import test from "node:test";
import assert from "node:assert/strict";
import { lastTradeAge, livePrice } from "../src/liveprice.ts";

/** The API decides an asset's price (see test/assetprice.test.ts); the website shows what it says. */

test("the price shown is the one the API gave, and the last trade only where there is none", () => {
  assert.equal(livePrice({ priceQu: 3994, lastPriceQu: 3994, lastTradeAt: 1_000, probedAt: 9_999_999 }), 3994);
  assert.equal(livePrice({ priceQu: 35_000_000, lastPriceQu: 56_500_000, lastTradeAt: 1 }), 35_000_000, "an old trade that the API kept inside today's bid and ask is not undone here");
  assert.equal(livePrice({ priceQu: null, lastPriceQu: 7, lastTradeAt: 5 }), 7, "an answer that carries only the last trade");
  assert.equal(livePrice({ priceQu: null, lastPriceQu: 0 }), null, "a zero is not a price");
  assert.equal(livePrice({ priceQu: null }), null);
});

test("the age of the newest trade is said in words", () => {
  const now = 10_000_000_000;
  const at = (ms: number) => ({ lastPriceQu: 5, lastTradeAt: now - ms });
  assert.equal(lastTradeAge(at(30_000), now), "just now");
  assert.equal(lastTradeAge(at(15 * 60_000), now), "15 minutes ago");
  assert.equal(lastTradeAge(at(5 * 3_600_000), now), "5 hours ago");
  assert.equal(lastTradeAge(at(62 * 86_400_000), now), "62 days ago");
  assert.equal(lastTradeAge({ lastPriceQu: null, lastTradeAt: now }, now), null, "no trade, no age");
  assert.equal(lastTradeAge({}, now), null);
});
