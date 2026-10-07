import type { Allocation, RoutePlan, Side, Venue } from "./types.ts";
import { QSWAP_MIN_BUY_QU, QswapVenue } from "./venues.ts";

export interface RouteOptions {
  /** Allow splitting across venues. Default true. */
  split?: boolean;
  /** Fractions of the order to quote on each venue first. Default [0.25, 0.5, 0.75, 1]. */
  ladder?: number[];
  /** Extra quotes around the chosen allocation to sharpen the sweet spot (default true). */
  refine?: boolean;
  /**
   * Allow a QSwap buy that needs under QSWAP_MIN_BUY_QU. Default false: Qswap.h keeps the whole payment (the flat 100,000 QU fee
   * included) for such a buy, so a route that contains one is never offered. Only a caller that sizes orders itself and applies
   * its own check (the swap planner's search probes small sizes on purpose) turns this on.
   */
  allowTinyQswapBuy?: boolean;
}

const STEPS = 2000;
const DEFAULT_LADDER = [0.25, 0.5, 0.75, 1];

/** Lower is better: buy minimizes QU paid, sell maximizes QU received. */
const score = (side: Side, netQu: number) => (side === "buy" ? netQu : -netQu);

/**
 * A venue's cost curve learned from quote calls at a handful of sizes. Quotes (on-chain QSwap
 * Quote* calls, QX book walks) are the only thing we trust; between samples we interpolate
 * linearly. Cost is convex in size, so interpolation never underestimates cost.
 */
class Curve {
  pts = new Map<number, number>([[0, 0]]);
  calls = 0;
  private venue: Venue;
  private side: Side;
  constructor(venue: Venue, side: Side) {
    this.venue = venue;
    this.side = side;
  }

  sample(q: number) {
    q = Math.round(q);
    if (q <= 0 || this.pts.has(q)) return;
    this.calls++;
    this.pts.set(q, this.venue.variableNetQu(this.side, q));
  }

  at(q: number): number {
    if (q <= 0) return 0;
    const xs = [...this.pts.keys()].sort((a, b) => a - b);
    let lo = 0;
    for (const x of xs) {
      if (x === q) return this.pts.get(x)!;
      if (x > q) {
        const c1 = this.pts.get(x)!;
        if (!Number.isFinite(c1)) return Infinity;
        const c0 = this.pts.get(lo)!;
        return c0 + ((c1 - c0) * (q - lo)) / (x - lo);
      }
      lo = x;
    }
    return Infinity; // beyond the largest sampled size
  }
}

/** Greedy marginal allocation over `curves`; optimal for convex costs up to chunk size. */
function allocate(curves: Curve[], side: Side, qty: number): number[] | null {
  const step = Math.max(1, Math.floor(qty / STEPS));
  const alloc = curves.map(() => 0);
  let left = qty;
  while (left > 0) {
    const chunk = Math.min(step, left);
    let best = -1;
    let bestDelta = Infinity;
    curves.forEach((c, i) => {
      const next = c.at(alloc[i] + chunk);
      if (!Number.isFinite(next)) return;
      const delta = score(side, next) - score(side, c.at(alloc[i]));
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    });
    if (best < 0) return null;
    alloc[best] += chunk;
    left -= chunk;
  }
  return alloc;
}

function subsets<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let m = 1; m < 1 << items.length; m++) out.push(items.filter((_, i) => m & (1 << i)));
  return out;
}

export function route(venues: Venue[], side: Side, qty: number, opts: RouteOptions = {}): RoutePlan {
  if (!(qty > 0) || !Number.isInteger(qty)) throw new Error("qty must be a positive integer");
  const ladder = opts.ladder ?? DEFAULT_LADDER;
  const curves = venues.map((v) => new Curve(v, side));
  let extraCalls = 0;
  let tinyRefused = false;

  // Step 1: quote every venue at 25/50/75/100% of the order.
  for (const c of curves) for (const f of ladder) c.sample(qty * f);

  const search = (set: number[]) => allocate(set.map((i) => curves[i]), side, qty);
  const idx = venues.map((_, i) => i);
  const candidates = opts.split === false ? idx.map((i) => [i]) : subsets(idx);

  const evaluate = (set: number[], qtys: number[]) => {
    const allocs: Allocation[] = [];
    let total = 0;
    set.forEach((vi, k) => {
      if (qtys[k] === 0) return;
      extraCalls++;
      const quote = venues[vi].quote(side, qtys[k]);
      if (!quote) return;
      // A QSwap buy that small would lose the user the flat fee (see QSWAP_MIN_BUY_QU): this route is not offered.
      if (side === "buy" && !opts.allowTinyQswapBuy && venues[vi] instanceof QswapVenue && quote.netQu - quote.fixedCostQu < QSWAP_MIN_BUY_QU) {
        tinyRefused = true;
        return;
      }
      allocs.push({ venue: venues[vi].name, qty: qtys[k], quote });
      total += score(side, quote.netQu);
    });
    const filled = allocs.reduce((s, a) => s + a.qty, 0);
    return filled === qty ? { allocs, total } : null;
  };

  const pick = () => {
    let best: { allocs: Allocation[]; total: number } | null = null;
    for (const set of candidates) {
      const qtys = search(set);
      if (!qtys) continue;
      const r = evaluate(set, qtys);
      if (r && (!best || r.total < best.total)) best = r;
    }
    return best;
  };

  let best = pick();

  // Step 2: zoom in. Add quotes around the chosen sizes and search again.
  if ((opts.refine ?? true) && best && best.allocs.length > 1) {
    for (const a of best.allocs) {
      const c = curves[venues.findIndex((v) => v.name === a.venue)];
      for (const d of [-0.125, -0.0625, 0.0625, 0.125]) c.sample(Math.min(qty, Math.max(1, a.qty + qty * d)));
    }
    const better = pick();
    if (better && (!best || better.total < best.total)) best = better;
  }

  const singleVenue = venues.map((v) => {
    extraCalls++;
    return { venue: v.name, quote: v.quote(side, qty) };
  });

  let allocations = best?.allocs ?? [];
  const venueTotalOf = (a: Allocation[]) => a.reduce((s, x) => s + x.quote.netQu, 0);
  const warnings = [...new Set(allocations.flatMap((a) => a.quote.warnings))];

  // A sale whose proceeds do not even cover the flat venue fees would cost the user money.
  if (allocations.length && side === "sell") {
    const total = venueTotalOf(allocations);
    if (total <= 0) {
      const fixed = allocations.reduce((s, a) => s + a.quote.fixedCostQu, 0);
      warnings.push(`This order is too small to sell: it is worth less than the flat ${Math.round(fixed).toLocaleString("en-US")} QU of fixed fees. Try a larger amount.`);
      allocations = [];
    }
  }
  // A QSwap buy that small is refused rather than quoted: the contract would keep the flat fee (see QSWAP_MIN_BUY_QU).
  if (!allocations.length && tinyRefused)
    warnings.push(`This order is too small to buy on QSwap: it needs less than ${QSWAP_MIN_BUY_QU.toLocaleString("en-US")} QU, and the contract keeps the whole payment, including the flat 100,000 QU fee, when the QU needed is that small. Buy a larger amount.`);
  if (!allocations.length && !warnings.length) warnings.push("No market (or combination) can fill the full order: insufficient depth");

  // Flat fees weigh heavily on small orders; tell the user when fees are a large share of the trade.
  if (allocations.length) {
    const cost = allocations.reduce((s, a) => s + a.quote.feesQu + a.quote.fixedCostQu, 0);
    const total = venueTotalOf(allocations);
    const value = side === "buy" ? total - cost : total + cost;
    if (value > 0 && cost / value > 0.05) {
      warnings.push(`Fees are ${Math.round((cost / value) * 100)}% of this trade (${Math.round(cost).toLocaleString("en-US")} QU). A larger order spreads the flat fees and costs less per unit.`);
    }
  }

  const filledQty = allocations.reduce((s, a) => s + a.qty, 0);
  const venueTotal = venueTotalOf(allocations);
  const totalNetQu = venueTotal;
  return {
    side,
    qty,
    filledQty,
    allocations,
    totalNetQu,
    averagePrice: filledQty ? totalNetQu / filledQty : NaN,
    singleVenue,
    quoteCalls: curves.reduce((s, c) => s + c.calls, 0) + extraCalls,
    warnings,
  };
}
