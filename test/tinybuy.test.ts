import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/router.ts";
import { QSWAP_MIN_BUY_QU, QswapVenue, QxVenue } from "../src/venues.ts";
import { buildQuote } from "../src/quoteapi.ts";
import type { MarketData } from "../src/data.ts";

/**
 * Qswap.h's SwapQuForExactAsset: when the QU a buy needs is under its 36 QU protocol fee, the contract refunds only that small amount
 * and keeps the rest of what was attached, the flat 100,000 QU fee included. QMax must never offer such a buy to be signed.
 */

// A pool where one unit costs about 1 QU, so a couple of units need only a couple of QU.
const pool = () => new QswapVenue({ reserveQu: 1_000_000_000, reserveAsset: 1_000_000_000, swapFeeRate: 30, fixedCostQu: 100_100 });
const book = (price = 5, qty = 1_000_000) => new QxVenue({ asks: [{ price, qty }], bids: [{ price: price - 1, qty }], buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 100, truncated: false });

test("a tiny QSwap buy on a pool-only token is refused, with the reason, instead of being offered", () => {
  const plan = route([pool()], "buy", 2);
  assert.equal(plan.allocations.length, 0);
  assert.equal(plan.filledQty, 0);
  assert.match(plan.warnings.join(" "), /too small to buy on QSwap.*keeps the whole payment.*100,000 QU/);
});

test("the line sits at 1,000 QU of input: just under is refused, just over is offered", () => {
  const v = pool();
  const under = Math.floor(QSWAP_MIN_BUY_QU * 0.99);
  const over = Math.ceil(QSWAP_MIN_BUY_QU * 1.02);
  assert.ok(v.variableNetQu("buy", under) < QSWAP_MIN_BUY_QU && v.variableNetQu("buy", over) >= QSWAP_MIN_BUY_QU);
  assert.equal(route([v], "buy", under).allocations.length, 0);
  assert.equal(route([v], "buy", over).allocations.length, 1);
});

test("a caller that sizes orders itself can ask for the unfiltered quote", () => {
  const plan = route([pool()], "buy", 2, { allowTinyQswapBuy: true });
  assert.equal(plan.allocations.length, 1);
  assert.equal(plan.filledQty, 2);
});

test("where QX can fill a small buy it is routed there, not refused", () => {
  const plan = route([book(), pool()], "buy", 10);
  assert.deepEqual(plan.allocations.map((a) => a.venue), ["QX"]);
  assert.equal(plan.filledQty, 10);
});

test("a split never includes a QSwap leg that small: the router falls back to a route without it", () => {
  // QX holds only a few units, so a buy a little bigger than that would send the rest to the pool; the rest is tiny.
  const plan = route([book(5, 8), pool()], "buy", 10);
  for (const a of plan.allocations) assert.ok(a.venue !== "QSwap" || a.quote.netQu - a.quote.fixedCostQu >= QSWAP_MIN_BUY_QU, `a ${a.venue} leg of ${a.quote.netQu - a.quote.fixedCostQu} QU would be offered`);
  assert.equal(plan.filledQty === 10 || plan.filledQty === 0, true);
});

test("a sell is never refused for this: the contract refunds the flat fee on every failed sell", () => {
  const plan = route([pool()], "sell", 20_000_000);
  assert.equal(plan.allocations.length, 1);
});

test("the API quote carries the refusal as an unfillable quote with the warning, and the bypass exists only for in-process callers", async () => {
  const data: MarketData = {
    assets: () => ["CHEAP"],
    venues: async (a) => (a.toUpperCase() === "CHEAP" ? [pool()] : null),
  };
  const q = await buildQuote(data, { side: "buy", asset: "CHEAP", qty: 2 });
  assert.equal(q.fillable, false);
  assert.equal(q.route.length, 0);
  assert.match(q.warnings.join(" "), /too small to buy on QSwap/);
  const internal = await buildQuote(data, { side: "buy", asset: "CHEAP", qty: 2 }, { allowTinyQswapBuy: true });
  assert.equal(internal.fillable, true);
  // a request body cannot switch it on: the option is a separate argument, not read from the input
  const sneaky = await buildQuote(data, { side: "buy", asset: "CHEAP", qty: 2, allowTinyQswapBuy: true });
  assert.equal(sneaky.fillable, false);
});
