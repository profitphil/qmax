import { C, compactNumber, esc, fontAttr, frame, message, timeLabel } from "./chart.ts";
import type { Palette } from "./chart.ts";
import type { BacktestTrade, EquityPoint } from "./backtest.ts";

/** The colours of the two lines: the strategy takes the accent, buying and holding the violet. Buys and sells take the palette's up and down colours. */
export type EquityPalette = Palette & { violet: string };
const DEFAULT_VIOLET = "#a78bfa";

/** The curve as the chart needs it. `EquityPoint` from a backtest fits. */
export type EquityBar = Pick<EquityPoint, "t" | "valueQu" | "holdValueQu">;

/** More trades than this and the markers would hide the lines, so they are left out. */
export const MAX_MARKERS = 60;
/** Lines are drawn from at most this many points; a run has one per hour, far more than a screen has pixels. */
const MAX_DRAWN = 600;

const finite = (p: EquityBar) => Number.isFinite(p.t) && Number.isFinite(p.valueQu) && Number.isFinite(p.holdValueQu);

/** Keeps the last point in each slice of time, and the first and last points, so a long run draws as fast as a short one. */
function thin(points: EquityBar[], max: number): EquityBar[] {
  if (points.length <= max) return points;
  const t0 = points[0].t;
  const spanMs = points[points.length - 1].t - t0 || 1;
  const slices = new Map<number, EquityBar>();
  for (const p of points) slices.set(Math.min(max - 1, Math.floor(((p.t - t0) / spanMs) * max)), p);
  const out = [...slices.values()];
  if (out[0].t !== points[0].t) out.unshift(points[0]);
  return out;
}

/**
 * The value of the strategy against the value of buying and holding, over time, with a small triangle at each trade when there are not too many
 * (an up triangle under the line for a buy, a down triangle above it for a sell). The value only changes when something trades, so each line is
 * a staircase: it holds its last value until the next hour with trades. A dashed line marks the starting value.
 */
export function equityChartSvg(
  equity: EquityBar[],
  o: { symbol: string; rangeLabel?: string; trades?: Pick<BacktestTrade, "t" | "side">[]; width?: number; height?: number; palette?: Partial<EquityPalette> },
): string {
  const P: EquityPalette = { ...C, violet: DEFAULT_VIOLET, ...o.palette };
  const w = o.width ?? 640;
  const h = o.height ?? 300;
  const all = equity.filter(finite);
  if (!all.length) return message(P, w, h, `${o.symbol} backtest`, "No trades in this range, so there is nothing to draw.");
  if (all.length < 2 || all[all.length - 1].t === all[0].t) return message(P, w, h, `${o.symbol} backtest`, "Only one hour of data: too little to draw a line.");

  // on a narrow screen the two legend entries do not fit side by side, so they stack and the plot starts lower
  const narrow = w < 480;
  const L = narrow ? 58 : 66, R = 16, T = narrow ? 68 : 50, B = 30;
  const t0 = all[0].t;
  const t1 = all[all.length - 1].t;
  const start = all[0].valueQu;
  const values = all.flatMap((p) => [p.valueQu, p.holdValueQu]);
  let lo = Math.min(...values, start);
  let hi = Math.max(...values, start);
  if (hi === lo) {
    lo *= 0.99;
    hi *= 1.01;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (w - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);

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

  const drawn = thin(all, MAX_DRAWN);
  /** A staircase through the points: flat until the next one, then straight up or down. */
  const stairs = (pick: (p: EquityBar) => number) =>
    drawn.map((p, k) => (k ? `L${x(p.t).toFixed(1)} ${y(pick(drawn[k - 1])).toFixed(1)} L${x(p.t).toFixed(1)} ${y(pick(p)).toFixed(1)}` : `M${x(p.t).toFixed(1)} ${y(pick(p)).toFixed(1)}`)).join(" ");

  const trades = o.trades ?? [];
  let markers = "";
  if (trades.length && trades.length <= MAX_MARKERS) {
    const at = new Map(all.map((p) => [p.t, p.valueQu]));
    for (const tr of trades) {
      const v = at.get(tr.t);
      if (v === undefined) continue;
      const cx = x(tr.t);
      const cy = y(v);
      markers +=
        tr.side === "buy"
          ? `<path d="M${cx.toFixed(1)} ${(cy + 4).toFixed(1)} L${(cx - 4).toFixed(1)} ${(cy + 11).toFixed(1)} L${(cx + 4).toFixed(1)} ${(cy + 11).toFixed(1)} Z" fill="${P.up}"/>`
          : `<path d="M${cx.toFixed(1)} ${(cy - 4).toFixed(1)} L${(cx - 4).toFixed(1)} ${(cy - 11).toFixed(1)} L${(cx + 4).toFixed(1)} ${(cy - 11).toFixed(1)} Z" fill="${P.down}"/>`;
    }
  }

  const last = all[all.length - 1];
  const pct = (v: number) => (start > 0 ? ((v / start - 1) * 100) : 0);
  const sign = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const hiddenNote = trades.length > MAX_MARKERS ? `${trades.length} trades (markers hidden)` : "";
  return frame(
    P,
    w,
    h,
    `<title>${esc(o.symbol)}: value of the strategy against buying and holding${o.rangeLabel ? `, ${esc(o.rangeLabel)}` : ""}</title>` +
      `<text x="${L}" y="22" ${fontAttr(P)} font-size="${narrow ? 14 : 15}" font-weight="bold" fill="${P.strong}">${esc(o.symbol)} strategy vs buy and hold</text>` +
      `<line x1="${L}" x2="${L + 18}" y1="38" y2="38" stroke="${P.accent}" stroke-width="2.5"/><text x="${L + 24}" y="42" ${fontAttr(P)} font-size="12" fill="${P.text}">Strategy ${esc(sign(pct(last.valueQu)))}</text>` +
      `<line x1="${narrow ? L : L + 150}" x2="${narrow ? L + 18 : L + 168}" y1="${narrow ? 55 : 38}" y2="${narrow ? 55 : 38}" stroke="${P.violet}" stroke-width="2.5"/><text x="${narrow ? L + 24 : L + 174}" y="${narrow ? 59 : 42}" ${fontAttr(P)} font-size="12" fill="${P.text}">Buy and hold ${esc(sign(pct(last.holdValueQu)))}</text>` +
      (hiddenNote ? `<text x="${w - R}" y="${narrow ? 59 : 42}" text-anchor="end" ${fontAttr(P)} font-size="11" fill="${P.text}">${esc(hiddenNote)}</text>` : "") +
      grid + xs +
      `<line x1="${L}" x2="${w - R}" y1="${y(start).toFixed(1)}" y2="${y(start).toFixed(1)}" stroke="${P.text}" stroke-width="1" stroke-dasharray="4 4" opacity="0.6"/>` +
      `<path d="${stairs((p) => p.holdValueQu)}" fill="none" stroke="${P.violet}" stroke-width="2" stroke-linejoin="round"/>` +
      `<path d="${stairs((p) => p.valueQu)}" fill="none" stroke="${P.accent}" stroke-width="2.25" stroke-linejoin="round"/>` +
      markers,
  );
}
