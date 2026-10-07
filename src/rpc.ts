export const QX_INDEX = 1;
export const QSWAP_INDEX = 13;

export interface RpcOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  /** Max requests per second to the node (the public RPC rate-limits). Default 5. */
  maxRps?: number;
  /** Longest a request may wait in the queue the rate limit makes (ms) before it is refused with RpcBusyError instead. Default 15,000. */
  maxQueueMs?: number;
  /** Longest to wait after a 429, whatever Retry-After says (ms). Default 10,000. */
  maxBackoffMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/** Minimal Qubic RPC client: read-only smart contract function calls. */
/** Thrown when the node's request queue is too long to wait out: callers should answer "busy, try again" instead of holding the connection. */
export class RpcBusyError extends Error {
  retryAfterSec: number;
  fatal = true; // not worth retrying here: the queue is the problem
  constructor(retryAfterSec: number) {
    super("The Qubic node is busy (too many requests are waiting). Try again shortly.");
    this.name = "RpcBusyError";
    this.retryAfterSec = retryAfterSec;
  }
}

const MAX_BACKOFF_MS = 10_000;

export class QubicRpc {
  private baseUrl: string;
  private timeoutMs: number;
  private retries: number;
  private minIntervalMs: number;
  private maxQueueMs: number;
  private maxBackoffMs: number;
  private nextFreeAt = 0;
  private fetchFn: typeof fetch;

  constructor(opts: RpcOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://rpc.qubic.org").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.retries = opts.retries ?? 3;
    this.minIntervalMs = 1000 / (opts.maxRps ?? 5);
    this.maxQueueMs = opts.maxQueueMs ?? 15_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
    // Called through a wrapper on purpose: a browser's fetch throws "Illegal invocation" when it is called as a method of this object.
    const f = opts.fetch;
    this.fetchFn = f ? (input, init) => f(input, init) : (input, init) => fetch(input, init);
  }

  /** Spaces requests out so a burst (e.g. a catalog scan) stays under the node's rate limit. */
  private async slot() {
    const now = Date.now();
    const at = Math.max(now, this.nextFreeAt);
    // A queue longer than this is not worth waiting in: the caller would sit on an open connection for minutes while more join it.
    if (at - now > this.maxQueueMs) throw new RpcBusyError(Math.ceil((at - now) / 1000));
    this.nextFreeAt = at + this.minIntervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  /** After a 429, wait as long as the node asks (Retry-After) or back off, and hold back other requests too. */
  private async backoff(res: Response | undefined, attempt: number) {
    const asked = Number(res?.headers?.get?.("retry-after"));
    // Whatever the node asks for, never wait (or hold everyone else back) longer than this: a huge value is an error or an attack, and one
    // past a timer's range (2^31 ms) would silently become about 1 ms and hammer the node.
    const wait = Math.min(this.maxBackoffMs, Number.isFinite(asked) && asked > 0 ? asked * 1000 : 500 * 2 ** attempt);
    this.nextFreeAt = Math.max(this.nextFreeAt, Date.now() + wait);
    await new Promise((r) => setTimeout(r, wait));
  }

  /** POST a JSON body to a REST path (e.g. the archive Query API) with the same timeout/retry rules. */
  async post<T>(path: string, body: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.slot();
        const res = await this.fetchFn(this.baseUrl + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(this.timeoutMs, 30_000)), // archive pages are large
        });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`RPC ${res.status}`), { res });
        if (!res.ok) throw Object.assign(new Error(`RPC ${res.status} for ${path}: ${await res.text()}`), { fatal: true });
        return (await res.json()) as T;
      } catch (e) {
        if ((e as { fatal?: boolean }).fatal) throw e;
        lastError = e;
        if (attempt < this.retries) await this.backoff((e as { res?: Response }).res, attempt);
      }
    }
    throw new Error(`Qubic RPC unavailable: ${lastError instanceof Error ? lastError.message : lastError}`);
  }

  /** GET a REST path with the same timeout/retry rules. */
  async get<T>(path: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.slot();
        const res = await this.fetchFn(this.baseUrl + path, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`RPC ${res.status}`), { res });
        if (!res.ok) throw Object.assign(new Error(`RPC ${res.status} for ${path}`), { fatal: true });
        return (await res.json()) as T;
      } catch (e) {
        if ((e as { fatal?: boolean }).fatal) throw e;
        lastError = e;
        if (attempt < this.retries) await this.backoff((e as { res?: Response }).res, attempt);
      }
    }
    throw new Error(`Qubic RPC unavailable: ${lastError instanceof Error ? lastError.message : lastError}`);
  }

  /** POST /live/v1/querySmartContract. Returns the raw response bytes. */
  async query(contractIndex: number, inputType: number, input: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    const body = JSON.stringify({
      contractIndex,
      inputType,
      inputSize: input.length,
      requestData: btoa(String.fromCharCode(...input)),
    });
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.slot();
        const res = await this.fetchFn(`${this.baseUrl}/live/v1/querySmartContract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`RPC ${res.status}`), { res });
        if (!res.ok) throw Object.assign(new Error(`RPC ${res.status}: ${await res.text()}`), { fatal: true });
        const json = (await res.json()) as { responseData?: string };
        return Uint8Array.from(atob(json.responseData ?? ""), (c) => c.charCodeAt(0));
      } catch (e) {
        if ((e as { fatal?: boolean }).fatal) throw e;
        lastError = e;
        if (attempt < this.retries) await this.backoff((e as { res?: Response }).res, attempt);
      }
    }
    throw new Error(`Qubic RPC unavailable: ${lastError instanceof Error ? lastError.message : lastError}`);
  }
}

/** Little-endian field writer/reader for contract input/output structs. */
export function structWriter(size: number) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let off = 0;
  return {
    bytes,
    id(b: Uint8Array) {
      bytes.set(b, off);
      off += 32;
      return this;
    },
    u64(v: bigint | number) {
      view.setBigUint64(off, BigInt(v), true);
      off += 8;
      return this;
    },
    i64(v: bigint | number) {
      view.setBigInt64(off, BigInt(v), true);
      off += 8;
      return this;
    },
  };
}

export function structReader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    length: bytes.length,
    u32: (off: number) => view.getUint32(off, true),
    i64: (off: number) => Number(view.getBigInt64(off, true)),
  };
}
