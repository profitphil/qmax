import { BASE } from "./client.ts";
import type { BacktestRequest, BacktestResponse } from "../src/backtest.ts";

export type { BacktestRequest, BacktestResponse };

/**
 * Runs a backtest on the server. The server answers a refused request with `{ error }` naming each setting that is wrong, and that text is
 * what the Error carries, so the page can show it as it is. A caller that is rate limited or has to pay gets the server's own message too.
 */
export async function runBacktestRequest(body: BacktestRequest, signal?: AbortSignal): Promise<BacktestResponse> {
  const res = await fetch(`${BASE}/v1/backtest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && typeof json.error === "string" && json.error) || `The server answered ${res.status}`);
  return json as BacktestResponse;
}
