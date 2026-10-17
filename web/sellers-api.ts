import type { SellersView } from "../src/sellers.ts";
import { BASE } from "./base.ts";

export type { SellerRow, SellersAnalysis, SellersView } from "../src/sellers.ts";

/**
 * Who has been selling an asset (the last 7 days) and what they paid. The first ask for an asset starts the reading, which takes a minute or two, and is answered `working` with what is
 * known so far; the page asks again every few seconds until it is `ready`.
 */
export async function fetchSellers(asset: string, signal?: AbortSignal): Promise<SellersView> {
  const res = await fetch(`${BASE}/v1/sellers?${new URLSearchParams({ asset })}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (res.status === 503) return { status: "busy", retryAfterSec: Number(body.retryAfterSec) || 120, message: String(body.error ?? "QMax is busy; try again shortly.") };
  if (!res.ok) throw new Error(body.error ?? `API ${res.status}`);
  return body as SellersView;
}
