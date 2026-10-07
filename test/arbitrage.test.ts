import { test } from "node:test";
import assert from "node:assert/strict";
import { comparePrices, findArbitrage, onBothMarkets } from "../src/arbitrage.ts";

// Pool price 100 QU per unit (deep pool); QX book varies per test.
const pool = { poolQu: 1_000_000_000, poolAsset: 10_000_000 };

test("price comparison picks the cheaper buy and the better sell", () => {
  const c = comparePrices({ ...pool, bestAsk: 90, askQty: 1000, bestBid: 80, bidQty: 1000 })!;
  assert.equal(c.buy.cheaperOn, "QX"); // 90 vs ~100.3 on the pool
  assert.ok(c.buy.pct > 0.09 && c.buy.pct < 0.11);
  assert.equal(c.sell.betterOn, "QSwap"); // pool pays ~99.7, QX bid nets ~79.8
  const d = comparePrices({ ...pool, bestAsk: 120, askQty: 1000, bestBid: 110, bidQty: 1000 })!;
  assert.equal(d.buy.cheaperOn, "QSwap");
  assert.equal(d.sell.betterOn, "QX");
});

test("no comparison or arbitrage unless the asset trades on both markets", () => {
  assert.equal(onBothMarkets({ bestAsk: 1, askQty: 1, bestBid: 1, bidQty: 1 }), false);
  assert.equal(comparePrices({ poolQu: 10, poolAsset: 10 }), null);
  assert.equal(findArbitrage({ ...pool }), null);
});

test("a book far below the pool price is an arbitrage after all fees, and size is capped by the book", () => {
  // Buy on QX at 80, sell into the pool at ~99.7: ~19.7 QU per unit before the flat 100,300 QU of fees.
  const a = findArbitrage({ ...pool, bestAsk: 80, askQty: 50_000, bestBid: 70, bidQty: 1000 })!;
  assert.equal(a.direction, "buy-qx-sell-qswap");
  assert.ok(a.qty <= 50_000 && a.qty > 5_000);
  assert.ok(a.profitQu > 0 && a.profitPct > 5);
});

test("flat fees swallow a small edge: tiny books give no arbitrage", () => {
  assert.equal(findArbitrage({ ...pool, bestAsk: 80, askQty: 100, bestBid: 70, bidQty: 100 }), null);
});

test("a book that matches the pool price is not an arbitrage", () => {
  assert.equal(findArbitrage({ ...pool, bestAsk: 101, askQty: 100_000, bestBid: 99, bidQty: 100_000 }), null);
});

test("buying cheap on the pool and selling to a high QX bid is the other direction", () => {
  const a = findArbitrage({ ...pool, bestAsk: 130, askQty: 1000, bestBid: 120, bidQty: 60_000 })!;
  assert.equal(a.direction, "buy-qswap-sell-qx");
  assert.ok(a.profitQu > 0);
});

import { findArbitrageVenues } from "../src/arbitrage.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";

const qxBook = (asks: [number, number][], bids: [number, number][]) =>
  new QxVenue({ asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 100, truncated: false });
const poolAt = (price: number) => new QswapVenue({ reserveQu: price * 1_000_000, reserveAsset: 1_000_000, swapFeeRate: 30, fixedCostQu: 100_100 });

test("live search uses the whole book: a deep cheap ask is found, and a thin one is not", () => {
  const deep = findArbitrageVenues(qxBook([[80, 200_000]], [[70, 1000]]), poolAt(100))!;
  assert.equal(deep.direction, "buy-qx-sell-qswap");
  assert.ok(deep.profitQu > 500_000);
  assert.equal(findArbitrageVenues(qxBook([[80, 50]], [[70, 50]]), poolAt(100)), null);
});

test("live search finds the reverse loop at full depth", () => {
  const rev = findArbitrageVenues(qxBook([[130, 1000]], [[120, 300_000]]), poolAt(100))!;
  assert.equal(rev.direction, "buy-qswap-sell-qx");
});

test("matched markets have no live arbitrage at any size", () => {
  assert.equal(findArbitrageVenues(qxBook([[101, 500_000]], [[99, 500_000]]), poolAt(100)), null);
});
