import { BASE } from "./client.ts";
import type { QuoteFn, SwapPlan, SwapQuote } from "../src/swap.ts";

export type { SwapPlan };

/** Plans a token-to-token swap (`POST /v1/swap-quote`): both quotes, the expected and guaranteed amounts, and the QU needed up front. */
export async function fetchSwapQuote(p: { from: string; to: string; qty: number; slippageBps: number; compare?: boolean }, signal?: AbortSignal): Promise<SwapPlan> {
  const res = await fetch(`${BASE}/v1/swap-quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p), signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body as SwapPlan;
}

/** Waits for a rate limit at most this long per try, and tries this many times more. */
const LIMIT_WAIT_MAX_S = 20;
const LIMIT_RETRIES = 2;

/**
 * One fresh quote, for sizing the second trade again after the first has settled (`fitBuyToBalance`, up to 12 in a
 * row). `/v1/quote` is rate limited for callers without a key, and the rest of the app polls it too; a refusal here
 * would stop the swap with the user holding QU, so a rate limit is waited out (briefly, as the server says) and retried.
 */
export const swapLegQuote: QuoteFn = async (side, asset, qty, slippageBps) => {
  const q = new URLSearchParams({ side, asset, qty: String(qty), slippageBps: String(slippageBps) });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/v1/quote?${q}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body as SwapQuote;
    const waitS = Number(body.retryAfterSec ?? res.headers.get("retry-after"));
    const limited = res.status === 429 || (res.status === 402 && Number.isFinite(waitS));
    if (!limited || attempt >= LIMIT_RETRIES || !(waitS > 0) || waitS > LIMIT_WAIT_MAX_S) throw new Error(body.error ?? `API ${res.status}`);
    await new Promise((r) => setTimeout(r, waitS * 1000));
  }
};
