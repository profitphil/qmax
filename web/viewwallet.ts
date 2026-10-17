import { bytesToIdentity, identityToBytes } from "../src/identity.ts";

/**
 * Looking at a wallet without connecting it. Some people will not connect a wallet to a site they have only just found, and everything the portfolio shows (what a wallet holds, its
 * open orders, its trades and profit, its pool positions) is public on the Qubic network, so a pasted address is enough to read it. Nothing is signed or sent for a wallet looked at this way.
 */

export const VIEW_KEY = "qmax.view";

export type ParsedWallet = { ok: true; id: string } | { ok: false; error: string };

/**
 * An address from whatever was pasted: the 60 letters on their own, with spaces or line breaks around them, in either case, or inside a link to an explorer. The last four letters of
 * an address are a checksum, so one with a typo (or cut short, or pasted from the middle of a longer text) is refused with a sentence saying so, instead of showing an empty wallet.
 */
export function parseWallet(input: string): ParsedWallet {
  const text = input.trim();
  if (!text) return { ok: false, error: "Paste a Qubic address: 60 capital letters." };
  const words = text.split(/[^A-Za-z]+/).filter(Boolean);
  const found = [...new Set(words.filter((w) => w.length === 60).map((w) => w.toUpperCase()))];
  if (found.length > 1) return { ok: false, error: "There is more than one address in that. Paste just the one to look at." };
  if (found.length === 0) {
    const near = words.find((w) => w.length >= 50 && w.length <= 70);
    return { ok: false, error: near ? `A Qubic address is 60 letters; that one has ${near.length}. Check it was copied whole.` : "That is not a Qubic address. It is 60 capital letters, like QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE." };
  }
  const id = found[0];
  if (bytesToIdentity(identityToBytes(id)) !== id) return { ok: false, error: "The last four letters of that address do not match the rest, so it has a typo. Copy it again." };
  return { ok: true, id };
}

/** The address looked at last time, if it is still a real one. A browser that blocks storage just starts with none. */
export function readViewed(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  try {
    const parsed = parseWallet(storage?.getItem(VIEW_KEY) ?? "");
    return parsed.ok ? parsed.id : null;
  } catch {
    return null;
  }
}

export function writeViewed(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, id: string | null): void {
  try {
    if (id) storage?.setItem(VIEW_KEY, id);
    else storage?.removeItem(VIEW_KEY);
  } catch {
    // not remembered: the view lasts until the page is closed
  }
}

/** True when the wallet being looked at is not the one that is connected: nothing on screen may then be signed with the connected wallet. */
export const isReadOnly = (viewing: string | null, connected: string | null): boolean => viewing !== null && viewing !== connected;

export const shortAddress = (a: string): string => `${a.slice(0, 5)}…${a.slice(-5)}`;
