import { readJsonFile, writeJsonFile, isObject } from "./safefile.ts";
import { isRef } from "./deeplink.ts";

interface RefStats {
  opens: number;
  trades: number;
  lastAt: number;
}

interface Data {
  refs: Record<string, RefStats>;
  /** Transaction ids partners' users reported, kept so they can be checked on-chain before anyone is paid. */
  trades: { ref: string; txIds: string[]; at: number }[];
}

const MAX_REFS = 500;
const MAX_TRADES = 2000;
const TX_ID = /^[a-z]{60}$/;

/**
 * Counts the people sent from other sites (the `ref` on a QMax link). Reports come from the user's browser, so
 * they are good for seeing which partners send traffic, not proof of anything: a payout would first check
 * the transaction ids against the chain.
 */
export class RefLog {
  private file?: string;
  private data: Data = { refs: Object.create(null), trades: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(file?: string) {
    this.file = file;
    if (file) {
      const saved = readJsonFile<Data>(file, (v) => isObject(v) && isObject(v.refs) && Array.isArray(v.trades));
      // No prototype on the table of partners, so a tag like "__proto__" can only ever be a name in it.
      if (saved) this.data = { refs: Object.assign(Object.create(null), saved.refs), trades: saved.trades };
    }
  }

  record(ref: unknown, event: unknown, txIds: unknown, now = Date.now()): boolean {
    if (!isRef(ref) || (event !== "open" && event !== "trade")) return false;
    let s = this.data.refs[ref];
    if (!s) {
      if (Object.keys(this.data.refs).length >= MAX_REFS) {
        // Full of junk tags must not shut real partners out: make room by dropping the stalest tag that never brought a trade.
        const stale = Object.entries(this.data.refs).filter(([, v]) => v.trades === 0).sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
        if (!stale) return false;
        delete this.data.refs[stale[0]];
      }
      s = this.data.refs[ref] = { opens: 0, trades: 0, lastAt: now };
    }
    s.lastAt = now;
    if (event === "open") s.opens++;
    else {
      const ids = (Array.isArray(txIds) ? txIds : []).filter((t): t is string => typeof t === "string" && TX_ID.test(t)).slice(0, 10);
      if (!ids.length) return false;
      s.trades++;
      this.data.trades = [...this.data.trades.slice(-(MAX_TRADES - 1)), { ref, txIds: ids, at: now }];
    }
    this.flushSoon();
    return true;
  }

  summary() {
    return { refs: this.data.refs, recentTrades: this.data.trades.slice(-50) };
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    writeJsonFile(this.file, this.data);
  }

  private flushSoon() {
    if (this.timer || !this.file) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref();
  }
}
