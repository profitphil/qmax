import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSignedTx } from "../src/signedtx.ts";
import type { TxExpectation } from "../src/signedtx.ts";

const key = (n: number) => new Uint8Array(32).fill(n);

/** A transaction laid out as the network reads it: keys, amount, tick, input type, input size, input, signature. */
function build(w: TxExpectation, signature = new Uint8Array(64).fill(7)): Uint8Array {
  const out = new Uint8Array(80 + w.payload.length + 64);
  const v = new DataView(out.buffer);
  out.set(w.source, 0);
  out.set(w.dest, 32);
  v.setBigUint64(64, w.amount, true);
  v.setUint32(72, w.tick, true);
  v.setUint16(76, w.inputType, true);
  v.setUint16(78, w.payload.length, true);
  out.set(w.payload, 80);
  out.set(signature, 80 + w.payload.length);
  return out;
}

const want: TxExpectation = { source: key(1), dest: key(2), amount: 25_000n, tick: 83_000_100, inputType: 6, payload: Uint8Array.from({ length: 56 }, (_, i) => i) };

test("the bytes of the transaction that was asked for pass", () => {
  assert.equal(checkSignedTx(build(want), want), null);
  const noPayload = { ...want, payload: new Uint8Array(0), inputType: 0, amount: 1n };
  assert.equal(checkSignedTx(build(noPayload), noPayload), null);
  // a sale attaches nothing: an amount of zero is fine
  const ask = { ...want, amount: 0n, inputType: 5 };
  assert.equal(checkSignedTx(build(ask), ask), null);
});

test("anything that differs is refused, with what differs", () => {
  assert.match(checkSignedTx(build({ ...want, source: key(9) }), want)!, /different account/);
  assert.match(checkSignedTx(build({ ...want, dest: key(9) }), want)!, /different destination/);
  assert.match(checkSignedTx(build({ ...want, amount: 25_001n }), want)!, /different amount/);
  assert.match(checkSignedTx(build({ ...want, tick: want.tick + 1 }), want)!, /different tick/);
  assert.match(checkSignedTx(build({ ...want, inputType: 5 }), want)!, /different kind of call/);
  const other = Uint8Array.from(want.payload);
  other[10] ^= 1;
  assert.match(checkSignedTx(build({ ...want, payload: other }), want)!, /different data/);
});

test("an unsigned transaction, a short answer and a lying size are refused", () => {
  assert.match(checkSignedTx(build(want, new Uint8Array(64)), want)!, /no signature/);
  assert.match(checkSignedTx(new Uint8Array(100), want)!, /too short/);
  const lying = build(want);
  new DataView(lying.buffer).setUint16(78, 10, true); // says 10 bytes of input, carries 56
  assert.match(checkSignedTx(lying, want)!, /length does not match/);
  assert.match(checkSignedTx(new Uint8Array(0), want)!, /too short/);
});

test("a larger amount than a safe integer is compared exactly", () => {
  const big = { ...want, amount: 9_007_199_254_740_993n };
  assert.equal(checkSignedTx(build(big), big), null);
  assert.match(checkSignedTx(build(big), { ...big, amount: 9_007_199_254_740_992n })!, /different amount/);
});
