import { readFileSync } from "node:fs";
import { writeJsonFile } from "./safefile.ts";
import type { ActivityIndex } from "./activity.ts";
import { assetNameToU64, identityToBytes } from "./identity.ts";
import { QSWAP_INDEX, QX_INDEX, structReader, structWriter } from "./rpc.ts";
import type { QubicRpc } from "./rpc.ts";

/** Issuer of every smart contract's shares (the contract itself issues them). */
export const CONTRACT_ISSUER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFXIB";

export type Category = "contract" | "token";

export interface AssetEntry {
  /** What users and the API call it: the symbol, or SYMBOL.ISSUER5 if two issuers share a name. */
  id: string;
  symbol: string;
  issuer: string;
  /** "contract" = smart contract shares; "token" = anything else. */
  category: Category;
  venues: ("QX" | "QSwap")[];
  /** Last known price in QU per unit (pool price, else middle of the best bid/ask). */
  priceQu: number | null;
  /** Rough size of the market in QU (pool reserves plus top of book), used for sorting. */
  liquidityQu: number;
  probedAt: number;
  /** Best QX ask and bid (QU per unit), when there is an order book. */
  bestAsk?: number | null;
  bestBid?: number | null;
  askQty?: number | null;
  bidQty?: number | null;
  /** Pool reserves (QU and asset units), when a QSwap pool exists. */
  poolQu?: number | null;
  poolAsset?: number | null;
  /** When QMax first saw this market, and the last time its pool reserves were seen to change. */
  observedSince?: number;
  poolSig?: string;
  poolChangedAt?: number;
  /** Computed on read: "active" = an order or pool change within two epochs; "inactive" = none (certain); "unknown" = not enough data yet. */
  activity?: "active" | "inactive" | "unknown";
  lastActiveAt?: number | null;
}

/** An epoch lasts a week, so two epochs is 14 days. */
const TWO_EPOCHS_MS = 14 * 24 * 3_600_000;
/** How long a pool must sit unchanged before we call it quiet. */
const POOL_QUIET_MS = 24 * 3_600_000;

interface Candidate {
  symbol: string;
  issuer: string;
}

export interface CatalogOptions {
  /** Token names or explicit { symbol, issuer } to always include. */
  seeds?: (string | { symbol: string; issuer: string; assetName?: string })[];
  /** Persist probed results here so restarts start with a full list. */
  cachePath?: string;
  /** Concurrent probes (the public RPC rate-limits). Default 3. */
  concurrency?: number;
  /** Re-probe interval. Default 10 minutes. */
  refreshMs?: number;
  /** Assets never to list, probe or quote (deprecated or unwanted), matched by issuer and optionally symbol. */
  hidden?: { issuer: string; symbol?: string; reason?: string }[];
  /** Source of QX order activity; without it, activity is only inferred from pool changes. */
  activity?: ActivityIndex;
  /** Called with every asset after each refresh, for example to record prices over time. */
  onRefresh?: (entries: AssetEntry[]) => void;
}

/** How long a search answer is reused, and how much longer than that an empty one is. */
const SEARCH_CACHE_MS = 60_000;
const SEARCH_EMPTY_EXTRA_MS = 9 * 60_000;

const entryKey = (c: Candidate) => `${c.symbol}|${c.issuer}`;

/**
 * Anyone can issue an asset with any seven characters for a name, and the name goes straight into the website, the Discord bot's messages and
 * the API's answers. Names that are not plain letters and digits (markdown, mentions, look-alike symbols, control characters) are not listed.
 */
export const isListableName = (s: unknown, issuer: unknown): boolean => typeof s === "string" && /^[A-Za-z0-9]{1,7}$/.test(s) && typeof issuer === "string" && /^[A-Z]{60}$/.test(issuer);
const pageSize = 256;

export class AssetCatalog {
  private rpc: QubicRpc;
  private opts: Required<Omit<CatalogOptions, "cachePath" | "seeds" | "activity" | "hidden" | "onRefresh">> & Pick<CatalogOptions, "cachePath" | "seeds" | "activity" | "hidden" | "onRefresh">;
  private entries = new Map<string, AssetEntry>();
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  /** True once the first discovery pass has finished (earlier results come from the cache). */
  ready = false;

  constructor(rpc: QubicRpc, opts: CatalogOptions = {}) {
    this.rpc = rpc;
    this.opts = { concurrency: 3, refreshMs: 10 * 60_000, ...opts };
    this.loadCache();
    for (const [k, e] of this.entries) if (this.isHidden(e)) this.entries.delete(k); // e.g. cached before it was hidden
    this.assignIds();
  }

  private isHidden(c: Candidate): boolean {
    return (this.opts.hidden ?? []).some((h) => h.issuer === c.issuer && (!h.symbol || h.symbol === c.symbol));
  }

  /** Loads cache, then discovers and probes in the background. Resolves when the first pass is done. */
  async start(): Promise<void> {
    const first = this.refresh();
    this.timer = setInterval(() => void this.refresh().catch(() => {}), this.opts.refreshMs);
    this.timer.unref?.();
    return first;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  list(filter: { category?: Category; q?: string } = {}): AssetEntry[] {
    const q = filter.q?.trim().toUpperCase();
    return [...this.entries.values()]
      .filter((e) => e.venues.length > 0)
      .map((e) => this.withActivity(e))
      .filter((e) => !filter.category || e.category === filter.category)
      .filter((e) => !q || e.symbol.toUpperCase().includes(q) || e.id.toUpperCase().split(".")[0].includes(q)) // by the name on the chain, or by the id QMax gives it (QTREATSC; not by the issuer part of QTREAT.QDOGE)
      .sort((a, b) => b.liquidityQu - a.liquidityQu || a.symbol.localeCompare(b.symbol));
  }

  /** Progress of the two-epoch order-history scan (1 = finished). */
  get activityStatus() {
    return { ready: this.opts.activity?.complete ?? false, progress: this.opts.activity?.progress ?? 0 };
  }

  private withActivity(e: AssetEntry): AssetEntry {
    const idx = this.opts.activity;
    const now = Date.now();
    const qxAt = idx && e.venues.includes("QX") ? idx.lastQxOrderAt(e.symbol, e.issuer) : null;
    const lastActiveAt = Math.max(qxAt ?? 0, e.poolChangedAt ?? 0) || null;
    let activity: AssetEntry["activity"];
    if (lastActiveAt !== null && lastActiveAt >= now - TWO_EPOCHS_MS) activity = "active";
    else {
      const qxKnown = !e.venues.includes("QX") || (idx?.complete ?? false);
      const poolKnown = !e.venues.includes("QSwap") || now - (e.observedSince ?? now) >= POOL_QUIET_MS;
      activity = qxKnown && poolKnown ? "inactive" : "unknown";
    }
    return { ...e, activity, lastActiveAt };
  }

  find(id: string): AssetEntry | undefined {
    const key = id.toUpperCase();
    return [...this.entries.values()].find((e) => e.id.toUpperCase() === key);
  }

  private searches = new Map<string, { at: number; result: Promise<AssetEntry[]> }>();

  /**
   * Looks a token up on the network by name (any issuer), probes it, and adds tradable matches. Each name is looked up once a minute at most
   * (and a name with nothing tradable is remembered for ten), and callers asking at the same time share one lookup: a search costs several
   * node requests, so asking for it again must not.
   */
  search(name: string): Promise<AssetEntry[]> {
    if (!/^[A-Za-z0-9]{1,7}$/.test(name)) return Promise.resolve([]);
    const key = name.toUpperCase();
    const now = Date.now();
    const hit = this.searches.get(key);
    if (hit && now - hit.at < SEARCH_CACHE_MS) return hit.result;
    if (this.searches.size >= 500) for (const k of [...this.searches.keys()].slice(0, 100)) this.searches.delete(k);
    const result = this.lookUp(key);
    const entry = { at: now, result };
    this.searches.set(key, entry);
    // A failure is not remembered, and an empty answer is remembered longer (nobody can make it more expensive by repeating it).
    result.then(
      (r) => {
        if (!r.length) entry.at = Date.now() + SEARCH_EMPTY_EXTRA_MS;
      },
      () => this.searches.get(key) === entry && this.searches.delete(key),
    );
    return result;
  }

  private async lookUp(name: string): Promise<AssetEntry[]> {
    const found = await this.issuances(`assetName=${encodeURIComponent(name)}`);
    const matches = found.filter((c) => c.symbol.toUpperCase() === name && !this.isHidden(c));
    const before = this.entries.size;
    await this.probeAll(matches);
    this.assignIds();
    // Writing the whole catalog to disk is for a search that found something new, not for every name asked about.
    if (this.entries.size !== before) this.saveCache();
    return matches.map((c) => this.entries.get(entryKey(c))).filter((e): e is AssetEntry => !!e && e.venues.length > 0);
  }

  // Discovery ---------------------------------------------------------------------------------

  private async issuances(query: string): Promise<Candidate[]> {
    const res = await this.rpc.get<{ assets?: { data: { name: string; issuerIdentity: string } }[] }>(
      `/v1/assets/issuances${query ? "?" + query : ""}`,
    );
    return (res.assets ?? []).filter((a) => isListableName(a?.data?.name, a?.data?.issuerIdentity)).map((a) => ({ symbol: a.data.name, issuer: a.data.issuerIdentity }));
  }

  private async discover(): Promise<Candidate[]> {
    // Probe order matters on a rate-limited node: contract shares and seeded tokens first, the long
    // tail of the (capped) issuance list last.
    const out = new Map<string, Candidate>();
    const add = (c: Candidate) => out.has(entryKey(c)) || out.set(entryKey(c), c);
    (await this.issuances(`issuerIdentity=${CONTRACT_ISSUER}`).catch(() => [])).forEach(add);
    for (const s of this.opts.seeds ?? []) {
      if (typeof s === "string") (await this.issuances(`assetName=${encodeURIComponent(s)}`).catch(() => [])).forEach((c) => c.symbol === s && add(c));
      else add({ symbol: s.assetName ?? s.symbol, issuer: s.issuer });
    }
    for (const e of this.entries.values()) if (e.venues.length) add({ symbol: e.symbol, issuer: e.issuer }); // searched/cached markets
    (await this.issuances("").catch(() => [])).forEach(add);
    return [...out.values()];
  }

  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        await this.probeAll(await this.discover());
        this.assignIds();
        this.saveCache();
        this.ready = true;
        try {
          this.opts.onRefresh?.(this.list());
        } catch {
          // a failing listener must not stop the catalog
        }
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  // Probing -----------------------------------------------------------------------------------

  private async probeAll(all: Candidate[]) {
    const candidates = all.filter((c) => !this.isHidden(c));
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const c = candidates[next++];
        try {
          this.entries.set(entryKey(c), await this.probe(c));
          this.assignIds(); // keep ids unique while a scan is still running, not only after it ends
        } catch {
          // keep the previous result (if any) when the RPC hiccups
        }
      }
    };
    await Promise.all(Array.from({ length: this.opts.concurrency }, worker));
  }

  private async probe(c: Candidate): Promise<AssetEntry> {
    const issuer = identityToBytes(c.issuer);
    const name = assetNameToU64(c.symbol);
    const book = (fn: number) => this.rpc.query(QX_INDEX, fn, structWriter(48).id(issuer).u64(name).u64(0).bytes);
    const [asks, bids, pool] = await Promise.all([
      book(2),
      book(3),
      this.rpc.query(QSWAP_INDEX, 2, structWriter(40).id(issuer).u64(name).bytes),
    ]);
    const top = (raw: Uint8Array) => {
      const r = structReader(raw);
      return r.length >= pageSize && r.i64(40) > 0 && r.i64(32) > 0 ? { price: r.i64(32), qty: r.i64(40) } : null;
    };
    const ask = top(asks);
    const bid = top(bids);
    const p = structReader(pool);
    const hasPool = p.length >= 24 && p.i64(0) === 1 && p.i64(8) > 0 && p.i64(16) > 0;

    const venues: AssetEntry["venues"] = [];
    if (ask || bid) venues.push("QX");
    if (hasPool) venues.push("QSwap");
    const poolPrice = hasPool ? p.i64(8) / p.i64(16) : null;
    const prev = this.entries.get(entryKey(c));
    const poolSig = hasPool ? `${p.i64(8)}|${p.i64(16)}` : undefined;
    const now = Date.now();
    const poolChangedAt = poolSig && prev?.poolSig && prev.poolSig !== poolSig ? now : prev?.poolChangedAt;
    const mid = ask && bid ? (ask.price + bid.price) / 2 : (ask ?? bid)?.price ?? null;
    return {
      id: c.symbol,
      symbol: c.symbol,
      issuer: c.issuer,
      category: c.issuer === CONTRACT_ISSUER ? "contract" : "token",
      venues,
      priceQu: poolPrice ?? mid,
      liquidityQu: (hasPool ? 2 * p.i64(8) : 0) + (ask ? ask.price * ask.qty : 0) + (bid ? bid.price * bid.qty : 0),
      bestAsk: ask?.price ?? null,
      bestBid: bid?.price ?? null,
      askQty: ask?.qty ?? null,
      bidQty: bid?.qty ?? null,
      poolQu: hasPool ? p.i64(8) : null,
      poolAsset: hasPool ? p.i64(16) : null,
      probedAt: now,
      observedSince: prev?.observedSince ?? now,
      poolSig,
      poolChangedAt,
    };
  }

  /**
   * Two issuers can share a name (e.g. the QTREAT contract's shares and a QTREAT token). The contract's shares get "SC" after the name (QTREATSC; an asset name is at
   * most 7 letters on the chain, so this cannot be another asset's own name) and the token keeps the plain one; if two tokens share a name too, they get the shortest issuer
   * prefix that tells them apart (QTREAT.QDOGE). The id is only what QMax and its API call the asset: on the chain it stays the symbol.
   */
  private assignIds() {
    const bySymbol = new Map<string, AssetEntry[]>();
    for (const e of this.entries.values()) bySymbol.set(e.symbol, [...(bySymbol.get(e.symbol) ?? []), e]);
    for (const group of bySymbol.values()) {
      const tradable = group.filter((e) => e.venues.length > 0);
      const tokens = group.filter((e) => e.category === "token");
      const shared = tradable.length > 1;
      let len = 5;
      while (len < 60 && new Set(tokens.map((e) => e.issuer.slice(0, len))).size < tokens.length) len++;
      for (const e of group) {
        if (e.category === "contract") {
          const sc = `${e.symbol}SC`;
          // (an asset really called that would keep the name: the contract then takes a dot instead)
          e.id = shared && tokens.length > 0 ? (bySymbol.has(sc) ? `${e.symbol}.SC` : sc) : e.symbol;
        } else e.id = tokens.length > 1 ? `${e.symbol}.${e.issuer.slice(0, len)}` : e.symbol;
      }
    }
  }

  // Cache -------------------------------------------------------------------------------------

  private loadCache() {
    if (!this.opts.cachePath) return;
    try {
      for (const e of JSON.parse(readFileSync(this.opts.cachePath, "utf8")) as AssetEntry[]) if (isListableName(e?.symbol, e?.issuer)) this.entries.set(entryKey(e), e);
      this.assignIds();
    } catch {
      // no cache yet
    }
  }

  private saveCache() {
    if (!this.opts.cachePath) return;
    try {
      writeJsonFile(this.opts.cachePath, [...this.entries.values()]);
    } catch {
      // read-only deployments just skip caching
    }
  }
}
