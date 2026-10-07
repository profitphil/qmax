// Read/broadcast helpers for the public Qubic RPC (CORS is open, so the browser calls it directly).
import type { OwnedAsset } from "../../src/consolidate.ts";
import type { Holdings } from "../../src/exec.ts";
import { fetchTransferFees } from "../../src/fees.ts";
import { QubicRpc } from "../../src/rpc.ts";
import { fetchAllRestingOrders, fetchOpenQxOrders } from "../../src/verify.ts";
import type { OpenOrder, Snapshot } from "../../src/verify.ts";

const RPC = (import.meta.env?.VITE_QUBIC_RPC_URL as string | undefined) ?? "https://rpc.qubic.org";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(RPC + path);
  if (!res.ok) throw new Error(`RPC ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

export const fetchTick = async () => (await get<{ tickInfo: { tick: number } }>("/live/v1/tick-info")).tickInfo.tick;

export const fetchBalance = async (id: string) =>
  Number((await get<{ balance: { balance: string } }>(`/live/v1/balances/${id}`)).balance.balance);

/** Shares of one asset the wallet owns, grouped by managing contract index. */
export async function fetchHoldings(id: string, issuer: string, assetName: string): Promise<Holdings> {
  const res = await get<{
    ownedAssets?: { data: { managingContractIndex: number; numberOfUnits: string; issuedAsset: { name: string; issuerIdentity: string } } }[];
  }>(`/v1/assets/${id}/owned`);
  const out: Holdings = {};
  for (const a of res.ownedAssets ?? []) {
    const d = a.data;
    if (d.issuedAsset.name !== assetName || d.issuedAsset.issuerIdentity !== issuer) continue;
    out[d.managingContractIndex] = (out[d.managingContractIndex] ?? 0) + Number(d.numberOfUnits);
  }
  return out;
}

export async function broadcast(tx: Uint8Array): Promise<string> {
  const res = await fetch(RPC + "/v1/broadcast-transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ encodedTransaction: btoa(String.fromCharCode(...tx)) }),
  });
  if (!res.ok) throw new Error(`Broadcast failed (${res.status}): ${await res.text()}`);
  return (await res.json()).transactionId as string;
}

/** Resolves once the transaction's tick has passed and the network reports its status. */
export async function waitForTx(txId: string, targetTick: number, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      if ((await fetchTick()) <= targetTick) continue;
      const s = await get<{ transactionStatus: { moneyFlew: boolean } }>(`/v1/tx-status/${txId}`);
      return { included: true, moneyFlew: s.transactionStatus.moneyFlew };
    } catch {
      // status is not available until the tick is processed; keep polling
    }
  }
  return { included: false, moneyFlew: false };
}

const rpc = new QubicRpc({ baseUrl: RPC });
export const getRpc = () => rpc;

export async function fetchSnapshot(id: string, issuer: string, assetName: string): Promise<Snapshot> {
  const [balanceQu, holdings] = await Promise.all([fetchBalance(id), fetchHoldings(id, issuer, assetName)]);
  return { balanceQu, holdings };
}

export const fetchOpenOrders = (id: string, issuer: string, assetName: string): Promise<OpenOrder[]> =>
  fetchOpenQxOrders(rpc, id, issuer, assetName);

/** Every asset the wallet owns with its shares per managing contract (QX, QSwap, or anything else). */
export async function fetchOwnedByContract(id: string): Promise<OwnedAsset[]> {
  const res = await get<{
    ownedAssets?: { data: { managingContractIndex: number; numberOfUnits: string; issuedAsset: { name: string; issuerIdentity: string } } }[];
  }>(`/v1/assets/${id}/owned`);
  const byAsset = new Map<string, OwnedAsset>();
  for (const a of res.ownedAssets ?? []) {
    const d = a.data;
    const key = `${d.issuedAsset.name}|${d.issuedAsset.issuerIdentity}`;
    const asset = byAsset.get(key) ?? { symbol: d.issuedAsset.name, assetName: d.issuedAsset.name, issuer: d.issuedAsset.issuerIdentity, holdings: {} };
    asset.holdings[d.managingContractIndex] = (asset.holdings[d.managingContractIndex] ?? 0) + Number(d.numberOfUnits);
    byAsset.set(key, asset);
  }
  return [...byAsset.values()];
}

export const fetchFees = () => fetchTransferFees(rpc);

/** Everything the wallet owns, as total units per `NAME|issuer` (across all managing contracts). */
export async function fetchOwned(id: string): Promise<Record<string, number>> {
  const res = await get<{
    ownedAssets?: { data: { numberOfUnits: string; issuedAsset: { name: string; issuerIdentity: string } } }[];
  }>(`/v1/assets/${id}/owned`);
  const out: Record<string, number> = {};
  for (const a of res.ownedAssets ?? []) {
    const key = `${a.data.issuedAsset.name}|${a.data.issuedAsset.issuerIdentity}`;
    out[key] = (out[key] ?? 0) + Number(a.data.numberOfUnits);
  }
  return out;
}

/** Every resting QX order the wallet has, across all assets. */
export const fetchRestingOrders = (id: string) => fetchAllRestingOrders(rpc, id);

/** A transaction as the network recorded it, or null if it is not (yet) known. Used to verify fee credits. */
export async function fetchTransaction(txId: string): Promise<{ sourceId: string; destId: string; amount: string; moneyFlew?: boolean } | null> {
  try {
    const res = await get<{ transaction: { sourceId: string; destId: string; amount: string }; moneyFlew?: boolean }>(`/v2/transactions/${txId}`);
    return { ...res.transaction, moneyFlew: res.moneyFlew };
  } catch {
    return null;
  }
}
