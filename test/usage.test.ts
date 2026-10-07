import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.ts";
import { PAYWALL } from "../src/config.ts";
import type { MarketData } from "../src/data.ts";
import { identityToBytes } from "../src/identity.ts";
import { QSWAP_ID, QX_ID } from "../src/ledger.ts";
import { GIVE_UP_MS, MAX_PENDING_PER_SOURCE, NOT_FOUND_GIVE_UP_MS, REPORT_WINDOW_MS, UsageLog, classifyCall, decodePayment } from "../src/usage.ts";
import type { Archive } from "../src/usage.ts";
import { QPAYHUB_IDENTITY, SESSION_RESOURCE_ID, resourceTag } from "../src/x402.ts";
import { ev, qx, swap } from "./trade-helpers.ts";

const A = "A".repeat(59) + "B";
const B = "C".repeat(59) + "D";
const hash = (n: number) => String.fromCharCode(97 + (n % 26)).repeat(58) + String.fromCharCode(97 + Math.floor(n / 26) % 26) + String.fromCharCode(97 + (n % 7));
const MIN = 60_000;
const T0 = 1_791_000_000_000;

interface Tx {
  hash: string;
  source: string;
  destination: string;
  amount: string;
  tickNumber: number;
  timestamp: string;
  inputType: number;
  inputData?: string;
  moneyFlew?: boolean;
}
const tx = (n: number, o: Partial<Tx> = {}): Tx => ({ hash: hash(n), source: A, destination: QX_ID, amount: "0", tickNumber: 1000 + n, timestamp: String(T0), inputType: 6, moneyFlew: true, ...o });
const withHash = <T extends object>(e: T, h: string) => ({ ...e, transactionHash: h });

/** A stand-in for the archive: transactions and their events by hash, and the QPayhub payment list. */
function chain(o: { lastTick?: number; txs?: Tx[]; events?: Record<string, object[]>; payhub?: Tx[]; capSpan?: number }) {
  const state = {
    lastTick: o.lastTick ?? 5000,
    /** How far the archive's transaction index has got, when it differs from its event index (`logTickNumber`). Unset: the same. */
    txTick: undefined as number | undefined,
    /** What an answer says it is valid up to (`validForTick`): the tick the serving replica had reached. Unset: the answers carry none. */
    validForEvents: undefined as number | undefined,
    validForTxs: undefined as number | undefined,
    txs: new Map((o.txs ?? []).map((t) => [t.hash, t])),
    events: o.events ?? {},
    payhub: o.payhub ?? [],
    calls: [] as { path: string; body?: any }[],
    /** When a tick happened (ms), or null for an empty tick (the archive answers `tickData: null` for those). By default the archive is fully caught up. */
    tickTime: ((_tick: number) => 9_000_000_000_000_000) as (tick: number) => number | null,
  };
  const archive: Archive = {
    async get<T>(path: string) {
      state.calls.push({ path });
      return { logTickNumber: state.lastTick, ...(state.txTick !== undefined ? { tickNumber: state.txTick } : {}) } as T;
    },
    async post<T>(path: string, body: any) {
      state.calls.push({ path, body });
      if (path.endsWith("/getTickData")) {
        const at = state.tickTime(body.tickNumber);
        return { tickData: at === null ? null : { tickNumber: body.tickNumber, timestamp: String(at) } } as T;
      }
      if (path.endsWith("/getTransactionByHash")) {
        const t = state.txs.get(body.hash);
        if (!t) throw new Error(`RPC 404 for ${path}: not found`);
        return t as T;
      }
      if (path.endsWith("/getEventLogs")) {
        const list = state.events[body.filters.transactionHash] ?? [];
        return { hits: { total: list.length }, eventLogs: list.slice(body.pagination.offset, body.pagination.offset + body.pagination.size), ...(state.validForEvents !== undefined ? { validForTick: state.validForEvents } : {}) } as T;
      }
      if (path.endsWith("/getTransactionsForIdentity")) {
        assert.equal(body.identity, QPAYHUB_IDENTITY);
        assert.equal(body.filters.inputType, "1");
        const { gte, lte } = body.ranges.tickNumber;
        assert.notEqual(gte, lte, "the archive refuses equal tick ends");
        let hits = state.payhub.filter((t) => t.tickNumber >= Number(gte) && t.tickNumber <= Number(lte) && (state.txTick === undefined || t.tickNumber <= state.txTick));
        // Emulates the 10,000-result cap: a wide span reports "full", and only a narrow one can be read.
        const total = o.capSpan && Number(lte) - Number(gte) > o.capSpan ? 10_000 : hits.length;
        if (total >= 10_000) hits = [];
        if (state.validForTxs !== undefined) hits = hits.filter((t) => t.tickNumber <= state.validForTxs!);
        return { hits: { total: state.validForTxs !== undefined ? hits.length : total }, transactions: hits.slice(body.pagination.offset, body.pagination.offset + body.pagination.size), ...(state.validForTxs !== undefined ? { validForTick: state.validForTxs } : {}) } as T;
      }
      throw new Error("unexpected " + path);
    },
  };
  return { archive, state };
}

const log = (c: ReturnType<typeof chain>, o: { file?: string; now?: () => number } = {}) => new UsageLog({ archive: c.archive, recipient: PAYWALL.recipient, now: o.now ?? (() => T0 + MIN), ...(o.file ? { file: o.file } : {}) });

test("only well-formed reports are queued, once each", () => {
  const u = log(chain({}));
  assert.equal(u.report(null), null);
  assert.equal(u.report({ wallet: "short", txIds: [hash(1)] }), null, "a wallet must be a 60-letter identity");
  assert.equal(u.report({ wallet: A, txIds: [] }), null);
  assert.equal(u.report({ wallet: A, txIds: ["nope"] }), null, "a transaction id is 60 lowercase letters");
  assert.equal(u.report({ wallet: A, txIds: Array.from({ length: 11 }, (_, i) => hash(i)) }), null, "at most ten per report");
  assert.equal(u.report({ wallet: A, txIds: [hash(1), hash(1), hash(2)] }), 2, "duplicates in one report count once");
  assert.equal(u.report({ wallet: A, txIds: [hash(1)] }), 0, "an id already waiting is not queued again");
  assert.equal(u.stats({}, T0 + MIN).verification.pending, 2);
});

test("a QX buy that filled is counted with its asset, side and QU", async () => {
  const t = tx(1, { inputType: 6, amount: "5000" });
  const c = chain({ txs: [t], events: { [t.hash]: [withHash(qx(t.tickNumber, T0, "CFB", 100, 50), t.hash), withHash(qx(t.tickNumber, T0, "CFB", 101, 10), t.hash)] } });
  const u = log(c);
  u.report({ wallet: A, txIds: [t.hash], ref: "partner" });
  assert.equal(await u.verifyPending(), 1);
  const s = u.stats({}, T0 + MIN);
  assert.equal(s.totals.trades, 1);
  assert.equal(s.totals.quVolume, 100 * 50 + 101 * 10);
  assert.deepEqual(s.byRef.map((r) => [r.ref, r.trades]), [["partner", 1]]);
  assert.equal(s.topAssets[0].asset, "CFB");
  const w = u.walletStats(A);
  assert.equal(w.trades[0].side, "buy");
  assert.equal(w.trades[0].venue, "QX");
  assert.equal(w.trades[0].fills, 2);
});

test("a QSwap swap counts by the event's direction, and liquidity counts as an operation", async () => {
  const sell = tx(2, { destination: QSWAP_ID, inputType: 8 });
  const add = tx(3, { destination: QSWAP_ID, inputType: 4 });
  const c = chain({
    txs: [sell, add],
    events: {
      [sell.hash]: [withHash(swap(8, sell.tickNumber, T0, "QDOGE", 400, 9000), sell.hash)],
      [add.hash]: [withHash(ev(13, 4, add.tickNumber, T0, "QDOGE", 1, 1), add.hash)],
    },
  });
  const u = log(c);
  u.report({ wallet: A, txIds: [sell.hash, add.hash], channel: "discord" });
  assert.equal(await u.verifyPending(), 2);
  const s = u.stats({}, T0 + MIN);
  assert.equal(s.totals.trades, 1);
  assert.equal(s.totals.quVolume, 9000);
  assert.equal(s.totals.liquidityOps, 1);
  assert.deepEqual(s.byChannel.map((r) => r.channel), ["discord"]);
  assert.equal(s.byVenue[0].venue, "QSwap");
});

test("what is not a trade by that wallet is rejected for good, and not looked up again", async () => {
  const cancel = tx(4, { inputType: 7 });
  const other = tx(5, { source: B });
  const toPayhub = tx(6, { destination: QPAYHUB_IDENTITY, inputType: 1 });
  const empty = tx(7); // a QX order that did not fill
  const refusedAdd = tx(12, { destination: QSWAP_ID, inputType: 4 }); // liquidity QSwap refused: no event
  const old = tx(8, { timestamp: String(T0 - REPORT_WINDOW_MS - 1) });
  const events = { [old.hash]: [withHash(qx(old.tickNumber, T0, "CFB", 1, 1), old.hash)] };
  const c = chain({ txs: [cancel, other, toPayhub, empty, old, refusedAdd], events });
  const u = log(c);
  u.report({ wallet: A, txIds: [cancel.hash, other.hash, toPayhub.hash, empty.hash, old.hash, refusedAdd.hash] });
  assert.equal(await u.verifyPending(10), 6);
  const s = u.stats({}, T0 + MIN);
  assert.equal(s.totals.trades, 0);
  assert.deepEqual(s.verification.rejected, { "not-a-trade": 2, "wrong-wallet": 1, "no-effect": 2, "too-old": 1 });
  const before = c.state.calls.length;
  assert.equal(u.report({ wallet: A, txIds: [cancel.hash] }), 0);
  assert.equal(c.state.calls.length, before, "a rejected id is remembered");
});

test("a transaction the archive has not indexed yet is retried, then counted", async () => {
  let now = T0 + MIN;
  const t = tx(9, { tickNumber: 6000 });
  const c = chain({ lastTick: 5000, events: { [t.hash]: [withHash(qx(6000, T0, "CFB", 10, 3), t.hash)] } });
  const u = log(c, { now: () => now });
  u.report({ wallet: A, txIds: [t.hash] });
  assert.equal(await u.verifyPending(), 0, "not indexed yet");
  assert.equal(await u.verifyPending(), 0, "and not asked again straight away");
  now += 60_000;
  c.state.txs.set(t.hash, t);
  assert.equal(await u.verifyPending(), 0, "found, but its events are newer than the archive's last processed tick");
  now += 600_000;
  c.state.lastTick = 7000;
  assert.equal(await u.verifyPending(), 1);
  assert.equal(u.stats({}, now).totals.trades, 1);
});

test("an id the archive does not know is dropped after 15 minutes: a real trade is indexed within a minute", async () => {
  let now = T0 + MIN;
  const u = log(chain({}), { now: () => now });
  u.report({ wallet: A, txIds: [hash(10)] });
  await u.verifyPending();
  now += NOT_FOUND_GIVE_UP_MS - MIN;
  assert.equal(await u.verifyPending(), 0, "still waiting inside the 15 minutes");
  now += 2 * MIN;
  assert.equal(await u.verifyPending(), 1);
  const s = u.stats({}, now);
  assert.equal(s.verification.pending, 0);
  assert.deepEqual(s.verification.rejected, { unverified: 1 });
});

test("a real transaction whose events never arrive gets two hours", async () => {
  let now = T0 + MIN;
  const t = tx(13, { tickNumber: 9000 }); // newer than the archive's last processed tick, for ever
  const u = log(chain({ lastTick: 5000, txs: [t] }), { now: () => now });
  u.report({ wallet: A, txIds: [t.hash] });
  await u.verifyPending();
  now += NOT_FOUND_GIVE_UP_MS + MIN;
  assert.equal(await u.verifyPending(), 0, "the 15-minute limit is for ids the archive does not know");
  now += GIVE_UP_MS;
  assert.equal(await u.verifyPending(), 1);
  assert.deepEqual(u.stats({}, now).verification.rejected, { unverified: 1 });
});

test("a malformed id is refused at once, not retried", async () => {
  const c = chain({});
  const real = c.archive.post.bind(c.archive);
  c.archive.post = (async (path: string, body: any) => {
    if (path.endsWith("getTransactionByHash")) throw new Error(`RPC 400 for ${path}: {"code":3, "message":"invalid id format: invalid hash"}`);
    return real(path, body);
  }) as Archive["post"];
  const u = log(c);
  u.report({ wallet: A, txIds: [hash(14)] });
  assert.equal(await u.verifyPending(), 1);
  assert.deepEqual(u.stats({}, T0 + MIN).verification.rejected, { "bad-id": 1 });
});

test("one source cannot fill the queue, and its place is freed as its ids are settled", async () => {
  const u = log(chain({}));
  const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => hash(from + i));
  let queued = 0;
  for (let i = 0; i < 12; i++) queued += u.report({ wallet: A, txIds: ids(100 + i * 10, 10) }, "1.2.3.4")!;
  assert.equal(queued, MAX_PENDING_PER_SOURCE, "one address gets 100 places");
  assert.equal(u.report({ wallet: B, txIds: [hash(900)] }, "5.6.7.8"), 1, "another address is not affected");
  assert.equal(u.report({ wallet: A, txIds: [hash(901)] }, "1.2.3.4"), 0);
});

test("a reported trade is not counted twice, and the log survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const file = join(dir, "usage.json");
  try {
    const t = tx(11);
    const c = chain({ txs: [t], events: { [t.hash]: [withHash(qx(t.tickNumber, T0, "CFB", 10, 3), t.hash)] } });
    const u = log(c, { file });
    u.report({ wallet: A, txIds: [t.hash] });
    await u.verifyPending();
    assert.equal(u.report({ wallet: A, txIds: [t.hash] }), 0);
    u.flush();
    assert.ok(JSON.parse(readFileSync(file, "utf8")).trades[t.hash]);
    const again = log(chain({}), { file });
    assert.equal(again.stats({}, T0 + MIN).totals.trades, 1);
    assert.equal(again.report({ wallet: A, txIds: [t.hash] }), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("which procedures count as a trade", () => {
  assert.deepEqual(classifyCall("QX", 6), { kind: "trade", side: "buy" });
  assert.deepEqual(classifyCall("QX", 5), { kind: "trade", side: "sell" });
  assert.equal(classifyCall("QX", 7), null, "cancelling an order");
  assert.equal(classifyCall("QX", 9), null, "moving share management");
  assert.deepEqual(classifyCall("QSwap", 7), { kind: "trade", side: "buy" });
  assert.deepEqual(classifyCall("QSwap", 8), { kind: "trade", side: "sell" });
  assert.deepEqual(classifyCall("QSwap", 4), { kind: "liquidity" });
  assert.equal(classifyCall("QSwap", 11), null);
});

/* ---------- payments to QMax ---------- */

function payInputBytes(seller: string, resource: Buffer, nonce = 1n) {
  const b = Buffer.alloc(72);
  Buffer.from(identityToBytes(seller)).copy(b, 0);
  resource.copy(b, 32);
  b.writeBigUInt64LE(nonce, 64);
  return b.toString("base64");
}
const payInput = (seller: string, resource: string, nonce = 1n) => payInputBytes(seller, Buffer.from(resource, "latin1"), nonce);
/** The resource id the Discord bot puts in a subscription payment: "QMAXSUB", a version byte, the Discord user id at byte 16. */
function subResource(discordId: string) {
  const r = Buffer.alloc(32);
  r.write("QMAXSUB", 0, "latin1");
  r[9] = 1;
  r.writeBigUInt64LE(BigInt(discordId), 16);
  return r;
}
const pay = (n: number, resource: string, o: Partial<Tx> = {}): Tx => tx(n, { destination: QPAYHUB_IDENTITY, inputType: 1, amount: "1000", inputData: payInput(PAYWALL.recipient, resource), ...o });
const forward = (h: string, amount: number) => withHash({ logType: 0, tickNumber: 1, timestamp: "1", logId: "1", epoch: 1, quTransfer: { source: QPAYHUB_IDENTITY, destination: PAYWALL.recipient, amount: String(amount) } }, h);
const refund = (h: string, to: string, amount: number) => withHash({ logType: 0, tickNumber: 1, timestamp: "1", logId: "2", epoch: 1, quTransfer: { source: QPAYHUB_IDENTITY, destination: to, amount: String(amount) } }, h);

test("a QPayhub payment is told apart by what it was for", () => {
  assert.equal(decodePayment(payInput(PAYWALL.recipient, "QMAXPASS"), PAYWALL.recipient)?.kind, "pass");
  assert.equal(decodePayment(payInput(PAYWALL.recipient, "QMAXSUB"), PAYWALL.recipient)?.kind, "subscription");
  assert.equal(decodePayment(payInput(PAYWALL.recipient, "QMAXAPI"), PAYWALL.recipient)?.kind, "api-topup");
  assert.equal(decodePayment(payInput(PAYWALL.recipient, "something else"), PAYWALL.recipient)?.kind, "other", "anything else sent to QMax's address");
  assert.deepEqual(decodePayment(payInputBytes(PAYWALL.recipient, Buffer.from(resourceTag(SESSION_RESOURCE_ID))), PAYWALL.recipient), { kind: "session" }, "an x402 session is recognised by its resource tag");
  assert.deepEqual(decodePayment(payInputBytes(PAYWALL.recipient, subResource("1234567890123456789")), PAYWALL.recipient), { kind: "subscription", discordId: "1234567890123456789" }, "the Discord user is read from the receipt");
  assert.equal(decodePayment(payInput(A, "QMAXPASS"), PAYWALL.recipient), null, "to someone else");
  assert.equal(decodePayment("AAAA", PAYWALL.recipient), null, "too short");
  assert.equal(decodePayment(undefined, PAYWALL.recipient), null);
});

test("payments QPayhub forwarded to QMax count; a refused one does not; the scan resumes where it stopped", async () => {
  const pass = pay(20, "QMAXPASS", { source: A });
  const sub = pay(21, "QMAXSUB", { source: B, amount: "100000" });
  const refused = pay(22, "QMAXPASS", { source: B });
  const elsewhere = pay(23, "QMAXPASS", { inputData: payInput(A, "QMAXPASS") });
  const c = chain({
    lastTick: 5000,
    payhub: [pass, sub, refused, elsewhere],
    events: { [pass.hash]: [refund(pass.hash, "X", 0), forward(pass.hash, 992)], [sub.hash]: [forward(sub.hash, 99_250)], [refused.hash]: [refund(refused.hash, B, 1000)] },
  });
  const u = log(c);
  const added = await u.scanPayments();
  assert.deepEqual(added.map((p) => [p.kind, p.payer === A ? "A" : "B", p.amountQu, p.forwardedQu]).sort(), [["pass", "A", 1000, 992], ["subscription", "B", 100000, 99250]].sort());
  const s = u.stats({}, T0 + MIN);
  assert.equal(s.payments.pass.allTime.count, 1);
  assert.equal(s.payments.pass.allTime.quReceived, 992);
  assert.equal(s.payments.subscription.allTime.wallets, 1);
  assert.equal(s.payments.refused, 1, "the refused payment is counted apart");
  assert.equal(s.payments.scannedToTick, 5000);

  // Next scan: only newer ticks are asked for, and nothing is added twice.
  c.state.lastTick = 5100;
  c.state.calls.length = 0;
  assert.deepEqual(await u.scanPayments(), []);
  const asked = c.state.calls.find((x) => x.path.endsWith("getTransactionsForIdentity"))!.body.ranges.tickNumber;
  assert.deepEqual(asked, { gte: "5001", lte: "5100" });
  assert.equal(u.stats({}, T0 + MIN).payments.pass.allTime.count, 1);
});

test("a span too wide for the archive's result cap is split, and every payment is read once", async () => {
  const payments = [pay(30, "QMAXPASS", { tickNumber: 100 }), pay(31, "QMAXPASS", { tickNumber: 2600 }), pay(32, "QMAXPASS", { tickNumber: 4900 })];
  const events = Object.fromEntries(payments.map((p) => [p.hash, [forward(p.hash, 990)]]));
  const c = chain({ lastTick: 5000, payhub: payments, events, capSpan: 1000 });
  const u = log(c);
  assert.equal((await u.scanPayments()).length, 3);
});

test("a scan that fails in the middle is read again from the same place", async () => {
  const p = pay(40, "QMAXPASS");
  const c = chain({ lastTick: 5000, payhub: [p], events: { [p.hash]: [forward(p.hash, 990)] } });
  const real = c.archive.post.bind(c.archive);
  let fail = true;
  c.archive.post = (async (path: string, body: unknown) => {
    if (fail && path.endsWith("getEventLogs")) throw new Error("archive hiccup");
    return real(path, body);
  }) as Archive["post"];
  const u = log(c);
  await assert.rejects(u.scanPayments(), /hiccup/);
  assert.equal(u.stats({}, T0).payments.scannedToTick, 0, "the cursor did not move");
  fail = false;
  assert.equal((await u.scanPayments()).length, 1);
});

test("a subscription keeps the Discord user it was paid for, so a wallet is tied to a Discord account", async () => {
  const sub = pay(41, "", { source: A, inputData: payInputBytes(PAYWALL.recipient, subResource("987654321")) });
  const c = chain({ lastTick: 5000, payhub: [sub], events: { [sub.hash]: [forward(sub.hash, 990)] } });
  const u = log(c);
  const [rec] = await u.scanPayments();
  assert.deepEqual([rec.kind, rec.discordId, rec.payer], ["subscription", "987654321", A]);
});

test("a wallet's own payments are read on demand, so a new member is recognised before the next scan", async () => {
  const mine = pay(42, "", { source: A, inputData: payInputBytes(PAYWALL.recipient, subResource("55")) });
  const c = chain({ lastTick: 5000, events: { [mine.hash]: [forward(mine.hash, 990)] } });
  const real = c.archive.post.bind(c.archive);
  const asked: any[] = [];
  c.archive.post = (async (path: string, body: any) => {
    if (path.endsWith("getTransactionsForIdentity") && body.identity === A) {
      asked.push(body);
      return { hits: { total: 1 }, transactions: [mine] };
    }
    return real(path, body);
  }) as Archive["post"];
  const u = log(c);
  assert.deepEqual(await u.refreshWallet(A), await u.refreshWallet(A), "the second call is the cached one");
  assert.equal(asked.length, 1, "asked the archive once, then used the cache");
  assert.deepEqual(asked[0].filters, { source: A, destination: QPAYHUB_IDENTITY, inputType: "1" });
  assert.equal(u.paymentsOf(A)[0].discordId, "55");
  assert.deepEqual(await u.refreshWallet("short"), [], "not a wallet");
  // The scan later meets the same payment: it is not added twice.
  c.state.payhub = [mine];
  assert.deepEqual(await u.scanPayments(), []);
  assert.equal(u.allPayments().length, 1);
});

test("a refused payment seen by a wallet lookup is not counted again by the scan", async () => {
  const refusedTx = pay(43, "", { source: A, inputData: payInputBytes(PAYWALL.recipient, subResource("56")) });
  const c = chain({ lastTick: 5000, payhub: [refusedTx], events: { [refusedTx.hash]: [refund(refusedTx.hash, A, 1000)] } });
  const real = c.archive.post.bind(c.archive);
  c.archive.post = (async (path: string, body: any) => (path.endsWith("getTransactionsForIdentity") && body.identity === A ? { hits: { total: 1 }, transactions: [refusedTx] } : real(path, body))) as Archive["post"];
  const u = log(c);
  await u.refreshWallet(A);
  await u.scanPayments();
  assert.equal(u.stats({}, T0).payments.refused, 1);
});

test("a log saved by the first version reads its payments again, to learn the Discord ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const file = join(dir, "usage.json");
  try {
    const sub = pay(44, "", { source: A, inputData: payInputBytes(PAYWALL.recipient, subResource("77")) });
    writeFileSync(file, JSON.stringify({ v: 1, since: T0, trades: {}, pending: [], rejectedIds: [], rejected: {}, payments: { [sub.hash]: { tx: sub.hash, payer: A, kind: "subscription", amountQu: 1000, forwardedQu: 990, tick: 1, t: 1 } }, paymentTick: 4000, refusedPayments: 0 }));
    const c = chain({ lastTick: 5000, payhub: [sub], events: { [sub.hash]: [forward(sub.hash, 990)] } });
    const u = log(c, { file });
    assert.equal(u.allPayments().length, 0, "the old records are dropped");
    await u.scanPayments();
    assert.equal(u.allPayments()[0].discordId, "77");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- the numbers ---------- */

test("stats group by day, ref and wallet, and tell new wallets from returning ones", async () => {
  const DAY = 86_400_000;
  const mk = (n: number, wallet: string, t: number, ref?: string, price = 100) => {
    const x = tx(n, { source: wallet, timestamp: String(t) });
    return { x, e: [withHash(qx(x.tickNumber, t, "CFB", price, 10), x.hash)], ref };
  };
  const rows = [mk(50, A, T0), mk(51, A, T0 + DAY, "partner"), mk(52, B, T0 + DAY, "partner", 200), mk(53, B, T0 + 2 * DAY)];
  const c = chain({ txs: rows.map((r) => r.x), events: Object.fromEntries(rows.map((r) => [r.x.hash, r.e])) });
  let now = T0;
  const u = log(c, { now: () => now });
  for (const r of rows) {
    now = Number(r.x.timestamp) + MIN;
    u.report({ wallet: r.x.source, txIds: [r.x.hash], ...(r.ref ? { ref: r.ref } : {}) });
    await u.verifyPending();
  }
  const s = u.stats({ days: 30 }, T0 + 3 * DAY);
  assert.equal(s.totals.trades, 4);
  assert.equal(s.totals.wallets, 2);
  assert.equal(s.totals.newWallets, 2);
  assert.deepEqual(s.byDay.map((d) => [d.trades, d.wallets, d.newWallets]), [[1, 1, 1], [2, 2, 1], [1, 1, 0]]);
  assert.deepEqual(s.byRef.map((r) => [r.ref, r.trades, r.quVolume]), [["partner", 2, 3000], ["direct", 2, 2000]]);
  assert.equal(s.topWallets[0].wallet, B, "ranked by QU volume");
  const narrow = u.stats({ days: 1 }, T0 + 3 * DAY);
  assert.equal(narrow.totals.trades, 1);
  assert.equal(narrow.totals.newWallets, 0, "wallet B first traded before this window");
  const w = u.walletStats(B);
  assert.equal(w.totals.trades, 2);
  assert.equal(w.firstSeen, new Date(T0 + DAY).toISOString());
  assert.equal(u.walletStats("Z".repeat(60)).trades.length, 0);
});

/* ---------- over HTTP ---------- */

const KEY = "k".repeat(24);
const t1 = tx(60);
const web = chain({ txs: [t1], events: { [t1.hash]: [withHash(qx(t1.tickNumber, T0, "CFB", 5, 5), t1.hash)] } });
const usage = log(web);
const data: MarketData = { assets: () => [], venues: async () => null };
const server = createApi({ data, usage, apiKey: KEY, freeAccess: true });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const post = (body: unknown) => fetch(base + "/v1/trade-report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("anyone can report a trade, malformed reports are refused, and nothing counts before it is verified", async () => {
  const bad = await post({ wallet: "x", txIds: [] });
  assert.equal(bad.status, 400);
  const ok = await post({ wallet: A, txIds: [t1.hash] });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { ok: true, queued: 1 });
  assert.equal(usage.stats({}, T0 + MIN).totals.trades, 0);
  await usage.verifyPending();
  assert.equal(usage.stats({}, T0 + MIN).totals.trades, 1);
});

test("the stats are only for QMax's own key", async () => {
  assert.equal((await fetch(base + "/v1/stats")).status, 401);
  assert.equal((await fetch(base + "/v1/stats", { headers: { "x-api-key": "j".repeat(24) } })).status, 401, "a wrong key of the same length");
  assert.equal((await fetch(base + "/v1/stats", { headers: { "x-api-key": "k" } })).status, 401, "a prefix of the key");
  const r = await fetch(base + "/v1/stats?days=7", { headers: { "x-api-key": KEY } });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { window: { days: number }; totals: { trades: number }; note: string };
  assert.equal(j.window.days, 7);
  assert.equal(j.totals.trades, 1);
  assert.match(j.note, /not that it went through QMax/);
  assert.equal((await fetch(base + "/v1/stats?days=0", { headers: { "x-api-key": KEY } })).status, 400);
  assert.equal((await fetch(base + "/v1/stats?wallet=nope", { headers: { "x-api-key": KEY } })).status, 400);
  const one = await fetch(base + `/v1/stats?wallet=${A}`, { headers: { "x-api-key": KEY } });
  assert.equal(((await one.json()) as { trades: unknown[] }).trades.length, 1);
});

test("without an API key set, nobody can read the stats", async () => {
  const s = createApi({ data, usage });
  await new Promise<void>((r) => s.listen(0, () => r()));
  try {
    const b = `http://localhost:${(s.address() as AddressInfo).port}`;
    assert.equal((await fetch(b + "/v1/stats", { headers: { "x-api-key": "" } })).status, 401);
    assert.equal((await fetch(b + "/v1/stats")).status, 401);
  } finally {
    s.close();
  }
});

/* ---------- adversarial review ---------- */

test("payments count as read up to the time of the archive's last tick, not the moment the scan ran: a lagging archive cannot make a month look complete", async () => {
  const HOUR = 3_600_000;
  const c = chain({ lastTick: 5000 });
  // The archive is three hours behind real time; its newest ticks are empty ones (it answers `tickData: null` for those).
  c.state.tickTime = (tick) => (tick > 4990 ? null : T0 - 3 * HOUR + tick);
  const u = log(c, { now: () => T0 });
  await u.scanPayments();
  assert.equal(u.scanState().at, T0 - 3 * HOUR + 4990, "the time of the newest tick that has data, found by walking back over the empty ones");
  assert.equal(u.scanState().tick, 5000);

  const caughtUp = log(chain({ lastTick: 5000 }), { now: () => T0 });
  await caughtUp.scanPayments();
  assert.equal(caughtUp.scanState().at, T0, "an archive that is up to date is read as of now");

  const blind = chain({ lastTick: 5000 });
  blind.state.tickTime = () => null;
  const v = log(blind, { now: () => T0 });
  await v.scanPayments();
  assert.equal(v.scanState().at, 0, "no time for any tick: nothing is claimed complete");
  assert.equal(v.scanState().tick, 5000, "but the payments themselves were read");
});

test("a refused payment met by a wallet lookup and the scan at the same moment is counted once", async () => {
  const refusedTx = pay(45, "", { source: A, inputData: payInputBytes(PAYWALL.recipient, subResource("57")) });
  const c = chain({ lastTick: 5000, payhub: [refusedTx], events: { [refusedTx.hash]: [refund(refusedTx.hash, A, 1000)] } });
  const real = c.archive.post.bind(c.archive);
  // Both readers are inside the payment's event lookup at once: neither has recorded it when the other starts.
  let waiting: (() => void)[] = [];
  c.archive.post = (async (path: string, body: any) => {
    if (path.endsWith("getTransactionsForIdentity") && body.identity === A) return { hits: { total: 1 }, transactions: [refusedTx] };
    if (path.endsWith("getEventLogs")) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) (waiting.forEach((r) => r()), (waiting = []));
        else setTimeout(() => (waiting.forEach((r) => r()), (waiting = [])), 50);
      });
    }
    return real(path, body);
  }) as Archive["post"];
  const u = log(c);
  await Promise.all([u.refreshWallet(A), u.scanPayments()]);
  assert.equal(u.stats({}, T0).payments.refused, 1);
  const data = JSON.parse(JSON.stringify((u as any).data));
  assert.equal(data.refusedIds.filter((h: string) => h === refusedTx.hash).length, 1);
});

test("a wallet the archive calls invalid is not asked about again for a minute, but a failing archive is retried", async () => {
  const c = chain({ lastTick: 5000 });
  const real = c.archive.post.bind(c.archive);
  let asked = 0;
  let mode: "invalid" | "down" = "invalid";
  c.archive.post = (async (path: string, body: any) => {
    if (path.endsWith("getTransactionsForIdentity") && body.identity === A) {
      asked++;
      throw new Error(mode === "invalid" ? 'RPC 400 for /query/v1/getTransactionsForIdentity: {"code":3,"message":"invalid id format"}' : "Qubic RPC unavailable: RPC 503");
    }
    return real(path, body);
  }) as Archive["post"];
  const u = log(c);
  await assert.rejects(u.refreshWallet(A), /RPC 400/);
  assert.deepEqual(await u.refreshWallet(A), [], "answered from what is known, with no second archive call");
  assert.equal(asked, 1, "a flood of made-up identities cannot make the server hammer the archive with the same one");
  mode = "down";
  const b = "B".repeat(59) + "Z";
  c.archive.post = (async (path: string, body: any) => {
    if (path.endsWith("getTransactionsForIdentity") && body.identity === b) {
      asked++;
      throw new Error("Qubic RPC unavailable: RPC 503");
    }
    return real(path, body);
  }) as Archive["post"];
  await assert.rejects(u.refreshWallet(b), /unavailable/);
  await assert.rejects(u.refreshWallet(b), /unavailable/);
  assert.equal(asked, 3, "an outage is not remembered: the next look tries again");
});

test("only what QPayhub really sent to QMax's address counts, whatever the payment says it was for", async () => {
  const toOther = pay(60, "QMAXSUB", { source: A, amount: "100000" }); // names QMax as the seller, but the events show the money going elsewhere
  const less = pay(61, "QMAXSUB", { source: B, amount: "100000" }); // QPayhub sent QMax less than the usual cut would leave
  const negative = pay(62, "QMAXSUB", { source: A, amount: "100000" });
  const ownerPays = pay(63, "QMAXSUB", { source: PAYWALL.recipient, amount: "100000" });
  const split = pay(64, "QMAXSUB", { source: B, amount: "100000" }); // QPayhub paid QMax in two transfers (an affiliate cut would be a third, to someone else)
  const c = chain({
    lastTick: 5000,
    payhub: [toOther, less, negative, ownerPays, split],
    events: {
      [toOther.hash]: [refund(toOther.hash, "X".repeat(59) + "Y", 99_250)],
      [less.hash]: [forward(less.hash, 500)],
      [negative.hash]: [forward(negative.hash, -5)],
      [ownerPays.hash]: [forward(ownerPays.hash, 99_250)],
      [split.hash]: [forward(split.hash, 90_000), forward(split.hash, 9_000), refund(split.hash, "Z".repeat(59) + "Y", 250)],
    },
  });
  const u = log(c);
  const added = await u.scanPayments();
  const by = (h: string) => added.find((p) => p.tx === h);
  assert.equal(by(toOther.hash), undefined, "a payment QPayhub did not forward to QMax is not income, however it is labelled");
  assert.equal(by(negative.hash), undefined, "nor is a negative transfer");
  assert.equal(by(less.hash)?.forwardedQu, 500, "what was really forwarded is what counts, not what the price would suggest");
  assert.equal(by(less.hash)?.amountQu, 100_000);
  assert.equal(by(split.hash)?.forwardedQu, 99_000, "QPayhub's transfers to QMax in one payment add up; the transfer to someone else does not");
  assert.equal(u.stats({}, T0).payments.refused, 2);
  assert.equal(by(ownerPays.hash)?.payer, PAYWALL.recipient, "QMax paying itself is recorded as a payment; the profit share leaves its own address out");
});

/* ---------- adversarial review, second pass: reading payments ---------- */

const countCalls = (c: ReturnType<typeof chain>, suffix: string) => c.state.calls.filter((x) => x.path.endsWith(suffix)).length;

test("payments are read only up to the tick the archive's transaction index has reached, not just its event index", async () => {
  // The live archive reports two counters that differ by a few ticks either way. Reading transactions up to the event counter, when it is the
  // one that is ahead, moves the cursor past ticks whose payments have not been indexed yet, and they would never be read.
  const late = pay(70, "QMAXPASS", { tickNumber: 5002 });
  const c = chain({ lastTick: 5004, payhub: [late], events: { [late.hash]: [forward(late.hash, 990)] } });
  c.state.txTick = 5000;
  const u = log(c);
  await u.scanPayments();
  assert.equal(u.scanState().tick, 5000, "the cursor stops where both indexes are complete");
  c.state.txTick = 5010;
  c.state.lastTick = 5010;
  assert.deepEqual((await u.scanPayments()).map((p) => p.tx), [late.hash], "so a payment the transaction index showed late is still read");

  // A wallet's own lookup is bounded the same way.
  const w = pay(71, "QMAXPASS", { tickNumber: 5002, source: A });
  const c2 = chain({ lastTick: 5004, payhub: [w], events: { [w.hash]: [forward(w.hash, 990)] } });
  c2.state.txTick = 5000;
  let asked: any;
  const real = c2.archive.post.bind(c2.archive);
  c2.archive.post = (async (path: string, body: any) => (path.endsWith("getTransactionsForIdentity") && body.identity === A ? ((asked = body), { hits: { total: 0 }, transactions: [] }) : real(path, body))) as Archive["post"];
  await log(c2).refreshWallet(A);
  assert.equal(asked.ranges.tickNumber.lte, "5000");
});

test("an amount that is not a whole number of QU never becomes income, and cannot poison the books", async () => {
  const weird = (n: number, amount: string) => ({ tx: pay(n, "QMAXSUB", { source: A, amount: "100000" }), ev: (h: string) => withHash({ logType: 0, tickNumber: 1, timestamp: "1", logId: "1", epoch: 1, quTransfer: { source: QPAYHUB_IDENTITY, destination: PAYWALL.recipient, amount } }, h) });
  const rows = [weird(72, "NaN"), weird(73, "1e999"), weird(74, "12.5"), weird(75, "-7"), weird(76, "abc")];
  const good = pay(77, "QMAXSUB", { source: B, amount: "100000" });
  const c = chain({ lastTick: 5000, payhub: [...rows.map((r) => r.tx), good], events: { ...Object.fromEntries(rows.map((r) => [r.tx.hash, [r.ev(r.tx.hash)]])), [good.hash]: [forward(good.hash, 99_250)] } });
  const u = log(c);
  const added = await u.scanPayments();
  assert.deepEqual(added.map((p) => p.tx), [good.hash], "a transfer amount that is NaN, infinite, fractional or negative is not money QPayhub sent");
  for (const p of u.allPayments()) assert.ok(Number.isSafeInteger(p.forwardedQu) && p.forwardedQu > 0 && Number.isSafeInteger(p.amountQu));
  const bad = pay(78, "QMAXSUB", { source: A, amount: "not a number" });
  const c2 = chain({ lastTick: 5000, payhub: [bad], events: { [bad.hash]: [forward(bad.hash, 500)] } });
  assert.deepEqual(await log(c2).scanPayments(), [], "nor is a payment whose own amount cannot be read");
});

test("a payment whose events the archive does not have yet is read again later, not written off as refused", async () => {
  const p = pay(79, "QMAXSUB", { source: A, amount: "100000" });
  const c = chain({ lastTick: 5000, payhub: [p], events: {} }); // the money moved (moneyFlew), but the events are not indexed yet
  const u = log(c);
  await assert.rejects(u.scanPayments(), /are not indexed yet/);
  assert.equal(u.scanState().tick, 0, "the cursor did not move");
  assert.equal(u.stats({}, T0).payments.refused, 0, "and it was not counted as refused");
  c.state.events[p.hash] = [forward(p.hash, 99_250)];
  assert.deepEqual((await u.scanPayments()).map((x) => x.forwardedQu), [99_250], "when the events appear, the payment counts");
  // The same through a wallet lookup.
  const q = pay(80, "QMAXSUB", { source: A, amount: "100000" });
  const c2 = chain({ lastTick: 5000, events: {} });
  const real = c2.archive.post.bind(c2.archive);
  c2.archive.post = (async (path: string, body: any) => (path.endsWith("getTransactionsForIdentity") && body.identity === A ? { hits: { total: 1 }, transactions: [q] } : real(path, body))) as Archive["post"];
  const v = log(c2);
  await assert.rejects(v.refreshWallet(A), /are not indexed yet/);
  c2.state.events[q.hash] = [forward(q.hash, 99_250)];
  assert.equal((await v.refreshWallet(A)).length, 1, "and the failed look is not remembered for the minute");
});

test("a payment that never moved money or is below QPayhub's minimum is refused without asking for its events", async () => {
  const unfunded = pay(81, "QMAXSUB", { source: A, amount: "100000", moneyFlew: false }); // included in a tick, but the payer could not cover it
  const dust = pay(82, "QMAXSUB", { source: B, amount: "99" }); // under QPayhub's minimum: refunded by the contract
  const zero = pay(83, "QMAXSUB", { source: B, amount: "0" });
  const c = chain({ lastTick: 5000, payhub: [unfunded, dust, zero], events: {} });
  const u = log(c);
  assert.deepEqual(await u.scanPayments(), []);
  assert.equal(countCalls(c, "getEventLogs"), 0, "no lookup for what cannot have been forwarded: free, repeatable spam must not cost the server archive calls");
  assert.equal(u.stats({}, T0).payments.refused, 3);
  assert.equal(u.scanState().tick, 5000);
});

test("a wallet's own lookup does a bounded number of event lookups, however many payments to QMax it has made", async () => {
  // Refused payments cost their sender nothing (QPayhub returns the money), so one wallet can make thousands.
  const spam = Array.from({ length: 120 }, (_, i) => pay(200 + i, "QMAXSUB", { source: A, amount: "5000" }));
  const events = Object.fromEntries(spam.map((p) => [p.hash, [refund(p.hash, A, 5000)]]));
  const c = chain({ lastTick: 5000, events });
  const real = c.archive.post.bind(c.archive);
  c.archive.post = (async (path: string, body: any) => (path.endsWith("getTransactionsForIdentity") && body.identity === A ? { hits: { total: spam.length }, transactions: spam.slice(body.pagination.offset, body.pagination.offset + body.pagination.size) } : real(path, body))) as Archive["post"];
  let now = T0 + MIN;
  const u = log(c, { now: () => now });
  await u.refreshWallet(A);
  assert.ok(countCalls(c, "getEventLogs") <= 40, `one look must not make ${countCalls(c, "getEventLogs")} archive calls`);
  for (let i = 0; i < 4; i++) {
    now += 2 * MIN;
    await u.refreshWallet(A);
  }
  assert.equal(countCalls(c, "getEventLogs"), 120, "it works through them over a few looks");
  now += 2 * MIN;
  await u.refreshWallet(A);
  assert.equal(countCalls(c, "getEventLogs"), 120, "and once they are known they cost nothing");
});

test("refused payments are remembered well past two thousand, so a flood of them is not looked up again at every wallet lookup", async () => {
  const spam = Array.from({ length: 2300 }, (_, i) => pay(500 + i, "QMAXSUB", { source: A, amount: "5000" }));
  const events = Object.fromEntries(spam.map((p) => [p.hash, [refund(p.hash, A, 5000)]]));
  const c = chain({ lastTick: 5000, payhub: spam, events });
  const u = log(c);
  await u.scanPayments();
  assert.equal(u.stats({}, T0).payments.refused, 2300);
  const before = countCalls(c, "getEventLogs");
  const real = c.archive.post.bind(c.archive);
  c.archive.post = (async (path: string, body: any) => (path.endsWith("getTransactionsForIdentity") && body.identity === A ? { hits: { total: spam.length }, transactions: spam.slice(body.pagination.offset, body.pagination.offset + body.pagination.size) } : real(path, body))) as Archive["post"];
  await u.refreshWallet(A);
  assert.equal(countCalls(c, "getEventLogs"), before, "every one of them is already known");
  assert.equal(u.stats({}, T0).payments.refused, 2300, "and none is counted twice");
});

test("the usage file is written for its owner only, even over an older, looser one or a leftover from a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const file = join(dir, "usage.json");
  try {
    writeFileSync(file, JSON.stringify({ v: 2, since: T0 }), { mode: 0o644 });
    writeFileSync(file + ".tmp", "half a file", { mode: 0o644 }); // left by a crash between the write and the rename
    const u = log(chain({}), { file });
    u.flush();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each answer says which tick it is valid for, and a payment is read only up to the lowest of those", async () => {
  // The archive may be served by replicas at different ticks (it answered "requested tick N is greater than last processed tick N-1" within the same
  // second as it reported N). An answer that is only valid up to tick V cannot be taken to be complete beyond it.
  const late = pay(90, "QMAXPASS", { tickNumber: 5008 });
  const c = chain({ lastTick: 5010, payhub: [late], events: { [late.hash]: [forward(late.hash, 990)] } });
  c.state.validForTxs = 5003; // the replica that answered the transaction list has only got to 5003
  const u = log(c);
  assert.deepEqual(await u.scanPayments(), []);
  assert.equal(u.scanState().tick, 5003, "the cursor stops at what the answer was valid for, not at the tick that was asked for");
  c.state.validForTxs = 5010;
  assert.deepEqual((await u.scanPayments()).map((p) => p.tx), [late.hash], "so the payment that was beyond it is read on the next scan");
});

test("a payment's events are believed only if the answer was valid up to the payment's own tick", async () => {
  const p = pay(91, "QMAXSUB", { source: A, amount: "100000", tickNumber: 1500 });
  // The replica that answered has events only up to tick 1499, so it shows the money going in but not yet QPayhub's forward.
  const c = chain({ lastTick: 5000, payhub: [p], events: { [p.hash]: [withHash({ logType: 0, tickNumber: 1500, timestamp: "1", logId: "1", epoch: 1, quTransfer: { source: A, destination: QPAYHUB_IDENTITY, amount: "100000" } }, p.hash)] } });
  c.state.validForEvents = 1499;
  const u = log(c);
  await assert.rejects(u.scanPayments(), /are not indexed yet/);
  assert.equal(u.stats({}, T0).payments.refused, 0, "not written off as refused for good");
  c.state.validForEvents = 5000;
  c.state.events[p.hash].push(forward(p.hash, 99_250));
  assert.deepEqual((await u.scanPayments()).map((x) => x.forwardedQu), [99_250]);
});

test("a corrupted or odd usage file starts a log that claims nothing is complete, so no month can be paid on a guess", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const file = join(dir, "usage.json");
  try {
    for (const content of ['{"v":2,"since":1,"payments":{"x":', "", "null", "[]", '"text"', '{"v":3}']) {
      writeFileSync(file, content);
      const u = log(chain({}), { file });
      assert.deepEqual([u.scanState().tick, u.scanState().at, u.allPayments().length], [0, 0, 0], `for ${JSON.stringify(content)}`);
    }
    // A saved log that lacks fields (older or damaged) is completed with defaults rather than breaking later.
    writeFileSync(file, JSON.stringify({ v: 2, since: T0, paymentTick: 4000 }));
    const odd = log(chain({}), { file });
    assert.deepEqual([odd.allPayments().length, odd.stats({}, T0 + MIN).payments.refused], [0, 0]);
    odd.flush();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a list of payments longer than one page is read in full, so a payment on the last page is not missed", async () => {
  const filler = Array.from({ length: 2300 }, (_, i) => pay(1000 + i, "QMAXPASS", { inputData: payInput(A, "QMAXPASS"), tickNumber: 100 + (i % 4000) })); // other sellers' payments
  const mine = [pay(3500, "QMAXSUB", { source: A, amount: "100000", tickNumber: 4990 }), pay(3501, "QMAXSUB", { source: B, amount: "100000", tickNumber: 4991 })];
  const c = chain({ lastTick: 5000, payhub: [...filler, ...mine], events: Object.fromEntries(mine.map((p) => [p.hash, [forward(p.hash, 99_250)]])) });
  const u = log(c);
  assert.deepEqual((await u.scanPayments()).map((p) => p.tx).sort(), mine.map((p) => p.hash).sort());
  assert.ok(countCalls(c, "getTransactionsForIdentity") >= 3, "three pages were asked for");
});
