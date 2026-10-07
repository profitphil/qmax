import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PAYWALL } from "../src/config.ts";
import type { TxStep } from "../src/exec.ts";
import { runSteps, setStepListener } from "../web/exec/run.ts";
import type { StepChain } from "../web/exec/run.ts";
import { rememberRef, reportTrade, startUsageReporting } from "../web/usage.ts";

const WALLET = PAYWALL.recipient; // any valid identity will do as a source
const step = (id: string, kind: TxStep["kind"], inputType: number): TxStep => ({ id, kind, description: id, to: { contractIndex: 1 }, inputType, amountQu: 0, payload: new Uint8Array(0) });
const sign = async () => ({ tx: new Uint8Array(4) });
const chain = (included = true): StepChain => {
  let n = 0;
  return { tick: async () => 5000, broadcast: async () => String.fromCharCode(97 + n++).repeat(60), wait: async () => ({ included, moneyFlew: true }) };
};

const g = globalThis as unknown as Record<string, unknown>;
const real = { fetch: g.fetch, localStorage: g.localStorage };
afterEach(() => {
  setStepListener(undefined);
  rememberRef(undefined);
  g.fetch = real.fetch;
  if (real.localStorage === undefined) delete g.localStorage;
  else g.localStorage = real.localStorage;
});

function stubs(settings?: unknown) {
  const sent: { url: string; body: any }[] = [];
  g.fetch = async (url: string, init: { body: string }) => (sent.push({ url, body: JSON.parse(init.body) }), new Response("{}"));
  g.localStorage = { getItem: () => (settings === undefined ? null : JSON.stringify(settings)) };
  return sent;
}

test("the step listener hears about each included step, and a failure in it never stops a trade", async () => {
  const heard: [string, string, string][] = [];
  setStepListener((source, s, txId) => (heard.push([source, s.id, txId]), (() => { throw new Error("boom"); })()));
  assert.equal(await runSteps(WALLET, [step("a", "qx-bid", 6), step("b", "qx-ask", 5)], sign, () => {}, undefined, chain()), true);
  assert.deepEqual(heard, [[WALLET, "a", "a".repeat(60)], [WALLET, "b", "b".repeat(60)]]);
});

test("a step that was not included is not reported", async () => {
  const heard: string[] = [];
  setStepListener((_s, s) => heard.push(s.id));
  assert.equal(await runSteps(WALLET, [step("a", "qx-bid", 6)], sign, () => {}, undefined, chain(false)), false);
  assert.deepEqual(heard, []);
});

test("trades and liquidity are reported with the wallet and the partner tag; moves, cancels and payments are not", async () => {
  const sent = stubs();
  startUsageReporting();
  rememberRef("partner");
  const steps = [step("move", "transfer-rights", 9), step("buy", "qx-bid", 6), step("cancel", "cancel-order", 8), step("pay", "payment", 1), step("swap", "qswap-sell", 8), step("add", "add-liquidity", 4)];
  assert.equal(await runSteps(WALLET, steps, sign, () => {}, undefined, chain()), true);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((s) => s.url.endsWith("/v1/trade-report")));
  assert.deepEqual(sent[0].body, { wallet: WALLET, txIds: ["b".repeat(60)], channel: "web", ref: "partner" });
  assert.deepEqual(sent.map((s) => s.body.txIds[0]), ["b".repeat(60), "e".repeat(60), "f".repeat(60)]);
});

test("with counting turned off in Settings nothing is sent", async () => {
  const sent = stubs({ shareUsage: false });
  startUsageReporting();
  await runSteps(WALLET, [step("buy", "qx-bid", 6)], sign, () => {}, undefined, chain());
  reportTrade(WALLET, "z".repeat(60));
  assert.equal(sent.length, 0);
});

test("counting is on when Settings has never been saved, or cannot be read", async () => {
  const sent = stubs();
  reportTrade(WALLET, "a".repeat(60));
  g.localStorage = { getItem: () => { throw new Error("blocked"); } };
  reportTrade(WALLET, "b".repeat(60));
  assert.equal(sent.length, 2);
});

test("a network failure is swallowed", async () => {
  g.localStorage = { getItem: () => null };
  g.fetch = () => Promise.reject(new Error("offline"));
  assert.doesNotThrow(() => reportTrade(WALLET, "a".repeat(60)));
  await new Promise((r) => setTimeout(r, 5));
});

test("with counting turned off, a partner's finished-trade report is not sent either; a plain visit count still is", async () => {
  const { reportRef } = await import("../web/client.ts");
  const sent = stubs({ shareUsage: false });
  reportRef("partner", "trade", ["a".repeat(60)]);
  assert.equal(sent.length, 0, "the transaction ids are the part that is about the person");
  reportRef("partner", "open");
  assert.equal(sent.length, 1, "arriving from a partner's link is not about the person");
  const on = stubs({ shareUsage: true });
  reportRef("partner", "trade", ["a".repeat(60)]);
  assert.equal(on.length, 1);
});
