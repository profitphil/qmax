import test from "node:test";
import assert from "node:assert/strict";
import { INDICATORS, bollinger, candlesNeeded, ema, isIndicatorId, macd, rsi, sma, vwap } from "../src/indicators.ts";
import type { Series } from "../src/indicators.ts";

const close = (a: Series, b: (number | null)[], tol = 1e-6) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => {
    if (b[i] === null) assert.equal(v, null, `index ${i} should not be defined yet`);
    else assert.ok(v !== null && Math.abs(v - b[i]!) <= tol, `index ${i}: ${v} vs ${b[i]}`);
  });
};

// Reference values below were worked out separately, with plain loops, not by these functions.
const XS = [10, 11, 12, 11, 13, 15, 14, 16, 18, 17, 19, 21];

test("sma: the average of the last N, and nothing before there are N", () => {
  close(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  close(sma([5], 1), [5]);
  close(sma([1, 2], 3), [null, null]);
  close(sma([1, 2, 3], 0), [null, null, null]);
});

test("ema: seeded by the simple average, then each value pulls by 2/(N+1)", () => {
  close(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  close(ema([2, 4, 6, 8], 2), [null, 3, 5.0, 7.0]); // k = 2/3: 6*2/3 + 3/3 = 5; 8*2/3 + 5/3 = 7
  close(ema([1, 2], 5), [null, null]);
});

test("bollinger: the bands are the average plus and minus two population standard deviations", () => {
  const b = bollinger(XS, 5, 2);
  close(b.mid, [null, null, null, null, 11.4, 12.4, 13.0, 13.8, 15.2, 16.0, 16.8, 18.2], 1e-9);
  close(b.upper, [null, null, null, null, 13.4396, 15.3933, 15.8284, 17.2409, 18.6409, 18.8284, 20.2409, 21.6409], 1e-4);
  close(b.lower, [null, null, null, null, 9.3604, 9.4067, 10.1716, 10.3591, 11.7591, 13.1716, 13.3591, 14.7591], 1e-4);
  const flat = bollinger([7, 7, 7, 7, 7, 7], 3);
  assert.deepEqual([flat.upper[5], flat.lower[5], flat.mid[5]], [7, 7, 7], "no movement, no band width");
});

test("rsi: Wilder's smoothing, checked against a plain-loop calculation", () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
  const r = rsi(closes, 14);
  close(r.slice(0, 14), new Array(14).fill(null));
  close(r.slice(14), [70.46, 66.25, 66.48, 69.35, 66.29, 57.92], 0.006);
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 3).at(-1), 100, "only rises: fully stretched");
  assert.equal(rsi([6, 5, 4, 3, 2, 1], 3).at(-1), 0, "only falls");
  assert.equal(rsi([5, 5, 5, 5, 5], 3).at(-1), 50, "no movement is neither");
  close(rsi([1, 2, 3], 14), [null, null, null]);
});

test("macd: fast minus slow, its signal average, and the histogram between", () => {
  const m = macd(XS, 3, 6, 3);
  close(m.macd, [null, null, null, null, null, 1.5, 1.178571, 1.32398, 1.615343, 1.274352, 1.399091, 1.672341], 1e-5);
  close(m.signal, [null, null, null, null, null, null, null, 1.334184, 1.474763, 1.374557, 1.386824, 1.529583], 1e-5);
  assert.ok(Math.abs(m.histogram[7]! - (1.32398 - 1.334184)) < 1e-5);
  assert.equal(m.histogram[6], null, "no histogram before there is a signal");
  assert.deepEqual(macd([1, 2, 3], 12, 26, 9).macd, [null, null, null]);
});

test("vwap: everything paid divided by everything bought, running from the first candle", () => {
  close(vwap([{ volumeQu: 1000, volumeQty: 10 }, { volumeQu: 3000, volumeQty: 10 }, { volumeQu: 900, volumeQty: 30 }]), [100, 200, 4900 / 50]);
  close(vwap([{ volumeQu: 0, volumeQty: 0 }, { volumeQu: 500, volumeQty: 5 }]), [null, 100]);
  close(vwap([{ volumeQu: NaN, volumeQty: 5 }, { volumeQu: 500, volumeQty: 5 }]), [null, 100]);
});

test("the list of indicators is what the chart offers, and each says how many candles it needs", () => {
  assert.equal(new Set(INDICATORS.map((i) => i.id)).size, INDICATORS.length);
  assert.ok(isIndicatorId("rsi") && !isIndicatorId("__proto__") && !isIndicatorId(5));
  assert.equal(candlesNeeded("sma50"), 50);
  // What each says it needs is the first index at which it has a value, plus one.
  const v = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 10 + i);
  const first = (s: Series) => s.findIndex((x) => x !== null) + 1;
  assert.equal(first(sma(v, 20)), candlesNeeded("sma20"));
  assert.equal(first(sma(v, 50)), candlesNeeded("sma50"));
  assert.equal(first(ema(v, 21)), candlesNeeded("ema21"));
  assert.equal(first(bollinger(v).mid), candlesNeeded("bb"));
  assert.equal(first(rsi(v, 14)), candlesNeeded("rsi"));
  assert.equal(first(macd(v).histogram), candlesNeeded("macd"));
});

import { atr, obv, stochastic } from "../src/indicators.ts";
import { heikinAshi, indicatorData } from "../src/lwdata.ts";

const H = [12, 13, 14, 13, 15, 17, 16, 18, 20, 19, 21, 23, 22, 24, 26, 25, 27, 26, 28, 30];
const L = [10, 11, 12, 11, 13, 14, 13, 15, 17, 16, 18, 20, 19, 21, 23, 22, 24, 23, 25, 27];
const C = [11, 12, 13, 12, 14, 16, 14, 17, 19, 17, 20, 22, 21, 23, 25, 23, 26, 24, 27, 29];
const V = [10, 20, 15, 30, 25, 40, 35, 20, 45, 30, 50, 60, 25, 35, 40, 30, 55, 20, 65, 70];
const bars = H.map((h, i) => ({ h, l: L[i], c: C[i], volumeQty: V[i] }));

test("stochastic: where the close sits in the recent range, smoothed twice", () => {
  const s = stochastic(bars, 5, 3, 3);
  close(s.k, [null, null, null, null, null, null, 71.1111, 73.0159, 73.8095, 76.1905, 76.7857, 77.381, 82.1429, 82.1429, 82.1429, 77.381, 77.381, 64.881, 73.6111, 73.6111], 1e-3);
  close(s.d, [null, null, null, null, null, null, null, null, 72.6455, 74.3386, 75.5952, 76.7857, 78.7698, 80.5556, 82.1429, 80.5556, 78.9683, 73.2143, 71.9577, 70.7011], 1e-3);
  const flat = stochastic([{ h: 5, l: 5, c: 5 }, { h: 5, l: 5, c: 5 }, { h: 5, l: 5, c: 5 }], 2, 1, 1);
  assert.equal(flat.k[2], 50, "no range: neither end");
});

test("atr: Wilder's smoothing of the true range", () => {
  close(atr(bars, 5), [null, null, null, null, 2.2, 2.36, 2.488, 2.7904, 2.8323, 2.8659, 3.0927, 3.0741, 3.0593, 3.0475, 3.038, 3.0304, 3.2243, 3.1794, 3.3435, 3.2748], 1e-3);
  close(atr([{ h: 5, l: 4, c: 4.5 }], 3), [null]);
});

test("obv: units added on an up close, taken off on a down close", () => {
  close(obv(bars), [0, 20, 35, 5, 30, 70, 35, 55, 100, 70, 120, 180, 155, 190, 230, 200, 255, 235, 300, 370]);
  close(obv([{ c: 5, volumeQty: 9 }, { c: 5, volumeQty: 9 }, { c: 6, volumeQty: NaN }]), [0, 0, 0]);
});

test("heikin-ashi: each candle starts from the middle of the one before, and holds its own highs and lows", () => {
  const O = [10.5, 11.5, 12.5, 12.5, 13.5, 15];
  const candles = O.map((o, i) => ({ t: (i + 1) * 3_600_000, o, h: H[i], l: L[i], c: C[i], volumeQu: 100, volumeQty: 10, trades: 1 }));
  const ha = heikinAshi(candles);
  close(ha.map((c) => c.o), [10.75, 10.8125, 11.3438, 12.1094, 12.1172, 12.9961], 1e-3);
  close(ha.map((c) => c.c), [10.875, 11.875, 12.875, 12.125, 13.875, 15.5], 1e-3);
  close(ha.map((c) => c.h), [12, 13, 14, 13, 15, 17]);
  close(ha.map((c) => c.l), [10, 10.8125, 11.3438, 11, 12.1172, 12.9961], 1e-3);
  assert.deepEqual(ha.map((c) => c.t), candles.map((c) => c.t));
  assert.deepEqual(heikinAshi([]), []);
});

test("the new indicators reach the chart under their names", () => {
  const candles = H.concat(H).map((h, i) => ({ t: (i + 1) * 3_600_000, o: C[i % 20], h, l: L[i % 20], c: C[i % 20] + (i >= 20 ? 1 : 0), volumeQu: 100, volumeQty: V[i % 20], trades: 1 }));
  assert.deepEqual(Object.keys(indicatorData(candles, "stoch")).sort(), ["d", "k"]);
  assert.ok(indicatorData(candles, "atr").line.length > 0);
  assert.equal(indicatorData(candles, "obv").line.length, 40);
});
