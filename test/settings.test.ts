import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, sanitizeSettings, arbFiltersOf } from "../src/settings.ts";

test("missing, malformed or hostile stored settings fall back to defaults", () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings("nope"), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ slippagePct: "abc", hideQuiet: "yes", defaultSort: "random", arbMinProfitQu: -5 }), { ...DEFAULT_SETTINGS, arbMinProfitQu: 0 });
});

test("valid values are kept and out-of-range numbers are clamped", () => {
  const s = sanitizeSettings({ slippagePct: 2.5, hideQuiet: true, defaultSort: "az", compactPrices: false, arbMinProfitQu: 50_000, arbMinProfitPct: 2.5, arbMaxCostQu: 1_000_000, consolidate: true, consolidateTo: "qswap", shareUsage: false });
  assert.deepEqual(s, { slippagePct: 2.5, hideQuiet: true, defaultSort: "az", compactPrices: false, arbMinProfitQu: 50_000, arbMinProfitPct: 2.5, arbMaxCostQu: 1_000_000, consolidate: true, consolidateTo: "qswap", shareUsage: false });
  assert.equal("hideMaxMarks" in sanitizeSettings({ hideMaxMarks: true } as never), false, "the option to hide the Max marks is gone (there are no marks)");
  assert.equal(DEFAULT_SETTINGS.shareUsage, true, "usage counting is on until the person turns it off");
  assert.equal(sanitizeSettings({ shareUsage: "no" }).shareUsage, true, "only a real boolean turns it off");
  assert.deepEqual([DEFAULT_SETTINGS.consolidate, DEFAULT_SETTINGS.consolidateTo], [false, "qx"]); // off unless asked for; QX when it is
  assert.deepEqual(sanitizeSettings({ consolidate: "yes", consolidateTo: "other" }), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ arbMinProfitPct: -3, arbMaxCostQu: "abc" }), { ...DEFAULT_SETTINGS, arbMinProfitPct: 0, arbMaxCostQu: 0 });
  assert.equal(sanitizeSettings({ arbMinProfitPct: 5000 }).arbMinProfitPct, 1000);
  assert.deepEqual(arbFiltersOf(s), { minProfitQu: 50_000, minProfitPct: 2.5, maxCostQu: 1_000_000 });
  assert.equal(sanitizeSettings({ slippagePct: 99 }).slippagePct, 10); // never allow a huge slippage by accident
  assert.equal(sanitizeSettings({ slippagePct: -1 }).slippagePct, 0);
});

test("the old 'top' sort (most liquid, the old default) becomes the new default, busiest first; the other choices are kept", () => {
  assert.equal(DEFAULT_SETTINGS.defaultSort, "volume");
  assert.equal(sanitizeSettings({ defaultSort: "top" }).defaultSort, "volume");
  assert.equal(sanitizeSettings({ defaultSort: "liquidity" }).defaultSort, "liquidity");
  assert.equal(sanitizeSettings({ defaultSort: "az" }).defaultSort, "az");
  assert.equal(sanitizeSettings({}).defaultSort, "volume");
});
