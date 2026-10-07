import test from "node:test";
import assert from "node:assert/strict";
import { liquidate, liquidationRoutes, parseHoldings } from "../src/liquidation.ts";
import type { LiquidationDeps } from "../src/liquidation.ts";
import { RouteError } from "../src/routes.ts";

/** A market that fills up to `depth` units at `price`, less a fee. */
const market = (m: Record<string, { depth: number; price: number; fee?: number; mid: number; venue?: string }>): LiquidationDeps => ({
  quote: async (asset, qty) => {
    const x = m[asset];
    if (!x) throw new RouteError(404, `Unknown asset '${asset}'`);
    const filled = Math.min(qty, x.depth);
    const total = filled * x.price * (1 - (x.fee ?? 0.003));
    return { filledQty: filled, totalQu: total, averagePriceQu: filled ? total / filled : null, route: filled ? [{ venue: x.venue ?? "QX" }] : [] };
  },
  midPrice: (asset) => m[asset]?.mid ?? null,
  now: () => 123,
});

test("a holding sold in full brings what the market gives after fees, and says how far that is from the mid price", async () => {
  const r = await liquidate([{ asset: "AAA", qty: 1000 }], market({ AAA: { depth: 5000, price: 98, mid: 100 } }));
  const x = r.items[0];
  assert.equal(x.complete, true);
  assert.equal(x.fillableQty, 1000);
  assert.ok(Math.abs(x.proceedsQu - 1000 * 98 * 0.997) < 1e-6);
  assert.equal(x.midValueQu, 100_000);
  assert.ok(Math.abs(x.haircutPct! - (1 - (98 * 0.997) / 100) * 100) < 1e-9);
  assert.deepEqual(x.venues, ["QX"]);
  assert.equal(r.incomplete, 0);
  assert.equal(r.at, 123);
});

test("a market that cannot take it all counts only what it can take, and marks the asset incomplete", async () => {
  const r = await liquidate([{ asset: "AAA", qty: 1000 }], market({ AAA: { depth: 400, price: 100, fee: 0, mid: 100 } }));
  const x = r.items[0];
  assert.equal(x.complete, false);
  assert.equal(x.fillableQty, 400);
  assert.equal(x.proceedsQu, 40_000);
  assert.equal(x.midValueQu, 100_000); // the whole holding at mid, for comparison
  assert.equal(x.haircutPct, 0); // measured on the part that sold
  assert.equal(r.incomplete, 1);
});

test("an asset nobody will buy is worth nothing now, and one that cannot be priced says why without spoiling the rest", async () => {
  const r = await liquidate([{ asset: "AAA", qty: 10 }, { asset: "BBB", qty: 10 }, { asset: "NOPE", qty: 5 }], market({ AAA: { depth: 0, price: 1, mid: 50 }, BBB: { depth: 100, price: 20, fee: 0, mid: 20 } }));
  assert.equal(r.items[0].proceedsQu, 0);
  assert.equal(r.items[0].avgPriceQu, null);
  assert.equal(r.items[0].complete, false);
  assert.equal(r.items[1].proceedsQu, 200);
  assert.match(r.items[2].error!, /Unknown asset/);
  assert.equal(r.items[2].complete, false);
  assert.equal(r.totalProceedsQu, 200);
  assert.equal(r.totalMidQu, 500 + 200); // NOPE has no mid price: left out
  assert.equal(r.incomplete, 2 + 0 + 0 + 1 - 1); // AAA and NOPE
});

test("no mid price means no comparison, not a made-up one", async () => {
  const deps = market({ AAA: { depth: 100, price: 10, mid: 0 } });
  const r = await liquidate([{ asset: "AAA", qty: 10 }], { ...deps, midPrice: () => null });
  assert.equal(r.items[0].midValueQu, null);
  assert.equal(r.items[0].haircutPct, null);
  assert.ok(r.items[0].proceedsQu > 0);
});

test("a quote that says it filled more than was asked, or a negative total, cannot inflate the answer", async () => {
  const deps: LiquidationDeps = { quote: async () => ({ filledQty: 5000, totalQu: -50, averagePriceQu: null, route: [] }), midPrice: () => 10 };
  const r = await liquidate([{ asset: "AAA", qty: 100 }], deps);
  assert.equal(r.items[0].fillableQty, 100);
  assert.equal(r.items[0].proceedsQu, 0);
});

test("the holdings in a request must be a sane list: whole positive amounts, each asset once", () => {
  assert.deepEqual(parseHoldings({ holdings: [{ asset: "CFB", qty: 5 }, { asset: "CFB", qty: "1,000" }, { asset: "QX", qty: 2 }] }), [{ asset: "CFB", qty: 1005 }, { asset: "QX", qty: 2 }]);
  for (const bad of [null, {}, { holdings: [] }, { holdings: "x" }, { holdings: [{ asset: "", qty: 1 }] }, { holdings: [{ asset: "A", qty: 0 }] }, { holdings: [{ asset: "A", qty: 1.5 }] }, { holdings: [{ asset: "A", qty: -3 }] }, { holdings: [{ asset: "A", qty: 1e13 }] }, { holdings: [{ asset: "x".repeat(41), qty: 1 }] }, { holdings: [{ qty: 1 }] }, { holdings: Array.from({ length: 101 }, (_, i) => ({ asset: `A${i}`, qty: 1 })) }]) {
    assert.throws(() => parseHoldings(bad), (e: unknown) => e instanceof RouteError && e.status === 400, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("the route prices the holdings it is sent and refuses a bad body", async () => {
  const [route] = liquidationRoutes(market({ AAA: { depth: 100, price: 10, fee: 0, mid: 10 } }));
  assert.equal(route.method, "POST");
  assert.equal(route.path, "/v1/liquidation");
  assert.ok(route.doc.summary);
  const out = (await route.handler({ query: new URLSearchParams(), body: { holdings: [{ asset: "AAA", qty: 50 }] } })) as { totalProceedsQu: number };
  assert.equal(out.totalProceedsQu, 500);
  await assert.rejects(Promise.resolve(route.handler({ query: new URLSearchParams(), body: { holdings: [] } })), RouteError);
});

/* ---------- sharing the work ---------- */

import { cachedQuote } from "../src/liquidation.ts";

const answer = { filledQty: 10, totalQu: 100, averagePriceQu: 10, route: [{ venue: "QX" }] };

test("the same sale asked twice, or by two people at once, is priced once and then kept for a while", async () => {
  let now = 0;
  let calls = 0;
  const q = cachedQuote(async () => (calls++, answer), { ttlMs: 30_000, now: () => now });
  await Promise.all([q("AAA", 10), q("aaa", 10), q("AAA", 10)]);
  assert.equal(calls, 1);
  now = 29_000;
  await q("AAA", 10);
  assert.equal(calls, 1);
  now = 31_000;
  await q("AAA", 10);
  assert.equal(calls, 2);
  await q("AAA", 11); // another amount is another sale
  await q("BBB", 10);
  assert.equal(calls, 4);
});

test("a failed pricing is not kept, and the cache cannot grow past its limit", async () => {
  let calls = 0;
  const flaky = cachedQuote(async () => {
    calls++;
    if (calls === 1) throw new Error("down");
    return answer;
  });
  await assert.rejects(flaky("AAA", 1), /down/);
  assert.equal(flaky.size(), 0);
  await flaky("AAA", 1);
  assert.equal(calls, 2);
  const small = cachedQuote(async () => answer, { max: 3 });
  for (let i = 1; i <= 10; i++) await small("AAA", i);
  assert.equal(small.size(), 3);
});

test("only a few portfolios are priced at once; the rest are told to ask again in a moment", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const deps: LiquidationDeps = { quote: async () => (await gate, answer), midPrice: () => 10 };
  const [route] = liquidationRoutes(deps, { maxConcurrent: 2 });
  const ask = () => route.handler({ query: new URLSearchParams(), body: { holdings: [{ asset: "AAA", qty: 5 }] } }) as Promise<unknown>;
  const a = ask();
  const b = ask();
  await assert.rejects(ask(), (e: unknown) => e instanceof RouteError && e.status === 503 && e.extra.retryAfterSec === 3);
  release();
  await Promise.all([a, b]);
  await ask(); // room again
});
