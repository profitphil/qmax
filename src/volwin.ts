/**
 * The window the volume figures are shown over: the last 24 hours (the default), 72 hours or 7 days. The server sends all three for every asset;
 * the page shows the one the person chose, and sorts "busiest first" by it.
 */
export type VolWindow = "24h" | "72h" | "7d";

export const VOL_WINDOWS: readonly { id: VolWindow; label: string; long: string }[] = [
  { id: "24h", label: "24h", long: "the last 24 hours" },
  { id: "72h", label: "72h", long: "the last 72 hours" },
  { id: "7d", label: "7d", long: "the last 7 days" },
];

export const DEFAULT_VOL_WINDOW: VolWindow = "24h";
export const isVolWindow = (v: unknown): v is VolWindow => VOL_WINDOWS.some((w) => w.id === v);
export const volLong = (w: VolWindow): string => VOL_WINDOWS.find((x) => x.id === w)!.long;

interface Vols {
  volume24hQu?: number;
  volume72hQu?: number;
  volume7dQu?: number;
}

/** QU traded in the window. An older server that does not send 72 hours gives the 24 hour figure as the least it can be (and the 7 day figure as the most): the 7 day one is nearer, so it is used. */
export function volumeOf(a: Vols, w: VolWindow): number {
  if (w === "24h") return a.volume24hQu ?? 0;
  if (w === "7d") return a.volume7dQu ?? 0;
  return a.volume72hQu ?? a.volume7dQu ?? a.volume24hQu ?? 0;
}

interface Changes {
  change24hPct?: number | null;
  change72hPct?: number | null;
  change7dPct?: number | null;
}

/** How far the price moved over the window, in percent: the change column follows the same window as the volume. Null when there is nothing to compare (or an older server did not send that window). */
export function changeOf(a: Changes, w: VolWindow): number | null {
  const v = w === "24h" ? a.change24hPct : w === "72h" ? a.change72hPct : a.change7dPct;
  return v ?? null;
}

/** "Busiest first" over the chosen window; ties go to the longer window, then to the deeper market. */
export const busiestIn =
  (w: VolWindow) =>
  (a: Vols & { liquidityQu: number }, b: Vols & { liquidityQu: number }): number =>
    volumeOf(b, w) - volumeOf(a, w) || (b.volume7dQu ?? 0) - (a.volume7dQu ?? 0) || b.liquidityQu - a.liquidityQu;
