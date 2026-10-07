import { BASE } from "./client.ts";

/** What QMax says about a Max pass for an address (GET /v1/pro). `until` is an ISO date. */
export interface ProServerStatus {
  wallet: string;
  active: boolean;
  until: string | null;
  via: "own" | "cover" | null;
  payer: string | null;
  /** For the paying address: the addresses its pass covers now. */
  covered: string[] | null;
  /** The payer's newest list is paid for on-chain but QMax has not been given it yet. */
  listPending: boolean;
  coverMax: number;
  rules: { days: number; minQu: number };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `API ${res.status}`), { status: res.status });
  return body as T;
}

/** Is this address covered by a Max pass, and by whom. Public: it is chain data. */
export const fetchProStatus = (wallet: string, signal?: AbortSignal) => call<ProServerStatus>(`/v1/pro?${new URLSearchParams({ wallet })}`, { signal });

/** The paying address gives QMax the list its payment committed to (public addresses only). */
export const sendCover = (payer: string, addresses: string[]) =>
  call<ProServerStatus>("/v1/pro/cover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payer, addresses }) });
