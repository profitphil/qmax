/** What counts as an arbitrage worth reporting. Zero means no limit (and no minimum). */
export interface ArbFilters {
  /** Smallest profit, in QU. */
  minProfitQu: number;
  /** Smallest profit as a percentage of the QU put in. */
  minProfitPct: number;
  /** Most QU to put in (the budget): bigger loops are skipped in favour of the best one that fits. */
  maxCostQu: number;
}

export const NO_FILTERS: ArbFilters = { minProfitQu: 0, minProfitPct: 0, maxCostQu: 0 };

const clamp = (v: unknown, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
};

/** Anything (stored settings, user input) to valid filters: wrong types and out-of-range numbers fall back to "no limit". */
export function sanitizeArbFilters(raw: unknown): ArbFilters {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return { minProfitQu: clamp(r.minProfitQu, 1e12), minProfitPct: clamp(r.minProfitPct, 1000), maxCostQu: clamp(r.maxCostQu, 1e13) };
}

export const hasFilters = (f: ArbFilters) => f.minProfitQu > 0 || f.minProfitPct > 0 || f.maxCostQu > 0;

/** Does this opportunity meet the filters? */
export function passesFilters(o: { profitQu: number; costQu: number; profitPct: number }, f: Partial<ArbFilters> = {}): boolean {
  return o.profitQu >= (f.minProfitQu ?? 0) && o.profitPct >= (f.minProfitPct ?? 0) && (!f.maxCostQu || o.costQu <= f.maxCostQu);
}

/** Query string for the API (only the filters that are set). */
export function arbQuery(f: Partial<ArbFilters>): string {
  const q = new URLSearchParams();
  if (f.minProfitQu) q.set("minProfitQu", String(f.minProfitQu));
  if (f.minProfitPct) q.set("minProfitPct", String(f.minProfitPct));
  if (f.maxCostQu) q.set("maxCostQu", String(f.maxCostQu));
  return q.toString();
}

/** Reads the filters from an API query, refusing anything that is not a non-negative number. */
export function parseArbQuery(params: URLSearchParams): ArbFilters {
  const out = { ...NO_FILTERS };
  for (const k of Object.keys(out) as (keyof ArbFilters)[]) {
    const raw = params.get(k);
    if (raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a number, zero or more`);
    out[k] = n;
  }
  return sanitizeArbFilters(out);
}

/** A short description of the active filters, e.g. "profit of at least 5,000 QU and 2%, at most 1,000,000 QU in". */
export function describeFilters(f: ArbFilters): string {
  const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const parts: string[] = [];
  if (f.minProfitQu) parts.push(`at least ${n(f.minProfitQu)} QU profit`);
  if (f.minProfitPct) parts.push(`at least ${n(f.minProfitPct)}% profit`);
  if (f.maxCostQu) parts.push(`at most ${n(f.maxCostQu)} QU in`);
  return parts.join(", ");
}
