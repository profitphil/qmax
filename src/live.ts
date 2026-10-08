
/** How long a contract's fee table is kept before it is read again. */
const FEE_TABLE_KEEP_MS = 5 * 60_000;
import { fetchTransferFees } from "./fees.ts";
import { AssetCatalog } from "./catalog.ts";
import type { Category } from "./catalog.ts";
import { identityToBytes, assetNameToU64 } from "./identity.ts";
import type { AssetInfo, MarketData } from "./data.ts";
import { QSWAP_INDEX, QX_INDEX, QubicRpc, structReader, structWriter } from "./rpc.ts";
import type { Allocation, Venue } from "./types.ts";
import { QswapVenue, QxVenue } from "./venues.ts";
import type { BookLevel, QswapConfig, QxConfig } from "./venues.ts";

export interface AssetConfig {
  /** Symbol users send to the API, e.g. "QX". */
  symbol: string;
  /** 60-char issuer identity. */
  issuer: string;
  /** On-chain asset name; defaults to `symbol`. */
  assetName?: string;
}

export interface LiveOptions {
  rpc?: QubicRpc;
  /** How long fetched state is reused. Default 5s. */
  cacheMs?: number;
  /** Max QX orders fetched per side (256 per RPC page). Default 2048. */
  maxBookOrders?: number;
  /** Flat per-swap fee QSwap charges (QSWAP_ADDITIONAL_FEE in Qswap.h). */
  qswapOperationFeeQu?: number;
}

const QX_FN = { fees: 1, assetAsks: 2, assetBids: 3 };
const QSWAP_FN = { fees: 1, poolState: 2, quoteAssetInput: 6, quoteAssetOutput: 7 };
const PAGE = 256;

interface Cached {
  at: number;
  venues: Promise<Venue[]>;
}

export class LiveMarketData implements MarketData {
  private rpc: QubicRpc;
  private assetsBySymbol = new Map<string, AssetConfig>();
  private catalog?: AssetCatalog;
  private cacheMs: number;
  private maxBookOrders: number;
  private qswapOperationFeeQu: number;
  private cache = new Map<string, Cached>();

  /** `assets` is a fixed list, or a catalog that discovers assets and keeps them up to date. */
  constructor(assets: AssetConfig[] | AssetCatalog, opts: LiveOptions = {}) {
    this.rpc = opts.rpc ?? new QubicRpc();
    this.cacheMs = opts.cacheMs ?? 5000;
    this.maxBookOrders = opts.maxBookOrders ?? 2048;
    this.qswapOperationFeeQu = opts.qswapOperationFeeQu ?? 100_000;
    if (assets instanceof AssetCatalog) this.catalog = assets;
    else for (const a of assets) this.assetsBySymbol.set(a.symbol.toUpperCase(), a);
  }

  /** Resolves an id like "CFB" (or "GARTH.PHOEN" when two issuers share a name) to its on-chain identity. */
  private resolve(id: string): AssetConfig | undefined {
    const fixed = this.assetsBySymbol.get(id.toUpperCase());
    if (fixed) return fixed;
    const e = this.catalog?.find(id);
    return e ? { symbol: e.id, assetName: e.symbol, issuer: e.issuer } : undefined;
  }

  listAssets(filter: { category?: Category; q?: string } = {}) {
    if (!this.catalog) return { assets: [], ready: true, activity: { ready: false, progress: 0 } };
    return { assets: this.catalog.list(filter), ready: this.catalog.ready, activity: this.catalog.activityStatus };
  }

  searchAssets(name: string) {
    return this.catalog ? this.catalog.search(name) : Promise.resolve([]);
  }

  assets() {
    return this.catalog ? this.catalog.list().map((e) => e.id) : [...this.assetsBySymbol.keys()];
  }

  async venues(symbol: string): Promise<Venue[] | null> {
    const key = symbol.toUpperCase();
    const asset = this.resolve(symbol);
    if (!asset) return null;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.venues;
    const venues = this.load(asset);
    this.cache.set(key, { at: Date.now(), venues });
    venues.catch(() => this.cache.delete(key)); // don't cache failures
    return venues;
  }

  private infoCache = new Map<string, { at: number; info: Promise<AssetInfo> }>();

  async assetInfo(symbol: string): Promise<AssetInfo | null> {
    const a = this.resolve(symbol);
    if (!a) return null;
    const hit = this.infoCache.get(a.symbol);
    if (hit && Date.now() - hit.at < 60_000) return hit.info;
    const info = this.loadInfo(a);
    this.infoCache.set(a.symbol, { at: Date.now(), info });
    info.catch(() => this.infoCache.delete(a.symbol));
    return info;
  }

  private async loadInfo(a: AssetConfig): Promise<AssetInfo> {
    return {
      symbol: a.symbol.toUpperCase(),
      issuer: a.issuer,
      assetName: a.assetName ?? a.symbol,
      transferFeeQu: await fetchTransferFees(this.rpc),
    };
  }

  private feeReads = new Map<string, { at: number; read: Promise<Uint8Array> }>();
  /**
   * A contract's fee table: the same for every asset and changing only when the contract does, so one read serves every market read for a few minutes (it was read once per
   * asset, two of the five requests a market read makes). A failed read is not kept.
   */
  private feeTable(index: number, fn: number): Promise<Uint8Array> {
    const key = `${index}:${fn}`;
    const hit = this.feeReads.get(key);
    if (hit && Date.now() - hit.at < FEE_TABLE_KEEP_MS) return hit.read;
    const read = this.rpc.query(index, fn);
    this.feeReads.set(key, { at: Date.now(), read });
    read.catch(() => {
      if (this.feeReads.get(key)?.read === read) this.feeReads.delete(key);
    });
    return read;
  }

  private async load(asset: AssetConfig): Promise<Venue[]> {
    const [qx, qswap] = await Promise.all([this.loadQx(asset), this.loadQswap(asset)]);
    const list: (Venue | null)[] = [qx, qswap];
    return list.filter((v): v is Venue => v !== null);
  }

  private assetInput(asset: AssetConfig, extra: number) {
    return structWriter(40 + extra)
      .id(identityToBytes(asset.issuer))
      .u64(assetNameToU64(asset.assetName ?? asset.symbol));
  }

  // QX ---------------------------------------------------------------------------------------

  private async loadQx(asset: AssetConfig): Promise<QxVenue | null> {
    const [feesRaw, asks, bids] = await Promise.all([
      this.feeTable(QX_INDEX, QX_FN.fees),
      this.fetchBook(asset, QX_FN.assetAsks),
      this.fetchBook(asset, QX_FN.assetBids),
    ]);
    const fees = structReader(feesRaw);
    if (fees.length < 12) throw new Error("Unexpected QX Fees response");
    const tradeFee = fees.u32(8); // billionths
    if (!asks.levels.length && !bids.levels.length) return null;

    const cfg: QxConfig = {
      asks: asks.levels,
      bids: bids.levels,
      buyerFeeRate: 0, // Qx.h deducts the trade fee from the seller's QU proceeds
      sellerFeeRate: tradeFee / 1e9,
      // QX takes no flat fee on an order: a bid attaches exactly price x quantity and a fill never costs more than that (a QMINE bid of 1,303 at 3,989 sent 5,197,667 QU and filled for
      // exactly that), and an ask attaches nothing; the 0.3% comes out of the seller's proceeds. The 100 QU "transfer fee" is charged only when management rights are moved from one
      // contract to the other, and that is a step of its own (a rights step in exec.ts), not part of the order. It was once added to every QX quote, so a 1 QDOGE buy showed 124 QU
      // for a 24 QU fill. (QSwap's flat fee is real: see the ledger.)
      fixedCostQu: 0,
      truncated: asks.truncated || bids.truncated,
    };
    return new QxVenue(cfg);
  }

  /** Pages through AssetAskOrders / AssetBidOrders (256 per call) using `offset`. */
  private async fetchBook(asset: AssetConfig, fn: number) {
    const levels: BookLevel[] = [];
    let truncated = false;
    for (let offset = 0; ; offset += PAGE) {
      if (offset >= this.maxBookOrders) {
        truncated = true;
        break;
      }
      const input = this.assetInput(asset, 8).u64(offset).bytes;
      const out = structReader(await this.rpc.query(QX_INDEX, fn, input));
      const orderSize = 48; // id entity (32) + sint64 price + sint64 numberOfShares
      let count = 0;
      for (let i = 0; i < PAGE && (i + 1) * orderSize <= out.length; i++) {
        const price = out.i64(i * orderSize + 32);
        const qty = out.i64(i * orderSize + 40);
        if (qty <= 0 || price <= 0) break; // empty slots are zero-filled
        levels.push({ price, qty });
        count++;
      }
      if (count < PAGE) break;
    }
    return { levels, truncated };
  }

  // QSwap ------------------------------------------------------------------------------------

  private async loadQswap(asset: AssetConfig): Promise<QswapVenue | null> {
    const [feesRaw, poolRaw] = await Promise.all([
      this.feeTable(QSWAP_INDEX, QSWAP_FN.fees),
      this.rpc.query(QSWAP_INDEX, QSWAP_FN.poolState, this.assetInput(asset, 0).bytes),
    ]);
    const fees = structReader(feesRaw);
    if (fees.length < 16) throw new Error("Unexpected QSwap Fees response");
    const transferFee = fees.u32(8);
    const swapFeeRate = fees.u32(12); // base 10_000
    const pool = structReader(poolRaw);
    if (pool.length < 24 || pool.i64(0) !== 1) return null; // poolExists
    const reserveQu = pool.i64(8);
    const reserveAsset = pool.i64(16);
    if (reserveQu <= 0 || reserveAsset <= 0) return null;

    const cfg: QswapConfig = {
      reserveQu,
      reserveAsset,
      swapFeeRate,
      fixedCostQu: this.qswapOperationFeeQu + transferFee,
    };
    return new QswapVenue(cfg);
  }

  /**
   * Asks the QSwap contract itself for the price of each QSwap allocation and compares it to the
   * model used for routing. Differences mean the pool moved or the model is wrong.
   */
  async verify(symbol: string, allocations: Allocation[]) {
    const asset = this.resolve(symbol);
    if (!asset) return [];
    const checks = [];
    for (const a of allocations) {
      if (a.venue !== "QSwap") continue;
      const side = a.quote.side;
      // Buy: QuoteExactAssetOutput → QU in. Sell: QuoteExactAssetInput → QU out.
      const fn = side === "buy" ? QSWAP_FN.quoteAssetOutput : QSWAP_FN.quoteAssetInput;
      const out = structReader(await this.rpc.query(QSWAP_INDEX, fn, this.assetInput(asset, 8).i64(a.qty).bytes));
      const onChainQu = out.i64(0);
      const modelQu = side === "buy" ? a.quote.netQu - a.quote.fixedCostQu : a.quote.netQu + a.quote.fixedCostQu;
      checks.push({
        venue: a.venue,
        qty: a.qty,
        onChainQu: onChainQu < 0 ? null : onChainQu,
        modelQu,
        differenceQu: onChainQu < 0 ? null : onChainQu - modelQu,
      });
    }
    return checks;
  }
}
