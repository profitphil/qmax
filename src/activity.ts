import { readFileSync } from "node:fs";
import { writeJsonFile } from "./safefile.ts";
import { identityToBytes, assetNameToU64 } from "./identity.ts";
import type { QubicRpc } from "./rpc.ts";

/** Contract identity of QX (contract index 1), where orders are sent. */
const QX_ID = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARMID";
const ORDER_TYPES = ["5", "6"]; // AddToAskOrder, AddToBidOrder
const PAGE = 1000;
const MAX_HITS = 10_000; // the Query API will not page past this per query
const WINDOW_TICKS = 100_000;
/** About 14 days of ticks (the network runs at roughly 1.8 ticks per second); slightly generous. */
const HORIZON_TICKS = 2_300_000;

interface QueryTx {
  timestamp: string;
  inputData: string;
  moneyFlew?: boolean;
}
interface QueryResponse {
  hits: { total: number };
  transactions: QueryTx[];
}

interface State {
  /** Highest and lowest tick already scanned (inclusive). */
  highTick: number;
  lowTick: number;
  /** When each asset last had a QX order placed (ms), keyed by `assetName|issuerHex`. */
  lastAt: Record<string, number>;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Key an asset by what appears in a QX order: its name and issuer public key. */
export const activityKey = (symbol: string, issuer: string) => `${assetNameToU64(symbol)}|${hex(identityToBytes(issuer))}`;

/**
 * Last time each asset had an order placed on QX, read from the archive Query API. It scans backwards
 * about two epochs once, then only the new ticks, and keeps the result on disk.
 */
export class ActivityIndex {
  private rpc: QubicRpc;
  private cachePath?: string;
  private state: State = { highTick: 0, lowTick: 0, lastAt: {} };
  private running?: Promise<void>;
  /** True once the whole two-epoch window has been scanned. */
  complete = false;
  private horizonTick = 0;

  constructor(rpc: QubicRpc, opts: { cachePath?: string } = {}) {
    this.rpc = rpc;
    this.cachePath = opts.cachePath;
    try {
      if (this.cachePath) this.state = JSON.parse(readFileSync(this.cachePath, "utf8"));
    } catch {
      // first run
    }
  }

  lastQxOrderAt(symbol: string, issuer: string): number | null {
    try {
      return this.state.lastAt[activityKey(symbol, issuer)] ?? null;
    } catch {
      return null;
    }
  }

  /** Progress through the initial backfill, 0 to 1. */
  get progress(): number {
    if (this.complete) return 1;
    if (!this.horizonTick || !this.state.highTick) return 0;
    const total = this.state.highTick - this.horizonTick;
    return total > 0 ? Math.min(1, (this.state.highTick - this.state.lowTick) / total) : 0;
  }

  /** Scans new ticks and continues the backfill. Safe to call repeatedly; overlapping calls share one run. */
  update(): Promise<void> {
    this.running ??= this.run().finally(() => (this.running = undefined));
    return this.running;
  }

  private async run() {
    const latest = (await this.rpc.get<{ tickInfo: { tick: number } }>("/live/v1/tick-info")).tickInfo.tick;
    this.horizonTick = latest - HORIZON_TICKS;
    const s = this.state;
    if (!s.highTick) s.highTick = s.lowTick = latest + 1;

    // 1. New ticks since the last run.
    if (latest >= s.highTick) {
      await this.scan(s.highTick, latest);
      s.highTick = latest + 1;
      this.save();
    }
    // 2. Older ticks, newest first, until the two-epoch horizon is covered.
    while (s.lowTick > this.horizonTick) {
      const lo = Math.max(this.horizonTick, s.lowTick - WINDOW_TICKS);
      await this.scan(lo, s.lowTick - 1);
      s.lowTick = lo;
      this.save();
    }
    this.complete = true;
  }

  /** Reads every QX order in the tick range, splitting the range if a query would exceed the 10,000-result cap. */
  private async scan(lo: number, hi: number): Promise<void> {
    for (const type of ORDER_TYPES) await this.scanType(type, lo, hi);
  }

  private async scanType(type: string, lo: number, hi: number): Promise<void> {
    const query = (offset: number) =>
      this.rpc.post<QueryResponse>("/query/v1/getTransactionsForIdentity", {
        identity: QX_ID,
        filters: { destination: QX_ID, inputType: type },
        // The Query API rejects a range whose ends are equal, so a single tick is widened by one (re-reading a tick is harmless).
        ranges: { tickNumber: { gte: String(lo === hi ? lo - 1 : lo), lte: String(hi) } },
        pagination: { offset, size: PAGE },
      });
    const first = await query(0);
    if (first.hits.total >= MAX_HITS && hi > lo) {
      const mid = Math.floor((lo + hi) / 2);
      await this.scanType(type, lo, mid);
      await this.scanType(type, mid + 1, hi);
      return;
    }
    this.absorb(first.transactions);
    for (let offset = PAGE; offset < first.hits.total; offset += PAGE) this.absorb((await query(offset)).transactions);
  }

  private absorb(txs: QueryTx[]) {
    for (const t of txs) {
      if (t.moneyFlew === false) continue; // failed transactions are not activity
      const b = Buffer.from(t.inputData, "base64");
      if (b.length < 40) continue;
      const key = `${b.readBigUInt64LE(32)}|${b.subarray(0, 32).toString("hex")}`;
      const at = Number(t.timestamp);
      if (at > (this.state.lastAt[key] ?? 0)) this.state.lastAt[key] = at;
    }
  }

  private save() {
    if (!this.cachePath) return;
    try {
      writeJsonFile(this.cachePath, this.state);
    } catch {
      // read-only deployments just skip caching
    }
  }
}
