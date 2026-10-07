import { C, compactNumber, esc, fontAttr, frame, message, timeLabel } from "./chart.ts";
import type { Palette } from "./chart.ts";
import type { PremiumBar } from "./premium.ts";

/**
 * The QX-versus-QSwap chart, drawn as SVG text like the other charts so the website can embed it and the bot can turn it into
 * a picture. Two panels share one time axis: the two prices on top, and underneath the premium (QSwap over QX, in percent) as
 * bars around a zero line with the "no profit after fees" band shaded.
 */

/** The chart palette plus the colour of the second venue. QX is `accent`; QSwap is violet, one that reads on both themes. */
export interface PremiumPalette extends Palette {
  violet: string;
}
export const PREMIUM_PALETTE: PremiumPalette = { ...C, violet: "#8f86ff" };

export interface PremiumChartOptions {
  symbol: string;
  rangeLabel: string;
  /** Width of one bar in ms, as the API reports it (`barMs`): sets the bar width and where a line may be joined across a gap. */
  barMs: number;
  /** Premium (percent, as magnitudes) a round trip needs before it pays, per direction. Without it no band is drawn. */
  breakEvenPct?: { qswapDearer: number; qxDearer: number };
  width?: number;
  height?: number;
  palette?: Partial<PremiumPalette>;
}

/** A line is only joined across a gap of up to this many bars; beyond that the venues simply were not both trading and the line breaks. */
const JOIN_BARS = 3;
/** With this many bars or fewer every point gets a dot, so a sparse token's chart is readable. */
const DOT_BARS = 60;
/**
 * A price more than this many times above or below the median price is drawn at the edge of the price panel instead of
 * stretching the scale. It does happen for real (QMINE swapped at ten times its market price in one hour in October 2026,
 * 1.6 billion QU of it) and one such hour would otherwise flatten every other price in the range into a line.
 */
const OUTLIER_X = 4;

const usable = (b: PremiumBar) => [b.t, b.qx, b.qswap, b.premiumPct, b.minPct, b.maxPct].every(Number.isFinite) && b.qx > 0 && b.qswap > 0;
/** Coordinates and labels can never print NaN or Infinity, whatever comes in. */
const f1 = (v: number) => (Number.isFinite(v) ? v : 0).toFixed(1);
const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

export function premiumChartSvg(points: PremiumBar[], o: PremiumChartOptions): string {
  const P: PremiumPalette = { ...PREMIUM_PALETTE, ...o.palette };
  const w = o.width ?? 640;
  const h = o.height ?? 380;
  const title = `${o.symbol} on QX and QSwap`;
  const bars = points.filter(usable).sort((a, b) => a.t - b.t);
  if (bars.length < 2)
    return message(P, w, h, title, bars.length ? "Only one stretch with trades on both markets in this range." : "No hour in this range had trades on both markets.");

  const narrow = w < 480;
  const L = narrow ? 52 : 66, R = 16, T = 58, B = 30;
  const gap = 20;
  const plotH = h - T - B;
  const priceH = Math.round(plotH * 0.55);
  const premH = plotH - priceH - gap;
  const plotW = w - L - R;
  const t0 = bars[0].t;
  const t1 = bars[bars.length - 1].t + o.barMs;
  const span = t1 - t0 || 1;
  const x = (t: number) => L + ((t - t0) / span) * plotW;

  // ---- top panel: the two prices
  const prices = bars.flatMap((b) => [b.qx, b.qswap]);
  const mid = quantile(prices, 0.5);
  const inScale = (p: number) => p <= mid * OUTLIER_X && p >= mid / OUTLIER_X;
  const kept = prices.filter(inScale);
  let lo = Math.min(...kept);
  let hi = Math.max(...kept);
  if (hi === lo) {
    lo *= 0.99;
    hi *= 1.01;
  }
  const pad = (hi - lo) * 0.08;
  lo = Math.max(lo - pad, lo / 2);
  hi += pad;
  const py = (p: number) => T + (1 - (Math.max(lo, Math.min(hi, p)) - lo) / (hi - lo)) * priceH;
  let grid = "";
  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) * k) / 3;
    grid += `<line x1="${L}" x2="${w - R}" y1="${f1(py(v))}" y2="${f1(py(v))}" stroke="${P.grid}" stroke-width="1"/><text x="${L - 8}" y="${f1(py(v) + 4)}" text-anchor="end" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(compactNumber(v))}</text>`;
  }

  /** A small triangle at the panel's edge for a value that is past the scale. */
  const marker = (cx: number, edge: number, dir: 1 | -1, colour: string) =>
    `<path d="M${f1(cx - 3)} ${f1(edge + dir * 5)} L${f1(cx + 3)} ${f1(edge + dir * 5)} L${f1(cx)} ${f1(edge)} Z" fill="${colour}"/>`;
  const offBars = new Set<PremiumBar>();
  let cuts = "";

  /** One venue's line, broken where the gap between bars is wider than JOIN_BARS. Lone points get a dot so they do not vanish. */
  const line = (pick: (b: PremiumBar) => number, colour: string) => {
    let d = "";
    let dots = "";
    bars.forEach((b, k) => {
      const joined = k > 0 && b.t - bars[k - 1].t <= JOIN_BARS * o.barMs;
      const cx = x(b.t + o.barMs / 2);
      d += `${joined ? "L" : "M"}${f1(cx)} ${f1(py(pick(b)))} `;
      if (!inScale(pick(b))) {
        offBars.add(b);
        cuts += marker(cx, pick(b) > mid ? T : T + priceH, pick(b) > mid ? 1 : -1, colour);
        return;
      }
      const alone = !joined && !(k < bars.length - 1 && bars[k + 1].t - b.t <= JOIN_BARS * o.barMs);
      if (alone || bars.length <= DOT_BARS || k === bars.length - 1) dots += `<circle cx="${f1(cx)}" cy="${f1(py(pick(b)))}" r="${k === bars.length - 1 ? 3 : 2}" fill="${colour}"/>`;
    });
    return `<path class="pline" d="${d.trim()}" fill="none" stroke="${colour}" stroke-width="1.75" stroke-linejoin="round"/>${dots}`;
  };

  const unit = `<text x="${L - 8}" y="${T - 8}" text-anchor="end" ${fontAttr(P)} font-size="10" fill="${P.text}">QU</text>`;
  const qxLine = line((b) => b.qx, P.accent);
  const swapLine = line((b) => b.qswap, P.violet);

  // ---- bottom panel: the premium
  const be = o.breakEvenPct && Number.isFinite(o.breakEvenPct.qswapDearer) && Number.isFinite(o.breakEvenPct.qxDearer) ? o.breakEvenPct : undefined;
  const bandUp = be ? Math.max(0, be.qswapDearer) : 0;
  const bandDown = be ? Math.max(0, be.qxDearer) : 0;
  const values = bars.map((b) => b.premiumPct);
  // The scale follows the 95th percentile of the gaps, not the biggest one: a single thin hour at +260% would otherwise flatten
  // everything else. Bars past the scale are cut at the edge and marked with a triangle.
  const cap = Math.max(quantile(values.map(Math.abs), 0.95) * 1.15, Math.max(bandUp, bandDown) * 1.5, 0.5);
  const top = Math.min(Math.max(0, ...values), cap);
  const bottom = Math.max(Math.min(0, ...values), -cap);
  let vHi = Math.max(top, bandUp * 1.25, cap * 0.25);
  let vLo = Math.min(bottom, -bandDown * 1.25, -cap * 0.25);
  vHi *= 1.06;
  vLo *= 1.06;
  const panelTop = T + priceH + gap;
  const panelBottom = panelTop + premH;
  const my = (v: number) => panelTop + (1 - (Math.max(vLo, Math.min(vHi, v)) - vLo) / (vHi - vLo)) * premH;
  const zero = my(0);

  const slot = (plotW * o.barMs) / span;
  const bodyW = Math.max(1, Math.min(18, slot * 0.7));
  let columns = "";
  let whiskers = "";
  for (const b of bars) {
    const cx = x(b.t + o.barMs / 2);
    const colour = b.premiumPct >= 0 ? P.violet : P.accent; // the dearer venue's colour
    const v = Math.max(vLo, Math.min(vHi, b.premiumPct));
    const y = my(v);
    columns += `<rect class="pbar" x="${f1(cx - bodyW / 2)}" y="${f1(Math.min(y, zero))}" width="${f1(bodyW)}" height="${f1(Math.max(1, Math.abs(y - zero)))}" fill="${colour}"${b.carriedHours > 0 ? ' fill-opacity="0.4"' : ""}/>`;
    if (b.hours > 1 && (b.maxPct > b.premiumPct || b.minPct < b.premiumPct)) whiskers += `<line x1="${f1(cx)}" x2="${f1(cx)}" y1="${f1(my(b.maxPct))}" y2="${f1(my(b.minPct))}" stroke="${P.text}" stroke-opacity="0.55" stroke-width="1"/>`;
    if (b.premiumPct > vHi || b.premiumPct < vLo) {
      offBars.add(b);
      cuts += marker(cx, b.premiumPct > vHi ? panelTop : panelBottom, b.premiumPct > vHi ? 1 : -1, colour);
    }
  }
  const band = be
    ? `<rect x="${L}" y="${f1(my(bandUp))}" width="${f1(plotW)}" height="${f1(Math.max(0, my(-bandDown) - my(bandUp)))}" fill="${P.text}" fill-opacity="0.1"/>` +
      `<line x1="${L}" x2="${w - R}" y1="${f1(my(bandUp))}" y2="${f1(my(bandUp))}" stroke="${P.text}" stroke-opacity="0.5" stroke-dasharray="3 3"/>` +
      `<line x1="${L}" x2="${w - R}" y1="${f1(my(-bandDown))}" y2="${f1(my(-bandDown))}" stroke="${P.text}" stroke-opacity="0.5" stroke-dasharray="3 3"/>`
    : "";
  const premAxis = [vHi, 0, vLo]
    .map((v) => `<text x="${L - 8}" y="${f1(my(v) + 4)}" text-anchor="end" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(v === 0 ? "0%" : pct(v))}</text>`)
    .join("");

  let xs = "";
  for (let k = 0; k < 4; k++) {
    const t = t0 + (span * k) / 3;
    xs += `<text x="${f1(x(t))}" y="${h - 9}" text-anchor="${k === 0 ? "start" : k === 3 ? "end" : "middle"}" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(timeLabel(t, span))}</text>`;
  }

  // ---- header: name and range, then a legend that drops what does not fit
  const last = bars[bars.length - 1];
  const latest = `Latest ${pct(last.premiumPct)}${offBars.size ? ` · ${offBars.size} off scale` : ""}`;
  const entries: { w: number; svg: (x0: number) => string }[] = [
    { w: 18 + 2 * 6.5 + 16, svg: (x0) => `<line x1="${f1(x0)}" x2="${f1(x0 + 12)}" y1="42" y2="42" stroke="${P.accent}" stroke-width="2.5"/><text x="${f1(x0 + 17)}" y="46" ${fontAttr(P)} font-size="12" fill="${P.text}">QX</text>` },
    { w: 18 + 5 * 6.5 + 16, svg: (x0) => `<line x1="${f1(x0)}" x2="${f1(x0 + 12)}" y1="42" y2="42" stroke="${P.violet}" stroke-width="2.5"/><text x="${f1(x0 + 17)}" y="46" ${fontAttr(P)} font-size="12" fill="${P.text}">QSwap</text>` },
  ];
  if (be) {
    const label = narrow ? "Break-even" : `No profit after fees: ${pct(-bandDown)} to ${pct(bandUp)}`;
    entries.push({ w: 18 + label.length * 6.2 + 16, svg: (x0) => `<rect x="${f1(x0)}" y="37" width="12" height="10" fill="${P.text}" fill-opacity="0.18" stroke="${P.text}" stroke-opacity="0.5" stroke-dasharray="3 3"/><text x="${f1(x0 + 17)}" y="46" ${fontAttr(P)} font-size="12" fill="${P.text}">${esc(label)}</text>` });
  }
  const latestW = narrow ? 0 : latest.length * 6.4;
  let cursor = L;
  let legend = "";
  for (const e of entries) {
    if (cursor + e.w > w - R - latestW) break;
    legend += e.svg(cursor);
    cursor += e.w;
  }
  const carriedAny = bars.some((b) => b.carriedHours > 0);
  // the caption above the premium panel gives way to a shorter one rather than run off the edge (10px text is about 5.4px a letter)
  const captions = [`Premium: QSwap price over QX price${carriedAny ? " (faded: used a carried-forward price)" : ""}`, `Premium${carriedAny ? " (faded: carried price)" : ""}`, "Premium"];
  const caption = captions.find((c) => c.length * 5.4 <= plotW - 8) ?? "Premium";
  return frame(
    P,
    w,
    h,
    `<text x="${L}" y="24" ${fontAttr(P)} font-size="16" font-weight="bold" fill="${P.strong}">${esc(o.symbol)}  QX vs QSwap</text>` +
      `<text x="${w - R}" y="24" text-anchor="end" ${fontAttr(P)} font-size="13" fill="${P.text}">${esc(o.rangeLabel)}</text>` +
      legend +
      (narrow ? "" : `<text x="${w - R}" y="46" text-anchor="end" ${fontAttr(P)} font-size="12" fill="${P.strong}">${esc(latest)}</text>`) +
      grid +
      unit +
      qxLine +
      swapLine +
      `<text x="${L + 4}" y="${f1(panelTop - 6)}" ${fontAttr(P)} font-size="10" fill="${P.text}">${esc(caption)}</text>` +
      band +
      `<line x1="${L}" x2="${w - R}" y1="${f1(panelTop)}" y2="${f1(panelTop)}" stroke="${P.grid}" stroke-width="1"/>` +
      `<line x1="${L}" x2="${w - R}" y1="${f1(panelBottom)}" y2="${f1(panelBottom)}" stroke="${P.grid}" stroke-width="1"/>` +
      columns +
      whiskers +
      `<line x1="${L}" x2="${w - R}" y1="${f1(zero)}" y2="${f1(zero)}" stroke="${P.text}" stroke-opacity="0.7" stroke-width="1"/>` +
      cuts +
      premAxis +
      xs,
  );
}
