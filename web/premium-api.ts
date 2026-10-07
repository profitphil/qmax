import type { PremiumRange, PremiumResponse } from "../src/premium.ts";
import { BASE } from "./client.ts";

export type { PremiumRange, PremiumResponse };

/**
 * How far apart QX and QSwap priced an asset over time, with a summary of how often the gap would have paid after fees.
 * `referenceQu` is the trade size the break-even is worked out for; `carry` lets a venue's last price stand in for up to that
 * many hours (0 means both venues must have traded in the same hour).
 */
export async function fetchPremium(asset: string, range: PremiumRange, opts: { referenceQu?: number; carry?: number } = {}, signal?: AbortSignal): Promise<PremiumResponse> {
  const q = new URLSearchParams({ asset, range });
  if (opts.referenceQu !== undefined) q.set("referenceQu", String(opts.referenceQu));
  if (opts.carry) q.set("carry", String(opts.carry));
  const res = await fetch(`${BASE}/v1/premium?${q}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // a server that has not been given this feature answers "Not found" for the path itself
    if (res.status === 404 && body.error === "Not found") throw new Error("This server does not offer the market comparison yet.");
    throw new Error(body.error ?? `API ${res.status}`);
  }
  return body;
}
