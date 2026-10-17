import test from "node:test";
import assert from "node:assert/strict";
import { compactPrices, compactUnits } from "../web/format.ts";

test("prices from a million up are written short, smaller ones in full", () => {
  assert.deepEqual(compactPrices([68_000_000, 59_500_000, 45_000_205, 18_600_000, 6_000_000, 320_000, 1]), ["68M", "59.5M", "45M", "18.6M", "6M", "320,000", "1"]);
  assert.deepEqual(compactPrices([2_750_000_000]), ["2.75B"]);
  assert.deepEqual(compactPrices([]), []);
});

test("two different prices never come out looking the same", () => {
  const prices = [60_000_000, 59_999_999, 59_500_000, 41_000_001, 41_000_000];
  const out = compactPrices(prices);
  assert.equal(new Set(out).size, prices.length, `all different: ${out.join(" ")}`);
  assert.equal(out[2], "59.5M", "prices that were already different are left short");
  assert.ok(out[0].length < "60,000,000".length || out[0] === "60M", "and 60M stays short where it is not confused with anything");
  // when not even more digits tell them apart, the whole number is written
  assert.deepEqual(compactPrices([1_000_000_001, 1_000_000_002]), ["1,000,000,001", "1,000,000,002"]);
});

test("sizes in little room", () => {
  assert.equal(compactUnits(241_235), "241.2K");
  assert.equal(compactUnits(2_078_713), "2.1M");
  assert.equal(compactUnits(999), "999");
});
