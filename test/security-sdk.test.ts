import test from "node:test";
import assert from "node:assert/strict";
import type { QuoteResponse } from "../src/apitypes.ts";
import { buildExecutionPlan } from "../src/exec.ts";
import { prepareTrade } from "../src/trade.ts";
import type { TradeEnv } from "../src/trade.ts";
import { TradeBudget, TradeRefused, agentTrade, checkPlan } from "../sdk/agent.ts";
import type { Signer, StepChain } from "../sdk/agent.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const SCAM = "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE";
const WALLET = "A".repeat(59) + "B";
const info = { issuer: ISSUER, assetName: "CFB", transferFeeQu: { qx: 100, qswap: 100 } };

/** A genuine quote for buying 10 CFB on QX at 100 each with 1% slippage (limit 101). */
const genuine = (over: Record<string, unknown> = {}) =>
  ({
    asset: "CFB", side: "buy", qty: 10, filledQty: 10, fillable: true, executable: true, totalQu: 1000, averagePriceQu: 100, slippageBps: 100, assetInfo: info,
    route: [{ venue: "QX", qty: 10, shareOfOrder: 1, totalQu: 1000, effectivePriceQu: 100, priceImpact: 0, feesQu: 0, fixedCostQu: 0, priceRangeQu: { best: 100, worst: 100 }, execution: { type: "qx-bid", qty: 10, limitPrice: 101 } }],
    alternatives: [], warnings: [], ...over,
  }) as unknown as QuoteResponse;

function rig(quote: QuoteResponse, balance = 100_000_000_000) {
  const signed: unknown[] = [];
  const signer: Signer = { identity: WALLET, sign: async (tx) => (signed.push(tx), { tx: new Uint8Array(4) }) };
  const chain: StepChain = { tick: async () => 5000, broadcast: async () => "a".repeat(60), wait: async () => ({ included: true, moneyFlew: true }) };
  const env = {
    snapshot: async () => ({ balanceQu: balance, holdings: { 1: 1_000_000 } as Record<number, number> }),
    openOrders: async () => [],
    fees: async () => ({ qx: 100, qswap: 100 }),
    sleep: async () => {}, // the real wait for balances to settle is 4 x 5 s
  };
  const run = (o: { side?: "buy" | "sell"; qty?: number; asset?: string; issuer?: string; limits?: object; budget?: TradeBudget } = {}) =>
    agentTrade({ budget: o.budget, client: { quote: async () => quote }, signer, side: o.side ?? "buy", asset: o.asset ?? "CFB", qty: o.qty ?? 10, issuer: o.issuer, limits: { maxOutlayQu: 200_000, ...(o.limits as object) }, chain, env: env as Partial<TradeEnv> });
  return { run, signed };
}

const refuses = async (quote: QuoteResponse, o: Parameters<ReturnType<typeof rig>["run"]>[0] = {}) => {
  const r = rig(quote);
  let why = "";
  try {
    await r.run(o);
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  assert.ok(why, "the trade was refused");
  assert.equal(r.signed.length, 0, "and nothing was signed");
  return why;
};

test("a genuine quote is traded", async () => {
  const r = rig(genuine());
  const res = await r.run();
  assert.equal(res.ok === true || res.ok === false, true);
  assert.ok(r.signed.length >= 1, "its transaction was signed");
});

test("a leg with a negative quantity and amount cannot hide a huge one inside the total", async () => {
  const q = genuine({
    route: [
      { venue: "QX", qty: 10, shareOfOrder: 1, totalQu: 1000, effectivePriceQu: 100, priceImpact: 0, feesQu: 0, fixedCostQu: 0, priceRangeQu: { best: 100, worst: 100 }, execution: { type: "qx-bid", qty: 10, limitPrice: 200_000_000 } },
      { venue: "QSwap", qty: -1, shareOfOrder: 0, totalQu: -1, effectivePriceQu: 1, priceImpact: 0, feesQu: 0, fixedCostQu: 0, execution: { type: "qswap-buy", qty: -1, maxQuIn: -1_999_890_000 } },
    ],
  });
  assert.match(await refuses(q), /not a positive whole number|looser|two|legs/);
});

test("a quote that labels the asset CFB but would sign for another issuer or name is refused", async () => {
  assert.match(await refuses(genuine({ assetInfo: { ...info, assetName: "SCAMTOK" } }), { limits: { allowedAssets: ["CFB"] } }), /not 'CFB'|SCAMTOK/);
  assert.match(await refuses(genuine({ assetInfo: { ...info, issuer: SCAM } }), { issuer: ISSUER }), /different issuer/);
});

test("a quote for another side or another quantity than was asked for is refused, so a sale cannot become a purchase", async () => {
  assert.match(await refuses(genuine({ side: "buy" }), { side: "sell", limits: { minAveragePriceQu: 90 } }), /quote is for a buy, not a sell/);
  assert.match(await refuses(genuine({ qty: 1000, route: [{ ...genuine().route[0], qty: 1000, execution: { type: "qx-bid", qty: 1000, limitPrice: 101 } }] }), { qty: 10 }), /not the 10 you asked for/);
});

test("a limit looser than the slippage asked for is refused even if the plan is inside the agent's own limits", async () => {
  const loose = genuine();
  (loose.route[0].execution as { limitPrice: number }).limitPrice = 150;
  assert.match(await refuses(loose, { limits: { maxOutlayQu: 100_000 } }), /looser than/);
});

test("a share move is paid at the fee the contracts charge, not the one the quote says", async () => {
  const hostile = genuine({ side: "sell", assetInfo: { ...info, transferFeeQu: { qx: 2_000_000_000, qswap: 2_000_000_000 } }, route: [{ venue: "QSwap", qty: 10, shareOfOrder: 1, totalQu: 1000, effectivePriceQu: 100, priceImpact: 0, feesQu: 0, fixedCostQu: 0, execution: { type: "qswap-sell", qty: 10, minQuOut: 990 } }] });
  const env = { quote: async () => hostile, snapshot: async () => ({ balanceQu: 100_000_000, holdings: { 1: 10 } as Record<number, number> }), fees: async () => ({ qx: 100, qswap: 100 }) } as unknown as TradeEnv;
  const p = await prepareTrade(env, { side: "sell", asset: "CFB", qty: 10, slippageBps: 100 }, WALLET);
  const move = p.plan.steps.find((s) => s.kind === "transfer-rights");
  assert.ok(move, "the shares are under QX, so they are moved to QSwap first");
  assert.equal(move!.amountQu, 100, "at the real fee");
  // And if the real fee cannot be read, a share move is refused rather than priced from the quote.
  const blind = { ...env, fees: async () => { throw new Error("rpc down"); } } as unknown as TradeEnv;
  await assert.rejects(prepareTrade(blind, { side: "sell", asset: "CFB", qty: 10, slippageBps: 100 }, WALLET), /fee could not be read from the network/);
});

test("checkPlan holds each step to the limit on its own and the plan's total to the sum of its steps", () => {
  const q = genuine();
  const plan = buildExecutionPlan(q);
  assert.deepEqual(checkPlan(plan, q, { maxOutlayQu: 5000 }), []);
  assert.match(checkPlan({ ...plan, maxOutlayQu: 5 }, q, { maxOutlayQu: 5000 }).join("|"), /not the sum of its steps/);
  const negative = { steps: [{ ...plan.steps[0], amountQu: 2_000_000_000 }, { ...plan.steps[0], id: "x", amountQu: -1_999_998_990 }], maxOutlayQu: 1010 };
  const problems = checkPlan(negative, q, { maxOutlayQu: 5000 }).join("|");
  assert.match(problems, /not a whole non-negative number/);
  assert.match(problems, /alone attaches 2,000,000,000 QU/);
  assert.match(checkPlan(plan, genuine({ assetInfo: { ...info, assetName: "SCAMTOK" } }), { maxOutlayQu: 5000, allowedAssets: ["CFB"] }).join("|"), /payload names SCAMTOK/);
  assert.ok(TradeRefused);
});

test("a budget shared by trades started together lets only what it covers through, and counts what was set aside", async () => {
  const probe = new TradeBudget(1_000_000_000);
  await rig(genuine()).run({ budget: probe });
  const oneTrade = probe.totalQu - probe.remainingQu;
  assert.ok(oneTrade > 0, "a trade holds its worst-case outlay");

  const r = rig(genuine());
  const budget = new TradeBudget(Math.floor(oneTrade * 1.5)); // room for one, not two
  const results = await Promise.allSettled([r.run({ budget }), r.run({ budget }), r.run({ budget })]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1, "only one of three simultaneous trades fits");
  const refused = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
  assert.equal(refused.length, 2);
  assert.ok(refused.every((x) => x.reason instanceof TradeRefused && /budget/.test(x.reason.message)));
  assert.equal(budget.remainingQu, Math.floor(oneTrade * 1.5) - oneTrade, "what was handed to the wallet stays counted");
});

test("a trade the checks refuse does not use up the budget, and a bad budget is refused", async () => {
  const budget = new TradeBudget(5_000_000);
  const r = rig(genuine());
  await assert.rejects(r.run({ budget, limits: { maxOutlayQu: 1 } }), TradeRefused);
  assert.equal(budget.remainingQu, 5_000_000);
  assert.throws(() => new TradeBudget(0), /above zero/);
  assert.throws(() => new TradeBudget(NaN), /above zero/);
  assert.throws(() => budget.reserve(-5), TradeRefused);
  const undo = budget.reserve(1000);
  undo();
  undo(); // undoing twice does not give back more than was held
  assert.equal(budget.remainingQu, 5_000_000);
});
