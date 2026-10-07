import type { ArbFilters } from "./arbfilters.ts";
import type { ManageTarget } from "./consolidate.ts";

export interface Settings {
  /** Price movement allowed between quote and fill, in percent. */
  slippagePct: number;
  /** Start with assets that have been quiet for two epochs hidden. */
  hideQuiet: boolean;
  /** How the asset list starts: busiest first (QU traded in 24 hours), most liquid first, or by name. */
  defaultSort: "volume" | "liquidity" | "az";
  /** Show 8.75B instead of 8,750,000,000 on cards. */
  compactPrices: boolean;
  /** Arbitrage filters: smallest profit in QU, smallest profit in percent, and most QU to put in (0 = no limit). */
  arbMinProfitQu: number;
  arbMinProfitPct: number;
  arbMaxCostQu: number;
  /** After a trade, offer to move that asset's shares under one contract (QX or QSwap). */
  consolidate: boolean;
  consolidateTo: ManageTarget;
  /** Tell QMax the transaction ids of trades made here, so it can count usage. They are public on-chain data; the wallet is the sender. */
  shareUsage: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  slippagePct: 1,
  hideQuiet: false,
  defaultSort: "volume",
  compactPrices: true,
  arbMinProfitQu: 10_000,
  arbMinProfitPct: 0,
  arbMaxCostQu: 0,
  consolidate: false,
  consolidateTo: "qx",
  shareUsage: true,
};

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Turns anything read from storage into valid settings: wrong types and out-of-range values fall back to defaults. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    slippagePct: num(r.slippagePct, d.slippagePct, 0, 10),
    hideQuiet: typeof r.hideQuiet === "boolean" ? r.hideQuiet : d.hideQuiet,
    // "top" was the old name for most liquid, and was what everyone had by default: those people get the new default, busiest first.
    defaultSort: r.defaultSort === "az" || r.defaultSort === "liquidity" || r.defaultSort === "volume" ? r.defaultSort : d.defaultSort,
    compactPrices: typeof r.compactPrices === "boolean" ? r.compactPrices : d.compactPrices,
    arbMinProfitQu: num(r.arbMinProfitQu, d.arbMinProfitQu, 0, 1e12),
    arbMinProfitPct: num(r.arbMinProfitPct, d.arbMinProfitPct, 0, 1000),
    arbMaxCostQu: num(r.arbMaxCostQu, d.arbMaxCostQu, 0, 1e13),
    consolidate: typeof r.consolidate === "boolean" ? r.consolidate : d.consolidate,
    consolidateTo: r.consolidateTo === "qswap" || r.consolidateTo === "qx" ? r.consolidateTo : d.consolidateTo,
    shareUsage: typeof r.shareUsage === "boolean" ? r.shareUsage : d.shareUsage,
  };
}

/** The arbitrage settings as filters for the search. */
export const arbFiltersOf = (s: Settings): ArbFilters => ({ minProfitQu: s.arbMinProfitQu, minProfitPct: s.arbMinProfitPct, maxCostQu: s.arbMaxCostQu });
