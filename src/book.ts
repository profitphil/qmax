import { QswapVenue, QxVenue } from "./venues.ts";
import type { BookLevel } from "./venues.ts";

export interface BookRow {
  price: number;
  /** Units resting at this price, across all the orders there. */
  qty: number;
  orders: number;
  /** Units and QU you would take going from the best price down to this one. */
  cumQty: number;
  cumQu: number;
}

export interface QxBook {
  /** Cheapest first. */
  asks: BookRow[];
  /** Highest first. */
  bids: BookRow[];
  bestAsk: number | null;
  bestBid: number | null;
  mid: number | null;
  /** Gap between best ask and best bid, as a percentage of the middle. */
  spreadPct: number | null;
  /** What is on the whole book, not just the rows shown. */
  asksTotal: { levels: number; orders: number; qty: number };
  bidsTotal: { levels: number; orders: number; qty: number };
  /** True if QX has more orders than the 256 one query returns. */
  truncated: boolean;
}

export interface PoolDepthRow {
  /** Share of the pool's units this size is. */
  fraction: number;
  qty: number;
  /** Average price per unit including the pool's fee, and how far that is from the pool price. Null if the pool cannot fill it. */
  buyAvgPrice: number | null;
  buyImpactPct: number | null;
  sellAvgPrice: number | null;
  sellImpactPct: number | null;
}

export interface PoolBook {
  reserveQu: number;
  reserveAsset: number;
  /** QU per unit at the reserves. */
  price: number;
  feePct: number;
  depth: PoolDepthRow[];
}

export interface BookView {
  qx: QxBook | null;
  qswap: PoolBook | null;
}

/** Orders at the same price become one row; `cum*` run from the best price outward. `max` limits the rows (not the totals). */
function rows(levels: BookLevel[], side: "ask" | "bid", max: number): { rows: BookRow[]; total: { levels: number; orders: number; qty: number } } {
  const byPrice = new Map<number, { qty: number; orders: number }>();
  for (const l of levels) {
    if (!(l.qty > 0) || !(l.price > 0)) continue;
    const cur = byPrice.get(l.price) ?? { qty: 0, orders: 0 };
    cur.qty += l.qty;
    cur.orders++;
    byPrice.set(l.price, cur);
  }
  const sorted = [...byPrice.entries()].sort((a, b) => (side === "ask" ? a[0] - b[0] : b[0] - a[0]));
  let cumQty = 0;
  let cumQu = 0;
  const out: BookRow[] = [];
  for (const [price, v] of sorted.slice(0, max)) {
    cumQty += v.qty;
    cumQu += v.qty * price;
    out.push({ price, qty: v.qty, orders: v.orders, cumQty, cumQu });
  }
  return {
    rows: out,
    total: { levels: sorted.length, orders: sorted.reduce((s, [, v]) => s + v.orders, 0), qty: sorted.reduce((s, [, v]) => s + v.qty, 0) },
  };
}

const DEPTH_FRACTIONS = [0.001, 0.005, 0.01, 0.02, 0.05];

/** The order book and pool of one asset, ready to show. */
export function buildBook(qx: QxVenue | undefined, qswap: QswapVenue | undefined, opts: { levels?: number } = {}): BookView {
  const max = Math.max(1, Math.min(opts.levels ?? 15, 50));
  let qxView: QxBook | null = null;
  if (qx) {
    const raw = qx.book();
    const asks = rows(raw.asks, "ask", max);
    const bids = rows(raw.bids, "bid", max);
    const bestAsk = asks.rows[0]?.price ?? null;
    const bestBid = bids.rows[0]?.price ?? null;
    const mid = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : (bestAsk ?? bestBid);
    qxView = {
      asks: asks.rows,
      bids: bids.rows,
      bestAsk,
      bestBid,
      mid,
      spreadPct: bestAsk !== null && bestBid !== null && mid ? ((bestAsk - bestBid) / mid) * 100 : null,
      asksTotal: asks.total,
      bidsTotal: bids.total,
      truncated: raw.truncated,
    };
  }
  let pool: PoolBook | null = null;
  if (qswap) {
    const p = qswap.pool();
    const price = p.reserveAsset > 0 ? p.reserveQu / p.reserveAsset : 0;
    const finite = (x: number) => (Number.isFinite(x) ? x : null);
    pool = {
      reserveQu: p.reserveQu,
      reserveAsset: p.reserveAsset,
      price,
      feePct: p.swapFeeRate / 100,
      depth: DEPTH_FRACTIONS.map((fraction) => {
        const qty = Math.max(1, Math.floor(p.reserveAsset * fraction));
        const buy = finite(qswap.variableNetQu("buy", qty));
        const sell = finite(qswap.variableNetQu("sell", qty));
        const buyAvg = buy === null ? null : buy / qty;
        const sellAvg = sell === null ? null : sell / qty;
        return {
          fraction,
          qty,
          buyAvgPrice: buyAvg,
          buyImpactPct: buyAvg === null || !price ? null : (buyAvg / price - 1) * 100,
          sellAvgPrice: sellAvg,
          sellImpactPct: sellAvg === null || !price ? null : (1 - sellAvg / price) * 100,
        };
      }),
    };
  }
  return { qx: qxView, qswap: pool };
}
