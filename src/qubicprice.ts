import type { Rate } from "../bot/price.ts";
import { RouteError, oneOf } from "./routes.ts";
import type { Route } from "./routes.ts";

/**
 * The price of QU itself in dollars, for the top of the page and a chart of it. The price comes from the checked median of five sources
 * (bot/price.ts: CoinGecko, CoinPaprika and three exchanges), the same one that prices the Discord subscription. The extras (change over 24
 * hours, market value, volume) and the candles come from CoinGecko, kept for a few minutes so the page can ask as often as it likes without
 * the server asking them again. If they cannot be reached the last good answer is kept for hours; with none, the call fails and the page
 * simply shows no price.
 */

export interface QuStats {
  change24hPct: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
}
export interface QuSnapshot extends QuStats {
  usdPerQu: number;
  /** When the price was measured (ms since epoch). */
  at: number;
  /** How many of the sources agreed. */
  note: string;
}
/** Dollars for one QU. */
export interface QuCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** A candle of QU in dollars with how many QU traded in it (from an exchange, which reports volume; CoinGecko's candles do not). */
export interface QuKline extends QuCandle {
  /** QU traded. */
  v: number;
}

/** How far back a chart goes, and the `days` CoinGecko is asked for. */
export const QU_RANGES = { "1d": "1", "7d": "7", "30d": "30", "90d": "90", "1y": "365", all: "max" } as const;
export type QuRange = keyof typeof QU_RANGES;

interface Deps {
  rate(): Promise<Rate>;
  fetchFn?: typeof fetch;
  now?: () => number;
  statsTtlMs?: number;
  candlesTtlMs?: number;
  /** How old a kept answer may be when a fresh one cannot be had. */
  staleMs?: number;
}

/** The most candles one chart answer holds (the latest, when a range at a fine width has more). */
export const KLINE_MAX = 5000;
/** How far back each range goes for the exchange candles (null: as far as the exchange has them). */
const KLINE_SPAN: Record<QuRange, number | null> = { "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000, "1y": 365 * 86_400_000, all: null };
const KLINE_NAMES: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

/** How many candles one request to each exchange returns (MEXC answers 500 at most whatever limit is asked for, and only the latest ones unless it is given a window of time). */
const PAGE = { mexc: 500, gate: 1000 } as const;

const BASE = "https://api.coingecko.com/api/v3";
const ID = "qubic-network";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class QubicPrice {
  private d: Required<Omit<Deps, "rate" | "fetchFn">> & Pick<Deps, "rate" | "fetchFn">;
  private statsCache: { at: number; value: QuStats } | null = null;
  private candleCache = new Map<QuRange, { at: number; value: { intervalMs: number; candles: QuCandle[] } }>();
  private klineCache = new Map<string, { at: number; value: QuKline[] }>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(deps: Deps) {
    this.d = { statsTtlMs: 5 * 60_000, candlesTtlMs: 10 * 60_000, staleMs: 6 * 3_600_000, now: Date.now, ...deps };
  }

  private get<T>(url: string): Promise<T> {
    const f = this.d.fetchFn ?? fetch;
    return f(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } }).then((res) => {
      if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
      return res.json() as Promise<T>;
    });
  }

  /** One request at a time for the same thing: a page that asks twice at once makes one call. */
  private once<T>(key: string, make: () => Promise<T>): Promise<T> {
    const have = this.inflight.get(key);
    if (have) return have as Promise<T>;
    const p = make().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async stats(): Promise<QuStats> {
    const now = this.d.now();
    if (this.statsCache && now - this.statsCache.at < this.d.statsTtlMs) return this.statsCache.value;
    try {
      const body = await this.once("stats", () => this.get<Record<string, Record<string, unknown>>>(`${BASE}/simple/price?ids=${ID}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`));
      const q = body?.[ID] ?? {};
      const value: QuStats = { change24hPct: num(q.usd_24h_change), marketCapUsd: num(q.usd_market_cap), volume24hUsd: num(q.usd_24h_vol) };
      this.statsCache = { at: now, value };
      return value;
    } catch (e) {
      if (this.statsCache && now - this.statsCache.at < this.d.staleMs) return this.statsCache.value;
      throw e;
    }
  }

  /**
   * Candles of QU in dollars at a width the chart can ask for (a minute to a day), with the QU traded in each, reaching back `spanMs` (null: as far as
   * the exchange goes). They come from MEXC's QUBIC/USDT market (USDT is treated as a dollar), 500 at a time and as many pages back as the range needs, and from
   * Gate.io's if MEXC cannot be reached (and for the days before MEXC listed it, in a long range at 4-hour or daily candles). Kept a minute; if neither answers a kept answer is used for hours.
   */
  async klines(intervalMs: number, spanMs: number | null, maxCandles = KLINE_MAX): Promise<QuKline[]> {
    const names = KLINE_WIDTHS[intervalMs];
    if (!names) throw new RouteError(400, "That candle width is not available for QU");
    const key = `${intervalMs}|${spanMs}`;
    const now = this.d.now();
    const kept = this.klineCache.get(key);
    if (kept && now - kept.at < 60_000) return kept.value;
    const since = spanMs === null ? 0 : now - spanMs;
    const page = async (source: "mexc" | "gate", end: number): Promise<QuKline[]> =>
      source === "mexc"
        ? parseMexcKlines(await this.get<unknown>(`https://api.mexc.com/api/v3/klines?symbol=QUBICUSDT&interval=${names.mexc}&limit=${PAGE.mexc}&startTime=${end - PAGE.mexc * intervalMs}&endTime=${end}`))
        : parseGateKlines(await this.get<unknown>(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=QUBIC_USDT&interval=${names.gate}&limit=${PAGE.gate}&to=${Math.floor(end / 1000)}`));
    const read = async (source: "mexc" | "gate", from = now, room = maxCandles): Promise<QuKline[]> => {
      let out: QuKline[] = [];
      let end = from;
      let oldest = Infinity;
      for (let i = 0; i < Math.ceil(room / PAGE[source]) + 1 && out.length < room; i++) {
        const got = await page(source, end);
        if (got.length === 0) break;
        out = tidy([...got, ...out]);
        // Far enough back, or no more. (MEXC answers a window of time and may skip a quiet stretch, so only an empty window ends it; Gate.io answers
        // the latest candles before a time, so a short answer is the start of its records.)
        if (out[0].t <= since || (source === "gate" && got.length < PAGE.gate) || out[0].t >= oldest) break;
        oldest = out[0].t;
        end = out[0].t - 1;
      }
      return out.filter((k) => k.t >= since).slice(-room);
    };
    try {
      const value = await this.once(`k${key}`, async () => {
        const a = await read("mexc").catch(() => []);
        if (a.length === 0) return read("gate");
        // MEXC listed QU on 17 July 2024. A range that reaches back further is made up from Gate.io (where it first traded, on 9 May 2024) for the
        // days before, at the widths Gate.io still has that far back (it refuses finer ones, which is ignored: the chart then simply starts at MEXC's).
        if ((names.gate === "1d" || names.gate === "4h") && a.length < maxCandles && a[0].t > since + 2 * intervalMs) {
          const before = (await read("gate", a[0].t - 1, maxCandles - a.length).catch(() => [])).filter((k) => k.t < a[0].t);
          return [...before, ...a];
        }
        return a;
      });
      if (value.length === 0) throw new Error("no exchange had candles");
      this.klineCache.set(key, { at: now, value });
      return value;
    } catch (e) {
      if (kept && now - kept.at < this.d.staleMs) return kept.value;
      throw new RouteError(503, `The QU chart is not available right now (${e instanceof Error ? e.message : e}).`);
    }
  }

  /** The price now, with what is known about the last day (the extras are null when they cannot be had). */
  async current(): Promise<QuSnapshot> {
    let rate: Rate;
    try {
      rate = await this.d.rate();
    } catch (e) {
      throw new RouteError(503, e instanceof Error ? e.message : "The QU price is not available right now.");
    }
    const stats = await this.stats().catch((): QuStats => ({ change24hPct: null, marketCapUsd: null, volume24hUsd: null }));
    return { usdPerQu: rate.usdPerQu, at: rate.at, note: rate.note, ...stats };
  }

  /** Candles of the price in dollars. How wide each is depends on the range (CoinGecko decides: 30 minutes for a day, 4 hours up to a month, 4 days beyond). */
  async candles(range: QuRange): Promise<{ range: QuRange; intervalMs: number; candles: QuCandle[] }> {
    const now = this.d.now();
    const kept = this.candleCache.get(range);
    if (kept && now - kept.at < this.d.candlesTtlMs) return { range, ...kept.value };
    try {
      // CoinGecko's free plan only goes back a year (it refuses "max"), so the whole history is made from the exchanges' daily candles instead.
      const value =
        range === "all"
          ? { intervalMs: 86_400_000, candles: (await this.klines(86_400_000, null)).map(({ v: _v, ...c }) => c) }
          : await this.once(`c${range}`, async () => {
              const v = parseCandles(await this.get<unknown[]>(`${BASE}/coins/${ID}/ohlc?vs_currency=usd&days=${QU_RANGES[range]}`));
              if (v.candles.length === 0) throw new Error("CoinGecko returned no candles");
              return v;
            });
      this.candleCache.set(range, { at: now, value });
      return { range, ...value };
    } catch (e) {
      if (kept && now - kept.at < this.d.staleMs) return { range, ...kept.value };
      throw new RouteError(503, `The QU chart is not available right now (${e instanceof Error ? e.message : e}).`);
    }
  }
}

/** The widths an exchange will give candles for, in the names MEXC and Gate.io use. */
export const KLINE_WIDTHS: Record<number, { mexc: string; gate: string }> = {
  60_000: { mexc: "1m", gate: "1m" },
  300_000: { mexc: "5m", gate: "5m" },
  900_000: { mexc: "15m", gate: "15m" },
  1_800_000: { mexc: "30m", gate: "30m" },
  3_600_000: { mexc: "60m", gate: "1h" },
  14_400_000: { mexc: "4h", gate: "4h" },
  86_400_000: { mexc: "1d", gate: "1d" },
};

const finite = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

function toKline(t: unknown, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown): QuKline | null {
  const [tt, oo, hh, ll, cc, vv] = [t, o, h, l, c, v].map(finite);
  if (tt === null || oo === null || hh === null || ll === null || cc === null || vv === null) return null;
  if (!(tt > 0 && oo > 0 && hh > 0 && ll > 0 && cc > 0 && vv >= 0)) return null;
  return { t: tt, o: oo, h: Math.max(hh, oo, cc), l: Math.min(ll, oo, cc), c: cc, v: vv };
}

/** MEXC: `[openTime ms, open, high, low, close, volume in QU, closeTime, volume in USDT]`. */
export function parseMexcKlines(rows: unknown): QuKline[] {
  return Array.isArray(rows) ? rows.flatMap((r) => (Array.isArray(r) && r.length >= 6 ? toKline(r[0], r[1], r[2], r[3], r[4], r[5]) ?? [] : [])) : [];
}

/** Gate.io: `[time in seconds, volume in USDT, close, high, low, open, volume in QU, closed]`. */
export function parseGateKlines(rows: unknown): QuKline[] {
  return Array.isArray(rows)
    ? rows.flatMap((r) => {
        if (!Array.isArray(r) || r.length < 7) return [];
        const t = finite(r[0]);
        return t === null ? [] : toKline(t * 1000, r[5], r[3], r[4], r[2], r[6]) ?? [];
      })
    : [];
}

/** Sorted oldest first, one per time. */
const tidy = (list: QuKline[]): QuKline[] => [...new Map(list.map((k) => [k.t, k])).values()].sort((a, b) => a.t - b.t);

/** CoinGecko's `[time, open, high, low, close]` rows as candles, oldest first, one per time, with the spacing between them. Rows that are not numbers or not prices are dropped. */
export function parseCandles(rows: unknown): { intervalMs: number; candles: QuCandle[] } {
  const by = new Map<number, QuCandle>();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 5) continue;
      const [t, o, h, l, c] = r.map(num);
      if (t === null || o === null || h === null || l === null || c === null) continue;
      if (!(o > 0 && h > 0 && l > 0 && c > 0 && t > 0)) continue;
      by.set(t, { t, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c });
    }
  }
  const candles = [...by.values()].sort((a, b) => a.t - b.t);
  const gaps = candles.slice(1).map((c, i) => c.t - candles[i].t).sort((a, b) => a - b);
  const intervalMs = gaps.length ? Math.max(60_000, gaps[gaps.length >> 1]) : 3_600_000;
  return { intervalMs, candles };
}

export function qubicRoutes(deps: { price: QubicPrice }): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/qu",
      limited: false,
      rate: { perMin: 120 },
      doc: {
        summary: "The price of QU in dollars",
        description:
          "One QU in US dollars: the median of five independent sources (CoinGecko, CoinPaprika, Gate.io, MEXC and Bitget; readings that disagree are dropped), with the change over 24 hours, the market value and the 24 hour volume where CoinGecko has them (null when it cannot be reached). Answers are kept for a few minutes.",
        responses: { "200": { description: "{ usdPerQu, at, note, change24hPct, marketCapUsd, volume24hUsd }" }, "503": { description: "No price that can be trusted right now" } },
      },
      handler: () => deps.price.current(),
    },
    {
      method: "GET",
      path: "/v1/qu/candles",
      limited: false,
      rate: { perMin: 60 },
      doc: {
        summary: "Candles of the QU price in dollars",
        description:
          "Open, high, low and close of one QU in US dollars. Without `interval` they are CoinGecko's, 30 minutes wide for `1d`, 4 hours for `7d` and `30d`, and 4 days beyond (`intervalMs` says which). With `interval` they are exchange candles from the QUBIC/USDT market on MEXC (Gate.io if MEXC cannot be reached) at that width, each with `v`, the QU traded in it; an answer holds at most the latest 5,000 (`truncated` says when there were more).",
        parameters: [
          { name: "range", in: "query", required: false, schema: { type: "string", enum: Object.keys(QU_RANGES), default: "7d" } },
          { name: "interval", in: "query", required: false, schema: { type: "string", enum: Object.keys(KLINE_NAMES) } },
        ],
        responses: {
          "200": { description: "{ range, intervalMs, candles: [{ t, o, h, l, c }] }, or with `interval`: { range, interval, intervalMs, truncated, candles: [{ t, o, h, l, c, v }] }" },
          "400": { description: "Invalid range or interval" },
          "503": { description: "No candles right now" },
        },
      },
      handler: async ({ query }) => {
        const range = oneOf(query, "range", Object.keys(QU_RANGES) as QuRange[], "7d");
        const interval = query.get("interval");
        if (interval === null || interval === "") return deps.price.candles(range);
        if (!Object.hasOwn(KLINE_NAMES, interval)) throw new RouteError(400, `interval must be one of ${Object.keys(KLINE_NAMES).join(", ")}`);
        const candles = await deps.price.klines(KLINE_NAMES[interval], KLINE_SPAN[range]);
        return { range, interval, intervalMs: KLINE_NAMES[interval], truncated: candles.length >= KLINE_MAX, candles };
      },
    },
  ];
}
