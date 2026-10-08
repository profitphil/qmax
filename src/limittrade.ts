import type { BookView } from "./book.ts";
import type { ExecutionPlan, TxStep } from "./exec.ts";
import { buildLimitPlan, checkLimitPlan, farFromMarket, limitProblem, placement } from "./limit.ts";
import type { Placement } from "./limit.ts";
import { summarizeOutcome } from "./verify.ts";
import type { OpenOrder, Outcome, Snapshot } from "./verify.ts";

/**
 * A limit order from start to finish, for anything that is not the website (the Discord bot, an agent): read everything it depends on now and check the plan before the wallet is asked
 * for anything, then place it and read the wallet and the book again to say what it did. It is the same flow as the website's limit order dialog, on the same plan and checks (src/limit.ts).
 */

export interface LimitRequest {
  side: "buy" | "sell";
  /** The asset's id in QMax's list (what the book is read by). */
  assetId: string;
  /** Its name on the chain, and its issuer. */
  assetName: string;
  issuer: string;
  qty: number;
  /** QU for one unit, a whole number. */
  price: number;
}

export interface LimitEnv {
  snapshot(wallet: string, issuer: string, assetName: string): Promise<Snapshot>;
  openOrders(wallet: string, issuer: string, assetName: string): Promise<OpenOrder[]>;
  /** What QX and QSwap really charge for moving shares, read from the network. */
  fees(): Promise<{ qx: number; qswap: number }>;
  /** The asset's book as the API gives it. */
  book(assetId: string): Promise<BookView>;
  run(
    wallet: string,
    steps: TxStep[],
    sign: (tx: never) => Promise<{ tx: Uint8Array }>,
    onState: (stepId: string, state: { status: string; error?: string; txId?: string }) => void,
  ): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface PreparedLimit {
  req: LimitRequest;
  plan: ExecutionPlan;
  /** What the order would do against the book as it stands now (null when the book could not be read). */
  placement: Placement | null;
  /** How far the price is from the middle of the book, in percent (positive = above); null without both sides. */
  farPct: number | null;
  balanceQu: number;
}

/** Everything the order depends on, read fresh and checked. Throws a sentence a person can read if the order cannot or should not be placed. */
export async function prepareLimitOrder(env: LimitEnv, req: LimitRequest, wallet: string): Promise<PreparedLimit> {
  const bad = limitProblem(req);
  if (bad) throw new Error(bad);
  if (!req.issuer) throw new Error(`${req.assetName} has no issuer on record, so an order cannot be placed for it.`);
  const [snap, open, fees, book] = await Promise.all([
    env.snapshot(wallet, req.issuer, req.assetName),
    env.openOrders(wallet, req.issuer, req.assetName),
    env.fees(),
    env.book(req.assetId).catch(() => null),
  ]);
  const restingAskQty = open.filter((o) => o.side === "ask").reduce((s, o) => s + o.qty, 0);
  const plan = buildLimitPlan({ side: req.side, price: req.price, qty: req.qty, assetName: req.assetName, issuer: req.issuer, fees, holdings: snap.holdings, restingAskQty });
  const check = checkLimitPlan(plan, { side: req.side, price: req.price, qty: req.qty, assetName: req.assetName, issuer: req.issuer, onChainFees: fees });
  if (check.problems.length) throw new Error(`The order does not match what you asked for, so nothing was signed: ${check.problems.join("; ")}.`);
  if (plan.maxOutlayQu > snap.balanceQu) {
    throw new Error(`Not enough QU: this order needs up to ${plan.maxOutlayQu.toLocaleString("en-US")} QU in the wallet and the wallet has ${snap.balanceQu.toLocaleString("en-US")} QU.`);
  }
  const qx = book?.qx ?? null;
  return { req, plan, placement: placement({ side: req.side, price: req.price, qty: req.qty }, qx), farPct: farFromMarket(req.price, qx?.bestBid, qx?.bestAsk), balanceQu: snap.balanceQu };
}

export interface LimitResult {
  /** Units that matched at once. */
  filledQty: number;
  /** Units now waiting on the book at this price because of this order. */
  restedQty: number;
  outcome: Outcome;
}

/** Places the order, then looks at the wallet and the book again and says what it did: matched now, waiting, or both. */
export async function executeLimitOrder(
  env: LimitEnv,
  p: PreparedLimit,
  wallet: string,
  sign: Parameters<LimitEnv["run"]>[2],
  onState: Parameters<LimitEnv["run"]>[3],
): Promise<{ ok: boolean; result: LimitResult | null }> {
  const { req } = p;
  // A fresh baseline at the moment of signing, so earlier activity is not counted.
  const [snapBefore, openBefore] = await Promise.all([env.snapshot(wallet, req.issuer, req.assetName), env.openOrders(wallet, req.issuer, req.assetName)]);
  const ok = await env.run(wallet, p.plan.steps, sign, onState);
  if (!ok) return { ok, result: null };
  let after = snapBefore;
  let open = openBefore;
  for (let attempt = 0; attempt < 5; attempt++) {
    await env.sleep(5000);
    [after, open] = await Promise.all([env.snapshot(wallet, req.issuer, req.assetName), env.openOrders(wallet, req.issuer, req.assetName)]);
    if (JSON.stringify(after) !== JSON.stringify(snapBefore) || JSON.stringify(open) !== JSON.stringify(openBefore)) break; // the wallet or the book has moved
  }
  const want = req.side === "buy" ? "bid" : "ask";
  const sum = (list: OpenOrder[]) => list.filter((o) => o.side === want && o.price === req.price).reduce((s, o) => s + o.qty, 0);
  const restedQty = Math.max(0, sum(open) - sum(openBefore));
  const outcome = summarizeOutcome({ side: req.side, requestedQty: req.qty, quotedQu: req.price * req.qty, before: snapBefore, after, openOrders: open });
  return { ok, result: { filledQty: outcome.filledQty, restedQty, outcome } };
}
