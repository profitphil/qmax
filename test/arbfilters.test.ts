import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_FILTERS, arbQuery, describeFilters, hasFilters, parseArbQuery, passesFilters, sanitizeArbFilters } from "../src/arbfilters.ts";
import { findArbitrage, findArbitrageVenues } from "../src/arbitrage.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";

const qxBook = (asks: [number, number][], bids: [number, number][]) =>
  new QxVenue({ asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 100, truncated: false });
const poolAt = (price: number) => new QswapVenue({ reserveQu: price * 1_000_000, reserveAsset: 1_000_000, swapFeeRate: 30, fixedCostQu: 100_100 });
const market = () => [qxBook([[80, 200_000]], [[70, 1000]]), poolAt(100)] as const;

test("filters are cleaned up: bad input means no limit, and nothing goes negative", () => {
  assert.deepEqual(sanitizeArbFilters(undefined), NO_FILTERS);
  assert.deepEqual(sanitizeArbFilters({ minProfitQu: -5, minProfitPct: "abc", maxCostQu: 2000 }), { minProfitQu: 0, minProfitPct: 0, maxCostQu: 2000 });
  assert.equal(sanitizeArbFilters({ minProfitPct: 99_999 }).minProfitPct, 1000);
  assert.equal(hasFilters(NO_FILTERS), false);
  assert.equal(hasFilters({ ...NO_FILTERS, maxCostQu: 1 }), true);
});

test("the API query round-trips, omits what is unset, and refuses junk", () => {
  const f = { minProfitQu: 5000, minProfitPct: 2.5, maxCostQu: 1_000_000 };
  assert.deepEqual(parseArbQuery(new URLSearchParams(arbQuery(f))), f);
  assert.equal(arbQuery(NO_FILTERS), "");
  assert.equal(arbQuery({ minProfitPct: 3 }), "minProfitPct=3");
  assert.deepEqual(parseArbQuery(new URLSearchParams("asset=X")), NO_FILTERS);
  assert.throws(() => parseArbQuery(new URLSearchParams("minProfitQu=-1")), /minProfitQu must be a number/);
  assert.throws(() => parseArbQuery(new URLSearchParams("maxCostQu=lots")), /maxCostQu must be a number/);
});

test("filters read well to a person", () => {
  assert.equal(describeFilters({ minProfitQu: 5000, minProfitPct: 2, maxCostQu: 1_000_000 }), "at least 5,000 QU profit, at least 2% profit, at most 1,000,000 QU in");
  assert.equal(describeFilters(NO_FILTERS), "");
});

test("an opportunity must clear every filter", () => {
  const o = { profitQu: 10_000, costQu: 100_000, profitPct: 10 };
  assert.equal(passesFilters(o, {}), true);
  assert.equal(passesFilters(o, { minProfitQu: 10_001 }), false);
  assert.equal(passesFilters(o, { minProfitPct: 10.5 }), false);
  assert.equal(passesFilters(o, { maxCostQu: 99_999 }), false);
  assert.equal(passesFilters(o, { minProfitQu: 10_000, minProfitPct: 10, maxCostQu: 100_000 }), true);
});

test("live search: a minimum can rule everything out, and a budget finds the best one that fits", () => {
  const [qx, pool] = market();
  const biggest = findArbitrageVenues(qx, pool)!;
  assert.ok(biggest.costQu > 1_000_000);
  assert.equal(findArbitrageVenues(qx, pool, { minProfitQu: biggest.profitQu + 1 }), null);
  assert.equal(findArbitrageVenues(qx, pool, { minProfitPct: biggest.profitPct + 50 }), null);
  const capped = findArbitrageVenues(qx, pool, { maxCostQu: 1_000_000 })!; // not null: a smaller loop fits
  assert.ok(capped.costQu <= 1_000_000 && capped.profitQu > 0);
  assert.ok(capped.profitQu < biggest.profitQu);
  assert.equal(findArbitrageVenues(qx, pool, { maxCostQu: 10 }), null); // too small for any loop to pay for the flat fees
});

test("the snapshot estimate takes the same filters", () => {
  const top = { bestAsk: 80, askQty: 200_000, bestBid: 70, bidQty: 1000, poolQu: 100_000_000, poolAsset: 1_000_000 };
  const biggest = findArbitrage(top)!;
  assert.equal(findArbitrage(top, { minProfitQu: biggest.profitQu + 1 }), null);
  const capped = findArbitrage(top, { maxCostQu: 1_000_000 })!;
  assert.ok(capped.costQu <= 1_000_000 && capped.profitQu < biggest.profitQu);
});
