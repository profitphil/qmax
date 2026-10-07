import { rightsStep } from "./exec.ts";
import type { Holdings, TxStep } from "./exec.ts";
import { QSWAP_INDEX, QX_INDEX } from "./rpc.ts";

/** Which contract to keep shares under. */
export type ManageTarget = "qx" | "qswap";

export const targetIndex = (t: ManageTarget) => (t === "qx" ? QX_INDEX : QSWAP_INDEX);

/** One asset the wallet owns and, per managing contract, how many shares. */
export interface OwnedAsset {
  symbol: string;
  issuer: string;
  assetName: string;
  holdings: Holdings;
}

export interface Consolidation {
  /** One transaction per asset that has shares under the other of QX and QSwap. */
  steps: TxStep[];
  /** What the steps move, for showing the person before they sign. */
  moves: { symbol: string; qty: number; from: ManageTarget }[];
  /** Shares managed by some other contract (staked in a smart contract, say): they cannot be moved from here. */
  stuck: { symbol: string; contractIndex: number; qty: number }[];
  feeQu: number;
}

/**
 * The moves that put every asset's shares under one contract. Only QX and QSwap can be moved between: they are
 * the two venues, and a move is called on the contract that manages the shares now. Shares already under the
 * target, or managed by anything else, are left alone (the latter are reported in `stuck`).
 */
export function buildConsolidation(assets: OwnedAsset[], target: ManageTarget, fees: { qx: number; qswap: number }): Consolidation {
  const to = targetIndex(target);
  const from = to === QX_INDEX ? QSWAP_INDEX : QX_INDEX;
  const out: Consolidation = { steps: [], moves: [], stuck: [], feeQu: 0 };
  for (const a of assets) {
    const qty = a.holdings[from] ?? 0;
    if (qty > 0) {
      const step = rightsStep({ symbol: a.symbol, issuer: a.issuer, assetName: a.assetName, qty, from, to, fees });
      out.steps.push(step);
      out.moves.push({ symbol: a.symbol, qty, from: from === QX_INDEX ? "qx" : "qswap" });
      out.feeQu += step.amountQu;
    }
    for (const [idx, q] of Object.entries(a.holdings)) {
      const contractIndex = Number(idx);
      if (q > 0 && contractIndex !== QX_INDEX && contractIndex !== QSWAP_INDEX) out.stuck.push({ symbol: a.symbol, contractIndex, qty: q });
    }
  }
  return out;
}

const money = (x: number) => x.toLocaleString("en-US");

/** What keeping the shares under one contract adds to a buy, worked out from the route, for showing while the order is built. */
export function previewKeep(p: { asset: string; route: { venue: string; qty: number }[]; fees: { qx: number; qswap: number }; to: ManageTarget; /** What the wallet holds now, by managing contract index (1 = QX, 13 = QSwap): the move includes it, so it is named. */ held?: Record<number, number> }): string {
  const toName = p.to === "qx" ? "QX" : "QSwap";
  const from = p.to === "qx" ? "QSwap" : "QX";
  const qty = p.route.filter((r) => r.venue === from).reduce((a, r) => a + r.qty, 0);
  const heldQty = p.held?.[from === "QX" ? 1 : 13];
  const before = heldQty !== undefined ? `the ${money(heldQty)} ${p.asset} you already hold under ${from}` : `any ${p.asset} you already hold under ${from}`;
  if (qty === 0) return `Nothing to move for this buy: it lands under ${toName} already. ${heldQty !== undefined ? `The ${money(heldQty)}` : `Any`} ${p.asset} you already hold under ${from} would still be moved.`;
  // A QX bid can fill only in part, so the amount that arrives under QX is not known until it has.
  return `Adds one signing step after the buy: move ${from === "QX" ? "up to " : ""}${money(qty)} ${p.asset} from ${from} to ${toName} (fee about ${money(p.to === "qx" ? p.fees.qx : p.fees.qswap)} QU), plus ${before}.`;
}
