import { activityKey } from "./activity.ts";
import { DAY } from "./history.ts";
import { isObject, readJsonFile, writeJsonFile } from "./safefile.ts";
import { SLOT_MS, rollUp } from "./trades.ts";
import type { Hour, TradeCandle } from "./trades.ts";

/**
 * Older QX history from Quhub (quhub.app), a community site that runs an open copy of the Qubic QX service. The Qubic archive has no trade records
 * before April 2026, so this is the only place older QX trades can be had without asking someone for a file.
 *
 *  - It is read once, by `npm run import-quhub`, into a file (`.cache/quhub.json`); QMax never calls Quhub while it runs.
 *  - Every number from the network is checked before it is kept (it is somebody else's server).
 *  - It is NOT chain-verified: the chain cannot confirm it before April 2026, and over the months where both exist it agrees with what QMax reads from
 *    the archive to within about a percent, not exactly. So it is always marked (`src: "quhub"`), shown only before the archive's own data begins,
 *    and never used for anything but the candle chart.
 *  - What it has: for every asset a daily summary (lowest and highest price, units, QU, average price, trades) back to October 2024, and for an asset
 *    with 1,000 trades or fewer in its whole life (most of them) every one of those trades with its time. QX only: there is no QSwap here.
 */

export const QUHUB_API = "https://api.quhub.app/service/v1/qx";
/** The most trades one list answers with. An asset with more than this has only its daily summary here. */
export const TRADE_LIST_MAX = 1000;

export interface DailyPoint {
  /** The day, as the API writes it: "2025-08-20T00:00:00Z". */
  time: string;
  min: number;
  max: number;
  totalShares: number;
  totalAmount: number;
  averagePrice: number;
  totalTrades: number;
}
export interface QuhubTrade {
  tickTime: string;
  transactionHash: string;
  price: number;
  numberOfShares: number;
  bid: boolean;
}
export interface AssetHistory {
  symbol: string;
  issuer: string;
  daily: DailyPoint[];
  /** Every trade the asset ever had, oldest first: present only when the list was complete (as many trades as the daily summaries add up to). */
  trades?: QuhubTrade[];
}
export interface Snapshot {
  v: 1;
  source: "quhub";
  /** When it was read (ms). */
  fetchedAt: number;
  /** By `symbol|issuer`. */
  assets: Record<string, AssetHistory>;
}

const EARLIEST_MS = Date.UTC(2024, 0, 1);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const whole = (v: unknown): v is number => num(v) && Number.isSafeInteger(v);

/** Daily points that are well formed, one per day, oldest first. Anything else is dropped. */
export function cleanDaily(raw: unknown, now = Date.now()): DailyPoint[] {
  if (!Array.isArray(raw)) return [];
  const by = new Map<number, DailyPoint>();
  for (const r of raw.slice(0, 5000)) {
    if (!isObject(r) || typeof r.time !== "string") continue;
    const t = Date.parse(r.time);
    if (!Number.isFinite(t) || t < EARLIEST_MS || t > now + DAY || t % DAY !== 0) continue;
    const p = { min: Number(r.min), max: Number(r.max), totalShares: Number(r.totalShares), totalAmount: Number(r.totalAmount), averagePrice: Number(r.averagePrice), totalTrades: Number(r.totalTrades) };
    if (![p.min, p.max, p.averagePrice].every((x) => num(x) && x > 0 && x < 1e15) || ![p.totalShares, p.totalAmount, p.totalTrades].every((x) => whole(x) && x > 0)) continue;
    if (p.min > p.max || p.averagePrice < p.min * 0.999 || p.averagePrice > p.max * 1.001) continue; // an average outside its own range is a broken day
    by.set(t, { time: new Date(t).toISOString().replace(".000Z", "Z"), ...p });
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

/**
 * Trades that are well formed, oldest first. Identical rows are all kept: one transaction can fill two orders of the same size at the same price, and
 * the list says so with two identical rows (its length then matches the daily summaries' trade counts exactly, which is how this was found). The list is
 * one page, so there is no overlap between pages to remove.
 */
export function cleanTrades(raw: unknown, now = Date.now()): QuhubTrade[] {
  if (!Array.isArray(raw)) return [];
  const out: (QuhubTrade & { ms: number })[] = [];
  for (const r of raw.slice(0, TRADE_LIST_MAX)) {
    if (!isObject(r) || typeof r.tickTime !== "string" || typeof r.transactionHash !== "string" || !/^[a-z]{60}$/.test(r.transactionHash)) continue;
    const ms = Date.parse(r.tickTime);
    const price = Number(r.price);
    const shares = Number(r.numberOfShares);
    if (!Number.isFinite(ms) || ms < EARLIEST_MS || ms > now + DAY || !num(price) || price <= 0 || price >= 1e15 || !whole(shares) || shares <= 0) continue;
    out.push({ tickTime: new Date(ms).toISOString().replace(".000Z", "Z"), transactionHash: r.transactionHash, price, numberOfShares: shares, bid: r.bid === true, ms });
  }
  return out.sort((a, b) => a.ms - b.ms).map(({ ms: _ms, ...t }) => t);
}

/**
 * Daily candles from the daily summaries. A summary has no open or close, so a candle is drawn from the day's average: it opens at the previous day's
 * average and closes at this day's, with the day's lowest and highest price as its range. Approximate, and marked so.
 */
export function dailyCandles(points: DailyPoint[]): TradeCandle[] {
  return points.map((p, i) => ({
    t: Date.parse(p.time),
    o: i > 0 ? points[i - 1].averagePrice : p.averagePrice,
    h: p.max,
    l: p.min,
    c: p.averagePrice,
    volumeQu: p.totalAmount,
    volumeQty: p.totalShares,
    trades: p.totalTrades,
    src: "quhub" as const,
    approx: true,
  }));
}

/** The start of the UTC day a time falls in. */
export const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;

/** What was read, kept in memory: asks for candles of older days. */
export class ImportedHistory {
  readonly fetchedAt: number;
  private daily = new Map<string, TradeCandle[]>();
  private slots = new Map<string, Hour[]>();
  private count = { assets: 0, tradeAssets: 0, trades: 0, days: 0 };

  constructor(snapshot: Snapshot | null) {
    this.fetchedAt = snapshot?.fetchedAt ?? 0;
    for (const a of Object.values(snapshot?.assets ?? {})) {
      let key: string;
      try {
        key = activityKey(a.symbol, a.issuer);
      } catch {
        continue;
      }
      const daily = cleanDaily(a.daily);
      if (daily.length) {
        this.daily.set(key, dailyCandles(daily));
        this.count.assets++;
        this.count.days += daily.length;
      }
      const trades = cleanTrades(a.trades);
      if (trades.length) {
        // The same minute-sized pieces the archive's trades are kept in, so the same arithmetic (open by the first trade, close by the last) applies.
        const by = new Map<number, Hour>();
        trades.forEach((t, i) => {
          const ms = Date.parse(t.tickTime);
          const slot = Math.floor(ms / SLOT_MS) * SLOT_MS;
          const qu = t.price * t.numberOfShares;
          const pos: [number, number] = [ms, i]; // order within this list: time, then place in the list
          const h = by.get(slot);
          if (!h) by.set(slot, { hour: slot, qu, qty: t.numberOfShares, n: 1, open: t.price, close: t.price, closeMs: ms, high: t.price, low: t.price, first: pos, last: pos });
          else {
            h.qu += qu;
            h.qty += t.numberOfShares;
            h.n++;
            h.high = Math.max(h.high, t.price);
            h.low = Math.min(h.low, t.price);
            h.last = pos;
            h.close = t.price;
            h.closeMs = ms;
          }
        });
        this.slots.set(key, [...by.values()]);
        this.count.tradeAssets++;
        this.count.trades += trades.length;
      }
    }
  }

  static fromFile(file: string): ImportedHistory {
    return new ImportedHistory(readSnapshotFile(file) ?? null);
  }

  stats() {
    return { ...this.count, fetchedAt: this.fetchedAt };
  }

  has(key: string) {
    return this.daily.has(key) || this.slots.has(key);
  }

  /**
   * Candles `intervalMs` wide for days before `beforeMs` (the start of what the archive holds), from `sinceMs` on. Where the asset has every trade it
   * has real candles of any width from a minute up; otherwise only daily ones exist, and nothing narrower than a day can be made. QX only.
   */
  candles(key: string, intervalMs: number, sinceMs: number, beforeMs: number): TradeCandle[] {
    const slots = this.slots.get(key);
    if (slots) {
      const width = Math.max(SLOT_MS, Math.round(intervalMs / SLOT_MS) * SLOT_MS);
      return rollUp(slots.filter((s) => s.hour < beforeMs), width, sinceMs)
        .filter((h) => h.hour < beforeMs)
        .map((h) => ({ t: h.hour, o: h.open, h: h.high, l: h.low, c: h.close, volumeQu: h.qu, volumeQty: h.qty, trades: h.n, src: "quhub" as const }));
    }
    if (intervalMs < DAY) return [];
    return (this.daily.get(key) ?? []).filter((c) => c.t >= sinceMs && c.t < beforeMs);
  }
}

/**
 * Which older candles go in front of the ones read from the archive: only when the caller asked for them (the candle chart), not for "QSwap only"
 * (Quhub is QX only), and only for days before the day the archive's records begin, so nothing is counted twice.
 */
export function olderCandles(imported: ImportedHistory, key: string, q: { venue: "auto" | "QX" | "QSwap" | "all"; intervalMs: number; sinceMs: number; withImported?: boolean }, archiveStartMs: number | null): TradeCandle[] {
  if (!q.withImported || q.venue === "QSwap" || !archiveStartMs) return [];
  return imported.candles(key, q.intervalMs, q.sinceMs, dayStart(archiveStartMs));
}

// ---------------------------------------------------------------------------------------------- reading it

export interface ImportOptions {
  /** The assets to read: symbol and issuer. */
  assets: { symbol: string; issuer: string }[];
  fetch?: typeof fetch;
  /** Pause between requests, ms. One a second is what this was tried with. */
  delayMs?: number;
  /** Told as each asset is done. */
  onAsset?: (symbol: string, info: { days: number; trades: number | null; note?: string }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getJson(url: string, f: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<unknown> {
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await f(url, { headers: { accept: "application/json", "user-agent": "QMax history import (one-time, about 80 requests, 1 per second)" }, redirect: "error", signal: AbortSignal.timeout(40_000) });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        await sleep(Math.min(30_000, 2_000 * 2 ** attempt)); // asked to slow down: do
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (/HTTP 4\d\d/.test(lastError)) throw e instanceof Error ? e : new Error(lastError);
      await sleep(2_000 * 2 ** attempt);
    }
  }
  throw new Error(lastError || "no answer");
}

/**
 * Reads every asset's daily summary and, for those whose whole history fits in one list, the list. Slow on purpose (a request a second); stops if the
 * server keeps failing. Returns what it got, never writes anything itself.
 */
export async function readQuhub(o: ImportOptions): Promise<Snapshot> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? wait;
  const delay = o.delayMs ?? 1000;
  const now = (o.now ?? Date.now)();
  const out: Snapshot = { v: 1, source: "quhub", fetchedAt: now, assets: {} };
  let failures = 0;
  for (const a of o.assets) {
    if (!/^[A-Za-z0-9]{1,7}$/.test(a.symbol) || !/^[A-Z]{60}$/.test(a.issuer)) continue;
    const base = `${QUHUB_API}/issuer/${a.issuer}/asset/${a.symbol}`;
    try {
      const daily = cleanDaily(await getJson(`${base}/chart/average-price`, f, sleep), now);
      failures = 0;
      if (!daily.length) {
        o.onAsset?.(a.symbol, { days: 0, trades: null, note: "no history" });
        await sleep(delay);
        continue;
      }
      const entry: AssetHistory = { symbol: a.symbol, issuer: a.issuer, daily };
      const total = daily.reduce((n, d) => n + d.totalTrades, 0);
      let tradesRead: number | null = null;
      let note: string | undefined;
      if (total <= TRADE_LIST_MAX) {
        await sleep(delay);
        const list = cleanTrades(await getJson(`${base}/trades?page=0&size=${TRADE_LIST_MAX}`, f, sleep), now);
        // Used only if it is the whole history: as many trades as the daily summaries say there were.
        if (list.length === total) {
          entry.trades = list;
          tradesRead = list.length;
        } else note = `the list has ${list.length} of ${total} trades, so only the daily summary is kept`;
      } else note = `${total.toLocaleString("en-US")} trades: daily summary only`;
      out.assets[`${a.symbol}|${a.issuer}`] = entry;
      o.onAsset?.(a.symbol, { days: daily.length, trades: tradesRead, note });
    } catch (e) {
      failures++;
      o.onAsset?.(a.symbol, { days: 0, trades: null, note: `failed: ${e instanceof Error ? e.message : e}` });
      if (failures >= 5) throw new Error("Quhub failed five times in a row: stopping, so as not to keep hitting a server that is struggling.");
    }
    await sleep(delay);
  }
  return out;
}

/** The saved snapshot, or undefined if there is none (or it is not one: it is then set aside, not trusted). */
export function readSnapshotFile(file: string): Snapshot | undefined {
  return readJsonFile<Snapshot>(file, (v) => isObject(v) && v.v === 1 && v.source === "quhub" && isObject(v.assets));
}

export function saveSnapshot(file: string, s: Snapshot): void {
  writeJsonFile(file, s);
}
