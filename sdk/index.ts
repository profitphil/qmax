/**
 * QMax SDK: a typed client for the QMax API, plus the pieces needed to turn a quote into the
 * transactions a wallet signs and to send a user to QMax's own trade screen.
 */
export { QMaxClient, QMaxError } from "./client.ts";
export type { AccountInfo, NewKey, QMaxOptions, QuoteRequest } from "./client.ts";

export type { ArbitrageResult, AssetItem, BookResponse, BookView, Candle, CandlesResponse, HistoryResponse, QuoteResponse, Sample, TradeCandle } from "../src/apitypes.ts";

// Charts as SVG text, from a book or a price history, for showing in a page or turning into a picture.
export { candleChartSvg, depthChartSvg, priceChartSvg } from "../src/chart.ts";
export { premiumChartSvg } from "../src/premiumchart.ts";
export type { PremiumResponse, PremiumBar, PremiumSummary } from "../src/premium.ts";
export type { PoolDetailResponse, PoolItem, PoolsResponse } from "../src/pools.ts";
export { equityChartSvg } from "../src/backtestchart.ts";
export type { BacktestRequest, BacktestResponse, BacktestResult, Strategy } from "../src/backtest.ts";
export type { Grade, Health, HealthAllResponse, HealthFlag, HealthResponse } from "../src/health.ts";
export type { Flow, TapeRow } from "../src/tape.ts";
export type { SwapPlan } from "../src/swap.ts";
export type { Ledger, LedgerEntry, LedgerPosition } from "../src/ledger.ts";
export type { LiquidityPosition, PoolResponse, PoolState, PositionsResponse } from "../src/liquidity.ts";
export { routeSaving, savingHeadline } from "../src/savings.ts";
export type { RouteSaving } from "../src/savings.ts";
export type { ArbFilters } from "../src/arbfilters.ts";
export { NO_FILTERS } from "../src/arbfilters.ts";
export type { TopupTx } from "../src/topup.ts";

// Paying for a session by x402 (see "@qmax/sdk/agent" for the payer that signs with the agent's own key).
export { X402Error, createX402Fetch } from "./x402.ts";
export type { PayRequest, Payer, Payment, X402Fetch, X402FetchOptions } from "./x402.ts";

// Turning a quote into transactions.
export { buildCancelStep, buildExecutionPlan } from "../src/exec.ts";
export type { ExecutableQuote, ExecutionHint, ExecutionPlan, Holdings, TxStep } from "../src/exec.ts";

// Sending a user to QMax with the order filled in.
export { buildDeepLink, parseDeepLink } from "../src/deeplink.ts";
export type { DeepLink } from "../src/deeplink.ts";

import { identityToBytes } from "../src/identity.ts";
import type { TxStep } from "../src/exec.ts";

/**
 * The 32-byte public key a step is sent to. A smart contract is addressed by its index in the first byte
 * (QX is 1, QSwap is 13, QPayhub is 29); a plain identity is decoded from its 60 letters.
 */
export function stepDestinationKey(to: TxStep["to"]): Uint8Array {
  if ("identity" in to) return identityToBytes(to.identity);
  const key = new Uint8Array(32);
  key[0] = to.contractIndex;
  return key;
}
