/**
 * An x402-aware fetch for agents: call QMax like normal, and when it answers 402 this pays for a session and retries.
 * It never signs anything itself. Paying is the job of a `Payer` you give it (see `contractPayer` in "@qmax/sdk/agent"),
 * and it refuses to pay more than the limits you set, because a wrong or hostile server can ask for any price.
 */

/** What a payer is asked to do: one QPAYHUB.Pay. */
export interface PayRequest {
  settlement: string;
  /** Where the payment goes. For QMax this must be QPayhub. */
  payTo: string;
  amount: number;
  asset: string;
  network: string;
  /** The resource's name; QPayhub files the receipt under its SHA-256. */
  resourceId: string;
  /** Who the money is for: the seller, named inside the Pay call. */
  sellerId: string;
  /** The nonce from the 402's ticket, 8 bytes in hex. It has to be in the payment, or the payment will not be accepted. */
  nonceHex: string | null;
  url: string;
}

export interface Payment {
  txId?: string;
  reference?: string;
}

export interface Payer {
  name: string;
  pay(req: PayRequest): Promise<Payment>;
}

export class X402Error extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "X402Error";
    this.code = code;
    this.details = details;
  }
}

export interface X402FetchOptions {
  payer?: Payer;
  fetch?: typeof fetch;
  /** The most one payment may cost, in QU. Default 10,000: opt in to more. Must be a positive number (a NaN or zero is refused, not read as "no limit"). */
  maxAmountPerCall?: number;
  /**
   * The most this client may spend in its lifetime, in QU: five payments at the per-call limit unless you say otherwise. A payment that would
   * pass it is refused. `null` turns the cap off, and must be asked for on purpose.
   */
  maxTotalSpend?: number | null;
  /** How often to look again for a payment the network has not shown yet. */
  confirmAttempts?: number;
  confirmIntervalMs?: number;
  /** False to get the 402 back instead of paying. */
  autoPay?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type X402Fetch = ((input: string | URL, init?: RequestInit) => Promise<Response>) & {
  stats(): { totalSpent: number; hasSession: boolean };
  clearSession(): void;
};

const utf8Base64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

function ticketNonce(ticket: unknown): string | null {
  if (typeof ticket !== "string") return null;
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) return null;
  try {
    const b64 = ticket.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64));
    return typeof claims?.nonce === "string" ? claims.nonce : null;
  } catch {
    return null;
  }
}

/** A limit must be a number above zero: NaN (a mistyped setting) compares false against everything, which would switch the limit off. */
function limitOf(name: string, value: number | null | undefined, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === null) {
    if (name === "maxAmountPerCall") throw new Error("maxAmountPerCall cannot be turned off");
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a number above zero, not ${String(value)}`);
  return value;
}

/** Failures that happen before anything could have been broadcast: the money was never at risk, so it is not counted as spent. */
const NOT_SENT = new Set(["payer_wrong_settlement", "payer_wrong_destination", "no_ticket", "no_resource", "bad_seller", "seller_not_allowed"]);

export function createX402Fetch(opts: X402FetchOptions = {}): X402Fetch {
  const fetchImpl = opts.fetch ?? fetch;
  const maxPerCall = limitOf("maxAmountPerCall", opts.maxAmountPerCall, 10_000)!;
  const maxTotal = limitOf("maxTotalSpend", opts.maxTotalSpend, maxPerCall * 5);
  const attempts = opts.confirmAttempts ?? 15;
  const interval = opts.confirmIntervalMs ?? 3000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const grants = new Map<string, { token: string; expiresAt: number | null }>(); // by server
  const paying = new Map<string, Promise<void>>();
  let totalSpent = 0;
  // One payment at a time across every server: the caps are checked and the amount reserved inside this, so payments to several servers at once
  // cannot each pass the check against the same unspent total.
  let gate: Promise<void> = Promise.resolve();
  const exclusive = async <T>(f: () => Promise<T>): Promise<T> => {
    const before = gate;
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    await before;
    try {
      return await f();
    } finally {
      release();
    }
  };

  // A redirect is refused: fetch forwards custom headers (the session grant, the payment proof) to wherever it is sent, and a 402 from a different host
  // must not be followed into paying it.
  const withHeader = (init: RequestInit | undefined, name: string, value: string): RequestInit => {
    const headers = new Headers(init?.headers ?? {});
    headers.set(name, value);
    return { ...init, headers, redirect: "error" };
  };
  const liveGrant = (origin: string) => {
    const g = grants.get(origin);
    if (!g) return null;
    if (g.expiresAt !== null && Date.now() / 1000 > g.expiresAt - 5) {
      grants.delete(origin); // 5 seconds of margin, so it does not run out in flight
      return null;
    }
    return g;
  };
  const keepGrant = (origin: string, res: Response) => {
    const token = res.headers.get("x-access-grant");
    if (token) grants.set(origin, { token, expiresAt: Number(res.headers.get("x-access-grant-expires")) || null });
  };

  async function payAndRetry(url: URL, init: RequestInit | undefined, challenge: Response): Promise<Response> {
    const body = await challenge.clone().json().catch(() => null);
    const req = Array.isArray(body?.accepts) ? body.accepts[0] : null;
    if (!req) throw new X402Error("The server answered 402 without a usable payment challenge.", "bad_challenge");
    const amount = Number(req.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new X402Error(`The server asked for an invalid amount: ${req.amount}`, "bad_amount");
    if (amount > maxPerCall) throw new X402Error(`The price, ${amount} QU, is above maxAmountPerCall (${maxPerCall} QU). Not paying.`, "limit_per_call", { amount, limit: maxPerCall });
    if (!opts.payer) throw new X402Error("Payment is required but no payer was given.", "no_payer", { amount, payTo: req.payTo });

    const ticket = body.paymentTicket;
    const payer = opts.payer;
    const payment = await exclusive(async () => {
      if (maxTotal !== null && totalSpent + amount > maxTotal)
        throw new X402Error(`Paying ${amount} QU would pass maxTotalSpend (${maxTotal} QU; ${totalSpent} spent). Not paying.`, "limit_total", { amount, totalSpent, limit: maxTotal });
      // Counted as spent from the moment it may be sent, not from when it is confirmed: a payment that is broadcast and never confirmed can still land.
      totalSpent += amount;
      try {
        const p = await payer.pay({
          settlement: req.extra?.settlement ?? "direct",
          payTo: req.payTo,
          amount,
          asset: req.asset,
          network: req.network,
          resourceId: req.extra?.resourceId,
          sellerId: req.extra?.sellerId ?? req.payTo,
          nonceHex: ticketNonce(ticket),
          url: url.href,
        });
        if (!p.txId && !p.reference) throw new X402Error("The payer returned neither a transaction id nor a receipt key.", "payer_no_txid");
        return p;
      } catch (e) {
        if (e instanceof X402Error && NOT_SENT.has(e.code)) totalSpent -= amount; // refused before anything could be sent
        throw e;
      }
    });

    const header = utf8Base64(
      JSON.stringify({ x402Version: 2, resource: body.resource, accepted: req, payload: payment.reference ? { reference: payment.reference, ticket } : { txHash: payment.txId, ticket }, extensions: {} }),
    );
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const res = await fetchImpl(url, withHeader(init, "x-payment", header));
      if (res.status !== 402) {
        keepGrant(url.origin, res);
        return res;
      }
      const err = await res.clone().json().catch(() => ({}));
      // The network not having caught up yet is expected, not a failure.
      if (err.error !== "invalid_transaction_state") throw new X402Error(`The payment was refused: ${err.error}`, String(err.error), { txId: payment.txId, amount });
      if (attempt < attempts) await sleep(interval);
    }
    throw new X402Error("Paid, but the network did not show the payment in time. It is not lost: ask again with the same transaction.", "confirm_timeout", { txId: payment.txId, amount });
  }

  const x402Fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const live = liveGrant(url.origin);
    if (live) {
      const res = await fetchImpl(url, withHeader(init, "x-access-grant", live.token));
      if (res.status !== 402) return res;
      grants.delete(url.origin); // refused: the session is over, so pay for a new one
    }
    const first = await fetchImpl(url, { ...init, redirect: "error" });
    if (first.status !== 402 || opts.autoPay === false) return first;

    // If a payment for this server is under way, wait for it. Then, whether it was or this request was simply sent before the
    // session existed, use the session that is there now rather than paying a second time.
    const underway = paying.get(url.origin);
    if (underway) await underway;
    const bought = liveGrant(url.origin);
    if (bought) {
      const res = await fetchImpl(url, withHeader(init, "x-access-grant", bought.token));
      if (res.status !== 402) return res;
      grants.delete(url.origin);
    }
    let done!: () => void;
    paying.set(url.origin, new Promise<void>((r) => (done = r)));
    try {
      return await payAndRetry(url, init, first);
    } finally {
      paying.delete(url.origin);
      done();
    }
  }) as X402Fetch;

  x402Fetch.stats = () => ({ totalSpent, hasSession: [...grants.keys()].some((o) => liveGrant(o)) });
  x402Fetch.clearSession = () => grants.clear();
  return x402Fetch;
}
