/**
 * Max: the best position for a trade, not just the best route. The planner itself is NOT part of this repository: this file keeps its types (the shape of a plan, as
 * the API documents it) and a stand-in `planMax` that says so, so everything that depends on it still builds and runs. The website and the API's `/v1/max` endpoint
 * work against QMax's own server, where the real planner runs.
 */
import type { QuoteFn, SwapQuote } from "./swap.ts";
import type { Venue } from "./types.ts";

export type MaxSide = "buy" | "sell";
export type MaxKind = "route" | "touch" | "size" | "split" | "arbitrage";
export type MarketName = "QX" | "QSwap";

export interface MaxInput {
  asset: string;
  side: MaxSide;
  /** The amount the person typed, if they did. Without it Max plans for all they can buy with their QU, or all they hold. */
  qty?: number;
  /** QU in the wallet: what a buy may spend (and what an arbitrage may lay out). */
  balanceQu?: number;
  /** Units the wallet can sell here. */
  heldQty?: number;
  /** What each held unit cost, in QU, if known (it sets the profit on an exit). */
  avgCostQu?: number | null;
  slippageBps: number;
}

/** One QX trading hour, for how often a resting order would have been reached. */
export interface RecentHour {
  low: number;
  high: number;
  /** Units that traded in the hour (an upper bound on what traded at the price). */
  qty: number;
}

export interface MaxDeps {
  quote: QuoteFn;
  /** A quote function that routes on one market only (arbitrage legs). Without it there is no arbitrage pick. */
  quoteOnly?: (venue: MarketName) => QuoteFn;
  /** Fresh venue models: the QX book (for the touch) and both markets (for arbitrage). Without it there are no limit or arbitrage picks. */
  venues?: (asset: string) => Promise<Venue[] | null>;
  /** QX's last day, hour by hour. Without it a resting order has no evidence behind it and is ranked low. */
  recent?: (asset: string) => Promise<RecentHour[] | null>;
}

export interface MaxAction {
  kind: "market" | "limit";
  side: MaxSide;
  qty: number;
  /** A market action on one market only (arbitrage legs); otherwise the router takes the best route. */
  venue?: MarketName;
  /** A limit action's price, QU per unit. */
  price?: number;
  /** QU out (buy) or in (sell) when it goes through, fees and flat costs included. */
  expectedQu: number;
  avgPriceQu: number | null;
  /** True when the action fills now at what is quoted; a resting order is not certain. */
  certain: boolean;
  /** What it is, in words. */
  label: string;
}

export interface MaxPick {
  id: string;
  kind: MaxKind;
  title: string;
  why: string;
  actions: MaxAction[];
  /** Units traded if every action goes through. */
  qty: number;
  /** QU paid (buy) or received (sell) in all, if every action goes through. */
  totalQu: number;
  avgPriceQu: number | null;
  /** QU better than the plain order of the whole amount at the best route (more received, or less paid); negative is worse. For an arbitrage: its profit. */
  gainQu: number;
  gainPct: number;
  /** `gainQu` weighted by how likely it is to happen (a resting order may not fill): what picks are ranked by. */
  expectedGainQu: number;
  /** For a sale with a known cost: QU received against what those units cost. */
  profitQu: number | null;
  /** Every part is a fill-now market order. */
  certain: boolean;
  /** 0 to 1: how likely the whole pick is to go through (1 for fill-now orders; a resting order's comes from how often the market has traded at its price). */
  fillChance: number;
  risks: string[];
}

export interface MaxPlan {
  asset: string;
  side: MaxSide;
  /** The amount planned for: what was typed, or all that can be bought or sold; cut to what the market can fill. */
  qty: number;
  /** The plain market order at the best route, to compare everything with. */
  baseline: { qty: number; totalQu: number; avgPriceQu: number | null; route: { venue: string; shareOfOrder: number }[] };
  /** The picks for the order, best first. The first is the recommendation. */
  picks: MaxPick[];
  recommendedId: string;
  /** A profit available from the markets disagreeing, apart from the order. */
  arbitrage: MaxPick | null;
  /** What was looked at and what it found, for the page to show. */
  searched: { label: string; found: string }[];
  /** True when the order was cut because the market (or the wallet) could not take all of it at once. */
  cut: boolean;
  quotesUsed: number;
}

export type MaxProblem = { ok: false; code: "bad-input" | "unknown-asset" | "not-executable" | "no-liquidity"; message: string };

/** The stand-in: every request is answered with a problem that says the planner is not included in this release. */
export async function planMax(_deps: MaxDeps, _input: MaxInput): Promise<MaxPlan | MaxProblem> {
  return { ok: false, code: "not-executable", message: "The Max planner is not part of the open-source release of QMax." };
}

export const isProblem = (r: MaxPlan | MaxProblem): r is MaxProblem => "ok" in r && r.ok === false;
