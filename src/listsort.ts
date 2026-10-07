import { busiestIn, changeOf, volumeOf } from "./volwin.ts";
import type { VolWindow } from "./volwin.ts";

/**
 * Sorting the market list by any column: name, price, change (over the chosen window, like the volume), volume (over the chosen window), depth or spread, either way. Rows with nothing in
 * that column (no price, no change to measure, an empty side of the book) always go last, whichever way the column is sorted.
 */
export type SortKey = "volume" | "liquidity" | "az" | "price" | "change" | "spread";
export type SortDir = "asc" | "desc";

/** The way a column sorts when it is first chosen: biggest first, except the name and the spread (tightest first). */
export const defaultDir = (k: SortKey): SortDir => (k === "az" || k === "spread" ? "asc" : "desc");

export interface Sortable {
  symbol: string;
  priceQu: number | null;
  liquidityQu: number;
  bestAsk?: number | null;
  bestBid?: number | null;
  change24hPct?: number | null;
  change72hPct?: number | null;
  change7dPct?: number | null;
  volume24hQu?: number;
  volume72hQu?: number;
  volume7dQu?: number;
}

/** The gap between the best bid and ask as a percent of the middle, or null when either side is empty or the book is crossed. */
export const spreadOf = (a: Pick<Sortable, "bestAsk" | "bestBid">): number | null =>
  a.bestAsk && a.bestBid && a.bestAsk >= a.bestBid ? ((a.bestAsk - a.bestBid) / ((a.bestAsk + a.bestBid) / 2)) * 100 : null;

const value = (a: Sortable, key: Exclude<SortKey, "az" | "volume">, win: VolWindow): number | null => {
  const v = key === "price" ? a.priceQu : key === "liquidity" ? a.liquidityQu : key === "change" ? changeOf(a, win) : spreadOf(a);
  return v !== null && Number.isFinite(v) ? v : null;
};

/** A new list, sorted. The sort is stable: rows that tie keep the order they came in (busiest first), and those with nothing to sort by keep it too. */
export function sortAssets<T extends Sortable>(list: readonly T[], key: SortKey, dir: SortDir, win: VolWindow): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const busiest = busiestIn(win);
  return [...list].sort((a, b) => {
    if (key === "az") return sign * a.symbol.localeCompare(b.symbol);
    if (key === "volume") return dir === "desc" ? busiest(a, b) : busiest(b, a); // "busiest" is already biggest first: ascending is its reverse
    const x = value(a, key, win);
    const y = value(b, key, win);
    if (x === null && y === null) return busiest(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y) || busiest(a, b);
  });
}

/** Whether the volume is read over a window: re-exported so the list needs one import for sorting. */
export { volumeOf };
