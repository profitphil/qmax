import test from "node:test";
import assert from "node:assert/strict";
import { clock, dialogTone, tradeCard } from "../src/tradecard.ts";
import type { CardInput } from "../src/tradecard.ts";

const steps = [
  { id: "a", description: "Move 10 QMINE shares to QX" },
  { id: "b", description: "Place the order on QX" },
];
const base: CardInput = { steps, states: {}, running: false, finished: null, checking: false, verdict: null };
const card = (o: Partial<CardInput>) => tradeCard({ ...base, ...o });

test("before anything is signed the card is idle and empty", () => {
  const c = card({});
  assert.equal(c.tone, "idle");
  assert.equal(c.percent, 0);
  assert.equal(c.step, null);
  assert.deepEqual(c.segments.map((s) => s.state), ["pending", "pending", "pending"]); // two steps and the wallet check
});

test("while the wallet is asked it says so, and names the step", () => {
  const c = card({ running: true, states: { a: { status: "signing" } } });
  assert.equal(c.tone, "working");
  assert.equal(c.title, "Waiting for your wallet");
  assert.match(c.detail, /Step 1 of 2: Move 10 QMINE shares/);
  assert.deepEqual(c.step, { at: 1, of: 2 });
  assert.deepEqual(c.segments.map((s) => s.state), ["active", "pending", "pending"]);
});

test("once sent, it is confirming on-chain, and the second step is the one counted", () => {
  const c = card({ running: true, states: { a: { status: "done" }, b: { status: "confirming" } } });
  assert.equal(c.title, "Confirming on-chain");
  assert.match(c.detail, /Step 2 of 2: Place the order on QX · waiting to be included/);
  assert.deepEqual(c.step, { at: 2, of: 2 });
  assert.deepEqual(c.segments.map((s) => s.state), ["done", "active", "pending"]);
});

test("a single-step trade does not talk about step 1 of 1", () => {
  const c = card({ steps: [steps[0]], running: true, states: { a: { status: "signing" } } });
  assert.doesNotMatch(c.detail, /Step 1 of 1/);
  assert.match(c.detail, /Move 10 QMINE/);
});

test("progress only goes forward as the steps do, and never reaches 100 before the wallet check agrees", () => {
  const stages: CardInput["states"][] = [
    {},
    { a: { status: "signing" } },
    { a: { status: "confirming" } },
    { a: { status: "done" } },
    { a: { status: "done" }, b: { status: "signing" } },
    { a: { status: "done" }, b: { status: "confirming" } },
    { a: { status: "done" }, b: { status: "done" } },
  ];
  const pcts = stages.map((states, i) => card({ running: i > 0 && i < 6, states, finished: i === 6 ? true : null }).percent);
  for (let i = 1; i < pcts.length; i++) assert.ok(pcts[i] >= pcts[i - 1], `${pcts.join(",")} should not go back`);
  assert.ok(pcts.every((p) => p < 100), `${pcts.join(",")}: not done until it is checked`);
});

test("all steps through: confirmed, then the wallet is being read", () => {
  const states = { a: { status: "done" }, b: { status: "done" } };
  const c = card({ states, finished: true, checking: true });
  assert.equal(c.tone, "working");
  assert.equal(c.title, "Confirmed on-chain");
  assert.deepEqual(c.segments.map((s) => s.state), ["done", "done", "active"]);
  assert.ok(c.percent > 80 && c.percent < 100);
});

test("a filled trade is a success at 100 per cent, with the title the dialog gave it", () => {
  const states = { a: { status: "done" }, b: { status: "done" } };
  const c = card({ states, finished: true, verdict: "good", labels: { success: "Order placed" } });
  assert.equal(c.tone, "success");
  assert.equal(c.title, "Order placed");
  assert.equal(c.percent, 100);
  assert.ok(c.segments.every((s) => s.state === "done"));
});

test("part of a fill, or nothing moved yet, is not called a success", () => {
  const states = { a: { status: "done" }, b: { status: "done" } };
  const partial = card({ states, finished: true, verdict: "partial" });
  assert.equal(partial.tone, "attention");
  assert.equal(partial.title, "Partly done");
  assert.ok(partial.percent < 100);
  const none = card({ states, finished: true, verdict: "none" });
  assert.equal(none.tone, "attention");
  assert.match(none.detail, /explorer/);
});

test("steps that went through but a wallet that could not be read afterwards is attention, with what went wrong", () => {
  const states = { a: { status: "done" }, b: { status: "done" } };
  const c = card({ states, finished: true, note: "Could not read the wallet after the trade: timeout\nmore" });
  assert.equal(c.tone, "attention");
  assert.equal(c.detail, "Could not read the wallet after the trade: timeout");
});

test("a step that fails stops the card: failed, which step, and the reason", () => {
  const states = { a: { status: "done" }, b: { status: "failed", error: "Signing took too long and the tick expired. Please try again.\nsecond line" } };
  const c = card({ states, finished: false });
  assert.equal(c.tone, "failed");
  assert.equal(c.title, "Stopped at step 2 of 2");
  assert.equal(c.detail, "Signing took too long and the tick expired. Please try again.");
  assert.deepEqual(c.segments.map((s) => s.state), ["done", "failed", "pending"]);
  assert.ok(c.percent < 100);
});

test("a one-step trade that fails is just \"failed\"", () => {
  const c = card({ steps: [steps[0]], states: { a: { status: "failed", error: "Rejected in the wallet" } }, finished: false });
  assert.equal(c.title, "The trade failed");
  assert.equal(c.detail, "Rejected in the wallet");
});

test("between two steps, with nothing being signed, it says what it is doing instead", () => {
  const states = { a: { status: "done" } };
  const reading = card({ states, running: false, checking: true });
  assert.equal(reading.tone, "working");
  assert.equal(reading.title, "Checking your wallet");
  const asking = card({ states, running: false, checking: false });
  assert.equal(asking.title, "Ready for the next step");
  assert.match(asking.detail, /Step 2 of 2: Place the order on QX/);
});

test("a stop with no failed step says why in its own words", () => {
  const c = card({ states: { a: { status: "done" } }, finished: false, reason: "Your wallet now holds less QU than the second trade attaches, so it was not sent." });
  assert.equal(c.tone, "failed");
  assert.match(c.detail, /less QU than the second trade attaches/);
  assert.equal(c.title, "The trade failed");
});

test("the dialog is outlined by the card, and a trade refused before anything was signed counts as failed", () => {
  assert.equal(dialogTone(null, false), "idle");
  assert.equal(dialogTone(null, true), "failed");
  assert.equal(dialogTone(card({}), true), "failed", "idle card plus a pre-flight error");
  assert.equal(dialogTone(card({ running: true, states: { a: { status: "signing" } } }), false), "working");
  assert.equal(dialogTone(card({ states: { a: { status: "done" }, b: { status: "done" } }, finished: true, verdict: "good" }), false), "success");
});

test("the clock reads m:ss", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(7.9), "0:07");
  assert.equal(clock(65), "1:05");
  assert.equal(clock(-3), "0:00");
  assert.equal(clock(600), "10:00");
});
