import test from "node:test";
import assert from "node:assert/strict";
import type { Sample } from "../src/history.ts";
import { axisPrice, candleData, lineData, volumeData } from "../src/lwdata.ts";
import type { CandlePoint } from "../src/lwdata.ts";
import type { TradeCandle } from "../src/trades.ts";

const H = 3_600_000;
const c = (hour: number, o: number, h: number, l: number, cl: number, volumeQu = 100): TradeCandle => ({ t: hour * H, o, h, l, c: cl, volumeQu, volumeQty: 1, trades: 1 });

test("candles become points in seconds, in order, one per time", () => {
  const out = candleData([c(3, 1, 2, 1, 2), c(1, 5, 6, 4, 5), c(2, 3, 3, 3, 3), c(2, 9, 9, 9, 9)], H) as CandlePoint[];
  assert.deepEqual(out.map((p) => p.time), [3600, 7200, 10800]);
  assert.deepEqual(out[1], { time: 7200, open: 9, high: 9, low: 9, close: 9 }, "the later of two candles at one time wins");
  assert.ok(out.every((p, i) => i === 0 || p.time > out[i - 1].time), "strictly increasing, as the library demands");
});

test("a stretch with no trades stays a gap: empty points keep the bars on either side apart", () => {
  const out = candleData([c(1, 1, 1, 1, 1), c(5, 2, 2, 2, 2)], H);
  assert.deepEqual(out.map((p) => p.time), [3600, 7200, 10800, 14400, 18000]);
  assert.equal(out.filter((p) => "open" in p).length, 2);
  assert.deepEqual(out[1], { time: 7200 }, "an empty point has a time and nothing else");
});

test("a very long quiet stretch adds a bounded number of empty points, not a million", () => {
  const out = candleData([c(1, 1, 1, 1, 1), c(1_000_000, 2, 2, 2, 2)], H);
  // (the cap is 30,000: room for a month of minute-wide candles, and still a bounded amount of memory)
  assert.ok(out.length <= 30_003, `${out.length} points`);
  assert.ok(out.length > 4_003, "and a quiet month of five-minute candles keeps all of its gaps");
  assert.ok(out.some((p) => "open" in p && p.time === 1_000_000 * 3600), "the last candle is still there");
});

test("a candle's wicks always hold its open and close, and candles with broken numbers are dropped", () => {
  const out = candleData([c(1, 10, 9, 11, 12), { ...c(2, 1, 1, 1, 1), o: NaN }, { ...c(3, 1, 1, 1, 1), t: Infinity }], H) as CandlePoint[];
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { time: 3600, open: 10, high: 12, low: 10, close: 12 }, "high 9 and low 11 were wrong for open 10 and close 12");
});

test("volume bars are coloured by whether the candle closed up or down, and bad volumes are zero", () => {
  const v = volumeData([c(1, 1, 2, 1, 2, 500), c(2, 5, 5, 3, 3, 700), c(3, 1, 1, 1, 1, NaN), c(4, 1, 1, 1, 1, -5)], "UP", "DOWN");
  assert.deepEqual(v.map((x) => [x.value, x.color]), [[500, "UP"], [700, "DOWN"], [0, "UP"], [0, "UP"]], "flat counts as up");
});

test("the line keeps only samples with a real price, in order, one per second", () => {
  const s = (t: number, price: number | null): Sample => ({ t, price, bid: null, ask: null, pool: null, liq: 0 });
  const out = lineData([s(3000, 3), s(1000, 1), s(2000, null), s(1500, 0), s(1000, 7), s(NaN, 5), s(4000, NaN)]);
  assert.deepEqual(out, [{ time: 1, value: 7 }, { time: 3, value: 3 }]);
});

test("axis prices are short when big and precise when small", () => {
  assert.equal(axisPrice(6_500_000_000), "6.50B");
  assert.equal(axisPrice(12_345_678), "12.35M");
  assert.equal(axisPrice(4288), "4,288");
  assert.equal(axisPrice(21.4007), "21.40");
  assert.equal(axisPrice(0.000123456), "0.000123");
  assert.equal(axisPrice(NaN), "");
});

import { indicatorData } from "../src/lwdata.ts";

test("indicator lines sit at the candles' own times, start when they have a value, and are keyed by name", () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({ t: (1_000 + i) * 3_600_000, o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i, volumeQu: 1000, volumeQty: 10, trades: 3 }));
  const sma20 = indicatorData(candles, "sma20").line;
  assert.equal(sma20.length, 41, "60 candles, defined from the 20th");
  assert.equal(sma20[0].time, (1_000 + 19) * 3600);
  assert.equal(sma20[0].value, 110.5, "the average of closes 101..120");
  assert.deepEqual(Object.keys(indicatorData(candles, "bb")).sort(), ["lower", "mid", "upper"]);
  assert.deepEqual(Object.keys(indicatorData(candles, "macd")).sort(), ["histogram", "macd", "signal"]);
  assert.equal(indicatorData(candles, "vwap").line.length, 60);
  assert.equal(indicatorData(candles, "vwap").line[0].value, 100);
  assert.equal(indicatorData(candles, "sma50").line.length, 11);
  assert.deepEqual(indicatorData([], "rsi").line, []);
  // Out of order and repeated candles are cleaned the same way as the candles drawn.
  assert.equal(indicatorData([...candles].reverse().concat(candles.slice(0, 5)), "sma20").line.length, 41);
});

import { closeLine } from "../src/lwdata.ts";

test("the area chart is the closes at the candles' own times, in order, one per second", () => {
  const c = (t: number, close: number) => ({ t: t * 1000, o: 1, h: 2, l: 0.5, c: close, volumeQu: 1, volumeQty: 1, trades: 1 });
  assert.deepEqual(closeLine([c(7200, 5), c(3600, 4), c(3600, 4.5), { ...c(10800, NaN) }]), [{ time: 3600, value: 4.5 }, { time: 7200, value: 5 }]);
});

import { fillQuietCandles } from "../src/lwdata.ts";

test("quiet hours carry the last price, with no volume, so a sparse market becomes an unbroken series", () => {
  const H = 3_600_000;
  const real = (t: number, o: number, h: number, l: number, c: number) => ({ t: t * H, o, h, l, c, volumeQu: 1000, volumeQty: 10, trades: 4 });
  const filled = fillQuietCandles([real(10, 5, 7, 4, 6), real(14, 6, 9, 6, 8)], H, 16 * H);
  assert.deepEqual(filled.map((c) => c.t / H), [10, 11, 12, 13, 14, 15, 16], "every hour from the first trade to the one asked for");
  assert.deepEqual(filled.map((c) => c.trades), [4, 0, 0, 0, 4, 0, 0]);
  assert.deepEqual([filled[1].o, filled[1].h, filled[1].l, filled[1].c], [6, 6, 6, 6], "flat at the close before it");
  assert.deepEqual([filled[5].o, filled[5].c, filled[5].volumeQu], [8, 8, 0], "and after the last trade, up to the time given");
  assert.equal(filled[0].h, 7, "real candles are untouched");
  assert.deepEqual(fillQuietCandles([], H, 5 * H), []);
  // Too much to fill (a tiny interval over a long time): the candles come back as they were.
  const big = [real(0, 1, 1, 1, 1), real(100_000, 1, 1, 1, 1)];
  assert.equal(fillQuietCandles(big, H, 100_000 * H, 20_000), big);
  // Out of order and repeated candles are cleaned the same way as the candles drawn.
  assert.equal(fillQuietCandles([real(12, 1, 1, 1, 1), real(10, 2, 2, 2, 2), real(10, 3, 3, 3, 3)], H, 12 * H).length, 3);
});
