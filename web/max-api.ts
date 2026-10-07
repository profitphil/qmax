import { BASE } from "./client.ts";
import type { QuoteResponse } from "./client.ts";
import type { MaxPlan } from "../src/maxplan.ts";

export type { MaxPlan };
export type { MaxAction, MaxPick } from "../src/maxplan.ts";

export interface MaxQuery {
  asset: string;
  side: "buy" | "sell";
  /** The amount typed, if any. */
  qty?: number;
  balanceQu?: number | null;
  heldQty?: number | null;
  avgCostQu?: number | null;
  slippageBps: number;
}

async function get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body as T;
}

const whole = (n: number | null | undefined): string | null => (n === null || n === undefined || !Number.isFinite(n) ? null : String(Math.max(0, Math.floor(n))));

/** QMax searching for the best position for this order (the Max button). The wallet's numbers only size the plan; nothing is signed. */
export function fetchMaxPlan(q: MaxQuery, signal?: AbortSignal): Promise<MaxPlan & { checkedAt?: string }> {
  const params: Record<string, string> = { asset: q.asset, side: q.side, slippageBps: String(q.slippageBps) };
  for (const [k, v] of [["qty", whole(q.qty)], ["balanceQu", whole(q.balanceQu)], ["heldQty", whole(q.heldQty)], ["avgCostQu", whole(q.avgCostQu)]] as const) if (v !== null) params[k] = v;
  return get("/v1/max", params, signal);
}

/** A quote on one market only: a plain QSwap swap, or a leg of an arbitrage landing on the market the plan chose. */
export function fetchVenueQuote(p: { asset: string; side: "buy" | "sell"; qty: number; venue: "QX" | "QSwap"; slippageBps: number }, signal?: AbortSignal): Promise<QuoteResponse> {
  return get("/v1/venue-quote", { asset: p.asset, side: p.side, qty: String(p.qty), venue: p.venue, slippageBps: String(p.slippageBps) }, signal);
}
