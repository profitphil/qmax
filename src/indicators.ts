import type { TradeCandle } from "./trades.ts";

/**
 * Chart indicators, worked out from QMax's own trade candles. Pure functions (no chart library), tested in Node.
 *
 * TradingView's Lightweight Charts draws what it is given and has no indicators of its own, so these are QMax's. The candles are only the
 * hours in which something traded, so every "period" counts candles that exist, not clock time: a 20-candle average of a quiet market spans more
 * than 20 hours. That is how a market with gaps is normally read, and the chart says so.
 *
 * Every function returns one entry per input, `null` where the indicator is not defined yet (too few candles before it).
 */

export type Series = (number | null)[];

/** Simple moving average of the last `period` values. */
export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, started from the simple average of the first `period` values (the usual way, and what makes it repeatable). */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface Bands {
  mid: Series;
  upper: Series;
  lower: Series;
}

/** Bollinger Bands: the simple average, and `mult` standard deviations (of the same window, population form) above and below it. */
export function bollinger(values: number[], period = 20, mult = 2): Bands {
  const mid = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i];
    if (m === null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - m) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

/** Relative strength index (Wilder's smoothing): 0 to 100, over 70 is usually read as stretched up, under 30 as stretched down. */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const at = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = at(gain, loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = at(gain, loss);
  }
  return out;
}

export interface Macd {
  macd: Series;
  signal: Series;
  histogram: Series;
}

/** MACD: the fast average minus the slow one, its own average (the signal line), and the gap between them. */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = values.map((_, i) => (f[i] === null || s[i] === null ? null : f[i]! - s[i]!));
  const first = line.findIndex((v) => v !== null);
  const signal: Series = new Array(values.length).fill(null);
  if (first >= 0) {
    const tail = ema(line.slice(first) as number[], signalPeriod);
    tail.forEach((v, i) => (signal[first + i] = v));
  }
  return { macd: line, signal, histogram: line.map((v, i) => (v === null || signal[i] === null ? null : v - signal[i]!)) };
}

type Bar = Pick<TradeCandle, "h" | "l" | "c">;

/** Stochastic oscillator (slow): where the close sits inside the last `period` candles' range, 0 to 100, smoothed once (%K) and again (%D). */
export function stochastic(bars: Bar[], period = 14, smoothK = 3, smoothD = 3): { k: Series; d: Series } {
  const raw: Series = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].h);
      lo = Math.min(lo, bars[j].l);
    }
    raw[i] = hi === lo ? 50 : ((bars[i].c - lo) / (hi - lo)) * 100;
  }
  const smooth = (s: Series, n: number): Series => {
    const first = s.findIndex((v) => v !== null);
    const out: Series = new Array(s.length).fill(null);
    if (first < 0) return out;
    sma(s.slice(first) as number[], n).forEach((v, i) => (out[first + i] = v));
    return out;
  };
  const k = smooth(raw, smoothK);
  return { k, d: smooth(k, smoothD) };
}

/** Average true range (Wilder's smoothing): how far a candle typically moves, in QU. A bigger number is a more restless market. */
export function atr(bars: Bar[], period = 14): Series {
  const out: Series = new Array(bars.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || bars.length < period) return out;
  const tr = bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** On-balance volume: the running total of units traded, added on a candle that closed up and taken off on one that closed down. */
export function obv(bars: Pick<TradeCandle, "c" | "volumeQty">[]): Series {
  let total = 0;
  return bars.map((b, i) => {
    if (i > 0 && Number.isFinite(b.volumeQty)) total += b.c > bars[i - 1].c ? b.volumeQty : b.c < bars[i - 1].c ? -b.volumeQty : 0;
    return total;
  });
}

/**
 * Volume-weighted average price from the first candle shown: everything that changed hands (QU) divided by every unit that did, which is the
 * exact average price paid so far, not an estimate from each candle's high, low and close.
 */
export function vwap(candles: Pick<TradeCandle, "volumeQu" | "volumeQty">[]): Series {
  let qu = 0;
  let qty = 0;
  return candles.map((c) => {
    if (Number.isFinite(c.volumeQu) && Number.isFinite(c.volumeQty) && c.volumeQty > 0 && c.volumeQu >= 0) {
      qu += c.volumeQu;
      qty += c.volumeQty;
    }
    return qty > 0 ? qu / qty : null;
  });
}

/** The indicators the chart offers. */
export const INDICATORS = [
  { id: "sma20", label: "SMA 20", kind: "overlay", need: 20, hint: "Simple moving average of the last 20 candles' closes" },
  { id: "sma50", label: "SMA 50", kind: "overlay", need: 50, hint: "Simple moving average of the last 50 candles' closes" },
  { id: "ema21", label: "EMA 21", kind: "overlay", need: 21, hint: "Exponential moving average of the closes: reacts faster than SMA" },
  { id: "bb", label: "Bollinger", kind: "overlay", need: 20, hint: "Bollinger Bands: 20-candle average, plus and minus two standard deviations" },
  { id: "vwap", label: "VWAP", kind: "overlay", need: 1, hint: "Volume-weighted average price from the first candle shown" },
  { id: "rsi", label: "RSI 14", kind: "pane", need: 15, hint: "Relative strength index (14): over 70 is stretched up, under 30 stretched down" },
  { id: "macd", label: "MACD", kind: "pane", need: 34, hint: "MACD (12, 26, 9): fast average minus slow, its signal line and their gap" },
  { id: "stoch", label: "Stochastic", kind: "pane", need: 18, hint: "Slow stochastic (14, 3, 3): where the close sits in the recent range, 0 to 100. Over 80 is stretched up, under 20 stretched down" },
  { id: "atr", label: "ATR 14", kind: "pane", need: 14, hint: "Average true range (14): how far a candle typically moves, in QU" },
  { id: "obv", label: "OBV", kind: "pane", need: 2, hint: "On-balance volume: units traded, added on up candles and taken off on down candles" },
] as const;
export type IndicatorId = (typeof INDICATORS)[number]["id"];
export const isIndicatorId = (v: unknown): v is IndicatorId => INDICATORS.some((i) => i.id === v);

/** How many candles an indicator needs before it shows anything. */
export const candlesNeeded = (id: IndicatorId): number => INDICATORS.find((i) => i.id === id)!.need;
