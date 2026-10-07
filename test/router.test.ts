import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/router.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";

const qxCfg = {
  buyerFeeRate: 0,
  sellerFeeRate: 0.003,
  fixedCostQu: 0,
  asks: [{ price: 100, qty: 1000 }, { price: 110, qty: 5000 }],
  bids: [{ price: 98, qty: 1000 }, { price: 90, qty: 5000 }],
};
const poolCfg = { reserveQu: 1_000_000, reserveAsset: 10_000, swapFeeRate: 30, fixedCostQu: 0 };
const qx = new QxVenue(qxCfg);
const qswap = new QswapVenue(poolCfg);

test("small buy goes to the cheaper venue only", () => {
  const plan = route([qx, qswap], "buy", 100);
  assert.equal(plan.allocations.length, 1);
  assert.equal(plan.allocations[0].venue, "QX");
});

test("large buy splits and beats every single venue", () => {
  const plan = route([qx, qswap], "buy", 3000);
  assert.equal(plan.allocations.length, 2);
  for (const s of plan.singleVenue) if (s.quote) assert.ok(plan.totalNetQu < s.quote.netQu);
  assert.equal(plan.filledQty, 3000);
});

test("large sell splits and beats every single venue", () => {
  const plan = route([qx, qswap], "sell", 3000);
  for (const s of plan.singleVenue) if (s.quote) assert.ok(plan.totalNetQu > s.quote.netQu);
});

test("QSwap fixed operation fee keeps a modest order on QX", () => {
  const costly = new QswapVenue({ ...poolCfg, fixedCostQu: 100_100 });
  const plan = route([qx, costly], "buy", 1200);
  assert.ok(plan.allocations.every((a) => a.venue === "QX"));
});

test("QX depth: order larger than the book cannot be filled by QX alone", () => {
  assert.equal(qx.quote("buy", 7000), null);
  const plan = route([qx, qswap], "buy", 7000);
  assert.equal(plan.filledQty, 7000); // pool covers the rest
  assert.ok(plan.singleVenue[0].quote === null);
});

test("reports unfillable orders", () => {
  const plan = route([qx], "buy", 999_999);
  assert.equal(plan.filledQty, 0);
  assert.ok(plan.warnings.length > 0);
});

test("QX: seller pays 0.3% (rounded up), buyer pays none", () => {
  const buy = qx.quote("buy", 100)!;
  assert.equal(buy.netQu, 10_000);
  const sell = qx.quote("sell", 100)!;
  assert.equal(sell.netQu, 9800 - (Math.floor(9800 * 0.003) + 1));
});

test("QSwap buy matches contract integer math", () => {
  const q = qswap.quote("buy", 100)!;
  const expected = Math.floor((1_000_000 * 100 * 10000) / (9900 * 9970)) + 1;
  assert.equal(q.netQu, expected);
  assert.ok(q.priceImpact > 0.009 && q.priceImpact < 0.011);
});

test("quote ladder keeps RPC calls small", () => {
  const plan = route([qx, qswap], "buy", 3000);
  assert.ok(plan.quoteCalls < 40);
});

test("there is no per-trade fee: the total is exactly what the venues charge", () => {
  const buy = route([qx], "buy", 100);
  assert.equal(buy.totalNetQu, buy.allocations[0].quote.netQu);
  const sell = route([qx], "sell", 100);
  assert.equal(sell.totalNetQu, sell.allocations[0].quote.netQu);
});

test("a sell worth less than the flat fees is refused instead of costing the user money", () => {
  const costly = new QswapVenue({ ...poolCfg, fixedCostQu: 100_100 });
  const plan = route([costly], "sell", 10); // ~1,000 QU of value vs 100,100 QU fixed
  assert.equal(plan.filledQty, 0);
  assert.equal(plan.allocations.length, 0);
  assert.match(plan.warnings[0], /too small to sell/);
});

test("warns when fees are a large share of a buy", () => {
  const costly = new QswapVenue({ ...poolCfg, fixedCostQu: 100_100 });
  const plan = route([costly], "buy", 100); // ~10,000 QU of value
  assert.equal(plan.filledQty, 100);
  assert.ok(plan.warnings.some((w) => /Fees are \d+% of this trade/.test(w)));
});
