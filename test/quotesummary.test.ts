import test from "node:test";
import assert from "node:assert/strict";
import { quoteSummary } from "../src/quotesummary.ts";
import type { QuoteSummaryInput } from "../src/quotesummary.ts";

const base: QuoteSummaryInput = {
  asset: "QDOGE",
  side: "sell",
  qty: 50_000_000,
  filledQty: 50_000_000,
  fillable: true,
  totalQu: 757_645_607,
  averagePriceQu: 15.1529,
  route: [{ venue: "QX", qty: 31_250_000, totalQu: 521_526_736 }, { venue: "QSwap", qty: 18_750_000, totalQu: 236_118_871 }],
  alternatives: [{ venue: "QX", fillable: false, totalQu: null }, { venue: "QSwap", fillable: false, totalQu: null }],
};

test("a sale that is split says the total, the average, where each part goes and that a quote is a snapshot", () => {
  const s = quoteSummary(base);
  assert.match(s, /^Selling 50,000,000 QDOGE by the best route would return about 757,645,607 QU \(15\.15 QU each on average, fees included\)/);
  assert.match(s, /split 31,250,000 on QX \(521,526,736 QU\) and 18,750,000 on QSwap \(236,118,871 QU\)\./);
  assert.match(s, /No single market could fill this whole order, so QMax split it across QX and QSwap\./, "when neither market alone could fill it, it says so");
  assert.match(s, /prices move, so quote again before signing\.$/);
});

test("a buy on one market says what it costs and where, and what the other market would have cost", () => {
  const s = quoteSummary({
    asset: "CFB", side: "buy", qty: 1000, filledQty: 1000, fillable: true, totalQu: 24_000, averagePriceQu: 24,
    route: [{ venue: "QSwap", qty: 1000, totalQu: 24_000 }],
    alternatives: [{ venue: "QX", fillable: true, totalQu: 26_000 }, { venue: "QSwap", fillable: true, totalQu: 24_000 }],
  });
  assert.match(s, /^Buying 1,000 CFB by the best route would cost about 24,000 QU \(24 QU each on average, fees included\), all on QSwap\./);
  assert.match(s, /QSwap is the better market for this order: QX alone would cost 2,000 QU more/);
});

test("a split that beats the best single market says by how much", () => {
  const s = quoteSummary({
    asset: "QDOGE", side: "sell", qty: 1_000_000, filledQty: 1_000_000, fillable: true, totalQu: 21_000_000, averagePriceQu: 21,
    route: [{ venue: "QX", qty: 600_000, totalQu: 13_000_000 }, { venue: "QSwap", qty: 400_000, totalQu: 8_000_000 }],
    alternatives: [{ venue: "QX", fillable: true, totalQu: 20_000_000 }, { venue: "QSwap", fillable: true, totalQu: 19_000_000 }],
  });
  assert.match(s, /Splitting across QX and QSwap gets you 1,000,000 QU \(5\.0%\) more than the best single market\./);
});

test("an order that cannot be filled in full says how much could be, or that nothing could", () => {
  const partial = quoteSummary({ ...base, fillable: false, filledQty: 33_900_000, totalQu: 512_000_000, route: [{ venue: "QX", qty: 33_900_000, totalQu: 512_000_000 }] });
  assert.match(partial, /^Only 33,900,000 of the 50,000,000 QDOGE could be sold with the liquidity on QX and QSwap right now, for about 512,000,000 QU\. Try a smaller amount\.$/);
  const none = quoteSummary({ ...base, fillable: false, filledQty: 0, totalQu: 0, route: [] });
  assert.match(none, /^QDOGE cannot be sold in that amount on QX or QSwap right now: there is not enough liquidity\./);
  assert.match(quoteSummary({ ...base, side: "buy", fillable: false, filledQty: 0, totalQu: 0, route: [] }), /cannot be bought/);
});

test("a small average is written with its decimals, a big one whole", () => {
  assert.match(quoteSummary({ ...base, averagePriceQu: 0.0421 }), /\(0\.04 QU each/);
  assert.match(quoteSummary({ ...base, averagePriceQu: 4089.7 }), /\(4,090 QU each/);
  assert.doesNotMatch(quoteSummary({ ...base, averagePriceQu: null }), /each on average/);
});
