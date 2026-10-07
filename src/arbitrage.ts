import { passesFilters } from "./arbfilters.ts";
import type { ArbFilters } from "./arbfilters.ts";
import type { Venue } from "./types.ts";
import { QswapVenue, QxVenue } from "./venues.ts";

/** What the catalog knows about an asset's two markets (top of the QX book and the pool reserves). */
export interface MarketTop {
  bestAsk?: number | null;
  askQty?: number | null;
  bestBid?: number | null;
  bidQty?: number | null;
  poolQu?: number | null;
  poolAsset?: number | null;
}

/** Fees as of today's contracts: QX takes 0.3% from the seller, QSwap charges 0.3% plus a flat 100,000 QU per swap. */
export const MARKET_FEES = { qxSellerRate: 0.003, swapFeeRate: 30, qswapFixedQu: 100_100, qxFixedQu: 100 };

const hasBook = (t: MarketTop) => !!(t.bestAsk && t.bestBid && t.askQty && t.bidQty);
const hasPool = (t: MarketTop) => !!(t.poolQu && t.poolAsset && t.poolQu > 0 && t.poolAsset > 0);
export const onBothMarkets = (t: MarketTop) => hasBook(t) && hasPool(t);

export interface PriceComparison {
  /** Where one unit costs less to buy, and by how much (fraction of the dearer price). */
  buy: { cheaperOn: "QX" | "QSwap"; pct: number };
  /** Where one unit sells for more, and by how much. */
  sell: { betterOn: "QX" | "QSwap"; pct: number };
}

/** Spot comparison per unit, fees included but not flat fees or price impact. */
export function comparePrices(t: MarketTop): PriceComparison | null {
  if (!onBothMarkets(t)) return null;
  const f = MARKET_FEES.swapFeeRate / 10_000;
  const spot = t.poolQu! / t.poolAsset!;
  const qxBuy = t.bestAsk!; // the buyer pays no QX fee
  const qxSell = t.bestBid! * (1 - MARKET_FEES.qxSellerRate);
  const swapBuy = spot / (1 - f);
  const swapSell = spot * (1 - f);
  return {
    buy: qxBuy <= swapBuy ? { cheaperOn: "QX", pct: 1 - qxBuy / swapBuy } : { cheaperOn: "QSwap", pct: 1 - swapBuy / qxBuy },
    sell: qxSell >= swapSell ? { betterOn: "QX", pct: 1 - swapSell / qxSell } : { betterOn: "QSwap", pct: 1 - qxSell / swapSell },
  };
}

export interface Arbitrage {
  /** Buy on one market, sell on the other. */
  direction: "buy-qx-sell-qswap" | "buy-qswap-sell-qx";
  qty: number;
  /** QU laid out buying, and QU left after selling, fees (including QMax's) and flat costs. */
  costQu: number;
  profitQu: number;
  profitPct: number;
}

/**
 * Looks for a loop that ends with more QU than it started with: buy where it is cheap, sell where it is dear,
 * counting every fee, the pool's price impact and the thin top of the QX book. Returns the most profitable size,
 * or null if there is none. The filters (minimum profit, minimum percentage, budget) apply during the search, so the result
 * is the best loop that fits them, not the best loop with the rest thrown away. This is a snapshot, not a promise: the two legs are separate transactions.
 */
export function findArbitrage(t: MarketTop, filters: Partial<ArbFilters> = {}): Arbitrage | null {
  if (!onBothMarkets(t)) return null;
  const pool = new QswapVenue({ reserveQu: t.poolQu!, reserveAsset: t.poolAsset!, swapFeeRate: MARKET_FEES.swapFeeRate, fixedCostQu: 0 });
  const book = new QxVenue({
    asks: [{ price: t.bestAsk!, qty: t.askQty! }],
    bids: [{ price: t.bestBid!, qty: t.bidQty! }],
    buyerFeeRate: 0,
    sellerFeeRate: MARKET_FEES.qxSellerRate,
    fixedCostQu: 0,
    truncated: false,
  });
  const fixed = MARKET_FEES.qswapFixedQu + MARKET_FEES.qxFixedQu;

  let best: Arbitrage | null = null;
  const consider = (direction: Arbitrage["direction"], cap: number) => {
    const sizes = new Set<number>();
    for (let q = 1; q <= cap; q *= 2) sizes.add(q);
    for (let k = 1; k <= 24; k++) sizes.add(Math.max(1, Math.floor((cap * k) / 24)));
    for (const q of sizes) {
      if (q >= t.poolAsset!) continue;
      const buyCost = direction === "buy-qx-sell-qswap" ? book.variableNetQu("buy", q) : pool.variableNetQu("buy", q);
      const sellGain = direction === "buy-qx-sell-qswap" ? pool.variableNetQu("sell", q) : book.variableNetQu("sell", q);
      if (!Number.isFinite(buyCost) || !Number.isFinite(sellGain)) continue;
      const cost = buyCost + fixed;
      const profit = sellGain - cost;
      const o = { direction, qty: q, costQu: cost, profitQu: profit, profitPct: (profit / cost) * 100 };
      if (profit > 0 && passesFilters(o, filters) && (!best || profit > best.profitQu)) best = o;
    }
  };
  consider("buy-qx-sell-qswap", t.askQty!);
  consider("buy-qswap-sell-qx", t.bidQty!);
  return best;
}

/**
 * The same search as findArbitrage, but against live venues with their full order book and pool, so it
 * is exact for every size rather than an estimate from the top of the book.
 */
export function findArbitrageVenues(qx: Venue, qswap: Venue, opts: { maxQty?: number } & Partial<ArbFilters> = {}): Arbitrage | null {
  const maxQty = opts.maxQty ?? 1e12;
  let best: Arbitrage | null = null;
  const legs: [Arbitrage["direction"], Venue, Venue][] = [
    ["buy-qx-sell-qswap", qx, qswap],
    ["buy-qswap-sell-qx", qswap, qx],
  ];
  for (const [direction, buyAt, sellAt] of legs) {
    let missing = 0;
    for (let q = 1; q <= maxQty; q = Math.ceil(q * 1.35) + 1) {
      const buyCost = buyAt.variableNetQu("buy", q);
      if (!Number.isFinite(buyCost)) {
        if (++missing > 2) break; // past what the venue can fill
        continue;
      }
      const sellGain = sellAt.variableNetQu("sell", q);
      if (!Number.isFinite(sellGain)) continue;
      const cost = buyCost + buyAt.fixedCostQu + sellAt.fixedCostQu;
      const profit = sellGain - cost;
      const o = { direction, qty: q, costQu: cost, profitQu: profit, profitPct: (profit / cost) * 100 };
      if (profit > 0 && passesFilters(o, opts) && (!best || profit > best.profitQu)) best = o;
    }
  }
  return best;
}
