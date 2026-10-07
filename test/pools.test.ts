import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { RouteError } from "../src/routes.ts";
import type { Route } from "../src/routes.ts";
import { TradeIndex } from "../src/trades.ts";
import {
  FEE_MODEL,
  IL_MOVES_PCT,
  LP_FEE_FRACTION,
  LP_SHARE_OF_FEE,
  NON_LP_SHARE,
  POOLS_CAVEAT,
  QSWAP_ADDITIONAL_FEE,
  QSWAP_FEE_BASE_100,
  QSWAP_SWAP_FEE_BASE,
  SMALL_POOL_TVL_QU,
  SWAP_FEE_FRACTION,
  feeSplit,
  impermanentLossPct,
  parseQuAmount,
  poolStats,
  poolsRoutes,
  positionEstimate,
  rankPools,
} from "../src/pools.ts";
import type { PoolHour, PoolStats, PoolsDeps } from "../src/pools.ts";
import { archive, key, swap } from "./trade-helpers.ts";

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0); // on an hour boundary, so "N hours ago" is exact

/** An hour of swaps that began `hoursAgo` hours before NOW. */
const hr = (hoursAgo: number, qu: number, n = 1, open = 1, close = open, high = Math.max(open, close), low = Math.min(open, close)): PoolHour => ({ hour: NOW - hoursAgo * H, qu, qty: qu / open, n, open, close, high, low });

/** 500M QU over the last ten hours (100 swaps), another 500M 12 days ago, and a swap 33 days ago that fixes the starting price at 1. */
const steady = (): PoolHour[] => [
  hr(800, 1_000, 1, 1),
  ...Array.from({ length: 10 }, (_, i) => hr(300 + i, 50_000_000, 10, 1)),
  ...Array.from({ length: 10 }, (_, i) => hr(1 + i, 50_000_000, 10, 1)),
];
const POOL = { id: "CFB", poolQu: 1_000_000_000, poolAsset: 1_000_000_000 }; // 1B QU a side: TVL 2B QU, price 1

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

const finiteEverywhere = (v: unknown, path = "$"): void => {
  if (typeof v === "number") assert.ok(Number.isFinite(v), `${path} is ${v}`);
  else if (Array.isArray(v)) v.forEach((x, i) => finiteEverywhere(x, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) finiteEverywhere(x, `${path}.${k}`);
};

/* ---------- the fee split, from the contract's constants ---------- */

test("the pool keeps 64% of a 0.3% swap fee: 0.192% of every QU swapped", () => {
  assert.equal(SWAP_FEE_FRACTION, 0.003);
  assert.equal(NON_LP_SHARE, 27 + 5 + 3 + 1);
  assert.equal(LP_SHARE_OF_FEE, 64);
  assert.equal(QSWAP_SWAP_FEE_BASE, 10_000);
  assert.equal(QSWAP_FEE_BASE_100, 100);
  assert.equal(LP_FEE_FRACTION, 0.00192);
  assert.equal(FEE_MODEL.lpFeePctOfVolume, 0.192);
  assert.equal(FEE_MODEL.swapFeePct, 0.3);
  assert.equal(FEE_MODEL.split.reduce((s, x) => s + x.pct, 0), 100, "every percent of the fee goes somewhere");
  assert.equal(QSWAP_ADDITIONAL_FEE, 100_000);
});

test("the contract's own integer arithmetic gives the same split", () => {
  // 1,000,000 QU in: fee 3,000; shareholders 810, QX 150, Invest & Rewards 90, burn 30; the pool keeps 1,920
  assert.deepEqual(feeSplit(1_000_000), { swapFee: 3000, shareholders: 810, qx: 150, investRewards: 90, burn: 30, lp: 1920 });
  // shares are rounded down, so on a small swap the pool keeps a little more than 64%: fee 30 -> 8 + 1 + 0 + 0 out, 21 stays
  assert.deepEqual(feeSplit(10_000), { swapFee: 30, shareholders: 8, qx: 1, investRewards: 0, burn: 0, lp: 21 });
  // a swap too small to owe a fee still pays the contract's minimum of 100
  assert.deepEqual(feeSplit(100), { swapFee: 100, shareholders: 27, qx: 5, investRewards: 3, burn: 1, lp: 64 });
  // at real sizes the exact fraction and the integer split agree
  const big = feeSplit(1e12);
  assert.equal(big.lp / 1e12, LP_FEE_FRACTION);
  assert.equal(big.swapFee, 3_000_000_000);
  // and beyond 2^53, where plain numbers would round
  assert.equal(feeSplit(1e15).lp, 1_920_000_000_000);
});

test("a swap amount that is not a positive number splits into nothing", () => {
  const zero = { swapFee: 0, shareholders: 0, qx: 0, investRewards: 0, burn: 0, lp: 0 };
  for (const bad of [0, -5, NaN, Infinity, -Infinity]) assert.deepEqual(feeSplit(bad), zero, String(bad));
});

/* ---------- impermanent loss ---------- */

test("impermanent loss follows 2*sqrt(r)/(1+r)-1, checked against known values", () => {
  const close = (r: number, want: number) => assert.ok(Math.abs(impermanentLossPct(r)! - want) < 1e-5, `r=${r}: ${impermanentLossPct(r)} vs ${want}`);
  close(1, 0);
  close(2, -5.719096); // the textbook "2x costs 5.7%"
  close(0.5, -5.719096);
  close(1.25, -0.619201);
  close(1.5, -2.02041);
  close(3, -13.39746);
  close(1.1, -0.113443);
  close(0.9, -0.1386);
});

test("impermanent loss is the same for a move and its mirror, never positive, and finite at the extremes", () => {
  for (const r of [1.01, 1.7, 4, 25, 1000]) assert.ok(Math.abs(impermanentLossPct(r)! - impermanentLossPct(1 / r)!) < 1e-9, `r=${r}`);
  for (const r of [1e-9, 0.01, 0.99, 1, 1.01, 100, 1e12, 1e300]) {
    const il = impermanentLossPct(r)!;
    assert.ok(Number.isFinite(il) && il <= 0 && il >= -100, `r=${r}: ${il}`);
  }
  assert.ok(impermanentLossPct(1e12)! < -99.99, "a price that ran away costs nearly everything");
});

test("a price ratio that is not a positive number has no impermanent loss to state", () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) assert.equal(impermanentLossPct(bad), null, String(bad));
});

/* ---------- fee APR ---------- */

test("fee APR, fees and window volume match a hand calculation for 7 days and 30 days", () => {
  // 7d: 500M QU x 0.192% = 960,000 QU of fees on a 2B QU pool = 0.048% in 7 days; x 365/7 = 2.502857% a year
  const s7 = poolStats({ ...POOL, hours: steady(), window: "7d", now: NOW });
  assert.equal(s7.tvlQu, 2_000_000_000);
  assert.equal(s7.volumeQu, 500_000_000);
  assert.equal(s7.swaps, 100);
  assert.equal(s7.activeHours, 10);
  assert.equal(s7.feesToLpQu, 960_000);
  assert.equal(s7.feeReturnPct, 0.048);
  assert.equal(s7.feeAprPct, 2.5029);
  assert.equal(s7.windowDays, 7);
  // 30d: 1B QU -> 1,920,000 QU = 0.096% in 30 days; x 365/30 = 1.168% a year
  const s30 = poolStats({ ...POOL, hours: steady(), window: "30d", now: NOW });
  assert.equal(s30.volumeQu, 1_000_000_000);
  assert.equal(s30.swaps, 200);
  assert.equal(s30.feesToLpQu, 1_920_000);
  assert.equal(s30.feeReturnPct, 0.096);
  assert.equal(s30.feeAprPct, 1.168);
});

test("TVL is the QU side times two, and a bigger pool earns a smaller rate from the same volume", () => {
  const small = poolStats({ ...POOL, poolQu: 500_000_000, hours: steady(), window: "7d", now: NOW });
  assert.equal(small.tvlQu, 1_000_000_000);
  assert.equal(small.feeAprPct, 5.0057, "half the pool, double the rate");
  const big = poolStats({ ...POOL, poolQu: 2_000_000_000, hours: steady(), window: "7d", now: NOW });
  assert.equal(big.feeAprPct, 1.2514);
});

test("the window decides which hours count, including its edge", () => {
  const at = (age: number) => poolStats({ ...POOL, hours: [hr(age, 1_000_000_000, 5)], window: "7d", now: NOW });
  assert.equal(at(1).volumeQu, 1_000_000_000);
  assert.equal(at(168).volumeQu, 1_000_000_000, "an hour that began exactly 7 days ago still covers the first hour of the window");
  assert.equal(at(169).volumeQu, 0, "one that ended before the window began does not");
  const thirty = (age: number) => poolStats({ ...POOL, hours: [hr(age, 1_000_000_000, 5)], window: "30d", now: NOW });
  assert.equal(thirty(169).volumeQu, 1_000_000_000, "but it is inside the 30-day window");
  assert.equal(thirty(30 * 24).volumeQu, 1_000_000_000);
  assert.equal(thirty(30 * 24 + 1).volumeQu, 0);
});

test("hours may arrive in any order, and the clock is used when no time is given", () => {
  const shuffled = steady().reverse();
  assert.deepEqual(poolStats({ ...POOL, hours: shuffled, window: "7d", now: NOW }), poolStats({ ...POOL, hours: steady(), window: "7d", now: NOW }));
  const recent: PoolHour[] = [{ ...hr(0, 7_000_000, 3), hour: Math.floor(Date.now() / H) * H }];
  assert.equal(poolStats({ ...POOL, hours: recent, window: "7d" }).swaps, 3);
});

test("a window other than 7d or 30d is refused", () => {
  assert.throws(() => poolStats({ ...POOL, hours: [], window: "1d" as "7d", now: NOW }), RangeError);
});

/* ---------- price change and impermanent loss over the window ---------- */

test("the price change runs from the last swap before the window to the pool's price now, and impermanent loss follows", () => {
  // the last swap before the window closed at 1.0; the pool now holds 1B QU against 0.5B units, so its price is 2: +100%
  const hours = [hr(200, 1_000_000, 1, 1.0, 1.0), ...Array.from({ length: 10 }, (_, i) => hr(1 + i, 50_000_000, 10, 1.5, 1.8))];
  const s = poolStats({ id: "CFB", poolQu: 1_000_000_000, poolAsset: 500_000_000, hours, window: "7d", now: NOW });
  assert.equal(s.poolPriceQu, 2);
  assert.equal(s.priceChangeFrom, "before-window");
  assert.equal(s.priceChangePct, 100);
  assert.equal(s.impermanentLossPct, -5.7191);
  // net = fees over the window (0.048%) + IL
  assert.equal(s.feeReturnPct, 0.048);
  assert.equal(s.netVsHoldPct, r4(0.048 + -5.719096));
});

test("a price that fell is measured the same way, and the loss is the mirror of the same rise", () => {
  const down = poolStats({ id: "A", poolQu: 500_000_000, poolAsset: 1_000_000_000, hours: [hr(200, 1_000_000, 1, 1, 1), hr(2, 50_000_000, 10, 0.7, 0.5)], window: "7d", now: NOW });
  assert.equal(down.priceChangePct, -50);
  assert.equal(down.impermanentLossPct, -5.7191, "halving costs the same as doubling");
});

test("with no swap before the window the price change starts at the first swap inside it, and says so", () => {
  const s = poolStats({ id: "NEW", poolQu: 1_000_000_000, poolAsset: 500_000_000, hours: [hr(30, 50_000_000, 10, 1.25, 1.5), hr(3, 50_000_000, 10, 1.9, 2)], window: "7d", now: NOW });
  assert.equal(s.priceChangeFrom, "first-swap-in-window");
  assert.equal(s.priceChangePct, 60);
  assert.equal(s.impermanentLossPct, -2.6991);
  assert.ok(s.quality.some((q) => q.code === "young-pool"));
});

test("sparse hours: the starting price is the last swap however long ago it was", () => {
  // the last swap before the window was 4 months ago and nothing since but one swap: the pool's price sat still in between
  const s = poolStats({ ...POOL, hours: [hr(24 * 120, 1_000_000, 1, 1, 1), hr(5, 20_000_000, 2, 1, 1)], window: "7d", now: NOW });
  assert.equal(s.priceChangeFrom, "before-window");
  assert.equal(s.priceChangePct, 0);
  assert.equal(s.impermanentLossPct, 0);
});

test("a pool with no swaps in the window did not move: 0% fees, 0% change, 0% loss", () => {
  const s = poolStats({ ...POOL, hours: [hr(24 * 40, 5_000_000, 3, 1, 1)], window: "7d", now: NOW });
  assert.deepEqual([s.volumeQu, s.swaps, s.feesToLpQu, s.feeAprPct, s.feeReturnPct], [0, 0, 0, 0, 0]);
  assert.deepEqual([s.priceChangePct, s.priceChangeFrom, s.impermanentLossPct, s.netVsHoldPct], [0, "no-swaps", 0, 0]);
  assert.deepEqual(s.quality.map((q) => q.code), ["no-swaps"]);
  assert.equal(s.lowConfidence, true);
});

/* ---------- empty, sparse and garbage input ---------- */

test("a pool nobody traded gives zeros, not an error, whether hours are null, empty or missing", () => {
  for (const hours of [null, []]) {
    const s = poolStats({ ...POOL, hours, window: "30d", now: NOW });
    finiteEverywhere(s);
    assert.equal(s.feeAprPct, 0);
    assert.equal(s.volumeQu, 0);
    assert.equal(s.topHourSharePct, 0);
    assert.equal(s.priceRangeRatio, null);
    assert.equal(s.impermanentLossPct, 0);
  }
});

test("an empty pool, a pool with one side empty and nonsense numbers never produce NaN or Infinity", () => {
  const busy = steady();
  for (const [poolQu, poolAsset] of [[0, 0], [0, 5], [5, 0], [-1, -1], [NaN, 5], [5, NaN], [Infinity, 5], [1, 1e-300]] as const) {
    const s = poolStats({ id: "X", poolQu, poolAsset, hours: busy, window: "7d", now: NOW });
    finiteEverywhere(s);
  }
  const noQu = poolStats({ id: "X", poolQu: 0, poolAsset: 5, hours: busy, window: "7d", now: NOW });
  assert.equal(noQu.feeAprPct, 0, "no TVL, no rate to state");
  assert.equal(noQu.poolPriceQu, null);
  assert.equal(noQu.priceChangePct, null);
  assert.equal(noQu.impermanentLossPct, null);
  assert.equal(noQu.netVsHoldPct, null);
  assert.ok(noQu.quality.some((q) => q.code === "no-price"));
});

test("hours with missing, negative or nonsense figures are ignored rather than poisoning the totals", () => {
  const junk = [
    { ...hr(5, NaN, 3), high: NaN, low: NaN },
    { ...hr(6, -50, -2) },
    { ...hr(7, Infinity, 1) },
    { ...hr(8, 1_000_000, 4, 2, 2), open: NaN, close: NaN, high: 0, low: 0 },
    { hour: NaN, qu: 1e9, qty: 1, n: 1, open: 1, close: 1, high: 1, low: 1 },
  ] as PoolHour[];
  const s = poolStats({ ...POOL, hours: junk, window: "7d", now: NOW });
  finiteEverywhere(s);
  assert.equal(s.volumeQu, 1_000_000, "only the one good figure counts");
  assert.equal(s.swaps, 4);
});

test("the busiest hour's share of the volume is reported", () => {
  const s = poolStats({ ...POOL, hours: [hr(1, 90_000_000, 3), hr(2, 10_000_000, 3)], window: "7d", now: NOW });
  assert.equal(s.topHourSharePct, 90);
});

/* ---------- the wash flag ---------- */

test("a suspected-wash asset is flagged and nothing else changes", () => {
  const plain = poolStats({ ...POOL, hours: steady(), window: "7d", now: NOW });
  const asked: string[] = [];
  const flagged = poolStats({ ...POOL, hours: steady(), window: "7d", now: NOW, suspectWash: (id) => (asked.push(id), true) });
  assert.deepEqual(asked, ["CFB"], "asked about this asset, once");
  assert.equal(flagged.volumeInflated, true);
  assert.equal(plain.volumeInflated, false);
  assert.equal(flagged.feeAprPct, plain.feeAprPct, "the APR is not adjusted, only flagged");
  assert.equal(flagged.volumeQu, plain.volumeQu);
  const note = flagged.quality.find((q) => q.code === "inflated-volume")!;
  assert.match(note.message, /wash trading/);
  assert.match(note.message, /inflated|higher/);
  assert.equal(flagged.lowConfidence, true);
  assert.equal(plain.lowConfidence, false);
});

test("a flag that says no, is missing, or throws leaves the pool unflagged", () => {
  for (const suspectWash of [() => false, undefined, () => { throw new Error("boom"); }]) {
    const s = poolStats({ ...POOL, hours: steady(), window: "7d", now: NOW, suspectWash });
    assert.equal(s.volumeInflated, false);
    assert.ok(!s.quality.some((q) => q.code === "inflated-volume"));
  }
});

/* ---------- quality notes ---------- */

test("a healthy pool has no notes", () => {
  const s = poolStats({ ...POOL, hours: steady(), window: "7d", now: NOW });
  assert.deepEqual(s.quality, []);
  assert.equal(s.lowConfidence, false);
});

test("fewer than one swap a day is thin volume, in either window", () => {
  const few = (n: number) => [hr(200, 1_000, 1, 1), hr(1, 10_000_000, n), hr(30, 10_000_000, n)];
  assert.ok(poolStats({ ...POOL, hours: few(3), window: "7d", now: NOW }).quality.some((q) => q.code === "thin-volume"), "3 swaps in 7 days");
  assert.ok(!poolStats({ ...POOL, hours: [hr(200, 1_000, 1, 1), hr(1, 10_000_000, 3), hr(2, 10_000_000, 4)], window: "7d", now: NOW }).quality.some((q) => q.code === "thin-volume"), "7 swaps in 7 days is one a day");
  assert.ok(poolStats({ ...POOL, hours: few(10), window: "30d", now: NOW }).quality.some((q) => q.code === "thin-volume"), "21 swaps in 30 days");
  const one = poolStats({ ...POOL, hours: [hr(1, 1_000_000, 1)], window: "7d", now: NOW });
  assert.match(one.quality.find((q) => q.code === "thin-volume")!.message, /Only 1 swap in 7 days/);
});

test("most of the volume in one hour is a burst, not a steady rate", () => {
  const s = poolStats({ ...POOL, hours: [hr(200, 1_000, 1, 1), hr(2, 900_000_000, 5), ...Array.from({ length: 10 }, (_, i) => hr(10 + i, 10_000_000, 10))], window: "7d", now: NOW });
  const note = s.quality.find((q) => q.code === "concentrated-volume")!;
  assert.match(note.message, /90% of the window's volume came in a single hour/);
  assert.ok(!s.quality.some((q) => q.code === "thin-volume"));
});

test("swap prices that span a factor of three or more are flagged", () => {
  const s = poolStats({ ...POOL, hours: [hr(200, 1_000, 1, 1), ...Array.from({ length: 10 }, (_, i) => hr(1 + i, 50_000_000, 10, 1, 1, i === 3 ? 4.5 : 1, i === 3 ? 0.9 : 1))], window: "7d", now: NOW });
  assert.equal(s.priceRangeRatio, 5);
  assert.match(s.quality.find((q) => q.code === "wide-price-range")!.message, /factor of 5\.0/);
  const calm = poolStats({ ...POOL, hours: steady(), window: "7d", now: NOW });
  assert.equal(calm.priceRangeRatio, 1);
});

test("a pool under the size threshold is tiny, and one at it is not", () => {
  const tiny = poolStats({ id: "T", poolQu: SMALL_POOL_TVL_QU / 2 - 1, poolAsset: 1e6, hours: steady(), window: "7d", now: NOW });
  assert.ok(tiny.quality.some((q) => q.code === "small-pool"));
  assert.ok(tiny.lowConfidence);
  const ok = poolStats({ id: "T", poolQu: SMALL_POOL_TVL_QU / 2, poolAsset: 1e6, hours: steady(), window: "7d", now: NOW });
  assert.ok(!ok.quality.some((q) => q.code === "small-pool"));
});

test("a 5,000% APR from a few swaps in a dust pool is reported as it is, with the reasons it should not be trusted", () => {
  // 300M QU of volume in 3 swaps in one hour against a pool holding 0.3M QU (TVL 0.6M): fees of 576,000 QU are 96% of TVL in a week
  const s = poolStats({ id: "DUST", poolQu: 300_000, poolAsset: 1_000_000, hours: [hr(5, 300_000_000, 3)], window: "7d", now: NOW });
  assert.equal(s.feesToLpQu, 576_000);
  assert.ok(s.feeAprPct > 5000, `APR is ${s.feeAprPct}`);
  assert.deepEqual(s.quality.map((q) => q.code).sort(), ["concentrated-volume", "small-pool", "thin-volume", "young-pool"]);
  assert.equal(s.lowConfidence, true);
  finiteEverywhere(s);
});

test("while the index is still reading back, the rate uses only the days it has read, and says so", () => {
  // the index has read only the last 2 days of a 7-day window; 100M QU swapped in them
  const hours = Array.from({ length: 10 }, (_, i) => hr(1 + i, 10_000_000, 10));
  const full = poolStats({ ...POOL, hours, window: "7d", now: NOW });
  const part = poolStats({ ...POOL, hours, window: "7d", now: NOW, coveredSince: NOW - 2 * D });
  assert.equal(part.rateDays, 2);
  assert.equal(full.rateDays, 7);
  assert.equal(part.volumeQu, full.volumeQu, "the volume itself is whatever was read");
  assert.ok(Math.abs(part.feeAprPct - full.feeAprPct * 3.5) < 0.001, `${part.feeAprPct} vs ${full.feeAprPct} x 3.5: the same volume spread over 2 days instead of 7`);
  assert.ok(part.quality.some((q) => q.code === "partial-history"));
  assert.ok(!full.quality.some((q) => q.code === "partial-history"));
  // covered all the way back (or further) is the same as not saying
  assert.deepEqual(poolStats({ ...POOL, hours, window: "7d", now: NOW, coveredSince: NOW - 40 * D }), full);
  // nothing read yet: no rate, no crash
  const none = poolStats({ ...POOL, hours: [], window: "7d", now: NOW, coveredSince: NOW + 1000 });
  assert.equal(none.feeAprPct, 0);
  finiteEverywhere(none);
});

/* ---------- position estimate ---------- */

const base = (): PoolStats => poolStats({ ...POOL, hours: steady(), window: "7d", now: NOW });

test("a deposit's fees, share and APR match a hand calculation", () => {
  // pool fees: 960,000 QU in 7 days = 137,142.86 a day. A 100M QU deposit is 100 / (2000 + 100) = 4.7619% of the pool afterwards.
  const e = positionEstimate({ positionQu: 100_000_000, stats: base() });
  assert.equal(e.sharePct, 4.7619);
  assert.equal(e.feesPerDayQu, 6530.61);
  assert.equal(e.feesPer30dQu, 195_918.37);
  assert.equal(e.aprAfterDepositPct, 2.3837);
  assert.equal(e.positionQu, 100_000_000);
});

test("impermanent loss for each price move is worked out in percent and in QU", () => {
  const e = positionEstimate({ positionQu: 1_000_000, stats: base() });
  assert.deepEqual(e.il.map((x) => x.movePct), [-50, -25, -10, 10, 25, 50]);
  assert.deepEqual([...IL_MOVES_PCT], [-50, -25, -10, 10, 25, 50]);
  const want = [
    [-50, -5.7191, -42_893.22, 707_106.78, 750_000],
    [-25, -1.0257, -8_974.6, 866_025.4, 875_000],
    [-10, -0.1386, -1_316.7, 948_683.3, 950_000],
    [10, -0.1134, -1_191.15, 1_048_808.85, 1_050_000],
    [25, -0.6192, -6_966.01, 1_118_033.99, 1_125_000],
    [50, -2.0204, -25_255.13, 1_224_744.87, 1_250_000],
  ];
  e.il.forEach((row, i) => assert.deepEqual([row.movePct, row.ilPct, row.ilQu, row.lpQu, row.holdQu], want[i]));
  // the QU figure is the percentage of what holding would be worth
  for (const row of e.il) assert.ok(Math.abs(row.ilQu - (row.holdQu * row.ilPct) / 100) < 1, `${row.movePct}`);
});

test("the flat fee to add and to remove liquidity is stated, and so is how long the fees take to cover it", () => {
  const e = positionEstimate({ positionQu: 100_000_000, stats: base() });
  assert.deepEqual([e.costs.addQu, e.costs.removeQu, e.costs.roundTripQu], [100_000, 100_000, 200_000]);
  assert.equal(e.costs.daysToCoverCosts, 30.63, "200,000 QU at 6,530.61 QU a day");
  assert.ok(e.notes.some((n) => /100,000 QU/.test(n)));
  assert.ok(e.notes.some((n) => /estimate/i.test(n)));
});

test("a bigger deposit dilutes the rate it would earn, and a tiny one earns about the pool's rate", () => {
  const s = base();
  const tiny = positionEstimate({ positionQu: 1_000, stats: s });
  assert.ok(Math.abs(tiny.aprAfterDepositPct - s.feeAprPct) < 0.001, `${tiny.aprAfterDepositPct} vs ${s.feeAprPct}`);
  const huge = positionEstimate({ positionQu: 2_000_000_000, stats: s });
  assert.equal(huge.sharePct, 50);
  assert.ok(Math.abs(huge.aprAfterDepositPct - s.feeAprPct / 2) < 0.001, `${huge.aprAfterDepositPct} vs half of ${s.feeAprPct}: doubling the pool halves the rate`);
});

test("a deposit into a pool with no volume earns nothing and never divides by zero", () => {
  const quiet = poolStats({ ...POOL, hours: [], window: "7d", now: NOW });
  const e = positionEstimate({ positionQu: 5_000_000, stats: quiet });
  assert.deepEqual([e.feesPerDayQu, e.feesPer30dQu, e.aprAfterDepositPct, e.costs.daysToCoverCosts], [0, 0, 0, null]);
  finiteEverywhere(e);
  const empty = poolStats({ id: "E", poolQu: 0, poolAsset: 0, hours: [], window: "7d", now: NOW });
  const f = positionEstimate({ positionQu: 5_000_000, stats: empty });
  assert.equal(f.sharePct, 100);
  finiteEverywhere(f);
});

test("a deposit that is not a positive number is refused", () => {
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => positionEstimate({ positionQu: bad, stats: base() }), RangeError, String(bad));
});

/* ---------- reading the amount a person types ---------- */

test("an amount of QU is read the way people type it", () => {
  const cases: [string, number][] = [["100000000", 1e8], ["100,000,000", 1e8], ["100m", 1e8], ["1.5B", 1.5e9], ["250k", 250_000], [" 10 M ", 1e7], [".5m", 500_000], ["1_000", 1000], ["0.5", 0.5], ["1000000b", 1e15]];
  for (const [text, want] of cases) assert.equal(parseQuAmount(text), want, text);
});

test("an amount that is not a positive number of QU within the limit is refused", () => {
  for (const bad of ["", "   ", "abc", "-5", "0", "0k", "0.0m", "1e9", "12x", "1.2.3", "m", "10000000b", "Infinity", "NaN", "5 5 5m x"]) assert.equal(parseQuAmount(bad), null, JSON.stringify(bad));
  assert.equal(parseQuAmount(undefined as unknown as string), null);
});

/* ---------- ranking ---------- */

const item = (id: string, feeAprPct: number, tvlQu: number, volumeQu: number, lowConfidence = false) => ({ id, feeAprPct, tvlQu, volumeQu, lowConfidence });

test("by APR, pools without notes come first, each group highest APR first", () => {
  const list = [item("DUST", 5000, 1e6, 1e6, true), item("A", 3, 1e9, 1e8), item("B", 7, 1e9, 1e8), item("SPIKY", 40, 1e9, 1e8, true), item("C", 0, 1e9, 0, true)];
  const ranked = rankPools(list, "apr");
  assert.deepEqual(ranked.map((p) => p.id), ["B", "A", "DUST", "SPIKY", "C"]);
  assert.deepEqual(ranked.map((p) => p.rank), [1, 2, 3, 4, 5]);
});

test("by TVL and by volume it is a plain sort, and ties break by TVL then id", () => {
  const list = [item("A", 1, 100, 50, true), item("B", 1, 300, 10), item("C", 1, 200, 50), item("D", 1, 200, 50)];
  assert.deepEqual(rankPools(list, "tvl").map((p) => p.id), ["B", "C", "D", "A"]);
  assert.deepEqual(rankPools(list, "volume").map((p) => p.id), ["C", "D", "A", "B"], "50 ties broken by TVL (200, 200, 100), then C before D");
});

test("ranking does not change the list it is given", () => {
  const list = [item("A", 1, 1, 1), item("B", 2, 2, 2)];
  const copy = structuredClone(list);
  rankPools(list, "apr");
  assert.deepEqual(list, copy);
  assert.deepEqual(rankPools([], "apr"), []);
});

/* ---------- through the trade index ---------- */

test("swaps read from the archive by the trade index flow through to fees and APR", async () => {
  // three buys in the last three hours: 1,000,000 QU in each for 500,000 units (price 2)
  const events = [1, 2, 3].map((i) => swap(6, 100 + i, NOW - i * H + 5_000, "CFB", 1_000_000, 500_000));
  const idx = new TradeIndex(archive(events, { lastTick: 200 }), { days: 30 });
  await idx.update(NOW);
  const hours = idx.hours(key("CFB"), "QSwap");
  const s = poolStats({ id: "CFB", poolQu: 1_000_000_000, poolAsset: 500_000_000, hours, window: "7d", now: NOW });
  assert.equal(s.volumeQu, 3_000_000);
  assert.equal(s.swaps, 3);
  assert.equal(s.feesToLpQu, 5_760, "0.192% of 3M QU");
  assert.equal(s.priceChangeFrom, "first-swap-in-window");
  assert.equal(s.priceChangePct, 0, "swaps at 2 QU each and a pool now priced at 2");
  assert.equal(poolStats({ id: "NOPE", poolQu: 1e9, poolAsset: 1e9, hours: idx.hours(key("NOPE"), "QSwap"), window: "7d", now: NOW }).swaps, 0);
});

/* ---------- routes ---------- */

function setup(over: Partial<PoolsDeps> = {}) {
  const calls = { pools: 0, hours: [] as string[] };
  let now = NOW;
  const deps: PoolsDeps = {
    pools: () => (
      calls.pools++,
      [
        { id: "CFB", symbol: "CFB", poolQu: 1_000_000_000, poolAsset: 1_000_000_000, priceQu: 1 },
        { id: "DUST", symbol: "DUST", poolQu: 300_000, poolAsset: 1_000_000, priceQu: 0.3 },
        { id: "BIG", symbol: "BIG", poolQu: 5_000_000_000, poolAsset: 5_000_000_000, priceQu: 1 },
        { id: "IDLE", symbol: "IDLE", poolQu: 2_000_000_000, poolAsset: 1_000_000_000, priceQu: null },
      ]
    ),
    hours: (id) => (calls.hours.push(id), id === "CFB" ? steady() : id === "DUST" ? [hr(5, 300_000_000, 3)] : id === "BIG" ? steady().map((h) => ({ ...h, qu: h.qu * 4 })) : null),
    ...over,
  };
  const routes = poolsRoutes(deps, { now: () => now });
  const find = (path: string) => routes.find((r) => r.path === path)!;
  const call = (path: string, qs = "") => find(path).handler({ query: new URLSearchParams(qs), body: undefined }) as any;
  return { routes, calls, call, advance: (ms: number) => (now += ms) };
}

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof RouteError, `expected a RouteError, got ${e}`);
    return e as RouteError;
  }
  assert.fail("expected a refusal");
};

test("the routes are the two documented GETs", () => {
  const { routes } = setup();
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ["GET /v1/pools", "GET /v1/pools/detail"]);
  for (const r of routes) assert.ok(r.doc.summary && r.doc.description?.includes(POOLS_CAVEAT));
});

test("the list defaults to 7 days ranked by APR, and covers every pool", () => {
  const { call } = setup();
  const res = call("/v1/pools");
  assert.equal(res.window, "7d");
  assert.equal(res.sort, "apr");
  assert.equal(res.pools.length, 4);
  assert.equal(res.note.startsWith(POOLS_CAVEAT), true);
  assert.equal(new Date(res.computedAt).toISOString(), res.computedAt);
  assert.deepEqual(res.feeModel, FEE_MODEL);
  // CFB (2.50%) and BIG (2.00%) are healthy; DUST has a huge APR but is flagged; IDLE never traded
  assert.deepEqual(res.pools.map((p: any) => [p.rank, p.id]), [[1, "CFB"], [2, "BIG"], [3, "DUST"], [4, "IDLE"]]);
  const dust = res.pools[2];
  assert.ok(dust.feeAprPct > 5000, "the headline number is not hidden");
  assert.equal(dust.lowConfidence, true);
  const idle = res.pools[3];
  assert.deepEqual([idle.volumeQu, idle.feeAprPct, idle.priceQu], [0, 0, null]);
  finiteEverywhere(res);
});

test("window and sort change the numbers and the order", () => {
  const { call } = setup();
  const t30 = call("/v1/pools", "window=30d&sort=tvl");
  assert.equal(t30.window, "30d");
  assert.deepEqual(t30.pools.map((p: any) => p.id), ["BIG", "IDLE", "CFB", "DUST"]);
  assert.equal(t30.pools.find((p: any) => p.id === "CFB").volumeQu, 1_000_000_000);
  assert.equal(call("/v1/pools").pools.find((p: any) => p.id === "CFB").volumeQu, 500_000_000);
  const byVol = call("/v1/pools", "sort=volume");
  assert.deepEqual(byVol.pools.map((p: any) => p.id), ["BIG", "CFB", "DUST", "IDLE"]);
});

test("a window or sort that is not allowed is a 400", () => {
  const { call } = setup();
  assert.equal(refusal(() => call("/v1/pools", "window=1d")).status, 400);
  assert.equal(refusal(() => call("/v1/pools", "sort=apy")).status, 400);
  assert.equal(refusal(() => call("/v1/pools/detail", "asset=CFB&window=90d")).status, 400);
  assert.equal(call("/v1/pools", "window=&sort=").window, "7d", "empty falls back to the default");
});

test("the list is cached for 60 seconds, per window, and sorting does not recompute it", () => {
  const { call, calls, advance } = setup();
  call("/v1/pools");
  call("/v1/pools", "sort=tvl");
  call("/v1/pools", "sort=volume");
  assert.equal(calls.pools, 1);
  call("/v1/pools", "window=30d");
  assert.equal(calls.pools, 2, "the 30-day list is its own computation");
  advance(59_000);
  const cached = call("/v1/pools");
  assert.equal(calls.pools, 2);
  advance(2_000);
  const fresh = call("/v1/pools");
  assert.equal(calls.pools, 3, "past a minute it is recomputed");
  assert.notEqual(cached.computedAt, fresh.computedAt);
  assert.equal(fresh.computedAt, new Date(NOW + 61_000).toISOString());
});

test("a pool flagged as wash is marked, and ranked below the unflagged ones by APR even with a higher APR", () => {
  const { call } = setup({ suspectWash: (id) => id === "CFB" });
  const res = call("/v1/pools");
  const by = (id: string) => res.pools.find((p: any) => p.id === id);
  assert.equal(by("CFB").volumeInflated, true);
  assert.equal(by("BIG").volumeInflated, false);
  assert.ok(by("CFB").feeAprPct > by("BIG").feeAprPct, "CFB still shows the higher APR");
  assert.deepEqual(res.pools.map((p: any) => p.id), ["BIG", "DUST", "CFB", "IDLE"], "but BIG is ranked first, then the flagged pools by APR");
  assert.equal(call("/v1/pools", "sort=tvl").pools.find((p: any) => p.id === "CFB").volumeInflated, true);
  assert.equal(call("/v1/pools/detail", "asset=CFB").pool.volumeInflated, true);
  assert.equal(call("/v1/pools/detail", "asset=BIG").pool.volumeInflated, false);
});

test("while the trade index is still reading back, every pool says how many days it has", () => {
  const { call } = setup({ coveredSince: () => NOW - 3 * D });
  const res = call("/v1/pools");
  for (const p of res.pools) {
    assert.equal(p.rateDays, 3);
    assert.ok(p.quality.some((q: any) => q.code === "partial-history"), p.id);
  }
  assert.equal(call("/v1/pools/detail", "asset=CFB").pool.rateDays, 3);
  // null means everything has been read, the same as leaving it out
  const complete = setup({ coveredSince: () => null }).call("/v1/pools");
  assert.equal(complete.pools.find((p: any) => p.id === "CFB").rateDays, 7);
});

test("the detail route returns one pool's stats, and an estimate only when a deposit is given", () => {
  const { call } = setup();
  const plain = call("/v1/pools/detail", "asset=CFB");
  assert.equal(plain.window, "7d");
  assert.equal(plain.pool.id, "CFB");
  assert.equal(plain.pool.feeAprPct, 2.5029);
  assert.equal(plain.positionEstimate, undefined);
  assert.equal("positionEstimate" in plain, false);
  assert.equal(plain.note.startsWith(POOLS_CAVEAT), true);

  const withPos = call("/v1/pools/detail", "asset=CFB&window=30d&positionQu=100000000");
  assert.equal(withPos.window, "30d");
  assert.equal(withPos.pool.volumeQu, 1_000_000_000);
  assert.equal(withPos.positionEstimate.positionQu, 100_000_000);
  assert.equal(withPos.positionEstimate.il.length, 6);
  assert.equal(withPos.positionEstimate.costs.roundTripQu, 200_000);
  finiteEverywhere(withPos);
  assert.equal(call("/v1/pools/detail", "asset=CFB&positionQu=").positionEstimate, undefined, "an empty deposit is no deposit");
});

test("the detail route finds an asset whatever its case, and refuses one without a pool with a 404", () => {
  const { call } = setup();
  assert.equal(call("/v1/pools/detail", "asset=cfb").pool.id, "CFB");
  const none = refusal(() => call("/v1/pools/detail", "asset=NOPE"));
  assert.equal(none.status, 404);
  assert.match(none.message, /No QSwap pool for 'NOPE'/);
  assert.ok(none.extra.hint);
  assert.equal(refusal(() => call("/v1/pools/detail")).status, 400, "the asset is required");
  assert.equal(refusal(() => call("/v1/pools/detail", "asset=%20")).status, 400);
});

test("a deposit that is not a sensible number of QU is a 400", () => {
  const { call } = setup();
  for (const bad of ["abc", "0", "-5", "1e16", "Infinity", "NaN", "1,000"]) assert.equal(refusal(() => call("/v1/pools/detail", `asset=CFB&positionQu=${bad}`)).status, 400, bad);
  assert.equal(call("/v1/pools/detail", "asset=CFB&positionQu=1e9").positionEstimate.positionQu, 1e9, "scientific notation is a number");
  assert.equal(call("/v1/pools/detail", "asset=CFB&positionQu=0.5").positionEstimate.positionQu, 0.5);
});

test("pools whose reserves are not numbers are left out rather than breaking the list", () => {
  const { call } = setup({ pools: () => [{ id: "OK", symbol: "OK", poolQu: 1e9, poolAsset: 1e9, priceQu: 1 }, { id: "BAD", symbol: "BAD", poolQu: NaN, poolAsset: 5, priceQu: null }, { id: "BAD2", symbol: "BAD2", poolQu: 5, poolAsset: Infinity, priceQu: null }] });
  assert.deepEqual(call("/v1/pools").pools.map((p: any) => p.id), ["OK"]);
  assert.equal(refusal(() => call("/v1/pools/detail", "asset=BAD")).status, 404);
});

test("no pools at all is an empty list, not an error", () => {
  const { call } = setup({ pools: () => [] });
  assert.deepEqual(call("/v1/pools").pools, []);
});

/* ---------- served by the real API ---------- */

const { routes: served } = setup();
const data: MarketData = { assets: () => [], venues: async () => null };
const server = createApi({ data, routes: served as Route[] });
await new Promise<void>((r) => server.listen(0, () => r()));
const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const get = (path: string) => fetch(origin + path).then(async (r) => ({ r, j: (await r.json()) as Record<string, any> }));

test("served over HTTP: parameters are checked, a missing pool is a 404, and the OpenAPI document describes both endpoints", async () => {
  const ok = await get("/v1/pools?window=30d&sort=volume");
  assert.equal(ok.r.status, 200);
  assert.equal(ok.j.window, "30d");
  assert.equal(ok.j.pools[0].id, "BIG");
  assert.equal((await get("/v1/pools?sort=nope")).r.status, 400);
  const missing = await get("/v1/pools/detail?asset=NOPE");
  assert.equal(missing.r.status, 404);
  assert.match(missing.j.error, /No QSwap pool/);
  const detail = await get("/v1/pools/detail?asset=CFB&positionQu=50000000");
  assert.equal(detail.r.status, 200);
  assert.equal(detail.j.positionEstimate.positionQu, 50_000_000);
  const spec = (await get("/v1/openapi.json")).j;
  assert.ok(spec.paths["/v1/pools"].get);
  assert.ok(spec.paths["/v1/pools/detail"].get);
});
