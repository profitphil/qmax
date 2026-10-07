import type { QubicRpc } from "./rpc.ts";

/**
 * Trades, read back from the network's event log. QX writes a `TradeMessage` for every order it matches and QSwap a
 * `SwapMessage` for every swap, and the archive Query API (`/query/v1/getEventLogs`, beta) serves them. That is the only
 * way to learn what traded in the past: contracts only expose their current state.
 */

export const QX_CONTRACT = 1;
export const QSWAP_CONTRACT = 13;

/** Event log type for a message a smart contract wrote with LOG_INFO. */
const CONTRACT_INFO_LOG = 6;
/** QX's TradeMessage has message type 0. */
const QX_TRADE = 0;
/** QSwap's SwapMessage types: exact QU in, QU in for exact asset out, exact asset in, asset in for exact QU out. */
const QSWAP_SWAP_QU_IN = [6, 7];
const QSWAP_SWAP_QU_OUT = [8, 9];

const PAGE = 1000; // the Query API allows at most 1000 per page
const MAX_HITS = 10_000; // and will not page past this per query

/** One event as the Query API returns it (only the fields used here). */
export interface EventLog {
  epoch: number;
  tickNumber: number;
  /** ms since epoch, as a string */
  timestamp: string;
  transactionHash?: string;
  logType: number;
  logId: string;
  /** base64 of the message body (the 8-byte contract index and message type header is not included) */
  rawPayload?: string;
  smartContractMessage?: { contractIndex: string; contractMessageType: string };
}

export interface Trade {
  /** ms since epoch */
  t: number;
  tick: number;
  epoch: number;
  logId: string;
  venue: "QX" | "QSwap";
  /** `assetNameAsNumber|issuerPublicKeyHex`: the same key the activity index uses for an asset. */
  key: string;
  /** Units of the asset that changed hands. */
  qty: number;
  /** QU that changed hands. */
  qu: number;
  /** QU per unit, fees and price impact included for a swap. */
  price: number;
  /** The transaction that caused it, when the archive says. */
  txHash?: string;
  /**
   * Which way the person who started the trade went, when the event itself says. A QSwap swap does (QU in is a buy, asset in is a
   * sell); a QX fill does not, because it is logged the same way for either side (the transaction's call tells: see `tape.ts`).
   */
  side?: "buy" | "sell";
}

/**
 * Turns one event into a trade, or null if it is something else (liquidity changes, other contracts, a payload too
 * short to hold a trade, or a zero-size trade). The body of every trade message starts with the asset: its 32-byte issuer
 * and its 8-byte name, then two 64-bit numbers whose meaning depends on the message.
 */
export function decodeTrade(e: EventLog): Trade | null {
  if (e.logType !== CONTRACT_INFO_LOG || !e.smartContractMessage || !e.rawPayload) return null;
  const contract = Number(e.smartContractMessage.contractIndex);
  const type = Number(e.smartContractMessage.contractMessageType);
  const body = Buffer.from(e.rawPayload, "base64");
  if (body.length < 56) return null;
  const a = body.readBigInt64LE(40);
  const b = body.readBigInt64LE(48);

  let venue: Trade["venue"];
  let qty: bigint;
  let qu: bigint;
  let side: Trade["side"];
  if (contract === QX_CONTRACT && type === QX_TRADE) {
    // price per unit, number of units
    venue = "QX";
    qty = b;
    qu = a * b;
  } else if (contract === QSWAP_CONTRACT && QSWAP_SWAP_QU_IN.includes(type)) {
    // amounts: QU paid in, asset received
    venue = "QSwap";
    qu = a;
    qty = b;
    side = "buy";
  } else if (contract === QSWAP_CONTRACT && QSWAP_SWAP_QU_OUT.includes(type)) {
    // amounts: asset paid in, QU received
    venue = "QSwap";
    qty = a;
    qu = b;
    side = "sell";
  } else return null;
  if (qty <= 0n || qu <= 0n) return null;

  const key = `${body.readBigUInt64LE(32)}|${body.subarray(0, 32).toString("hex")}`;
  return { t: Number(e.timestamp), tick: e.tickNumber, epoch: e.epoch, logId: e.logId, venue, key, qty: Number(qty), qu: Number(qu), price: Number(qu) / Number(qty), ...(e.transactionHash ? { txHash: e.transactionHash } : {}), ...(side ? { side } : {}) };
}

/** What to read: a span of time (ms) and/or ticks, both ends included. A tick span may leave out its start. */
export interface Span {
  fromMs?: number;
  toMs?: number;
  fromTick?: number;
  toTick?: number;
}

interface Response {
  hits: { total: number };
  eventLogs?: EventLog[];
}

/** The last tick whose events are complete: ask for nothing newer than this. */
export async function lastLogTick(rpc: QubicRpc): Promise<number> {
  return (await rpc.get<{ logTickNumber: number }>("/query/v1/getLastProcessedTick")).logTickNumber;
}

/**
 * Reads every trade one contract logged in a span and hands them over page by page. If a query would hit the 10,000-result
 * cap the span is halved and each half read on its own, so nothing is silently cut off.
 */
export async function scanTrades(rpc: QubicRpc, contract: number, span: Span, absorb: (trades: Trade[]) => void): Promise<void> {
  const ranges: Record<string, { gte?: string; lte?: string }> = {};
  if (span.fromMs !== undefined && span.toMs !== undefined) ranges.timestamp = { gte: String(span.fromMs), lte: String(span.toMs) };
  // The API rejects a tick range whose ends are equal, so a single tick is widened by one and the extra tick dropped again below.
  const widened = span.fromTick !== undefined && span.toTick !== undefined && span.fromTick === span.toTick;
  if (span.fromTick !== undefined || span.toTick !== undefined) {
    ranges.tickNumber = {};
    if (span.fromTick !== undefined) ranges.tickNumber.gte = String(widened ? span.fromTick - 1 : span.fromTick);
    if (span.toTick !== undefined) ranges.tickNumber.lte = String(span.toTick);
  }

  const query = (offset: number) =>
    rpc.post<Response>("/query/v1/getEventLogs", {
      filters: { logType: String(CONTRACT_INFO_LOG), contractIndex: String(contract) },
      ranges,
      pagination: { offset, size: PAGE },
    });
  const take = (logs: EventLog[] = []) => {
    const trades: Trade[] = [];
    for (const e of logs) {
      if (span.fromTick !== undefined && e.tickNumber < span.fromTick) continue;
      const t = decodeTrade(e);
      if (t) trades.push(t);
    }
    if (trades.length) absorb(trades);
  };

  const first = await query(0);
  if (first.hits.total >= MAX_HITS) {
    if (span.fromMs !== undefined && span.toMs !== undefined && span.toMs > span.fromMs) {
      const mid = Math.floor((span.fromMs + span.toMs) / 2);
      await scanTrades(rpc, contract, { ...span, toMs: mid }, absorb);
      await scanTrades(rpc, contract, { ...span, fromMs: mid + 1 }, absorb);
      return;
    }
    if (span.fromTick !== undefined && span.toTick !== undefined && span.toTick > span.fromTick) {
      const mid = Math.floor((span.fromTick + span.toTick) / 2);
      await scanTrades(rpc, contract, { ...span, toTick: mid }, absorb);
      await scanTrades(rpc, contract, { ...span, fromTick: mid + 1 }, absorb);
      return;
    }
  }
  take(first.eventLogs);
  for (let offset = PAGE; offset < Math.min(first.hits.total, MAX_HITS); offset += PAGE) take((await query(offset)).eventLogs);
}
