import { existsSync, readFileSync } from "node:fs";
import { createApi } from "./api.ts";
import type { AssetVolume, TradeSource } from "./api.ts";
import { SnapshotData } from "./data.ts";
import { ActivityIndex } from "./activity.ts";
import { AssetCatalog } from "./catalog.ts";
import { PAYWALL } from "./config.ts";
import { HistoryStore } from "./history.ts";
import { TradeIndex } from "./trades.ts";
import { ImportedHistory, olderCandles } from "./quhub.ts";
import type { Venue } from "./trades.ts";
import type { Route } from "./routes.ts";
import { premiumRoutes } from "./premium.ts";
import { poolsRoutes } from "./pools.ts";
import { backtestRoutes } from "./backtest.ts";
import { createHealth } from "./health.ts";
import { swapRoutes } from "./swap.ts";
import { maxRoutes } from "./maxroutes.ts";
import { llmsRoutes } from "./llms.ts";
import { ledgerRoutes } from "./ledger.ts";
import { liquidityRoutes } from "./liquidity.ts";
import type { SwapQuote } from "./swap.ts";
import { buildQuote } from "./quoteapi.ts";
import type { MarketData } from "./data.ts";
import { TradeTape, catalogSymbolOf, sideResolver, tapeRoutes } from "./tape.ts";
import { activityKey } from "./activity.ts";
import { LiveMarketData } from "./live.ts";
import { Meter } from "./meter.ts";
import { RefLog } from "./refs.ts";
import { UsageLog } from "./usage.ts";
import { ProService, proRoutes } from "./proapi.ts";
import { PayoutLog } from "./payouts.ts";
import { periodBounds, periodOf, shareConfigFromEnv } from "./profitshare.ts";
import { ProfitShare, profitShareRoutes, readSendToManyFee } from "./shareapi.ts";
import { QPAYHUB_MIN_PAYMENT_QU, fetchReceipt } from "./qpay.ts";
import { QubicRpc } from "./rpc.ts";
import { PriceFeed, defaultSources } from "../bot/price.ts";
import { QubicPrice, qubicRoutes } from "./qubicprice.ts";
import { plansRoutes } from "./plans.ts";
import { cachedQuote, liquidationRoutes } from "./liquidation.ts";
import { UsedLedger, X402Gate, loadSecrets, rpcChain } from "./x402.ts";

/** A number from the environment, refused (not quietly turned into NaN, which disables whatever it limits) if it is not a number in range. */
function envNumber(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}, not '${raw}'`);
  return n;
}
/** What an agent pays for a Max quote, in QU (0: Max quotes are free). Paid from a prepaid key's balance or covered by an x402 session; the website's own Max is never charged. */
const maxPriceQu = envNumber("API_MAX_PRICE_QU", 0, 0, 1_000_000_000);
const port = envNumber("PORT", 8787, 1, 65535);
// Only this machine by default: the website and the bot reach the API at localhost. HOST=0.0.0.0 opens it to the network (behind your own proxy).
const host = process.env.HOST ?? "127.0.0.1";
// Prices recorded every time the catalog re-reads the markets, so charts can exist: the network itself only gives the current state.
const history = new HistoryStore(new URL("../.cache/history.json", import.meta.url).pathname);
// Things to write to disk when the server is stopped. One handler runs them all: the first process.exit would skip any later handler.
const onExit: (() => void)[] = [() => history.flush()];
// Each is tried even if an earlier one fails: one that throws must not leave the others (balances, ledgers, payouts) unsaved.
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    for (const f of onExit) {
      try {
        f();
      } catch (e) {
        console.error("Could not save on exit:", e instanceof Error ? e.message : e);
      }
    }
    process.exit(0);
  });
// A rejected promise nobody awaited must not take the whole server down.
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e instanceof Error ? (e.stack ?? e.message) : e));
const root = new URL("../", import.meta.url).pathname;

// ASSETS=path to a JSON array of { symbol, issuer, assetName? } switches the API to live chain data.
// Without it the API serves the demo snapshot.
const assetsFile = process.env.ASSETS ?? (process.env.SNAPSHOT ? undefined : root + "assets.json");
let data;
let label;
let tradeSource: TradeSource | undefined;
/** Endpoints that features bring (health, premium, pools, ledger, ...), mounted below once the market data exists. */
const featureRoutes: Route[] = [];
const quFeed = new PriceFeed(defaultSources());
try {
  if (!assetsFile) throw new Error("no assets file");
  const seeds = JSON.parse(readFileSync(assetsFile, "utf8"));
  const baseUrl = process.env.QUBIC_RPC_URL;
  // Two clients so the background asset scan (slow, low priority) never delays a user's quote.
  const rpc = new QubicRpc({ baseUrl, maxRps: 6 });
  const scanRpc = new QubicRpc({ baseUrl, maxRps: 2 });
  // Smart-contract shares are discovered automatically; `seeds` adds tokens by name or { symbol, issuer }.
  // Order history (archive Query API) tells which markets have been quiet for two epochs.
  const activity = new ActivityIndex(new QubicRpc({ baseUrl, maxRps: 2 }), { cachePath: root + ".cache/activity.json" });
  const runActivity = () => activity.update().then(() => console.log("Order history scan up to date")).catch((e) => console.error("Order history scan failed:", e instanceof Error ? e.message : e));
  void runActivity();
  setInterval(runActivity, 10 * 60_000).unref();
  // hidden.json lists assets to leave out entirely (deprecated tokens and the like).
  let hidden: { issuer: string; symbol?: string; reason?: string }[] = [];
  try {
    hidden = JSON.parse(readFileSync(root + "hidden.json", "utf8"));
  } catch {
    // optional file
  }
  // The live tape: every new QX fill and QSwap swap, with its direction, as the trade index reads it. It has its own client so its
  // transaction lookups (which give a QX fill's side) never delay a quote.
  const tapeRpc = new QubicRpc({ baseUrl, maxRps: 2 });
  const tape = new TradeTape({ symbolOf: catalogSymbolOf(() => catalog.list()), resolveSide: sideResolver(tapeRpc) });
  // Past trades (QX fills and QSwap swaps, from the archive's event log) fill the price history from before QMax began recording.
  let applyTrades = () => {};
  const trades =
    process.env.TRADE_HISTORY === "off"
      ? null
      : new TradeIndex(new QubicRpc({ baseUrl, maxRps: 2 }), { file: root + ".cache/trades.json", days: envNumber("TRADE_HISTORY_DAYS", 1825, 1, 3650), onProgress: () => applyTrades(), onTrades: (t) => tape.push(t) });
  const catalog = new AssetCatalog(scanRpc, {
    seeds,
    cachePath: root + ".cache/catalog.json",
    activity,
    hidden,
    onRefresh: (entries) => {
      for (const e of entries)
        history.record(e.id, { t: e.probedAt, price: e.priceQu, bid: e.bestBid ?? null, ask: e.bestAsk ?? null, pool: e.poolQu && e.poolAsset ? e.poolQu / e.poolAsset : null, liq: e.liquidityQu });
      applyTrades();
    },
  });
  if (trades) {
    // Older QX history read once from Quhub (npm run import-quhub), if it has been: shown before the archive's own records begin, marked, and never used for anything else.
    const imported = ImportedHistory.fromFile(root + ".cache/quhub.json");
    if (imported.stats().assets) console.log(`Older QX history from Quhub: ${imported.stats().assets} assets, ${imported.stats().days.toLocaleString("en-US")} days, ${imported.stats().trades.toLocaleString("en-US")} trades with exact times for ${imported.stats().tradeAssets} of them (read ${new Date(imported.stats().fetchedAt).toISOString().slice(0, 10)})`);
    let volumeCache: { at: number; map: Map<string, AssetVolume> } | null = null;
    let lastCache: { at: number; map: Map<string, { price: number; ms: number }> } | null = null;
    tradeSource = {
      // Volume for the asset list: a pass over every asset's hours, so it is kept for a minute.
      volumes() {
        const now = Date.now();
        if (volumeCache && now - volumeCache.at < 60_000) return volumeCache.map;
        const map = new Map<string, AssetVolume>();
        for (const e of catalog.list()) {
          try {
            const key = activityKey(e.symbol, e.issuer);
            const day = trades.volume(key, now - 24 * 3_600_000);
            map.set(e.id.toUpperCase(), { volume24hQu: day.volumeQu, volume72hQu: trades.volume(key, now - 72 * 3_600_000).volumeQu, volume7dQu: trades.volume(key, now - 7 * 24 * 3_600_000).volumeQu, trades24h: day.trades, change24hPct: trades.change(key, now), change72hPct: trades.change(key, now, 72 * 3_600_000), change7dPct: trades.change(key, now, 7 * 24 * 3_600_000) });
          } catch {
            // an asset whose name cannot be keyed has no history
          }
        }
        volumeCache = { at: now, map };
        return map;
      },
      // The newest QX trade of each asset: every asset trades on QX, and QX is where the price QMax shows comes from (a QSwap pool is only a reserve ratio and stays put when nobody trades against it; see `priceFromQx`). One cheap pass, kept for a few seconds.
      lasts() {
        const now = Date.now();
        if (lastCache && now - lastCache.at < 5_000) return lastCache.map;
        const map = new Map<string, { price: number; ms: number }>();
        for (const e of catalog.list()) {
          try {
            const l = trades.last(activityKey(e.symbol, e.issuer), "QX");
            if (l) map.set(e.id.toUpperCase(), l);
          } catch {
            // an asset whose name cannot be keyed has no trades
          }
        }
        lastCache = { at: now, map };
        return map;
      },
      candles(assetId, q) {
        const e = catalog.list().find((x) => x.id.toUpperCase() === assetId.toUpperCase());
        if (!e) return null;
        let key: string;
        try {
          key = activityKey(e.symbol, e.issuer);
        } catch {
          return null;
        }
        let venue = q.venue === "auto" ? trades.venueFor(key, e.venues.includes("QSwap") ? "QSwap" : "QX") : q.venue;
        const day = trades.volume(key, Date.now() - 24 * 3_600_000);
        // Older days from Quhub (QX only, so not for "QSwap only"): those before the day the archive's records begin. Asked for by the candle chart only: the
        // backtester, health and the rest read what the chain confirms. (The market the caller asked for, not the one "auto" settled on.)
        const older = olderCandles(imported, key, q, trades.stats().firstMs);
        // With older QX candles in front, "best market" means both markets together: older QX candles run on into QX and QSwap trades alike, not into a
        // QSwap-only series that may have started at a very different price.
        if (older.length && q.venue === "auto") venue = "all";
        const own = trades.candles(key, venue, q.intervalMs, q.sinceMs);
        return { asset: e.id, venue, candles: older.length ? [...older, ...own] : own, volume24hQu: day.volumeQu, trades24h: day.trades };
      },
    };
    // An asset's hourly trades on one venue, found through the asset list (null for an asset QMax does not know).
    const hoursFor = (assetId: string, venue: Venue) => {
      const e = catalog.list().find((x) => x.id.toUpperCase() === assetId.toUpperCase());
      if (!e) return null;
      try {
        return trades.hours(activityKey(e.symbol, e.issuer), venue);
      } catch {
        return null;
      }
    };
    // Health grades (and the wash-trade check pools use to flag inflated volume).
    const health = createHealth({
      assets: () => catalog.list(),
      hours: (a, venue) => {
        try {
          return trades.hours(activityKey(a.symbol, a.issuer), venue);
        } catch {
          return null;
        }
      },
      historySince: () => trades.stats().lowMs || null,
    });
    featureRoutes.push(
      ...health.routes,
      ...premiumRoutes({ hours: hoursFor }),
      ...poolsRoutes({
        pools: () => catalog.list().filter((e) => e.poolQu != null && e.poolAsset != null).map((e) => ({ id: e.id, symbol: e.symbol, poolQu: e.poolQu!, poolAsset: e.poolAsset!, priceQu: e.priceQu })),
        hours: (id) => hoursFor(id, "QSwap"),
        suspectWash: (id) => health.washSuspected(id),
        // a window the index has not finished reading is flagged, not mistaken for a quiet pool
        coveredSince: () => (trades.stats().highTick ? trades.stats().lowMs : Date.now()),
      }),
    );
    // Backtests run over the same hourly candles the candle chart uses.
    featureRoutes.push(...backtestRoutes({ candles: (id, venue, intervalMs, sinceMs) => tradeSource!.candles(id, { venue, intervalMs, sinceMs }) }));
    // An asset with a pool is charted by its swaps (as the live price is the pool's), otherwise by its QX trades.
    applyTrades = () => {
      let added = 0;
      for (const e of catalog.list()) {
        try {
          added += history.backfill(e.id, trades.samples(activityKey(e.symbol, e.issuer), e.venues.includes("QSwap") ? "QSwap" : "QX"));
        } catch {
          // a name or issuer that cannot be encoded has no trades to match
        }
      }
      if (added) console.log(`Price history: added ${added.toLocaleString("en-US")} hourly points rebuilt from past trades`);
    };
    const syncTrades = () => trades.update().then(applyTrades).catch((e) => console.error("Trade history scan failed:", e instanceof Error ? e.message : e));
    void syncTrades();
    // Reading only the newest ticks is cheap, so the index (and with it the tape and the candles) stays within seconds of the chain.
    setInterval(syncTrades, 15_000).unref();
    void tape.warmup(tapeRpc, 24).then((r) => console.log("Trade tape warmup", JSON.stringify(r)));
    setInterval(() => void tape.resolvePending(), 60_000).unref();
    // Add/remove liquidity: live pool state and a wallet's positions, read straight from the QSwap contract (its own client, paced by the routes).
    const liqRpc = new QubicRpc({ baseUrl, maxRps: 3 });
    featureRoutes.push(
      ...liquidityRoutes({
        query: (c, f, i) => liqRpc.query(c, f, i),
        pools: () => catalog.list().filter((e) => e.venues.includes("QSwap")).map((e) => ({ id: e.id, symbol: e.symbol, issuer: e.issuer, assetName: e.symbol })),
      }),
    );
    // Wallet ledgers read the archive heavily (up to ~30 requests a build), so they have their own client.
    featureRoutes.push(
      ...ledgerRoutes({
        rpc: new QubicRpc({ baseUrl, maxRps: 2 }),
        // A wallet's ledger is reused for five minutes by everyone who asks: it reads the public archive, which limits how often it is asked.
        cacheMs: envNumber("LEDGER_CACHE_SECONDS", 300, 30, 3600) * 1000,
        priceOf: (key) => catalog.list().find((e) => `${e.symbol}|${e.issuer}` === key)?.priceQu ?? null,
      }),
    );
    featureRoutes.push(...tapeRoutes({ tape, knownAsset: (id) => catalog.list().some((e) => e.id.toUpperCase() === id.toUpperCase()) }));
  }
  void catalog.start().then(() => console.log(`Asset scan finished: ${catalog.list().length} tradable assets`));
  data = new LiveMarketData(catalog, { rpc });
  // Token-to-token swap planning makes up to 25 internal quotes per request, so it quotes in-process and skips the per-quote on-chain
  // QSwap re-check (the venues are cached for a few seconds). These internal quotes are not billed like split quotes on /v1/quote. They may
  // price a tiny QSwap buy (the size search probes small sizes); the planner refuses to sign one itself (tinyQswapBuy in swap.ts).
  const md: MarketData = data;
  const quoteData: MarketData = { assets: () => md.assets(), venues: (a) => md.venues(a), assetInfo: md.assetInfo?.bind(md) };
  // What holdings would fetch if sold now: each one run through the same router a real sale uses (the depth of the book and pool, every fee), in-process.
  featureRoutes.push(
    ...liquidationRoutes({
      // Shared for two minutes by default (LIQUIDATION_CACHE_SECONDS) between everyone who asks (the same holding of the same asset is the same sale), so many people looking at their portfolios cost little more than one. Each pricing reads the live market and the public node limits how often that may be asked, so this also keeps repeated refreshes from hitting that limit.
      quote: cachedQuote(
        async (asset, qty) => {
          const q = await buildQuote(quoteData, { side: "sell", asset, qty, slippageBps: 0 });
          return { filledQty: q.filledQty, totalQu: q.totalQu, averagePriceQu: q.averagePriceQu, route: q.route.map((r) => ({ venue: r.venue })) };
        },
        { ttlMs: envNumber("LIQUIDATION_CACHE_SECONDS", 120, 5, 3600) * 1000 },
      ),
      midPrice: (asset) => catalog.list().find((e) => e.id.toUpperCase() === asset.toUpperCase())?.priceQu ?? null,
    }),
  );
  // The price of QU in dollars (top of the page, and a chart of it): the checked median of five sources, the one that prices the Discord subscription.
  featureRoutes.push(...qubicRoutes({ price: new QubicPrice({ rate: () => quFeed.rate() }) }));
  featureRoutes.push(...plansRoutes(process.env)); // what the Discord subscription costs, for the website's welcome window
  featureRoutes.push(...llmsRoutes(process.env)); // /llms.txt: what QMax is and how an agent uses it (nginx serves it at the site's root)
  featureRoutes.push(...swapRoutes({ quote: (side, asset, qty, slippageBps) => buildQuote(quoteData, { side, asset, qty, slippageBps }, { allowTinyQswapBuy: true }) as Promise<SwapQuote>, quoteOnly: (venue) => (side, asset, qty, slippageBps) => buildQuote(quoteData, { side, asset, qty, slippageBps }, { allowTinyQswapBuy: true, onlyVenue: venue }) as Promise<SwapQuote>, ...(process.env.SWAP_MAX_OUTLAY_QU ? { maxOutlayQu: Number(process.env.SWAP_MAX_OUTLAY_QU) } : {}) }));
  // Max (a Pro feature of the website): plans the best position for an order from the same quotes, the QX book and pool, and the last day of QX trades.
  featureRoutes.push(
    ...maxRoutes({
      quote: (side, asset, qty, slippageBps) => buildQuote(quoteData, { side, asset, qty, slippageBps }, { allowTinyQswapBuy: true }) as Promise<SwapQuote>,
      quoteOnly: (venue) => (side, asset, qty, slippageBps) => buildQuote(quoteData, { side, asset, qty, slippageBps }, { allowTinyQswapBuy: true, onlyVenue: venue }) as Promise<SwapQuote>,
      // what a person signs (a plain QSwap swap) is not allowed to be a buy so small that the pool would keep the whole payment
      venueQuote: (venue) => (side, asset, qty, slippageBps) => buildQuote(quoteData, { side, asset, qty, slippageBps }, { onlyVenue: venue }) as Promise<SwapQuote>,
      venues: (asset) => quoteData.venues(asset),
      priceQu: maxPriceQu,
      recent: async (asset) => {
        const found = tradeSource?.candles(asset, { venue: "QX", intervalMs: 3_600_000, sinceMs: Date.now() - 24 * 3_600_000 });
        if (!found) return null;
        // every hour of the last day: the ones with no QX trade count as not reached
        const traded = found.candles.filter((c) => c.trades > 0 && c.volumeQty > 0).map((c) => ({ low: c.l, high: c.h, qty: c.volumeQty }));
        return [...traded, ...Array.from({ length: Math.max(0, 24 - traded.length) }, () => ({ low: Infinity, high: 0, qty: 0 }))].slice(0, 24);
      },
    }),
  );
  label = `live Qubic data (seeds: ${assetsFile})`;
} catch (e) {
  // Demo prices are not the market. They are served only when no live setup was asked for (no ASSETS and no assets.json): a live setup that fails
  // (a corrupt file, a bad setting) stops the server with the reason, rather than quietly showing demo prices as if they were live.
  if (process.env.ASSETS || (assetsFile && existsSync(assetsFile))) throw e;
  const snapshot = process.env.SNAPSHOT ?? root + "examples/snapshot.json";
  data = SnapshotData.fromFile(snapshot);
  label = `DEMO snapshot data (${snapshot})`;
}
// Who may use the API, and whether they pay. API_ACCESS=free (the default): everyone, no key, no billing, limited per IP; only the Discord bot's
// subscription is charged for. billing: other sites prepay per call and agents can buy x402 sessions. private: only API_KEY gets in.
const access = (process.env.API_ACCESS ?? "free") as "free" | "billing" | "private";
if (!["free", "billing", "private"].includes(access)) throw new Error(`API_ACCESS must be free, billing or private, not '${access}'`);
// A private API with no key would let everyone in (and say it was private): it does not start. A weak key is guessable, so it is said loudly.
if (access === "private" && !(process.env.API_KEY && process.env.API_KEY.length >= 16)) throw new Error("API_ACCESS=private needs API_KEY, at least 16 characters (32 or more is better)");
// The owner's endpoints (subscribers, profit sharing, payouts, stats) want their own key, one the Discord bot never holds. Without ADMIN_KEY the bot's API_KEY
// opens them too, which is what a bot that is tricked into leaking its key would hand over.
const adminKey = process.env.ADMIN_KEY || undefined;
if (adminKey && adminKey.length < 24) throw new Error("ADMIN_KEY must be at least 24 characters, for example: openssl rand -hex 24");
if (adminKey && adminKey === process.env.API_KEY) throw new Error("ADMIN_KEY must differ from API_KEY: the Discord bot holds API_KEY");
if (!adminKey && process.env.API_KEY) console.warn("ADMIN_KEY is not set, so API_KEY (which the Discord bot also holds) opens the subscriber list and the payout planner. Set a separate ADMIN_KEY (openssl rand -hex 24) and use it for npm run payout.");
if (process.env.API_KEY && process.env.API_KEY.length < 24) console.warn(`API_KEY is only ${process.env.API_KEY.length} characters. Use a long random one, for example: openssl rand -hex 24`);
let meter: Meter | undefined;
const receiptRpc = new QubicRpc({ baseUrl: process.env.QUBIC_RPC_URL, maxRps: 3 });
// The meter sells everything in billing mode; in free mode it sells only Max quotes (API_MAX_PRICE_QU), so keys and top-ups work and nothing else is charged.
if (access === "billing" || (access === "free" && maxPriceQu > 0)) {
  meter = new Meter({
    file: root + ".cache/meter.json",
    splitPriceQu: envNumber("API_SPLIT_PRICE_QU", 100, 1),
    arbitragePriceQu: envNumber("API_ARBITRAGE_PRICE_QU", 50, 1),
    minTopupQu: envNumber("API_MIN_TOPUP_QU", 10_000, 1),
    recipient: PAYWALL.recipient,
    lookupReceipt: (payer, seller, resourceId, nonce) => fetchReceipt(receiptRpc, payer, seller, resourceId, nonce),
  });
  onExit.push(() => meter!.flush());
}
// With billing on (or Max quotes sold), agents can also buy a session by x402 (pay QPayhub, present the receipt) instead of holding a key. API_X402=off turns that off.
let x402: X402Gate | undefined;
if (meter && process.env.API_X402 !== "off") {
  const used = new UsedLedger(root + ".cache/x402-used.json");
  onExit.push(() => used.flush());
  x402 = new X402Gate({
    priceQu: envNumber("API_SESSION_PRICE_QU", 10_000, 1),
    seconds: envNumber("API_SESSION_SECONDS", 3600, 1),
    sellerId: PAYWALL.recipient,
    chain: rpcChain(receiptRpc, process.env.QUBIC_RPC_URL ?? "https://rpc.qubic.org"),
    ledger: used,
    secrets: loadSecrets(root + ".cache/x402-secrets.json"),
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
  });
}
// Who trades through QMax: the app reports transaction ids, each is checked against the archive, and payments to QMax's address are read from QPayhub.
const refs = new RefLog(root + ".cache/refs.json");
const usage = new UsageLog({ file: root + ".cache/usage.json", archive: new QubicRpc({ baseUrl: process.env.QUBIC_RPC_URL, maxRps: 2 }), recipient: PAYWALL.recipient });
const demo = label.startsWith("DEMO");
// Profit share: what QMax received (read from QPayhub) shared with subscribers; it only computes, and plans payouts for the owner to sign.
if (process.env.PROFIT_SHARE !== "off" && !demo) {
  try {
    const cfg = shareConfigFromEnv(process.env, PAYWALL.recipient);
    const start = process.env.PROFIT_SHARE_START ?? periodOf(Date.now());
    if (!periodBounds(start)) throw new Error("PROFIT_SHARE_START must look like 2026-10");
    const shareRpc = new QubicRpc({ baseUrl: process.env.QUBIC_RPC_URL, maxRps: 2 });
    const payouts = new PayoutLog(start, { file: root + ".cache/profitshare.json" });
    const share = new ProfitShare({
      usage,
      payouts,
      config: cfg,
      membership: { subscriptionDays: Number(process.env.BOT_SUB_DAYS ?? 30), passHours: PAYWALL.hours },
      owner: PAYWALL.recipient,
      subscriptionUnlocksWeb: process.env.SUBSCRIBERS_TRADE_ON_WEB !== "off",
      archive: shareRpc,
      sendToManyFee: () => readSendToManyFee((c, f, i) => shareRpc.query(c, f, i)),
    });
    featureRoutes.push(...profitShareRoutes(share));
    payouts.watch(shareRpc, PAYWALL.recipient);
    onExit.push(() => payouts.flush());
    console.log(`Profit share on: ${cfg.sharePct}% of net income to subscribers from ${payouts.start}, split by what each paid${cfg.capFraction > 0 ? `, capped at ${cfg.capFraction}x what they paid` : ""}`);
  } catch (e) {
    console.error("Profit share is off:", e instanceof Error ? e.message : e);
  }
}
const shareOn = featureRoutes.some((r) => r.path === "/v1/membership");
// Max passes: who a pass covers (the paying address and up to 14 it listed), worked out from the same QPayhub payments. The pass length and price are the website's own settings.
if (!demo && process.env.PRO_COVER !== "off") {
  const days = envNumber("PRO_DAYS", envNumber("VITE_PRO_DAYS", 30, 1, 3650), 1, 3650);
  const price = envNumber("PRO_PRICE_QU", envNumber("VITE_PRO_PRICE_QU", 0, 0, 1_000_000_000), 0, 1_000_000_000);
  const pro = new ProService({ usage, rules: { days, minQu: Math.max(price, QPAYHUB_MIN_PAYMENT_QU) }, file: root + ".cache/pro-cover.json" });
  featureRoutes.push(...proRoutes(pro));
  onExit.push(() => pro.flush());
}
const proOn = featureRoutes.some((r) => r.path === "/v1/pro");
if (!demo) usage.start({ trades: process.env.TRADE_USAGE !== "off", payments: process.env.TRADE_USAGE !== "off" || shareOn || proOn });
onExit.push(() => usage.flush(), () => refs.flush());
createApi({ data, history, trades: tradeSource, routes: featureRoutes, x402, apiKey: process.env.API_KEY, adminKey, meter, freeAccess: access === "free", maxPriceQu, publicUrl: process.env.PUBLIC_BASE_URL, refs, usage, freePerMin: envNumber("API_FREE_PER_MIN", 60, 1), trustProxy: envNumber("TRUST_PROXY", 0, 0, 10) }).listen(port, host, () =>
  console.log(`QMax API on http://${host}:${port}, ${label}${meter ? `; prepaid API: ${access === "free" ? `${maxPriceQu} QU per Max quote for agents (everything else is free)` : `${meter.splitPriceQu} QU per split quote, ${meter.arbitragePriceQu} QU per arbitrage result`}${x402 ? `; x402 sessions: ${x402.priceQu} QU for ${x402.seconds / 60} minutes` : ""}` : access === "free" ? `; the API is free for everyone (${process.env.API_FREE_PER_MIN ?? 60} market requests a minute per IP; no key, no billing)` : "; API is private (API_KEY only)"}`),
);
