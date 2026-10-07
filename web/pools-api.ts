import { BASE } from "./client.ts";
import type { PoolDetailResponse, PoolItem, PoolSort, PoolWindow, PoolsResponse, PositionEstimate } from "../src/pools.ts";

export type { PoolDetailResponse, PoolItem, PoolSort, PoolWindow, PoolsResponse, PositionEstimate };

/** Reads a JSON answer, or says what went wrong in words (a server that has not mounted the route answers with a page, not JSON). */
async function read<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? (res.status === 404 ? "The pools endpoint is not available on this server" : `API ${res.status}`));
  if (!body) throw new Error("The server's answer could not be read");
  return body;
}

/** Every asset with a QSwap pool, ranked. The server caches the list for a minute. */
export async function fetchPools(window: PoolWindow, sort: PoolSort, signal?: AbortSignal): Promise<PoolsResponse> {
  return read(await fetch(`${BASE}/v1/pools?${new URLSearchParams({ window, sort })}`, { signal }));
}

/** One pool's stats and, when `positionQu` is given, what a deposit of that many QU (both sides together) would earn and lose. */
export async function fetchPoolDetail(asset: string, window: PoolWindow, positionQu?: number, signal?: AbortSignal): Promise<PoolDetailResponse> {
  const q = new URLSearchParams({ asset, window });
  if (positionQu !== undefined) q.set("positionQu", String(positionQu));
  return read(await fetch(`${BASE}/v1/pools/detail?${q}`, { signal }));
}
