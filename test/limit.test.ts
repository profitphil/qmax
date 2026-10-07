import test from "node:test";
import assert from "node:assert/strict";
import type { BookRow } from "../src/book.ts";
import type { ExecutionPlan } from "../src/exec.ts";
import { assetNameToU64, identityToBytes } from "../src/identity.ts";
import { MAX_AMOUNT, buildLimitPlan, checkLimitPlan, farFromMarket, limitProblem, placement } from "../src/limit.ts";
import type { LimitExpectation, LimitPlanInput } from "../src/limit.ts";
import { assessLimitReadiness } from "../src/readiness.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const OTHER = "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE";
const FEES = { qx: 100, qswap: 200 };
const input = (o: Partial<LimitPlanInput> = {}): LimitPlanInput => ({ side: "buy", price: 10, qty: 500, assetName: "CFB", issuer: ISSUER, fees: FEES, ...o });
const expectation = (o: Partial<LimitExpectation> = {}): LimitExpectation => ({ side: "buy", price: 10, qty: 500, assetName: "CFB", issuer: ISSUER, onChainFees: FEES, ...o });
const row = (price: number, qty: number): BookRow => ({ price, qty, orders: 1, cumQty: 0, cumQu: 0 });
const clone = (p: ExecutionPlan): ExecutionPlan => ({ maxOutlayQu: p.maxOutlayQu, steps: p.steps.map((s) => ({ ...s, payload: new Uint8Array(s.payload) })) });

test("a price or amount that cannot be an order is named, a good one passes", () => {
  assert.equal(limitProblem({ side: "buy", price: 10, qty: 5 }), null);
  assert.match(limitProblem({ side: "buy", price: 10, qty: 0 })!, /whole number of units/);
  assert.match(limitProblem({ side: "buy", price: 10, qty: 1.5 })!, /whole number of units/);
  assert.match(limitProblem({ side: "sell", price: 0, qty: 5 })!, /whole number of QU/);
  assert.match(limitProblem({ side: "sell", price: 2.5, qty: 5 })!, /whole number of QU/);
  assert.match(limitProblem({ side: "buy", price: -3, qty: 5 })!, /whole number of QU/);
  assert.match(limitProblem({ side: "buy", price: Math.floor(MAX_AMOUNT / 2), qty: 2 })!, /too large/);
  assert.match(limitProblem({ side: "buy", price: Number.MAX_SAFE_INTEGER, qty: 3 })!, /too large/);
  assert.match(limitProblem({ side: "buy", price: NaN, qty: 3 })!, /whole number/);
});

test("a limit buy is one QX bid at the chosen price that attaches price times units", () => {
  const plan = buildLimitPlan(input({ side: "buy", price: 7, qty: 300 }));
  assert.equal(plan.steps.length, 1);
  const s = plan.steps[0];
  assert.equal(s.kind, "qx-bid");
  assert.deepEqual(s.to, { contractIndex: 1 });
  assert.equal(s.inputType, 6);
  assert.equal(s.amountQu, 2100);
  assert.equal(plan.maxOutlayQu, 2100);
  const v = new DataView(s.payload.buffer, s.payload.byteOffset, s.payload.byteLength);
  assert.deepEqual([...s.payload.slice(0, 32)], [...identityToBytes(ISSUER)]);
  assert.equal(v.getBigUint64(32, true), assetNameToU64("CFB"));
  assert.equal(v.getBigInt64(40, true), 7n);
  assert.equal(v.getBigInt64(48, true), 300n);
  assert.match(s.description, /limit order/);
  assert.deepEqual(checkLimitPlan(plan, expectation({ price: 7, qty: 300 })).problems, []);
});

test("a limit sale is one QX ask that attaches nothing when the shares are already with QX", () => {
  const plan = buildLimitPlan(input({ side: "sell", price: 12, qty: 40, holdings: { 1: 100, 13: 0 } }));
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].kind, "qx-ask");
  assert.equal(plan.steps[0].inputType, 5);
  assert.equal(plan.steps[0].amountQu, 0);
  assert.equal(plan.maxOutlayQu, 0);
  assert.deepEqual(checkLimitPlan(plan, expectation({ side: "sell", price: 12, qty: 40 })).problems, []);
});

test("a sale of shares QSwap manages first moves just what is short to QX, for QX's fee", () => {
  const plan = buildLimitPlan(input({ side: "sell", price: 12, qty: 80, holdings: { 1: 30, 13: 100 } }));
  assert.deepEqual(plan.steps.map((s) => s.kind), ["transfer-rights", "qx-ask"]);
  assert.equal(plan.steps[0].amountQu, FEES.qx);
  assert.equal(plan.maxOutlayQu, FEES.qx);
  assert.deepEqual(checkLimitPlan(plan, expectation({ side: "sell", price: 12, qty: 80 })).problems, []);
});

test("units already offered in other open sell orders are not offered again", () => {
  assert.throws(() => buildLimitPlan(input({ side: "sell", qty: 80, holdings: { 1: 100, 13: 0 }, restingAskQty: 50 })), /You can sell 50 CFB here, not 80.*already offered/);
  // QSwap's shares are free, so they make up the difference
  const plan = buildLimitPlan(input({ side: "sell", qty: 80, holdings: { 1: 100, 13: 40 }, restingAskQty: 50 }));
  assert.deepEqual(plan.steps.map((s) => s.kind), ["transfer-rights", "qx-ask"]);
  assert.throws(() => buildLimitPlan(input({ side: "sell", qty: 10, holdings: {} })), /You can sell 0 CFB here/);
});

test("the check refuses a plan that is not exactly the order: wrong price, units, asset, issuer, amount or place", () => {
  const good = buildLimitPlan(input({ side: "buy", price: 10, qty: 500 }));
  const e = expectation();
  assert.deepEqual(checkLimitPlan(good, e).problems, []);
  const view = (p: ExecutionPlan) => new DataView(p.steps[0].payload.buffer, p.steps[0].payload.byteOffset);

  let p = clone(good);
  view(p).setBigInt64(40, 11n, true);
  assert.match(checkLimitPlan(p, e).problems.join(), /price is not 10/);
  p = clone(good);
  view(p).setBigInt64(48, 501n, true);
  assert.match(checkLimitPlan(p, e).problems.join(), /units are not 500/);
  p = clone(good);
  p.steps[0].payload.set(identityToBytes(OTHER), 0);
  assert.match(checkLimitPlan(p, e).problems.join(), /different asset or issuer/);
  p = clone(good);
  view(p).setBigUint64(32, assetNameToU64("XYZ"), true);
  assert.match(checkLimitPlan(p, e).problems.join(), /different asset or issuer/);
  p = clone(good);
  p.steps[0].amountQu = 6000;
  p.maxOutlayQu = 6000;
  assert.match(checkLimitPlan(p, e).problems.join(), /attaches 6,000 QU, not 5,000/);
  p = clone(good);
  p.steps[0].to = { contractIndex: 13 };
  assert.match(checkLimitPlan(p, e).problems.join(), /not sent to QX/);
  p = clone(good);
  p.steps[0].to = { identity: OTHER };
  assert.match(checkLimitPlan(p, e).problems.join(), /not sent to a contract/);
  p = clone(good);
  p.steps[0].inputType = 5;
  assert.match(checkLimitPlan(p, e).problems.join(), /different kind of call/);
  p = clone(good);
  p.maxOutlayQu = 1;
  assert.match(checkLimitPlan(p, e).problems.join(), /do not add up/);
});

test("the check refuses extra steps, a payment, a second order, and a share move that is too big, costs more, or goes elsewhere", () => {
  const sell = buildLimitPlan(input({ side: "sell", price: 12, qty: 80, holdings: { 1: 30, 13: 100 } }));
  const e = expectation({ side: "sell", price: 12, qty: 80 });
  assert.deepEqual(checkLimitPlan(sell, e).problems, []);

  let p = clone(sell);
  p.steps.push({ ...p.steps[1], id: "again" });
  p.maxOutlayQu += 0;
  assert.match(checkLimitPlan(p, e).problems.join(), /2 order steps/);
  p = clone(sell);
  p.steps.push({ id: "pay", kind: "payment", description: "pay", to: { identity: OTHER }, inputType: 0, amountQu: 5, payload: new Uint8Array(0) });
  p.maxOutlayQu += 5;
  assert.match(checkLimitPlan(p, e).problems.join(), /payment, which a limit order never needs|not sent to a contract/);
  p = clone(sell);
  p.steps[0].amountQu = 999;
  p.maxOutlayQu = 999;
  assert.match(checkLimitPlan(p, e).problems.join(), /QX's fee is 100/);
  p = clone(sell);
  new DataView(p.steps[0].payload.buffer, p.steps[0].payload.byteOffset).setBigInt64(40, 9999n, true);
  assert.match(checkLimitPlan(p, e).problems.join(), /outside what this order needs/);
  p = clone(sell);
  new DataView(p.steps[0].payload.buffer, p.steps[0].payload.byteOffset).setUint32(48, 13, true);
  assert.match(checkLimitPlan(p, e).problems.join(), /something other than QX/);
  // a buy never moves shares
  const buy = buildLimitPlan(input());
  const withMove = { maxOutlayQu: buy.maxOutlayQu + 100, steps: [sell.steps[0], ...buy.steps] };
  assert.match(checkLimitPlan(withMove, expectation()).problems.join(), /buy needs no share move/);
});

test("a buy that crosses the book fills now at the resting prices, never at its own", () => {
  const asks = [row(10, 100), row(11, 100), row(14, 500)];
  const p = placement({ side: "buy", price: 12, qty: 250 }, { asks, bids: [row(9, 100)] });
  assert.equal(p?.kind, "fills-now");
  if (p?.kind !== "fills-now") return;
  assert.equal(p.fillQty, 200);
  assert.equal(p.restQty, 50);
  assert.equal(p.costQu, 100 * 10 + 100 * 11);
  assert.equal(p.avgPrice, 10.5);
  assert.equal(p.atLeast, false);
  // wholly inside the first level
  const small = placement({ side: "buy", price: 10, qty: 30 }, { asks, bids: [] });
  assert.ok(small?.kind === "fills-now" && small.fillQty === 30 && small.restQty === 0 && small.costQu === 300);
});

test("a buy below the best ask and a sale above the best bid wait on the book, and say how far off they are", () => {
  const book = { asks: [row(10, 100)], bids: [row(8, 100)] };
  const buy = placement({ side: "buy", price: 9, qty: 50 }, book);
  assert.deepEqual(buy, { kind: "rests", away: 10 });
  const sell = placement({ side: "sell", price: 10, qty: 50 }, book);
  assert.equal(sell?.kind, "rests");
  assert.ok(sell?.kind === "rests" && sell.away !== null && Math.abs(sell.away - 25) < 1e-9);
  // nothing on the other side: it waits and there is nothing to measure against
  assert.deepEqual(placement({ side: "buy", price: 9, qty: 5 }, { asks: [], bids: [] }), { kind: "rests", away: null });
  assert.equal(placement({ side: "buy", price: 9, qty: 5 }, null), null);
});

test("a sale that crosses the bids sells to the best first", () => {
  const bids = [row(10, 60), row(9, 60), row(5, 500)];
  const p = placement({ side: "sell", price: 8, qty: 100 }, { asks: [], bids });
  assert.ok(p?.kind === "fills-now");
  if (p?.kind !== "fills-now") return;
  assert.equal(p.fillQty, 100);
  assert.equal(p.costQu, 60 * 10 + 40 * 9);
  assert.equal(p.restQty, 0);
});

test("when the rows shown run out while still matching, the fill is marked as a minimum", () => {
  const p = placement({ side: "buy", price: 50, qty: 1000 }, { asks: [row(10, 100), row(11, 100)], bids: [], asksTotal: { levels: 40 } });
  assert.ok(p?.kind === "fills-now" && p.atLeast === true && p.fillQty === 200);
  const whole = placement({ side: "buy", price: 50, qty: 1000 }, { asks: [row(10, 100), row(11, 100)], bids: [], asksTotal: { levels: 2 } });
  assert.ok(whole?.kind === "fills-now" && whole.atLeast === false);
});

test("how far a price is from the middle of the book", () => {
  assert.equal(farFromMarket(110, 90, 110), 10);
  assert.equal(farFromMarket(90, 90, 110), -10);
  assert.equal(farFromMarket(100, null, 110), null);
  assert.equal(farFromMarket(100, 90, undefined), null);
});

const ready = (o: Partial<Parameters<typeof assessLimitReadiness>[0]> = {}) => assessLimitReadiness({ side: "buy", qty: 100, price: 10, connected: true, hasPass: true, passRequired: false, balanceQu: 5000, heldQty: 0, onQx: true, problem: null, ...o });

test("a limit order is ready when connected, on QX, valid, and backed by QU (a buy) or units (a sale)", () => {
  assert.equal(ready().ready, true);
  assert.equal(ready({ side: "sell", heldQty: 100, balanceQu: 0 }).ready, true);
});

test("a limit order is not ready without a wallet, on a pool-only asset, with a bad price, or without the QU or units", () => {
  assert.equal(ready({ connected: false }).ready, false);
  const pool = ready({ onQx: false });
  assert.equal(pool.ready, false);
  assert.match(pool.checks.find((c) => c.id === "liquidity")!.label, /needs QX/);
  assert.equal(ready({ problem: "The price must be a whole number" }).ready, false);
  const poor = ready({ balanceQu: 999 });
  assert.equal(poor.ready, false);
  assert.match(poor.checks.find((c) => c.id === "fees")!.detail!, /Needs 1,000 QU; you have 999 QU/);
  assert.equal(ready({ balanceQu: 1000 }).ready, true);
  const short = ready({ side: "sell", heldQty: 99 });
  assert.equal(short.ready, false);
  assert.match(short.checks.find((c) => c.id === "shares")!.detail!, /hold 99/);
  assert.equal(ready({ balanceQu: null }).ready, false); // still loading
  assert.equal(ready({ hasPass: false, passRequired: true }).ready, false);
  assert.equal(ready({ hasPass: true, passRequired: true }).ready, true);
});
