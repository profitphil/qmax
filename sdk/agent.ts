/**
 * For agents that trade on their own. Everything here runs in the agent's own process with its own key: QMax never sees
 * a seed, and never signs for anyone. The seed signs transactions that are built from QMax's quotes, so before anything
 * is signed the plan is checked against limits the agent set. A server can name any price, so the limits are required.
 */
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper";
import type { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction";
import type { QuoteResponse } from "../src/apitypes.ts";
import type { ExecutionPlan, TxStep } from "../src/exec.ts";
import { identityToBytes } from "../src/identity.ts";
import { QPAYHUB_INDEX, payPayload } from "../src/qpay.ts";
import { QSWAP_INDEX, QX_INDEX } from "../src/rpc.ts";
import { executeTrade, prepareTrade } from "../src/trade.ts";
import type { TradeEnv, TradeResult } from "../src/trade.ts";
import { QPAYHUB_IDENTITY, resourceTag } from "../src/x402.ts";
import { PAYWALL } from "../src/config.ts";
import { fetchFees, fetchOpenOrders, fetchSnapshot } from "../web/exec/chain.ts";
import { liveChain, runSteps } from "../web/exec/run.ts";
import type { StepChain, StepState } from "../web/exec/run.ts";
import type { QMaxClient } from "./client.ts";
import { X402Error } from "./x402.ts";
import type { Payer, PayRequest } from "./x402.ts";

export type { StepChain, StepState };

/** Something that can sign a Qubic transaction. */
export interface Signer {
  /** The 60-letter identity the transactions come from. */
  identity: string;
  sign(tx: QubicTransaction): Promise<{ tx: Uint8Array }>;
}

/** A signer from a 55-letter seed. The seed stays in this process: it is not sent or logged anywhere. */
export async function seedSigner(seed: string): Promise<Signer> {
  if (!/^[a-z]{55}$/.test(seed)) throw new Error("A Qubic seed is 55 lowercase letters."); // never echo the seed back
  const id = await new QubicHelper().createIdPackage(seed);
  return { identity: id.publicId, sign: async (tx) => ({ tx: await tx.build(seed) }) };
}

/** The nonce QPayhub expects, from the ticket's 8 bytes in hex (little-endian, as the contract and the server read it). */
export const nonceFromHex = (hex: string): bigint => Buffer.from(hex, "hex").readBigUInt64LE(0);

/**
 * Pays by calling QPAYHUB.Pay, which keeps its fee, forwards the rest to the seller and files a receipt. It will only
 * ever send money to QPayhub, whatever the server says, because a plain transfer to some other address named in a 402
 * answer is exactly how an agent gets drained.
 */
export function contractPayer(signer: Signer, opts: { chain?: StepChain; onState?: (s: StepState) => void; /** Who may be paid through QPayhub. Default: QMax's own address only. */ allowedSellers?: string[] } = {}): Payer {
  const allowed = new Set(opts.allowedSellers ?? [PAYWALL.recipient]);
  return {
    name: "contract",
    async pay(req: PayRequest) {
      if (req.settlement !== "contract") throw new X402Error(`This payer only pays through QPayhub, and the server asked for "${req.settlement}".`, "payer_wrong_settlement");
      if (req.payTo !== QPAYHUB_IDENTITY) throw new X402Error("The server asked for the payment to go somewhere other than QPayhub. Not paying.", "payer_wrong_destination", { payTo: req.payTo });
      if (!req.nonceHex || !/^[0-9a-f]{16}$/.test(req.nonceHex)) throw new X402Error("The 402 answer had no usable ticket, so the payment could not be tied to this request.", "no_ticket");
      if (!req.resourceId) throw new X402Error("The 402 answer did not name what is being bought.", "no_resource");
      try {
        identityToBytes(req.sellerId);
      } catch {
        throw new X402Error("The seller in the 402 answer is not a valid Qubic identity.", "bad_seller");
      }
      // QPayhub forwards the payment to whoever the seller is, so the destination being QPayhub is not enough: the seller must be one you chose.
      if (!allowed.has(req.sellerId)) throw new X402Error(`The server asked for the payment to go to ${req.sellerId.slice(0, 8)}…, which is not a seller this payer was told it may pay. Not paying.`, "seller_not_allowed", { sellerId: req.sellerId });
      const step: TxStep = {
        id: "x402-session",
        kind: "payment",
        description: `Pay ${req.amount.toLocaleString("en-US")} QU through QPayhub for ${req.resourceId}`,
        to: { contractIndex: QPAYHUB_INDEX },
        inputType: 1,
        amountQu: req.amount,
        payload: payPayload(req.sellerId, resourceTag(req.resourceId), nonceFromHex(req.nonceHex)),
        qpay: { seller: req.sellerId, resourceId: resourceTag(req.resourceId), nonce: nonceFromHex(req.nonceHex) },
      };
      let txId: string | undefined;
      let sentTx: string | undefined;
      let moneyFlew = false;
      let error = "";
      const ok = await runSteps(
        signer.identity,
        [step],
        (tx) => signer.sign(tx),
        (_id, s) => {
          opts.onState?.(s);
          if (s.status === "confirming") sentTx = s.txId; // broadcast: it may land even if confirmation is never seen
          if (s.status === "done") ({ txId, moneyFlew } = s);
          if (s.status === "failed") error = s.error;
        },
        undefined,
        opts.chain,
      );
      if (!ok || !txId) throw new X402Error(`The payment did not go through: ${error || "unknown error"}`, "pay_failed", sentTx ? { txId: sentTx } : {});
      if (!moneyFlew) throw new X402Error("The payment was recorded but no money moved. Does the wallet have enough QU?", "pay_no_money", { txId });
      return { txId };
    },
  };
}

// ---------------------------------------------------------------------------------------------- limits

export interface TradeLimits {
  /** The most QU that may leave the wallet across the whole plan, fees included. Required. */
  maxOutlayQu: number;
  /** If set, only these assets may be traded (symbols, any case). */
  allowedAssets?: string[];
  /** Buying: the most to pay per unit in the worst case the plan allows (its limit prices). */
  maxAveragePriceQu?: number;
  /** Selling: the least to accept per unit in the worst case the plan allows. Required for a sale, because a sale's outlay is only fees. */
  minAveragePriceQu?: number;
}

/**
 * A ceiling for everything one agent may spend across all its trades, however many it runs at once. `limits.maxOutlayQu` caps one trade; without
 * this a loop (or a hundred parallel calls) could repeat it without end. Each trade holds its worst-case outlay when it passes the checks and keeps
 * it once it has been handed to the wallet to sign, so what is counted is what could have left, not what is known to have: the safe side.
 */
export class TradeBudget {
  private held = 0;
  readonly totalQu: number;
  constructor(totalQu: number) {
    if (!Number.isSafeInteger(totalQu) || totalQu <= 0) throw new Error(`A trade budget must be a whole number of QU above zero, not ${totalQu}`);
    this.totalQu = totalQu;
  }
  /** What could still be spent. */
  get remainingQu(): number {
    return this.totalQu - this.held;
  }
  /** Sets `qu` aside, or throws TradeRefused if the budget cannot cover it. Returns what undoes it (for a trade that never reached the wallet). */
  reserve(qu: number): () => void {
    if (!Number.isSafeInteger(qu) || qu < 0) throw new TradeRefused([`the plan's outlay, ${qu}, is not a whole non-negative number of QU`]);
    if (qu > this.remainingQu) throw new TradeRefused([`this trade could spend ${qu.toLocaleString("en-US")} QU and the budget has ${this.remainingQu.toLocaleString("en-US")} QU left of ${this.totalQu.toLocaleString("en-US")}`]);
    this.held += qu;
    let undone = false;
    return () => {
      if (!undone) this.held -= qu;
      undone = true;
    };
  }
}

export class TradeRefused extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Not trading: ${problems.join("; ")}`);
    this.name = "TradeRefused";
    this.problems = problems;
  }
}

const TRADE_KINDS = new Set(["transfer-rights", "qx-bid", "qx-ask", "qswap-buy", "qswap-sell"]);
const VENUES = new Set([QX_INDEX, QSWAP_INDEX]);

/** The price per unit at the worst the plan's own limits would allow: what a hostile or mistaken quote could still get you. */
export function worstCasePrice(quote: QuoteResponse): number {
  let total = 0;
  let qty = 0;
  for (const leg of quote.route) {
    const h = leg.execution;
    qty += h.qty;
    if (h.type === "qx-bid" || h.type === "qx-ask") total += h.limitPrice * h.qty;
    else if (h.type === "qswap-buy") total += h.maxQuIn;
    else total += h.minQuOut;
  }
  return qty ? total / qty : NaN;
}

/** Every reason this plan should not be signed. An empty list means it is inside the limits. */
export function checkPlan(plan: ExecutionPlan, quote: QuoteResponse, limits: TradeLimits): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(limits.maxOutlayQu) || limits.maxOutlayQu <= 0) throw new Error("limits.maxOutlayQu is required: the most QU this trade may spend.");
  if (quote.side === "sell" && !(limits.minAveragePriceQu !== undefined && limits.minAveragePriceQu >= 0)) throw new Error("limits.minAveragePriceQu is required for a sale: the least to accept per unit.");
  if (!plan.steps.length) problems.push("the plan has no steps");
  // Every figure is a whole, non-negative number, each step is inside the limit on its own (a negative one must not hide a large one in the sum),
  // and the plan's own total is the sum of its steps.
  for (const s of plan.steps) {
    if (!Number.isSafeInteger(s.amountQu) || s.amountQu < 0) problems.push(`step "${s.id}" attaches ${s.amountQu} QU, which is not a whole non-negative number`);
    else if (s.amountQu > limits.maxOutlayQu) problems.push(`step "${s.id}" alone attaches ${s.amountQu.toLocaleString("en-US")} QU, over the limit of ${limits.maxOutlayQu.toLocaleString("en-US")} QU`);
  }
  if (plan.steps.reduce((t, s) => t + s.amountQu, 0) !== plan.maxOutlayQu) problems.push("the plan's total is not the sum of its steps");
  for (const leg of quote.route) {
    const h = leg.execution;
    const figures = h.type === "qx-bid" || h.type === "qx-ask" ? [h.qty, h.limitPrice] : h.type === "qswap-buy" ? [h.qty, h.maxQuIn] : [h.qty];
    if (!figures.every((x) => Number.isSafeInteger(x) && x > 0) || !Number.isSafeInteger(leg.qty) || leg.qty <= 0) problems.push(`the ${leg.venue} leg has a quantity or limit that is not a positive whole number`);
  }
  for (const s of plan.steps) {
    if (!TRADE_KINDS.has(s.kind)) problems.push(`step "${s.id}" is a ${s.kind}, which a trade never needs`);
    if (!("contractIndex" in s.to) || !VENUES.has(s.to.contractIndex)) problems.push(`step "${s.id}" is sent somewhere other than QX or QSwap`);
  }
  if (plan.maxOutlayQu > limits.maxOutlayQu) problems.push(`it could spend ${plan.maxOutlayQu.toLocaleString("en-US")} QU, over the limit of ${limits.maxOutlayQu.toLocaleString("en-US")} QU`);
  // The asset that would be traded is the one named in the signed payload, not just the label the quote carries.
  if (limits.allowedAssets) {
    const allowed = (name: string) => limits.allowedAssets!.some((a) => a.toUpperCase() === name.toUpperCase());
    if (!allowed(quote.asset)) problems.push(`${quote.asset} is not on the allowed list`);
    if (!allowed(quote.assetInfo.assetName)) problems.push(`the quote's payload names ${quote.assetInfo.assetName}, which is not on the allowed list`);
  }
  const worst = worstCasePrice(quote);
  if (quote.side === "buy" && limits.maxAveragePriceQu !== undefined && !(worst <= limits.maxAveragePriceQu))
    problems.push(`the worst price it allows, ${worst.toFixed(4)} QU each, is above ${limits.maxAveragePriceQu} QU`);
  if (quote.side === "sell" && limits.minAveragePriceQu !== undefined && !(worst >= limits.minAveragePriceQu))
    problems.push(`the worst price it allows, ${worst.toFixed(4)} QU each, is below ${limits.minAveragePriceQu} QU`);
  return problems;
}

// ---------------------------------------------------------------------------------------------- trading

export interface AgentTradeOptions {
  client: Pick<QMaxClient, "quote">;
  signer: Signer;
  side: "buy" | "sell";
  asset: string;
  qty: number;
  limits: TradeLimits;
  /** The issuer the asset must have, from a source other than QMax's quote (an asset list you already trust). Strongly advised: without it only the name is checked. */
  issuer?: string;
  slippageBps?: number;
  /** False to price the best single venue only. */
  split?: boolean;
  /** Called as each transaction is signed, sent and confirmed. */
  onState?: (stepId: string, state: { status: string; error?: string; txId?: string }) => void;
  /** Replace how the network is read and written (tests, or another RPC). */
  chain?: StepChain;
  env?: Partial<TradeEnv>;
  /** Share one of these between every trade an agent makes, to cap what all of them together may spend. */
  budget?: TradeBudget;
}

/**
 * Quote, check, sign and send one trade, then read the wallet to say what really happened. Nothing is signed unless the
 * plan is inside `limits`; if it is not, `TradeRefused` lists why. A trade is several transactions (a share move first when
 * selling from the other venue, then one per venue), sent one at a time, stopping at the first failure.
 */
export async function agentTrade(o: AgentTradeOptions): Promise<TradeResult & { quote: QuoteResponse }> {
  const env: TradeEnv = {
    quote: (req) => o.client.quote(req),
    snapshot: fetchSnapshot,
    fees: fetchFees,
    openOrders: fetchOpenOrders,
    run: (wallet, steps, sign, onState) => runSteps(wallet, steps, sign as never, onState, undefined, o.chain ?? liveChain),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...o.env,
  };
  const prepared = await prepareTrade(env, { side: o.side, asset: o.asset, qty: o.qty, slippageBps: o.slippageBps ?? 100, split: o.split, issuer: o.issuer }, o.signer.identity);
  const problems = checkPlan(prepared.plan, prepared.quote, o.limits);
  if (problems.length) throw new TradeRefused(problems);
  // No await between the budget check and holding the amount, so trades started together cannot all pass on the same money.
  o.budget?.reserve(prepared.plan.maxOutlayQu);
  const result = await executeTrade(env, prepared, o.signer.identity, (tx: never) => o.signer.sign(tx), o.onState ?? (() => {}));
  return { ...result, quote: prepared.quote };
}
