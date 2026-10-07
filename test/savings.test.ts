import test from "node:test";
import assert from "node:assert/strict";
import { addToTally, comparisonLines, receiptText, routeSaving, savingHeadline, tallyLine } from "../src/savings.ts";
import type { SavingsInput } from "../src/savings.ts";

const buy = (over: Partial<SavingsInput> = {}): SavingsInput => ({
  side: "buy",
  totalQu: 9_800,
  fillable: true,
  route: [{ venue: "QX" }, { venue: "QSwap" }],
  alternatives: [
    { venue: "QX", fillable: true, totalQu: 10_000 },
    { venue: "QSwap", fillable: true, totalQu: 10_400 },
  ],
  ...over,
});

test("a split buy is compared with each market alone, and the saving against the best one is the smaller figure", () => {
  const s = routeSaving(buy())!;
  assert.deepEqual(s.comparisons.map((c) => [c.venue, c.savedQu]), [["QX", 200], ["QSwap", 600]]);
  assert.equal(s.savedVsBestSingleQu, 200, "the best single market is QX, so only 200 is the honest saving");
  assert.ok(Math.abs(s.savedVsBestSinglePct - 2) < 1e-9);
  assert.equal(s.split, true);
  assert.match(savingHeadline(s)!, /saves you 200 QU \(2\.0%\) versus the best single market/);
});

test("a split sell gets more, and the wording says so", () => {
  const s = routeSaving({ side: "sell", totalQu: 10_300, fillable: true, route: [{ venue: "QX" }, { venue: "QSwap" }], alternatives: [{ venue: "QX", fillable: true, totalQu: 10_000 }, { venue: "QSwap", fillable: true, totalQu: 9_000 }] })!;
  assert.deepEqual(s.comparisons.map((c) => c.savedQu), [300, 1300]);
  assert.equal(s.savedVsBestSingleQu, 300);
  assert.match(savingHeadline(s)!, /gets you 300 QU \(3\.0%\) more than the best single market/);
});

test("a single-market route says what the other market would have cost", () => {
  const s = routeSaving(buy({ totalQu: 10_000, route: [{ venue: "QX" }] }))!;
  assert.equal(s.split, false);
  assert.equal(s.savedVsBestSingleQu, 0, "it is the best single market");
  assert.match(savingHeadline(s)!, /QX is the better market for this order: QSwap alone would cost 400 QU more \(3\.8%\)/);
});

test("when no single market can fill the order, the split is what made it possible", () => {
  const s = routeSaving(buy({ alternatives: [{ venue: "QX", fillable: false, totalQu: null }, { venue: "QSwap", fillable: false, totalQu: null }] }))!;
  assert.equal(s.onlyViaSplit, true);
  assert.match(savingHeadline(s)!, /No single market could fill this whole order/);
  assert.deepEqual(comparisonLines(s), ["QX alone: could not fill the whole order", "QSwap alone: could not fill the whole order"]);
});

test("a market that cannot fill the order is left out of the comparison, not counted as a saving", () => {
  const s = routeSaving(buy({ totalQu: 10_000, route: [{ venue: "QSwap" }], alternatives: [{ venue: "QX", fillable: false, totalQu: null }, { venue: "QSwap", fillable: true, totalQu: 10_000 }] }))!;
  assert.equal(s.savedVsBestSingleQu, 0);
  assert.equal(savingHeadline(s), null, "nothing worth saying");
});

test("nothing is claimed for an unfillable quote, an empty route or noise-level differences", () => {
  assert.equal(routeSaving(buy({ fillable: false })), null);
  assert.equal(routeSaving(buy({ route: [] })), null);
  assert.equal(routeSaving(buy({ totalQu: 0 })), null);
  assert.equal(routeSaving(buy({ alternatives: [] })), null);
  const tiny = routeSaving(buy({ totalQu: 9_999.4, route: [{ venue: "QX" }, { venue: "QSwap" }], alternatives: [{ venue: "QX", fillable: true, totalQu: 10_000 }] }))!;
  assert.equal(savingHeadline(tiny), null, "under 1 QU is rounding");
});

test("a route that costs a hair more than a market alone shows no negative saving", () => {
  const s = routeSaving(buy({ totalQu: 10_001, alternatives: [{ venue: "QX", fillable: true, totalQu: 10_000 }] }))!;
  assert.equal(s.comparisons[0].savedQu, 0);
  assert.equal(s.savedVsBestSingleQu, 0);
});

test("the comparison lines read as sentences", () => {
  const lines = comparisonLines(routeSaving(buy())!);
  assert.deepEqual(lines, ["QX alone: 10,000 QU, 200 QU more than this route", "QSwap alone: 10,400 QU, 600 QU more than this route"]);
});

test("the lifetime tally counts only the saving against the best single market, and partial fills count their share", () => {
  const split = routeSaving(buy())!; // saves 200
  const single = routeSaving(buy({ totalQu: 10_000, route: [{ venue: "QX" }] }))!;
  let t = addToTally(undefined, split, 1, 1000);
  assert.deepEqual(t, { savedQu: 200, trades: 1, splitTrades: 1, since: 1000 });
  t = addToTally(t, single, 1, 2000);
  assert.deepEqual(t, { savedQu: 200, trades: 2, splitTrades: 1, since: 1000 }, "a single-market trade adds a trade, not a saving");
  t = addToTally(t, split, 0.5, 3000);
  assert.deepEqual(t, { savedQu: 300, trades: 3, splitTrades: 2, since: 1000 });
  assert.deepEqual(addToTally(t, split, 0), t, "a trade that moved nothing is not counted");
  assert.deepEqual(addToTally(t, split, NaN), t);
  assert.equal(addToTally(t, split, 7).savedQu, 500, "a fraction above 1 is capped at a full fill");
});

test("the tally line is empty before the first trade", () => {
  assert.equal(tallyLine(undefined), null);
  assert.equal(tallyLine({ savedQu: 0, trades: 0, splitTrades: 0, since: 0 }), null);
  assert.equal(tallyLine({ savedQu: 1234, trades: 1, splitTrades: 1, since: 0 }), "1,234 QU saved by splitting orders across both markets, over 1 trade (1 split).");
});

test("the receipt text is plain and includes the saving when there is one", () => {
  const saving = routeSaving(buy())!;
  assert.equal(receiptText({ side: "buy", asset: "CFB", filledQty: 5000, actualQu: 9_850, saving }), "Bought 5,000 CFB for 9,850 QU with QMax. Splitting across QX and QSwap saves you 200 QU (2.0%) versus the best single market.");
  assert.equal(receiptText({ side: "sell", asset: "CFB", filledQty: 5000, actualQu: 9_850, saving: null }), "Sold 5,000 CFB for 9,850 QU with QMax.");
});
