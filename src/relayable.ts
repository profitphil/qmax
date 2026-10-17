import { classifyCall } from "./orderkinds.ts";
import { QSWAP_INDEX, QX_INDEX } from "./rpc.ts";

/**
 * Reading a signed transaction's bytes to tell whether it is an order QMax carries (see relay.ts). Apart from the relay itself so the browser can ask the same question before
 * it offers a transaction to QMax, without any of the server in its bundle.
 */

const KEY = 32;
const SIGNATURE = 64;
const HEADER = KEY * 2 + 8 + 4 + 2 + 2;
/** An order's input is a few dozen bytes; a bigger transaction is not one. */
export const MAX_RELAY_BYTES = 512;

/** A contract's address is its number, written as a 64-bit little-endian value, then zeros (QX is contract 1, QSwap 13). Not read from ledger.ts: that file pulls server code into a page. */
const contractKey = (index: number) => {
  const key = new Uint8Array(KEY);
  new DataView(key.buffer).setBigUint64(0, BigInt(index), true);
  return key;
};
const QX_KEY = contractKey(QX_INDEX);
const QSWAP_KEY = contractKey(QSWAP_INDEX);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface RelayableTx {
  source: Uint8Array;
  venue: "QX" | "QSwap";
  inputType: number;
  amount: bigint;
  tick: number;
}

/**
 * What a signed transaction is, read from its bytes (the sender's key, the destination's, the amount, the tick, the input type and size, the input, the signature), if it is an order,
 * a swap or a liquidity change for QX or QSwap that QMax carries. Null for anything else: a payment, a share move, a cancellation, bytes that are not a transaction.
 */
export function readRelayable(tx: Uint8Array): RelayableTx | null {
  if (tx.length < HEADER + SIGNATURE || tx.length > MAX_RELAY_BYTES) return null;
  const view = new DataView(tx.buffer, tx.byteOffset, tx.byteLength);
  const size = view.getUint16(KEY * 2 + 14, true);
  if (tx.length !== HEADER + size + SIGNATURE) return null;
  const dest = tx.subarray(KEY, KEY * 2);
  const venue = same(dest, QX_KEY) ? "QX" : same(dest, QSWAP_KEY) ? "QSwap" : null;
  const inputType = view.getUint16(KEY * 2 + 12, true);
  if (!venue || !classifyCall(venue, inputType)) return null;
  if (!tx.subarray(HEADER + size).some((b) => b !== 0)) return null; // no signature
  return { source: tx.subarray(0, KEY), venue, inputType, amount: view.getBigUint64(KEY * 2, true), tick: view.getUint32(KEY * 2 + 8, true) };
}

