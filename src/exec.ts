import { assetNameToU64, identityToBytes } from "./identity.ts";
import { QSWAP_INDEX, QX_INDEX, structWriter } from "./rpc.ts";
import type { RestingOrder } from "./verify.ts";

/** QSWAP_ADDITIONAL_FEE in Qswap.h: flat QU attached to every swap call. */
export const QSWAP_OPERATION_FEE_QU = 100_000;

/** What the quote API returns for each route leg (`route[i].execution`). */
export type ExecutionHint =
  | { type: "qx-bid"; qty: number; limitPrice: number }
  | { type: "qx-ask"; qty: number; limitPrice: number }
  | { type: "qswap-buy"; qty: number; maxQuIn: number }
  | { type: "qswap-sell"; qty: number; minQuOut: number };

export interface ExecutableQuote {
  asset: string;
  side: "buy" | "sell";
  assetInfo: { issuer: string; assetName: string; transferFeeQu: { qx: number; qswap: number } };
  route: { venue: string; qty: number; execution: ExecutionHint }[];
}

export interface TxStep {
  id: string;
  kind: "cancel-order" | "transfer-rights" | "qx-bid" | "qx-ask" | "qswap-buy" | "qswap-sell" | "payment" | "add-liquidity" | "remove-liquidity" | "payout";
  description: string;
  /** Destination: a smart contract (by index) or a plain identity. */
  to: { contractIndex: number } | { identity: string };
  inputType: number;
  amountQu: number;
  payload: Uint8Array;
  /** Set on a payment made through QPayhub: what the receipt is keyed by, so it can be verified afterwards. */
  qpay?: { seller: string; resourceId: Uint8Array; nonce: bigint };
}

export interface ExecutionPlan {
  steps: TxStep[];
  /** Most QU that can leave the wallet across all steps (some is refunded). */
  maxOutlayQu: number;
}

/** Shares the wallet holds per managing contract index, e.g. { 1: 500, 13: 0 }. */
export type Holdings = Record<number, number>;

const QX_PROC = { addToAskOrder: 5, addToBidOrder: 6, removeFromAskOrder: 7, removeFromBidOrder: 8, transferRights: 9 };
const QSWAP_PROC = { swapQuForExactAsset: 7, swapExactAssetForQu: 8, transferRights: 11 };

const contractFor = (venue: string) => (venue === "QX" ? QX_INDEX : QSWAP_INDEX);
const money = (n: number) => n.toLocaleString("en-US");

function assetInput(issuer: string, assetName: string, ...i64s: number[]) {
  const w = structWriter(40 + 8 * i64s.length).id(identityToBytes(issuer)).u64(assetNameToU64(assetName));
  for (const v of i64s) w.i64(v);
  return w.bytes;
}

/**
 * Turns a quote into the ordered list of transactions the user's wallet must sign:
 * (if selling) any share-management move first, then one call per venue.
 */
export function buildExecutionPlan(quote: ExecutableQuote, holdings: Holdings = {}): ExecutionPlan {
  if (!quote.assetInfo) throw new Error("This quote has no execution details: the server it came from is serving demo data, not live chain data.");
  const { issuer, assetName, transferFeeQu } = quote.assetInfo;
  const steps: TxStep[] = [];
  const sym = quote.asset;

  if (quote.side === "sell") {
    // Shares must be managed by the contract that will trade them. Pull any shortfall from the other one.
    const have: Holdings = { [QX_INDEX]: holdings[QX_INDEX] ?? 0, [QSWAP_INDEX]: holdings[QSWAP_INDEX] ?? 0 };
    const need = new Map(quote.route.map((r) => [contractFor(r.venue), r.qty]));
    const total = [...need.values()].reduce((a, b) => a + b, 0);
    if (have[QX_INDEX] + have[QSWAP_INDEX] < total)
      throw new Error(`Insufficient ${sym}: need ${money(total)}, wallet has ${money(have[QX_INDEX] + have[QSWAP_INDEX])} on QX/QSwap`);
    for (const [target, qty] of need) {
      const source = target === QX_INDEX ? QSWAP_INDEX : QX_INDEX;
      const shortfall = qty - have[target];
      if (shortfall <= 0) continue;
      // Surplus the source contract holds beyond what it still needs for its own leg.
      const surplus = have[source] - (need.get(source) ?? 0);
      if (surplus < shortfall) throw new Error(`Cannot move ${money(shortfall)} ${sym} to ${target === QX_INDEX ? "QX" : "QSwap"}: shares are not managed by QX or QSwap`);
      steps.push(rightsStep({ symbol: sym, issuer, assetName, qty: shortfall, from: source, to: target, fees: transferFeeQu, reason: `so ${target === QX_INDEX ? "QX" : "QSwap"} can sell them` }));
      have[source] -= shortfall;
      have[target] += shortfall;
    }
  }

  for (const leg of quote.route) {
    const h = leg.execution;
    switch (h.type) {
      case "qx-bid":
        steps.push({
          id: "qx-bid",
          kind: "qx-bid",
          description: `QX: buy ${money(h.qty)} ${sym}, bid up to ${money(h.limitPrice)} QU each`,
          to: { contractIndex: QX_INDEX },
          inputType: QX_PROC.addToBidOrder,
          amountQu: h.limitPrice * h.qty, // contract refunds whatever the match costs less than this
          payload: assetInput(issuer, assetName, h.limitPrice, h.qty),
        });
        break;
      case "qx-ask":
        steps.push({
          id: "qx-ask",
          kind: "qx-ask",
          description: `QX: sell ${money(h.qty)} ${sym}, asking at least ${money(h.limitPrice)} QU each`,
          to: { contractIndex: QX_INDEX },
          inputType: QX_PROC.addToAskOrder,
          amountQu: 0,
          payload: assetInput(issuer, assetName, h.limitPrice, h.qty),
        });
        break;
      case "qswap-buy":
        steps.push({
          id: "qswap-buy",
          kind: "qswap-buy",
          description: `QSwap: buy exactly ${money(h.qty)} ${sym}, paying at most ${money(h.maxQuIn)} QU`,
          to: { contractIndex: QSWAP_INDEX },
          inputType: QSWAP_PROC.swapQuForExactAsset,
          amountQu: h.maxQuIn + QSWAP_OPERATION_FEE_QU, // unused part is refunded
          payload: assetInput(issuer, assetName, h.qty),
        });
        break;
      case "qswap-sell":
        steps.push({
          id: "qswap-sell",
          kind: "qswap-sell",
          description: `QSwap: sell ${money(h.qty)} ${sym}, receiving at least ${money(h.minQuOut)} QU`,
          to: { contractIndex: QSWAP_INDEX },
          inputType: QSWAP_PROC.swapExactAssetForQu,
          amountQu: QSWAP_OPERATION_FEE_QU,
          payload: assetInput(issuer, assetName, h.qty, h.minQuOut),
        });
        break;
    }
  }

  return { steps, maxOutlayQu: steps.reduce((s, x) => s + x.amountQu, 0) };
}

/**
 * Hands the management of `qty` shares from QX to QSwap or back. It is called on the contract that manages them now,
 * and the fee goes to the contract that takes them over.
 */
export function rightsStep(p: {
  symbol: string;
  issuer: string;
  assetName: string;
  qty: number;
  from: number;
  to: number;
  fees: { qx: number; qswap: number };
  /** Why, for the person signing: "so QSwap can sell them". */
  reason?: string;
}): TxStep {
  const name = (i: number) => (i === QX_INDEX ? "QX" : "QSwap");
  return {
    // The issuer is in the id: two assets with the same name from different issuers must not collide as one step.
    id: `rights-${p.assetName}-${p.issuer.slice(0, 6)}-${p.from}-to-${p.to}`,
    kind: "transfer-rights",
    description: `Move ${money(p.qty)} ${p.symbol} from ${name(p.from)} to ${name(p.to)} management${p.reason ? ` ${p.reason}` : ""}`,
    to: { contractIndex: p.from },
    inputType: p.from === QX_INDEX ? QX_PROC.transferRights : QSWAP_PROC.transferRights,
    amountQu: p.to === QX_INDEX ? p.fees.qx : p.fees.qswap,
    payload: rightsPayload(p.issuer, p.assetName, p.qty, p.to),
  };
}

/** TransferShareManagementRights_input: Asset (issuer + name), sint64 shares, uint32 new contract index. */
function rightsPayload(issuer: string, assetName: string, shares: number, newContractIndex: number) {
  const bytes = new Uint8Array(52);
  const view = new DataView(bytes.buffer);
  bytes.set(identityToBytes(issuer), 0);
  view.setBigUint64(32, assetNameToU64(assetName), true);
  view.setBigInt64(40, BigInt(shares), true);
  view.setUint32(48, newContractIndex, true);
  return bytes;
}

/**
 * Cancels (some of) a resting QX order. It costs nothing, and for a bid the QU locked in it comes back
 * to the wallet. Pass `qty` to cancel only part of the order.
 */
export function buildCancelStep(order: RestingOrder, qty: number = order.qty): TxStep {
  const payload = new Uint8Array(56);
  const view = new DataView(payload.buffer);
  payload.set(order.issuerBytes, 0);
  view.setBigUint64(32, order.assetNameU64, true);
  view.setBigInt64(40, BigInt(order.price), true);
  view.setBigInt64(48, BigInt(qty), true);
  return {
    id: `cancel-${order.side}-${order.key}-${order.price}`,
    kind: "cancel-order",
    description: `Cancel ${order.side === "bid" ? "buy" : "sell"} order: ${money(qty)} ${order.assetName} at ${money(order.price)} QU`,
    to: { contractIndex: QX_INDEX },
    inputType: order.side === "bid" ? QX_PROC.removeFromBidOrder : QX_PROC.removeFromAskOrder,
    amountQu: 0,
    payload,
  };
}
