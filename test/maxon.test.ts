import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_KEY, readMaxOn, showMaxButton } from "../web/maxon.ts";

const store = (v: string | null) => ({ getItem: (k: string) => (k === MAX_KEY ? v : null) });

test("Max mode is on for a new visitor and stays on unless the person switched it off", () => {
  assert.equal(readMaxOn(store(null)), true, "nothing stored: on");
  assert.equal(readMaxOn(store("1")), true);
  assert.equal(readMaxOn(store("0")), false, "the person's own choice to switch it off");
  assert.equal(readMaxOn(store("")), true, "anything but their explicit off is on");
  assert.equal(readMaxOn(null), true, "no storage at all (a private window, a server): on");
  assert.equal(readMaxOn(undefined), true);
  assert.equal(readMaxOn({ getItem: () => { throw new Error("blocked"); } }), true, "a browser that blocks storage");
});

test("the Max button is not offered over a limit order, which has a price of its own", () => {
  assert.equal(showMaxButton(true, true, false), true, "a market order with Max on: Max is the main button");
  assert.equal(showMaxButton(true, true, true), false, "a limit order: only the limit button, Max plans a fill-now trade that ignores the typed price");
  assert.equal(showMaxButton(false, true, false), false, "Max switched off");
  assert.equal(showMaxButton(true, false, false), false, "no wallet connected: the Connect button leads");
});
