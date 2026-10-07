/** Where a dollar price for one QU can come from. Exchange pairs are USDT, treated as dollars. */
export interface PriceSource {
  name: string;
  /** USD for one QU. */
  fetch(): Promise<number>;
}

const getJson = async (url: string, fetchFn: typeof fetch) => {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<any>;
};

/** Five independent places that quote QU in dollars: two aggregators and three exchanges. */
export function defaultSources(fetchFn: typeof fetch = fetch): PriceSource[] {
  return [
    { name: "CoinGecko", fetch: async () => Number((await getJson("https://api.coingecko.com/api/v3/simple/price?ids=qubic-network&vs_currencies=usd", fetchFn))["qubic-network"].usd) },
    { name: "CoinPaprika", fetch: async () => Number((await getJson("https://api.coinpaprika.com/v1/tickers/qubic-qubic", fetchFn)).quotes.USD.price) },
    { name: "Gate.io", fetch: async () => Number((await getJson("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=QUBIC_USDT", fetchFn))[0].last) },
    { name: "MEXC", fetch: async () => Number((await getJson("https://api.mexc.com/api/v3/ticker/price?symbol=QUBICUSDT", fetchFn)).price) },
    { name: "Bitget", fetch: async () => Number((await getJson("https://api.bitget.com/api/v2/spot/market/tickers?symbol=QUBICUSDT", fetchFn)).data[0].lastPr) },
  ];
}

export interface Aggregate {
  /** The price to use, or null if these readings should not be trusted. */
  price: number | null;
  /** How many readings agreed with each other. */
  agreeing: number;
  note: string;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Turns several readings into one price, or refuses. Readings further than `disagree` from the median are
 * thrown out. With several sources, two or more must agree. After that, a move of more than `jump` from the
 * last accepted price is only believed if at least two sources back it: one source going wild is how a wrong
 * price gets in.
 */
export function aggregate(readings: number[], last: number | null, o: { disagree?: number; jump?: number; minReadings?: number; jumpQuorum?: number } = {}): Aggregate {
  const disagree = o.disagree ?? 0.15;
  const jump = o.jump ?? 0.25;
  const minReadings = o.minReadings ?? 3;
  const jumpQuorum = o.jumpQuorum ?? 3;
  const good = readings.filter((x) => Number.isFinite(x) && x > 0);
  if (!good.length) return { price: null, agreeing: 0, note: "no source answered" };
  // A price is a vote: with fewer than three sources answering (the other failing, or being blocked), one of them could be anything, so none is believed.
  if (good.length < minReadings) return { price: null, agreeing: 0, note: `only ${good.length} source${good.length === 1 ? "" : "s"} answered and at least ${minReadings} are needed` };
  const m = median(good);
  const agree = good.filter((x) => Math.abs(x / m - 1) <= disagree);
  if (agree.length < 2) return { price: null, agreeing: agree.length, note: "the sources disagree" };
  let price = median(agree);
  if (last !== null && Math.abs(price / last - 1) > jump) {
    // A big move needs a real majority, and even then it is taken in steps of at most `jump` per reading: a price that is wrong (or bought) cannot
    // make the subscription nearly free all at once, and a real move still gets through within a few readings.
    if (agree.length < jumpQuorum) return { price: null, agreeing: agree.length, note: `the price moved by more than ${Math.round(jump * 100)}% and fewer than ${jumpQuorum} sources back it` };
    price = last * (price > last ? 1 + jump : 1 - jump);
    return { price, agreeing: agree.length, note: `${agree.length} of ${good.length} sources agree on a big move; taking it ${Math.round(jump * 100)}% at a time` };
  }
  return { price, agreeing: agree.length, note: `${agree.length} of ${good.length} sources agree` };
}

/** Rounds up to `sig` significant figures, so a price reads as 1,800,000 QU and not 1,751,334 QU. */
export function ceilSig(x: number, sig = 3): number {
  if (x <= 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(x)) - sig + 1);
  return Math.ceil(x / step - 1e-9) * step;
}

/** QU worth `usd` dollars, rounded up a little to a tidy figure and never below QPayhub's 100 QU minimum. */
export const usdToQu = (usd: number, usdPerQu: number): number => Math.max(100, ceilSig(usd / usdPerQu, 3));

export interface Rate {
  usdPerQu: number;
  /** When it was measured (ms since epoch). */
  at: number;
  note: string;
}

export interface FeedOptions {
  /** How long a reading is used before asking the sources again. Default 5 minutes. */
  ttlMs?: number;
  /** How old the last good price may be when the sources cannot be used. Default 6 hours. */
  maxAgeMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
  /** Called with each accepted price, and `initial` is the one the last run ended with: so a restart does not forget the last good price (and with it every check against a jump). */
  save?: (rate: Rate) => void;
  initial?: Rate | null;
}

/** The QU price in dollars, kept fresh and checked. If the sources cannot be trusted it keeps the last good price for a while, then stops. */
export class PriceFeed {
  private sources: PriceSource[];
  private ttl: number;
  private maxAge: number;
  private now: () => number;
  private log: (msg: string) => void;
  private save: (rate: Rate) => void;
  private last: Rate | null = null;
  private inflight: Promise<Rate> | null = null;

  constructor(sources: PriceSource[], o: FeedOptions = {}) {
    this.sources = sources;
    this.ttl = o.ttlMs ?? 5 * 60_000;
    this.maxAge = o.maxAgeMs ?? 6 * 3_600_000;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.save = o.save ?? (() => {});
    if (o.initial && Number.isFinite(o.initial.usdPerQu) && o.initial.usdPerQu > 0) this.last = { ...o.initial, note: "kept from the last run" };
  }

  /** The current price. Throws if there is none that can be trusted. */
  async rate(): Promise<Rate> {
    if (this.last && this.now() - this.last.at < this.ttl) return this.last;
    this.inflight ??= this.refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async refresh(): Promise<Rate> {
    const results = await Promise.allSettled(this.sources.map((s) => s.fetch()));
    const readings: number[] = [];
    results.forEach((r, k) => {
      if (r.status === "fulfilled") readings.push(r.value);
      else this.log(`[price] ${this.sources[k].name} failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    });
    const agg = aggregate(readings, this.last?.usdPerQu ?? null);
    const now = this.now();
    if (agg.price !== null) {
      this.last = { usdPerQu: agg.price, at: now, note: agg.note };
      this.save(this.last);
      this.log(`[price] 1 QU = $${agg.price.toExponential(4)} (${agg.note})`);
      return this.last;
    }
    this.log(`[price] not updated: ${agg.note}`);
    if (this.last && now - this.last.at < this.maxAge) return this.last; // keep using the last good price for a while
    throw new Error("The QU price is not available right now, so a dollar price cannot be worked out. Please try again in a few minutes.");
  }
}
