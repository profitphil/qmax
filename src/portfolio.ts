import type { Ledger, LedgerEntry, LedgerPosition } from "./ledger.ts";
import type { LiquidationItem } from "./liquidation.ts";

/**
 * The My assets view, put together from three things: what the wallet holds now (read from the chain), what each holding would really fetch if it
 * were sold now (src/liquidation.ts: the depth of the market and every fee, not units times the last price) and what it cost (the wallet's trade
 * ledger, src/ledger.ts, by the average cost method). Profit or loss here is "worth now against cost" on a real sale, so it is what selling would
 * actually leave you with, and it only covers units whose purchase the ledger found.
 */

export interface HoldingIn {
  /** `NAME|ISSUER`, the ledger's key for the asset. */
  key: string;
  /** The asset's id in the asset list (what the API takes). */
  id: string;
  symbol: string;
  qty: number;
}

/** Whether the units are known to have been bought: yes (all of them), partly, no (none in the window: older, or received), or unknown (no ledger yet). */
export type Bought = "yes" | "partly" | "no" | "unknown";

export interface PortfolioRow {
  key: string;
  id: string;
  symbol: string;
  held: number;
  /** What a sale of `fillableQty` would bring in, after fees; null before the sale is priced. */
  proceedsQu: number | null;
  fillableQty: number;
  /** False when the market cannot take the whole holding now. */
  complete: boolean;
  /** How far below the mid price value the sale lands, in percent (fees and depth). */
  haircutPct: number | null;
  midValueQu: number | null;
  venues: string[];
  /** Why it could not be priced. */
  error?: string;
  bought: Bought;
  /** Units whose cost is known (at most `held`), their average cost per unit, and what that cost. */
  costedQty: number;
  avgCost: number | null;
  costQu: number | null;
  firstBuyMs: number | null;
  lastBuyMs: number | null;
  buys: number;
  /** Profit or loss on the units compared: their sale value now minus their cost. Null when there is nothing to compare. */
  plQu: number | null;
  plPct: number | null;
  /** How many units that comparison covers. */
  comparedQty: number;
  /** Profit already made by selling some of it (average cost). Null without a ledger. */
  realizedQu: number | null;
}

export interface PortfolioTotals {
  /** What everything would fetch if sold now, and the same at mid prices. */
  worthQu: number;
  midQu: number;
  /** How much of the mid value fees and depth would take (`midQu - worthQu`, on the holdings that could be priced). */
  haircutQu: number;
  /** What the compared units cost, and their profit or loss now. */
  costQu: number;
  plQu: number | null;
  plPct: number | null;
  /** Profit realized by sales in the ledger's window. Null without a ledger. */
  realizedQu: number | null;
  /** Holdings with no purchase found (older than the window, or received), so not in the profit. */
  uncosted: number;
  /** Holdings the market cannot take in full now: none of it (no buyers), or only part. */
  incomplete: number;
  noBuyers: number;
  partial: number;
  priced: boolean;
}

type LedgerPart = Pick<Ledger, "positions" | "entries" | "totals">;

export function buildPortfolio(holdings: HoldingIn[], liquidation: LiquidationItem[] | null, ledger: LedgerPart | null): { rows: PortfolioRow[]; totals: PortfolioTotals } {
  const liq = new Map((liquidation ?? []).map((i) => [i.asset.toUpperCase(), i]));
  const positions = new Map<string, LedgerPosition>((ledger?.positions ?? []).map((p) => [p.asset.key, p]));
  const buys = new Map<string, LedgerEntry[]>();
  for (const e of ledger?.entries ?? []) if (e.kind === "buy" && e.asset) (buys.get(e.asset.key) ?? buys.set(e.asset.key, []).get(e.asset.key)!).push(e);

  const rows = holdings.map((h): PortfolioRow => {
    const l = liq.get(h.id.toUpperCase());
    const pos = positions.get(h.key);
    const mine = buys.get(h.key) ?? [];
    const costedQty = pos && pos.avgCost !== null ? Math.min(pos.costedQty, h.qty) : 0;
    const avgCost = costedQty > 0 ? pos!.avgCost : null;
    const bought: Bought = !ledger ? "unknown" : costedQty >= h.qty * 0.999 ? "yes" : costedQty > 0 ? "partly" : "no";
    const fillable = l ? l.fillableQty : 0;
    const perUnit = l && fillable > 0 ? l.proceedsQu / fillable : null;
    // Compare like with like: the units that are both costed and sellable, at their average sale price against their average cost.
    const comparedQty = perUnit !== null && avgCost !== null ? Math.min(costedQty, fillable) : 0;
    const costQu = avgCost !== null ? avgCost * comparedQty : null;
    const plQu = perUnit !== null && avgCost !== null && comparedQty > 0 ? (perUnit - avgCost) * comparedQty : null;
    return {
      key: h.key,
      id: h.id,
      symbol: h.symbol,
      held: h.qty,
      proceedsQu: l ? l.proceedsQu : null,
      fillableQty: fillable,
      complete: l ? l.complete : false,
      haircutPct: l?.haircutPct ?? null,
      midValueQu: l?.midValueQu ?? null,
      venues: l?.venues ?? [],
      ...(l?.error ? { error: l.error } : {}),
      bought,
      costedQty,
      avgCost,
      costQu,
      firstBuyMs: mine.length ? Math.min(...mine.map((e) => e.t)) : null,
      lastBuyMs: mine.length ? Math.max(...mine.map((e) => e.t)) : null,
      buys: mine.length,
      plQu,
      plPct: plQu !== null && costQu !== null && costQu > 0 ? (plQu / costQu) * 100 : null,
      comparedQty,
      realizedQu: ledger ? pos?.realizedQu ?? 0 : null,
    };
  });

  const priced = rows.filter((r) => r.proceedsQu !== null);
  const worthQu = priced.reduce((s, r) => s + (r.proceedsQu ?? 0), 0);
  const withMid = priced.filter((r) => r.midValueQu !== null && r.fillableQty > 0);
  // The mid value of what could be sold, so the gap is fees and depth, not the part the market would not take.
  const midQu = rows.reduce((s, r) => s + (r.midValueQu ?? 0), 0);
  const midOfSold = withMid.reduce((s, r) => s + (r.midValueQu! * r.fillableQty) / r.held, 0);
  const soldWorth = withMid.reduce((s, r) => s + (r.proceedsQu ?? 0), 0);
  const compared = rows.filter((r) => r.plQu !== null);
  const costQu = compared.reduce((s, r) => s + (r.costQu ?? 0), 0);
  const plQu = compared.length ? compared.reduce((s, r) => s + (r.plQu ?? 0), 0) : null;
  return {
    rows,
    totals: {
      worthQu,
      midQu,
      haircutQu: Math.max(0, midOfSold - soldWorth),
      costQu,
      plQu,
      plPct: plQu !== null && costQu > 0 ? (plQu / costQu) * 100 : null,
      realizedQu: ledger ? ledger.totals.realizedQu : null,
      uncosted: ledger ? rows.filter((r) => r.bought === "no").length : 0,
      incomplete: rows.filter((r) => r.proceedsQu !== null && !r.complete).length,
      noBuyers: rows.filter((r) => r.proceedsQu !== null && !r.complete && r.fillableQty <= 0).length,
      partial: rows.filter((r) => r.proceedsQu !== null && !r.complete && r.fillableQty > 0).length,
      priced: priced.length > 0,
    },
  };
}
