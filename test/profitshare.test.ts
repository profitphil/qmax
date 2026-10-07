import test from "node:test";
import assert from "node:assert/strict";
import { DAY_MS, coverageUntil, membershipOf, subscribersOf } from "../src/membership.ts";
import type { MembershipConfig } from "../src/membership.ts";
import { DEFAULT_SHARE_CONFIG, SCAN_MARGIN_MS, balancesFor, nextPeriod, periodBounds, periodOf, periodStatus, previousPeriod, shareConfigFromEnv, statementFor } from "../src/profitshare.ts";
import type { ShareConfig } from "../src/profitshare.ts";
import type { PaymentKind, PaymentRecord } from "../src/usage.ts";

const OWNER = "O".repeat(59) + "A";
const W = (c: string) => c.repeat(59) + "Z";
const [A, B, C, D] = [W("A"), W("B"), W("C"), W("D")];
const OCT = Date.UTC(2026, 9, 1);
const NOV = Date.UTC(2026, 10, 1);
const DEC = Date.UTC(2026, 11, 1);
const cfg: ShareConfig = { ...DEFAULT_SHARE_CONFIG, excludeWallets: [OWNER] };
/** The wider setting a deployment could choose: passes, API top-ups and sessions count as income too. */
const wide: ShareConfig = { ...cfg, incomeKinds: ["pass", "subscription", "api-topup", "session"] };
const mcfg: MembershipConfig = { subscriptionDays: 30, passHours: 24 };

let n = 0;
/** A payment: `gross` is what the payer sent, `net` what QPayhub forwarded (default: 0.75% lower, at least 100). */
const pay = (kind: PaymentKind, payer: string, gross: number, t: number, o: { net?: number; discordId?: string } = {}): PaymentRecord => ({
  tx: "tx" + ++n,
  payer,
  kind,
  amountQu: gross,
  forwardedQu: o.net ?? gross - Math.max(100, Math.floor(gross * 0.0075)),
  tick: n,
  t,
  ...(o.discordId ? { discordId: o.discordId } : {}),
});

/* ---------- membership ---------- */

test("each payment buys its length from the later of its time and the end of the last one", () => {
  const L = 30 * DAY_MS;
  assert.equal(coverageUntil([], L), 0);
  assert.equal(coverageUntil([1000], L), 1000 + L);
  assert.equal(coverageUntil([1000, 1000 + 10 * DAY_MS], L), 1000 + 2 * L, "paying early stacks after the first");
  assert.equal(coverageUntil([1000, 1000 + 60 * DAY_MS], L), 1000 + 60 * DAY_MS + L, "paying late starts from the payment");
  assert.equal(coverageUntil([1000 + 60 * DAY_MS, 1000], L), 1000 + 60 * DAY_MS + L, "the order they are given in does not matter");
});

test("a wallet that paid for a Discord subscription is a member on the website too, found by its wallet", () => {
  const now = OCT + 10 * DAY_MS;
  const payments = [pay("subscription", A, 1_000_000, OCT + 2 * DAY_MS, { discordId: "111" }), pay("subscription", B, 1_000_000, OCT - 40 * DAY_MS, { discordId: "222" })];
  const a = membershipOf(payments, A, now, mcfg);
  assert.deepEqual([a.active, a.source, a.until, a.subscription.discordIds], [true, "subscription", OCT + 32 * DAY_MS, ["111"]]);
  assert.equal(a.subscription.since, OCT + 2 * DAY_MS);
  assert.equal(a.subscription.paidQu, 1_000_000);
  const b = membershipOf(payments, B, now, mcfg);
  assert.deepEqual([b.active, b.until, b.source, b.subscription.active], [false, null, null, false], "an expired subscription is not active, but the history stays");
  assert.equal(b.subscription.payments, 1);
  assert.deepEqual(membershipOf(payments, C, now, mcfg).subscription, { active: false, until: null, since: null, lastPaidAt: null, payments: 0, paidQu: 0, discordIds: [] });
});

test("a pass counts too, and the longer of the two is what keeps a member active", () => {
  const now = OCT + 5 * DAY_MS;
  const both = [pay("pass", A, 1000, now - 3_600_000), pay("subscription", A, 1_000_000, now - DAY_MS)];
  const m = membershipOf(both, A, now, mcfg);
  assert.deepEqual([m.active, m.source, m.pass.active, m.subscription.active], [true, "subscription", true, true]);
  const passOnly = membershipOf([pay("pass", A, 1000, now - 3_600_000)], A, now, mcfg);
  assert.deepEqual([passOnly.active, passOnly.source, passOnly.until], [true, "pass", now - 3_600_000 + 24 * 3_600_000]);
  assert.equal(membershipOf([pay("pass", A, 1000, now - 25 * 3_600_000)], A, now, mcfg).active, false, "a pass lasts 24 hours");
  assert.equal(membershipOf([pay("api-topup", A, 50_000, now)], A, now, mcfg).active, false, "an API top-up is not a membership");
});

test("subscribers are the wallets that ever paid for a subscription, latest payer first", () => {
  const payments = [pay("subscription", A, 1000, OCT), pay("pass", C, 1000, OCT), pay("subscription", B, 1000, OCT + DAY_MS), pay("subscription", A, 1000, OCT + 2 * DAY_MS)];
  assert.deepEqual(subscribersOf(payments, OCT + 3 * DAY_MS, mcfg).map((m) => m.wallet), [A, B]);
});

/* ---------- periods ---------- */

test("periods are calendar months in UTC", () => {
  assert.equal(periodOf(Date.UTC(2026, 9, 31, 23, 59, 59)), "2026-10");
  assert.equal(periodOf(Date.UTC(2026, 10, 1)), "2026-11");
  assert.deepEqual(periodBounds("2026-10"), { from: OCT, to: NOV });
  assert.deepEqual(periodBounds("2026-12"), { from: DEC, to: Date.UTC(2027, 0, 1) });
  assert.equal(periodBounds("2026-13"), null);
  assert.equal(periodBounds("2026-1"), null);
  assert.equal(periodBounds("nope"), null);
  assert.equal(previousPeriod("2027-01"), "2026-12");
  assert.equal(nextPeriod("2026-12"), "2027-01");
  assert.throws(() => periodStatus("bad", 0, 0), /not a period/);
});

test("a period is complete only after it has ended and the scan has read past its end", () => {
  assert.deepEqual(periodStatus("2026-10", OCT + DAY_MS, 0), { id: "2026-10", from: OCT, to: NOV, closed: false, complete: false });
  assert.equal(periodStatus("2026-10", NOV + 1, NOV - 1).complete, false, "ended, but the scan stopped before its end");
  assert.equal(periodStatus("2026-10", NOV + 1, NOV + SCAN_MARGIN_MS - 1).complete, false, "and the archive indexes a little late");
  assert.deepEqual([periodStatus("2026-10", NOV + 1, NOV + SCAN_MARGIN_MS).closed, periodStatus("2026-10", NOV + 1, NOV + SCAN_MARGIN_MS).complete], [true, true]);
});

/* ---------- the statement ---------- */

const closed = (id = "2026-10") => ({ now: periodBounds(id)!.to + 3_600_000, scanAt: periodBounds(id)!.to + 3_600_000 });

test("by default only subscriptions are income: 75% of what QMax received for them goes into the pool, split by what each subscriber paid", () => {
  assert.deepEqual(DEFAULT_SHARE_CONFIG.incomeKinds, ["subscription"], "the website, API, SDK and MCP are free: only the Discord subscription is sold");
  const { now, scanAt } = closed();
  const payments = [
    pay("subscription", A, 1_000_000, OCT + DAY_MS, { net: 992_500 }),
    pay("subscription", B, 3_000_000, OCT + 2 * DAY_MS, { net: 2_977_500 }),
    pay("pass", C, 1_000, OCT + 3 * DAY_MS, { net: 900 }), // received, but not income any more
    pay("api-topup", D, 100_000, OCT + 4 * DAY_MS, { net: 99_250 }),
  ];
  const s = statementFor(payments, cfg, "2026-10", now, scanAt);
  const income = 992_500 + 2_977_500;
  assert.equal(s.income.countedNetQu, income);
  assert.equal(s.income.notCountedNetQu, 900 + 99_250, "what else arrived is shown, not shared");
  assert.equal(s.pool.poolQu, Math.floor(income * 0.75));
  assert.equal(s.pool.eligibleWeightQu, income);
  const byWallet = Object.fromEntries(s.lines.map((l) => [l.wallet, l]));
  assert.equal(Object.keys(byWallet).length, 2, "only subscribers are on the statement");
  assert.equal(byWallet[A].shareQu, Math.floor((s.pool.poolQu * 992_500) / 3_970_000));
  assert.equal(byWallet[B].shareQu, Math.floor((s.pool.poolQu * 2_977_500) / 3_970_000));
  assert.ok(byWallet[A].shareQu <= Math.floor(992_500 * 0.75) && byWallet[B].shareQu <= Math.floor(2_977_500 * 0.75), "with only subscriptions as income each one gets back at most 75% of what QMax received from it");
  assert.equal(s.pool.distributedQu, byWallet[A].earnedQu + byWallet[B].earnedQu);
  assert.equal(s.pool.retainedQu, s.pool.poolQu - s.pool.distributedQu);
  assert.deepEqual(s.warnings, [], "a closed, complete period with no exclusions has nothing to warn about");

  // A deployment can still count more kinds as income.
  const w = statementFor(payments, wide, "2026-10", now, scanAt);
  const all = 992_500 + 2_977_500 + 900 + 99_250;
  assert.equal(w.income.countedNetQu, all);
  assert.equal(w.pool.poolQu, Math.floor(all * 0.75));
});

test("nobody earns more than they paid, however big the pool is next to their payment", () => {
  const { now, scanAt } = closed();
  // Lots of income from API top-ups, one small subscriber: the pool is huge next to what they paid.
  const payments = [pay("api-topup", D, 50_000_000, OCT + DAY_MS), pay("subscription", A, 1_000_000, OCT + DAY_MS)];
  const s = statementFor(payments, wide, "2026-10", now, scanAt);
  assert.ok(s.pool.poolQu > 1_000_000);
  assert.equal(s.lines[0].earnedQu, 1_000_000, "capped at what A paid in gross");
  assert.equal(s.lines[0].capped, true);
  assert.ok(s.pool.retainedQu > 0);
  assert.ok(s.warnings.some((w) => /cap/.test(w)));
  // With the cap off the same wallet takes the whole pool.
  const open = statementFor(payments, { ...wide, capFraction: 0 }, "2026-10", now, scanAt);
  assert.equal(open.lines[0].earnedQu, open.pool.poolQu);
  assert.equal(open.lines[0].capQu, null);
});

test("splitting one subscription across many wallets gains nothing", () => {
  const { now, scanAt } = closed();
  const others = [pay("subscription", B, 1_000_000, OCT + DAY_MS), pay("subscription", C, 2_000_000, OCT + DAY_MS), pay("api-topup", D, 40_000_000, OCT + DAY_MS)];
  const one = statementFor([...others, pay("subscription", A, 3_000_000, OCT + DAY_MS)], wide, "2026-10", now, scanAt);
  const wallets = ["a", "b", "c"].map((c) => W(c.toUpperCase().repeat(1)).replace(/Z$/, "Y"));
  const split = statementFor([...others, ...wallets.map((w) => pay("subscription", w, 1_000_000, OCT + DAY_MS))], wide, "2026-10", now, scanAt);
  const earnedBy = (s: ReturnType<typeof statementFor>, ws: string[]) => s.lines.filter((l) => ws.includes(l.wallet)).reduce((t, l) => t + l.earnedQu, 0);
  const mine = earnedBy(one, [A]);
  const mineSplit = earnedBy(split, wallets);
  assert.ok(Math.abs(mine - mineSplit) <= 3, `one wallet earned ${mine}, the same money in three earned ${mineSplit}`);
  assert.ok(mine <= 3_000_000 && mineSplit <= 3_000_000, "and neither is ever more than was paid");
});

test("the sums stay exact when pool x weight is far past what a plain number holds", () => {
  const { now, scanAt } = closed();
  // Amounts near QU's total supply (1e15): pool x weight is about 1e29, past what a plain number can hold exactly.
  const netA = 400_000_000_000_001;
  const netB = 300_000_000_000_003;
  const payments = [pay("subscription", A, netA + 1000, OCT + DAY_MS, { net: netA }), pay("subscription", B, netB + 1000, OCT + DAY_MS, { net: netB })];
  const s = statementFor(payments, { ...cfg, capFraction: 0 }, "2026-10", now, scanAt);
  const pool = (BigInt(netA + netB) * 75n) / 100n;
  assert.equal(BigInt(s.pool.poolQu), pool);
  const total = BigInt(netA + netB);
  const exact = (w: number) => Number((pool * BigInt(w)) / total);
  assert.equal(s.lines.find((l) => l.wallet === A)!.earnedQu, exact(netA));
  assert.equal(s.lines.find((l) => l.wallet === B)!.earnedQu, exact(netB));
});

test("excluded wallets, other payments and payments outside the month are left out", () => {
  const { now, scanAt } = closed();
  const payments = [
    pay("subscription", A, 1_000_000, OCT + DAY_MS),
    pay("subscription", OWNER, 5_000_000, OCT + DAY_MS), // QMax paying itself
    pay("subscription", D, 1_000_000, OCT + DAY_MS), // a test wallet, excluded by setting
    pay("other", B, 700_000, OCT + DAY_MS), // not known to be QMax's income
    pay("subscription", C, 1_000_000, OCT - 1), // September
    pay("subscription", C, 1_000_000, NOV), // November
  ];
  const s = statementFor(payments, { ...cfg, excludeWallets: [OWNER, D] }, "2026-10", now, scanAt);
  assert.deepEqual(s.lines.map((l) => l.wallet), [A]);
  assert.equal(s.income.countedNetQu, 1_000_000 - 7_500);
  assert.equal(s.income.notCountedNetQu, 700_000 - 5_250);
  assert.equal(s.income.excluded.payments, 2);
  assert.equal(s.income.byKind.other?.counted, false);
  assert.ok(s.warnings.some((w) => /excluded wallets/.test(w)));
});

test("a month with income but no subscriber keeps the whole pool", () => {
  const { now, scanAt } = closed();
  const s = statementFor([pay("api-topup", D, 1_000_000, OCT + DAY_MS)], wide, "2026-10", now, scanAt);
  assert.deepEqual([s.lines.length, s.pool.distributedQu, s.pool.retainedQu], [0, 0, s.pool.poolQu]);
  assert.ok(s.warnings.some((w) => /no eligible subscriber/.test(w)));
});

test("an open or not yet scanned period says its numbers are not final", () => {
  const payments = [pay("subscription", A, 1_000_000, OCT + DAY_MS)];
  assert.ok(statementFor(payments, cfg, "2026-10", OCT + 5 * DAY_MS, OCT + 5 * DAY_MS).warnings.some((w) => /still open/.test(w)));
  assert.ok(statementFor(payments, cfg, "2026-10", NOV + 60_000, NOV - 60_000).warnings.some((w) => /payment scan has not read past/.test(w)));
});

test("whatever the payments are, the pool is never exceeded and no wallet earns more than it paid", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const { now, scanAt } = closed();
  const kinds: PaymentKind[] = ["pass", "subscription", "api-topup", "session", "other"];
  for (let round = 0; round < 300; round++) {
    const wallets = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => W(String.fromCharCode(65 + i)));
    const payments = Array.from({ length: Math.floor(rnd() * 25) }, () => {
      const gross = 100 + Math.floor(rnd() * 5_000_000);
      return pay(kinds[Math.floor(rnd() * kinds.length)], wallets[Math.floor(rnd() * wallets.length)], gross, OCT + Math.floor(rnd() * 28 * DAY_MS), { net: Math.max(1, gross - Math.floor(rnd() * 200)) });
    });
    const c: ShareConfig = { ...(rnd() < 0.5 ? cfg : wide), sharePct: Math.floor(rnd() * 101), capFraction: rnd() < 0.3 ? 0 : 0.5 + rnd(), minSubscriptionQu: rnd() < 0.5 ? 0 : Math.floor(rnd() * 3_000_000) };
    const s = statementFor(payments, c, "2026-10", now, scanAt);
    assert.ok(s.pool.distributedQu <= s.pool.poolQu, "never more than the pool");
    assert.ok(s.pool.poolQu <= (s.income.countedNetQu * c.sharePct) / 100 + 1e-6, "the pool is the share of income");
    assert.equal(s.pool.retainedQu, s.pool.poolQu - s.pool.distributedQu);
    for (const l of s.lines) {
      assert.ok(l.earnedQu >= 0 && Number.isInteger(l.earnedQu));
      if (c.capFraction > 0) assert.ok(l.earnedQu <= l.paidQu * c.capFraction, "never more than it paid times the cap");
    }
  }
});

test("a payment on the last millisecond of a month is that month's, and the next millisecond is the next month's: never in both, never in neither", () => {
  const payments = [pay("subscription", A, 1_000_000, NOV - 1), pay("subscription", A, 1_000_000, NOV), pay("subscription", B, 2_000_000, OCT), pay("subscription", B, 2_000_000, DEC - 1)];
  const now = DEC + 3_600_000;
  const oct = statementFor(payments, cfg, "2026-10", now, now);
  const nov = statementFor(payments, cfg, "2026-11", now, now);
  assert.deepEqual(oct.lines.map((l) => [l.wallet, l.paidQu]).sort(), [[A, 1_000_000], [B, 2_000_000]].sort());
  assert.deepEqual(nov.lines.map((l) => [l.wallet, l.paidQu]).sort(), [[A, 1_000_000], [B, 2_000_000]].sort());
  assert.equal(oct.income.byKind.subscription!.count + nov.income.byKind.subscription!.count, payments.length, "every payment is counted in exactly one month");
});

/* ---------- what each wallet is owed ---------- */

test("balances add up complete periods from the start and take off what was paid", () => {
  const payments = [pay("subscription", A, 1_000_000, OCT + DAY_MS), pay("subscription", A, 1_000_000, NOV + DAY_MS), pay("subscription", B, 1_000_000, NOV + DAY_MS)];
  const now = DEC + 10 * DAY_MS;
  const scanAt = now;
  const oct = statementFor(payments, cfg, "2026-10", now, scanAt).lines[0].earnedQu;
  const nov = statementFor(payments, cfg, "2026-11", now, scanAt);
  const novA = nov.lines.find((l) => l.wallet === A)!.earnedQu;
  const none = balancesFor(payments, cfg, "2026-10", now, scanAt, new Map());
  assert.deepEqual(none.periods, ["2026-10", "2026-11"]);
  assert.equal(none.balances.find((b) => b.wallet === A)!.earnedQu, oct + novA);
  assert.equal(none.totalOwedQu, none.totalEarnedQu);
  const paid = balancesFor(payments, cfg, "2026-10", now, scanAt, new Map([[A, oct]]));
  assert.equal(paid.balances.find((b) => b.wallet === A)!.owedQu, novA, "what was paid comes off");
  assert.equal(paid.totalPaidQu, oct);
  const over = balancesFor(payments, cfg, "2026-10", now, scanAt, new Map([[A, oct + novA + 999]]));
  assert.equal(over.balances.find((b) => b.wallet === A)!.owedQu, 0, "an overpayment is never a negative balance");
  const late = balancesFor(payments, cfg, "2026-11", now, scanAt, new Map());
  assert.deepEqual(late.periods, ["2026-11"], "periods before the start are not counted");
});

test("only complete periods are owed: the open month and a month the scan has not reached are not", () => {
  const payments = [pay("subscription", A, 1_000_000, OCT + DAY_MS), pay("subscription", A, 1_000_000, NOV + DAY_MS)];
  const now = NOV + 10 * DAY_MS;
  assert.deepEqual(balancesFor(payments, cfg, "2026-10", now, now, new Map()).periods, ["2026-10"], "November is still open");
  assert.deepEqual(balancesFor(payments, cfg, "2026-10", now, NOV - 1, new Map()).periods, [], "the scan has not read past October's end");
});

test("a wallet paid out with nothing earned still shows, owing nothing", () => {
  const b = balancesFor([], cfg, "2026-10", DEC, DEC, new Map([[A, 500]]));
  assert.deepEqual(b.balances.map((x) => [x.wallet, x.earnedQu, x.paidQu, x.owedQu]), [[A, 0, 500, 0]]);
});

test("an overpayment (a batch signed twice) is set against what the wallet earns later, so it is not paid again until its earnings catch up", () => {
  const payments = [pay("subscription", A, 1_000_000, OCT + DAY_MS), pay("subscription", A, 1_000_000, NOV + DAY_MS)];
  const earnedPerMonth = statementFor(payments, cfg, "2026-10", DEC, DEC).lines[0].earnedQu;
  const afterOct = balancesFor(payments, cfg, "2026-10", NOV + 10 * DAY_MS, NOV + 10 * DAY_MS, new Map([[A, 2 * earnedPerMonth]]));
  assert.deepEqual([afterOct.balances[0].owedQu, afterOct.balances[0].overpaidQu], [0, earnedPerMonth], "paid twice for October: nothing owed, and the overpayment is shown");
  const afterNov = balancesFor(payments, cfg, "2026-10", DEC + 3_600_000, DEC + 3_600_000, new Map([[A, 2 * earnedPerMonth]]));
  assert.deepEqual([afterNov.balances[0].earnedQu, afterNov.balances[0].owedQu, afterNov.balances[0].overpaidQu], [2 * earnedPerMonth, 0, 0], "November's share is covered by what was paid twice, not paid a third time");
});

/* ---------- settings ---------- */

test("settings come from the environment and nonsense is refused, not guessed at", () => {
  assert.deepEqual(shareConfigFromEnv({}, OWNER), { ...DEFAULT_SHARE_CONFIG, excludeWallets: [OWNER] });
  const c = shareConfigFromEnv({ PROFIT_SHARE_PCT: "50", PROFIT_SHARE_CAP: "0", PROFIT_SHARE_MIN_PAYOUT_QU: "5000", PROFIT_SHARE_EXCLUDE: `${A}, ${B}`, PROFIT_SHARE_INCOME: "subscription,pass", PROFIT_SHARE_ELIGIBLE: "subscription,pass" }, OWNER);
  assert.deepEqual([c.sharePct, c.capFraction, c.minPayoutQu, c.excludeWallets, c.incomeKinds, c.eligibleKinds], [50, 0, 5000, [OWNER, A, B], ["subscription", "pass"], ["subscription", "pass"]]);
  assert.throws(() => shareConfigFromEnv({ PROFIT_SHARE_PCT: "120" }, OWNER), /PROFIT_SHARE_PCT/);
  assert.throws(() => shareConfigFromEnv({ PROFIT_SHARE_PCT: "lots" }, OWNER), /PROFIT_SHARE_PCT/);
  assert.throws(() => shareConfigFromEnv({ PROFIT_SHARE_CAP: "-1" }, OWNER), /PROFIT_SHARE_CAP/);
  assert.throws(() => shareConfigFromEnv({ PROFIT_SHARE_EXCLUDE: "nope" }, OWNER), /not a 60-letter identity/);
  assert.throws(() => shareConfigFromEnv({ PROFIT_SHARE_INCOME: "subscription,gold" }, OWNER), /'gold' is not one of/);
});

/* ---------- adversarial review, second pass: what counts as a subscription ---------- */

test("a subscription payment under the minimum is not a subscription: not income, not shared in, not a member", () => {
  // Anyone can pay QPayhub with QMax as the seller and a QMAXSUB resource id, for any amount from 100 QU up.
  const { now, scanAt } = closed();
  const min = 1_000_000;
  const payments = [
    pay("subscription", A, 1_810_000, OCT + DAY_MS, { net: 1_796_425, discordId: "111" }),
    pay("subscription", B, 500, OCT + DAY_MS, { net: 400, discordId: "222" }), // dust naming someone's Discord id
    pay("subscription", C, min, OCT + DAY_MS, { net: min - 7_500 }), // exactly the minimum counts
    pay("subscription", D, min - 1, OCT + DAY_MS, { net: min - 7_500 }), // one under does not
  ];
  const s = statementFor(payments, { ...cfg, minSubscriptionQu: min }, "2026-10", now, scanAt);
  assert.deepEqual(s.lines.map((l) => l.wallet).sort(), [A, C].sort());
  assert.equal(s.income.countedNetQu, 1_796_425 + min - 7_500, "the dust is not income");
  assert.deepEqual(s.income.belowMinimum, { payments: 2, netQu: 400 + min - 7_500 }, "but it is shown, not hidden");
  assert.equal(s.income.byKind.subscription!.count, 2);
  assert.ok(s.warnings.some((w) => /2 subscription payments below the 1,000,000 QU minimum are not counted/.test(w)));
  const off = statementFor(payments, cfg, "2026-10", now, scanAt);
  assert.equal(off.lines.length, 4, "with no minimum (the default) every subscription counts, as before");
  assert.deepEqual(off.income.belowMinimum, { payments: 0, netQu: 0 });

  const m = (w: string) => membershipOf(payments, w, OCT + 5 * DAY_MS, { ...mcfg, minSubscriptionQu: min });
  assert.deepEqual([m(A).active, m(B).active, m(C).active, m(D).active], [true, false, true, false]);
  assert.deepEqual([m(B).subscription.payments, m(B).subscription.paidQu, m(B).subscription.discordIds], [0, 0, []], "dust leaves no subscription history to hang a Discord id on");
  assert.deepEqual(subscribersOf(payments, OCT + 5 * DAY_MS, { ...mcfg, minSubscriptionQu: min }).map((x) => x.wallet).sort(), [A, C].sort());
  assert.equal(membershipOf(payments, B, OCT + 5 * DAY_MS, mcfg).active, true, "no minimum in the settings: unchanged");
});

test("the minimum for a subscription comes from SUBSCRIPTION_MIN_QU, and nonsense is refused", () => {
  assert.equal(DEFAULT_SHARE_CONFIG.minSubscriptionQu, 0);
  assert.equal(shareConfigFromEnv({}, OWNER).minSubscriptionQu, 0);
  assert.equal(shareConfigFromEnv({ SUBSCRIPTION_MIN_QU: "900000" }, OWNER).minSubscriptionQu, 900_000);
  assert.throws(() => shareConfigFromEnv({ SUBSCRIPTION_MIN_QU: "-1" }, OWNER), /SUBSCRIPTION_MIN_QU/);
  assert.throws(() => shareConfigFromEnv({ SUBSCRIPTION_MIN_QU: "cheap" }, OWNER), /SUBSCRIPTION_MIN_QU/);
});

test("with only subscriptions as income, no wallet is ever paid back more than 75% of what QMax received from it", () => {
  // Consequence worth knowing: with income and eligibility the same kind, pool x weight / total weight collapses to sharePct x that wallet's own
  // net payment, whoever else pays. The cap never binds, and the split among subscribers changes nothing.
  const { now, scanAt } = closed();
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 200; round++) {
    const wallets = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => W(String.fromCharCode(65 + i)));
    const payments = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => {
      const gross = 100 + Math.floor(rnd() * 9_000_000);
      return pay("subscription", wallets[Math.floor(rnd() * wallets.length)], gross, OCT + Math.floor(rnd() * 28 * DAY_MS), { net: Math.max(1, gross - Math.floor(rnd() * 500)) });
    });
    const s = statementFor(payments, cfg, "2026-10", now, scanAt);
    for (const l of s.lines) assert.ok(l.earnedQu <= Math.floor(l.weightQu * 0.75), `${l.earnedQu} of ${l.weightQu}`);
    assert.ok(s.lines.every((l) => !l.capped));
  }
});

test("a flood of dust payments costs the statement time in proportion to their number, not its square", () => {
  // Payments to QMax cost a sender almost nothing, so an attacker can make a lot of them; the statement and the balances are worked out for every
  // lookup of the public endpoint.
  const { now, scanAt } = closed();
  const dust = Array.from({ length: 150_000 }, (_, i) => pay("subscription", "Q" + String(i % 3000).padStart(59, "B"), 500, OCT + DAY_MS + i, { net: 400 }));
  const real = Array.from({ length: 60_000 }, (_, i) => pay("subscription", "Q" + String(i % 3000).padStart(59, "C"), 1_810_000, OCT + 2 * DAY_MS + i, { net: 1_796_425 }));
  const started = Date.now();
  const s = statementFor([...dust, ...real], { ...cfg, minSubscriptionQu: 1_000_000 }, "2026-10", now, scanAt);
  assert.equal(s.income.belowMinimum.payments, 150_000);
  assert.equal(s.lines.length, 3000);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("listing the subscribers costs time in proportion to the payments, not wallets times payments", () => {
  const payments = Array.from({ length: 40_000 }, (_, i) => pay("subscription", "Q" + String(i).padStart(59, "D"), 1_810_000, OCT + i, { net: 1_796_425 }));
  const started = Date.now();
  const list = subscribersOf(payments, OCT + 5 * DAY_MS, mcfg);
  assert.equal(list.length, 40_000);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(list[0].subscription.lastPaidAt, OCT + 39_999, "latest payer first, as before");
});
