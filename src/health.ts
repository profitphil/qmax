import { RouteError, required } from "./routes.ts";
import type { Route } from "./routes.ts";
import type { AssetItem } from "./apitypes.ts";
import type { Hour, Venue } from "./trades.ts";

/**
 * How safe an asset is to trade, as a grade A to E. It looks at three things QMax can see for any asset: what is resting on
 * the QX book and in the QSwap pool right now, how much and how often it traded (the hourly sums in `TradeIndex`), and whether
 * the trading looks like one bot churning (wash trading). It is an estimate from public data: it cannot see who trades, what an
 * issuer plans, or anything off the network, and it says so wherever it is shown.
 *
 * `assessHealth` is pure: the same input gives the same answer, nothing reads the clock (`now` is passed in) and nothing is NaN.
 * This file imports nothing from node, so the web app can import from it (it takes the grade floors and the flag limits).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The latest time a JavaScript Date can hold; later numbers are not times. */
const MAX_TIME = 8.64e15;

/* ---------- Thresholds. Each says where the number came from. ---------- */

/** "Near the price" means within 2% of it (see `depthNear` for which price). */
export const DEPTH_BAND = 0.02;
/** Being able to sell this much (QU) near the price loses nothing in the score; at or under DEPTH_EMPTY_QU it loses everything the depth part can. In between it falls on a log scale. Real catalogue: the best pool gave about 93M, most pool assets 5 to 60M. */
const DEPTH_FULL_QU = 100_000_000;
const DEPTH_EMPTY_QU = 1_000_000;
/** Under this the market is called thin: a 10M QU sale (a modest trade) would move the price by more than 2%. */
const THIN_DEPTH_QU = 10_000_000;
/** QX prices are whole QU, so a cheap token's two nearest prices can be 1 QU apart (9 and 10 is a 10% "spread") with nothing wrong. A spread only counts when it is wider than one such step. */
const QX_TICK_QU = 1;
/** A QX spread up to this is free; at SPREAD_BAD_PCT and over it costs the most the spread part can. In between it rises evenly. */
const SPREAD_OK_PCT = 2;
const SPREAD_BAD_PCT = 20;
/** The flag 'wide-spread' needs at least this. */
const WIDE_SPREAD_PCT = 10;
/** With a pool beside it a wide book matters half as much, because an order can go through the pool instead. */
const POOL_SPREAD_DISCOUNT = 0.5;
/** Fewer trades than this in 7 days is 'few-trades'. */
const FEW_TRADES_7D = 5;
/** 100 trades in a week earns full marks for frequency, 24 active hours (about one a day) for regularity. Both fall on a log scale. */
const TRADES_FULL_7D = 100;
const ACTIVE_HOURS_FULL_7D = 24;
/** No trade for this long is 'quiet'. */
const QUIET_DAYS = 14;
/** A first trade this recent is a 'new-listing', but only when the history reaches back at least NEW_MIN_COVERAGE_DAYS: otherwise an old asset would look new. */
const NEW_LISTING_DAYS = 14;
const NEW_MIN_COVERAGE_DAYS = 60;
/** 'volume-spike': one hour holds this share of the last 30 days' QU volume, with at least SPIKE_MIN_TRADES trades behind it. In the real catalogue that is 3 of 83 assets. */
const SPIKE_SHARE = 0.6;
const SPIKE_MIN_TRADES = 10;
/** 'pool-dominated': at least this share of the last 7 days' trades (and at least FEW_TRADES_7D of them) were QSwap swaps, so nobody is trading on the QX book and the pool alone sets the price. In the real catalogue QX takes most of the trades even for assets that have a pool. */
const POOL_DOMINATED_SHARE = 0.9;

/**
 * Churn-like hours. Set from the real index (six months, 13,705 asset-hours, 81 assets):
 *  - Every QSwap hour of every asset except one had at most 24 swaps. One asset had 59 hours of 433 to 2,774 swaps
 *    (median 2,462) whose swaps averaged 103 QU, varying 3.6% from hour to hour, where its normal swap was about 30M QU.
 *  - The real busy QSwap hours (24, 20 and 12 swaps) averaged 1.2M, 7.8M and 1.4M QU; the smallest real hour with 10 or more
 *    swaps averaged 670,000 QU.
 * So an hour is churn-like only when BOTH its count and its size are far outside anything genuine: at least 300 swaps (12 times
 * the busiest genuine hour) at an average of at most 5,000 QU (130 times under the smallest genuine busy hour).
 */
const CHURN_MIN_SWAPS = 300;
/** QX differs: one transaction can fill many resting orders and the log has one fill per order. Real busy QX hours were 144 fills from 30 transactions, 110 from 36 and 53 from 3. So the bar is 10 times the real maximum of 144 fills. */
const CHURN_MIN_QX_FILLS = 1_500;
const CHURN_MAX_AVG_QU = 5_000;
/** Strong evidence (the only kind that raises 'wash-suspected'): at least this many churn-like hours, at least this many of them in a row, and their average size varying by no more than this from hour to hour (real: 0.036). */
const WASH_MIN_HOURS = 6;
const WASH_MIN_RUN = 3;
const WASH_MAX_SIZE_CV = 0.25;
/** The wash check looks at the last 7 days. Older strong evidence only raises 'wash-past', which does not change the score. */
const WASH_WINDOW_DAYS = 7;

/** What each problem costs, in points off 100. They add up, then the grade comes from the total. */
const LOSS = {
  depth: 35,
  spread: 25,
  trades: 25,
  activeHours: 10,
  quiet: 10,
  noExit: 30,
  noAsks: 6,
  newListing: 8,
  spike: 5,
  washStrong: 40,
  washWeak: 8,
  unknownTrades: 12,
  unknownBook: 15,
} as const;
/** An asset nobody will buy back can never be better than an E, and one with no market at all is the worst there is. */
const NO_EXIT_CEILING = 29;
const NO_MARKET_CEILING = 10;

/** The limits behind the flags, for anything that explains them to a reader (the web panel does), so the words never drift from the numbers. */
export const HEALTH_LIMITS = {
  depthBand: DEPTH_BAND,
  thinDepthQu: THIN_DEPTH_QU,
  wideSpreadPct: WIDE_SPREAD_PCT,
  fewTrades7d: FEW_TRADES_7D,
  quietDays: QUIET_DAYS,
  newListingDays: NEW_LISTING_DAYS,
  washWindowDays: WASH_WINDOW_DAYS,
} as const;

/** Lowest score of each grade. */
export const GRADE_FLOOR = { A: 80, B: 65, C: 50, D: 30, E: 0 } as const;
export type Grade = keyof typeof GRADE_FLOOR;

export function gradeFor(score: number): Grade {
  for (const g of ["A", "B", "C", "D"] as const) if (score >= GRADE_FLOOR[g]) return g;
  return "E";
}

/* ---------- Types ---------- */

/** Stable ids, in the order they are listed. */
export const HEALTH_FLAGS = ["wash-suspected", "no-market", "one-sided", "bot-burst", "thin-book", "wide-spread", "quiet", "few-trades", "new-listing", "volume-spike", "wash-past", "pool-dominated"] as const;
export type HealthFlag = (typeof HEALTH_FLAGS)[number];

/** What `AssetItem` carries that matters here. Anything but the id may be missing. */
export type HealthAsset = { id: string } & Partial<Pick<AssetItem, "venues" | "priceQu" | "liquidityQu" | "bestBid" | "bestAsk" | "bidQty" | "askQty" | "poolQu" | "poolAsset" | "activity">>;

/** The fields of `Hour` this uses. */
export type HourSum = Pick<Hour, "hour" | "qu" | "qty" | "n" | "high" | "low">;
export interface BookLevel {
  price: number;
  qty: number;
}

export interface HealthInput {
  asset: HealthAsset;
  /** The asset's hourly sums per venue (`TradeIndex.hours`). `null` means the trade history is not available, which is not the same as `[]`: that means it is, and nothing traded. */
  hours: { QX: HourSum[]; QSwap: HourSum[] } | null;
  /** The time the hourly sums are complete from (`TradeIndex.stats().lowMs`). A window that reaches back further than this is reported as unknown instead of as zero. */
  historySince: number | null;
  /** The whole QX book (`buildBook(...).qx`), if you have it. Without it only the best order on each side is known, so depth is a lower bound. */
  book?: { bids: BookLevel[]; asks: BookLevel[] } | null;
  /** ms since epoch. */
  now: number;
}

export interface HealthMetrics {
  /** Middle of the best QX bid and ask, QU per unit (the one price there is if only one side has orders). */
  qxMidQu: number | null;
  /** The pool's price, QU per unit. */
  poolPriceQu: number | null;
  /** QU of QX buy / sell orders within 2% of the pool's price, or without a pool of that side's best price. */
  qxBidDepthQu: number;
  qxAskDepthQu: number;
  /** 'best-level': only the best order per side was known; 'full-book': the whole book; 'none': no QX orders. */
  qxDepthBasis: "none" | "best-level" | "full-book";
  /** QU a swap can put through the pool before its price moves 2%, one way (about 1% of its QU reserve; fees ignored). Null with no pool. */
  poolDepthQu: number | null;
  /** What can be sold / bought near the price: QX orders plus the pool. */
  exitDepthQu: number;
  entryDepthQu: number;
  /** The pool's share of exitDepthQu. */
  poolShare: number | null;
  /** (best ask - best bid) / middle, in percent. */
  spreadPct: number | null;
  spreadGapQu: number | null;
  /** Trade totals on both venues. Null when the history does not reach back that far. */
  volume24hQu: number | null;
  volume7dQu: number | null;
  volume30dQu: number | null;
  trades24h: number | null;
  trades7d: number | null;
  trades30d: number | null;
  tradesQx7d: number | null;
  tradesQswap7d: number | null;
  /** Hours of the last 7 days (out of 168) with at least one trade. */
  activeHours7d: number | null;
  avgTradeQu7d: number | null;
  /** The catalogue's rough market size (pool reserves twice, plus the top of each book). */
  liquidityQu: number | null;
  /** Volume over liquidityQu. */
  turnover24h: number | null;
  turnover7d: number | null;
  /** Share of the last 30 days' trades / QU volume that fell in the single busiest hour. */
  busiestHourShare30d: number | null;
  busiestHourVolumeShare30d: number | null;
  /** Start of the first and last hour that had a trade in the history. */
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  /** Hours that look like churn (many tiny swaps): in the last 7 days and in the whole history. */
  washLikeHours7d: number | null;
  washLikeHoursTotal: number | null;
  /** Their share of the last 7 days' trades. */
  washLikeShare7d: number | null;
  washPeakPerHour: number | null;
  /** Average QU per trade in the recent ones. */
  washAvgTradeQu: number | null;
}

export interface Health {
  /** 0 (worst) to 100 (best), a whole number. */
  score: number;
  grade: Grade;
  flags: HealthFlag[];
  /** Plain sentences, most important first, each with the numbers it rests on. */
  reasons: string[];
  metrics: HealthMetrics;
  /** True when something it needs was missing (no trade history yet, no book), so the grade is an estimate from the rest. */
  partial: boolean;
}

/* ---------- Small helpers ---------- */

const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const positive = (x: unknown): number | null => (ok(x) && x > 0 ? x : null);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const ramp = (x: number, from: number, to: number) => clamp((x - from) / (to - from), 0, 1);
/** Where x sits between `from` and `to` on a log scale, 0 to 1. */
const logRamp = (x: number, from: number, to: number) => ramp(Math.log10(Math.max(x, 1e-9)), Math.log10(from), Math.log10(to));
const ratio = (a: number, b: number): number | null => (b > 0 && Number.isFinite(a / b) ? a / b : null);
const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** 12,345 */
const count = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** 1.2M QU: the same everywhere, whatever the locale. */
function qu(n: number): string {
  for (const [size, mark] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) if (n >= size) return `${round(n / size, 1)}${mark} QU`;
  return `${count(n)} QU`;
}
const pct = (x: number) => `${round(x, x < 100 ? 1 : 0)}%`;
/** An ISO time, or an empty string for a number that is not a time. */
const iso = (ms: number) => (Number.isNaN(new Date(ms).getTime()) ? "" : new Date(ms).toISOString());
const isoDay = (ms: number) => iso(ms).slice(0, 10);
const plural = (n: number, one: string) => `${count(n)} ${n === 1 ? one : `${one}s`}`;
const daysAgo = (now: number, ms: number) => Math.max(0, Math.floor((now - ms) / DAY));

/* ---------- The QX book and the pool ---------- */

interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
  basis: HealthMetrics["qxDepthBasis"];
}

const cleanLevels = (levels: BookLevel[] | undefined): BookLevel[] => (levels ?? []).filter((l) => ok(l?.price) && ok(l?.qty) && l.price > 0 && l.qty > 0);

function readBook(a: HealthAsset, full: HealthInput["book"]): Book {
  const bids = cleanLevels(full?.bids);
  const asks = cleanLevels(full?.asks);
  if (bids.length || asks.length) return { bids, asks, basis: "full-book" };
  // The catalogue knows only the first order on each side. A price without a size still shows that orders exist.
  const bid = positive(a.bestBid);
  const ask = positive(a.bestAsk);
  if (bid === null && ask === null) return { bids: [], asks: [], basis: "none" };
  const level = (price: number | null, qty: unknown): BookLevel[] => (price === null ? [] : [{ price, qty: positive(qty) ?? 0 }]);
  return { bids: level(bid, a.bidQty), asks: level(ask, a.askQty), basis: "best-level" };
}

const extreme = (levels: BookLevel[], pick: (a: number, b: number) => number) => (levels.length ? levels.reduce((m, l) => pick(m, l.price), levels[0].price) : null);

/** QU resting within the band of a reference price: at or above 98% of it for buy orders, at or below 102% of it for sell orders. */
function depthNear(levels: BookLevel[], reference: number | null, side: "bid" | "ask"): number {
  if (reference === null) return 0;
  let sum = 0;
  for (const l of levels) if (side === "bid" ? l.price >= reference * (1 - DEPTH_BAND) : l.price <= reference * (1 + DEPTH_BAND)) sum += l.price * l.qty;
  return sum;
}

/**
 * How much a constant-product pool takes before its price moves by the band. With reserves x (QU) and y (units) the price is
 * x/y, and it goes as x squared, so buying moves it up 2% once QU worth x * (sqrt(1.02) - 1) has gone in, and selling moves it
 * down 2% once x * (1 - sqrt(0.98)) has come out. The swap fee is ignored.
 */
const poolDepth = (reserveQu: number) => ({ buy: reserveQu * (Math.sqrt(1 + DEPTH_BAND) - 1), sell: reserveQu * (1 - Math.sqrt(1 - DEPTH_BAND)) });

/* ---------- Trades ---------- */

const cleanHours = (rows: HourSum[] | undefined, now: number): HourSum[] =>
  (rows ?? []).filter((h) => ok(h?.hour) && ok(h.n) && ok(h.qu) && h.n > 0 && h.qu >= 0 && h.hour >= 0 && h.hour <= Math.min(now, MAX_TIME)).sort((a, b) => a.hour - b.hour);

/** An hour counts for a window if any part of it falls inside: the rule `TradeIndex.volume` and the candles' 24h volume use. */
const inWindow = (h: HourSum, now: number, ms: number) => h.hour + HOUR > now - ms;

function total(rows: HourSum[], now: number, ms: number) {
  let n = 0;
  let volume = 0;
  for (const h of rows) if (inWindow(h, now, ms)) (n += h.n), (volume += h.qu);
  return { n, volume };
}

/** QU and trades per hour, both venues together, for the hours inside a window. */
function perHour(rows: HourSum[], now: number, ms: number): { n: number; qu: number }[] {
  const byHour = new Map<number, { n: number; qu: number }>();
  for (const h of rows) if (inWindow(h, now, ms)) byHour.set(h.hour, { n: (byHour.get(h.hour)?.n ?? 0) + h.n, qu: (byHour.get(h.hour)?.qu ?? 0) + h.qu });
  return [...byHour.values()];
}

/** The most hours in a row, for hour starts in order. */
function longestRun(sortedHours: number[]): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < sortedHours.length; i++) {
    run = i > 0 && sortedHours[i] - sortedHours[i - 1] === HOUR ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Standard deviation over the mean. */
function variation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (!(mean > 0)) return Infinity;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length) / mean;
}

const avgSize = (h: HourSum) => h.qu / h.n;
/** How far the price moved within the hour, in percent of its middle. Zero when the hour's high and low are not usable. */
const band = (h: HourSum) => {
  const width = ok(h.high) && ok(h.low) && h.high > 0 && h.low > 0 ? ((h.high - h.low) / ((h.high + h.low) / 2)) * 100 : 0;
  return Number.isFinite(width) ? width : 0;
};

interface Churn {
  venue: Venue;
  recent: HourSum[];
  past: HourSum[];
}

/** The hours of one venue with far more trades than people make, each one tiny (see the thresholds). */
function churnOf(venue: Venue, rows: HourSum[], now: number): Churn {
  const min = venue === "QSwap" ? CHURN_MIN_SWAPS : CHURN_MIN_QX_FILLS;
  const like = rows.filter((h) => h.n >= min && avgSize(h) <= CHURN_MAX_AVG_QU);
  const recent = (h: HourSum) => inWindow(h, now, WASH_WINDOW_DAYS * DAY);
  return { venue, recent: like.filter(recent), past: like.filter((h) => !recent(h)) };
}

/** Enough churn-like hours, in a row, of nearly the same size: only then is it called wash trading. */
const strong = (rows: HourSum[]) => rows.length >= WASH_MIN_HOURS && longestRun(rows.map((h) => h.hour)) >= WASH_MIN_RUN && variation(rows.map(avgSize)) <= WASH_MAX_SIZE_CV;

/* ---------- The assessment ---------- */

interface Issue {
  flag?: HealthFlag;
  loss: number;
  text: string;
}

export function assessHealth(input: HealthInput): Health {
  const a = input.asset;
  const now = ok(input.now) ? input.now : 0;
  const issues: Issue[] = [];
  let partial = false;
  const add = (loss: number, text: string, flag?: HealthFlag) => issues.push({ flag, loss, text });

  /* --- the market right now --- */
  const book = readBook(a, input.book);
  const bid = extreme(book.bids, Math.max);
  const ask = extreme(book.asks, Math.min);
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
  const poolQu = positive(a.poolQu);
  const poolAsset = positive(a.poolAsset);
  const pool = poolQu !== null && poolAsset !== null ? poolDepth(poolQu) : null;
  const poolPrice = poolQu !== null && poolAsset !== null ? poolQu / poolAsset : null;
  // "Near the price" is near the pool's price when there is a pool: that is a price a swap really gets. Without one it is near each side's own best price,
  // because the middle of a wide book is a price nobody offers (the spread is judged separately). Orders far from the pool's price are not depth: a bid wall
  // at 1 QU says nothing about selling a token the pool prices at 1.75.
  const qxBidDepth = depthNear(book.bids, poolPrice ?? bid, "bid");
  const qxAskDepth = depthNear(book.asks, poolPrice ?? ask, "ask");
  const hasQx = book.basis !== "none";
  const exitDepth = qxBidDepth + (pool?.sell ?? 0);
  const entryDepth = qxAskDepth + (pool?.buy ?? 0);
  const gap = bid !== null && ask !== null ? Math.max(0, ask - bid) : null;
  const spreadPct = gap !== null && mid ? (gap / mid) * 100 : null;
  const marketKnown = pool !== null || hasQx;
  const noMarket = !marketKnown && Array.isArray(a.venues) && a.venues.length === 0;
  const noExit = marketKnown && pool === null && book.bids.length === 0;

  if (noMarket) {
    add(100, "There is no order book on QX and no QSwap pool for this asset right now, so there is nothing to trade against.", "no-market");
  } else if (!marketKnown) {
    // The numbers are missing, not the market: say so, rather than grade an unseen book as empty or as fine.
    partial = true;
    add(LOSS.unknownBook, "The order book and pool could not be read, so depth and spread are not known.");
  } else {
    if (noExit) add(LOSS.noExit, `There are only sell orders on QX and no QSwap pool, so there may be nobody to sell to once you have bought (the cheapest offer is ${qu(ask!)} per unit).`, "one-sided");
    else if (pool === null && book.asks.length === 0) add(LOSS.noAsks, "There are only buy orders on QX and no QSwap pool, so nobody is offering to sell and you cannot buy more right now.", "one-sided");

    const depthLoss = LOSS.depth * (1 - logRamp(exitDepth, DEPTH_EMPTY_QU, DEPTH_FULL_QU));
    const where = pool ? "the pool's price" : "the highest buy order";
    const sources = [pool ? `the pool takes ${qu(pool.sell)}` : "", qxBidDepth > 0 ? `${pool ? "buy orders near it add" : "buy orders there are worth"} ${qu(qxBidDepth)}` : ""].filter(Boolean).join(" and ");
    // With no buyer at all the one-sided reason already says so, so the depth part only costs points.
    const text = noExit ? "" : exitDepth === 0 ? `Nothing can be sold within 2% of ${where}, so any sale would have to accept a much lower price.` : exitDepth < THIN_DEPTH_QU ? `Only about ${qu(exitDepth)} can be sold within 2% of ${where} (${sources}), so a larger sale will push the price down further.` : `About ${qu(exitDepth)} can be sold within 2% of ${where} (${sources}).`;
    add(depthLoss, text, exitDepth < THIN_DEPTH_QU ? "thin-book" : undefined);

    if (spreadPct !== null && gap !== null && gap > QX_TICK_QU) {
      const loss = LOSS.spread * ramp(spreadPct, SPREAD_OK_PCT, SPREAD_BAD_PCT) * (pool ? POOL_SPREAD_DISCOUNT : 1);
      add(loss, `On QX you would pay ${qu(ask!)} per unit to buy but get only ${qu(bid!)} if you sold straight back, a gap of ${pct(spreadPct)} of the middle price${pool ? "; the QSwap pool gives a tighter price" : ""}.`, spreadPct >= WIDE_SPREAD_PCT ? "wide-spread" : undefined);
    }
    // The catalogue lists a pool but gave no reserves: the pool side of the numbers above is missing.
    if (pool === null && Array.isArray(a.venues) && a.venues.includes("QSwap")) partial = true;
  }

  /* --- trading history --- */
  const rows = input.hours ? { QX: cleanHours(input.hours.QX, now), QSwap: cleanHours(input.hours.QSwap, now) } : null;
  // TradeIndex.stats().lowMs is 0 until its first scan starts: that is "nothing read yet", not "read since 1970".
  const since = ok(input.historySince) && input.historySince > 0 ? input.historySince : null;
  const covers = (ms: number) => rows !== null && since !== null && since <= now - ms;
  const all = rows ? [...rows.QX, ...rows.QSwap] : [];
  const d24 = covers(DAY) ? total(all, now, DAY) : null;
  const d7 = covers(7 * DAY) ? total(all, now, 7 * DAY) : null;
  const d30 = covers(30 * DAY) ? total(all, now, 30 * DAY) : null;
  const qx7 = d7 ? total(rows!.QX, now, 7 * DAY) : null;
  const swaps7 = d7 ? total(rows!.QSwap, now, 7 * DAY) : null;
  const activeHours = d7 ? Math.min(168, new Set(all.filter((h) => inWindow(h, now, 7 * DAY)).map((h) => h.hour)).size) : null;
  const firstTradeAt = all.length ? Math.min(...all.map((h) => h.hour)) : null;
  const lastTradeAt = all.length ? Math.max(...all.map((h) => h.hour)) : null;
  const inactive = a.activity === "inactive";
  const noTradesLately = covers(QUIET_DAYS * DAY) && total(all, now, QUIET_DAYS * DAY).n === 0;
  const busy30 = d30 ? perHour(all, now, 30 * DAY) : [];

  if (d7 === null) {
    partial = true;
    add(LOSS.unknownTrades, rows === null ? "The trade history is not available, so how often this asset trades could not be checked." : "The trade history has not finished loading, so how often this asset trades could not be checked yet.");
    if (inactive) add(LOSS.quiet, "QMax has seen no order or pool change for this asset in about 2 epochs, so it may be hard to find a buyer.", "quiet");
  } else {
    const tradeLoss = LOSS.trades * (1 - logRamp(d7.n + 1, 1, 1 + TRADES_FULL_7D)) + LOSS.activeHours * (1 - logRamp(activeHours! + 1, 1, 1 + ACTIVE_HOURS_FULL_7D));
    if (noTradesLately || (inactive && d7.n < FEW_TRADES_7D)) {
      const last = lastTradeAt === null ? `QMax has no trade recorded for it since ${isoDay(since!)}` : `The last trade was about ${plural(daysAgo(now, lastTradeAt), "day")} ago`;
      add(LOSS.quiet + tradeLoss, `${last}${inactive ? ", and there has been no order or pool change in about 2 epochs" : ""}, so it may be hard to find a buyer and the price shown may be out of date.`, "quiet");
    } else if (d7.n < FEW_TRADES_7D) {
      add(tradeLoss, `${d7.n === 0 ? "No trades" : `Only ${plural(d7.n, "trade")}`} in the last 7 days${d7.n === 0 ? "" : ` (in ${plural(activeHours!, "hour")})`}, so the price may not reflect what people would pay now.`, "few-trades");
    } else {
      add(tradeLoss, `${plural(d7.n, "trade")} in the last 7 days, in ${plural(activeHours!, "different hour")}, worth ${qu(d7.volume)} in all.`);
    }
    if (swaps7 && d7.n >= FEW_TRADES_7D && swaps7.n / d7.n >= POOL_DOMINATED_SHARE) {
      add(0, `${d7.n === swaps7.n ? `All ${count(d7.n)}` : `${pct((swaps7.n / d7.n) * 100)} of the ${count(d7.n)}`} trades in the last 7 days were QSwap swaps, so the pool alone sets the price and nobody is trading on the QX order book.`, "pool-dominated");
    }
    if (covers(NEW_MIN_COVERAGE_DAYS * DAY) && firstTradeAt !== null && now - firstTradeAt < NEW_LISTING_DAYS * DAY) {
      add(LOSS.newListing, `The first trade was only about ${plural(daysAgo(now, firstTradeAt), "day")} ago, so there is little history to judge it by.`, "new-listing");
    }
    const top = busy30.length ? Math.max(...busy30.map((h) => h.qu)) : 0;
    const share = d30 ? ratio(top, d30.volume) : null;
    if (d30 && d30.n >= SPIKE_MIN_TRADES && share !== null && share >= SPIKE_SHARE) {
      add(LOSS.spike, `${pct(share * 100)} of the last 30 days' trading volume (${qu(top)} of ${qu(d30.volume)}) happened in a single hour, so the volume figure is not what a normal week looks like.`, "volume-spike");
    }
  }

  /* --- wash trading --- */
  // This runs on whatever hours exist: what it finds is evidence even when the full window is not covered.
  const churn = rows ? [churnOf("QSwap", rows.QSwap, now), churnOf("QX", rows.QX, now)] : [];
  const recent = churn.flatMap((c) => c.recent);
  const recentTrades = recent.reduce((s, h) => s + h.n, 0);
  const recentQu = recent.reduce((s, h) => s + h.qu, 0);
  const recentShare = d7 ? ratio(recentTrades, d7.n) : null;
  const wash = churn.find((c) => strong(c.recent));
  const old = churn.find((c) => strong(c.past));
  const things = (venue: Venue) => (venue === "QSwap" ? "swaps" : "fills");
  if (wash) {
    const hs = wash.recent;
    add(LOSS.washStrong, `Looks like wash trading: ${plural(hs.length, "hour")} in the last 7 days had about ${count(median(hs.map((h) => h.n)))} ${things(wash.venue)} each, averaging only ${qu(recentQu / recentTrades)} with almost the same size every hour while the price barely moved (about ${pct(median(hs.map(band)))} in a typical hour). That pattern is typical of a bot trading back and forth, and those hours are ${recentShare === null ? "most" : pct(recentShare * 100)} of the recent trade count. It is an estimate: public trade totals do not show who is trading.`, "wash-suspected");
  } else if (recent.length > 0) {
    const lead = [...churn].sort((x, y) => y.recent.length - x.recent.length)[0];
    add(LOSS.washWeak, `${plural(recent.length, "hour")} in the last 7 days had a burst of up to ${count(Math.max(...recent.map((h) => h.n)))} ${things(lead.venue)} averaging only ${qu(recentQu / recentTrades)}, which could be a bot. That is not enough on its own to call it wash trading.`, "bot-burst");
  }
  if (!wash && old) {
    const hs = old.past;
    add(0, `Between ${isoDay(hs[0].hour)} and ${isoDay(hs[hs.length - 1].hour)} this asset had ${plural(hs.length, "hour")} that looked like wash trading (a typical ${count(median(hs.map((h) => h.n)))} tiny ${things(old.venue)} an hour, averaging ${qu(hs.reduce((s, h) => s + h.qu, 0) / hs.reduce((s, h) => s + h.n, 0))}). Nothing as strong has shown up in the last 7 days.`, "wash-past");
  }

  /* --- put it together --- */
  const flags = HEALTH_FLAGS.filter((f) => issues.some((i) => i.flag === f));
  let score = clamp(100 - issues.reduce((s, i) => s + i.loss, 0), 0, 100);
  if (noMarket) score = Math.min(score, NO_MARKET_CEILING);
  if (noExit) score = Math.min(score, NO_EXIT_CEILING);
  score = Math.round(score);

  // Most costly first; a problem that costs nothing is only listed if it is a flag, and goes last.
  const order = (f?: HealthFlag) => (f ? HEALTH_FLAGS.indexOf(f) : HEALTH_FLAGS.length);
  const reasons = issues.filter((i) => i.text && (i.loss >= 1 || i.flag)).sort((x, y) => y.loss - x.loss || order(x.flag) - order(y.flag)).map((i) => i.text);
  if (reasons.length === 0) reasons.push(`No warning signs found: about ${qu(exitDepth)} can be sold within 2% of the price and there were ${d7 ? plural(d7.n, "trade") : "trades"} in the last 7 days.`);
  if (partial) reasons.push("Some of what this needs was not available, so the grade is an estimate from the rest.");

  const liquidity = positive(a.liquidityQu);
  const metrics: HealthMetrics = {
    qxMidQu: mid,
    poolPriceQu: poolPrice,
    qxBidDepthQu: round(qxBidDepth, 0),
    qxAskDepthQu: round(qxAskDepth, 0),
    qxDepthBasis: book.basis,
    poolDepthQu: pool ? round((pool.buy + pool.sell) / 2, 0) : null,
    exitDepthQu: round(exitDepth, 0),
    entryDepthQu: round(entryDepth, 0),
    poolShare: pool ? ratio(pool.sell, exitDepth) : null,
    spreadPct: spreadPct === null ? null : round(spreadPct, 2),
    spreadGapQu: gap,
    volume24hQu: d24 ? d24.volume : null,
    volume7dQu: d7 ? d7.volume : null,
    volume30dQu: d30 ? d30.volume : null,
    trades24h: d24 ? d24.n : null,
    trades7d: d7 ? d7.n : null,
    trades30d: d30 ? d30.n : null,
    tradesQx7d: qx7 ? qx7.n : null,
    tradesQswap7d: swaps7 ? swaps7.n : null,
    activeHours7d: activeHours,
    avgTradeQu7d: d7 && d7.n > 0 ? round(d7.volume / d7.n, 0) : null,
    liquidityQu: liquidity,
    turnover24h: d24 && liquidity ? ratio(d24.volume, liquidity) : null,
    turnover7d: d7 && liquidity ? ratio(d7.volume, liquidity) : null,
    busiestHourShare30d: d30 && busy30.length ? ratio(Math.max(...busy30.map((h) => h.n)), d30.n) : null,
    busiestHourVolumeShare30d: d30 && busy30.length ? ratio(Math.max(...busy30.map((h) => h.qu)), d30.volume) : null,
    firstTradeAt,
    lastTradeAt,
    washLikeHours7d: rows ? recent.length : null,
    washLikeHoursTotal: rows ? churn.reduce((s, c) => s + c.recent.length + c.past.length, 0) : null,
    washLikeShare7d: recentShare,
    washPeakPerHour: recent.length ? Math.max(...recent.map((h) => h.n)) : null,
    washAvgTradeQu: recentTrades > 0 ? round(recentQu / recentTrades, 0) : null,
  };
  // Nothing above should be able to go wrong, but a number in a public response is never allowed to be NaN or infinite.
  for (const [k, v] of Object.entries(metrics)) if (typeof v === "number" && !Number.isFinite(v)) (metrics as unknown as Record<string, unknown>)[k] = null;

  return { score, grade: gradeFor(score), flags, reasons, metrics, partial };
}

/* ---------- The endpoints ---------- */

/** What `/v1/health` and `/v1/health/all` say about how to read the grade. */
export const HEALTH_NOTE = "An automated estimate from public QX and QSwap trade data. It cannot see who is trading or anything off the network, and it is not financial advice.";

/** How long a computed grade is reused. */
const CACHE_MS = 60_000;

export interface HealthDeps<A extends HealthAsset = HealthAsset> {
  /** The catalogue as the assets endpoint lists it (`catalog.list()`). */
  assets(): A[];
  /** One asset's hourly sums on one venue (`trades.hours(activityKey(a.symbol, a.issuer), venue)`). Return null when there is no trade index; throwing (a name that cannot be encoded) has the same effect. The asset is then graded without trades and marked partial. */
  hours(asset: A, venue: Venue): HourSum[] | null;
  /** `trades.stats().lowMs`: how far back the hourly sums are complete. Null, or 0, if not known yet. */
  historySince(): number | null;
  /** The clock, in ms. Defaults to `Date.now`. */
  now?(): number;
}

export interface HealthSummary {
  grade: Grade;
  score: number;
  flags: HealthFlag[];
  /** The most important reason, so a list can show it as a tooltip without asking for each asset. */
  reason: string;
}

export interface HealthAllResponse {
  assets: Record<string, HealthSummary>;
  /** ISO time the grades were computed. */
  computedAt: string;
}

export interface HealthResponse extends Health {
  asset: string;
  computedAt: string;
  note: string;
}

export interface HealthService {
  routes: Route[];
  /** One asset by id (case does not matter), or null if the catalogue has none. */
  health(assetId: string): HealthResponse | null;
  all(): HealthAllResponse;
  /** True when the asset's last 7 days look like wash trading (strong evidence only). For the pools feature to mark inflated trade counts. False for an unknown asset. */
  washSuspected(assetId: string): boolean;
}

export function createHealth<A extends HealthAsset>(deps: HealthDeps<A>): HealthService {
  const clock = deps.now ?? Date.now;
  let cache: { at: number; byId: Map<string, Health>; ids: string[] } | null = null;

  const assess = (asset: A, now: number): Health => {
    let hours: HealthInput["hours"] = null;
    try {
      const qx = deps.hours(asset, "QX");
      const swaps = deps.hours(asset, "QSwap");
      if (qx && swaps) hours = { QX: qx, QSwap: swaps };
    } catch {
      // a name or issuer that cannot be encoded has no trades to read
    }
    let historySince: number | null = null;
    try {
      historySince = deps.historySince();
    } catch {
      // unknown: windows are then reported as not covered
    }
    return assessHealth({ asset, hours, historySince, now });
  };

  /** Everything computed at once and kept for a minute, so the whole catalogue costs one pass however many callers ask. */
  function snapshot(): NonNullable<typeof cache> {
    const now = clock();
    if (cache && now >= cache.at && now - cache.at < CACHE_MS) return cache;
    const byId = new Map<string, Health>();
    const ids: string[] = [];
    for (const asset of deps.assets()) {
      byId.set(asset.id.toUpperCase(), assess(asset, now));
      ids.push(asset.id);
    }
    return (cache = { at: now, byId, ids });
  }

  const find = (assetId: string): { id: string; health: Health; at: number } | null => {
    const snap = snapshot();
    const key = assetId.trim().toUpperCase();
    const cached = snap.byId.get(key);
    if (cached) return { id: snap.ids.find((i) => i.toUpperCase() === key)!, health: cached, at: snap.at };
    // An asset added to the catalogue since the snapshot (for example one just searched for) does not wait for the next one.
    const asset = deps.assets().find((x) => x.id.toUpperCase() === key);
    if (!asset) return null;
    const health = assess(asset, snap.at);
    snap.byId.set(key, health);
    snap.ids.push(asset.id);
    return { id: asset.id, health, at: snap.at };
  };

  const health = (assetId: string): HealthResponse | null => {
    const found = find(assetId);
    return found && { asset: found.id, ...found.health, computedAt: iso(found.at), note: HEALTH_NOTE };
  };

  const all = (): HealthAllResponse => {
    const snap = snapshot();
    const assets: Record<string, HealthSummary> = {};
    for (const id of snap.ids) {
      const h = snap.byId.get(id.toUpperCase())!;
      assets[id] = { grade: h.grade, score: h.score, flags: h.flags, reason: h.reasons[0] };
    }
    return { assets, computedAt: iso(snap.at) };
  };

  const routes: Route[] = [
    {
      method: "GET",
      path: "/v1/health",
      doc: {
        summary: "How safe an asset is to trade (a grade from A to E)",
        description: `A grade, a score from 0 to 100, flags, plain-English reasons and the numbers behind them, from the QX book, the QSwap pool and the last six months of trades. Includes a check for trading that looks like one bot churning (wash trading). ${HEALTH_NOTE} Computed at most once a minute.`,
        parameters: [{ name: "asset", in: "query", required: true, schema: { type: "string" }, description: "An asset id from /v1/assets, for example CFB." }],
        responses: { "200": { description: "score, grade, flags, reasons, metrics, partial, computedAt" }, "404": { description: "Unknown asset" } },
      },
      handler: ({ query }) => {
        const id = required(query, "asset");
        const h = health(id);
        if (!h) throw new RouteError(404, `Unknown asset '${id}'`);
        return h;
      },
    },
    {
      method: "GET",
      path: "/v1/health/all",
      limited: false, // one cached pass over the catalogue, cheaper than most of the other endpoints
      doc: {
        summary: "The health grade of every asset in one call",
        description: `{ assets: { [assetId]: { grade, score, flags, reason } }, computedAt }. ${HEALTH_NOTE} Computed at most once a minute.`,
        responses: { "200": { description: "grade, score, flags and the top reason for every asset" } },
      },
      handler: () => all(),
    },
  ];

  return { routes, health, all, washSuspected: (assetId) => find(assetId)?.health.flags.includes("wash-suspected") ?? false };
}

/** The two endpoints and nothing else. Use `createHealth` if you also want `washSuspected`. */
export const healthRoutes = <A extends HealthAsset>(deps: HealthDeps<A>): Route[] => createHealth(deps).routes;
