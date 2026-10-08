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
