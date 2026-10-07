import assert from "node:assert/strict";
import type { EventLog } from "../src/events.ts";
import type { QubicRpc } from "../src/rpc.ts";

export const issuer = Buffer.alloc(32, 7);
export const nameU64 = (n: string) => Buffer.from(n.padEnd(8, "\0")).readBigUInt64LE(0);
export const key = (n: string) => `${nameU64(n)}|${issuer.toString("hex")}`;

/** The body of a trade message: issuer, asset name, then two signed 64-bit numbers. */
export function body(name: string, a: number, b: number) {
  const buf = Buffer.alloc(56);
  issuer.copy(buf, 0);
  buf.writeBigUInt64LE(nameU64(name), 32);
  buf.writeBigInt64LE(BigInt(a), 40);
  buf.writeBigInt64LE(BigInt(b), 48);
  return buf.toString("base64");
}

let logCounter = 0;
export function ev(contract: number, type: number, tick: number, ms: number, name: string, a: number, b: number, logType = 6): EventLog {
  return {
    epoch: 233,
    tickNumber: tick,
    timestamp: String(ms),
    logType,
    logId: String(++logCounter),
    rawPayload: body(name, a, b),
    smartContractMessage: { contractIndex: String(contract), contractMessageType: String(type) },
  };
}
export const qx = (tick: number, ms: number, name: string, price: number, shares: number) => ev(1, 0, tick, ms, name, price, shares);
export const swap = (type: number, tick: number, ms: number, name: string, amountIn: number, amountOut: number) => ev(13, type, tick, ms, name, amountIn, amountOut);

/** A stand-in for the archive Query API that follows its real rules: both ends of a range are included, equal tick ends are refused, pages hold at most 1000, a count stops at 10,000 and newest comes first. */
export function archive(events: EventLog[], opts: { lastTick: number; failOnCall?: number } = { lastTick: 0 }) {
  const calls: unknown[] = [];
  let n = 0;
  const rpc = {
    calls,
    async get(path: string) {
      assert.ok(path.endsWith("/getLastProcessedTick"), path);
      return { logTickNumber: opts.lastTick };
    },
    async post(path: string, request: { filters: Record<string, string>; ranges?: Record<string, { gte?: string; lte?: string }>; pagination: { offset: number; size: number } }) {
      assert.ok(path.endsWith("/getEventLogs"), path);
      calls.push(request);
      if (opts.failOnCall === ++n) throw new Error("archive hiccup");
      const { filters, ranges = {}, pagination } = request;
      assert.ok(pagination.size <= 1000, "page size over the API's limit");
      const tr = ranges.tickNumber;
      if (tr?.gte !== undefined && tr.gte === tr.lte) throw new Error(`invalid range: [${tr.gte}:${tr.lte}]`);
      let hits = events.filter((e) => e.logType === Number(filters.logType) && e.smartContractMessage?.contractIndex === filters.contractIndex);
      if (tr) hits = hits.filter((e) => (tr.gte === undefined || e.tickNumber >= Number(tr.gte)) && (tr.lte === undefined || e.tickNumber <= Number(tr.lte)));
      const ts = ranges.timestamp;
      if (ts) hits = hits.filter((e) => Number(e.timestamp) >= Number(ts.gte) && Number(e.timestamp) <= Number(ts.lte));
      hits = [...hits].sort((a, b) => b.tickNumber - a.tickNumber || Number(b.logId) - Number(a.logId));
      assert.ok(pagination.offset < 10_000 || hits.length === 0, "paged past the API's 10,000 cap");
      return { hits: { total: Math.min(hits.length, 10_000) }, eventLogs: hits.slice(pagination.offset, pagination.offset + pagination.size) };
    },
  };
  return rpc as unknown as QubicRpc & { calls: unknown[] };
}

export const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

