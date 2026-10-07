/**
 * Token-to-token swaps in one review. QX and QSwap price everything in QU, so swapping token A for token B is two
 * trades: sell A for QU (leg 1), then buy B with that QU (leg 2). Both legs use QMax's normal best route (QX, QSwap
 * or a split).
 *
 * The hard part is money that does not exist yet: leg 2's buy steps attach QU, and the wallet only has what leg 1
 * actually paid out. So leg 2 is planned against the LEAST leg 1 can pay while staying inside its signed limits
 * (`worstProceedsQu`), and once leg 1 has settled it is sized again from the wallet's real balance
 * (`fitBuyToBalance`), never larger than the size the user reviewed and never smaller than the minimum they were
 * promised. A leg 2 that the wallet could not pay for is refused, not sent.
 *
 * Nothing here signs or sends anything. It plans; the web app runs the steps through the user's own wallet.
 */
import { QSWAP_OPERATION_FEE_QU, buildExecutionPlan } from "./exec.ts";
import type { ExecutableQuote, ExecutionHint, Holdings, TxStep } from "./exec.ts";
import { RouteError } from "./routes.ts";
import type { Route } from "./routes.ts";
import { QSWAP_INDEX, QX_INDEX } from "./rpc.ts";
import type { OpenOrder } from "./verify.ts";
import { QSWAP_MIN_BUY_QU } from "./venues.ts";

export type SwapSide = "buy" | "sell";

/** One venue's part of a quote, as `buildQuote` returns it in `route[i]`. */
export interface QuoteLeg {
  venue: string;
  qty: number;
  /** Buy: QU paid. Sell: QU received. Venue fees and the model's flat costs are included. */
  totalQu: number;
  feesQu: number;
  fixedCostQu: number;
  effectivePriceQu?: number;
  /** QX only: how many resting orders the quote matched, and how many shares rest on that side in all. */
  depth?: { levelsUsed: number; qtyAvailable: number };
  priceRangeQu?: { best: number; worst: number };
  /** The limits the wallet signs. Missing when the server serves demo data. */
  execution?: ExecutionHint;
}

/** The parts of a quote (`buildQuote`, the web app's `QuoteResponse`) the swap planner reads. */
export interface SwapQuote {
  asset: string;
  side: SwapSide;
  qty: number;
  filledQty: number;
  fillable: boolean;
  executable: boolean;
  totalQu: number;
  averagePriceQu: number | null;
  slippageBps: number;
  assetInfo?: ExecutableQuote["assetInfo"];
  route: QuoteLeg[];
  /** Every venue the token trades on, each quoted for the whole order. */
  alternatives?: { venue: string; fillable: boolean }[];
  warnings: string[];
}

/** One quote from QMax's router. Tests fake it; the server builds it from `buildQuote`, the browser from `/v1/quote`. */
export type QuoteFn = (side: SwapSide, asset: string, qty: number, slippageBps: number) => Promise<SwapQuote>;

/**
 * Kept back from leg 1's worst-case proceeds before leg 2 is sized, so the guaranteed minimum survives small
 * surprises the limits do not cover. Mainly: a QX ask pays a fee per order it matches (rounded down, plus 1 QU), and
 * the quote only knows how many orders it matched at quote time. 1,000 QU covers 1,000 extra matches; 0.1% covers
 * rounding on large swaps. It is small next to QSwap's flat 100,000 QU per swap.
 */
export const SAFETY_MARGIN = { minQu: 1_000, bps: 10 };
/** New quotes one size search may make (the brief's bound). A plan makes at most 1 + 2 x this. */
export const MAX_QUOTES_PER_SEARCH = 12;
/** Qx.h's trade fee today: 3,000,000 billionths. Worst cases never assume a lower rate than this. */
export const QX_TRADE_FEE_RATE = 0.003;
/**
 * From a match worth INT64_MAX / tradeFee QU up (3,074,457,345,618 at 0.3%), Qx.h avoids an overflow by dividing the
 * value by floor(1e9 / tradeFee) = 333 instead: a slightly higher rate than 0.3%, which the venue model does not use.
 */
const QX_BIG_MATCH_QU = 3_074_457_345_618;
const QX_BIG_MATCH_RATE = 1 / 333;
/**
 * Qswap.h's SwapQuForExactAsset refunds only `quAmountIn` and keeps the rest of what was attached (the 100,000 QU flat
 * fee included) when `quAmountIn` is below its protocol fee, which is 36 QU on any swap under 334 QU: such a buy loses
 * the whole attachment and delivers nothing. Buy legs on QSwap below this many QU (at quoted prices) are not sent; it
 * leaves room for the pool's price to fall 96% before the swap lands. A QSwap buy this small would pay its flat fee
 * 100 times over anyway.
 */
export { QSWAP_MIN_BUY_QU }; // defined once, in venues.ts, because the quote itself now refuses such a buy
/** Qx.h refuses an order whose price x quantity reaches this (MAX_AMOUNT). */
const QX_MAX_AMOUNT = 1e15;
/** The same ceiling `buildQuote` puts on a quantity. */
const MAX_QTY = 1e12;
/** A size search stops once the largest fitting size is pinned down to this fraction (0.05%). */
const SEARCH_PRECISION = 1 / 2000;
/** Flat fees above this share of what the swap moves get a warning. */
const FLAT_FEE_WARN_SHARE = 0.05;

const money = (n: number) => Math.round(n).toLocaleString("en-US");
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isQu = (id: string) => id.trim().toUpperCase() === "QU";

// ---------------------------------------------------------------------------------------------------------------
// Reading quotes

/** Why a quote cannot be signed as one leg of a swap (as a `side` of exactly `qty`), or null when it can. */
export function legProblem(q: SwapQuote, side: SwapSide, qty: number): string | null {
  if (q.side !== side) return `Expected a ${side} quote.`;
  if (!q.executable || !q.assetInfo) return "This server is serving demo data, so trading is off.";
  // When the quote itself says why (an order too small for the venue's fixed fees), say that, not "liquidity".
  if (!q.fillable || q.filledQty !== qty || !q.route.length) return q.warnings.find((w) => /too small/i.test(w)) ?? `Not enough liquidity to ${side} ${money(qty)} ${q.asset} right now.`;
  let total = 0;
  for (const leg of q.route) {
    const h = leg.execution;
    if (!h) return "The quote has no limits to sign.";
    const rightKind = side === "sell" ? h.type === "qx-ask" || h.type === "qswap-sell" : h.type === "qx-bid" || h.type === "qswap-buy";
    if (!rightKind || h.qty !== leg.qty || !isCount(h.qty) || h.qty === 0) return "The quote's limits do not match its route.";
    if (h.type === "qx-ask" || h.type === "qx-bid") {
      if (!isCount(h.limitPrice) || h.limitPrice < 1) return "The quote has an invalid QX limit price.";
      if (h.limitPrice * h.qty >= QX_MAX_AMOUNT) return "This order is larger than QX accepts in one order.";
    }
    if (h.type === "qswap-sell" && !isCount(h.minQuOut)) return "The quote has an invalid QSwap minimum.";
    if (h.type === "qswap-buy" && (!isCount(h.maxQuIn) || h.maxQuIn < 1)) return "The quote has an invalid QSwap maximum.";
    if (![leg.totalQu, leg.feesQu, leg.fixedCostQu].every(Number.isFinite)) return "The quote has missing amounts.";
    total += leg.qty;
  }
  if (total !== qty) return "The quote's route does not add up to the order.";
  return null;
}

/** The quote as `buildExecutionPlan` takes it. Call only after `legProblem` returned null. */
function executableOf(q: SwapQuote): ExecutableQuote {
  return { asset: q.asset, side: q.side, assetInfo: q.assetInfo!, route: q.route.map((l) => ({ venue: l.venue, qty: l.qty, execution: l.execution! })) };
}

const sameAsset = (a: SwapQuote, b: SwapQuote) =>
  !!a.assetInfo && !!b.assetInfo && a.assetInfo.issuer === b.assetInfo.issuer && a.assetInfo.assetName === b.assetInfo.assetName;

/** Why a buy quote has a QSwap leg too small to send (see QSWAP_MIN_BUY_QU), or null. */
export function tinyQswapBuy(q: SwapQuote): string | null {
  for (const l of q.route) {
    if (l.execution?.type !== "qswap-buy") continue;
    const quIn = l.totalQu - l.fixedCostQu; // what the pool charges at quoted prices, its 0.3% included
    if (!(quIn >= QSWAP_MIN_BUY_QU))
      return `This swap is too small for QSwap: buying ${money(l.qty)} ${q.asset} there costs only ${money(quIn)} QU, and on a swap under 36 QU QSwap keeps the whole 100,000 QU fee and delivers nothing. Swap a larger amount.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Leg 1: what selling A pays

/**
 * The highest QX trade fee rate a sell leg's own numbers allow. Qx.h takes value x rate, rounded down, plus 1 QU from
 * every match, so the fees the quote charged are always MORE than value x rate: fees / value bounds the rate from
 * above. Never below today's 0.3%, so a quote source with a missing fee cannot make the worst case look better.
 */
export function qxFeeRateCeiling(leg: QuoteLeg): number {
  const gross = leg.totalQu + leg.feesQu + leg.fixedCostQu; // a QX sell's totalQu is gross - fees - flat cost
  if (!(gross > 0) || !Number.isFinite(gross) || !(leg.feesQu >= 0)) return 1; // cannot tell: assume it all goes in fees
  return Math.max(QX_TRADE_FEE_RATE, leg.feesQu / gross);
}

/**
 * The least QU one sell leg pays into the wallet if it fills within its signed limit.
 * - QSwap: `minQuOut`. Qswap.h refuses the swap (and hands back the shares and the 100,000 QU fee) below it.
 * - QX: the ask matches resting bids at THEIR price, never below `limitPrice`, and the fee comes out of each match. The
 *   worst is every share matched at exactly the limit: limit x qty, less the fee at the highest rate the quote allows
 *   (rounded up; Qx.h's higher rate on a match of 3 trillion QU or more if the sale is that large), less 1 QU per order
 *   matched (the quote's count; more matches are what SAFETY_MARGIN covers, and each one costs at most 1 QU more),
 *   less the flat QX cost the venue model charges (QX does not actually take it from an ask, so this errs low).
 *   It is NOT a bound against any book: an ask matched against many more, smaller orders than the quote saw pays up to
 *   1 QU per extra match, which for a cheap token sold in bulk can exceed the margin. Leg 2 is then refused, not overpaid.
 * Throws for a buy leg.
 */
export function worstLegProceedsQu(leg: QuoteLeg): number {
  const h = leg.execution;
  if (!h || (h.type !== "qx-ask" && h.type !== "qswap-sell")) throw new Error("Not a sell leg with limits");
  if (h.type === "qswap-sell") return Math.max(0, h.minQuOut);
  const value = h.limitPrice * h.qty;
  const matches = Math.min(h.qty, Math.max(1, leg.depth?.levelsUsed ?? 1));
  const rate = value >= QX_BIG_MATCH_QU ? Math.max(qxFeeRateCeiling(leg), QX_BIG_MATCH_RATE) : qxFeeRateCeiling(leg);
  const fee = Math.ceil(value * rate) + matches;
  return Math.max(0, value - fee - Math.max(0, Math.ceil(leg.fixedCostQu)));
}

/** The least QU the whole sell pays into the wallet if every leg fills within its limits. */
export const worstProceedsQu = (sell: SwapQuote) => sell.route.reduce((s, l) => s + worstLegProceedsQu(l), 0);

/**
 * QU the sell is expected to pay into the wallet at the quoted prices. The venues' flat fees are not in it: they leave
 * the wallet separately and up front (see `upfrontQu`). For both venues that is the quote's net plus its flat cost.
 */
export const expectedProceedsQu = (sell: SwapQuote) => sell.route.reduce((s, l) => s + Math.floor(l.totalQu + l.fixedCostQu), 0);

/** Shares on the contracts exactly as the sell legs need them: no share move. Used when the wallet is not known. */
function holdingsMatching(sell: SwapQuote): Holdings {
  const h: Holdings = { [QX_INDEX]: 0, [QSWAP_INDEX]: 0 };
  for (const l of sell.route) h[l.venue === "QX" ? QX_INDEX : QSWAP_INDEX] += l.qty;
  return h;
}

/**
 * QU the wallet must hold before leg 1, because it leaves before any proceeds arrive: QSwap's flat 100,000 QU per sell
 * call and any share-management move fee. It is the sum of what the sell steps attach (some may be refunded).
 * Without `holdings` no share move is assumed. Throws if `holdings` cannot cover the sale.
 */
export function upfrontQu(sell: SwapQuote, holdings?: Holdings): number {
  return buildExecutionPlan(executableOf(sell), holdings ?? holdingsMatching(sell)).maxOutlayQu;
}

/** Most QU a buy's steps attach: limit x qty for a QX bid, maxQuIn + 100,000 for a QSwap buy. Unused QU is refunded. */
export const buyMaxOutlayQu = (buy: SwapQuote) => buildExecutionPlan(executableOf(buy)).maxOutlayQu;

/** QU kept back from leg 1's worst case before leg 2 is sized (see SAFETY_MARGIN). */
export const safetyMarginQu = (proceedsQu: number) => Math.max(SAFETY_MARGIN.minQu, Math.ceil((Math.max(0, proceedsQu) * SAFETY_MARGIN.bps) / 10_000));

// ---------------------------------------------------------------------------------------------------------------
// Leg 2: the largest buy that fits a QU budget

interface Probe {
  qty: number;
  quote: SwapQuote;
  /** What the buy's steps attach; Infinity when the quote cannot be signed (not fillable, demo data, ...). */
  outlayQu: number;
}

/** Quotes buys of one asset, remembering every size it has seen, and counts the quotes it made. */
function buyProber(quoteFn: QuoteFn, asset: string, slippageBps: number) {
  const seen = new Map<number, Probe>();
  const self = {
    seen,
    calls: 0,
    async at(qty: number): Promise<Probe> {
      const hit = seen.get(qty);
      if (hit) return hit;
      self.calls++;
      const quote = await quoteFn("buy", asset, qty, slippageBps);
      const outlayQu = legProblem(quote, "buy", qty) === null ? buyMaxOutlayQu(quote) : Infinity;
      const p = { qty, quote, outlayQu };
      seen.set(qty, p);
      return p;
    },
  };
  return self;
}
type Prober = ReturnType<typeof buyProber>;

/**
 * For a token that trades on QX only, the most its book can fill: the shares resting on the ask side, as the quotes
 * report them. 0 when the token has a pool too (or nothing says it has not). Used only to choose the next size to
 * quote, never as a limit: when a buy is limited by depth rather than budget, it finds the edge in a quote or two.
 */
function capacityHint(p: Prober): number {
  let best = 0;
  for (const x of p.seen.values()) {
    if (!Number.isFinite(x.outlayQu)) continue;
    if (!x.quote.alternatives || x.quote.alternatives.some((a) => a.venue !== "QX")) return 0;
    for (const l of x.quote.route) if (l.venue === "QX" && l.depth && Number.isSafeInteger(l.depth.qtyAvailable)) best = Math.max(best, l.depth.qtyAvailable);
  }
  return best;
}

/**
 * The largest buy between `lowQty` and `highQty` whose steps attach no more than `budgetQu`, using at most `maxQuotes`
 * new quotes. Only a size that was actually quoted and checked is ever returned, so the answer is safe even when the
 * search stops early, or the router's choice of venues makes the cost jump; it can fall a little short of the true
 * largest size. Returns null when not even `lowQty` fits.
 */
async function largestBuyWithin(p: Prober, budgetQu: number, lowQty: number, highQty: number, maxQuotes: number): Promise<Probe | null> {
  if (!(budgetQu > 0) || highQty < lowQty) return null;
  const startCalls = p.calls;
  const left = () => maxQuotes - (p.calls - startCalls);
  const fits = (x: Probe) => x.outlayQu <= budgetQu;
  const inRange = [...p.seen.values()].filter((x) => x.qty >= lowQty && x.qty <= highQty);
  let lo: Probe | null = inRange.filter(fits).sort((a, b) => b.qty - a.qty)[0] ?? null;
  if (!lo) {
    if (left() <= 0) return null;
    const first = await p.at(lowQty);
    if (!fits(first)) return null; // cost grows with size, so nothing larger fits either
    lo = first;
  }
  const above = (x: Probe) => x.qty > lo!.qty;
  let hi: Probe | null = inRange.filter((x) => !fits(x) && above(x)).sort((a, b) => a.qty - b.qty)[0] ?? null;
  let bisect = false;
  while (left() > 0) {
    if (hi ? hi.qty - lo.qty <= Math.max(1, Math.floor(lo.qty * SEARCH_PRECISION)) : lo.qty >= highQty) break;
    let next: number;
    if (!hi) {
      // Not bracketed yet: extrapolate upwards. Two fitting points give the marginal cost (which also gets a flat fee
      // right); one point scales proportionally, which undershoots when a flat fee dominates, so never grow by less
      // than double while the budget is less than half used.
      const below = [...p.seen.values()].filter((x) => fits(x) && x.qty < lo!.qty).sort((a, b) => b.qty - a.qty)[0];
      const slope = below && lo.outlayQu > below.outlayQu ? (lo.outlayQu - below.outlayQu) / (lo.qty - below.qty) : lo.outlayQu / lo.qty;
      next = lo.qty + Math.floor((budgetQu - lo.outlayQu) / slope);
      if (lo.outlayQu * 2 <= budgetQu) next = Math.max(next, lo.qty * 2);
      next = Math.min(Math.max(next, lo.qty + 1), highQty);
      // Past what the market seems to hold: try exactly that much first.
      const cap = capacityHint(p);
      if (cap > lo.qty && cap < next && !p.seen.has(cap)) next = cap;
    } else {
      // Bracketed: alternate interpolation (fast when cost is close to linear) with bisection (always halves). Above the
      // market's depth there is no cost to interpolate; try the depth the quotes show, then bisect in log, as the depth
      // can be orders of magnitude below the size that failed.
      const unfillable = !Number.isFinite(hi.outlayQu);
      const cap = unfillable ? capacityHint(p) : 0;
      const interp = !unfillable && hi.outlayQu > lo.outlayQu && !bisect;
      if (interp) {
        // Kept off the bracket's last eighths: on a convex cost curve plain interpolation keeps landing next to one end.
        const w = hi.qty - lo.qty;
        const edge = Math.max(1, Math.floor(w / 8));
        next = lo.qty + Math.floor(((budgetQu - lo.outlayQu) * w) / (hi.outlayQu - lo.outlayQu));
        next = Math.min(Math.max(next, lo.qty + edge), hi.qty - edge);
      } else if (cap > lo.qty && cap < hi.qty && !p.seen.has(cap)) next = cap;
      else if (cap === lo.qty && cap + 1 < hi.qty && !p.seen.has(cap + 1)) next = cap + 1;
      else if (unfillable && hi.qty > 4 * lo.qty) next = Math.floor(Math.sqrt(lo.qty * hi.qty));
      else next = lo.qty + Math.floor((hi.qty - lo.qty) / 2);
      next = Math.min(Math.max(next, lo.qty + 1), hi.qty - 1);
      bisect = !bisect;
    }
    const r = await p.at(next);
    if (fits(r)) lo = r;
    else hi = r;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------------------------
// The largest buy a wallet can fund

export type AffordableBuy =
  | {
      ok: true;
      /** The most units whose buy steps attach no more QU than the budget. A size that was quoted and checked, never an estimate. */
      qty: number;
      /** What those steps attach at most (limit price x quantity for a QX bid, the most a QSwap buy may take plus its flat fee); unused QU is refunded. */
      outlayQu: number;
      /** The wallet's QU less the small amount kept back (see `safetyMarginQu`). */
      budgetQu: number;
      /** The quote at that size: QMax's best route for it (QX, QSwap, or both). */
      quote: SwapQuote;
      quotesUsed: number;
    }
  | { ok: false; reason: string; quotesUsed: number };

/**
 * The largest buy a wallet can fund: the most `asset` that `balanceQu` can pay for, each size priced by QMax's router at its best route (a big order is split
 * across QX and the pool when that is cheaper), and every size checked the way a signed buy is: what its steps attach, slippage room included, must fit
 * the wallet. A little QU is kept back. Asks `quoteFn` for at most `maxQuotes` quotes (default 12) and returns only a size it quoted, so it can fall
 * a hair short of the true largest but never overspends. Nothing is signed or sent.
 */
export async function affordableBuy(quoteFn: QuoteFn, input: { asset: string; slippageBps: number; balanceQu: number; maxQuotes?: number }): Promise<AffordableBuy> {
  const maxQuotes = Math.max(2, input.maxQuotes ?? MAX_QUOTES_PER_SEARCH);
  const p = buyProber(quoteFn, input.asset, input.slippageBps);
  const refuse = (reason: string): AffordableBuy => ({ ok: false, reason, quotesUsed: p.calls });
  if (!Number.isSafeInteger(input.balanceQu) || input.balanceQu <= 0) return refuse("There is no QU in the wallet to buy with.");
  const budgetQu = Math.floor(input.balanceQu - safetyMarginQu(input.balanceQu));
  if (budgetQu <= 0) return refuse(`Only ${money(input.balanceQu)} QU is in the wallet, which is all kept back for the network's small costs.`);
  try {
    const best = await largestBuyWithin(p, budgetQu, 1, MAX_QTY, maxQuotes);
    if (best) return { ok: true, qty: best.qty, outlayQu: best.outlayQu, budgetQu, quote: best.quote, quotesUsed: p.calls };
    const one = p.seen.get(1);
    if (!one || !Number.isFinite(one.outlayQu)) {
      const why = one?.quote.warnings.find((w) => /too small|liquidity|cannot|no /i.test(w));
      return refuse(why ? `${input.asset} cannot be bought right now: ${why}` : `${input.asset} cannot be bought right now (not enough liquidity to fill an order).`);
    }
    return refuse(`Buying even one ${input.asset} needs up to ${money(one.outlayQu)} QU (the market's flat fee included) and the wallet has ${money(input.balanceQu)} QU.`);
  } catch (e) {
    return refuse(`Could not price the order: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

export interface SwapPlanInput {
  /** Asset ids as in /v1/assets. */
  from: string;
  to: string;
  /** Units of `from` to sell. */
  qty: number;
  slippageBps?: number;
  /** The wallet's shares of `from` per managing contract, when known: share-move fees are then part of `upfrontQu`. */
  holdings?: Holdings;
  maxQuotesPerSearch?: number;
}

export type SwapProblemCode = "qu" | "same-asset" | "unknown-asset" | "bad-input";

export interface SwapPlan {
  from: string;
  to: string;
  qty: number;
  slippageBps: number;
  /** True when both legs can be signed and leg 2 can buy at least one unit. */
  executable: boolean;
  /** Leg 1: sell `qty` of `from`. */
  sell: SwapQuote | null;
  /** Leg 2 as it will be signed if leg 1 pays what it is expected to: `expectedOutQty` units. */
  buy: SwapQuote | null;
  /** Leg 2 sized to leg 1's worst case: `minOutQty` units. */
  buyAtWorst: SwapQuote | null;
  /** Units of `to` bought if leg 1 pays its expected proceeds. Leg 2 is sized so its own worst price still fits. */
  expectedOutQty: number;
  /**
   * Units of `to` the limits leave room for in the worst case: leg 2 sized to leg 1's worst-case proceeds less the
   * margin. The second trade is never sent for fewer; if it cannot get this many, QMax stops and the wallet keeps QU.
   */
  minOutQty: number;
  /** QU the sale is expected to pay into the wallet (before the flat fees in `upfrontQu`). */
  expectedProceedsQu: number;
  /** The least QU the sale pays into the wallet if it fills within its limits. */
  worstProceedsQu: number;
  safetyMarginQu: number;
  /** QU that must be in the wallet before leg 1 (flat fees that leave before the proceeds arrive). */
  upfrontQu: number;
  /** False when the wallet's holdings were not known, so share moves (if any) are not in `upfrontQu`. */
  upfrontIncludesShareMoves: boolean;
  /** Most QU leg 2 attaches (at `expectedOutQty`). It is paid from leg 1's proceeds. */
  buyMaxOutlayQu: number;
  /** `upfrontQu` + `buyMaxOutlayQu`: the most QU that can leave the wallet across both legs (unused QU is refunded). */
  maxTotalOutlayQu: number;
  /** Expected proceeds that leg 2 is not expected to spend: they stay in the wallet as QU. */
  expectedLeftoverQu: number;
  quotesUsed: number;
  warnings: string[];
  /** Set when the request itself cannot be planned (the API answers 400 or 404). */
  problem?: { code: SwapProblemCode; message: string };
  /** Set only when the operator configured a size limit and the plan was refused for being over it: the limit in QU. */
  capQu?: number;
  /** Present when asked for (`compare: true`): the same swap forced onto each single market, to show what routing is worth. */
  bestDeal?: BestDeal;
}

/** The same swap with the sale and the purchase each forced onto one market. */
export interface SwapComparison {
  label: string;
  sellVenue: "QX" | "QSwap";
  buyVenue: "QX" | "QSwap";
  /** False when that combination cannot do this swap (a market is missing, too shallow, or the order is too small for it). */
  executable: boolean;
  /** Units of the target token that combination buys at expected proceeds (0 if it cannot). */
  expectedOutQty: number;
  minOutQty: number;
  /** QU it expects to leave unspent in the wallet, and the flat fees it pays up front out of the wallet's own QU. */
  leftoverQu: number;
  upfrontQu: number;
  /**
   * What it is worth in units of the target token: the units bought, plus the leftover QU at the price this plan's own purchase paid,
   * minus the up-front fees at that price. Units alone would mislead: a plan that buys at a better price can end up buying fewer
   * units because it is sized against a worst-case limit and keeps the rest as QU.
   */
  valueQty: number;
  /** How much less than QMax's route this is worth, in units and as a percentage of QMax's (never negative). Null when it cannot do the swap. */
  lessQty: number | null;
  lessPct: number | null;
  /** Why it cannot, in a few words. */
  reason?: string;
}

export interface BestDeal {
  /** One plain sentence on what routing is worth for this swap, or on why nothing beats a single market. */
  headline: string;
  comparisons: SwapComparison[];
  /** What QMax's own route is worth in units of the target token (see `SwapComparison.valueQty`). */
  valueQty: number;
  /** What the best single-market combination is worth (0 if none can do it). */
  bestSingleValueQty: number;
  /** QMax's value minus the best single combination's: what routing gains (can be 0). */
  gainQty: number;
  gainPct: number;
}

const statusOf = (e: unknown) => (e && typeof e === "object" && "status" in e ? (e as { status: unknown }).status : undefined);

/**
 * Plans a swap of `qty` units of `from` for as much `to` as leg 1's proceeds can buy. Quotes leg 1 once, then searches
 * leg 2's size twice (worst-case and expected proceeds), each with at most `maxQuotesPerSearch` new quotes.
 * Quote errors other than an unknown asset are thrown.
 */
export async function planSwap(quoteFn: QuoteFn, input: SwapPlanInput): Promise<SwapPlan> {
  const slippageBps = input.slippageBps ?? 100;
  const maxQuotes = input.maxQuotesPerSearch ?? MAX_QUOTES_PER_SEARCH;
  const plan: SwapPlan = {
    from: input.from.trim(),
    to: input.to.trim(),
    qty: input.qty,
    slippageBps,
    executable: false,
    sell: null,
    buy: null,
    buyAtWorst: null,
    expectedOutQty: 0,
    minOutQty: 0,
    expectedProceedsQu: 0,
    worstProceedsQu: 0,
    safetyMarginQu: 0,
    upfrontQu: 0,
    upfrontIncludesShareMoves: !!input.holdings,
    buyMaxOutlayQu: 0,
    maxTotalOutlayQu: 0,
    expectedLeftoverQu: 0,
    quotesUsed: 0,
    warnings: [],
  };
  const stop = (code: SwapProblemCode, message: string) => {
    plan.problem = { code, message };
    plan.warnings.push(message);
    return plan;
  };
  const { from, to } = plan;
  if (!from || !to) return stop("bad-input", "Both 'from' and 'to' are required.");
  if (!Number.isSafeInteger(input.qty) || input.qty <= 0 || input.qty > MAX_QTY) return stop("bad-input", `qty must be a whole number from 1 to ${MAX_QTY}.`);
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 1000) return stop("bad-input", "slippageBps must be between 0 and 1000.");
  if (isQu(from) || isQu(to)) return stop("qu", "QU is what both legs trade against. To turn a token into QU or QU into a token, use a normal sell or buy.");
  if (from.toUpperCase() === to.toUpperCase()) return stop("same-asset", "Pick two different tokens to swap.");

  // Leg 1, and the first look at leg 2's market (which also tells whether `to` exists).
  let sell: SwapQuote;
  try {
    sell = await quoteFn("sell", from, input.qty, slippageBps);
  } catch (e) {
    if (statusOf(e) === 404) return stop("unknown-asset", `Unknown asset '${from}'`);
    throw e;
  }
  plan.quotesUsed++;
  plan.sell = sell;
  const prober = buyProber(quoteFn, to, slippageBps);
  let one: Probe;
  try {
    one = await prober.at(1);
  } catch (e) {
    if (statusOf(e) === 404) return stop("unknown-asset", `Unknown asset '${to}'`);
    throw e;
  } finally {
    plan.quotesUsed = 1 + prober.calls;
  }
  if (sameAsset(sell, one.quote)) return stop("same-asset", `'${from}' and '${to}' are the same token.`);

  const tag = (who: string, ws: string[]) => ws.map((w) => `${who}: ${w}`);
  const sellProblem = legProblem(sell, "sell", input.qty);
  if (sellProblem) {
    plan.warnings.push(`Selling ${from}: ${sellProblem}`, ...tag(`Selling ${from}`, sell.warnings.filter((w) => w !== sellProblem)));
    return plan;
  }
  plan.warnings.push(...tag(`Selling ${from}`, sell.warnings));
  plan.expectedProceedsQu = expectedProceedsQu(sell);
  plan.worstProceedsQu = worstProceedsQu(sell);
  plan.safetyMarginQu = safetyMarginQu(plan.worstProceedsQu);
  try {
    plan.upfrontQu = upfrontQu(sell, input.holdings);
  } catch (e) {
    plan.warnings.push(e instanceof Error ? e.message : String(e));
    return plan;
  }

  const unbuyable = legProblem(one.quote, "buy", 1);
  if (unbuyable) {
    plan.warnings.push(`Buying ${to}: ${unbuyable}`);
    return plan;
  }
  const worstBudget = plan.worstProceedsQu - plan.safetyMarginQu;
  // The 1-unit quote above is this search's first, so it gets one fewer new quote.
  const atWorst = await largestBuyWithin(prober, worstBudget, 1, MAX_QTY, maxQuotes - 1);
  plan.quotesUsed = 1 + prober.calls;
  if (!atWorst) {
    plan.warnings.push(
      `Buying ${to}: in the worst case the sale pays ${money(plan.worstProceedsQu)} QU, which is not enough to buy even 1 ${to} within your limits (leg 2 needs up to ${money(one.outlayQu)} QU for 1). Swap a larger amount.`,
    );
    return plan;
  }
  // The expected-case search starts from everything the first one learned, so it usually needs only a few quotes.
  const atExpected = (await largestBuyWithin(prober, plan.expectedProceedsQu - plan.safetyMarginQu, atWorst.qty, MAX_QTY, maxQuotes)) ?? atWorst;
  plan.quotesUsed = 1 + prober.calls;
  const tiny = tinyQswapBuy(atWorst.quote) ?? tinyQswapBuy(atExpected.quote);
  if (tiny) {
    plan.warnings.push(`Buying ${to}: ${tiny}`);
    return plan;
  }

  plan.buyAtWorst = atWorst.quote;
  plan.buy = atExpected.quote;
  plan.minOutQty = atWorst.qty;
  plan.expectedOutQty = atExpected.qty;
  plan.buyMaxOutlayQu = atExpected.outlayQu;
  plan.maxTotalOutlayQu = plan.upfrontQu + plan.buyMaxOutlayQu;
  plan.expectedLeftoverQu = Math.max(0, plan.expectedProceedsQu - Math.ceil(atExpected.quote.totalQu));
  plan.warnings.push(...tag(`Buying ${to}`, atExpected.quote.warnings));

  // Flat fees: what the sale costs up front plus QSwap's 100,000 QU per buy call.
  const flatQu = plan.upfrontQu + atExpected.quote.route.filter((l) => l.execution?.type === "qswap-buy").length * QSWAP_OPERATION_FEE_QU;
  if (plan.expectedProceedsQu > 0 && flatQu / plan.expectedProceedsQu > FLAT_FEE_WARN_SHARE)
    plan.warnings.push(
      `Flat market fees (${money(flatQu)} QU) are ${Math.round((flatQu / plan.expectedProceedsQu) * 100)}% of what this swap moves. QSwap charges 100,000 QU per swap whatever the size, so a larger amount costs less per unit.`,
    );
  plan.executable = plan.minOutQty >= 1 && plan.worstProceedsQu > 0;
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------
// The steps to sign

export interface SwapPhase {
  steps: TxStep[];
  /** Most QU this phase's steps attach (unused QU is refunded by the contracts). */
  maxOutlayQu: number;
}

export interface SwapSteps {
  /** Leg 1: any share-management move first, then one call per venue. Its outlay must be in the wallet up front. */
  sell: SwapPhase;
  /** Leg 2 as planned. Rebuild it with `fitBuyToBalance` once leg 1 has settled, and sign that instead. */
  buy: SwapPhase;
  /** Both phases in signing order. */
  steps: TxStep[];
}

const prefixed = (phase: "sell" | "buy", steps: TxStep[]) => steps.map((s) => ({ ...s, id: `${phase}:${s.id}` }));

/**
 * The transactions of both legs, in signing order. Pure: it builds, it does not check the wallet's QU. Throws when a
 * quote cannot be signed, the two tokens are the same, or `holdings` cannot cover the sale.
 * `holdings` should leave out shares already offered in the wallet's resting QX asks (see `freeHoldings`).
 */
export function planSwapSteps(sellQuote: SwapQuote, buyQuote: SwapQuote, holdings: Holdings): SwapSteps {
  const sp = legProblem(sellQuote, "sell", sellQuote.qty);
  if (sp) throw new Error(`Leg 1 (sell ${sellQuote.asset}): ${sp}`);
  const bp = legProblem(buyQuote, "buy", buyQuote.qty);
  if (bp) throw new Error(`Leg 2 (buy ${buyQuote.asset}): ${bp}`);
  if (sameAsset(sellQuote, buyQuote)) throw new Error("A swap needs two different tokens.");
  const s = buildExecutionPlan(executableOf(sellQuote), holdings);
  const b = buildExecutionPlan(executableOf(buyQuote));
  const sell = { steps: prefixed("sell", s.steps), maxOutlayQu: s.maxOutlayQu };
  const buy = { steps: prefixed("buy", b.steps), maxOutlayQu: b.maxOutlayQu };
  return { sell, buy, steps: [...sell.steps, ...buy.steps] };
}

/** Shares the wallet can sell now: QX will not sell (or move) shares already offered in the wallet's own resting asks. */
export function freeHoldings(holdings: Holdings, openOrders: OpenOrder[]): Holdings {
  const reserved = openOrders.filter((o) => o.side === "ask").reduce((s, o) => s + o.qty, 0);
  return { ...holdings, [QX_INDEX]: Math.max(0, (holdings[QX_INDEX] ?? 0) - reserved) };
}

/**
 * Qx.h merges a new order into the wallet's own resting order on the same asset, side and price instead of matching
 * it: the shares (or the QU) would just sit on the book. And it does not skip the wallet's own orders on the other
 * side: a sale would match the wallet's own bid (a buy its own ask), paying the fee to trade with itself and turning
 * QU that was locked in that bid into what looks like sale proceeds. Returns why a quote would hit either, or null.
 * `openOrders` are the wallet's resting QX orders for the quote's asset.
 */
export function restingOrderClash(quote: SwapQuote, openOrders: OpenOrder[]): string | null {
  for (const leg of quote.route) {
    const h = leg.execution;
    if (h?.type === "qx-ask" && openOrders.some((o) => o.side === "ask" && o.price === h.limitPrice))
      return `You already have a QX sell order for ${quote.asset} at ${money(h.limitPrice)} QU. QX adds to that order instead of trading, so the shares would not sell. Cancel it first, or change the slippage so the limit price differs.`;
    if (h?.type === "qx-bid" && openOrders.some((o) => o.side === "bid" && o.price === h.limitPrice))
      return `You already have a QX buy order for ${quote.asset} at ${money(h.limitPrice)} QU. QX adds to that order instead of trading, so the QU would sit on the book. Cancel it first, or change the slippage so the limit price differs.`;
    if (h?.type === "qx-ask") {
      const own = openOrders.find((o) => o.side === "bid" && o.price >= h.limitPrice);
      if (own)
        return `You have your own QX buy order for ${quote.asset} at ${money(own.price)} QU, at or above this sale's limit of ${money(h.limitPrice)} QU. QX would match the sale against it, so you would trade with yourself and pay the fee. Cancel it first.`;
    }
    if (h?.type === "qx-bid") {
      const own = openOrders.find((o) => o.side === "ask" && o.price <= h.limitPrice);
      if (own)
        return `You have your own QX sell order for ${quote.asset} at ${money(own.price)} QU, at or below this buy's limit of ${money(h.limitPrice)} QU. QX would match the buy against it, so you would trade with yourself and pay the fee. Cancel it first.`;
    }
  }
  return null;
}

/**
 * Whether `reviewed`, a buy the user reviewed (its signed limits unchanged), still fills in full at the prices of
 * `fresh`, a new quote of the same size: the router takes the same venues for the same quantities, and on each the new
 * price sits inside the reviewed limit (QX: the dearest order it needs is at or below the limit price; QSwap: the pool
 * charges at most maxQuIn). A fresh quote puts the slippage room on top of the price as it is now, so after a move that
 * stayed inside the limit the fresh limits can need more QU than the reviewed ones, which still fill.
 */
export function reviewedStillFills(reviewed: SwapQuote, fresh: SwapQuote): boolean {
  if (reviewed.qty !== fresh.qty || !sameAsset(reviewed, fresh)) return false;
  if (legProblem(reviewed, "buy", reviewed.qty) || legProblem(fresh, "buy", fresh.qty)) return false;
  if (reviewed.route.length !== fresh.route.length) return false;
  return reviewed.route.every((r) => {
    const f = fresh.route.find((x) => x.venue === r.venue);
    const h = r.execution!;
    if (!f || f.qty !== r.qty) return false;
    if (h.type === "qx-bid") return f.execution?.type === "qx-bid" && !!f.priceRangeQu && Number.isFinite(f.priceRangeQu.worst) && f.priceRangeQu.worst <= h.limitPrice;
    if (h.type === "qswap-buy") return f.execution?.type === "qswap-buy" && f.totalQu - f.fixedCostQu <= h.maxQuIn;
    return false;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Between the legs

export interface FitInput {
  /**
   * The reviewed plan. Leg 2 is never larger than `expectedOutQty` nor smaller than `minOutQty`. `upfrontQu` must be
   * what leg 1's steps actually attached: the sell phase's `maxOutlayQu` from `planSwapSteps` with the real holdings.
   * With `buyAtWorst`, the minimum can still be bought with its reviewed limits when a fresh quote's limits no longer
   * fit (see `reviewedStillFills`). With `buyMaxOutlayQu`, `needsConfirmation` says when leg 2 attaches more than that.
   */
  plan: Pick<SwapPlan, "to" | "slippageBps" | "minOutQty" | "expectedOutQty" | "upfrontQu"> & Partial<Pick<SwapPlan, "buyAtWorst" | "buyMaxOutlayQu">>;
  /** Wallet QU read right before leg 1 was signed. */
  balanceBeforeQu: number;
  /** Wallet QU read after leg 1 confirmed and the sale shows in the wallet. */
  balanceNowQu: number;
  /** Units of the sold token that left the wallet during leg 1 (holdings before minus after). */
  soldQty: number;
  /** Fresh quotes (the browser uses `/v1/quote`). */
  quoteFn: QuoteFn;
  /** The wallet's resting QX orders for the token being bought (see `restingOrderClash`). */
  openOrders?: OpenOrder[];
  maxQuotes?: number;
}

export type FitResult =
  | {
      ok: true;
      qty: number;
      quote: SwapQuote;
      /** Sign exactly these. */
      steps: TxStep[];
      maxOutlayQu: number;
      /** What leg 2 was allowed to attach: the smaller of the wallet's balance and what leg 1 brought in. */
      budgetQu: number;
      /** QU leg 1 brought in: balance change plus the flat fees it attached (an over-count by any fee refunded). */
      receivedQu: number;
      /** True when leg 2 is smaller than the reviewed `expectedOutQty`. */
      resized: boolean;
      /** True when these are the reviewed minimum's own limits (`plan.buyAtWorst`), not a fresh quote's. */
      reviewedLimits: boolean;
      /**
       * Ask the user before signing: leg 2 is smaller than reviewed, or attaches more QU than the reviewed
       * `buyMaxOutlayQu` (the price moved), or the plan did not say what was reviewed.
       */
      needsConfirmation: boolean;
      quotesUsed: number;
    }
  | { ok: false; reason: string; budgetQu: number; receivedQu: number; quotesUsed: number };

/**
 * Sizes leg 2 again once leg 1 has settled, from the wallet's real QU: re-quotes at the reviewed size and, if that no
 * longer fits, shrinks it (never below the promised minimum, never above the reviewed size). The returned steps attach
 * no more than min(wallet balance, QU leg 1 brought in), so leg 2 cannot fail for lack of QU and never spends more of
 * the wallet's own QU than leg 1's fees, which the user approved. Refuses, with a reason, rather than overspend.
 * Pure apart from the quotes it asks `quoteFn` for (at most `maxQuotes`, default 12).
 */
export async function fitBuyToBalance(input: FitInput): Promise<FitResult> {
  const { plan } = input;
  const maxQuotes = Math.max(2, input.maxQuotes ?? MAX_QUOTES_PER_SEARCH);
  const nums = [input.balanceBeforeQu, input.balanceNowQu, input.soldQty, plan.upfrontQu, plan.minOutQty, plan.expectedOutQty];
  const known = nums.every((n) => Number.isSafeInteger(n) && n >= 0);
  const receivedQu = known ? input.balanceNowQu - input.balanceBeforeQu + plan.upfrontQu : 0;
  const budgetQu = known ? Math.max(0, Math.min(input.balanceNowQu, receivedQu)) : 0;
  let quotesUsed = 0;
  const refuse = (reason: string): FitResult => ({ ok: false, reason, budgetQu, receivedQu, quotesUsed });

  if (!known) return refuse("The wallet could not be read reliably, so the second trade was not prepared. Nothing more was sent.");
  if (plan.minOutQty < 1 || plan.expectedOutQty < plan.minOutQty) return refuse("This swap had no second trade that could be signed.");
  if (input.soldQty <= 0) return refuse("The first trade has not sold anything (or the wallet has not updated yet), so there is no QU to buy with. Nothing more was sent.");
  if (budgetQu <= 0) return refuse(`The first trade brought in no usable QU (wallet change ${money(input.balanceNowQu - input.balanceBeforeQu)} QU). Nothing more was sent.`);

  const p = buyProber(input.quoteFn, plan.to, plan.slippageBps);
  const fits = (x: Probe) => x.outlayQu <= budgetQu;
  let pick: Probe | null = null;
  /** The fresh quote of the minimum, when the reviewed one is signed instead: its prices are checked too. */
  let freshMin: SwapQuote | null = null;
  try {
    const top = await p.at(plan.expectedOutQty);
    if (fits(top)) pick = top;
    else {
      const bottom = await p.at(plan.minOutQty);
      if (fits(bottom)) pick = (await largestBuyWithin(p, budgetQu, plan.minOutQty, plan.expectedOutQty, maxQuotes - p.calls)) ?? bottom;
      else {
        // The fresh limits add the slippage room on top of today's price. If the price moved but stayed inside the
        // reviewed limits, the reviewed minimum still fills and still fits what the sale paid: sign that.
        const reviewed = plan.buyAtWorst;
        if (reviewed && reviewed.qty === plan.minOutQty && reviewedStillFills(reviewed, bottom.quote)) {
          const asReviewed: Probe = { qty: plan.minOutQty, quote: reviewed, outlayQu: buyMaxOutlayQu(reviewed) };
          if (fits(asReviewed)) {
            pick = asReviewed;
            freshMin = bottom.quote;
          }
        }
        if (!pick) {
          quotesUsed = p.calls;
          // When the quote says why (a QSwap buy too small to be safe), say that rather than a generic "cannot be filled".
          const tooSmall = bottom.quote.warnings.find((w) => /too small/i.test(w));
          if (tooSmall) return refuse(`${tooSmall} The second trade was not sent, so you keep the QU.`);
          const need = Number.isFinite(bottom.outlayQu) ? `now needs up to ${money(bottom.outlayQu)} QU` : "cannot be filled right now";
          return refuse(`Buying the promised minimum of ${money(plan.minOutQty)} ${plan.to} ${need}, and the first trade left ${money(budgetQu)} QU for it (the sale paid less than planned, or ${plan.to}'s price moved past your limit). The second trade was not sent, so you keep the QU.`);
        }
      }
    }
  } catch (e) {
    quotesUsed = p.calls;
    return refuse(`Could not get a fresh price for ${plan.to}: ${e instanceof Error ? e.message : String(e)}. The second trade was not sent, so you keep the QU.`);
  }
  quotesUsed = p.calls;

  const clash = restingOrderClash(pick.quote, input.openOrders ?? []);
  if (clash) return refuse(clash);
  const tiny = tinyQswapBuy(pick.quote) ?? (freshMin && tinyQswapBuy(freshMin));
  if (tiny) return refuse(`${tiny} The second trade was not sent, so you keep the QU.`);
  const built = buildExecutionPlan(executableOf(pick.quote));
  const steps = prefixed("buy", built.steps);
  // The final check stands on its own: whatever the search did, never hand back steps the wallet cannot pay for.
  if (!(built.maxOutlayQu <= budgetQu && budgetQu <= input.balanceNowQu) || pick.qty < plan.minOutQty || pick.qty > plan.expectedOutQty)
    return refuse("The second trade did not pass the final balance check, so it was not sent.");
  const resized = pick.qty < plan.expectedOutQty;
  const needsConfirmation = resized || !(plan.buyMaxOutlayQu !== undefined && built.maxOutlayQu <= plan.buyMaxOutlayQu);
  return { ok: true, qty: pick.qty, quote: pick.quote, steps, maxOutlayQu: built.maxOutlayQu, budgetQu, receivedQu, resized, reviewedLimits: freshMin !== null, needsConfirmation, quotesUsed };
}

// ---------------------------------------------------------------------------------------------------------------
// What routing is worth for a swap

const VENUES = ["QX", "QSwap"] as const;

/** A plan's worth in units of its target token: units bought + (leftover QU - up-front fees) at the price its own purchase paid. */
function valueOf(plan: SwapPlan): number {
  const price = plan.buy && plan.buy.qty > 0 ? plan.buy.totalQu / plan.buy.qty : 0;
  const extra = price > 0 ? (plan.expectedLeftoverQu - plan.upfrontQu) / price : 0;
  return Math.max(0, plan.expectedOutQty + extra);
}
const pctText = (x: number) => (x < 10 ? x.toFixed(1) : x.toFixed(0));

/**
 * Plans the same swap four more times with the sale and the purchase each forced onto one market (QX or QSwap), and compares what
 * each combination would deliver with what QMax's own route delivers. This is measured, not asserted: every number is a real plan
 * over the same quotes, sized the same way. A combination a market cannot do (the token is not there, the book is too shallow, the
 * order is too small for its fees) is listed as unavailable with the reason.
 */
export async function compareSwap(deps: { quote: QuoteFn; quoteOnly: (venue: "QX" | "QSwap") => QuoteFn }, input: SwapPlanInput, best: SwapPlan): Promise<BestDeal> {
  const comparisons: SwapComparison[] = [];
  const bestValue = valueOf(best);
  for (const sellVenue of VENUES) {
    for (const buyVenue of VENUES) {
      const label = `Sell on ${sellVenue}, buy on ${buyVenue}`;
      const sellQ = deps.quoteOnly(sellVenue);
      const buyQ = deps.quoteOnly(buyVenue);
      // a quote function that sends each leg to its own market
      const forced: QuoteFn = (side, asset, qty, slippageBps) => (side === "sell" ? sellQ : buyQ)(side, asset, qty, slippageBps);
      let plan: SwapPlan | null = null;
      try {
        plan = await planSwap(forced, input);
      } catch {
        plan = null;
      }
      if (!plan || plan.problem || !plan.executable || !(plan.expectedOutQty > 0)) {
        const reason = plan?.warnings.find((w) => /too small|liquidity|fill|not on|unknown/i.test(w)) ?? "this market cannot do that leg";
        comparisons.push({ label, sellVenue, buyVenue, executable: false, expectedOutQty: 0, minOutQty: 0, leftoverQu: 0, upfrontQu: 0, valueQty: 0, lessQty: null, lessPct: null, reason: reason.slice(0, 140) });
        continue;
      }
      const valueQty = valueOf(plan);
      const lessQty = Math.max(0, bestValue - valueQty);
      comparisons.push({ label, sellVenue, buyVenue, executable: true, expectedOutQty: plan.expectedOutQty, minOutQty: plan.minOutQty, leftoverQu: plan.expectedLeftoverQu, upfrontQu: plan.upfrontQu, valueQty, lessQty, lessPct: bestValue > 0 ? (lessQty / bestValue) * 100 : 0 });
    }
  }
  const able = comparisons.filter((c) => c.executable);
  const bestSingle = able.reduce<SwapComparison | null>((a, c) => (!a || c.valueQty > a.valueQty ? c : a), null);
  const bestSingleValueQty = bestSingle?.valueQty ?? 0;
  const gainQty = Math.max(0, bestValue - bestSingleValueQty);
  const gainPct = bestSingleValueQty > 0 ? (gainQty / bestSingleValueQty) * 100 : 0;
  const to = input.to;
  // "selling on QX and buying on QSwap": built from the venues, not by lowercasing a label (QX and QSwap are names)
  const how = (c: SwapComparison) => (c.sellVenue === c.buyVenue ? `selling and buying on ${c.sellVenue}` : `selling on ${c.sellVenue} and buying on ${c.buyVenue}`);
  let headline: string;
  if (!bestSingle) headline = "No single-market combination could do this swap, so QMax's route is what makes it possible.";
  else if (gainQty >= 1 && gainPct >= 0.05)
    headline = `QMax's route is worth about ${money(bestValue)} ${to}: ${money(gainQty)} more (${pctText(gainPct)}%) than the best single-market route (${how(bestSingle)}, about ${money(bestSingleValueQty)} ${to}), counting the QU left over and the fees paid up front.`;
  else {
    const worse = able.filter((c) => c !== bestSingle && (c.lessPct ?? 0) >= 0.05).sort((a, b) => (b.lessPct ?? 0) - (a.lessPct ?? 0))[0];
    headline = `${how(bestSingle).replace(/^./, (c) => c.toUpperCase())} is already the best deal for this swap${worse ? `: ${how(worse)} would be worth ${pctText(worse.lessPct!)}% less` : ""}.`;
  }
  return { headline, comparisons, valueQty: bestValue, bestSingleValueQty, gainQty, gainPct };
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP

/** What the swap endpoint needs: one quote, as `buildQuote` makes it. */
export interface SwapDeps {
  quote: QuoteFn;
  /** A quote function that routes on one market only. With it, `compare: true` on a request measures each single-market combination. */
  quoteOnly?: (venue: "QX" | "QSwap") => QuoteFn;
  /**
   * An optional size limit: the most QU a swap may put at risk (`maxTotalOutlayQu`). There is none unless the operator sets one
   * (`SWAP_MAX_OUTLAY_QU` in the server's environment). The limits that remain are the contracts' own (QX refuses an order whose
   * price times quantity reaches 1e15) and the quote's maximum quantity.
   */
  maxOutlayQu?: number;
}

/** Reads `{ from, to, qty, slippageBps? }`. Throws a 400 for anything else. */
export function parseSwapBody(body: unknown): { from: string; to: string; qty: number; slippageBps: number; compare: boolean } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RouteError(400, "Body must be a JSON object: { from, to, qty, slippageBps? }");
  const b = body as Record<string, unknown>;
  const from = typeof b.from === "string" ? b.from.trim() : "";
  const to = typeof b.to === "string" ? b.to.trim() : "";
  if (!from) throw new RouteError(400, "from is required (an asset id from /v1/assets)");
  if (!to) throw new RouteError(400, "to is required (an asset id from /v1/assets)");
  const qty = typeof b.qty === "number" ? b.qty : Number(String(b.qty ?? "").replace(/,/g, ""));
  if (!Number.isSafeInteger(qty) || qty <= 0 || qty > MAX_QTY) throw new RouteError(400, `qty must be a positive whole number up to ${MAX_QTY}`);
  const slippageBps = b.slippageBps === undefined ? 100 : Number(b.slippageBps);
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 1000) throw new RouteError(400, "slippageBps must be between 0 and 1000");
  return { from, to, qty, slippageBps, compare: b.compare === true };
}

export function swapRoutes(deps: SwapDeps): Route[] {
  return [
    {
      method: "POST",
      path: "/v1/swap-quote",
      limited: true,
      doc: {
        summary: "Plan a token-to-token swap: sell one token for QU, then buy another with that QU",
        description:
          "Two trades run one after the other, each on QMax's best route (QX, QSwap or a split). Leg 2 is sized so that its worst case (the QU its signed limits " +
          "can take) fits the LEAST leg 1 can pay within its limits, less a small safety margin: that size is `minOutQty`. `expectedOutQty` is the size if leg 1 " +
          "pays what it is expected to. `upfrontQu` must be in the wallet before leg 1: QSwap's flat 100,000 QU per sell call leaves before the proceeds arrive " +
          "(share-management moves are not included, as the wallet is not known here). Nothing is signed or sent; leg 2 must be sized again from the wallet's " +
          "real balance after leg 1 settles. Both legs are limit orders: a QX order that does not fill stays on the book.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["from", "to", "qty"],
                properties: {
                  from: { type: "string", description: "Asset id to sell, from /v1/assets" },
                  to: { type: "string", description: "Asset id to buy, from /v1/assets" },
                  qty: { type: "integer", minimum: 1, maximum: MAX_QTY, description: "Units of `from` to sell" },
                  slippageBps: { type: "integer", minimum: 0, maximum: 1000, default: 100, description: "Price movement allowed on each leg" },
                  compare: { type: "boolean", default: false, description: "Also plan the same swap forced onto each single market (QX or QSwap for each leg) and say what QMax's route gains over the best of them (`bestDeal`). Slower: several plans." },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The plan: both quotes, expected and guaranteed amounts, QU needed up front, warnings and whether it can be signed" },
          "400": { description: "Bad body, the same token twice, or QU as either side" },
          "404": { description: "Unknown asset" },
        },
      },
      handler: async ({ body }) => {
        const input = parseSwapBody(body);
        const plan = await planSwap(deps.quote, input);
        if (plan.problem) throw new RouteError(plan.problem.code === "unknown-asset" ? 404 : 400, plan.problem.message);
        if (input.compare && deps.quoteOnly && plan.sell && plan.buy) {
          // the comparison is an extra: if it cannot be made, the plan itself is still good
          try {
            plan.bestDeal = await compareSwap({ quote: deps.quote, quoteOnly: deps.quoteOnly }, input, plan);
          } catch {
            // leave bestDeal out
          }
        }
        const cap = deps.maxOutlayQu;
        if (cap !== undefined && Number.isFinite(cap) && cap > 0 && plan.executable && plan.maxTotalOutlayQu > cap) {
          plan.executable = false;
          plan.capQu = cap;
          plan.warnings.push(`This server limits a swap to ${cap.toLocaleString("en-US")} QU at risk, and this one could move up to ${Math.round(plan.maxTotalOutlayQu).toLocaleString("en-US")} QU. Try a smaller amount, or do the sale and the purchase as two normal trades.`);
        }
        return plan;
      },
    },
  ];
}
