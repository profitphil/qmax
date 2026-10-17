import type { MarketData } from "./data.ts";
import { buildQuotes } from "./quotesroute.ts";

/**
 * A page for every asset QMax lists, from one template (GET /token/<id>), and a page that lists them (GET /token/). The numbers on a page are the ones the API serves: the same price,
 * volume and depth, and what a sale or purchase of three sizes would really fetch, priced by the router. They are plain HTML with no script, so a search engine or an assistant reads them as they are.
 *
 * Only an asset that traded in the last seven days is offered to search engines (the page has `index`, and the sitemap lists it); the rest still have a page for people, marked `noindex`, so
 * a long tail of idle tokens does not fill the index with thin pages. An asset moves in or out of the sitemap by itself as trading starts and stops.
 */

export interface ListedAsset {
  id: string;
  symbol: string;
  issuer: string;
  category: "contract" | "token";
  venues: ("QX" | "QSwap")[];
  priceQu: number | null;
  liquidityQu: number;
  bestAsk?: number | null;
  bestBid?: number | null;
  askQty?: number | null;
  bidQty?: number | null;
  poolQu?: number | null;
  poolAsset?: number | null;
  volume24hQu?: number;
  volume7dQu?: number;
  trades24h?: number;
  change24hPct?: number | null;
  change7dPct?: number | null;
  lastTradeAt?: number;
}

export interface Page {
  status: number;
  type: string;
  body: string;
  /** How long a shared cache may keep it (seconds). */
  cacheSeconds?: number;
  /** For a redirect. */
  location?: string;
  retryAfterSec?: number;
}

export interface PageContext {
  /** The asset list as the API serves it, with each asset's volumes and price; `ready` is false while the first scan of the network is still running. */
  listing(): { ready: boolean; assets: ListedAsset[] };
}

export type PageHandler = (pathname: string, ctx: PageContext) => Promise<Page | null>;

export const SITE = "https://qmax.exchange";
const API = `${SITE}/api`;
/** How long an asset must be quiet before its page is no longer offered to search engines. */
export const INDEX_WINDOW_DAYS = 7;
/** What a sale or a purchase is priced at: sizes worth about this many QU at the current price. */
export const NOTIONALS_QU = [10_000_000, 100_000_000, 1_000_000_000];
const QUOTE_TTL_MS = 10 * 60_000;
const QUOTE_FAIL_TTL_MS = 2 * 60_000;

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const compact = (x: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: x >= 1e9 ? 2 : 1 }).format(x);
const qu = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : x >= 1000 ? n(x) : n(x, x >= 10 ? 1 : 3));
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(Math.abs(x) < 10 ? 1 : 0)}%`);
const usd = (x: number) => `$${x >= 1 ? n(x, 2) : x >= 0.01 ? x.toFixed(3) : Number(x.toPrecision(2)).toString()}`;

/** Whether search engines are offered this asset's page: it traded in the last seven days. */
export const isIndexable = (a: ListedAsset) => (a.volume7dQu ?? 0) > 0;

/** The name the page uses: the symbol, or the id when two issuers share a symbol (so the two pages are told apart). */
const nameOf = (a: ListedAsset) => (a.id.toUpperCase() === a.symbol.toUpperCase() ? a.symbol : a.id);
const pathOf = (a: ListedAsset) => `/token/${encodeURIComponent(a.id)}`;

const CSS = `
  :root { color-scheme: dark; --bg: #070a0f; --panel: #0e141c; --line: #1c2633; --fg: #e6ebf2; --muted: #93a1b4; --accent: #78aae6; --up: #4ade80; --down: #f87171; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 28px 16px 64px; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 32px 0 8px; padding-top: 10px; border-top: 1px solid var(--line); }
  p, li, td, th { color: var(--muted); }
  p strong, li strong, b, td b { color: var(--fg); }
  a { color: var(--accent); }
  nav a { margin-right: 14px; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; color: var(--fg); overflow-wrap: anywhere; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 8px 0; }
  td, th { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--fg); font-weight: 600; }
  td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
  .up { color: var(--up); } .down { color: var(--down); }
  .note { font-size: 13px; }
  .cta { display: inline-block; margin: 6px 10px 0 0; padding: 9px 16px; border-radius: 4px; background: var(--accent); color: #07101c; font-weight: 600; text-decoration: none; }
  .cta.sell { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  .wrap { overflow-x: auto; }
`;

function shell(o: { title: string; description: string; path: string; robots: string; body: string; jsonld?: unknown; updated?: string }): string {
  const url = SITE + o.path;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(o.title)}</title>
    <meta name="description" content="${esc(o.description)}" />
    <meta name="robots" content="${o.robots}" />
    <link rel="canonical" href="${esc(url)}" />
    <meta name="theme-color" content="#070a0f" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="QMax" />
    <meta property="og:url" content="${esc(url)}" />
    <meta property="og:title" content="${esc(o.title)}" />
    <meta property="og:description" content="${esc(o.description)}" />
    <meta property="og:image" content="${SITE}/brand/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
    <link rel="alternate" type="text/plain" href="/llms.txt" title="QMax for AI agents (llms.txt)" />${o.jsonld ? `\n    <script type="application/ld+json">${JSON.stringify(o.jsonld).replace(/</g, "\\u003c")}</script>` : ""}
    <style>${CSS}</style>
  </head>
  <body>
    <main>
      <nav aria-label="Site"><a href="/">QMax</a><a href="/token/">All tokens</a><a href="/qubic-dex/">How trading works</a><a href="/agents/">For AI agents</a></nav>
${o.body}
    </main>
  </body>
</html>
`;
}

const crumbs = (name?: string) => ({
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "QMax", item: `${SITE}/` },
    { "@type": "ListItem", position: 2, name: "Qubic tokens", item: `${SITE}/token/` },
    ...(name ? [{ "@type": "ListItem", position: 3, name }] : []),
  ],
});

/** What a sale and a purchase of a few sizes would fetch and cost, priced together from one reading of the markets; null when it cannot be priced. */
type Tables = { sell: Awaited<ReturnType<typeof buildQuotes>>; buy: Awaited<ReturnType<typeof buildQuotes>> } | null;

export function tokenPages(deps: { data: MarketData; usdPerQu: () => Promise<number | null>; now?: () => number }): PageHandler {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; ttl: number; value: Promise<Tables> }>();

  /** The sizes for an asset: about 10 million, 100 million and 1 billion QU worth at its price, as whole units, smallest first. */
  const sizesFor = (a: ListedAsset): number[] => {
    if (!a.priceQu || !(a.priceQu > 0)) return [];
    return [...new Set(NOTIONALS_QU.map((v) => Math.floor(v / a.priceQu!)).filter((q) => q >= 1))].sort((x, y) => x - y);
  };

  // Pricing sizes reads the markets, so it is done once for ten minutes per asset (and once at a time for the same asset): a crawler walking every page cannot make the API read the node for each visit.
  const tablesFor = (a: ListedAsset): Promise<Tables> => {
    const sizes = sizesFor(a);
    if (!sizes.length || (a.liquidityQu ?? 0) <= 0) return Promise.resolve(null);
    const key = a.id.toUpperCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    const qtys = sizes.join(",");
    const value = (async (): Promise<Tables> => {
      // one reading of the markets for both the sale and the purchase
      let snapshot: ReturnType<MarketData["venues"]> | undefined;
      const once: MarketData = { assets: () => deps.data.assets(), venues: (id) => (snapshot ??= deps.data.venues(id)), ...(deps.data.assetInfo ? { assetInfo: (id: string) => deps.data.assetInfo!(id) } : {}) };
      const sell = await buildQuotes(once, { side: "sell", asset: a.id, qtys });
      const buy = await buildQuotes(once, { side: "buy", asset: a.id, qtys });
      return { sell, buy };
    })().catch(() => null);
    const entry = { at: now(), ttl: QUOTE_TTL_MS, value };
    cache.set(key, entry);
    void value.then((v) => {
      if (!v) entry.ttl = QUOTE_FAIL_TTL_MS;
    });
    return value;
  };

  const sizeTable = (kind: "sell" | "buy", t: NonNullable<Tables>["sell"], price: number | null) => {
    const sell = kind === "sell";
    const rows = t.quotes
      .map((q) => {
        if (!q.fillable) return `<tr><td>${n(q.qty)}</td><td class="r">${price ? compact(q.qty * price) : "–"}</td><td colspan="4">cannot be ${sell ? "sold" : "bought"} in full right now</td></tr>`;
        const split = q.route.map((r) => `${esc(r.venue)} ${n((r.qty / q.qty) * 100, 0)}%`).join(" · ");
        return `<tr><td>${n(q.qty)}</td><td class="r">${price ? compact(q.qty * price) : "–"}</td><td class="r"><b>${n(q.totalQu)}</b></td><td class="r">${qu(q.averagePriceQu)}</td><td class="r">${q.averageVsSmallestPct === null ? "–" : pct(q.averageVsSmallestPct)}</td><td>${split}</td></tr>`;
      })
      .join("\n          ");
    return `<div class="wrap"><table>
        <tr><th>Units</th><th class="r">Worth at the last price (QU)</th><th class="r">${sell ? "You receive (QU)" : "You pay (QU)"}</th><th class="r">Average (QU each)</th><th class="r">Against the smallest size</th><th>Where it goes</th></tr>
          ${rows}
      </table></div>`;
  };

  const assetPage = async (a: ListedAsset): Promise<Page> => {
    const name = nameOf(a);
    const rate = await deps.usdPerQu().catch(() => null);
    const price = a.priceQu;
    const both = a.venues.includes("QX") && a.venues.includes("QSwap");
    const marketText = both ? "QX (the order book) and QSwap (a liquidity pool)" : a.venues.includes("QSwap") ? "QSwap (a liquidity pool)" : "QX (the order book)";
    const kind = a.category === "contract" ? "smart-contract share" : "token";
    const spread = a.bestBid && a.bestAsk && a.bestBid > 0 ? ((a.bestAsk - a.bestBid) / ((a.bestAsk + a.bestBid) / 2)) * 100 : null;
    const tables = await tablesFor(a);
    const active = isIndexable(a);
    const last = a.lastTradeAt ? new Date(a.lastTradeAt).toISOString().slice(0, 10) : null;

    const intro =
      price !== null
        ? `${esc(name)} is a ${kind} on Qubic that trades on ${marketText}. It last traded at about <strong>${qu(price)} QU</strong>${rate ? ` (about ${usd(price * rate)})` : ""}, ${pct(a.change24hPct)} over 24 hours and ${pct(a.change7dPct)} over 7 days${a.volume24hQu ? `, with ${compact(a.volume24hQu)} QU traded in the last 24 hours` : active ? "" : ", and nothing traded this week"}.`
        : `${esc(name)} is a ${kind} on Qubic that trades on ${marketText}. It has no price right now.`;

    const figures = [
      ["Last price", price !== null ? `${qu(price)} QU${rate ? ` (about ${usd(price * rate)})` : ""}` : "–"],
      ["Change, 24 hours / 7 days", `${pct(a.change24hPct)} / ${pct(a.change7dPct)}`],
      ["Volume, 24 hours / 7 days", `${a.volume24hQu !== undefined ? n(a.volume24hQu) : "–"} / ${a.volume7dQu !== undefined ? n(a.volume7dQu) : "–"} QU`],
      ["Trades in 24 hours", a.trades24h !== undefined ? n(a.trades24h) : "–"],
      ...(a.venues.includes("QX") ? [["QX best bid / best ask", `${qu(a.bestBid)} / ${qu(a.bestAsk)} QU${spread !== null ? ` (spread ${spread.toFixed(1)}%)` : ""}`], ["QX size at the best bid / ask", `${a.bidQty != null ? n(a.bidQty) : "–"} / ${a.askQty != null ? n(a.askQty) : "–"} units`]] : []),
      ...(a.venues.includes("QSwap") && a.poolQu ? [["QSwap pool", `${n(a.poolQu)} QU and ${a.poolAsset != null ? n(a.poolAsset) : "–"} units${a.poolAsset ? `, pool price ${qu(a.poolQu / a.poolAsset)} QU` : ""}`]] : []),
      ["Listed as", `${kind}, issued by ${a.issuer ? a.issuer.slice(0, 5) + "…" + a.issuer.slice(-5) : "–"}`],
    ];

    const midQty = tables ? tables.sell.quotes[Math.min(1, tables.sell.quotes.length - 1)]?.qty : null;
    const feeText = both
      ? `QX takes 0.3% of each match, from the seller's QU. QSwap takes 0.3% of a swap plus a flat 100,000 QU per swap, which makes small trades dearer there. QMax adds no fee of its own. The router compares both before you sign.`
      : `QX takes 0.3% of each match, from the seller's QU, with no flat fee on an order. QMax adds no fee of its own.`;

    const body = `      <h1>${esc(name)} on Qubic: price, order book and best route</h1>
      <p class="lead">${intro}</p>
      <p><a class="cta" href="/?asset=${encodeURIComponent(a.id)}&amp;side=buy">Buy ${esc(name)} on QMax</a><a class="cta sell" href="/?asset=${encodeURIComponent(a.id)}&amp;side=sell">Sell ${esc(name)}</a></p>

      <h2>${esc(name)} market figures</h2>
      <div class="wrap"><table>
        ${figures.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("\n        ")}
      </table></div>
      <p class="note">${last ? `Last trade ${esc(last)}. ` : ""}Prices come from real trades on QX, kept inside today's order book${a.venues.includes("QSwap") && a.poolQu ? "; the QSwap pool price is shown beside them" : ""}. Live on the <a href="/?asset=${encodeURIComponent(a.id)}">QMax trading screen</a>, which also has the chart and the full order book.</p>

${
  tables
    ? `      <h2>What selling ${esc(name)} would fetch</h2>
      <p>Priced by QMax's router across QX and QSwap, splitting each order where that pays more. Bigger sizes move the price, so the average falls as the size grows.</p>
      ${sizeTable("sell", tables.sell, price)}
      <h2>What buying ${esc(name)} would cost</h2>
      ${sizeTable("buy", tables.buy, price)}
      <p class="note">These are snapshots from ${esc(new Date(now()).toISOString().slice(0, 16).replace("T", " "))} UTC and prices move: ask again before you trade. Any other size: <a href="${API}/v1/quote?side=sell&amp;asset=${encodeURIComponent(a.id)}&amp;qty=${midQty ?? 1}"><code>/api/v1/quote?side=sell&amp;asset=${esc(a.id)}&amp;qty=${midQty ?? 1}</code></a> (free, no key), or several sizes at once with <a href="${API}/v1/quotes?side=sell&amp;asset=${encodeURIComponent(a.id)}&amp;qtys=${tables.sell.quotes.map((q) => q.qty).join(",")}"><code>/api/v1/quotes</code></a>.</p>`
    : `      <h2>Prices for larger sizes</h2>
      <p>${esc(name)} has no market deep enough to price a sale or a purchase right now. The figures above are what its order book and pool show. Check the <a href="/?asset=${encodeURIComponent(a.id)}">trading screen</a> for the latest.</p>`
}

      <h2>Fees when trading ${esc(name)}</h2>
      <p>${feeText} For how the two markets differ, see <a href="/qubic-dex/">how trading on Qubic works</a>.</p>

      <h2>For software and AI assistants</h2>
      <p>Everything on this page is available as JSON from the free <a href="${API}/v1/openapi.json">QMax API</a>, and through the hosted MCP server at <code>${API}/mcp</code> (tool <code>qmax_get_quote</code>). The guide for assistants is <a href="/llms.txt">/llms.txt</a>.</p>`;

    const jsonld = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": `${SITE}${pathOf(a)}#page`,
          name: `${name} price on Qubic`,
          url: `${SITE}${pathOf(a)}`,
          inLanguage: "en",
          dateModified: new Date(now()).toISOString(),
          isPartOf: { "@id": `${SITE}/#site` },
          about: { "@type": "Thing", name: `${name} (${kind} on Qubic)` },
          breadcrumb: crumbs(name),
        },
      ],
    };
    return {
      status: 200,
      type: "text/html; charset=utf-8",
      cacheSeconds: 300,
      body: shell({
        title: `${name} price on Qubic: buy, sell and order book | QMax`,
        description: `Live price, ${both ? "QX order book and QSwap pool" : a.venues.includes("QSwap") ? "QSwap pool" : "QX order book"} for ${name} on Qubic, what selling or buying a given amount would fetch, and how to trade it at the best price with QMax.`,
        path: pathOf(a),
        robots: active ? "index, follow, max-image-preview:large" : "noindex, follow",
        body,
        jsonld,
      }),
    };
  };

  const hubPage = (assets: ListedAsset[]): Page => {
    const sorted = [...assets].sort((a, b) => (b.volume24hQu ?? 0) - (a.volume24hQu ?? 0) || (b.volume7dQu ?? 0) - (a.volume7dQu ?? 0) || (b.liquidityQu ?? 0) - (a.liquidityQu ?? 0));
    const activeList = sorted.filter(isIndexable);
    const idle = sorted.filter((a) => !isIndexable(a));
    const row = (a: ListedAsset) =>
      `<tr><td><a href="${pathOf(a)}"><b>${esc(nameOf(a))}</b></a></td><td>${a.category === "contract" ? "Share" : "Token"}</td><td class="r">${qu(a.priceQu)}</td><td class="r ${(a.change24hPct ?? 0) > 0 ? "up" : (a.change24hPct ?? 0) < 0 ? "down" : ""}">${pct(a.change24hPct)}</td><td class="r">${a.volume24hQu ? compact(a.volume24hQu) : "–"}</td><td class="r">${a.volume7dQu ? compact(a.volume7dQu) : "–"}</td><td>${a.venues.join(" + ")}</td></tr>`;
    const body = `      <h1>Qubic tokens and smart-contract shares: live prices</h1>
      <p class="lead">${activeList.length} assets traded on QX or QSwap in the last seven days, busiest first. Each page has the live price, the order book and pool, and what selling or buying a few sizes would fetch, priced by QMax across both markets.</p>
      <div class="wrap"><table>
        <tr><th>Asset</th><th>Type</th><th class="r">Price (QU)</th><th class="r">24h</th><th class="r">Volume 24h (QU)</th><th class="r">Volume 7d (QU)</th><th>Markets</th></tr>
        ${activeList.map(row).join("\n        ")}
      </table></div>
${
  idle.length
    ? `      <h2>No trades this week</h2>
      <p>${idle.length} more are listed on QMax but have not traded in the last seven days, so their prices are only what the order book or pool shows.</p>
      <details><summary>Show them</summary><p>${idle.map((a) => `<a href="${pathOf(a)}">${esc(nameOf(a))}</a>`).join(" · ")}</p></details>`
    : ""
}
      <p class="note">New to trading on Qubic? Read <a href="/qubic-dex/">how QX, QSwap and QMax work</a>.</p>`;
    return {
      status: 200,
      type: "text/html; charset=utf-8",
      cacheSeconds: 300,
      body: shell({
        title: "Qubic tokens and shares: live prices on QX and QSwap | QMax",
        description: `Live prices and volume for ${activeList.length} Qubic tokens and smart-contract shares traded on QX and QSwap, with what selling or buying each would fetch.`,
        path: "/token/",
        robots: "index, follow, max-image-preview:large",
        body,
        jsonld: { "@context": "https://schema.org", "@graph": [{ "@type": "CollectionPage", "@id": `${SITE}/token/#page`, name: "Qubic tokens and smart-contract shares", url: `${SITE}/token/`, isPartOf: { "@id": `${SITE}/#site` }, breadcrumb: crumbs() }] },
      }),
    };
  };

  const sitemap = (assets: ListedAsset[]): Page => {
    const today = new Date(now()).toISOString().slice(0, 10);
    const urls = [
      { loc: `${SITE}/token/`, lastmod: today, priority: "0.8" },
      ...assets.filter(isIndexable).map((a) => ({ loc: `${SITE}${pathOf(a)}`, lastmod: a.lastTradeAt ? new Date(a.lastTradeAt).toISOString().slice(0, 10) : today, priority: "0.6" })),
    ];
    return {
      status: 200,
      type: "application/xml; charset=utf-8",
      cacheSeconds: 600,
      body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><changefreq>daily</changefreq><priority>${u.priority}</priority></url>`).join("\n")}\n</urlset>\n`,
    };
  };

  const notFound = (): Page => ({
    status: 404,
    type: "text/html; charset=utf-8",
    body: shell({ title: "Not a listed asset | QMax", description: "This asset is not listed on QMax. See every Qubic token and share with a live price.", path: "/token/", robots: "noindex, follow", body: `      <h1>That asset is not listed</h1>\n      <p>QMax lists the tokens and smart-contract shares that trade on QX or QSwap. <a href="/token/">See all of them</a>.</p>` }),
  });

  return async (pathname, ctx) => {
    if (pathname === "/token") return { status: 301, type: "text/plain; charset=utf-8", body: "", location: "/token/" };
    const isAsset = pathname.startsWith("/token/") && pathname.length > "/token/".length;
    if (pathname !== "/token/" && pathname !== "/sitemap-tokens.xml" && !isAsset) return null;
    const { ready, assets } = ctx.listing();
    // While the first scan of the network is running the list is partial: a crawler is told to come back, never that a page does not exist.
    if (!ready) return { status: 503, type: "text/plain; charset=utf-8", body: "QMax is still reading the Qubic network. Try again in a few minutes.\n", retryAfterSec: 120 };
    if (pathname === "/sitemap-tokens.xml") return sitemap(assets);
    if (pathname === "/token/") return hubPage(assets);
    let id: string;
    try {
      id = decodeURIComponent(pathname.slice("/token/".length)).replace(/\/+$/, "");
    } catch {
      return notFound();
    }
    const found = assets.find((a) => a.id.toUpperCase() === id.toUpperCase());
    if (!found) return notFound();
    // One address per asset: another spelling (case, a trailing slash) goes to it.
    if (pathname !== pathOf(found)) return { status: 301, type: "text/plain; charset=utf-8", body: "", location: pathOf(found) };
    return assetPage(found);
  };
}
