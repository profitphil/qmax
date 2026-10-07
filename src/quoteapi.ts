import type { MarketData } from "./data.ts";
import type { ExecutionHint } from "./exec.ts";
import { RouteError, plainNumber } from "./routes.ts";
import { route } from "./router.ts";
import type { Side } from "./types.ts";

const MAX_QTY = 1e12;

export function parseQuery(input: Record<string, unknown>) {
  const side = String(input.side ?? "").toLowerCase();
  const asset = String(input.asset ?? "").trim();
  const qty = plainNumber(typeof input.qty === "string" ? input.qty.replace(/,/g, "") : input.qty);
  if (side !== "buy" && side !== "sell") throw new RouteError(400, "side must be 'buy' or 'sell'");
  if (!asset) throw new RouteError(400, "asset is required");
  if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY)
    throw new RouteError(400, `qty must be a positive integer up to ${MAX_QTY}`);
  const slippageBps = input.slippageBps === undefined ? 100 : plainNumber(input.slippageBps);
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 1000)
    throw new RouteError(400, "slippageBps must be between 0 and 1000");
  return {
    side: side as Side,
    asset,
    qty,
    slippageBps,
    split: input.split !== false && input.split !== "false",
  };
}

/** Limits that protect the user from the market moving between quote and execution. */
function hintFor(venue: string, q: import("./types.ts").VenueQuote, side: Side, slip: number): ExecutionHint {
  if (venue === "QX") {
    const p = q.limitPrice ?? 1;
    return side === "buy"
      ? { type: "qx-bid", qty: q.qty, limitPrice: Math.ceil(p * (1 + slip)) }
      : { type: "qx-ask", qty: q.qty, limitPrice: Math.max(1, Math.floor(p * (1 - slip))) };
  }
  const variable = side === "buy" ? q.netQu - q.fixedCostQu : q.netQu + q.fixedCostQu;
  return side === "buy"
    ? { type: "qswap-buy", qty: q.qty, maxQuIn: Math.ceil(variable * (1 + slip)) }
    : { type: "qswap-sell", qty: q.qty, minQuOut: Math.floor(variable * (1 - slip)) };
}

/** Quotes one order across the venues and describes it the way the API does: the route, the alternatives and the limits to sign. */
export async function buildQuote(data: MarketData, input: Record<string, unknown>, opts: { allowTinyQswapBuy?: boolean; /** Quote on this one market only (used to measure what a single market would give; never settable from a request). */ onlyVenue?: "QX" | "QSwap" } = {}) {
  const q = parseQuery(input);
  const data_verify = typeof data.verify === "function";
  const slip = q.slippageBps / 10_000;
  const [venues, assetInfo] = await Promise.all([data.venues(q.asset), data.assetInfo?.(q.asset) ?? null]);
  if (!venues) throw new RouteError(404, `Unknown asset '${q.asset}'`);
  const plan = route(opts.onlyVenue ? venues.filter((v) => v.name === opts.onlyVenue) : venues, q.side, q.qty, { split: q.split, allowTinyQswapBuy: opts.allowTinyQswapBuy });
  const onChainCheck = data_verify ? await data.verify!(q.asset, plan.allocations).catch(() => null) : undefined;
  return {
    asset: q.asset.toUpperCase(),
    side: plan.side,
    qty: plan.qty,
    filledQty: plan.filledQty,
    fillable: plan.filledQty === plan.qty,
    totalQu: plan.totalNetQu,
    averagePriceQu: Number.isFinite(plan.averagePrice) ? plan.averagePrice : null,
    slippageBps: q.slippageBps,
    executable: assetInfo !== null,
    ...(assetInfo ? { assetInfo } : {}),
    route: plan.allocations.map((a) => ({
      venue: a.venue,
      qty: a.qty,
      shareOfOrder: a.qty / plan.qty,
      totalQu: a.quote.netQu,
      effectivePriceQu: a.quote.effectivePrice,
      priceImpact: a.quote.priceImpact,
      feesQu: a.quote.feesQu,
      fixedCostQu: a.quote.fixedCostQu,
      ...(a.quote.depth ? { depth: a.quote.depth } : {}),
      // QX fills against individual orders at whole-number prices; the average above is not one of them.
      ...(a.quote.limitPrice !== undefined ? { priceRangeQu: { best: a.quote.referencePrice, worst: a.quote.limitPrice } } : {}),
      ...(assetInfo ? { execution: hintFor(a.venue, a.quote, plan.side, slip) } : {}),
    })),
    alternatives: plan.singleVenue.map((s) => ({
      venue: s.venue,
      fillable: s.quote !== null,
      totalQu: s.quote?.netQu ?? null,
      effectivePriceQu: s.quote?.effectivePrice ?? null,
    })),
    warnings: plan.warnings,
    ...(onChainCheck ? { onChainCheck } : {}),
    quotedAt: new Date().toISOString(),
  };
}

