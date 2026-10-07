import { createHash, randomBytes } from "node:crypto";
import { bytesToHex, identityToBytes } from "../src/identity.ts";
import type { FullReceipt } from "../src/qpay.ts";
import { resourceTag } from "../src/x402.ts";
import type { ChainReader, ChainTx } from "../src/x402.ts";

export const SELLER = "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE";
export const PAYER = "QXMRTKAIIGLUREPIQPCMHCKWSIPDTUYFCFNYXQLTECSUJVYEMMDELBMDOEYB";
export const OTHER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";

export const randomTxId = () => Array.from(randomBytes(60), (b) => "abcdefghijklmnopqrstuvwxyz"[b % 26]).join("");

/** A stand-in for the network: QPayhub receipts and the transactions that made them. */
export function fakeNetwork() {
  const receipts = new Map<string, FullReceipt>();
  const txs = new Map<string, ChainTx>();
  const state = { tick: 10_000 };
  const keyOf = (payer: Uint8Array, seller: Uint8Array, rid: Uint8Array, nonce: bigint) => {
    const n = Buffer.alloc(8);
    n.writeBigUInt64LE(nonce);
    return new Uint8Array(createHash("sha256").update(Buffer.concat([payer, seller, rid, n])).digest());
  };
  const chain: ChainReader = {
    receiptKey: async (...a) => keyOf(...a),
    getReceipt: async (k) => receipts.get(bytesToHex(k)) ?? null,
    transaction: async (id) => txs.get(id) ?? null,
    tick: async () => state.tick,
  };
  /** Records a payment the way QPayhub would: a receipt under its key, and the transaction that made it. */
  function record(p: { payer: Uint8Array; sourceId: string; seller: Uint8Array; resourceId: Uint8Array; nonce: bigint; amount: number; destId: string; tickPaid?: number; consumed?: boolean; moneyFlew?: boolean }) {
    const key = keyOf(p.payer, p.seller, p.resourceId, p.nonce);
    receipts.set(bytesToHex(key), { payer: p.payer, seller: p.seller, resourceId: p.resourceId, nonce: p.nonce, amountPaid: p.amount, fee: 100, epochPaid: 233, tickPaid: p.tickPaid ?? state.tick, consumed: p.consumed ?? false });
    const txId = randomTxId();
    txs.set(txId, { sourceId: p.sourceId, destId: p.destId, amount: String(p.amount), moneyFlew: p.moneyFlew ?? true });
    return { txId, reference: bytesToHex(key) };
  }
  /** What a buyer does after reading a 402: QPAYHUB.Pay with the ticket's nonce. `over` bends one detail to test a refusal. */
  function pay(challenge: any, over: Partial<{ payer: string; amount: number; nonceHex: string; seller: string; resource: string; tickPaid: number; consumed: boolean; destId: string; moneyFlew: boolean }> = {}) {
    const req = challenge.accepts[0];
    const nonceHex = over.nonceHex ?? JSON.parse(Buffer.from(challenge.paymentTicket.split(".")[0], "base64url").toString()).nonce;
    const payer = over.payer ?? PAYER;
    const seller = over.seller ?? req.extra.sellerId;
    const tag = resourceTag(over.resource ?? req.extra.resourceId);
    const nonce = Buffer.from(nonceHex, "hex").readBigUInt64LE(0);
    return record({ payer: identityToBytes(payer), sourceId: payer, seller: identityToBytes(seller), resourceId: tag, nonce, amount: over.amount ?? Number(req.amount), destId: over.destId ?? req.payTo, tickPaid: over.tickPaid, consumed: over.consumed, moneyFlew: over.moneyFlew });
  }
  return { chain, pay, record, state, receipts, txs };
}


export const header = (challenge: any, payload: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { ticket: challenge.paymentTicket, ...payload }, extensions: {}, ...over })).toString("base64");
