import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildExecutionPlan } from "../src/exec.ts";
import type { ExecutableQuote } from "../src/exec.ts";
import { createApi } from "../src/api.ts";
import { SnapshotData } from "../src/data.ts";
import { assetNameToU64, identityToBytes } from "../src/identity.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const info = { issuer: ISSUER, assetName: "CFB", transferFeeQu: { qx: 100, qswap: 100 } };
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

test("buy split: QX bid + QSwap swap, with payload layouts", () => {
  const q: ExecutableQuote = {
    asset: "CFB", side: "buy", assetInfo: info,
    route: [
      { venue: "QX", qty: 100, execution: { type: "qx-bid", qty: 100, limitPrice: 303 } },
      { venue: "QSwap", qty: 50, execution: { type: "qswap-buy", qty: 50, maxQuIn: 160 } },
    ],
  };
  const plan = buildExecutionPlan(q);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["qx-bid", "qswap-buy"]);

  const [bid, swap] = plan.steps;
  assert.deepEqual(bid.to, { contractIndex: 1 });
  assert.equal(bid.inputType, 6);
  assert.equal(bid.amountQu, 303 * 100);
  assert.equal(bid.payload.length, 56);
  assert.deepEqual([...bid.payload.slice(0, 32)], [...identityToBytes(ISSUER)]);
  assert.equal(view(bid.payload).getBigUint64(32, true), assetNameToU64("CFB"));
  assert.equal(view(bid.payload).getBigInt64(40, true), 303n);
  assert.equal(view(bid.payload).getBigInt64(48, true), 100n);

  assert.deepEqual(swap.to, { contractIndex: 13 });
  assert.equal(swap.inputType, 7);
  assert.equal(swap.amountQu, 160 + 100_000);
  assert.equal(swap.payload.length, 48);
  assert.equal(view(swap.payload).getBigInt64(40, true), 50n);

  assert.equal(plan.maxOutlayQu, 30_300 + 100_160);
});

test("sell: QSwap leg with min out, and shares are moved from QX when needed", () => {
  const q: ExecutableQuote = {
    asset: "CFB", side: "sell", assetInfo: info,
    route: [{ venue: "QSwap", qty: 80, execution: { type: "qswap-sell", qty: 80, minQuOut: 900 } }],
  };
  const plan = buildExecutionPlan(q, { 1: 100, 13: 30 });
  const [move, swap] = plan.steps;
  assert.equal(move.kind, "transfer-rights");
  assert.deepEqual(move.to, { contractIndex: 1 }); // called on the contract that currently manages the shares
  assert.equal(move.inputType, 9);
  assert.equal(move.amountQu, 100);
  assert.equal(view(move.payload).getBigInt64(40, true), 50n); // 80 needed - 30 already at QSwap
  assert.equal(view(move.payload).getUint32(48, true), 13);
  assert.equal(swap.inputType, 8);
  assert.equal(swap.amountQu, 100_000);
  assert.equal(view(swap.payload).getBigInt64(40, true), 80n);
  assert.equal(view(swap.payload).getBigInt64(48, true), 900n);
});

test("sell: no transfer when shares already sit at the venue; clear error when short", () => {
  const q: ExecutableQuote = {
    asset: "CFB", side: "sell", assetInfo: info,
    route: [{ venue: "QX", qty: 10, execution: { type: "qx-ask", qty: 10, limitPrice: 95 } }],
  };
  const plan = buildExecutionPlan(q, { 1: 10 });
  assert.deepEqual(plan.steps.map((s) => s.kind), ["qx-ask"]);
  assert.equal(plan.steps[0].amountQu, 0);
  assert.throws(() => buildExecutionPlan(q, { 1: 3 }), /Insufficient CFB/);
});

test("API returns execution hints with slippage applied when the data source is executable", async () => {
  class Executable extends SnapshotData {
    async assetInfo() {
      return { symbol: "DEMO", ...info };
    }
  }
  const data = new Executable([JSON.parse(readFileSync("examples/snapshot.json", "utf8"))]);
  const server = createApi({ data });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const j = await (await fetch(`${base}/v1/quote?side=buy&asset=DEMO&qty=100000&slippageBps=100`)).json();
  server.close();
  assert.equal(j.executable, true);
  const qx = j.route.find((r: { venue: string }) => r.venue === "QX");
  assert.equal(qx.execution.type, "qx-bid");
  assert.equal(qx.execution.limitPrice, Math.ceil(108 * 1.01)); // worst ask consumed is 108
  const sw = j.route.find((r: { venue: string }) => r.venue === "QSwap");
  assert.ok(sw.execution.maxQuIn > sw.totalQu - sw.fixedCostQu);
  const plan = buildExecutionPlan(j);
  assert.ok(plan.steps.every((s) => s.kind !== "payment")); // no per-trade fee: the pass covers it
});

import { buildCancelStep } from "../src/exec.ts";
import { fetchAllRestingOrders } from "../src/verify.ts";
import { QubicRpc } from "../src/rpc.ts";

test("cancel steps use the remove-order calls with the same payload layout as placing one", () => {
  const order = { side: "bid" as const, price: 150, qty: 40, assetName: "CFB", assetNameU64: assetNameToU64("CFB"), issuerBytes: identityToBytes(ISSUER), key: "k" };
  const bid = buildCancelStep(order);
  assert.equal(bid.inputType, 8);
  assert.equal(bid.amountQu, 0);
  assert.deepEqual(bid.to, { contractIndex: 1 });
  assert.equal(bid.payload.length, 56);
  assert.equal(view(bid.payload).getBigInt64(40, true), 150n);
  assert.equal(view(bid.payload).getBigInt64(48, true), 40n);
  const ask = buildCancelStep({ ...order, side: "ask" }, 10);
  assert.equal(ask.inputType, 7);
  assert.equal(view(ask.payload).getBigInt64(48, true), 10n);
  assert.match(ask.description, /Cancel sell order: 10 CFB at 150 QU/);
});

test("fetchAllRestingOrders lists orders for every asset, bids and asks", async () => {
  const entry = (name: string, price: number, qty: number) => {
    const b = Buffer.alloc(56);
    b.set(identityToBytes(ISSUER), 0);
    b.writeBigUInt64LE(assetNameToU64(name), 32);
    b.writeBigInt64LE(BigInt(price), 40);
    b.writeBigInt64LE(BigInt(qty), 48);
    return b;
  };
  const page = (orders: Buffer[]) => Buffer.concat([...orders, Buffer.alloc((256 - orders.length) * 56)]);
  const fetch = (async (_u: string, init: { body: string }) => {
    const { inputType } = JSON.parse(init.body);
    const out = inputType === 5 ? page([entry("CFB", 3, 40), entry("QXMR", 1, 9)]) : page([entry("CFB", 5, 2)]);
    return { ok: true, status: 200, json: async () => ({ responseData: out.toString("base64") }) };
  }) as never;
  const orders = await fetchAllRestingOrders(new QubicRpc({ fetch, retries: 0, maxRps: 1000 }), ISSUER);
  assert.deepEqual(orders.map((o) => [o.side, o.assetName, o.price, o.qty]), [["bid", "CFB", 3, 40], ["bid", "QXMR", 1, 9], ["ask", "CFB", 5, 2]]);
  assert.equal(orders[0].key, `${assetNameToU64("CFB")}|${Buffer.from(identityToBytes(ISSUER)).toString("hex")}`);
});
