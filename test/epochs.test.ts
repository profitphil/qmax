import test from "node:test";
import assert from "node:assert/strict";
import { EPOCH_MS, epochAt, epochStartMs, epochsIn } from "../src/epochs.ts";

test("an epoch begins on a Wednesday at 12:00 UTC and lasts a week", () => {
  for (const e of [207, 215, 233, 240]) {
    const d = new Date(epochStartMs(e));
    assert.equal(d.getUTCDay(), 3, `epoch ${e} starts on a Wednesday`);
    assert.equal(d.getUTCHours(), 12);
    assert.equal(d.getUTCMinutes(), 0);
  }
  assert.equal(epochStartMs(208) - epochStartMs(207), EPOCH_MS);
});

test("the epoch at a time matches what the network said: 233 on 2026-10-06", () => {
  assert.equal(epochAt(Date.UTC(2026, 9, 6, 13, 26)), 233);
  assert.equal(epochAt(Date.UTC(2026, 3, 1, 12, 0)), 207);
  assert.equal(epochAt(Date.UTC(2026, 3, 1, 11, 59)), 206);
  assert.equal(epochAt(Date.UTC(2026, 8, 30, 12, 0)), 233);
  assert.equal(epochAt(Date.UTC(2026, 8, 30, 11, 59)), 232);
});

test("epochsIn lists the starts inside a range, ends included, oldest first", () => {
  const a = epochStartMs(210);
  const out = epochsIn(a, epochStartMs(213));
  assert.deepEqual(out.map((e) => e.epoch), [210, 211, 212, 213]);
  assert.equal(out[0].startMs, a);
  // a range between two starts holds none
  assert.deepEqual(epochsIn(a + 1, a + EPOCH_MS - 1), []);
  // one start just inside
  assert.deepEqual(epochsIn(a + 1, a + EPOCH_MS).map((e) => e.epoch), [211]);
});

test("epochsIn is empty for a backwards or unusable range", () => {
  assert.deepEqual(epochsIn(10, 5), []);
  assert.deepEqual(epochsIn(NaN, 5), []);
  assert.deepEqual(epochsIn(0, Infinity), []);
});
