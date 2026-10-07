import { activityKey } from "./activity.ts";
import { QSWAP_CONTRACT, QX_CONTRACT, lastLogTick, scanTrades } from "./events.ts";
import type { Trade } from "./events.ts";
import { DAY, HOUR } from "./history.ts";
import { RouteError, oneOf } from "./routes.ts";
import type { Route } from "./routes.ts";
import type { QubicRpc } from "./rpc.ts";

/**
 * A live tape of every QX fill and QSwap swap, newest first, with which way each one went and how much buying and selling
 * there was over a window. It is held in memory only: `warmup` refills it from the archive on start, and the trade index
 * announces new trades through `push`.
 *
 * The direction is the side of the party that STARTED the trade (the taker). A QSwap swap says so in its own log message. A
 * QX fill does not: QX logs the same message for both sides, so the side comes from the transaction that caused it.
 */

export type Side = "buy" | "sell";
export type TapeVenue = Trade["venue"];

/** One line of the tape. Everything here is exact (nothing is estimated); `side` is absent when it is not known. */
export interface TapeRow {
  /** Stable. Grows with the order rows arrived in, so a client can ask for what came after the last one it saw. */
  id: number;
  /** ms since epoch (the tick's timestamp). */
  t: number;
  venue: TapeVenue;
  /** The asset's id as QMax lists it: its symbol, or SYMBOL.ISSUER5 where two issuers share a name (see `symbolOf`). */
  asset: string;
  /** `assetNameAsNumber|issuerHex`, the key the trade index uses. */
  assetKey: string;
  /** Units of the asset. */
  qty: number;
  /** QU that changed hands. */
  qu: number;
  /** QU per unit (for a swap, fees and price impact included). */
  price: number;
  side?: Side;
  /** The transaction that caused the trade, when the archive says (the real archive always does). */
  txHash?: string;
}

/* ---------- which way a QX fill went ---------- */

/** QX's identity (contract 1) and the calls that place an order. Every fill happens inside one of these two. */
const QX_ID = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARMID";
const ADD_TO_ASK_ORDER = 5; // the sender offers units for sale
const ADD_TO_BID_ORDER = 6; // the sender offers QU to buy units

/**
 * The side of the person who sent a QX transaction: placing a bid (call 6) is buying, placing an ask (call 5) is selling. The
 * sender is the taker because the order it places is the one that matches what was already resting on the book.
 * Anything else (another contract, another call) is not a plain order, so there is no side to report.
 *
 * Checked on real data on 2026-10-04 against the shares the archive logs as moving. In 23 transactions (17 bids, 6 asks, 31 fills)
 * and again in all 109 of the day's QX transactions (142 fills): the shares went TO the sender in every bid and FROM the sender in
 * every ask, and their sum equalled the fills' units. The one exception is a self-trade, an order that matches the sender's own
 * resting order (shares move from the sender to the sender): there it still says what the sender did, though nobody really bought
 * or sold. That was 2 of those 109 transactions (3 fills, 0.04% of the QU), all from one account.
 */
export function sideFromTransaction(tx: { destination?: string; inputType?: number } | null | undefined): Side | undefined {
  if (!tx || tx.destination !== QX_ID) return undefined;
  if (tx.inputType === ADD_TO_BID_ORDER) return "buy";
  if (tx.inputType === ADD_TO_ASK_ORDER) return "sell";
  return undefined;
}

/** `unknown` says why there is no side: "not-an-order" is final, "unavailable" (the lookup failed) is worth trying again later. */
export interface SideResult {
  side?: Side;
  unknown?: "not-an-order" | "unavailable";
}
export type SideLookup = (txHash: string) => Promise<SideResult>;
export type SideResolver = SideLookup & { stats(): { lookups: number; cached: number; failed: number; calls: number; open: boolean } };

export interface SideResolverOptions {
  /** Lookups in flight at once. Default 3 (the RPC client spaces the requests out as well). */
  concurrency?: number;
  /** Extra attempts after a failed one. Default 1. The RPC client already retries rate limits and server errors itself. */
  retries?: number;
  /** Wait before the first retry (ms); doubles each time. Default 1500. */
  retryDelayMs?: number;
  /** Longest one attempt may take (ms). Default 35,000: a little longer than the RPC client's own 30 s, so its answer comes first. A slower lookup counts as failed and frees its place in the queue. */
  timeoutMs?: number;
  /** Results to remember. Default 5,000. */
  cacheSize?: number;
  /** After this many failed attempts in a row the archive is left alone for `cooldownMs`. Defaults 5 and 20,000. */
  breakAfter?: number;
  cooldownMs?: number;
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits for a promise for at most `ms`. The slower promise is left to finish on its own (a fetch cannot be taken back). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {}); // if the timer wins, a later failure must not become an unhandled rejection
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer after ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/**
 * Looks up which side a QX transaction took, from the archive (`getTransactionByHash`). At most a few lookups run at once,
 * each result is remembered by hash (one transaction can fill many orders, and the live feed and the warmup overlap), a failed
 * lookup is retried, and if the archive keeps failing it is left alone for a while. It never throws: a lookup that cannot be
 * done answers `{ unknown: "unavailable" }`, which is not remembered, so asking again later tries again.
 */
export function sideResolver(rpc: Pick<QubicRpc, "post">, opts: SideResolverOptions = {}): SideResolver {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const retries = Math.max(0, opts.retries ?? 1);
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 35_000;
  const cacheSize = opts.cacheSize ?? 5000;
  const breakAfter = Math.max(1, opts.breakAfter ?? 5);
  const cooldownMs = opts.cooldownMs ?? 20_000;
  const now = opts.now ?? Date.now;

  const cache = new Map<string, SideResult>();
  const inflight = new Map<string, Promise<SideResult>>();
  const waiting: (() => void)[] = [];
  let running = 0;
  let failures = 0; // attempts in a row that got no answer from the archive
  let pausedUntil = 0;
  const counts = { lookups: 0, cached: 0, failed: 0, calls: 0 };

  // A place is handed straight to the next in line, so the limit holds even when many are waiting.
  const acquire = () => (running < concurrency ? (running++, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  const resting = () => failures >= breakAfter && now() < pausedUntil;

  async function read(hash: string): Promise<SideResult> {
    for (let attempt = 0; ; attempt++) {
      if (resting()) return { unknown: "unavailable" };
      let answer: { transaction?: { destination?: string; inputType?: number }; destination?: string; inputType?: number } | undefined;
      try {
        counts.calls++;
        answer = await within(rpc.post<typeof answer>("/query/v1/getTransactionByHash", { hash }), timeoutMs);
      } catch (e) {
        // A definite refusal (RPC 4xx) means the archive is up; anything else (timeout, network, 5xx) counts towards leaving it alone.
        if (!/^RPC 4\d\d/.test(e instanceof Error ? e.message : "")) {
          failures++;
          if (failures >= breakAfter) pausedUntil = now() + cooldownMs;
        }
        counts.failed++;
        if (attempt >= retries) return { unknown: "unavailable" };
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      failures = 0;
      // The live API returns the transaction itself; its OpenAPI file shows it wrapped in `transaction`. Both are accepted.
      const tx = answer?.transaction ?? answer;
      if (typeof tx?.inputType !== "number") {
        counts.failed++;
        if (attempt >= retries) return { unknown: "unavailable" };
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      const side = sideFromTransaction(tx);
      return side ? { side } : { unknown: "not-an-order" };
    }
  }

  const lookup: SideLookup = (hash) => {
    counts.lookups++;
    const hit = cache.get(hash);
    if (hit) {
      counts.cached++;
      return Promise.resolve(hit);
    }
    const pending = inflight.get(hash);
    if (pending) return pending;
    if (resting()) return Promise.resolve({ unknown: "unavailable" });
    const job = (async () => {
      await acquire();
      try {
        return await read(hash);
      } finally {
        release();
      }
    })()
      .then((r) => {
        if (r.side || r.unknown === "not-an-order") {
          cache.set(hash, r);
          if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
        }
        return r;
      })
      .finally(() => inflight.delete(hash));
    inflight.set(hash, job);
    return job;
  };
  return Object.assign(lookup, { stats: () => ({ ...counts, open: resting() }) });
}

/* ---------- the tape ---------- */

export interface TapeDeps {
  /** The asset id for a key (`assetNameAsNumber|issuerHex`), or undefined if QMax does not list that asset (its trades are then ignored). */
  symbolOf(key: string): string | undefined;
  /** Finds the side of a QX fill by its transaction (see `sideResolver`). Left out, QX rows simply have no side. */
  resolveSide?: SideLookup;
}

export interface TapeOptions {
  /** Most rows kept. Default 3,000. The oldest go first. */
  capacity?: number;
  now?: () => number;
  /** Identifies this tape (see `TradeTape.instance`). Random by default. */
  instance?: string;
}

interface Slot {
  row: TapeRow;
  /** Position on the chain, to keep rows in order whatever order they arrive in. */
  tick: number;
  log: number;
  key?: string;
  /** For a QX row: "pending" while its side is being looked up, "failed" if that did not work (try again later), "final" once settled. */
  lookup: "none" | "pending" | "failed" | "final";
}

export interface FlowSide {
  qu: number;
  qty: number;
  trades: number;
}

/** Buying and selling over a window, counting only what the tape holds. Direction is the taker's. */
export interface Flow {
  sinceMs: number;
  buy: FlowSide;
  sell: FlowSide;
  /** Trades whose direction could not be read. They are left out of buy, sell and `pressure`, and counted here. */
  unknown: FlowSide;
  /** All trades in the window: buy + sell + unknown. */
  trades: number;
  /** buy QU minus sell QU. */
  netQu: number;
  /** (buy QU - sell QU) / (buy QU + sell QU): +1 if everything with a known side was a buy, -1 if all were sells. Null if nothing with a known side traded. */
  pressure: number | null;
  /** True if the tape cannot vouch for the whole window: it started (or dropped its oldest rows) after `sinceMs`. */
  partial: boolean;
  /** The earliest time the tape holds every trade from. */
  coveredFromMs: number;
}

const emptySide = (): FlowSide => ({ qu: 0, qty: 0, trades: 0 });
const after = (a: { tick: number; log: number }, b: { tick: number; log: number }) => a.tick > b.tick || (a.tick === b.tick && a.log > b.log);

export interface RecentQuery {
  /** An asset id, any case. */
  asset?: string;
  /** Default 50. */
  limit?: number;
  /** Only rows that arrived after this id. If more than `limit` did, the newest `limit` are returned. */
  sinceId?: number;
  venue?: TapeVenue;
}

export interface WarmupOptions {
  /** Width of one archive query (ms). Default 4 hours: a day of trades is a few hundred, so a window is a handful of requests. */
  windowMs?: number;
  /** Stop reading older windows after this long (ms). Default 3 minutes. */
  scanBudgetMs?: number;
  /** After the last window, stop waiting for QX sides after this long (ms); lookups still queued carry on in the background. Default 90 seconds. */
  resolveBudgetMs?: number;
  /** Lookups that failed (the archive was busy, or the resolver is resting after repeated failures) are tried again after this pause (ms), up to `retryPasses` times, within the budget. Defaults 10,000 and 3. */
  retryPauseMs?: number;
  retryPasses?: number;
  /** Extra pause between archive queries (ms), on top of the RPC client's own spacing. Default 0. */
  pauseMs?: number;
}

export interface WarmupResult {
  hours: number;
  windows: number;
  windowsRead: number;
  /** Trades the archive returned, and how many became rows (the rest were duplicates, unlisted assets, or too old for the tape). */
  tradesRead: number;
  rowsAdded: number;
  /** True if every window was read. */
  complete: boolean;
  /** Set if reading stopped early: the tape then holds the newest windows only (see `coveredFromMs`). */
  error?: string;
  coveredFromMs: number;
  /** QX rows still without a side when warmup returned (still being looked up, or the lookup failed). */
  sidesPending: number;
  ms: number;
}

/** A tick's clock can run ahead of ours, so the newest window reaches a day past "now" (the tick ceiling is what really bounds it). */
const KEEP_TOP_MS = DAY;

export class TradeTape {
  /**
   * Different for every tape, so for every start of the server. Ids start over then, and the same trade would turn up under a new
   * id: a client that sees this change must drop what it holds and start again instead of asking `since` its old cursor.
   */
  readonly instance: string;
  private deps: TapeDeps;
  private capacity: number;
  private now: () => number;
  /** Newest first. */
  private slots: Slot[] = [];
  private keys = new Set<string>();
  private nextId = 1;
  /** The tape has every trade from here on... */
  private scannedFrom: number;
  /** ...unless it dropped rows: everything up to the newest row it dropped is gone. */
  private droppedUpTo = 0;
  private inflight = new Set<Promise<void>>();
  private ignored = { unknownAsset: 0, duplicate: 0, invalid: 0, tooOld: 0 };

  constructor(deps: TapeDeps, opts: TapeOptions = {}) {
    this.deps = deps;
    this.capacity = Math.max(1, Math.floor(opts.capacity ?? 3000));
    this.now = opts.now ?? Date.now;
    this.scannedFrom = this.now();
    this.instance = opts.instance ?? `${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** The newest id handed out (0 if the tape never held a row), for the whole tape, whatever a query filters on. */
  get latestId(): number {
    return this.nextId - 1;
  }

  get size(): number {
    return this.slots.length;
  }

  /** The earliest time the tape holds every trade from: when it started (or its warmup began), or later if it has had to drop old rows. */
  get coveredFromMs(): number {
    return Math.max(this.scannedFrom, this.droppedUpTo);
  }

  /**
   * Adds trades and returns how many became rows. Unlisted assets, malformed trades and ones already seen are skipped (a trade
   * is the same trade if it has the same tick and log number; without a log number, the same transaction and position within
   * it). A QX fill with a transaction gets its side looked up in the background: the row is on the tape at once and its side
   * is filled in later under the same id.
   */
  push(trades: Trade[]): number {
    const ordinal = new Map<string, number>();
    const batch = trades.map((trade) => {
      let key: string | undefined;
      if (trade.logId) key = `${trade.tick}:${trade.logId}`;
      else if (trade.txHash) {
        const n = ordinal.get(trade.txHash) ?? 0;
        ordinal.set(trade.txHash, n + 1);
        key = `${trade.txHash}#${n}`;
      }
      return { trade, key, log: Number(trade.logId) || 0 };
    });
    // Oldest first, so ids grow with time within a batch.
    batch.sort((a, b) => a.trade.tick - b.trade.tick || a.log - b.log);

    const toLookUp = new Set<string>();
    let added = 0;
    for (const { trade: t, key, log } of batch) {
      if (!(t.qty > 0 && t.qu > 0 && Number.isFinite(t.price) && t.price > 0 && Number.isFinite(t.t) && Number.isFinite(t.tick))) {
        this.ignored.invalid++;
        continue;
      }
      let asset: string | undefined;
      try {
        asset = this.deps.symbolOf(t.key);
      } catch {
        // a lookup that throws means the same as one that does not know the asset
      }
      if (!asset) {
        this.ignored.unknownAsset++;
        continue;
      }
      if (key && this.keys.has(key)) {
        this.ignored.duplicate++;
        continue;
      }
      const slot: Slot = {
        row: { id: 0, t: t.t, venue: t.venue, asset, assetKey: t.key, qty: t.qty, qu: t.qu, price: t.price, ...(t.side ? { side: t.side } : {}), ...(t.txHash ? { txHash: t.txHash } : {}) },
        tick: t.tick,
        log,
        key,
        lookup: "none",
      };
      const at = this.indexFor(slot);
      if (at >= this.capacity) {
        // older than everything on a full tape: it would be dropped at once, so it never gets an id
        this.ignored.tooOld++;
        this.droppedUpTo = Math.max(this.droppedUpTo, t.t);
        continue;
      }
      slot.row.id = this.nextId++;
      if (slot.row.side) slot.lookup = "final";
      else if (t.venue === "QX" && t.txHash && this.deps.resolveSide) {
        slot.lookup = "pending";
        toLookUp.add(t.txHash);
      }
      this.slots.splice(at, 0, slot);
      if (key) this.keys.add(key);
      added++;
      while (this.slots.length > this.capacity) {
        const gone = this.slots.pop()!;
        if (gone.key) this.keys.delete(gone.key);
        this.droppedUpTo = Math.max(this.droppedUpTo, gone.row.t);
      }
    }
    this.track(toLookUp);
    return added;
  }

  /** Where a slot belongs in the newest-first list. */
  private indexFor(p: { tick: number; log: number }): number {
    let lo = 0;
    let hi = this.slots.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (after(this.slots[mid], p)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private track(hashes: Iterable<string>) {
    const lookup = this.deps.resolveSide;
    if (!lookup) return;
    for (const hash of hashes) {
      const job: Promise<void> = this.fill(lookup, hash).finally(() => this.inflight.delete(job));
      this.inflight.add(job);
    }
  }

  /** Looks one transaction up and gives its side to every QX row that came from it (one transaction can fill several orders). */
  private async fill(lookup: SideLookup, hash: string): Promise<void> {
    let result: SideResult;
    try {
      result = await lookup(hash);
    } catch {
      result = { unknown: "unavailable" };
    }
    for (const s of this.slots) {
      if (s.row.txHash !== hash || s.row.venue !== "QX" || s.row.side) continue;
      if (result.side) {
        s.row.side = result.side;
        s.lookup = "final";
      } else s.lookup = result.unknown === "not-an-order" ? "final" : "failed";
    }
  }

  /** Resolves once every side lookup started so far has finished (for tests, and for a warmup that wants to wait for them). */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** Tries again for QX rows whose lookup failed. Cheap when there are none. Returns how many rows got a side. */
  async resolvePending(): Promise<number> {
    const hashes = new Set<string>();
    const targets: Slot[] = [];
    for (const s of this.slots)
      if (s.lookup === "failed" && !s.row.side && s.row.txHash) {
        s.lookup = "pending";
        hashes.add(s.row.txHash);
        targets.push(s);
      }
    this.track(hashes);
    await this.settled();
    return targets.filter((s) => s.row.side).length;
  }

  /** The newest rows first, as copies (a row's side can still arrive after it was returned). */
  recent(q: RecentQuery = {}): TapeRow[] {
    const limit = Number.isFinite(q.limit) ? Math.max(1, Math.min(Math.floor(q.limit!), this.capacity)) : 50;
    const asset = q.asset?.toUpperCase();
    const out: TapeRow[] = [];
    for (const s of this.slots) {
      if (out.length >= limit) break;
      const r = s.row;
      if (q.sinceId !== undefined && r.id <= q.sinceId) continue;
      if (asset && r.asset.toUpperCase() !== asset) continue;
      if (q.venue && r.venue !== q.venue) continue;
      out.push({ ...r });
    }
    return out;
  }

  /**
   * Buying and selling since a time (ms), for one asset or all, on one venue or both. Volumes are sums of what traded; a trade
   * without a known side is counted separately and leaves the pressure alone, so a gap in the data cannot tilt it.
   */
  flow(asset: string | undefined, sinceMs: number, venue?: TapeVenue): Flow {
    const want = asset?.toUpperCase();
    const buy = emptySide();
    const sell = emptySide();
    const unknown = emptySide();
    for (const { row: r } of this.slots) {
      if (r.t < sinceMs) continue;
      if (want && r.asset.toUpperCase() !== want) continue;
      if (venue && r.venue !== venue) continue;
      const side = r.side === "buy" ? buy : r.side === "sell" ? sell : unknown;
      side.qu += r.qu;
      side.qty += r.qty;
      side.trades++;
    }
    const sided = buy.qu + sell.qu;
    const coveredFromMs = this.coveredFromMs;
    return {
      sinceMs,
      buy,
      sell,
      unknown,
      trades: buy.trades + sell.trades + unknown.trades,
      netQu: buy.qu - sell.qu,
      pressure: sided > 0 ? (buy.qu - sell.qu) / sided : null,
      partial: sinceMs < coveredFromMs,
      coveredFromMs,
    };
  }

  stats() {
    let withSide = 0;
    let lookingUp = 0;
    let failed = 0;
    for (const s of this.slots) {
      if (s.row.side) withSide++;
      else if (s.lookup === "pending") lookingUp++;
      else if (s.lookup === "failed") failed++;
    }
    return { rows: this.slots.length, capacity: this.capacity, latestId: this.latestId, coveredFromMs: this.coveredFromMs, withSide, lookingUp, lookupFailed: failed, ignored: { ...this.ignored } };
  }

  /** Waits until every lookup has finished or `end` (a real-clock time in ms) has come. */
  private async settledBy(end: number): Promise<void> {
    if (!this.inflight.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.settled(), new Promise<void>((r) => (timer = setTimeout(r, Math.max(0, end - Date.now()))))]);
    clearTimeout(timer);
  }

  /** Waits for QX sides for at most `budgetMs`; lookups that failed get a few more tries after a pause, as long as there is time. */
  private async waitForSides(budgetMs: number, passes: number, pauseMs: number): Promise<void> {
    const end = Date.now() + budgetMs;
    for (let pass = 0; ; pass++) {
      await this.settledBy(end);
      const failed = this.slots.some((s) => s.lookup === "failed" && !s.row.side);
      if (!failed || pass >= passes || Date.now() + pauseMs >= end) return;
      await sleep(pauseMs);
      void this.resolvePending(); // starts the lookups at once; the next turn of the loop waits for them
    }
  }

  /**
   * Fills the tape with the last `hours` of trades from the archive, newest window first, so something useful is there at once
   * and a failure partway leaves the newest part intact (`coveredFromMs` says how far back the tape can vouch for). Reads time
   * windows of both contracts, never past the last tick the archive has finished, one request at a time: the RPC client's
   * `maxRps` sets the pace. Never throws; a failure is reported in the result. Then waits (for a bounded time, retrying failed lookups) for QX sides.
   */
  async warmup(rpc: QubicRpc, hours = 24, opts: WarmupOptions = {}): Promise<WarmupResult> {
    const started = this.now();
    const windowMs = Math.max(HOUR / 4, opts.windowMs ?? 4 * HOUR);
    const scanBudgetMs = opts.scanBudgetMs ?? 3 * 60_000;
    const resolveBudgetMs = opts.resolveBudgetMs ?? 90_000;
    const span = Math.min(Math.max(hours, 0), 7 * 24); // the tape holds 3,000 rows: a week is more than it can keep anyway
    const start = started - span * HOUR;
    const windows: { fromMs: number; toMs: number }[] = [];
    for (let hi = started; hi > start; hi -= windowMs) windows.push({ fromMs: Math.max(start, hi - windowMs), toMs: windows.length === 0 ? started + KEEP_TOP_MS : hi - 1 });

    const result: WarmupResult = { hours: span, windows: windows.length, windowsRead: 0, tradesRead: 0, rowsAdded: 0, complete: false, coveredFromMs: this.coveredFromMs, sidesPending: 0, ms: 0 };
    try {
      const last = await lastLogTick(rpc);
      for (const w of windows) {
        if (this.now() - started > scanBudgetMs) throw new Error(`stopped after ${Math.round(scanBudgetMs / 1000)} s without reading everything`);
        const found: Trade[] = [];
        for (const contract of [QX_CONTRACT, QSWAP_CONTRACT]) {
          await scanTrades(rpc, contract, { fromMs: w.fromMs, toMs: w.toMs, toTick: last }, (t) => found.push(...t));
          if (opts.pauseMs) await sleep(opts.pauseMs);
        }
        result.tradesRead += found.length;
        result.rowsAdded += this.push(found);
        result.windowsRead++;
        this.scannedFrom = Math.min(this.scannedFrom, w.fromMs); // contiguous from the newest window down
      }
      result.complete = true;
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }

    await this.waitForSides(resolveBudgetMs, opts.retryPasses ?? 3, opts.retryPauseMs ?? 10_000);
    result.sidesPending = this.slots.filter((s) => s.row.venue === "QX" && !s.row.side && (s.lookup === "pending" || s.lookup === "failed")).length;
    result.coveredFromMs = this.coveredFromMs;
    result.ms = this.now() - started;
    return result;
  }
}

/* ---------- connecting the tape to the catalog ---------- */

/**
 * Builds the `symbolOf` the tape needs from the asset catalog's list. Keys are worked out once and kept; the list is read again
 * every minute, and sooner when a trade turns up for a key it does not know (a newly listed asset).
 */
export function catalogSymbolOf(
  list: () => { id: string; symbol: string; issuer: string }[],
  opts: { keyOf?: (symbol: string, issuer: string) => string; ttlMs?: number; missMs?: number; now?: () => number } = {},
): (key: string) => string | undefined {
  const keyOf = opts.keyOf ?? activityKey;
  const ttlMs = opts.ttlMs ?? 60_000;
  const missMs = opts.missMs ?? 5_000;
  const now = opts.now ?? Date.now;
  let map = new Map<string, string>();
  let builtAt = -Infinity;
  const rebuild = () => {
    const next = new Map<string, string>();
    for (const e of list()) {
      try {
        next.set(keyOf(e.symbol, e.issuer), e.id);
      } catch {
        // a name or issuer that cannot be encoded has no trades to match
      }
    }
    map = next;
    builtAt = now();
  };
  return (key) => {
    if (now() - builtAt > ttlMs) rebuild();
    let id = map.get(key);
    if (id === undefined && now() - builtAt > missMs) {
      rebuild();
      id = map.get(key);
    }
    return id;
  };
}

/* ---------- the API ---------- */

export interface TapeRouteDeps {
  tape: TradeTape;
  /** Whether QMax lists this asset id (any case). */
  knownAsset(id: string): boolean;
  now?: () => number;
}

const WINDOWS = { "1h": HOUR, "24h": DAY } as const;
const MAX_LIMIT = 200;

/** Reads a whole-number query parameter that may be left out. Throws a 400 otherwise. */
function wholeNumber(query: URLSearchParams, name: string, min: number, max: number | undefined, fallback: number | undefined): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) throw new RouteError(400, `${name} must be a whole number${max === undefined ? ` of ${min} or more` : ` from ${min} to ${max}`}`);
  return n;
}

function venueParam(query: URLSearchParams): TapeVenue | undefined {
  const raw = (query.get("venue") ?? "").trim();
  if (!raw) return undefined;
  const found = (["QX", "QSwap"] as const).find((v) => v.toLowerCase() === raw.toLowerCase());
  if (!found) throw new RouteError(400, "venue must be one of QX, QSwap");
  return found;
}

function assetParam(query: URLSearchParams, deps: TapeRouteDeps): string | undefined {
  const asset = (query.get("asset") ?? "").trim();
  if (!asset) return undefined;
  if (!deps.knownAsset(asset)) throw new RouteError(404, `Unknown asset '${asset}'`);
  return asset;
}

const ASSET_PARAM = { name: "asset", in: "query", required: false, schema: { type: "string" }, description: "An asset id as listed by /v1/assets. Leave out for all assets." };
const VENUE_PARAM = { name: "venue", in: "query", required: false, schema: { type: "string", enum: ["QX", "QSwap"] }, description: "Only trades on this venue." };

/**
 * `GET /v1/tape` (the newest trades, and the 24-hour buy and sell flow beside them) and `GET /v1/flow`. Both are answered
 * from memory, so neither is rate limited.
 */
export function tapeRoutes(deps: TapeRouteDeps): Route[] {
  const now = deps.now ?? Date.now;
  return [
    {
      method: "GET",
      path: "/v1/tape",
      limited: false,
      doc: {
        summary: "Live trade tape: the newest QX fills and QSwap swaps, newest first, with the direction of each",
        description:
          "Every fill on the QX order book and every swap on QSwap, from one feed. `side` is the direction of the party that started the trade (buy: they bought the asset); it is read from the swap's own log or, for a QX fill, from the transaction that caused it, and is missing for a QX fill whose transaction could not be read (yet). " +
          "Pass `since=<latestId>` from the last response to get only what came after: ids only grow, and a row keeps its id when its side arrives later, so a row whose side is missing can be fetched again by asking from before it. " +
          "If more than `limit` rows are newer than `since`, the newest `limit` are returned. Ids start over when the server restarts: `instance` changes then, and a client holding an old cursor should drop it. `flow24h` sums the last 24 hours for the same asset and venue (see /v1/flow).",
        parameters: [
          ASSET_PARAM,
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: 50 } },
          { name: "since", in: "query", required: false, schema: { type: "integer", minimum: 0 }, description: "Only rows with an id greater than this." },
          VENUE_PARAM,
        ],
        responses: {
          "200": { description: "{ trades: [{ id, t, venue, asset, assetKey, qty, qu, price, side?, txHash? }], latestId, instance, flow24h }" },
          "400": { description: "Invalid input" },
          "404": { description: "Unknown asset" },
        },
      },
      handler({ query }) {
        const asset = assetParam(query, deps);
        const limit = wholeNumber(query, "limit", 1, MAX_LIMIT, 50)!;
        const sinceId = wholeNumber(query, "since", 0, undefined, undefined);
        const venue = venueParam(query);
        return {
          trades: deps.tape.recent({ asset, limit, sinceId, venue }),
          latestId: deps.tape.latestId,
          instance: deps.tape.instance,
          flow24h: deps.tape.flow(asset, now() - DAY, venue),
        };
      },
    },
    {
      method: "GET",
      path: "/v1/flow",
      limited: false,
      doc: {
        summary: "Buy versus sell pressure over the last hour or 24 hours, from the live trade tape",
        description:
          "Volume in QU and units, and number of trades, that were buys and sells, and the net pressure (buy QU minus sell QU, over their sum: +1 all buying, -1 all selling, null if nothing with a known direction traded). " +
          "Direction is that of the party who started the trade. Trades whose direction is not known are counted in `unknown` and left out of the pressure. " +
          "`partial` is true when the tape has not covered the whole window yet (it was started or refilled later).",
        parameters: [ASSET_PARAM, { name: "window", in: "query", required: false, schema: { type: "string", enum: Object.keys(WINDOWS), default: "24h" } }, VENUE_PARAM],
        responses: { "200": { description: "{ asset, venue, window, sinceMs, buy, sell, unknown, trades, netQu, pressure, partial, coveredFromMs }" }, "400": { description: "Invalid input" }, "404": { description: "Unknown asset" } },
      },
      handler({ query }) {
        const asset = assetParam(query, deps);
        const window = oneOf(query, "window", Object.keys(WINDOWS) as (keyof typeof WINDOWS)[], "24h");
        const venue = venueParam(query);
        return { asset: asset ?? null, venue: venue ?? null, window, ...deps.tape.flow(asset, now() - WINDOWS[window], venue) };
      },
    },
  ];
}
