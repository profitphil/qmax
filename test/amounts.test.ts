import test from "node:test";
import assert from "node:assert/strict";
import { presetLabel, presetsFor } from "../src/amounts.ts";

test("smart contract shares get small quick amounts and tokens get big ones", () => {
  assert.deepEqual(presetsFor("contract"), [1, 2, 5, 10]);
  assert.deepEqual(presetsFor("token"), [100_000, 500_000, 1_000_000, 10_000_000]);
});

test("every quick amount is a positive whole number and they rise", () => {
  for (const c of ["contract", "token"] as const) {
    const list = presetsFor(c);
    assert.ok(list.every((n) => Number.isInteger(n) && n > 0));
    assert.deepEqual([...list], [...list].sort((a, b) => a - b));
  }
});

test("the labels are short", () => {
  assert.deepEqual(presetsFor("contract").map(presetLabel), ["1", "2", "5", "10"]);
  assert.deepEqual(presetsFor("token").map(presetLabel), ["100K", "500K", "1M", "10M"]);
});
