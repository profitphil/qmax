import { test } from "node:test";
import assert from "node:assert/strict";
import { PAYWALL } from "../src/config.ts";
import { identityToBytes } from "../src/identity.ts";
import { passIsActive, passResourceId, passStep } from "../src/pass.ts";
import { fetchReceipt, payPayload, receiptPays, waitForReceipt } from "../src/qpay.ts";
import { QubicRpc } from "../src/rpc.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const FEE = "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE";
const PAYER = "QXMRTKAIIGLUREPIQPCMHCKWSIPDTUYFCFNYXQLTECSUJVYEMMDELBMDOEYB";
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

test("the pass is one QPayhub payment of the price to the QMax address", () => {
  const step = passStep(42n);
  assert.deepEqual(step.to, { contractIndex: 29 });
  assert.equal(step.inputType, 1);
  assert.equal(step.amountQu, PAYWALL.priceQu);
  assert.equal(step.amountQu, 1000);
  assert.equal(step.payload.length, 72);
  assert.deepEqual([...step.payload.slice(0, 32)], [...identityToBytes(PAYWALL.recipient)]);
  assert.equal(view(step.payload).getBigUint64(64, true), 42n);
  assert.equal(step.qpay!.nonce, 42n);
  assert.match(step.description, /1,000 QU for 24 hours/);
});

test("the resource id names the pass and its length", () => {
  const id = passResourceId();
  assert.equal(id.length, 32);
  assert.equal(new TextDecoder().decode(id.slice(0, 8)), "QMAXPASS");
  assert.equal(view(id).getUint32(12, true), 24);
  assert.equal(payPayload(PAYWALL.recipient, id, 1n).length, 72);
});

test("a pass lasts 24 hours, for the wallet that paid", () => {
  const pass = { wallet: PAYER, paidAt: 1_000_000, nonce: "1", txId: "t" };
  assert.equal(passIsActive(pass, PAYER, 1_000_000 + 23 * 3_600_000), true);
  assert.equal(passIsActive(pass, PAYER, 1_000_000 + 24 * 3_600_000), false);
  assert.equal(passIsActive(pass, "OTHER", 1_000_000 + 1000), false);
  assert.equal(passIsActive(undefined, PAYER), false);
  assert.equal(passIsActive({ ...pass, paidAt: Date.now() + 3_600_000 }, PAYER), false); // a date in the future is not a real payment
});

/** Fake QPayhub: ComputeReceiptKey returns a fixed key; GetReceipt returns a receipt (or a not-found code). */
function fakeHub(found: boolean, over: { seller?: string; amount?: number } = {}) {
  const calls: number[] = [];
  const fetch = (async (_u: string, init: { body: string }) => {
    const { contractIndex, inputType } = JSON.parse(init.body);
    assert.equal(contractIndex, 29);
    calls.push(inputType);
    let out: Buffer;
    if (inputType === 2) out = Buffer.alloc(32, 7);
    else {
      out = Buffer.alloc(8 + 32 * 3 + 8 + 8 + 8 + 8 + 1);
      out.writeBigUInt64LE(found ? 0n : 5n, 0);
      Buffer.from(identityToBytes(over.seller ?? FEE)).copy(out, 40);
      out.writeBigInt64LE(BigInt(over.amount ?? 1000), 112);
      out.writeBigInt64LE(100n, 120);
    }
    return { ok: true, status: 200, json: async () => ({ responseData: out.toString("base64") }) };
  }) as never;
  return { rpc: new QubicRpc({ fetch, retries: 0, maxRps: 1000 }), calls };
}

test("a receipt on QPayhub proves the fee was paid; a refunded payment has none", async () => {
  const rid = passResourceId();
  const ok = fakeHub(true);
  const receipt = await fetchReceipt(ok.rpc, PAYER, FEE, rid, 9n);
  assert.deepEqual(ok.calls, [2, 1]); // compute the key, then read the receipt
  assert.equal(receipt!.amountPaid, 1000);
  assert.equal(receipt!.fee, 100);
  assert.equal(receiptPays(receipt, FEE, 1000), true);
  assert.equal(await fetchReceipt(fakeHub(false).rpc, PAYER, FEE, rid, 9n), null);
});

test("a receipt only proves a payment if it paid the fee address enough", async () => {
  const rid = passResourceId();
  const short = await fetchReceipt(fakeHub(true, { amount: 400 }).rpc, PAYER, FEE, rid, 9n);
  assert.equal(receiptPays(short, FEE, 1000), false);
  const wrongSeller = await fetchReceipt(fakeHub(true, { seller: PAYER }).rpc, PAYER, FEE, rid, 9n);
  assert.equal(receiptPays(wrongSeller, FEE, 1000), false);
  assert.equal(receiptPays(null, FEE, 1), false);
});

test("waitForReceipt retries until QPayhub shows the payment, and gives up if it never does", async () => {
  const rid = passResourceId();
  const p = { payer: PAYER, seller: FEE, resourceId: rid, nonce: 9n, amountQu: 1000 };
  const slept: number[] = [];
  const sleep = async (ms: number) => void slept.push(ms);
  assert.equal(await waitForReceipt(fakeHub(true).rpc, p, { sleep }), true);
  assert.deepEqual(slept, []); // found on the first look
  assert.equal(await waitForReceipt(fakeHub(false).rpc, p, { attempts: 3, delayMs: 7, sleep }), false);
  assert.deepEqual(slept, [7, 7]);
});
