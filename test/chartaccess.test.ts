import test from "node:test";
import assert from "node:assert/strict";
import { FREE_CHART, entitled, isFreeIndicator, isFreeInterval, isFreeScale, isFreeShot, isFreeTool, isFreeType } from "../src/chartaccess.ts";
import { INDICATORS } from "../src/indicators.ts";

const chosen = { type: "heikin", interval: "5m", indicators: ["sma20", "bb", "rsi"], epochs: true, fill: true, scale: "log", volume: true, color: "#fff" };

test("with Max on, every choice applies as it was made", () => {
  assert.deepEqual(entitled(chosen, true), chosen);
});

test("with Max off, the choices outside the free set fall back to the basic ones, and the rest are left alone", () => {
  const e = entitled(chosen, false);
  assert.equal(e.type, "candles");
  assert.equal(e.interval, "5m", "every candle width is free");
  assert.deepEqual(e.indicators, ["sma20"]);
  assert.equal(e.epochs, false);
  assert.equal(e.fill, false);
  assert.equal(e.scale, "normal");
  assert.equal(e.volume, true, "volume is free");
  assert.equal(e.color, "#fff", "anything else is carried through");
  assert.deepEqual(chosen.indicators, ["sma20", "bb", "rsi"], "the saved choice is not changed: it comes back with Max");
});

test("a free choice stays as chosen with Max off", () => {
  const free = { type: "line", interval: "1h", indicators: ["sma20"], epochs: false, fill: false, scale: "normal" };
  assert.deepEqual(entitled(free, false), free);
  assert.equal(entitled({ ...free, interval: "1d" }, false).interval, "1d");
});

test("what is free: the basics only", () => {
  assert.ok(["candles", "line"].every(isFreeType));
  assert.ok(!["heikin", "bars", "area"].some(isFreeType));
  assert.ok(["auto", "1m", "5m", "15m", "30m", "1h", "4h", "1d"].every(isFreeInterval), "every candle width is free");
  assert.ok(isFreeIndicator("sma20"));
  assert.equal(INDICATORS.filter((i) => isFreeIndicator(i.id)).length, 1, "one indicator is free");
  assert.ok(isFreeScale("normal") && !isFreeScale("log") && !isFreeScale("percent"));
  assert.ok(["cursor", "trend", "hline"].every(isFreeTool));
  assert.ok(!["ray", "vline", "rect", "fib", "measure"].some(isFreeTool));
  assert.ok(isFreeShot(0) && !isFreeShot(1920) && !isFreeShot(3840) && !isFreeShot(7680));
});

test("every free choice is something the chart really offers", () => {
  const ids = new Set(INDICATORS.map((i) => i.id as string));
  for (const i of FREE_CHART.indicators) assert.ok(ids.has(i), i);
});
