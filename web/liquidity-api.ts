import { BASE } from "./client.ts";
import { getRpc } from "./exec/chain.ts";
import { readLiquidity, readPool } from "../src/liquidity.ts";
import type { LiquidityOf, LiquidityPosition, PoolResponse, PoolState, PositionsResponse } from "../src/liquidity.ts";

export type { LiquidityOf, LiquidityPosition, PoolResponse, PoolState, PositionsResponse };

/** Reads a JSON answer, or says what went wrong in words (a server that has not mounted the route answers with a page, not JSON). */
async function read<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? (res.status === 404 ? "The liquidity endpoint is not available on this server" : `API ${res.status}`));
  if (!body) throw new Error("The server's answer could not be read");
  return body;
}

/**
 * Every QSwap pool the wallet has liquidity in (`GET /v1/liquidity/positions`). The server caches it for 30 seconds; `fresh`
 * (after an add or remove, or a manual refresh) asks it to read again unless its answer is only seconds old.
 */
export async function fetchPositions(identity: string, signal?: AbortSignal, fresh = false): Promise<PositionsResponse> {
  return read(await fetch(`${BASE}/v1/liquidity/positions?${new URLSearchParams(fresh ? { identity, fresh: "1" } : { identity })}`, { signal }));
}

/** One pool as the server read it (`GET /v1/liquidity/pool`, cached for 10 seconds). */
export async function fetchLiquidityPool(asset: string, signal?: AbortSignal): Promise<PoolResponse> {
  return read(await fetch(`${BASE}/v1/liquidity/pool?${new URLSearchParams({ asset })}`, { signal }));
}

const query = (contractIndex: number, functionId: number, input: Uint8Array) => getRpc().query(contractIndex, functionId, input);

/**
 * The pool read straight from the contract (the public RPC, from the browser), not through the server's cache: what the
 * last check before signing and the read-back after it use.
 */
export const readPoolLive = (asset: { issuer: string; assetName: string }): Promise<PoolState> => readPool(query, asset);

/** The wallet's liquidity in one pool, read straight from the contract (GetLiquidityOf). */
export const readPositionLive = (wallet: string, asset: { issuer: string; assetName: string }): Promise<LiquidityOf> => readLiquidity(query, asset, wallet);
