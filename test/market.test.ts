import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import { buildBook } from "../src/book.ts";
import { compactNumber, depthChartSvg, priceChartSvg } from "../src/chart.ts";
import type { MarketData } from "../src/data.ts";
import { DAY, HOUR, HistoryStore, candles, compact, downsample, isRange } from "../src/history.ts";
import type { Sample } from "../src/history.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";

const qxWith = (asks: [number, number][], bids: [number, number][], truncated = false) =>
  new QxVenue({ asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 100, truncated });
const pool = (qu = 1_000_000, asset = 10_000) => new QswapVenue({ reserveQu: qu, reserveAsset: asset, swapFeeRate: 30, fixedCostQu: 100_100 });

// ---------------- order book ----------------

test("the book groups orders by price and adds up size and cost from the best price outward", () => {
  const b = buildBook(qxWith([[100, 10], [100, 5], [101, 20], [105, 1]], [[99, 7], [98, 3], [99, 3]]), undefined).qx!;
  assert.deepEqual(b.asks.map((r) => [r.price, r.qty, r.orders, r.cumQty, r.cumQu]), [[100, 15, 2, 15, 1500], [101, 20, 1, 35, 3520], [105, 1, 1, 36, 3625]]);
  assert.deepEqual(b.bids.map((r) => [r.price, r.qty, r.orders, r.cumQty]), [[99, 10, 2, 10], [98, 3, 1, 13]]); // highest first
  assert.deepEqual([b.bestAsk, b.bestBid, b.mid], [100, 99, 99.5]);
  assert.ok(Math.abs(b.spreadPct! - (1 / 99.5) * 100) < 1e-9);
  assert.equal(buildBook(undefined, undefined).qx, null);
  assert.equal(buildBook(undefined, undefined).qswap, null);
});

test("limiting the rows does not change the totals, and a one-sided or empty book is handled", () => {
  const many = Array.from({ length: 30 }, (_, k) => [100 + k, 2] as [number, number]);
  const limited = buildBook(qxWith(many, []), undefined, { levels: 5 }).qx!;
  assert.equal(limited.asks.length, 5);
  assert.deepEqual(limited.asksTotal, { levels: 30, orders: 30, qty: 60 }); // the whole book, not the five rows
  assert.equal(limited.asks[4].cumQty, 10);
  assert.deepEqual([limited.bestBid, limited.spreadPct, limited.mid], [null, null, 100]); // no bids: no spread
  const empty = buildBook(qxWith([], [], true), undefined).qx!;
  assert.deepEqual([empty.asks.length, empty.bids.length, empty.mid, empty.truncated], [0, 0, null, true]);
  assert.equal(buildBook(qxWith([[0, 5], [10, 0], [-1, 3]], []), undefined).qx!.asks.length, 0); // junk orders are ignored
});

test("the pool shows its price and how far bigger trades move it, buying worse and selling worse as they grow", () => {
  const p = buildBook(undefined, pool()).qswap!;
  assert.deepEqual([p.price, p.feePct, p.reserveQu, p.reserveAsset], [100, 0.3, 1_000_000, 10_000]);
  assert.deepEqual(p.depth.map((d) => d.qty), [10, 50, 100, 200, 500]);
  for (const d of p.depth) {
    assert.ok(d.buyAvgPrice! > 100 && d.sellAvgPrice! < 100);
    assert.ok(d.buyImpactPct! > 0.29 && d.sellImpactPct! > 0.29); // never better than the 0.3% fee
  }
  const buys = p.depth.map((d) => d.buyImpactPct!);
  const sells = p.depth.map((d) => d.sellImpactPct!);
  assert.deepEqual(buys, [...buys].sort((a, b) => a - b)); // bigger trades, bigger impact
  assert.deepEqual(sells, [...sells].sort((a, b) => a - b));
  assert.ok(p.depth[4].buyImpactPct! > 5 && p.depth[4].buyImpactPct! < 6); // 5% of the pool is about a 5.3% worse price
});

// ---------------- history ----------------

const sample = (t: number, price: number | null = 100): Sample => ({ t, price, bid: null, ask: null, pool: null, liq: 1 });

test("recording ignores anything not newer, remembers when it started, and keeps assets apart", () => {
  const h = new HistoryStore();
  h.record("A", sample(1000));
  h.record("A", sample(1000, 5)); // same moment
  h.record("A", sample(500, 5)); // older
  h.record("A", sample(2000, 101));
  h.record("B", sample(1500, 7));
  assert.deepEqual(h.series("A", null, 3000).map((s) => s.price), [100, 101]);
  assert.equal(h.since("A"), 1000);
  assert.equal(h.since("nope"), null);
  assert.deepEqual(h.assets().sort(), ["A", "B"]);
  assert.deepEqual(h.series("nope", null), []);
});

test("a range keeps only recent samples, and a long series is thinned evenly without losing its ends", () => {
  const h = new HistoryStore();
  const now = 100 * DAY;
  for (let k = 0; k < 500; k++) h.record("A", sample(now - (499 - k) * HOUR, k));
  assert.equal(h.series("A", DAY, now, 1000).length, 25); // the last day, hourly: 25 samples with both ends
  const thin = h.series("A", null, now, 50);
  assert.ok(thin.length <= 51 && thin.length >= 40);
  assert.equal(thin[0].price, 0);
  assert.equal(thin.at(-1)!.price, 499);
  assert.ok(thin.every((s, i) => i === 0 || s.t > thin[i - 1].t));
  assert.equal(downsample([sample(1), sample(2)], 5).length, 2);
});

test("old samples are thinned to one an hour, the oldest to one a day, and recent ones are all kept", () => {
  const now = 200 * DAY;
  const all: Sample[] = [];
  for (let m = 0; m < 6 * 60; m += 10) all.push(sample(now - 10 * DAY + m * 60_000, m)); // 6 hours, every 10 minutes, 10 days ago
  for (let m = 0; m < 3 * 24 * 60; m += 10) all.push(sample(now - 3 * DAY + 60_000 + m * 60_000, 1000 + m)); // the last 3 days
  for (let m = 0; m < 5 * 60; m += 10) all.push(sample(now - 120 * DAY + m * 60_000, 9 + m)); // 120 days ago
  all.sort((a, b) => a.t - b.t);
  const out = compact(all, now);
  assert.equal(out.filter((s) => now - s.t > 90 * DAY).length, 1); // five hours on one old day become one sample
  assert.equal(out.filter((s) => now - s.t <= 3 * DAY).length, 3 * 24 * 6); // every recent sample survives
  const tenDaysAgo = out.filter((s) => now - s.t > 3 * DAY && now - s.t <= 90 * DAY);
  assert.ok(tenDaysAgo.length >= 6 && tenDaysAgo.length <= 7); // six hours become about six samples
  assert.equal(tenDaysAgo[0].price, 50); // the last sample of that hour, not the first
});

test("recorded history survives a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "qmax-history-")), "history.json");
  const a = new HistoryStore(file);
  a.record("CFB", { t: 1000, price: 1.71, bid: 1.7, ask: 1.72, pool: 1.71, liq: 50 });
  a.record("CFB", sample(2000, null));
  a.flush();
  const b = new HistoryStore(file);
  assert.deepEqual(b.series("CFB", null, 3000), [{ t: 1000, price: 1.71, bid: 1.7, ask: 1.72, pool: 1.71, liq: 50 }, sample(2000, null)]);
  assert.equal(new HistoryStore(join(tmpdir(), "does-not-exist-qmax.json")).assets().length, 0);
});

test("candles give open, high, low and close for each interval and skip empty ones", () => {
  const s = [sample(0, 10), sample(20 * 60_000, 14), sample(40 * 60_000, 8), sample(50 * 60_000, 11), sample(3 * HOUR, 12), sample(3 * HOUR + 1000, null)];
  assert.deepEqual(candles(s, HOUR), [{ t: 0, o: 10, h: 14, l: 8, c: 11 }, { t: 3 * HOUR, o: 12, h: 12, l: 12, c: 12 }]);
  assert.equal(isRange("7d") && isRange("all") && !isRange("2y") && !isRange("toString"), true);
});

// ---------------- charts ----------------

test("axis numbers are short", () => {
  assert.deepEqual([8_750_000_000, 400_100_000, 12_340, 123.4, 12.345, 0.3124, 0].map(compactNumber), ["8.75B", "400.10M", "12.3K", "123", "12.35", "0.312", "0"]);
});

test("a price chart is a well-formed SVG with the symbol, the latest price and the change, and no NaN", () => {
  const pts = Array.from({ length: 50 }, (_, k) => ({ t: k * HOUR, price: 100 + k }));
  const svg = priceChartSvg(pts, { symbol: "CFB", rangeLabel: "7D" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="640" height="300"/);
  assert.match(svg, /CFB {2}149\.0 QU|CFB {2}149 QU/);
  assert.match(svg, /\+49\.00% · 7D/);
  assert.ok(svg.includes("#4ade80")); // up is green
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
  assert.ok(priceChartSvg([{ t: 0, price: 10 }, { t: HOUR, price: 5 }], { symbol: "X", rangeLabel: "1D" }).includes("#f87171")); // down is red
  assert.doesNotMatch(priceChartSvg([{ t: 0, price: 7 }, { t: HOUR, price: 7 }], { symbol: "X", rangeLabel: "1D" }), /NaN|Infinity/); // a flat line
});

test("charts with too little data say so instead of drawing nothing, and names are escaped", () => {
  assert.match(priceChartSvg([], { symbol: "X", rangeLabel: "1D" }), /No price history recorded/);
  assert.match(priceChartSvg([{ t: 0, price: 5 }, { t: 1, price: null }], { symbol: "X", rangeLabel: "1D" }), /only just started recording/);
  const evil = priceChartSvg([], { symbol: '<script>alert("x")</script>', rangeLabel: "1D" });
  assert.doesNotMatch(evil, /<script>/);
  assert.match(evil, /&lt;script&gt;/);
});

test("the depth chart draws both sides, and says so when the book is empty", () => {
  const book = buildBook(qxWith([[101, 10], [102, 30]], [[99, 20], [98, 5]]), undefined).qx!;
  const svg = depthChartSvg(book, { symbol: "CFB" });
  assert.match(svg, /CFB order book depth/);
  assert.match(svg, /spread 2\.00%/);
  assert.ok(svg.includes("#4ade80") && svg.includes("#f87171"));
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.match(depthChartSvg(buildBook(qxWith([], []), undefined).qx!, { symbol: "X" }), /no orders on the QX book/);
  assert.match(depthChartSvg(buildBook(qxWith([[5, 1]], []), undefined).qx!, { symbol: "X" }), /one-sided book/);
});

// ---------------- the API ----------------

const data: MarketData = {
  assets: () => ["ARB"],
  venues: async (asset) => (asset.toUpperCase() === "ARB" ? [qxWith([[100, 10], [101, 20]], [[99, 7]]), pool()] : null),
};
const history = new HistoryStore();
const now = Date.now();
for (let k = 0; k < 48; k++) history.record("ARB", sample(now - (47 - k) * HOUR, 100 + k));
const server = createApi({ data, history });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const get = (path: string) => fetch(base + path).then(async (r) => ({ r, j: (await r.json()) as Record<string, any> }));

test("GET /v1/book returns the QX ladder and the pool, and refuses bad requests", async () => {
  const { r, j } = await get("/v1/book?asset=arb&levels=5");
  assert.equal(r.status, 200);
  assert.equal(j.asset, "ARB");
  assert.equal(j.qx.bestAsk, 100);
  assert.equal(j.qx.asks.length, 2);
  assert.equal(j.qswap.price, 100);
  assert.equal(j.qswap.depth.length, 5);
  assert.equal((await get("/v1/book?asset=NOPE")).r.status, 404);
  assert.equal((await get("/v1/book")).r.status, 400);
  assert.equal((await get("/v1/book?asset=ARB&levels=0")).r.status, 400);
  assert.equal((await get("/v1/book?asset=ARB&levels=51")).r.status, 400);
});

test("GET /v1/history returns the recorded points for a range, and candles when asked", async () => {
  const day = await get("/v1/history?asset=arb&range=1d");
  assert.equal(day.r.status, 200);
  assert.equal(day.j.asset, "ARB");
  assert.ok(day.j.points.length === 24 || day.j.points.length === 25); // the last 24 hours, hourly (the sample exactly 24h old may just have fallen out)
  assert.equal(day.j.points.at(-1).price, 147);
  assert.ok(day.j.since <= now - 47 * HOUR + 1);
  const all = await get("/v1/history?asset=ARB&range=all&interval=4h");
  assert.equal(all.j.points.length, 48);
  assert.ok(all.j.candles.length >= 12 && all.j.candles.length <= 13);
  assert.ok(all.j.candles.every((c: any) => c.l <= c.o && c.l <= c.c && c.h >= c.o && c.h >= c.c));
  const none = await get("/v1/history?asset=NEVERSEEN");
  assert.deepEqual([none.r.status, none.j.points, none.j.since], [200, [], null]); // not recorded yet: an empty answer, not an error
  assert.equal((await get("/v1/history?asset=ARB&range=2y")).r.status, 400);
  assert.equal((await get("/v1/history?asset=ARB&interval=5m")).r.status, 400);
  assert.equal((await get("/v1/history")).r.status, 400);
});

test("a server that does not record history says so", async () => {
  const s = createApi({ data });
  await new Promise<void>((r) => s.listen(0, () => r()));
  const res = await fetch(`http://localhost:${(s.address() as AddressInfo).port}/v1/history?asset=ARB`);
  s.close();
  assert.equal(res.status, 404);
});
