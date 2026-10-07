import type { Ledger, LedgerEntry, LedgerPosition } from "../src/ledger.ts";
import { BASE } from "./client.ts";

export type { Ledger, LedgerEntry, LedgerPosition };

/** A refused or failed ledger request; `retryAfterSec` is set when the server is busy and asks to try again shortly. */
export class LedgerError extends Error {
  status: number;
  retryAfterSec?: number;
  constructor(message: string, status: number, retryAfterSec?: number) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

const query = (identity: string, days: number, format: "json" | "csv") => new URLSearchParams({ identity, days: String(days), format });

/** A wallet's trades, positions and profit over the last `days` (the server reads the archive: it can take several seconds). */
export async function fetchLedger(identity: string, days = 180, signal?: AbortSignal): Promise<Ledger> {
  const res = await fetch(`${BASE}/v1/ledger?${query(identity, days, "json")}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new LedgerError(body.error ?? `API ${res.status}`, res.status, typeof body.retryAfterSec === "number" ? body.retryAfterSec : undefined);
  return body as Ledger;
}

/** Where the same ledger is served as a CSV download. */
export function ledgerCsvUrl(identity: string, days = 180): string {
  return `${BASE}/v1/ledger?${query(identity, days, "csv")}`;
}

/** Fetches the CSV and hands it to the browser as a file (a plain link would lose the error message if the server refuses). */
export async function downloadLedgerCsv(identity: string, days = 180): Promise<void> {
  const res = await fetch(ledgerCsvUrl(identity, days));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new LedgerError(body.error ?? `API ${res.status}`, res.status, body.retryAfterSec);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `qmax-ledger-${identity.slice(0, 8)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
