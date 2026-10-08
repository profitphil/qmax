import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuoteResponse } from "../src/apitypes.ts";
import { buildExecutionPlan, fitBidsToBalance, fitNote } from "../src/exec.ts";
import type { FitQuote } from "../src/exec.ts";
import { prepareTrade } from "../src/trade.ts";
import type { TradeEnv } from "../src/trade.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const WALLET = "A".repeat(59) + "B";
const info = { issuer: ISSUER, assetName: "QDOGE", transferFeeQu: { qx: 100, qswap: 100 } };

/** 400,000 QDOGE bought on QX at 24 QU: 9.6 million to pay. 1% above 24 rounds up to a whole 25, so the bid is capped at 25 and QX holds 10 million. */
const dogeQuote = (over: Record<string, unknown> = {}) =>
  ({
    asset: "QDOGE", side: "buy", qty: 400_000, filledQty: 400_000, fillable: true, executable: true, totalQu: 9_600_000, averagePriceQu: 24, slippageBps: 100, assetInfo: info,
    route: [{ venue: "QX", qty: 400_000, shareOfOrder: 1, totalQu: 9_600_000, effectivePriceQu: 24, priceImpact: 0, feesQu: 0, fixedCostQu: 0, priceRangeQu: { best: 24, worst: 24 }, execution: { type: "qx-bid", qty: 400_000, limitPrice: 25 } }],
    alternatives: [], warnings: [], ...over,
  }) as unknown as QuoteResponse;

const env = (quote: QuoteResponse, balanceQu: number) =>
  ({ quote: async () => quote, snapshot: async () => ({ balanceQu, holdings: {} as Record<number, number> }), fees: async () => ({ qx: 100, qswap: 100 }) }) as unknown as TradeEnv;
const req = { side: "buy" as const, asset: "QDOGE", qty: 400_000, slippageBps: 100 };

test("a wallet that can pay for the buy but not for the whole price allowance gets a lower cap instead of a refusal (400,000 QDOGE, 9.76 million QU)", async () => {
  const p = await prepareTrade(env(dogeQuote(), 9_760_100), req, WALLET);
  const bid = p.plan.steps[0];
  assert.equal(bid.amountQu, 24 * 400_000, "capped at the price the fill reaches: exactly what it costs");
  assert.equal(p.plan.maxOutlayQu, 9_600_000);
  assert.ok(p.plan.maxOutlayQu <= 9_760_100);
  assert.match(p.warnings!.join(" "), /does not hold the full 1% price allowance/);
  assert.match(p.warnings!.join(" "), /24 QU each instead of 25/);
  assert.match(p.warnings!.join(" "), /open bid/);
});

test("a wallet that covers the whole allowance is left alone: same cap, no note", async () => {
  const p = await prepareTrade(env(dogeQuote(), 10_000_000), req, WALLET);
  assert.equal(p.plan.steps[0].amountQu, 25 * 400_000);
  assert.equal(p.warnings, undefined);
});

test("a wallet that cannot even pay the quoted price is still refused, and told why the buy holds more than it costs", async () => {
  await assert.rejects(prepareTrade(env(dogeQuote(), 9_000_000), req, WALLET), (e: Error) => /Not enough QU: this trade needs up to 10,000,000 QU/.test(e.message) && /shares cost about 9,600,000 QU/.test(e.message) && /holds its price cap times the quantity/.test(e.message));
});

test("the allowance is spent as far as the wallet allows, in whole prices, and never goes above the cap it had or below the worst price", () => {
  // price 3,989 with 1% allowance = cap 4,030; the wallet covers 3,995 x 1,000
  const q = {
    asset: "QMINE", side: "buy", assetInfo: info,
    route: [{ venue: "QX", qty: 1000, priceRangeQu: { best: 3989, worst: 3989 }, execution: { type: "qx-bid", qty: 1000, limitPrice: 4030 } }],
  } as unknown as FitQuote;
  const f = fitBidsToBalance(q, 3_995_500)!;
  assert.equal((f.quote.route[0].execution as { limitPrice: number }).limitPrice, 3995);
  assert.equal(f.maxOutlayAfter, 3_995_000);
  assert.equal(f.capBefore, 4030);
  assert.equal(f.capAfter, 3995);
  // exactly the quoted price: the floor
  assert.equal((fitBidsToBalance(q, 3_989_000)!.quote.route[0].execution as { limitPrice: number }).limitPrice, 3989);
  // below the quoted price: nothing can be done here
  assert.equal(fitBidsToBalance(q, 3_988_999), null);
  // already covered, a sale, or a leg that does not say its worst price: untouched
  assert.equal(fitBidsToBalance(q, 4_030_000), null);
  assert.equal(fitBidsToBalance({ ...q, side: "sell" } as FitQuote, 1), null);
  const blind = { ...q, route: [{ venue: "QX", qty: 1000, execution: { type: "qx-bid", qty: 1000, limitPrice: 4030 } }] } as unknown as FitQuote;
  assert.equal(fitBidsToBalance(blind, 3_995_500), null);
  // the original quote is not changed
  assert.equal((q.route[0].execution as { limitPrice: number }).limitPrice, 4030);
});

test("a buy split across QX and QSwap only lowers the QX cap (the pool's flat fee and cap are not touched)", () => {
  const q = {
    asset: "CFB", side: "buy", assetInfo: info,
    route: [
      { venue: "QX", qty: 100, priceRangeQu: { best: 300, worst: 300 }, execution: { type: "qx-bid", qty: 100, limitPrice: 303 } },
      { venue: "QSwap", qty: 50, execution: { type: "qswap-buy", qty: 50, maxQuIn: 160 } },
    ],
  } as unknown as FitQuote;
  const before = buildExecutionPlan(q).maxOutlayQu; // 30,300 + 160 + 100,000
  const f = fitBidsToBalance(q, before - 250)!;
  assert.equal((f.quote.route[0].execution as { limitPrice: number }).limitPrice, 300); // 303 -> 300 saves 300 >= 250
  assert.deepEqual(f.quote.route[1], q.route[1]);
  assert.equal(f.maxOutlayAfter, before - 300);
  // the note says what happened in plain words
  assert.match(fitNote(f, 100), /capped at 300 QU each instead of 303/);
});
