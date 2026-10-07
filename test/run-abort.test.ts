import test from "node:test";
import assert from "node:assert/strict";
import { PAYWALL } from "../src/config.ts";
import type { TxStep } from "../src/exec.ts";
import { runSteps } from "../web/exec/run.ts";
import type { StepChain, StepState } from "../web/exec/run.ts";

const WALLET = PAYWALL.recipient;
const step = (id: string): TxStep => ({ id, kind: "qx-bid", description: id, to: { contractIndex: 1 }, inputType: 6, amountQu: 0, payload: new Uint8Array(0) });
const chainOf = (log: string[]): StepChain => {
  let n = 0;
  return { tick: async () => 5000, broadcast: async () => (log.push("broadcast"), String.fromCharCode(97 + n++).repeat(60)), wait: async () => ({ included: true, moneyFlew: true }) };
};

test("closing the window between two steps stops the second: it is not signed, not sent", async () => {
  const log: string[] = [];
  const ctl = new AbortController();
  const states: Record<string, StepState["status"]> = {};
  const sign = async () => (log.push("sign"), { tx: new Uint8Array(4) });
  const ok = await runSteps(WALLET, [step("first"), step("second")], sign, (id, s) => {
    states[id] = s.status;
    if (id === "first" && s.status === "done") ctl.abort(); // the window goes away once the first step has landed
  }, undefined, chainOf(log), ctl.signal);
  assert.equal(ok, false);
  assert.deepEqual(log, ["sign", "broadcast"], "one step was signed and sent, the second never reached the wallet");
  assert.deepEqual(states, { first: "done", second: "failed" });
});

test("a wallet that answers after the window is gone does not get its transaction broadcast", async () => {
  const log: string[] = [];
  const ctl = new AbortController();
  const sign = async () => {
    ctl.abort(); // the person closed the window while the wallet was asking them
    return { tx: new Uint8Array(4) };
  };
  const ok = await runSteps(WALLET, [step("only")], sign, () => {}, undefined, chainOf(log), ctl.signal);
  assert.equal(ok, false);
  assert.deepEqual(log, [], "nothing was broadcast");
});

test("without a signal it runs every step as before", async () => {
  const log: string[] = [];
  const ok = await runSteps(WALLET, [step("a"), step("b")], async () => ({ tx: new Uint8Array(4) }), () => {}, undefined, chainOf(log));
  assert.equal(ok, true);
  assert.deepEqual(log, ["broadcast", "broadcast"]);
});
