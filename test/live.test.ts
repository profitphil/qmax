import { test } from "node:test";
import assert from "node:assert/strict";
import { identityToBytes, assetNameToU64 } from "../src/identity.ts";
import { LiveMarketData } from "../src/live.ts";
import { QubicRpc } from "../src/rpc.ts";
import { route } from "../src/router.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";

test("identity and asset name encoding", () => {
  assert.deepEqual([...identityToBytes("A".repeat(60))], new Array(32).fill(0));
  assert.equal(identityToBytes(ISSUER).length, 32);
  assert.throws(() => identityToBytes("abc"));
  assert.equal(assetNameToU64("QX"), 0x5851n); // 'Q'=0x51, 'X'=0x58, little-endian
});

const le = (...vals: [number, "u32" | "i64"][]) => {
  const size = vals.reduce((s, [, t]) => s + (t === "u32" ? 4 : 8), 0);
  const b = Buffer.alloc(size);
  let o = 0;
  for (const [v, t] of vals) {
    if (t === "u32") b.writeUInt32LE(v, o), (o += 4);
    else b.writeBigInt64LE(BigInt(v), o), (o += 8);
  }
  return b;
};
const order = (price: number, qty: number) => Buffer.concat([Buffer.alloc(32, 1), le([price, "i64"], [qty, "i64"])]);
const page = (orders: Buffer[]) => Buffer.concat([...orders, Buffer.alloc((256 - orders.length) * 48)]);

function mockRpc(opts: { asks: Buffer[][]; poolExists?: boolean }) {
  const calls: string[] = [];
  const fetch = (async (_url: string, init: { body: string }) => {
    const { contractIndex, inputType, requestData } = JSON.parse(init.body);
    const input = Buffer.from(requestData, "base64");
    calls.push(`${contractIndex}:${inputType}`);
    let out: Buffer;
    if (contractIndex === 1 && inputType === 1) out = le([1e9, "u32"], [100, "u32"], [3_000_000, "u32"]);
    else if (contractIndex === 1 && inputType === 2) out = page(opts.asks[Number(input.readBigUInt64LE(40)) / 256] ?? []);
    else if (contractIndex === 1 && inputType === 3) out = page([order(95, 1000)]);
    else if (contractIndex === 13 && inputType === 1)
      out = le([1e9, "u32"], [2e8, "u32"], [100, "u32"], [30, "u32"], [27, "u32"], [3, "u32"], [5, "u32"], [1, "u32"]);
    else if (contractIndex === 13 && inputType === 2)
      out = le([opts.poolExists === false ? 0 : 1, "i64"], [1_000_000, "i64"], [10_000, "i64"], [5, "i64"], [0, "i64"]);
    else if (contractIndex === 13 && inputType === 7) out = le([123456, "i64"]);
    else throw new Error(`unexpected ${contractIndex}:${inputType}`);
    return { ok: true, status: 200, json: async () => ({ responseData: out.toString("base64") }) };
  }) as unknown as typeof globalThis.fetch;
  return { rpc: new QubicRpc({ fetch, retries: 0 }), calls };
}

test("live adapter reads fees, pages the QX book and parses the pool", async () => {
  const full = Array.from({ length: 256 }, (_, i) => order(100 + i, 10));
  const { rpc, calls } = mockRpc({ asks: [full, [order(400, 5)]] });
  const data = new LiveMarketData([{ symbol: "CFB", issuer: ISSUER }], { rpc });
  const venues = (await data.venues("cfb"))!;
  assert.deepEqual(venues.map((v) => v.name), ["QX", "QSwap"]);
  assert.equal(calls.filter((c) => c === "1:2").length, 2); // second page fetched
  const qx = venues[0].quote("buy", 2565)!; // 256*10 + 5 shares needs the second page
  assert.ok(qx);
  assert.equal(venues[0].quote("sell", 100)!.fixedCostQu, 0, "QX takes no flat fee on an order");
  const plan = route(venues, "buy", 500);
  assert.ok(plan.filledQty === 500);
});

test("no pool means QSwap is skipped; unknown symbol is null", async () => {
  const { rpc } = mockRpc({ asks: [[order(100, 10)]], poolExists: false });
  const data = new LiveMarketData([{ symbol: "CFB", issuer: ISSUER }], { rpc });
  assert.deepEqual((await data.venues("CFB"))!.map((v) => v.name), ["QX"]);
  assert.equal(await data.venues("NOPE"), null);
});

test("verify compares QSwap allocations with the on-chain quote", async () => {
  const { rpc } = mockRpc({ asks: [[]] });
  const data = new LiveMarketData([{ symbol: "CFB", issuer: ISSUER }], { rpc });
  const venues = (await data.venues("CFB"))!;
  const plan = route(venues, "buy", 100);
  const checks = (await data.verify("CFB", plan.allocations)) as { onChainQu: number; modelQu: number }[];
  assert.equal(checks.length, 1);
  assert.equal(checks[0].onChainQu, 123456);
});

test("RPC failures are retried then reported", async () => {
  let n = 0;
  const rpc = new QubicRpc({ retries: 2, fetch: (async () => (n++, { ok: false, status: 503 })) as never });
  await assert.rejects(rpc.query(1, 1), /unavailable/);
  assert.equal(n, 3);
});

test("the contracts' fee tables are read once for every asset, not once per asset (two of the five requests a market read made)", async () => {
  const { rpc, calls } = mockRpc({ asks: [[order(100, 10)]] });
  const data = new LiveMarketData([{ symbol: "CFB", issuer: ISSUER }, { symbol: "QDOGE", issuer: ISSUER }, { symbol: "QMINE", issuer: ISSUER }], { rpc, cacheMs: 0 });
  await Promise.all(["CFB", "QDOGE", "QMINE"].map((s) => data.venues(s)));
  await data.venues("CFB"); // and again later: still the one reading
  assert.equal(calls.filter((c) => c === "1:1").length, 1, "QX fees");
  assert.equal(calls.filter((c) => c === "13:1").length, 1, "QSwap fees");
  assert.equal(calls.filter((c) => c === "1:2").length, 4, "each market read still reads its own asks");
  assert.equal(calls.filter((c) => c === "13:2").length, 4, "and its own pool");
});

test("a one-share QX buy costs the share's price, not the price plus a flat 100 QU (the contract takes no flat fee on an order)", async () => {
  // asks: 1 share at 24 QU. QX's fee comes out of the seller's proceeds, so the buyer pays 24.
  const { rpc } = mockRpc({ asks: [[order(24, 5)]], poolExists: false });
  const data = new LiveMarketData([{ symbol: "QDOGE", issuer: ISSUER }], { rpc });
  const venues = (await data.venues("QDOGE"))!;
  const plan = route(venues, "buy", 1);
  assert.equal(plan.filledQty, 1);
  assert.equal(plan.totalNetQu, 24);
  assert.equal(plan.averagePrice, 24);
  assert.deepEqual(plan.warnings, [], "no 'fees are 417% of this trade' warning");
  assert.equal(plan.allocations[0].quote.fixedCostQu, 0);
});
