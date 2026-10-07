import { MARKET_FEES } from "./arbitrage.ts";
import { MAX_MARKERS } from "./backtestchart.ts";
import { RouteError } from "./routes.ts";
import type { Route } from "./routes.ts";
import type { TradeCandle } from "./trades.ts";

/**
 * Tests a simple strategy on the hourly candles of real QX fills and QSwap swaps: "what if I had bought 50,000 QU of CFB every
 * week?". It is a pure function of its input (no clock, no randomness), so the same candles and settings always give the same answer.
 *
 * How it decides and trades, so nothing looks into the future:
 *   - A price-based strategy (bands) looks at the CLOSE of hour t and trades at the OPEN of the next hour that has trades.
 *   - Hold and DCA follow the calendar and never look at a price: they buy at the OPEN of the hour they fall due.
 *   - An hour with no candle (nobody traded) has no price. Nothing is traded in it and no price is made up: a purchase that falls due
 *     there waits for the next hour with trades. The equity curve keeps the last known price through such hours and marks them `stale`.
 *
 * What it cannot know: the depth of the order book or pool at the time (nobody kept that), so every fill is assumed to happen at the
 * candle's price however large it is. That is optimistic, and the result says so.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** What one run may cost, so an endpoint cannot be made to do unbounded work. */
export const BACKTEST_LIMITS = {
  /** Candles accepted (6 months of hours is about 4,400). */
  maxCandles: 12_000,
  /** Longest window, in hours (400 days). */
  maxWindowHours: 24 * 400,
  /** A run that would make more trades than this is refused rather than cut off, because a cut-off result would mislead. */
  maxTrades: 2_000,
  minStartingQu: 1,
  /** One trillion QU: far more than any wallet holds, and small enough that no QU amount loses precision in a double. */
  maxStartingQu: 1_000_000_000_000,
  maxEveryHours: 24 * 365,
  minLookbackHours: 3,
  maxLookbackHours: 24 * 90,
  maxCooldownHours: 24 * 30,
} as const;

/** Bands needs at least this many hourly closes inside its lookback before it will decide anything. */
const MIN_AVERAGE_CANDLES = 3;

/** A price this far (in percent) from the typical close of the hours around it is called odd: see `oddPrices`. */
const ODD_PCT = 40;
/** How many hours with trades on each side are looked at, and how few neighbours make a judgement too shaky to give. */
const ODD_NEIGHBOURS = 12;
const ODD_MIN_NEIGHBOURS = 6;

export type BacktestVenue = "QX" | "QSwap" | "all";

/* ---------- strategies ---------- */

export interface HoldStrategy {
  type: "hold";
}
/** Spends `amountQu` (fees included) every `everyHours` hours until the starting QU runs out. */
export interface DcaStrategy {
  type: "dca";
  amountQu: number;
  everyHours: number;
}
/**
 * Mean reversion. At the close of an hour, if the close is `bandPct` or more below the simple average of the hourly closes of the last
 * `lookbackHours` hours, it buys with `fractionPct` of the QU on hand; if it is `bandPct` or more above, it sells `fractionPct` of the units held.
 * `cooldownHours` is the least wait after a trade before it decides again (without it a price that stays low would buy every single hour).
 */
export interface BandsStrategy {
  type: "bands";
  lookbackHours: number;
  bandPct: number;
  fractionPct: number;
  cooldownHours: number;
}
export type Strategy = HoldStrategy | DcaStrategy | BandsStrategy;
export type StrategyType = Strategy["type"];
export const STRATEGY_TYPES: readonly StrategyType[] = ["hold", "dca", "bands"];

/** A strategy with the parameters it does not need to be told left out; `resolveStrategy` fills them from `STRATEGY_DEFAULTS`. */
export type StrategyInput = HoldStrategy | ({ type: "dca" } & Partial<Omit<DcaStrategy, "type">>) | ({ type: "bands" } & Partial<Omit<BandsStrategy, "type">>);

export const STRATEGY_DEFAULTS = {
  startingQu: 10_000_000,
  dca: { amountQu: 500_000, everyHours: 168 },
  bands: { lookbackHours: 168, bandPct: 5, fractionPct: 25, cooldownHours: 24 },
} as const;

export const STRATEGY_LABELS: Record<StrategyType, string> = { hold: "Buy and hold", dca: "Buy a fixed amount regularly", bands: "Buy dips, sell rallies" };

export function resolveStrategy(s: StrategyInput): Strategy {
  if (s.type === "dca") return { type: "dca", amountQu: s.amountQu ?? STRATEGY_DEFAULTS.dca.amountQu, everyHours: s.everyHours ?? STRATEGY_DEFAULTS.dca.everyHours };
  if (s.type === "bands") {
    const d = STRATEGY_DEFAULTS.bands;
    return { type: "bands", lookbackHours: s.lookbackHours ?? d.lookbackHours, bandPct: s.bandPct ?? d.bandPct, fractionPct: s.fractionPct ?? d.fractionPct, cooldownHours: s.cooldownHours ?? d.cooldownHours };
  }
  return s.type === "hold" ? { type: "hold" } : (s as Strategy); // an unknown type is left as it is for validateStrategy to refuse
}

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
/** 168 hours as "7 days", 36 hours as "36 hours". */
const span = (hours: number) => (hours % 24 === 0 ? `${hours / 24} ${hours === 24 ? "day" : "days"}` : `${n(hours)} ${hours === 1 ? "hour" : "hours"}`);
/** 168 hours as "7-day", 36 hours as "36-hour", for "its 7-day average". */
const spanAdj = (hours: number) => (hours % 24 === 0 ? `${hours / 24}-day` : `${n(hours)}-hour`);

/** A short phrase for the settings, for the page and for agents: "buy 500,000 QU every 7 days". */
export function describeStrategy(s: Strategy): string {
  if (s.type === "hold") return "buy once with all the QU and hold";
  if (s.type === "dca") return `buy with ${n(s.amountQu)} QU every ${span(s.everyHours)}`;
  const wait = s.cooldownHours > 0 ? `, waiting at least ${span(s.cooldownHours)} between trades` : "";
  return `buy with ${n(s.fractionPct, 2)}% of the QU on hand when the price is ${n(s.bandPct, 2)}% below its ${spanAdj(s.lookbackHours)} average, and sell ${n(s.fractionPct, 2)}% of the holding when it is ${n(s.bandPct, 2)}% above${wait}`;
}

/* ---------- fees ---------- */

/**
 * What each venue charges, in the contracts' own terms (Qx.h, Qswap.h) and as QMax's router charges it (`MARKET_FEES`).
 *   QX: the 0.3% trade fee comes out of the seller's QU, rounded up (`value * 3_000_000 / 1e9 + 1`); the buyer pays none.
 *   QSwap: a flat 100,000 QU on every swap (QSWAP_ADDITIONAL_FEE), whatever its size, plus a 0.3% pool fee.
 *   Both: the contract's fee for taking over management of shares (100 QU), which the router counts on every trade and so does this.
 * The 0.3% QSwap pool fee is NOT charged again here: the prices in the candles are what swaps really paid or received (QU in over
 * units out, QU out after the fee over units in), so the fee is already inside them. It is estimated and reported separately.
 */
export interface FeeSettings {
  /** The market the candles were built from. For "all" every trade is charged the cheaper of the two venues' fees for its size. */
  venue: BacktestVenue;
  /** QX: the seller's share of a trade's value (0.003 is 0.3%). */
  qxSellerRate: number;
  /** QX: flat QU per trade. */
  qxFixedQu: number;
  /** QSwap: flat QU per swap: the 100,000 operation fee plus the share-management fee. */
  qswapFixedQu: number;
  /** QSwap: pool fee as a fraction (0.003). Already inside the price; only used to report how much of it was paid. */
  qswapPoolRate: number;
}

export type FeeInput = { venue: BacktestVenue } & Partial<Omit<FeeSettings, "venue">>;

export function feeSettings(f: FeeInput): FeeSettings {
  return {
    venue: f.venue,
    qxSellerRate: f.qxSellerRate ?? MARKET_FEES.qxSellerRate,
    qxFixedQu: f.qxFixedQu ?? MARKET_FEES.qxFixedQu,
    qswapFixedQu: f.qswapFixedQu ?? MARKET_FEES.qswapFixedQu,
    qswapPoolRate: f.qswapPoolRate ?? MARKET_FEES.swapFeeRate / 10_000,
  };
}

/** Qx.h: fee = value * tradeFee / 1e9 + 1 in integers, per matched order. Trades here are one fill, and under 1e12 QU so the contract's overflow branch never applies. */
function qxTradeFee(valueQu: number, rate: number): number {
  if (!(rate > 0)) return 0;
  return Number((BigInt(valueQu) * BigInt(Math.round(rate * 1e9))) / 1_000_000_000n) + 1;
}

export interface TradeFee {
  /** The venue whose fees apply (for "all", the cheaper one). */
  venue: "QX" | "QSwap";
  /** QU paid on top of the price. */
  feeQu: number;
  /** QSwap's pool fee, an estimate of what is already inside the price (0 on QX). */
  poolFeeQu: number;
}

/** The fee on a trade of `valueQu` (units times price, in whole QU). */
export function tradeFee(f: FeeSettings, side: "buy" | "sell", valueQu: number): TradeFee {
  const qx = f.qxFixedQu + (side === "sell" ? qxTradeFee(valueQu, f.qxSellerRate) : 0);
  const qswap = f.qswapFixedQu;
  const useQswap = f.venue === "QSwap" || (f.venue === "all" && qswap < qx);
  if (!useQswap) return { venue: "QX", feeQu: qx, poolFeeQu: 0 };
  // a buy's price already includes the fee on top of the pool's value; a sell's has already had it taken off
  const r = f.qswapPoolRate;
  const pool = side === "buy" ? valueQu * r : (valueQu * r) / (1 - r);
  return { venue: "QSwap", feeQu: qswap, poolFeeQu: Math.round(pool) };
}

/* ---------- input and output ---------- */

export interface BacktestInput {
  /** One-hour candles, oldest first, one per hour with trades. Candles before `startMs` may be passed so averages are warm from the start. */
  candles: TradeCandle[];
  /** Whole QU the account starts with. Nothing is added later. */
  startingQu: number;
  strategy: StrategyInput;
  fees: FeeInput;
  /** The first moment the strategy may act (rounded up to a whole hour). Default: the first candle. */
  startMs?: number;
  /** The end of the test (hours that end after it are left out). Default: the end of the last candle. */
  endMs?: number;
}

export interface BacktestTrade {
  /** The hour whose opening price was used, ms since epoch. */
  t: number;
  side: "buy" | "sell";
  /** The venue whose fees were charged. */
  venue: "QX" | "QSwap";
  /** Whole units. */
  qty: number;
  /** QU per unit: the opening price of the hour. */
  price: number;
  /** A buy: QU paid for the units (rounded up), without fees. */
  quSpent?: number;
  /** A sell: QU the units fetched (rounded down), before fees. */
  quReceived?: number;
  /** QU charged on top. */
  feeQu: number;
  /** Estimate of QSwap's 0.3% pool fee, which is already inside `price`, not part of `feeQu`. */
  poolFeeQu: number;
  /** The change to the QU balance: minus (quSpent + feeQu) for a buy, plus (quReceived - feeQu) for a sell. */
  netQu: number;
  /** Bands only: how far the closing price was from its average when it decided, in percent (negative is below). */
  signalPct?: number;
}

export interface EquityPoint {
  /** The hour, ms since epoch. */
  t: number;
  /** QU in hand plus the units held at this hour's closing price. */
  valueQu: number;
  /** The same for buying everything at the first opportunity and holding. */
  holdValueQu: number;
  /** The closing price used, or null before any price was known. */
  priceQu: number | null;
  /** True when nothing traded this hour, so the price is the last known one. */
  stale?: true;
}

export interface BacktestMetrics {
  startingValueQu: number;
  /** QU in hand plus the final holding at the last known closing price. Selling it would cost more (see `exitFeeQu`). */
  finalValueQu: number;
  returnPct: number;
  holdFinalValueQu: number;
  holdReturnPct: number;
  /** finalValueQu minus holdFinalValueQu. */
  differenceQu: number;
  /** returnPct minus holdReturnPct, in percentage points. */
  differencePct: number;
  /** The biggest fall from a peak of the equity curve, in percent. */
  maxDrawdownPct: number;
  holdMaxDrawdownPct: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  /** Fees charged on top of prices. */
  totalFeesQu: number;
  totalFeesPctOfStart: number;
  /** QSwap's pool fee, estimated; it is inside the prices, not added to totalFeesQu. */
  poolFeesInPriceQu: number;
  /** QU paid for units (without fees) over units bought, across all buys. Null if nothing was bought. */
  averageCostQu: number | null;
  /** The same with the fees on the buys added. */
  averageCostWithFeesQu: number | null;
  finalHoldingQty: number;
  finalCashQu: number;
  /** The last closing price, or null if no hour had trades. */
  lastPriceQu: number | null;
  /** What selling the final holding at the last price would cost in fees. Not in the return. */
  exitFeeQu: number;
}

export interface BacktestResult {
  window: {
    /** The first hour tested and the end of the last one (ms). */
    fromMs: number;
    toMs: number;
    hours: number;
    /** Hours in the window that had trades (and so a price). */
    candleHours: number;
  };
  trades: BacktestTrade[];
  /** One point per hour with trades in the window, plus the first and last hour (marked stale when empty). The endpoint thins a long curve (see `thinEquity`). */
  equity: EquityPoint[];
  metrics: BacktestMetrics;
  warnings: string[];
  /** Hours whose price is far from the typical price around them (see `oddPrices`), and how much of the result leans on one. A note for the reader, not an input to any strategy. */
  odd: {
    /** Hours in the window with trades whose open or close is odd. */
    hours: number;
    /** Trades made at an odd opening price. */
    trades: number;
    /** The final value uses an odd closing price. */
    lastPriceIsOdd: boolean;
    /** The buy-and-hold comparison bought at an odd opening price. */
    holdBuyIsOdd: boolean;
  };
  skipped: {
    /** Trades that could not be made because the amount did not cover the fees, or was under one unit. */
    tooSmall: number;
    /** Purchases that fell due but no hour with trades came before the next one (or the end). */
    noTradingHours: number;
    /** Scheduled purchases that were smaller than set, or not made, because the QU ran out. */
    outOfQu: number;
  };
}

export class BacktestInputError extends Error {
  messages: string[];
  constructor(messages: string[]) {
    super(messages.join(" "));
    this.name = "BacktestInputError";
    this.messages = messages;
  }
}

/* ---------- validation ---------- */

const whole = (name: string, v: unknown, lo: number, hi: number): string[] =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? [] : [`${name} must be a whole number from ${n(lo)} to ${n(hi)}.`];

const decimal = (name: string, v: unknown, lo: number, hi: number, unit: string): string[] =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? [] : [`${name} must be a number from ${n(lo, 2)} to ${n(hi, 2)}${unit}.`];

/** The messages for a strategy's settings that are out of range. Empty if they are fine. */
export function validateStrategy(s: Strategy): string[] {
  const L = BACKTEST_LIMITS;
  if (typeof s !== "object" || s === null) return ["strategy must be an object with a type."];
  if (s.type === "hold") return [];
  if (s.type === "dca") return [...whole("strategy.amountQu", s.amountQu, 1, L.maxStartingQu), ...whole("strategy.everyHours", s.everyHours, 1, L.maxEveryHours)];
  if (s.type === "bands") {
    const out = [
      ...whole("strategy.lookbackHours", s.lookbackHours, L.minLookbackHours, L.maxLookbackHours),
      // under 0.1% a band is inside the noise of one trade's price; 90% is the most that leaves a lower band above zero
      ...decimal("strategy.bandPct", s.bandPct, 0.1, 90, "%"),
      ...whole("strategy.cooldownHours", s.cooldownHours, 0, L.maxCooldownHours),
    ];
    if (!(typeof s.fractionPct === "number" && Number.isFinite(s.fractionPct) && s.fractionPct > 0 && s.fractionPct <= 100))
      out.push("strategy.fractionPct must be more than 0 and at most 100 (the share of the QU or the holding to trade each time).");
    return out;
  }
  return [`strategy.type must be one of ${STRATEGY_TYPES.join(", ")}.`];
}

/** The hours the test covers: those that start at or after `startMs` and end by `endMs`. */
function windowOf(input: BacktestInput): { from: number; hours: number } {
  const first = input.candles[0]?.t;
  const last = input.candles[input.candles.length - 1]?.t;
  const start = input.startMs ?? first;
  const end = input.endMs ?? (last === undefined ? undefined : last + HOUR);
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) return { from: 0, hours: 0 };
  const from = Math.ceil(start / HOUR) * HOUR;
  return { from, hours: Math.max(0, Math.floor((end - from) / HOUR)) };
}

/** The messages for anything in the input that is out of range or malformed. Empty if the run can go ahead. */
export function validateBacktestInput(input: BacktestInput): string[] {
  const L = BACKTEST_LIMITS;
  const out: string[] = [];
  out.push(...whole("startingQu", input.startingQu, L.minStartingQu, L.maxStartingQu));
  const strategy = typeof input.strategy === "object" && input.strategy !== null ? resolveStrategy(input.strategy) : input.strategy;
  out.push(...validateStrategy(strategy as Strategy));
  const v = input.fees?.venue;
  if (v !== "QX" && v !== "QSwap" && v !== "all") out.push("fees.venue must be QX, QSwap or all.");

  for (const [name, t] of [["startMs", input.startMs], ["endMs", input.endMs]] as const)
    if (t !== undefined && !(typeof t === "number" && Number.isFinite(t) && t >= 0)) out.push(`${name} must be a time in milliseconds since 1970.`);
  if (typeof input.startMs === "number" && typeof input.endMs === "number" && input.endMs <= input.startMs) out.push("endMs must be after startMs.");

  if (!Array.isArray(input.candles)) return [...out, "candles must be a list."];
  if (input.candles.length > L.maxCandles) out.push(`Too many candles: ${n(input.candles.length)} (at most ${n(L.maxCandles)}).`);
  else {
    let bad = 0;
    for (let k = 0; k < input.candles.length && bad < 3; k++) {
      const c = input.candles[k];
      const fine = [c?.o, c?.h, c?.l, c?.c].every((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
      const aligned = typeof c?.t === "number" && Number.isFinite(c.t) && c.t % HOUR === 0;
      if (!fine) out.push(`Candle ${k} has a price that is missing or not above zero.`), bad++;
      else if (!aligned) out.push(`Candle ${k} does not start on a whole hour: candles must be one hour wide.`), bad++;
      else if (k > 0 && !(c.t > input.candles[k - 1].t)) out.push(`Candle ${k} is not after the one before it: candles must be oldest first, one per hour.`), bad++;
    }
  }

  if (out.length) return out;
  const { hours } = windowOf(input);
  if (hours > L.maxWindowHours) out.push(`The window is ${n(hours)} hours; at most ${n(L.maxWindowHours)} hours (${n(L.maxWindowHours / 24)} days) can be tested at once.`);
  if (strategy.type === "dca") {
    const buys = Math.ceil(hours / strategy.everyHours);
    if (buys > L.maxTrades) out.push(`That would make ${n(buys)} purchases; at most ${n(L.maxTrades)} per run. Raise strategy.everyHours or shorten the range.`);
  }
  return out;
}

/* ---------- whole-QU arithmetic ---------- */

// A price is a float (QSwap's is QU over units), so a product that should be a whole number can land a hair off it; these ignore that hair.
const ceilQu = (x: number) => Math.ceil(x - Math.abs(x) * 1e-14);
const floorQu = (x: number) => Math.floor(x + Math.abs(x) * 1e-14);
const cents = (x: number) => Math.round(x * 100) / 100;

/** The most whole units that `budgetQu` buys at `price`, fees included (0 if it does not cover the fee and one unit). */
function buyQty(f: FeeSettings, price: number, budgetQu: number): number {
  if (!(budgetQu > 0)) return 0;
  // a buyer's fee is flat, so the fee at the full budget is exact; if it ever grew with size this would err on the side of buying less
  const flat = tradeFee(f, "buy", budgetQu).feeQu;
  let qty = Math.min(floorQu((budgetQu - flat) / price), Number.MAX_SAFE_INTEGER);
  const cost = (q: number) => ceilQu(q * price) + tradeFee(f, "buy", ceilQu(q * price)).feeQu;
  while (qty > 0 && cost(qty) > budgetQu) qty--;
  return Math.max(0, qty);
}

interface Order {
  side: "buy" | "sell";
  /** Buy: the QU to spend, fees included. */
  budgetQu: number;
  /** Sell: the units to sell. */
  qty: number;
  signalPct?: number;
}

/** The average of the hourly closes in the `lookbackHours` hours up to and including candle `at`. Hours with no trades are left out. */
function movingAverage(candles: TradeCandle[], at: number, lookbackHours: number): { avg: number; count: number } {
  const from = candles[at].t - (lookbackHours - 1) * HOUR;
  let sum = 0;
  let count = 0;
  for (let k = at; k >= 0 && candles[k].t >= from; k--) {
    sum += candles[k].c;
    count++;
  }
  return { avg: sum / count, count };
}

/**
 * Real thin markets print one-off prices: a single large swap moves a small pool far, or a sweep clears a book, and the price comes back an hour
 * later. They are real trades, but nobody could repeat them in size, and a run that bought at one or was valued at one means little. So each candle's
 * open and close are compared with the median close of the (up to) 12 candles either side. Beyond 40% away is "odd". This looks at the hours after
 * the fact and only to tell the reader; the strategies never see it.
 */
function oddPrices(candles: TradeCandle[]): { open: boolean[]; close: boolean[] } {
  const open: boolean[] = [];
  const close: boolean[] = [];
  for (let i = 0; i < candles.length; i++) {
    const around: number[] = [];
    for (let j = Math.max(0, i - ODD_NEIGHBOURS); j <= Math.min(candles.length - 1, i + ODD_NEIGHBOURS); j++) if (j !== i) around.push(candles[j].c);
    if (around.length < ODD_MIN_NEIGHBOURS) {
      open.push(false);
      close.push(false);
      continue;
    }
    around.sort((a, b) => a - b);
    const mid = around.length >> 1;
    const median = around.length % 2 ? around[mid] : (around[mid - 1] + around[mid]) / 2;
    const far = (x: number) => Math.abs(x / median - 1) * 100 > ODD_PCT;
    open.push(far(candles[i].o));
    close.push(far(candles[i].c));
  }
  return { open, close };
}

function maxDrawdown(values: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return cents(worst * 100);
}

/** Replays the strategy hour by hour over the candles. Throws `BacktestInputError` for input that is out of range (see `validateBacktestInput`). */
export function runBacktest(input: BacktestInput): BacktestResult {
  const problems = validateBacktestInput(input);
  if (problems.length) throw new BacktestInputError(problems);
  const strategy = resolveStrategy(input.strategy);
  const fees = feeSettings(input.fees);
  const { candles, startingQu } = input;
  const { from, hours } = windowOf(input);

  const at = new Map<number, number>();
  candles.forEach((c, k) => at.set(c.t, k));

  let cash = startingQu;
  let qty = 0;
  let holdCash = startingQu;
  let holdQty = 0;
  let holdBought = false;
  let lastClose: number | null = null;
  let pending: Order | null = null;
  let lastTradeHour = -Infinity;
  let candleHours = 0;
  let emptyRun = 0;
  let longestEmpty = 0;
  let scheduled = 0;
  const skipped = { tooSmall: 0, noTradingHours: 0, outOfQu: 0 };
  const odd = { hours: 0, trades: 0, lastPriceIsOdd: false, holdBuyIsOdd: false };
  const flagged = oddPrices(candles);
  const trades: BacktestTrade[] = [];
  const equity: EquityPoint[] = [];

  const tooManyTrades = () =>
    new BacktestInputError([`This setup makes more than ${n(BACKTEST_LIMITS.maxTrades)} trades in one run. Make it trade less often (a wider band, a longer wait or a longer interval).`]);

  for (let i = 0; i < hours; i++) {
    const t = from + i * HOUR;
    const k = at.get(t);
    const c = k === undefined ? undefined : candles[k];

    // What the calendar asks for as this hour begins. A purchase that is still waiting for an hour with trades is dropped when the next one falls due.
    if (strategy.type === "hold" && i === 0) pending = { side: "buy", budgetQu: startingQu, qty: 0 };
    if (strategy.type === "dca" && i % strategy.everyHours === 0) {
      scheduled++;
      if (pending) skipped.noTradingHours++;
      pending = { side: "buy", budgetQu: strategy.amountQu, qty: 0 };
    }

    if (c) {
      candleHours++;
      if (flagged.open[k!] || flagged.close[k!]) odd.hours++;
      longestEmpty = Math.max(longestEmpty, emptyRun);
      emptyRun = 0;

      // The comparison: everything bought at the first opening price there is, and held.
      if (!holdBought) {
        holdBought = true;
        const q = buyQty(fees, c.o, holdCash);
        if (q > 0) {
          const value = ceilQu(q * c.o);
          holdCash -= value + tradeFee(fees, "buy", value).feeQu;
          holdQty = q;
          odd.holdBuyIsOdd = flagged.open[k!];
        }
      }

      // Orders go through at this hour's opening price.
      if (pending) {
        const order: Order = pending;
        pending = null;
        if (order.side === "buy") {
          const budget = Math.min(order.budgetQu, cash);
          if (strategy.type === "dca" && budget < order.budgetQu) skipped.outOfQu++;
          const q = buyQty(fees, c.o, budget);
          if (q > 0) {
            if (trades.length >= BACKTEST_LIMITS.maxTrades) throw tooManyTrades();
            const value = ceilQu(q * c.o);
            const fee = tradeFee(fees, "buy", value);
            cash -= value + fee.feeQu;
            qty += q;
            lastTradeHour = i;
            if (flagged.open[k!]) odd.trades++;
            trades.push({ t, side: "buy", venue: fee.venue, qty: q, price: c.o, quSpent: value, feeQu: fee.feeQu, poolFeeQu: fee.poolFeeQu, netQu: -(value + fee.feeQu), ...(order.signalPct === undefined ? {} : { signalPct: order.signalPct }) });
          } else if (budget > 0) skipped.tooSmall++;
        } else {
          const q = Math.min(order.qty, qty);
          const gross = floorQu(q * c.o);
          const fee = tradeFee(fees, "sell", gross);
          if (q > 0 && gross - fee.feeQu > 0) {
            if (trades.length >= BACKTEST_LIMITS.maxTrades) throw tooManyTrades();
            cash += gross - fee.feeQu;
            qty -= q;
            lastTradeHour = i;
            if (flagged.open[k!]) odd.trades++;
            trades.push({ t, side: "sell", venue: fee.venue, qty: q, price: c.o, quReceived: gross, feeQu: fee.feeQu, poolFeeQu: fee.poolFeeQu, netQu: gross - fee.feeQu, ...(order.signalPct === undefined ? {} : { signalPct: order.signalPct }) });
          } else if (q > 0) skipped.tooSmall++;
        }
      }
      lastClose = c.c;
      odd.lastPriceIsOdd = flagged.close[k!];

      // Bands: decide on this hour's close; the order goes through at the next hour with trades.
      if (strategy.type === "bands" && i - lastTradeHour >= strategy.cooldownHours) {
        const { avg, count } = movingAverage(candles, k!, strategy.lookbackHours);
        if (count >= Math.min(MIN_AVERAGE_CANDLES, strategy.lookbackHours)) {
          const dev = (c.c / avg - 1) * 100;
          const fraction = strategy.fractionPct / 100;
          // the small allowance keeps a close that is exactly on the band (95 against an average of 100 and a 5% band) from missing it by float noise
          if (dev <= -strategy.bandPct + 1e-9 && cash > 0) pending = { side: "buy", budgetQu: Math.floor(cash * fraction), qty: 0, signalPct: cents(dev) };
          else if (dev >= strategy.bandPct - 1e-9 && qty > 0) pending = { side: "sell", budgetQu: 0, qty: Math.max(1, Math.floor(qty * fraction)), signalPct: cents(dev) };
        }
      }
    } else emptyRun++;

    if (c || i === 0 || i === hours - 1) {
      const px = lastClose;
      equity.push({
        t,
        valueQu: cents(cash + (px === null ? 0 : qty * px)),
        holdValueQu: cents(holdCash + (px === null ? 0 : holdQty * px)),
        priceQu: px,
        ...(c ? {} : { stale: true as const }),
      });
    }
  }
  longestEmpty = Math.max(longestEmpty, emptyRun);
  if (pending && (strategy.type === "hold" || strategy.type === "dca")) skipped.noTradingHours++;
  if (candleHours === 0) equity.length = 0;

  const metrics = buildMetrics({ startingQu, cash, qty, lastClose, trades, equity, fees });
  const warnings = buildWarnings({ strategy, fees, startingQu, hours, candleHours, longestEmpty, scheduled, trades, metrics, skipped, odd });
  return { window: { fromMs: from, toMs: from + hours * HOUR, hours, candleHours }, trades, equity, metrics, warnings, odd, skipped };
}

function buildMetrics(a: { startingQu: number; cash: number; qty: number; lastClose: number | null; trades: BacktestTrade[]; equity: EquityPoint[]; fees: FeeSettings }): BacktestMetrics {
  const { startingQu, trades, equity } = a;
  const last = equity[equity.length - 1];
  const finalValueQu = last ? last.valueQu : startingQu;
  const holdFinalValueQu = last ? last.holdValueQu : startingQu;
  const buys = trades.filter((t) => t.side === "buy");
  const bought = buys.reduce((s, t) => s + t.qty, 0);
  const spent = buys.reduce((s, t) => s + t.quSpent!, 0);
  const buyFees = buys.reduce((s, t) => s + t.feeQu, 0);
  const totalFeesQu = trades.reduce((s, t) => s + t.feeQu, 0);
  const returnPct = cents((finalValueQu / startingQu - 1) * 100);
  const holdReturnPct = cents((holdFinalValueQu / startingQu - 1) * 100);
  const exitFeeQu = a.qty > 0 && a.lastClose !== null ? tradeFee(a.fees, "sell", floorQu(a.qty * a.lastClose)).feeQu : 0;
  return {
    startingValueQu: startingQu,
    finalValueQu,
    returnPct,
    holdFinalValueQu,
    holdReturnPct,
    differenceQu: cents(finalValueQu - holdFinalValueQu),
    differencePct: cents(returnPct - holdReturnPct),
    maxDrawdownPct: maxDrawdown(equity.map((p) => p.valueQu)),
    holdMaxDrawdownPct: maxDrawdown(equity.map((p) => p.holdValueQu)),
    tradeCount: trades.length,
    buyCount: buys.length,
    sellCount: trades.length - buys.length,
    totalFeesQu,
    totalFeesPctOfStart: cents((totalFeesQu / startingQu) * 100),
    poolFeesInPriceQu: trades.reduce((s, t) => s + t.poolFeeQu, 0),
    averageCostQu: bought > 0 ? spent / bought : null,
    averageCostWithFeesQu: bought > 0 ? (spent + buyFees) / bought : null,
    finalHoldingQty: a.qty,
    finalCashQu: a.cash,
    lastPriceQu: a.lastClose,
    exitFeeQu,
  };
}

function buildWarnings(a: {
  strategy: Strategy;
  fees: FeeSettings;
  startingQu: number;
  hours: number;
  candleHours: number;
  longestEmpty: number;
  scheduled: number;
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  skipped: BacktestResult["skipped"];
  odd: BacktestResult["odd"];
}): string[] {
  const { strategy, fees, hours, candleHours, metrics: m, trades, skipped, odd } = a;
  const out: string[] = [];
  const flat = fees.qswapFixedQu;
  const qswapInvolved = fees.venue !== "QX";
  // the flat fee a buy has to cover: on "all" a buy goes to QX, the cheaper venue, for any size
  const buyFlat = fees.venue === "QSwap" ? fees.qswapFixedQu : fees.qxFixedQu;

  if (hours === 0 || candleHours === 0) out.push("Nothing traded in this date range, so there is nothing to test. Try a longer range or another market.");
  else if (candleHours < 2) out.push(`Only ${candleHours} hour with trades in this range: far too little to judge a strategy.`);

  if (candleHours > 0) {
    if (!trades.length) {
      const why =
        skipped.tooSmall > 0
          ? `every trade it tried was too small: the amount did not cover the fixed fee of ${n(buyFlat)} QU and one unit`
          : strategy.type === "bands"
            ? `no hour closed ${n(strategy.bandPct, 2)}% or more away from its ${spanAdj(strategy.lookbackHours)} average (or there were fewer than ${MIN_AVERAGE_CANDLES} hourly closes to average)`
            : "no hour with trades came up when a purchase was due";
      out.push(`The strategy made no trades because ${why}.`);
    }

    // Fees: say plainly when they decided the result.
    if (trades.length) {
      const gain = m.finalValueQu - m.startingValueQu;
      const before = gain + m.totalFeesQu; // what it would have made with no fees, give or take a unit of rounding
      const feesText = `${n(m.totalFeesQu)} QU (${n(m.totalFeesPctOfStart, 2)}% of the QU you started with)`;
      if (before > 0 && gain <= 0) out.push(`Fees ate the result: before fees the strategy was ${n(before)} QU ahead, but fees of ${feesText} left it ${gain < 0 ? `${n(-gain)} QU behind` : "level"}.`);
      else if (before > 0 && m.totalFeesQu >= before / 2) out.push(`Fees took ${n((m.totalFeesQu / before) * 100)}% of the gain: ${feesText} out of ${n(before)} QU before fees.`);
      else if (m.totalFeesPctOfStart >= 1) out.push(`Fees came to ${feesText}.`);
      const avgTrade = trades.reduce((s, t) => s + (t.quSpent ?? t.quReceived ?? 0), 0) / trades.length;
      if (qswapInvolved && trades.some((t) => t.venue === "QSwap") && flat / avgTrade >= 0.01)
        out.push(`QSwap charges a flat ${n(flat)} QU on every swap whatever its size. Here the average trade was ${n(avgTrade)} QU, so that flat fee alone took ${n((flat / avgTrade) * 100, 1)}% of each trade.`);
    }
    if (skipped.tooSmall > 0 && trades.length) out.push(`${n(skipped.tooSmall)} ${skipped.tooSmall === 1 ? "trade was" : "trades were"} skipped because the amount did not cover the fixed fee and one unit.`);
    if (skipped.outOfQu > 0) out.push(`The starting QU ran out: ${n(skipped.outOfQu)} of the ${n(a.scheduled)} scheduled purchases were smaller than set or not made.`);
    if (skipped.noTradingHours > 0) out.push(`${n(skipped.noTradingHours)} ${skipped.noTradingHours === 1 ? "purchase was" : "purchases were"} not made because nothing traded between when ${skipped.noTradingHours === 1 ? "it" : "each"} fell due and the next purchase (or the end of the test).`);
    if (m.finalHoldingQty > 0 && m.exitFeeQu > 0) out.push(`The final value counts the ${n(m.finalHoldingQty)} units held at the last traded price. Selling them would cost about ${n(m.exitFeeQu)} QU more in fees, which is not in the return.`);

    if (odd.hours > 0) {
      const uses = [
        odd.trades > 0 ? `${n(odd.trades)} of this strategy's ${n(trades.length)} ${trades.length === 1 ? "trade" : "trades"} used one as the price` : "",
        odd.lastPriceIsOdd ? "the final value is counted at one" : "",
        odd.holdBuyIsOdd ? "the buy-and-hold comparison bought at one" : "",
      ].filter(Boolean);
      out.push(
        `${n(odd.hours)} of the ${n(candleHours)} hours with trades have a price more than ${ODD_PCT}% away from the typical price of the hours around them: one-off spikes, usually a thin market moved by a single large trade. They are real trades, but you may not have been able to trade at such a price in any size, and they show up as spikes in the value line and in the worst drop.${uses.length ? ` Here ${uses.join(", ")}, so treat this result with extra care.` : ""}`,
      );
    }
    if (candleHours / hours < 0.5) out.push(`The asset traded in only ${n(candleHours)} of ${n(hours)} hours (${n((candleHours / hours) * 100)}%). Hours with no trades have no price, so nothing could be traded in them.`);
    if (a.longestEmpty >= 24) out.push(`Nothing traded for up to ${n(a.longestEmpty)} hours in a row (${n(a.longestEmpty / 24, 1)} days). The strategy could not trade in those hours, and the value line holds the last known price through them.`);
  }

  if (fees.venue === "all")
    out.push("Market 'all' joins QX and QSwap into one price series and charges each trade the cheaper market's fees for its size. In reality the two markets quote different prices at any moment, so this is optimistic.");
  if (fees.venue === "QSwap" && candleHours > 0) out.push(`QSwap's 0.3% pool fee is already inside its prices (they are what swaps really paid or received), so it is not charged a second time. Only the flat ${n(flat)} QU is added.`);

  out.push(
    "No order book or pool depth was kept, so every trade is assumed to fill at the hour's opening price however large it is. That is optimistic, especially for thin assets where a big order would move the price, and it ignores the gap between the price to buy and the price to sell.",
    "The data is hourly: each candle sums up every trade in the hour. A strategy decides on an hour's closing price and trades at the next hour's opening price, which is the first trade of that hour, not a price you were sure to get.",
    "Past results do not predict future ones.",
  );
  return out;
}

/* ---------- describing a run ---------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (ms: number, withYear: boolean) => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? `, ${d.getUTCFullYear()}` : ""}`;
};

/**
 * One plain sentence about what the run did, for the top of the result: "Bought 50,000 QU of QDOGE every 7 days from Jul 7 to Oct 4 at the
 * next hour's opening price, paying fees of 1,300,100 QU (2.6% of the 50,000,000 QU you started with)."
 */
export function summarizeBacktest(r: { symbol: string; startingQu: number; strategy: Strategy; result: BacktestResult }): string {
  const { result: x, strategy: s, symbol } = r;
  const years = new Date(x.window.fromMs).getUTCFullYear() !== new Date(x.window.toMs - 1).getUTCFullYear();
  const when = x.window.hours > 0 ? `from ${day(x.window.fromMs, years)} to ${day(x.window.toMs - 1, years)}` : "in this range";
  const m = x.metrics;
  if (!m.tradeCount) {
    const why =
      x.window.candleHours === 0
        ? "nothing traded"
        : x.skipped.tooSmall > 0
          ? "the amount was too small to cover the fixed fee and one unit"
          : s.type === "bands"
            ? "the price never moved far enough from its average"
            : "no hour with trades came up when a purchase was due";
    return `Made no trades ${when}: ${why}.`;
  }
  const fees = `paying fees of ${n(m.totalFeesQu)} QU (${n(m.totalFeesPctOfStart, 2)}% of the ${n(r.startingQu)} QU you started with)`;
  if (s.type === "hold") return `Bought ${symbol} once with ${n(r.startingQu)} QU at the opening price of the first hour with trades and held it ${when}, ${fees}.`;
  if (s.type === "dca") return `Bought ${n(s.amountQu)} QU of ${symbol} every ${span(s.everyHours)} ${when} at the next hour's opening price (${n(m.buyCount)} ${m.buyCount === 1 ? "purchase" : "purchases"}), ${fees}.`;
  return `Bought ${symbol} with ${n(s.fractionPct, 2)}% of the QU on hand when an hour closed ${n(s.bandPct, 2)}% or more below its ${spanAdj(s.lookbackHours)} average, and sold ${n(s.fractionPct, 2)}% of the holding when it closed ${n(s.bandPct, 2)}% or more above it, trading at the next hour's opening price ${when} (${n(m.buyCount)} ${m.buyCount === 1 ? "buy" : "buys"}, ${n(m.sellCount)} ${m.sellCount === 1 ? "sell" : "sells"}), ${fees}.`;
}

/* ---------- the endpoint ---------- */

export type BacktestRange = "30d" | "90d" | "all";
export const BACKTEST_RANGES: Record<BacktestRange, number | null> = { "30d": 30 * DAY, "90d": 90 * DAY, all: null };
export type BacktestVenueRequest = "auto" | BacktestVenue;
const VENUE_REQUESTS: readonly BacktestVenueRequest[] = ["auto", "QX", "QSwap", "all"];

/** The body of POST /v1/backtest. */
export interface BacktestRequest {
  asset: string;
  range?: BacktestRange;
  venue?: BacktestVenueRequest;
  startingQu: number;
  strategy: StrategyInput;
}

/** The most equity points a response carries; a long run is thinned to this (the chart cannot show more, and the response stays small). */
export const MAX_RESPONSE_EQUITY_POINTS = 1_500;

/**
 * Keeps the first and last points, the hour of each trade when there are few enough to be marked, and an even spread of the rest, in time order.
 * The metrics are worked out on the full curve before this, so thinning changes only what is drawn.
 */
export function thinEquity(points: EquityPoint[], trades: Pick<BacktestTrade, "t">[], max = MAX_RESPONSE_EQUITY_POINTS): EquityPoint[] {
  if (points.length <= max) return points;
  const keep = new Set<number>([0, points.length - 1]);
  if (trades.length <= MAX_MARKERS) {
    const at = new Set(trades.map((t) => t.t));
    points.forEach((p, k) => at.has(p.t) && keep.add(k));
  }
  const stride = Math.ceil(points.length / Math.max(1, max - keep.size));
  for (let k = 0; k < points.length; k += stride) keep.add(k);
  return [...keep].sort((a, b) => a - b).map((k) => points[k]);
}

export interface BacktestResponse extends BacktestResult {
  /** Set when `equity` was thinned: how many points the full curve had. */
  equityPointsBeforeThinning?: number;
  asset: string;
  range: BacktestRange;
  /** The market the candles came from (what "auto" resolved to). */
  venue: BacktestVenue;
  venueRequested: BacktestVenueRequest;
  startingQu: number;
  /** The strategy with every setting filled in. */
  strategy: Strategy;
  /** One plain sentence about what was done. */
  summary: string;
}

export interface BacktestDeps {
  /** Candles of `intervalMs` from `sinceMs`, for one asset on one venue ("auto" lets the server choose and says which it chose), or null for an unknown asset. */
  candles(assetId: string, venue: BacktestVenueRequest, intervalMs: number, sinceMs: number): { asset: string; venue: BacktestVenue; candles: TradeCandle[] } | null;
  /** The current time in ms. Tests pass their own. */
  now?(): number;
}

const PARAMS: Record<StrategyType, readonly string[]> = { hold: [], dca: ["amountQu", "everyHours"], bands: ["lookbackHours", "bandPct", "fractionPct", "cooldownHours"] };
const BODY_KEYS = ["asset", "range", "venue", "startingQu", "strategy"] as const;

/** Reads the strategy out of a request body: the right type, only its own settings, numbers only. Returns the messages for anything wrong. */
export function parseStrategy(raw: unknown): { strategy: Strategy | null; problems: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { strategy: null, problems: [`strategy must be an object such as { "type": "dca", "amountQu": 500000, "everyHours": 168 }.`] };
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== "string" || !(STRATEGY_TYPES as readonly string[]).includes(type)) return { strategy: null, problems: [`strategy.type must be one of ${STRATEGY_TYPES.join(", ")}.`] };
  const problems: string[] = [];
  const allowed = PARAMS[type as StrategyType];
  for (const key of Object.keys(o)) if (key !== "type" && !allowed.includes(key)) problems.push(`strategy.${key} is not a setting of '${type}'${allowed.length ? ` (it takes ${allowed.join(", ")})` : " (it takes none)"}.`);
  for (const key of allowed) if (o[key] !== undefined && (typeof o[key] !== "number" || !Number.isFinite(o[key]))) problems.push(`strategy.${key} must be a number.`);
  if (problems.length) return { strategy: null, problems };
  const strategy = resolveStrategy(o as unknown as StrategyInput);
  const range = validateStrategy(strategy);
  return range.length ? { strategy: null, problems: range } : { strategy, problems: [] };
}

export function backtestRoutes(deps: BacktestDeps): Route[] {
  return [
    {
      method: "POST",
      path: "/v1/backtest",
      doc: {
        summary: "Test a simple strategy on the real trade history of an asset",
        description:
          "Replays a strategy over hourly candles of real QX fills and QSwap swaps. A price-based strategy decides on the close of an hour and trades at the open of the next hour with trades; hold and dca follow the calendar. Fees are the contracts' own (QX 0.3% from the seller; QSwap a flat 100,000 QU per swap, with its 0.3% pool fee already inside its prices). Order book depth was not kept, so every fill is assumed at the candle price: optimistic for large amounts and thin assets. Past results do not predict future ones.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["asset", "startingQu", "strategy"],
                additionalProperties: false,
                properties: {
                  asset: { type: "string", example: "QDOGE" },
                  range: { type: "string", enum: ["30d", "90d", "all"], default: "90d" },
                  venue: { type: "string", enum: [...VENUE_REQUESTS], default: "auto", description: "Which market's trades make the price series. 'all' joins both and charges each trade the cheaper venue's fees." },
                  startingQu: { type: "integer", minimum: BACKTEST_LIMITS.minStartingQu, maximum: BACKTEST_LIMITS.maxStartingQu, example: STRATEGY_DEFAULTS.startingQu },
                  strategy: {
                    type: "object",
                    required: ["type"],
                    description: `hold: no settings. dca: amountQu (default ${STRATEGY_DEFAULTS.dca.amountQu}, fees included) every everyHours (default ${STRATEGY_DEFAULTS.dca.everyHours}). bands: lookbackHours (${STRATEGY_DEFAULTS.bands.lookbackHours}), bandPct (${STRATEGY_DEFAULTS.bands.bandPct}), fractionPct (${STRATEGY_DEFAULTS.bands.fractionPct}), cooldownHours (${STRATEGY_DEFAULTS.bands.cooldownHours}).`,
                    properties: {
                      type: { type: "string", enum: [...STRATEGY_TYPES] },
                      amountQu: { type: "integer" },
                      everyHours: { type: "integer" },
                      lookbackHours: { type: "integer" },
                      bandPct: { type: "number" },
                      fractionPct: { type: "number" },
                      cooldownHours: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The summary sentence, the trades, the equity curve, metrics and warnings, with the inputs echoed back" },
          "400": { description: "A setting is missing or out of range; `error` names each one" },
          "404": { description: "Unknown asset" },
        },
      },
      handler({ body }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RouteError(400, "Send a JSON object with asset, startingQu and strategy.", { problems: ["Send a JSON object with asset, startingQu and strategy."] });
        const b = body as Record<string, unknown>;
        const problems: string[] = [];
        for (const key of Object.keys(b)) if (!(BODY_KEYS as readonly string[]).includes(key)) problems.push(`Unknown field '${key}'. The fields are ${BODY_KEYS.join(", ")}.`);

        const asset = typeof b.asset === "string" ? b.asset.trim() : "";
        if (!/^[A-Za-z0-9._-]{1,32}$/.test(asset)) problems.push("asset is required: the asset's symbol, such as QDOGE.");
        const range = b.range ?? "90d";
        if (!(typeof range === "string" && Object.hasOwn(BACKTEST_RANGES, range))) problems.push(`range must be one of ${Object.keys(BACKTEST_RANGES).join(", ")}.`);
        const venue = b.venue ?? "auto";
        if (!(typeof venue === "string" && (VENUE_REQUESTS as readonly string[]).includes(venue))) problems.push(`venue must be one of ${VENUE_REQUESTS.join(", ")}.`);
        problems.push(...whole("startingQu", b.startingQu, BACKTEST_LIMITS.minStartingQu, BACKTEST_LIMITS.maxStartingQu));
        const parsed = parseStrategy(b.strategy);
        problems.push(...parsed.problems);
        if (problems.length || !parsed.strategy) throw new RouteError(400, problems.join(" "), { problems });

        const strategy = parsed.strategy;
        const rangeKey = range as BacktestRange;
        const now = deps.now?.() ?? Date.now();
        // The hour in progress is not finished, so the test ends where the last whole hour ended.
        const endMs = Math.floor(now / HOUR) * HOUR;
        const span = BACKTEST_RANGES[rangeKey];
        const startMs = span === null ? undefined : endMs - span;
        // Bands needs earlier closes to average, so read back that far before the range begins (it only trades inside the range).
        const warmup = strategy.type === "bands" ? strategy.lookbackHours * HOUR : 0;
        const sinceMs = startMs === undefined ? 0 : Math.max(0, startMs - warmup);

        const found = deps.candles(asset, venue as BacktestVenueRequest, HOUR, sinceMs);
        if (!found) throw new RouteError(404, `Unknown asset '${asset}'`);
        let result: BacktestResult;
        try {
          result = runBacktest({ candles: found.candles, startingQu: b.startingQu as number, strategy, fees: { venue: found.venue }, startMs, endMs });
        } catch (e) {
          if (e instanceof BacktestInputError) throw new RouteError(400, e.messages.join(" "), { problems: e.messages });
          throw e;
        }
        const equity = thinEquity(result.equity, result.trades);
        const response: BacktestResponse = {
          asset: found.asset,
          range: rangeKey,
          venue: found.venue,
          venueRequested: venue as BacktestVenueRequest,
          startingQu: b.startingQu as number,
          strategy,
          summary: summarizeBacktest({ symbol: found.asset, startingQu: b.startingQu as number, strategy, result }),
          ...result,
          equity,
          ...(equity.length < result.equity.length ? { equityPointsBeforeThinning: result.equity.length } : {}),
        };
        return response;
      },
    },
  ];
}
