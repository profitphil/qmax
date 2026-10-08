import { RouteError, plainNumber } from "./routes.ts";
import type { Route } from "./routes.ts";
import type { Venue } from "./types.ts";
import { QxVenue } from "./venues.ts";

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

/** How many holdings are priced at the same time, and how often one that failed for a passing reason is asked again (and how long it waits first). */
export interface LiquidationPacing {
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  /**
   * How long pricing may go on before the holdings not yet started are handed back unpriced (with a reason that says to ask again), so an answer comes back inside the proxy's
   * 60-second limit even for a very large portfolio. The ones already priced are kept by the server for a while, so asking again prices the rest. Default 40,000.
   */
  budgetMs?: number;
}

/** A reason that will not change by asking again (the asset is not known), against a passing one (the node is busy, a request timed out). */
const lasting = (e: unknown): boolean => e instanceof RouteError && e.status === 404;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs `fn` over `list` with at most `limit` running at once, keeping the order of the answers. */
async function mapLimit<T, R>(list: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i]);
      }
    }),
  );
  return out;
}

/**
 * Each holding is priced by reading its market live, and the node answers a limited number of requests a second, so pricing every holding at the same moment queues hundreds of
 * requests and the ones at the back are refused as "node busy" (a wallet with 25 holdings lost about half of them this way, and the page kept the failures). So only a few are priced
 * at a time, and one that fails for a passing reason is asked again a couple of times before it is reported as failed.
 */
export async function liquidate(inputs: LiquidationInput[], deps: LiquidationDeps, pacing: LiquidationPacing = {}): Promise<LiquidationResult> {
  const retries = pacing.retries ?? 2;
  const retryDelayMs = pacing.retryDelayMs ?? 1500;
  const quote = async (asset: string, qty: number) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await deps.quote(asset, qty);
      } catch (e) {
        if (attempt >= retries || lasting(e)) throw e;
        await wait(retryDelayMs * (attempt + 1));
      }
    }
  };
  const startedAt = Date.now();
  const budgetMs = pacing.budgetMs ?? 40_000;
  const items = await mapLimit(
    inputs,
    pacing.concurrency ?? 4,
    async (i): Promise<LiquidationItem> => {
      const mid = deps.midPrice(i.asset);
      const midValueQu = mid !== null && mid > 0 ? mid * i.qty : null;
      if (Date.now() - startedAt > budgetMs) return { asset: i.asset, qty: i.qty, fillableQty: 0, proceedsQu: 0, avgPriceQu: null, midValueQu, haircutPct: null, venues: [], complete: false, error: STILL_PRICING };
      try {
        const q = await quote(i.asset, i.qty);
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
    },
  );
  return combineLiquidation(items, (deps.now ?? Date.now)());
}

/** The reason given for a holding that was not priced because the answer had to go back first. A page that sees it asks again for that holding. */
export const STILL_PRICING = "QMax is still pricing this one: asking again.";

/** The answer for a list of holdings' items: their totals and how many could not be sold in full. (Also how a page puts together an answer it fetched in parts.) */
export function combineLiquidation(items: LiquidationItem[], at: number): LiquidationResult {
  return {
    items,
    totalProceedsQu: items.reduce((s, x) => s + x.proceedsQu, 0),
    totalMidQu: items.reduce((s, x) => s + (x.midValueQu ?? 0), 0),
    incomplete: items.filter((x) => !x.complete).length,
    at,
  };
}

/** A list cut into runs of at most `size`, keeping the order (a portfolio is priced a few holdings at a time, so no one request runs long). */
export function inRuns<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + Math.max(1, size)));
  return out;
}

/**
 * The most units of an asset the markets could take in a sale now. A QSwap pool takes any amount (the price only gets worse), so with a pool the answer is unlimited; with QX alone
 * it is the units the standing bids ask for. A market of any other kind is not known, and counts as unlimited too, so nothing is cut short on a guess.
 */
export function sellCapacity(venues: Venue[]): number {
  let total = 0;
  for (const v of venues) {
    if (!(v instanceof QxVenue)) return Infinity;
    total += v.depth("sell");
  }
  return total;
}

/**
 * A quote that does not give up on an amount the market cannot take in full. The router is all or nothing (it fills the whole order or says there is not enough depth), so a holding
 * of 30 shares with buyers for 12 was priced as nothing. When the whole amount does not fill and the market can take part of it, this prices the part it can take (`capacity` says
 * how many units that is): the holding is then worth what its sellable units bring, and `liquidate` marks it incomplete.
 */
export function quoteWhatFits(quote: LiquidationDeps["quote"], capacity: (asset: string) => Promise<number | null>): LiquidationDeps["quote"] {
  return async (asset, qty) => {
    const full = await quote(asset, qty);
    if (full.filledQty >= qty) return full;
    let most = Infinity;
    try {
      most = Math.floor((await capacity(asset)) ?? Infinity);
    } catch {
      return full; // the capacity could not be read: the whole-amount answer stands
    }
    if (!(most > 0) || most >= qty) return full;
    const part = await quote(asset, most);
    return part.filledQty > 0 ? part : full;
  };
}

/**
 * `read` for an asset, kept for `ttlMs` and shared by everyone who asks meanwhile (two asking at once make one read). Pricing a portfolio reads each holding's market live, which
 * is most of what the public node is asked, and a portfolio's worth does not need books fresher than a minute, so wallets that hold the same asset share one reading of it.
 * A failure, and an answer of null (an unknown asset), are not kept. The oldest go first once `max` are held.
 */
export function sharedRead<T>(read: (asset: string) => Promise<T | null>, o: { ttlMs: number; max?: number; now?: () => number }): (asset: string) => Promise<T | null> {
  const now = o.now ?? Date.now;
  const max = o.max ?? 500;
  const kept = new Map<string, { at: number; value: Promise<T | null> }>();
  return (asset) => {
    const key = asset.toUpperCase();
    const hit = kept.get(key);
    if (hit && now() - hit.at < o.ttlMs) return hit.value;
    const value = read(asset);
    kept.set(key, { at: now(), value });
    value.then(
      (v) => {
        if (v === null && kept.get(key)?.value === value) kept.delete(key);
      },
      () => {
        if (kept.get(key)?.value === value) kept.delete(key);
      },
    );
    while (kept.size > max) kept.delete(kept.keys().next().value as string);
    return value;
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
