import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConsolidation } from "../src/consolidate.ts";
import type { OwnedAsset } from "../src/consolidate.ts";
import { buildExecutionPlan } from "../src/exec.ts";
import type { ExecutableQuote } from "../src/exec.ts";
import { assetNameToU64, identityToBytes } from "../src/identity.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const info = { issuer: ISSUER, assetName: "CFB", transferFeeQu: { qx: 100, qswap: 250 } };
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

const splitSell = (qx: number, qswap: number): ExecutableQuote => ({
  asset: "CFB", side: "sell", assetInfo: info,
  route: [
    { venue: "QX", qty: qx, execution: { type: "qx-ask", qty: qx, limitPrice: 95 } },
    { venue: "QSwap", qty: qswap, execution: { type: "qswap-sell", qty: qswap, minQuOut: 900 } },
  ],
});

// ---- selling split through QSwap ----

test("a split sell with every share under QX first moves the QSwap part to QSwap, then trades both", () => {
  const plan = buildExecutionPlan(splitSell(60, 40), { 1: 100 });
  assert.deepEqual(plan.steps.map((s) => s.kind), ["transfer-rights", "qx-ask", "qswap-sell"]); // the move comes before the swap
  const move = plan.steps[0];
  assert.deepEqual(move.to, { contractIndex: 1 }); // called on QX, which manages them now
  assert.equal(move.inputType, 9);
  assert.equal(move.amountQu, 250); // the fee goes to the contract taking them over: QSwap
  assert.equal(view(move.payload).getBigInt64(40, true), 40n); // only what the swap needs, so the QX leg keeps its 60
  assert.equal(view(move.payload).getUint32(48, true), 13);
  assert.match(move.description, /Move 40 CFB from QX to QSwap management so QSwap can sell them/);
});

test("shares already under QSwap need no move, and a mixed holding moves only the shortfall", () => {
  assert.deepEqual(buildExecutionPlan(splitSell(60, 40), { 1: 60, 13: 40 }).steps.map((s) => s.kind), ["qx-ask", "qswap-sell"]);
  const mixed = buildExecutionPlan(splitSell(60, 40), { 1: 70, 13: 30 });
  assert.equal(view(mixed.steps[0].payload).getBigInt64(40, true), 10n); // 40 needed at QSwap, 30 already there
});

test("a split sell with every share under QSwap moves the QX part to QX", () => {
  const plan = buildExecutionPlan(splitSell(60, 40), { 13: 100 });
  const move = plan.steps[0];
  assert.deepEqual(move.to, { contractIndex: 13 });
  assert.equal(move.inputType, 11); // QSwap's own transfer call
  assert.equal(move.amountQu, 100); // QX's fee
  assert.equal(view(move.payload).getBigInt64(40, true), 60n);
  assert.equal(view(move.payload).getUint32(48, true), 1);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["transfer-rights", "qx-ask", "qswap-sell"]);
});

test("selling only through QSwap moves everything it needs there", () => {
  const q: ExecutableQuote = { ...splitSell(0, 100), route: [splitSell(0, 100).route[1]] };
  const plan = buildExecutionPlan(q, { 1: 100 });
  assert.deepEqual(plan.steps.map((s) => s.kind), ["transfer-rights", "qswap-sell"]);
  assert.equal(view(plan.steps[0].payload).getBigInt64(40, true), 100n);
});

test("shares managed by anything else cannot be sold here, and the error says so", () => {
  assert.throws(() => buildExecutionPlan(splitSell(60, 40), { 1: 30, 29: 200 }), /Insufficient CFB: need 100, wallet has 30 on QX\/QSwap/);
});

// ---- keeping everything under one contract ----

const owned: OwnedAsset[] = [
  { symbol: "CFB", issuer: ISSUER, assetName: "CFB", holdings: { 1: 100, 13: 40 } },
  { symbol: "QXMR", issuer: ISSUER, assetName: "QXMR", holdings: { 13: 25 } },
  { symbol: "MLM", issuer: ISSUER, assetName: "MLM", holdings: { 1: 7 } },
  { symbol: "STAKED", issuer: ISSUER, assetName: "STAKED", holdings: { 1: 5, 29: 300 } },
];

test("moving everything to QX takes only the QSwap shares, one step per asset, with QX's fee", () => {
  const c = buildConsolidation(owned, "qx", { qx: 100, qswap: 250 });
  assert.deepEqual(c.moves, [{ symbol: "CFB", qty: 40, from: "qswap" }, { symbol: "QXMR", qty: 25, from: "qswap" }]);
  assert.equal(c.steps.length, 2);
  for (const s of c.steps) {
    assert.deepEqual(s.to, { contractIndex: 13 });
    assert.equal(s.inputType, 11);
    assert.equal(s.amountQu, 100);
  }
  assert.equal(view(c.steps[0].payload).getBigInt64(40, true), 40n);
  assert.equal(view(c.steps[0].payload).getUint32(48, true), 1);
  assert.equal(view(c.steps[1].payload).getBigUint64(32, true), assetNameToU64("QXMR"));
  assert.deepEqual([...c.steps[0].payload.slice(0, 32)], [...identityToBytes(ISSUER)]);
  assert.equal(c.feeQu, 200);
  assert.notEqual(c.steps[0].id, c.steps[1].id);
});

test("moving everything to QSwap takes the QX shares, with QSwap's fee", () => {
  const c = buildConsolidation(owned, "qswap", { qx: 100, qswap: 250 });
  assert.deepEqual(c.moves.map((m) => [m.symbol, m.qty, m.from]), [["CFB", 100, "qx"], ["MLM", 7, "qx"], ["STAKED", 5, "qx"]]);
  assert.equal(c.feeQu, 750);
  for (const s of c.steps) assert.deepEqual([s.to, s.inputType], [{ contractIndex: 1 }, 9]);
});

test("shares under some other contract are reported, not moved, and nothing to do is an empty plan", () => {
  const c = buildConsolidation(owned, "qx", { qx: 100, qswap: 250 });
  assert.deepEqual(c.stuck, [{ symbol: "STAKED", contractIndex: 29, qty: 300 }]);
  const done = buildConsolidation([owned[2]], "qx", { qx: 100, qswap: 250 });
  assert.deepEqual([done.steps.length, done.feeQu, done.stuck.length], [0, 0, 0]);
});

// ---- the question asked while a buy is built ----
import { previewKeep } from "../src/consolidate.ts";

test("the preview says what keeping under QX adds to a buy, from the route", () => {
  const fees = { qx: 100, qswap: 250 };
  const split = [{ venue: "QX", qty: 600 }, { venue: "QSwap", qty: 400 }];
  const text = previewKeep({ asset: "CFB", route: split, fees, to: "qx" });
  assert.match(text, /move 400 CFB from QSwap to QX \(fee about 100 QU\)/);
  assert.match(text, /plus any CFB you already hold under QSwap/);
  assert.doesNotMatch(text, /up to/); // a QSwap buy is for an exact amount
});

test("a buy that already lands where the person wants it has nothing to move", () => {
  const text = previewKeep({ asset: "CFB", route: [{ venue: "QX", qty: 100 }], fees: { qx: 100, qswap: 250 }, to: "qx" });
  assert.match(text, /^Nothing to move for this buy: it lands under QX already\./);
  assert.match(text, /Any CFB you already hold under QSwap would still be moved\./);
});

test("keeping under QSwap after a QX bid is 'up to', since a bid can fill in part, and uses QSwap's fee", () => {
  const text = previewKeep({ asset: "CFB", route: [{ venue: "QX", qty: 100 }], fees: { qx: 100, qswap: 250 }, to: "qswap" });
  assert.match(text, /move up to 100 CFB from QX to QSwap \(fee about 250 QU\)/);
});
