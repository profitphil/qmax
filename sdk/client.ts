import type { ArbFilters } from "../src/arbfilters.ts";
import { arbQuery } from "../src/arbfilters.ts";
import type { ArbitrageResult, AssetItem, BookResponse, CandlesResponse, HistoryResponse, QuoteResponse } from "../src/apitypes.ts";
import type { PoolDetailResponse, PoolsResponse } from "../src/pools.ts";
import type { PremiumResponse } from "../src/premium.ts";
import type { BacktestRequest, BacktestResponse } from "../src/backtest.ts";
import type { HealthAllResponse, HealthResponse } from "../src/health.ts";
import type { Flow, TapeRow } from "../src/tape.ts";
import type { PoolResponse, PositionsResponse } from "../src/liquidity.ts";
import type { SwapPlan } from "../src/swap.ts";
import type { MaxPlan } from "../src/maxplan.ts";
import type { Ledger } from "../src/ledger.ts";
import type { TopupTx } from "../src/topup.ts";

export interface QMaxOptions {
  /** Where the QMax API is served, e.g. "https://api.qmax.example". */
  baseUrl: string;
  /** Your API key. Keep it on your server: anyone holding it can spend your prepaid balance. */
  apiKey?: string;
  /** Replace for tests or a custom HTTP stack. */
  fetch?: typeof fetch;
}

export interface QuoteRequest {
  side: "buy" | "sell";
  asset: string;
  qty: number;
  /** Price movement allowed between quote and fill; applied to the limits in `route[].execution`. Default 100 (1%). */
  slippageBps?: number;
  /** False prices the best single venue only. That is always free; a split across both venues is billed. */
  split?: boolean;
}

/** An error from the API. A `402` carries what the call would have been worth (`body.splitWouldSaveQu`, `body.opportunityProfitQu`) or what a Max plan costs (`body.priceQu`). */
export class QMaxError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `QMax API ${status}`);
    this.name = "QMaxError";
    this.status = status;
    this.body = body;
  }
  /** True when the prepaid balance is too low for this call. */
  get needsTopup() {
    return this.status === 402;
  }
}

export interface MaxRequest {
  asset: string;
  side: "buy" | "sell";
  /** How many units. Without it Max plans for all the wallet can buy (needs `balanceQu`) or all it holds (needs `heldQty`). */
  qty?: number;
  /** QU in the wallet: what a buy or an arbitrage may spend. */
  balanceQu?: number;
  /** Units the wallet can sell here. */
  heldQty?: number;
  /** What each held unit cost, for the profit of an exit. */
  avgCostQu?: number;
  /** Price movement allowed between quote and fill. Default 100 (1%). */
  slippageBps?: number;
}

export interface AccountInfo {
  keyId: string;
  balanceQu: number;
  calls: number;
  /** In a server that bills every metered result: what a split quote and an arbitrage result cost. Absent where only Max is sold. */
  splitPriceQu?: number;
  arbitragePriceQu?: number;
  /** Where only Max plans are sold (everything else free): what one costs, in QU. */
  maxPriceQu?: number;
  minTopupQu: number;
}

export interface NewKey {
  key: string;
  keyId: string;
  balanceQu: number;
  splitPriceQu?: number;
  arbitragePriceQu?: number;
  maxPriceQu?: number;
  minTopupQu: number;
}

export class QMaxClient {
  private base: string;
  private apiKey?: string;
  private fetchFn: typeof fetch;

  constructor(opts: QMaxOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    // Called through a wrapper on purpose: a browser's fetch throws "Illegal invocation" when it is called as a method of this object.
    const f = opts.fetch;
    this.fetchFn = f ? (input, init) => f(input, init) : (input, init) => fetch(input, init);
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { ...(init.body ? { "content-type": "application/json" } : {}), ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) };
    // With a key, a redirect is refused: fetch forwards custom headers (x-api-key) to wherever it is sent, which could be another host.
    const res = await this.fetchFn(this.base + path, { ...init, headers, ...(this.apiKey ? { redirect: "error" as const } : {}) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new QMaxError(res.status, body);
    return body as T;
  }

  /** The best route for an order. A split across QX and QSwap is billed to your key; anything else is free. */
  quote(req: QuoteRequest): Promise<QuoteResponse> {
    const q = new URLSearchParams({ side: req.side, asset: req.asset, qty: String(req.qty), slippageBps: String(req.slippageBps ?? 100) });
    if (req.split === false) q.set("split", "false");
    return this.call(`/v1/quote?${q}`);
  }

  /** A live arbitrage check, optionally with filters (minimum profit, minimum percentage, budget). Billed only when one is found. */
  arbitrage(asset: string, filters: Partial<ArbFilters> = {}): Promise<ArbitrageResult> {
    return this.call(`/v1/arbitrage?${new URLSearchParams({ asset })}&${arbQuery(filters)}`);
  }

  /**
   * Max: the best position for a trade, not just the best route (the best way to execute, the best size, an arbitrage sized to the wallet, the best exit for what is held).
   * Nothing is signed or sent. **A plan costs QU for agents** (100 QU at qmax.exchange): taken from your key's balance once the plan is made, or free inside an x402 session;
   * without either the call fails with a 402 that carries `body.priceQu`.
   */
  max(req: MaxRequest): Promise<MaxPlan> {
    const q = new URLSearchParams({ asset: req.asset, side: req.side });
    for (const [k, v] of Object.entries({ qty: req.qty, balanceQu: req.balanceQu, heldQty: req.heldQty, avgCostQu: req.avgCostQu, slippageBps: req.slippageBps })) if (v !== undefined) q.set(k, String(v));
    return this.call(`/v1/max?${q}`);
  }

  /** The QX order book (grouped by price, with cumulative size and the spread) and the QSwap pool (price and how far bigger trades move it). Free; limited per IP without a key. */
  book(asset: string, levels = 15): Promise<BookResponse> {
    return this.call(`/v1/book?${new URLSearchParams({ asset, levels: String(levels) })}`);
  }

  /**
   * Candles of real trades with volume: open, high, low, close, QU volume and trade count per candle. `interval` defaults to a
   * width that suits the range; `venue` is one market or "all" to treat QX and QSwap as one ("auto" follows the live price).
   */
  candles(asset: string, range: "1d" | "7d" | "30d" | "90d" | "all" = "7d", opts: { interval?: "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d"; venue?: "auto" | "QX" | "QSwap" | "all" } = {}): Promise<CandlesResponse> {
    const q = new URLSearchParams({ asset, range });
    if (opts.interval) q.set("interval", opts.interval);
    if (opts.venue) q.set("venue", opts.venue);
    return this.call(`/v1/candles?${q}`);
  }

  /**
   * How far apart QX and QSwap prices were, hour by hour, and how often the gap was wider than the trading costs. An upper bound,
   * not a profit: hourly averages leave out the QX spread and the delay between the two legs. `carry` lets a price stand for up
   * to that many hours (0 to 3) so thinly traded assets have more comparable hours.
   */
  premium(asset: string, range: "7d" | "30d" | "90d" | "all" = "30d", opts: { referenceQu?: number; carry?: number } = {}): Promise<PremiumResponse> {
    const q = new URLSearchParams({ asset, range });
    if (opts.referenceQu !== undefined) q.set("referenceQu", String(opts.referenceQu));
    if (opts.carry !== undefined) q.set("carry", String(opts.carry));
    return this.call(`/v1/premium?${q}`);
  }

  /** Every QSwap pool ranked by what it really earned in fees from swap volume (a trailing estimate), with price change and impermanent loss. */
  pools(opts: { window?: "7d" | "30d"; sort?: "apr" | "tvl" | "volume" } = {}): Promise<PoolsResponse> {
    const q = new URLSearchParams();
    if (opts.window) q.set("window", opts.window);
    if (opts.sort) q.set("sort", opts.sort);
    return this.call(`/v1/pools?${q}`);
  }

  /** One pool in detail; give `positionQu` to estimate fees and impermanent loss for a deposit of that size. */
  poolDetail(asset: string, opts: { window?: "7d" | "30d"; positionQu?: number } = {}): Promise<PoolDetailResponse> {
    const q = new URLSearchParams({ asset });
    if (opts.window) q.set("window", opts.window);
    if (opts.positionQu !== undefined) q.set("positionQu", String(opts.positionQu));
    return this.call(`/v1/pools/detail?${q}`);
  }

  /**
   * Replays a simple strategy (hold, dca or bands) over real hourly trade data with the venues' real fees, and says what it would
   * have done. No order book depth is in the history, so it is optimistic for large amounts: read `warnings` in the result.
   */
  backtest(req: BacktestRequest): Promise<BacktestResponse> {
    return this.call("/v1/backtest", { method: "POST", body: JSON.stringify(req) });
  }

  /**
   * How safe an asset is to trade: a 0 to 100 score and an A to E grade from the order book, the pool and six months of trades,
   * with flags ('thin-book', 'wide-spread', 'wash-suspected', ...) and plain-English reasons. An automated estimate from public
   * data, not advice. 'wash-suspected' needs strong evidence (one wallet churning tiny same-size swaps), so its absence is not a clean bill of health.
   */
  health(asset: string): Promise<HealthResponse> {
    return this.call(`/v1/health?${new URLSearchParams({ asset })}`);
  }

  /** The grade, score, flags and top reason for every asset in one call. */
  healthAll(): Promise<HealthAllResponse> {
    return this.call("/v1/health/all");
  }

  /**
   * The latest trades on QX and QSwap in one feed, newest first, each with its direction (the taker's: buy or sell) when known,
   * plus the last 24 hours of buy and sell pressure. Pass `since` (the `latestId` you last saw) to get only newer rows; ids restart
   * when `instance` changes. Served from memory, so cheap to poll every few seconds.
   */
  tape(o: { asset?: string; limit?: number; since?: number; venue?: "QX" | "QSwap" } = {}): Promise<{ trades: TapeRow[]; latestId: number; instance: string; flow24h: Flow }> {
    const q = new URLSearchParams();
    if (o.asset) q.set("asset", o.asset);
    if (o.limit !== undefined) q.set("limit", String(o.limit));
    if (o.since !== undefined) q.set("since", String(o.since));
    if (o.venue) q.set("venue", o.venue);
    return this.call(`/v1/tape?${q}`);
  }

  /** Buy versus sell volume (QU and units), trade counts and net pressure over the last hour or 24 hours, for one asset or all. */
  flow(o: { asset?: string; window?: "1h" | "24h"; venue?: "QX" | "QSwap" } = {}): Promise<Flow & { asset: string | null; venue: string | null; window: string }> {
    const q = new URLSearchParams();
    if (o.asset) q.set("asset", o.asset);
    if (o.window) q.set("window", o.window);
    if (o.venue) q.set("venue", o.venue);
    return this.call(`/v1/flow?${q}`);
  }

  /**
   * Plans a token-to-token swap (sell `from`, buy `to` with the QU) as two linked trades: both quotes, the QU needed up front for the
   * first leg's flat fees, the expected amount of `to` and the amount guaranteed by the limits (only if neither price moves past
   * the slippage limit). With `compare: true` it also plans the same swap forced onto each single market and returns `bestDeal`: what
   * QMax's route is worth against each, counting the QU left over and the fees paid up front (slower: several plans). Read-only: nothing is signed. The second leg must be re-sized from the wallet's real balance after the
   * first confirms (`fitBuyToBalance`), because the proceeds are only known then.
   */
  swapQuote(p: { from: string; to: string; qty: number; slippageBps?: number; compare?: boolean }): Promise<SwapPlan> {
    return this.call("/v1/swap-quote", { method: "POST", body: JSON.stringify(p) });
  }

  /**
   * A wallet's trade ledger on QX and QSwap, rebuilt from on-chain transfers: every buy and sell with price, fees, position, average-cost
   * profit and loss. Public chain data, so any identity works. It reads the archive heavily (a few seconds, up to about 30 requests).
   * Estimated: read `warnings` and `truncated` in the result (the archive has a gap in June 2026, and units that arrived before the
   * window or by transfer have no known cost).
   */
  ledger(identity: string, opts: { days?: number } = {}): Promise<Ledger> {
    const q = new URLSearchParams({ identity });
    if (opts.days !== undefined) q.set("days", String(opts.days));
    return this.call(`/v1/ledger?${q}`);
  }

  /**
   * A wallet's QSwap liquidity: every pool it has a share of, with its liquidity units, share of the pool, what removing it all would pay
   * and its value in QU, read live from the contract (cached 30 s; `fresh: true` skips a cached answer older than a few seconds, for right after adding or removing). Public chain data, so any identity works. Read-only: `complete` is
   * false when a pool could not be read, in which case its positions are missing from the list.
   */
  liquidityPositions(identity: string, opts: { fresh?: boolean } = {}): Promise<PositionsResponse> {
    return this.call(`/v1/liquidity/positions?${new URLSearchParams(opts.fresh ? { identity, fresh: "1" } : { identity })}`);
  }

  /** One QSwap pool's live state (reserves, total liquidity, price and the flat fee), read from the contract. Read-only. */
  liquidityPool(asset: string): Promise<PoolResponse> {
    return this.call(`/v1/liquidity/pool?${new URLSearchParams({ asset })}`);
  }

  /** The same ledger as a CSV (date, tx hash, kind, venue, asset, quantity, price, QU net, estimated fee, position, realized P&L), followed by a positions table. */
  async ledgerCsv(identity: string, opts: { days?: number } = {}): Promise<string> {
    const q = new URLSearchParams({ identity, format: "csv" });
    if (opts.days !== undefined) q.set("days", String(opts.days));
    const res = await this.fetchFn(`${this.base}/v1/ledger?${q}`, { headers: this.apiKey ? { "x-api-key": this.apiKey } : {}, ...(this.apiKey ? { redirect: "error" as const } : {}) });
    if (!res.ok) throw new QMaxError(res.status, (await res.json().catch(() => ({}))) as Record<string, unknown>);
    return res.text();
  }

  /** Prices over time: rebuilt from past trades before the server started recording (hourly averages, marked `src: "trades"`), recorded about every 10 minutes after. `interval` also returns open/high/low/close candles of the points. Free; limited per IP without a key. */
  history(asset: string, range: "1d" | "7d" | "30d" | "90d" | "all" = "7d", interval?: "1h" | "4h" | "1d"): Promise<HistoryResponse> {
    const q = new URLSearchParams({ asset, range });
    if (interval) q.set("interval", interval);
    return this.call(`/v1/history?${q}`);
  }

  /** Tradable assets, most liquid first. Free. */
  async assets(opts: { q?: string; category?: "contract" | "token" } = {}): Promise<AssetItem[]> {
    const q = new URLSearchParams();
    if (opts.q) q.set("q", opts.q);
    if (opts.category) q.set("category", opts.category);
    return (await this.call<{ assets: AssetItem[] }>(`/v1/assets?${q}`)).assets;
  }

  /** A new key with a balance of 0. The key is shown once: store it. */
  createKey(): Promise<NewKey> {
    return this.call("/v1/keys", { method: "POST" });
  }

  /** Your balance and the prices. */
  account(): Promise<AccountInfo> {
    return this.call("/v1/account");
  }

  /** The QPayhub payment that adds `amountQu` to a key. Sign and broadcast it from any wallet, then call `claimTopup`. */
  topupTransaction(keyId: string, amountQu: number, nonce?: string): Promise<TopupTx> {
    const q = new URLSearchParams({ keyId, amountQu: String(amountQu) });
    if (nonce) q.set("nonce", nonce);
    return this.call(`/v1/topup?${q}`);
  }

  /** Credits a confirmed top-up. `payer` is the identity that signed the payment and `nonce` comes from `topupTransaction`. */
  claimTopup(p: { keyId: string; payer: string; nonce: string }): Promise<{ ok: true; creditedQu: number; balanceQu: number }> {
    return this.call("/v1/topup/claim", { method: "POST", body: JSON.stringify(p) });
  }
}
