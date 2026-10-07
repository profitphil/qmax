import { identityToBytes } from "./identity.ts";
import { structReader, structWriter } from "./rpc.ts";
import type { QubicRpc } from "./rpc.ts";

/** QPayhub (token QPAY): the Qubic payment contract. Pay() forwards the payment to the seller and records a receipt. */
export const QPAYHUB_INDEX = 29;
export const QPAYHUB_PROC_PAY = 1;
const FN_GET_RECEIPT = 1;
const FN_COMPUTE_RECEIPT_KEY = 2;
/** Payments below this are refused by the contract (QPAYHUB_MIN_PAYMENT). */
export const QPAYHUB_MIN_PAYMENT_QU = 100;

/** A random 64-bit nonce, so every fee payment gets its own receipt. */
export function randomNonce(): bigint {
  const b = new Uint32Array(2);
  crypto.getRandomValues(b);
  return (BigInt(b[0]) << 32n) | BigInt(b[1]);
}

/** Pay_input: id seller, id resourceId, uint64 nonce. The fee is attached as the transaction amount. */
export function payPayload(seller: string, resourceId: Uint8Array, nonce: bigint): Uint8Array {
  return structWriter(72).id(identityToBytes(seller)).id(resourceId).u64(nonce).bytes;
}

export interface Receipt {
  amountPaid: number;
  fee: number;
  seller: Uint8Array;
}

/** Everything QPayhub records about a payment. */
export interface FullReceipt extends Receipt {
  payer: Uint8Array;
  resourceId: Uint8Array;
  nonce: bigint;
  epochPaid: number;
  /** The tick the payment was made in. */
  tickPaid: number;
  /** The seller marked it used (QPAYHUB.Consume), so it can never unlock anything again. */
  consumed: boolean;
}

/** The key QPayhub files a receipt under: a hash of who paid whom, for what, with which nonce. */
export async function computeReceiptKey(
  rpc: QubicRpc,
  payer: string | Uint8Array,
  seller: string | Uint8Array,
  resourceId: Uint8Array,
  nonce: bigint,
): Promise<Uint8Array | null> {
  const bytes = (x: string | Uint8Array) => (typeof x === "string" ? identityToBytes(x) : x);
  const out = await rpc.query(QPAYHUB_INDEX, FN_COMPUTE_RECEIPT_KEY, structWriter(104).id(bytes(payer)).id(bytes(seller)).id(resourceId).u64(nonce).bytes);
  return out.length < 32 ? null : out.slice(0, 32);
}

/** A receipt by its key, or null if QPayhub has none. */
export async function getReceipt(rpc: QubicRpc, key: Uint8Array): Promise<FullReceipt | null> {
  const out = await rpc.query(QPAYHUB_INDEX, FN_GET_RECEIPT, structWriter(32).id(key).bytes);
  if (out.length < 128) return null;
  const r = structReader(out);
  if (r.i64(0) !== 0) return null; // returnCode: 0 means found
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // Layout (checked against real receipts): returnCode 0, payer 8, seller 40, resourceId 72, nonce 104, amountPaid 112, fee 120, epochPaid 128, tickPaid 132, consumed 136.
  return {
    payer: out.slice(8, 40),
    seller: out.slice(40, 72),
    resourceId: out.slice(72, 104),
    nonce: view.getBigUint64(104, true),
    amountPaid: r.i64(112),
    fee: r.i64(120),
    epochPaid: out.length >= 132 ? r.u32(128) : 0,
    tickPaid: out.length >= 136 ? r.u32(132) : 0,
    consumed: out.length > 136 ? out[136] !== 0 : false,
  };
}

/**
 * Asks QPayhub whether it recorded this payment. Pay() refunds and returns an error code instead of
 * failing the transaction (amount too low, duplicate, full), so "the transaction was included" does not
 * prove the fee was paid: the receipt does. Returns null when there is none.
 */
export async function fetchReceipt(rpc: QubicRpc, payer: string, seller: string, resourceId: Uint8Array, nonce: bigint): Promise<FullReceipt | null> {
  const key = await computeReceiptKey(rpc, payer, seller, resourceId, nonce);
  return key ? getReceipt(rpc, key) : null;
}

/** A receipt proves a payment only if it paid `recipient` at least `amountQu`. */
export function receiptPays(receipt: Receipt | null, recipient: string, amountQu: number): boolean {
  if (!receipt) return false;
  const want = identityToBytes(recipient);
  return want.every((b, i) => receipt.seller[i] === b) && receipt.amountPaid >= amountQu;
}

/** Polls QPayhub for a payment's receipt (its state can trail the tick by a moment). True once it shows. */
export async function waitForReceipt(
  rpc: QubicRpc,
  p: { payer: string; seller: string; resourceId: Uint8Array; nonce: bigint; amountQu: number },
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < (opts.attempts ?? 4); attempt++) {
    if (attempt > 0) await sleep(opts.delayMs ?? 2500);
    const receipt = await fetchReceipt(rpc, p.payer, p.seller, p.resourceId, p.nonce).catch(() => null);
    if (receiptPays(receipt, p.seller, p.amountQu)) return true;
  }
  return false;
}
