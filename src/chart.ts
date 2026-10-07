import type { BookRow, QxBook } from "./book.ts";

/** Charts are drawn as SVG text from plain numbers, so the website can show them inline and the Discord bot can turn them into a picture. */

/** Colours (and the font) a chart is drawn with. The website passes its own so charts follow the light and dark themes; the Discord picture uses the defaults. */
export interface Palette {
  /** "none" leaves the background transparent. */
  bg: string;
  grid: string;
  text: string;
  strong: string;
  up: string;
  down: string;
  accent: string;
  font: string;
}
export const C: Palette = { bg: "#0f1226", grid: "#2a2f55", text: "#9a9fc0", strong: "#f2f3fb", up: "#4ade80", down: "#f87171", accent: "#6ee7ff", font: "Helvetica, Arial, sans-serif" };

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 8.75B, 400.1M, 12.3K, 123, 12.34, 0.3124: short enough for an axis. */
export function compactNumber(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(x / 1e3).toFixed(1)}K`;
  if (a >= 100) return x.toFixed(0);
  if (a >= 1) return x.toFixed(2);
  if (a === 0) return "0";
  return x.toPrecision(3);
}

const two = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A short time label: the clock for a day or less, the date for longer. UTC, so every viewer sees the same chart. */
export function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  return spanMs <= 36 * 3_600_000 ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export const frame = (P: Palette, w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><rect width="${w}" height="${h}" rx="12" fill="${P.bg}"/>${body}</svg>`;

export const message = (P: Palette, w: number, h: number, title: string, line: string) =>
  frame(P, w, h, `<text x="${w / 2}" y="${h / 2 - 8}" text-anchor="middle" ${fontAttr(P)} font-size="16" fill="${P.strong}">${esc(title)}</text><text x="${w / 2}" y="${h / 2 + 16}" text-anchor="middle" ${fontAttr(P)} font-size="13" fill="${P.text}">${esc(line)}</text>`);

export const fontAttr = (P: Palette) => `font-family="${P.font}"`;

export interface PricePoint {
  t: number;
  price: number | null;
}

/** A price line over time, with a title that shows the latest price and the change over the range. */
export function priceChartSvg(points: PricePoint[], o: { symbol: string; rangeLabel: string; width?: number; height?: number; palette?: Partial<Palette> }): string {
  const P: Palette = { ...C, ...o.palette };
  const w = o.width ?? 640;
  const h = o.height ?? 300;
  const pts = points.filter((p): p is { t: number; price: number } => p.price !== null && Number.isFinite(p.price));
  if (pts.length < 2)
    return message(P, w, h, `${o.symbol} price history`, pts.length ? "QMax has only just started recording this asset. Check back soon." : "No price history recorded for this asset yet.");

  const L = 66, R = 16, T = 44, B = 30;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  let lo = Math.min(...pts.map((p) => p.price));
  let hi = Math.max(...pts.map((p) => p.price));
  if (hi === lo) {
    lo *= 0.99;
    hi *= 1.01;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (w - L - R);
  const y = (p: number) => T + (1 - (p - lo) / (hi - lo)) * (h - T - B);

  const first = pts[0].price;
  const last = pts[pts.length - 1].price;
  const change = ((last - first) / first) * 100;
  const colour = last >= first ? P.up : P.down;

  let grid = "";
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    grid += `<line x1="${L}" x2="${w - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${P.grid}" stroke-width="1"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(compactNumber(v))}</text>`;
  }
  let xs = "";
  for (let k = 0; k < 4; k++) {
    const t = t0 + ((t1 - t0) * k) / 3;
    xs += `<text x="${x(t).toFixed(1)}" y="${h - 9}" text-anchor="${k === 0 ? "start" : k === 3 ? "end" : "middle"}" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(timeLabel(t, t1 - t0))}</text>`;
  }
  const line = pts.map((p, k) => `${k ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.price).toFixed(1)}`).join(" ");
  const area = `${line} L${x(t1).toFixed(1)} ${h - B} L${x(t0).toFixed(1)} ${h - B} Z`;
  return frame(
    P,
    w,
    h,
    `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colour}" stop-opacity="0.28"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></linearGradient></defs>` +
      `<text x="${L}" y="26" ${fontAttr(P)} font-size="16" font-weight="bold" fill="${P.strong}">${esc(o.symbol)}  ${esc(compactNumber(last))} QU</text>` +
      `<text x="${w - R}" y="26" text-anchor="end" ${fontAttr(P)} font-size="13" fill="${colour}">${change >= 0 ? "+" : ""}${change.toFixed(2)}% · ${esc(o.rangeLabel)}</text>` +
      grid + xs +
      `<path d="${area}" fill="url(#fill)"/><path d="${line}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"/>` +
      `<circle cx="${x(t1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" fill="${colour}"/>`,
  );
}

/** Cumulative size at each price, bids to the left and asks to the right, from the QX order book. */
export function depthChartSvg(book: QxBook, o: { symbol: string; width?: number; height?: number; palette?: Partial<Palette> }): string {
  const P: Palette = { ...C, ...o.palette };
  const w = o.width ?? 640;
  const h = o.height ?? 300;
  if (!book.asks.length && !book.bids.length) return message(P, w, h, `${o.symbol} depth`, "There are no orders on the QX book.");

  const L = 66, R = 16, T = 44, B = 30;
  const prices = [...book.asks, ...book.bids].map((r) => r.price);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const span = pMax - pMin || pMax * 0.02 || 1;
  const lo = pMin - span * 0.04;
  const hi = pMax + span * 0.04;
  const maxQty = Math.max(book.asks.at(-1)?.cumQty ?? 0, book.bids.at(-1)?.cumQty ?? 0) || 1;
  const x = (p: number) => L + ((p - lo) / (hi - lo)) * (w - L - R);
  const y = (q: number) => T + (1 - q / maxQty) * (h - T - B);

  /** A staircase from the best price outward. */
  const steps = (rows: BookRow[], edge: number) => {
    if (!rows.length) return "";
    let d = `M${x(rows[0].price).toFixed(1)} ${y(0).toFixed(1)}`;
    rows.forEach((r, k) => {
      d += ` L${x(r.price).toFixed(1)} ${y(k ? rows[k - 1].cumQty : 0).toFixed(1)} L${x(r.price).toFixed(1)} ${y(r.cumQty).toFixed(1)}`;
    });
    const end = rows[rows.length - 1];
    d += ` L${x(edge).toFixed(1)} ${y(end.cumQty).toFixed(1)} L${x(edge).toFixed(1)} ${y(0).toFixed(1)} Z`;
    return d;
  };
  let grid = "";
  for (let k = 0; k <= 3; k++) {
    const q = (maxQty * k) / 3;
    grid += `<line x1="${L}" x2="${w - R}" y1="${y(q).toFixed(1)}" y2="${y(q).toFixed(1)}" stroke="${P.grid}" stroke-width="1"/><text x="${L - 8}" y="${(y(q) + 4).toFixed(1)}" text-anchor="end" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(compactNumber(q))}</text>`;
  }
  let xs = "";
  for (let k = 0; k < 4; k++) {
    const p = lo + ((hi - lo) * k) / 3;
    xs += `<text x="${x(p).toFixed(1)}" y="${h - 9}" text-anchor="${k === 0 ? "start" : k === 3 ? "end" : "middle"}" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(compactNumber(p))}</text>`;
  }
  const mid = book.mid !== null ? `<line x1="${x(book.mid).toFixed(1)}" x2="${x(book.mid).toFixed(1)}" y1="${T}" y2="${h - B}" stroke="${P.text}" stroke-dasharray="4 4" stroke-width="1"/>` : "";
  const spread = book.spreadPct !== null ? `spread ${book.spreadPct.toFixed(2)}%` : "one-sided book";
  return frame(
    P,
    w,
    h,
    `<text x="${L}" y="26" ${fontAttr(P)} font-size="16" font-weight="bold" fill="${P.strong}">${esc(o.symbol)} order book depth</text>` +
      `<text x="${w - R}" y="26" text-anchor="end" ${fontAttr(P)} font-size="13" fill="${P.text}">${esc(spread)}</text>` +
      grid + xs + mid +
      (book.bids.length ? `<path d="${steps(book.bids, lo)}" fill="${P.up}" fill-opacity="0.25" stroke="${P.up}" stroke-width="1.5"/>` : "") +
      (book.asks.length ? `<path d="${steps(book.asks, hi)}" fill="${P.down}" fill-opacity="0.25" stroke="${P.down}" stroke-width="1.5"/>` : ""),
  );
}

/** One candle as the chart needs it. `TradeCandle` from the trade index fits. */
export interface CandleBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volumeQu: number;
}

/**
 * Candlesticks of real trades with a volume panel underneath. Time runs left to right at a fixed scale, so a stretch with no
 * trades is left empty rather than squeezed away. Green is a candle that closed above where it opened, red below; the volume
 * bar takes its candle's colour.
 */
export function candleChartSvg(bars: CandleBar[], o: { symbol: string; rangeLabel: string; intervalMs: number; width?: number; height?: number; palette?: Partial<Palette> }): string {
  const P: Palette = { ...C, ...o.palette };
  const w = o.width ?? 640;
  const h = o.height ?? 340;
  if (!bars.length) return message(P, w, h, `${o.symbol} trades`, "No trades in this range.");

  const L = 66, R = 16, T = 44, B = 30;
  const gap = 10;
  const plotH = h - T - B;
  const volH = Math.round(plotH * 0.22);
  const priceH = plotH - volH - gap;
  const plotW = w - L - R;
  const t0 = bars[0].t;
  const t1 = bars[bars.length - 1].t + o.intervalMs;
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * plotW;

  let lo = Math.min(...bars.map((b) => b.l));
  let hi = Math.max(...bars.map((b) => b.h));
  if (hi === lo) {
    lo *= 0.99;
    hi *= 1.01;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const y = (p: number) => T + (1 - (p - lo) / (hi - lo)) * priceH;
  const volMax = Math.max(...bars.map((b) => b.volumeQu)) || 1;
  const volBottom = T + plotH;
  const vy = (v: number) => volBottom - (v / volMax) * volH;

  let grid = "";
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    grid += `<line x1="${L}" x2="${w - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${P.grid}" stroke-width="1"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(compactNumber(v))}</text>`;
  }
  let xs = "";
  for (let k = 0; k < 4; k++) {
    const t = t0 + ((t1 - t0) * k) / 3;
    xs += `<text x="${x(t).toFixed(1)}" y="${h - 9}" text-anchor="${k === 0 ? "start" : k === 3 ? "end" : "middle"}" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(timeLabel(t, t1 - t0))}</text>`;
  }

  const slot = (plotW * o.intervalMs) / (t1 - t0 || 1);
  const bodyW = Math.max(1, Math.min(18, slot * 0.7));
  let sticks = "";
  let volume = "";
  for (const b of bars) {
    const cx = x(b.t + o.intervalMs / 2);
    const colour = b.c >= b.o ? P.up : P.down;
    const top = y(Math.max(b.o, b.c));
    const bottom = y(Math.min(b.o, b.c));
    sticks +=
      `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke="${colour}" stroke-width="1"/>` +
      `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, bottom - top).toFixed(1)}" fill="${colour}"/>`;
    volume += `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${vy(b.volumeQu).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, volBottom - vy(b.volumeQu)).toFixed(1)}" fill="${colour}" fill-opacity="0.45"/>`;
  }

  const first = bars[0];
  const last = bars[bars.length - 1];
  const change = ((last.c - first.o) / first.o) * 100;
  const total = bars.reduce((a, b) => a + b.volumeQu, 0);
  return frame(
    P,
    w,
    h,
    `<text x="${L}" y="26" ${fontAttr(P)} font-size="16" font-weight="bold" fill="${P.strong}">${esc(o.symbol)}  ${esc(compactNumber(last.c))} QU</text>` +
      `<text x="${w - R}" y="26" text-anchor="end" ${fontAttr(P)} font-size="13" fill="${change >= 0 ? P.up : P.down}">${change >= 0 ? "+" : ""}${change.toFixed(2)}% · ${esc(o.rangeLabel)}</text>` +
      grid + xs + sticks +
      `<line x1="${L}" x2="${w - R}" y1="${volBottom}" y2="${volBottom}" stroke="${P.grid}" stroke-width="1"/>` +
      volume +
      `<text x="${L + 4}" y="${(volBottom - volH + 11).toFixed(1)}" ${fontAttr(P)} font-size="10" fill="${P.text}">Volume ${esc(compactNumber(total))} QU</text>`,
  );
}
