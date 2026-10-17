import type { MarketData } from "./data.ts";
import { buildQuote } from "./quoteapi.ts";
import { RouteError, plainNumber } from "./routes.ts";
import type { Route } from "./routes.ts";
import type { Venue } from "./types.ts";

/**
 * Several sizes of the same order in one call (GET /v1/quotes?side=sell&asset=QDOGE&qtys=1000000,10000000,50000000). A bot choosing how big a piece to sell or buy at a time needs the price of
 * more than one size, and asking for them one by one means several calls, each against a slightly different book. Here all are priced from one reading of the markets, so the sizes can be
 * compared with each other: how fast the average price falls as the order grows is exactly what the list shows.
 */
export const MAX_SIZES = 10;

/** The sizes asked for: whole numbers, separated by commas, each used once, smallest first. */
export function parseSizes(text: string | null): number[] {
  const parts = (text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new RouteError(400, "qtys is required: whole numbers separated by commas, such as qtys=1000000,10000000,50000000");
  if (parts.length > MAX_SIZES) throw new RouteError(400, `qtys may list at most ${MAX_SIZES} sizes`);
  const sizes = parts.map((p) => (/^\d+$/.test(p) ? plainNumber(p) : NaN));
  if (sizes.some((n) => !Number.isInteger(n) || n <= 0)) throw new RouteError(400, "every size in qtys must be a positive whole number");
  return [...new Set(sizes)].sort((a, b) => a - b);
}

const n = (x: number) => Math.round(x).toLocaleString("en-US");
const avg = (x: number) => (x >= 100 ? n(x) : x.toLocaleString("en-US", { maximumFractionDigits: 2 }));

export async function buildQuotes(data: MarketData, input: { side: unknown; asset: unknown; qtys: string | null; slippageBps?: unknown; split?: unknown }) {
  const sizes = parseSizes(input.qtys);
  // One reading of the markets for every size, and no on-chain re-check (that is for the one size chosen: GET /v1/quote).
  let snapshot: Promise<Venue[] | null> | undefined;
  const lean: MarketData = {
    assets: () => data.assets(),
    venues: (a) => (snapshot ??= data.venues(a)),
    ...(data.assetInfo ? { assetInfo: (a: string) => data.assetInfo!(a) } : {}),
  };
  const quotes = [];
  for (const qty of sizes) quotes.push(await buildQuote(lean, { side: input.side, asset: input.asset, qty: String(qty), slippageBps: input.slippageBps, split: input.split }));

  const first = quotes[0];
  const base = first.fillable ? first.averagePriceQu : null;
  const rows = quotes.map((q) => ({
    qty: q.qty,
    fillable: q.fillable,
    filledQty: q.filledQty,
    totalQu: q.totalQu,
    averagePriceQu: q.averagePriceQu,
    // How the average price compares with the smallest size's: negative when selling means less per unit, positive when buying means more per unit.
    averageVsSmallestPct: base !== null && base > 0 && q.fillable && q.averagePriceQu !== null && q !== first ? Math.round(((q.averagePriceQu - base) / base) * 10_000) / 100 : null,
    route: q.route.map((r) => ({ venue: r.venue, qty: r.qty, totalQu: r.totalQu })),
    summary: q.summary,
  }));
  const buy = first.side === "buy";
  const asset = first.asset;
  const lines = rows.map((r) =>
    r.fillable
      ? `${n(r.qty)}: ${buy ? "cost" : "return"} about ${n(r.totalQu)} QU (${r.averagePriceQu !== null ? avg(r.averagePriceQu) : "?"} each${r.averageVsSmallestPct !== null ? `, ${r.averageVsSmallestPct > 0 ? "+" : ""}${r.averageVsSmallestPct}% against the smallest size` : ""})`
      : `${n(r.qty)}: cannot be filled in full right now`,
  );
  return {
    asset,
    side: first.side,
    slippageBps: first.slippageBps,
    summary: `${buy ? "Buying" : "Selling"} ${asset} at ${rows.length} sizes, priced together from one reading of QX and QSwap. ${lines.join("; ")}.`,
    quotes: rows,
    quotedAt: first.quotedAt,
    note: "All sizes are priced from the same snapshot, so they compare with each other. A quote is a snapshot: prices move. Use GET /v1/quote for the size you choose, with its signing limits.",
  };
}

export function quotesRoutes(data: MarketData): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/quotes",
      doc: {
        summary: "Quote several sizes of an order at once",
        description:
          "Prices up to 10 sizes of the same buy or sell from one reading of QX and QSwap, so a bot can see how the average price changes with size and pick a good piece, without one call per size. Each quote has the total, the average, where the order goes and a plain-language summary; averageVsSmallestPct says how much worse (or dearer) a size is than the smallest. Free. For the signing limits of the size you choose, ask GET /v1/quote.",
        parameters: [
          { name: "side", in: "query", required: true, schema: { type: "string", enum: ["buy", "sell"] } },
          { name: "asset", in: "query", required: true, schema: { type: "string" }, description: "Asset symbol, e.g. QDOGE" },
          { name: "qtys", in: "query", required: true, schema: { type: "string" }, description: "Whole numbers separated by commas, at most 10, e.g. 1000000,10000000,50000000" },
          { name: "slippageBps", in: "query", schema: { type: "integer", minimum: 0, maximum: 1000, default: 100 } },
        ],
        responses: { "200": { description: "A quote for each size, with a summary" }, "400": { description: "Invalid input" }, "404": { description: "Unknown asset" } },
      },
      handler: ({ query }) => buildQuotes(data, { side: query.get("side"), asset: query.get("asset"), qtys: query.get("qtys"), slippageBps: query.get("slippageBps") ?? undefined }),
    },
  ];
}
