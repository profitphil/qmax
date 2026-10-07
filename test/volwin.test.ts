import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VOL_WINDOW, VOL_WINDOWS, busiestIn, changeOf, isVolWindow, volLong, volumeOf } from "../src/volwin.ts";

const a = { id: "A", volume24hQu: 100, volume72hQu: 150, volume7dQu: 900, liquidityQu: 5 };
const b = { id: "B", volume24hQu: 300, volume72hQu: 310, volume7dQu: 320, liquidityQu: 1 };

test("24 hours is the default, and 72 hours and 7 days are the other choices", () => {
  assert.equal(DEFAULT_VOL_WINDOW, "24h");
  assert.deepEqual(VOL_WINDOWS.map((w) => w.id), ["24h", "72h", "7d"]);
  assert.ok(["24h", "72h", "7d"].every(isVolWindow));
  assert.equal(isVolWindow("30d"), false);
  assert.equal(isVolWindow(undefined), false);
  assert.equal(volLong("72h"), "the last 72 hours");
});

test("each window reads its own figure", () => {
  assert.equal(volumeOf(a, "24h"), 100);
  assert.equal(volumeOf(a, "72h"), 150);
  assert.equal(volumeOf(a, "7d"), 900);
  assert.equal(volumeOf({}, "24h"), 0);
  assert.equal(volumeOf({}, "7d"), 0);
});

test("a server that sends no 72 hour figure still gives a sensible one", () => {
  assert.equal(volumeOf({ volume24hQu: 10, volume7dQu: 70 }, "72h"), 70);
  assert.equal(volumeOf({ volume24hQu: 10 }, "72h"), 10);
});

test("busiest first follows the chosen window, so the order can differ between them", () => {
  assert.deepEqual([a, b].sort(busiestIn("24h")).map((x) => x.id), ["B", "A"]);
  assert.deepEqual([a, b].sort(busiestIn("72h")).map((x) => x.id), ["B", "A"]);
  assert.deepEqual([a, b].sort(busiestIn("7d")).map((x) => x.id), ["A", "B"]);
});

test("ties go to the longer window and then to the deeper market", () => {
  const x = { id: "X", volume24hQu: 5, volume7dQu: 10, liquidityQu: 1 };
  const y = { id: "Y", volume24hQu: 5, volume7dQu: 20, liquidityQu: 1 };
  const z = { id: "Z", volume24hQu: 5, volume7dQu: 20, liquidityQu: 9 };
  assert.deepEqual([x, y, z].sort(busiestIn("24h")).map((v) => v.id), ["Z", "Y", "X"]);
});

test("the price change follows the same window as the volume, and is null where there is nothing to compare", () => {
  const c = { change24hPct: 2, change72hPct: -7.5, change7dPct: 40 };
  assert.equal(changeOf(c, "24h"), 2);
  assert.equal(changeOf(c, "72h"), -7.5);
  assert.equal(changeOf(c, "7d"), 40);
  assert.equal(changeOf({ change24hPct: 0, change72hPct: null }, "24h"), 0, "no move is a number, not a gap");
  assert.equal(changeOf({ change24hPct: 0, change72hPct: null }, "72h"), null);
  assert.equal(changeOf({ change24hPct: 5 }, "7d"), null, "an older server that does not send the longer windows");
});
