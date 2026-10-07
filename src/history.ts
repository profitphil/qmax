import { readFileSync } from "node:fs";
import { writeJsonFile } from "./safefile.ts";

/** What was seen about one asset at one moment. Prices are QU per unit. */
export interface Sample {
  /** ms since epoch */
  t: number;
  /** The price QMax shows for the asset (pool price, else the middle of the best bid and ask). */
  price: number | null;
  bid: number | null;
  ask: number | null;
  /** QSwap pool price, if there is a pool. */
  pool: number | null;
  /** Rough market size in QU. */
  liq: number;
  /** Set on samples that were not recorded live but rebuilt afterwards from the trades the network logged (an hourly average price). */
  src?: "trades";
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The ranges a chart can show. `null` means everything recorded. */
export const RANGES: Record<string, number | null> = { "1d": DAY, "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY, all: null };
export const isRange = (r: string): r is keyof typeof RANGES => Object.hasOwn(RANGES, r);

/** Recent samples are all kept; older ones are thinned to one per hour, and the oldest to one per day. */
const FULL_DETAIL = 3 * DAY;
const HOURLY_UNTIL = 90 * DAY;

/** Thins old samples so the file stays small however long QMax runs. Keeps the last sample of each hour (or day) it thins. */
export function compact(samples: Sample[], now: number): Sample[] {
  const out: Sample[] = [];
  let lastBucket = "";
  for (const s of samples) {
    const age = now - s.t;
    if (age <= FULL_DETAIL) {
      out.push(s);
      lastBucket = "";
      continue;
    }
    const bucket = age <= HOURLY_UNTIL ? `h${Math.floor(s.t / HOUR)}` : `d${Math.floor(s.t / DAY)}`;
    if (bucket === lastBucket) out[out.length - 1] = s; // a later sample in the same hour or day replaces the earlier one
    else out.push(s);
    lastBucket = bucket;
  }
  return out;
}

/** At most `max` samples, spread evenly in time (the last sample in each time slice), always keeping the first and the newest. */
export function downsample(samples: Sample[], max: number): Sample[] {
  if (samples.length <= max || max < 3) return samples;
  const from = samples[0].t;
  const span = samples[samples.length - 1].t - from || 1;
  const slices = new Map<number, Sample>();
  for (const s of samples) slices.set(Math.min(max - 1, Math.floor(((s.t - from) / span) * max)), s);
  const out = [...slices.values()];
  if (out[0].t !== samples[0].t) out.unshift(samples[0]);
  return out;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Open, high, low and close of the price in each interval. Intervals with no samples are left out. */
export function candles(samples: Sample[], intervalMs: number): Candle[] {
  const out: Candle[] = [];
  for (const s of samples) {
    if (s.price === null) continue;
    const t = Math.floor(s.t / intervalMs) * intervalMs;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, s.price);
      last.l = Math.min(last.l, s.price);
      last.c = s.price;
    } else out.push({ t, o: s.price, h: s.price, l: s.price, c: s.price });
  }
  return out;
}

type Row = [number, number | null, number | null, number | null, number | null, number, "trades"?];

/**
 * Prices over time, recorded by QMax itself: the public network gives only the current state, so history exists
 * from the day recording started. Kept in memory and saved to one file.
 */
export class HistoryStore {
  private file?: string;
  private data = new Map<string, Sample[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastCompact = 0;

  constructor(file?: string) {
    this.file = file;
    if (file) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Row[]>;
        for (const [asset, rows] of Object.entries(raw)) this.data.set(asset, rows.map(([t, price, bid, ask, pool, liq, src]) => ({ t, price, bid, ask, pool, liq, ...(src ? { src } : {}) })));
      } catch {
        // first run, or unreadable: start empty
      }
    }
  }

  /** Adds a sample. One that is not newer than the last one for that asset is ignored. */
  record(asset: string, s: Sample, now = Date.now()): void {
    const list = this.data.get(asset) ?? [];
    if (list.length && s.t <= list[list.length - 1].t) return;
    list.push(s);
    this.data.set(asset, list);
    if (now - this.lastCompact > DAY) {
      for (const [a, l] of this.data) this.data.set(a, compact(l, now));
      this.lastCompact = now;
    }
    this.saveSoon();
  }

  assets(): string[] {
    return [...this.data.keys()];
  }

  /** The earliest point there is for this asset (recorded live or rebuilt from trades), or null if there is none. */
  since(asset: string): number | null {
    return this.data.get(asset)?.[0]?.t ?? null;
  }

  /** When QMax itself started recording this asset: the first sample that was not rebuilt from trades. */
  recordedSince(asset: string): number | null {
    return this.data.get(asset)?.find((s) => !s.src)?.t ?? null;
  }

  /**
   * Adds samples rebuilt from past trades, only where nothing is there yet: an hour that already has a sample (as thinned
   * data is kept, so a day for the oldest) is left alone, so recorded data always wins and calling this again changes nothing.
   * Returns how many were added.
   */
  backfill(asset: string, derived: Sample[], now = Date.now()): number {
    if (!derived.length) return 0;
    const list = this.data.get(asset) ?? [];
    const bucket = (t: number) => (now - t <= HOURLY_UNTIL ? Math.floor(t / HOUR) : -1 - Math.floor(t / DAY));
    const taken = new Set(list.map((s) => bucket(s.t)));
    const add: Sample[] = [];
    for (const s of derived) {
      const b = bucket(s.t);
      if (taken.has(b)) continue;
      taken.add(b);
      add.push(s);
    }
    if (!add.length) return 0;
    this.data.set(asset, compact([...list, ...add].sort((a, b) => a.t - b.t), now));
    this.saveSoon();
    return add.length;
  }

  /** The samples in a range (null = all), thinned to at most `max` points. */
  series(asset: string, rangeMs: number | null, now = Date.now(), max = 400): Sample[] {
    const all = this.data.get(asset) ?? [];
    const inRange = rangeMs === null ? all : all.filter((s) => s.t >= now - rangeMs);
    return downsample(inRange, max);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    const out: Record<string, Row[]> = {};
    for (const [asset, list] of this.data) out[asset] = list.map((s): Row => (s.src ? [s.t, s.price, s.bid, s.ask, s.pool, s.liq, s.src] : [s.t, s.price, s.bid, s.ask, s.pool, s.liq]));
    writeJsonFile(this.file, out);
  }

  private saveSoon() {
    if (this.timer || !this.file) return;
    this.timer = setTimeout(() => this.flush(), 30_000);
    this.timer.unref();
  }
}
