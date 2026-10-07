import { useEffect, useState } from "react";
import { BASE } from "./client.ts";
import { HEALTH_LIMITS as L } from "../src/health.ts";
import type { Grade, HealthAllResponse, HealthFlag, HealthResponse, HealthSummary } from "../src/health.ts";

export type { Grade, HealthAllResponse, HealthFlag, HealthResponse, HealthSummary };

/** The health of one asset (`GET /v1/health`), or null if the server does not know the asset. */
export async function fetchHealth(assetId: string, signal?: AbortSignal): Promise<HealthResponse | null> {
  const res = await fetch(`${BASE}/v1/health?${new URLSearchParams({ asset: assetId })}`, { signal });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body;
}

/** The grade, score, flags and top reason of every asset in one call (`GET /v1/health/all`). The server keeps it for a minute. */
export async function fetchHealthAll(signal?: AbortSignal): Promise<HealthAllResponse> {
  const res = await fetch(`${BASE}/v1/health/all`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body;
}

/* ---------- One shared copy of the whole list, for every badge in a table ---------- */

const KEEP_MS = 60_000;
let shared: { at: number; promise: Promise<HealthAllResponse> } | null = null;

/** Many badges on one page ask for the list at once, so they share one request and reuse its answer for a minute. A failed request is not kept. */
export function sharedHealthAll(now = Date.now()): Promise<HealthAllResponse> {
  if (shared && now - shared.at < KEEP_MS) return shared.promise;
  const promise = fetchHealthAll();
  shared = { at: now, promise };
  promise.catch(() => {
    if (shared?.promise === promise) shared = null;
  });
  return promise;
}

/** The health of every asset, for a list: `data.assets[asset.id]` is the badge's `health`. While it loads `data` is null; if the server cannot grade, `error` says so and the list simply shows no badges. */
export function useHealthAll(): { data: HealthAllResponse | null; loading: boolean; error: string } {
  const [state, setState] = useState<{ data: HealthAllResponse | null; error: string }>({ data: null, error: "" });
  useEffect(() => {
    let alive = true;
    const load = () =>
      sharedHealthAll().then(
        (data) => alive && setState({ data, error: "" }),
        (e: unknown) => alive && setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : "Health grades are not available" })),
      );
    void load();
    const timer = setInterval(load, KEEP_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return { ...state, loading: !state.data && !state.error };
}

/* ---------- Words ---------- */

export const GRADE_LABEL: Record<Grade, string> = { A: "Healthy", B: "Mostly healthy", C: "Some risks", D: "Risky", E: "High risk" };

/** One sentence for each grade, under the grade in the panel. The reasons carry the specifics. */
export const GRADE_SUMMARY: Record<Grade, string> = {
  A: "Looks fine to trade at ordinary sizes.",
  B: "Fine for most trades, with something to keep in mind.",
  C: "Read the reasons below before you trade.",
  D: "Expect a poor price or a slow exit.",
  E: "You may not be able to sell this near its price.",
};

/** What a flag chip says. 'bad' flags are the ones that can cost you money outright, 'warn' ones are cautions, 'info' ones are only facts. */
export const FLAG_LABEL: Record<HealthFlag, { label: string; tone: "bad" | "warn" | "info"; hint: string }> = {
  "wash-suspected": { label: "Looks like wash trading", tone: "bad", hint: "Thousands of tiny, same-sized swaps an hour, in a row: it looks like one bot trading back and forth, which inflates the trade count. An estimate, not proof." },
  "no-market": { label: "Nothing to trade against", tone: "bad", hint: "No order book on QX and no QSwap pool right now." },
  "one-sided": { label: "One-sided book", tone: "bad", hint: "Orders on only one side and no pool: either nobody will buy it back from you, or nobody is selling." },
  "bot-burst": { label: "Bot-like burst", tone: "warn", hint: "A short burst of tiny swaps that could be a bot. Not enough to call it wash trading." },
  "thin-book": { label: "Thin book", tone: "warn", hint: `Under ${L.thinDepthQu / 1e6}M QU can be sold within ${L.depthBand * 100}% of the price.` },
  "wide-spread": { label: "Wide spread", tone: "warn", hint: `Buying and selling straight back on QX would lose ${L.wideSpreadPct}% or more.` },
  quiet: { label: "Quiet", tone: "warn", hint: `No trades for ${L.quietDays} days, or no order or pool change for about 2 epochs.` },
  "few-trades": { label: "Few trades", tone: "warn", hint: `Fewer than ${L.fewTrades7d} trades in the last 7 days.` },
  "new-listing": { label: "New listing", tone: "warn", hint: `The first trade was less than ${L.newListingDays} days ago.` },
  "volume-spike": { label: "Volume spike", tone: "warn", hint: "One hour holds most of the last 30 days' trading volume." },
  "wash-past": { label: "Wash-like past", tone: "info", hint: `Earlier hours looked like wash trading. Nothing as strong in the last ${L.washWindowDays} days.` },
  "pool-dominated": { label: "Pool only", tone: "info", hint: "Nearly all recent trades were QSwap swaps; nobody is trading on the QX book." },
};
