import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import {
  BACKTEST_LIMITS,
  BacktestInputError,
  STRATEGY_DEFAULTS,
  backtestRoutes,
  describeStrategy,
  feeSettings,
  parseStrategy,
  resolveStrategy,
  runBacktest,
  summarizeBacktest,
  thinEquity,
  tradeFee,
  validateBacktestInput,
} from "../src/backtest.ts";
import type { BacktestInput, BacktestResponse, BacktestResult, StrategyInput } from "../src/backtest.ts";
import { MAX_MARKERS, equityChartSvg } from "../src/backtestchart.ts";
import { RouteError } from "../src/routes.ts";
import type { TradeCandle } from "../src/trades.ts";

const H = 3_600_000;
const T0 = Date.UTC(2026, 6, 7, 0); // Jul 7 2026, an hour boundary

/** An hourly candle at hour `i` after T0. Close defaults to the open. */
const cd = (i: number, o: number, c = o): TradeCandle => ({ t: T0 + i * H, o, h: Math.max(o, c), l: Math.min(o, c), c, volumeQu: 1000, volumeQty: 100, trades: 3 });
/** Candles for hours 0.. from open and close lists. */
const series = (opens: number[], closes = opens) => opens.map((o, i) => cd(i, o, closes[i]));
/** Fees of zero, so a hand calculation is only about prices. */
const NOFEE = { venue: "QX" as const, qxSellerRate: 0, qxFixedQu: 0, qswapFixedQu: 0, qswapPoolRate: 0 };

const run = (candles: TradeCandle[], strategy: StrategyInput, o: Partial<BacktestInput> = {}): BacktestResult => runBacktest({ candles, startingQu: 1000, strategy, fees: NOFEE, ...o });
const has = (r: BacktestResult, text: string) => r.warnings.some((w) => w.includes(text));

/* ---------- hold ---------- */

test("hold buys once at the first opening price and is marked at each close", () => {
  const r = run(series([10, 12, 11, 15, 14], [12, 11, 15, 14, 16]), { type: "hold" });
  assert.equal(r.trades.length, 1);
  assert.deepEqual([r.trades[0].side, r.trades[0].qty, r.trades[0].price, r.trades[0].quSpent, r.trades[0].feeQu, r.trades[0].t], ["buy", 100, 10, 1000, 0, T0]);
  assert.deepEqual(r.equity.map((p) => p.valueQu), [1200, 1100, 1500, 1400, 1600]);
  assert.equal(r.metrics.finalValueQu, 1600);
  assert.equal(r.metrics.returnPct, 60);
  assert.equal(r.metrics.differenceQu, 0, "holding is the comparison, so it cannot differ from it");
  assert.equal(r.metrics.averageCostQu, 10);
  assert.equal(r.metrics.finalHoldingQty, 100);
  // peak 1200, then 1100: 8.33%; the later dip from 1500 to 1400 is only 6.67%
  assert.equal(r.metrics.maxDrawdownPct, 8.33);
});

test("what does not buy a whole unit stays as QU", () => {
  const r = run(series([10, 10], [10, 16]), { type: "hold" }, { startingQu: 1005 });
  assert.equal(r.trades[0].qty, 100);
  assert.equal(r.metrics.finalCashQu, 5);
  assert.equal(r.metrics.finalValueQu, 5 + 100 * 16);
});

test("on QX a buy pays the flat 100 QU and nothing else, so units come from what is left after it", () => {
  const r = run(series([10, 10], [10, 15]), { type: "hold" }, { fees: { venue: "QX" } });
  assert.deepEqual([r.trades[0].qty, r.trades[0].quSpent, r.trades[0].feeQu], [90, 900, 100]);
  assert.equal(r.metrics.finalCashQu, 0);
  assert.equal(r.metrics.finalValueQu, 90 * 15);
  assert.equal(r.metrics.totalFeesQu, 100);
  assert.equal(r.metrics.totalFeesPctOfStart, 10);
  // selling the 90 units at 15 would fetch 1350, and the fee is 0.3% rounded up (1350 * 3 / 1000 = 4, plus 1) plus the 100
  assert.equal(r.metrics.exitFeeQu, 105);
  assert.ok(has(r, "Selling them would cost about 105 QU"));
});

/* ---------- dca ---------- */

test("dca buys the amount every N hours at the opening price, with the rest staying as QU", () => {
  // due at hours 0, 2 and 4: 100 buys 10 units at 10; 9 at 11 (99 QU); 7 at 14 (98 QU)
  const r = run(series([10, 12, 11, 15, 14, 20]), { type: "dca", amountQu: 100, everyHours: 2 });
  assert.deepEqual(r.trades.map((t) => [t.t, t.qty, t.price, t.quSpent]), [[T0, 10, 10, 100], [T0 + 2 * H, 9, 11, 99], [T0 + 4 * H, 7, 14, 98]]);
  assert.equal(r.metrics.finalHoldingQty, 26);
  assert.equal(r.metrics.finalCashQu, 1000 - 297);
  assert.equal(r.metrics.finalValueQu, 703 + 26 * 20);
  assert.equal(r.metrics.averageCostQu, 297 / 26, "total spent over total units");
  assert.equal(r.metrics.holdFinalValueQu, 100 * 20, "the comparison put all 1,000 QU in at 10");
});

test("dca average cost is total spent over units, with and without the fees on the buys", () => {
  const r = run(series([10, 13, 17, 12, 20, 25, 22, 30]), { type: "dca", amountQu: 150, everyHours: 1 }, { fees: { venue: "QX" }, startingQu: 100_000 });
  const spent = r.trades.reduce((s, t) => s + t.quSpent!, 0);
  const units = r.trades.reduce((s, t) => s + t.qty, 0);
  const fees = r.trades.reduce((s, t) => s + t.feeQu, 0);
  assert.equal(r.trades.length, 8);
  assert.equal(r.metrics.averageCostQu, spent / units);
  assert.equal(r.metrics.averageCostWithFeesQu, (spent + fees) / units);
  assert.equal(r.metrics.totalFeesQu, 800);
});

test("a flat fee swallows a tiny dca: nothing is bought when the amount does not cover it, and half of it goes when it barely does", () => {
  const candles = series(Array(30).fill(10));
  const tiny = run(candles, { type: "dca", amountQu: 100_000, everyHours: 24 }, { fees: { venue: "QSwap" }, startingQu: 1_000_000 });
  assert.equal(tiny.trades.length, 0, "100,000 QU is less than QSwap's flat 100,100");
  assert.equal(tiny.skipped.tooSmall, 2);
  assert.equal(tiny.metrics.finalValueQu, 1_000_000);
  assert.ok(has(tiny, "no trades because every trade it tried was too small"));

  const half = run(candles, { type: "dca", amountQu: 200_000, everyHours: 24 }, { fees: { venue: "QSwap" }, startingQu: 1_000_000 });
  assert.equal(half.trades.length, 2);
  assert.deepEqual([half.trades[0].qty, half.trades[0].quSpent, half.trades[0].feeQu], [9990, 99_900, 100_100]);
  assert.equal(half.metrics.totalFeesQu, 200_200);
  // the price never moved, so everything lost is the fees: flat on the day it was bought
  assert.equal(half.metrics.finalValueQu, 1_000_000 - 200_200);
  assert.ok(has(half, "QSwap charges a flat 100,100 QU on every swap"), "the flat fee is named");
  assert.ok(has(half, "Fees came to 200,200 QU"));
});

test("fees can eat a gain, and the result says so plainly", () => {
  // up 0.1% over the run on a 1,000,000 QU hold: the 100,100 flat fee is far bigger than the 900 QU the price added
  const r = run(series([1000, 1000], [1000, 1001]), { type: "hold" }, { fees: { venue: "QSwap" }, startingQu: 1_000_000 });
  assert.ok(r.metrics.finalValueQu < 1_000_000);
  assert.ok(has(r, "Fees ate the result: before fees the strategy was"), r.warnings.join("\n"));
  assert.ok(r.metrics.totalFeesPctOfStart > 10);
});

test("a dca that runs out of QU buys what it can and says so", () => {
  const r = run(series([10, 10, 10, 10]), { type: "dca", amountQu: 400, everyHours: 1 }, { startingQu: 1000 });
  assert.deepEqual(r.trades.map((t) => t.quSpent), [400, 400, 200]);
  assert.equal(r.skipped.outOfQu, 2, "the third was smaller than set and the fourth was not made");
  assert.ok(has(r, "The starting QU ran out: 2 of the 4 scheduled purchases"));
  assert.equal(r.metrics.finalCashQu, 0);
});

/* ---------- bands ---------- */

// Closes 100, 100, 100, 90, 100, 115, 115; each hour opens where the last closed (the first at 100).
const bandCandles = () => series([100, 100, 100, 100, 90, 100, 115], [100, 100, 100, 90, 100, 115, 115]);
const bands = { type: "bands", lookbackHours: 3, bandPct: 5, fractionPct: 50, cooldownHours: 0 } as const;

test("bands buys when a close is 5% under its average and sells when 5% over, at the next opening price", () => {
  const r = run(bandCandles(), bands);
  // hour 3 closes at 90 against an average of (100 + 100 + 90) / 3 = 96.67: 6.9% under. It buys with half the QU at hour 4's open (90): 5 units for 450.
  // hour 5 closes at 115 against (90 + 100 + 115) / 3 = 101.67: 13.1% over. It sells half the 5 units (2) at hour 6's open (115) for 230.
  assert.deepEqual(r.trades.map((t) => [t.side, t.t, t.qty, t.price]), [["buy", T0 + 4 * H, 5, 90], ["sell", T0 + 6 * H, 2, 115]]);
  assert.equal(r.trades[0].quSpent, 450);
  assert.equal(r.trades[1].quReceived, 230);
  assert.equal(r.trades[0].signalPct, -6.9);
  assert.equal(r.trades[1].signalPct, 13.11);
  assert.equal(r.metrics.finalCashQu, 780);
  assert.equal(r.metrics.finalHoldingQty, 3);
  assert.equal(r.metrics.finalValueQu, 780 + 3 * 115);
  assert.equal(r.metrics.holdFinalValueQu, 10 * 115, "bought at 100 on the first hour");
  assert.equal(r.metrics.differenceQu, 1125 - 1150);
  assert.deepEqual([r.metrics.buyCount, r.metrics.sellCount, r.metrics.tradeCount], [1, 1, 2]);
});

test("a close exactly on the band counts, even though the arithmetic lands a hair short of it", () => {
  // closes 110, 100, 90 average exactly 100, so 90 is exactly 10% under: (90 / 100 - 1) * 100 is -9.999999999999998 in floating point
  assert.ok((90 / 100 - 1) * 100 > -10, "the float really is short of the band");
  const r = run(series([110, 100, 90, 90], [110, 100, 90, 90]), { type: "bands", lookbackHours: 3, bandPct: 10, fractionPct: 100, cooldownHours: 0 });
  assert.deepEqual(r.trades.map((t) => [t.side, t.t, t.price]), [["buy", T0 + 3 * H, 90]]);
  // and just inside the band is not enough
  const inside = run(series([110, 100, 91, 91], [110, 100, 91, 91]), { type: "bands", lookbackHours: 3, bandPct: 10, fractionPct: 100, cooldownHours: 0 });
  assert.equal(inside.trades.length, 0);
  // the sell side: 110 against an average of 100 is exactly 10% over, and the hold is there to sell
  const up = run(series([90, 100, 110, 110], [90, 100, 110, 110]), { type: "bands", lookbackHours: 3, bandPct: 10, fractionPct: 100, cooldownHours: 0 });
  assert.equal(up.trades.length, 0, "nothing held, so nothing to sell");
});

test("a price that never leaves the bands makes no trades, and there is nothing to buy before the average has enough closes", () => {
  const calm = run(series([100, 101, 99, 100, 101, 100]), bands);
  assert.equal(calm.trades.length, 0);
  assert.ok(has(calm, "The strategy made no trades because no hour closed 5% or more away from its 3-hour average"));
  // a crash on the second hour: only two closes so far, so the average is not trusted yet
  const early = run(series([100, 50]), bands);
  assert.equal(early.trades.length, 0);
  // one hour later there are three closes (100, 50, 50): the average is 66.7 and the close is 25% under it
  assert.equal(run(series([100, 50, 50, 50]), bands).trades[0]?.side, "buy");
});

test("bands waits out its cooldown, and without one it trades on every hour the price stays low", () => {
  const falling = series(Array.from({ length: 40 }, (_, i) => Math.round(1000 * 0.92 ** i)));
  const free = run(falling, { ...bands, fractionPct: 25, cooldownHours: 0 }, { startingQu: 1_000_000 });
  const waiting = run(falling, { ...bands, fractionPct: 25, cooldownHours: 5 }, { startingQu: 1_000_000 });
  assert.ok(free.trades.length > waiting.trades.length);
  for (let k = 1; k < waiting.trades.length; k++) assert.ok(waiting.trades[k].t - waiting.trades[k - 1].t >= 5 * H, "never two trades inside the wait");
});

test("bands averages over closes from before the start, but never trades before it", () => {
  // the start is hour 4; closes from hours 0 to 3 warm the average up, and hour 4 closes 10% under it
  const candles = series([100, 100, 100, 100, 100, 90, 90], [100, 100, 100, 100, 90, 90, 90]);
  const r = run(candles, { ...bands, bandPct: 5 }, { startMs: T0 + 4 * H });
  assert.equal(r.window.fromMs, T0 + 4 * H);
  assert.equal(r.trades[0].side, "buy");
  assert.equal(r.trades[0].t, T0 + 5 * H, "decided on hour 4's close, traded at hour 5's open");
  assert.ok(r.trades.every((t) => t.t >= T0 + 4 * H));
});

/* ---------- looking ahead ---------- */

test("a price spike in hour t cannot be traded in hour t: the order goes through at the next open", () => {
  // hour 5 crashes to 50 at the close (its open was 100); hour 6 opens back at 100
  const candles = series(Array(10).fill(100), [100, 100, 100, 100, 100, 50, 100, 100, 100, 100]);
  const r = run(candles, { ...bands, bandPct: 20, fractionPct: 100 });
  assert.equal(r.trades.length >= 1, true);
  assert.equal(r.trades[0].side, "buy");
  assert.equal(r.trades[0].t, T0 + 6 * H, "not hour 5, whose close showed the spike");
  assert.equal(r.trades[0].price, 100, "the opening price of hour 6, not the 50 that triggered it");
});

test("a signal on the very last hour has no next open to trade at", () => {
  const r = run(series([100, 100, 100, 100], [100, 100, 100, 50]), { ...bands, bandPct: 20, fractionPct: 100 });
  assert.equal(r.trades.length, 0);
});

test("what happens after an hour cannot change what was done before it", () => {
  // a random-looking series with gaps; cut it at several hours and the trades up to the cut must be the same
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let p = 100;
  const candles: TradeCandle[] = [];
  for (let i = 0; i < 400; i++) {
    const o = p;
    p = Math.max(5, Math.round(p * (1 + (rnd() - 0.5) * 0.12)));
    if (rnd() < 0.7) candles.push(cd(i, o, p));
  }
  for (const strategy of [{ type: "hold" }, { type: "dca", amountQu: 20_000, everyHours: 7 }, { type: "bands", lookbackHours: 24, bandPct: 3, fractionPct: 40, cooldownHours: 3 }] as StrategyInput[]) {
    // the same start for every run: a calendar strategy counts its days from there
    const full = runBacktest({ candles, startingQu: 1_000_000, strategy, fees: { venue: "QX" }, startMs: T0 });
    assert.ok(full.trades.length >= (strategy.type === "hold" ? 1 : 4), `${strategy.type} traded`);
    for (const cut of [60, 150, 300]) {
      const upTo = T0 + cut * H;
      const prefix = runBacktest({ candles: candles.filter((c) => c.t < upTo), startingQu: 1_000_000, strategy, fees: { venue: "QX" }, startMs: T0, endMs: upTo });
      const sameWindow = runBacktest({ candles, startingQu: 1_000_000, strategy, fees: { venue: "QX" }, startMs: T0, endMs: upTo });
      assert.deepEqual(prefix.trades, full.trades.filter((t) => t.t < upTo), `${strategy.type}: trades before hour ${cut}`);
      assert.deepEqual(sameWindow.trades, prefix.trades, `${strategy.type}: later candles in the array make no difference`);
    }
  }
});

/* ---------- gaps and sparse data ---------- */

test("a purchase due in an hour with no trades waits for the next hour with trades, and is dropped if the next purchase falls due first", () => {
  const present = new Set([0, 1, 5, 6, 12]);
  const candles = [...present].map((i) => cd(i, 10 + i, 10 + i));
  // due at hours 0, 3, 6, 9 and 12. Hour 3 (no trades) waits and goes through at hour 5. Hour 9 waits, but hour 12 falls due first, so it is dropped.
  const r = run(candles, { type: "dca", amountQu: 100, everyHours: 3 }, { startMs: T0, endMs: T0 + 14 * H });
  assert.deepEqual(r.trades.map((t) => (t.t - T0) / H), [0, 5, 6, 12]);
  assert.equal(r.skipped.noTradingHours, 1);
  assert.ok(has(r, "1 purchase was not made because nothing traded"));
  assert.equal(r.window.candleHours, 5);
  assert.ok(has(r, "The asset traded in only 5 of 14 hours (36%)"));
  assert.equal(has(r, "hours in a row"), false, "the longest stretch was 5 hours: no gap warning");
});

test("the value line holds the last price through quiet hours and marks them", () => {
  const r = run([cd(0, 10, 10), cd(1, 10, 12), cd(5, 12, 20)], { type: "hold" }, { startMs: T0, endMs: T0 + 8 * H });
  assert.deepEqual(r.equity.map((p) => [(p.t - T0) / H, p.valueQu, p.priceQu, p.stale]), [[0, 1000, 10, undefined], [1, 1200, 12, undefined], [5, 2000, 20, undefined], [7, 2000, 20, true]]);
});

test("a long stretch with no trades is called out", () => {
  const r = run([cd(0, 10), cd(1, 10), cd(40, 10), cd(41, 10)], { type: "hold" });
  assert.ok(has(r, "Nothing traded for up to 38 hours in a row (1.6 days)"), r.warnings.join("\n"));
});

test("a price is never made up: before the first trade there is no price and the value is just the QU", () => {
  const r = run([cd(3, 10, 10), cd(4, 10, 11)], { type: "hold" }, { startMs: T0, endMs: T0 + 6 * H });
  assert.deepEqual(r.equity.map((p) => [(p.t - T0) / H, p.valueQu, p.priceQu]), [[0, 1000, null], [3, 1000, 10], [4, 1100, 11], [5, 1100, 11]]);
  assert.equal(r.trades[0].t, T0 + 3 * H, "the first hour that had a price");
});

/* ---------- one-off prices ---------- */

/** 40 hours near 100 with one hour (or none) at 10 times that. */
const spiky = (at: number | null, n = 40) => series(Array.from({ length: n }, (_, i) => (i === at ? 1000 : 100 + (i % 3))));

test("a one-off price is counted and called out, with what leaned on it", () => {
  // the spike is hour 20: a purchase due then buys at 1,000 when the hours around it are near 100
  const r = run(spiky(20), { type: "dca", amountQu: 5000, everyHours: 20 }, { startingQu: 10_000 });
  assert.equal(r.odd.hours, 1);
  assert.equal(r.odd.trades, 1);
  assert.equal(r.odd.lastPriceIsOdd, false);
  assert.ok(has(r, "1 of the 40 hours with trades have a price more than 40% away from the typical price of the hours around them"), r.warnings.join("\n"));
  assert.ok(has(r, "1 of this strategy's 2 trades used one as the price"));
  assert.equal(has(r, "final value is counted at one"), false);
});

test("a final value counted at a spike, or a comparison that bought at one, is said so", () => {
  const last = run(spiky(39), { type: "hold" });
  assert.deepEqual([last.odd.hours, last.odd.lastPriceIsOdd, last.odd.holdBuyIsOdd], [1, true, false]);
  assert.ok(has(last, "the final value is counted at one"));
  const first = run(spiky(0), { type: "dca", amountQu: 500, everyHours: 10 });
  assert.equal(first.odd.holdBuyIsOdd, true);
  assert.ok(has(first, "the buy-and-hold comparison bought at one"));
});

test("a quiet market has no odd hours, and a short one is not judged", () => {
  const calm = run(spiky(null), { type: "hold" });
  assert.equal(calm.odd.hours, 0);
  assert.equal(has(calm, "away from the typical price"), false);
  const short = run(spiky(2, 5), { type: "hold" });
  assert.equal(short.odd.hours, 0, "fewer than 6 hours around it: too few to say what is typical");
  const walked = runBacktest({ candles: walk(500, 21), startingQu: 10_000_000, strategy: { type: "hold" }, fees: { venue: "QX" } });
  assert.equal(walked.odd.hours, 0, "ordinary hour-to-hour moves are not flagged");
});

test("the strategy does not see the flag: it trades a spike like any other price", () => {
  const withSpike = run(spiky(20), { type: "dca", amountQu: 5000, everyHours: 20 }, { startingQu: 10_000 });
  assert.deepEqual(withSpike.trades.map((t) => t.price), [100, 1000]);
});

/* ---------- edge cases ---------- */

test("no candles: an empty result that says so, not an error", () => {
  const r = run([], { type: "hold" });
  assert.deepEqual([r.trades, r.equity, r.window.hours, r.window.candleHours], [[], [], 0, 0]);
  assert.equal(r.metrics.finalValueQu, 1000);
  assert.equal(r.metrics.averageCostQu, null);
  assert.ok(has(r, "Nothing traded in this date range"));
  assert.ok(has(r, "Past results do not predict future ones"));
  const asked = run([], { type: "dca", amountQu: 100, everyHours: 1 }, { startMs: T0, endMs: T0 + 5 * H });
  assert.equal(asked.trades.length, 0);
  assert.ok(has(asked, "Nothing traded in this date range"));
});

test("one candle: it still runs, and says one hour is too little to judge", () => {
  const r = run([cd(0, 10, 12)], { type: "hold" });
  assert.equal(r.trades.length, 1);
  assert.equal(r.metrics.finalValueQu, 1200);
  assert.ok(has(r, "Only 1 hour with trades"));
  assert.equal(r.equity.length, 1);
});

test("a starting amount that cannot pay the flat fee buys nothing and keeps all its QU", () => {
  const r = run(series([10, 10, 12]), { type: "hold" }, { fees: { venue: "QSwap" }, startingQu: 100_000 });
  assert.equal(r.trades.length, 0);
  assert.equal(r.metrics.finalValueQu, 100_000);
  assert.equal(r.skipped.tooSmall, 1);
  assert.ok(has(r, "fixed fee of 100,100 QU and one unit"));
  const barely = run(series([10, 10, 12]), { type: "hold" }, { fees: { venue: "QSwap" }, startingQu: 100_105 });
  assert.equal(barely.trades.length, 0, "5 QU left after the fee is not a unit at 10");
  const just = run(series([10, 10, 12]), { type: "hold" }, { fees: { venue: "QSwap" }, startingQu: 100_110 });
  assert.equal(just.trades[0].qty, 1);
});

test("it does not sell when the proceeds would not cover the fees", () => {
  // the 100,100 QU flat fee on a sale of 1 unit worth 10 QU
  const candles = series([100, 100, 100, 100, 100, 100], [100, 100, 100, 50, 100, 130]);
  const r = run(candles, { type: "bands", lookbackHours: 3, bandPct: 5, fractionPct: 100, cooldownHours: 0 }, { fees: { venue: "QSwap" }, startingQu: 100_300 });
  // it can afford 2 units after the fee (100 each); selling them later would fetch 260 against the fee
  assert.equal(r.trades.filter((t) => t.side === "sell").length, 0);
  assert.ok(r.skipped.tooSmall >= 1);
});

test("a result with holding left over reports what selling would cost", () => {
  const r = run(series([1000, 1000, 1000]), { type: "hold" }, { fees: { venue: "QSwap" }, startingQu: 10_000_000 });
  assert.equal(r.metrics.exitFeeQu, 100_100);
  assert.ok(has(r, "Selling them would cost about 100,100 QU more"));
});

/* ---------- fees ---------- */

test("QX charges the seller 0.3% rounded up and nothing to the buyer, QSwap a flat 100,100 on either side", () => {
  const qx = feeSettings({ venue: "QX" });
  assert.deepEqual(tradeFee(qx, "buy", 1_000_000), { venue: "QX", feeQu: 100, poolFeeQu: 0 });
  assert.equal(tradeFee(qx, "sell", 1_000_000).feeQu, 3000 + 1 + 100, "Qx.h: value * 3,000,000 / 1e9, plus 1");
  assert.equal(tradeFee(qx, "sell", 1000).feeQu, 3 + 1 + 100);
  assert.equal(tradeFee(feeSettings({ venue: "QX", qxSellerRate: 0 }), "sell", 1_000_000).feeQu, 100, "no rate, no rounding up");
  const qs = feeSettings({ venue: "QSwap" });
  assert.equal(tradeFee(qs, "buy", 5).feeQu, 100_100);
  assert.equal(tradeFee(qs, "sell", 5_000_000_000).feeQu, 100_100, "flat, whatever the size");
  // the pool fee is inside the price; it is reported, never added
  assert.equal(tradeFee(qs, "buy", 1_000_000).poolFeeQu, 3000);
  assert.equal(tradeFee(qs, "sell", 1_000_000).poolFeeQu, 3009);
});

test("on 'all' each trade pays the cheaper venue's fees for its size", () => {
  const all = feeSettings({ venue: "all" });
  assert.equal(tradeFee(all, "buy", 50_000_000).venue, "QX", "a buy is 100 on QX at any size");
  assert.equal(tradeFee(all, "sell", 1_000_000).venue, "QX");
  assert.equal(tradeFee(all, "sell", 1_000_000).feeQu, 3101);
  // QX's 0.3% passes the flat 100,100 at about 33.3 million QU
  assert.equal(tradeFee(all, "sell", 33_000_000).venue, "QX");
  assert.equal(tradeFee(all, "sell", 40_000_000).venue, "QSwap");
  assert.equal(tradeFee(all, "sell", 40_000_000).feeQu, 100_100);
  assert.ok(has(run(series([10, 10, 12]), { type: "hold" }, { fees: { venue: "all" } }), "joins QX and QSwap into one price series"));
});

test("the fees follow the venue the candles were built from", () => {
  const candles = series([1000, 1000, 1000]);
  const qx = run(candles, { type: "hold" }, { fees: { venue: "QX" }, startingQu: 10_000_000 });
  const qswap = run(candles, { type: "hold" }, { fees: { venue: "QSwap" }, startingQu: 10_000_000 });
  assert.equal(qx.trades[0].venue, "QX");
  assert.equal(qswap.trades[0].venue, "QSwap");
  assert.equal(qx.metrics.totalFeesQu, 100);
  assert.equal(qswap.metrics.totalFeesQu, 100_100);
  assert.ok(qswap.metrics.poolFeesInPriceQu > 0);
  assert.equal(qx.metrics.poolFeesInPriceQu, 0);
  assert.ok(has(qswap, "already inside its prices"));
  assert.equal(has(qx, "already inside its prices"), false);
});

/* ---------- conservation ---------- */

/** A random-looking price path with gaps, the same every time. */
function walk(hours: number, seed: number, start = 5000): TradeCandle[] {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let p = start;
  const out: TradeCandle[] = [];
  for (let i = 0; i < hours; i++) {
    const o = p;
    p = Math.max(3, p * (1 + (rnd() - 0.5) * 0.1));
    if (rnd() < 0.65) out.push(cd(i, Number((o * (1 + (rnd() - 0.5) * 0.01)).toFixed(rnd() < 0.5 ? 0 : 4)) || 3, Number(p.toFixed(rnd() < 0.5 ? 0 : 4)) || 3));
  }
  return out;
}

test("no QU is created or destroyed: every trade moves value only by its fee and under 1 QU of rounding", () => {
  const strategies: StrategyInput[] = [{ type: "hold" }, { type: "dca", amountQu: 777_777, everyHours: 5 }, { type: "bands", lookbackHours: 24, bandPct: 2, fractionPct: 33, cooldownHours: 2 }];
  for (const venue of ["QX", "QSwap", "all"] as const)
    for (const seed of [1, 2, 3])
      for (const strategy of strategies) {
        const candles = walk(600, seed);
        const start = 50_000_000;
        const r = runBacktest({ candles, startingQu: start, strategy, fees: { venue } });
        const where = `${venue} ${strategy.type} seed ${seed}`;
        let cash = start;
        let qty = 0;
        for (const t of r.trades) {
          assert.ok(Number.isInteger(t.qty) && t.qty > 0, `${where}: whole units`);
          const before = cash + qty * t.price;
          cash += t.netQu;
          qty += t.side === "buy" ? t.qty : -t.qty;
          assert.ok(cash >= 0 && qty >= 0 && Number.isInteger(cash), `${where}: never short of QU or units, QU stays whole`);
          if (t.side === "buy") assert.equal(t.netQu, -(t.quSpent! + t.feeQu));
          else assert.equal(t.netQu, t.quReceived! - t.feeQu);
          const moved = cash + qty * t.price - before;
          assert.ok(moved <= -t.feeQu + 1e-6 && moved > -t.feeQu - 1, `${where}: value moved by ${moved}, the fee was ${t.feeQu}`);
        }
        const last = r.equity[r.equity.length - 1];
        assert.equal(r.metrics.finalHoldingQty, qty);
        assert.equal(r.metrics.finalCashQu, cash);
        assert.ok(Math.abs(r.metrics.finalValueQu - (cash + qty * (last.priceQu ?? 0))) <= 0.01, `${where}: the final value is the QU plus the units at the last price`);
        assert.equal(r.metrics.totalFeesQu, r.trades.reduce((s, t) => s + t.feeQu, 0));
        // all that was lost relative to the start is fees, rounding and price moves: with the price pinned, only fees and rounding remain
        assert.ok(r.equity.every((p) => Number.isFinite(p.valueQu) && Number.isFinite(p.holdValueQu)));
        if (strategy.type === "hold") assert.equal(r.metrics.differenceQu, 0, `${where}: hold is the comparison`);
      }
});

test("with the price pinned a run loses exactly its fees and under 1 QU per trade of rounding", () => {
  const candles = series(Array(60).fill(7));
  for (const venue of ["QX", "QSwap"] as const) {
    const r = runBacktest({ candles, startingQu: 10_000_000, strategy: { type: "dca", amountQu: 500_000, everyHours: 6 }, fees: { venue } });
    const lost = 10_000_000 - r.metrics.finalValueQu;
    assert.ok(lost >= r.metrics.totalFeesQu - 1e-6 && lost < r.metrics.totalFeesQu + r.trades.length, `${venue}: lost ${lost}, fees ${r.metrics.totalFeesQu}`);
  }
});

/* ---------- validation ---------- */

const base = (): BacktestInput => ({ candles: series([10, 11, 12]), startingQu: 1000, strategy: { type: "hold" }, fees: { venue: "QX" } });

test("valid input has no messages", () => {
  assert.deepEqual(validateBacktestInput(base()), []);
  assert.deepEqual(validateBacktestInput({ ...base(), candles: [] }), []);
});

test("every out-of-range setting is named in a clear message", () => {
  const bad = (patch: Partial<BacktestInput>) => validateBacktestInput({ ...base(), ...patch }).join(" | ");
  assert.match(bad({ startingQu: 0 }), /startingQu must be a whole number from 1 to 1,000,000,000,000/);
  assert.match(bad({ startingQu: 1.5 }), /startingQu must be a whole number/);
  assert.match(bad({ startingQu: Number.NaN }), /startingQu must be a whole number/);
  assert.match(bad({ startingQu: 2e12 }), /startingQu must be a whole number/);
  assert.match(bad({ startingQu: "100" as unknown as number }), /startingQu must be a whole number/);
  assert.match(bad({ strategy: { type: "dca", amountQu: 0 } }), /strategy.amountQu must be a whole number from 1/);
  assert.match(bad({ strategy: { type: "dca", everyHours: 0 } }), /strategy.everyHours must be a whole number from 1 to 8,760/);
  assert.match(bad({ strategy: { type: "dca", everyHours: 8761 } }), /strategy.everyHours/);
  assert.match(bad({ strategy: { type: "bands", lookbackHours: 2 } }), /strategy.lookbackHours must be a whole number from 3 to 2,160/);
  assert.match(bad({ strategy: { type: "bands", bandPct: 0 } }), /strategy.bandPct must be a number from 0.1 to 90/);
  assert.match(bad({ strategy: { type: "bands", bandPct: 95 } }), /strategy.bandPct/);
  assert.match(bad({ strategy: { type: "bands", cooldownHours: -1 } }), /strategy.cooldownHours/);
  assert.match(bad({ strategy: { type: "grid" } as unknown as StrategyInput }), /strategy.type must be one of hold, dca, bands/);
  assert.match(bad({ fees: { venue: "QXX" as "QX" } }), /fees.venue must be QX, QSwap or all/);
  assert.match(bad({ startMs: T0 + 5 * H, endMs: T0 }), /endMs must be after startMs/);
  assert.match(bad({ startMs: -5 }), /startMs must be a time/);
});

test("a fraction of zero, or over 100, is refused", () => {
  for (const fractionPct of [0, -5, 100.01, Number.NaN, Infinity]) assert.match(validateBacktestInput({ ...base(), strategy: { type: "bands", fractionPct } }).join(" "), /strategy.fractionPct must be more than 0 and at most 100/);
  assert.deepEqual(validateBacktestInput({ ...base(), strategy: { type: "bands", fractionPct: 100 } }), []);
  assert.deepEqual(validateBacktestInput({ ...base(), strategy: { type: "bands", fractionPct: 0.5 } }), []);
});

test("bad candles are refused with the index of the first ones", () => {
  const msgs = (candles: TradeCandle[]) => validateBacktestInput({ ...base(), candles }).join(" | ");
  assert.match(msgs([cd(0, 10), { ...cd(1, 10), c: Number.NaN }]), /Candle 1 has a price that is missing or not above zero/);
  assert.match(msgs([cd(0, 10), { ...cd(1, 0) }]), /Candle 1 has a price/);
  assert.match(msgs([cd(0, 10), { ...cd(1, 10), t: T0 + H + 1 }]), /Candle 1 does not start on a whole hour: candles must be one hour wide/);
  assert.match(msgs([cd(1, 10), cd(0, 10)]), /Candle 1 is not after the one before it/);
  assert.match(msgs([cd(0, 10), cd(0, 11)]), /Candle 1 is not after the one before it/, "two candles for one hour");
  assert.ok(validateBacktestInput({ ...base(), candles: Array.from({ length: BACKTEST_LIMITS.maxCandles + 1 }, (_, i) => cd(i, 10)) }).join(" ").includes("Too many candles"));
});

test("too long a window, or too many scheduled purchases, is refused before any work is done", () => {
  assert.match(validateBacktestInput({ ...base(), startMs: T0, endMs: T0 + (BACKTEST_LIMITS.maxWindowHours + 1) * H }).join(" "), /at most 9,600 hours \(400 days\)/);
  assert.match(validateBacktestInput({ ...base(), strategy: { type: "dca", amountQu: 10, everyHours: 1 }, startMs: T0, endMs: T0 + 2500 * H }).join(" "), /2,500 purchases; at most 2,000 per run. Raise strategy.everyHours/);
});

test("runBacktest throws one error carrying every message", () => {
  assert.throws(
    () => runBacktest({ ...base(), startingQu: 0, strategy: { type: "bands", fractionPct: 0 } }),
    (e: unknown) => e instanceof BacktestInputError && e.messages.length === 2 && /startingQu/.test(e.messages[0]) && /fractionPct/.test(e.messages[1]),
  );
});

test("a run that would make too many trades is refused, not cut short", () => {
  // closes alternate 1000 and 1004, and each hour opens where the last closed: every dip is bought and every rally sold, 0.4% apart, an hour after the signal
  const closes = Array.from({ length: 3000 }, (_, i) => (i % 2 ? 1004 : 1000));
  const opens = closes.map((c, i) => (i ? closes[i - 1] : c));
  assert.throws(
    () => runBacktest({ candles: series(opens, closes), startingQu: 1_000_000_000, strategy: { type: "bands", lookbackHours: 3, bandPct: 0.1, fractionPct: 100, cooldownHours: 0 }, fees: NOFEE }),
    (e: unknown) => e instanceof BacktestInputError && /more than 2,000 trades/.test(e.message),
  );
});

test("strategy settings left out take their defaults", () => {
  assert.deepEqual(resolveStrategy({ type: "dca" }), { type: "dca", ...STRATEGY_DEFAULTS.dca });
  assert.deepEqual(resolveStrategy({ type: "bands", bandPct: 8 }), { type: "bands", ...STRATEGY_DEFAULTS.bands, bandPct: 8 });
  assert.deepEqual(resolveStrategy({ type: "hold" }), { type: "hold" });
  const r = runBacktest({ candles: walk(300, 4), startingQu: 10_000_000, strategy: { type: "bands" }, fees: { venue: "QX" } });
  assert.ok(r.trades.length > 0, "the defaults trade a random walk");
});

/* ---------- determinism ---------- */

test("the same input always gives the same answer", () => {
  const candles = walk(500, 9);
  for (const strategy of [{ type: "hold" }, { type: "dca" }, { type: "bands" }] as StrategyInput[]) {
    const a = runBacktest({ candles, startingQu: 20_000_000, strategy, fees: { venue: "all" } });
    const b = runBacktest({ candles: structuredClone(candles), startingQu: 20_000_000, strategy, fees: { venue: "all" } });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  }
});

test("running does not change its input", () => {
  const candles = walk(100, 5);
  const copy = structuredClone(candles);
  runBacktest({ candles, startingQu: 1_000_000, strategy: { type: "bands" }, fees: { venue: "QX" } });
  assert.deepEqual(candles, copy);
});

/* ---------- describing ---------- */

test("the strategy and the run are described in plain words", () => {
  assert.equal(describeStrategy({ type: "hold" }), "buy once with all the QU and hold");
  assert.equal(describeStrategy({ type: "dca", amountQu: 50_000, everyHours: 168 }), "buy with 50,000 QU every 7 days");
  assert.equal(describeStrategy({ type: "dca", amountQu: 50_000, everyHours: 24 }), "buy with 50,000 QU every 1 day");
  assert.equal(describeStrategy({ type: "dca", amountQu: 50_000, everyHours: 36 }), "buy with 50,000 QU every 36 hours");
  assert.match(describeStrategy({ type: "bands", lookbackHours: 168, bandPct: 5, fractionPct: 25, cooldownHours: 24 }), /^buy with 25% of the QU on hand when the price is 5% below its 7-day average, and sell 25% of the holding when it is 5% above, waiting at least 1 day between trades$/);
});

test("the summary says what was bought, when, at what price and what fees were paid", () => {
  const candles = Array.from({ length: 24 * 21 }, (_, i) => cd(i, 20, 20));
  const strategy = resolveStrategy({ type: "dca", amountQu: 50_000, everyHours: 168 });
  const result = runBacktest({ candles, startingQu: 1_000_000, strategy, fees: { venue: "QX" } });
  assert.equal(
    summarizeBacktest({ symbol: "QDOGE", startingQu: 1_000_000, strategy, result }),
    "Bought 50,000 QU of QDOGE every 7 days from Jul 7 to Jul 27 at the next hour's opening price (3 purchases), paying fees of 300 QU (0.03% of the 1,000,000 QU you started with).",
  );
  const hold = runBacktest({ candles, startingQu: 1_000_000, strategy: { type: "hold" }, fees: { venue: "QX" } });
  assert.match(summarizeBacktest({ symbol: "X", startingQu: 1_000_000, strategy: { type: "hold" }, result: hold }), /^Bought X once with 1,000,000 QU at the opening price of the first hour with trades and held it from Jul 7 to Jul 27, paying fees of 100 QU/);
  const none = runBacktest({ candles: [], startingQu: 1000, strategy: { type: "hold" }, fees: { venue: "QX" } });
  assert.equal(summarizeBacktest({ symbol: "X", startingQu: 1000, strategy: { type: "hold" }, result: none }), "Made no trades in this range: nothing traded.");
});

/* ---------- the endpoint ---------- */

const NOW = Date.UTC(2026, 9, 4, 12, 30); // 12:30, so the hour in progress is 12:00 and the test ends there
const END = Date.UTC(2026, 9, 4, 12, 0);

interface Asked { assetId: string; venue: string; intervalMs: number; sinceMs: number }
function fakeDeps(candles: TradeCandle[] = walk(24 * 100, 11).map((c) => ({ ...c, t: c.t + (END - 24 * 100 * H - T0) }))) {
  const asked: Asked[] = [];
  const deps = {
    now: () => NOW,
    candles(assetId: string, venue: "auto" | "QX" | "QSwap" | "all", intervalMs: number, sinceMs: number) {
      asked.push({ assetId, venue, intervalMs, sinceMs });
      if (assetId.toUpperCase() === "NOPE") return null;
      return { asset: assetId.toUpperCase(), venue: venue === "auto" ? ("QSwap" as const) : venue, candles: candles.filter((c) => c.t >= sinceMs) };
    },
  };
  return { deps, asked, route: backtestRoutes(deps)[0] };
}
// async, so a handler that throws is a rejection here as it is in the server
const post = async (route: { handler(r: { query: URLSearchParams; body: unknown }): unknown }, body: unknown) => route.handler({ query: new URLSearchParams(), body });
const refused = async (route: Parameters<typeof post>[0], body: unknown, status: number, text: RegExp) => {
  await assert.rejects(post(route, body), (e: unknown) => e instanceof RouteError && e.status === status && text.test(e.message) && (status !== 400 || Array.isArray(e.extra.problems)));
};

test("POST /v1/backtest is described for the API docs", () => {
  const routes = backtestRoutes(fakeDeps().deps);
  assert.equal(routes.length, 1);
  assert.deepEqual([routes[0].method, routes[0].path], ["POST", "/v1/backtest"]);
  assert.match(routes[0].doc.summary, /strategy/);
  assert.match(String(routes[0].doc.description), /Past results do not predict future ones/);
});

test("a valid request returns the result with the inputs echoed back", async () => {
  const { route, asked } = fakeDeps();
  const res = (await post(route, { asset: "qdoge", range: "30d", startingQu: 5_000_000, strategy: { type: "dca", amountQu: 200_000 } })) as BacktestResponse;
  assert.equal(res.asset, "QDOGE");
  assert.equal(res.range, "30d");
  assert.equal(res.venue, "QSwap", "what 'auto' resolved to");
  assert.equal(res.venueRequested, "auto");
  assert.equal(res.startingQu, 5_000_000);
  assert.deepEqual(res.strategy, { type: "dca", amountQu: 200_000, everyHours: STRATEGY_DEFAULTS.dca.everyHours }, "the strategy with its defaults filled in");
  assert.match(res.summary, /^Bought 200,000 QU of QDOGE every 7 days from Sep 4 to Oct 4 at the next hour's opening price/);
  assert.equal(res.window.toMs, END);
  assert.equal(res.window.fromMs, END - 30 * 24 * H);
  assert.ok(res.trades.length >= 4 && res.trades.length <= 5);
  assert.ok(res.equity.length > 10);
  assert.ok(res.warnings.length >= 3);
  assert.ok(res.trades.every((t) => t.venue === "QSwap"), "QSwap's fees, because auto chose QSwap");
  assert.deepEqual(asked, [{ assetId: "qdoge", venue: "auto", intervalMs: H, sinceMs: END - 30 * 24 * H }]);
  JSON.stringify(res); // plain data
});

test("the time range ends at the last whole hour and 'all' starts from the first candle", async () => {
  const { route, asked } = fakeDeps();
  const all = (await post(route, { asset: "CFB", range: "all", venue: "QX", startingQu: 1_000_000, strategy: { type: "hold" } })) as BacktestResponse;
  assert.equal(all.window.toMs, END, "the 12:00 hour had not finished at 12:30");
  assert.equal(asked[0].sinceMs, 0);
  assert.equal(all.venue, "QX");
  assert.equal(all.window.candleHours > 1000, true);
  const def = (await post(route, { asset: "CFB", startingQu: 1_000_000, strategy: { type: "hold" } })) as BacktestResponse;
  assert.equal(def.range, "90d", "90 days unless told otherwise");
  assert.equal(asked[1].sinceMs, END - 90 * 24 * H);
});

test("bands asks for earlier candles so its average is warm on the first day", async () => {
  const { route, asked } = fakeDeps();
  await post(route, { asset: "CFB", range: "30d", startingQu: 1_000_000, strategy: { type: "bands", lookbackHours: 72 } });
  assert.equal(asked[0].sinceMs, END - 30 * 24 * H - 72 * H);
  await post(route, { asset: "CFB", range: "30d", startingQu: 1_000_000, strategy: { type: "dca" } });
  assert.equal(asked[1].sinceMs, END - 30 * 24 * H, "a calendar strategy needs nothing before the range");
});

test("an unknown asset is a 404", async () => {
  await refused(fakeDeps().route, { asset: "NOPE", startingQu: 1000, strategy: { type: "hold" } }, 404, /Unknown asset 'NOPE'/);
});

test("every bad request is a 400 that names what is wrong", async () => {
  const { route } = fakeDeps();
  const ok = { asset: "CFB", startingQu: 1_000_000, strategy: { type: "hold" } };
  await refused(route, null, 400, /Send a JSON object/);
  await refused(route, [], 400, /Send a JSON object/);
  await refused(route, { ...ok, asset: undefined }, 400, /asset is required/);
  await refused(route, { ...ok, asset: "a b" }, 400, /asset is required/);
  await refused(route, { ...ok, asset: 5 }, 400, /asset is required/);
  await refused(route, { ...ok, range: "7d" }, 400, /range must be one of 30d, 90d, all/);
  await refused(route, { ...ok, venue: "Binance" }, 400, /venue must be one of auto, QX, QSwap, all/);
  await refused(route, { ...ok, startingQu: undefined }, 400, /startingQu must be a whole number from 1 to 1,000,000,000,000/);
  await refused(route, { ...ok, startingQu: "1000" }, 400, /startingQu must be a whole number/);
  await refused(route, { ...ok, startingQu: -5 }, 400, /startingQu must be a whole number/);
  await refused(route, { ...ok, startingQu: 1e13 }, 400, /startingQu must be a whole number/);
  await refused(route, { ...ok, startingQu: 12.5 }, 400, /startingQu must be a whole number/);
  await refused(route, { ...ok, startingQU: 5 }, 400, /Unknown field 'startingQU'/);
  await refused(route, { ...ok, strategy: undefined }, 400, /strategy must be an object/);
  await refused(route, { ...ok, strategy: { type: "grid" } }, 400, /strategy.type must be one of hold, dca, bands/);
  await refused(route, { ...ok, strategy: { type: "hold", amountQu: 5 } }, 400, /strategy.amountQu is not a setting of 'hold' \(it takes none\)/);
  await refused(route, { ...ok, strategy: { type: "dca", bandPct: 5 } }, 400, /strategy.bandPct is not a setting of 'dca' \(it takes amountQu, everyHours\)/);
  await refused(route, { ...ok, strategy: { type: "dca", amountQu: "500" } }, 400, /strategy.amountQu must be a number/);
  await refused(route, { ...ok, strategy: { type: "dca", everyHours: 0 } }, 400, /strategy.everyHours must be a whole number from 1 to 8,760/);
  await refused(route, { ...ok, strategy: { type: "bands", fractionPct: 0 } }, 400, /strategy.fractionPct must be more than 0 and at most 100/);
  await refused(route, { ...ok, strategy: { type: "bands", bandPct: 1000 } }, 400, /strategy.bandPct/);
});

test("all the problems come back together, not one at a time", async () => {
  const { route } = fakeDeps();
  await assert.rejects(post(route, { asset: "", range: "1y", startingQu: 0, strategy: { type: "bands", fractionPct: 0 } }), (e: unknown) => {
    assert.ok(e instanceof RouteError);
    assert.equal(e.status, 400);
    const problems = e.extra.problems as string[];
    assert.equal(problems.length, 4);
    assert.ok(problems.some((p) => /asset/.test(p)) && problems.some((p) => /range/.test(p)) && problems.some((p) => /startingQu/.test(p)) && problems.some((p) => /fractionPct/.test(p)));
    return true;
  });
});

test("too much work is refused with a 400", async () => {
  const { route } = fakeDeps();
  // a purchase an hour over 90 days is 2,160, more than the 2,000 a run may make
  await refused(route, { asset: "CFB", range: "90d", startingQu: 1_000_000_000, strategy: { type: "dca", amountQu: 1000, everyHours: 1 } }, 400, /2,160 purchases; at most 2,000 per run/);
  // the same setting over 30 days is fine
  const ok = (await post(route, { asset: "CFB", range: "30d", venue: "QX", startingQu: 1_000_000_000, strategy: { type: "dca", amountQu: 100_000, everyHours: 1 } })) as BacktestResponse;
  assert.ok(ok.trades.length > 100, "an asset priced around 5,000 QU a unit: 100,000 QU buys some");
  // more candles than a run accepts
  const huge = fakeDeps(Array.from({ length: BACKTEST_LIMITS.maxCandles + 1 }, (_, i) => cd(i, 10)).map((c) => ({ ...c, t: END - (BACKTEST_LIMITS.maxCandles + 1 - 1) * H + (c.t - T0) })));
  await refused(huge.route, { asset: "CFB", range: "all", startingQu: 1000, strategy: { type: "hold" } }, 400, /Too many candles/);
});

test("a repeated request gives byte-for-byte the same response", async () => {
  const { route } = fakeDeps();
  const body = { asset: "QDOGE", range: "90d", venue: "all", startingQu: 20_000_000, strategy: { type: "bands", bandPct: 3 } };
  assert.equal(JSON.stringify(await post(route, body)), JSON.stringify(await post(route, structuredClone(body))));
});

test("a long run's equity curve is thinned for the response, keeping the ends and the trade hours", async () => {
  // 3,000 hours with trades, a purchase every 400: only 8 trades, so each keeps its hour
  const candles = Array.from({ length: 3000 }, (_, i) => cd(i, 100 + (i % 17)));
  const full = runBacktest({ candles, startingQu: 100_000_000, strategy: { type: "dca", amountQu: 1_000_000, everyHours: 400 }, fees: { venue: "QX" } });
  assert.equal(full.equity.length, 3000);
  const thin = thinEquity(full.equity, full.trades);
  assert.ok(thin.length <= 1500 && thin.length > 1000, `thinned to ${thin.length}`);
  assert.equal(thin[0].t, full.equity[0].t);
  assert.equal(thin[thin.length - 1].t, full.equity[2999].t);
  assert.ok(thin.every((p, k) => k === 0 || p.t > thin[k - 1].t), "still in time order, no repeats");
  const at = new Set(thin.map((p) => p.t));
  assert.ok(full.trades.every((t) => at.has(t.t)), "every trade hour is still there for its marker");
  assert.deepEqual(thinEquity(full.equity.slice(0, 100), []), full.equity.slice(0, 100), "a short curve is left alone");

  // through the route, with the number it had before saying so, and the metrics from the full curve
  const { route } = fakeDeps(candles.map((c) => ({ ...c, t: c.t + (END - 3000 * H - T0) })));
  const res = (await post(route, { asset: "CFB", range: "all", venue: "QX", startingQu: 100_000_000, strategy: { type: "dca", amountQu: 1_000_000, everyHours: 400 } })) as BacktestResponse;
  assert.equal(res.equityPointsBeforeThinning, 3000);
  assert.ok(res.equity.length <= 1500);
  assert.equal(res.metrics.tradeCount, res.trades.length);
  const small = (await post(route, { asset: "CFB", range: "30d", venue: "QX", startingQu: 100_000_000, strategy: { type: "hold" } })) as BacktestResponse;
  assert.equal(small.equityPointsBeforeThinning, undefined, "nothing thinned, nothing said");
});

test("through the API server a good request is 200 JSON and a bad one is a 400 with the messages", async () => {
  const { deps } = fakeDeps();
  const data: MarketData = { assets: () => [], venues: async () => null };
  const server = createApi({ data, routes: backtestRoutes(deps), freePerMin: 50 });
  await new Promise<void>((r) => server.listen(0, () => r()));
  after(() => server.close());
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const send = (body: unknown) => fetch(`${base}/v1/backtest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const good = await send({ asset: "CFB", range: "30d", startingQu: 5_000_000, strategy: { type: "hold" } });
  assert.equal(good.status, 200);
  const json = (await good.json()) as BacktestResponse;
  assert.equal(json.asset, "CFB");
  assert.equal(json.metrics.tradeCount, 1);
  const bad = await send({ asset: "CFB", startingQu: -1, strategy: { type: "dca", everyHours: 0 } });
  assert.equal(bad.status, 400);
  const err = (await bad.json()) as { error: string; problems: string[] };
  assert.match(err.error, /startingQu must be a whole number/);
  assert.match(err.error, /strategy.everyHours/);
  assert.equal(err.problems.length, 2);
  assert.equal((await send({ asset: "NOPE", startingQu: 1000, strategy: { type: "hold" } })).status, 404);
  const doc = (await (await fetch(`${base}/v1/openapi.json`)).json()) as { paths: Record<string, { post?: { summary: string } }> };
  assert.match(doc.paths["/v1/backtest"].post!.summary, /strategy/);
});

test("strategy settings are read strictly", () => {
  assert.deepEqual(parseStrategy({ type: "hold" }), { strategy: { type: "hold" }, problems: [] });
  assert.deepEqual(parseStrategy({ type: "bands", bandPct: 7.5 }).strategy, { type: "bands", ...STRATEGY_DEFAULTS.bands, bandPct: 7.5 });
  assert.equal(parseStrategy("dca").strategy, null);
  assert.equal(parseStrategy({ type: "dca", amountQu: Number.NaN }).problems[0], "strategy.amountQu must be a number.");
});

/* ---------- the chart ---------- */

const curve = (n: number) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * H, valueQu: 1000 + i * 3 + (i % 7), holdValueQu: 1000 + i * 2 }));
const triangles = (svg: string, colour: string) => svg.split(`fill="${colour}"/>`).length - 1;

test("the chart draws both lines and the starting level, and never writes NaN", () => {
  const svg = equityChartSvg(curve(48), { symbol: "QDOGE", rangeLabel: "30D" });
  assert.match(svg, /^<svg /);
  assert.ok(!/NaN|undefined|Infinity/.test(svg));
  assert.ok(svg.includes("QDOGE strategy vs buy and hold"));
  assert.ok(svg.includes("Strategy +"), "legend with the return so far");
  assert.ok(svg.includes("Buy and hold +"));
  assert.ok(svg.includes("stroke-dasharray"), "the starting level");
});

test("the chart takes its colours from the palette: accent for the strategy, violet for holding, buy and sell for the markers", () => {
  const palette = { bg: "none", accent: "#111111", violet: "#222222", up: "#333333", down: "#444444", grid: "#555555", text: "#666666", strong: "#777777" };
  const svg = equityChartSvg(curve(48), { symbol: "X", palette, trades: [{ t: T0 + 5 * H, side: "buy" }, { t: T0 + 20 * H, side: "sell" }] });
  assert.ok(svg.includes('stroke="#111111"') && svg.includes('stroke="#222222"'));
  assert.equal(triangles(svg, "#333333"), 1, "one buy marker");
  assert.equal(triangles(svg, "#444444"), 1, "one sell marker");
  assert.ok(svg.includes('fill="none"/>'), "the background is left clear");
  assert.ok(!svg.includes("#6ee7ff"), "the default accent is not used when one is given");
});

test("markers are left out when there are too many trades, and the chart says so", () => {
  const trades = Array.from({ length: MAX_MARKERS + 1 }, (_, i) => ({ t: T0 + (i % 40) * H, side: "buy" as const }));
  const crowded = equityChartSvg(curve(48), { symbol: "X", trades });
  assert.equal(triangles(crowded, "#4ade80"), 0);
  assert.ok(crowded.includes(`${MAX_MARKERS + 1} trades (markers hidden)`));
  const fine = equityChartSvg(curve(48), { symbol: "X", trades: trades.slice(0, MAX_MARKERS) });
  assert.equal(triangles(fine, "#4ade80"), MAX_MARKERS);
});

test("the chart has a message when there is nothing, or too little, to draw", () => {
  assert.ok(equityChartSvg([], { symbol: "QDOGE" }).includes("No trades in this range"));
  assert.ok(equityChartSvg(curve(1), { symbol: "QDOGE" }).includes("Only one hour of data"));
  assert.ok(equityChartSvg([{ t: T0, valueQu: Number.NaN, holdValueQu: 1 }, { t: T0 + H, valueQu: 5, holdValueQu: Number.POSITIVE_INFINITY }], { symbol: "X" }).includes("No trades in this range"), "points that are not numbers are dropped");
  assert.ok(!/NaN/.test(equityChartSvg([{ t: T0, valueQu: Number.NaN, holdValueQu: 1 }, ...curve(10).map((p) => ({ ...p, t: p.t + H }))], { symbol: "X" })));
});

test("a flat curve, and a long one, still draw", () => {
  const flat = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * H, valueQu: 1000, holdValueQu: 1000 }));
  const svg = equityChartSvg(flat, { symbol: "X" });
  assert.ok(!/NaN|Infinity/.test(svg) && svg.includes("<path"));
  const long = equityChartSvg(curve(5000), { symbol: "X" });
  assert.ok(long.length < 120_000, `a run of 5,000 hours draws as a bounded picture (${long.length} bytes)`);
  assert.ok(!/NaN/.test(long));
});

test("on a narrow screen the legend stacks, and everything stays inside the picture", () => {
  const wide = equityChartSvg(curve(48), { symbol: "QDOGE", width: 640, height: 300 });
  const narrow = equityChartSvg(curve(48), { symbol: "QDOGE", width: 345, height: 270 });
  assert.ok(!/NaN/.test(narrow));
  assert.ok(wide.includes('y="42"') && !wide.includes('y="59"'), "side by side on a wide chart");
  assert.ok(narrow.includes('y="42"') && narrow.includes('y="59"'), "one under the other on a narrow one");
  assert.match(narrow, /viewBox="0 0 345 270"/);
  // no x coordinate runs past the right edge
  const xs = [...narrow.matchAll(/(?:x|x1|x2|cx)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(xs.every((x) => x >= 0 && x <= 345), `all x within 0..345, got max ${Math.max(...xs)}`);
});

test("a backtest result draws straight into the chart", () => {
  const r = runBacktest({ candles: walk(400, 3), startingQu: 20_000_000, strategy: { type: "bands", bandPct: 3 }, fees: { venue: "QX" } });
  const svg = equityChartSvg(r.equity, { symbol: "TEST", trades: r.trades });
  assert.ok(!/NaN|undefined/.test(svg));
  assert.ok(svg.includes("<path"));
});
