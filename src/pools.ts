import { RouteError, oneOf, plainNumber, required } from "./routes.ts";
import type { Route } from "./routes.ts";
import type { Hour } from "./trades.ts";

/**
 * What a QSwap liquidity pool really earns, worked out from the swaps the network logged: the fee income that reaches liquidity
 * providers, the impermanent loss from the price moving, and a ranking of the pools. Everything here is a trailing estimate; the
 * module says so wherever it hands out a number. It is browser-safe on purpose (the web panel imports its constants and types).
 *
 * How QSwap splits a swap fee, read from the contract (https://github.com/qubic/core/blob/main/src/contracts/Qswap.h), and
 * checked against the deployed contract: its public `Fees` function (QSwap contract 13, function 1) returned swapFee 30,
 * shareholderFee 27, investRewardsFee 3, qxFee 5, burnFee 1 on 2026-10-04.
 *
 *  - Every swap pays a fee of `swapFeeRate / QSWAP_SWAP_FEE_BASE` = 30 / 10,000 = 0.3% of the QU side of the swap.
 *  - That fee is split in percent of the fee (`QSWAP_FEE_BASE_100`): 27 to the contract's shareholders, 5 to QX, 3 to Invest &
 *    Rewards, 1 burned. The rest, 64%, stays in the pool (the contract adds it to `accFeePerLPX64`, and it is part of the
 *    reserves the swap leaves behind: `reservedQuAmount += quAmountIn - totalFee` where totalFee is only the 36%).
 *  - Liquidity providers do not claim fees separately. `RemoveLiquidity` pays `burnLiquidity * reserves / totalLiquidity`, so the
 *    64% comes back inside the QU you withdraw. (`accumulatedFee` / `earnedFees` in the contract is a bookkeeping figure that
 *    `GetLiquidityOf` reports; nothing transfers it.)
 *  - So of each QU swapped, 0.3% x 64% = 0.192% reaches liquidity providers.
 *  - Separately, every swap, AddLiquidity and RemoveLiquidity costs the caller a flat `QSWAP_ADDITIONAL_FEE` = 100,000 QU on top
 *    (75% to shareholders, 25% burned). None of it reaches liquidity providers. It does mean adding and removing liquidity
 *    costs 100,000 QU each, which matters for a small position.
 *
 * What "volume" is: the trade index sums the QU of each logged swap. For a swap that pays QU in (a buy) that is the QU paid in,
 * and the 0.3% is taken from it. For a swap that pays QU out (a sell) the log holds the QU the seller received, which is already
 * net of the fee (the contract takes the fee from the gross output), so the fee on a sell is really 0.3% / 0.997 of the logged
 * figure. The hourly sums do not say which way each swap went, so the estimate uses 0.192% of the logged volume for both: on sells
 * it understates the fee by 0.3% of itself (never overstates). The 100,000 QU flat fee is not part of the logged amounts.
 */

/** Qswap.h `QSWAP_SWAP_FEE_BASE`: the swap fee rate is a number out of this. */
export const QSWAP_SWAP_FEE_BASE = 10_000;
/** Qswap.h `QSWAP_FEE_BASE_100`: the shares of the swap fee below are percentages, out of this. */
export const QSWAP_FEE_BASE_100 = 100;
/** Qswap.h `INITIALIZE`: `swapFeeRate = 30`, which is 0.3% of 10,000 (a state value; the live `Fees` function confirms 30). */
export const QSWAP_SWAP_FEE_RATE = 30;
/** Percent of the swap fee, from `INITIALIZE`: to the contract's shareholders (paid out as dividends at the end of each tick). */
export const QSWAP_SHAREHOLDER_SHARE = 27;
/** Percent of the swap fee to QX (`qxFeeRate`, donated to the QX contract). */
export const QSWAP_QX_SHARE = 5;
/** Percent of the swap fee to Invest & Rewards (`investRewardsFeeRate`). */
export const QSWAP_INVEST_REWARDS_SHARE = 3;
/** Percent of the swap fee burned (`burnFeeRate`). */
export const QSWAP_BURN_SHARE = 1;
/** Qswap.h `QSWAP_ADDITIONAL_FEE`: flat QU charged on every swap, AddLiquidity and RemoveLiquidity. 75% shareholders, 25% burned. */
export const QSWAP_ADDITIONAL_FEE = 100_000;

/** The swap fee as a fraction of the QU swapped: 30 / 10,000. */
export const SWAP_FEE_FRACTION = QSWAP_SWAP_FEE_RATE / QSWAP_SWAP_FEE_BASE;
/** Percent of the swap fee that is not liquidity providers': 27 + 5 + 3 + 1. */
export const NON_LP_SHARE = QSWAP_SHAREHOLDER_SHARE + QSWAP_QX_SHARE + QSWAP_INVEST_REWARDS_SHARE + QSWAP_BURN_SHARE;
/** Percent of the swap fee that stays in the pool for liquidity providers: what is left, 64. */
export const LP_SHARE_OF_FEE = QSWAP_FEE_BASE_100 - NON_LP_SHARE;
/**
 * The share of every QU swapped that reaches liquidity providers: 0.3% x 64% = 0.192% (0.00192).
 * Written as one division so it is the nearest double to 1920 / 1,000,000.
 */
export const LP_FEE_FRACTION = (QSWAP_SWAP_FEE_RATE * LP_SHARE_OF_FEE) / (QSWAP_SWAP_FEE_BASE * QSWAP_FEE_BASE_100);

/** The fee model in the shape the API and the web panel show it (percent, so no one has to multiply by 100). */
export const FEE_MODEL = {
  swapFeePct: SWAP_FEE_FRACTION * 100,
  /** Percent of a swap's value that reaches liquidity providers (0.192). */
  lpFeePctOfVolume: LP_FEE_FRACTION * 100,
  /** Who gets the swap fee, in percent of the fee. */
  split: [
    { who: "Liquidity providers", pct: LP_SHARE_OF_FEE },
    { who: "QSwap shareholders", pct: QSWAP_SHAREHOLDER_SHARE },
    { who: "QX", pct: QSWAP_QX_SHARE },
    { who: "Invest & Rewards", pct: QSWAP_INVEST_REWARDS_SHARE },
    { who: "Burned", pct: QSWAP_BURN_SHARE },
  ],
  /** Flat QU on every swap, AddLiquidity and RemoveLiquidity. Not liquidity providers' income. */
  flatFeeQu: QSWAP_ADDITIONAL_FEE,
} as const;

export interface FeeSplit {
  swapFee: number;
  shareholders: number;
  qx: number;
  investRewards: number;
  burn: number;
  /** What stays in the pool for liquidity providers. */
  lp: number;
}

/**
 * The split of one swap's fee with the contract's own integer arithmetic (every share rounded down, the pool keeps the remainder),
 * for a QU amount that goes in and is charged the fee. For tests and for explaining the numbers; the estimates use the exact
 * fraction `LP_FEE_FRACTION`, which differs only by rounding on tiny swaps (and a swap under about 334 QU pays the contract's
 * minimum fee of 100 QU, which the contract refuses anyway unless the swap is at least 36 QU: both are far below real volume).
 */
export function feeSplit(quAmountIn: number): FeeSplit {
  const zero: FeeSplit = { swapFee: 0, shareholders: 0, qx: 0, investRewards: 0, burn: 0, lp: 0 };
  if (!Number.isFinite(quAmountIn) || quAmountIn <= 0) return zero;
  const q = BigInt(Math.floor(quAmountIn));
  let swapFee = (q * BigInt(QSWAP_SWAP_FEE_RATE)) / BigInt(QSWAP_SWAP_FEE_BASE);
  if (swapFee === 0n) swapFee = BigInt(QSWAP_FEE_BASE_100); // the contract never charges nothing
  const part = (share: number) => (swapFee * BigInt(share)) / BigInt(QSWAP_FEE_BASE_100);
  const shareholders = part(QSWAP_SHAREHOLDER_SHARE);
  const qx = part(QSWAP_QX_SHARE);
  const investRewards = part(QSWAP_INVEST_REWARDS_SHARE);
  const burn = part(QSWAP_BURN_SHARE);
  return {
    swapFee: Number(swapFee),
    shareholders: Number(shareholders),
    qx: Number(qx),
    investRewards: Number(investRewards),
    burn: Number(burn),
    lp: Number(swapFee - shareholders - qx - investRewards - burn),
  };
}

/* ---------- windows, thresholds and shapes ---------- */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const POOL_WINDOWS = ["7d", "30d"] as const;
export type PoolWindow = (typeof POOL_WINDOWS)[number];
export const WINDOW_DAYS: Record<PoolWindow, number> = { "7d": 7, "30d": 30 };
export const POOL_SORTS = ["apr", "tvl", "volume"] as const;
export type PoolSort = (typeof POOL_SORTS)[number];

/** Fewer swaps than this per day on average and the volume is "thin": a couple of trades decide the APR. A judgement call, not a contract fact. */
export const THIN_SWAPS_PER_DAY = 1;
/** One hour holding at least this share of the window's volume makes the APR a burst, not a rate. Judgement call. */
export const CONCENTRATED_HOUR_SHARE = 0.5;
/** Swap prices spanning at least this factor (highest over lowest) inside the window mean a thin pool or a one-off huge swap. Judgement call. */
export const WIDE_PRICE_RANGE = 3;
/** A pool holding less than this much in total (QU, both sides) is "tiny": one swap moves its price a lot. Judgement call. */
export const SMALL_POOL_TVL_QU = 100_000_000;

export const POOLS_CAVEAT = "Trailing estimate from swap volume. Past fees do not predict future fees; price moves cause impermanent loss.";

/** The part of an `Hour` this module reads (a full `Hour` fits). */
export type PoolHour = Pick<Hour, "hour" | "qu" | "qty" | "n" | "open" | "close" | "high" | "low">;

export type QualityCode = "inflated-volume" | "no-swaps" | "partial-history" | "small-pool" | "thin-volume" | "concentrated-volume" | "wide-price-range" | "young-pool" | "no-price";

export interface QualityNote {
  code: QualityCode;
  /** Two or three words, for a pill. */
  label: string;
  /** One or two plain sentences. */
  message: string;
}

export interface PoolStatsInput {
  /** The asset's id: what `suspectWash` is asked about. */
  id: string;
  /** What the pool holds right now. */
  poolQu: number;
  poolAsset: number;
  /** The asset's QSwap hours, oldest first or not (they are sorted here). Null or empty means no swaps are known. */
  hours: PoolHour[] | null;
  window: PoolWindow;
  /** ms since epoch. Defaults to the clock. */
  now?: number;
  /** The trade index has read the network's swaps from this time on (ms): pass it while the index is still scanning back, so a half-read window is not mistaken for a quiet one. */
  coveredSince?: number;
  /** True when the asset's volume looks like wash trading. Only passed on as a flag: the numbers are not changed. */
  suspectWash?: (assetId: string) => boolean;
}

export interface PoolStats {
  window: PoolWindow;
  windowDays: number;
  /** The days the volume is spread over to get a rate: the window, or less while the index has read only part of it. */
  rateDays: number;
  /** QU side times two. Assumes the pool is balanced at the pool price (the asset side is worth the same as the QU side), which is true for a constant-product pool when the asset is valued at the pool's own price. If the asset sells for less elsewhere, the real value is lower. */
  tvlQu: number;
  /** QU per unit, from the reserves. Null when either side is empty. */
  poolPriceQu: number | null;
  /** QU that went through swaps (hours overlapping the window; the hour the window starts in counts whole). */
  volumeQu: number;
  swaps: number;
  activeHours: number;
  /** The busiest hour's share of the window's volume, in percent. */
  topHourSharePct: number;
  /** Highest swap price over lowest within the window, or null with no swaps. */
  priceRangeRatio: number | null;
  /** What reached liquidity providers: volume x 0.192%. */
  feesToLpQu: number;
  /** Fees over TVL for the window itself (not annualised), in percent. */
  feeReturnPct: number;
  /** Trailing: fees in the window, annualised over today's TVL. It is what the pool paid recently, not a promise, and it can change fast. */
  feeAprPct: number;
  /**
   * Change in the pool price over the window, in percent: from the price of the last swap before the window to the pool's price now
   * (from its reserves). With no swap before the window the start is the first swap inside it, and with no swap in the window at all
   * the price cannot have moved (a pool's price only moves when someone swaps), so it is 0. Null when the pool has no price.
   * Swap prices include the 0.3% fee and the swap's own price impact, so the start is approximate, most of all for big swaps in small pools.
   */
  priceChangePct: number | null;
  priceChangeFrom: "before-window" | "first-swap-in-window" | "no-swaps" | null;
  /** 2*sqrt(r)/(1+r)-1 for r = the price ratio over the window, in percent. Zero or negative: what holding the two assets would have beaten the pool share by. Null when the price change is unknown. */
  impermanentLossPct: number | null;
  /** feeReturnPct + impermanentLossPct: an estimate for someone who held the pool share for the whole window. It ignores when within the window a depositor came in, and any change in TVL during it. Null when the price change is unknown. */
  netVsHoldPct: number | null;
  /** The caller's `suspectWash` said so. The APR may be inflated by wash trading; nothing else is changed. */
  volumeInflated: boolean;
  /** Any quality note at all: the APR is a weaker guide than for a busy, balanced pool. */
  lowConfidence: boolean;
  quality: QualityNote[];
}

/* ---------- small pure helpers ---------- */

/** No QU amount, unit count or price on Qubic comes near this, so anything above it is garbage and counts as nothing (it also keeps every sum finite). */
const TOO_BIG = 1e18;
const positive = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 && x <= TOO_BIG ? x : 0);
const count = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 && x <= TOO_BIG ? Math.floor(x) : 0);
/** Percent and QU values are tidied so the JSON has no 0.30000000000000004 (a value too large to round safely is left alone). */
const r4 = (x: number) => (Math.abs(x) < 1e12 ? Math.round(x * 1e4) / 1e4 : x);
const r2 = (x: number) => (Math.abs(x) < 1e13 ? Math.round(x * 1e2) / 1e2 : x);

/**
 * Impermanent loss of a constant-product position when the price ends up at `priceRatio` times where it began, as a percent of
 * what holding the same two assets would be worth then: 2*sqrt(r)/(1+r)-1. It is the same for r and 1/r, zero at r = 1 and never
 * positive. Null for a ratio that is not a positive number.
 */
export function impermanentLossPct(priceRatio: number): number | null {
  if (typeof priceRatio !== "number" || !Number.isFinite(priceRatio) || priceRatio <= 0) return null;
  return (2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1) * 100;
}

/** The price of an hour's first swap, or the hour's average if that is missing. */
const openPrice = (h: PoolHour) => positive(h.open) || (positive(h.qty) ? positive(h.qu) / positive(h.qty) : 0);
const closePrice = (h: PoolHour) => positive(h.close) || (positive(h.qty) ? positive(h.qu) / positive(h.qty) : 0);

const fmtN = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Fee income, price change and impermanent loss of one pool over a trailing window, plus honest notes about how far to trust them.
 * Pure: the reserves, the hours and the clock come in as arguments. Never returns NaN or Infinity; a pool with no volume earns 0%.
 */
export function poolStats(input: PoolStatsInput): PoolStats {
  const windowDays = WINDOW_DAYS[input.window];
  if (!windowDays) throw new RangeError(`window must be one of ${POOL_WINDOWS.join(", ")}`);
  const now = input.now ?? Date.now();
  const windowStart = now - windowDays * DAY;

  const poolQu = positive(input.poolQu);
  const poolAsset = positive(input.poolAsset);
  const tvlQu = 2 * poolQu;
  const rawPrice = poolQu > 0 && poolAsset > 0 ? poolQu / poolAsset : 0;
  const poolPrice = positive(rawPrice) || null;

  // An hour with no valid QU in it cannot have held a swap (the log never records a zero swap), so it is dropped whole.
  const hours = (input.hours ?? []).filter((h) => Number.isFinite(h.hour) && positive(h.qu) > 0).sort((a, b) => a.hour - b.hour);
  // An hour counts if any of it falls inside the window, the same rule `TradeIndex.volume` uses for the 24-hour figure.
  const inWindow = hours.filter((h) => h.hour + HOUR > windowStart);
  const before = hours.filter((h) => h.hour + HOUR <= windowStart);

  let volumeQu = 0;
  let swaps = 0;
  let activeHours = 0;
  let busiest = 0;
  let highest = 0;
  let lowest = Infinity;
  for (const h of inWindow) {
    const qu = positive(h.qu);
    volumeQu += qu;
    swaps += Math.max(1, count(h.n)); // an hour with volume had at least one swap
    activeHours++;
    busiest = Math.max(busiest, qu);
    if (positive(h.high)) highest = Math.max(highest, h.high);
    if (positive(h.low)) lowest = Math.min(lowest, h.low);
  }
  const priceRangeRatio = highest > 0 && Number.isFinite(lowest) && lowest > 0 ? highest / lowest : null;
  const topHourShare = volumeQu > 0 ? busiest / volumeQu : 0;

  // How many days of the window have really been read. A backward scan that is still running leaves the older part empty.
  const covered = input.coveredSince;
  const partial = covered !== undefined && Number.isFinite(covered) && covered > windowStart + HOUR;
  const rateDays = partial ? Math.min(windowDays, Math.max(0, (now - covered) / DAY)) : windowDays;

  const feesToLpQu = volumeQu * LP_FEE_FRACTION;
  const feeReturn = tvlQu > 0 ? feesToLpQu / tvlQu : 0;
  const feeApr = tvlQu > 0 && rateDays > 0 ? (feesToLpQu / tvlQu) * (365 / rateDays) : 0;

  // Price change: start from the last swap before the window, end at the pool's price now.
  let priceChangeFrom: PoolStats["priceChangeFrom"] = null;
  let priceChange: number | null = null;
  let start = 0;
  if (swaps === 0) {
    // Nothing swapped, so nothing moved the price (adding or removing liquidity keeps the pool's ratio).
    if (poolPrice !== null) (priceChange = 0), (priceChangeFrom = "no-swaps");
  } else if (poolPrice !== null) {
    for (let i = before.length - 1; i >= 0 && !start; i--) {
      start = closePrice(before[i]);
      if (start) priceChangeFrom = "before-window";
    }
    for (let i = 0; i < inWindow.length && !start; i++) {
      start = openPrice(inWindow[i]);
      if (start) priceChangeFrom = "first-swap-in-window";
    }
    if (start) priceChange = (poolPrice / start - 1) * 100;
  }
  const il = priceChange === null ? null : impermanentLossPct(1 + priceChange / 100);
  const net = il === null ? null : feeReturn * 100 + il;

  let wash = false;
  try {
    wash = input.suspectWash?.(input.id) === true;
  } catch {
    // the flag is advisory: a failing check must not take the pool (or the whole list) down
  }

  const quality: QualityNote[] = [];
  const note = (code: QualityCode, label: string, message: string) => quality.push({ code, label, message });
  if (wash) note("inflated-volume", "Volume looks inflated", "Some of this volume may be wash trading (swaps that only pad the numbers), so the fee APR may be higher than ordinary trading would pay.");
  if (swaps === 0) note("no-swaps", "No swaps", `No swaps in the last ${windowDays} days, so the pool earned nothing from fees in this window.`);
  if (partial) note("partial-history", "Partial history", `QMax has read only ${rateDays.toFixed(1)} of the last ${windowDays} days of swaps so far, so the figures use that shorter span.`);
  if (poolPrice === null) note("no-price", "No price", "One side of the pool is empty, so it has no price and no fee APR.");
  else if (tvlQu < SMALL_POOL_TVL_QU) note("small-pool", "Tiny pool", `The pool holds under ${fmtN(SMALL_POOL_TVL_QU / 1e6)}M QU in total, so one swap can move its price a lot and the APR is easily distorted.`);
  if (swaps > 0 && swaps < THIN_SWAPS_PER_DAY * rateDays) note("thin-volume", "Few swaps", `Only ${swaps} swap${swaps === 1 ? "" : "s"} in ${windowDays} days (fewer than one a day). A few trades can swing the APR a lot, so treat it as a rough guide.`);
  if (swaps >= 2 && topHourShare >= CONCENTRATED_HOUR_SHARE) note("concentrated-volume", "One-off burst", `${Math.round(topHourShare * 100)}% of the window's volume came in a single hour, so the APR reflects a burst, not a steady rate.`);
  if (priceRangeRatio !== null && priceRangeRatio >= WIDE_PRICE_RANGE) note("wide-price-range", "Wild prices", `Swap prices spanned a factor of ${priceRangeRatio.toFixed(1)} inside the window. That usually means a thin pool or a one-off huge swap, so the volume may not repeat.`);
  if (swaps > 0 && priceChangeFrom === "first-swap-in-window") note("young-pool", "New or idle pool", "No swap is recorded before this window (a new pool, or one that sat idle). The price change is measured from its first swap here, and the APR averages over the whole window, so it may be understated.");

  return {
    window: input.window,
    windowDays,
    rateDays: r4(rateDays),
    tvlQu: r2(tvlQu),
    poolPriceQu: poolPrice,
    volumeQu: r2(volumeQu),
    swaps,
    activeHours,
    topHourSharePct: r4(topHourShare * 100),
    priceRangeRatio: priceRangeRatio === null ? null : r4(priceRangeRatio),
    feesToLpQu: r2(feesToLpQu),
    feeReturnPct: r4(feeReturn * 100),
    feeAprPct: r4(feeApr * 100),
    priceChangePct: priceChange === null ? null : r4(priceChange),
    priceChangeFrom,
    impermanentLossPct: il === null ? null : r4(il),
    netVsHoldPct: net === null ? null : r4(net),
    volumeInflated: wash,
    lowConfidence: quality.length > 0,
    quality,
  };
}

/* ---------- what a deposit would do ---------- */

/** The price moves the table shows, in percent. */
export const IL_MOVES_PCT = [-50, -25, -10, 10, 25, 50] as const;
/** A sanity limit on a deposit: it keeps the arithmetic exact, and anything larger is surely a typo. */
export const MAX_POSITION_QU = 1e15;

export interface PositionEstimate {
  /** The deposit: the QU value of both sides together, at today's pool price (half in QU, half in the asset). */
  positionQu: number;
  /** What share of the pool the deposit would be, counting the deposit itself in the pool. */
  sharePct: number;
  /** At the window's average pace, spread over a pool that now includes this deposit. Fees stay in the pool and come back when liquidity is removed. */
  feesPerDayQu: number;
  feesPer30dQu: number;
  /** Fee APR for this deposit: the trailing rate, diluted by the deposit (a big deposit lowers the rate for everyone). */
  aprAfterDepositPct: number;
  /** What the price moving does to the deposit, against simply holding the two assets. */
  il: { movePct: number; ilPct: number; ilQu: number; holdQu: number; lpQu: number }[];
  /** The flat QU on adding and on removing liquidity (100,000 each, not paid to liquidity providers) and how long the estimated fees take to cover them. */
  costs: { addQu: number; removeQu: number; roundTripQu: number; daysToCoverCosts: number | null };
  notes: string[];
}

/**
 * What a deposit of `positionQu` (both sides together) would earn per day and per 30 days at the pool's trailing rate, and what the
 * price moving would cost it in impermanent loss. An estimate: the trailing rate may not continue, and it ignores price moves
 * beyond the table, changes in volume or TVL, and anything but the flat fees to add and remove liquidity. Throws on a deposit that
 * is not a positive number.
 */
export function positionEstimate(input: { positionQu: number; stats: PoolStats }): PositionEstimate {
  const { positionQu, stats } = input;
  if (typeof positionQu !== "number" || !Number.isFinite(positionQu) || positionQu <= 0) throw new RangeError("positionQu must be a positive number of QU");
  const share = positionQu / (stats.tvlQu + positionQu);
  const poolFeesPerDay = stats.rateDays > 0 ? stats.feesToLpQu / stats.rateDays : 0;
  const feesPerDay = poolFeesPerDay * share;
  const roundTrip = 2 * QSWAP_ADDITIONAL_FEE;

  const il = IL_MOVES_PCT.map((movePct) => {
    const r = 1 + movePct / 100;
    const lpQu = positionQu * Math.sqrt(r);
    const holdQu = (positionQu * (1 + r)) / 2;
    return { movePct, ilPct: r4(impermanentLossPct(r) ?? 0), ilQu: r2(lpQu - holdQu), holdQu: r2(holdQu), lpQu: r2(lpQu) };
  });

  return {
    positionQu,
    sharePct: r4(share * 100),
    feesPerDayQu: r2(feesPerDay),
    feesPer30dQu: r2(feesPerDay * 30),
    aprAfterDepositPct: r4((feesPerDay * 365 / positionQu) * 100),
    il,
    costs: { addQu: QSWAP_ADDITIONAL_FEE, removeQu: QSWAP_ADDITIONAL_FEE, roundTripQu: roundTrip, daysToCoverCosts: feesPerDay > 0 ? r2(roundTrip / feesPerDay) : null },
    notes: [
      "An estimate from past swaps: the pool may earn more or less from here, and it ignores price moves beyond the table.",
      "The 100,000 QU a swap costs the trader is not income for liquidity providers, but adding and removing liquidity each cost you 100,000 QU, which is the same flat fee.",
      "Impermanent loss is against holding the two assets. It is only a loss on paper until you remove liquidity, and it shrinks if the price comes back.",
    ],
  };
}

/**
 * Reads an amount of QU the way people type it: "100000000", "100,000,000", "100m", "1.5B", "250k". Null when it is not a positive
 * amount up to `MAX_POSITION_QU` (so the panel can say what is wrong instead of asking the server).
 */
export function parseQuAmount(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/i.exec(String(text).replace(/[\s,_]/g, ""));
  if (!m) return null;
  const unit = m[2] ? ({ k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[m[2].toLowerCase()] : 1;
  const x = Number(m[1]) * unit;
  return Number.isFinite(x) && x > 0 && x <= MAX_POSITION_QU ? x : null;
}

/* ---------- ranking ---------- */

/**
 * Puts pools in order and numbers them. By TVL or volume it is a plain sort. By APR the pools with no quality notes come first,
 * then the flagged ones (few swaps, a tiny pool, a one-off burst, suspected wash...), each group by APR: a headline APR from a
 * handful of swaps in a dust pool says little, and it must not top a list people use to pick where to put money.
 */
export function rankPools<T extends { id: string; feeAprPct: number; tvlQu: number; volumeQu: number; lowConfidence: boolean }>(pools: T[], sort: PoolSort): (T & { rank: number })[] {
  const by: Record<PoolSort, (a: T, b: T) => number> = {
    apr: (a, b) => Number(a.lowConfidence) - Number(b.lowConfidence) || b.feeAprPct - a.feeAprPct,
    tvl: (a, b) => b.tvlQu - a.tvlQu,
    volume: (a, b) => b.volumeQu - a.volumeQu,
  };
  return [...pools]
    .sort((a, b) => by[sort](a, b) || b.tvlQu - a.tvlQu || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

/* ---------- routes ---------- */

export interface PoolsDeps {
  /** Every asset that has a QSwap pool, with what the pool holds now. `priceQu` is the asset's price as QMax shows it. */
  pools(): { id: string; symbol: string; poolQu: number; poolAsset: number; priceQu: number | null }[];
  /** The asset's QSwap hours (`TradeIndex.hours(key, "QSwap")`), or null if nothing is known about it. */
  hours(assetId: string): PoolHour[] | null;
  /** True when the asset's volume looks like wash trading. */
  suspectWash?(assetId: string): boolean;
  /** The time (ms) from which the trade index has read the swaps, while it is still scanning back; null or left out once it is complete. */
  coveredSince?(): number | null;
}

export interface PoolItem extends PoolStats {
  rank: number;
  id: string;
  symbol: string;
  poolQu: number;
  poolAsset: number;
  priceQu: number | null;
}

export interface PoolsResponse {
  window: PoolWindow;
  sort: PoolSort;
  pools: PoolItem[];
  computedAt: string;
  note: string;
  feeModel: typeof FEE_MODEL;
}

export interface PoolDetailResponse {
  window: PoolWindow;
  pool: Omit<PoolItem, "rank">;
  /** Present when `positionQu` was given. */
  positionEstimate?: PositionEstimate;
  computedAt: string;
  note: string;
  feeModel: typeof FEE_MODEL;
}

const NOTE = `${POOLS_CAVEAT} Fee APR is the swap volume in the window times ${FEE_MODEL.lpFeePctOfVolume}% (the ${LP_SHARE_OF_FEE}% of QSwap's ${FEE_MODEL.swapFeePct}% swap fee that stays in the pool for liquidity providers), over today's TVL, annualised.`;

/** The list is recomputed at most this often. */
const CACHE_MS = 60_000;

export function poolsRoutes(deps: PoolsDeps, opts: { now?: () => number; cacheMs?: number } = {}): Route[] {
  const clock = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? CACHE_MS;
  const cache = new Map<PoolWindow, { at: number; pools: Omit<PoolItem, "rank">[] }>();

  const poolsNow = () => deps.pools().filter((p) => Number.isFinite(p.poolQu) && Number.isFinite(p.poolAsset));
  const covered = () => {
    const c = deps.coveredSince?.();
    return c === null || c === undefined ? undefined : c;
  };
  const one = (p: ReturnType<typeof poolsNow>[number], window: PoolWindow, now: number): Omit<PoolItem, "rank"> => ({
    id: p.id,
    symbol: p.symbol,
    poolQu: p.poolQu,
    poolAsset: p.poolAsset,
    priceQu: p.priceQu ?? null,
    ...poolStats({ id: p.id, poolQu: p.poolQu, poolAsset: p.poolAsset, hours: deps.hours(p.id), window, now, coveredSince: covered(), suspectWash: deps.suspectWash ? (id) => deps.suspectWash!(id) : undefined }),
  });
  const list = (window: PoolWindow) => {
    const now = clock();
    const hit = cache.get(window);
    if (hit && now - hit.at < cacheMs && now >= hit.at) return hit;
    const fresh = { at: now, pools: poolsNow().map((p) => one(p, window, now)) };
    cache.set(window, fresh);
    return fresh;
  };

  const windowParam = { name: "window", in: "query", schema: { type: "string", enum: [...POOL_WINDOWS], default: "7d" }, description: "The trailing window the fees and price change are measured over." };
  return [
    {
      method: "GET",
      path: "/v1/pools",
      limited: false, // cached for a minute and cheap to compute
      doc: {
        summary: "QSwap pools ranked by what they really earn",
        description: `Every asset with a QSwap pool: TVL, swap volume in the window, trailing fee APR, price change, impermanent loss and notes on how far to trust the numbers. Fees are worked out from the swaps the network logged: ${FEE_MODEL.lpFeePctOfVolume}% of each swap's value reaches liquidity providers. ${POOLS_CAVEAT} By APR, pools without quality notes are ranked first. Cached for 60 seconds.`,
        parameters: [windowParam, { name: "sort", in: "query", schema: { type: "string", enum: [...POOL_SORTS], default: "apr" } }],
        responses: { "200": { description: "The ranked pools." }, "400": { description: "A parameter is not one of the allowed values." } },
      },
      handler: ({ query }): PoolsResponse => {
        const window = oneOf(query, "window", POOL_WINDOWS, "7d");
        const sort = oneOf(query, "sort", POOL_SORTS, "apr");
        const { at, pools } = list(window);
        return { window, sort, pools: rankPools(pools, sort), computedAt: new Date(at).toISOString(), note: NOTE, feeModel: FEE_MODEL };
      },
    },
    {
      method: "GET",
      path: "/v1/pools/detail",
      limited: false,
      doc: {
        summary: "One QSwap pool's stats, and an estimate for a deposit",
        description: `The pool's stats for the window and, when positionQu is given, what a deposit of that many QU (both sides together) would earn per day and per 30 days at the trailing rate, and its impermanent loss for price moves of 10%, 25% and 50% either way. ${POOLS_CAVEAT}`,
        parameters: [
          { name: "asset", in: "query", required: true, schema: { type: "string" }, description: "The asset id, as in /v1/assets." },
          windowParam,
          { name: "positionQu", in: "query", schema: { type: "number", exclusiveMinimum: 0 }, description: "A deposit, as the QU value of both sides together." },
        ],
        responses: { "200": { description: "The pool and, if asked, the estimate." }, "400": { description: "A parameter is missing or invalid." }, "404": { description: "That asset has no QSwap pool." } },
      },
      handler: ({ query }): PoolDetailResponse => {
        const id = required(query, "asset");
        const window = oneOf(query, "window", POOL_WINDOWS, "7d");
        const raw = (query.get("positionQu") ?? "").trim();
        let position: number | undefined;
        if (raw) {
          position = plainNumber(raw, true);
          if (!Number.isFinite(position) || position <= 0 || position > MAX_POSITION_QU) throw new RouteError(400, `positionQu must be a number of QU above 0 and at most ${MAX_POSITION_QU}`);
        }
        const all = poolsNow();
        const found = all.find((p) => p.id === id) ?? all.find((p) => p.id.toLowerCase() === id.toLowerCase());
        if (!found) throw new RouteError(404, `No QSwap pool for '${id}'`, { hint: "Only assets with a QSwap pool are listed; see /v1/pools." });
        const now = clock();
        const pool = one(found, window, now);
        return {
          window,
          pool,
          ...(position === undefined ? {} : { positionEstimate: positionEstimate({ positionQu: position, stats: pool }) }),
          computedAt: new Date(now).toISOString(),
          note: NOTE,
          feeModel: FEE_MODEL,
        };
      },
    },
  ];
}
