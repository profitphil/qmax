/**
 * Checks that the bytes a wallet handed back are the transaction that was asked for, before they are broadcast. A transaction is, in order: the sender's key (32 bytes), the
 * destination's key (32), the amount (8, little-endian), the tick (4), the input type (2), the input size (2), the input, and the signature (64). A browser extension signs
 * with whichever account is active in it, which can be a different one from the account the page thinks it is connected to, so what comes back must be compared, not trusted.
 */

const KEY = 32;
const SIGNATURE = 64;
const HEADER = KEY * 2 + 8 + 4 + 2 + 2;

export interface TxExpectation {
  source: Uint8Array;
  dest: Uint8Array;
  amount: bigint;
  tick: number;
  inputType: number;
  payload: Uint8Array;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Null when the signed bytes are exactly what was asked for and carry a signature; otherwise a sentence saying what is different. */
export function checkSignedTx(signed: Uint8Array, want: TxExpectation): string | null {
  if (signed.length < HEADER + SIGNATURE) return "the answer is too short to be a signed transaction";
  const view = new DataView(signed.buffer, signed.byteOffset, signed.byteLength);
  const size = view.getUint16(KEY * 2 + 14, true);
  if (signed.length !== HEADER + size + SIGNATURE) return "the answer's length does not match the size it states";
  if (!same(signed.subarray(0, KEY), want.source)) return "it was signed from a different account than the one connected";
  if (!same(signed.subarray(KEY, KEY * 2), want.dest)) return "it is addressed to a different destination";
  if (view.getBigUint64(KEY * 2, true) !== want.amount) return "it carries a different amount";
  if (view.getUint32(KEY * 2 + 8, true) !== want.tick) return "it is set to a different tick";
  if (view.getUint16(KEY * 2 + 12, true) !== want.inputType) return "it is a different kind of call";
  if (!same(signed.subarray(HEADER, HEADER + size), want.payload)) return "it carries different data";
  if (!signed.subarray(HEADER + size).some((b) => b !== 0)) return "it has no signature";
  return null;
}
