import type { ArbFilters } from "../src/arbfilters.ts";
import { arbQuery } from "../src/arbfilters.ts";
import type { ArbitrageResult, AssetItem, BookResponse, CandlesResponse, HistoryResponse, QuoteResponse } from "../src/apitypes.ts";

export type { ArbitrageResult, AssetItem, BookResponse, CandlesResponse, HistoryResponse, QuoteResponse };

export { shownName } from "../src/assetname.ts";
export { livePrice } from "../src/liveprice.ts";

import { BASE } from "./base.ts";
import { usageSharingOn } from "./sharing.ts";
export { BASE };

export async function fetchAssetList(): Promise<{ assets: AssetItem[]; ready: boolean; activity?: { ready: boolean; progress: number } }> {
  const res = await fetch(`${BASE}/v1/assets`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/** Looks a token up by name on the network (the API adds it to the list if it trades). */
export async function searchAssets(name: string): Promise<AssetItem[]> {
  const res = await fetch(`${BASE}/v1/assets/search?name=${encodeURIComponent(name)}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body.assets;
}

export async function fetchQuote(
  p: { side: string; asset: string; qty: number; slippageBps: number },
  signal?: AbortSignal,
): Promise<QuoteResponse> {
  const q = new URLSearchParams({ side: p.side, asset: p.asset, qty: String(p.qty), slippageBps: String(p.slippageBps) });
  const res = await fetch(`${BASE}/v1/quote?${q}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body;
}

/** Live arbitrage check against the full order book and pool (not the cached snapshot). */
export async function fetchArbitrage(asset: string, filters: Partial<ArbFilters>, signal?: AbortSignal): Promise<ArbitrageResult> {
  const res = await fetch(`${BASE}/v1/arbitrage?${new URLSearchParams({ asset })}&${arbQuery(filters)}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body;
}

/** The asset a link points at: the one with that id (QTREATSC), else the most liquid one with that symbol, found in the list or, failing that, on the network. */
export async function lookupAsset(symbol: string): Promise<AssetItem | null> {
  const want = symbol.toUpperCase();
  const pick = (list: AssetItem[]) => list.find((a) => a.id.toUpperCase() === want) ?? list.filter((a) => a.symbol.toUpperCase() === want).sort((a, b) => b.liquidityQu - a.liquidityQu)[0] ?? null;
  const res = await fetch(`${BASE}/v1/assets?${new URLSearchParams({ q: symbol })}`);
  if (res.ok) {
    const found = pick((await res.json()).assets ?? []);
    if (found) return found;
  }
  return pick(await searchAssets(symbol).catch(() => []));
}

/** Finds an asset by its exact id (its symbol, or SYMBOL.ISSUER5 when two issuers share a name), as the live tape names it. */
export async function lookupAssetById(id: string): Promise<AssetItem | null> {
  const res = await fetch(`${BASE}/v1/assets?${new URLSearchParams({ q: id.split(".")[0] })}`);
  if (!res.ok) return null;
  return ((await res.json()).assets as AssetItem[] | undefined)?.find((a) => a.id.toUpperCase() === id.toUpperCase()) ?? null;
}

/** What the server says about the Discord bot's subscription (off: the bot is free) and where support goes (null if it cannot be read: the callers have their own defaults). */
export interface DiscordPlan {
  subscriptions: boolean;
  days: number;
  priceQu: number | null;
  priceUsd: number | null;
  freeUntil: number | null;
  freeNow: boolean;
  profitSharePct: number;
  /** What the bot's alerts cost for one period (`days`), in QU, or null while they are free. */
  alertsPriceQu: number | null;
}
/** What agents pay (see `agentPlan` in src/plans.ts): a Max plan's price, and the x402 session that covers unlimited plans. Null where it is free or not sold. */
export interface AgentPlan {
  maxPriceQu: number | null;
  sessionPriceQu: number | null;
  sessionSeconds: number | null;
  minTopupQu: number | null;
}
export async function fetchPlans(): Promise<(DiscordPlan & { supportAddress: string; supportUrl: string; agents: AgentPlan }) | null> {
  try {
    const res = await fetch(`${BASE}/v1/plans`);
    if (!res.ok) return null;
    const body = (await res.json()) as { discord: DiscordPlan; support?: { address?: string; url?: string | null }; agents?: Partial<AgentPlan> };
    const a = body.agents ?? {};
    return {
      ...body.discord,
      supportAddress: body.support?.address ?? "",
      supportUrl: body.support?.url ?? "",
      alertsPriceQu: body.discord.alertsPriceQu ?? null,
      agents: { maxPriceQu: a.maxPriceQu ?? null, sessionPriceQu: a.sessionPriceQu ?? null, sessionSeconds: a.sessionSeconds ?? null, minTopupQu: a.minTopupQu ?? null },
    };
  } catch {
    return null;
  }
}

/** Tells QMax someone arrived from (or traded through) a partner's link. Counting only; failures are ignored. */
export function reportRef(ref: string, event: "open" | "trade", txIds?: string[]): void {
  // A finished trade's transaction ids are the part that is about the person: not sent when they turned counting off in Settings.
  if (event === "trade" && !usageSharingOn()) return;
  fetch(`${BASE}/v1/ref`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref, event, txIds }) }).catch(() => {});
}

/** The order book and pool of an asset, read live. */
export async function fetchBook(asset: string, signal?: AbortSignal): Promise<BookResponse> {
  const res = await fetch(`${BASE}/v1/book?${new URLSearchParams({ asset, levels: "12" })}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body;
}

/** Prices recorded over time. History only goes back to when the server started recording. */
export async function fetchHistory(asset: string, range: string, signal?: AbortSignal): Promise<HistoryResponse> {
  const res = await fetch(`${BASE}/v1/history?${new URLSearchParams({ asset, range })}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body;
}

export async function fetchCandles(asset: string, range: string, signal?: AbortSignal, o: { interval?: string; venue?: string } = {}): Promise<CandlesResponse> {
  const q = new URLSearchParams({ asset, range });
  if (o.interval && o.interval !== "auto") q.set("interval", o.interval);
  if (o.venue && o.venue !== "auto") q.set("venue", o.venue);
  const res = await fetch(`${BASE}/v1/candles?${q}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body;
}
