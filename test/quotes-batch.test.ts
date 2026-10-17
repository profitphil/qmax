import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { buildQuote } from "../src/quoteapi.ts";
import { MAX_SIZES, buildQuotes, parseSizes, quotesRoutes } from "../src/quotesroute.ts";
import { llmsText } from "../src/llms.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";

const bids: [number, number][] = [[100, 50], [95, 100], [90, 200]];
const qx = () => new QxVenue({ asks: [{ price: 110, qty: 50 }], bids: bids.map(([price, qty]) => ({ price, qty })), buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 0 });
const pool = () => new QswapVenue({ reserveQu: 1_000_000, reserveAsset: 10_000, swapFeeRate: 30, fixedCostQu: 100_100 });

function market() {
  const calls = { venues: 0 };
  const data: MarketData = {
    assets: () => ["CFB"],
    venues: async (a) => {
      calls.venues++;
      return a.toUpperCase() === "CFB" ? [qx(), pool()] : null;
    },
  };
  return { data, calls };
}

test("the sizes asked for are whole numbers, each once, smallest first, and no more than ten", () => {
  assert.deepEqual(parseSizes("50000000, 1000000,10000000,1000000"), [1_000_000, 10_000_000, 50_000_000]);
  for (const bad of [null, "", " , ", "1000,abc", "0", "-5", "1.5", "1e6", Array.from({ length: MAX_SIZES + 1 }, (_, i) => i + 1).join(",")]) assert.throws(() => parseSizes(bad), /qtys|every size/, String(bad));
  assert.equal(parseSizes(Array.from({ length: MAX_SIZES }, (_, i) => i + 1).join(",")).length, MAX_SIZES);
});

test("each size is priced as it would be alone, from one reading of the markets", async () => {
  const { data, calls } = market();
  const r = await buildQuotes(data, { side: "sell", asset: "CFB", qtys: "300,10,100" });
  assert.deepEqual(r.quotes.map((q) => q.qty), [10, 100, 300], "smallest first");
  assert.equal(calls.venues, 1, "the markets are read once for all the sizes");
  for (const q of r.quotes) {
    const alone = await buildQuote(market().data, { side: "sell", asset: "CFB", qty: String(q.qty) });
    assert.equal(q.totalQu, alone.totalQu, `${q.qty}: the same total as asking alone`);
    assert.deepEqual(q.route.map((l) => [l.venue, l.qty]), alone.route.map((l) => [l.venue, l.qty]));
    assert.equal(q.summary, alone.summary);
  }
});

test("it says how much worse each bigger size is than the smallest, and which cannot be filled", async () => {
  const { data } = market();
  const sell = await buildQuotes(data, { side: "sell", asset: "CFB", qtys: "10,100,300" });
  assert.equal(sell.quotes[0].averageVsSmallestPct, null, "the smallest is the baseline");
  assert.ok(sell.quotes[1].averageVsSmallestPct! < 0, "selling more means less per unit");
  assert.ok(sell.quotes[2].averageVsSmallestPct! < sell.quotes[1].averageVsSmallestPct!, "and still less for more");
  assert.match(sell.summary, /^Selling CFB at 3 sizes, priced together from one reading of QX and QSwap\. 10: return about [\d,]+ QU \(/);
  assert.match(sell.summary, /% against the smallest size\)\.$/);

  const buy = await buildQuotes(data, { side: "buy", asset: "CFB", qtys: "10,20,20000" });
  assert.ok(buy.quotes[1].averageVsSmallestPct! >= 0, "buying more never costs less per unit");
  assert.equal(buy.quotes[2].fillable, false, "more than the book and the pool hold");
  assert.equal(buy.quotes[2].averageVsSmallestPct, null);
  assert.match(buy.summary, /^Buying CFB at 3 sizes/);
  assert.match(buy.summary, /20,000: cannot be filled in full right now\.$/);
});

test("an unknown asset or a bad side is refused like a single quote is", async () => {
  const { data } = market();
  await assert.rejects(buildQuotes(data, { side: "sell", asset: "NOPE", qtys: "10" }), /Unknown asset/);
  await assert.rejects(buildQuotes(data, { side: "hold", asset: "CFB", qtys: "10" }), /side must be/);
});

const served = market().data;
const server = createApi({ data: served, routes: quotesRoutes(served), freeAccess: true });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("GET /v1/quotes answers over HTTP, and refuses what it cannot read", async () => {
  const ok = await fetch(`${base}/v1/quotes?side=sell&asset=CFB&qtys=10,100`);
  assert.equal(ok.status, 200);
  const j = (await ok.json()) as { quotes: { qty: number; summary: string }[]; summary: string };
  assert.deepEqual(j.quotes.map((q) => q.qty), [10, 100]);
  assert.match(j.summary, /^Selling CFB at 2 sizes/);
  const noSizes = await fetch(`${base}/v1/quotes?side=sell&asset=CFB`);
  assert.equal(noSizes.status, 400);
  assert.match(((await noSizes.json()) as { error: string }).error, /qtys is required/);
  assert.equal((await fetch(`${base}/v1/quotes?side=sell&asset=NOPE&qtys=10`)).status, 404);
});

test("llms.txt offers the several-sizes call only where quotes are free", () => {
  assert.match(llmsText({}), /\/v1\/quotes\?side=sell&asset=QDOGE&qtys=1000000,10000000,50000000/);
  assert.doesNotMatch(llmsText({ API_ACCESS: "billing" }), /\/v1\/quotes/);
  assert.doesNotMatch(llmsText({ API_ACCESS: "private" }), /\/v1\/quotes/);
});
