import { RouteError, oneOf, plainNumber, required } from "./routes.ts";
import type { Route } from "./routes.ts";
import { isProblem, planMax } from "./maxplan.ts";
import type { MaxDeps, MaxInput, MaxPlan } from "./maxplan.ts";
import type { QuoteFn } from "./swap.ts";

const MAX_QTY = 1e12;
/** A plan is a dozen or more quotes: the same question asked within this long is answered from the one before. */
const KEEP_MS = 15_000;
const KEEP_MAX = 300;

const optionalWhole = (query: URLSearchParams, name: string, max = Number.MAX_SAFE_INTEGER): number | undefined => {
  const raw = query.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = plainNumber(raw.replace(/,/g, ""));
  if (!Number.isInteger(n) || n < 0 || n > max) throw new RouteError(400, `${name} must be a whole number from 0 to ${max}`);
  return n;
};

/** What Max asks of the server: the planner's own dependencies, and a quote on one market only (the legs of an arbitrage). */
export interface MaxRouteDeps extends MaxDeps {
  quoteOnly: (venue: "QX" | "QSwap") => QuoteFn;
  /** What an agent pays for a Max plan (API_MAX_PRICE_QU), in QU: said in the endpoint's description. 0 or unset: free. */
  priceQu?: number;
  /**
   * The quote `GET /v1/venue-quote` answers with, for a person who will sign it. Unlike the planner's (which probes small sizes on purpose), it refuses a QSwap
   * buy so small that the pool would keep the whole payment. Defaults to `quoteOnly`.
   */
  venueQuote?: (venue: "QX" | "QSwap") => QuoteFn;
  now?: () => number;
}

/**
 * `GET /v1/max` plans the best position for an order (see `planMax`): Max, the website's Pro feature (free to try for a while, then a pass). `GET /v1/venue-quote`
 * quotes one order on one market, which is what each leg of a Max arbitrage is and what a plain QSwap swap is. Like the swap planner both count against the
 * free quota, so they can be sold by session or by key like the rest.
 */
export function maxRoutes(deps: MaxRouteDeps): Route[] {
  const now = deps.now ?? Date.now;
  const kept = new Map<string, { at: number; value: MaxPlan }>();
  const inflight = new Map<string, Promise<MaxPlan>>();
  return [
    {
      method: "GET",
      path: "/v1/max",
      limited: true,
      doc: {
        summary: "Max: the best position for a trade",
        description:
          "Searches for the best position, not just the best route. A normal order already goes at the best route (each market priced alone and a split, the cheapest taken); " +
          "Max also looks at what to do with the order: take the best route now, or rest on the QX book at the touch for a better price (with how often QX traded there in the last day), " +
          "or both; the size where one more unit starts to cost more; an arbitrage between QX and QSwap sized to the wallet; and, for a sale, what it returns against what the units cost. " +
          "Each pick is a short list of ordinary actions (a market order at the best route or on one market, a limit order) with what it should give. Prices move: quote and check every action again before signing. " +
          "Nothing is signed or sent. The wallet's numbers (`balanceQu`, `heldQty`, `avgCostQu`) come from the caller and are used only to size the plan." +
          (deps.priceQu ? ` For agents a plan costs ${deps.priceQu} QU: from a prepaid key's balance (POST /v1/keys, GET /v1/topup, POST /v1/topup/claim, then send x-api-key) or free inside an x402 session (GET /v1/x402). Without either the answer is a 402 with the price. The website's own Max is free.` : ""),
        parameters: [
          { name: "asset", in: "query", required: true, schema: { type: "string" }, description: "Asset id from /v1/assets" },
          { name: "side", in: "query", required: true, schema: { type: "string", enum: ["buy", "sell"] } },
          { name: "qty", in: "query", required: false, schema: { type: "integer", minimum: 1 }, description: "The amount asked for. Without it Max plans for all the wallet can buy (needs balanceQu) or all it holds (needs heldQty)." },
          { name: "balanceQu", in: "query", required: false, schema: { type: "integer", minimum: 0 }, description: "QU in the wallet: what a buy or an arbitrage may spend." },
          { name: "heldQty", in: "query", required: false, schema: { type: "integer", minimum: 0 }, description: "Units the wallet can sell here." },
          { name: "avgCostQu", in: "query", required: false, schema: { type: "integer", minimum: 0 }, description: "What each held unit cost, for the profit of an exit." },
          { name: "slippageBps", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 1000, default: 100 } },
        ],
        responses: {
          "200": { description: "{ asset, side, qty, baseline, picks, recommendedId, arbitrage, searched, cut, quotesUsed }" },
          ...(deps.priceQu ? { "402": { description: `A Max plan costs ${deps.priceQu} QU for agents: send a prepaid key (x-api-key) with at least that balance, or an x402 session` } } : {}),
          "400": { description: "Bad parameters, or nothing to plan from" },
          "404": { description: "Unknown asset" },
          "422": { description: "The market cannot fill it, or the asset cannot be signed from here" },
        },
      },
      handler: async ({ query }) => {
        const input: MaxInput = {
          asset: required(query, "asset"),
          side: oneOf(query, "side", ["buy", "sell"] as const, "buy"),
          qty: optionalWhole(query, "qty", MAX_QTY),
          balanceQu: optionalWhole(query, "balanceQu"),
          heldQty: optionalWhole(query, "heldQty", MAX_QTY),
          avgCostQu: optionalWhole(query, "avgCostQu") ?? null,
          slippageBps: query.get("slippageBps") === null ? 100 : plainNumber(query.get("slippageBps")),
        };
        if (query.get("side") === null) throw new RouteError(400, "side is required (buy or sell)");
        const key = JSON.stringify([input.asset.toUpperCase(), input.side, input.qty, input.balanceQu, input.heldQty, input.avgCostQu, input.slippageBps]);
        const t = now();
        const hit = kept.get(key);
        if (hit && t - hit.at < KEEP_MS) return { ...hit.value, checkedAt: new Date(hit.at).toISOString() };
        let job = inflight.get(key);
        if (!job) {
          job = planMax(deps, input).then((r) => {
            if (isProblem(r)) throw new RouteError(r.code === "unknown-asset" ? 404 : r.code === "bad-input" ? 400 : 422, r.message);
            return r;
          });
          inflight.set(key, job);
          job.finally(() => inflight.delete(key)).catch(() => {});
        }
        const value = await job;
        if (kept.size >= KEEP_MAX) kept.delete(kept.keys().next().value!);
        kept.set(key, { at: t, value });
        return { ...value, checkedAt: new Date(t).toISOString() };
      },
    },
    {
      method: "GET",
      path: "/v1/venue-quote",
      limited: true,
      doc: {
        summary: "A quote on one market only (a plain QSwap swap, or a leg of a Max arbitrage)",
        description: "The same quote as /v1/quote, but routed on the one market asked for (QX or QSwap) instead of the cheapest route: what a plain QSwap swap is, and how the two legs of an arbitrage land on the markets the plan chose. A QSwap buy too small to be safe (the pool would keep the whole payment) is not quoted.",
        parameters: [
          { name: "asset", in: "query", required: true, schema: { type: "string" } },
          { name: "side", in: "query", required: true, schema: { type: "string", enum: ["buy", "sell"] } },
          { name: "qty", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
          { name: "venue", in: "query", required: true, schema: { type: "string", enum: ["QX", "QSwap"] } },
          { name: "slippageBps", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 1000, default: 100 } },
        ],
        responses: { "200": { description: "A quote, as /v1/quote answers" }, "400": { description: "Bad parameters" }, "404": { description: "Unknown asset" } },
      },
      handler: async ({ query }) => {
        const side = oneOf(query, "side", ["buy", "sell"] as const, "buy");
        if (query.get("side") === null) throw new RouteError(400, "side is required (buy or sell)");
        const venue = oneOf(query, "venue", ["QX", "QSwap"] as const, "QX");
        if (query.get("venue") === null) throw new RouteError(400, "venue is required (QX or QSwap)");
        const qty = optionalWhole(query, "qty", MAX_QTY);
        if (!qty) throw new RouteError(400, "qty must be a positive whole number");
        const slippageBps = query.get("slippageBps") === null ? 100 : plainNumber(query.get("slippageBps"));
        if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 1000) throw new RouteError(400, "slippageBps must be between 0 and 1000");
        return (deps.venueQuote ?? deps.quoteOnly)(venue)(side, required(query, "asset"), qty, slippageBps);
      },
    },
  ];
}
