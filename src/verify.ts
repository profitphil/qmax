import { assetNameFromU64, assetNameToU64, bytesToHex, identityToBytes } from "./identity.ts";
import { QX_INDEX, structReader, structWriter } from "./rpc.ts";
import type { QubicRpc } from "./rpc.ts";
import type { Holdings } from "./exec.ts";

/** Wallet state for one asset at a point in time. */
export interface Snapshot {
  balanceQu: number;
  holdings: Holdings;
}

export interface OpenOrder {
  side: "bid" | "ask";
  price: number;
  qty: number;
}

const QX_FN = { entityAsks: 4, entityBids: 5 };
const ORDER_SIZE = 56; // issuer id (32) + assetName u64 + price i64 + numberOfShares i64
const PAGE = 256;

/** The wallet's resting QX orders for one asset (what is left over when a limit order is not fully matched). */
export async function fetchOpenQxOrders(
  rpc: QubicRpc,
  entity: string,
  issuer: string,
  assetName: string,
  maxOrders = 1024,
): Promise<OpenOrder[]> {
  const wantIssuer = identityToBytes(issuer);
  const wantName = assetNameToU64(assetName);
  const found: OpenOrder[] = [];
  for (const [side, fn] of [["bid", QX_FN.entityBids], ["ask", QX_FN.entityAsks]] as const) {
    for (let offset = 0; offset < maxOrders; offset += PAGE) {
      const input = structWriter(40).id(identityToBytes(entity)).u64(offset).bytes;
      const out = await rpc.query(QX_INDEX, fn, input);
      const r = structReader(out);
      let count = 0;
      for (let i = 0; i < PAGE && (i + 1) * ORDER_SIZE <= out.length; i++) {
        const base = i * ORDER_SIZE;
        const qty = r.i64(base + 48);
        const price = r.i64(base + 40);
        if (qty <= 0 || price <= 0) break;
        count++;
        const sameIssuer = wantIssuer.every((b, k) => out[base + k] === b);
        const sameName = new DataView(out.buffer, out.byteOffset + base + 32, 8).getBigUint64(0, true) === wantName;
        if (sameIssuer && sameName) found.push({ side, price, qty });
      }
      if (count < PAGE) break;
    }
  }
  return found;
}

export interface Outcome {
  status: "filled" | "partial" | "nothing" | "oversold";
  requestedQty: number;
  /** Shares actually received (buy) or sold (sell), from the wallet's share balance. */
  filledQty: number;
  /** QU actually spent (buy) or received (sell), net of everything the wallet paid, including routing fee. */
  actualQu: number;
  /** actualQu / filledQty */
  actualPriceQu: number | null;
  quotedQu: number;
  /** actual vs quote, as a fraction; positive = worse for the user. */
  slippage: number | null;
  openOrders: OpenOrder[];
  /** QU still locked in resting QX orders (not part of actualQu). */
  lockedInOrdersQu: number;
}

const total = (h: Holdings) => Object.values(h).reduce((a, b) => a + b, 0);

/** Compares wallet state before and after a trade with what was requested and quoted. */
export function summarizeOutcome(p: {
  side: "buy" | "sell";
  requestedQty: number;
  quotedQu: number;
  before: Snapshot;
  after: Snapshot;
  openOrders: OpenOrder[];
}): Outcome {
  const shareDelta = total(p.after.holdings) - total(p.before.holdings);
  const filledQty = Math.max(0, p.side === "buy" ? shareDelta : -shareDelta);
  const quDelta = p.after.balanceQu - p.before.balanceQu;
  const locked = p.openOrders.filter((o) => o.side === "bid").reduce((s, o) => s + o.price * o.qty, 0);
  // Buy: QU left the wallet (negative delta), minus what is merely parked in open bids.
  const actualQu = p.side === "buy" ? -quDelta - locked : quDelta;
  const status: Outcome["status"] =
    filledQty === 0 ? "nothing" : filledQty === p.requestedQty ? "filled" : filledQty > p.requestedQty ? "oversold" : "partial";
  const actualPriceQu = filledQty > 0 ? actualQu / filledQty : null;
  const quotedPerShare = p.quotedQu / p.requestedQty;
  const slippage =
    actualPriceQu === null || status === "partial" ? null : p.side === "buy" ? actualPriceQu / quotedPerShare - 1 : 1 - actualPriceQu / quotedPerShare;
  return { status, requestedQty: p.requestedQty, filledQty, actualQu, actualPriceQu, quotedQu: p.quotedQu, slippage, openOrders: p.openOrders, lockedInOrdersQu: locked };
}

/** One of the wallet's resting QX orders, with everything needed to cancel it. */
export interface RestingOrder {
  side: "bid" | "ask";
  price: number;
  qty: number;
  assetName: string;
  assetNameU64: bigint;
  issuerBytes: Uint8Array;
  /** `${assetNameU64}|${issuer public key hex}`, matching activityKey() so orders can be tied to catalog assets. */
  key: string;
}

/** Every resting QX order the wallet has, across all assets. */
export async function fetchAllRestingOrders(rpc: QubicRpc, entity: string, maxOrders = 1024): Promise<RestingOrder[]> {
  const found: RestingOrder[] = [];
  for (const [side, fn] of [["bid", QX_FN.entityBids], ["ask", QX_FN.entityAsks]] as const) {
    for (let offset = 0; offset < maxOrders; offset += PAGE) {
      const input = structWriter(40).id(identityToBytes(entity)).u64(offset).bytes;
      const out = await rpc.query(QX_INDEX, fn, input);
      const r = structReader(out);
      let count = 0;
      for (let i = 0; i < PAGE && (i + 1) * ORDER_SIZE <= out.length; i++) {
        const base = i * ORDER_SIZE;
        const qty = r.i64(base + 48);
        const price = r.i64(base + 40);
        if (qty <= 0 || price <= 0) break;
        count++;
        const issuerBytes = out.slice(base, base + 32);
        const assetNameU64 = new DataView(out.buffer, out.byteOffset + base + 32, 8).getBigUint64(0, true);
        found.push({ side, price, qty, assetName: assetNameFromU64(assetNameU64), assetNameU64, issuerBytes, key: `${assetNameU64}|${bytesToHex(issuerBytes)}` });
      }
      if (count < PAGE) break;
    }
  }
  return found;
}
