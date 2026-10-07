import { buildExecutionPlan } from "./exec.ts";
import type { ExecutableQuote, ExecutionPlan, Holdings } from "./exec.ts";
import { assetNameToU64, identityToBytes } from "./identity.ts";
import { QSWAP_INDEX, QX_INDEX } from "./rpc.ts";
import type { BookRow } from "./book.ts";

/**
 * Limit orders. QX is an order book: placing a bid or an ask at a price you choose either matches what is already resting there (at the
 * resting price, which is never worse for you than yours) or waits on the book until someone takes it, for as long as it takes or until you
 * cancel it. That is a limit order, and it is the very same transaction a market buy or sale uses, with the price chosen by the person
 * instead of worked out from the book. QSwap is a pool with no order book, so a limit order can only be placed on QX.
 *
 * Everything an order needs is fixed by the person's own inputs (price, amount, the asset and issuer from the asset list), so the plan is
 * built here, not taken from the server, and `checkLimitPlan` makes sure what the wallet is about to sign is exactly that.
 */

/** QX refuses an order whose price times its units reaches this (the most QU there can be). */
export const MAX_AMOUNT = 1_000_000_000_000_000;

export interface LimitOrder {
  side: "buy" | "sell";
  /** QU for one unit: a whole number, as QX takes no fractions. */
  price: number;
  qty: number;
}

/** Why these numbers cannot be an order, or null if they can. */
export function limitProblem(o: LimitOrder): string | null {
  if (!Number.isInteger(o.qty) || o.qty <= 0) return "Enter a whole number of units.";
  if (!Number.isInteger(o.price) || o.price <= 0) return "The price must be a whole number of QU, at least 1 (QX takes no fractions).";
  if (!Number.isSafeInteger(o.price * o.qty) || o.price * o.qty >= MAX_AMOUNT) return "That order is too large: its price times its units must stay under 1,000,000,000,000,000 QU.";
  return null;
}

/** What the order does when it reaches the book. */
export type Placement =
  /** Nothing on the other side is as good as the price: it waits. `away` is how far the price is from the best opposite price (percent; null if that side is empty). */
  | { kind: "rests"; away: number | null }
  /** Some or all of it matches at once, at the prices resting there. `restQty` is what is left to wait on the book. */
  | { kind: "fills-now"; fillQty: number; restQty: number; costQu: number; avgPrice: number; /** The rows read ran out while still matching: the real fill may be bigger. */ atLeast: boolean };

/**
 * What would happen to the order against a book as it stands: a buy takes asks at or below its price (cheapest first), a sale takes bids at or
 * above it (best first). Each match is at the price resting there, not at the order's price.
 */
export function placement(o: LimitOrder, book: { asks: BookRow[]; bids: BookRow[]; asksTotal?: { levels: number }; bidsTotal?: { levels: number } } | null): Placement | null {
  if (!book) return null;
  const rows = o.side === "buy" ? book.asks : book.bids;
  const total = o.side === "buy" ? book.asksTotal?.levels : book.bidsTotal?.levels;
  let left = o.qty;
  let cost = 0;
  let matchedAll = true;
  for (const r of rows) {
    const ok = o.side === "buy" ? r.price <= o.price : r.price >= o.price;
    if (!ok) {
      matchedAll = false;
      break;
    }
    const take = Math.min(left, r.qty);
    left -= take;
    cost += take * r.price;
    if (left <= 0) break;
  }
  const filled = o.qty - left;
  if (filled <= 0) {
    const best = rows[0]?.price;
    return { kind: "rests", away: best ? (Math.abs(o.price - best) / best) * 100 : null };
  }
  const ranOut = left > 0 && matchedAll && total !== undefined && rows.length < total;
  return { kind: "fills-now", fillQty: filled, restQty: left, costQu: cost, avgPrice: cost / filled, atLeast: ranOut };
}

/** How far a price is from the book's middle, as a percent (positive = above). Null without both sides. */
export const farFromMarket = (price: number, bestBid: number | null | undefined, bestAsk: number | null | undefined): number | null => {
  if (!(bestBid && bestAsk)) return null;
  const mid = (bestBid + bestAsk) / 2;
  return ((price - mid) / mid) * 100;
};

export interface LimitPlanInput extends LimitOrder {
  /** The asset's name as the contract knows it, and its issuer: from the asset list. */
  assetName: string;
  issuer: string;
  /** What QX and QSwap charge to take over shares, read from the network. */
  fees: { qx: number; qswap: number };
  /** The wallet's shares per managing contract. Used for a sale. */
  holdings?: Holdings;
  /** Units already offered in the wallet's other resting sell orders for this asset: they are not free to sell again. */
  restingAskQty?: number;
}

/**
 * The transactions that place the order: (a sale only) moving any shares QSwap holds over to QX, then one bid or ask on QX at the chosen
 * price. A bid attaches the most it could cost (price times units); the contract gives back whatever the match costs less than that and keeps
 * the rest locked for the part that waits. A sale attaches nothing.
 */
export function buildLimitPlan(i: LimitPlanInput): ExecutionPlan {
  const bad = limitProblem(i);
  if (bad) throw new Error(bad);
  let holdings: Holdings = {};
  if (i.side === "sell") {
    const held = i.holdings ?? {};
    const locked = Math.max(0, i.restingAskQty ?? 0);
    const qx = Math.max(0, (held[QX_INDEX] ?? 0) - locked);
    const qswap = held[QSWAP_INDEX] ?? 0;
    if (qx + qswap < i.qty) {
      throw new Error(
        `You can sell ${(qx + qswap).toLocaleString("en-US")} ${i.assetName} here, not ${i.qty.toLocaleString("en-US")}` +
          (locked > 0 ? `: ${locked.toLocaleString("en-US")} are already offered in your other open sell orders.` : "."),
      );
    }
    holdings = { [QX_INDEX]: qx, [QSWAP_INDEX]: qswap };
  }
  const quote: ExecutableQuote = {
    asset: i.assetName,
    side: i.side,
    assetInfo: { issuer: i.issuer, assetName: i.assetName, transferFeeQu: i.fees },
    route: [{ venue: "QX", qty: i.qty, execution: { type: i.side === "buy" ? "qx-bid" : "qx-ask", qty: i.qty, limitPrice: i.price } }],
  };
  const plan = buildExecutionPlan(quote, holdings);
  // The step says what it is: this is a limit order of the person's own, so the wording is theirs, not a market order's.
  for (const s of plan.steps) {
    if (s.kind === "qx-bid") s.description = `QX: bid for ${i.qty.toLocaleString("en-US")} ${i.assetName} at ${i.price.toLocaleString("en-US")} QU each (a limit order: it waits on the book for what it cannot buy now)`;
    if (s.kind === "qx-ask") s.description = `QX: offer ${i.qty.toLocaleString("en-US")} ${i.assetName} at ${i.price.toLocaleString("en-US")} QU each (a limit order: it waits on the book for what it cannot sell now)`;
  }
  return plan;
}

export interface LimitExpectation extends LimitOrder {
  assetName: string;
  issuer: string;
  onChainFees: { qx: number; qswap: number };
}

const ASK_ORDER = 5;
const BID_ORDER = 6;

/**
 * The check made before signing: the plan must be exactly this order on this asset and no more. One bid or ask, to QX, whose issuer, name,
 * price and units are the ones chosen and whose attached QU is exactly price times units (a bid) or nothing (an ask); a sale may also move
 * shares to QX, no more than the order needs, for the fee the contract really charges. Anything else is a reason not to sign.
 */
export function checkLimitPlan(plan: ExecutionPlan, e: LimitExpectation): { problems: string[] } {
  const problems: string[] = [];
  const issuer = identityToBytes(e.issuer);
  const name = assetNameToU64(e.assetName);
  const sameAsset = (p: Uint8Array) => p.length >= 40 && issuer.every((b, k) => p[k] === b) && new DataView(p.buffer, p.byteOffset + 32, 8).getBigUint64(0, true) === name;
  const wantKind = e.side === "buy" ? "qx-bid" : "qx-ask";
  const trades = plan.steps.filter((s) => s.kind !== "transfer-rights");

  if (trades.length !== 1) problems.push(`the plan has ${trades.length} order steps, not one`);
  for (const s of plan.steps) {
    if (!("contractIndex" in s.to)) {
      problems.push(`step "${s.id}" is not sent to a contract`);
      continue;
    }
    const view = new DataView(s.payload.buffer, s.payload.byteOffset, s.payload.byteLength);
    if (s.kind === wantKind) {
      if (s.to.contractIndex !== QX_INDEX) problems.push("the order is not sent to QX");
      if (s.inputType !== (e.side === "buy" ? BID_ORDER : ASK_ORDER)) problems.push("the order is a different kind of call than a QX " + (e.side === "buy" ? "bid" : "ask"));
      if (s.payload.length !== 56) problems.push("the order's data is the wrong size");
      else {
        if (!sameAsset(s.payload)) problems.push(`the order is for a different asset or issuer than ${e.assetName}`);
        if (view.getBigInt64(40, true) !== BigInt(e.price)) problems.push(`the order's price is not ${e.price.toLocaleString("en-US")} QU`);
        if (view.getBigInt64(48, true) !== BigInt(e.qty)) problems.push(`the order's units are not ${e.qty.toLocaleString("en-US")}`);
      }
      const attach = e.side === "buy" ? e.price * e.qty : 0;
      if (s.amountQu !== attach) problems.push(`the order attaches ${s.amountQu.toLocaleString("en-US")} QU, not ${attach.toLocaleString("en-US")}`);
    } else if (s.kind === "transfer-rights") {
      if (e.side !== "sell") problems.push("a buy needs no share move");
      else if (s.to.contractIndex !== QSWAP_INDEX) problems.push("a share move is not asked of QSwap");
      else if (s.payload.length !== 52 || !sameAsset(s.payload)) problems.push("a share move is for a different asset or issuer");
      else {
        if (view.getUint32(48, true) !== QX_INDEX) problems.push("a share move hands the shares to something other than QX");
        const moved = Number(view.getBigInt64(40, true));
        if (!(moved > 0 && moved <= e.qty)) problems.push(`a share move is for ${moved.toLocaleString("en-US")} units, outside what this order needs`);
        if (s.amountQu !== e.onChainFees.qx) problems.push(`a share move attaches ${s.amountQu.toLocaleString("en-US")} QU, but QX's fee is ${e.onChainFees.qx.toLocaleString("en-US")} QU`);
      }
    } else {
      problems.push(`step "${s.id}" is a ${s.kind}, which a limit order never needs`);
    }
  }
  const sum = plan.steps.reduce((t, s) => t + s.amountQu, 0);
  if (!plan.steps.every((s) => Number.isSafeInteger(s.amountQu) && s.amountQu >= 0) || sum !== plan.maxOutlayQu) problems.push("the plan's amounts do not add up to its total");
  return { problems };
}
