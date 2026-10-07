import test from "node:test";
import assert from "node:assert/strict";
import type { QuoteResponse } from "../src/apitypes.ts";
import type { MarketData } from "../src/data.ts";
import { buildExecutionPlan } from "../src/exec.ts";
import type { ExecutionPlan, TxStep } from "../src/exec.ts";
import { checkQuotePlan } from "../src/plancheck.ts";
import type { PlanExpectation } from "../src/plancheck.ts";
import { buildQuote } from "../src/quoteapi.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const OTHER = "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE";
const info = { issuer: ISSUER, assetName: "CFB", transferFeeQu: { qx: 100, qswap: 100 } };
const FEES = { qx: 100, qswap: 100 };

// Sizes where it matters, found with the router itself: 100,000 units fill on QX alone, 400,000 split across QX and QSwap, 1,000,000 go to QSwap alone.
const book = () => new QxVenue({ asks: [{ price: 10, qty: 150_000 }, { price: 12, qty: 150_000 }], bids: [{ price: 10, qty: 150_000 }, { price: 8, qty: 150_000 }], buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 100, truncated: false });
const pool = () => new QswapVenue({ reserveQu: 5_000_000_000, reserveAsset: 500_000_000, swapFeeRate: 30, fixedCostQu: 100_100 });
const data = (): MarketData => ({ assets: () => ["CFB"], venues: async () => [book(), pool()], assetInfo: async () => info }) as unknown as MarketData;

const genuine = async (side: "buy" | "sell", qty: number, slippageBps = 100) => {
  const quote = (await buildQuote(data(), { side, asset: "CFB", qty, slippageBps })) as unknown as QuoteResponse;
  return { quote, plan: buildExecutionPlan(quote, side === "sell" ? { 1: qty, 13: 0 } : {}) };
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const expect = (side: "buy" | "sell", qty: number, o: Partial<PlanExpectation> = {}): PlanExpectation => ({ side, qty, assetName: "CFB", issuer: ISSUER, slippageBps: 100, onChainFees: FEES, ...o });
/** A tampered quote, with its plan rebuilt from the tampered hints the way the website does. */
const tampered = (quote: QuoteResponse, edit: (q: QuoteResponse) => void, holdings = {}) => {
  const q = clone(quote);
  edit(q);
  return { quote: q, plan: buildExecutionPlan(q, holdings) };
};
const problemsOf = (r: { problems: string[] }) => r.problems.join(" | ");

test("a genuine quote, split across QX and QSwap or on one market, passes with nothing to say", async () => {
  for (const [side, qty] of [["buy", 100_000], ["buy", 400_000], ["buy", 1_000_000], ["sell", 100_000], ["sell", 400_000], ["sell", 1_000_000]] as const) {
    const { quote, plan } = await genuine(side, qty);
    const r = checkQuotePlan(quote, plan, expect(side, qty));
    assert.deepEqual(r, { problems: [], warnings: [] }, `${side} ${qty}`);
  }
});

test("a quote for something other than what was chosen is refused: another issuer, name, side or quantity", async () => {
  const { quote, plan } = await genuine("buy", 100_000);
  assert.match(problemsOf(checkQuotePlan(quote, plan, expect("buy", 100_000, { issuer: OTHER }))), /different issuer/);
  assert.match(problemsOf(checkQuotePlan(quote, plan, expect("buy", 100_000, { assetName: "QDOGE" }))), /asset 'CFB', not 'QDOGE'/);
  assert.match(problemsOf(checkQuotePlan(quote, plan, expect("sell", 100_000))), /quote is for a buy, not a sell/);
  assert.match(problemsOf(checkQuotePlan(quote, plan, expect("buy", 90_000))), /not the 90,000 you asked for/);
  const swapped = tampered(quote, (q) => (q.assetInfo.issuer = OTHER));
  assert.match(problemsOf(checkQuotePlan(swapped.quote, swapped.plan, expect("buy", 100_000))), /different issuer/, "a server that swaps the issuer inside the quote is caught");
});

test("a limit looser than the person's slippage allows is refused, whichever market and side", async () => {
  const buy = await genuine("buy", 400_000);
  const loose = tampered(buy.quote, (q) => {
    for (const leg of q.route) {
      const h = leg.execution;
      if (h.type === "qx-bid") h.limitPrice *= 400;
      if (h.type === "qswap-buy") h.maxQuIn *= 1000;
    }
  });
  const r = checkQuotePlan(loose.quote, loose.plan, expect("buy", 400_000));
  assert.match(problemsOf(r), /QX bid limit .* looser/);
  assert.match(problemsOf(r), /QSwap buy would pay up to/);

  const sell = await genuine("sell", 400_000);
  const cheap = tampered(sell.quote, (q) => {
    for (const leg of q.route) {
      const h = leg.execution;
      if (h.type === "qx-ask") h.limitPrice = 1;
      if (h.type === "qswap-sell") h.minQuOut = 0;
    }
  }, { 1: 400_000, 13: 400_000 });
  const r2 = checkQuotePlan(cheap.quote, cheap.plan, expect("sell", 400_000));
  assert.match(problemsOf(r2), /QSwap sale would accept as little as 0 QU|QX ask limit/);
});

test("each kind of limit is checked on its own: a loosened QX ask, QSwap sale, QX bid or QSwap buy alone is enough to refuse", async () => {
  const sell = await genuine("sell", 400_000);
  const buy = await genuine("buy", 400_000);
  const hold = { 1: 400_000, 13: 400_000 };
  const only = async (kind: "qx-ask" | "qswap-sell" | "qx-bid" | "qswap-buy") => {
    const base = kind === "qx-ask" || kind === "qswap-sell" ? sell : buy;
    const t = tampered(base.quote, (q) => {
      for (const leg of q.route) {
        const h = leg.execution;
        if (h.type === "qx-ask" && kind === "qx-ask") h.limitPrice = 1;
        if (h.type === "qswap-sell" && kind === "qswap-sell") h.minQuOut = 0;
        if (h.type === "qx-bid" && kind === "qx-bid") h.limitPrice *= 50;
        if (h.type === "qswap-buy" && kind === "qswap-buy") h.maxQuIn *= 50;
      }
    }, hold);
    return problemsOf(checkQuotePlan(t.quote, t.plan, expect(base.quote.side, 400_000)));
  };
  assert.match(await only("qx-ask"), /QX ask limit 1 QU is looser/);
  assert.match(await only("qswap-sell"), /QSwap sale would accept as little as 0 QU/);
  assert.match(await only("qx-bid"), /QX bid limit .* looser/);
  assert.match(await only("qswap-buy"), /QSwap buy would pay up to/);
});

test("legs that quietly route less than was asked are refused even when each leg is consistent with itself", async () => {
  const { quote } = await genuine("buy", 400_000);
  const short = tampered(quote, (q) => {
    const leg = q.route[0];
    leg.qty = Math.floor(leg.qty / 2);
    leg.execution.qty = leg.qty;
  });
  const r = checkQuotePlan(short.quote, short.plan, expect("buy", 400_000));
  assert.match(problemsOf(r), /legs add up to .*, not 400,000/);
});

test("a server that answers with looser slippage than the person set cannot widen the limits", async () => {
  const { quote, plan } = await genuine("buy", 400_000, 1000); // 10% asked of the API
  assert.deepEqual(checkQuotePlan(quote, plan, expect("buy", 400_000, { slippageBps: 1000 })).problems, [], "fine if that is what the person chose");
  assert.match(problemsOf(checkQuotePlan(quote, plan, expect("buy", 400_000, { slippageBps: 100 }))), /looser than|more than the/, "but not when they chose 1%");
});

test("tighter limits than needed are accepted: they are safe, they can only cause a refusal", async () => {
  const { quote } = await genuine("buy", 400_000);
  const t = tampered(quote, (q) => {
    for (const leg of q.route) {
      const h = leg.execution;
      if (h.type === "qx-bid") h.limitPrice = Math.max(1, h.limitPrice - 1);
      if (h.type === "qswap-buy") h.maxQuIn = Math.floor(h.maxQuIn * 0.99);
    }
  });
  assert.deepEqual(checkQuotePlan(t.quote, t.plan, expect("buy", 400_000)).problems, []);
});

test("legs that do not match what they route are refused: another quantity, a duplicate, a wrong kind, a missing worst price", async () => {
  const { quote } = await genuine("buy", 400_000);
  assert.ok(quote.route.length === 2, "this order splits");
  const more = tampered(quote, (q) => (q.route[0].execution.qty *= 100));
  assert.match(problemsOf(checkQuotePlan(more.quote, more.plan, expect("buy", 400_000))), /routes .* but would trade/);
  const dup = tampered(quote, (q) => q.route.push(clone(q.route[0])));
  const d = problemsOf(checkQuotePlan(dup.quote, dup.plan, expect("buy", 400_000)));
  assert.match(d, /two legs on/);
  assert.match(d, /legs add up to/);
  const kind = tampered(quote, (q) => {
    q.route[0].execution = { type: q.route[0].venue === "QX" ? "qx-ask" : "qswap-sell", qty: q.route[0].qty, limitPrice: 1, minQuOut: 1 } as never;
  });
  assert.match(problemsOf(checkQuotePlan(kind.quote, kind.plan, expect("buy", 400_000))), /would (qx-ask|qswap-sell), not/);
  const noWorst = tampered(quote, (q) => delete q.route.find((l) => l.venue === "QX")!.priceRangeQu);
  assert.match(problemsOf(checkQuotePlan(noWorst.quote, noWorst.plan, expect("buy", 400_000))), /no worst price/);
  const venue = tampered(quote, (q) => (q.route[0].venue = "Elsewhere" as never));
  assert.match(problemsOf(checkQuotePlan(venue.quote, venue.plan, expect("buy", 400_000))), /not QX or QSwap/);
});

test("the legs must add up to the total shown", async () => {
  const { quote, plan } = await genuine("buy", 400_000);
  const lie = clone(quote);
  lie.totalQu = Math.round(quote.totalQu / 10);
  assert.match(problemsOf(checkQuotePlan(lie, plan, expect("buy", 400_000))), /legs add up to .* QU but the total shown/);
});

test("steps that go anywhere but QX or QSwap, or do anything but trade, are refused", async () => {
  const { quote, plan } = await genuine("buy", 100_000);
  const evil = (edit: (s: TxStep) => TxStep): ExecutionPlan => ({ ...plan, steps: plan.steps.map(edit) });
  assert.match(problemsOf(checkQuotePlan(quote, evil((s) => ({ ...s, to: { identity: ISSUER } })), expect("buy", 100_000))), /somewhere other than QX or QSwap/);
  assert.match(problemsOf(checkQuotePlan(quote, evil((s) => ({ ...s, to: { contractIndex: 29 } })), expect("buy", 100_000))), /somewhere other than QX or QSwap/);
  assert.match(problemsOf(checkQuotePlan(quote, evil((s) => ({ ...s, kind: "payment" })), expect("buy", 100_000))), /a payment, which a trade never needs/);
  assert.match(problemsOf(checkQuotePlan(quote, { ...plan, steps: [] }, expect("buy", 100_000))), /no steps/);
});

test("a share move is paid at the contracts' real fee, read from the network, or it is refused", async () => {
  const { quote } = await genuine("sell", 100_000);
  // Hold everything under the other contract from the one the order sells on, so the shares have to be moved first.
  const holdings = quote.route[0].venue === "QX" ? { 1: 0, 13: 100_000 } : { 1: 100_000, 13: 0 };
  const plan = buildExecutionPlan(quote, holdings);
  const move = plan.steps.find((s) => s.kind === "transfer-rights");
  assert.ok(move, "this sale needs a share move");
  assert.deepEqual(checkQuotePlan(quote, plan, expect("sell", 100_000)).problems, []);
  assert.match(problemsOf(checkQuotePlan(quote, plan, expect("sell", 100_000, { onChainFees: undefined }))), /could not be read from the network/);
  const greedy = tampered(quote, (q) => (q.assetInfo.transferFeeQu = { qx: 2_000_000_000, qswap: 2_000_000_000 }), holdings);
  assert.match(problemsOf(checkQuotePlan(greedy.quote, greedy.plan, expect("sell", 100_000))), /attaches 2,000,000,000 QU, but the contracts' fees are 100 and 100/);
});

test("limits that allow a much worse price than the average are allowed but flagged, with the figures", () => {
  // A thin book: the average is 100 QU a unit but the worst level is 160, which at 5% slippage lets the order cost far more than shown.
  const quote = {
    asset: "CFB", side: "buy", qty: 100, filledQty: 100, fillable: true, executable: true, totalQu: 10_000, averagePriceQu: 100, slippageBps: 500,
    assetInfo: info, alternatives: [], warnings: [],
    route: [{ venue: "QX", qty: 100, shareOfOrder: 1, totalQu: 10_000, effectivePriceQu: 100, priceImpact: 0.6, feesQu: 0, fixedCostQu: 100, priceRangeQu: { best: 50, worst: 160 }, execution: { type: "qx-bid", qty: 100, limitPrice: 168 } }],
  } as unknown as QuoteResponse;
  const plan = buildExecutionPlan(quote);
  const r = checkQuotePlan(quote, plan, expect("buy", 100, { slippageBps: 500 }));
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings[0], /up to 16,800 QU to leave your wallet, against an expected 10,000 QU/);
});
