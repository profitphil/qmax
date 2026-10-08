import { errorText } from "../../src/errtext.ts";
import { checkSignedTx } from "../../src/signedtx.ts";
import type { TxExpectation } from "../../src/signedtx.ts";
import { base64ToUint8Array } from "./utils/tx.ts";

/**
 * The Qubic Wallet browser extension (https://github.com/qubic/wallet-extension, listed in Qubic's wallet docs). It puts `window.qubic` on every web page. A site asks it to
 * `connect()` (the person approves, for the account that is active in the extension), reads `getAccount()`, and has it sign with `signTransaction()`, which returns the signed
 * bytes for the site to broadcast itself. Nothing here holds a key: the extension signs, after the person approves and enters their passphrase.
 */

export const EXTENSION_RELEASES_URL = "https://github.com/qubic/wallet-extension/releases";

export interface ExtensionAccount {
  identity: string;
  name?: string;
}

export interface SignTransactionParams {
  toIdentity: string;
  amount: string;
  targetTick: number;
  inputType: number;
  inputBytes?: Uint8Array;
}

export type ExtensionEvent = "accountChanged" | "disconnect";

/** The part of `window.qubic` this site uses. */
export interface QubicProvider {
  isQubic?: boolean;
  connect(): Promise<{ connected: true; origin: string }>;
  disconnect(): Promise<{ disconnected: true }>;
  getAccount(): Promise<ExtensionAccount | null>;
  signTransaction(p: SignTransactionParams): Promise<{ txId: string; targetTick: number; txBytesBase64: string; txBytesHex: string }>;
  on(event: ExtensionEvent, cb: (payload: unknown) => void): () => void;
}

export const isIdentity = (s: unknown): s is string => typeof s === "string" && /^[A-Z]{60}$/.test(s);
/** A name from the extension is shown to the person: plain letters, digits and a few marks, short. */
const cleanName = (n: string) => n.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 32);

/** The extension's provider on this page, or null if it is not installed (or is something else answering to `window.qubic`). */
export function extensionProvider(w: object | undefined = typeof window !== "undefined" ? window : undefined): QubicProvider | null {
  const p = (w as { qubic?: Partial<QubicProvider> } | undefined)?.qubic;
  return p && p.isQubic === true && typeof p.connect === "function" && typeof p.getAccount === "function" && typeof p.signTransaction === "function" ? (p as QubicProvider) : null;
}

/** The extension puts its provider on the page when its own script has run, which can be a moment after this page's: look for it for a short while before saying it is missing. */
export async function waitForExtension(ms = 1500, w?: object, sleep: (ms: number) => Promise<void> = (t) => new Promise((r) => setTimeout(r, t))): Promise<QubicProvider | null> {
  for (let waited = 0; ; waited += 100) {
    const p = extensionProvider(w);
    if (p || waited >= ms) return p;
    await sleep(100);
  }
}

/** What a person is told for each of the extension's own error codes. Anything else keeps its own words. */
export function extensionMessage(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const text = errorText(e);
  switch (code) {
    case "USER_REJECTED": return "You rejected the request in the Qubic Wallet extension.";
    case "NOT_CONNECTED": return "This site is not connected to the extension (or the account was changed there). Connect it again.";
    case "NO_ACCOUNT": return "The extension has no active account. Open it, select an account, and try again.";
    case "WATCH_ONLY_ACCOUNT": return "The active account in the extension is watch-only, so it cannot sign. Switch to an account that has a key.";
    case "INVALID_PASSPHRASE": return "The wallet passphrase was wrong. Try again.";
    case "UNSUPPORTED_ORIGIN": return "The extension does not allow this site.";
    case "INVALID_REQUEST": return "The extension is busy with other requests or refused this one. Finish or close them in the extension and try again.";
    case "METHOD_NOT_SUPPORTED": return "This version of the extension does not support that. Update the extension.";
    case "INVALID_PARAMS": return `The extension did not accept the request (${text}).`;
  }
  if (/provider request timed out|timed out/i.test(text)) return "The extension did not answer in time. Open it, approve the request, and try again.";
  return text;
}

/** Asks the extension to connect (the person approves in it) and reads the account it shares. */
export async function connectExtension(provider: QubicProvider): Promise<ExtensionAccount> {
  await provider.connect();
  const account = await provider.getAccount();
  if (!account || !isIdentity(account.identity)) throw new Error("The extension did not share an account. Open it, select an account, and connect again.");
  return { identity: account.identity, ...(typeof account.name === "string" && cleanName(account.name) ? { name: cleanName(account.name) } : {}) };
}

/** The account the extension shares with this site right now, without asking the person anything; null if it shares none (or is not there). */
export async function currentExtensionAccount(provider: QubicProvider): Promise<ExtensionAccount | null> {
  try {
    const a = await provider.getAccount();
    return a && isIdentity(a.identity) ? { identity: a.identity, ...(typeof a.name === "string" && cleanName(a.name) ? { name: cleanName(a.name) } : {}) } : null;
  } catch {
    return null;
  }
}

/** The transaction as the extension is asked to sign it. The input is sent as bytes (not text), so it cannot be read as hex or base64 by mistake. */
export function signRequest(t: { destinationIdentity: string; amount: bigint; tick: number; inputType: number; payload: Uint8Array }): SignTransactionParams {
  return { toIdentity: t.destinationIdentity, amount: t.amount.toString(), targetTick: t.tick, inputType: t.inputType, ...(t.payload.length ? { inputBytes: t.payload } : {}) };
}

/** Has the extension sign the transaction and returns the signed bytes only once they are checked to be exactly what was asked for. */
export async function signWithExtension(provider: QubicProvider, want: TxExpectation & { destinationIdentity: string }): Promise<Uint8Array> {
  const result = await provider.signTransaction(signRequest({ destinationIdentity: want.destinationIdentity, amount: want.amount, tick: want.tick, inputType: want.inputType, payload: want.payload }));
  if (!result || typeof result.txBytesBase64 !== "string") throw new Error("The extension did not return a signed transaction.");
  let bytes: Uint8Array;
  try {
    bytes = base64ToUint8Array(result.txBytesBase64);
  } catch {
    throw new Error("The extension's answer was not a signed transaction.");
  }
  const problem = checkSignedTx(bytes, want);
  if (problem) throw new Error(`The extension's answer is not what was asked for, so nothing was sent: ${problem}.`);
  return bytes;
}

/** Listens for the person switching account or disconnecting the site inside the extension. Returns the function that stops listening. */
export function watchExtension(provider: QubicProvider, onAccount: (a: ExtensionAccount | null) => void, onDisconnect: () => void): () => void {
  const offs = [
    provider.on("accountChanged", (payload) => {
      const a = payload as { identity?: unknown; name?: unknown } | null;
      onAccount(a && isIdentity(a.identity) ? { identity: a.identity, ...(typeof a.name === "string" && cleanName(a.name) ? { name: cleanName(a.name) } : {}) } : null);
    }),
    provider.on("disconnect", () => onDisconnect()),
  ];
  return () => offs.forEach((off) => off());
}
