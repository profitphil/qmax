import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import { MARKET_FEES, findArbitrage } from "../src/arbitrage.ts";
import type { MarketData } from "../src/data.ts";
import {
  DEFAULT_REFERENCE_QU,
  MAX_CARRY_HOURS,
  MIN_COMPARABLE_HOURS,
  breakEven,
  buildPremium,
  costModel,
  describePremium,
  premiumBars,
  premiumRoutes,
  premiumSeries,
  premiumSummary,
} from "../src/premium.ts";
import type { PremiumBar, PremiumPoint, TradedHour } from "../src/premium.ts";
import { PREMIUM_PALETTE, premiumChartSvg } from "../src/premiumchart.ts";
import { NOW } from "./trade-helpers.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** An hour boundary, so fixtures line up the way the trade index's hours do. */
const BASE = Date.UTC(2026, 8, 1, 0, 0, 0);
/** One hour of trades at a price: `qu` defaults to 1000 units' worth. */
const at = (i: number, price: number, units = 1000): TradedHour => ({ hour: BASE + i * HOUR, qu: price * units, qty: units });
const near = (a: number | null, b: number, eps = 1e-6) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

/** Hourly points with a chosen premium: the QX price is 100, so the QSwap price is 100 plus the premium in percent. */
const gaps = (premiums: number[], start = 0): PremiumPoint[] => premiums.map((p, i) => ({ t: BASE + (start + i) * HOUR, qx: 100, qswap: 100 + p, premiumPct: p, qxQu: 1e6, qswapQu: 1e6 }));
const model = costModel(); // 10M QU: break-even +1.306% (QSwap dearer) and -1.585% (QX dearer)

/* ---------- the series ---------- */

test("only hours where both venues traded are compared, with volume-weighted prices", () => {
  const qx = [at(0, 100), at(1, 100), at(3, 100)];
  const swap = [at(1, 103), at(2, 99), at(3, 97)];
  const s = premiumSeries(qx, swap);
  assert.deepEqual(s.map((p) => p.t), [BASE + HOUR, BASE + 3 * HOUR], "hours 0 and 2 had a trade on one venue only");
  assert.equal(s[0].qx, 100);
  near(s[0].qswap, 103);
  near(s[0].premiumPct, 3);
  near(s[1].premiumPct, -3, 1e-9);
  assert.equal(s[0].carried, undefined);
});

test("an hour's price is QU over units, so the big trade counts most", () => {
  // 1000 units at 10 and 3000 units at 20 on QX: (10_000 + 60_000) / 4000 = 17.5
  const qx: TradedHour[] = [{ hour: BASE, qu: 70_000, qty: 4000 }];
  const swap: TradedHour[] = [{ hour: BASE, qu: 35_000, qty: 2000 }];
  const [p] = premiumSeries(qx, swap);
  assert.equal(p.qx, 17.5);
  assert.equal(p.qswap, 17.5);
  assert.equal(p.premiumPct, 0);
  assert.deepEqual([p.qxQu, p.qswapQu], [70_000, 35_000]);
});

test("a positive premium means QSwap was dearer, a negative one that QX was", () => {
  const [up] = premiumSeries([at(0, 100)], [at(0, 110)]);
  const [down] = premiumSeries([at(0, 100)], [at(0, 90)]);
  near(up.premiumPct, 10);
  near(down.premiumPct, -10);
});

test("without carry-forward, hours that only one venue traded are not compared (the default)", () => {
  const s = premiumSeries([at(0, 100), at(2, 100)], [at(1, 101)]);
  assert.deepEqual(s, []);
  assert.deepEqual(premiumSeries([at(0, 100), at(2, 100)], [at(1, 101)], { carryHours: 0 }), []);
});

test("carry-forward fills an hour from the other venue's last price, and marks it", () => {
  // QSwap traded in hour 0 only, QX in hours 0 to 2: with a 2 hour carry, hours 1 and 2 borrow QSwap's price from hour 0
  const s = premiumSeries([at(0, 100), at(1, 100), at(2, 100)], [at(0, 102)], { carryHours: 2 });
  assert.deepEqual(s.map((p) => p.carried), [undefined, { venue: "QSwap", hours: 1 }, { venue: "QSwap", hours: 2 }]);
  near(s[2].premiumPct, 2);
  assert.deepEqual([s[1].qxQu, s[1].qswapQu], [100_000, 0], "the carried side did not trade that hour");
  // and the other way round
  const t = premiumSeries([at(0, 100)], [at(0, 100), at(1, 105)], { carryHours: 1 });
  assert.deepEqual(t[1].carried, { venue: "QX", hours: 1 });
  near(t[1].premiumPct, 5);
});

test("a carried price stops after the number of hours allowed", () => {
  const qx = [at(0, 100), at(1, 100), at(2, 100), at(3, 100), at(4, 100)];
  const swap = [at(0, 102)];
  assert.equal(premiumSeries(qx, swap, { carryHours: 1 }).length, 2, "hour 0 and hour 1");
  assert.equal(premiumSeries(qx, swap, { carryHours: 3 }).length, 4, "hours 0 to 3, not 4");
  assert.equal(premiumSeries(qx, swap, { carryHours: 3 }).at(-1)!.carried!.hours, 3);
});

test("carrying is capped at a small number of hours, whatever is asked for", () => {
  const qx = Array.from({ length: 10 }, (_, i) => at(i, 100));
  const s = premiumSeries(qx, [at(0, 102)], { carryHours: 99 });
  assert.equal(s.length, MAX_CARRY_HOURS + 1);
  assert.equal(premiumSeries(qx, [at(0, 102)], { carryHours: -4 }).length, 1, "a negative carry is no carry: only the shared hour 0");
  assert.equal(premiumSeries(qx, [at(0, 102)], { carryHours: Number.NaN }).length, 1);
  assert.equal(premiumSeries(qx, [at(0, 102)], { carryHours: 1.9 }).length, 2, "whole hours only");
});

test("a price is never carried backwards: a later trade does not fill an earlier hour", () => {
  // QSwap trades at hour 5 only; QX at hours 3 and 4. Carrying must not pull QSwap's hour-5 price back into 3 or 4:
  // the only comparable hour is 5, which borrows QX's price from hour 4.
  const s = premiumSeries([at(3, 100), at(4, 100)], [at(5, 110)], { carryHours: 3 });
  assert.equal(s.length, 1);
  assert.equal(s[0].t, BASE + 5 * HOUR);
  assert.deepEqual(s[0].carried, { venue: "QX", hours: 1 });
  // QX's later trade at hour 5 can borrow QSwap's price only from before it, never the reverse
  const u = premiumSeries([at(5, 100)], [at(3, 110)], { carryHours: 3 });
  assert.equal(u.length, 1);
  assert.equal(u[0].t, BASE + 5 * HOUR);
  assert.deepEqual(u[0].carried, { venue: "QSwap", hours: 2 });
});

test("a same-hour pair is never replaced by a carried one", () => {
  const s = premiumSeries([at(0, 100), at(1, 100)], [at(0, 120), at(1, 101)], { carryHours: 3 });
  assert.equal(s.length, 2);
  assert.ok(s.every((p) => !p.carried));
  near(s[1].premiumPct, 1);
});

test("carried hours may borrow from before the range starts", () => {
  const s = premiumSeries([at(0, 100), at(5, 100)], [at(4, 103)], { carryHours: 2, sinceMs: BASE + 5 * HOUR });
  assert.equal(s.length, 1);
  assert.equal(s[0].t, BASE + 5 * HOUR);
  assert.equal(s[0].carried!.hours, 1);
});

test("since and until cut the series, both ends inclusive", () => {
  const qx = Array.from({ length: 6 }, (_, i) => at(i, 100));
  const swap = Array.from({ length: 6 }, (_, i) => at(i, 101));
  const s = premiumSeries(qx, swap, { sinceMs: BASE + 2 * HOUR, untilMs: BASE + 4 * HOUR });
  assert.deepEqual(s.map((p) => (p.t - BASE) / HOUR), [2, 3, 4]);
});

test("empty input, one empty venue and unusable rows give an empty series", () => {
  assert.deepEqual(premiumSeries([], []), []);
  assert.deepEqual(premiumSeries([at(0, 100)], []), []);
  assert.deepEqual(premiumSeries([], [at(0, 100)], { carryHours: 3 }), []);
  const junk: TradedHour[] = [{ hour: BASE, qu: 0, qty: 5 }, { hour: BASE, qu: 5, qty: 0 }, { hour: BASE, qu: Number.NaN, qty: 5 }, { hour: Number.NaN, qu: 5, qty: 5 }, { hour: BASE, qu: -5, qty: 5 }, { hour: BASE, qu: Infinity, qty: 1 }];
  assert.deepEqual(premiumSeries(junk, [at(0, 100)]), []);
  assert.equal(premiumSeries([...junk, at(0, 100)], [at(0, 100)]).length, 1, "bad rows are skipped, good ones kept");
});

test("two rows for the same hour are added together, and the order of the input does not matter", () => {
  const qx: TradedHour[] = [{ hour: BASE + HOUR, qu: 200, qty: 2 }, { hour: BASE, qu: 100, qty: 1 }, { hour: BASE, qu: 300, qty: 1 }];
  const swap: TradedHour[] = [{ hour: BASE, qu: 100, qty: 1 }];
  const [p] = premiumSeries(qx, swap);
  assert.equal(p.qx, 200, "(100 + 300) / (1 + 1)");
  assert.equal(p.premiumPct, -50);
});

test("every number in the series is finite", () => {
  const qx = Array.from({ length: 50 }, (_, i) => at(i * 2, 50 + (i % 7)));
  const swap = Array.from({ length: 50 }, (_, i) => at(i * 2 + (i % 3), 52));
  for (const carry of [0, 1, 3]) for (const p of premiumSeries(qx, swap, { carryHours: carry })) assert.ok([p.t, p.qx, p.qswap, p.premiumPct].every(Number.isFinite));
});

/* ---------- bars ---------- */

test("hours are folded into bars with the mean gap, the extremes and how many hours used a carried price", () => {
  const series: PremiumPoint[] = [
    ...gaps([2, 4, -2], 0), // hours 0 to 2 (first 4-hour bar)
    { ...gaps([6], 5)[0], carried: { venue: "QX", hours: 1 } }, // hour 5 (second bar)
    ...gaps([1], 6),
  ];
  const bars = premiumBars(series, 4 * HOUR);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].t, BASE);
  assert.deepEqual([bars[0].hours, bars[0].carriedHours, bars[0].minPct, bars[0].maxPct], [3, 0, -2, 4]);
  near(bars[0].premiumPct, 4 / 3);
  assert.equal(bars[1].t, BASE + 4 * HOUR);
  assert.deepEqual([bars[1].hours, bars[1].carriedHours], [2, 1]);
  near(bars[1].premiumPct, 3.5);
  near(bars[1].qswap, 103.5);
});

test("an hourly bar is just the hour, and a stretch with no hours gets no bar", () => {
  const bars = premiumBars(gaps([3, -1], 0).concat(gaps([5], 30)), HOUR);
  assert.equal(bars.length, 3);
  assert.deepEqual(bars.map((b) => [b.hours, b.minPct === b.premiumPct, b.maxPct === b.premiumPct]), [[1, true, true], [1, true, true], [1, true, true]]);
  assert.deepEqual(premiumBars([], DAY), []);
  assert.equal(premiumBars(gaps([1, 2]), 0).length, 2, "a width under an hour is an hour, not a division by zero");
});

/* ---------- the cost model ---------- */

test("the fees come from the live arbitrage constants, not from numbers typed here", () => {
  const m = costModel(10_000_000);
  assert.equal(m.qswapFee, MARKET_FEES.swapFeeRate / 10_000);
  assert.equal(m.qxSellerFee, MARKET_FEES.qxSellerRate);
  assert.equal(m.flatQu, MARKET_FEES.qswapFixedQu + MARKET_FEES.qxFixedQu);
  // and today those are 0.3%, 0.3% and 100,000 + 100 + 100
  assert.deepEqual([m.qswapFee, m.qxSellerFee, m.flatQu], [0.003, 0.003, 100_200]);
  const doubled = costModel(10_000_000, { ...MARKET_FEES, swapFeeRate: 60, qswapFixedQu: 200_100 });
  assert.deepEqual([doubled.qswapFee, doubled.flatQu], [0.006, 200_200]);
});

test("the break-even for the default 10M QU trade is worked out from those fees", () => {
  const be = breakEven(costModel());
  assert.equal(DEFAULT_REFERENCE_QU, 10_000_000);
  // QSwap dearer: r > (1 + 100_200 / 10_000_000) / (1 - 0.003)
  near(be.qswapDearerPct, ((1 + 100_200 / 1e7) / 0.997 - 1) * 100, 1e-9);
  near(be.qswapDearerPct, 1.3059, 1e-4);
  // QX dearer: r < 0.997 * 0.997 / (1 + 100_200 / 10_000_000)
  near(be.qxDearerPct, (1 - (0.997 * 0.997) / (1 + 100_200 / 1e7)) * 100, 1e-9);
  near(be.qxDearerPct, 1.5852, 1e-4);
  assert.ok(be.qxDearerPct > be.qswapDearerPct, "selling on QX costs its fee as well, so QX has to be dearer by more");
});

test("small trades need a bigger gap because the flat fee does not shrink, and big trades approach the percentage fees", () => {
  const at1 = (qu: number) => breakEven(costModel(qu));
  assert.ok(at1(1e6).qswapDearerPct > at1(1e7).qswapDearerPct);
  assert.ok(at1(1e7).qswapDearerPct > at1(1e8).qswapDearerPct);
  assert.ok(at1(1e6).qxDearerPct > at1(1e7).qxDearerPct);
  near(at1(1e6).qswapDearerPct, 10.351, 1e-3);
  // a trade no bigger than the flat fee has to double to pay
  assert.ok(at1(100_200).qswapDearerPct > 100);
  // a huge trade only pays the percentage fees: 0.3 / 0.997 = 0.3009% one way, about 0.6% the other
  near(at1(1e15).qswapDearerPct, (1 / 0.997 - 1) * 100, 1e-3);
  near(at1(1e15).qxDearerPct, (1 - 0.997 * 0.997) * 100, 1e-3);
});

test("a reference trade of no size, or a nonsense size, is refused", () => {
  for (const bad of [0, -5, Number.NaN, Infinity]) assert.throws(() => costModel(bad), RangeError);
});

/** The live arbitrage search is the ground truth for what pays, so the break-even is checked against it. */
test("the break-even agrees with the live arbitrage search a hair either side of it", () => {
  const N = 10_000_000;
  const be = breakEven(costModel(N));
  const bigPool = (spot: number) => ({ poolQu: spot * 1e12, poolAsset: 1e12 }); // deep, so the price impact is nil
  // QSwap dearer: someone buys on QX (top of book 100 QU, N worth of it) and sells into the pool
  const up = (premium: number) => findArbitrage({ bestAsk: 100, askQty: N / 100, bestBid: 1, bidQty: 1, ...bigPool(100 * (1 + premium / 100)) });
  assert.equal(up(be.qswapDearerPct + 0.03)?.direction, "buy-qx-sell-qswap");
  assert.equal(up(be.qswapDearerPct - 0.03), null);
  // QX dearer: buy N worth from the pool and sell to a QX bid of 100
  const down = (premium: number) => {
    const spot = 100 * (1 + premium / 100);
    return findArbitrage({ bestAsk: 1e9, askQty: 1, bestBid: 100, bidQty: Math.round((N * 0.997) / spot), ...bigPool(spot) });
  };
  assert.equal(down(-be.qxDearerPct - 0.03)?.direction, "buy-qswap-sell-qx");
  assert.equal(down(-be.qxDearerPct + 0.03), null);
});

/* ---------- the summary ---------- */

test("the summary's statistics are worked out from the hourly gaps", () => {
  // up beyond +1.306: 2, 3, 4, 20    down beyond -1.585: -2, -3, -2.5    inside the band: the rest
  const s = premiumSummary(gaps([0, 2, 3, 0.5, -2, -3, -2.5, 4, 0, -0.9, 20, 0.9]), model);
  assert.equal(s.enough, true);
  assert.deepEqual([s.hours, s.sameHour, s.carried], [12, 12, 0]);
  near(s.medianPct, 0.25);
  near(s.meanPct, 22 / 12);
  near(s.medianAbsPct, 2);
  assert.equal(s.closePct, 1);
  near(s.closeShare, 5 / 12);
  near(s.qswapDearerShare, 4 / 12);
  near(s.qxDearerShare, 3 / 12);
  near(s.profitableShare, 7 / 12);
  assert.equal(s.firstMs, BASE);
  assert.equal(s.lastMs, BASE + 11 * HOUR);
  assert.equal(s.referenceQu, DEFAULT_REFERENCE_QU);
});

test("a gap is a run of consecutive hours beyond break-even in one direction", () => {
  // runs: hours 1-2 (up), 4-6 (down), 7 (up: the direction changed), 10 (up). Hour 3 and 8 and 9 are inside the band.
  const s = premiumSummary(gaps([0, 2, 3, 0.5, -2, -3, -2.5, 4, 0, -0.9, 20, 0.9]), model);
  assert.deepEqual(s.gaps, { count: 4, medianHours: 1.5, longestHours: 3 });
});

test("an hour with no comparable data ends a gap, even if the next hour is beyond break-even too", () => {
  const series = [...gaps([5, 5, 5], 0), ...gaps([5, 5], 4), ...gaps([0, 0, 0, 0, 0], 10)]; // hour 3 is missing
  const s = premiumSummary(series, model);
  assert.deepEqual(s.gaps, { count: 2, medianHours: 2.5, longestHours: 3 });
});

test("no gap beyond break-even means no gap statistics", () => {
  const s = premiumSummary(gaps(Array.from({ length: 12 }, (_, i) => (i % 2 ? 0.4 : -0.4))), model);
  assert.deepEqual(s.gaps, { count: 0, medianHours: null, longestHours: null });
  assert.equal(s.profitableShare, 0);
  assert.equal(s.closeShare, 1);
});

test("the largest gaps are the biggest of each day, five at most, biggest first", () => {
  const day = (d: number, ...p: number[]) => gaps(p, d * 24).map((x, i) => ({ ...x, qxQu: 20e6 + 1000 * d, qswapQu: 30e6 + i }));
  const series = [...day(0, 20, 15), ...day(1, -8), ...day(2, 3), ...day(3, 6), ...day(4, -12), ...day(5, 9), ...day(6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)];
  const s = premiumSummary(series, model);
  assert.equal(s.largest.length, 5);
  assert.deepEqual(s.largest.map((g) => g.premiumPct), [20, -12, 9, -8, 6], "the 15 shares a day with the 20, so it is left out");
  assert.deepEqual(s.largest.map((g) => g.dearer), ["QSwap", "QX", "QSwap", "QX", "QSwap"]);
  assert.equal(s.largest[0].t, BASE);
  assert.equal(s.largest[0].thinnerQu, 20e6, "the smaller of the two venues' QU that hour");
});

test("a gap seen on only a sliver of volume is not listed among the largest, and does not count as deep", () => {
  const series = gaps([30, 2, 1, 0.5, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
  series[0] = { ...series[0], qxQu: 26, qswapQu: 5e7 }; // 30% on 26 QU: dust
  series[1] = { ...series[1], qxQu: 12e6, qswapQu: 11e6 }; // 2% on 11M: a real one
  const s = premiumSummary(series, model);
  assert.deepEqual(s.largest.map((g) => g.premiumPct), [2], "only the hour where at least 10M QU traded on each venue");
  assert.equal(s.largest[0].thinnerQu, 11e6);
  near(s.profitableShare, 2 / 12, 1e-9);
  near(s.depthShare, 1 / 12, 1e-9); // the other ten hours have 1M each: not deep at 10M
  near(s.profitableDeepShare, 1 / 12, 1e-9);
});

test("the depth shares count hours where the quieter venue traded the reference size", () => {
  // 12 hours at +5% (beyond break-even). Three have 10M or more on both venues, two have 10M on one venue only.
  const series = gaps(Array(12).fill(5)).map((p, i) => ({ ...p, qxQu: i < 3 ? 10e6 : i < 5 ? 40e6 : 1e6, qswapQu: i < 3 ? 25e6 : 2e6 }));
  const s = premiumSummary(series, model);
  assert.equal(s.profitableShare, 1);
  near(s.depthShare, 3 / 12, 1e-9);
  near(s.profitableDeepShare, 3 / 12, 1e-9);
  // at 1M QU every hour is deep, but +5% no longer beats the 10% break-even of such a small trade
  const small = premiumSummary(series, costModel(1e6));
  assert.equal(small.depthShare, 1);
  assert.equal(small.profitableShare, 0);
  assert.equal(small.profitableDeepShare, 0);
});

test("a price carried forward is never deep, because the carried venue did not trade that hour", () => {
  const series = gaps(Array(12).fill(5)).map((p) => ({ ...p, qxQu: 50e6, qswapQu: 50e6 }));
  series[4] = { ...series[4], qswapQu: 0, carried: { venue: "QSwap", hours: 1 } };
  near(premiumSummary(series, model).depthShare, 11 / 12, 1e-9);
});

test("a carried hour is counted as comparable but never listed among the largest gaps", () => {
  const series = gaps([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 40]).map((p) => ({ ...p, qxQu: 20e6, qswapQu: 20e6 }));
  series[11] = { ...series[11], qswapQu: 0, carried: { venue: "QSwap", hours: 2 } };
  const s = premiumSummary(series, model);
  assert.deepEqual([s.hours, s.sameHour, s.carried], [12, 11, 1]);
  assert.equal(s.largest[0].premiumPct, 11, "the 40% hour used a carried price, so it is not evidence of a tradeable gap");
  assert.ok(s.largest.every((g) => g.thinnerQu > 0));
  assert.ok(s.profitableShare! > s.profitableDeepShare!, "the carried hour is beyond break-even but not deep");
});

test("with too few comparable hours the summary says so instead of reporting statistics", () => {
  const s = premiumSummary(gaps([3, 4, 5]), model);
  assert.equal(s.enough, false);
  assert.equal(s.hours, 3, "the count is still reported");
  assert.deepEqual([s.medianPct, s.meanPct, s.medianAbsPct, s.closeShare, s.profitableShare, s.qswapDearerShare, s.qxDearerShare, s.qxStepPct], [null, null, null, null, null, null, null, null]);
  assert.deepEqual([s.largest, s.coarseQx], [[], false]);
  assert.equal(premiumSummary(gaps(Array(MIN_COMPARABLE_HOURS - 1).fill(1)), model).enough, false);
  assert.equal(premiumSummary(gaps(Array(MIN_COMPARABLE_HOURS).fill(1)), model).enough, true);
  const none = premiumSummary([], model);
  assert.deepEqual([none.hours, none.enough, none.firstMs, none.lastMs], [0, false, null, null]);
  assert.equal(premiumSummary(gaps([3, 4, 5]), model, { minHours: 3 }).enough, true, "the minimum can be set");
});

test("the share beyond break-even depends on the trade size", () => {
  const series = gaps(Array.from({ length: 20 }, (_, i) => i * 0.5)); // 0% to 9.5%
  const small = premiumSummary(series, costModel(1e6)); // needs +10.35%: never
  const big = premiumSummary(series, costModel(1e8)); // needs +0.40%: nearly always
  assert.equal(small.profitableShare, 0);
  assert.equal(big.profitableShare, 19 / 20);
  assert.equal(big.referenceQu, 1e8);
});

test("a token whose QX price step is as big as the break-even is flagged as rounding", () => {
  const cheap = gaps(Array(12).fill(0.1)).map((p) => ({ ...p, qx: 18, qswap: 18.02 })); // 1 QU is 5.6% of 18 QU
  const dear = gaps(Array(12).fill(0.1)); // 1 QU is 1% of 100 QU, under the 1.3% break-even
  const s = premiumSummary(cheap, model);
  near(s.qxStepPct, 100 / 18, 1e-9);
  assert.equal(s.coarseQx, true);
  assert.equal(premiumSummary(dear, model).coarseQx, false);
  assert.equal(premiumSummary(cheap, costModel(1e6)).coarseQx, false, "at 1M QU the break-even is 9.7%, bigger than one step");
});

/* ---------- the chart ---------- */

/** Bars one hour wide with chosen premiums over a QX price of 100. */
const barsOf = (premiums: number[], opts: { start?: number; every?: number; hours?: number } = {}): PremiumBar[] =>
  premiums.map((p, i) => ({ t: BASE + ((opts.start ?? 0) + i * (opts.every ?? 1)) * HOUR, qx: 100, qswap: 100 + p, premiumPct: p, minPct: p, maxPct: p, hours: opts.hours ?? 1, carriedHours: 0 }));
const be = { qswapDearer: 1.306, qxDearer: 1.585 };
const chart = (points: PremiumBar[], extra: Partial<Parameters<typeof premiumChartSvg>[1]> = {}) => premiumChartSvg(points, { symbol: "QDOGE", rangeLabel: "7 days", barMs: HOUR, breakEvenPct: be, ...extra });
const count = (svg: string, needle: string) => svg.split(needle).length - 1;

test("the chart has a bar per point, two price lines, a zero line and the break-even band", () => {
  const svg = chart(barsOf([0.5, -2, 3, 0, 4, -1, 2, 6]));
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.equal(count(svg, 'class="pbar"'), 8);
  assert.equal(count(svg, 'class="pline"'), 2);
  assert.ok(svg.includes("QDOGE  QX vs QSwap") && svg.includes("7 days"));
  assert.ok(svg.includes("No profit after fees: -1.6% to +1.3%"), "the band is explained in the legend");
  assert.equal(count(svg, "stroke-dasharray"), 3, "two edges of the band and the legend swatch");
  assert.ok(svg.includes(PREMIUM_PALETTE.violet) && svg.includes(PREMIUM_PALETTE.accent), "QSwap is violet and QX the accent colour");
});

test("bars take the colour of the dearer venue, so positive bars are violet and negative bars are the accent", () => {
  const svg = chart(barsOf([3, 4, -2]));
  const bar = (n: number) => svg.match(/<rect class="pbar"[^>]*>/g)![n];
  assert.ok(bar(0).includes(`fill="${PREMIUM_PALETTE.violet}"`) && bar(1).includes(`fill="${PREMIUM_PALETTE.violet}"`));
  assert.ok(bar(2).includes(`fill="${PREMIUM_PALETTE.accent}"`));
});

test("no band is drawn when no break-even is given", () => {
  const svg = chart(barsOf([1, 2, 3]), { breakEvenPct: undefined });
  assert.equal(count(svg, "stroke-dasharray"), 0);
  assert.ok(!svg.includes("No profit after fees"));
  assert.equal(count(chart(barsOf([1, 2, 3]), { breakEvenPct: { qswapDearer: Number.NaN, qxDearer: 1 } }), "stroke-dasharray"), 0, "a break-even that is not a number is ignored");
});

test("an empty or one-point input shows a message, not a broken chart", () => {
  for (const pts of [[], barsOf([2])]) {
    const svg = chart(pts);
    assert.ok(svg.startsWith("<svg") && svg.includes("QDOGE on QX and QSwap"));
    assert.equal(count(svg, "<path"), 0);
    assert.equal(count(svg, 'class="pbar"'), 0);
  }
  assert.ok(chart([]).includes("No hour in this range had trades on both markets."));
  assert.ok(chart(barsOf([2])).includes("Only one stretch"));
});

test("points that are not usable numbers are dropped, and the SVG never contains NaN or Infinity", () => {
  const good = barsOf([1, 2, -3, 4]);
  const bad: PremiumBar[] = [
    { ...good[0], t: Number.NaN },
    { ...good[1], qx: 0 },
    { ...good[1], qswap: -5 },
    { ...good[2], premiumPct: Infinity },
    { ...good[3], maxPct: Number.NaN },
    { ...good[0], qx: Infinity },
  ];
  const svg = chart([...bad, ...good]);
  assert.equal(count(svg, 'class="pbar"'), 4, "only the good four");
  assert.ok(!/NaN|Infinity|undefined/.test(svg));
  assert.ok(chart(bad).includes("No hour in this range"), "nothing usable at all is the empty message");
});

test("odd but valid input still draws cleanly: flat prices, one timestamp, zero width, a huge gap, tiny sizes", () => {
  const flat = barsOf([0, 0, 0]);
  assert.ok(!/NaN|Infinity/.test(chart(flat)));
  assert.equal(count(chart(flat), 'class="pbar"'), 3);
  const same = barsOf([1, 2, 3], { every: 0 });
  for (const barMs of [HOUR, 0]) assert.ok(!/NaN|Infinity/.test(chart(same, { barMs })));
  assert.ok(!/NaN|Infinity/.test(chart(barsOf([1e9, -1e9, 0.0001]))));
  assert.ok(!/NaN|Infinity/.test(chart(barsOf([1, 2, 3]), { width: 10, height: 10 })));
  assert.ok(!/NaN|Infinity/.test(chart(barsOf([1, 2, 3]), { width: 320, height: 200 })));
  const tiny = barsOf([0.0001, -0.0002, 0.0003]).map((b) => ({ ...b, qx: 1e-9, qswap: 1e-9 * 1.0001 }));
  assert.ok(!/NaN|Infinity/.test(chart(tiny)));
});

test("points handed over out of order are drawn in time order", () => {
  const ordered = barsOf([1, -2, 3, 4, -5]);
  const shuffled = [ordered[3], ordered[0], ordered[4], ordered[2], ordered[1]];
  assert.equal(chart(shuffled), chart(ordered));
});

test("one extreme gap does not flatten the rest: it is cut at the edge, marked and counted", () => {
  const normal = Array.from({ length: 30 }, (_, i) => (i % 2 ? 2 : -2));
  const svg = chart(barsOf([...normal, 900]));
  assert.ok(svg.includes("1 off scale"));
  assert.equal(count(svg, 'class="pbar"'), 31);
  const axisTop = [...svg.matchAll(/>\+([\d.]+)%<\/text>/g)].map((m) => Number(m[1]));
  assert.ok(axisTop.length > 0);
  assert.ok(Math.max(...axisTop) < 50, `the scale stayed readable, top label ${axisTop}`);
});

test("one wild price is drawn at the edge and does not stretch the price scale", () => {
  const pts = barsOf(Array.from({ length: 12 }, () => 1));
  pts[5] = { ...pts[5], qswap: 4000, premiumPct: 3900, minPct: 3900, maxPct: 3900 };
  const svg = chart(pts);
  assert.ok(svg.includes("1 off scale"));
  // the price axis labels stay near 100 (the outlier is 40 times that)
  const labels = [...svg.matchAll(/text-anchor="end"[^>]*>([\d.]+)<\/text>/g)].map((m) => Number(m[1])).filter((v) => v > 50 && v < 1e5);
  assert.ok(labels.length >= 3 && labels.every((v) => v < 300), `price labels ${labels}`);
});

test("a line breaks across a long gap but joins across a short one, and a lone point still gets a dot", () => {
  const pts = [...barsOf([1, 2], { start: 0 }), ...barsOf([3], { start: 50 }), ...barsOf([4, 5], { start: 100, every: 2 })];
  const svg = chart(pts);
  const qxPath = svg.match(/<path class="pline" d="([^"]+)"/)![1];
  assert.equal((qxPath.match(/M/g) ?? []).length, 3, "three separate pieces: a pair, a lone point, and a pair two hours apart");
  assert.equal((qxPath.match(/L/g) ?? []).length, 2, "the pair two bars apart is still joined");
  assert.ok(count(svg, "<circle") >= 5);
});

test("points that used a carried-forward price are faded, and the chart says so", () => {
  const pts = barsOf([1, 2, 3]);
  pts[1] = { ...pts[1], carriedHours: 1 };
  const svg = chart(pts);
  assert.equal(count(svg, 'fill-opacity="0.4"'), 1);
  assert.ok(svg.includes("faded: used a carried-forward price"));
  assert.ok(!chart(barsOf([1, 2, 3])).includes("faded"));
});

test("a bar that stands for several hours shows their range as a whisker", () => {
  const pts = barsOf([1, 2, 3], { hours: 4 }).map((b) => ({ ...b, minPct: b.premiumPct - 1, maxPct: b.premiumPct + 2 }));
  const one = barsOf([1, 2, 3]);
  const lines = (svg: string) => count(svg, 'stroke-opacity="0.55"');
  assert.equal(lines(chart(pts)), 3);
  assert.equal(lines(chart(one)), 0);
});

test("the symbol and range are escaped, and a palette changes the colours", () => {
  const svg = chart(barsOf([1, 2, 3]), { symbol: '<b>"X"&', rangeLabel: "<7d>", palette: { bg: "none", accent: "#112233", violet: "#445566", text: "#778899" } });
  assert.ok(!svg.includes("<b>") && svg.includes("&lt;b&gt;&quot;X&quot;&amp;"));
  assert.ok(svg.includes("&lt;7d&gt;"));
  assert.ok(svg.includes("#112233") && svg.includes("#445566") && svg.includes("#778899"));
  assert.ok(svg.includes('fill="none"'), "a transparent background follows the page theme");
  assert.ok(!svg.includes(PREMIUM_PALETTE.violet) && !svg.includes(PREMIUM_PALETTE.accent));
});

test("the caption over the premium panel gets shorter when the chart is narrow", () => {
  const pts = barsOf([1, 2, 3]);
  pts[1] = { ...pts[1], carriedHours: 1 };
  assert.ok(chart(pts, { width: 320, height: 220 }).includes(">Premium (faded: carried price)<"));
  assert.ok(chart(pts, { width: 200, height: 220 }).includes(">Premium<"));
  assert.ok(chart(pts, { width: 640 }).includes("Premium: QSwap price over QX price (faded: used a carried-forward price)"));
});

test("a narrow chart keeps its legend short and still fits", () => {
  const svg = chart(barsOf([1, 2, 3]), { width: 320, height: 200 });
  assert.ok(svg.includes('width="320"') && svg.includes('viewBox="0 0 320 200"'));
  assert.ok(!svg.includes("No profit after fees"), "the long label gives way on a phone");
  assert.ok(svg.includes(">Break-even<"));
  const xs = [...svg.matchAll(/<(?:rect|line|circle|text)[^>]* (?:x|x1|cx)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(xs.every((v) => v >= 0 && v <= 320), "nothing is drawn outside the picture");
});

/* ---------- the answer the API gives ---------- */

/** A fixture asset with trades on both venues over the last two days, and one pair of hours two months back. */
const twoDays = (premium: number, count = 24, units = 1000): { qx: TradedHour[]; qswap: TradedHour[] } => {
  const start = Math.floor(NOW / HOUR) * HOUR - count * HOUR;
  return {
    qx: Array.from({ length: count }, (_, i) => ({ hour: start + i * HOUR, qu: 100 * units, qty: units })),
    qswap: Array.from({ length: count }, (_, i) => ({ hour: start + i * HOUR, qu: (100 + premium) * units, qty: units })),
  };
};

test("buildPremium returns the points, a summary and the break-even for the range asked for", () => {
  const { qx, qswap } = twoDays(2);
  const old = [{ hour: NOW - 60 * DAY, qu: 5000, qty: 50 }];
  const r = buildPremium("QDOGE", [...old, ...qx], [...old, ...qswap], { range: "30d", now: NOW });
  assert.equal(r.asset, "QDOGE");
  assert.equal(r.range, "30d");
  assert.equal(r.bothVenues, true);
  assert.equal(r.barMs, 4 * HOUR);
  assert.equal(r.referenceQu, DEFAULT_REFERENCE_QU);
  assert.equal(r.carryHours, 0);
  assert.deepEqual(r.tradedHours, { QX: 25, QSwap: 25 }, "the whole history, including the old hour");
  assert.equal(r.summary!.hours, 24, "the old hour is outside 30 days");
  near(r.summary!.medianPct, 2);
  assert.equal(r.summary!.qswapDearerShare, 1);
  assert.equal(r.breakEvenPct.qswapDearer, 1.306);
  assert.equal(r.breakEvenPct.qxDearer, 1.585);
  assert.equal(r.points.reduce((a, b) => a + b.hours, 0), 24);
  assert.ok(r.points.length <= 8, "24 hours in 4-hour bars");
  assert.ok(r.note.includes("indication") && r.note.includes("not a guarantee"));
  const all = buildPremium("QDOGE", [...old, ...qx], [...old, ...qswap], { range: "all", now: NOW });
  assert.equal(all.summary!.hours, 25);
  assert.equal(all.barMs, DAY);
});

test("the note says what the numbers ignore and what fees they count, from the fee constants", () => {
  const { note } = buildPremium("QDOGE", twoDays(1).qx, twoDays(1).qswap, { now: NOW });
  for (const word of ["spread", "slippage", "separate transactions", "volume-weighted", "0.3%", "100,200 QU", "10,000,000 QU"]) assert.ok(note.includes(word), `the note mentions ${word}`);
  assert.ok(buildPremium("X", twoDays(1).qx, twoDays(1).qswap, { now: NOW, referenceQu: 2_500_000 }).note.includes("2,500,000 QU"));
});

test("a token on one venue only gets a clear answer with no points", () => {
  const { qx } = twoDays(0);
  const r = buildPremium("ONLYQX", qx, [], { now: NOW });
  assert.equal(r.bothVenues, false);
  assert.deepEqual(r.points, []);
  assert.equal(r.summary, null);
  assert.deepEqual(r.tradedHours, { QX: 24, QSwap: 0 });
  assert.match(r.note, /ONLYQX only trades on QX/);
  assert.match(buildPremium("ONLYSWAP", [], qx, { now: NOW }).note, /only trades on QSwap/);
  assert.match(buildPremium("NOTHING", [], [], { now: NOW }).note, /No trades of NOTHING/);
});

test("a token on both venues that never overlapped in the range reports zero comparable hours, not an error", () => {
  const r = buildPremium("SPARSE", [{ hour: NOW - 5 * DAY, qu: 100, qty: 1 }], [{ hour: NOW - 3 * DAY, qu: 100, qty: 1 }], { now: NOW });
  assert.equal(r.bothVenues, true);
  assert.deepEqual(r.points, []);
  assert.equal(r.summary!.hours, 0);
  assert.equal(r.summary!.enough, false);
});

test("carrying forward adds marked hours to the answer", () => {
  const start = Math.floor(NOW / HOUR) * HOUR - 6 * HOUR;
  const qx = Array.from({ length: 6 }, (_, i) => ({ hour: start + i * HOUR, qu: 100, qty: 1 }));
  const qswap = [{ hour: start, qu: 103, qty: 1 }];
  const without = buildPremium("A", qx, qswap, { now: NOW });
  const withCarry = buildPremium("A", qx, qswap, { now: NOW, carryHours: 2 });
  assert.equal(without.summary!.hours, 1);
  assert.deepEqual([withCarry.summary!.hours, withCarry.summary!.carried, withCarry.summary!.sameHour], [3, 2, 1]);
  assert.equal(withCarry.carryHours, 2);
  assert.ok(withCarry.points.some((p) => p.carriedHours > 0));
});

test("everything in the answer is a finite number or null, so it survives JSON", () => {
  const { qx, qswap } = twoDays(-3, 60);
  const r = buildPremium("A", qx, qswap, { now: NOW, range: "7d" });
  const walk = (v: unknown): void => {
    if (typeof v === "number") assert.ok(Number.isFinite(v), `non-finite number ${v}`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(r);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

/* ---------- plain English ---------- */

test("the summary is written out in sentences with the numbers in them", () => {
  const { qx, qswap } = twoDays(3, 24, 200_000); // 20M QU an hour on each venue
  const r = buildPremium("QDOGE", qx, qswap, { now: NOW, range: "30d" });
  const text = describePremium(r, "QDOGE").lines.join(" ");
  assert.match(text, /Over 30 days, QDOGE had 24 hours with trades on both QX and QSwap\./);
  assert.match(text, /within 1% of each other in 0% of those hours; the median gap was \+3\.0% \(QSwap dearer\)/);
  assert.match(text, /QSwap dearer by more than 1\.3% in 100%, QX dearer by more than 1\.6% in 0%/);
  assert.match(text, /10M QU round trip/);
  assert.match(text, /upper bound, not as profit/);
  assert.match(text, /QX bid-ask spread/);
  assert.match(text, /At least 10M QU traded on each market in 100% of the comparable hours; in 100% of all of them the gap was also beyond break-even/);
  assert.match(text, /biggest gap among those was 3\.0% on \w{3} \d+ \(QSwap dearer, with 20M QU traded on the quieter market/);
  assert.match(text, /stretch beyond break-even typically lasted 24 hours/);
});

test("the sentences say when there is not enough data, no overlap, or only one venue", () => {
  const few = describePremium(buildPremium("QDOGE", twoDays(2, 4).qx, twoDays(2, 4).qswap, { now: NOW }), "QDOGE").lines.join(" ");
  assert.match(few, /had 4 hours/);
  assert.match(few, /not enough data for statistics/);
  assert.doesNotMatch(few, /break-even/);
  const shallow = describePremium(buildPremium("QDOGE", twoDays(2, 24).qx, twoDays(2, 24).qswap, { now: NOW }), "QDOGE").lines.join(" ");
  assert.match(shallow, /No comparable hour had 10M QU traded on each market/, "100,000 QU an hour is not a 10M QU trade");
  assert.doesNotMatch(shallow, /biggest gap/);
  const none = describePremium(buildPremium("S", [{ hour: NOW - 5 * DAY, qu: 100, qty: 1 }], [{ hour: NOW - 3 * DAY, qu: 100, qty: 1 }], { now: NOW }), "S").lines.join(" ");
  assert.match(none, /no hour with trades on both QX and QSwap/);
  assert.match(none, /carry forward/);
  assert.match(describePremium(buildPremium("S", twoDays(0).qx, [], { now: NOW }), "S").lines.join(" "), /only trades on QX/);
  const single = describePremium(buildPremium("S", twoDays(1, 1).qx, twoDays(1, 1).qswap, { now: NOW, range: "all" }), "S").lines[0];
  assert.match(single, /^Across the whole history, S had 1 hour with/);
});

test("the sentences warn when QX prices are too coarse to trust, and mention carried hours", () => {
  const start = Math.floor(NOW / HOUR) * HOUR - 24 * HOUR;
  const qx = Array.from({ length: 24 }, (_, i) => ({ hour: start + i * HOUR, qu: 18 * 1000, qty: 1000 }));
  const qswap = Array.from({ length: 12 }, (_, i) => ({ hour: start + i * 2 * HOUR, qu: 17.2 * 1000, qty: 1000 }));
  const r = buildPremium("CHEAP", qx, qswap, { now: NOW, carryHours: 1 });
  const { lines, caution } = describePremium(r, "CHEAP");
  assert.match(lines.join(" "), /12 of them using a price carried forward up to 1 hour\b/);
  assert.match(caution!, /QX prices move in whole QU, so one price step is about 5\.6% of CHEAP's price/);
  assert.equal(describePremium(buildPremium("DEAR", twoDays(2).qx, twoDays(2).qswap, { now: NOW }), "DEAR").caution, null, "no warning for a token with fine prices");
});

/* ---------- the endpoint ---------- */

const assets: Record<string, { qx: TradedHour[]; qswap: TradedHour[] }> = {
  QDOGE: twoDays(2, 30),
  ONLYQX: { qx: twoDays(0).qx, qswap: [] },
};
const deps = { now: () => NOW, hours: (id: string, venue: "QX" | "QSwap") => (assets[id] ? (venue === "QX" ? assets[id].qx : assets[id].qswap) : null) };
const [route] = premiumRoutes(deps);
const call = (qs: string) => route.handler({ query: new URLSearchParams(qs), body: undefined }) as ReturnType<typeof buildPremium>;
const status = (qs: string) => {
  try {
    call(qs);
    return 200;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

test("the route is GET /v1/premium and is documented", () => {
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/v1/premium");
  assert.ok(route.doc.summary && route.doc.description?.includes("not a guarantee"));
  const names = (route.doc.parameters as { name: string }[]).map((p) => p.name);
  assert.deepEqual(names, ["asset", "range", "referenceQu", "carry"]);
});

test("the range defaults to 30 days and the reference trade to 10M QU", () => {
  const r = call("asset=QDOGE");
  assert.equal(r.range, "30d");
  assert.equal(r.referenceQu, 10_000_000);
  assert.equal(r.carryHours, 0);
  assert.equal(r.summary!.hours, 30);
  assert.equal(call("asset=QDOGE&range=7d").barMs, HOUR);
  assert.equal(call("asset=QDOGE&range=90d").barMs, DAY);
  assert.equal(call("asset=QDOGE&range=all").range, "all");
});

test("the reference size and the carry can be asked for", () => {
  const r = call("asset=QDOGE&referenceQu=1000000&carry=2");
  assert.equal(r.referenceQu, 1_000_000);
  assert.equal(r.carryHours, 2);
  assert.equal(r.breakEvenPct.qswapDearer, 10.351);
  assert.equal(call("asset=QDOGE&referenceQu=1e8").referenceQu, 1e8);
});

test("bad parameters are refused with a 400 and unknown assets with a 404", () => {
  assert.equal(status(""), 400, "asset is required");
  assert.equal(status("asset=%20"), 400);
  assert.equal(status("asset=QDOGE&range=1d"), 400, "1d is not offered");
  assert.equal(status("asset=QDOGE&range=forever"), 400);
  assert.equal(status("asset=QDOGE&referenceQu=abc"), 400);
  assert.equal(status("asset=QDOGE&referenceQu=0"), 400);
  assert.equal(status("asset=QDOGE&referenceQu=-5"), 400);
  assert.equal(status("asset=QDOGE&referenceQu=99999"), 400, "under the smallest trade accepted");
  assert.equal(status("asset=QDOGE&referenceQu=1e15"), 400);
  assert.equal(status("asset=QDOGE&referenceQu=Infinity"), 400);
  assert.equal(status("asset=QDOGE&carry=4"), 400);
  assert.equal(status("asset=QDOGE&carry=-1"), 400);
  assert.equal(status("asset=QDOGE&carry=1.5"), 400);
  assert.equal(status("asset=QDOGE&carry=x"), 400);
  assert.equal(status("asset=NOPE"), 404);
  assert.equal(status("asset=QDOGE&carry=3&range=all&referenceQu=100000"), 200, "the limits themselves are fine");
  assert.throws(() => call("asset=NOPE"), /Unknown asset 'NOPE'/);
});

test("a single-venue asset is answered, not refused", () => {
  const r = call("asset=ONLYQX");
  assert.equal(r.bothVenues, false);
  assert.deepEqual(r.points, []);
  assert.equal(r.summary, null);
  assert.match(r.note, /only trades on QX/);
});

test("an asset the source reports half-known (one venue null) is unknown", () => {
  const [half] = premiumRoutes({ hours: (_id, venue) => (venue === "QX" ? [] : null) });
  assert.throws(() => half.handler({ query: new URLSearchParams("asset=A"), body: undefined }), /Unknown asset/);
});

test("served over HTTP the route answers with JSON, honours its errors and shows up in the OpenAPI document", async () => {
  const data: MarketData = { assets: () => [], venues: async () => null };
  const server = createApi({ data, routes: premiumRoutes(deps), freePerMin: 1000 });
  await new Promise<void>((r) => server.listen(0, () => r()));
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const ok = await fetch(`${base}/v1/premium?asset=QDOGE&range=7d`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as ReturnType<typeof buildPremium>;
    assert.equal(body.asset, "QDOGE");
    assert.equal(body.range, "7d");
    assert.ok(body.points.length > 0 && body.summary && body.note);
    assert.equal((await fetch(`${base}/v1/premium?asset=NOPE`)).status, 404);
    assert.equal((await fetch(`${base}/v1/premium?asset=QDOGE&range=2d`)).status, 400);
    const doc = (await (await fetch(`${base}/v1/openapi.json`)).json()) as { paths: Record<string, unknown> };
    assert.ok(doc.paths["/v1/premium"]);
  } finally {
    server.close();
  }
});
