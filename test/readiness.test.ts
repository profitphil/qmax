import { test } from "node:test";
import assert from "node:assert/strict";
import { assessReadiness } from "../src/readiness.ts";
import type { ReadinessInput } from "../src/readiness.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const info = { issuer: ISSUER, assetName: "CFB", transferFeeQu: { qx: 100, qswap: 100 } };

const buyQuote = (over = {}) => ({
  asset: "CFB", side: "buy" as const, assetInfo: info, fillable: true, executable: true, warnings: [] as string[],
  route: [{ venue: "QX", qty: 10, execution: { type: "qx-bid" as const, qty: 10, limitPrice: 100 } }], ...over,
});
const sellQuote = (venue = "QSwap") => ({
  asset: "CFB", side: "sell" as const, assetInfo: info, fillable: true, executable: true, warnings: [] as string[],
  route: [venue === "QSwap"
    ? { venue, qty: 50, execution: { type: "qswap-sell" as const, qty: 50, minQuOut: 900 } }
    : { venue, qty: 50, execution: { type: "qx-ask" as const, qty: 50, limitPrice: 90 } }],
});
const base = (o: Partial<ReadinessInput>): ReadinessInput => ({ side: "buy", qty: 10, connected: true, quote: buyQuote(), balanceQu: 10_000, holdings: {}, hasPass: true, passRequired: true, ...o });
const state = (r: ReturnType<typeof assessReadiness>, id: string) => r.checks.find((c) => c.id === id)?.state;

test("a funded buy with a fillable quote is ready", () => {
  const r = assessReadiness(base({}));
  assert.equal(r.ready, true);
  assert.equal(state(r, "fees"), "ok");
});

test("not connected, still loading or short of QU are not ready", () => {
  assert.equal(assessReadiness(base({ connected: false })).ready, false);
  assert.equal(assessReadiness(base({ quote: null })).ready, false);
  assert.equal(assessReadiness(base({ balanceQu: null })).ready, false);
  const poor = assessReadiness(base({ balanceQu: 500 }));
  assert.equal(state(poor, "fees"), "fail");
  assert.equal(poor.ready, false);
});

test("selling needs QU for fees even when the proceeds are in QU", () => {
  const r = assessReadiness(base({ side: "sell", quote: sellQuote(), holdings: { 13: 50 }, balanceQu: 50_000 })); // QSwap sell sends 100,000 QU
  assert.equal(state(r, "fees"), "fail");
  assert.match(r.checks.find((c) => c.id === "fees")!.detail!, /paid in QU, even when selling/);
});

test("selling shares held at the other contract is ready but flagged as an extra step", () => {
  const r = assessReadiness(base({ side: "sell", quote: sellQuote(), holdings: { 1: 50 }, balanceQu: 500_000 }));
  assert.equal(state(r, "shares"), "warn");
  assert.equal(r.ready, true);
  assert.match(r.checks.find((c) => c.id === "shares")!.detail!, /1 extra step/);
});

test("selling more than you hold fails with the reason", () => {
  const r = assessReadiness(base({ side: "sell", quote: sellQuote("QX"), holdings: { 1: 10 }, balanceQu: 500_000 }));
  assert.equal(state(r, "shares"), "fail");
  assert.equal(r.ready, false);
});

test("quiet markets and heavy fees warn but do not block", () => {
  const r = assessReadiness(base({ activity: "inactive", quote: buyQuote({ warnings: ["Fees are 40% of this trade (…)"] }) }));
  assert.equal(state(r, "activity"), "warn");
  assert.equal(state(r, "costs"), "warn");
  assert.equal(r.ready, true);
});

test("unfillable or non-executable quotes block", () => {
  assert.equal(assessReadiness(base({ quote: buyQuote({ fillable: false, warnings: ["No market can fill the full order"] }) })).ready, false);
  assert.equal(assessReadiness(base({ quote: buyQuote({ executable: false }) })).ready, false);
});

test("without a pass the trade is not ready and the checklist says how to unlock it", () => {
  const r = assessReadiness(base({ hasPass: false }));
  assert.equal(r.ready, false);
  assert.equal(state(r, "pass"), "fail");
  assert.match(r.checks.find((c) => c.id === "pass")!.detail!, /1,000 QU for 24 hours/);
  assert.equal(state(assessReadiness(base({ hasPass: null })), "pass"), "pending");
  assert.equal(state(assessReadiness(base({ hasPass: true })), "pass"), "ok");
  assert.equal(state(assessReadiness(base({ connected: false, hasPass: false })), "pass"), undefined); // connect first
});

test("when trading is free there is no pass to check or unlock, whatever the wallet holds", () => {
  for (const hasPass of [false, null, true]) {
    const r = assessReadiness(base({ hasPass, passRequired: false }));
    assert.equal(state(r, "pass"), undefined, "no pass line at all");
    assert.equal(r.ready, true, "and a missing pass does not stop the trade");
  }
});

test("the site is free unless it was built to ask for a pass", () => {
  assert.equal(state(assessReadiness({ ...base({ hasPass: false }), passRequired: undefined }), "pass"), undefined, "outside Vite, with nothing set, trading is free");
});
