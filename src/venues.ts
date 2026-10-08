import type { Side, Venue, VenueQuote } from "./types.ts";

/** One resting QX order. QX returns at most 256 orders per query. */
export interface BookLevel {
  /** QU per unit of asset */
  price: number;
  qty: number;
}

export const QX_MAX_ORDERS_PER_QUERY = 256;

export interface QxConfig {
  asks: BookLevel[];
  bids: BookLevel[];
  /** True if more orders exist than were fetched (depth beyond the visible book is unknown). */
  truncated?: boolean;
  /**
   * Trade fee as a fraction of matched value (QX tradeFee = 3_000_000 / 1e9 = 0.3%).
   * In Qx.h the fee is deducted from the QU a seller receives, so the buyer pays none.
   */
  buyerFeeRate: number;
  sellerFeeRate: number;
  /** Flat QU the venue takes on top of an order. QX takes none (the live adapter sets 0: see src/live.ts); the 100 QU transfer fee belongs to a management-rights move, a step of its own. */
  fixedCostQu: number;
}

export interface QswapConfig {
  reserveQu: number;
  reserveAsset: number;
  /** Swap fee, base 10_000 (QSwap swapFeeRate = 30 → 0.3%). */
  swapFeeRate: number;
  /** Flat QU: per-operation fee (100_000) + asset transfer fee (QX transferFee, 100). */
  fixedCostQu: number;
}

/** Qx.h rounds the fee up: div(value * rate, 1) + 1. */
const feeOf = (value: number, rate: number) => (rate > 0 ? Math.floor(value * rate) + 1 : 0);

function finish(
  venue: string,
  side: Side,
  qty: number,
  variableNet: number,
  grossQu: number,
  fixed: number,
  referencePrice: number,
  extra: Partial<VenueQuote> = {},
): VenueQuote {
  const netQu = variableNet + (side === "buy" ? fixed : -fixed);
  const gross = grossQu / qty;
  return {
    venue,
    side,
    qty,
    netQu,
    effectivePrice: netQu / qty,
    referencePrice,
    priceImpact: side === "buy" ? gross / referencePrice - 1 : 1 - gross / referencePrice,
    feesQu: Math.abs(variableNet - grossQu),
    fixedCostQu: fixed,
    warnings: [],
    ...extra,
  };
}

export class QxVenue implements Venue {
  readonly name = "QX";
  readonly fixedCostQu: number;
  private cfg: QxConfig;
  constructor(cfg: QxConfig) {
    this.cfg = cfg;
    this.fixedCostQu = cfg.fixedCostQu;
  }

  /** The resting orders as they were read, for showing the book. */
  book(): { asks: BookLevel[]; bids: BookLevel[]; truncated: boolean } {
    return { asks: this.cfg.asks.map((l) => ({ ...l })), bids: this.cfg.bids.map((l) => ({ ...l })), truncated: !!this.cfg.truncated };
  }

  private levels(side: Side): BookLevel[] {
    return [...(side === "buy" ? this.cfg.asks : this.cfg.bids)]
      .filter((l) => l.qty > 0)
      .sort((a, b) => (side === "buy" ? a.price - b.price : b.price - a.price));
  }

  /** Walks the book order by order, charging the fee per match like the contract. */
  private walk(side: Side, qty: number) {
    const rate = side === "buy" ? this.cfg.buyerFeeRate : this.cfg.sellerFeeRate;
    let left = qty;
    let gross = 0;
    let fees = 0;
    let levelsUsed = 0;
    let worstPrice = 0;
    for (const l of this.levels(side)) {
      if (left <= 0) break;
      const take = Math.min(left, l.qty);
      const value = take * l.price;
      gross += value;
      fees += feeOf(value, rate);
      left -= take;
      levelsUsed++;
      worstPrice = l.price;
    }
    return { filled: left <= 0, gross, fees, levelsUsed, worstPrice };
  }

  /** Total shares resting on the side we would hit. */
  depth(side: Side): number {
    return (side === "buy" ? this.cfg.asks : this.cfg.bids).reduce((s, l) => s + l.qty, 0);
  }

  variableNetQu(side: Side, qty: number): number {
    if (qty <= 0) return 0;
    const w = this.walk(side, qty);
    if (!w.filled) return Infinity;
    return side === "buy" ? w.gross + w.fees : w.gross - w.fees;
  }

  quote(side: Side, qty: number): VenueQuote | null {
    const w = this.walk(side, qty);
    if (!w.filled) return null;
    const lv = this.levels(side);
    const raw = side === "buy" ? this.cfg.asks : this.cfg.bids;
    const net = side === "buy" ? w.gross + w.fees : w.gross - w.fees;
    const warnings: string[] = [];
    if (this.cfg.truncated || (this.cfg.truncated === undefined && raw.length >= QX_MAX_ORDERS_PER_QUERY))
      warnings.push(`QX book has ${raw.length}+ orders (fetch cap): more depth may exist beyond what was fetched`);
    const q = finish(this.name, side, qty, net, w.gross, this.fixedCostQu, lv[0].price, {
      limitPrice: w.worstPrice,
      depth: { levelsUsed: w.levelsUsed, qtyAvailable: this.depth(side) },
      warnings,
    });
    q.feesQu = w.fees;
    return q;
  }
}

/**
 * The least QU a QSwap BUY may need. In Qswap.h's SwapQuForExactAsset, when the QU the swap needs is under its protocol fee (36 QU:
 * a minimum swap fee of 100 split 27, 5, 3 and 1), the contract refunds only that small amount and KEEPS the rest of what was
 * attached, including the flat 100,000 QU. A buy that small (a couple of units of a cheap token) would lose the user 100,000 QU, so
 * QMax never offers one to be signed (`route` refuses it; see `RouteOptions.allowTinyQswapBuy`); 1,000 leaves a wide margin for the
 * pool moving between quote and execution. The venue still prices any size, because other code (the arbitrage search, the swap
 * planner's size search) needs to. Sells refund the flat fee on every failure and have no such trap.
 */
export const QSWAP_MIN_BUY_QU = 1_000;

export class QswapVenue implements Venue {
  readonly name = "QSwap";
  readonly fixedCostQu: number;
  private cfg: QswapConfig;
  constructor(cfg: QswapConfig) {
    this.cfg = cfg;
    this.fixedCostQu = cfg.fixedCostQu;
  }

  /** The pool as it was read, for showing it. */
  pool(): { reserveQu: number; reserveAsset: number; swapFeeRate: number } {
    return { reserveQu: this.cfg.reserveQu, reserveAsset: this.cfg.reserveAsset, swapFeeRate: this.cfg.swapFeeRate };
  }

  /**
   * Mirrors Qswap.h integer math (BigInt: reserve * amount * 10_000 overflows 2^53).
   * Buy  = QuoteExactAssetOutput: fee on the QU input, rounded up.
   * Sell = QuoteExactAssetInput: constant-product output, then fee deducted from the QU out.
   */
  private calc(side: Side, qty: number): { net: number; gross: number } {
    const x = BigInt(Math.round(this.cfg.reserveQu));
    const y = BigInt(Math.round(this.cfg.reserveAsset));
    const f = BigInt(this.cfg.swapFeeRate);
    const q = BigInt(qty);
    if (side === "buy") {
      if (q >= y) return { net: Infinity, gross: Infinity };
      const net = (x * q * 10000n) / ((y - q) * (10000n - f)) + 1n;
      return { net: Number(net), gross: Number((x * q) / (y - q)) };
    }
    const gross = (x * q) / (y + q);
    return { net: Number((gross * (10000n - f)) / 10000n), gross: Number(gross) };
  }

  variableNetQu(side: Side, qty: number): number {
    if (qty <= 0) return 0;
    return this.calc(side, qty).net;
  }

  quote(side: Side, qty: number): VenueQuote | null {
    const { net, gross } = this.calc(side, qty);
    if (!Number.isFinite(net)) return null;
    const ref = this.cfg.reserveQu / this.cfg.reserveAsset;
    return finish(this.name, side, qty, net, gross, this.fixedCostQu, ref);
  }
}
