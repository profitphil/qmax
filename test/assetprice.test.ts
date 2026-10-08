import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { STALE_TRADE_MS, createApi, priceFromQx } from "../src/api.ts";
import type { TradeSource } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";

/**
 * An asset's price comes from QX, where every asset trades: the newest QX trade when it is recent, an older one kept inside today's QX bid and ask, and for an asset with no QX
 * trade the middle of its QX bid and ask. A QSwap pool nobody trades against must not set the price (QMINE's said 4,157 while QX traded at 3,994).
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

test("a recent QX trade is the price, not the QSwap pool's reserve ratio or the middle of a wide book", () => {
  // QMINE: the pool said 4,157; QX traded at 3,994 an hour ago
  const q = priceFromQx({ priceQu: 4157.05, bestBid: 3715, bestAsk: 3994 }, { price: 3994, ms: NOW - 3_600_000 }, NOW);
  assert.deepEqual([q.priceQu, q.bookPriceQu, q.lastPriceQu, q.lastTradeAt], [3994, 4157.05, 3994, NOW - 3_600_000]);
  // QSILVER: the middle of a 303,000 bid and a 7,000,000 ask is 3.65 million; the last trade, 6.9 days ago, was at 100,001 (outside today's bid: still recent, so it stands)
  assert.equal(priceFromQx({ priceQu: 3_651_500, bestBid: 303_000, bestAsk: 7_000_000 }, { price: 100_001, ms: NOW - 6.9 * DAY }, NOW).priceQu, 100_001);
});

test("a trade older than a week is kept inside today's QX bid and ask", () => {
  const old = NOW - STALE_TRADE_MS - 1;
  // QEARN: the last trade, 146 days ago, was above today's best ask
  assert.equal(priceFromQx({ priceQu: 18_600_000, bestBid: 2_200_001, bestAsk: 35_000_000 }, { price: 56_500_000, ms: NOW - 146 * DAY }, NOW).priceQu, 35_000_000);
  assert.equal(priceFromQx({ priceQu: 1, bestBid: 303_000, bestAsk: 7_000_000 }, { price: 100, ms: old }, NOW).priceQu, 303_000, "below the bid: the bid");
  assert.equal(priceFromQx({ priceQu: 1, bestBid: 100, bestAsk: 900 }, { price: 500, ms: old }, NOW).priceQu, 500, "inside the spread: as it was");
  assert.equal(priceFromQx({ priceQu: 1, bestBid: null, bestAsk: 1 }, { price: 1, ms: old }, NOW).priceQu, 1, "one side only (QVERSAL)");
  assert.equal(priceFromQx({ priceQu: 7, bestBid: null, bestAsk: null }, { price: 12, ms: old }, NOW).priceQu, 12, "an empty book leaves the trade alone");
  // a week exactly is still recent
  assert.equal(priceFromQx({ priceQu: 1, bestBid: 5_000, bestAsk: 9_000 }, { price: 100, ms: NOW - STALE_TRADE_MS }, NOW).priceQu, 100);
});

test("an asset with no QX trade takes the middle of its QX bid and ask, or the one side there is", () => {
  assert.equal(priceFromQx({ priceQu: 4157, bestBid: 100, bestAsk: 300 }, undefined, NOW).priceQu, 200, "not the pool's price");
  assert.equal(priceFromQx({ priceQu: 4157, bestBid: 1_000_000, bestAsk: null }, undefined, NOW).priceQu, 1_000_000, "QTRYGOV: a bid only");
  assert.equal(priceFromQx({ priceQu: 4157, bestBid: null, bestAsk: 250 }, undefined, NOW).priceQu, 250);
  const same = { priceQu: 12, bestBid: 10, bestAsk: 14 };
  assert.equal(priceFromQx(same, undefined, NOW), same, "when the book agrees nothing is added");
  assert.equal(priceFromQx({ priceQu: 12 }, undefined, NOW).priceQu, 12, "no book at all: what there is");
  assert.equal(priceFromQx({ priceQu: 5, bestBid: 4, bestAsk: 6 }, { price: 0, ms: NOW }, NOW).priceQu, 5, "a zero trade is not a price");
});

const entry = (id: string, priceQu: number | null, bestBid: number | null, bestAsk: number | null) => ({ id, symbol: id, issuer: "", category: "token", venues: ["QX", "QSwap"], priceQu, liquidityQu: 1, bestBid, bestAsk });
const data = {
  assets: () => [],
  venues: async () => null,
  listAssets: () => ({ ready: true, assets: [entry("QMINE", 4157.05, 3715, 3994), entry("QEARN", 18_600_000, 2_200_001, 35_000_000), entry("FRESH", 7, 6, 8)] }),
  searchAssets: async () => [entry("QMINE", 4157.05, 3715, 3994)],
} as unknown as MarketData;
const zero = { volume24hQu: 0, volume72hQu: 0, volume7dQu: 0, trades24h: 0, change24hPct: null, change72hPct: null, change7dPct: null };
const trades = {
  volumes: () => new Map([["QMINE", { ...zero, volume24hQu: 9 }], ["QEARN", zero], ["FRESH", zero]]),
  lasts: () => new Map([["QMINE", { price: 3994, ms: Date.now() - 3_600_000 }], ["QEARN", { price: 56_500_000, ms: Date.now() - 146 * DAY }]]),
} as unknown as TradeSource;
const server = createApi({ data, trades, freeAccess: true });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("the asset list carries each asset's price drawn from QX, and the book or pool price as bookPriceQu", async () => {
  const j = (await (await fetch(`${base}/v1/assets`)).json()) as { assets: any[] };
  const by = Object.fromEntries(j.assets.map((a) => [a.id, a]));
  assert.deepEqual([by.QMINE.priceQu, by.QMINE.bookPriceQu, by.QMINE.lastPriceQu], [3994, 4157.05, 3994]);
  assert.deepEqual([by.QEARN.priceQu, by.QEARN.lastPriceQu], [35_000_000, 56_500_000], "an old trade is kept inside the book; the raw trade is still there");
  assert.deepEqual([by.FRESH.priceQu, by.FRESH.bookPriceQu, by.FRESH.lastPriceQu], [7, undefined, undefined], "no QX trade, and the QX middle is 7: nothing to add");
});

test("a search by name gets the same price, so a looked-up asset agrees with the list", async () => {
  const j = (await (await fetch(`${base}/v1/assets/search?name=QMINE`)).json()) as { assets: any[] };
  assert.deepEqual([j.assets[0].priceQu, j.assets[0].bookPriceQu], [3994, 4157.05]);
});
