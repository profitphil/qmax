import { test } from "node:test";
import assert from "node:assert/strict";
import { hasProfitShare, memberHow, showsMembership } from "../web/memberlabel.ts";

/** What `GET /v1/membership` really answered for a subscriber (copied from the live server): note that `subscription` has no `discordIds`. */
const SUBSCRIBER = {
  wallet: "OWRZJQOKYQLKFBUJREXEKCXNZBICMBBEHURQBIPNAEPUQLVJZLNFYTGEQIFH",
  active: true,
  until: 1794061831000,
  source: "subscription" as const,
  pass: { active: false, until: null },
  unlocksWebTrading: true,
  profitShare: { sharePct: 75, capFraction: 1, since: "2026-10", earnedQu: 0, paidQu: 0, owedQu: 0, periods: [], thisMonth: { period: "2026-10", estimatedQu: 74437, provisional: true }, note: "..." },
  subscription: { active: true, until: 1794061831000, since: 1791469831000, lastPaidAt: 1791469831000, payments: 1, paidQu: 100000 },
};

test("a subscriber's membership, as the server really sends it, reads without error (the wallet menu used to read a list the server leaves out and crash the page)", () => {
  assert.equal(memberHow(SUBSCRIBER), "Subscriber");
  assert.equal(showsMembership(SUBSCRIBER), true);
  assert.equal(hasProfitShare(SUBSCRIBER), true);
  assert.equal("discordIds" in SUBSCRIBER.subscription, false);
});

test("a pass holder, a wallet with nothing, and a missing or partial profit share are all fine", () => {
  assert.equal(memberHow({ source: "pass" }), "Pass holder");
  assert.equal(memberHow({ source: null }), "Not a member right now");
  assert.equal(memberHow({}), "Not a member right now");
  const none = { active: false, source: null, profitShare: null };
  assert.equal(showsMembership(none), false, "nothing to show for a wallet that is no member and has no share");
  assert.equal(showsMembership({ active: false, source: null }), false);
  assert.equal(hasProfitShare({ profitShare: {} }), false, "a share with no figures is not worth showing");
  assert.equal(hasProfitShare({ profitShare: { paidQu: 5 } }), true);
  assert.equal(hasProfitShare({ profitShare: { thisMonth: {} } }), false, "a month with no estimate");
  assert.equal(showsMembership({ active: false, source: null, profitShare: { earnedQu: 10, paidQu: 0, owedQu: 10 } }), true, "a lapsed member who has earned a share still sees it");
});
