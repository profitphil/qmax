import test from "node:test";
import assert from "node:assert/strict";
import { TimeGrid } from "../src/timegrid.ts";

const H = 3600;
test("a time maps to a candle position and back, inside and outside the candles", () => {
  const g = new TimeGrid([1000 * H, 1001 * H, 1002 * H, 1003 * H], H);
  assert.equal(g.indexOf(1000 * H), 0);
  assert.equal(g.indexOf(1002.5 * H), 2.5);
  assert.equal(g.indexOf(998 * H), -2, "before the first candle: carries on at one step each");
  assert.equal(g.indexOf(1006 * H), 6, "after the last: into the future");
  for (const i of [-3.5, 0, 0.25, 1.9, 3, 5.5]) assert.ok(Math.abs(g.indexOf(g.timeAt(i)) - i) < 1e-9, `round trip at ${i}`);
});

test("a gap in the data is interpolated, so a time inside it lands between its neighbours", () => {
  const g = new TimeGrid([0, H, 5 * H], H); // the candles at 2h, 3h and 4h are missing
  assert.equal(g.indexOf(3 * H), 1.5);
  assert.equal(g.timeAt(1.5), 3 * H);
  assert.equal(g.indexOf(5 * H), 2);
});

test("with no candles there is nothing to map, and a bad step falls back to an hour", () => {
  const g = new TimeGrid([], 0);
  assert.ok(g.empty);
  assert.equal(g.indexOf(5), 0);
  assert.equal(g.timeAt(3), 0);
  assert.equal(g.stepSec, 3600);
});

test("the same time keeps its place when the candles get wider", () => {
  const hourly = new TimeGrid(Array.from({ length: 48 }, (_, i) => i * H), H);
  const fourHourly = new TimeGrid(Array.from({ length: 12 }, (_, i) => i * 4 * H), 4 * H);
  const t = 20 * H;
  assert.equal(hourly.timeAt(hourly.indexOf(t)), t);
  assert.equal(fourHourly.timeAt(fourHourly.indexOf(t)), t);
  assert.equal(fourHourly.indexOf(t), 5);
});
