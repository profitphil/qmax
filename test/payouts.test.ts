import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityToBytes } from "../src/identity.ts";
import { MAX_RECIPIENTS, NOT_FOUND_AFTER_MS, PLAN_EXPIRES_MS, PayoutLog, REPEAT_WINDOW_MS, overEntitlement, readJournalFile, recentlyPaid, takeLock, writeJournalFile, QUTIL_ID, QUTIL_INDEX, SEND_TO_MANY_PROC, batchStep, buildBatches, checkBatchView, checkPlan, sendToManyPayload, verifyBatch } from "../src/payouts.ts";
import type { BatchView } from "../src/payouts.ts";
import type { Batch } from "../src/payouts.ts";
import type { Balance } from "../src/profitshare.ts";
import type { Archive } from "../src/usage.ts";
import { QPAYHUB_IDENTITY } from "../src/x402.ts";

const OWNER = "O".repeat(59) + "Q";
// Never 'A' first: sixty-odd 'A's are the all-zero public key, which QUtil skips (keeping the money), and the payload builder refuses.
const wallet = (i: number) => String.fromCharCode(66 + (i % 25)).repeat(58) + String.fromCharCode(65 + Math.floor(i / 25) % 26) + "Z";
const FEE = 10;
const T0 = 1_791_000_000_000;
const txid = (c: string) => c.repeat(60);

const bal = (w: string, owedQu: number): Balance => ({ wallet: w, discordIds: [], earnedQu: owedQu, paidQu: 0, owedQu, overpaidQu: 0, periods: [] });
const opts = { feeQu: FEE, minPayoutQu: 1000, throughPeriod: "2026-10" };

/* ---------- the transaction ---------- */

test("the payload is QUtil's SendToManyV1 input: 25 ids, then 25 amounts, unused slots zero", () => {
  const lines = [{ wallet: wallet(1), amountQu: 5000 }, { wallet: wallet(2), amountQu: 123_456_789_012 }];
  const p = sendToManyPayload(lines);
  assert.equal(p.length, 1000);
  assert.deepEqual([...p.subarray(0, 32)], [...identityToBytes(wallet(1))]);
  assert.deepEqual([...p.subarray(32, 64)], [...identityToBytes(wallet(2))]);
  assert.ok(p.subarray(64, 800).every((b) => b === 0), "unused destination slots are zero");
  const v = new DataView(p.buffer);
  assert.equal(v.getBigInt64(800, true), 5000n);
  assert.equal(v.getBigInt64(808, true), 123_456_789_012n);
  assert.ok(p.subarray(816).every((b) => b === 0), "unused amount slots are zero");
});

test("a payload the contract would refuse, or that could misdirect money, is never built", () => {
  const ok = { wallet: wallet(1), amountQu: 1000 };
  assert.throws(() => sendToManyPayload([]), /1 to 25/);
  assert.throws(() => sendToManyPayload(Array.from({ length: 26 }, (_, i) => ({ wallet: wallet(i), amountQu: 1000 }))), /1 to 25/);
  assert.throws(() => sendToManyPayload([ok, ok]), /twice/);
  assert.throws(() => sendToManyPayload([{ wallet: "nope", amountQu: 1000 }]), /not a 60-letter/);
  assert.throws(() => sendToManyPayload([{ wallet: wallet(1), amountQu: 0 }]), /whole number of QU/);
  assert.throws(() => sendToManyPayload([{ wallet: wallet(1), amountQu: -5 }]), /whole number of QU/);
  assert.throws(() => sendToManyPayload([{ wallet: wallet(1), amountQu: 12.5 }]), /whole number of QU/);
  assert.throws(() => sendToManyPayload([{ wallet: wallet(1), amountQu: 1e15 }]), /whole number of QU/, "the contract refuses an amount at its supply limit");
  assert.equal(sendToManyPayload([{ wallet: wallet(1), amountQu: 1e15 - 1 }]).length, 1000);
});

test("what is owed is split into batches of up to 25, biggest first, attaching exactly the amounts plus the fee", () => {
  const lines = Array.from({ length: 60 }, (_, i) => ({ wallet: wallet(i), amountQu: 1000 + i }));
  const batches = buildBatches(lines, FEE, "2026-10", T0);
  assert.deepEqual(batches.map((b) => b.lines.length), [25, 25, 10]);
  assert.equal(batches[0].lines[0].amountQu, 1059, "biggest first");
  for (const b of batches) {
    assert.equal(b.amountQu, b.lines.reduce((s, l) => s + l.amountQu, 0) + FEE, "the contract refunds anything but amounts plus fee");
    assert.equal(b.status, "prepared");
  }
  assert.equal(new Set(batches.map((b) => b.id)).size, 3);
  assert.equal(batches.flatMap((b) => b.lines).length, 60, "everyone is in exactly one batch");
  assert.equal(new Set(batches.flatMap((b) => b.lines.map((l) => l.wallet))).size, 60);
  const later = buildBatches(lines, FEE, "2026-10", T0 + 5000);
  assert.deepEqual(later.map((b) => b.payload), batches.map((b) => b.payload), "the same lines are the same bytes");
  assert.notEqual(later[0].id, batches[0].id, "but planned at another time they are a new payment (the same amounts can be owed again next month)");
  assert.notEqual(buildBatches(lines, FEE + 1, "2026-10", T0)[0].amountQu, batches[0].amountQu, "a different fee attaches a different amount");
});

test("a fee that does not look right stops the payout instead of attaching the wrong amount", () => {
  const lines = [{ wallet: wallet(1), amountQu: 5000 }];
  for (const bad of [-1, NaN, 1.5, 2_000_000, Infinity]) assert.throws(() => buildBatches(lines, bad, "2026-10", T0), /fee/);
  assert.deepEqual(buildBatches([], FEE, "2026-10", T0), []);
});

test("the step to sign is a call to QUtil's procedure 1 with the batch's amount and bytes", () => {
  const [b] = buildBatches([{ wallet: wallet(1), amountQu: 5000 }, { wallet: wallet(2), amountQu: 7000 }], FEE, "2026-10", T0);
  const s = batchStep(b);
  assert.deepEqual([s.kind, s.to, s.inputType, s.amountQu], ["payout", { contractIndex: QUTIL_INDEX }, SEND_TO_MANY_PROC, 12_010]);
  assert.equal(Buffer.from(s.payload).toString("base64"), b.payload);
  assert.match(s.description, /2 subscribers 12,000 QU/);
  assert.equal(QUTIL_INDEX, 4);
  assert.equal(SEND_TO_MANY_PROC, 1);
  assert.equal(MAX_RECIPIENTS, 25);
});

/* ---------- what a signer checks before signing ---------- */

const view = (b: Batch): BatchView => ({ id: b.id, status: b.status, lines: b.lines, feeQu: b.feeQu, amountQu: b.amountQu, tx: { destinationContractIndex: QUTIL_INDEX, inputType: SEND_TO_MANY_PROC, amountQu: b.amountQu, payloadBase64: b.payload } });

test("a signer accepts a batch exactly as built, and refuses one that differs in any way that could misdirect or lose money", () => {
  const [b] = buildBatches([{ wallet: wallet(1), amountQu: 5000 }, { wallet: wallet(2), amountQu: 7000 }], FEE, "2026-10", T0);
  assert.deepEqual(checkBatchView(view(b)), []);
  // The bytes pay someone else.
  const other = Buffer.from(sendToManyPayload([{ wallet: wallet(9), amountQu: 5000 }, { wallet: wallet(2), amountQu: 7000 }])).toString("base64");
  assert.match(checkBatchView({ ...view(b), tx: { ...view(b).tx, payloadBase64: other } })[0], /bytes do not match/);
  // The bytes pay more than the list says.
  const more = Buffer.from(sendToManyPayload([{ wallet: wallet(1), amountQu: 5000_000 }, { wallet: wallet(2), amountQu: 7000 }])).toString("base64");
  assert.match(checkBatchView({ ...view(b), tx: { ...view(b).tx, payloadBase64: more } })[0], /bytes do not match/);
  // The attachment is not amounts plus fee: QUtil would refund it.
  assert.match(checkBatchView({ ...view(b), amountQu: b.amountQu + 1, tx: { ...view(b).tx, amountQu: b.amountQu + 1 } }).join(), /plus the fee/);
  assert.match(checkBatchView({ ...view(b), amountQu: b.amountQu - 1 }).join(), /plus the fee/, "the two stated amounts disagree");
  // It goes somewhere else, or calls something else.
  assert.match(checkBatchView({ ...view(b), tx: { ...view(b).tx, destinationContractIndex: 1 } }).join(), /not a send-to-many/);
  assert.match(checkBatchView({ ...view(b), tx: { ...view(b).tx, inputType: 2 } }).join(), /not a send-to-many/);
  // A silly fee, a duplicate wallet, a bad amount.
  assert.match(checkBatchView({ ...view(b), feeQu: 999_999_999 }).join(), /fee/);
  assert.match(checkBatchView({ ...view(b), lines: [b.lines[0], b.lines[0]] }).join(), /twice/);
  assert.match(checkBatchView({ ...view(b), lines: [{ wallet: wallet(1), amountQu: -5 }] }).join(), /whole number/);
});

/* ---------- a stand-in for the chain ---------- */

interface Tx {
  hash: string;
  source: string;
  destination: string;
  amount: string;
  tickNumber: number;
  timestamp: string;
  inputType: number;
  inputData: string;
  moneyFlew?: boolean;
}

function chain() {
  // `tickTime`: when the archive's newest tick happened (ms). By default it is fully caught up (far ahead of any test clock).
  const st = { lastTick: 5000, txs: new Map<string, Tx>(), events: {} as Record<string, object[]>, calls: [] as string[], tickTime: 9_000_000_000_000_000, /** The tick an events answer says it is valid up to, when it says. */ eventsValid: undefined as number | undefined };
  const archive: Archive = {
    async get<T>(path: string) {
      st.calls.push(path);
      return { logTickNumber: st.lastTick } as T;
    },
    async post<T>(path: string, body: any) {
      st.calls.push(path);
      if (path.endsWith("/getTickData")) return { tickData: { tickNumber: body.tickNumber, timestamp: String(st.tickTime) } } as T;
      if (path.endsWith("/getTransactionByHash")) {
        const t = st.txs.get(body.hash);
        if (!t) throw new Error(`RPC 404 for ${path}: not found`);
        return t as T;
      }
      if (path.endsWith("/getEventLogs")) {
        const list = st.events[body.filters.transactionHash] ?? [];
        return { hits: { total: list.length }, eventLogs: list.slice(body.pagination.offset, body.pagination.offset + body.pagination.size), ...(st.eventsValid !== undefined ? { validForTick: st.eventsValid } : {}) } as T;
      }
      if (path.endsWith("/getTransactionsForIdentity")) {
        assert.equal(body.filters.source, OWNER);
        assert.equal(body.filters.destination, QUTIL_ID);
        const { gte, lte } = body.ranges.timestamp;
        const hits = [...st.txs.values()].filter((t) => t.source === OWNER && t.destination === QUTIL_ID && Number(t.timestamp) >= Number(gte) && Number(t.timestamp) <= Number(lte));
        return { hits: { total: hits.length }, transactions: hits } as T;
      }
      throw new Error("unexpected " + path);
    },
  };
  /** Puts a batch on the chain as the owner's transaction, with QUtil's transfers to each wallet. */
  const send = (b: Batch, hash: string, o: { at?: number; tick?: number; refund?: boolean; skip?: string[]; source?: string; amount?: number; payload?: string; pay?: (l: { wallet: string; amountQu: number }) => { from: string; amount: number } } = {}) => {
    const t: Tx = { hash, source: o.source ?? OWNER, destination: QUTIL_ID, amount: String(o.amount ?? b.amountQu), tickNumber: o.tick ?? 4000, timestamp: String(o.at ?? b.createdAt + 60_000), inputType: SEND_TO_MANY_PROC, inputData: o.payload ?? b.payload };
    st.txs.set(hash, t);
    const tr = (source: string, destination: string, amount: number) => ({ logType: 0, tickNumber: t.tickNumber, timestamp: t.timestamp, logId: "1", epoch: 1, transactionHash: hash, quTransfer: { source, destination, amount: String(amount) } });
    st.events[hash] = o.refund
      ? [tr(OWNER, QUTIL_ID, b.amountQu), tr(QUTIL_ID, OWNER, b.amountQu)]
      : [tr(OWNER, QUTIL_ID, b.amountQu), ...b.lines.filter((l) => !o.skip?.includes(l.wallet)).map((l) => { const p = o.pay?.(l) ?? { from: QUTIL_ID, amount: l.amountQu }; return tr(p.from, l.wallet, p.amount); })];
    return t;
  };
  return { archive, st, send };
}

const plan = (log: PayoutLog, lines: [number, number][], o = opts) => log.prepare(lines.map(([i, q]) => bal(wallet(i), q)), o);

/* ---------- planning ---------- */

test("only balances that reach the minimum are planned, and asking again gives the same plan", () => {
  let now = T0;
  const log = new PayoutLog("2026-10", { now: () => now });
  const first = plan(log, [[1, 5000], [2, 999], [3, 1000]]);
  assert.deepEqual(first.flatMap((b) => b.lines).map((l) => [l.wallet, l.amountQu]), [[wallet(1), 5000], [wallet(3), 1000]], "999 waits for next time");
  now += 5000;
  const again = plan(log, [[1, 5000], [2, 999], [3, 1000]]);
  assert.equal(again[0].id, first[0].id);
  assert.equal(log.list().length, 1, "no second record for the same plan");
  assert.equal(log.list()[0].status, "prepared");
});

test("a new plan replaces one nobody signed", () => {
  const log = new PayoutLog("2026-10", { now: () => T0 });
  const a = plan(log, [[1, 5000]]);
  const b = plan(log, [[1, 5000], [2, 7000]]);
  assert.notEqual(a[0].id, b[0].id);
  assert.deepEqual(log.list().map((x) => x.status), ["cancelled", "prepared"]);
});

test("a batch being signed reserves its wallets, so they cannot be planned a second time", () => {
  const log = new PayoutLog("2026-10", { now: () => T0 });
  const [b] = plan(log, [[1, 5000], [2, 6000]]);
  log.markSigning(b.id);
  assert.deepEqual(plan(log, [[1, 5000], [2, 6000], [3, 9000]]).flatMap((x) => x.lines.map((l) => l.wallet)), [wallet(3)], "only the wallet that is not in flight");
  assert.throws(() => log.markSigning(b.id), /sent, not waiting to be signed|is sent/, "the same batch cannot be signed twice");
  assert.equal(log.get(b.id)!.status, "sent");
});

test("a part of a balance already in flight is not planned again, only the rest", () => {
  const log = new PayoutLog("2026-10", { now: () => T0 });
  const [b] = plan(log, [[1, 5000]]);
  log.markSigning(b.id);
  assert.deepEqual(plan(log, [[1, 9000]]).flatMap((x) => x.lines.map((l) => [l.wallet, l.amountQu])), [[wallet(1), 4000]]);
});

test("only a live plan can be cancelled; one being signed or sent cannot", () => {
  const log = new PayoutLog("2026-10", { now: () => T0 });
  const [a] = plan(log, [[1, 5000]]);
  assert.equal(log.cancel(a.id).status, "cancelled");
  assert.throws(() => log.cancel(a.id), /cancelled batch cannot be cancelled/);
  const [b] = plan(log, [[2, 5000]]);
  log.markSigning(b.id);
  assert.throws(() => log.cancel(b.id), /sent batch cannot be cancelled/);
  assert.throws(() => log.cancel("nope"), /No such batch/);
});

test("a reported transaction id must look like one, and a batch is never sent in two transactions", () => {
  const log = new PayoutLog("2026-10", { now: () => T0 });
  const [b] = plan(log, [[1, 5000]]);
  assert.throws(() => log.markSent(b.id, "short"), /60 lowercase/);
  assert.throws(() => log.markSent("nope", txid("a")), /No such batch/);
  assert.equal(log.markSent(b.id, txid("a")).status, "sent");
  assert.throws(() => log.markSent(b.id, txid("b")), /another transaction/);
  assert.equal(log.markSent(b.id, txid("a")).txId, txid("a"), "the same id again is fine");
});

/* ---------- checking a batch on the chain ---------- */

const sentBatch = (extra: Partial<Batch> = {}): Batch => ({ ...buildBatches([{ wallet: wallet(1), amountQu: 5000 }, { wallet: wallet(2), amountQu: 7000 }], FEE, "2026-10", T0)[0], status: "sent", txId: txid("a"), sentAt: T0, ...extra });

test("a batch is paid only when the owner's transaction is on-chain with this payload and QUtil's transfers match every line", async () => {
  const c = chain();
  const b = sentBatch();
  c.send(b, txid("a"));
  const v = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.deepEqual(v.ok && v.paid.map((l) => [l.wallet, l.amountQu]), [[wallet(2), 7000], [wallet(1), 5000]]);
});

test("a refunded transaction did not pay", async () => {
  const c = chain();
  const b = sentBatch();
  c.send(b, txid("a"), { refund: true });
  const v = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.deepEqual([v.ok, !v.ok && v.retry, !v.ok && /refunded/.test(v.reason)], [false, false, true]);
});

test("a transaction that is not exactly this batch, from the owner, to QUtil, is refused", async () => {
  const c = chain();
  const b = sentBatch();
  const why = async (o: Parameters<typeof c.send>[2], tweak?: (b: Batch) => void) => {
    const t = c.send(b, txid("a"), o);
    tweak?.(b);
    const v = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
    c.st.txs.delete(t.hash);
    return v.ok ? "ok" : v.reason;
  };
  assert.match(await why({ source: "S".repeat(59) + "Q" }), /not sent from QMax's address/);
  assert.match(await why({ amount: b.amountQu + 1 }), /does not match this batch/);
  assert.match(await why({ payload: Buffer.alloc(1000).toString("base64") }), /does not match this batch/);
  const t = c.send(b, txid("a"));
  t.destination = "Z".repeat(59) + "A";
  const v = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.ok(!v.ok && /not a send-to-many to QUtil/.test(v.reason));
  const t2 = c.send(b, txid("a"));
  t2.inputType = 2;
  const v2 = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.ok(!v2.ok && /not a send-to-many/.test(v2.reason));
});

test("a wallet that did not get its exact amount makes the batch fail, and the batch says so", async () => {
  const c = chain();
  const b = sentBatch();
  c.send(b, txid("a"), { skip: [wallet(1)] });
  const v = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.ok(!v.ok && !v.retry && /only 1 of 2 wallets/.test(v.reason));
});

test("only QUtil's own transfers, of exactly each line's amount, count as the wallets being paid", async () => {
  const c = chain();
  const b = sentBatch();
  const run = async (pay: NonNullable<Parameters<typeof c.send>[2]>["pay"]) => {
    c.send(b, txid("a"), { pay });
    const v = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
    return v.ok ? "ok" : v.reason;
  };
  assert.match(await run((l) => ({ from: "S".repeat(59) + "Q", amount: l.amountQu })), /refunded|sent nothing/, "a transfer from someone else with the same amount is not QUtil paying");
  assert.match(await run((l) => ({ from: QUTIL_ID, amount: l.wallet === wallet(1) ? l.amountQu - 1 : l.amountQu })), /only 1 of 2/, "one QU short");
  assert.match(await run((l) => ({ from: QUTIL_ID, amount: l.wallet === wallet(1) ? l.amountQu + 1 : l.amountQu })), /only 1 of 2/, "or one QU over: it is not what was planned");
  assert.equal(await run((l) => ({ from: QUTIL_ID, amount: l.amountQu })), "ok");
});

test("a transaction sent before the plan existed is not that plan's payment", async () => {
  let now = T0 + 3 * 24 * 3_600_000;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  c.send(b, txid("a"), { at: T0, tick: 3000 }); // identical bytes, three days earlier
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.deepEqual([log.get(b.id)!.txId, log.get(b.id)!.status], [undefined, "prepared"]);
  assert.equal(log.paidByWallet().size, 0);
});

test("a transaction id the owner reports is verified on its own merits, even if it is older than the plan", async () => {
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => T0 + 3 * 24 * 3_600_000 });
  const [b] = plan(log, [[1, 5000]]);
  log.markSent(b.id, txid("a"));
  c.send(b, txid("a"), { at: T0, tick: 3000 });
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "verified", "a reported id is checked on its own merits: the owner vouched for it");
});

test("a transaction the archive has not indexed yet is retried, for an hour, then given up on", async () => {
  const c = chain();
  const b = sentBatch();
  const early = await verifyBatch(c.archive, b, OWNER, T0 + 60_000);
  assert.ok(!early.ok && early.retry);
  const late = await verifyBatch(c.archive, b, OWNER, T0 + NOT_FOUND_AFTER_MS + 1);
  assert.ok(!late.ok && !late.retry && /never showed/.test(late.reason));
  c.send(b, txid("a"), { tick: 9000 });
  const lag = await verifyBatch(c.archive, b, OWNER, T0 + 60_000);
  assert.ok(!lag.ok && lag.retry && /events not indexed/.test(lag.reason), "the transaction is there but its events are newer than the archive's last processed tick");
});

test("a batch marked as being signed with no transaction is given up on after an hour", async () => {
  const c = chain();
  const b = sentBatch({ txId: undefined, note: "being signed" });
  const soon = await verifyBatch(c.archive, b, OWNER, T0 + 60_000);
  assert.ok(!soon.ok && soon.retry);
  const later = await verifyBatch(c.archive, b, OWNER, T0 + NOT_FOUND_AFTER_MS + 1);
  assert.ok(!later.ok && !later.retry && /no transaction for this batch/.test(later.reason));
});

/* ---------- finding out what happened ---------- */

test("a batch signed without telling QMax is found by its payload, verified and credited", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000], [2, 7000]]);
  c.send(b, txid("a"));
  now += 120_000;
  const r = await log.reconcile(c.archive, OWNER);
  assert.equal(r.verified.length, 1);
  assert.equal(log.get(b.id)!.status, "verified");
  assert.equal(log.get(b.id)!.txId, txid("a"));
  assert.deepEqual([...log.paidByWallet()].sort(), [[wallet(1), 5000], [wallet(2), 7000]].sort());
  // Planned again with the same balances: nothing, because the money has been paid. (In practice the balances then show it paid.)
  assert.equal(log.inFlight().size, 0);
});

test("a reported transaction is verified without searching, and a refunded one is failed so its wallets are planned again", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  log.markSigning(b.id);
  log.markSent(b.id, txid("a"));
  c.send(b, txid("a"), { refund: true });
  now += 120_000;
  const r = await log.reconcile(c.archive, OWNER);
  assert.equal(r.failed.length, 1);
  assert.equal(log.get(b.id)!.status, "failed");
  assert.equal(log.paidByWallet().size, 0, "a refunded batch paid nobody");
  assert.deepEqual(plan(log, [[1, 5000]]).flatMap((x) => x.lines.map((l) => l.wallet)), [wallet(1)], "so the wallet is planned again");
});

test("a plan nobody signs is dropped after a day, but still credited if it is signed late", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  now += PLAN_EXPIRES_MS + 1000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "cancelled");
  // The owner signs the old plan a week later.
  now += 6 * 24 * 3_600_000;
  c.send(b, txid("a"), { at: now - 1000 });
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "verified", "money that moved is always recorded");
  assert.equal(log.paidByWallet().get(wallet(1)), 5000);
});

test("a batch signed twice shows it, and both payments are counted so the books match the chain", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000], [2, 7000]]);
  c.send(b, txid("a"), { at: T0 + 60_000, tick: 4000 });
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "verified");
  // Signed again by mistake, later.
  c.send(b, txid("b"), { at: now + 1000, tick: 4100 });
  now += 600_000;
  await log.reconcile(c.archive, OWNER);
  const done = log.get(b.id)!;
  assert.deepEqual(done.duplicateTx, [txid("b")]);
  assert.deepEqual(done.paidTx, [txid("a"), txid("b")]);
  assert.match(done.note!, /SIGNED MORE THAN ONCE/);
  assert.equal(log.paidByWallet().get(wallet(1)), 10_000, "what really arrived, twice");
  assert.equal(log.paidByWallet().get(wallet(2)), 14_000);
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.paidByWallet().get(wallet(1)), 10_000, "and the duplicate is not credited again on the next check");
});

test("a batch marked as being signed that never appears is failed after an hour, releasing its wallets", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  log.markSigning(b.id);
  now += 30 * 60_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "sent", "still waiting inside the hour");
  assert.equal(log.inFlight().size, 1);
  now += 40 * 60_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "failed");
  assert.equal(log.inFlight().size, 0);
});

test("the same lines owed again next month are a new batch, and each month's transaction is matched to its own", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [oct] = plan(log, [[1, 5000]]);
  c.send(oct, txid("a"), { at: now + 60_000 });
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(oct.id)!.status, "verified");
  // A month later the same amount is owed to the same wallet: identical bytes, a new payment.
  now += 20 * 24 * 3_600_000;
  const [nov] = plan(log, [[1, 5000]]);
  assert.notEqual(nov.id, oct.id);
  assert.equal(nov.payload, oct.payload);
  c.send(nov, txid("b"), { at: now + 60_000, tick: 4500 });
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(nov.id)!.txId, txid("b"));
  assert.equal(log.get(oct.id)!.txId, txid("a"));
  assert.deepEqual([log.get(oct.id)!.duplicateTx, log.get(nov.id)!.duplicateTx], [undefined, undefined], "neither is mistaken for the other being signed twice");
  assert.equal(log.paidByWallet().get(wallet(1)), 10_000);
});

test("a plan made current again is not dropped for its old age, but still keeps its own window for finding transactions", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [a] = plan(log, [[1, 5000]]);
  now += PLAN_EXPIRES_MS + 1000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(a.id)!.status, "cancelled");
  const [again] = plan(log, [[1, 5000]]);
  assert.equal(again.id, a.id, "the same plan is brought back");
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(a.id)!.status, "prepared", "and is not dropped again straight away");
});

test("a refund followed by a successful second signing of the same batch is credited", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  c.send(b, txid("a"), { refund: true, at: now + 60_000, tick: 4000 });
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "failed");
  c.send(b, txid("b"), { at: now + 1000, tick: 4100 });
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "verified", "money moved, so it is recorded");
  assert.equal(log.paidByWallet().get(wallet(1)), 5000, "only the transaction that paid is credited, not the refunded one");
});

test("a wrong transaction id reported for a batch does not hide the real one", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  log.markSent(b.id, txid("z")); // a typo: no such transaction
  c.send(b, txid("a"), { at: now + 60_000 });
  now += NOT_FOUND_AFTER_MS + 120_000;
  await log.reconcile(c.archive, OWNER);
  const done = log.get(b.id)!;
  assert.equal(done.status, "verified");
  assert.equal(done.note, undefined, "one transaction paid, so it is not called a double payment");
  assert.equal(log.paidByWallet().get(wallet(1)), 5000);
});

test("the ledger survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "payouts-"));
  const file = join(dir, "profitshare.json");
  try {
    const c = chain();
    const log = new PayoutLog("2026-10", { file, now: () => T0 });
    const [b] = plan(log, [[1, 5000]]);
    c.send(b, txid("a"));
    await log.reconcile(c.archive, OWNER);
    log.flush();
    const again = new PayoutLog("2030-01", { file, now: () => T0 });
    assert.equal(again.start, "2026-10", "the start of the programme is fixed when the ledger is first made");
    assert.equal(again.get(b.id)!.status, "verified");
    assert.equal(again.paidByWallet().get(wallet(1)), 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- adversarial review: what must not double-pay or credit money that did not move ---------- */

test("an archive that errors says nothing about the transaction: a sent batch is not failed, however long it lasts", async () => {
  const c = chain();
  const b = sentBatch();
  c.send(b, txid("a"));
  const real = c.archive.post.bind(c.archive);
  c.archive.post = (async (path: string, body: unknown) => {
    if (path.endsWith("/getTransactionByHash")) throw new Error("Qubic RPC unavailable: RPC 503");
    return real(path, body);
  }) as Archive["post"];
  const v = await verifyBatch(c.archive, b, OWNER, T0 + 5 * 3_600_000);
  assert.ok(!v.ok && v.retry, "a 503 or a 429 is not 'the archive never showed it': the batch stays sent and its wallets stay reserved");
  const log = new PayoutLog("2026-10", { now: () => T0 + 5 * 3_600_000 });
  log.list().push(sentBatch());
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.list()[0].status, "sent", "released only on a real answer, or the wallets would be planned and paid a second time");
});

test("a transaction the archive showed late is still credited after the batch was given up on", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  log.markSigning(b.id);
  log.markSent(b.id, txid("a"));
  now += NOT_FOUND_AFTER_MS + 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "failed", "nothing showed for an hour: the wallets are released");
  c.send(b, txid("a"), { at: T0 + 60_000, tick: 4000 }); // the archive was only late
  now += 120_000;
  const r = await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "verified", "the money moved, so the books must say so, or the wallets are paid again");
  assert.equal(r.verified.length, 1);
  assert.equal(log.paidByWallet().get(wallet(1)), 5000);
});

test("a transaction id that already belongs to another batch cannot be reported for this one", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [first] = plan(log, [[1, 5000]]);
  c.send(first, txid("a"));
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.paidByWallet().get(wallet(1)), 5000);
  now += 30 * 24 * 3_600_000;
  const [second] = plan(log, [[1, 5000]]); // the same lines owed again next month: the same bytes, a new batch
  assert.notEqual(second.id, first.id);
  assert.throws(() => log.markSent(second.id, txid("a")), /already belongs to batch/, "one transaction moved the money once");
  assert.equal(log.get(second.id)!.txId, undefined);
});

test("a ledger that exists but cannot be read stops the payout instead of starting empty and paying everything again", () => {
  const dir = mkdtempSync(join(tmpdir(), "payouts-"));
  const file = join(dir, "profitshare.json");
  try {
    writeFileSync(file, '{"v":1,"start":"2026-10","batches":[{"id":"x"');
    assert.throws(() => new PayoutLog("2026-10", { file }), /cannot be read/);
    writeFileSync(file, JSON.stringify({ v: 2, start: "2026-10", batches: [] }));
    assert.throws(() => new PayoutLog("2026-10", { file }), /cannot be read/, "a newer format is not guessed at");
    rmSync(file);
    assert.equal(new PayoutLog("2026-10", { file }).list().length, 0, "no file at all is a first run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserving a batch and reporting its transaction reach the disk at once, not after a delay a crash could eat", () => {
  const dir = mkdtempSync(join(tmpdir(), "payouts-"));
  const file = join(dir, "profitshare.json");
  try {
    const log = new PayoutLog("2026-10", { file, now: () => T0 });
    const [b] = plan(log, [[1, 5000]]);
    log.markSigning(b.id);
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).batches[0].status, "sent", "the reservation survives a crash right after signing starts");
    log.markSent(b.id, txid("a"));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).batches[0].txId, txid("a"));
    const again = new PayoutLog("2026-10", { file, now: () => T0 });
    assert.deepEqual(plan(again, [[1, 5000]]), [], "after a restart the wallet is still reserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the owner's own address and excluded wallets are never planned, whatever the balances say", () => {
  const log = new PayoutLog("2026-10", { now: () => T0 });
  const batches = log.prepare([bal(OWNER, 9000), bal(wallet(1), 5000), bal(wallet(2), 7000)], { ...opts, exclude: [OWNER, wallet(2)] });
  assert.deepEqual(batches.flatMap((b) => b.lines.map((l) => l.wallet)), [wallet(1)]);
});

test("a whole plan is checked before anything is signed, and its totals are counted from the batches, not taken from the plan's own summary", () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ wallet: wallet(i), amountQu: 2000 + i }));
  const bs = buildBatches(lines, FEE, "2026-10", T0);
  const owed = new Map(lines.map((l) => [l.wallet, l.amountQu]));
  const ok = checkPlan({ owner: OWNER, batches: bs.map(view) }, { owner: OWNER, owed });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.wallets, 30);
  assert.equal(ok.toWalletsQu, lines.reduce((s, l) => s + l.amountQu, 0));
  assert.equal(ok.totalAttachedQu, ok.toWalletsQu + 2 * FEE, "two transactions, each carrying QUtil's fee");

  const problems = (v: BatchView[], o = OWNER, owedMap: Map<string, number> | undefined = owed) => checkPlan({ owner: o, batches: v }, { owner: OWNER, owed: owedMap }).problems.join(" | ");
  assert.match(problems(bs.map(view), "X".repeat(60)), /not QMax|not O{59}Q|is paid from/);
  assert.match(problems([view(bs[0]), view(bs[0])]), /listed twice/);
  assert.match(problems([view({ ...bs[0], status: "verified" })]), /not a plan waiting/);
  const [overlap] = buildBatches([bs[0].lines[0]], FEE, "2026-10", T0 + 1);
  assert.match(problems([view(bs[0]), view(overlap)]), /more than one batch/, "the same wallet paid in two batches");
  const [self] = buildBatches([{ wallet: OWNER, amountQu: 5000 }], FEE, "2026-10", T0);
  assert.match(problems([view(self)], OWNER, undefined), /signing address itself/);
  assert.match(problems(bs.map(view), OWNER, new Map(lines.map((l) => [l.wallet, l.amountQu - 1]))), /more than the/, "a line above what the wallet is owed");
  assert.match(problems(bs.map(view), OWNER, new Map()), /more than the 0 QU it is owed/, "a wallet that is not owed anything at all");
  const tampered = view(bs[0]);
  assert.match(problems([{ ...tampered, tx: { ...tampered.tx, amountQu: tampered.tx.amountQu + 1 } }]), /plus the fee/, "each batch still passes the byte-level check");
});

test("a missing transaction is only given up on once the archive itself has processed past the hour, so a lagging archive cannot release the wallets", async () => {
  const c = chain();
  const b = sentBatch();
  c.st.tickTime = T0 + 10 * 60_000; // the archive has only got ten minutes past the signing
  const behind = await verifyBatch(c.archive, b, OWNER, T0 + 3 * 3_600_000);
  assert.ok(!behind.ok && behind.retry, "three hours of the clock, but the archive is not there yet: it may simply not have indexed it");
  const noId = await verifyBatch(c.archive, sentBatch({ txId: undefined }), OWNER, T0 + 3 * 3_600_000);
  assert.ok(!noId.ok && noId.retry);
  c.st.tickTime = T0 + NOT_FOUND_AFTER_MS + 5 * 60_000; // now it has processed an hour and more after the signing, and still nothing
  const passed = await verifyBatch(c.archive, b, OWNER, T0 + 3 * 3_600_000);
  assert.ok(!passed.ok && !passed.retry && passed.unconfirmed === true);
  const noTime = chain();
  noTime.archive.post = (async () => { throw new Error("Qubic RPC unavailable: RPC 503"); }) as Archive["post"];
  const blind = await verifyBatch({ ...noTime.archive, post: async (p: string, body: unknown) => { if (p.endsWith("/getTransactionByHash")) throw new Error("RPC 404 for x"); throw new Error("nope"); } } as Archive, b, OWNER, T0 + 3 * 3_600_000);
  assert.ok(!blind.ok && blind.retry, "an archive that cannot say how far it has got is not trusted to say a transaction is missing");
});

test("a server clock that runs a few minutes ahead of the chain does not hide the owner's transaction from the plan it paid", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000], [2, 7000]]);
  // Signed straight after the plan was made, but the chain stamps it 5 minutes before the server's idea of "now" at planning.
  c.send(b, txid("a"), { at: b.createdAt - 5 * 60_000 + 10_000 });
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "verified", "found by its bytes despite the skew, so the wallets are not planned and paid again");
  assert.equal(log.paidByWallet().get(wallet(2)), 7000);
});

test("a transaction from before the plan's time is still not that plan's payment, even with the allowance for a clock that is off", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  c.send(b, txid("a"), { at: b.createdAt - 3 * 3_600_000, tick: 3000 }); // three hours earlier: last month's payment of the same lines, say
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.deepEqual([log.get(b.id)!.txId, log.get(b.id)!.status], [undefined, "prepared"]);
});

/* ---------- adversarial review, second pass ---------- */

test("an identity QUtil would skip or treat as a contract is never a destination: the all-zero id makes it keep the money", () => {
  // QUtil.h: a destination equal to NULL_ID is skipped, but its amount is still part of the total, so that QU stays in the contract for good.
  const nullId = "A".repeat(60);
  for (const bad of [nullId, QUTIL_ID, QPAYHUB_IDENTITY, "B" + "A".repeat(55) + "RMID"]) assert.throws(() => sendToManyPayload([{ wallet: bad, amountQu: 5000 }]), /not a wallet|all-zero|contract/, bad);
  // A signer checking a plan from a server it does not trust must see it too: here the bytes really are what the list says, and still refused.
  const hostile = Buffer.alloc(1000);
  hostile.writeBigInt64LE(5000n, 800);
  const v: BatchView = { id: "0123456789abcdef", status: "prepared", lines: [{ wallet: nullId, amountQu: 5000 }], feeQu: FEE, amountQu: 5000 + FEE, tx: { destinationContractIndex: QUTIL_INDEX, inputType: SEND_TO_MANY_PROC, amountQu: 5000 + FEE, payloadBase64: hostile.toString("base64") } };
  assert.match(checkBatchView(v).join(), /not a wallet|all-zero|contract/);
  assert.equal(sendToManyPayload([{ wallet: wallet(3), amountQu: 5000 }]).length, 1000, "an ordinary wallet is fine");
});

test("a transaction with no events at all is not judged a refund, because a wrong verdict would pay the wallets twice", async () => {
  const c = chain();
  const b = sentBatch();
  const t = c.send(b, txid("a"));
  const good = c.st.events[txid("a")];
  c.st.events[txid("a")] = []; // the archive has the transaction but not its events yet
  const v = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.ok(!v.ok && v.retry && /events/.test(v.reason), "wait for them: a refund has events too (the money in and the money back)");
  t.moneyFlew = false; // unless the money never left the wallet: then there will never be any, and that is final
  const v2 = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.ok(!v2.ok && !v2.retry && /never left/.test(v2.reason));

  // Through the ledger: the batch stays sent, its wallets stay reserved, and when the events appear it is credited.
  let now = T0;
  const c2 = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [pb] = plan(log, [[1, 5000]]);
  log.markSigning(pb.id);
  log.markSent(pb.id, txid("a"));
  c2.send(pb, txid("a"));
  const events = c2.st.events[txid("a")];
  c2.st.events[txid("a")] = [];
  now += 120_000;
  await log.reconcile(c2.archive, OWNER);
  assert.equal(log.get(pb.id)!.status, "sent");
  assert.equal(log.inFlight().size, 1, "the wallet is still reserved, not planned a second time");
  c2.st.events[txid("a")] = events;
  now += 120_000;
  await log.reconcile(c2.archive, OWNER);
  assert.equal(log.get(pb.id)!.status, "verified");
  assert.equal(log.paidByWallet().get(wallet(1)), 5000);
  assert.ok(good.length > 0);
});

test("when a transaction moved money to only some of its wallets, what moved is credited and only the rest stays owed", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000], [2, 7000]]);
  c.send(b, txid("a"), { skip: [wallet(1)] }); // wallet 2 was paid, wallet 1 was not
  now += 120_000;
  const r = await log.reconcile(c.archive, OWNER);
  assert.equal(r.failed.length, 1, "not a clean payout: it is flagged");
  assert.equal(log.get(b.id)!.status, "failed");
  assert.match(log.get(b.id)!.note!, /only 1 of 2/);
  assert.deepEqual([...log.paidByWallet()], [[wallet(2), 7000]], "but the money that did move is on the books, or wallet 2 would be paid again");
  const owed = (w: number, q: number) => q - (log.paidByWallet().get(wallet(w)) ?? 0);
  assert.deepEqual(plan(log, [[1, owed(1, 5000)], [2, owed(2, 7000)]]).flatMap((x) => x.lines.map((l) => [l.wallet, l.amountQu])), [[wallet(1), 5000]], "so the next plan pays only the wallet that did not get its money");

  // A wallet that received a different amount from the line is credited what it really received.
  const c2 = chain();
  const log2 = new PayoutLog("2026-10", { now: () => now });
  const [b2] = plan(log2, [[1, 5000], [2, 7000]]);
  c2.send(b2, txid("b"), { pay: (l) => ({ from: QUTIL_ID, amount: l.wallet === wallet(1) ? l.amountQu - 1 : l.amountQu }) });
  now += 120_000;
  await log2.reconcile(c2.archive, OWNER);
  assert.equal(log2.paidByWallet().get(wallet(1)), 4999, "what arrived, not what was planned");
  assert.equal(log2.paidByWallet().get(wallet(2)), 7000);
});

test("a refund is never credited to the owner as if it were a payment to a wallet", async () => {
  // With a fee of zero the refund QUtil gives back (everything attached) equals a line to the owner's own address.
  const [self] = buildBatches([{ wallet: OWNER, amountQu: 5000 }], 0, "2026-10", T0);
  const c = chain();
  const b: Batch = { ...self, status: "sent", txId: txid("a"), sentAt: T0 };
  c.send(b, txid("a"), { refund: true });
  const v = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.ok(!v.ok && !("moved" in v && v.moved?.length), "the owner is not a wallet that can be paid by its own batch");
});

test("a batch whose reported transaction was checked and did not pay is not left 'sent' for ever, reserving its wallets", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  log.markSigning(b.id);
  log.markSent(b.id, txid("a"));
  c.send(b, txid("a"), { refund: true });
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "failed");
  // The same transaction reported again (a retried request, say) must not put it back into a state nothing can leave.
  assert.throws(() => log.markSent(b.id, txid("a")), /already checked/);
  assert.equal(log.get(b.id)!.status, "failed");
  assert.equal(log.inFlight().size, 0);
  // And a batch found in that state (left by an older version) is settled by the next check instead of staying reserved.
  log.get(b.id)!.status = "sent";
  assert.equal(log.inFlight().size, 1);
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(b.id)!.status, "failed");
  assert.equal(log.inFlight().size, 0);
});

test("a plan brought back after more than a month is still looked for on-chain, so signing it without telling QMax cannot lead to paying twice", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [a] = plan(log, [[1, 5000]]);
  now += PLAN_EXPIRES_MS + 1000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(a.id)!.status, "cancelled");
  now += 40 * 24 * 3_600_000;
  const [again] = plan(log, [[1, 5000]]); // nothing changed, so it is the same plan, with its old creation time
  assert.equal(again.id, a.id);
  log.markSigning(again.id);
  c.send(again, txid("a"), { at: now + 30_000, tick: 4500 }); // the owner signs it; the request that reports the id is lost
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(log.get(a.id)!.status, "verified", "found by its bytes even though the plan was first made more than 30 days ago");
  assert.equal(log.paidByWallet().get(wallet(1)), 5000);
});

test("the ledger exists from the moment it is created, so a crash before the first payout cannot move the start of the programme", () => {
  const dir = mkdtempSync(join(tmpdir(), "payouts-"));
  const file = join(dir, "sub", "profitshare.json");
  try {
    new PayoutLog("2026-10", { file, now: () => T0 });
    assert.ok(existsSync(file), "written at once, not at the first plan or a clean exit");
    // The server is killed and started again two months later, when 'the current month' is a different one.
    assert.equal(new PayoutLog("2026-12", { file, now: () => T0 }).start, "2026-10");
    assert.equal(statSync(file).mode & 0o777, 0o600, "readable by its owner only");
    const log = new PayoutLog("2026-10", { file, now: () => T0 });
    plan(log, [[1, 5000]]);
    log.flush();
    log.flush();
    assert.equal(statSync(file + ".bak").mode & 0o777, 0o600, "and so is the copy of the version before");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transaction in the archive's answer that is not from the owner is never attached to a batch, whatever the archive filtered", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  const stranger = c.send(b, txid("s"), { source: "S".repeat(59) + "Q" });
  const real = c.archive.post.bind(c.archive);
  c.archive.post = (async (path: string, body: unknown) => (path.endsWith("/getTransactionsForIdentity") ? { hits: { total: 1 }, transactions: [stranger] } : real(path, body))) as Archive["post"];
  now += 120_000;
  await log.reconcile(c.archive, OWNER);
  assert.deepEqual([log.get(b.id)!.txId, log.get(b.id)!.status], [undefined, "prepared"], "an archive that ignored the source filter cannot make a stranger's transaction this batch's");
  assert.throws(() => log.markSent("nope", txid("s")), /No such batch/);
});

test("the signer's own journal catches a plan that pays wallets again that this machine paid recently, whatever the server's ledger says", () => {
  const plan = [{ lines: [{ wallet: wallet(1), amountQu: 5000 }, { wallet: wallet(2), amountQu: 7000 }] }, { lines: [{ wallet: wallet(3), amountQu: 1000 }] }];
  const journal = [
    { at: T0, batchId: "a", txId: txid("a"), lines: [{ wallet: wallet(2), amountQu: 7000 }, { wallet: wallet(9), amountQu: 100 }] },
    { at: T0 - 60 * 24 * 3_600_000, batchId: "old", lines: [{ wallet: wallet(1), amountQu: 5000 }] }, // two months ago: a new month's payout
  ];
  const hit = recentlyPaid(plan, journal, T0 + 24 * 3_600_000);
  assert.deepEqual(hit.map((h) => [h.wallet, h.amountQu, h.paidAt, h.paidQu]), [[wallet(2), 7000, T0, 7000]], "only the wallet paid recently, in this plan");
  assert.deepEqual(recentlyPaid(plan, journal, T0 + REPEAT_WINDOW_MS - 1).length, 1);
  assert.deepEqual(recentlyPaid(plan, journal, T0 + REPEAT_WINDOW_MS), [], "after the window it is next month's payout");
  assert.deepEqual(recentlyPaid(plan, [], T0), []);
});

test("only one signing run at a time: the lock names its process, and one left by a dead or very old run is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const path = join(dir, "sub", "payout.lock");
  try {
    const a = takeLock(path, { pid: 111, now: T0, alive: () => true });
    assert.ok(a.ok && existsSync(path));
    assert.deepEqual(takeLock(path, { pid: 222, now: T0 + 1000, alive: () => true }), { ok: false, heldBy: 111 }, "a second run is refused while the first lives");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const dead = takeLock(path, { pid: 333, now: T0 + 2000, alive: () => false });
    assert.ok(dead.ok, "a lock left by a run that died is taken over");
    assert.ok(takeLock(path, { pid: 444, now: T0 + 3 * 3_600_000, alive: () => true }).ok, "and one that is hours old, whatever the pid says (pids are reused)");
    writeFileSync(path, "garbage");
    assert.ok(takeLock(path, { pid: 555, now: T0, alive: () => true }).ok, "an unreadable lock is as good as stale");
    const mine = takeLock(path, { pid: 666, now: T0, alive: () => true });
    assert.equal(mine.ok, false);
    const last = takeLock(join(dir, "other.lock"), { pid: 777 });
    assert.ok(last.ok);
    if (last.ok) last.release();
    assert.equal(existsSync(join(dir, "other.lock")), false, "released at the end");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the signer's journal is kept for its owner only, written whole, and an unreadable one stops the signing instead of being ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-"));
  const path = join(dir, "sub", "payout-journal.json");
  try {
    assert.deepEqual(readJournalFile(path), [], "no file is a first run");
    const entries = [{ at: T0, batchId: "a", txId: txid("a"), lines: [{ wallet: wallet(1), amountQu: 5000 }] }];
    writeJournalFile(path, entries);
    assert.deepEqual(readJournalFile(path), entries);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    writeFileSync(path, '[{"at":1,"batchId":"x","lines":[');
    assert.throws(() => readJournalFile(path), /cannot be read/);
    writeFileSync(path, '{"not":"a list"}');
    assert.throws(() => readJournalFile(path), /cannot be read/);
    writeFileSync(path, '[{"at":"yesterday","lines":[]}]');
    assert.throws(() => readJournalFile(path), /cannot be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("events from an answer that is only valid up to an earlier tick are not taken for the transaction's whole story", async () => {
  // A replica that has reached tick 3999 can show the owner's transfer into QUtil (tick 4000's first events) without QUtil's payments out, and
  // 'only some wallets were paid' would then be recorded as final while the rest arrive a moment later: they would be paid a second time.
  const c = chain();
  const b = sentBatch();
  c.send(b, txid("a"));
  c.st.events[txid("a")] = c.st.events[txid("a")].slice(0, 2); // the money in, and one of the payments out
  c.st.eventsValid = 3999;
  const lagging = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.ok(!lagging.ok && lagging.retry && /events not indexed/.test(lagging.reason), "wait for a replica that has the whole tick");
  c.st.eventsValid = 5000;
  const behind = await verifyBatch(c.archive, b, OWNER, T0 + 120_000);
  assert.ok(!behind.ok && !behind.retry && /only 1 of 2/.test(behind.reason), "once it is valid for the tick, what it shows is believed");
});

test("a ledger that was fully written but not yet moved into place when the process died is not lost", () => {
  // markSigning writes the new state to a temporary file, syncs it, then moves it over the ledger. A crash between the two used to leave the
  // old ledger (the plan still 'prepared', its wallets not reserved) with the newer state sitting unread beside it.
  const dir = mkdtempSync(join(tmpdir(), "payouts-"));
  const file = join(dir, "profitshare.json");
  try {
    const log = new PayoutLog("2026-10", { file, now: () => T0 });
    const [b] = plan(log, [[1, 5000]]);
    log.flush();
    const older = readFileSync(file, "utf8");
    log.markSigning(b.id);
    const newer = readFileSync(file, "utf8");
    assert.notEqual(older, newer);
    // Put the disk as the crash would have left it: the old ledger in place, the new one complete in the temporary file.
    writeFileSync(file, older);
    writeFileSync(file + ".tmp", newer);
    const again = new PayoutLog("2026-10", { file, now: () => T0 });
    assert.equal(again.get(b.id)!.status, "sent", "the reservation survives");
    assert.equal(again.inFlight().size, 1);
    assert.equal(existsSync(file + ".tmp"), false);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).batches[0].status, "sent");
    // A half-written temporary file (the crash came earlier) is not believed.
    writeFileSync(file + ".tmp", newer.slice(0, 40));
    const third = new PayoutLog("2026-10", { file, now: () => T0 });
    assert.equal(third.get(b.id)!.status, "sent");
    assert.equal(existsSync(file + ".tmp"), false, "and is cleared away");
    // Nothing but a temporary file (the first write of all): that is the ledger.
    rmSync(file);
    writeFileSync(file + ".tmp", newer);
    assert.equal(new PayoutLog("2030-01", { file, now: () => T0 }).start, "2026-10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plan is checked against what the chain itself entitles each wallet to, so a tampered server cannot invent a wallet or inflate an amount", () => {
  const plan = [{ lines: [{ wallet: wallet(1), amountQu: 5000 }, { wallet: wallet(2), amountQu: 7000 }] }, { lines: [{ wallet: wallet(3), amountQu: 1000 }] }];
  const earned = new Map([[wallet(1), 5000], [wallet(2), 9000]]);
  const problems = overEntitlement(plan, earned);
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`${wallet(3)} would be paid 1000 QU.*at most 0 QU`), "a wallet that never paid anything");
  assert.deepEqual(overEntitlement([plan[0]], earned), [], "what is owed is never more than what was earned");
  assert.equal(overEntitlement([{ lines: [{ wallet: wallet(1), amountQu: 5001 }] }], earned).length, 1, "one QU over is over");
  assert.deepEqual(overEntitlement([], earned), []);
});

test("the owner's sends are read page after page, so a signed batch is found however many other sends the owner made since", async () => {
  let now = T0;
  const c = chain();
  const log = new PayoutLog("2026-10", { now: () => now });
  const [b] = plan(log, [[1, 5000]]);
  c.send(b, txid("a"), { at: now + 60_000 });
  const real = c.archive.post.bind(c.archive);
  // 2,400 other send-to-many transactions from the owner, the batch's own after them: it is on the third page.
  const others: Tx[] = Array.from({ length: 2400 }, (_, i) => ({ hash: String.fromCharCode(98 + (i % 20)).repeat(59) + String.fromCharCode(97 + Math.floor(i / 20) % 26), source: OWNER, destination: QUTIL_ID, amount: "999", tickNumber: 3000, timestamp: String(now + 1000 + i), inputType: SEND_TO_MANY_PROC, inputData: Buffer.alloc(1000, 1).toString("base64") }));
  const all = [...others, c.st.txs.get(txid("a"))!];
  let pages = 0;
  c.archive.post = (async (path: string, body: any) => {
    if (path.endsWith("/getTransactionsForIdentity")) {
      pages++;
      return { hits: { total: all.length }, transactions: all.slice(body.pagination.offset, body.pagination.offset + body.pagination.size) };
    }
    return real(path, body);
  }) as Archive["post"];
  now += 3 * 60_000;
  await log.reconcile(c.archive, OWNER);
  assert.equal(pages, 3);
  assert.equal(log.get(b.id)!.txId, txid("a"));
  assert.equal(log.get(b.id)!.status, "verified");
});
