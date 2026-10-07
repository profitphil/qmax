/**
 * Plans a real token-to-token swap against the running API's live quotes and prints the numbers, so the planner can be
 * checked against the market. Read-only: it asks for quotes, it never signs or sends anything.
 *
 *   node --experimental-strip-types --no-warnings scripts/swap-check.ts [FROM] [TO] [QTY] [SLIPPAGE_BPS]
 *
 * API_URL defaults to http://localhost:8787. Quotes are paced one per second: the free tier allows 60 a minute, and
 * each live quote also reads the chain.
 */
import { fitBuyToBalance, planSwap, worstLegProceedsQu } from "../src/swap.ts";
import type { QuoteFn, SwapQuote } from "../src/swap.ts";

const [from = "CFB", to = "QDOGE", qtyArg = "10000000", slipArg = "100"] = process.argv.slice(2);
const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const n = (x: number) => Math.round(x).toLocaleString("en-US");

let last = 0;
let calls = 0;
const quote: QuoteFn = async (side, asset, qty, slippageBps) => {
  const wait = last + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  calls++;
  const res = await fetch(`${API}/v1/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ side, asset, qty, slippageBps }) });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error ?? `API ${res.status}`), { status: res.status });
  return body as SwapQuote;
};

const legs = (q: SwapQuote | null) =>
  q ? q.route.map((l) => `${l.venue} ${n(l.qty)} ${JSON.stringify(l.execution)} total ${n(l.totalQu)} QU${l.depth ? `, ${l.depth.levelsUsed} orders` : ""}`).join("\n    ") : "-";

const started = Date.now();
const plan = await planSwap(quote, { from, to, qty: Number(qtyArg), slippageBps: Number(slipArg) });
console.log(`Swap ${n(plan.qty)} ${plan.from} -> ${plan.to}, slippage ${plan.slippageBps / 100}%  (${plan.quotesUsed} quotes, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
console.log(`  executable: ${plan.executable}${plan.problem ? `  problem: ${plan.problem.code}` : ""}`);
console.log(`  leg 1 (sell ${plan.from}):\n    ${legs(plan.sell)}`);
if (plan.sell) for (const l of plan.sell.route) console.log(`    worst case for ${l.venue}: ${n(worstLegProceedsQu(l))} QU`);
console.log(`  proceeds: expected ${n(plan.expectedProceedsQu)} QU, worst ${n(plan.worstProceedsQu)} QU, margin ${n(plan.safetyMarginQu)} QU`);
console.log(`  up front: ${n(plan.upfrontQu)} QU (share moves ${plan.upfrontIncludesShareMoves ? "included" : "not included"})`);
console.log(`  leg 2 (buy ${plan.to}) at expected:\n    ${legs(plan.buy)}`);
console.log(`  leg 2 at worst:\n    ${legs(plan.buyAtWorst)}`);
console.log(`  you get about ${n(plan.expectedOutQty)} ${plan.to}, at least ${n(plan.minOutQty)} ${plan.to}`);
console.log(`  leg 2 attaches up to ${n(plan.buyMaxOutlayQu)} QU; both legs up to ${n(plan.maxTotalOutlayQu)} QU; about ${n(plan.expectedLeftoverQu)} QU left over`);
if (plan.buy) {
  const unit = plan.buy.totalQu / plan.expectedOutQty;
  console.log(`  sanity: leg 2 average ${unit.toFixed(4)} QU per ${plan.to}; expected proceeds / that = ${n(plan.expectedProceedsQu / unit)} ${plan.to}`);
}
for (const w of plan.warnings) console.log(`  warning: ${w}`);

if (plan.executable) {
  // What happens between the legs, with live prices: leg 1 paid as expected, or only its worst case.
  const before = 1_000_000;
  for (const [label, proceeds] of [["as expected", plan.expectedProceedsQu], ["worst case", plan.worstProceedsQu], ["1,000 QU short of worst less margin", plan.worstProceedsQu - plan.safetyMarginQu - 1_000]] as const) {
    const fit = await fitBuyToBalance({ plan, balanceBeforeQu: before, balanceNowQu: before - plan.upfrontQu + proceeds, soldQty: plan.qty, quoteFn: quote });
    console.log(`  fit after leg 1 ${label} (${n(proceeds)} QU in):`, fit.ok ? `buy ${n(fit.qty)} ${plan.to}${fit.resized ? " (resized)" : ""}, attaches ${n(fit.maxOutlayQu)} of ${n(fit.budgetQu)} QU, ${fit.quotesUsed} quotes` : `refused: ${fit.reason}`);
  }
}
console.log(`  ${calls} quotes in all`);
