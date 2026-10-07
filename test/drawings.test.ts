import test from "node:test";
import assert from "node:assert/strict";
import { FIB_RATIOS, PALETTE, POINTS_NEEDED, anchorsPx, describeDuration, distToSegment, fibLevels, hitTest, loadDrawings, measureStats, moveAnchor, newDrawingId, rayEnd, sanitizeDrawings, saveDrawings, translate } from "../src/drawings.ts";
import type { Drawing, Geo, KeyValueStore } from "../src/drawings.ts";

// A plot 800 wide and 400 tall: time maps to x (1 px per 10 s), price to y (100 at the bottom, 140 at the top).
const geo: Geo = { x: (t) => t / 10, y: (p) => 400 - ((p - 100) / 40) * 400, w: 800, h: 400 };
const d = (kind: Drawing["kind"], points: [number, number][]): Drawing => ({ id: "x1", kind, color: "#38bdf8", points: points.map(([t, p]) => ({ t, p })) });

test("fib levels run from where the move ended (0) back to where it began (1)", () => {
  const up = fibLevels({ t: 0, p: 100 }, { t: 1, p: 200 });
  assert.equal(up.length, FIB_RATIOS.length);
  assert.deepEqual(up.map((l) => [l.ratio, Math.round(l.price * 1000) / 1000]), [[0, 200], [0.236, 176.4], [0.382, 161.8], [0.5, 150], [0.618, 138.2], [0.786, 121.4], [1, 100]]);
  assert.equal(fibLevels({ t: 0, p: 200 }, { t: 1, p: 100 })[1].price, 123.6, "after a fall the levels run up from the low");
});

test("measuring: price, percent, candles and time between two points", () => {
  const m = measureStats({ t: 0, p: 100 }, { t: 3 * 3600 * 4, p: 125 }, 3600);
  assert.deepEqual([m.dPrice, m.dPct, m.bars, m.seconds], [25, 25, 12, 43200]);
  assert.equal(measureStats({ t: 100, p: 50 }, { t: 0, p: 40 }, 3600).dPct, -20, "a fall is negative, and time is never");
  assert.equal(measureStats({ t: 0, p: 0 }, { t: 1, p: 5 }, 3600).dPct, 0);
  assert.equal(describeDuration(3 * 86400 + 2 * 3600 + 5), "3d 2h");
  assert.equal(describeDuration(5 * 3600 + 30 * 60), "5h 30m");
  assert.equal(describeDuration(45 * 60), "45m");
  assert.equal(describeDuration(2 * 86400), "2d");
  assert.equal(describeDuration(-5), "0m");
});

test("distance to a segment, and where a ray ends", () => {
  assert.equal(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(distToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5, "past the end it is the distance to the end");
  assert.equal(distToSegment({ x: 3, y: 4 }, { x: 1, y: 1 }, { x: 1, y: 1 }), Math.hypot(2, 3), "a segment that is a point");
  const e = rayEnd({ x: 100, y: 100 }, { x: 200, y: 150 }, 800, 400);
  assert.ok(e.x > 800 && e.y > 100, "carries on in the same direction, beyond the plot");
  assert.ok(Math.abs((e.y - 100) / (e.x - 100) - 0.5) < 1e-9, "same slope");
});

test("hit-testing: handles first, then the body, each kind in its own way", () => {
  const trend = d("trend", [[1000, 110], [3000, 130]]); // px (100,300) to (300,100)
  assert.deepEqual(anchorsPx(trend, geo), [{ x: 100, y: 300 }, { x: 300, y: 100 }]);
  assert.deepEqual(hitTest(trend, geo, { x: 103, y: 298 }), { part: "handle", index: 0 });
  assert.deepEqual(hitTest(trend, geo, { x: 298, y: 104 }), { part: "handle", index: 1 });
  assert.deepEqual(hitTest(trend, geo, { x: 200, y: 200 }), { part: "body" });
  assert.equal(hitTest(trend, geo, { x: 200, y: 240 }), null);
  assert.equal(hitTest(trend, geo, { x: 500, y: -50 }), null, "a trend line stops at its end");

  const ray = d("ray", [[1000, 110], [3000, 130]]);
  assert.deepEqual(hitTest(ray, geo, { x: 500, y: -100 }), { part: "body" }, "a ray carries on");
  assert.equal(hitTest(ray, geo, { x: 50, y: 350 }), null, "but not backwards");

  const h = d("hline", [[1000, 120]]); // y = 200
  assert.deepEqual(hitTest(h, geo, { x: 700, y: 204 }), { part: "body" });
  assert.equal(hitTest(h, geo, { x: 700, y: 220 }), null);
  const v = d("vline", [[2000, 120]]); // x = 200
  assert.deepEqual(hitTest(v, geo, { x: 196, y: 10 }), { part: "body" });
  assert.equal(hitTest(v, geo, { x: 260, y: 10 }), null);

  const rect = d("rect", [[1000, 110], [3000, 130]]);
  assert.deepEqual(hitTest(rect, geo, { x: 200, y: 200 }), { part: "body" }, "inside it");
  assert.deepEqual(hitTest(rect, geo, { x: 100, y: 300 }), { part: "handle", index: 0 });
  assert.equal(hitTest(rect, geo, { x: 400, y: 200 }), null);

  const fib = d("fib", [[1000, 110], [3000, 130]]);
  const level618 = fibLevels(fib.points[0], fib.points[1])[4].price; // 117.64
  const y618 = geo.y(level618)!;
  assert.deepEqual(hitTest(fib, geo, { x: 600, y: y618 + 3 }), { part: "body" }, "a level line runs on to the right edge");
  assert.equal(hitTest(fib, geo, { x: 50, y: y618 }), null, "but not to the left of the drawing");
});

test("a drawing that cannot be placed on screen is never hit", () => {
  const off: Geo = { ...geo, x: () => null };
  assert.equal(anchorsPx(d("trend", [[1, 1], [2, 2]]), off), null);
  assert.equal(hitTest(d("trend", [[1, 1], [2, 2]]), off, { x: 0, y: 0 }), null);
  assert.equal(anchorsPx(d("hline", [[1, NaN]]), { ...geo, y: () => NaN }), null);
});

test("moving a drawing, or one of its points", () => {
  const t = d("trend", [[1000, 110], [3000, 130]]);
  assert.deepEqual(translate(t, 500, -5).points, [{ t: 1500, p: 105 }, { t: 3500, p: 125 }]);
  assert.deepEqual(moveAnchor(t, 1, { t: 4000, p: 140 }).points, [{ t: 1000, p: 110 }, { t: 4000, p: 140 }]);
  assert.deepEqual(t.points[1], { t: 3000, p: 130 }, "the original is untouched");
});

test("stored drawings are only trusted when they are well formed", () => {
  const good = d("fib", [[1000, 110], [3000, 130]]);
  const list = sanitizeDrawings([
    good,
    { ...good, id: "x2", kind: "wormhole" },
    { ...good, id: "x3", points: [{ t: 1, p: 1 }] }, // a fib needs two
    { ...good, id: "x4", points: [{ t: NaN, p: 1 }, { t: 2, p: 2 }] },
    { ...good, id: "x5", points: [{ t: 1, p: 1e20 }, { t: 2, p: 2 }] },
    { ...good, id: "x6", color: "red; background:url(x)" },
    { ...good, id: "../../etc" },
    { ...good, id: "x1" }, // a repeated id
    null,
    "junk",
    5,
  ]);
  assert.equal(list.length, 4);
  assert.equal(list[0].id, "x1");
  assert.equal(list[1].color, PALETTE[0].hex, "a colour that is not #rrggbb becomes the default");
  assert.ok(list.every((x) => /^[a-z0-9]{1,32}$/.test(x.id)), "ids are plain");
  assert.equal(new Set(list.map((x) => x.id)).size, list.length, "and unique");
  assert.deepEqual(sanitizeDrawings("nope"), []);
  assert.equal(sanitizeDrawings(Array.from({ length: 200 }, () => ({ ...good, id: newDrawingId() }))).length, 60);
  assert.deepEqual(Object.keys(POINTS_NEEDED).sort(), ["fib", "hline", "ray", "rect", "trend", "vline"]);
});

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

test("drawings are kept per asset, and a broken or blocked store changes nothing", () => {
  const s = memory();
  const a = d("trend", [[1000, 110], [3000, 130]]);
  saveDrawings(s, "GARTH", [a]);
  saveDrawings(s, "CFB", [{ ...a, id: "x9" }]);
  assert.equal(loadDrawings(s, "GARTH").length, 1);
  assert.equal(loadDrawings(s, "GARTH")[0].id, "x1");
  assert.equal(loadDrawings(s, "CFB")[0].id, "x9");
  assert.deepEqual(loadDrawings(s, "NONE"), []);
  assert.deepEqual(loadDrawings(s, "__proto__"), [], "an asset called __proto__ is just unknown");
  saveDrawings(s, "GARTH", []);
  assert.deepEqual(loadDrawings(s, "GARTH"), [], "an emptied asset is removed");
  assert.ok(!(s.data.get("qmax.chart.drawings.v1") ?? "").includes("GARTH"));
  s.data.set("qmax.chart.drawings.v1", "{not json");
  assert.deepEqual(loadDrawings(s, "CFB"), []);
  saveDrawings(s, "CFB", [a]); // writes over the broken value
  assert.equal(loadDrawings(s, "CFB").length, 1);
  assert.deepEqual(loadDrawings(null, "CFB"), []);
  assert.doesNotThrow(() => saveDrawings(null, "CFB", [a]));
  assert.doesNotThrow(() => saveDrawings({ getItem: () => null, setItem: () => { throw new Error("full"); } }, "CFB", [a]));
  // Only the 40 most recently saved assets are kept.
  const big = memory();
  for (let i = 0; i < 60; i++) saveDrawings(big, `A${i}`, [a]);
  assert.equal(Object.keys(JSON.parse(big.data.get("qmax.chart.drawings.v1")!)).length, 40);
  assert.equal(loadDrawings(big, "A59").length, 1);
  assert.equal(loadDrawings(big, "A0").length, 0);
});
