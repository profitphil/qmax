// Types come from src/tape.ts, never its code: that module reads files and would not bundle for the browser.
import type { Flow, TapeRow, TapeVenue } from "../src/tape.ts";

export type { Flow, TapeRow, TapeVenue };

// Same address as web/client.ts uses. Written out here (with `?.`) instead of imported so the node tests can load this file too:
// outside Vite `import.meta.env` does not exist.
const BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? "/api";

export interface TapeResponse {
  /** Newest first. */
  trades: TapeRow[];
  /** The newest id on the whole tape, whatever was asked for: send it back as `since` to get only what came after. */
  latestId: number;
  /** Changes when the server restarts (ids start over): drop the old cursor and rows then. */
  instance: string;
  /** The last 24 hours of buying and selling for the same asset and venue. */
  flow24h: Flow;
}

export interface FlowResponse extends Flow {
  asset: string | null;
  venue: TapeVenue | null;
  window: "1h" | "24h";
}

async function get<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const qs = q.toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body;
}

/** The newest trades on QX and QSwap, optionally for one asset (its id from the asset list), only those after an id, or one venue. */
export function fetchTape(p: { asset?: string; limit?: number; since?: number; venue?: TapeVenue } = {}, signal?: AbortSignal): Promise<TapeResponse> {
  return get<TapeResponse>("/v1/tape", p, signal);
}

/** Buy versus sell volume over the last hour or 24 hours, for one asset or all of them. */
export function fetchFlow(p: { asset?: string; window?: "1h" | "24h"; venue?: TapeVenue } = {}, signal?: AbortSignal): Promise<FlowResponse> {
  return get<FlowResponse>("/v1/flow", p, signal);
}

/* ---------- what the components share (plain functions, so the node tests can cover them) ---------- */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Folds freshly fetched rows into the list on screen: by id (a refetched row replaces its old copy, so a side that arrived late shows), newest first, at most `limit`. */
export function mergeTape(shown: TapeRow[], incoming: TapeRow[], limit: number): TapeRow[] {
  const byId = new Map<number, TapeRow>();
  for (const r of shown) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.t - a.t || b.id - a.id).slice(0, Math.max(1, limit));
}

/**
 * What to send as `since` on the next poll. Normally the newest id seen. But a QX row can reach the screen before its side has
 * been looked up, and a poll that asks only for newer rows would never bring the side; so while a young QX row has no side, ask
 * from just before it (rows already shown are simply replaced). A row older than `graceMs` is given up on.
 */
export function pollCursor(shown: TapeRow[], latestId: number, now: number, graceMs = 2 * 60_000): number {
  let cursor = latestId;
  for (const r of shown) if (r.venue === "QX" && !r.side && r.txHash && now - r.t < graceMs) cursor = Math.min(cursor, r.id - 1);
  return Math.max(0, cursor);
}

/** "just now", "42 s ago", "5 min ago", "3 h ago", "2 d ago". */
export function agoLabel(ms: number): string {
  if (!(ms >= 5_000)) return "just now"; // also what a clock that runs a little ahead gives
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`;
  if (ms < HOUR) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

/** The same, without "ago", for a narrow column that is headed "Time" anyway: "4 min", "1 h". */
export function agoShort(ms: number): string {
  return agoLabel(ms).replace(/ ago$/, "").replace("just now", "now");
}

/** 186,900,922 becomes 186.9M. */
export const compactQu = (qu: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(qu);
