/**
 * Making a WalletConnect pairing link (what the QR code and the "Open in wallet" button carry) without ever leaving the dialog on "Preparing…".
 *
 * Making the link needs WalletConnect's relay (a server the page talks to over a WebSocket). Where that cannot be reached (a VPN, a content blocker or a restrictive
 * network, an in-app browser) the request never comes back, and with no timeout the dialog waited for ever with no message and no way out. Starting the client can hang
 * the same way where the browser blocks the storage it uses (private browsing, some in-app browsers). So: every wait has an end, a failure says in words what to try, and
 * the client can start again keeping everything in memory.
 */

/** A failure whose message is already fit to show a person. */
export class PairingError extends Error {}

export const TIMEOUT_MESSAGE =
  "WalletConnect's servers did not answer in time. That is usually your network: turn off a VPN or content blocker for this site, check your connection, or try another browser.";

/** Rejects with `message` if `p` has not settled within `ms` (and lets `p` carry on: nothing is cancelled). */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PairingError(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** What WalletConnect keeps its state in; this one keeps it in memory, for a browser that blocks (or hangs on) its own storage. */
export class MemoryStorage {
  private map = new Map<string, unknown>();
  async getKeys(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async getEntries<T = any>(): Promise<[string, T][]> {
    return [...this.map.entries()] as [string, T][];
  }
  async getItem<T = any>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async setItem<T = any>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/**
 * Starts a client the normal way and, if that fails or hangs (a browser that blocks its storage), once more keeping everything in memory: a connection then lasts until
 * the page is closed instead of being remembered. If both fail, the first failure is the one reported.
 */
export async function startClient<C>(normal: () => Promise<C>, inMemory: () => Promise<C>, ms = 8_000): Promise<C> {
  try {
    return await withTimeout(normal(), ms, "WalletConnect did not start in time.");
  } catch (first) {
    try {
      return await withTimeout(inMemory(), ms, "WalletConnect did not start in time.");
    } catch {
      throw first;
    }
  }
}

/** Waits for the client, then asks it for a pairing, and gives up with a message instead of waiting for ever. */
export async function makePairing<C, R>(getClient: () => Promise<C>, pair: (client: C) => Promise<R>, limits = { readyMs: 12_000, pairMs: 15_000 }): Promise<R> {
  const client = await withTimeout(getClient(), limits.readyMs, TIMEOUT_MESSAGE);
  return withTimeout(pair(client), limits.pairMs, TIMEOUT_MESSAGE);
}

/** A failure as the dialog says it: a message already fit to show, or a short plain one with the technical reason in brackets. */
export function describeFailure(e: unknown): string {
  if (e instanceof PairingError) return e.message;
  const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120);
  return `Could not create the connection link${reason ? ` (${reason})` : ""}. Check your connection, turn off a VPN or content blocker for this site, or try another browser.`;
}

// ---- picking up a connection the wallet approved while this page was in the background

/** How long a pairing the page started is still expected to be answered: the link itself lives about five minutes, so ten is generous. */
export const PAIRING_WINDOW_MS = 10 * 60_000;

/** Whether the page started a pairing recently (`startedAt` is when, or null for none). */
export const pairingIsFresh = (startedAt: number | null, now = Date.now(), windowMs = PAIRING_WINDOW_MS): boolean => startedAt !== null && Number.isFinite(startedAt) && now >= startedAt && now - startedAt < windowMs;

/**
 * Of the sessions a WalletConnect client holds, the newest one that is for Qubic. The page records a session only at the moment it is waiting to see it approved, so a wallet that
 * answered while the page was in the background (a phone puts the browser to sleep when the wallet app opens, and may throw the page away) left a session the page did not know about.
 * A session can only exist because this page's own pairing was approved, so taking it up is safe.
 */
export function newestQubicSession<S extends { topic: string; expiry: number; namespaces?: Record<string, unknown> }>(sessions: readonly S[]): S | null {
  const mine = sessions.filter((s) => s.namespaces && Object.prototype.hasOwnProperty.call(s.namespaces, "qubic"));
  return mine.length ? mine.reduce((a, b) => (b.expiry > a.expiry ? b : a)) : null;
}

/**
 * Whether this looks like the in-app browser of another app (Facebook, Instagram, LINE, WeChat and so on, or an Android WebView, or an iPhone web view that is not Safari). Those
 * often cannot hand over to a wallet app, so the person is told to open the page in their own browser. A best guess from the browser's own description of itself.
 */
export function inAppBrowser(userAgent: string): boolean {
  if (/\b(FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|Snapchat|MicroMessenger|KAKAOTALK|Discord)\b/i.test(userAgent)) return true;
  if (/; wv\)/.test(userAgent)) return true;
  return /iPhone|iPad|iPod/.test(userAgent) && !/Safari\//.test(userAgent);
}

/**
 * The accounts a wallet listed in a WalletConnect session when it approved (each entry is "qubic:mainnet:ADDRESS"), without asking it anything. A phone's wallet app is asleep
 * once the person is back on the page, so a request for its accounts goes unanswered until they open it again; the session already carries the list. Only real addresses, once
 * each, at most 25.
 */
export function accountsFromNamespaces(namespaces: Record<string, { accounts?: string[] } | undefined> | undefined): string[] {
  const listed = namespaces?.qubic?.accounts ?? [];
  const out: string[] = [];
  for (const entry of listed) {
    const address = String(entry).split(":").pop() ?? "";
    if (/^[A-Z]{60}$/.test(address) && !out.includes(address)) out.push(address);
    if (out.length >= 25) break;
  }
  return out;
}

/**
 * What the connect dialog does once the wallet app is linked and the person has to choose an account: use the accounts the session lists at once ("session": the wallet app may be
 * asleep and would not answer a request for them), or ask the wallet for them, showing a waiting screen only if the dialog is part way through connecting ("ask-and-wait") and
 * otherwise leaving the other ways to connect where they are ("ask-quietly").
 */
export function accountPlan(fromSession: readonly string[], midway: boolean): "session" | "ask-and-wait" | "ask-quietly" {
  if (fromSession.length) return "session";
  return midway ? "ask-and-wait" : "ask-quietly";
}

/**
 * Whatever a wallet sends back for its accounts is shown to the person and used as an address in requests: only real addresses (60 capital letters), once each, with a plain short
 * name, get through, and an entry that is not one is dropped rather than allowed to break the page. A wallet may name the address field differently, so the likely names are read.
 */
export function cleanWalletAccounts(res: unknown, limit = 25): { address: string; name: string }[] {
  if (!Array.isArray(res)) return [];
  const out: { address: string; name: string }[] = [];
  for (const entry of res) {
    const a = entry as Record<string, unknown> | null;
    const address = [a?.address, a?.publicId, a?.identity, a?.publicKey].find((v): v is string => typeof v === "string" && /^[A-Z]{60}$/.test(v));
    if (!address || out.some((x) => x.address === address)) continue;
    const raw = typeof a?.name === "string" ? a.name : typeof a?.alias === "string" ? a.alias : "";
    out.push({ address, name: raw.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 32) });
    if (out.length >= limit) break;
  }
  return out;
}
