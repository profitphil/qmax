import test from "node:test";
import assert from "node:assert/strict";
import { quietWords, sinceLabel } from "../src/tapewords.ts";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

test("a moment is the time when it was today, and the date with it otherwise", () => {
  const now = at(2026, 10, 6, 15, 0);
  assert.equal(sinceLabel(at(2026, 10, 6, 12, 28), now), "12:28 PM today");
  assert.equal(sinceLabel(at(2026, 10, 5, 22, 5), now), "Oct 5, 10:05 PM");
});

test("with the whole day covered it says no trades in the last 24 hours", () => {
  const w = quietWords({ asset: "BITE", partial: false, coveredFromMs: null, now: at(2026, 10, 6, 15, 0) });
  assert.equal(w.headline, "No trades of BITE in the last 24 hours");
  assert.match(w.detail, /BITE has not traded on QX or QSwap in the last 24 hours/);
  assert.equal(quietWords({ partial: false, coveredFromMs: null, now: 0 }).headline, "No trades in the last 24 hours");
  assert.match(quietWords({ partial: false, coveredFromMs: null, now: 0 }).detail, /^Nothing has traded/);
});

test("when the feed began part-way through the day it says since when, and that earlier trades may exist", () => {
  const now = at(2026, 10, 6, 15, 0);
  const w = quietWords({ asset: "BITE", partial: true, coveredFromMs: at(2026, 10, 6, 12, 28), now });
  assert.equal(w.headline, "No trades of BITE since 12:28 PM today");
  assert.match(w.detail, /live feed began, at 12:28 PM today/);
  assert.match(w.detail, /older trades/);
  assert.equal(quietWords({ partial: true, coveredFromMs: at(2026, 10, 5, 9, 0), now }).headline, "No trades since Oct 5, 9:00 AM");
});

test("a partial feed with no known start falls back to the plain last-24-hours wording", () => {
  assert.equal(quietWords({ asset: "X", partial: true, coveredFromMs: null, now: 0 }).headline, "No trades of X in the last 24 hours");
});
