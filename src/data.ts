import { readFileSync } from "node:fs";
import type { AssetEntry, Category } from "./catalog.ts";
import type { Allocation, Venue } from "./types.ts";
import { QswapVenue, QxVenue } from "./venues.ts";
import type { QswapConfig, QxConfig } from "./venues.ts";

/**
 * Where venue state comes from. Implement this with live QX / QSwap RPC reads to take the API
 * off demo data; the router and API never need to change.
 */
export interface MarketData {
  assets(): string[];
  /** Optional: tradable assets for pickers, grouped by `category`. */
  listAssets?(filter: { category?: Category; q?: string }): { assets: AssetEntry[]; ready: boolean; activity?: { ready: boolean; progress: number } };
  /** Optional: look a token up on the network by name and add it. */
  searchAssets?(name: string): Promise<AssetEntry[]>;
  /** Fresh venue models for `asset`, or null if the asset is unknown. */
  venues(asset: string): Promise<Venue[] | null>;
  /** Optional: on-chain identity of the asset and contract fees. Without it, quotes are not executable. */
  assetInfo?(asset: string): Promise<AssetInfo | null>;
  /** Optional: re-check allocations against the chain itself (QSwap Quote* calls). */
  verify?(asset: string, allocations: Allocation[]): Promise<unknown[]>;
}

export interface AssetInfo {
  symbol: string;
  issuer: string;
  assetName: string;
  /** Fee each contract charges to take over management rights of shares (QU). */
  transferFeeQu: { qx: number; qswap: number };
}

export interface Snapshot {
  asset: string;
  qx: QxConfig;
  qswap: QswapConfig;
}

export class SnapshotData implements MarketData {
  private markets = new Map<string, Snapshot>();

  constructor(snapshots: Snapshot[]) {
    for (const s of snapshots) this.markets.set(s.asset.toUpperCase(), s);
  }

  static fromFile(path: string): SnapshotData {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return new SnapshotData(Array.isArray(raw) ? raw : [raw]);
  }

  assets() {
    return [...this.markets.keys()];
  }

  listAssets(filter: { category?: Category; q?: string } = {}) {
    const q = filter.q?.trim().toUpperCase();
    const assets: AssetEntry[] = [...this.markets.values()]
      .filter((s) => !q || s.asset.toUpperCase().includes(q))
      .map((s) => ({
        id: s.asset.toUpperCase(),
        symbol: s.asset,
        issuer: "",
        category: "token" as const,
        venues: ["QX" as const, "QSwap" as const],
        priceQu: s.qswap.reserveQu / s.qswap.reserveAsset,
        liquidityQu: 2 * s.qswap.reserveQu,
        probedAt: Date.now(),
        activity: "active" as const,
        lastActiveAt: Date.now(),
      }))
      .filter((a) => !filter.category || a.category === filter.category);
    return { assets, ready: true, activity: { ready: true, progress: 1 } };
  }

  async venues(asset: string) {
    const s = this.markets.get(asset.toUpperCase());
    return s ? [new QxVenue(s.qx), new QswapVenue(s.qswap)] : null;
  }
}
