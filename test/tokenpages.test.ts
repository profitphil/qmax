import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { INDEX_WINDOW_DAYS, isIndexable, tokenPages } from "../src/tokenpages.ts";
import type { ListedAsset, PageContext } from "../src/tokenpages.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";

const ISSUER = "Q".repeat(60);
const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 20, 12, 0, 0);

const asset = (over: Partial<ListedAsset> & { id: string }): ListedAsset => ({
  symbol: over.id.split(".")[0],
  issuer: ISSUER,
  category: "token",
  venues: ["QX", "QSwap"],
  priceQu: 100,
  liquidityQu: 5_000_000_000,
  bestBid: 99,
  bestAsk: 101,
  bidQty: 5_000_000,
  askQty: 2_000_000,
  poolQu: 1_000_000_000,
  poolAsset: 10_000_000,
  volume24hQu: 3_000_000_000,
  volume7dQu: 9_000_000_000,
  trades24h: 40,
  change24hPct: 2.5,
  change7dPct: -4,
  lastTradeAt: T - 3_600_000,
  ...over,
});
const DOGE = asset({ id: "QDOGE" });
const IDLE = asset({ id: "SLEEPY", volume24hQu: 0, volume7dQu: 0, trades24h: 0, change24hPct: null, change7dPct: null, lastTradeAt: T - 30 * DAY });
const SHARE = asset({ id: "QUTIL", category: "contract", venues: ["QX"], volume24hQu: 10, volume7dQu: 500, poolQu: null, poolAsset: null });
const TWIN1 = asset({ id: "TWIN", issuer: "A".repeat(60), volume7dQu: 1 });
const TWIN2 = asset({ id: "TWIN.BBBBB", symbol: "TWIN", issuer: "B".repeat(60), volume7dQu: 2 });
const ALL = [DOGE, IDLE, SHARE, TWIN1, TWIN2];

function market() {
  const calls = { venues: 0 };
  const data: MarketData = {
    assets: () => ALL.map((a) => a.id),
    venues: async (id) => {
      calls.venues++;
      if (!ALL.some((a) => a.id.toUpperCase() === id.toUpperCase())) return null;
      return [
        new QxVenue({ asks: [{ price: 101, qty: 2_000_000 }], bids: [{ price: 100, qty: 5_000_000 }], buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 0 }),
        new QswapVenue({ reserveQu: 1_000_000_000, reserveAsset: 10_000_000, swapFeeRate: 30, fixedCostQu: 100_100 }),
      ];
    },
  };
  return { data, calls };
}
const ctx = (assets: ListedAsset[], ready = true): PageContext => ({ listing: () => ({ ready, assets }) });
const handler = (o: { rate?: number | null; clock?: { t: number }; calls?: boolean } = {}) => {
  const m = market();
  const clock = o.clock ?? { t: T };
  return { h: tokenPages({ data: m.data, usdPerQu: async () => (o.rate === undefined ? 0.00000055 : o.rate), now: () => clock.t }), ...m, clock };
};
const html = (p: { body: string } | null) => p!.body;
const one = (s: string, re: RegExp) => s.match(re)?.[1];

test("an asset is offered to search engines only if it traded in the last seven days", () => {
  assert.equal(INDEX_WINDOW_DAYS, 7);
  assert.equal(isIndexable(DOGE), true);
  assert.equal(isIndexable(IDLE), false);
  assert.equal(isIndexable({ ...IDLE, volume7dQu: undefined }), false);
  assert.equal(isIndexable(SHARE), true, "a smart-contract share is judged by the same rule");
});

test("an active token's page: one heading, its own address, index, the live figures and priced sizes", async () => {
  const { h } = handler();
  const p = (await h("/token/QDOGE", ctx(ALL)))!;
  assert.equal(p.status, 200);
  assert.match(p.type, /^text\/html/);
  const b = html(p);
  assert.equal((b.match(/<h1[ >]/g) ?? []).length, 1);
  assert.equal(one(b, /<h1>([^<]+)<\/h1>/), "QDOGE on Qubic: price, order book and best route");
  assert.equal(one(b, /<link rel="canonical" href="([^"]+)"/), "https://qmax.exchange/token/QDOGE");
  assert.match(b, /<meta name="robots" content="index, follow/);
  assert.match(one(b, /<title>([^<]+)<\/title>/)!, /^QDOGE price on Qubic: buy, sell and order book \| QMax$/);
  const description = one(b, /<meta name="description" content="([^"]+)"/)!;
  assert.ok(description.length >= 70 && description.length <= 175, `${description.length} characters`);
  // the figures are the listing's
  assert.match(b, /last traded at about <strong>100 QU<\/strong> \(about \$0\.000055\), \+2\.5% over 24 hours and −4\.0% over 7 days, with 3B QU traded in the last 24 hours/);
  assert.match(b, /QX and QSwap/);
  assert.match(b, /99 \/ 101 QU \(spread 2\.0%\)/);
  assert.match(b, /pool price 100 QU/);
  // sizes worth about 10M, 100M and 1B QU at 100 QU each: 100,000; 1,000,000; 10,000,000 units
  for (const qty of ["100,000", "1,000,000", "10,000,000"]) assert.ok(b.includes(`<td>${qty}</td>`), qty);
  assert.match(b, /What selling QDOGE would fetch/);
  assert.match(b, /What buying QDOGE would cost/);
  assert.match(b, /href="\/\?asset=QDOGE&amp;side=sell"/);
  assert.match(b, /\/api\/v1\/quote\?side=sell&amp;asset=QDOGE&amp;qty=1000000/);
  assert.match(b, /QSwap takes 0\.3% of a swap plus a flat 100,000 QU per swap/);
  // structured data is valid and says what the page is
  const ld = JSON.parse(one(b, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/)!);
  assert.equal(ld["@graph"][0]["@type"], "WebPage");
  assert.equal(ld["@graph"][0].breadcrumb.itemListElement.length, 3);
});

test("an idle token still has a page for people, but search engines are told to leave it out", async () => {
  const { h } = handler();
  const b = html(await h("/token/SLEEPY", ctx(ALL)));
  assert.match(b, /<meta name="robots" content="noindex, follow" \/>/);
  assert.match(b, /nothing traded this week/);
});

test("a contract share, which trades on QX only, says so and leaves the QSwap fee out", async () => {
  const { h } = handler();
  const b = html(await h("/token/QUTIL", ctx(ALL)));
  assert.match(b, /smart-contract share on Qubic that trades on QX \(the order book\)\./);
  assert.doesNotMatch(b, /flat 100,000 QU per swap/);
  assert.doesNotMatch(b, /QSwap pool/);
});

test("two assets that share a symbol each get their own page, named by id", async () => {
  const { h } = handler();
  const a = html(await h("/token/TWIN", ctx(ALL)));
  const b = html(await h("/token/TWIN.BBBBB", ctx(ALL)));
  assert.equal(one(a, /<h1>([^<]+)<\/h1>/), "TWIN on Qubic: price, order book and best route");
  assert.equal(one(b, /<h1>([^<]+)<\/h1>/), "TWIN.BBBBB on Qubic: price, order book and best route");
  assert.equal(one(b, /<link rel="canonical" href="([^"]+)"/), "https://qmax.exchange/token/TWIN.BBBBB");
});

test("another spelling of an address goes to the one address; an unknown asset is a 404; a partial list is a 503", async () => {
  const { h } = handler();
  for (const p of ["/token/qdoge", "/token/QDOGE/", "/token/Qdoge/"]) {
    const r = (await h(p, ctx(ALL)))!;
    assert.deepEqual([r.status, r.location], [301, "/token/QDOGE"], p);
  }
  const hub = (await h("/token", ctx(ALL)))!;
  assert.deepEqual([hub.status, hub.location], [301, "/token/"]);
  const missing = (await h("/token/NOPE", ctx(ALL)))!;
  assert.equal(missing.status, 404);
  assert.match(missing.body, /noindex/);
  const scanning = (await h("/token/QDOGE", ctx([], false)))!;
  assert.deepEqual([scanning.status, scanning.retryAfterSec], [503, 120]);
  assert.equal((await h("/token/", ctx([], false)))!.status, 503, "the hub too: a crawler comes back instead of learning there is nothing");
  assert.equal((await h("/sitemap-tokens.xml", ctx([], false)))!.status, 503);
  assert.equal(await h("/somewhere-else", ctx(ALL)), null, "any other path is not its business");
});

test("the hub lists the active assets busiest first, and tucks the idle ones away", async () => {
  const { h } = handler();
  const b = html(await h("/token/", ctx(ALL)));
  assert.equal(one(b, /<link rel="canonical" href="([^"]+)"/), "https://qmax.exchange/token/");
  assert.match(b, /4 assets traded on QX or QSwap in the last seven days/);
  const order = [...b.matchAll(/<tr><td><a href="\/token\/([^"]+)"><b>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["QDOGE", "QUTIL", "TWIN.BBBBB", "TWIN"].sort((x, y) => order.indexOf(x) - order.indexOf(y)), "every active asset is in the table");
  assert.equal(order[0], "QDOGE", "the one with the most volume first");
  assert.ok(!order.includes("SLEEPY"));
  assert.match(b, /<details><summary>Show them<\/summary><p><a href="\/token\/SLEEPY">SLEEPY<\/a><\/p><\/details>/);
  assert.match(b, /<meta name="robots" content="index, follow/);
});

test("the sitemap lists the hub and only the assets that traded this week, dated by their last trade", async () => {
  const { h } = handler();
  const p = (await h("/sitemap-tokens.xml", ctx(ALL)))!;
  assert.match(p.type, /^application\/xml/);
  const locs = [...p.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs.sort(), ["https://qmax.exchange/token/", "https://qmax.exchange/token/QDOGE", "https://qmax.exchange/token/QUTIL", "https://qmax.exchange/token/TWIN", "https://qmax.exchange/token/TWIN.BBBBB"].sort());
  assert.ok(!p.body.includes("SLEEPY"));
  assert.match(p.body, /<loc>https:\/\/qmax\.exchange\/token\/QDOGE<\/loc><lastmod>2026-10-20<\/lastmod>/);
});

test("nothing from the listing can break out of the page", async () => {
  const evil = asset({ id: 'X"><script>alert(1)</script>', symbol: '<img src=x onerror=alert(1)>', issuer: '"><b>' });
  const { h } = handler();
  const hub = html(await h("/token/", ctx([evil])));
  assert.ok(!hub.includes("<script>alert") && !hub.includes("<img src=x"), "the hub");
  const page = (await h(`/token/${encodeURIComponent(evil.id)}`, ctx([evil])))!;
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes("<script>alert") && !page.body.includes("<img src=x") && !page.body.includes('"><b>'), "the page");
  const sitemap = (await h("/sitemap-tokens.xml", ctx([evil])))!.body;
  assert.ok(!sitemap.includes("<script>"));
});

test("pricing the sizes reads the markets once for ten minutes, however many visits", async () => {
  const { h, calls, clock } = handler();
  await h("/token/QDOGE", ctx(ALL));
  const first = calls.venues;
  assert.equal(first, 1, "one reading of the markets for the sale and the purchase together");
  for (let i = 0; i < 5; i++) await h("/token/QDOGE", ctx(ALL));
  assert.equal(calls.venues, first, "visits inside ten minutes use what was read");
  clock.t += 11 * 60_000;
  await h("/token/QDOGE", ctx(ALL));
  assert.equal(calls.venues, first + 1, "after ten minutes it reads again");
  await Promise.all([h("/token/QUTIL", ctx(ALL)), h("/token/QUTIL", ctx(ALL)), h("/token/QUTIL", ctx(ALL))]);
  assert.equal(calls.venues, first + 2, "visits at the same moment share one reading");
});

test("an asset that cannot be priced still has a page, and the page says so", async () => {
  const noMarket = asset({ id: "GHOST", liquidityQu: 0, priceQu: null });
  const { h } = handler({ rate: null });
  const p = (await h("/token/GHOST", ctx([noMarket])))!;
  assert.equal(p.status, 200);
  assert.match(p.body, /It has no price right now\./);
  assert.match(p.body, /Prices for larger sizes/);
  assert.doesNotMatch(p.body, /What selling GHOST would fetch/);
  const noUsd = html(await handler({ rate: null }).h("/token/QDOGE", ctx(ALL)));
  assert.doesNotMatch(noUsd, /about \$/, "no dollar figure when there is no rate");
});

const m2 = market();
const listed: MarketData = { ...m2.data, listAssets: () => ({ ready: true, assets: ALL as never }) };
const volumes = new Map(ALL.map((a) => [a.id.toUpperCase(), { volume24hQu: a.volume24hQu ?? 0, volume72hQu: 0, volume7dQu: a.volume7dQu ?? 0, trades24h: a.trades24h ?? 0, change24hPct: a.change24hPct ?? null, change72hPct: null, change7dPct: a.change7dPct ?? null }]));
const server = createApi({
  data: listed,
  trades: { volumes: () => volumes as never, lasts: () => new Map(), candles: (async () => ({ candles: [] })) as never },
  freeAccess: true,
  pages: tokenPages({ data: m2.data, usdPerQu: async () => null }),
});
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("over HTTP: the page is HTML with its own strict policy, the sitemap is XML, and an idle asset is noindex", async () => {
  const r = await fetch(`${base}/token/QDOGE`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(r.headers.get("cache-control") ?? "", /max-age=300/);
  assert.equal(r.headers.get("x-ratelimit-limit"), "120");
  const body = await r.text();
  assert.match(body, /<h1>QDOGE on Qubic/);
  assert.match(await (await fetch(`${base}/token/SLEEPY`)).text(), /noindex/);
  const sm = await fetch(`${base}/sitemap-tokens.xml`);
  assert.match(sm.headers.get("content-type") ?? "", /^application\/xml/);
  assert.match(await sm.text(), /<loc>https:\/\/qmax\.exchange\/token\/QDOGE<\/loc>/);
  const missing = await fetch(`${base}/token/NOPE`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type") ?? "", /^text\/html/);
  const moved = await fetch(`${base}/token/qdoge`, { redirect: "manual" });
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get("location"), "/token/QDOGE");
  const post = await fetch(`${base}/token/QDOGE`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.notEqual(post.headers.get("content-type")?.startsWith("text/html"), true, "only a GET is a page");
});

test("a HEAD request, which crawlers and link checkers send, gets the same status and headers as a GET, with no body", async () => {
  for (const path of ["/token/QDOGE", "/token/", "/sitemap-tokens.xml"]) {
    const head = await fetch(`${base}${path}`, { method: "HEAD" });
    const get = await fetch(`${base}${path}`);
    assert.equal(head.status, 200, path);
    assert.equal(head.headers.get("content-type"), get.headers.get("content-type"), path);
    assert.equal(head.headers.get("cache-control"), get.headers.get("cache-control"), path);
    assert.equal(await head.text(), "", `${path}: no body`);
  }
  assert.equal((await fetch(`${base}/token/NOPE`, { method: "HEAD" })).status, 404);
  const moved = await fetch(`${base}/token/qdoge`, { method: "HEAD", redirect: "manual" });
  assert.deepEqual([moved.status, moved.headers.get("location")], [301, "/token/QDOGE"]);
});
