import { z } from "zod";
import { QMaxError, buildExecutionPlan, routeSaving, savingHeadline } from "../sdk/index.ts";
import type { QMaxClient, QuoteResponse } from "../sdk/index.ts";
import { checkQuotePlan } from "../src/plancheck.ts";

/** What QX and QSwap charge for moving shares, read from the network (never from the quote). Replaceable for tests. */
let feeReader: () => Promise<{ qx: number; qswap: number }> = async () => (await import("../web/exec/chain.ts")).fetchFees();
export const setFeeReader = (f: typeof feeReader) => {
  feeReader = f;
};

/**
 * The tools QMax gives an AI agent. Every one reads public market data except `qmax_build_plan`, which only describes the
 * transactions a quote needs: nothing here signs or sends anything, and no tool moves funds. An agent that wants to trade
 * signs the returned steps with its own wallet (or uses `@qmax/sdk/agent`, which has spending limits built in).
 */

/** The part of the SDK client the tools use, so tests can stand in for the network. */
export type QMaxApi = Pick<QMaxClient, "assets" | "quote" | "arbitrage" | "book" | "candles" | "history" | "premium" | "pools" | "poolDetail" | "backtest" | "health" | "healthAll" | "tape" | "flow" | "swapQuote" | "ledger" | "liquidityPositions" | "liquidityPool" | "max">;

/** Replies longer than this are trimmed (the longest lists lose their oldest entries) so one call cannot fill an agent's context. */
export const CHARACTER_LIMIT = 40_000;

export interface Tool {
  name: string;
  title: string;
  description: string;
  /** Costs QU each time it is called (the server's price for the call): not marked idempotent, and the description says so. */
  paid?: boolean;
  input: z.ZodRawShape;
  run(args: Record<string, unknown>, api: QMaxApi): Promise<unknown>;
}

const asset = z.string().min(1).max(32).describe("Asset symbol, for example CFB or QDOGE (case does not matter). Use qmax_list_assets to find one.");
const range = z.enum(["1d", "7d", "30d", "90d", "all"]).default("7d").describe("How far back to look. 'all' is everything QMax has (about six months).");
const venue = z.enum(["auto", "QX", "QSwap", "all"]).default("auto").describe("Which market's prices: QX (order book), QSwap (pool), 'all' (treat both as one market), or 'auto' (the market the live price comes from).");

const tools: Tool[] = [
  {
    name: "qmax_list_assets",
    title: "List or search tradable Qubic assets",
    description: `Lists assets that trade on QX and/or QSwap, most liquid first, or searches by symbol.

Use this first to find the right asset symbol and to see which markets it trades on ('QX', 'QSwap' or both: only assets on both can be split for a better price).

Returns: { count, assets: [{ id, symbol, category ('contract' shares or 'token'), venues, priceQu, liquidityQu, activity }] }. Prices are QU per unit.`,
    input: {
      query: z.string().max(32).optional().describe("Part of a symbol to search for, e.g. 'QD'"),
      category: z.enum(["contract", "token"]).optional().describe("Only smart-contract shares or only tokens"),
      limit: z.number().int().min(1).max(100).default(25).describe("Most assets to return"),
    },
    async run(a, api) {
      const list = await api.assets({ q: a.query as string | undefined, category: a.category as "contract" | "token" | undefined });
      const limit = Number(a.limit ?? 25);
      return {
        count: list.length,
        assets: list.slice(0, limit).map((x) => ({ id: x.id, symbol: x.symbol, category: x.category, venues: x.venues, priceQu: x.priceQu, liquidityQu: x.liquidityQu, activity: x.activity })),
        ...(list.length > limit ? { note: `Showing ${limit} of ${list.length}; narrow with query or category.` } : {}),
      };
    },
  },
  {
    name: "qmax_get_quote",
    title: "Quote a buy or sell across QX and QSwap",
    description: `Prices an order and finds the cheapest route across the QX order book and the QSwap pool, splitting the order across both when that is cheaper. Nothing is placed.

Returns the total in QU, the average price, each leg (venue, quantity, price range, fees, price impact), what each single market alone would cost, a plain-English line saying what the routing saved, and warnings. All amounts are QU; quantities are whole units. The quote is a snapshot: prices move, so re-quote before acting.`,
    input: {
      side: z.enum(["buy", "sell"]),
      asset,
      qty: z.number().int().min(1).describe("How many units of the asset"),
      slippage_bps: z.number().int().min(0).max(1000).default(100).describe("Slippage tolerance in basis points (100 = 1%), applied to the limits in route[].execution"),
      split: z.boolean().default(true).describe("false prices the best single market only"),
    },
    async run(a, api) {
      const q = await api.quote({ side: a.side as "buy" | "sell", asset: String(a.asset), qty: Number(a.qty), slippageBps: Number(a.slippage_bps ?? 100), split: a.split !== false });
      return summarizeQuote(q);
    },
  },
  {
    name: "qmax_build_plan",
    title: "Build the unsigned transactions for a trade",
    description: `Quotes an order and returns the exact transactions a wallet must sign to carry it out, in order. QMax signs nothing and sends nothing: you (or the user) sign each step with your own wallet and broadcast it.

Steps (in order): any share-management move needed first (selling shares that the other market manages), then one call per market. Each step: kind, description, destination (a smart contract by index), inputType (procedure number), amountQu to attach (QU that may leave the wallet; unused QU is refunded by the contracts) and payloadBase64 (the call's input bytes). 'maxOutlayQu' is the most QU that can leave the wallet across all steps, so check it against your own spending limit BEFORE signing. Sending a step moves real funds.

For a sell, pass how many shares the wallet holds under QX management and under QSwap management (holdings_qx, holdings_qswap) so the right moves are planned. Buys need no holdings.`,
    input: {
      side: z.enum(["buy", "sell"]),
      asset,
      qty: z.number().int().min(1),
      slippage_bps: z.number().int().min(0).max(1000).default(100),
      holdings_qx: z.number().int().min(0).default(0).describe("Selling only: units of this asset the wallet holds that QX manages"),
      holdings_qswap: z.number().int().min(0).default(0).describe("Selling only: units of this asset the wallet holds that QSwap manages"),
    },
    async run(a, api) {
      const q = await api.quote({ side: a.side as "buy" | "sell", asset: String(a.asset), qty: Number(a.qty), slippageBps: Number(a.slippage_bps ?? 100) });
      if (!q.executable) throw new Error("This server is showing demo data, so it cannot plan real transactions.");
      if (!q.fillable) throw new Error(`This order cannot be filled at current liquidity (${q.warnings[0] ?? "not enough depth"}). Try a smaller quantity.`);
      const onChainFees = await feeReader().catch(() => undefined);
      const trusted = onChainFees ? { ...q, assetInfo: { ...q.assetInfo, transferFeeQu: onChainFees } } : q;
      const plan = buildExecutionPlan(trusted, { 1: Number(a.holdings_qx ?? 0), 13: Number(a.holdings_qswap ?? 0) });
      // The steps are described from what the server answered: they are checked against what was asked for first, so a quote that would sign for another
      // asset, side or size, or with limits looser than the slippage, is refused instead of being handed to an agent as a plan.
      const check = checkQuotePlan(trusted, plan, { side: a.side as "buy" | "sell", qty: Number(a.qty), assetName: String(a.asset).split(".")[0], slippageBps: Number(a.slippage_bps ?? 100), onChainFees });
      if (check.problems.length) throw new Error(`QMax's answer does not match what you asked for, so no plan is given: ${check.problems.join("; ")}.`);
      return {
        // What the steps really trade, from the payload's own asset (the label above comes from the same server, the issuer below is what is signed).
        signedAsset: { name: trusted.assetInfo.assetName, issuer: trusted.assetInfo.issuer },
        ...(check.warnings.length ? { checkWarnings: check.warnings } : {}),
        ...summarizeQuote(q),
        maxOutlayQu: plan.maxOutlayQu,
        steps: plan.steps.map((s) => ({
          id: s.id,
          kind: s.kind,
          description: s.description,
          to: s.to,
          inputType: s.inputType,
          amountQu: s.amountQu,
          payloadBase64: Buffer.from(s.payload).toString("base64"),
        })),
        warning: "UNSIGNED. These steps move real funds when signed and sent, one at a time and in order (wait for each to confirm). Stop at the first failure. Check maxOutlayQu against your own limit first.",
      };
    },
  },
  {
    name: "qmax_get_health",
    title: "How safe an asset is to trade",
    description: `A 0 to 100 score and A to E grade for an asset, from its QX order book, its QSwap pool and six months of trades, with flags and plain-English reasons (most important first).

Flags include thin-book, wide-spread, quiet, few-trades, new-listing, volume-spike, one-sided, pool-dominated and wash-suspected / bot-burst (a single wallet churning tiny same-size swaps against itself, which inflates trade counts but not volume). Many assets grade D or E because QX markets are thin: that is information, not an error. It is an automated estimate from public data and NOT advice; the absence of 'wash-suspected' is not proof of a clean market (large wash trades are not detectable from this data). Omit 'asset' to get every asset's grade in one call.`,
    input: { asset: asset.optional().describe("Leave out for all assets (grade, score, flags, top reason each)") },
    async run(a, api) {
      return a.asset ? api.health(String(a.asset)) : api.healthAll();
    },
  },
  {
    name: "qmax_get_tape",
    title: "Latest trades on QX and QSwap",
    description: `The most recent trades on both markets in one feed, newest first: time, market, asset, quantity, QU, price and direction. The direction is the TAKER's side (the person who started the trade): 'buy' or 'sell'. Rows also carry the transaction hash. The answer includes 'flow24h', the last 24 hours of buy versus sell volume, and 'latestId': pass it back as 'since' to get only newer trades. Served from memory, so cheap to poll.`,
    input: { asset: asset.optional().describe("Only this asset (leave out for all)"), limit: z.number().int().min(1).max(200).default(30), since: z.number().int().min(0).optional().describe("Only trades newer than this id (the latestId from an earlier call)"), venue: z.enum(["QX", "QSwap"]).optional() },
    async run(a, api) {
      return api.tape({ asset: a.asset as string | undefined, limit: Number(a.limit ?? 30), since: a.since as number | undefined, venue: a.venue as "QX" | undefined });
    },
  },
  {
    name: "qmax_get_flow",
    title: "Buy versus sell pressure",
    description: `Buy and sell volume (QU and units), trade counts and net pressure (positive = more buying) over the last hour or 24 hours, for one asset or the whole market. Direction is the taker's side. 'partial' is true while the server is still loading the window.`,
    input: { asset: asset.optional(), window: z.enum(["1h", "24h"]).default("24h"), venue: z.enum(["QX", "QSwap"]).optional() },
    async run(a, api) {
      return api.flow({ asset: a.asset as string | undefined, window: a.window as "24h", venue: a.venue as "QX" | undefined });
    },
  },
  {
    name: "qmax_swap_quote",
    title: "Plan a token-to-token swap",
    description: `Plans swapping one token for another as two linked trades: sell 'from' for QU (leg 1), then buy 'to' with the QU (leg 2), each routed across QX and QSwap by the best route. Read-only: nothing is signed.

Returns both quotes, 'upfrontQu' (QU the wallet must hold BEFORE leg 1 for its flat fees), 'expectedOutQty' (what you should get) and 'minOutQty' (guaranteed by the limits only if neither price moves past the slippage limit), plus warnings. Leg 2 can only be sized exactly after leg 1 settles, from the wallet's real balance, so a swap is never one atomic transaction: if leg 1 completes and leg 2 cannot proceed you are left holding QU. Both tokens must trade on QX or QSwap; QU itself is not a swap leg (use qmax_get_quote).`,
    input: { from: asset.describe("Token to sell"), to: asset.describe("Token to buy"), qty: z.number().int().min(1).describe("How many units of 'from' to sell"), slippage_bps: z.number().int().min(0).max(1000).default(100), compare: z.boolean().default(false).describe("Also plan the same swap forced onto each single market (QX or QSwap per leg) and say what QMax's route is worth against them (bestDeal). Slower.") },
    async run(a, api) {
      return api.swapQuote({ from: String(a.from), to: String(a.to), qty: Number(a.qty), slippageBps: Number(a.slippage_bps ?? 100), compare: a.compare === true });
    },
  },
  {
    name: "qmax_get_wallet_ledger",
    title: "A wallet's QX and QSwap trade ledger",
    description: `Every QX and QSwap buy and sell a wallet made (read from public on-chain transfers, so any 60-letter identity works): price, QU net of fees, estimated fees, running position, and average-cost realized profit, plus current positions with unrealized profit and loss.

ESTIMATED. Read 'warnings' and 'truncated': the archive has no events for about 10 to 14 June 2026, units that arrived before the window or by transfer have no known cost (selling them is not counted as profit), and QSwap liquidity changes appear as transfers. Unrealized P&L uses the mid or pool price, which can mislead on thin markets. Takes a few seconds and many archive reads, so ask once and keep the answer. Not tax advice.`,
    input: { identity: z.string().regex(/^[A-Z]{60}$/, "A Qubic identity is 60 uppercase letters").describe("The wallet's 60-letter identity"), days: z.number().int().min(1).max(365).default(180) },
    async run(a, api) {
      const l = await api.ledger(String(a.identity), { days: Number(a.days ?? 180) });
      return { ...l, entries: l.entries.slice(-100), ...(l.entries.length > 100 ? { entriesNote: `Showing the latest 100 of ${l.entries.length} entries; the CSV export (GET /v1/ledger?format=csv) has them all.` } : {}) };
    },
  },
  {
    name: "qmax_get_liquidity_positions",
    title: "A wallet's QSwap liquidity positions",
    description: `Every QSwap pool a wallet has liquidity in (public chain data, so any 60-letter identity works): its liquidity units, share of the pool, what removing it all would pay (QU and tokens, before QSwap's flat 100,000 QU fee) and its value in QU at the pool's own price, read live from the contract. Read-only. Adding or removing liquidity is done in the QMax app with a wallet; this tool never builds or signs one.

Check 'complete': when false, a pool could not be read and its positions are missing. 'earnedFeesQu' is already inside what removing pays, nothing pays it separately. Values are estimates at the pool's price, which can be far from what the tokens sell for on a thin market.`,
    input: { identity: z.string().regex(/^[A-Z]{60}$/, "A Qubic identity is 60 uppercase letters").describe("The wallet's 60-letter identity") },
    async run(a, api) {
      return api.liquidityPositions(String(a.identity));
    },
  },
  {
    name: "qmax_get_liquidity_pool",
    title: "One QSwap pool's live state",
    description: `A QSwap pool's reserves (QU and tokens), total liquidity units and price, read from the contract. Use it to see how deep a pool is before talking about providing liquidity. Adding or removing liquidity each cost a flat 100,000 QU on top of any deposit. Read-only.`,
    input: { asset },
    async run(a, api) {
      return api.liquidityPool(String(a.asset));
    },
  },
  {
    name: "qmax_get_candles",
    title: "Candles and volume from real trades",
    description: `Open, high, low, close, QU volume, units and trade count per candle, built from every trade QX and QSwap logged (a minute wide at the finest; about six months back, which is all the Qubic archive has: its trade records begin in April 2026). A candle exists only where something traded, so a gap means no trades. The response also gives the last 24 hours of volume across both markets.

Returns: { asset, range, interval, venue, candles: [{ t (ms), o, h, l, c, volumeQu, volumeQty, trades }], truncated?, available?, volume24hQu, trades24h }. Prices are QU per unit.`,
    input: { asset, range, interval: z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]).optional().describe("Candle width: a minute up to a day (default suits the range). One answer holds at most the latest 5,000 candles"), venue },
    async run(a, api) {
      return api.candles(String(a.asset), a.range as "7d", { interval: a.interval as "1h" | undefined, venue: a.venue as "auto" });
    },
  },
  {
    name: "qmax_get_price_history",
    title: "Price over time (line)",
    description: `The asset's price over time as points (ms timestamp, price in QU, and for recently recorded points the best bid, ask and pool price). Points before 'recordedSince' were rebuilt from past trades as hourly volume-weighted averages (marked src 'trades'); after it QMax recorded the price about every 10 minutes. Use qmax_get_candles for OHLC and volume.`,
    input: { asset, range },
    async run(a, api) {
      const h = await api.history(String(a.asset), a.range as "7d");
      return { asset: h.asset, range: h.range, since: h.since, recordedSince: h.recordedSince, points: h.points.map((p) => ({ t: p.t, price: p.price, ...(p.src ? { src: p.src } : {}) })) };
    },
  },
  {
    name: "qmax_get_order_book",
    title: "QX order book and QSwap pool",
    description: `What is resting on the QX order book (grouped by price, with cumulative size and cost from the best price outward, best bid/ask, spread) and the QSwap pool (reserves, price, and how far trades of 0.1% to 5% of the pool would move the price). Use it to judge depth before sizing an order.`,
    input: { asset, levels: z.number().int().min(1).max(50).default(15).describe("Price levels per side of the QX book") },
    async run(a, api) {
      return api.book(String(a.asset), Number(a.levels ?? 15));
    },
  },
  {
    name: "qmax_check_arbitrage",
    title: "Check an asset for QX/QSwap arbitrage",
    description: `Searches, live and at full depth, for a profitable buy-on-one-market, sell-on-the-other loop after every venue fee, and returns the most profitable size or null. It is two separate transactions, so the second leg can fill worse than shown; this is a snapshot, not a guarantee. Only assets on both markets can have one. A found result may be billed to the caller's QMax key (50 QU).`,
    input: {
      asset,
      min_profit_qu: z.number().min(0).optional().describe("Only an opportunity with at least this profit (QU)"),
      min_profit_pct: z.number().min(0).optional().describe("Only one with at least this profit as a percentage of the QU put in"),
      max_cost_qu: z.number().min(0).optional().describe("Most QU to put in (a budget); the search returns the best loop that fits"),
    },
    async run(a, api) {
      return api.arbitrage(String(a.asset), { minProfitQu: a.min_profit_qu as number | undefined, minProfitPct: a.min_profit_pct as number | undefined, maxCostQu: a.max_cost_qu as number | undefined });
    },
  },
  {
    name: "qmax_best_position",
    title: "Max: the best position for a trade (costs QU)",
    paid: true,
    description: `Max searches for the best position, not just the best route (a normal quote already takes the best route): the best way to execute (a market order now, a resting limit order at the touch, or both), the size where one more unit starts to cost more, an arbitrage between QX and QSwap sized to the wallet's QU, and, for a sale, what it returns against what the units cost. Each pick is a short list of ordinary actions with what it should give. Nothing is signed or sent; prices move, so quote and check every action again before signing.

COSTS QU: a Max plan costs the server's Max price (100 QU at qmax.exchange), taken from the prepaid key's balance (QMAX_API_KEY) once the plan is made, or free inside an x402 session the server buys with QMAX_AGENT_SEED (which spends real QU, up to QMAX_MAX_SPEND_QU). A request that cannot be planned is not charged. Give the wallet's numbers (balance_qu, held_qty, avg_cost_qu) so the plan fits what it can actually do; they are used only to size the plan.`,
    input: {
      asset,
      side: z.enum(["buy", "sell"]),
      qty: z.number().int().min(1).optional().describe("How many units. Without it Max plans for all the wallet can buy (needs balance_qu) or all it holds (needs held_qty)."),
      balance_qu: z.number().int().min(0).optional().describe("QU in the wallet: what a buy or an arbitrage may spend"),
      held_qty: z.number().int().min(0).optional().describe("Units of the asset the wallet can sell"),
      avg_cost_qu: z.number().int().min(0).optional().describe("What each held unit cost, for the profit of an exit"),
      slippage_bps: z.number().int().min(0).max(1000).default(100).describe("Slippage tolerance in basis points (100 = 1%)"),
    },
    async run(a, api) {
      return api.max({
        asset: String(a.asset),
        side: a.side as "buy" | "sell",
        qty: a.qty as number | undefined,
        balanceQu: a.balance_qu as number | undefined,
        heldQty: a.held_qty as number | undefined,
        avgCostQu: a.avg_cost_qu as number | undefined,
        slippageBps: Number(a.slippage_bps ?? 100),
      });
    },
  },
  {
    name: "qmax_venue_premium",
    title: "How far apart QX and QSwap prices were",
    description: `Hour by hour, the gap between the asset's QX and QSwap prices (positive = QSwap dearer) and how often it was wider than the trading costs for a trade of 'reference_qu'. This is an UPPER BOUND on arbitrage, not a profit: it uses hourly average prices, so it leaves out the QX bid-ask spread (often wider than the costs) and the delay between the two transactions. Returns { bothVenues, breakEvenPct, points, summary, note }.`,
    input: {
      asset,
      range: z.enum(["7d", "30d", "90d", "all"]).default("30d"),
      reference_qu: z.number().min(100_000).max(1e12).optional().describe("Trade size in QU used to work out the break-even gap (default 10,000,000)"),
    },
    async run(a, api) {
      const r = await api.premium(String(a.asset), a.range as "30d", { referenceQu: a.reference_qu as number | undefined });
      return { ...r, points: r.points.length > 200 ? r.points.filter((_, i) => i % Math.ceil(r.points.length / 200) === 0) : r.points };
    },
  },
  {
    name: "qmax_list_pools",
    title: "QSwap pools ranked by real fee income",
    description: `Every QSwap liquidity pool with its TVL, trailing swap volume, estimated fee APR (from real swap volume; only 0.192% of each swap's volume reaches liquidity providers), price change and impermanent loss over the window. A trailing estimate: past fees do not predict future fees, and volume that looks inflated (wash trading) is flagged in each pool's notes.`,
    input: { window: z.enum(["7d", "30d"]).default("7d"), sort: z.enum(["apr", "tvl", "volume"]).default("apr"), limit: z.number().int().min(1).max(50).default(20) },
    async run(a, api) {
      const r = await api.pools({ window: a.window as "7d", sort: a.sort as "apr" });
      return { ...r, pools: r.pools.slice(0, Number(a.limit ?? 20)) };
    },
  },
  {
    name: "qmax_pool_detail",
    title: "One QSwap pool in detail, with a deposit estimate",
    description: `One pool's numbers explained, and for a deposit size (position_qu, the QU value of both sides together) an estimate of fees per day, per 30 days and the impermanent loss for price moves of 10%, 25% and 50%. Adding and removing liquidity each cost a flat 100,000 QU.`,
    input: { asset, window: z.enum(["7d", "30d"]).default("7d"), position_qu: z.number().min(1).max(1e15).optional() },
    async run(a, api) {
      return api.poolDetail(String(a.asset), { window: a.window as "7d", positionQu: a.position_qu as number | undefined });
    },
  },
  {
    name: "qmax_backtest",
    title: "Backtest a simple strategy on real history",
    description: `Replays a strategy over real hourly trade data with the venues' real fees and reports what it would have done: final value, return, buy-and-hold comparison, max drawdown, fees paid, trades. Decisions are made on an hour's close and filled at the next hour's open; hours with no trades cannot be traded.

Strategies: 'hold' (buy once, hold), 'dca' (spend amountQu every everyHours), 'bands' (buy fractionPct of the QU when the price is bandPct below its lookbackHours average, sell fractionPct of the holding when above, with a cooldown). READ 'warnings' in the result: there is no order book depth in the history, so large amounts are optimistic, and QSwap's flat 100,100 QU fee can swallow small trades. Past results do not predict future ones.`,
    input: {
      asset,
      range: z.enum(["30d", "90d", "all"]).default("90d"),
      venue,
      starting_qu: z.number().int().min(1).max(1e12).describe("QU to start with, e.g. 10000000"),
      strategy: z
        .object({
          type: z.enum(["hold", "dca", "bands"]),
          amountQu: z.number().int().optional().describe("dca: QU per purchase, fees included"),
          everyHours: z.number().int().optional().describe("dca: hours between purchases (168 = weekly)"),
          lookbackHours: z.number().int().optional().describe("bands: moving-average window in hours"),
          bandPct: z.number().optional().describe("bands: how far from the average triggers a trade, in %"),
          fractionPct: z.number().optional().describe("bands: share of QU (to buy) or holding (to sell) per trade, in %"),
          cooldownHours: z.number().int().optional().describe("bands: minimum hours between trades"),
        })
        .strict(),
    },
    async run(a, api) {
      const r = await api.backtest({ asset: String(a.asset), range: a.range as "90d", venue: a.venue as "auto", startingQu: Number(a.starting_qu), strategy: a.strategy as never });
      const sample = (xs: unknown[], max: number) => (xs.length > max ? xs.filter((_, i) => i % Math.ceil(xs.length / max) === 0) : xs);
      return { ...r, equity: sample(r.equity, 60), trades: r.trades.slice(-60), ...(r.trades.length > 60 ? { tradesNote: `Showing the last 60 of ${r.trades.length} trades.` } : {}) };
    },
  },
];

export default tools;

/** A quote reduced to what an agent decides with. */
export function summarizeQuote(q: QuoteResponse) {
  const saving = routeSaving(q);
  const headline = saving ? savingHeadline(saving) : null;
  return {
    asset: q.asset,
    side: q.side,
    qty: q.qty,
    fillable: q.fillable,
    totalQu: q.totalQu,
    averagePriceQu: q.averagePriceQu,
    slippageBps: q.slippageBps,
    route: q.route.map((r) => ({ venue: r.venue, qty: r.qty, shareOfOrder: r.shareOfOrder, totalQu: r.totalQu, effectivePriceQu: r.effectivePriceQu, priceImpact: r.priceImpact, feesQu: r.feesQu, fixedCostQu: r.fixedCostQu, ...(r.priceRangeQu ? { priceRangeQu: r.priceRangeQu } : {}), ...(r.execution ? { execution: r.execution } : {}) })),
    alternatives: q.alternatives,
    ...(headline ? { routingSaving: headline } : {}),
    warnings: q.warnings,
    quotedAt: q.quotedAt,
  };
}

/** Trims a result so its JSON fits `limit` characters: the longest list loses its oldest entries until it does. */
export function fit(result: unknown, limit = CHARACTER_LIMIT): { text: string; trimmed: boolean } {
  const { text, trimmed } = fitLists(result, limit);
  if (text.length <= limit) return { text, trimmed };
  // Still too long (a long string, or lists nested deeper than the top level): cut the text itself, so the limit holds whatever is in the answer.
  // The cut text is quoted again inside the answer (every quote and backslash doubles), so it is shortened until the whole thing fits.
  let keep = Math.max(0, limit - 200);
  let out = "";
  do {
    out = JSON.stringify({ _trimmed: "This reply was cut to fit the size limit; ask for something narrower.", partial: text.slice(0, keep) });
    keep = Math.floor(keep * 0.8);
  } while (out.length > limit && keep > 0);
  return { text: out, trimmed: true };
}

function fitLists(result: unknown, limit: number): { text: string; trimmed: boolean } {
  let text = JSON.stringify(result);
  if (text.length <= limit || typeof result !== "object" || result === null) return { text, trimmed: false };
  const copy: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  let trimmed = false;
  for (let guard = 0; guard < 40 && text.length > limit; guard++) {
    const lists = Object.entries(copy).filter((e): e is [string, unknown[]] => Array.isArray(e[1]) && e[1].length > 1);
    if (!lists.length) break;
    const [key, list] = lists.reduce((a, b) => (JSON.stringify(a[1]).length >= JSON.stringify(b[1]).length ? a : b));
    copy[key] = list.slice(Math.ceil(list.length / 2)); // the newest half
    copy._trimmed = "Oldest entries were left out to keep this reply short; ask for a narrower range for the rest.";
    trimmed = true;
    text = JSON.stringify(copy);
  }
  return { text, trimmed };
}

/** An error as an agent should read it: what happened and what to do next. */
export function explain(e: unknown): string {
  if (e instanceof QMaxError) {
    if (e.status === 402 && typeof e.body.priceQu === "number") return `QMax asked for payment (402): ${e.message} Max plans cost ${e.body.priceQu} QU for agents: have the server set QMAX_API_KEY (a prepaid key with a balance) or QMAX_AGENT_SEED (to buy a session by x402).`;
    if (e.status === 402) return `QMax asked for payment (402): ${e.message} The free allowance is used up. Wait a minute, or have the server set QMAX_API_KEY (a prepaid key) or QMAX_AGENT_SEED (to buy a session by x402).`;
    if (e.status === 429) return `QMax says slow down (429): ${e.message}`;
    if (e.status === 404) return `Not found: ${e.message} Use qmax_list_assets to check the symbol.`;
    if (e.status === 400) return `The request was refused: ${e.message}`;
    return `QMax API error ${e.status}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
