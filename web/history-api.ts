import { useEffect, useState } from "react";
import { fetchCandles } from "./client.ts";
import type { TapeRow } from "./tape-api.ts";

/** A line of the trade list that is not an exact trade from the live tape: one minute of trading read from the trade history. */
export type ListRow = TapeRow & {
  /** How many trades the minute held (the quantity, QU and price are their total and average). Absent on a live row. */
  trades?: number;
  /** Set on a row from Quhub's history (before the archive began): the chain cannot confirm it. */
  src?: "quhub";
};

export const MINUTE = 60_000;
const VENUES = ["QX", "QSwap"] as const;

/**
 * The minutes in which an asset traded, newest first, from the trade history the server keeps (back to when the archive begins,
 * and for QX further back from Quhub's list). A minute with one trade is that trade; with several it is their total and average
 * price. There is no buy or sell side in it. Daily summaries drawn as candles (Quhub, for assets with more trades than it lists)
 * are left out: they are not trades. A venue that has nothing for the asset just adds no rows.
 */
export async function fetchOlderTrades(assetId: string, signal?: AbortSignal): Promise<ListRow[]> {
  const parts = await Promise.allSettled(VENUES.map((venue) => fetchCandles(assetId, "all", signal, { interval: "1m", venue }).then((r) => ({ venue, candles: r.candles }))));
  if (signal?.aborted) return [];
  const failed = parts.filter((p): p is PromiseRejectedResult => p.status === "rejected");
  if (failed.length === parts.length) throw failed[0].reason;
  const rows: ListRow[] = [];
  for (const p of parts) {
    if (p.status !== "fulfilled") continue;
    for (const c of p.value.candles) {
      if (c.approx || !(c.trades > 0 && c.volumeQty > 0 && c.volumeQu > 0)) continue;
      rows.push({ id: -1, t: c.t, venue: p.value.venue, asset: assetId, assetKey: "", qty: c.volumeQty, qu: c.volumeQu, price: c.volumeQu / c.volumeQty, trades: c.trades, ...(c.src ? { src: c.src } : {}) });
    }
  }
  return rows.sort((a, b) => b.t - a.t);
}

/** Only the rows whose minute ended before `cutoffMs`: the exact trades on the tape cover everything from there on. */
export const olderThan = (rows: ListRow[], cutoffMs: number) => rows.filter((r) => r.t + MINUTE <= cutoffMs);

/** Read once for an asset (what is older than a day does not change by the minute); `enabled` holds the request back until the list is needed. */
export function useOlderTrades(assetId: string | undefined, enabled: boolean): { rows: ListRow[]; loading: boolean; error: string } {
  const [state, setState] = useState<{ id: string; rows: ListRow[]; error: string } | null>(null);
  useEffect(() => {
    if (!assetId || !enabled) return;
    const ctl = new AbortController();
    fetchOlderTrades(assetId, ctl.signal)
      .then((rows) => !ctl.signal.aborted && setState({ id: assetId, rows, error: "" }))
      .catch((e) => !ctl.signal.aborted && setState({ id: assetId, rows: [], error: e instanceof Error ? e.message : String(e) }));
    return () => ctl.abort();
  }, [assetId, enabled]);
  const mine = state && state.id === assetId ? state : null;
  return { rows: mine?.rows ?? [], loading: !!assetId && enabled && !mine, error: mine?.error ?? "" };
}

/** How long ago a trade was, or, once it is more than two days back, its date. */
export function whenLabel(t: number, now: number): string {
  const age = now - t;
  if (age < 2 * 24 * 3_600_000) return "";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "2-digit" }) });
}
