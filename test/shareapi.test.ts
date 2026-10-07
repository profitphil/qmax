import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import { PAYWALL } from "../src/config.ts";
import type { MarketData } from "../src/data.ts";
import { identityToBytes } from "../src/identity.ts";
import { DAY_MS } from "../src/membership.ts";
import { PayoutLog, QUTIL_ID, SEND_TO_MANY_PROC } from "../src/payouts.ts";
import { Meter } from "../src/meter.ts";
import { DEFAULT_SHARE_CONFIG } from "../src/profitshare.ts";
import { ProfitShare, profitShareRoutes, readSendToManyFee } from "../src/shareapi.ts";
import { UsageLog } from "../src/usage.ts";
import type { Archive } from "../src/usage.ts";
import { QPAYHUB_IDENTITY } from "../src/x402.ts";

const OWNER = PAYWALL.recipient;
// Some letters that are not "A" in more than one place: a run of "A"s is the all-zero public key, and one letter at the start is a contract's
// address. QUtil skips the first (keeping the money) and the payout builder refuses both.
const W = (c: string) => "Q" + c.repeat(19) + "R" + c.repeat(20) + "R" + c.repeat(17) + "Z";
const [A, B, C, D] = [W("A"), W("B"), W("C"), W("D")];
const OCT = Date.UTC(2026, 9, 1);
const NOV = Date.UTC(2026, 10, 1);
const KEY = "k".repeat(24);

/* ---------- a chain with payments to QMax and a place to send payouts ---------- */

interface Tx {
  hash: string;
  source: string;
  destination: string;
  amount: string;
  tickNumber: number;
  timestamp: string;
  inputType: number;
  inputData: string;
}
let n = 0;
const id60 = () => {
  const i = ++n;
  return String.fromCharCode(97 + (i % 26)).repeat(57) + String.fromCharCode(97 + Math.floor(i / 26) % 26) + String.fromCharCode(97 + Math.floor(i / 676) % 26) + String.fromCharCode(97 + (i % 7));
};

function subResource(discordId: string) {
  const r = Buffer.alloc(32);
  r.write("QMAXSUB", 0, "latin1");
  r[9] = 1;
  r.writeBigUInt64LE(BigInt(discordId), 16);
  return r;
}
const payInput = (resource: Buffer) => {
  const b = Buffer.alloc(72);
  Buffer.from(identityToBytes(OWNER)).copy(b, 0);
  resource.copy(b, 32);
  return b.toString("base64");
};
const named = (s: string) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.alloc(32 - s.length)]);

function world() {
  // `tickTime`: when the archive's newest tick happened (ms). By default it is fully caught up, so a scan is read as of the clock.
  const st = { lastTick: 9000, payhub: [] as Tx[], txs: new Map<string, Tx>(), events: {} as Record<string, object[]>, feeFails: false, tickTime: 9_000_000_000_000_000 };
  const ev = (hash: string, source: string, destination: string, amount: number) => ({ logType: 0, tickNumber: 1, timestamp: "1", logId: "1", epoch: 1, transactionHash: hash, quTransfer: { source, destination, amount: String(amount) } });
  /** A payment to QMax through QPayhub: the payer pays `gross`, QPayhub forwards the rest. */
  const payment = (payer: string, resource: Buffer, gross: number, t: number) => {
    const hash = id60();
    const tx: Tx = { hash, source: payer, destination: QPAYHUB_IDENTITY, amount: String(gross), tickNumber: 1000 + n, timestamp: String(t), inputType: 1, inputData: payInput(resource) };
    st.payhub.push(tx);
    st.events[hash] = [ev(hash, payer, QPAYHUB_IDENTITY, gross), ev(hash, QPAYHUB_IDENTITY, OWNER, gross - Math.max(100, Math.floor(gross * 0.0075)))];
    return tx;
  };
  const archive: Archive = {
    async get<T>() {
      return { logTickNumber: st.lastTick } as T;
    },
    async post<T>(path: string, body: any) {
      if (path.endsWith("/getTickData")) return { tickData: { tickNumber: body.tickNumber, timestamp: String(st.tickTime) } } as T;
      if (path.endsWith("/getTransactionByHash")) {
        const t = st.txs.get(body.hash);
        if (!t) throw new Error(`RPC 404 for ${path}: not found`);
        return t as T;
      }
      if (path.endsWith("/getEventLogs")) {
        const l = st.events[body.filters.transactionHash] ?? [];
        return { hits: { total: l.length }, eventLogs: l.slice(body.pagination.offset, body.pagination.offset + body.pagination.size) } as T;
      }
      if (path.endsWith("/getTransactionsForIdentity")) {
        if (body.identity === QPAYHUB_IDENTITY) {
          const { gte, lte } = body.ranges.tickNumber;
          const hits = st.payhub.filter((t) => t.tickNumber >= Number(gte) && t.tickNumber <= Number(lte));
          return { hits: { total: hits.length }, transactions: hits } as T;
        }
        if (body.identity === OWNER) {
          const { gte, lte } = body.ranges.timestamp;
          const hits = [...st.txs.values()].filter((t) => t.source === OWNER && Number(t.timestamp) >= Number(gte) && Number(t.timestamp) <= Number(lte));
          return { hits: { total: hits.length }, transactions: hits } as T;
        }
        // a wallet's own payments to QPayhub
        const hits = st.payhub.filter((t) => t.source === body.identity);
        return { hits: { total: hits.length }, transactions: hits } as T;
      }
      throw new Error("unexpected " + path);
    },
  };
  /** The owner signs a batch: the transaction lands and QUtil pays each wallet. */
  const signBatch = (b: { payload: string; amountQu: number; lines: { wallet: string; amountQu: number }[] }, at: number, tick = 8000) => {
    const hash = id60();
    st.txs.set(hash, { hash, source: OWNER, destination: QUTIL_ID, amount: String(b.amountQu), tickNumber: tick, timestamp: String(at), inputType: SEND_TO_MANY_PROC, inputData: b.payload });
    st.events[hash] = [ev(hash, OWNER, QUTIL_ID, b.amountQu), ...b.lines.map((l) => ev(hash, QUTIL_ID, l.wallet, l.amountQu))];
    return hash;
  };
  return { st, archive, payment, signBatch };
}

/** October 2026 on the chain: two Discord subscribers, a pass holder and an API customer. */
function october() {
  const w = world();
  w.payment(A, subResource("111"), 1_000_000, OCT + 2 * DAY_MS);
  w.payment(B, subResource("222"), 3_000_000, OCT + 5 * DAY_MS);
  w.payment(C, named("QMAXPASS"), 1_000, OCT + 6 * DAY_MS);
  w.payment(D, named("QMAXAPI"), 200_000, OCT + 7 * DAY_MS);
  return w;
}

async function service(w: ReturnType<typeof world>, clock: { now: number }, o: { fee?: () => Promise<number>; minPayoutQu?: number; minSubscriptionQu?: number } = {}) {
  const usage = new UsageLog({ archive: w.archive, recipient: OWNER, now: () => clock.now });
  const payouts = new PayoutLog("2026-10", { now: () => clock.now });
  const svc = new ProfitShare({
    usage,
    payouts,
    config: { ...DEFAULT_SHARE_CONFIG, ...(o.minPayoutQu !== undefined ? { minPayoutQu: o.minPayoutQu } : {}), ...(o.minSubscriptionQu !== undefined ? { minSubscriptionQu: o.minSubscriptionQu } : {}), excludeWallets: [OWNER] },
    membership: { subscriptionDays: 30, passHours: 24 },
    owner: OWNER,
    archive: w.archive,
    sendToManyFee: o.fee ?? (async () => 10),
    now: () => clock.now,
  });
  await usage.scanPayments();
  return { svc, usage, payouts };
}

/* ---------- membership ---------- */

test("a wallet that subscribed on Discord is a member here too, and its profit share shows", async () => {
  const w = october();
  const clock = { now: OCT + 20 * DAY_MS };
  const { svc } = await service(w, clock);
  const a = await svc.membership(A, false);
  assert.deepEqual([a.active, a.source, a.subscription.discordIds], [true, "subscription", ["111"]]);
  assert.equal(a.until, OCT + 32 * DAY_MS);
  assert.ok(a.profitShare);
  assert.equal(a.profitShare!.sharePct, 75);
  assert.ok(a.profitShare!.thisMonth.estimatedQu > 0 && a.profitShare!.thisMonth.provisional, "an estimate for the open month");
  assert.equal(a.profitShare!.earnedQu, 0, "nothing is earned for a month that has not ended");
  const c = await svc.membership(C, false);
  assert.deepEqual([c.active, c.source, c.pass.active], [false, null, false], "a 24-hour pass from the 6th has long ended");
  assert.equal((await svc.membership(OWNER, false)).profitShare, null, "QMax's own address does not share");
});

test("a member is recognised at once, before the next scan, by reading the wallet's own payments", async () => {
  const w = october();
  const clock = { now: OCT + 20 * DAY_MS };
  const { svc } = await service(w, clock);
  const E = W("E");
  w.payment(E, subResource("333"), 1_000_000, clock.now - 60_000); // paid a minute ago on Discord
  assert.equal((await svc.membership(E, false)).active, false, "the scan has not seen it yet");
  const e = await svc.membership(E);
  assert.deepEqual([e.active, e.subscription.discordIds], [true, ["333"]]);
});

/* ---------- subscribers and statements ---------- */

test("subscribers are listed with their status, what they paid, earned and are owed", async () => {
  const w = october();
  const clock = { now: NOV + 3 * DAY_MS };
  const { svc } = await service(w, clock);
  const s = svc.subscribers();
  assert.deepEqual([s.counts.everSubscribed, s.counts.activeNow], [2, 1], "A paid on 3 Oct, so its 30 days ended on 2 Nov; B paid on 6 Oct, so it runs to 5 Nov");
  assert.deepEqual(s.subscribers.map((x) => x.wallet), [B, A], "latest payer first");
  const b = s.subscribers[0];
  assert.deepEqual([b.discordIds, b.paidQu, b.payments], [["222"], 3_000_000, 1]);
  assert.ok(b.earnedQu > 0 && b.owedQu === b.earnedQu && b.paidOutQu === 0);
  assert.ok(b.earnedQu <= b.paidQu, "never more than it paid");
  assert.equal(s.totals.owedQu, s.subscribers.reduce((t, x) => t + x.owedQu, 0));
});

test("a statement for a month, and a bad month is refused", async () => {
  const w = october();
  const { svc } = await service(w, { now: NOV + 2 * 3_600_000 });
  const st = svc.statement("2026-10");
  assert.equal(st.period.complete, true);
  assert.equal(st.lines.length, 2);
  assert.equal(st.income.byKind.pass?.count, 1);
  assert.equal(svc.statement().period.id, "2026-11", "no period means the current one");
  assert.throws(() => svc.statement("2026-13"), /period must look like/);
});

/* ---------- planning and paying ---------- */

test("nothing is owed until a month is complete", async () => {
  const w = october();
  const { svc } = await service(w, { now: OCT + 20 * DAY_MS });
  await assert.rejects(svc.plan(), /No month is complete yet/);
});

test("the plan is the unsigned send-to-many transactions, with the exact attachment, and a fee that cannot be read stops it", async () => {
  const w = october();
  const { svc } = await service(w, { now: NOV + 2 * 3_600_000 });
  const p = await svc.plan();
  assert.deepEqual([p.throughPeriod, p.feeQu, p.wallets, p.batches.length], ["2026-10", 10, 2, 1]);
  const b = p.batches[0];
  assert.equal(b.tx.amountQu, b.lines.reduce((s, l) => s + l.amountQu, 0) + 10);
  assert.deepEqual([b.tx.destinationContractIndex, b.tx.inputType], [4, 1]);
  assert.equal(p.toWalletsQu, b.lines.reduce((s, l) => s + l.amountQu, 0));
  assert.match(p.howToSign, new RegExp(OWNER));

  const w2 = october();
  const failing = await service(w2, { now: NOV + 2 * 3_600_000 }, { fee: async () => { throw new Error("node down"); } });
  await assert.rejects(failing.svc.plan(), (e: any) => e.status === 502 && /not planning a payout without it/.test(e.message));
  assert.equal(failing.payouts.list().length, 0, "and nothing was recorded");
});

test("a balance under the minimum waits, and the plan says so", async () => {
  const w = october();
  const { svc } = await service(w, { now: NOV + 2 * 3_600_000 }, { minPayoutQu: 5_000_000 });
  const p = await svc.plan();
  assert.equal(p.batches.length, 0);
  assert.equal(p.skipped.length, 2);
  assert.match(p.skipped[0].reason, /below the 5,000,000 QU minimum/);
});

test("the whole payout: plan, reserve, sign on-chain, confirm, and nobody is paid twice", async () => {
  const w = october();
  const clock = { now: NOV + 2 * 3_600_000 };
  const { svc, payouts } = await service(w, clock);
  const plan = await svc.plan();
  const [b] = plan.batches;
  svc.signing(b.id);
  assert.equal((await svc.plan()).wallets, 0, "wallets in a batch being signed are not planned again");
  const hash = w.signBatch({ payload: b.tx.payloadBase64, amountQu: b.amountQu, lines: b.lines }, clock.now + 30_000);
  svc.sent(b.id, hash);
  clock.now += 120_000;
  const r = await svc.reconcile();
  assert.deepEqual(r.verified.map((x) => x.id), [b.id]);
  assert.equal(svc.payoutsView().batches[0].status, "verified");
  const bal = svc.balancesView();
  assert.equal(bal.totalOwedQu, 0, "what was paid is no longer owed");
  assert.equal(bal.totalPaidQu, b.toWalletsQu);
  assert.equal((await svc.plan()).batches.length, 0, "so there is nothing left to plan");
  assert.equal(payouts.paidByWallet().get(A) !== undefined, true);
  const sub = svc.subscribers().subscribers.find((x) => x.wallet === A)!;
  assert.deepEqual([sub.owedQu, sub.paidOutQu > 0], [0, true]);
  const me = await svc.membership(A, false);
  assert.deepEqual([me.profitShare!.owedQu, me.profitShare!.paidQu > 0], [0, true], "and the member sees it paid");
});

test("a batch cannot be signed twice, an unknown or malformed id is refused, and only a plan can be cancelled", async () => {
  const w = october();
  const { svc } = await service(w, { now: NOV + 2 * 3_600_000 });
  const [b] = (await svc.plan()).batches;
  svc.signing(b.id);
  assert.throws(() => svc.signing(b.id), (e: any) => e.status === 409 && /not waiting to be signed/.test(e.message));
  assert.throws(() => svc.cancel(b.id), (e: any) => e.status === 409);
  assert.throws(() => svc.signing("0123456789abcdef"), (e: any) => e.status === 404);
});

test("QUtil's fee is read from the contract's answer, and an answer that makes no sense is refused", async () => {
  const bytes = (n: bigint) => new Uint8Array(new BigInt64Array([n]).buffer);
  assert.equal(await readSendToManyFee(async (c, f) => (assert.deepEqual([c, f], [4, 1]), bytes(10n))), 10);
  await assert.rejects(readSendToManyFee(async () => new Uint8Array(3)), /too short/);
  await assert.rejects(readSendToManyFee(async () => bytes(-1n)), /does not look right/);
  await assert.rejects(readSendToManyFee(async () => bytes(5_000_000n)), /does not look right/);
});

/* ---------- over HTTP ---------- */

const w = october();
const clock = { now: NOV + 2 * 3_600_000 };
const { svc } = await service(w, clock);
const data: MarketData = { assets: () => [], venues: async () => null };
const meter = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: OWNER, lookupReceipt: async () => null });
const server = createApi({ data, apiKey: KEY, meter, routes: profitShareRoutes(svc) });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const call = (path: string, o: { key?: string; post?: unknown } = {}) =>
  fetch(base + path, { method: o.post !== undefined ? "POST" : "GET", headers: { ...(o.key ? { "x-api-key": o.key } : {}), "content-type": "application/json" }, ...(o.post !== undefined ? { body: JSON.stringify(o.post) } : {}) });

test("membership is public; the subscriber list, statements and payouts are for QMax's own key only", async () => {
  assert.equal((await call(`/v1/membership?wallet=${A}`)).status, 200);
  assert.equal((await call("/v1/membership?wallet=nope")).status, 400);
  const open = (await (await call(`/v1/membership?wallet=${A}`)).json()) as { subscription: Record<string, unknown> };
  assert.ok((await svc.membership(A, false)).subscription.discordIds.length > 0, "the service itself does know them (this is not an empty case)");
  assert.ok(!("discordIds" in open.subscription), "which Discord accounts a wallet paid for is not handed to anyone who asks about the wallet");
  assert.ok(!JSON.stringify(open).match(/discordIds/));
  for (const path of ["/v1/subscribers", "/v1/profit-share", "/v1/profit-share/balances", "/v1/profit-share/payouts"]) {
    assert.equal((await call(path)).status, 401, path);
    assert.equal((await call(path, { key: "j".repeat(24) })).status, 401, path + " with a wrong key");
    assert.equal((await call(path, { key: KEY })).status, 200, path + " with the key");
  }
  for (const path of ["/v1/profit-share/payouts/prepare", "/v1/profit-share/payouts/signing", "/v1/profit-share/payouts/sent", "/v1/profit-share/payouts/cancel", "/v1/profit-share/payouts/reconcile"]) {
    assert.equal((await call(path, { post: {} })).status, 401, path);
  }
});

test("the admin endpoints are left out of the public API description, the membership one is in it", async () => {
  const doc = (await (await call("/v1/openapi.json")).json()) as { paths: Record<string, unknown> };
  assert.ok(doc.paths["/v1/membership"]);
  assert.equal(doc.paths["/v1/subscribers"], undefined);
  assert.equal(doc.paths["/v1/profit-share/payouts/prepare"], undefined);
});

test("the payout works end to end through the API", async () => {
  const prep = await call("/v1/profit-share/payouts/prepare", { key: KEY, post: {} });
  assert.equal(prep.status, 200);
  const plan = (await prep.json()) as { batches: { id: string; amountQu: number; tx: { payloadBase64: string }; lines: { wallet: string; amountQu: number }[] }[] };
  const b = plan.batches[0];
  assert.equal((await call("/v1/profit-share/payouts/signing", { key: KEY, post: { id: b.id } })).status, 200);
  assert.equal((await call("/v1/profit-share/payouts/signing", { key: KEY, post: { id: b.id } })).status, 409, "not twice");
  assert.equal((await call("/v1/profit-share/payouts/signing", { key: KEY, post: { id: "nope" } })).status, 400);
  const hash = w.signBatch({ payload: b.tx.payloadBase64, amountQu: b.amountQu, lines: b.lines }, clock.now + 30_000);
  assert.equal((await call("/v1/profit-share/payouts/sent", { key: KEY, post: { id: b.id } })).status, 400, "a transaction id is required");
  assert.equal((await call("/v1/profit-share/payouts/sent", { key: KEY, post: { id: b.id, txId: hash } })).status, 200);
  clock.now += 120_000;
  const rec = (await (await call("/v1/profit-share/payouts/reconcile", { key: KEY, post: {} })).json()) as { verified: string[] };
  assert.deepEqual(rec.verified, [b.id]);
  const list = (await (await call("/v1/profit-share/payouts", { key: KEY })).json()) as { batches: { status: string }[]; totalPaidQu: number };
  assert.deepEqual([list.batches[0].status, list.totalPaidQu > 0], ["verified", true]);
  const bal = (await (await call("/v1/profit-share/balances", { key: KEY })).json()) as { totalOwedQu: number };
  assert.equal(bal.totalOwedQu, 0);
});

test("the public membership lookup has its own limit, so the app can call it freely without eating the quote allowance", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 40; i++) codes.push((await call(`/v1/membership?wallet=${B}`)).status);
  assert.ok(codes.includes(429), "a flood is stopped");
  assert.equal(codes[0], 200);
  assert.equal((await call("/v1/subscribers", { key: KEY })).status, 200, "and the keyed endpoints are not affected");
});

test("an active subscription unlocks trading on the website unless the operator turns that off; a pass always does", async () => {
  const w1 = october();
  const clock1 = { now: OCT + 20 * DAY_MS };
  const on = (await service(w1, clock1)).svc;
  assert.equal((await on.membership(A, false)).unlocksWebTrading, true);
  assert.equal((await on.membership(W("Q"), false)).unlocksWebTrading, false, "not a member");
  const w2 = october();
  w2.payment(C, named("QMAXPASS"), 1_000, clock1.now - 3_600_000);
  const usage = new UsageLog({ archive: w2.archive, recipient: OWNER, now: () => clock1.now });
  const off = new ProfitShare({ usage, payouts: new PayoutLog("2026-10", { now: () => clock1.now }), config: { ...DEFAULT_SHARE_CONFIG, excludeWallets: [OWNER] }, membership: { subscriptionDays: 30, passHours: 24 }, owner: OWNER, archive: w2.archive, subscriptionUnlocksWeb: false, sendToManyFee: async () => 10, now: () => clock1.now });
  await usage.scanPayments();
  assert.deepEqual([(await off.membership(A, false)).active, (await off.membership(A, false)).unlocksWebTrading], [true, false], "still a member, but trading on the site needs a pass");
  assert.equal((await off.membership(C, false)).unlocksWebTrading, true, "a pass still unlocks it");
});

/* ---------- adversarial review ---------- */

test("a month is not owed while the archive is hours behind, even though the scan ran after the month ended", async () => {
  const w = october();
  w.payment(A, subResource("111"), 2_000_000, NOV - 30 * 60_000); // 23:30 on 31 October: the archive has not got this far yet
  w.st.tickTime = NOV - 2 * 3_600_000; // its newest tick is from 22:00
  const clock = { now: NOV + 20 * 60_000 }; // the scan runs at 00:20, comfortably "after" the month
  const { svc, usage } = await service(w, clock);
  await assert.rejects(svc.plan(), /No month is complete yet/, "with the last half hour of payments missing, the numbers are not final and nothing is planned from them");
  assert.equal(svc.balancesView().periods.length, 0);
  // The archive catches up; the next scan reads everything, and now the month is complete, including the late payment.
  w.st.tickTime = NOV + 20 * 60_000;
  clock.now = NOV + 40 * 60_000;
  w.st.lastTick += 10;
  await usage.scanPayments();
  const p = await svc.plan();
  assert.equal(p.throughPeriod, "2026-10");
  assert.equal(svc.statement("2026-10").lines.find((l) => l.wallet === A)!.paidQu, 3_000_000, "the 23:30 payment is in");
});

test("the admin endpoints cannot be reached with no key configured, an empty key, a customer's key, or a key that is only close", async () => {
  const w3 = october();
  const clock3 = { now: NOV + 2 * 3_600_000 };
  const { svc: svc3 } = await service(w3, clock3);
  const m = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: OWNER, lookupReceipt: async () => null });
  const customer = m.createKey().key;
  const admin = ["/v1/subscribers", "/v1/profit-share", "/v1/profit-share/balances", "/v1/profit-share/payouts"];
  const posts = ["/v1/profit-share/payouts/prepare", "/v1/profit-share/payouts/signing", "/v1/profit-share/payouts/sent", "/v1/profit-share/payouts/cancel", "/v1/profit-share/payouts/reconcile"];
  const serve = async (apiKey: string | undefined, meter?: Meter) => {
    const s = createApi({ data, apiKey, ...(meter ? { meter } : {}), routes: profitShareRoutes(svc3) });
    await new Promise<void>((r) => s.listen(0, () => r()));
    return { s, url: `http://localhost:${(s.address() as AddressInfo).port}` };
  };
  const status = async (url: string, path: string, headers: Record<string, string>, post = false) => (await fetch(url + path, { method: post ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, ...(post ? { body: "{}" } : {}) })).status;
  const noKeyServers = [await serve(undefined, m), await serve("", m), await serve(undefined), await serve("")];
  const keyed = await serve(KEY, m);
  const keyedNoMeter = await serve(KEY);
  try {
    for (const { url } of noKeyServers) {
      for (const path of admin) for (const h of [{} as Record<string, string>, { "x-api-key": "" }, { "x-api-key": " " }, { "x-api-key": "undefined" }, { "x-api-key": customer }]) assert.equal(await status(url, path, h), 401, `${path} ${JSON.stringify(h)} with no API_KEY configured`);
      for (const path of posts) assert.equal(await status(url, path, { "x-api-key": "" }, true), 401, path);
    }
    for (const { url } of [keyed, keyedNoMeter]) {
      for (const path of admin) {
        // A wrong key is refused with 401, or with 429 once one address has tried too many (that throttle is its own test, in security-api.test.ts).
        for (const wrong of [KEY.slice(0, -1), KEY + "k", "k" + KEY, KEY.slice(0, -1) + "j", KEY.toUpperCase(), ""]) assert.ok([401, 429].includes(await status(url, path, { "x-api-key": wrong })), `${path} with '${wrong}'`);
        assert.equal(await status(url, path, { "X-API-KEY": KEY }), 200, "header names are case-insensitive, the key is not");
      }
      for (const path of posts) assert.ok([401, 429].includes(await status(url, path, { "x-api-key": KEY.slice(0, -1) + "j" }, true)), path);
    }
    assert.equal(await status(keyed.url, "/v1/subscribers", { "x-api-key": customer }), 401, "a prepaid customer's key is not QMax's own key");
    assert.equal(await status(keyed.url, "/v1/membership?wallet=" + A, {}), 200, "while the public lookup stays open");
  } finally {
    for (const { s } of [...noKeyServers, keyed, keyedNoMeter]) s.close();
  }
});

test("a payout confirmed while the next plan is waiting for QUtil's fee is not planned a second time", async () => {
  const w = october();
  const clock = { now: NOV + 2 * 3_600_000 };
  let during: (() => Promise<unknown>) | undefined;
  const { svc } = await service(w, clock, { fee: async () => { await during?.(); return 10; } });
  const [b] = (await svc.plan()).batches;
  svc.signing(b.id);
  const hash = w.signBatch({ payload: b.tx.payloadBase64, amountQu: b.amountQu, lines: b.lines }, clock.now + 30_000);
  svc.sent(b.id, hash);
  clock.now += 120_000;
  // The owner asks for a new plan; while it waits for the fee, the background check finds the batch on-chain and credits it.
  during = () => svc.reconcile();
  const again = await svc.plan();
  assert.equal(svc.payoutsView().batches.find((x) => x.id === b.id)!.status, "verified", "the batch was confirmed meanwhile");
  assert.equal(again.wallets, 0, "so what it paid is not planned again from balances that were read before it was credited");
  assert.equal(again.batches.length, 0);
});

test("a plan that went stale is refused at signing: a wallet paid meanwhile is not paid a second time", async () => {
  const w = october();
  const clock = { now: NOV + 2 * 3_600_000 };
  const { svc, payouts } = await service(w, clock);
  const [b] = (await svc.plan()).batches;
  assert.ok(b.lines.length >= 2);
  // Meanwhile a payout for one of its wallets that was signed outside QMax is found on the chain and credited.
  const paidAlready = b.lines[0];
  payouts.list().push({ id: "ffffffffffffffff", createdAt: clock.now - 1000, throughPeriod: "2026-10", lines: [paidAlready], feeQu: 10, amountQu: paidAlready.amountQu + 10, payload: "x", status: "verified", paid: [paidAlready], paidTx: ["t"] });
  assert.throws(() => svc.signing(b.id), (e: any) => e.status === 409 && /out of date/.test(e.message) && e.message.includes(paidAlready.wallet));
  assert.equal(payouts.get(b.id)!.status, "prepared", "nothing was reserved or signed");
  const again = await svc.plan();
  assert.ok(!again.batches.flatMap((x) => x.lines).some((l) => l.wallet === paidAlready.wallet), "a new plan leaves it out");
  assert.equal(again.batches[0].lines.length, b.lines.length - 1);
  svc.signing(again.batches[0].id); // and the new plan can be signed
});

test("a plan for a wallet that is excluded or is QMax's own address cannot be signed either", async () => {
  const w = october();
  const clock = { now: NOV + 2 * 3_600_000 };
  const { svc, payouts } = await service(w, clock);
  const [b] = (await svc.plan()).batches;
  // The settings changed since the plan was made: one of its wallets is now left out of the programme.
  (svc as any).d.config.excludeWallets.push(b.lines[0].wallet);
  assert.throws(() => svc.signing(b.id), (e: any) => e.status === 409 && /out of date/.test(e.message));
  assert.equal(payouts.get(b.id)!.status, "prepared");
});

test("one setting, SUBSCRIPTION_MIN_QU, decides what a subscription is for membership and for the profit share alike", async () => {
  const w = october();
  const E = W("E");
  const clock = { now: OCT + 20 * DAY_MS };
  w.payment(E, subResource("333"), 500, clock.now - 60_000); // dust that names a Discord user
  const strict = (await service(w, clock, { minSubscriptionQu: 100_000 })).svc;
  assert.equal((await strict.membership(E, false)).active, false, "not a member");
  assert.equal((await strict.membership(E, false)).subscription.payments, 0);
  assert.equal((await strict.membership(A, false)).active, true, "a real subscriber still is");
  assert.deepEqual(strict.subscribers().subscribers.map((x) => x.wallet).sort(), [A, B].sort());
  assert.equal(strict.statement("2026-10").income.belowMinimum.payments, 1, "the dust is shown on the statement, not hidden");
  const lenient = (await service(w, clock)).svc;
  assert.equal((await lenient.membership(E, false)).active, true, "with no minimum it counts, as it always did");
  assert.equal(lenient.subscribers().subscribers.length, 3);
});

test("a payer the payout cannot be built for stops the plan with a plain refusal instead of an internal error", async () => {
  const w = october();
  w.payment(QUTIL_ID, subResource("444"), 2_000_000, OCT + 8 * DAY_MS); // a contract's address as a payer: nothing real, but it must not crash the plan or be paid
  const { svc, payouts } = await service(w, { now: NOV + 2 * 3_600_000 });
  await assert.rejects(svc.plan(), (e: any) => e.status === 409 && /Could not build the payout/.test(e.message) && /not a wallet that can be paid/.test(e.message));
  assert.equal(payouts.list().filter((b) => b.status === "prepared").length, 0, "nothing half-planned is left");
});

test("the public lookup does not redo the whole books for every call, but anything that changes them is seen at once", async () => {
  // Payments to QMax cost a sender next to nothing, and the books are walked in full each time they are worked out, so a flood of lookups
  // must not each pay that price.
  const w = october();
  const clock = { now: NOV + 2 * 3_600_000 };
  const { svc, payouts, usage } = await service(w, clock);
  let worked = 0;
  const real = payouts.paidByWallet.bind(payouts);
  payouts.paidByWallet = () => (worked++, real());
  for (let i = 0; i < 20; i++) await svc.membership(A, false);
  assert.equal(worked, 1, "twenty lookups, one working-out of the books");
  // A change to the ledger is seen by the next lookup.
  const [b] = (await svc.plan()).batches;
  worked = 0;
  const before = (await svc.membership(A, false)).profitShare!.paidQu;
  svc.signing(b.id);
  const hash = w.signBatch({ payload: b.tx.payloadBase64, amountQu: b.amountQu, lines: b.lines }, clock.now + 30_000);
  svc.sent(b.id, hash);
  clock.now += 120_000;
  await svc.reconcile();
  const after = (await svc.membership(A, false)).profitShare!.paidQu;
  assert.equal(before, 0);
  assert.ok(after > 0, "the payout that was just confirmed shows");
  // Planning and paying read the books fresh every time.
  worked = 0;
  await svc.plan();
  svc.balancesView();
  svc.subscribers();
  assert.ok(worked >= 3, "the admin reads never use the reused answer");
  assert.ok(usage.paymentRevision() > 0);
});

/* ---------- a whole programme, many months, with things going wrong ---------- */

test("over several months, whatever goes wrong while paying, the books match the chain, and nobody is paid twice unless a batch really was signed twice", async () => {
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const seen = { refund: 0, lost: 0, twice: 0, normal: 0, batches: 0, dustSkipped: 0 };
  for (let run = 0; run < 12; run++) {
    const w = world();
    const clock = { now: OCT + 3 * DAY_MS };
    const usage = new UsageLog({ archive: w.archive, recipient: OWNER, now: () => clock.now });
    const payouts = new PayoutLog("2026-10", { now: () => clock.now });
    const svc = new ProfitShare({ usage, payouts, config: { ...DEFAULT_SHARE_CONFIG, minPayoutQu: 1000, minSubscriptionQu: 500_000, excludeWallets: [OWNER] }, membership: { subscriptionDays: 30, passHours: 24 }, owner: OWNER, archive: w.archive, sendToManyFee: async () => 10, now: () => clock.now });
    const wallets = Array.from({ length: 6 }, (_, i) => W(String.fromCharCode(65 + i)));
    const received = new Map<string, number>(); // what the chain says each wallet got from the owner's batches
    const dup = new Set<string>(); // wallets whose batch was deliberately signed twice
    let tickNo = 10_000;
    let hadDuplicate = false;
    for (let month = 0; month < 4; month++) {
      tickNo += 1000; // each month's ticks come after the last: payments at tickNo+1.., batches signed at tickNo+950
      const start = Date.UTC(2026, 9 + month, 1);
      // This month's payments: real subscriptions and dust, from random wallets, at random moments (some right on the edges of the month).
      for (let i = 0, k = 1 + Math.floor(rnd() * 8); i < k; i++) {
        const when = rnd() < 0.15 ? (rnd() < 0.5 ? start : Date.UTC(2026, 9 + month + 1, 1) - 1) : start + Math.floor(rnd() * 27 * DAY_MS);
        const gross = rnd() < 0.3 ? 100 + Math.floor(rnd() * 5000) : 600_000 + Math.floor(rnd() * 3_000_000);
        const t = w.payment(wallets[Math.floor(rnd() * wallets.length)], subResource(String(1 + Math.floor(rnd() * 99))), gross, when);
        t.tickNumber = ++tickNo;
      }
      // The month ends; the archive is up to date; QMax reads the chain and plans.
      clock.now = Date.UTC(2026, 9 + month + 1, 1) + 2 * 3_600_000;
      w.st.lastTick = tickNo + 900;
      await usage.scanPayments();
      let plan;
      try {
        plan = await svc.plan();
      } catch (e: any) {
        assert.equal(e.status, 409, "only 'nothing to pay' may stop a plan");
        continue;
      }
      seen.batches += plan.batches.length;
      for (const b of plan.batches) {
        svc.signing(b.id);
        const mode = rnd();
        const sign = (at: number, refund = false) => {
          const hash = w.signBatch({ payload: b.tx.payloadBase64, amountQu: b.amountQu, lines: b.lines }, at, tickNo + 950);
          if (refund) w.st.events[hash] = [w.st.events[hash][0], { logType: 0, tickNumber: 1, timestamp: "1", logId: "1", epoch: 1, transactionHash: hash, quTransfer: { source: QUTIL_ID, destination: OWNER, amount: String(b.amountQu) } }];
          else for (const l of b.lines) received.set(l.wallet, (received.get(l.wallet) ?? 0) + l.amountQu);
          return hash;
        };
        seen[mode < 0.15 ? "refund" : mode < 0.3 ? "lost" : mode < 0.4 ? "twice" : "normal"]++;
        if (mode < 0.15) {
          sign(clock.now + 20_000, true); // QUtil refunds it (the fee changed, say): nobody was paid
        } else if (mode < 0.3) {
          const h = sign(clock.now + 20_000); // the request that reports the id is lost: QMax must find it by its bytes
          void h;
        } else if (mode < 0.4) {
          const h = sign(clock.now + 20_000);
          svc.sent(b.id, h);
          sign(clock.now + 5 * 60_000); // signed a second time by mistake
          hadDuplicate = true;
          for (const l of b.lines) dup.add(l.wallet);
        } else {
          svc.sent(b.id, sign(clock.now + 20_000));
        }
      }
      clock.now += 3 * 60_000;
      w.st.lastTick = tickNo + 990;
      await svc.reconcile();
      clock.now += 3 * 60_000;
      await svc.reconcile();
      // The books say exactly what the chain says, to the QU, for every wallet.
      const books = payouts.paidByWallet();
      for (const [wallet, q] of received) assert.equal(books.get(wallet) ?? 0, q, `run ${run} month ${month}: books and chain disagree for ${wallet}`);
      for (const [wallet, q] of books) assert.equal(received.get(wallet) ?? 0, q);
      // Nothing is stuck in flight once the chain has answered.
      assert.equal(payouts.inFlight().size, 0, `run ${run} month ${month}: wallets left reserved`);
    }
    // Over the whole programme, no wallet got more than it earned unless a batch was deliberately signed twice.
    clock.now = Date.UTC(2027, 1, 1) + 3_600_000;
    w.st.lastTick = tickNo + 5000;
    await usage.scanPayments();
    const bal = svc.balancesView();
    for (const b of bal.balances) {
      const got = received.get(b.wallet) ?? 0;
      assert.ok(b.paidQu === got);
      if (!dup.has(b.wallet)) assert.ok(got <= b.earnedQu, `run ${run}: ${b.wallet} was paid ${got} of ${b.earnedQu} earned`);
    }
    // Every complete month's pool was respected as a whole.
    let pools = 0;
    for (const p of bal.periods) pools += svc.statement(p).pool.distributedQu;
    assert.equal(bal.totalEarnedQu, pools);
    if (!hadDuplicate) assert.ok(bal.totalPaidQu <= bal.totalEarnedQu);
    seen.dustSkipped += svc.statement("2026-10").income.belowMinimum.payments;
  }
  assert.ok(seen.refund > 0 && seen.lost > 0 && seen.twice > 0 && seen.normal > 0 && seen.batches >= 20 && seen.dustSkipped > 0, `the simulation must exercise every case: ${JSON.stringify(seen)}`);
});
