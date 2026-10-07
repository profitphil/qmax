import type { QuoteResponse } from "./apitypes.ts";
import { buildExecutionPlan } from "./exec.ts";
import type { ExecutionPlan, TxStep } from "./exec.ts";
import { checkQuotePlan } from "./plancheck.ts";
import { summarizeOutcome } from "./verify.ts";
import type { OpenOrder, Outcome, Snapshot } from "./verify.ts";

/** Everything the trade flow needs from the outside world, so it can be tested without a network or a wallet. Shared by the Discord bot and by agents. */
export interface TradeEnv {
  quote(req: TradeRequest): Promise<QuoteResponse>;
  snapshot(wallet: string, issuer: string, assetName: string): Promise<Snapshot>;
  openOrders(wallet: string, issuer: string, assetName: string): Promise<OpenOrder[]>;
  run(
    wallet: string,
    steps: TxStep[],
    sign: (tx: never) => Promise<{ tx: Uint8Array }>,
    onState: (stepId: string, state: { status: string; error?: string; txId?: string }) => void,
  ): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** What QX and QSwap really charge for moving shares, read from the network (not from the quote): a share move attaches it. */
  fees?(): Promise<{ qx: number; qswap: number }>;
}

export interface Prepared {
  quote: QuoteResponse;
  plan: ExecutionPlan;
  balanceQu: number;
  /** The price moved against the user by more than 0.5% since they last saw it. */
  worse: boolean;
  /** Things worth saying that are not reasons to refuse (the limits allow a much worse price than the average, say). */
  warnings?: string[];
}

export interface TradeRequest {
  side: "buy" | "sell";
  asset: string;
  qty: number;
  slippageBps: number;
  /** False to price the best single venue only (default: allow a split). */
  split?: boolean;
  /** The issuer the asset must have, from a source other than the quote (an asset list the caller already trusts). Without it only the name is checked. */
  issuer?: string;
}

/** A fresh quote and execution plan, with the same checks the web app makes before it asks for a signature. */
export async function prepareTrade(env: TradeEnv, req: TradeRequest, wallet: string, shownTotalQu?: number): Promise<Prepared> {
  const quote = await env.quote(req);
  if (!quote.fillable) throw new Error(`Only ${quote.filledQty.toLocaleString("en-US")} of ${req.qty.toLocaleString("en-US")} ${quote.asset} can be filled right now.`);
  if (!quote.executable) throw new Error(`${quote.asset} cannot be traded from here yet.`);
  const snap = await env.snapshot(wallet, quote.assetInfo.issuer, quote.assetInfo.assetName);
  // What moving shares costs comes from the network, never from the quote.
  const onChainFees = await env.fees?.().catch(() => undefined);
  const trusted = onChainFees ? { ...quote, assetInfo: { ...quote.assetInfo, transferFeeQu: onChainFees } } : quote;
  const plan = buildExecutionPlan(trusted, req.side === "sell" ? snap.holdings : {});
  // What is about to be signed must be what was asked for: this asset (and issuer, if known), this side and size, limits inside the slippage setting.
  const check = checkQuotePlan(trusted, plan, { side: req.side, qty: req.qty, assetName: req.asset.split(".")[0], issuer: req.issuer, slippageBps: req.slippageBps, onChainFees });
  if (check.problems.length) throw new Error(`QMax's answer does not match what was asked for, so nothing was signed: ${check.problems.join("; ")}.`);
  if (plan.maxOutlayQu > snap.balanceQu)
    throw new Error(
      `Not enough QU: this trade needs up to ${plan.maxOutlayQu.toLocaleString("en-US")} QU in the wallet (fees are paid in QU, even when selling) and the wallet has ${snap.balanceQu.toLocaleString("en-US")} QU.`,
    );
  const worse = shownTotalQu !== undefined && (req.side === "buy" ? quote.totalQu > shownTotalQu * 1.005 : quote.totalQu < shownTotalQu * 0.995);
  return { quote: trusted, plan, balanceQu: snap.balanceQu, worse, ...(check.warnings.length ? { warnings: check.warnings } : {}) };
}

export interface TradeResult {
  ok: boolean;
  outcome: Outcome | null;
}

/** Signs and sends the plan step by step, then reads the wallet back to report what really happened. */
export async function executeTrade(
  env: TradeEnv,
  p: Prepared,
  wallet: string,
  sign: Parameters<TradeEnv["run"]>[2],
  onState: Parameters<TradeEnv["run"]>[3],
): Promise<TradeResult> {
  const { quote, plan } = p;
  const { issuer, assetName } = quote.assetInfo;
  const before = await env.snapshot(wallet, issuer, assetName);
  const ok = await env.run(wallet, plan.steps, sign, onState);
  if (!ok) return { ok, outcome: null };
  let after = before;
  for (let attempt = 0; attempt < 4; attempt++) {
    await env.sleep(5000);
    after = await env.snapshot(wallet, issuer, assetName);
    if (JSON.stringify(after) !== JSON.stringify(before)) break; // balances have moved
  }
  const openOrders = quote.route.some((r) => r.venue === "QX") ? await env.openOrders(wallet, issuer, assetName).catch(() => []) : [];
  return { ok, outcome: summarizeOutcome({ side: quote.side, requestedQty: quote.qty, quotedQu: quote.totalQu, before, after, openOrders }) };
}
