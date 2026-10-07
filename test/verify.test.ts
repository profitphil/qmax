import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchOpenQxOrders, summarizeOutcome } from "../src/verify.ts";
import { QubicRpc } from "../src/rpc.ts";
import { assetNameToU64, identityToBytes } from "../src/identity.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const snap = (balanceQu: number, qx: number, qswap = 0) => ({ balanceQu, holdings: { 1: qx, 13: qswap } });

test("buy fully filled: actual price and slippage vs quote", () => {
  const o = summarizeOutcome({ side: "buy", requestedQty: 100, quotedQu: 10_000, before: snap(50_000, 0), after: snap(39_900, 100), openOrders: [] });
  assert.equal(o.status, "filled");
  assert.equal(o.filledQty, 100);
  assert.equal(o.actualQu, 10_100);
  assert.ok(Math.abs(o.slippage! - 0.01) < 1e-9);
});

test("buy partially filled with the rest resting as a QX bid: locked QU is not counted as spent", () => {
  const o = summarizeOutcome({
    side: "buy", requestedQty: 100, quotedQu: 10_000,
    before: snap(50_000, 0), after: snap(50_000 - 6_000 - 4_100, 60),
    openOrders: [{ side: "bid", price: 102.5, qty: 40 }],
  });
  assert.equal(o.status, "partial");
  assert.equal(o.filledQty, 60);
  assert.equal(o.lockedInOrdersQu, 4_100);
  assert.equal(o.actualQu, 6_000);
  assert.equal(o.slippage, null);
});

test("sell uses shares leaving the wallet and QU received; nothing filled is reported", () => {
  const sold = summarizeOutcome({ side: "sell", requestedQty: 10, quotedQu: 1_000, before: snap(1_000, 5, 5), after: snap(1_980, 0, 0), openOrders: [] });
  assert.equal(sold.status, "filled");
  assert.equal(sold.actualQu, 980);
  assert.ok(Math.abs(sold.slippage! - 0.02) < 1e-9);
  const none = summarizeOutcome({ side: "sell", requestedQty: 10, quotedQu: 1_000, before: snap(1_000, 10), after: snap(1_000, 10), openOrders: [] });
  assert.equal(none.status, "nothing");
  assert.equal(none.actualPriceQu, null);
});

test("fetchOpenQxOrders keeps only this asset's orders", async () => {
  const entry = (issuer: Uint8Array, name: bigint, price: number, qty: number) => {
    const b = Buffer.alloc(56);
    b.set(issuer, 0);
    b.writeBigUInt64LE(name, 32);
    b.writeBigInt64LE(BigInt(price), 40);
    b.writeBigInt64LE(BigInt(qty), 48);
    return b;
  };
  const page = (orders: Buffer[]) => Buffer.concat([...orders, Buffer.alloc((256 - orders.length) * 56)]);
  const mine = identityToBytes(ISSUER);
  const other = identityToBytes("QXMRTKAIIGLUREPIQPCMHCKWSIPDTUYFCFNYXQLTECSUJVYEMMDELBMDOEYB");
  const fetch = (async (_u: string, init: { body: string }) => {
    const { inputType } = JSON.parse(init.body);
    const out = inputType === 5 ? page([entry(mine, assetNameToU64("CFB"), 3, 40), entry(other, assetNameToU64("QXMR"), 1, 9)]) : page([]);
    return { ok: true, status: 200, json: async () => ({ responseData: out.toString("base64") }) };
  }) as never;
  const orders = await fetchOpenQxOrders(new QubicRpc({ fetch, retries: 0 }), ISSUER, ISSUER, "CFB");
  assert.deepEqual(orders, [{ side: "bid", price: 3, qty: 40 }]);
});
