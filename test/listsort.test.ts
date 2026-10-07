import test from "node:test";
import assert from "node:assert/strict";
import { defaultDir, sortAssets, spreadOf } from "../src/listsort.ts";
import type { Sortable } from "../src/listsort.ts";

const row = (symbol: string, o: Partial<Sortable> = {}): Sortable & { id: string } => ({ id: symbol, symbol, priceQu: 10, liquidityQu: 100, volume24hQu: 0, volume7dQu: 0, ...o });
const ids = (l: { id: string }[]) => l.map((x) => x.id).join(",");

const A = row("AAA", { priceQu: 5, change24hPct: 10, liquidityQu: 300, volume24hQu: 50, volume72hQu: 500, volume7dQu: 600, bestBid: 95, bestAsk: 105 });
const B = row("BBB", { priceQu: 50, change24hPct: -5, liquidityQu: 100, volume24hQu: 500, volume72hQu: 600, volume7dQu: 700, bestBid: 99, bestAsk: 101 });
const C = row("CCC", { priceQu: 20, change24hPct: null, liquidityQu: 200, volume24hQu: 5, volume72hQu: 5, volume7dQu: 9000, bestBid: null, bestAsk: 40 });
const D = row("DDD", { priceQu: null, change24hPct: 0, liquidityQu: 50 });

test("each column sorts both ways", () => {
  assert.equal(ids(sortAssets([A, B, C], "price", "desc", "24h")), "BBB,CCC,AAA");
  assert.equal(ids(sortAssets([A, B, C], "price", "asc", "24h")), "AAA,CCC,BBB");
  assert.equal(ids(sortAssets([A, B, C], "liquidity", "desc", "24h")), "AAA,CCC,BBB");
  assert.equal(ids(sortAssets([A, B, C], "liquidity", "asc", "24h")), "BBB,CCC,AAA");
  assert.equal(ids(sortAssets([C, A, B], "az", "asc", "24h")), "AAA,BBB,CCC");
  assert.equal(ids(sortAssets([A, B, C], "az", "desc", "24h")), "CCC,BBB,AAA");
  assert.equal(ids(sortAssets([A, B, D], "change", "desc", "24h")), "AAA,DDD,BBB");
  assert.equal(ids(sortAssets([A, B, D], "change", "asc", "24h")), "BBB,DDD,AAA");
});

test("rows with nothing in the column go last, whichever way it is sorted", () => {
  assert.equal(ids(sortAssets([C, A, B], "change", "desc", "24h")), "AAA,BBB,CCC"); // C has no change
  assert.equal(ids(sortAssets([C, A, B], "change", "asc", "24h")), "BBB,AAA,CCC");
  assert.equal(ids(sortAssets([D, A, B], "price", "desc", "24h")), "BBB,AAA,DDD"); // D has no price
  assert.equal(ids(sortAssets([D, A, B], "price", "asc", "24h")), "AAA,BBB,DDD");
  assert.equal(ids(sortAssets([C, A, B], "spread", "asc", "24h")), "BBB,AAA,CCC"); // C has no bid
  assert.equal(ids(sortAssets([C, A, B], "spread", "desc", "24h")), "AAA,BBB,CCC");
});

test("volume sorts over the chosen window, so the order changes with it", () => {
  assert.equal(ids(sortAssets([A, B, C], "volume", "desc", "24h")), "BBB,AAA,CCC");
  assert.equal(ids(sortAssets([A, B, C], "volume", "desc", "72h")), "BBB,AAA,CCC");
  assert.equal(ids(sortAssets([A, B, C], "volume", "desc", "7d")), "CCC,BBB,AAA");
  assert.equal(ids(sortAssets([A, B, C], "volume", "asc", "7d")), "AAA,BBB,CCC");
  assert.equal(ids(sortAssets([A, B, C], "volume", "asc", "24h")), "CCC,AAA,BBB");
});

test("ties keep the busiest first and the sort leaves the original list alone", () => {
  const x = row("XXX", { priceQu: 7, volume24hQu: 1 });
  const y = row("YYY", { priceQu: 7, volume24hQu: 9 });
  const list = [x, y];
  assert.equal(ids(sortAssets(list, "price", "desc", "24h")), "YYY,XXX");
  assert.equal(ids(list), "XXX,YYY");
});

test("the way each column sorts when first chosen, and the spread", () => {
  for (const k of ["volume", "liquidity", "price", "change"] as const) assert.equal(defaultDir(k), "desc");
  for (const k of ["az", "spread"] as const) assert.equal(defaultDir(k), "asc");
  assert.equal(spreadOf({ bestBid: 90, bestAsk: 110 }), 20);
  assert.equal(spreadOf({ bestBid: null, bestAsk: 110 }), null);
  assert.equal(spreadOf({ bestBid: 120, bestAsk: 110 }), null); // a crossed book is not a spread
});

test("the change column sorts over the chosen window, like the volume", () => {
  const X = row("XXX", { change24hPct: 1, change72hPct: -20, change7dPct: 5, liquidityQu: 1 });
  const Y = row("YYY", { change24hPct: 9, change72hPct: 30, change7dPct: -9, liquidityQu: 1 });
  const Z = row("ZZZ", { change24hPct: 3, change72hPct: null, change7dPct: null, liquidityQu: 1 });
  assert.equal(ids(sortAssets([X, Y, Z], "change", "desc", "24h")), "YYY,ZZZ,XXX");
  assert.equal(ids(sortAssets([X, Y, Z], "change", "desc", "72h")), "YYY,XXX,ZZZ"); // Z has nothing over 72 hours: last
  assert.equal(ids(sortAssets([X, Y, Z], "change", "desc", "7d")), "XXX,YYY,ZZZ");
});
