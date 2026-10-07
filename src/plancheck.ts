import { QSWAP_INDEX, QX_INDEX } from "./rpc.ts";
import type { ExecutionPlan } from "./exec.ts";
import type { QuoteResponse } from "./apitypes.ts";

/**
 * The website builds the transactions a wallet signs from what the QMax API returns. If that answer is wrong (a compromised server, a
 * man in the middle, or a plain bug) the wallet would sign it, and seed and vault logins sign without asking again. This is the check the
 * website makes before it signs, with nothing but the answer itself and what the person asked for:
 *
 *  - it is the asset, issuer, side and quantity they chose, not something else;
 *  - every transaction goes to QX or QSwap, one leg per market, for exactly the quantity routed there;
 *  - each limit is no looser than their slippage setting allows against the leg's own numbers (a limit looser than the quote could
 *    let a fill happen at a price far worse than the one shown);
 *  - the legs add up to the total shown, and share-move fees are the fees the contracts really charge (read from the network by the
 *    caller, not taken from the API).
 *
 * A server that fabricates a whole consistent lie can still show a bad price, which no check here can know: the review dialog's
 * "most that can leave your wallet" line and the post-trade read-back are the defences for that. The agent SDK has its own, stricter
 * checkPlan with limits the agent sets; this one needs none from the person.
 */

export interface PlanExpectation {
  side: "buy" | "sell";
  qty: number;
  /** The asset's name as listed (its symbol), and its issuer, from the asset list the person picked it from. */
  assetName: string;
  /** The issuer it must have. Left out when nothing independent of the quote says which issuer is meant (then only the name is checked). */
  issuer?: string;
  slippageBps: number;
  /** What QX and QSwap really charge for moving shares, read from the network. Without it a share move is refused. */
  onChainFees?: { qx: number; qswap: number };
}

export interface PlanCheck {
  /** Reasons not to sign. */
  problems: string[];
  /** Worth telling the person, not a reason to refuse. */
  warnings: string[];
}

const TRADE_KINDS = new Set(["transfer-rights", "qx-bid", "qx-ask", "qswap-buy", "qswap-sell"]);
const n = (x: number) => x.toLocaleString("en-US");
const whole = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

export function checkQuotePlan(quote: QuoteResponse, plan: ExecutionPlan, e: PlanExpectation): PlanCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const s = e.slippageBps / 10_000;

  // What they asked for.
  if (quote.side !== e.side) problems.push(`the quote is for a ${quote.side}, not a ${e.side}`);
  if (quote.qty !== e.qty) problems.push(`the quote is for ${n(quote.qty)}, not the ${n(e.qty)} you asked for`);
  if (String(quote.assetInfo?.assetName).toUpperCase() !== e.assetName.toUpperCase()) problems.push(`the quote is for asset '${quote.assetInfo?.assetName}', not '${e.assetName}'`);
  if (e.issuer !== undefined && quote.assetInfo?.issuer !== e.issuer) problems.push(`the quote is for a different issuer of ${e.assetName} than the one you chose (${String(quote.assetInfo?.issuer).slice(0, 8)}… instead of ${e.issuer.slice(0, 8)}…)`);
  if (typeof quote.asset !== "string" || quote.asset.toUpperCase().split(".")[0] !== e.assetName.toUpperCase()) problems.push(`the quote is labelled '${quote.asset}', which is not ${e.assetName}`);

  // The legs.
  const venues = new Set<string>();
  let routed = 0;
  let totals = 0;
  for (const leg of quote.route) {
    const h = leg.execution;
    if (leg.venue !== "QX" && leg.venue !== "QSwap") {
      problems.push(`a leg goes to '${leg.venue}', which is not QX or QSwap`);
      continue;
    }
    if (venues.has(leg.venue)) problems.push(`two legs on ${leg.venue}`);
    venues.add(leg.venue);
    const want = leg.venue === "QX" ? (e.side === "buy" ? "qx-bid" : "qx-ask") : e.side === "buy" ? "qswap-buy" : "qswap-sell";
    if (h?.type !== want) {
      problems.push(`the ${leg.venue} leg would ${h?.type}, not ${want}`);
      continue;
    }
    if (!whole(leg.qty) || !whole(h.qty) || h.qty !== leg.qty) problems.push(`the ${leg.venue} leg routes ${n(leg.qty)} but would trade ${n(h.qty)} (every quantity must be a positive whole number)`);
    const limits = h.type === "qx-bid" || h.type === "qx-ask" ? [h.limitPrice] : h.type === "qswap-buy" ? [h.maxQuIn] : [];
    if (!limits.every(whole) || (h.type === "qswap-sell" && !(Number.isSafeInteger(h.minQuOut) && h.minQuOut >= 0))) problems.push(`the ${leg.venue} leg has a limit that is not a whole number of QU`);
    routed += leg.qty;
    totals += leg.totalQu;

    // The limit may be tighter than the quote allows for, never looser.
    if (h.type === "qx-bid" || h.type === "qx-ask") {
      const worst = leg.priceRangeQu?.worst;
      if (!(typeof worst === "number" && worst >= 1)) {
        problems.push("the QX leg gives no worst price to check its limit against");
      } else if (h.type === "qx-bid") {
        const most = Math.ceil(worst * (1 + s));
        if (!(h.limitPrice <= most + 1)) problems.push(`the QX bid limit ${n(h.limitPrice)} QU is looser than the ${n(most)} QU your ${e.slippageBps / 100}% slippage allows`);
      } else {
        const least = Math.max(1, Math.floor(worst * (1 - s)));
        if (!(h.limitPrice >= least - 1)) problems.push(`the QX ask limit ${n(h.limitPrice)} QU is looser than the ${n(least)} QU your ${e.slippageBps / 100}% slippage allows`);
      }
    } else if (h.type === "qswap-buy") {
      const most = Math.ceil((leg.totalQu - leg.fixedCostQu) * (1 + s));
      if (!(h.maxQuIn <= most + 1)) problems.push(`the QSwap buy would pay up to ${n(h.maxQuIn)} QU, more than the ${n(most)} QU your ${e.slippageBps / 100}% slippage allows`);
    } else {
      const least = Math.floor((leg.totalQu + leg.fixedCostQu) * (1 - s));
      if (!(h.minQuOut >= least - 1)) problems.push(`the QSwap sale would accept as little as ${n(h.minQuOut)} QU, less than the ${n(least)} QU your ${e.slippageBps / 100}% slippage allows`);
    }
  }
  if (quote.route.length === 0) problems.push("the quote has no legs");
  if (routed !== e.qty) problems.push(`the legs add up to ${n(routed)}, not ${n(e.qty)}`);
  if (Math.abs(totals - quote.totalQu) > quote.route.length + 1) problems.push(`the legs add up to ${n(totals)} QU but the total shown is ${n(quote.totalQu)} QU`);

  // The transactions themselves: each amount a whole, non-negative number, and the plan's total the sum of them (a negative step would hide another).
  const stepTotal = plan.steps.reduce((t, st) => t + st.amountQu, 0);
  if (!plan.steps.every((st) => Number.isSafeInteger(st.amountQu) && st.amountQu >= 0) || stepTotal !== plan.maxOutlayQu) problems.push("the plan's amounts are not whole non-negative numbers adding up to its total");
  for (const st of plan.steps) {
    if (!TRADE_KINDS.has(st.kind)) problems.push(`step "${st.id}" is a ${st.kind}, which a trade never needs`);
    if (!("contractIndex" in st.to) || (st.to.contractIndex !== QX_INDEX && st.to.contractIndex !== QSWAP_INDEX)) problems.push(`step "${st.id}" is sent somewhere other than QX or QSwap`);
    if (st.kind === "transfer-rights") {
      // Moving shares is paid to the contract that takes them over: the amount must be that contract's real fee.
      if (!e.onChainFees) problems.push(`step "${st.id}" moves shares and its fee could not be read from the network, so it cannot be checked`);
      else if (st.amountQu !== e.onChainFees.qx && st.amountQu !== e.onChainFees.qswap) problems.push(`step "${st.id}" attaches ${n(st.amountQu)} QU, but the contracts' fees are ${n(e.onChainFees.qx)} and ${n(e.onChainFees.qswap)} QU`);
    }
  }
  if (!plan.steps.length) problems.push("the plan has no steps");

  // Not a refusal, but worth saying: how much worse than the total shown the limits allow.
  const expected = quote.totalQu;
  if (e.side === "buy" && expected > 0 && plan.maxOutlayQu > expected * (1 + s) * 1.25 + 1) {
    warnings.push(`The limits allow up to ${n(plan.maxOutlayQu)} QU to leave your wallet, against an expected ${n(expected)} QU: the worst price on the way is much worse than the average. A lower slippage tightens it.`);
  }
  return { problems, warnings };
}
