import type { BookView } from "./book.ts";
import type { Candle, Sample } from "./history.ts";
import type { ExecutableQuote } from "./exec.ts";
import type { TradeCandle } from "./trades.ts";

export type { BookView, Candle, Sample, TradeCandle };

/** Shapes the QMax HTTP API returns. */

export interface QuoteResponse extends ExecutableQuote {
  qty: number;
  filledQty: number;
  fillable: boolean;
  executable: boolean;
  totalQu: number;
  averagePriceQu: number | null;
  slippageBps: number;
  route: (ExecutableQuote["route"][number] & {
    shareOfOrder: number;
    totalQu: number;
    effectivePriceQu: number;
    priceImpact: number;
    feesQu: number;
    fixedCostQu: number;
    depth?: { levelsUsed: number; qtyAvailable: number };
    priceRangeQu?: { best: number; worst: number };
  })[];
  alternatives: { venue: string; fillable: boolean; totalQu: number | null; effectivePriceQu: number | null }[];
  warnings: string[];
  /** When the quote was made (ISO time). A quote is a snapshot: prices move. */
  quotedAt?: string;
  onChainCheck?: { venue: string; differenceQu: number | null }[];
}

export interface AssetItem {
  id: string;
  symbol: string;
  issuer: string;
  category: "contract" | "token";
  venues: ("QX" | "QSwap")[];
  priceQu: number | null;
  liquidityQu: number;
  bestAsk?: number | null;
  bestBid?: number | null;
  askQty?: number | null;
  bidQty?: number | null;
  poolQu?: number | null;
  poolAsset?: number | null;
  /** 'inactive' = no QX order or pool change in the last 2 epochs; 'unknown' = not enough data yet. */
  activity?: "active" | "inactive" | "unknown";
  lastActiveAt?: number | null;
  /** What traded on QX and QSwap together in the last 24 hours and 7 days (QU), and the number of trades in the last 24 hours. Absent when QMax does not keep trade history. */
  volume24hQu?: number;
  volume72hQu?: number;
  volume7dQu?: number;
  trades24h?: number;
  /** How far the price moved in the last 24 hours, in percent (last trade against the price a day before); null with nothing to compare. */
  change24hPct?: number | null;
  /** The same over 72 hours and 7 days (what the list's volume window picks). */
  change72hPct?: number | null;
  change7dPct?: number | null;
  /**
   * The price of the asset's newest QX trade (QU per unit) and when it was (ms), absent for an asset that has never traded on QX; `priceQu` is that same price when there
   * is one. `bookPriceQu` is then the price from the order book or pool (the pool's price, else the middle of the best bid and ask). `probedAt` is when the books were last read (ms).
   */
  bookPriceQu?: number | null;
  lastPriceQu?: number;
  lastTradeAt?: number;
  probedAt?: number;
}

export interface ArbitrageResult {
  asset: string;
  checkedAt: string;
  bothMarkets: boolean;
  opportunity: { direction: "buy-qx-sell-qswap" | "buy-qswap-sell-qx"; qty: number; costQu: number; profitQu: number; profitPct: number } | null;
}


/** The order book and pool of one asset (`GET /v1/book`). */
export interface BookResponse extends BookView {
  asset: string;
  checkedAt: string;
}

/**
 * Prices over time (`GET /v1/history`). Before QMax started recording, the points are rebuilt from the trades the network logged
 * (one hourly average per hour that had trades, marked `src: "trades"`); from then on they are recorded about every 10 minutes.
 */
export interface HistoryResponse {
  asset: string;
  range: string;
  /** The earliest point for this asset (ms since epoch), or null if there is none. */
  since: number | null;
  /** When QMax itself started recording this asset; points before this were rebuilt from trades. Null if nothing is recorded live yet. */
  recordedSince: number | null;
  points: Sample[];
  /** Present when `interval` was asked for. */
  candles?: Candle[];
}

/** Candles of real trades (`GET /v1/candles`): open, high, low, close and the volume, hour by hour at the finest. */
export interface CandlesResponse {
  asset: string;
  range: string;
  /** Candle width. */
  interval: "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
  /** The market the prices come from: QX, QSwap, or both treated as one. */
  venue: "QX" | "QSwap" | "all";
  candles: TradeCandle[];
  /** Set when there were more candles than one answer holds (5,000): these are the latest, and `available` is how many there were. */
  truncated?: boolean;
  available?: number;
  /** What traded on both venues in the last 24 hours (to the hour). */
  volume24hQu: number;
  trades24h: number;
}
