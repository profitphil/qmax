import test from "node:test";
import assert from "node:assert/strict";
import { STILL_PRICING, combineLiquidation, inRuns, liquidate, liquidationRoutes, parseHoldings, quoteWhatFits, sellCapacity, sharedRead } from "../src/liquidation.ts";
import { route } from "../src/router.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";
import type { Venue } from "../src/types.ts";
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

// ---- a holding the buyers cannot take in full is priced for the part they can take (30 held, buyers for 12)

const qxBids = (bids: [number, number][]) => new QxVenue({ asks: [], bids: bids.map(([price, qty]) => ({ price, qty })), buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 100, truncated: false });
// a pool worth 10 billion QU, so a sale of a few units is worth far more than its flat 100,000 QU fee
const pool = () => new QswapVenue({ reserveQu: 10_000_000_000, reserveAsset: 1000, swapFeeRate: 30, fixedCostQu: 100_000 });

/** The real router, as the server wires it: a sale of `qty` priced across `venues`. */
const routed = (venues: Venue[]): LiquidationDeps["quote"] => async (_asset, qty) => {
  const plan = route(venues, "sell", qty);
  return { filledQty: plan.filledQty, totalQu: plan.totalNetQu, averagePriceQu: Number.isFinite(plan.averagePrice) ? plan.averagePrice : null, route: plan.allocations.map((a) => ({ venue: a.venue })) };
};

test("the router alone prices nothing for 30 shares when buyers want only 12 (why a capacity-aware quote is needed)", async () => {
  const venues = [qxBids([[100, 7], [99, 5]])];
  const q = await routed(venues)("QTREAT", 30);
  assert.equal(q.filledQty, 0);
});

test("with buyers for 12 of 30 shares, the 12 are priced and the holding is marked incomplete", async () => {
  const venues = [qxBids([[100, 7], [99, 5]])];
  const deps: LiquidationDeps = { quote: quoteWhatFits(routed(venues), async () => sellCapacity(venues)), midPrice: () => 100, now: () => 1 };
  const r = await liquidate([{ asset: "QTREAT", qty: 30 }], deps);
  const x = r.items[0];
  assert.equal(x.qty, 30);
  assert.equal(x.fillableQty, 12);
  assert.equal(x.complete, false);
  assert.equal(r.incomplete, 1);
  // exactly what a sale of the 12 the buyers want brings (7 at 100 and 5 at 99, QX's fees and flat cost taken off), no more
  assert.equal(x.proceedsQu, route(venues, "sell", 12).totalNetQu);
  assert.ok(x.proceedsQu > 1000 && x.proceedsQu < 1195, String(x.proceedsQu));
  assert.equal(x.midValueQu, 3000); // the whole holding at the mid price, for comparison
  assert.deepEqual(x.venues, ["QX"]);
  assert.equal(r.totalProceedsQu, x.proceedsQu);
});

test("buyers for the whole holding: nothing is cut short, and the whole-amount answer is used as it is", async () => {
  const venues = [qxBids([[100, 40]])];
  const calls: number[] = [];
  const inner = routed(venues);
  const quote = quoteWhatFits(async (a, q) => (calls.push(q), inner(a, q)), async () => sellCapacity(venues));
  const q = await quote("X", 30);
  assert.equal(q.filledQty, 30);
  assert.deepEqual(calls, [30]); // one pricing, not two
});

test("a pool takes any amount, so a holding it backs is never marked incomplete", async () => {
  const venues = [qxBids([[100, 12]]), pool()];
  assert.equal(sellCapacity(venues), Infinity);
  const r = await liquidate([{ asset: "P", qty: 30 }], { quote: quoteWhatFits(routed(venues), async () => sellCapacity(venues)), midPrice: () => 10_000_000, now: () => 1 });
  assert.equal(r.items[0].complete, true);
  assert.equal(r.items[0].fillableQty, 30);
});

test("no bids at all is still no buyers (nothing to price), and unknown capacity cuts nothing short", async () => {
  assert.equal(sellCapacity([qxBids([])]), 0);
  const none = [qxBids([])];
  const r = await liquidate([{ asset: "N", qty: 30 }], { quote: quoteWhatFits(routed(none), async () => sellCapacity(none)), midPrice: () => 100, now: () => 1 });
  assert.equal(r.items[0].fillableQty, 0);
  assert.equal(r.items[0].proceedsQu, 0);
  assert.equal(r.items[0].complete, false);
  // an unknown kind of market, or a capacity that cannot be read, leaves the whole-amount answer alone
  const odd = { name: "Odd", fixedCostQu: 0, variableNetQu: () => 0, quote: () => null } as Venue;
  assert.equal(sellCapacity([odd]), Infinity);
  const whole = { filledQty: 0, totalQu: 0, averagePriceQu: null, route: [] };
  assert.deepEqual(await quoteWhatFits(async () => whole, async () => { throw new Error("rpc"); })("A", 5), whole);
  assert.deepEqual(await quoteWhatFits(async () => whole, async () => null)("A", 5), whole);
});

// ---- pricing many holdings: a few at a time, and a passing failure is asked again

const filled = (qty: number) => ({ filledQty: qty, totalQu: qty * 10, averagePriceQu: 10, route: [{ venue: "QX" }] });

test("at most four holdings are priced at the same moment, and every one still gets its answer in order", async () => {
  let running = 0;
  let most = 0;
  const deps: LiquidationDeps = {
    quote: async (_a, qty) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return filled(qty);
    },
    midPrice: () => 10,
    now: () => 1,
  };
  const inputs = Array.from({ length: 25 }, (_, i) => ({ asset: `A${i}`, qty: i + 1 }));
  const r = await liquidate(inputs, deps);
  assert.ok(most <= 4, `${most} were priced at once`);
  assert.ok(most > 1, "but not one at a time");
  assert.deepEqual(r.items.map((x) => x.asset), inputs.map((x) => x.asset));
  assert.ok(r.items.every((x, i) => x.complete && x.fillableQty === i + 1 && !x.error));
  assert.equal((await liquidate(inputs, deps, { concurrency: 1 })).items.length, 25);
});

test("a holding that fails because the node is busy is asked again and priced; a lasting failure is not asked again", async () => {
  const tries = new Map<string, number>();
  const deps: LiquidationDeps = {
    quote: async (asset, qty) => {
      tries.set(asset, (tries.get(asset) ?? 0) + 1);
      if (asset === "BUSY" && tries.get(asset)! <= 2) throw new Error("The Qubic node is busy (too many requests are waiting). Try again shortly.");
      if (asset === "GONE") throw new RouteError(404, "Unknown asset 'GONE'");
      return filled(qty);
    },
    midPrice: () => 10,
    now: () => 1,
  };
  const r = await liquidate([{ asset: "BUSY", qty: 5 }, { asset: "GONE", qty: 5 }, { asset: "FINE", qty: 5 }], deps, { retryDelayMs: 1 });
  const by = Object.fromEntries(r.items.map((x) => [x.asset, x]));
  assert.equal(by.BUSY.complete, true, "priced on the third try");
  assert.equal(by.BUSY.error, undefined);
  assert.equal(tries.get("BUSY"), 3);
  assert.match(by.GONE.error!, /Unknown asset/);
  assert.equal(tries.get("GONE"), 1, "an unknown asset is not asked again");
  assert.equal(tries.get("FINE"), 1);
});

test("a holding that keeps failing is reported with the reason after the retries, and does not spoil the rest", async () => {
  let calls = 0;
  const deps: LiquidationDeps = {
    quote: async (asset, qty) => {
      if (asset === "DOWN") {
        calls++;
        throw new Error("The Qubic node is busy (too many requests are waiting). Try again shortly.");
      }
      return filled(qty);
    },
    midPrice: () => 10,
    now: () => 1,
  };
  const r = await liquidate([{ asset: "DOWN", qty: 3 }, { asset: "UP", qty: 3 }], deps, { retryDelayMs: 1, retries: 2 });
  assert.equal(calls, 3, "the first try and two more");
  assert.match(r.items[0].error!, /node is busy/);
  assert.equal(r.items[1].complete, true);
  assert.equal(r.totalProceedsQu, 30);
});

test("a portfolio is cut into runs in order, and an answer put together from runs has the same totals as one made whole", async () => {
  assert.deepEqual(inRuns([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(inRuns([], 8), []);
  assert.deepEqual(inRuns([1, 2], 8), [[1, 2]]);
  const deps: LiquidationDeps = { quote: async (_a, qty) => filled(qty), midPrice: () => 11, now: () => 5 };
  const inputs = Array.from({ length: 10 }, (_, i) => ({ asset: `A${i}`, qty: i + 1 }));
  const whole = await liquidate(inputs, deps);
  const parts = await Promise.all(inRuns(inputs, 4).map((run) => liquidate(run, deps)));
  const combined = combineLiquidation(parts.flatMap((p) => p.items), 5);
  assert.deepEqual(combined, whole);
  assert.equal(combined.totalProceedsQu, 550);
});

test("pricing that runs past its time budget hands back the holdings not yet started unpriced, with the reason that says to ask again", async () => {
  const deps: LiquidationDeps = {
    quote: async (_a, qty) => {
      await new Promise((r) => setTimeout(r, 30));
      return filled(qty);
    },
    midPrice: () => 10,
    now: () => 1,
  };
  const inputs = Array.from({ length: 8 }, (_, i) => ({ asset: `S${i}`, qty: 2 }));
  const r = await liquidate(inputs, deps, { concurrency: 1, budgetMs: 70 });
  const priced = r.items.filter((x) => !x.error);
  const left = r.items.filter((x) => x.error);
  assert.ok(priced.length >= 1 && priced.length < 8, `${priced.length} priced`);
  assert.ok(left.every((x) => x.error === STILL_PRICING && x.fillableQty === 0 && !x.complete));
  assert.deepEqual(r.items.map((x) => x.asset), inputs.map((x) => x.asset), "still in order");
  assert.equal(r.items.length, 8);
});

test("a market read is kept and shared for a while: two wallets holding the same asset make one reading; failures and unknown assets are not kept", async () => {
  let clock = 1000;
  const reads: string[] = [];
  const read = sharedRead<string>(
    async (asset) => {
      reads.push(asset);
      if (asset === "BOOM") throw new Error("node busy");
      return asset === "NOPE" ? null : `book of ${asset}`;
    },
    { ttlMs: 60_000, max: 3, now: () => clock },
  );
  const [a, b] = await Promise.all([read("qmine"), read("QMINE")]); // two at once, any case
  assert.equal(a, "book of qmine");
  assert.equal(b, a);
  assert.equal(reads.length, 1);
  clock += 30_000;
  await read("QMINE");
  assert.equal(reads.length, 1, "still kept after half a minute");
  clock += 31_000;
  await read("QMINE");
  assert.equal(reads.length, 2, "read again once the time is up");
  await assert.rejects(read("BOOM"), /node busy/);
  await assert.rejects(read("BOOM"), /node busy/);
  assert.equal(reads.filter((r) => r === "BOOM").length, 2, "a failure is asked for again");
  assert.equal(await read("NOPE"), null);
  await read("NOPE");
  assert.equal(reads.filter((r) => r === "NOPE").length, 2, "an unknown asset is asked for again");
  for (const x of ["A", "B", "C", "D"]) await read(x);
  const before = reads.length;
  await read("D");
  assert.equal(reads.length, before, "the newest are still held");
  await read("A");
  assert.equal(reads.length, before + 1, "the oldest went first once more than max were held");
});
