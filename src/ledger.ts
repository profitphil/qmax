import { activityKey } from "./activity.ts";
import { QX_CONTRACT, scanTrades } from "./events.ts";
import type { Trade } from "./events.ts";
import type { QubicRpc } from "./rpc.ts";
import { Raw, RouteError, oneOf, plainNumber, required } from "./routes.ts";
import type { Route } from "./routes.ts";

/**
 * A wallet's trade ledger, rebuilt from the public archive: what it bought and sold on QX and QSwap, at what price, what it
 * paid in fees, and its profit by the average cost method.
 *
 * How a trade is found (checked on real wallets, see scripts/ledger-check.ts):
 * - Every QU transfer (event type 0) and share ownership change (type 2) the wallet was part of is read with one query
 *   (`should: source OR destination`), then grouped by transaction. Possession changes (type 3) are not read: in every real
 *   trade they mirror the ownership change exactly, and ownership is what the wallet economically holds.
 * - In one transaction, units of an asset moving one way and QU the other way is a trade. Starting from the wallet's events
 *   (not its own transactions) is what catches a QX maker: a resting order filled by someone else's transaction leaves
 *   events under THAT transaction.
 * - The venue comes from the counterparty: shares to or from the QSwap contract identity are a QSwap swap, QU to or from the
 *   QX contract identity is a QX fill. No extra request is needed for that.
 * - Two QX cases need more than the wallet's own events. (1) A buy order locks `price x quantity` QU when it is placed; what
 *   does not fill at once stays locked, so the wallet's QU change overstates the cost. The order's own price and quantity
 *   (read from the wallet's transaction list) give the locked part exactly. (2) When the wallet's resting buy order is
 *   filled by a seller, only the shares arrive (the QU left when the order was placed), so the price is read from QX's
 *   trade message in that transaction. Those lookups are grouped by tick range and capped.
 *
 * Fees: QX takes 0.3% (+1 QU) from the seller only; QSwap takes 0.3% of the QU side, plus a flat 100,000 QU per swap since
 * epoch 215. Fees are included in each trade's QU (a buy's cost, a sell's proceeds) and also estimated separately.
 */

/* ---------- constants ---------- */

/** Contract identities, as they appear in the archive's events (checked against real QX and QSwap trades). */
export const QX_ID = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARMID";
export const QSWAP_ID = "NAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAML";
const QSWAP_INDEX = 13;

/** QSwap keeps this many QU from every successful swap (QSWAP_ADDITIONAL_FEE in Qswap.h). */
export const QSWAP_FLAT_FEE = 100_000;
/**
 * The first epoch with that flat fee. Measured on the archive: every swap up to the end of epoch 214 put the whole payment into
 * the pool, every swap from the start of epoch 215 (2026-05-27 12:00 UTC) kept 100,000 QU of it.
 */
export const QSWAP_FLAT_FEE_EPOCH = 215;
export const qswapFlatFee = (epoch: number) => (epoch >= QSWAP_FLAT_FEE_EPOCH ? QSWAP_FLAT_FEE : 0);
/** QSwap's swap fee: 30 / 10,000 = 0.3% of the QU side (swapFeeRate in Qswap.h; it can be changed by its shareholders). */
const QSWAP_FEE_RATE = 30;
/** QX's trade fee in billionths, paid by the seller (Qx.h `_tradeFee`, 0.3% since epoch 138). */
const QX_TRADE_FEE = 3_000_000n;

/** QX procedures (input types) that matter here. */
const QX_TRANSFER = 2;
const QX_ADD_ASK = 5;
const QX_ADD_BID = 6;
const QX_REMOVE_ASK = 7;
const QX_REMOVE_BID = 8;
const QX_MANAGEMENT = 9;
/** QSwap procedures. */
const QSWAP_ADD_LIQUIDITY = 4;
const QSWAP_REMOVE_LIQUIDITY = 5;
const QSWAP_BUYS = [6, 7];
const QSWAP_SELLS = [8, 9];
const QSWAP_MANAGEMENT = 11;

const PAGE = 1000; // the Query API allows at most 1000 per page
const MAX_HITS = 10_000; // and will not page past this per query
const DAY = 86_400_000;
/** QX fills are looked up for candidates this close together in one query (about 3.5 days, a few hundred QX trades). */
const FILL_CLUSTER_TICKS = 600_000;
/** At most this many checks for gaps in the archive's event log per ledger. */
const GAP_PROBES = 4;

/* ---------- archive shapes ---------- */

/** One event as the archive's getEventLogs returns it (only the fields used here). */
export interface WalletEvent {
  epoch: number;
  tickNumber: number;
  /** ms since epoch, as a string */
  timestamp: string;
  /** Missing for events a contract caused on its own (dividends and other distributions at the start or end of a tick). */
  transactionHash?: string;
  logType: number;
  logId: string;
  quTransfer?: { source: string; destination: string; amount: string };
  assetOwnershipChange?: { source: string; destination: string; assetIssuer: string; assetName: string; numberOfShares: string };
}

/** One transaction the wallet sent, as getTransactionsForIdentity returns it. */
export interface WalletTx {
  hash: string;
  source: string;
  destination: string;
  amount: string;
  tickNumber: number;
  timestamp: string;
  inputType: number;
  inputData?: string;
  moneyFlew?: boolean;
}

/** One QX fill from QX's trade message: which transaction, where in it, which asset (`activityKey`), at what price. */
export interface QxFill {
  logId: number;
  key: string;
  price: number;
  qty: number;
}

/* ---------- ledger shapes ---------- */

export interface LedgerAsset {
  /** `NAME|ISSUER_IDENTITY`: two issuers can use the same name, so the issuer is part of the key. */
  key: string;
  symbol: string;
  issuer: string;
}

export type EntryKind = "buy" | "sell" | "transfer-in" | "transfer-out" | "other";

export interface LedgerEntry {
  /** ms since epoch (UTC) */
  t: number;
  tick: number;
  /** The transaction hash, or `tick:<n>` for events a contract caused without a transaction. */
  tx: string;
  kind: EntryKind;
  /** Where a trade happened. Missing for transfers. */
  venue?: "QX" | "QSwap" | "unknown";
  /** Missing for QU-only operations (a QX buy order placed or cancelled, a management fee). */
  asset?: LedgerAsset;
  /** Units bought, sold or moved (never negative; the direction is in `kind`). 0 for QU-only operations. */
  qty: number;
  /** How the wallet's QU balance changed in this transaction (exact; negative = paid). */
  quNet: number;
  /**
   * What the units cost (buy) or fetched (sell), fees included. It differs from `quNet` when QU was locked in or released from
   * a QX buy order (`escrowQu`), and can be negative for a tiny QSwap sale whose proceeds did not cover the flat fee. Null for
   * anything that is not a trade.
   */
  valueQu: number | null;
  /** QU per unit, fees included (`valueQu / qty`). Null for anything that is not a trade. */
  price: number | null;
  /** Fees included in this entry, estimated from the venues' fee rules. Null when not known. */
  feeQu: number | null;
  /** QU locked in (+) or released from (-) the wallet's resting QX buy orders by this transaction. */
  escrowQu?: number;
  /** Units of this asset the ledger says the wallet holds after this entry. */
  position: number | null;
  /** Profit or loss realized by this sale (average cost), or null when none or when the units' cost is not known. */
  realizedQu: number | null;
  note?: string;
}

export interface LedgerPosition {
  asset: LedgerAsset;
  /** Units held at the end, as far as this window shows. */
  held: number;
  /** Of `held`, the units bought inside the window, whose cost is known. */
  costedQty: number;
  /** Average cost per unit of `costedQty`, fees included. */
  avgCost: number | null;
  costQu: number;
  realizedQu: number;
  /** QU from selling units whose cost the window does not show (bought earlier, or received by transfer). Not in `realizedQu`. */
  uncostedProceedsQu: number;
  /** Current price per unit (QMax's mid or pool price), null when unknown. */
  priceQu: number | null;
  valueQu: number | null;
  /** (price - average cost) x costed units. Null without a price or without costed units. */
  unrealizedQu: number | null;
  unrealizedPct: number | null;
  feesQu: number;
  bought: number;
  sold: number;
  spentQu: number;
  receivedQu: number;
  trades: number;
  /** Units sold or sent that never arrived inside the window. */
  preWindowQty: number;
}

export interface LedgerTotals {
  trades: number;
  buys: number;
  sells: number;
  spentQu: number;
  receivedQu: number;
  realizedQu: number;
  /** Sum over positions that have both costed units and a current price; null when there is none. */
  unrealizedQu: number | null;
  /** Positions with units held but no current price (so not in `unrealizedQu`). */
  unpricedPositions: number;
  /** Every fee estimated: trading fees plus QX/QSwap transfer and share-management fees. */
  feesQu: number;
  tradeFeesQu: number;
  otherFeesQu: number;
  uncostedProceedsQu: number;
  /** Net QU this window locked in (+) or released from (-) QX buy orders. */
  escrowQu: number;
}

/** QU that moved but is not a trade, counted so the ledger can say what it leaves out. */
export interface Excluded {
  /** QU received from contracts: dividends, rewards, refunds (not QX or QSwap trades). */
  contractIncome: { count: number; qu: number };
  /** QU sent to contracts other than QX and QSwap trades (QPayhub payments, for example). */
  contractPayments: { count: number; qu: number };
  /** QU from and to other wallets. */
  transfersIn: { count: number; qu: number };
  transfersOut: { count: number; qu: number };
  /** Transactions where nothing changed for the wallet (an order refunded in full, a failed swap). */
  noChange: number;
}

export interface Ledger {
  identity: string;
  /** The window asked for, ms since epoch. */
  fromMs: number;
  toMs: number;
  /** The window actually covered (later than `fromMs` when truncated). */
  coveredFromMs: number;
  generatedAt: number;
  method: "average-cost";
  /** What the numbers are and what they leave out, in plain words (the same for every ledger). */
  notes: string[];
  entries: LedgerEntry[];
  positions: LedgerPosition[];
  totals: LedgerTotals;
  excluded: Excluded;
  /** True when the work stopped early; `truncatedReasons` says what was left out. */
  truncated: boolean;
  truncatedReasons: string[];
  warnings: string[];
  /** Archive requests used to build this. */
  requests: number;
}

/* ---------- small helpers ---------- */

/** The contract index an identity belongs to, or null for an ordinary wallet. A contract's public key is its index, then zeros. */
export function contractIndexOf(id: string): number | null {
  if (!/^[A-Z]{60}$/.test(id) || !/^A{42}$/.test(id.slice(14, 56))) return null;
  let v = 0;
  for (let j = 13; j >= 0; j--) v = v * 26 + (id.charCodeAt(j) - 65);
  return v < 1_000_000 ? v : null;
}

/** A Qubic identity: 60 uppercase letters (the last four are a checksum, not checked here). */
export const isIdentity = (s: string) => /^[A-Z]{60}$/.test(s);

/** QX's fee on a fill worth `value` QU, exactly as Qx.h computes it (rounded down, plus one; a coarser formula for huge fills). */
export function qxFee(value: number): number {
  const v = BigInt(value);
  const huge = v >= 9_223_372_036_854_775_807n / QX_TRADE_FEE;
  return Number(huge ? v / (1_000_000_000n / QX_TRADE_FEE) + 1n : (v * QX_TRADE_FEE) / 1_000_000_000n + 1n);
}

/**
 * The value of a QX fill (price x quantity) from what the seller received after QX's fee, or null if no whole price fits.
 * Two values can leave the same net amount, exactly where the fee's rounding steps: a round value (600,000,000) and the one
 * below it. The higher one is taken because round prices are the common case (on real sales it was right 4 times out of 4);
 * when wrong, the fee is 1 QU too high.
 */
export function qxGrossFromNet(net: number, qty: number): number | null {
  if (!(net > 0) || !(qty > 0)) return null;
  const guess = Math.floor(net / 0.997 / qty);
  for (let p = guess + 2; p >= Math.max(1, guess - 2); p--) if (p * qty - qxFee(p * qty) === net) return p * qty;
  return null;
}

/**
 * QSwap's fee estimate for a buy that cost `value` QU in all: the flat fee plus 0.3% of what went into the pool (the AMM formula
 * prices the trade on the input less 0.3%; the contract's 100 QU minimum only changes how it splits the fee, not the price).
 */
export function qswapBuyFee(value: number, epoch: number): number {
  const flat = qswapFlatFee(epoch);
  const quIn = value - flat;
  if (quIn <= 0) return Math.max(0, value);
  return flat + Math.floor((quIn * QSWAP_FEE_RATE) / 10_000);
}

/** QSwap's fee estimate for a sale whose net proceeds were `value`: the flat fee plus 0.3% of the QU before QSwap's cut. */
export function qswapSellFee(value: number, epoch: number): number {
  const flat = qswapFlatFee(epoch);
  const payout = Math.max(0, value + flat);
  return flat + Math.round((payout * QSWAP_FEE_RATE) / (10_000 - QSWAP_FEE_RATE));
}

/** Six decimals is plenty for QU and keeps averages free of floating-point noise. */
const tidy = (x: number) => Math.round(x * 1e6) / 1e6;

const safeInt = (s: string | undefined): number | null => {
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** The price and quantity of a QX order, from the transaction's input (issuer, asset name, price, number of shares). */
function orderInput(tx: WalletTx): { key: string; price: number; qty: number } | null {
  if (!tx.inputData) return null;
  const b = Buffer.from(tx.inputData, "base64");
  if (b.length < 56) return null;
  const price = Number(b.readBigInt64LE(40));
  const qty = Number(b.readBigInt64LE(48));
  if (!(price > 0) || !(qty > 0)) return null;
  return { key: `${b.readBigUInt64LE(32)}|${b.subarray(0, 32).toString("hex")}`, price, qty };
}

/** The `activityKey` form of an asset (what QX's own messages use), or null for a name QX could not trade. */
function tradeKeyOf(a: LedgerAsset): string | null {
  try {
    return activityKey(a.symbol, a.issuer);
  } catch {
    return null;
  }
}

/* ---------- grouping ---------- */

interface Flow {
  logId: number;
  cp: string;
  /** Signed from the wallet's view. */
  amount: number;
}
interface Move {
  logId: number;
  cp: string;
  asset: LedgerAsset;
  /** Signed from the wallet's view; 0 for a move from the wallet to itself. */
  qty: number;
  /** Units moved from the wallet to itself (QX matching the wallet's own orders), else 0. */
  selfQty: number;
}
interface Group {
  id: string;
  hash?: string;
  epoch: number;
  tick: number;
  t: number;
  firstLog: number;
  qu: Flow[];
  moves: Move[];
}

/** Gathers the wallet's events by transaction (events without one, by tick and contract), ignoring repeats. */
function groupEvents(events: WalletEvent[], identity: string, warnings: string[]): Group[] {
  const groups = new Map<string, Group>();
  const seen = new Set<string>();
  let unreadable = 0;
  for (const e of events) {
    const id = `${e.tickNumber}:${e.logId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const logId = Number(e.logId);
    let cp: string;
    let flow: Flow | undefined;
    let move: Move | undefined;
    if (e.logType === 0 && e.quTransfer) {
      const { source, destination } = e.quTransfer;
      const amount = safeInt(e.quTransfer.amount);
      if (amount === null) {
        unreadable++;
        continue;
      }
      if (source === identity && destination === identity) continue; // to itself: nothing changes
      if (destination === identity) (cp = source), (flow = { logId, cp, amount });
      else if (source === identity) (cp = destination), (flow = { logId, cp, amount: -amount });
      else continue;
    } else if (e.logType === 2 && e.assetOwnershipChange) {
      const c = e.assetOwnershipChange;
      const qty = safeInt(c.numberOfShares);
      if (qty === null) {
        unreadable++;
        continue;
      }
      const asset = { key: `${c.assetName}|${c.assetIssuer}`, symbol: c.assetName, issuer: c.assetIssuer };
      if (c.source === identity && c.destination === identity) (cp = identity), (move = { logId, cp, asset, qty: 0, selfQty: qty });
      else if (c.destination === identity) (cp = c.source), (move = { logId, cp, asset, qty, selfQty: 0 });
      else if (c.source === identity) (cp = c.destination), (move = { logId, cp, asset, qty: -qty, selfQty: 0 });
      else continue;
    } else continue;

    const gid = e.transactionHash || `tick:${e.tickNumber}:${cp}`;
    let g = groups.get(gid);
    if (!g) groups.set(gid, (g = { id: gid, hash: e.transactionHash || undefined, epoch: e.epoch, tick: e.tickNumber, t: Number(e.timestamp), firstLog: logId, qu: [], moves: [] }));
    g.firstLog = Math.min(g.firstLog, logId);
    if (flow) g.qu.push(flow);
    if (move) g.moves.push(move);
  }
  if (unreadable) warnings.push(`${unreadable} events had amounts that could not be read exactly and were left out.`);
  return [...groups.values()].sort((a, b) => a.tick - b.tick || a.firstLog - b.firstLog);
}

/* ---------- classification ---------- */

interface Context {
  identity: string;
  ownTxs: Map<string, WalletTx>;
  fills: Map<string, QxFill[]>;
  excluded: Excluded;
  unchecked: number;
}

const isQx = (id: string) => id === QX_ID || contractIndexOf(id) === QX_CONTRACT;
const isQswap = (id: string) => id === QSWAP_ID || contractIndexOf(id) === QSWAP_INDEX;

function base(g: Group, quNet: number): Omit<LedgerEntry, "kind" | "qty"> {
  return { t: g.t, tick: g.tick, tx: g.hash ?? `tick:${g.tick}`, quNet, valueQu: null, price: null, feeQu: null, position: null, realizedQu: null };
}

function trade(g: Group, quNet: number, kind: "buy" | "sell", venue: "QX" | "QSwap" | "unknown", asset: LedgerAsset, qty: number, valueQu: number, feeQu: number | null, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return { ...base(g, quNet), kind, venue, asset, qty, valueQu, price: tidy(valueQu / qty), feeQu, ...extra };
}

function transfer(g: Group, quNet: number, asset: LedgerAsset, units: number, note?: string, feeQu: number | null = null): LedgerEntry {
  return { ...base(g, quNet), kind: units > 0 ? "transfer-in" : "transfer-out", asset, qty: Math.abs(units), feeQu, ...(note ? { note } : {}) };
}

/** QU that is not part of a trade: counted by kind, not listed. */
function exclude(g: Group, ctx: Context) {
  for (const f of g.qu) {
    const contract = !g.hash || contractIndexOf(f.cp) !== null;
    const bucket = contract ? (f.amount > 0 ? ctx.excluded.contractIncome : ctx.excluded.contractPayments) : f.amount > 0 ? ctx.excluded.transfersIn : ctx.excluded.transfersOut;
    bucket.count++;
    bucket.qu += Math.abs(f.amount);
  }
}

/** A QX or QSwap transaction that moved QU but no shares: an order placed or cancelled, a fee. */
function quOnly(g: Group, quNet: number, own: WalletTx | undefined, onQx: boolean, ctx: Context): LedgerEntry | null {
  if (quNet === 0) {
    ctx.excluded.noChange++;
    return null;
  }
  const type = own?.inputType;
  const entry = (note: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ ...base(g, quNet), kind: "other", venue: onQx ? "QX" : "QSwap", qty: 0, note, ...extra });
  if (onQx && type === QX_ADD_BID) return entry("QX buy order placed: the QU stays locked in the order until it fills or is cancelled.", { escrowQu: -quNet });
  if (onQx && type === QX_REMOVE_BID) return entry("QX buy order cancelled: locked QU returned.", { escrowQu: -quNet });
  if ((onQx && type === QX_MANAGEMENT) || (!onQx && type === QSWAP_MANAGEMENT)) return entry("Shares moved between QX and QSwap management (fee).", { feeQu: Math.max(0, -quNet) });
  if (onQx && type === QX_TRANSFER) return entry("QX share transfer fee (the transfer did not go through).", { feeQu: Math.max(0, -quNet) });
  if (onQx && (type === QX_ADD_ASK || type === QX_REMOVE_ASK)) return entry("QX sell order (nothing filled).");
  return entry(onQx ? "Other QX operation." : "Other QSwap operation.", quNet < 0 ? { feeQu: -quNet } : {});
}

/**
 * The units of a QX maker buy (the wallet's resting buy order filled by a seller): each share movement is matched to the QX
 * trade message that follows it in the same transaction, which carries the price.
 */
function makerBuy(g: Group, asset: LedgerAsset, moves: Move[], ctx: Context): LedgerEntry[] {
  const fills = ctx.fills.get(g.hash!);
  const units = moves.reduce((s, m) => s + m.qty, 0);
  if (!fills) {
    ctx.unchecked++;
    return [transfer(g, 0, asset, units, "Shares received from another wallet. Not checked against QX fills (lookup limit), so it may be a filled buy order.")];
  }
  const want = tradeKeyOf(asset);
  const used = new Set<QxFill>();
  let qty = 0;
  let value = 0;
  for (const m of [...moves].sort((a, b) => a.logId - b.logId)) {
    const f = fills.filter((x) => !used.has(x) && x.key === want && x.qty === m.qty && x.logId > m.logId).sort((a, b) => a.logId - b.logId)[0];
    if (!f) continue;
    used.add(f);
    qty += f.qty;
    value += f.price * f.qty;
  }
  const out: LedgerEntry[] = [];
  if (qty > 0) out.push(trade(g, 0, "buy", "QX", asset, qty, value, 0, { escrowQu: -value, note: "Your resting QX buy order was filled; the QU was locked when the order was placed." }));
  if (units - qty > 0) out.push(transfer(g, 0, asset, units - qty, "Shares received from another wallet (not a QX fill)."));
  return out;
}

/** QX's fee on the wallet's sales in this transaction: each payment from QX is matched to the share movement right after it. */
function qxSellFees(g: Group, key: string): number | null {
  const events = [...g.qu.map((f) => ({ logId: f.logId, f })), ...g.moves.map((m) => ({ logId: m.logId, m }))].sort((a, b) => a.logId - b.logId);
  let pending: number | null = null;
  let fee = 0;
  let paired = 0;
  for (const e of events) {
    if ("f" in e && e.f && isQx(e.f.cp) && e.f.amount > 0) pending = e.f.amount;
    else if ("m" in e && e.m && e.m.asset.key === key && e.m.qty < 0) {
      const gross = pending === null ? null : qxGrossFromNet(pending, -e.m.qty);
      if (gross === null) return null;
      fee += gross - pending!;
      pending = null;
      paired++;
    }
  }
  return paired ? fee : null;
}

/** Turns one transaction's events into ledger entries (none for QU that is not a trade; those are only counted). */
function classify(g: Group, ctx: Context): LedgerEntry[] {
  const quNet = g.qu.reduce((s, f) => s + f.amount, 0);
  const units = new Map<string, { asset: LedgerAsset; net: number; moves: Move[]; self: number }>();
  for (const m of g.moves) {
    const u = units.get(m.asset.key) ?? { asset: m.asset, net: 0, moves: [], self: 0 };
    if (m.selfQty) u.self += m.selfQty;
    else (u.net += m.qty), u.moves.push(m);
    units.set(m.asset.key, u);
  }
  const moved = [...units.values()].filter((u) => u.net !== 0);
  const own = g.hash ? ctx.ownTxs.get(g.hash) : undefined;
  const ownDest = own ? contractIndexOf(own.destination) : null;
  const cps = [...g.qu.map((f) => f.cp), ...g.moves.map((m) => m.cp)];
  const onQswap = !!g.hash && (ownDest === QSWAP_INDEX || cps.some(isQswap));
  const onQx = !!g.hash && !onQswap && (ownDest === QX_CONTRACT || cps.some(isQx));

  // Events a contract caused without a transaction: distributions. Shares that arrive are transfers in (carrying any QU paid
  // with them); QU alone is income, counted but not listed. QU shown on an entry is never also counted as excluded.
  if (!g.hash) {
    if (!moved.length) {
      exclude(g, ctx);
      return [];
    }
    const from = contractIndexOf(g.moves[0]?.cp ?? "");
    const note = from === null ? "Moved without a transaction (a contract distribution)." : `Sent by contract ${from} without a transaction (a distribution).`;
    return moved.map((u, i) => transfer(g, i === 0 ? quNet : 0, u.asset, u.net, note));
  }

  if (moved.length === 0) {
    const selfTrade = [...units.values()].find((u) => u.self > 0);
    if (onQx && selfTrade && quNet < 0) return [{ ...base(g, quNet), kind: "other", venue: "QX", asset: selfTrade.asset, qty: 0, feeQu: -quNet, note: "Your QX order matched your own order: only the fee changed hands." }];
    if (onQx || onQswap) return [quOnly(g, quNet, own, onQx, ctx)].filter((e): e is LedgerEntry => e !== null);
    if (quNet === 0 && g.qu.length === 0) return [];
    exclude(g, ctx);
    return [];
  }

  // Several assets in one transaction: the QU cannot be split between them, so each is listed as a transfer.
  if (moved.length > 1) {
    return moved.map((u, i) => transfer(g, i === 0 ? quNet : 0, u.asset, u.net, "Several assets moved in one transaction; listed as transfers because the QU cannot be split between them."));
  }

  const { asset, net, moves } = moved[0];
  const qty = Math.abs(net);

  if (onQswap) {
    const type = own?.inputType;
    if (type === QSWAP_ADD_LIQUIDITY || type === QSWAP_REMOVE_LIQUIDITY || (net > 0 && quNet > 0) || (!own && net < 0 && quNet <= 0))
      return [transfer(g, quNet, asset, net, net < 0 ? "Added to a QSwap pool as liquidity (the QU sent with it is not a cost)." : "Taken out of a QSwap pool (liquidity removed).")];
    if (net > 0 && (type === undefined || QSWAP_BUYS.includes(type))) return [trade(g, quNet, "buy", "QSwap", asset, qty, -quNet, qswapBuyFee(-quNet, g.epoch))];
    if (net < 0 && (type === undefined || QSWAP_SELLS.includes(type)))
      return [trade(g, quNet, "sell", "QSwap", asset, qty, quNet, qswapSellFee(quNet, g.epoch), quNet < 0 ? { note: "The sale fetched less than QSwap's flat 100,000 QU fee, so it cost QU overall." } : {})];
    return [transfer(g, quNet, asset, net, "QSwap operation that moved shares.")];
  }

  if (onQx) {
    if (net > 0 && own?.inputType === QX_ADD_BID && quNet < 0) {
      // The order locked price x quantity; what did not fill at once (here or against the wallet's own sell orders) stays locked.
      const order = orderInput(own);
      const resting = order ? order.qty - qty - (units.get(asset.key)?.self ?? 0) : -1;
      if (order && order.key === tradeKeyOf(asset) && resting >= 0) {
        const escrow = order.price * resting;
        const value = -quNet - escrow;
        if (value > 0) return [trade(g, quNet, "buy", "QX", asset, qty, value, 0, escrow ? { escrowQu: escrow, note: `${resting.toLocaleString("en-US")} units of the order did not fill at once; their QU stays locked in the order.` } : {})];
      }
      return [trade(g, quNet, "buy", "QX", asset, qty, -quNet, 0, { note: "The order's details could not be read: the cost may include QU still locked in the order." })];
    }
    if (net > 0 && quNet < 0) return [trade(g, quNet, "buy", "QX", asset, qty, -quNet, 0, own ? {} : { note: "The order's details are not in the transaction list read: the cost may include QU still locked in the order." })];
    if (net < 0 && own?.inputType === QX_TRANSFER) return [transfer(g, quNet, asset, net, "Sent with QX's transfer procedure.", Math.max(0, -quNet))];
    if (net < 0 && quNet > 0) {
      const fee = qxSellFees(g, asset.key);
      const received = g.qu.filter((f) => isQx(f.cp) && f.amount > 0).reduce((s, f) => s + f.amount, 0);
      return [trade(g, quNet, "sell", "QX", asset, qty, quNet, fee ?? Math.round((received * 3) / 997), own ? {} : { note: "Your resting QX sell order was filled by another trader." })];
    }
    if (net > 0 && quNet === 0 && !own) return makerBuy(g, asset, moves, ctx);
    return [transfer(g, quNet, asset, net, "QX operation that moved shares without a matching payment.")];
  }

  // Neither venue: a resting QX buy order filled by a seller looks like this from the wallet's side (shares in, no QU).
  if (net > 0 && quNet === 0 && !own && moves.every((m) => contractIndexOf(m.cp) === null)) return makerBuy(g, asset, moves, ctx);
  if (net > 0 && quNet < 0) return [trade(g, quNet, "buy", "unknown", asset, qty, -quNet, null, { note: "Shares and QU swapped in one transaction outside QX and QSwap." })];
  if (net < 0 && quNet > 0) return [trade(g, quNet, "sell", "unknown", asset, qty, quNet, null, { note: "Shares and QU swapped in one transaction outside QX and QSwap." })];
  const from = moves.map((m) => contractIndexOf(m.cp)).find((c) => c !== null);
  return [transfer(g, quNet, asset, net, from !== undefined && from !== null ? `${net > 0 ? "From" : "To"} contract ${from}.` : undefined)];
}

/* ---------- positions ---------- */

interface Book {
  asset: LedgerAsset;
  costed: number;
  cost: number;
  uncosted: number;
  realized: number;
  uncostedProceeds: number;
  fees: number;
  bought: number;
  sold: number;
  spent: number;
  received: number;
  trades: number;
  preWindow: number;
}

/** Takes `qty` units out of a book: units with a known cost first (at the average cost), then the others. Returns the cost removed and how many had a cost. */
function takeOut(b: Book, qty: number): { costed: number; cost: number } {
  const costed = Math.min(qty, b.costed);
  const cost = costed === b.costed ? b.cost : b.costed > 0 ? (b.cost / b.costed) * costed : 0;
  b.costed -= costed;
  b.cost = b.costed === 0 ? 0 : b.cost - cost;
  const rest = qty - costed;
  const fromUncosted = Math.min(rest, b.uncosted);
  b.uncosted -= fromUncosted;
  b.preWindow += rest - fromUncosted;
  return { costed, cost };
}

/** Runs the entries in order through average-cost books: fills in each entry's position and realized P&L, returns the positions. */
function runBooks(entries: LedgerEntry[], priceOf: (key: string) => number | null | undefined): LedgerPosition[] {
  const books = new Map<string, Book>();
  for (const e of entries) {
    if (!e.asset) continue;
    let b = books.get(e.asset.key);
    if (!b) books.set(e.asset.key, (b = { asset: e.asset, costed: 0, cost: 0, uncosted: 0, realized: 0, uncostedProceeds: 0, fees: 0, bought: 0, sold: 0, spent: 0, received: 0, trades: 0, preWindow: 0 }));
    if (e.feeQu && (e.kind === "buy" || e.kind === "sell" || e.kind === "other")) b.fees += e.feeQu;
    if (e.kind === "buy") {
      b.costed += e.qty;
      b.cost += e.valueQu!;
      b.bought += e.qty;
      b.spent += e.valueQu!;
      b.trades++;
    } else if (e.kind === "sell") {
      const { costed, cost } = takeOut(b, e.qty);
      const proceeds = (e.valueQu! * costed) / e.qty;
      e.realizedQu = costed > 0 ? tidy(proceeds - cost) : null;
      b.realized += costed > 0 ? proceeds - cost : 0;
      b.uncostedProceeds += e.valueQu! - proceeds;
      b.sold += e.qty;
      b.received += e.valueQu!;
      b.trades++;
    } else if (e.kind === "transfer-in") b.uncosted += e.qty;
    else if (e.kind === "transfer-out") takeOut(b, e.qty);
    e.position = b.costed + b.uncosted;
  }
  return [...books.values()].map((b) => {
    const p = priceOf(b.asset.key);
    const price = typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
    const avg = b.costed > 0 ? b.cost / b.costed : null;
    const held = b.costed + b.uncosted;
    return {
      asset: b.asset,
      held,
      costedQty: b.costed,
      avgCost: avg === null ? null : tidy(avg),
      costQu: tidy(b.cost),
      realizedQu: tidy(b.realized),
      uncostedProceedsQu: tidy(b.uncostedProceeds),
      priceQu: price,
      valueQu: price === null ? null : tidy(price * held),
      unrealizedQu: price === null || avg === null ? null : tidy((price - avg) * b.costed),
      unrealizedPct: price === null || avg === null || avg <= 0 ? null : tidy((price / avg - 1) * 100),
      feesQu: b.fees,
      bought: b.bought,
      sold: b.sold,
      spentQu: b.spent,
      receivedQu: b.received,
      trades: b.trades,
      preWindowQty: b.preWindow,
    };
  });
}

/* ---------- the ledger ---------- */

export interface BuildOptions {
  identity: string;
  /** The wallet's own QX and QSwap transactions (for order prices and to tell its own trades from a counterparty's). */
  ownTxs?: WalletTx[];
  /** QX fills by transaction, for the transactions that were looked up (an empty list = looked up, no QX fill there). */
  fills?: Map<string, QxFill[]>;
  /** Current price per unit in QU for an asset key (`NAME|ISSUER`): QMax's mid or pool price. */
  priceOf?: (key: string) => number | null | undefined;
  fromMs?: number;
  toMs?: number;
  coveredFromMs?: number;
  truncatedReasons?: string[];
  warnings?: string[];
  requests?: number;
  now?: number;
}

const NOTES = [
  "Estimated from on-chain transfers in the public archive's event log. Fees include the markets' fees. Not tax advice.",
  "Profit uses the average cost method: a buy adds its cost (fees included) to the asset's pool, a sale takes units out at the pool's average cost.",
  "Units that arrived by transfer, or before the window, have no known cost: selling them is reported as uncosted proceeds, not as profit.",
  "Unrealized profit uses QMax's current mid (QX) or pool (QSwap) price per unit, not what selling the whole position would fetch.",
  "QX fees are recovered from what sellers received (Qx.h's formula); QSwap fees are estimated from its 0.3% rate and, since epoch 215, its flat 100,000 QU per swap.",
];

/**
 * Builds the ledger from a wallet's events (pure: no network). Entries come out oldest first, each with the position after it;
 * positions use the average cost method: a buy adds its cost (fees included) to the pool, a sale takes units out at the pool's
 * average cost and the difference to its proceeds (fees deducted) is realized. Units that arrived by transfer, or before the
 * window, have no known cost: selling them adds to `uncostedProceedsQu`, not to realized profit.
 */
export function buildLedger(events: WalletEvent[], opts: BuildOptions): Ledger {
  const warnings = [...(opts.warnings ?? [])];
  const ownTxs = new Map((opts.ownTxs ?? []).filter((t) => t.source === opts.identity).map((t) => [t.hash, t]));
  const ctx: Context = {
    identity: opts.identity,
    ownTxs,
    fills: opts.fills ?? new Map(),
    excluded: { contractIncome: { count: 0, qu: 0 }, contractPayments: { count: 0, qu: 0 }, transfersIn: { count: 0, qu: 0 }, transfersOut: { count: 0, qu: 0 }, noChange: 0 },
    unchecked: 0,
  };
  const groups = groupEvents(events, opts.identity, warnings);
  const entries = groups.flatMap((g) => classify(g, ctx));
  const positions = runBooks(entries, opts.priceOf ?? (() => null)).sort((a, b) => (b.valueQu ?? 0) - (a.valueQu ?? 0) || b.trades - a.trades);

  // Own transactions that moved QU but left no events: the archive's event log has gaps, so those are missing here.
  const withEvents = new Set(groups.map((g) => g.hash));
  const missing = [...ownTxs.values()].filter((t) => t.moneyFlew !== false && Number(t.amount) > 0 && !withEvents.has(t.hash));
  if (missing.length) warnings.push(`${missing.length} of this wallet's QX/QSwap transactions moved QU but the archive has no events for them (its event log has gaps), so they are missing from this ledger.`);
  const truncatedReasons = [...(opts.truncatedReasons ?? [])];
  if (ctx.unchecked) truncatedReasons.push(`${ctx.unchecked} incoming share transfers were not checked against QX fills (lookup limit); they are listed as transfers.`);

  const trades = entries.filter((e) => e.kind === "buy" || e.kind === "sell");
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const priced = positions.filter((p) => p.unrealizedQu !== null);
  const tradeFees = sum(trades.map((e) => e.feeQu ?? 0));
  const otherFees = sum(entries.filter((e) => e.kind !== "buy" && e.kind !== "sell").map((e) => e.feeQu ?? 0));
  const now = opts.now ?? Date.now();
  const fromMs = opts.fromMs ?? (entries[0]?.t ?? now);
  return {
    identity: opts.identity,
    fromMs,
    toMs: opts.toMs ?? now,
    coveredFromMs: opts.coveredFromMs ?? fromMs,
    generatedAt: now,
    method: "average-cost",
    notes: NOTES,
    entries,
    positions,
    totals: {
      trades: trades.length,
      buys: trades.filter((e) => e.kind === "buy").length,
      sells: trades.filter((e) => e.kind === "sell").length,
      spentQu: sum(trades.filter((e) => e.kind === "buy").map((e) => e.valueQu!)),
      receivedQu: sum(trades.filter((e) => e.kind === "sell").map((e) => e.valueQu!)),
      realizedQu: tidy(sum(positions.map((p) => p.realizedQu))),
      unrealizedQu: priced.length ? tidy(sum(priced.map((p) => p.unrealizedQu!))) : null,
      unpricedPositions: positions.filter((p) => p.held > 0 && p.priceQu === null).length,
      feesQu: tradeFees + otherFees,
      tradeFeesQu: tradeFees,
      otherFeesQu: otherFees,
      uncostedProceedsQu: tidy(sum(positions.map((p) => p.uncostedProceedsQu))),
      escrowQu: sum(entries.map((e) => e.escrowQu ?? 0)),
    },
    excluded: ctx.excluded,
    truncated: truncatedReasons.length > 0,
    truncatedReasons,
    warnings,
    requests: opts.requests ?? 0,
  };
}

/* ---------- CSV ---------- */

/** The columns of the ledger CSV, in order. Dates are UTC (ISO 8601); amounts are in QU; quantities in units. */
export const CSV_COLUMNS = ["date_utc", "tx_hash", "kind", "venue", "asset", "issuer", "quantity", "price_qu", "qu_net", "est_fee_qu", "position_after", "realized_pnl_qu", "note"] as const;
export const POSITION_COLUMNS = ["asset", "issuer", "held", "avg_cost_qu", "cost_qu", "realized_pnl_qu", "uncosted_proceeds_qu", "current_price_qu", "unrealized_pnl_qu", "fees_qu"] as const;

/** A number for a spreadsheet: plain digits, a dot for decimals, at most six of them; empty when unknown. */
const csvNum = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "" : String(tidy(x)));

/**
 * One CSV cell: quoted when it holds a comma, quote or line break (quotes doubled). Text that starts like a formula
 * (= + - @) gets a leading apostrophe so a spreadsheet shows it instead of running it: asset names are chosen by their issuers.
 */
export function csvCell(v: string | number | null | undefined, text = false): string {
  if (typeof v === "number" || v === null || v === undefined) return csvNum(v as number | null | undefined);
  let s = v;
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The ledger as CSV (RFC 4180, CRLF line ends): one row per entry, oldest first, with the columns in `CSV_COLUMNS`. When
 * positions are given, a second table follows after one empty line, with the columns in `POSITION_COLUMNS`.
 */
export function toCsv(entries: LedgerEntry[], positions?: LedgerPosition[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const e of entries)
    rows.push(
      [
        csvCell(new Date(e.t).toISOString()),
        csvCell(e.tx.startsWith("tick:") ? "" : e.tx),
        csvCell(e.kind),
        csvCell(e.venue ?? ""),
        csvCell(e.asset?.symbol ?? "", true),
        csvCell(e.asset?.issuer ?? ""),
        csvCell(e.asset ? e.qty : null),
        csvCell(e.price),
        csvCell(e.quNet),
        csvCell(e.feeQu),
        csvCell(e.position),
        csvCell(e.realizedQu),
        csvCell(e.note ?? "", true),
      ].join(","),
    );
  if (positions?.length) {
    rows.push("", POSITION_COLUMNS.join(","));
    for (const p of positions)
      rows.push([csvCell(p.asset.symbol, true), csvCell(p.asset.issuer), csvCell(p.held), csvCell(p.avgCost), csvCell(p.costQu), csvCell(p.realizedQu), csvCell(p.uncostedProceedsQu), csvCell(p.priceQu), csvCell(p.unrealizedQu), csvCell(p.feesQu)].join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

/* ---------- reading the archive ---------- */

/** What the ledger needs from the archive: QubicRpc, or a stand-in in tests. */
export interface ArchiveClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

class BudgetSpent extends Error {}

interface Budget {
  used: number;
  max: number;
}

/** Counts every request, and refuses once the budget is spent so a busy wallet cannot keep the archive busy for minutes. */
function metered(client: ArchiveClient, budget: Budget): ArchiveClient {
  const charge = () => {
    if (budget.used >= budget.max) throw new BudgetSpent("request budget spent");
    budget.used++;
  };
  return {
    get: <T>(path: string) => (charge(), client.get<T>(path)),
    post: <T>(path: string, body: unknown) => (charge(), client.post<T>(path, body)),
  };
}

interface Paged<T> {
  hits: { total: number };
  items: T[];
}

/**
 * Reads every result of a query over a time span, newest first. A span that would pass the 10,000-result cap is halved, the
 * newer half first, so stopping early (the budget) always leaves a complete newest stretch. Returns false if it stopped early.
 */
async function readSpan<T>(fromMs: number, toMs: number, query: (fromMs: number, toMs: number, offset: number) => Promise<Paged<T>>, absorb: (items: T[]) => void): Promise<boolean> {
  try {
    const first = await query(fromMs, toMs, 0);
    if (first.hits.total >= MAX_HITS && toMs > fromMs) {
      const mid = Math.floor((fromMs + toMs) / 2);
      return (await readSpan(mid + 1, toMs, query, absorb)) && (await readSpan(fromMs, mid, query, absorb));
    }
    absorb(first.items);
    for (let offset = PAGE; offset < Math.min(first.hits.total, MAX_HITS); offset += PAGE) absorb((await query(fromMs, toMs, offset)).items);
    return true;
  } catch (e) {
    if (e instanceof BudgetSpent) return false;
    throw e;
  }
}

export interface LedgerInput {
  identity: string;
  events: WalletEvent[];
  ownTxs: WalletTx[];
  fills: Map<string, QxFill[]>;
  fromMs: number;
  toMs: number;
  coveredFromMs: number;
  lastTick: number;
  truncatedReasons: string[];
  warnings: string[];
  requests: number;
}

export interface FetchOptions {
  /** How far back to look, in days. Default 180. */
  days?: number;
  now?: number;
  /** Most archive requests one ledger may use. Default 60. */
  maxRequests?: number;
}

/** The transactions in which shares reached the wallet from another wallet with no QU: possibly a filled resting buy order. */
export function makerCandidates(events: WalletEvent[], identity: string, ownHashes: Set<string>): { hash: string; tick: number }[] {
  const byTx = new Map<string, { tick: number; sharesIn: boolean; qu: boolean }>();
  for (const e of events) {
    if (!e.transactionHash || ownHashes.has(e.transactionHash)) continue;
    const s = byTx.get(e.transactionHash) ?? { tick: e.tickNumber, sharesIn: false, qu: false };
    const c = e.assetOwnershipChange;
    if (e.logType === 2 && c && c.destination === identity && c.source !== identity && contractIndexOf(c.source) === null) s.sharesIn = true;
    if (e.logType === 0 && e.quTransfer && (e.quTransfer.source === identity) !== (e.quTransfer.destination === identity)) s.qu = true;
    byTx.set(e.transactionHash, s);
  }
  return [...byTx].filter(([, s]) => s.sharesIn && !s.qu).map(([hash, s]) => ({ hash, tick: s.tick }));
}

/**
 * Reads what the ledger needs: the wallet's QU and share events over the window, its own QX/QSwap transactions, and QX's trade
 * messages around shares that arrived without a payment. Cost: 1 request for the archive's last tick, 1 per 1,000 own
 * transactions, 1 per 1,000 events, up to 4 probes for gaps in the event log, and 1 per cluster of incoming shares (about
 * 3.5 days of QX trades each), all within `maxRequests` (default 60). On real wallets that was 3 to 29 requests.
 */
export async function fetchLedgerInput(client: ArchiveClient, identity: string, opts: FetchOptions = {}): Promise<LedgerInput> {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 180;
  const fromMs = now - days * DAY;
  const budget: Budget = { used: 0, max: Math.max(3, opts.maxRequests ?? 60) };
  const rpc = metered(client, budget);
  const reasons: string[] = [];

  // Everything up to the archive's last processed tick is complete; nothing newer is asked for, which also keeps pages stable.
  const lastTick = (await rpc.get<{ logTickNumber: number }>("/query/v1/getLastProcessedTick")).logTickNumber;

  // The wallet's own QX/QSwap transactions first (usually one page), with at most half the budget so the events always get some.
  const ownTxs: WalletTx[] = [];
  const txBudget: Budget = { used: 0, max: Math.floor(budget.max / 2) };
  const txRpc = metered(client, txBudget);
  const txsDone = await readSpan(
    fromMs,
    now,
    async (lo, hi, offset) => {
      const r = await txRpc.post<{ hits: { total: number }; transactions?: WalletTx[] }>("/query/v1/getTransactionsForIdentity", {
        identity,
        filters: { source: identity, destination: `${QX_ID},${QSWAP_ID}` },
        ranges: { timestamp: { gte: String(lo), lte: String(hi) }, tickNumber: { lte: String(lastTick) } },
        pagination: { offset, size: PAGE },
      });
      return { hits: r.hits, items: r.transactions ?? [] };
    },
    (items) => ownTxs.push(...items),
  );
  budget.used += txBudget.used;

  const events: WalletEvent[] = [];
  const eventsDone = await readSpan(
    fromMs,
    now,
    async (lo, hi, offset) => {
      const r = await rpc.post<{ hits: { total: number }; eventLogs?: WalletEvent[] }>("/query/v1/getEventLogs", {
        filters: { logType: "0,2" },
        should: [{ terms: { source: identity, destination: identity } }],
        ranges: { timestamp: { gte: String(lo), lte: String(hi) }, tickNumber: { lte: String(lastTick) } },
        pagination: { offset, size: PAGE },
      });
      return { hits: r.hits, items: r.eventLogs ?? [] };
    },
    (items) => events.push(...items),
  );

  // Stopped early: keep only the newest stretch both lists cover completely (the oldest tick read may be cut in half).
  let coveredFromMs = fromMs;
  if (!eventsDone || !txsDone) {
    const floor = (ticks: number[]) => (ticks.length ? Math.min(...ticks) : lastTick);
    const cut = Math.max(eventsDone ? 0 : floor(events.map((e) => e.tickNumber)), txsDone ? 0 : floor(ownTxs.map((t) => t.tickNumber)));
    const keptEvents = events.filter((e) => e.tickNumber > cut);
    events.length = 0;
    events.push(...keptEvents);
    const keptTxs = ownTxs.filter((t) => t.tickNumber > cut);
    ownTxs.length = 0;
    ownTxs.push(...keptTxs);
    coveredFromMs = events.length ? Math.min(...events.map((e) => Number(e.timestamp))) : now;
    reasons.push(`This wallet has more activity than one ledger reads (${budget.max} archive requests), so it covers ${new Date(coveredFromMs).toISOString().slice(0, 10)} onwards only.`);
  }

  // The archive's event log has gaps (no events at all for days). A transaction of the wallet's that left no events is either
  // one that moved nothing (an unfilled sell order) or one inside a gap; a few are checked, one per day, spread over the window.
  const warnings: string[] = [];
  const withEvents = new Set(events.map((e) => e.transactionHash));
  const silentDays = new Map<number, number>();
  for (const t of ownTxs) if (t.moneyFlew !== false && !withEvents.has(t.hash)) silentDays.set(Math.floor(Number(t.timestamp) / DAY), t.tickNumber);
  const silent = [...silentDays.keys()].sort((a, b) => a - b);
  const probe = silent.length <= GAP_PROBES ? silent : Array.from({ length: GAP_PROBES }, (_, i) => silent[Math.round((i * (silent.length - 1)) / (GAP_PROBES - 1))]);
  const gapDays: string[] = [];
  for (const day of probe) {
    const tick = silentDays.get(day)!;
    try {
      const r = await rpc.post<{ hits: { total: number } }>("/query/v1/getEventLogs", { ranges: { tickNumber: { gte: String(tick - 100), lte: String(tick + 100) } }, pagination: { offset: 0, size: 1 } });
      if (r.hits.total === 0) gapDays.push(new Date(day * DAY).toISOString().slice(0, 10));
    } catch (e) {
      if (e instanceof BudgetSpent) break;
      throw e;
    }
  }
  if (gapDays.length) warnings.push(`The archive has no events at all around ${gapDays.join(", ")}, when this wallet sent QX/QSwap transactions: trades and transfers from that time are missing, so positions may be off.`);

  const fills = new Map<string, QxFill[]>();
  const candidates = makerCandidates(events, identity, new Set(ownTxs.map((t) => t.hash))).sort((a, b) => b.tick - a.tick);
  for (let i = 0; i < candidates.length; ) {
    const top = candidates[i].tick;
    let j = i;
    while (j < candidates.length && candidates[j].tick >= top - FILL_CLUSTER_TICKS) j++;
    const cluster = candidates.slice(i, j);
    i = j;
    const lo = cluster[cluster.length - 1].tick;
    const want = new Set(cluster.map((c) => c.hash));
    const found = new Map<string, QxFill[]>();
    try {
      await scanTrades(rpc as unknown as QubicRpc, QX_CONTRACT, { fromTick: lo, toTick: top }, (trades: Trade[]) => {
        for (const t of trades) if (t.txHash && want.has(t.txHash)) found.set(t.txHash, [...(found.get(t.txHash) ?? []), { logId: Number(t.logId), key: t.key, price: t.price, qty: t.qty }]);
      });
    } catch (e) {
      if (e instanceof BudgetSpent) break;
      throw e;
    }
    for (const h of want) fills.set(h, found.get(h) ?? []);
  }

  return { identity, events, ownTxs, fills, fromMs, toMs: now, coveredFromMs, lastTick, truncatedReasons: reasons, warnings, requests: budget.used };
}

/** Reads the archive and builds the ledger. */
export async function ledgerFor(client: ArchiveClient, identity: string, opts: FetchOptions & { priceOf?: BuildOptions["priceOf"] } = {}): Promise<Ledger> {
  const input = await fetchLedgerInput(client, identity, opts);
  return buildLedger(input.events, { ...input, priceOf: opts.priceOf, now: opts.now });
}

/* ---------- API ---------- */

export interface LedgerDeps {
  /** The archive (QubicRpc in production). Its own throttle keeps the request rate down. */
  rpc: ArchiveClient;
  /** Current price per unit in QU for an asset key `NAME|ISSUER` (the catalog's mid or pool price), or null. */
  priceOf(key: string): number | null | undefined;
  /** For tests. */
  now?: () => number;
  /** How long one wallet's ledger is reused, ms. Default 60 s. */
  cacheMs?: number;
  /** Ledgers built at the same time; more are refused with 503. Default 2. */
  maxConcurrent?: number;
  /** Archive requests per ledger. Default 60. */
  maxRequests?: number;
}

/** Ledgers kept in memory at once (the oldest go first): enough that the people looking at their portfolios around the same time are mostly served from here. */
const MAX_CACHED = 200;
/** After the archive says it is rate limiting (429), no new ledger is started for this long, so a crowd does not keep hitting a limit it has already hit. */
const ARCHIVE_PAUSE_MS = 30_000;

/** `GET /v1/ledger`: a wallet's trades, positions and profit, as JSON or CSV. */
export function ledgerRoutes(deps: LedgerDeps): Route[] {
  const now = deps.now ?? Date.now;
  const ttl = deps.cacheMs ?? 60_000;
  const maxConcurrent = deps.maxConcurrent ?? 2;
  const cache = new Map<string, { at: number; ledger?: Ledger; pending?: Promise<Ledger> }>();
  let running = 0;
  let archivePausedUntil = 0;

  const get = async (identity: string, days: number): Promise<Ledger> => {
    // The last four letters of an identity are only a checksum: the same wallet written with any of them must be one cache entry, not 456,976.
    const key = `${identity.slice(0, 56)}|${days}`;
    const hit = cache.get(key);
    if (hit?.pending) return hit.pending;
    if (hit?.ledger && now() - hit.at < ttl) return hit.ledger;
    if (now() < archivePausedUntil) throw new RouteError(503, "The Qubic archive is busy right now, so your trade history cannot be read yet. It will be asked again shortly.", { retryAfterSec: Math.max(5, Math.ceil((archivePausedUntil - now()) / 1000)) });
    if (running >= maxConcurrent) throw new RouteError(503, "QMax is building other ledgers right now. Try again in a few seconds.", { retryAfterSec: 5 });
    running++;
    const pending = ledgerFor(deps.rpc, identity, { days, now: now(), maxRequests: deps.maxRequests, priceOf: (k) => deps.priceOf(k) }).finally(() => running--);
    cache.set(key, { at: now(), pending });
    try {
      const ledger = await pending;
      cache.set(key, { at: now(), ledger });
      for (const k of cache.keys()) {
        if (cache.size <= MAX_CACHED) break;
        if (!cache.get(k)?.pending) cache.delete(k);
      }
      return ledger;
    } catch (e) {
      cache.delete(key);
      if (e instanceof RouteError) throw e;
      const why = e instanceof Error ? e.message : String(e);
      // The public archive limits how fast it is asked (429), and sometimes drops a request: that passes, so the page is told to ask again shortly instead of being told it failed.
      if (/\b429\b|rate limit|timed? ?out|unavailable/i.test(why)) {
        archivePausedUntil = now() + ARCHIVE_PAUSE_MS;
        throw new RouteError(503, "The Qubic archive is busy right now, so your trade history cannot be read yet. It will be asked again shortly.", { retryAfterSec: 30 });
      }
      throw new RouteError(502, `Could not read the Qubic archive: ${why}`);
    }
  };

  return [
    {
      method: "GET",
      path: "/v1/ledger",
      // A build reads the archive up to ~30 times and only two run at once: one address must not be able to keep both busy.
      limited: false,
      rate: { perMin: 6 },
      doc: {
        summary: "Trade ledger, profit and CSV export for a wallet",
        description:
          "Every QX and QSwap trade of a wallet over the last `days`, read from the public archive's event log, with average-cost positions, realized and unrealized profit (at QMax's current mid or pool price) and estimated fees. Estimated from on-chain transfers; fees include the venues' fees. Not tax advice. Expensive: results are cached for 60 seconds.",
        parameters: [
          { name: "identity", in: "query", required: true, schema: { type: "string", pattern: "^[A-Z]{60}$" }, description: "The wallet's 60-letter Qubic identity." },
          { name: "format", in: "query", schema: { type: "string", enum: ["json", "csv"], default: "json" } },
          { name: "days", in: "query", schema: { type: "integer", minimum: 1, maximum: 365, default: 180 }, description: "How far back to look." },
        ],
        responses: { "200": { description: "The ledger (JSON), or a CSV download" }, "400": { description: "Bad identity or days" }, "503": { description: "Busy; retry shortly" } },
      },
      async handler({ query }) {
        const identity = required(query, "identity");
        if (!isIdentity(identity)) throw new RouteError(400, "identity must be a 60-letter uppercase Qubic identity");
        const format = oneOf(query, "format", ["json", "csv"] as const, "json");
        const rawDays = (query.get("days") ?? "").trim();
        const days = rawDays === "" ? 180 : plainNumber(rawDays);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new RouteError(400, "days must be a whole number from 1 to 365");
        const ledger = await get(identity, days);
        if (format === "csv") return new Raw(toCsv(ledger.entries, ledger.positions), "text/csv; charset=utf-8", `qmax-ledger-${identity.slice(0, 8)}.csv`);
        return ledger;
      },
    },
  ];
}
