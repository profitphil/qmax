import { MARKET_FEES } from "./arbitrage.ts";
import { RouteError, oneOf, plainNumber, required } from "./routes.ts";
import type { Route } from "./routes.ts";
import type { Hour, Venue } from "./trades.ts";

/**
 * How far apart the QX order book and the QSwap pool priced the same token, hour by hour, and how often that gap would have
 * paid after fees. Everything here is built from the trade index's hourly sums, so it is a picture of what people actually
 * paid, not of live quotes, and it is an INDICATION: see `premiumNote`.
 *
 * This file is shared with the website (it formats the summary there), so it must not import anything that needs Node.
 * That is why HOUR and DAY are repeated here instead of coming from history.ts, which reads files.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** What the premium needs from an hour of trades: when, QU that changed hands and units. `Hour` from the trade index fits. */
export type TradedHour = Pick<Hour, "hour" | "qu" | "qty">;

/* ---------- the cost of a round trip ---------- */

/**
 * A trade of 10,000,000 QU, about what a typical trade on these markets is: the median hourly average swap on QSwap for the
 * busiest tokens is 10 to 38 million QU, and the median QX fill 4 to 26 million (read from the real trade index in October
 * 2026). A smaller reference makes QSwap's flat fee look worse, a bigger one makes it vanish, so the size is always shown next
 * to the result and can be changed.
 */
export const DEFAULT_REFERENCE_QU = 10_000_000;

/** The fees of one buy-on-one-venue, sell-on-the-other round trip, as the live arbitrage search prices them. */
export interface CostModel {
  /** QU spent on the buying leg (its percentage fee included, the flat fees not). The size the break-even is worked out for. */
  referenceQu: number;
  /** QSwap's pool fee as a fraction (30 in base 10,000 is 0.003). Charged on whichever way a swap goes. */
  qswapFee: number;
  /** QX's trade fee as a fraction of what a seller receives (the buyer pays none). */
  qxSellerFee: number;
  /** Flat QU for the round trip: QSwap's 100,000 per-swap fee plus the 100 QU transfer fee at each venue. */
  flatQu: number;
}

/** Fee constants come from `MARKET_FEES` in arbitrage.ts, so this stays in step with the live arbitrage search. */
export function costModel(referenceQu: number = DEFAULT_REFERENCE_QU, fees: typeof MARKET_FEES = MARKET_FEES): CostModel {
  if (!Number.isFinite(referenceQu) || referenceQu <= 0) throw new RangeError("referenceQu must be a positive number of QU");
  return { referenceQu, qswapFee: fees.swapFeeRate / 10_000, qxSellerFee: fees.qxSellerRate, flatQu: fees.qswapFixedQu + fees.qxFixedQu };
}

/**
 * How big the premium (QSwap price over QX price, in percent) must be before a round trip of the reference size pays, one
 * threshold per direction because the fees differ. With r = QSwap price / QX price, N the QU spent buying, F the flat QU,
 * f QSwap's pool fee and s QX's seller fee:
 *   QSwap dearer: buy on QX (no fee), sell on QSwap (fee f):   N * r * (1 - f) - N - F > 0   so   r > (1 + F/N) / (1 - f)
 *   QX dearer:    buy on QSwap (fee f), sell on QX (fee s):    N * (1 - f) * (1 - s) / r - N - F > 0   so   r < (1 - f) * (1 - s) / (1 + F/N)
 * Both are returned as positive percentages. Selling on QX costs the extra 0.3%, so QX has to be dearer by more.
 * The hourly averages are treated as mid prices (they mix buyers and sellers), so the fees are charged on top of them.
 */
export function breakEven(m: CostModel): { qswapDearerPct: number; qxDearerPct: number } {
  const flat = 1 + m.flatQu / m.referenceQu;
  const up = flat / (1 - m.qswapFee);
  const down = ((1 - m.qswapFee) * (1 - m.qxSellerFee)) / flat;
  return { qswapDearerPct: (up - 1) * 100, qxDearerPct: (1 - down) * 100 };
}

/* ---------- the series ---------- */

/** One hour in which both venues have a price. */
export interface PremiumPoint {
  /** Start of the hour, ms since epoch (UTC). */
  t: number;
  /** Volume-weighted price in QU per unit on each venue (QU traded divided by units traded). */
  qx: number;
  qswap: number;
  /** (qswap - qx) / qx * 100. Positive means QSwap was dearer. */
  premiumPct: number;
  /** QU traded in that hour on each venue. 0 on a venue whose price was carried forward, because it did not trade. */
  qxQu: number;
  qswapQu: number;
  /** Set when one venue did not trade this hour and its last price was carried forward: which venue, and how many hours old. */
  carried?: { venue: Venue; hours: number };
}

export interface PremiumOptions {
  /** Only hours from this time on (ms, inclusive). */
  sinceMs?: number;
  /** Only hours up to this time (ms, inclusive). */
  untilMs?: number;
  /**
   * How many hours a venue's last price may be carried forward to meet a trade on the other venue. 0, the default, means both
   * venues must trade in the same clock hour. Clamped to 0 to MAX_CARRY_HOURS.
   *
   * Why the default is 0. Most tokens rarely trade on both venues in the same hour. In the real index of October 2026 (six
   * months, 17 token-issuer pairs on both venues) QDOGE had 665 such hours, GARTH 469, QMINE 230, WP 154, QCAP 94, CFB 46.
   * Carrying up to 3 hours roughly doubles those (QDOGE 1,375, QMINE 490, CFB 114) but the carried gaps are wider, because the
   * price moved while it was carried. The median absolute gap on same-hour data against carried hours 1 to 3 old: QDOGE 3.3%
   * against 4.2% to 4.7%, WP 3.3% against 4.6% to 6.5%, CODED 6.7% against 9.5% to 15.5%. That extra spread is the clock, not
   * arbitrage, and it would push up the share of "profitable" hours. So the default uses only same-hour data. Carrying is
   * available, always marked (`carried`), never looks ahead (a price is only carried forward in time, never back from a later
   * trade) and stops after MAX_CARRY_HOURS, for people who prefer more points to cleaner ones.
   */
  carryHours?: number;
}

/** The longest a price may be carried: past this the gap mostly measures how far the market moved, not how far apart the venues are. */
export const MAX_CARRY_HOURS = 3;

interface Priced {
  hour: number;
  price: number;
  qu: number;
}

/** Hours with a usable price, one per hour (duplicates are added together), oldest first. */
function priced(rows: TradedHour[]): Priced[] {
  const byHour = new Map<number, { qu: number; qty: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.hour) || !Number.isFinite(r.qu) || !Number.isFinite(r.qty) || r.qu <= 0 || r.qty <= 0) continue;
    const have = byHour.get(r.hour);
    if (have) {
      have.qu += r.qu;
      have.qty += r.qty;
    } else byHour.set(r.hour, { qu: r.qu, qty: r.qty });
  }
  return [...byHour].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, price: v.qu / v.qty, qu: v.qu }));
}

/**
 * Every hour where both venues have a price: the hour's volume-weighted price on each (an average, so a lone tiny trade does
 * not draw a spike, the same choice `TradeIndex.samples` makes) and the premium between them. Hours where only one venue
 * traded are left out unless `carryHours` lets the other venue's last price stand in (see PremiumOptions).
 */
export function premiumSeries(qxHours: TradedHour[], qswapHours: TradedHour[], opts: PremiumOptions = {}): PremiumPoint[] {
  const carry = Math.min(MAX_CARRY_HOURS, Math.max(0, Math.floor(Number.isFinite(opts.carryHours) ? opts.carryHours! : 0)));
  const qx = priced(qxHours);
  const sw = priced(qswapHours);
  const out: PremiumPoint[] = [];
  let i = 0;
  let j = 0;
  let lastQx: Priced | undefined;
  let lastSw: Priced | undefined;
  while (i < qx.length || j < sw.length) {
    const t = Math.min(qx[i]?.hour ?? Infinity, sw[j]?.hour ?? Infinity);
    const a = qx[i]?.hour === t ? qx[i++] : undefined;
    const b = sw[j]?.hour === t ? sw[j++] : undefined;
    const point = (qxPrice: number, swPrice: number, qxQu: number, swQu: number, carried?: PremiumPoint["carried"]): PremiumPoint => ({
      t,
      qx: qxPrice,
      qswap: swPrice,
      premiumPct: ((swPrice - qxPrice) / qxPrice) * 100,
      qxQu,
      qswapQu: swQu,
      ...(carried ? { carried } : {}),
    });
    // Only earlier hours are ever carried forward (lastQx and lastSw are updated after the hour is handled).
    if (a && b) out.push(point(a.price, b.price, a.qu, b.qu));
    else if (a && lastSw && t - lastSw.hour <= carry * HOUR) out.push(point(a.price, lastSw.price, a.qu, 0, { venue: "QSwap", hours: (t - lastSw.hour) / HOUR }));
    else if (b && lastQx && t - lastQx.hour <= carry * HOUR) out.push(point(lastQx.price, b.price, 0, b.qu, { venue: "QX", hours: (t - lastQx.hour) / HOUR }));
    if (a) lastQx = a;
    if (b) lastSw = b;
  }
  return out.filter((p) => p.t >= (opts.sinceMs ?? -Infinity) && p.t <= (opts.untilMs ?? Infinity));
}

/** A stretch of time shown as one point: the average of the hourly gaps in it, with the extremes. For one hour all three are the same. */
export interface PremiumBar {
  /** Start of the stretch, ms since epoch (UTC). */
  t: number;
  /** Mean of the hourly prices on each venue. */
  qx: number;
  qswap: number;
  /** Mean of the hourly premiums (positive: QSwap dearer). A plain mean, so a thin hour with a wild price pulls it; the range shows that. */
  premiumPct: number;
  /** Smallest and largest hourly premium in the stretch. */
  minPct: number;
  maxPct: number;
  /** Comparable hours folded into this bar, and how many of them used a carried-forward price. */
  hours: number;
  carriedHours: number;
}

/** Folds hourly points into bars `barMs` wide (a multiple of an hour, aligned to UTC). Stretches with no comparable hour get no bar. */
export function premiumBars(series: PremiumPoint[], barMs: number): PremiumBar[] {
  const width = Math.max(HOUR, barMs);
  const buckets = new Map<number, PremiumPoint[]>();
  for (const p of series) {
    const t = Math.floor(p.t / width) * width;
    const b = buckets.get(t);
    if (b) b.push(p);
    else buckets.set(t, [p]);
  }
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  return [...buckets]
    .sort((a, b) => a[0] - b[0])
    .map(([t, ps]) => {
      const gaps = ps.map((p) => p.premiumPct);
      return { t, qx: mean(ps.map((p) => p.qx)), qswap: mean(ps.map((p) => p.qswap)), premiumPct: mean(gaps), minPct: Math.min(...gaps), maxPct: Math.max(...gaps), hours: ps.length, carriedHours: ps.filter((p) => p.carried).length };
    });
}

/* ---------- ranges ---------- */

export const PREMIUM_RANGES = ["7d", "30d", "90d", "all"] as const;
export type PremiumRange = (typeof PREMIUM_RANGES)[number];

/** How far back a range reaches (null: everything) and how wide one bar is, giving roughly 40 to 210 bars. */
export const RANGE_SPEC: Record<PremiumRange, { spanMs: number | null; barMs: number; label: string }> = {
  "7d": { spanMs: 7 * DAY, barMs: HOUR, label: "7 days" },
  "30d": { spanMs: 30 * DAY, barMs: 4 * HOUR, label: "30 days" },
  "90d": { spanMs: 90 * DAY, barMs: DAY, label: "90 days" },
  all: { spanMs: null, barMs: DAY, label: "the whole history" },
};

/* ---------- the summary ---------- */

/** Below this many comparable hours a median or a share says nothing, so the summary reports "not enough data" instead. */
export const MIN_COMPARABLE_HOURS = 10;

/** "Within 1%" is how close the two venues are called here: one unit of price agreement that does not depend on the fee model. */
export const CLOSE_PCT = 1;

export interface BigGap {
  t: number;
  /** Signed, as in the series. */
  premiumPct: number;
  /** The venue that was dearer in that hour. */
  dearer: Venue;
  qx: number;
  qswap: number;
  /** QU traded in that hour on the venue that traded less. At least the reference trade size for the entries of `largest`. */
  thinnerQu: number;
}

export interface PremiumSummary {
  /** Hours where both venues had a price, and how many of those needed a carried-forward price. */
  hours: number;
  sameHour: number;
  carried: number;
  /** False below MIN_COMPARABLE_HOURS: every statistic below is then null (or empty). */
  enough: boolean;
  firstMs: number | null;
  lastMs: number | null;
  referenceQu: number;
  /** Median, mean and median absolute premium in percent (positive: QSwap dearer). */
  medianPct: number | null;
  meanPct: number | null;
  medianAbsPct: number | null;
  /** Share (0 to 1) of hours with |premium| at or under `closePct`. */
  closePct: number;
  closeShare: number | null;
  /** Share (0 to 1) of hours beyond the break-even for a trade of `referenceQu`: QSwap dearer, QX dearer, either. An indication only. */
  qswapDearerShare: number | null;
  qxDearerShare: number | null;
  profitableShare: number | null;
  /** Runs of consecutive hours beyond break-even in the same direction. A run of one is a single hour; an hour with no comparable data ends a run. */
  gaps: { count: number; medianHours: number | null; longestHours: number | null };
  /** Share (0 to 1) of hours in which at least `referenceQu` changed hands on each venue. Carried hours never count: the carried side did not trade. */
  depthShare: number | null;
  /** Share of ALL comparable hours that were both beyond break-even and that well traded: the same indication with a floor on the volume seen. Never above `profitableShare`. */
  profitableDeepShare: number | null;
  /** The biggest gaps by size, one per UTC day, among hours where at least `referenceQu` traded on each venue (a gap seen on a few QU is no gap). */
  largest: BigGap[];
  /** How much one price step on QX is worth in percent (QX prices are whole QU, so one step is 1 QU), at the median QX price. */
  qxStepPct: number | null;
  /** True when one QX price step is as big as the smaller break-even: the premium of such a token mostly shows rounding, and its profitable share cannot be trusted. */
  coarseQx: boolean;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** How many of the five biggest gaps to list. */
const TOP_GAPS = 5;

/**
 * Statistics over hourly points (not bars) for a trade of `model.referenceQu`. "Profitable" means only that the hourly
 * average gap was bigger than the fees: see `premiumNote` for everything this ignores.
 */
export function premiumSummary(series: PremiumPoint[], model: CostModel, opts: { minHours?: number; closePct?: number; top?: number } = {}): PremiumSummary {
  const minHours = opts.minHours ?? MIN_COMPARABLE_HOURS;
  const closePct = opts.closePct ?? CLOSE_PCT;
  const top = opts.top ?? TOP_GAPS;
  const n = series.length;
  const carried = series.filter((p) => p.carried).length;
  const base = { hours: n, sameHour: n - carried, carried, firstMs: n ? series[0].t : null, lastMs: n ? series[n - 1].t : null, referenceQu: model.referenceQu, closePct };
  const empty: PremiumSummary = {
    ...base,
    enough: false,
    medianPct: null,
    meanPct: null,
    medianAbsPct: null,
    closeShare: null,
    qswapDearerShare: null,
    qxDearerShare: null,
    profitableShare: null,
    depthShare: null,
    profitableDeepShare: null,
    gaps: { count: 0, medianHours: null, longestHours: null },
    largest: [],
    qxStepPct: null,
    coarseQx: false,
  };
  if (n < Math.max(1, minHours)) return empty;

  const be = breakEven(model);
  const gaps = series.map((p) => p.premiumPct);
  const dir = (p: PremiumPoint) => (p.premiumPct > be.qswapDearerPct ? 1 : p.premiumPct < -be.qxDearerPct ? -1 : 0);
  const up = series.filter((p) => dir(p) === 1).length;
  const down = series.filter((p) => dir(p) === -1).length;

  // Runs of consecutive hours beyond break-even in one direction.
  const runs: number[] = [];
  let run = 0;
  series.forEach((p, k) => {
    const d = dir(p);
    const continues = run > 0 && d !== 0 && d === dir(series[k - 1]) && p.t - series[k - 1].t === HOUR;
    if (continues) run++;
    else {
      if (run > 0) runs.push(run);
      run = d === 0 ? 0 : 1;
    }
  });
  if (run > 0) runs.push(run);

  // How much was seen to trade: the quieter venue must have traded the reference size in that hour. A price carried forward
  // has no trades behind it in that hour, so it is never deep.
  const deep = (p: PremiumPoint) => !p.carried && Math.min(p.qxQu, p.qswapQu) >= model.referenceQu;
  const deepHours = series.filter(deep);

  // The biggest deep hours, keeping only the biggest of each UTC day so one event does not fill the list.
  const bigDay = new Map<number, PremiumPoint>();
  for (const p of deepHours) {
    const day = Math.floor(p.t / DAY);
    const best = bigDay.get(day);
    if (!best || Math.abs(p.premiumPct) > Math.abs(best.premiumPct)) bigDay.set(day, p);
  }
  const largest = [...bigDay.values()]
    .sort((a, b) => Math.abs(b.premiumPct) - Math.abs(a.premiumPct) || a.t - b.t)
    .slice(0, top)
    .map((p): BigGap => ({ t: p.t, premiumPct: p.premiumPct, dearer: p.premiumPct >= 0 ? "QSwap" : "QX", qx: p.qx, qswap: p.qswap, thinnerQu: Math.min(p.qxQu, p.qswapQu) }));

  const qxStepPct = 100 / median(series.map((p) => p.qx));
  return {
    ...base,
    enough: true,
    medianPct: median(gaps),
    meanPct: gaps.reduce((a, x) => a + x, 0) / n,
    medianAbsPct: median(gaps.map(Math.abs)),
    closeShare: gaps.filter((g) => Math.abs(g) <= closePct).length / n,
    qswapDearerShare: up / n,
    qxDearerShare: down / n,
    profitableShare: (up + down) / n,
    depthShare: deepHours.length / n,
    profitableDeepShare: deepHours.filter((p) => dir(p) !== 0).length / n,
    gaps: { count: runs.length, medianHours: runs.length ? median(runs) : null, longestHours: runs.length ? Math.max(...runs) : null },
    largest,
    qxStepPct,
    coarseQx: qxStepPct >= Math.min(be.qswapDearerPct, be.qxDearerPct),
  };
}

/* ---------- what the API returns ---------- */

/** The honest caveat, built from the same fee constants the numbers use so the two cannot drift apart. */
export function premiumNote(model: CostModel): string {
  const pct = (x: number) => `${+(x * 100).toFixed(2)}%`;
  return (
    "An indication from hourly averages, not a guarantee. Each hour's price is the volume-weighted average of that hour's trades, which mixes buyers and sellers, " +
    "so the figures treat it as the middle of each market and ignore the QX bid-ask spread, how deep the QX book and the QSwap pool really were (slippage and price impact; the QU traded in the hour is only a floor), " +
    "and that the two legs are separate transactions whose prices can move in between. " +
    `Fees counted for a ${model.referenceQu.toLocaleString("en-US")} QU round trip: QSwap ${pct(model.qswapFee)} pool fee, QX ${pct(model.qxSellerFee)} on the sale, and ${model.flatQu.toLocaleString("en-US")} QU flat ` +
    "(QSwap's 100,000 QU per swap plus transfer fees), the same as the live arbitrage search. Small trades pay far more, because the flat fee does not shrink with the trade."
  );
}

export interface PremiumResponse {
  asset: string;
  range: PremiumRange;
  /** Width of one point in ms. Points are averages of the hourly gaps they cover; the summary is computed from the hours themselves. */
  barMs: number;
  /** Hours the asset traded on each venue over the whole history (not just this range), to tell "one venue only" from "no overlap lately". */
  tradedHours: { QX: number; QSwap: number };
  bothVenues: boolean;
  /** 0 means only hours where both venues traded; otherwise the most hours a price was carried forward. */
  carryHours: number;
  referenceQu: number;
  /** The premium (in percent, as magnitudes) a round trip of `referenceQu` needs to pay: QSwap dearer than qswapDearer, or QX dearer than qxDearer. */
  breakEvenPct: { qswapDearer: number; qxDearer: number };
  points: PremiumBar[];
  /** Null when the asset is not on both venues. */
  summary: PremiumSummary | null;
  note: string;
}

/** Numbers that go over the wire do not need fifteen digits. */
const sig = (x: number) => Number(x.toPrecision(7));
const dp = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const roundOpt = (x: number | null, d: number) => (x === null ? null : dp(x, d));

/** The whole answer for one asset, from its hourly sums on each venue. Pure, so the API and anything else can use it. */
export function buildPremium(asset: string, qxHours: TradedHour[], qswapHours: TradedHour[], o: { range?: PremiumRange; referenceQu?: number; carryHours?: number; now?: number } = {}): PremiumResponse {
  const range = o.range ?? "30d";
  const spec = RANGE_SPEC[range];
  const model = costModel(o.referenceQu);
  const be = breakEven(model);
  const carryHours = Math.min(MAX_CARRY_HOURS, Math.max(0, Math.floor(o.carryHours ?? 0)));
  const tradedHours = { QX: priced(qxHours).length, QSwap: priced(qswapHours).length };
  const head = { asset, range, barMs: spec.barMs, tradedHours, bothVenues: tradedHours.QX > 0 && tradedHours.QSwap > 0, carryHours, referenceQu: model.referenceQu, breakEvenPct: { qswapDearer: dp(be.qswapDearerPct, 3), qxDearer: dp(be.qxDearerPct, 3) } };
  if (!head.bothVenues) {
    const where = tradedHours.QX ? "QX" : tradedHours.QSwap ? "QSwap" : null;
    return { ...head, points: [], summary: null, note: where ? `${asset} only trades on ${where}, so there are not two markets to compare.` : `No trades of ${asset} are recorded yet, so there is nothing to compare.` };
  }
  const now = o.now ?? Date.now();
  const series = premiumSeries(qxHours, qswapHours, { carryHours, sinceMs: spec.spanMs === null ? undefined : now - spec.spanMs, untilMs: now });
  const s = premiumSummary(series, model);
  const summary: PremiumSummary = {
    ...s,
    medianPct: roundOpt(s.medianPct, 3),
    meanPct: roundOpt(s.meanPct, 3),
    medianAbsPct: roundOpt(s.medianAbsPct, 3),
    closeShare: roundOpt(s.closeShare, 4),
    qswapDearerShare: roundOpt(s.qswapDearerShare, 4),
    qxDearerShare: roundOpt(s.qxDearerShare, 4),
    profitableShare: roundOpt(s.profitableShare, 4),
    depthShare: roundOpt(s.depthShare, 4),
    profitableDeepShare: roundOpt(s.profitableDeepShare, 4),
    qxStepPct: roundOpt(s.qxStepPct, 4),
    largest: s.largest.map((g) => ({ ...g, premiumPct: dp(g.premiumPct, 3), qx: sig(g.qx), qswap: sig(g.qswap), thinnerQu: Math.round(g.thinnerQu) })),
  };
  const points = premiumBars(series, spec.barMs).map((b) => ({ ...b, qx: sig(b.qx), qswap: sig(b.qswap), premiumPct: dp(b.premiumPct, 3), minPct: dp(b.minPct, 3), maxPct: dp(b.maxPct, 3) }));
  return { ...head, points, summary, note: premiumNote(model) };
}

/* ---------- plain English ---------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
/** "Sep 26, 14:00 UTC". UTC like the charts, so every viewer reads the same date. */
export const hourLabel = (t: number) => {
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${two(d.getUTCHours())}:00 UTC`;
};
const dayLabel = (t: number) => `${MONTHS[new Date(t).getUTCMonth()]} ${new Date(t).getUTCDate()}`;
/** A share (0 to 1) as a short percentage: whole numbers from 1% up, a decimal below. */
export const shareText = (s: number) => (s === 0 ? "0%" : s * 100 < 0.1 ? "under 0.1%" : `${s * 100 >= 1 ? Math.round(s * 100) : +(s * 100).toFixed(1)}%`);
/** A gap in percent: more digits for small ones. */
export const gapText = (x: number) => {
  const a = Math.abs(x);
  return `${a >= 100 ? Math.round(a) : a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toFixed(2)}%`;
};
const signedGap = (x: number) => `${x > 0 ? "+" : x < 0 ? "-" : ""}${gapText(x)}`;
/** "10M QU", "250K QU": a QU amount short enough for a sentence. */
export const quText = (x: number) => (x >= 1e6 ? `${+(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${+(x / 1e3).toFixed(1)}K` : String(Math.round(x))) + " QU";
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The summary in plain sentences (one string each), for the website's "Venues" tab and anything else that wants words. Says
 * "not enough data" rather than guessing, and never claims more than an indication. `caution` is kept apart because it is
 * a warning about the token, not part of the story: set when QX's whole-QU prices are too coarse to trust the profitable share.
 */
export function describePremium(r: PremiumResponse, symbol: string): { lines: string[]; caution: string | null } {
  const s = r.summary;
  const over = r.range === "all" ? "Across the whole history" : `Over ${RANGE_SPEC[r.range].label}`;
  if (!r.bothVenues) return { lines: [r.note], caution: null };
  if (!s || s.hours === 0)
    return {
      lines: [`${over}, ${symbol} had no hour with trades on both QX and QSwap${r.carryHours ? ` (or within ${plural(r.carryHours, "hour")} of each other)` : ""}. Try a longer range${r.carryHours ? "" : ", or let a price carry forward for up to 3 hours"}.`],
      caution: null,
    };
  const carriedText = s.carried ? `, ${s.carried.toLocaleString("en-US")} of them using a price carried forward up to ${plural(r.carryHours, "hour")}` : "";
  const lines = [`${over}, ${symbol} had ${plural(s.hours, "hour")} with trades on both QX and QSwap${carriedText}.`];
  if (!s.enough || s.medianPct === null || s.closeShare === null || s.profitableShare === null || s.profitableDeepShare === null || s.qswapDearerShare === null || s.qxDearerShare === null) {
    lines.push(`That is not enough data for statistics (QMax wants at least ${MIN_COMPARABLE_HOURS}). Try a longer range.`);
    return { lines, caution: null };
  }
  const side = s.medianPct === 0 ? "" : s.medianPct > 0 ? " (QSwap dearer)" : " (QX dearer)";
  lines.push(`The two markets were within ${s.closePct}% of each other in ${shareText(s.closeShare)} of those hours; the median gap was ${signedGap(s.medianPct)}${side}.`);
  lines.push(
    `The hourly average prices were further apart than the trading costs in about ${shareText(s.profitableShare)} of those hours (QSwap dearer by more than ${gapText(r.breakEvenPct.qswapDearer)} in ${shareText(s.qswapDearerShare)}, QX dearer by more than ${gapText(r.breakEvenPct.qxDearer)} in ${shareText(s.qxDearerShare)}, for a ${quText(r.referenceQu)} round trip). ` +
      `Treat that as an upper bound, not as profit: these averages leave out the QX bid-ask spread, which alone is often wider than the costs, and the two legs are separate transactions that can move against you.`,
  );
  lines.push(
    s.depthShare === 0 || s.depthShare === null
      ? `No comparable hour had ${quText(r.referenceQu)} traded on each market, so none of them shows a gap that a trade of that size is known to have been able to use.`
      : `At least ${quText(r.referenceQu)} traded on each market in ${shareText(s.depthShare)} of the comparable hours; in ${shareText(s.profitableDeepShare)} of all of them the gap was also beyond break-even.`,
  );
  if (s.gaps.count && s.gaps.medianHours !== null && s.gaps.longestHours !== null)
    lines.push(`A stretch beyond break-even typically lasted ${plural(s.gaps.medianHours, "hour")} (longest ${plural(s.gaps.longestHours, "hour")}). An hour without trades on both markets ends a stretch, so real ones may have lasted longer.`);
  const big = s.largest[0];
  if (big) lines.push(`The biggest gap among those was ${gapText(big.premiumPct)} on ${dayLabel(big.t)} (${big.dearer} dearer, with ${quText(big.thinnerQu)} traded on the quieter market that hour).`);
  const caution =
    s.coarseQx && s.qxStepPct !== null
      ? `QX prices move in whole QU, so one price step is about ${gapText(s.qxStepPct)} of ${symbol}'s price here. Gaps that small mostly show rounding, so the share beyond break-even is not reliable for this token.`
      : null;
  return { lines, caution };
}

/* ---------- the endpoint ---------- */

/** What the endpoint reads. `hours` is `TradeIndex.hours` matched to the asset list: null for an asset it does not know. */
export interface PremiumDeps {
  hours(assetId: string, venue: Venue): TradedHour[] | null;
  /** The clock, for tests. */
  now?(): number;
}

/** A number from the query string within limits, or the fallback when absent. A 400 for anything else. */
function numberParam(query: URLSearchParams, name: string, min: number, max: number, fallback: number, integer = false): number {
  const raw = query.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const v = plainNumber(raw, true);
  if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw new RouteError(400, `${name} must be ${integer ? "a whole number" : "a number"} from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}`);
  return v;
}

/** The smallest reference trade accepted: below this the 100,200 QU flat fee alone is more than the trade. */
const MIN_REFERENCE_QU = 100_000;
const MAX_REFERENCE_QU = 1e12;

export function premiumRoutes(deps: PremiumDeps): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/premium",
      doc: {
        summary: "How far apart QX and QSwap priced a token, hour by hour, and how often the gap would have paid after fees",
        description:
          "Built from the trade index (what was actually paid on each venue, hourly volume-weighted prices). `premiumPct` is (QSwap - QX) / QX * 100, so positive means QSwap was dearer. " +
          "`points` are averages over `barMs`; `summary` is computed from the individual hours. 'Profitable' is an indication from hourly averages, not a guarantee: it ignores the QX spread, order book depth, slippage and that the legs are separate transactions. " +
          "`profitableDeepShare` is the same indication counting only hours in which at least `referenceQu` traded on each venue. " +
          "For a token that trades on one venue only, `points` is empty and `bothVenues` is false.",
        parameters: [
          { name: "asset", in: "query", required: true, schema: { type: "string" }, description: "Asset id from /v1/assets" },
          { name: "range", in: "query", schema: { type: "string", enum: [...PREMIUM_RANGES], default: "30d" } },
          { name: "referenceQu", in: "query", schema: { type: "number", default: DEFAULT_REFERENCE_QU, minimum: MIN_REFERENCE_QU, maximum: MAX_REFERENCE_QU }, description: "Trade size in QU the break-even is worked out for (the flat per-swap fee matters more for small trades)." },
          { name: "carry", in: "query", schema: { type: "integer", default: 0, minimum: 0, maximum: MAX_CARRY_HOURS }, description: "Hours a venue's last price may be carried forward to an hour the other venue traded in (0: same hour only). Carried points are marked." },
        ],
        responses: { "200": { description: "The premium series and its summary" }, "400": { description: "A parameter is out of range" }, "404": { description: "Unknown asset" } },
      },
      handler: ({ query }) => {
        const asset = required(query, "asset");
        const range = oneOf(query, "range", PREMIUM_RANGES, "30d");
        const referenceQu = numberParam(query, "referenceQu", MIN_REFERENCE_QU, MAX_REFERENCE_QU, DEFAULT_REFERENCE_QU);
        const carryHours = numberParam(query, "carry", 0, MAX_CARRY_HOURS, 0, true);
        const qx = deps.hours(asset, "QX");
        const qswap = deps.hours(asset, "QSwap");
        if (qx === null || qswap === null) throw new RouteError(404, `Unknown asset '${asset}'`);
        return buildPremium(asset, qx, qswap, { range, referenceQu, carryHours, now: deps.now?.() });
      },
    },
  ];
}
