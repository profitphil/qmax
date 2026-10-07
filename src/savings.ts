/**
 * What QMax's routing is worth on one order: the chosen route against each market on its own. A quote already carries the
 * price of the order on QX alone and on QSwap alone (`alternatives`), so this is arithmetic on the quote, not a guess about
 * what another site would have charged. It uses the prices at quote time; the trade can still settle a little differently,
 * and the receipt shows the quote-time saving and the actual result side by side instead of blending them.
 */

export interface SavingsInput {
  side: "buy" | "sell";
  /** QU the chosen route costs (buy) or pays (sell). */
  totalQu: number;
  fillable: boolean;
  route: { venue: string }[];
  alternatives: { venue: string; fillable: boolean; totalQu: number | null }[];
}

export interface VenueComparison {
  venue: string;
  /** What the whole order would cost (buy) or pay (sell) on this market alone; null if it could not fill all of it. */
  totalQu: number | null;
  /** How much better the chosen route is than this market alone, in QU (never negative). Null if the market could not fill it. */
  savedQu: number | null;
  savedPct: number | null;
}

export interface RouteSaving {
  side: "buy" | "sell";
  routeQu: number;
  venues: string[];
  /** The order is split across more than one market. */
  split: boolean;
  comparisons: VenueComparison[];
  /** Saving against the best single market that could fill the order (the smallest saving; 0 if the route is that market). */
  savedVsBestSingleQu: number;
  savedVsBestSinglePct: number;
  /** No single market could fill the order, so the split is what made it possible. */
  onlyViaSplit: boolean;
}

const pct = (saved: number, base: number) => (base > 0 ? (saved / base) * 100 : 0);

/** The saving on a quote, or null when the quote cannot be filled or there is nothing to compare with. */
export function routeSaving(q: SavingsInput): RouteSaving | null {
  if (!q.fillable || !(q.totalQu > 0) || !q.route.length) return null;
  const comparisons: VenueComparison[] = q.alternatives.map((a) => {
    if (!a.fillable || a.totalQu === null || !(a.totalQu > 0)) return { venue: a.venue, totalQu: null, savedQu: null, savedPct: null };
    // Buying: the route should cost no more than the market alone. Selling: it should pay no less. Never show a negative saving.
    const saved = Math.max(0, q.side === "buy" ? a.totalQu - q.totalQu : q.totalQu - a.totalQu);
    return { venue: a.venue, totalQu: a.totalQu, savedQu: saved, savedPct: pct(saved, a.totalQu) };
  });
  if (!comparisons.length) return null;
  const fillable = comparisons.filter((c) => c.savedQu !== null);
  const vsBest = fillable.length ? fillable.reduce((a, b) => (a.savedQu! <= b.savedQu! ? a : b)) : null;
  return {
    side: q.side,
    routeQu: q.totalQu,
    venues: q.route.map((r) => r.venue),
    split: q.route.length > 1,
    comparisons,
    savedVsBestSingleQu: vsBest?.savedQu ?? 0,
    savedVsBestSinglePct: vsBest?.savedPct ?? 0,
    onlyViaSplit: fillable.length === 0 && q.route.length > 1,
  };
}

/** A saving smaller than this is rounding noise and is not worth a line on screen. */
export const MIN_SHOWN_QU = 1;
export const MIN_SHOWN_PCT = 0.05;

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const pctText = (p: number) => (p < 10 ? p.toFixed(1) : p.toFixed(0));

function meaningful(qu: number, p: number) {
  return qu >= MIN_SHOWN_QU && p >= MIN_SHOWN_PCT;
}

/** One sentence saying what the routing did for this order, or null if it did nothing worth saying. */
export function savingHeadline(s: RouteSaving): string | null {
  if (s.onlyViaSplit) return `No single market could fill this whole order, so QMax split it across ${s.venues.join(" and ")}.`;
  if (s.split && meaningful(s.savedVsBestSingleQu, s.savedVsBestSinglePct))
    return s.side === "buy"
      ? `Splitting across ${s.venues.join(" and ")} saves you ${n(s.savedVsBestSingleQu)} QU (${pctText(s.savedVsBestSinglePct)}%) versus the best single market.`
      : `Splitting across ${s.venues.join(" and ")} gets you ${n(s.savedVsBestSingleQu)} QU (${pctText(s.savedVsBestSinglePct)}%) more than the best single market.`;
  // One market was the best: say what the other would have cost, which is the choice QMax made for the user.
  const others = s.comparisons.filter((c) => c.savedQu !== null && meaningful(c.savedQu, c.savedPct ?? 0));
  if (!s.split && others.length) {
    const o = others.reduce((a, b) => (a.savedQu! >= b.savedQu! ? a : b));
    return `${s.venues[0]} is the better market for this order: ${o.venue} alone would ${s.side === "buy" ? "cost" : "pay"} ${n(o.savedQu!)} QU ${s.side === "buy" ? "more" : "less"} (${pctText(o.savedPct!)}%).`;
  }
  return null;
}

/** Each market on its own, as short lines for a receipt: "QX alone: 7,300 QU, 150 QU more than this route". */
export function comparisonLines(s: RouteSaving): string[] {
  return s.comparisons.map((c) => {
    if (c.totalQu === null) return `${c.venue} alone: could not fill the whole order`;
    const diff = c.savedQu! >= MIN_SHOWN_QU ? `, ${n(c.savedQu!)} QU ${s.side === "buy" ? "more" : "less"} than this route` : ", about the same as this route";
    return `${c.venue} alone: ${n(c.totalQu)} QU${diff}`;
  });
}

/** The running total of what the split saved, kept per wallet. Only the conservative figure is counted: the saving against the best single market. */
export interface SavingsTally {
  /** QU saved by splitting, summed over completed trades. */
  savedQu: number;
  /** Trades routed through QMax that finished. */
  trades: number;
  /** Of those, how many were split across both markets. */
  splitTrades: number;
  /** When the first one was counted (ms since epoch). */
  since: number;
}

/**
 * Adds a finished trade to the tally. `filledFraction` is how much of the order really filled (1 for a full fill): a partial
 * fill counts its share of the saving. A trade that moved nothing is not counted.
 */
export function addToTally(tally: SavingsTally | undefined, s: RouteSaving, filledFraction: number, now = Date.now()): SavingsTally {
  const base: SavingsTally = tally ?? { savedQu: 0, trades: 0, splitTrades: 0, since: now };
  const f = Number.isFinite(filledFraction) ? Math.min(1, Math.max(0, filledFraction)) : 0;
  if (f === 0) return base;
  return {
    savedQu: base.savedQu + Math.round((s.split ? s.savedVsBestSingleQu : 0) * f),
    trades: base.trades + 1,
    splitTrades: base.splitTrades + (s.split ? 1 : 0),
    since: base.since,
  };
}

/** The tally as one line for a menu or a receipt, or null before the first trade. */
export function tallyLine(t: SavingsTally | undefined): string | null {
  if (!t || t.trades === 0) return null;
  return `${n(t.savedQu)} QU saved by splitting orders across both markets, over ${n(t.trades)} trade${t.trades === 1 ? "" : "s"} (${n(t.splitTrades)} split).`;
}

/** Plain text a person can paste anywhere: what they traded and what routing did for it. */
export function receiptText(r: { side: "buy" | "sell"; asset: string; filledQty: number; actualQu: number; saving: RouteSaving | null }): string {
  const verb = r.side === "buy" ? "Bought" : "Sold";
  const head = `${verb} ${n(r.filledQty)} ${r.asset} for ${n(r.actualQu)} QU with QMax.`;
  const line = r.saving ? savingHeadline(r.saving) : null;
  return line ? `${head} ${line}` : head;
}
