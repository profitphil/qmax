export type Side = "buy" | "sell";

/** Result of executing `qty` units of the asset on one venue. All amounts in QU. */
export interface VenueQuote {
  venue: string;
  side: Side;
  qty: number;
  /** Buy: total QU paid. Sell: total QU received. Fees and fixed costs included. */
  netQu: number;
  /** netQu / qty */
  effectivePrice: number;
  /** Price before the trade (pool: reserve ratio; book: best opposite price). */
  referencePrice: number;
  /** Slippage vs referencePrice from curve/book depth only (fees excluded), fraction. */
  priceImpact: number;
  feesQu: number;
  /** Flat cost to use the venue: asset transfer / management / operation fees. */
  fixedCostQu: number;
  /** QX only: worst order-book price this fill reaches (the limit price an order needs). */
  limitPrice?: number;
  /** Order-book depth consumed (QX only). */
  depth?: { levelsUsed: number; qtyAvailable: number };
  warnings: string[];
}

export interface Venue {
  readonly name: string;
  /** Flat QU cost to use this venue at all. */
  readonly fixedCostQu: number;
  /**
   * Black-box quote of variable-only net QU for `qty` (fees included, fixed cost excluded).
   * Infinity if the venue cannot fill `qty`. For QSwap this is one on-chain Quote* call.
   */
  variableNetQu(side: Side, qty: number): number;
  quote(side: Side, qty: number): VenueQuote | null;
}

export interface Allocation {
  venue: string;
  qty: number;
  quote: VenueQuote;
}

export interface RoutePlan {
  side: Side;
  qty: number;
  filledQty: number;
  allocations: Allocation[];
  /** Total QU paid (buy) or received (sell), venue costs. */
  totalNetQu: number;
  averagePrice: number;
  /** Quotes for sending the whole order to a single venue (null if it can't fill). */
  singleVenue: { venue: string; quote: VenueQuote | null }[];
  /** Number of venue quote calls made while searching (a proxy for RPC load). */
  quoteCalls: number;
  warnings: string[];
}
