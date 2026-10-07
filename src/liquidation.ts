import { RouteError, plainNumber } from "./routes.ts";
import type { Route } from "./routes.ts";

/**
 * What a wallet's holdings would really fetch if they were sold now: not units times the last price, but each asset's whole holding run through the
 * same router a real sale uses, so the depth of the QX book and the pool, the venues' fees and QSwap's flat fee are all in it. Where the market cannot
 * take the whole holding, only what it can take is counted, and the asset is marked incomplete. Each asset is priced on its own (selling one does
 * not move the price of another).
 */

export interface LiquidationInput {
  asset: string;
  qty: number;
}

export interface LiquidationItem {
  asset: string;
  qty: number;
  /** How many of the units a sale could place now (all of them when `complete`). */
  fillableQty: number;
  /** QU a sale of `fillableQty` would bring in, after fees. */
  proceedsQu: number;
  /** Proceeds per unit sold. */
  avgPriceQu: number | null;
  /** The units at the market's mid or pool price, for comparison. */
  midValueQu: number | null;
  /** How far below that mid value the real sale lands, in percent (fees plus the depth of the market). Null without a mid price. */
  haircutPct: number | null;
  venues: string[];
  complete: boolean;
  /** Why this asset could not be priced. */
  error?: string;
}

export interface LiquidationResult {
  items: LiquidationItem[];
  totalProceedsQu: number;
  totalMidQu: number;
  /** Assets the market cannot take in full right now. */
  incomplete: number;
  at: number;
}

export interface LiquidationDeps {
  /** A sale of `qty` units with no slippage allowance: what fills, what it brings, where. */
  quote(asset: string, qty: number): Promise<{ filledQty: number; totalQu: number; averagePriceQu: number | null; route: { venue: string }[] }>;
  /** The asset's mid or pool price, QU per unit, or null. */
  midPrice(asset: string): number | null;
  now?: () => number;
}

export async function liquidate(inputs: LiquidationInput[], deps: LiquidationDeps): Promise<LiquidationResult> {
  const items = await Promise.all(
    inputs.map(async (i): Promise<LiquidationItem> => {
      const mid = deps.midPrice(i.asset);
      const midValueQu = mid !== null && mid > 0 ? mid * i.qty : null;
      try {
        const q = await deps.quote(i.asset, i.qty);
        const fillableQty = Math.max(0, Math.min(i.qty, q.filledQty));
        const proceedsQu = Math.max(0, q.totalQu);
        // The haircut is measured on what was sold: the mid value of the filled part, not of the whole holding.
        const midOfFilled = mid !== null && mid > 0 ? mid * fillableQty : null;
        return {
          asset: i.asset,
          qty: i.qty,
          fillableQty,
          proceedsQu,
          avgPriceQu: fillableQty > 0 ? proceedsQu / fillableQty : null,
          midValueQu,
          haircutPct: midOfFilled && midOfFilled > 0 ? (1 - proceedsQu / midOfFilled) * 100 : null,
          venues: [...new Set(q.route.map((r) => r.venue))],
          complete: fillableQty >= i.qty,
        };
      } catch (e) {
        return { asset: i.asset, qty: i.qty, fillableQty: 0, proceedsQu: 0, avgPriceQu: null, midValueQu, haircutPct: null, venues: [], complete: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return {
    items,
    totalProceedsQu: items.reduce((s, x) => s + x.proceedsQu, 0),
    totalMidQu: items.reduce((s, x) => s + (x.midValueQu ?? 0), 0),
    incomplete: items.filter((x) => !x.complete).length,
    at: (deps.now ?? Date.now)(),
  };
}

/**
 * Prices shared between everyone who asks: a sale of the same amount of the same asset is the same answer for a while, whoever asks, and two
 * people asking at once make one pricing. Holdings of contract shares are small whole numbers that many wallets share, so this is where most of the
 * work is saved. A failure is not kept. The cache holds at most `max` answers (the oldest go first), so it cannot grow without limit.
 */
export function cachedQuote(quote: LiquidationDeps["quote"], o: { ttlMs?: number; max?: number; now?: () => number } = {}): LiquidationDeps["quote"] & { size(): number } {
  const ttl = o.ttlMs ?? 30_000;
  const max = o.max ?? 5000;
  const now = o.now ?? Date.now;
  const kept = new Map<string, { at: number; value?: Awaited<ReturnType<LiquidationDeps["quote"]>>; pending?: ReturnType<LiquidationDeps["quote"]> }>();
  const fn = (async (asset: string, qty: number) => {
    const key = `${asset.toUpperCase()}|${qty}`;
    const hit = kept.get(key);
    if (hit?.pending) return hit.pending;
    if (hit?.value && now() - hit.at < ttl) return hit.value;
    const pending = quote(asset, qty);
    kept.set(key, { at: now(), pending });
    try {
      const value = await pending;
      kept.set(key, { at: now(), value });
      while (kept.size > max) kept.delete(kept.keys().next().value as string); // the oldest first (a Map keeps the order things were added in)
      return value;
    } catch (e) {
      kept.delete(key);
      throw e;
    }
  }) as LiquidationDeps["quote"] & { size(): number };
  fn.size = () => kept.size;
  return fn;
}

const MAX_ITEMS = 100;
const MAX_QTY = 1e12;

/** The request body: a list of { asset, qty }. Each asset once (quantities of a repeat are added), whole positive quantities, a sane count. */
export function parseHoldings(body: unknown): LiquidationInput[] {
  const list = (body as { holdings?: unknown } | null)?.holdings;
  if (!Array.isArray(list) || list.length === 0) throw new RouteError(400, "holdings must be a non-empty list of { asset, qty }");
  if (list.length > MAX_ITEMS) throw new RouteError(400, `at most ${MAX_ITEMS} holdings at a time`);
  const by = new Map<string, number>();
  for (const h of list) {
    const asset = typeof (h as { asset?: unknown })?.asset === "string" ? (h as { asset: string }).asset.trim() : "";
    const rawQty = (h as { qty?: unknown })?.qty;
    const qty = plainNumber(typeof rawQty === "string" ? rawQty.replace(/,/g, "") : rawQty);
    if (!asset || asset.length > 40) throw new RouteError(400, "every holding needs an asset id");
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) throw new RouteError(400, `qty must be a positive whole number up to ${MAX_QTY}`);
    by.set(asset, (by.get(asset) ?? 0) + qty);
  }
  return [...by.entries()].map(([asset, qty]) => ({ asset, qty }));
}

/** At most `maxConcurrent` pricings run at once (default 3); a request that finds them all busy is told to ask again in a moment. */
export function liquidationRoutes(deps: LiquidationDeps, opts: { maxConcurrent?: number } = {}): Route[] {
  const maxConcurrent = opts.maxConcurrent ?? 3;
  let running = 0;
  return [
    {
      method: "POST",
      path: "/v1/liquidation",
      limited: false,
      rate: { perMin: 20 },
      doc: {
        summary: "What a set of holdings would fetch if sold now",
        description:
          "Each holding is run through the router as a sale of the whole amount, so the answer counts the depth of the QX order book and the QSwap pool and every fee, not just units times the last price. " +
          "Where the market cannot take the whole holding, only the part it can take is counted and the holding is marked incomplete. Each asset is priced on its own. Nothing is sent or reserved.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["holdings"], properties: { holdings: { type: "array", maxItems: MAX_ITEMS, items: { type: "object", required: ["asset", "qty"], properties: { asset: { type: "string" }, qty: { type: "integer", minimum: 1 } } } } } } } } },
        responses: { "200": { description: "{ items: [{ asset, qty, fillableQty, proceedsQu, avgPriceQu, midValueQu, haircutPct, venues, complete, error? }], totalProceedsQu, totalMidQu, incomplete, at }" }, "400": { description: "Invalid holdings" } },
      },
      async handler({ body }) {
        const holdings = parseHoldings(body);
        if (running >= maxConcurrent) throw new RouteError(503, "QMax is pricing other portfolios right now. Try again in a few seconds.", { retryAfterSec: 3 });
        running++;
        try {
          return await liquidate(holdings, deps);
        } finally {
          running--;
        }
      },
    },
  ];
}
