import { atr, bollinger, ema, macd, obv, rsi, sma, stochastic, vwap } from "./indicators.ts";
import type { IndicatorId, Series } from "./indicators.ts";
import type { Sample } from "./history.ts";
import type { TradeCandle } from "./trades.ts";

/**
 * QMax's market data in the shapes TradingView's Lightweight Charts wants. Pure functions (no chart library import), so they are tested in
 * Node: the library draws; this decides what it is given.
 *
 * What the library insists on: every point has a `time` in whole seconds, in strictly increasing order with no repeats. A bar in a gap is not
 * drawn, so the bars on either side would sit next to each other: the gaps (stretches with no trades) are kept by giving them empty points.
 */

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface Gap {
  time: number;
}
export interface VolumePoint {
  time: number;
  value: number;
  color: string;
}
export interface LinePoint {
  time: number;
  value: number;
}

const seconds = (ms: number) => Math.floor(ms / 1000);
const valid = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** At most this many empty points are added for gaps in one chart (a long quiet stretch of hourly candles would otherwise add thousands). */
const MAX_GAP_POINTS = 30_000;

/** Sorted by time, one per time (the later wins), and only candles whose numbers are real. */
function clean(candles: TradeCandle[]): TradeCandle[] {
  const by = new Map<number, TradeCandle>();
  for (const c of candles) if (valid(c.t) && valid(c.o) && valid(c.h) && valid(c.l) && valid(c.c)) by.set(seconds(c.t), c);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

/** Candles for the candlestick series, with an empty point for every bucket in which nothing traded (up to a cap). */
export function candleData(candles: TradeCandle[], intervalMs: number): (CandlePoint | Gap)[] {
  const list = clean(candles);
  const step = Math.max(1, seconds(intervalMs));
  const out: (CandlePoint | Gap)[] = [];
  let missing = 0;
  list.forEach((c, i) => {
    const time = seconds(c.t);
    if (i > 0) {
      for (let g = seconds(list[i - 1].t) + step; g < time && missing < MAX_GAP_POINTS; g += step, missing++) out.push({ time: g });
    }
    // The high and low always hold the open and close, whatever the data says: a candle drawn with the body outside its wicks looks like a bug.
    out.push({ time, open: c.o, high: Math.max(c.h, c.o, c.c), low: Math.min(c.l, c.o, c.c), close: c.c });
  });
  return out;
}

/** Volume bars for a histogram under the candles: QU that changed hands, coloured by whether the candle closed up or down. */
export function volumeData(candles: TradeCandle[], up: string, down: string): VolumePoint[] {
  return clean(candles).map((c) => ({ time: seconds(c.t), value: Number.isFinite(c.volumeQu) && c.volumeQu > 0 ? c.volumeQu : 0, color: c.c >= c.o ? up : down }));
}

/** The price over time as a line: only samples that have a price, in order, one per second. */
export function lineData(points: Sample[]): LinePoint[] {
  const by = new Map<number, number>();
  for (const p of points) if (valid(p.t) && valid(p.price) && p.price > 0) by.set(seconds(p.t), p.price);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

/** A price for the axis and the legend: whole numbers with separators when big, more places when small. */
export function axisPrice(p: number): string {
  if (!Number.isFinite(p)) return "";
  const a = Math.abs(p);
  if (a >= 1e12) return `${(p / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(p / 1e9).toFixed(2)}B`;
  if (a >= 1e7) return `${(p / 1e6).toFixed(2)}M`;
  if (a >= 100) return Math.round(p).toLocaleString("en-US");
  if (a >= 1) return p.toFixed(2);
  return p.toPrecision(3);
}

/** Volume for the legend: the same compact way as prices. */
export const axisVolume = (v: number): string => axisPrice(v);

/** The points of a computed series, as the chart wants them (only where it has a value), at the candles' times. */
const asLine = (times: number[], s: Series): LinePoint[] => {
  const out: LinePoint[] = [];
  s.forEach((v, i) => v !== null && Number.isFinite(v) && out.push({ time: times[i], value: v }));
  return out;
};

/**
 * One indicator over these candles, as named lines: `sma20` has one, `bb` has `mid`, `upper` and `lower`, `macd` has `macd`, `signal` and
 * `histogram`. Worked out on the candles that exist (see src/indicators.ts), at those candles' own times.
 */
export function indicatorData(candles: TradeCandle[], id: IndicatorId): Record<string, LinePoint[]> {
  const list = clean(candles);
  const times = list.map((c) => seconds(c.t));
  const closes = list.map((c) => c.c);
  switch (id) {
    case "sma20": return { line: asLine(times, sma(closes, 20)) };
    case "sma50": return { line: asLine(times, sma(closes, 50)) };
    case "ema21": return { line: asLine(times, ema(closes, 21)) };
    case "bb": {
      const b = bollinger(closes, 20, 2);
      return { mid: asLine(times, b.mid), upper: asLine(times, b.upper), lower: asLine(times, b.lower) };
    }
    case "vwap": return { line: asLine(times, vwap(list)) };
    case "rsi": return { line: asLine(times, rsi(closes, 14)) };
    case "macd": {
      const m = macd(closes, 12, 26, 9);
      return { macd: asLine(times, m.macd), signal: asLine(times, m.signal), histogram: asLine(times, m.histogram) };
    }
    case "stoch": {
      const s = stochastic(list, 14, 3, 3);
      return { k: asLine(times, s.k), d: asLine(times, s.d) };
    }
    case "atr": return { line: asLine(times, atr(list, 14)) };
    case "obv": return { line: asLine(times, obv(list)) };
  }
}

/**
 * Heikin-Ashi candles: each candle is built from the averages of the one before, which smooths the noise so a trend is easier to see. Same
 * times as the candles it comes from; the real prices are not these (the legend still reads out the real candle).
 */
export function heikinAshi(candles: TradeCandle[]): TradeCandle[] {
  const list = clean(candles);
  const out: TradeCandle[] = [];
  list.forEach((c, i) => {
    const close = (c.o + c.h + c.l + c.c) / 4;
    const open = i === 0 ? (c.o + c.c) / 2 : (out[i - 1].o + out[i - 1].c) / 2;
    out.push({ ...c, o: open, c: close, h: Math.max(c.h, open, close), l: Math.min(c.l, open, close) });
  });
  return out;
}

/** The candles' closes as a line (for an area chart), at the candles' own times. */
export function closeLine(candles: TradeCandle[]): LinePoint[] {
  return clean(candles).map((c) => ({ time: seconds(c.t), value: c.c }));
}

/**
 * A quiet market has candles only for the hours in which something traded, so a 20-candle average of it can span days and a short range has
 * almost nothing to work on. This carries the last price through every empty candle (open, high, low and close all the last close, no volume, no
 * trades) up to `untilMs`, which is how a market with no trades is usually shown: the price did not change because nothing traded. The result is
 * an unbroken series of equal steps for the indicators to work on. Returns the candles as they were if filling would be more than `cap` candles.
 */
export function fillQuietCandles(candles: TradeCandle[], intervalMs: number, untilMs: number, cap = 20_000): TradeCandle[] {
  const list = clean(candles);
  if (!list.length || !(intervalMs > 0)) return candles;
  const last = list[list.length - 1].t;
  const end = Math.max(last, Math.floor(untilMs / intervalMs) * intervalMs);
  if ((end - list[0].t) / intervalMs + 1 > cap) return candles;
  const out: TradeCandle[] = [];
  let next = list[0].t;
  for (const c of list) {
    for (let t = next; t < c.t; t += intervalMs) out.push({ t, o: out.length ? out[out.length - 1].c : c.o, h: 0, l: 0, c: 0, volumeQu: 0, volumeQty: 0, trades: 0 });
    // (the flat candles are given their price below, from the candle before them)
    out.push(c);
    next = c.t + intervalMs;
  }
  for (let t = next; t <= end; t += intervalMs) out.push({ t, o: 0, h: 0, l: 0, c: 0, volumeQu: 0, volumeQty: 0, trades: 0 });
  // One pass to set each empty candle to the close before it.
  let price = list[0].o;
  return out.map((c) => {
    if (c.trades > 0 || c.volumeQu > 0) {
      price = c.c;
      return c;
    }
    return { ...c, o: price, h: price, l: price, c: price };
  });
}
