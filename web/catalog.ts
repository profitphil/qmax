import { useEffect, useState } from "react";
import { fetchAssetList } from "./client.ts";
import type { AssetItem } from "./client.ts";

const FRESH_MS = 15_000;
let cache: { assets: AssetItem[]; at: number } | null = null;
let inflight: Promise<AssetItem[]> | null = null;

/** Busiest first: the QU traded in the last 24 hours, then in 7 days, then the deepest market. The order of the watchlist. */
export const busiest = (a: AssetItem, b: AssetItem) =>
  (b.volume24hQu ?? 0) - (a.volume24hQu ?? 0) || (b.volume7dQu ?? 0) - (a.volume7dQu ?? 0) || b.liquidityQu - a.liquidityQu;

/**
 * Every tradable asset, busiest first, for pickers that need the whole list (the trade screen's asset switcher). One shared copy,
 * read again when it is a minute old; the list on the page keeps its own, so this never holds that one up.
 */
export function useAssetCatalog(): AssetItem[] {
  const [assets, setAssets] = useState<AssetItem[]>(() => cache?.assets ?? []);
  useEffect(() => {
    let alive = true;
    const refresh = (force = false) => {
      if (!force && document.visibilityState !== "visible") return;
      if (cache && Date.now() - cache.at < FRESH_MS) {
        setAssets(cache.assets);
        return;
      }
      inflight ??= fetchAssetList()
        .then((r) => {
          cache = { assets: [...r.assets].sort(busiest), at: Date.now() };
          return cache.assets;
        })
        .finally(() => {
          inflight = null;
        });
      inflight.then((a) => alive && setAssets(a)).catch(() => {}); // no list: the switcher just has nothing to offer
    };
    refresh(true);
    // read again every 20 seconds while in view (every user of the list shares the one answer), so the header's figures move with the market
    const again = () => refresh();
    const timer = setInterval(again, 20_000);
    document.addEventListener("visibilitychange", again);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);
  return assets;
}
