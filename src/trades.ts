import { readFileSync, renameSync } from "node:fs";
import { writeJsonFile } from "./safefile.ts";
import { QSWAP_CONTRACT, QX_CONTRACT, lastLogTick, scanTrades } from "./events.ts";
import type { Trade } from "./events.ts";
import { DAY, HOUR } from "./history.ts";
import type { Sample } from "./history.ts";
import type { QubicRpc } from "./rpc.ts";

/** The finest piece of time trades are kept in: a minute. Candles of any width from a minute up (and the hourly sums the rest of QMax reads) are built from these. */
export const SLOT_MS = 60_000;

/** Everything that traded in one stretch of time on one venue, summed. Enough for a volume-weighted price and for candles. (`hours()` hands these out one hour wide.) */
export interface Hour {
  /** Start of the hour (or, inside the index, of the minute), ms since epoch */
  hour: number;
  /** QU and units that changed hands, and how many trades. */
  qu: number;
  qty: number;
  n: number;
  /** First and last trade of the hour (by tick, then log number), with the time of the last one. */
  open: number;
  close: number;
  closeMs: number;
  high: number;
  low: number;
  /** Position of the first and last trade, to keep them right when hours arrive out of order. */
  first: [tick: number, log: number];
  last: [tick: number, log: number];
}

export type Venue = "QX" | "QSwap";

/** One candle of real trades: open, high, low, close and how much traded. A bucket with no trades has no candle. */
export interface TradeCandle {
  /** Start of the bucket, ms since epoch (UTC) */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** QU and units that changed hands, and the number of trades. */
  volumeQu: number;
  volumeQty: number;
  trades: number;
  /** Set on a candle that did not come from the archive: "quhub" (src/quhub.ts), which the chain cannot confirm. Absent on every candle QMax read itself. */
  src?: "quhub";
  /** With `src`: a daily summary drawn as a candle (open and close are the previous and this day's average price), not real trades. */
  approx?: boolean;
}
/** A minute of trading, in the same shape as an hour: `hour` is where the minute starts. */
type Slot = Hour;
type Book = Record<Venue, Map<number, Slot>>;

const WINDOW_MS = 14 * DAY;
const KEEP_TOP_MS = DAY; // a clock that runs behind must not cut off the newest ticks
const before = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

interface State {
  /** 1 was hours, 2 is minutes. */
  v: 2;
  /** Everything up to and including this tick has been read. */
  highTick: number;
  /** The newest tick the first (backward) scan was allowed to see; later ticks are read forward. */
  ceilTick: number;
  /** Everything from this time (ms) up to the ceiling has been read. */
  lowMs: number;
}

type Row = [hour: number, qu: number, qty: number, n: number, open: number, close: number, closeMs: number, high: number, low: number, f0: number, f1: number, l0: number, l1: number];

const toRow = (h: Hour): Row => [h.hour, h.qu, h.qty, h.n, h.open, h.close, h.closeMs, h.high, h.low, ...h.first, ...h.last];
const fromRow = (r: Row): Hour => ({ hour: r[0], qu: r[1], qty: r[2], n: r[3], open: r[4], close: r[5], closeMs: r[6], high: r[7], low: r[8], first: [r[9], r[10]], last: [r[11], r[12]] });

/**
 * Merges slots into buckets `widthMs` wide (aligned to UTC), from `sinceMs` on. Open is the first trade by position (tick, then log number) and close
 * the last, wherever the slots came from, so QX and QSwap slots can be merged into one market.
 */
export function rollUp(slots: Iterable<Slot>, widthMs: number, sinceMs = 0): Hour[] {
  const by = new Map<number, Hour>();
  for (const s of slots) {
    if (s.hour < sinceMs) continue;
    const t = Math.floor(s.hour / widthMs) * widthMs;
    const b = by.get(t);
    if (!b) {
      by.set(t, { ...s, hour: t, first: s.first, last: s.last });
      continue;
    }
    b.qu += s.qu;
    b.qty += s.qty;
    b.n += s.n;
    b.high = Math.max(b.high, s.high);
    b.low = Math.min(b.low, s.low);
    if (before(s.first, b.first)) (b.first = s.first), (b.open = s.open);
    if (before(b.last, s.last)) (b.last = s.last), (b.close = s.close), (b.closeMs = s.closeMs);
  }
  return [...by.values()].sort((a, b) => a.hour - b.hour);
}

/**
 * What traded on QX and QSwap, minute by minute, read from the network's event log and kept on disk. It scans backwards once
 * (as far as the configured number of days; the archive's events start around epoch 207) and then only reads new ticks, so
 * restarts and repeated updates are cheap. Nothing here needs the node's own history: it is rebuilt from the public archive.
 */
export class TradeIndex {
  private rpc: QubicRpc;
  private file?: string;
  private days: number;
  private state: State = { v: 2, highTick: 0, ceilTick: 0, lowMs: 0 };
  private assets = new Map<string, Book>();
  /** Hourly sums are built from the minutes when asked for, and kept until a trade changes them. */
  private hourCache = new Map<string, Hour[]>();
  private count = { slots: 0, trades: 0, first: Infinity };
  private running?: Promise<void>;
  /** True once the whole configured span has been read. */
  complete = false;
  private horizonMs = 0;
  private onProgress?: () => void;
  private onTrades?: (trades: Trade[]) => void;

  constructor(rpc: QubicRpc, opts: { file?: string; days?: number; /** Called after each stretch of time has been read, so history can fill in while a long scan is still running. */ onProgress?: () => void; /** Told about trades from new ticks (not the backward scan) as soon as they are read, for a live feed. */ onTrades?: (trades: Trade[]) => void } = {}) {
    this.rpc = rpc;
    this.onProgress = opts.onProgress;
    this.onTrades = opts.onTrades;
    this.file = opts.file;
    this.days = opts.days ?? 1825;
    if (this.file) this.load();
  }

  /** Progress through the backward scan, 0 to 1. */
  get progress(): number {
    if (this.complete) return 1;
    if (!this.horizonMs || !this.state.lowMs) return 0;
    const total = this.state.ceilTick ? Date.now() + KEEP_TOP_MS - this.horizonMs : 0;
    return total > 0 ? Math.min(1, (Date.now() + KEEP_TOP_MS - this.state.lowMs) / total) : 0;
  }

  /** Reads new ticks and continues the backward scan. Safe to call repeatedly: overlapping calls share one run. */
  update(now = Date.now()): Promise<void> {
    this.running ??= this.run(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(now: number) {
    const latest = await lastLogTick(this.rpc);
    this.horizonMs = now - this.days * DAY;
    const s = this.state;
    if (!s.highTick) {
      s.highTick = s.ceilTick = latest;
      s.lowMs = now + KEEP_TOP_MS + 1;
    }

    // 1. New ticks since the last run.
    if (latest > s.highTick) {
      const trades = await this.read({ fromTick: s.highTick + 1, toTick: latest });
      this.absorb(trades);
      s.highTick = latest;
      this.save();
      if (trades.length) this.onTrades?.(trades);
      this.onProgress?.();
    }
    // 2. Older time, newest first, until the configured span is covered.
    while (s.lowMs > this.horizonMs) {
      const lo = Math.max(this.horizonMs, s.lowMs - WINDOW_MS);
      const trades = await this.read({ fromMs: lo, toMs: s.lowMs - 1, toTick: s.ceilTick });
      this.absorb(trades);
      s.lowMs = lo;
      this.save();
      this.onProgress?.();
    }
    this.complete = true;
  }

  /** Both contracts, held back until the whole span has been read so a failed run can safely be repeated. */
  private async read(span: Parameters<typeof scanTrades>[2]): Promise<Trade[]> {
    const out: Trade[] = [];
    for (const contract of [QX_CONTRACT, QSWAP_CONTRACT]) await scanTrades(this.rpc, contract, span, (t) => out.push(...t));
    return out.sort((a, b) => a.tick - b.tick || Number(a.logId) - Number(b.logId));
  }

  private absorb(trades: Trade[]) {
    if (trades.length) this.hourCache.clear();
    for (const t of trades) {
      let book = this.assets.get(t.key);
      if (!book) this.assets.set(t.key, (book = { QX: new Map(), QSwap: new Map() }));
      const hour = Math.floor(t.t / SLOT_MS) * SLOT_MS;
      const pos: [number, number] = [t.tick, Number(t.logId)];
      const h = book[t.venue].get(hour);
      this.count.trades++;
      if (!h) {
        book[t.venue].set(hour, { hour, qu: t.qu, qty: t.qty, n: 1, open: t.price, close: t.price, closeMs: t.t, high: t.price, low: t.price, first: pos, last: pos });
        this.count.slots++;
        this.count.first = Math.min(this.count.first, hour);
        continue;
      }
      h.qu += t.qu;
      h.qty += t.qty;
      h.n += 1;
      h.high = Math.max(h.high, t.price);
      h.low = Math.min(h.low, t.price);
      if (before(pos, h.first)) (h.first = pos), (h.open = t.price);
      if (before(h.last, pos)) (h.last = pos), (h.close = t.price), (h.closeMs = t.t);
    }
  }

  /** The hours one asset traded on one venue, oldest first (built from the minutes). The array is the caller's to change. */
  hours(key: string, venue: Venue): Hour[] {
    const id = `${key}|${venue}`;
    let rows = this.hourCache.get(id);
    if (!rows) this.hourCache.set(id, (rows = rollUp(this.assets.get(key)?.[venue].values() ?? [], HOUR)));
    return [...rows];
  }

  /**
   * The asset's price over time as history samples: one per hour that had trades, the volume-weighted average price on the
   * venue named (or on the other one, if it never traded there). An average, not the last trade, because a swap's price
   * includes rounding and price impact and a lone tiny trade would otherwise draw a spike.
   */
  samples(key: string, prefer: Venue): Sample[] {
    return this.hours(key, this.venueFor(key, prefer)).map((h) => ({ t: h.closeMs, price: h.qu / h.qty, bid: null, ask: null, pool: null, liq: 0, src: "trades" as const }));
  }

  /** The venue to draw an asset from: the one asked for, or the other if the asked one never traded. */
  venueFor(key: string, prefer: Venue): Venue {
    return this.assets.get(key)?.[prefer].size ? prefer : prefer === "QX" ? "QSwap" : "QX";
  }

  /**
   * Candles of real trades, `intervalMs` wide (a whole number of minutes, aligned to UTC), from `sinceMs` on. `venue` is one
   * market, or "all" to treat QX and QSwap as one market: the highs and lows then span both and the volume adds up.
   * Built from the minute sums, so a candle cannot be narrower than a minute.
   */
  candles(key: string, venue: Venue | "all", intervalMs: number, sinceMs = 0): TradeCandle[] {
    const book = this.assets.get(key);
    if (!book) return [];
    const width = Math.max(SLOT_MS, Math.round(intervalMs / SLOT_MS) * SLOT_MS);
    const slots = venue === "all" ? [...book.QX.values(), ...book.QSwap.values()] : book[venue].values();
    return rollUp(slots, width, sinceMs).map((h) => ({ t: h.hour, o: h.open, h: h.high, l: h.low, c: h.close, volumeQu: h.qu, volumeQty: h.qty, trades: h.n }));
  }

  /** What traded on both venues since a time: QU volume and number of trades. */
  volume(key: string, sinceMs: number): { volumeQu: number; trades: number } {
    let volumeQu = 0;
    let trades = 0;
    const book = this.assets.get(key);
    if (book)
      for (const v of ["QX", "QSwap"] as const)
        for (const h of book[v].values())
          if (h.hour + SLOT_MS > sinceMs) {
            volumeQu += h.qu;
            trades += h.n;
          }
    return { volumeQu, trades };
  }

  /**
   * How far the price moved over the last `windowMs` (a day by default), in percent: the last trade against the price a window ago. The price a
   * window ago is the last trade before the window began; an asset that was not trading then is measured from its first trade inside it. Both ends
   * are on the one venue that traded last (QX and QSwap prices sit a little apart, and mixing them would show a move that is not one). Null when
   * nothing traded inside the window, or when there is only one trade to compare with itself.
   */
  change(key: string, nowMs: number, windowMs = 24 * 3_600_000): number | null {
    const book = this.assets.get(key);
    if (!book) return null;
    const cutoff = nowMs - windowMs;
    let venue: Venue | null = null;
    let lastMs = -Infinity;
    for (const v of ["QX", "QSwap"] as const) for (const h of book[v].values()) if (h.closeMs > lastMs) (lastMs = h.closeMs), (venue = v);
    if (!venue || lastMs <= cutoff) return null;
    let last: Hour | null = null;
    let before: Hour | null = null; // the latest slot that ended at or before the cutoff
    let first: Hour | null = null; // the earliest slot that ended after it
    for (const h of book[venue].values()) {
      if (!last || h.closeMs > last.closeMs) last = h;
      if (h.closeMs <= cutoff) {
        if (!before || h.closeMs > before.closeMs) before = h;
      } else if (!first || h.hour < first.hour) first = h;
    }
    if (!last) return null;
    const ref = before ? before.close : first ? first.open : null;
    if (ref === null || !(ref > 0)) return null;
    if (!before && first === last && first.n <= 1) return null; // a single trade has nothing to be compared with
    return (last.close / ref - 1) * 100;
  }

  /**
   * The newest trade's price (QU per unit: the close of the newest minute with trades, on whichever market traded last) and when that minute ended. Null when
   * the asset has no trades on record. The list shows it as the price whenever it is newer than the order books were read.
   */
  /** The newest trade of an asset, and the market it was on: on `venue` only when one is named, otherwise on either (QX first, so QX wins a tie). */
  last(key: string, venue?: Venue): { price: number; ms: number; venue: Venue } | null {
    const book = this.assets.get(key);
    if (!book) return null;
    let best: Hour | null = null;
    let on: Venue = "QX";
    for (const v of venue ? [venue] : (["QX", "QSwap"] as const))
      for (const h of book[v].values())
        if (!best || h.closeMs > best.closeMs) {
          best = h;
          on = v;
        }
    return best && best.close > 0 ? { price: best.close, ms: best.closeMs, venue: on } : null;
  }

  /** Counts for a status line. `slots` is the number of minutes (per asset and venue) that had trades. */
  stats() {
    return { assets: this.assets.size, slots: this.count.slots, trades: this.count.trades, firstMs: Number.isFinite(this.count.first) ? this.count.first : null, highTick: this.state.highTick, lowMs: this.state.lowMs };
  }

  private load() {
    try {
      const raw = JSON.parse(readFileSync(this.file!, "utf8")) as { state: Omit<State, "v"> & { v?: number }; assets: Record<string, Record<Venue, Row[]>> };
      if (raw.state?.v === 1) {
        // The first version kept hours, which cannot be split into minutes: it is put aside and everything is read again from the archive (a few minutes, newest first).
        try {
          renameSync(this.file!, `${this.file}.v1.bak`);
        } catch {
          // it will be overwritten by the first save
        }
        return;
      }
      if (raw.state?.v !== 2) return;
      this.state = { ...raw.state, v: 2 };
      for (const [key, b] of Object.entries(raw.assets)) {
        const book: Book = { QX: new Map(), QSwap: new Map() };
        for (const v of ["QX", "QSwap"] as const)
          for (const r of b[v] ?? []) {
            const slot = fromRow(r);
            book[v].set(r[0], slot);
            this.count.slots++;
            this.count.trades += slot.n;
            this.count.first = Math.min(this.count.first, slot.hour);
          }
        this.assets.set(key, book);
      }
    } catch {
      // first run, or unreadable: start empty
    }
  }

  private save() {
    if (!this.file) return;
    try {
      const assets: Record<string, Record<Venue, Row[]>> = {};
      for (const [key, b] of this.assets) assets[key] = { QX: [...b.QX.values()].map(toRow), QSwap: [...b.QSwap.values()].map(toRow) };
      writeJsonFile(this.file, { state: this.state, assets });
    } catch {
      // read-only deployments just skip caching
    }
  }
}
