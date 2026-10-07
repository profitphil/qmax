import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { QSWAP_OPERATION_FEE_QU, buildExecutionPlan } from "../src/exec.ts";
import type { Holdings, TxStep } from "../src/exec.ts";
import { buildQuote } from "../src/quoteapi.ts";
import { assetNameFromU64 } from "../src/identity.ts";
import { QX_INDEX } from "../src/rpc.ts";
import { RouteError } from "../src/routes.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";
import type { BookLevel, QswapConfig, QxConfig } from "../src/venues.ts";
import {
  MAX_QUOTES_PER_SEARCH,
  SAFETY_MARGIN,
  compareSwap,
  expectedProceedsQu,
  fitBuyToBalance,
  freeHoldings,
  legProblem,
  affordableBuy,
  parseSwapBody,
  planSwap,
  planSwapSteps,
  qxFeeRateCeiling,
  restingOrderClash,
  safetyMarginQu,
  swapRoutes,
  upfrontQu,
  worstLegProceedsQu,
  worstProceedsQu,
} from "../src/swap.ts";
import type { QuoteFn, QuoteLeg, SwapPlan, SwapQuote } from "../src/swap.ts";

const ISSUERS = [
  "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL",
  "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
];
const FEES = { qx: 100, qswap: 100 };

/** QX as the live data source configures it: the 0.3% fee comes out of the seller's QU, plus the 100 QU flat cost. */
const qx = (bids: BookLevel[], asks: BookLevel[] = []): QxConfig => ({ bids, asks, buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 100 });
/** A QSwap pool: 0.3% fee, flat 100,000 QU per swap plus the 100 QU transfer fee. */
const pool = (reserveQu: number, reserveAsset: number): QswapConfig => ({ reserveQu, reserveAsset, swapFeeRate: 30, fixedCostQu: QSWAP_OPERATION_FEE_QU + 100 });

interface Market {
  qx?: QxConfig;
  qswap?: QswapConfig;
  /** Serve it like the demo snapshot: no on-chain identity, so nothing can be signed. */
  demo?: boolean;
}

/** MarketData over real venue objects, so quotes come from the real router and `buildQuote`. */
function marketData(markets: Record<string, Market>): MarketData {
  const ids = Object.keys(markets);
  return {
    assets: () => ids,
    venues: async (a) => {
      const m = markets[a.toUpperCase()];
      if (!m) return null;
      return [m.qx && new QxVenue(m.qx), m.qswap && new QswapVenue(m.qswap)].filter((v): v is QxVenue | QswapVenue => !!v);
    },
    assetInfo: async (a) => {
      const id = a.toUpperCase();
      const m = markets[id];
      if (!m || m.demo) return null;
      return { symbol: id, issuer: ISSUERS[ids.indexOf(id) % ISSUERS.length], assetName: id, transferFeeQu: FEES };
    },
  };
}

/** The quote function the server builds: `buildQuote` on the market. Counts its calls. */
function quoteFnOf(markets: Record<string, Market>) {
  const data = marketData(markets);
  const fn = ((side, asset, qty, slippageBps) => {
    fn.calls++;
    return buildQuote(data, { side, asset, qty, slippageBps }, { allowTinyQswapBuy: true }) as Promise<SwapQuote>;
  }) as QuoteFn & { calls: number };
  fn.calls = 0;
  return fn;
}

const stepsSum = (steps: { amountQu: number }[]) => steps.reduce((s, x) => s + x.amountQu, 0);

// ------------------------------------------------------------------------------------------------------------
// Hand-computed cases

test("QX-only sale: the worst case is every share matched at the limit, less the fee, 1 QU per matched order and QX's flat cost", async () => {
  const q = quoteFnOf({ AAA: { qx: qx([{ price: 100, qty: 600 }, { price: 98, qty: 1000 }]) } });
  const sell = await q("sell", "AAA", 1000, 100);
  const [leg] = sell.route;
  // The router walks 600 @ 100 and 400 @ 98: 99,200 QU gross, fees 181 + 118 = 299, less the 100 QU flat cost.
  assert.equal(leg.venue, "QX");
  assert.equal(leg.totalQu, 98_801);
  assert.equal(leg.feesQu, 299);
  assert.equal(leg.depth?.levelsUsed, 2);
  assert.deepEqual(leg.execution, { type: "qx-ask", qty: 1000, limitPrice: 97 }); // floor(98 x 0.99)
  // Fee rate ceiling 299 / 99,200; fee at the limit ceil(97,000 x 299 / 99,200) = ceil(292.37) = 293.
  assert.equal(qxFeeRateCeiling(leg), 299 / 99_200);
  assert.equal(worstLegProceedsQu(leg), 97_000 - 293 - 2 - 100);
  assert.equal(worstProceedsQu(sell), 96_605);
  assert.equal(expectedProceedsQu(sell), 98_901); // gross less fees: what actually arrives
  assert.equal(upfrontQu(sell), 0, "a QX ask attaches no QU");

  // The venue model's own worst case: all 1,000 bid at exactly the limit, as one order or as the two the quote matched.
  for (const bids of [[{ price: 97, qty: 1000 }], [{ price: 97, qty: 600 }, { price: 97, qty: 400 }]]) {
    const worst = new QxVenue(qx(bids)).quote("sell", 1000)!;
    assert.ok(worst.netQu >= worstProceedsQu(sell), `${worst.netQu} >= 96,605`);
  }
  assert.equal(new QxVenue(qx([{ price: 97, qty: 600 }, { price: 97, qty: 400 }])).quote("sell", 1000)!.netQu, 96_608);
});

test("QSwap-only sale: the worst case is the signed minimum, and the 100,000 QU swap fee is needed up front", async () => {
  const q = quoteFnOf({ AAA: { qswap: pool(1_000_000_000, 10_000_000) } });
  const sell = await q("sell", "AAA", 10_000, 100);
  const [leg] = sell.route;
  // Constant product: floor(1e9 x 1e4 / 10,010,000) = 999,000 gross; less 0.3% = 996,003 out; minimum floor(996,003 x 0.99).
  assert.equal(leg.totalQu, 996_003 - 100_100);
  assert.deepEqual(leg.execution, { type: "qswap-sell", qty: 10_000, minQuOut: 986_042 });
  assert.equal(worstProceedsQu(sell), 986_042);
  assert.equal(expectedProceedsQu(sell), 996_003);
  assert.equal(upfrontQu(sell), 100_000);
  assert.equal(new QswapVenue(pool(1_000_000_000, 10_000_000)).variableNetQu("sell", 10_000), 996_003, "the pool really pays the expected amount");
});

/** A split sale written out by hand: 500 on QX across 3 orders, 300,000 to the pool. */
function splitSale(): SwapQuote {
  return {
    asset: "AAA",
    side: "sell",
    qty: 300_500,
    filledQty: 300_500,
    fillable: true,
    executable: true,
    totalQu: 1_021_034,
    averagePriceQu: 1_021_034 / 300_500,
    slippageBps: 100,
    assetInfo: { issuer: ISSUERS[0], assetName: "AAA", transferFeeQu: FEES },
    warnings: [],
    route: [
      // 200 @ 44 + 200 @ 42 + 100 @ 40 = 21,200 gross; fees 27 + 26 + 13 = 66; less 100 flat = 21,034.
      { venue: "QX", qty: 500, totalQu: 21_034, feesQu: 66, fixedCostQu: 100, depth: { levelsUsed: 3, qtyAvailable: 500 }, execution: { type: "qx-ask", qty: 500, limitPrice: 39 } },
      { venue: "QSwap", qty: 300_000, totalQu: 1_000_000, feesQu: 3_310, fixedCostQu: 100_100, execution: { type: "qswap-sell", qty: 300_000, minQuOut: 1_089_099 } },
    ],
  };
}

test("split sale: each leg's worst case is added up, and share moves count towards the QU needed up front", () => {
  const sell = splitSale();
  // QX: 39 x 500 = 19,500, fee ceil(19,500 x 66 / 21,200) = ceil(60.71) = 61, 3 orders, 100 flat.
  assert.equal(worstLegProceedsQu(sell.route[0]), 19_500 - 61 - 3 - 100);
  assert.equal(worstLegProceedsQu(sell.route[1]), 1_089_099);
  assert.equal(worstProceedsQu(sell), 19_336 + 1_089_099);
  assert.equal(expectedProceedsQu(sell), 21_134 + 1_100_100);
  assert.equal(upfrontQu(sell, { 1: 500, 13: 300_000 }), 100_000, "shares already where they trade");
  assert.equal(upfrontQu(sell, { 1: 300_500, 13: 0 }), 100_100, "300,000 must move to QSwap first (100 QU)");
  assert.throws(() => upfrontQu(sell, { 1: 100, 13: 0 }), /Insufficient AAA/);
});

test("leg 2 is the largest buy whose signed limits fit leg 1's worst case less the margin, found in a bounded number of quotes", async () => {
  // Sell AAA into the pool above (worst 986,042 QU, expected 996,003 QU); buy BBB on QX: 1,000 @ 50, then 100,000 @ 60.
  const markets = { AAA: { qswap: pool(1_000_000_000, 10_000_000) }, BBB: { qx: qx([], [{ price: 50, qty: 1000 }, { price: 60, qty: 100_000 }]) } };
  const q = quoteFnOf(markets);
  const plan = await planSwap(q, { from: "AAA", to: "BBB", qty: 10_000, slippageBps: 100 });
  assert.equal(plan.executable, true, plan.warnings.join("; "));
  assert.equal(plan.safetyMarginQu, SAFETY_MARGIN.minQu); // 0.1% of 986,042 is less than 1,000
  // Above 1,000 units every bid is limited at ceil(60 x 1.01) = 61 QU, so the worst-case budget 985,042 buys floor(985,042 / 61) = 16,148.
  assert.equal(plan.minOutQty, 16_148);
  assert.deepEqual(plan.buyAtWorst!.route[0].execution, { type: "qx-bid", qty: 16_148, limitPrice: 61 });
  // Expected proceeds 996,003 less 1,000 buy floor(995,003 / 61) = 16,311.
  assert.equal(plan.expectedOutQty, 16_311);
  assert.equal(plan.buyMaxOutlayQu, 16_311 * 61);
  assert.equal(plan.upfrontQu, 100_000);
  assert.equal(plan.maxTotalOutlayQu, 100_000 + 16_311 * 61);
  assert.equal(plan.expectedLeftoverQu, 996_003 - plan.buy!.totalQu);
  assert.ok(plan.quotesUsed <= 1 + 2 * MAX_QUOTES_PER_SEARCH, `${plan.quotesUsed} quotes`);
  assert.equal(plan.quotesUsed, q.calls);
});

test("the size search only ever returns a size it quoted, even when cost jumps where the router switches venue", async () => {
  // 10 QU each up to 999 units; from 1,000 a flat 100,000 QU fee appears (a QSwap leg joins). Not monotone in a smooth way.
  const fake: QuoteFn = async (side, asset, qty) => {
    if (side === "sell") return { ...splitSale(), qty, filledQty: qty, route: [{ ...splitSale().route[1], qty, execution: { type: "qswap-sell", qty, minQuOut: 2_000_000 } }] };
    const swap = qty >= 1000;
    return {
      asset, side, qty, filledQty: qty, fillable: true, executable: true, totalQu: qty * 10, averagePriceQu: 10, slippageBps: 0, warnings: [],
      assetInfo: { issuer: ISSUERS[1], assetName: asset, transferFeeQu: FEES },
      route: [swap ? { venue: "QSwap", qty, totalQu: qty * 10 + 100_100, feesQu: 0, fixedCostQu: 100_100, execution: { type: "qswap-buy", qty, maxQuIn: qty * 10 } } : { venue: "QX", qty, totalQu: qty * 10, feesQu: 0, fixedCostQu: 100, execution: { type: "qx-bid", qty, limitPrice: 10 } }],
    };
  };
  const quoted = new Set<number>();
  const counting: QuoteFn = (side, asset, qty, s) => (side === "buy" && quoted.add(qty), fake(side, asset, qty, s));
  const plan = await planSwap(counting, { from: "AAA", to: "BBB", qty: 5 });
  assert.equal(plan.executable, true);
  assert.ok(quoted.has(plan.minOutQty) && quoted.has(plan.expectedOutQty));
  const budget = plan.worstProceedsQu - plan.safetyMarginQu;
  const outlay = (n: number) => (n >= 1000 ? n * 10 + 100_000 : n * 10);
  assert.ok(outlay(plan.minOutQty) <= budget);
  assert.ok(outlay(plan.minOutQty + 1) > budget || plan.minOutQty + 1 > 1e12, "and it is the largest that fits");
});

// ------------------------------------------------------------------------------------------------------------
// Refusals and warnings

test("swapping a token for itself, or for QU, or with an unknown token is refused with the right code", async () => {
  const q = quoteFnOf({ AAA: { qswap: pool(1e9, 1e7) }, BBB: { qswap: pool(1e9, 1e7) } });
  assert.equal((await planSwap(q, { from: "AAA", to: "aaa", qty: 10 })).problem?.code, "same-asset");
  assert.equal((await planSwap(q, { from: "QU", to: "AAA", qty: 10 })).problem?.code, "qu");
  assert.equal((await planSwap(q, { from: "AAA", to: "qu", qty: 10 })).problem?.code, "qu");
  const unknownTo = await planSwap(q, { from: "AAA", to: "NOPE", qty: 10 });
  assert.deepEqual(unknownTo.problem, { code: "unknown-asset", message: "Unknown asset 'NOPE'" });
  assert.equal((await planSwap(q, { from: "NOPE", to: "AAA", qty: 10 })).problem?.code, "unknown-asset");
  assert.equal((await planSwap(q, { from: "AAA", to: "BBB", qty: 1.5 })).problem?.code, "bad-input");
  assert.equal((await planSwap(q, { from: "AAA", to: "BBB", qty: 10, slippageBps: 5000 })).problem?.code, "bad-input");
  for (const p of [unknownTo]) assert.equal(p.executable, false);
});

test("an illiquid side, demo data, or a sale too small for the flat fees is not executable, and says why", async () => {
  const markets: Record<string, Market> = {
    DRY: { qx: qx([], [{ price: 5, qty: 10 }]) }, // nobody is buying DRY
    AAA: { qswap: pool(1_000_000_000, 10_000_000) },
    BBB: { qx: qx([], [{ price: 50, qty: 10 }]) }, // only 10 BBB for sale
    DEMO: { qswap: pool(1e9, 1e7), demo: true },
    BIG: { qx: qx([], [{ price: 2_000_000, qty: 5 }]) }, // 1 BIG costs 2,000,000 QU
  };
  const q = quoteFnOf(markets);
  const dry = await planSwap(q, { from: "DRY", to: "AAA", qty: 5 });
  assert.equal(dry.executable, false);
  assert.match(dry.warnings[0], /^Selling DRY: Not enough liquidity/);

  const thin = await planSwap(q, { from: "AAA", to: "BBB", qty: 10_000 });
  assert.equal(thin.executable, true, "10 BBB is all there is, but it can be bought");
  assert.equal(thin.minOutQty, 10);
  assert.equal(thin.expectedOutQty, 10);

  const demo = await planSwap(q, { from: "DEMO", to: "AAA", qty: 10 });
  assert.equal(demo.executable, false);
  assert.match(demo.warnings[0], /demo data/);

  const tooSmall = await planSwap(q, { from: "AAA", to: "BIG", qty: 10_000 });
  assert.equal(tooSmall.executable, false);
  assert.match(tooSmall.warnings.join(" "), /not enough to buy even 1 BIG/);

  // 2,000 AAA bring about 199,000 QU, of which the pool keeps 100,000 up front: the flat fees dominate.
  const small = await planSwap(q, { from: "AAA", to: "BBB", qty: 2_000 });
  assert.match(small.warnings.join(" "), /Flat market fees \(100,000 QU\) are \d+% of what this swap moves/);
});

test("planSwapSteps orders the sale (share moves first) before the buy, and refuses what cannot be signed", async () => {
  const markets = { AAA: { qswap: pool(1_000_000_000, 10_000_000) }, BBB: { qx: qx([], [{ price: 50, qty: 1000 }, { price: 60, qty: 100_000 }]) } };
  const plan = await planSwap(quoteFnOf(markets), { from: "AAA", to: "BBB", qty: 10_000 });
  const s = planSwapSteps(plan.sell!, plan.buy!, { 1: 10_000 });
  assert.deepEqual(s.steps.map((x) => x.id), [`sell:rights-AAA-${ISSUERS[0].slice(0, 6)}-1-to-13`, "sell:qswap-sell", "buy:qx-bid"]);
  assert.equal(s.sell.maxOutlayQu, 100 + 100_000);
  assert.equal(s.buy.maxOutlayQu, plan.buyMaxOutlayQu);
  assert.equal(stepsSum(s.sell.steps), s.sell.maxOutlayQu);
  assert.throws(() => planSwapSteps(plan.sell!, plan.buy!, { 1: 9_999 }), /Insufficient AAA/);
  assert.throws(() => planSwapSteps(plan.buy!, plan.sell!, {}), /Leg 1/);
  const sameToken = { ...plan.buy!, assetInfo: plan.sell!.assetInfo };
  assert.throws(() => planSwapSteps(plan.sell!, sameToken, { 13: 10_000 }), /two different tokens/);
});

test("shares in the wallet's own resting asks cannot be sold again, and an order at a price the wallet already rests at is flagged", () => {
  assert.deepEqual(freeHoldings({ 1: 500, 13: 20 }, [{ side: "ask", price: 9, qty: 300 }, { side: "bid", price: 7, qty: 1000 }]), { 1: 200, 13: 20 });
  assert.deepEqual(freeHoldings({ 1: 100 }, [{ side: "ask", price: 9, qty: 300 }]), { 1: 0 });
  const sale = splitSale();
  assert.equal(restingOrderClash(sale, [{ side: "ask", price: 40, qty: 1 }]), null);
  assert.match(restingOrderClash(sale, [{ side: "ask", price: 39, qty: 1 }])!, /already have a QX sell order for AAA at 39 QU/);
  const buy: SwapQuote = { ...sale, side: "buy", route: [{ ...sale.route[0], execution: { type: "qx-bid", qty: 500, limitPrice: 41 } }] };
  assert.equal(restingOrderClash(buy, [{ side: "ask", price: 42, qty: 1 }]), null, "an own ask above the bid's limit is not touched");
  assert.match(restingOrderClash(buy, [{ side: "bid", price: 41, qty: 1 }])!, /QX buy order/);
  // Qx.h does not skip the wallet's own orders on the other side: the order would trade with itself and pay the fee.
  assert.match(restingOrderClash(buy, [{ side: "ask", price: 41, qty: 1 }])!, /own QX sell order for AAA at 41 QU, at or below this buy's limit/);
  assert.match(restingOrderClash(buy, [{ side: "ask", price: 30, qty: 1 }])!, /trade with yourself/);
  assert.match(restingOrderClash(sale, [{ side: "bid", price: 39, qty: 1 }])!, /own QX buy order for AAA at 39 QU, at or above this sale's limit/);
  assert.equal(restingOrderClash(sale, [{ side: "bid", price: 38, qty: 1 }]), null, "an own bid below the sale's limit is not touched");
});

test("legProblem rejects quotes whose limits are missing, inconsistent or too large for QX", () => {
  const ok = splitSale();
  assert.equal(legProblem(ok, "sell", 300_500), null);
  assert.match(legProblem(ok, "buy", 300_500)!, /Expected a buy quote/);
  assert.match(legProblem(ok, "sell", 300_000)!, /liquidity/);
  assert.match(legProblem({ ...ok, route: [{ ...ok.route[0], execution: undefined }, ok.route[1]] }, "sell", 300_500)!, /no limits/);
  assert.match(legProblem({ ...ok, route: [{ ...ok.route[0], execution: { type: "qx-ask", qty: 499, limitPrice: 39 } }, ok.route[1]] }, "sell", 300_500)!, /do not match/);
  assert.match(legProblem({ ...ok, route: [{ ...ok.route[0], execution: { type: "qx-ask", qty: 500, limitPrice: 0 } }, ok.route[1]] }, "sell", 300_500)!, /invalid QX limit/);
  assert.match(legProblem({ ...ok, route: [{ ...ok.route[0], execution: { type: "qx-ask", qty: 500, limitPrice: 2e12 } }, ok.route[1]] }, "sell", 300_500)!, /larger than QX accepts/);
  assert.match(legProblem({ ...ok, route: [ok.route[0], { ...ok.route[1], qty: 1 }] }, "sell", 300_500)!, /do not match/);
});

// ------------------------------------------------------------------------------------------------------------
// Between the legs

async function referencePlan() {
  const markets = { AAA: { qswap: pool(1_000_000_000, 10_000_000) }, BBB: { qx: qx([], [{ price: 50, qty: 1000 }, { price: 60, qty: 100_000 }]) } };
  const q = quoteFnOf(markets);
  const plan = await planSwap(q, { from: "AAA", to: "BBB", qty: 10_000, slippageBps: 100 });
  return { plan, q };
}
const fitArgs = (plan: SwapPlan, quoteFn: QuoteFn, before: number, now: number, soldQty = plan.qty) => ({ plan, balanceBeforeQu: before, balanceNowQu: now, soldQty, quoteFn });

test("after leg 1 pays as expected, leg 2 is the reviewed size and fits the QU that came in", async () => {
  const { plan, q } = await referencePlan();
  const before = 250_000;
  const now = before - 100_000 + 996_003;
  const fit = await fitBuyToBalance(fitArgs(plan, q, before, now));
  assert.ok(fit.ok);
  assert.equal(fit.qty, plan.expectedOutQty);
  assert.equal(fit.resized, false);
  assert.equal(fit.receivedQu, 996_003);
  assert.equal(fit.budgetQu, 996_003);
  assert.equal(fit.maxOutlayQu, stepsSum(fit.steps));
  assert.ok(fit.maxOutlayQu <= fit.budgetQu);
  assert.deepEqual(fit.steps.map((s) => s.id), ["buy:qx-bid"]);
  assert.equal(fit.quotesUsed, 1);
});

test("after leg 1 pays its worst case, leg 2 shrinks, but not below the promised minimum", async () => {
  const { plan, q } = await referencePlan();
  const fit = await fitBuyToBalance(fitArgs(plan, q, 100_000, 986_042));
  assert.ok(fit.ok);
  assert.equal(fit.resized, true);
  assert.ok(fit.qty >= plan.minOutQty && fit.qty < plan.expectedOutQty);
  assert.equal(fit.qty, Math.floor(986_042 / 61), "the margin is no longer needed once the QU is in the wallet");
  assert.ok(fit.maxOutlayQu <= 986_042);
  assert.ok(fit.quotesUsed <= MAX_QUOTES_PER_SEARCH);
});

test("a leg 1 outcome worse than its worst case is refused, not overspent", async () => {
  const { plan, q } = await referencePlan();
  const needForMin = plan.minOutQty * 61;
  const fit = await fitBuyToBalance(fitArgs(plan, q, 100_000, needForMin - 1)); // 1 QU short of the minimum's limit
  assert.equal(fit.ok, false);
  assert.match(fit.ok ? "" : fit.reason, /promised minimum of 16,148 BBB now needs up to 985,028 QU/);
});

test("leg 2 spends only what the sale brought in, and never more than the wallet holds", async () => {
  const { plan, q } = await referencePlan();
  // The sale paid 996,003 QU, but 600,000 QU left the wallet for something else meanwhile. The wallet still has
  // 896,003 QU, but only 396,003 of it counts as the sale's: the rest is the user's own QU and is not touched.
  const spent = await fitBuyToBalance(fitArgs(plan, q, 600_000, 600_000 - 100_000 + 996_003 - 600_000));
  assert.equal(spent.budgetQu, 396_003);
  assert.equal(spent.ok, false, "396,003 QU cannot buy the promised 16,148 BBB");
  // The wallet held less than the planned fees (a fee was refunded, say): the balance is the limit, not the count.
  const short = await fitBuyToBalance(fitArgs(plan, q, 50_000, 50_000 + 996_003));
  assert.equal(short.receivedQu, 996_003 + 100_000);
  assert.equal(short.budgetQu, 1_046_003);
  assert.ok(short.ok && short.maxOutlayQu <= 1_046_003);
});

test("leg 2 is not prepared when the sale does not show in the wallet yet, or the wallet read is unusable", async () => {
  const { plan, q } = await referencePlan();
  const stale = await fitBuyToBalance(fitArgs(plan, q, 1_000_000, 1_000_000, 0));
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? "" : stale.reason, /has not sold anything/);
  // Holdings updated but the balance read is still from before the sale: it looks like only the fee came "back".
  const lagging = await fitBuyToBalance(fitArgs(plan, q, 1_000_000, 1_000_000));
  assert.equal(lagging.ok, false);
  assert.equal(lagging.budgetQu, 100_000);
  const nan = await fitBuyToBalance(fitArgs(plan, q, NaN, 5));
  assert.equal(nan.ok, false);
  assert.match(nan.ok ? "" : nan.reason, /could not be read/);
  assert.equal(q.calls >= 0, true);
});

test("leg 2 is refused when a fresh price cannot be had, or when it would merge into the wallet's own resting bid", async () => {
  const { plan, q } = await referencePlan();
  const failing: QuoteFn = async () => {
    throw new Error("API 503");
  };
  const down = await fitBuyToBalance(fitArgs(plan, failing, 100_000, 1_000_000));
  assert.equal(down.ok, false);
  assert.match(down.ok ? "" : down.reason, /Could not get a fresh price for BBB: API 503/);
  const clash = await fitBuyToBalance({ ...fitArgs(plan, q, 250_000, 1_146_003), openOrders: [{ side: "bid", price: 61, qty: 3 }] });
  assert.equal(clash.ok, false);
  assert.match(clash.ok ? "" : clash.reason, /already have a QX buy order for BBB at 61 QU/);
});

test("leg 2 is never made larger than reviewed, even when leg 1 paid more", async () => {
  const { plan, q } = await referencePlan();
  const fit = await fitBuyToBalance(fitArgs(plan, q, 0, 5_000_000));
  assert.ok(fit.ok);
  assert.equal(fit.qty, plan.expectedOutQty);
});

// ------------------------------------------------------------------------------------------------------------
// HTTP

test("POST /v1/swap-quote plans the swap, echoes the inputs, and answers 400 and 404 for bad requests", async () => {
  const markets = { AAA: { qswap: pool(1_000_000_000, 10_000_000) }, BBB: { qx: qx([], [{ price: 50, qty: 1000 }, { price: 60, qty: 100_000 }]) } };
  const data: MarketData = { assets: () => [], venues: async () => null };
  const server = createApi({ data, routes: swapRoutes({ quote: quoteFnOf(markets) }), freePerMin: 100 });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown) => {
    const r = await fetch(base + "/v1/swap-quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, j: (await r.json()) as Record<string, any> };
  };
  try {
    const ok = await post({ from: "AAA", to: "BBB", qty: "10,000" });
    assert.equal(ok.status, 200);
    assert.equal(ok.j.from, "AAA");
    assert.equal(ok.j.to, "BBB");
    assert.equal(ok.j.qty, 10_000);
    assert.equal(ok.j.slippageBps, 100);
    assert.equal(ok.j.minOutQty, 16_148);
    assert.equal(ok.j.upfrontIncludesShareMoves, false);
    assert.equal((await post({ from: "AAA", qty: 5 })).status, 400);
    assert.equal((await post({ from: "AAA", to: "AAA", qty: 5 })).status, 400);
    assert.equal((await post({ from: "AAA", to: "QU", qty: 5 })).status, 400);
    assert.equal((await post({ from: "AAA", to: "BBB", qty: 0 })).status, 400);
    assert.equal((await post({ from: "AAA", to: "BBB", qty: 5, slippageBps: -1 })).status, 400);
    const unknown = await post({ from: "AAA", to: "ZZZ", qty: 5 });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.j.error, "Unknown asset 'ZZZ'");
    const doc = await (await fetch(base + "/v1/openapi.json")).json();
    assert.ok(doc.paths["/v1/swap-quote"].post.summary);
  } finally {
    server.close();
  }
});

test("parseSwapBody reads numbers given as text and refuses everything else", () => {
  assert.deepEqual(parseSwapBody({ from: " cfb ", to: "QDOGE", qty: "1,000", slippageBps: 50 }), { from: "cfb", to: "QDOGE", qty: 1000, slippageBps: 50, compare: false });
  assert.equal(parseSwapBody({ from: "A", to: "B", qty: 1, compare: true }).compare, true);
  assert.equal(parseSwapBody({ from: "A", to: "B", qty: 1, compare: "yes" }).compare, false, "only a real true turns it on");
  for (const bad of [null, [], "x", { to: "B", qty: 1 }, { from: "A", to: "B", qty: -1 }, { from: "A", to: "B", qty: 1e13 }, { from: "A", to: "B", qty: 1, slippageBps: "lots" }]) {
    assert.throws(() => parseSwapBody(bad), (e: unknown) => e instanceof RouteError && e.status === 400);
  }
});

// ------------------------------------------------------------------------------------------------------------
// Property tests: random markets through the real router and venue models

/** Small seeded PRNG (mulberry32), so a failure can be reproduced from its case number. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const logInt = (lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Math.exp(Math.log(lo) + next() * (Math.log(hi) - Math.log(lo))))));
  return { next, int, logInt };
}

/** A random market: QX only, QSwap only, or both, with prices from 1 to 5,000 QU and depth from a handful to millions. */
function randomMarket(r: ReturnType<typeof rng>): Market {
  const mix = r.int(0, 2);
  const price = r.logInt(1, 5000);
  const m: Market = {};
  if (mix !== 1) {
    const bids: BookLevel[] = [];
    const asks: BookLevel[] = [];
    let b = price;
    let a = price + r.int(1, Math.max(1, Math.ceil(price * 0.05)));
    for (let i = r.int(1, 8); i > 0; i--) {
      bids.push({ price: b, qty: r.logInt(1, 2_000_000) });
      asks.push({ price: a, qty: r.logInt(1, 2_000_000) });
      b = Math.max(1, b - r.int(0, Math.max(1, Math.ceil(b * 0.05))));
      a += r.int(0, Math.max(1, Math.ceil(a * 0.05)));
    }
    m.qx = qx(bids, asks);
  }
  if (mix !== 0) {
    const reserveAsset = r.logInt(1_000, 1_000_000_000);
    const unit = Math.exp(Math.log(0.01) + r.next() * (Math.log(5000) - Math.log(0.01)));
    m.qswap = pool(Math.max(1_000_000, Math.round(reserveAsset * unit)), reserveAsset);
  }
  return m;
}

const sellDepth = (m: Market) => (m.qx ? m.qx.bids.reduce((s, l) => s + l.qty, 0) : 0) + (m.qswap ? Math.floor(m.qswap.reserveAsset * 0.5) : 0);

/** Every number in the plan, found by walking it. */
function numbersIn(x: unknown, path = "plan", out: [string, number][] = []): [string, number][] {
  if (typeof x === "number") out.push([path, x]);
  else if (Array.isArray(x)) x.forEach((v, i) => numbersIn(v, `${path}[${i}]`, out));
  else if (x && typeof x === "object" && !(x instanceof Uint8Array)) for (const [k, v] of Object.entries(x)) numbersIn(v, `${path}.${k}`, out);
  return out;
}

/**
 * What a QX ask really pays under Qx.h's rules: it matches resting bids at or above its limit, best first, at the
 * BID's price, and each match pays value - (floor(value x rate) + 1). Unmatched shares would stay on the book.
 */
function qxAskFill(bids: BookLevel[], limit: number, qty: number, rate: number) {
  let left = qty;
  let quIn = 0;
  let matches = 0;
  for (const b of [...bids].filter((x) => x.price >= limit).sort((x, y) => y.price - x.price)) {
    if (left <= 0) break;
    const n = Math.min(left, b.qty);
    const v = b.price * n;
    quIn += v - (Math.floor(v * rate) + 1);
    left -= n;
    matches++;
  }
  return { filled: qty - left, quIn, matches };
}

const CASES = 300;

test(`property: across ${CASES} random markets, the plan's QU never runs out at any step and every amount is a whole, finite number`, async () => {
  let executable = 0;
  let resized = 0;
  let refused = 0;
  for (let c = 0; c < CASES; c++) {
    const r = rng(1000 + c);
    const markets = { AAA: randomMarket(r), BBB: randomMarket(r) };
    const depth = sellDepth(markets.AAA);
    if (depth < 1) continue;
    const qty = r.logInt(1, Math.max(1, Math.floor(depth * 0.8)));
    const slippageBps = r.int(0, 1000);
    // Random holdings that cover the sale, spread over QX and QSwap so share moves happen sometimes.
    const onQx = r.int(0, qty + r.int(0, 10));
    const holdings: Holdings = { 1: onQx, 13: Math.max(0, qty - onQx) + r.int(0, 5) };
    // The market does not move within a case, so quotes can be remembered (the same answer each time).
    const base = quoteFnOf(markets);
    const memo = new Map<string, Promise<SwapQuote>>();
    const q: QuoteFn = (side, asset, n, s) => {
      const k = `${side}|${asset}|${n}|${s}`;
      if (!memo.has(k)) memo.set(k, base(side, asset, n, s));
      return memo.get(k)!;
    };
    const plan = await planSwap(q, { from: "AAA", to: "BBB", qty, slippageBps, holdings });
    const where = `case ${c} (qty ${qty}, slippage ${slippageBps} bps)`;

    for (const [path, v] of numbersIn({ ...plan, sell: null, buy: null, buyAtWorst: null })) assert.ok(Number.isFinite(v), `${where}: ${path} is ${v}`);
    for (const k of ["expectedOutQty", "minOutQty", "expectedProceedsQu", "worstProceedsQu", "safetyMarginQu", "upfrontQu", "buyMaxOutlayQu", "maxTotalOutlayQu", "expectedLeftoverQu", "quotesUsed"] as const)
      assert.ok(Number.isSafeInteger(plan[k]) && plan[k] >= 0, `${where}: ${k} = ${plan[k]}`);
    assert.ok(plan.quotesUsed <= 1 + 2 * MAX_QUOTES_PER_SEARCH, `${where}: ${plan.quotesUsed} quotes`);
    if (!plan.executable || !plan.sell) continue;
    executable++;
    const sell = plan.sell;
    const buy = plan.buy!;
    const buyAtWorst = plan.buyAtWorst!;

    // Leg 2 fits leg 1's worst case; the expected-case leg 2 fits the expected proceeds.
    const worstOutlay = buildExecutionPlan(buyAtWorst as never).maxOutlayQu;
    assert.ok(worstOutlay <= plan.worstProceedsQu - plan.safetyMarginQu, `${where}: leg 2 at worst ${worstOutlay} > ${plan.worstProceedsQu} - margin`);
    assert.ok(worstOutlay <= plan.worstProceedsQu);
    assert.ok(plan.buyMaxOutlayQu <= plan.expectedProceedsQu - plan.safetyMarginQu, `${where}: expected leg 2 ${plan.buyMaxOutlayQu}`);
    assert.equal(buyAtWorst.qty, plan.minOutQty);
    assert.equal(buy.qty, plan.expectedOutQty);
    assert.ok(plan.minOutQty >= 1 && plan.minOutQty <= plan.expectedOutQty, `${where}: min ${plan.minOutQty} expected ${plan.expectedOutQty}`);
    assert.ok(plan.worstProceedsQu <= plan.expectedProceedsQu, `${where}: worst above expected`);
    assert.equal(plan.maxTotalOutlayQu, plan.upfrontQu + plan.buyMaxOutlayQu);
    assert.equal(plan.safetyMarginQu, safetyMarginQu(plan.worstProceedsQu));

    // upfrontQu is exactly what the sale's steps attach: 100,000 per QSwap sell call plus the fee of each share move.
    const steps = planSwapSteps(sell, buy, holdings);
    assert.equal(plan.upfrontQu, stepsSum(steps.sell.steps), `${where}: upfront`);
    const need = { 1: 0, 13: 0 } as Record<number, number>;
    for (const l of sell.route) need[l.venue === "QX" ? 1 : 13] += l.qty;
    const moves = (need[1] > holdings[1] ? FEES.qx : 0) + (need[13] > holdings[13] ? FEES.qswap : 0);
    assert.equal(plan.upfrontQu, sell.route.filter((l) => l.venue === "QSwap").length * QSWAP_OPERATION_FEE_QU + moves, `${where}: upfront by hand`);
    assert.equal(steps.buy.maxOutlayQu, plan.buyMaxOutlayQu);

    // worstProceedsQu never exceeds what the sale returns in the venue model's worst case, nor under Qx.h's matching.
    for (const leg of sell.route) {
      const h = leg.execution!;
      const worst = worstLegProceedsQu(leg);
      if (h.type === "qswap-sell") {
        assert.equal(worst, h.minQuOut); // the contract refuses anything below this
        assert.ok(new QswapVenue(markets.AAA.qswap!).variableNetQu("sell", leg.qty) >= h.minQuOut, `${where}: the pool pays less than the minimum`);
        continue;
      }
      if (h.type !== "qx-ask") assert.fail("sell leg");
      const k = leg.depth!.levelsUsed;
      const split: BookLevel[] = Array.from({ length: k }, (_, i) => ({ price: h.limitPrice, qty: Math.floor(h.qty / k) + (i < h.qty % k ? 1 : 0) })).filter((l) => l.qty > 0);
      for (const bids of [[{ price: h.limitPrice, qty: h.qty }], split]) {
        const model = new QxVenue(qx(bids)).quote("sell", h.qty)!;
        assert.ok(model.netQu >= worst, `${where}: model worst ${model.netQu} < ${worst}`);
      }
      // A different book at execution time: bids at or above the limit, possibly more of them than the quote matched.
      for (let t = 0; t < 3; t++) {
        const book = Array.from({ length: r.int(1, k + 40) }, () => ({ price: h.limitPrice + r.int(0, 3), qty: r.logInt(1, Math.max(1, h.qty)) }));
        const fill = qxAskFill(book, h.limitPrice, h.qty, 0.003);
        if (fill.filled === h.qty) assert.ok(fill.quIn >= worst - Math.max(0, fill.matches - k), `${where}: Qx.h fill ${fill.quIn} below worst ${worst} with ${fill.matches} matches`);
      }
    }

    // Leg 1 settles with random proceeds (from nothing to more than expected), then leg 2 is fitted to the wallet.
    const minOutlay = worstOutlay;
    const expectedOutlay = plan.buyMaxOutlayQu;
    for (const proceeds of [plan.expectedProceedsQu, plan.worstProceedsQu, r.int(0, Math.max(0, minOutlay - 1)), r.int(0, Math.ceil(plan.expectedProceedsQu * 1.2))]) {
      const before = plan.upfrontQu + r.int(0, 3) * r.logInt(1, 1_000_000);
      const otherSpending = r.next() < 0.25 ? r.int(0, before + proceeds - plan.upfrontQu) : 0;
      const now = before - plan.upfrontQu + proceeds - otherSpending;
      const fit = await fitBuyToBalance({ plan, balanceBeforeQu: before, balanceNowQu: now, soldQty: qty, quoteFn: q });
      const budget = Math.min(now, now - before + plan.upfrontQu);
      assert.equal(fit.budgetQu, Math.max(0, budget), `${where}: budget`);
      if (fit.ok) {
        assert.ok(fit.maxOutlayQu <= now, `${where}: leg 2 attaches ${fit.maxOutlayQu} with ${now} QU in the wallet`);
        assert.ok(now - fit.maxOutlayQu >= before - plan.upfrontQu, `${where}: leg 2 dips into the wallet's own QU`);
        assert.ok(fit.qty >= plan.minOutQty && fit.qty <= plan.expectedOutQty, `${where}: fitted ${fit.qty}`);
        assert.equal(fit.maxOutlayQu, stepsSum(fit.steps));
        if (fit.resized) resized++;
      } else refused++;
      // Same market as at review: it can go ahead exactly when the promised minimum still fits.
      assert.equal(fit.ok, budget >= minOutlay, `${where}: proceeds ${proceeds}, budget ${budget}, minimum needs ${minOutlay}: ${fit.ok ? "" : fit.reason}`);
      if (fit.ok && budget >= expectedOutlay) assert.equal(fit.qty, plan.expectedOutQty, `${where}: should not shrink`);
    }
  }
  // The generator must actually exercise the interesting paths.
  assert.ok(executable >= CASES / 3, `only ${executable} executable cases`);
  assert.ok(resized > 10 && refused > 10, `resized ${resized}, refused ${refused}`);
});

// ------------------------------------------------------------------------------------------------------------
// A simulator of the contracts, so whole swaps can be run end to end: the steps the planner returns are executed
// under Qx.h's and Qswap.h's own rules (read from the sources, not from the venue models), with the markets moving
// between the steps. The router and venue models only ever see the simulated state through `buildQuote`.

const I64_MAX = 9223372036854775807n;
const QX_FEE_BILLIONTHS = 3_000_000n;
const SIM_FEES = { qx: 100, qswap: 100 };

/** Qx.h, per match: value x tradeFee / 1e9 rounded down, plus 1 QU; from INT64_MAX / tradeFee up it divides by floor(1e9 / tradeFee) = 333. */
function qxMatchFee(value: number): number {
  const v = BigInt(value);
  return Number(v >= I64_MAX / QX_FEE_BILLIONTHS ? v / (1_000_000_000n / QX_FEE_BILLIONTHS) + 1n : (v * QX_FEE_BILLIONTHS) / 1_000_000_000n + 1n);
}
/** Qswap.h's protocol share of a swap fee (27% + 5% + 3% + 1%, each rounded down); a zero fee counts as 100. */
function qswapProtocolFee(base: bigint): bigint {
  let fee = (base * 30n) / 10_000n;
  if (fee === 0n) fee = 100n;
  return (fee * 27n) / 100n + (fee * 5n) / 100n + (fee * 3n) / 100n + fee / 100n;
}

interface SimOrder { entity: string; price: number; qty: number }
interface SimMarket { issuer: string; asks: SimOrder[]; bids: SimOrder[]; pool?: { qu: bigint; asset: bigint } }
const ME = "ME";

class SimChain {
  markets: Record<string, SimMarket>;
  qu: number;
  shares: Record<string, Record<number, number>> = {};
  /** QU a contract kept and gave nothing for (Qswap.h refunds only quAmountIn when it is below the protocol fee). */
  lostQu = 0;
  /** Steps sent with more QU attached than the wallet had. */
  unpaid: string[] = [];
  /** QX matches the wallet's orders made, per asset. */
  matches: Record<string, number> = {};
  constructor(markets: Record<string, SimMarket>, qu: number) {
    this.markets = markets;
    this.qu = qu;
  }
  held(asset: string) {
    return (this.shares[asset] ??= { 1: 0, 13: 0 });
  }
  /** Shares the wallet already offers in its own resting asks (Qx.h's _NumberOfReservedShares). */
  reserved(asset: string) {
    return this.markets[asset].asks.filter((o) => o.entity === ME).reduce((s, o) => s + o.qty, 0);
  }
  clone(qu = this.qu) {
    const c = new SimChain(structuredClone(this.markets), qu);
    c.shares = structuredClone(this.shares);
    return c;
  }
  /** Prices as Qx.h orders them: best first, first come first served at the same price. */
  rest(asset: string, side: "asks" | "bids", o: SimOrder) {
    const book = this.markets[asset][side];
    const at = book.findIndex((x) => (side === "asks" ? x.price > o.price : x.price < o.price));
    book.splice(at < 0 ? book.length : at, 0, o);
  }
  data(): MarketData {
    const markets = this.markets;
    return {
      assets: () => Object.keys(markets),
      venues: async (a) => {
        const m = markets[a.toUpperCase()];
        if (!m) return null;
        const out: (QxVenue | QswapVenue)[] = [];
        const levels = (os: SimOrder[]) => os.filter((o) => o.qty > 0).map((o) => ({ price: o.price, qty: o.qty }));
        if (m.asks.length || m.bids.length) out.push(new QxVenue({ asks: levels(m.asks), bids: levels(m.bids), buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 100 }));
        if (m.pool && m.pool.qu > 0n && m.pool.asset > 0n) out.push(new QswapVenue({ reserveQu: Number(m.pool.qu), reserveAsset: Number(m.pool.asset), swapFeeRate: 30, fixedCostQu: QSWAP_OPERATION_FEE_QU + 100 }));
        return out;
      },
      assetInfo: async (a) => {
        const m = markets[a.toUpperCase()];
        return m ? { symbol: a.toUpperCase(), issuer: m.issuer, assetName: a.toUpperCase(), transferFeeQu: SIM_FEES } : null;
      },
    };
  }
  /**
   * The planner quotes with the server's bypass (its size search probes tiny sizes and applies its own check). The browser's re-fit
   * of leg 2 (`fitBuyToBalance`) goes through the public /v1/quote, which refuses a tiny QSwap buy: `quoteFn(false)`.
   */
  quoteFn(planner = true): QuoteFn {
    const data = this.data();
    return (side, asset, qty, slippageBps) => buildQuote(data, { side, asset, qty, slippageBps }, planner ? { allowTinyQswapBuy: true } : {}) as Promise<SwapQuote>;
  }

  /** Executes one signed step the way the contract would. */
  exec(step: TxStep) {
    if (step.amountQu > this.qu) {
      this.unpaid.push(`${step.id}: attaches ${step.amountQu} with ${this.qu} QU in the wallet`);
      return;
    }
    this.qu -= step.amountQu;
    const v = new DataView(step.payload.buffer, step.payload.byteOffset, step.payload.byteLength);
    const asset = assetNameFromU64(v.getBigUint64(32, true));
    const m = this.markets[asset];
    const mine = this.held(asset);
    const i64 = (off: number) => Number(v.getBigInt64(off, true));
    const from = "contractIndex" in step.to ? step.to.contractIndex : 0;
    switch (step.kind) {
      case "transfer-rights": {
        const n = i64(40);
        if (from === QX_INDEX) {
          // Qx.h: "no fee", the reward is refunded; QSwap's PRE_ACQUIRE_SHARES asks for nothing.
          this.qu += step.amountQu;
          if (mine[1] - this.reserved(asset) >= n) (mine[1] -= n), (mine[13] += n);
        } else if (mine[13] >= n && step.amountQu >= SIM_FEES.qx) {
          // Qswap.h offers the whole reward; QX's PRE_ACQUIRE_SHARES takes its transfer fee; the rest is refunded.
          mine[13] -= n;
          mine[1] += n;
          this.qu += step.amountQu - SIM_FEES.qx;
        } else this.qu += step.amountQu;
        return;
      }
      case "qx-ask": {
        this.qu += step.amountQu; // AddToAskOrder refunds any reward
        const price = i64(40);
        let left = i64(48);
        if (mine[1] - this.reserved(asset) < left) return;
        if (m.asks.some((o) => o.entity === ME && o.price === price)) {
          m.asks.find((o) => o.entity === ME && o.price === price)!.qty += left; // merged, not matched
          return;
        }
        while (left > 0 && m.bids.length && m.bids[0].price >= price) {
          const b = m.bids[0];
          const n = Math.min(left, b.qty);
          const value = b.price * n;
          this.qu += value - qxMatchFee(value);
          mine[1] -= n;
          if (b.entity === ME) mine[1] += n; // matched its own bid: the shares come straight back
          this.matches[asset] = (this.matches[asset] ?? 0) + 1;
          b.qty -= n;
          left -= n;
          if (b.qty === 0) m.bids.shift();
        }
        if (left > 0) this.rest(asset, "asks", { entity: ME, price, qty: left });
        return;
      }
      case "qx-bid": {
        const price = i64(40);
        let left = i64(48);
        if (step.amountQu < price * left) return void (this.qu += step.amountQu);
        this.qu += step.amountQu - price * left;
        if (m.bids.some((o) => o.entity === ME && o.price === price)) {
          m.bids.find((o) => o.entity === ME && o.price === price)!.qty += left; // merged: the QU sits on the book
          return;
        }
        while (left > 0 && m.asks.length && m.asks[0].price <= price) {
          const a = m.asks[0];
          const n = Math.min(left, a.qty);
          mine[1] += n;
          this.qu += (price - a.price) * n; // the difference to the limit comes back
          if (a.entity === ME) (this.qu += a.price * n - qxMatchFee(a.price * n)), (mine[1] -= n);
          this.matches[asset] = (this.matches[asset] ?? 0) + 1;
          a.qty -= n;
          left -= n;
          if (a.qty === 0) m.asks.shift();
        }
        if (left > 0) this.rest(asset, "bids", { entity: ME, price, qty: left }); // its QU stays locked in it
        return;
      }
      case "qswap-sell": {
        if (step.amountQu < QSWAP_OPERATION_FEE_QU) return void (this.qu += step.amountQu);
        this.qu += step.amountQu - QSWAP_OPERATION_FEE_QU;
        const amountIn = BigInt(i64(40));
        const minOut = BigInt(i64(48));
        const p = m.pool;
        if (!p || amountIn <= 0n || BigInt(mine[13]) < amountIn) return void (this.qu += QSWAP_OPERATION_FEE_QU);
        const gross = (p.qu * amountIn) / (p.asset + amountIn);
        const out = (gross * 9970n) / 10_000n;
        if (out < minOut) return void (this.qu += QSWAP_OPERATION_FEE_QU); // refused: shares stay, the fee comes back
        const protocol = qswapProtocolFee(gross);
        mine[13] -= Number(amountIn);
        this.qu += Number(out);
        p.asset += amountIn;
        p.qu = p.qu < out + protocol ? 0n : p.qu - out - protocol;
        return;
      }
      case "qswap-buy": {
        const reward = BigInt(step.amountQu);
        const out = BigInt(i64(40));
        const p = m.pool;
        if (reward <= BigInt(QSWAP_OPERATION_FEE_QU) || out <= 0n || !p || out >= p.asset) return void (this.qu += step.amountQu);
        const quIn = (p.qu * out * 10_000n) / ((p.asset - out) * 9970n) + 1n;
        if (quIn > reward - BigInt(QSWAP_OPERATION_FEE_QU)) return void (this.qu += step.amountQu);
        const protocol = qswapProtocolFee(quIn);
        if (quIn < protocol) {
          // Qswap.h SwapQuForExactAsset: `if (quAmountIn < totalFee) { transfer(invocator, quAmountIn); return; }`
          this.qu += Number(quIn);
          this.lostQu += Number(reward - quIn);
          return;
        }
        mine[13] += Number(out);
        this.qu += Number(reward - quIn) - QSWAP_OPERATION_FEE_QU;
        p.qu += quIn - protocol;
        p.asset -= out;
        return;
      }
      default:
        throw new Error(`the simulator does not run ${step.kind}`);
    }
  }
  run(steps: TxStep[]) {
    for (const s of steps) this.exec(s);
  }
}

const simTotal = (h: Record<number, number> | undefined) => (h?.[1] ?? 0) + (h?.[13] ?? 0);

test("simulator: a QX sale and a pool sale pay what the venue models and the worst-case bounds say", async () => {
  const chain = new SimChain(
    {
      AAA: { issuer: ISSUERS[0], asks: [], bids: [{ entity: "MM", price: 100, qty: 600 }, { entity: "MM", price: 98, qty: 1000 }], pool: { qu: 1_000_000_000n, asset: 10_000_000n } },
    },
    0,
  );
  chain.shares.AAA = { 1: 1000, 13: 10_000 };
  chain.qu = 100_000;
  const qxOnly = new QxVenue(qx([{ price: 100, qty: 600 }, { price: 98, qty: 1000 }])).quote("sell", 1000)!;
  chain.run(buildExecutionPlan({ asset: "AAA", side: "sell", assetInfo: { issuer: ISSUERS[0], assetName: "AAA", transferFeeQu: SIM_FEES }, route: [{ venue: "QX", qty: 1000, execution: { type: "qx-ask", qty: 1000, limitPrice: 97 } }] }, { 1: 1000 }).steps);
  assert.equal(chain.qu - 100_000, qxOnly.netQu + qxOnly.fixedCostQu, "the model's gross less fees is what arrives");
  const before = chain.qu;
  chain.run(buildExecutionPlan({ asset: "AAA", side: "sell", assetInfo: { issuer: ISSUERS[0], assetName: "AAA", transferFeeQu: SIM_FEES }, route: [{ venue: "QSwap", qty: 10_000, execution: { type: "qswap-sell", qty: 10_000, minQuOut: 0 } }] }, { 13: 10_000 }).steps);
  assert.equal(chain.qu - before, 996_003 - QSWAP_OPERATION_FEE_QU, "the pool pays the modelled amount; the flat fee is kept");
  // A match of 3.1 trillion QU pays Qx.h's larger fee (value / 333), which the worst case must not undercut.
  const big = 40_000_000 * 80_000;
  assert.equal(qxMatchFee(big), Math.floor(big / 333) + 1);
  const leg: QuoteLeg = { venue: "QX", qty: 80_000, totalQu: big - (Math.floor(big * 0.003) + 1) - 100, feesQu: Math.floor(big * 0.003) + 1, fixedCostQu: 100, depth: { levelsUsed: 1, qtyAvailable: 80_000 }, execution: { type: "qx-ask", qty: 80_000, limitPrice: 40_000_000 } };
  assert.ok(worstLegProceedsQu(leg) <= big - qxMatchFee(big), `worst ${worstLegProceedsQu(leg)} vs Qx.h ${big - qxMatchFee(big)}`);
});

test("a swap is never planned into a QSwap buy so small that Qswap.h keeps the 100,000 QU fee and delivers nothing", async () => {
  // AAA sells into a pool for a little over 101,000 QU; BBB trades only in a pool at about 1 QU each. Qswap.h's
  // SwapQuForExactAsset refunds only quAmountIn (and keeps the rest of the reward) when quAmountIn is below its
  // protocol fee, 36 QU. Before the fix the planner chose 2 BBB for 3 QU, and the wallet lost 100,000 QU.
  const markets = (): Record<string, SimMarket> => ({
    AAA: { issuer: ISSUERS[0], asks: [], bids: [], pool: { qu: 100_000_000n, asset: 10_000_000n } },
    BBB: { issuer: ISSUERS[1], asks: [], bids: [], pool: { qu: 1_000_000_000n, asset: 1_000_000_000n } },
  });
  let refusedTooSmall = 0;
  for (let qty = 10_138; qty <= 10_160; qty++) {
    const chain = new SimChain(markets(), 100_000);
    chain.shares.AAA = { 1: 0, 13: qty };
    const plan = await planSwap(chain.quoteFn(), { from: "AAA", to: "BBB", qty, slippageBps: 0, holdings: { 1: 0, 13: qty } });
    if (!plan.executable) {
      if (plan.worstProceedsQu > 101_000) assert.match(plan.warnings.join(" "), /too small/, `qty ${qty}: says why`), refusedTooSmall++;
      continue;
    }
    for (const l of plan.buyAtWorst!.route) if (l.execution?.type === "qswap-buy") assert.ok(l.totalQu - l.fixedCostQu >= 1_000, `qty ${qty}: QSwap buy of ${l.totalQu - l.fixedCostQu} QU`);
    // Run it as the web app does: leg 1, then leg 2 fitted to the wallet.
    const steps = planSwapSteps(plan.sell!, plan.buy!, { 1: 0, 13: qty });
    const base = chain.qu;
    chain.run(steps.sell.steps);
    const fit = await fitBuyToBalance({ plan: { ...plan, upfrontQu: steps.sell.maxOutlayQu }, balanceBeforeQu: base, balanceNowQu: chain.qu, soldQty: qty - simTotal(chain.shares.AAA), quoteFn: chain.quoteFn(false) });
    if (fit.ok) chain.run(fit.steps);
    assert.equal(chain.lostQu, 0, `qty ${qty}: ${chain.lostQu} QU kept by QSwap for nothing`);
  }
  assert.ok(refusedTooSmall > 0, "the window where it would happen was reached");

  // At review the smallest buy is safe, but BBB's pool price collapses before step 2: the same size would now cost
  // less than 36 QU. The second trade is refused rather than sent.
  const chain = new SimChain(markets(), 100_000);
  chain.shares.AAA = { 1: 0, 13: 20_000 };
  const plan = await planSwap(chain.quoteFn(), { from: "AAA", to: "BBB", qty: 10_400, slippageBps: 0, holdings: { 1: 0, 13: 20_000 } });
  assert.equal(plan.executable, true, plan.warnings.join("; "));
  const steps = planSwapSteps(plan.sell!, plan.buy!, { 1: 0, 13: 20_000 });
  const base = chain.qu;
  chain.run(steps.sell.steps);
  chain.markets.BBB.pool = { qu: 1_000_000_000n, asset: 200_000_000_000n }; // 200 times cheaper
  const fit = await fitBuyToBalance({ plan: { ...plan, upfrontQu: steps.sell.maxOutlayQu }, balanceBeforeQu: base, balanceNowQu: chain.qu, soldQty: 10_400, quoteFn: chain.quoteFn(false) });
  if (fit.ok) chain.run(fit.steps);
  assert.equal(chain.lostQu, 0, `${chain.lostQu} QU kept by QSwap for nothing`);
  assert.equal(fit.ok, false);
  assert.match(fit.ok ? "" : fit.reason, /too small to buy on QSwap/);
});

/** A random simulated market: QX orders from several makers, a pool, or both. */
function simMarket(r: ReturnType<typeof rng>, issuer: string): SimMarket {
  const mix = r.int(0, 2);
  const price = r.logInt(1, 40_000_000);
  const m: SimMarket = { issuer, asks: [], bids: [] };
  if (mix !== 1) {
    let b = price;
    let a = price + r.int(1, Math.max(1, Math.ceil(price * 0.05)));
    for (let i = r.int(1, 8); i > 0; i--) {
      m.bids.push({ entity: "MM", price: b, qty: r.logInt(1, Math.max(1, Math.floor(2e12 / b))) });
      m.asks.push({ entity: "MM", price: a, qty: r.logInt(1, Math.max(1, Math.floor(2e12 / a))) });
      b = Math.max(1, b - r.int(0, Math.max(1, Math.ceil(b * 0.05))));
      a += r.int(0, Math.max(1, Math.ceil(a * 0.05)));
    }
  }
  if (mix !== 0) {
    const asset = r.logInt(1_000, 1_000_000_000);
    const unit = Math.exp(Math.log(0.01) + r.next() * (Math.log(40_000) - Math.log(0.01)));
    m.pool = { qu: BigInt(Math.max(1_000_000, Math.round(asset * unit))), asset: BigInt(asset) };
  }
  return m;
}

/** Moves a market's prices by `factor` (bids, asks and the pool together), as other traders would. */
function movePrices(m: SimMarket, factor: number) {
  for (const o of [...m.asks, ...m.bids]) if (o.entity !== ME) o.price = Math.max(1, Math.round(o.price * factor));
  m.asks.sort((x, y) => x.price - y.price);
  m.bids.sort((x, y) => y.price - x.price);
  if (m.pool) m.pool.qu = BigInt(Math.max(1, Math.round(Number(m.pool.qu) * factor)));
}

const E2E_CASES = 400;

test(`end to end over the contract simulator (${E2E_CASES} random swaps, markets moving between the steps): leg 2 never attaches QU the wallet lacks, no QU is lost to a contract, and the minimum holds while prices stay inside the limits`, async () => {
  const seen = { executable: 0, leg2: 0, refused: 0, guaranteeChecked: 0, viaReviewedLimits: 0 };
  for (let c = 0; c < E2E_CASES; c++) {
    const r = rng(77_000 + c);
    const chain = new SimChain({ AAA: simMarket(r, ISSUERS[0]), BBB: simMarket(r, ISSUERS[1]) }, 0);
    const a = chain.markets.AAA;
    const depth = a.bids.reduce((s, o) => s + o.qty, 0) + (a.pool ? Number(a.pool.asset / 2n) : 0);
    if (depth < 1) continue;
    const qty = r.logInt(1, Math.max(1, Math.floor(depth * 0.8)));
    const slippageBps = [0, 10, 50, 100, 300, 1000][r.int(0, 5)];
    const onQx = r.int(0, qty);
    const holdings = { 1: onQx, 13: qty - onQx + r.int(0, 3) };
    chain.shares.AAA = { ...holdings };
    const where = `case ${c} (qty ${qty}, slippage ${slippageBps} bps)`;

    const plan = await planSwap(chain.quoteFn(), { from: "AAA", to: "BBB", qty, slippageBps, holdings });
    if (!plan.executable) continue;
    seen.executable++;
    const steps = planSwapSteps(plan.sell!, plan.buy!, holdings);
    chain.qu = steps.sell.maxOutlayQu + (r.next() < 0.5 ? 0 : r.logInt(1, 10_000_000)); // the review checks this much is there
    const s = slippageBps / 10_000;

    // Between review and leg 1, AAA moves: anywhere from its limit (the worst case) to better; sometimes past it.
    const pastA = r.next() < 0.15;
    movePrices(a, pastA ? 1 - s - 0.02 - r.next() * 0.1 : 1 - s * r.next() * (r.next() < 0.4 ? 1 : 0.5) + (r.next() < 0.3 ? r.next() * 0.02 : 0));
    const base = chain.qu;
    chain.run(steps.sell.steps);
    assert.deepEqual(chain.unpaid, [], `${where}: leg 1 attached QU the wallet did not have`);
    const soldQty = simTotal(holdings) - simTotal(chain.shares.AAA);
    const received = chain.qu - base + steps.sell.maxOutlayQu;
    // Within its limits and without a fragmented book, the sale pays at least its worst case less the margin.
    const extraMatches = (chain.matches.AAA ?? 0) - plan.sell!.route.reduce((n, l) => n + (l.depth?.levelsUsed ?? 0), 0);
    if (soldQty === qty && extraMatches <= 0) assert.ok(received >= plan.worstProceedsQu - plan.safetyMarginQu, `${where}: sale paid ${received}, worst ${plan.worstProceedsQu}`);

    // Other wallet activity while leg 1 settles: QU coming in (dividends) or going out (another app).
    const activity = r.next();
    const outgoing = activity < 0.1 ? r.int(0, chain.qu) : 0;
    if (activity >= 0.9) chain.qu += r.logInt(1, 1_000_000);
    chain.qu -= outgoing;

    // BBB moves before leg 2 is prepared: within the slippage limit (up or down), or past it.
    const pastB = r.next() < 0.15;
    const bFactor = pastB ? 1 + s + 0.02 + r.next() * 0.1 : 1 + (r.next() < 0.5 ? s * r.next() : -0.05 * r.next());
    movePrices(chain.markets.BBB, bFactor);
    // Would the reviewed minimum (its signed limits) still fill completely on BBB as it is now?
    const probe = chain.clone(Number.MAX_SAFE_INTEGER);
    const bBefore = simTotal(probe.shares.BBB);
    probe.run(buildExecutionPlan(plan.buyAtWorst as Parameters<typeof buildExecutionPlan>[0]).steps);
    const reviewedMinFills = simTotal(probe.shares.BBB) - bBefore === plan.minOutQty && probe.lostQu === 0;

    const now = chain.qu;
    const fit = await fitBuyToBalance({ plan: { ...plan, upfrontQu: steps.sell.maxOutlayQu }, balanceBeforeQu: base, balanceNowQu: now, soldQty, quoteFn: chain.quoteFn(false), openOrders: chain.markets.BBB.bids.filter((o) => o.entity === ME).map((o) => ({ side: "bid" as const, price: o.price, qty: o.qty })) });
    const bHeld = simTotal(chain.shares.BBB);
    if (fit.ok) {
      seen.leg2++;
      assert.ok(fit.maxOutlayQu <= now, `${where}: leg 2 attaches ${fit.maxOutlayQu} with ${now} QU in the wallet`);
      assert.ok(fit.maxOutlayQu <= now - base + steps.sell.maxOutlayQu, `${where}: leg 2 attaches more than the wallet's QU grew by, plus the fees leg 1 attached`);
      if (fit.quote === plan.buyAtWorst) seen.viaReviewedLimits++;
      chain.run(fit.steps);
      assert.deepEqual(chain.unpaid, [], `${where}: leg 2 attached QU the wallet did not have`);
    } else seen.refused++;
    assert.equal(chain.lostQu, 0, `${where}: ${chain.lostQu} QU kept by a contract for nothing`);

    // The promise: the whole sale went through within its limits (no fragmented book), nothing else left the wallet,
    // and BBB is still where the reviewed minimum's limits fill. Then leg 2 is sent and delivers the minimum.
    if (soldQty === qty && received >= plan.worstProceedsQu - plan.safetyMarginQu && outgoing === 0 && reviewedMinFills) {
      seen.guaranteeChecked++;
      assert.ok(fit.ok, `${where}: BBB moved x${bFactor.toFixed(4)} (inside the ${slippageBps} bps limit) and the sale paid ${received} (worst ${plan.worstProceedsQu}), yet: ${fit.ok ? "" : fit.reason}`);
      assert.ok(simTotal(chain.shares.BBB) - bHeld >= plan.minOutQty, `${where}: got ${simTotal(chain.shares.BBB) - bHeld} BBB, promised at least ${plan.minOutQty}`);
    }
  }
  // The generator must reach every path, the reviewed-limits one included (it is what keeps the promise when BBB moved).
  assert.ok(seen.executable > E2E_CASES / 4 && seen.leg2 > 50 && seen.refused > 10 && seen.guaranteeChecked > 50 && seen.viaReviewedLimits > 0, JSON.stringify(seen));
});

test("when BBB's price moved inside the limit and the sale paid its worst case, the minimum is still bought, with its reviewed limits", async () => {
  // BBB asks at 6,000 QU: the reviewed limit is ceil(6,000 x 1.01) = 6,060. Before step 2 they move to 6,030 (+0.5%,
  // inside the 1% limit). A fresh quote would sign ceil(6,030 x 1.01) = 6,091, which the worst-case proceeds cannot
  // pay for the minimum; the reviewed 6,060 still fills against asks at 6,030, so that is what is signed.
  const chain = new SimChain(
    {
      AAA: { issuer: ISSUERS[0], asks: [], bids: [], pool: { qu: 1_000_000_000_000n, asset: 10_000_000n } },
      BBB: { issuer: ISSUERS[1], asks: [{ entity: "MM", price: 6_000, qty: 10_000_000 }], bids: [] },
    },
    100_000,
  );
  chain.shares.AAA = { 13: 1_000 };
  const plan = await planSwap(chain.quoteFn(), { from: "AAA", to: "BBB", qty: 1_000, slippageBps: 100, holdings: { 13: 1_000 } });
  assert.equal(plan.executable, true, plan.warnings.join("; "));
  assert.deepEqual(plan.buyAtWorst!.route[0].execution, { type: "qx-bid", qty: plan.minOutQty, limitPrice: 6_060 });
  const steps = planSwapSteps(plan.sell!, plan.buy!, { 13: 1_000 });
  movePrices(chain.markets.AAA, 0.99); // the sale lands at about its limit
  const base = chain.qu;
  chain.run(steps.sell.steps);
  const received = chain.qu - base + steps.sell.maxOutlayQu;
  assert.ok(received >= plan.worstProceedsQu && received < plan.worstProceedsQu * 1.002, `received ${received}, worst ${plan.worstProceedsQu}`);
  chain.markets.BBB.asks[0].price = 6_030;
  const args = { plan: { ...plan, upfrontQu: steps.sell.maxOutlayQu }, balanceBeforeQu: base, balanceNowQu: chain.qu, soldQty: 1_000, quoteFn: chain.quoteFn(false) };
  const fit = await fitBuyToBalance(args);
  assert.ok(fit.ok, fit.ok ? "" : fit.reason);
  assert.equal(fit.qty, plan.minOutQty);
  assert.equal(fit.reviewedLimits, true);
  assert.equal(fit.needsConfirmation, true, "smaller than reviewed: the user is asked");
  assert.deepEqual(fit.steps.map((s) => s.amountQu), [6_060 * plan.minOutQty]);
  const held = simTotal(chain.shares.BBB);
  chain.run(fit.steps);
  assert.equal(simTotal(chain.shares.BBB) - held, plan.minOutQty);
  assert.deepEqual(chain.unpaid, []);

  // Without the reviewed quote (an older caller), the same situation is refused, not overspent.
  const old = await fitBuyToBalance({ ...args, plan: { ...args.plan, buyAtWorst: undefined } });
  assert.equal(old.ok, false);
  // Past the limit (6,061), the reviewed limits would not fill: refused.
  chain.markets.BBB.asks[0].price = 6_061;
  const past = await fitBuyToBalance({ ...args, quoteFn: chain.quoteFn(false) });
  assert.equal(past.ok, false);
  assert.match(past.ok ? "" : past.reason, /moved past your limit/);
});

test("leg 2 starts without asking only when it is exactly what was reviewed: same size, and no more QU attached than shown", async () => {
  const { plan, q } = await referencePlan();
  const asReviewed = await fitBuyToBalance(fitArgs(plan, q, 250_000, 250_000 - 100_000 + 996_003));
  assert.ok(asReviewed.ok);
  assert.equal(asReviewed.needsConfirmation, false);
  assert.equal(asReviewed.reviewedLimits, false);
  // The same size, but BBB's price rose and the sale paid more: it fits, yet attaches more than the reviewed "at most".
  const dearer = quoteFnOf({ AAA: { qswap: pool(1_000_000_000, 10_000_000) }, BBB: { qx: qx([], [{ price: 50, qty: 1000 }, { price: 62, qty: 100_000 }]) } });
  const moved = await fitBuyToBalance(fitArgs(plan, dearer, 0, 2_000_000));
  assert.ok(moved.ok && moved.qty === plan.expectedOutQty && moved.maxOutlayQu > plan.buyMaxOutlayQu);
  assert.equal(moved.needsConfirmation, true);
  // A caller that does not pass what was reviewed always gets asked.
  const { buyMaxOutlayQu: _drop, ...noReview } = plan;
  const unknown = await fitBuyToBalance(fitArgs(noReview as SwapPlan, q, 250_000, 250_000 - 100_000 + 996_003));
  assert.ok(unknown.ok && unknown.needsConfirmation);
});

test("a QX sale matched against a much more fragmented book can pay less than its worst case: leg 2 is then refused, never overspent", async () => {
  // 100,000 AAA at 5 QU, quoted against one bid. At execution the same 100,000 are bid as 5,000 orders of 20: each
  // match pays floor(100 x 0.3%) + 1 = 1 QU in fees, 5,000 QU in all instead of 1,501. The margin covers 1,000 extra
  // matches, not 4,999. This is the stated limit of the worst case (a griefing book, not a market move).
  const chain = new SimChain(
    {
      AAA: { issuer: ISSUERS[0], asks: [], bids: [{ entity: "MM", price: 5, qty: 100_000 }] },
      BBB: { issuer: ISSUERS[1], asks: [{ entity: "MM", price: 10, qty: 1_000_000 }], bids: [] },
    },
    0,
  );
  chain.shares.AAA = { 1: 100_000 };
  const plan = await planSwap(chain.quoteFn(), { from: "AAA", to: "BBB", qty: 100_000, slippageBps: 0, holdings: { 1: 100_000 } });
  assert.equal(plan.executable, true, plan.warnings.join("; "));
  chain.markets.AAA.bids = Array.from({ length: 5_000 }, () => ({ entity: "MM", price: 5, qty: 20 }));
  const steps = planSwapSteps(plan.sell!, plan.buy!, { 1: 100_000 });
  chain.run(steps.sell.steps);
  assert.equal(chain.qu, 500_000 - 5_000);
  assert.ok(chain.qu < plan.worstProceedsQu - plan.safetyMarginQu, `${chain.qu} vs ${plan.worstProceedsQu} - ${plan.safetyMarginQu}`);
  const fit = await fitBuyToBalance({ plan: { ...plan, upfrontQu: 0 }, balanceBeforeQu: 0, balanceNowQu: chain.qu, soldQty: 100_000, quoteFn: chain.quoteFn(false) });
  assert.equal(fit.ok, false);
  assert.match(fit.ok ? "" : fit.reason, /promised minimum/);
});

test("a size limit is opt-in: with one set, a bigger plan is refused; with none, it is not", async () => {
  const { createApi } = await import("../src/api.ts");
  const markets: Record<string, Market> = {
    AAA: { qswap: pool(100_000_000_000, 10_000_000_000) },
    BBB: { qswap: pool(100_000_000_000, 100_000_000_000) },
  };
  const quote = quoteFnOf(markets);
  const data = { assets: () => ["AAA", "BBB"], venues: async () => null };
  const small = createApi({ data, routes: swapRoutes({ quote, maxOutlayQu: 1_000_000_000 }) });
  const tight = createApi({ data, routes: swapRoutes({ quote, maxOutlayQu: 1_000_000 }) });
  const none = createApi({ data, routes: swapRoutes({ quote }) });
  await Promise.all([small, tight, none].map((s) => new Promise<void>((r) => s.listen(0, () => r()))));
  const post = async (s: typeof small) => (await fetch(`http://localhost:${(s.address() as import("node:net").AddressInfo).port}/v1/swap-quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "AAA", to: "BBB", qty: 1_000_000, slippageBps: 100 }) })).json() as Promise<{ executable: boolean; capQu?: number; warnings: string[] }>;
  const ok = await post(small);
  const refused = await post(tight);
  const unlimited = await post(none);
  small.close();
  tight.close();
  none.close();
  assert.equal(ok.executable, true, ok.warnings.join("; "));
  assert.equal(ok.capQu, undefined);
  assert.equal(refused.executable, false);
  assert.equal(refused.capQu, 1_000_000);
  assert.match(refused.warnings.join(" "), /limits a swap to 1,000,000 QU at risk/);
  assert.equal(unlimited.executable, true, "no limit unless the operator sets one");
  assert.equal(unlimited.capQu, undefined);
});


/* ---------- what routing is worth: the same swap forced onto each single market ---------- */

function compareFixture(markets: Record<string, Market>) {
  const data = marketData(markets);
  const quote = quoteFnOf(markets);
  const quoteOnly = (venue: "QX" | "QSwap"): QuoteFn => (side, asset, qty, slippageBps) => buildQuote(data, { side, asset, qty, slippageBps }, { allowTinyQswapBuy: true, onlyVenue: venue }) as Promise<SwapQuote>;
  return { quote, quoteOnly };
}

test("a split sale beats every single-market combination, and the comparison measures it", async () => {
  // AAA: two shallow bid levels on QX plus a big pool, sold in a size where splitting wins. BBB: a deep pool and a deep ask.
  const markets: Record<string, Market> = {
    AAA: { qx: qx([{ price: 100, qty: 1_000_000 }, { price: 99, qty: 1_000_000 }]), qswap: pool(10_000_000_000, 100_000_000) },
    BBB: { qx: qx([], [{ price: 10, qty: 500_000_000 }]), qswap: pool(10_000_000_000, 1_000_000_000) },
  };
  const f = compareFixture(markets);
  const input = { from: "AAA", to: "BBB", qty: 2_000_000, slippageBps: 100 };
  const best = await planSwap(f.quote, input);
  assert.equal(best.executable, true, best.warnings.join("; "));
  const deal = await compareSwap(f, input, best);
  assert.equal(deal.comparisons.length, 4);
  assert.deepEqual(deal.comparisons.map((c) => c.label), ["Sell on QX, buy on QX", "Sell on QX, buy on QSwap", "Sell on QSwap, buy on QX", "Sell on QSwap, buy on QSwap"]);
  const able = deal.comparisons.filter((c) => c.executable);
  assert.ok(able.length >= 2);
  // QMax's route is never worth less than any single-market combination (units plus leftover QU minus up-front fees; the search is exact to about 0.05%)
  for (const c of able) assert.ok(deal.valueQty >= c.valueQty * 0.999, `${c.label}: QMax ${deal.valueQty} vs ${c.valueQty}`);
  for (const c of able) assert.ok(c.lessQty! >= 0 && c.lessPct! >= 0);
  assert.ok(deal.gainQty > 0, "splitting the sale across both markets is worth something here");
  assert.match(deal.headline, /QMax's route is worth about .* more \(.*%\) than the best single-market route \(selling .*\).*counting the QU left over/);
});

test("a combination a market cannot do is listed as unavailable with the reason, and no gain is claimed", async () => {
  // AAA trades only on QX, BBB only in a pool: one combination exists, and QMax's route is that one.
  const markets: Record<string, Market> = {
    AAA: { qx: qx([{ price: 100, qty: 10_000_000 }]) },
    BBB: { qswap: pool(10_000_000_000, 1_000_000_000) },
  };
  const f = compareFixture(markets);
  const input = { from: "AAA", to: "BBB", qty: 100_000, slippageBps: 100 };
  const best = await planSwap(f.quote, input);
  assert.equal(best.executable, true, best.warnings.join("; "));
  const deal = await compareSwap(f, input, best);
  const ok = deal.comparisons.filter((c) => c.executable);
  assert.deepEqual(ok.map((c) => c.label), ["Sell on QX, buy on QSwap"]);
  for (const c of deal.comparisons.filter((x) => !x.executable)) assert.ok(c.reason && c.expectedOutQty === 0 && c.valueQty === 0 && c.lessQty === null, c.label);
  assert.equal(deal.gainQty, 0);
  assert.match(deal.headline, /Selling on QX and buying on QSwap is already the best deal/);
});

test("when no single market combination can do the swap, the headline says routing makes it possible", async () => {
  const f = compareFixture({ AAA: { qx: qx([{ price: 100, qty: 10_000_000 }]) }, BBB: { qx: qx([], [{ price: 10, qty: 500_000_000 }]) } });
  const input = { from: "AAA", to: "BBB", qty: 1_000, slippageBps: 100 };
  const best = await planSwap(f.quote, input);
  // pretend every forced plan fails: a market that has nothing
  const none = { quote: f.quote, quoteOnly: (): QuoteFn => async () => ({ fillable: false, filledQty: 0, route: [], alternatives: [], warnings: ["No venue (or combination) can fill the full order: insufficient depth"], asset: "X", side: "sell", qty: 1, totalQu: 0, averagePriceQu: null, slippageBps: 100, executable: true }) as never };
  const deal = await compareSwap(none, input, best);
  assert.equal(deal.comparisons.every((c) => !c.executable), true);
  assert.match(deal.headline, /No single-market combination could do this swap/);
});

test("the endpoint adds the comparison only when asked, and a failing comparison does not spoil the plan", async () => {
  const markets: Record<string, Market> = { AAA: { qswap: pool(10_000_000_000, 1_000_000_000) }, BBB: { qswap: pool(10_000_000_000, 1_000_000_000) } };
  const f = compareFixture(markets);
  const broken = createApi({ data: { assets: () => [], venues: async () => null }, routes: swapRoutes({ quote: f.quote, quoteOnly: () => async () => { throw new Error("boom"); } }) });
  const fine = createApi({ data: { assets: () => [], venues: async () => null }, routes: swapRoutes({ quote: f.quote, quoteOnly: f.quoteOnly }) });
  await Promise.all([broken, fine].map((s) => new Promise<void>((r) => s.listen(0, () => r()))));
  const post = async (s: typeof fine, body: object) => (await fetch(`http://localhost:${(s.address() as AddressInfo).port}/v1/swap-quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ executable: boolean; bestDeal?: { comparisons: unknown[]; headline: string } }>;
  const base = { from: "AAA", to: "BBB", qty: 100_000_000, slippageBps: 100 };
  const without = await post(fine, base);
  const withCmp = await post(fine, { ...base, compare: true });
  const spoiled = await post(broken, { ...base, compare: true });
  fine.close();
  broken.close();
  assert.equal(without.executable, true);
  assert.equal(without.bestDeal, undefined, "not asked for, not computed");
  assert.equal(withCmp.bestDeal?.comparisons.length, 4);
  assert.equal(spoiled.executable, true, "the plan survives a comparison that fails");
  assert.equal(spoiled.bestDeal?.comparisons.every((c: unknown) => !(c as { executable: boolean }).executable), true, "a comparison whose quotes fail lists every combination as unavailable");
});

// ------------------------------------------------------------------------------------------------------------
// The largest buy a wallet can fund

test("The largest affordable buy on a QX-only book is the largest size whose bid fits the balance, found with few quotes", async () => {
  const q = quoteFnOf({ BBB: { qx: qx([], [{ price: 50, qty: 1000 }, { price: 60, qty: 100_000 }]) } });
  const balance = 2_000_000;
  const r = await affordableBuy(q, { asset: "BBB", slippageBps: 100, balanceQu: balance });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.outlayQu <= r.budgetQu && r.budgetQu < balance, "never more than the budget, and some QU is kept back");
  assert.equal(r.budgetQu, balance - safetyMarginQu(balance));
  assert.ok(r.quotesUsed <= MAX_QUOTES_PER_SEARCH, `${r.quotesUsed} quotes`);
  // one more unit than the answer would not have fitted (or is not there to buy): it is the largest, within the search's precision
  const next = await q("buy", "BBB", r.qty + Math.max(2, Math.ceil(r.qty / 1000)), 100);
  assert.ok(!next.fillable || buildExecutionPlan({ ...next, assetInfo: next.assetInfo! } as never).maxOutlayQu > r.budgetQu, "a clearly larger size does not fit");
  // what it says it attaches is what the buy steps really attach
  assert.equal(r.outlayQu, buildExecutionPlan({ ...r.quote, assetInfo: r.quote.assetInfo! } as never).maxOutlayQu);
});

test("The largest affordable buy is priced by the router at that size: the same route and cost a normal quote gives, and no dearer than the pool alone", async () => {
  const markets = { AAA: { qswap: pool(1_000_000_000, 10_000_000), qx: qx([], [{ price: 99, qty: 2_000 }, { price: 140, qty: 50_000 }]) } };
  const q = quoteFnOf(markets);
  const r = await affordableBuy(q, { asset: "AAA", slippageBps: 100, balanceQu: 5_000_000_000 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const again = await q("buy", "AAA", r.qty, 100);
  assert.deepEqual(again.route.map((l) => [l.venue, l.qty]), r.quote.route.map((l) => [l.venue, l.qty]));
  assert.equal(again.totalQu, r.quote.totalQu);
  const poolOnly = await quoteFnOf({ AAA: { qswap: markets.AAA.qswap } })("buy", "AAA", r.qty, 100);
  assert.ok(r.quote.totalQu <= poolOnly.totalQu, `${r.quote.totalQu} QU by the best route against ${poolOnly.totalQu} QU in the pool alone`);
});

test("The largest affordable buy refuses, with a reason, when nothing can be bought or the balance is too small", async () => {
  const q = quoteFnOf({ AAA: { qswap: pool(1_000_000_000, 10_000_000) } });
  const poor = await affordableBuy(q, { asset: "AAA", slippageBps: 100, balanceQu: 50_000 });
  assert.equal(poor.ok, false);
  if (!poor.ok) assert.match(poor.reason, /needs up to .* QU/);
  const none = await affordableBuy(q, { asset: "AAA", slippageBps: 100, balanceQu: 0 });
  assert.equal(none.ok, false);
  const nothingToBuy = await affordableBuy(quoteFnOf({ AAA: { qx: qx([{ price: 10, qty: 5 }], []) } }), { asset: "AAA", slippageBps: 100, balanceQu: 10_000_000 });
  assert.equal(nothingToBuy.ok, false);
  if (!nothingToBuy.ok) assert.match(nothingToBuy.reason, /cannot be bought/);
  const broken = await affordableBuy((async () => { throw new Error("rate limited"); }) as QuoteFn, { asset: "AAA", slippageBps: 100, balanceQu: 1_000_000 });
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.reason, /rate limited/);
});

test("The largest affordable buy never asks for more quotes than it was allowed", async () => {
  const q = quoteFnOf({ BBB: { qx: qx([], Array.from({ length: 40 }, (_, i) => ({ price: 50 + i * 3, qty: 500 }))) } });
  const r = await affordableBuy(q, { asset: "BBB", slippageBps: 100, balanceQu: 30_000_000, maxQuotes: 4 });
  assert.ok(q.calls <= 4, `${q.calls} quotes`);
  if (r.ok) assert.ok(r.outlayQu <= r.budgetQu);
});
