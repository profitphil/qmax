import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { decodeTrade } from "../src/events.ts";
import type { EventLog, Trade } from "../src/events.ts";
import { DAY, HOUR } from "../src/history.ts";
import { RouteError } from "../src/routes.ts";
import type { QubicRpc } from "../src/rpc.ts";
import { TradeTape, catalogSymbolOf, sideFromTransaction, sideResolver, tapeRoutes } from "../src/tape.ts";
import type { SideResult, TapeRow } from "../src/tape.ts";
import { agoLabel, agoShort, compactQu, mergeTape, pollCursor } from "../web/tape-api.ts";

import { NOW, archive, key, qx, swap } from "./trade-helpers.ts";

const known = new Map([
  [key("CFB"), "CFB"],
  [key("QWIN"), "QWIN"],
]);
const symbolOf = (k: string) => known.get(k);
/** A trade as the index would announce it, optionally with the transaction the archive attached. */
const mk = (e: EventLog, txHash?: string): Trade => decodeTrade(txHash ? { ...e, transactionHash: txHash } : e)!;
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const tapeAt = (opts: { capacity?: number; resolveSide?: (hash: string) => Promise<SideResult> } = {}) => new TradeTape({ symbolOf, resolveSide: opts.resolveSide }, { capacity: opts.capacity, now: () => NOW });
/** One QX fill whose price is the tick number, so rows can be told apart by price. */
const fill = (tick: number, name = "CFB", ms = NOW - 1000 + tick) => mk(qx(tick, ms, name, tick, 1));
const ticks = (rows: TapeRow[]) => rows.map((r) => r.price);

// Two real QX transactions, captured from the archive on 2026-10-04 (signatures left out): a bid (call 6) and an ask (call 5).
const QX_ID = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARMID";
const realBid = { hash: "zazgdzyqmchuefezqpoxuqimhyxclkawjqubgepxeduswscpwclcpybdawqb", amount: "186900922", source: "TNYYHTXOXEJHIGIEXZZLLXPVNHRBGHILDYNJZNTWFGKNTAOBBYMEWBGACZTH", destination: QX_ID, tickNumber: 83103103, timestamp: "1791156484000", inputType: 6, inputSize: 56, inputData: "sIDhGBAYq/Jp2R/RLXMGWuearj4mBsUxy2MEmL3KGd1RTUlORQAAADoQAAAAAAAAwa8AAAAAAAA=", moneyFlew: true };
const realAsk = { hash: "lyxtixcrhkdkrdnihmpqcgvwatmgvvelcizylhuwyfgavchwopttehqfreeh", amount: "0", source: "EOLQSUOCRESWOBITXKZGPFPSOTSCKXMEXYZMBZPXGBIWMHFOYWMMMWSGFQJJ", destination: QX_ID, tickNumber: 83080545, timestamp: "1791144045000", inputType: 5, inputSize: 56, inputData: "ZpCUU0kbxLVM35YebInTIt5m6nrFRnJZzooZJQJb5k5RUEFZAAAAAMIBAAAAAAAAcrMAAAAAAAA=", moneyFlew: true };

/* ---------- the ring buffer ---------- */

test("the tape keeps the newest rows, newest first, and ids only grow", () => {
  const tape = tapeAt({ capacity: 3 });
  for (let tick = 1; tick <= 5; tick++) tape.push([fill(tick)]);
  assert.deepEqual(ticks(tape.recent()), [5, 4, 3], "the two oldest fell off the end");
  assert.deepEqual(tape.recent().map((r) => r.id), [5, 4, 3], "an id belongs to a row for good, whatever happens to the others");
  assert.equal(tape.latestId, 5);
  assert.equal(tape.size, 3);
  tape.push([fill(6)]);
  assert.deepEqual(tape.recent().map((r) => r.id), [6, 5, 4]);
});

test("a row older than everything on a full tape is not kept and does not use up an id", () => {
  const tape = tapeAt({ capacity: 2 });
  tape.push([fill(10), fill(11)]);
  assert.equal(tape.push([fill(5)]), 0);
  assert.equal(tape.latestId, 2);
  assert.deepEqual(ticks(tape.recent()), [11, 10]);
  assert.equal(tape.stats().ignored.tooOld, 1);
  // so a replay of a row that has already fallen off cannot come back either
  tape.push([fill(12)]);
  assert.equal(tape.push([fill(10)]), 0);
  assert.deepEqual(ticks(tape.recent()), [12, 11]);
});

test("rows arriving out of order are placed by their position on the chain, with ids in arrival order", () => {
  const tape = tapeAt();
  tape.push([fill(5), fill(3), fill(4)]);
  assert.deepEqual(ticks(tape.recent()), [5, 4, 3]);
  assert.deepEqual(tape.recent().map((r) => r.id), [3, 2, 1], "within one batch ids grow with time");
  tape.push([fill(2)]); // an older window read later, as a warmup does
  assert.deepEqual(ticks(tape.recent()), [5, 4, 3, 2]);
  assert.equal(tape.recent()[3].id, 4, "it still gets a new id, so a client polling since=3 hears about it");
  assert.deepEqual(ticks(tape.recent({ sinceId: 3 })), [2]);
});

test("rows in the same tick are ordered by log number", () => {
  const tape = tapeAt();
  const a = mk({ ...qx(100, NOW, "CFB", 1, 1), logId: "9" });
  const b = mk({ ...qx(100, NOW, "CFB", 2, 1), logId: "10" });
  tape.push([b, a]);
  assert.deepEqual(ticks(tape.recent()), [2, 1], "10 comes after 9 even though '10' < '9' as text");
});

test("a tape has an instance token that stays the same for its life and can be set", () => {
  const a = tapeAt();
  a.push([fill(1)]);
  assert.equal(a.instance, a.instance);
  assert.notEqual(a.instance, tapeAt().instance);
  assert.equal(new TradeTape({ symbolOf }, { instance: "fixed" }).instance, "fixed");
});

test("rows that are given back are copies", () => {
  const tape = tapeAt();
  tape.push([fill(1)]);
  tape.recent()[0].price = 999;
  assert.equal(tape.recent()[0].price, 1);
});

test("a row carries what the page needs and nothing absent shows up as undefined", () => {
  const tape = tapeAt();
  tape.push([mk(swap(6, 1, NOW - 5000, "CFB", 5000, 2000), "tx9")]);
  const [row] = tape.recent();
  assert.deepEqual(row, { id: 1, t: NOW - 5000, venue: "QSwap", asset: "CFB", assetKey: key("CFB"), qty: 2000, qu: 5000, price: 2.5, side: "buy", txHash: "tx9" });
  tape.push([fill(2)]);
  assert.deepEqual(Object.keys(tape.recent()[0]).sort(), ["asset", "assetKey", "id", "price", "qty", "qu", "t", "venue"], "a QX fill without a transaction or side has neither key");
});

/* ---------- since, filters ---------- */

test("since returns only rows that arrived after that id", () => {
  const tape = tapeAt();
  for (let tick = 1; tick <= 10; tick++) tape.push([fill(tick)]);
  assert.equal(tape.recent({ sinceId: 10 }).length, 0, "nothing newer than the newest");
  assert.deepEqual(ticks(tape.recent({ sinceId: 7 })), [10, 9, 8]);
  assert.equal(tape.recent({ sinceId: 0 }).length, 10);
  assert.equal(tape.recent({ sinceId: 99 }).length, 0, "a cursor from a longer-lived tape");
  assert.deepEqual(ticks(tape.recent({ sinceId: 2, limit: 3 })), [10, 9, 8], "if more are newer than the limit, it is the newest ones");
});

test("a filter does not change the cursor: latestId is the whole tape's", () => {
  const tape = tapeAt();
  tape.push([fill(1, "CFB"), fill(2, "QWIN"), fill(3, "CFB")]);
  assert.deepEqual(ticks(tape.recent({ asset: "CFB" })), [3, 1]);
  assert.deepEqual(ticks(tape.recent({ asset: "CFB", sinceId: 1 })), [3]);
  assert.equal(tape.latestId, 3);
});

test("asset and venue filters, and limits", () => {
  const tape = tapeAt();
  tape.push([fill(1, "CFB"), mk(swap(6, 2, NOW - 3000, "CFB", 100, 10)), mk(swap(6, 3, NOW - 2000, "QWIN", 100, 10))]);
  assert.equal(tape.recent({ asset: "cfb" }).length, 2, "any case");
  assert.equal(tape.recent({ asset: "CFB", venue: "QSwap" }).length, 1);
  assert.equal(tape.recent({ venue: "QX" }).length, 1);
  assert.equal(tape.recent({ asset: "NOPE" }).length, 0);
  assert.equal(tape.recent({ limit: 2 }).length, 2);
  assert.equal(tape.recent({ limit: 0 }).length, 1, "at least one");
  assert.equal(tape.recent({ limit: NaN }).length, 3, "the default is 50");
});

/* ---------- what gets in ---------- */

test("the same trade pushed twice is one row, whether in one batch or two", () => {
  const tape = tapeAt();
  const t = fill(1);
  assert.equal(tape.push([t, t]), 1);
  assert.equal(tape.push([t]), 0);
  assert.equal(tape.size, 1);
  assert.equal(tape.stats().ignored.duplicate, 2);
  // different log numbers in one tick are different trades; the same log number in another tick is too
  assert.equal(tape.push([mk({ ...qx(1, NOW, "CFB", 1, 1), logId: "77" }), mk({ ...qx(1, NOW, "CFB", 1, 1), logId: "78" }), mk({ ...qx(2, NOW, "CFB", 1, 1), logId: "77" })]), 3);
});

test("without a log number, a trade is the same one if it has the same transaction and place within it", () => {
  const tape = tapeAt();
  const nolog = (e: EventLog, tx: string) => ({ ...mk(e, tx), logId: "" });
  const pair = () => [nolog(qx(1, NOW, "CFB", 5, 1), "txA"), nolog(qx(1, NOW, "CFB", 6, 2), "txA")];
  assert.equal(tape.push(pair()), 2, "two fills of one transaction are two rows");
  assert.equal(tape.push(pair()), 0, "seen again");
  assert.equal(tape.push([{ ...nolog(qx(1, NOW, "CFB", 5, 1), "txA"), tick: 2 }]), 0, "same transaction, first place: the same trade, whatever tick it is reported under");
  // with neither, nothing can tell two apart, so both are kept
  const bare = { ...fill(9), logId: "" };
  assert.equal(tape.push([bare, bare]), 2);
});

test("assets QMax does not list are ignored, and so are malformed trades", () => {
  const tape = tapeAt();
  assert.equal(tape.push([fill(1, "NOPE"), fill(2, "CFB")]), 1);
  assert.equal(tape.stats().ignored.unknownAsset, 1);
  const good = fill(3);
  for (const bad of [{ ...good, qty: 0 }, { ...good, qu: -5 }, { ...good, price: NaN }, { ...good, t: NaN }]) assert.equal(tape.push([{ ...bad, logId: String(Math.random()) }]), 0);
  assert.equal(tape.stats().ignored.invalid, 4);
  assert.equal(new TradeTape({ symbolOf: () => { throw new Error("boom"); } }).push([good]), 0, "a lookup that throws is an unknown asset, not a crash");
});

/* ---------- flow ---------- */

function flowTape() {
  const sides: Record<string, SideResult> = { txBuy: { side: "buy" }, txSell: { side: "sell" }, txLost: { unknown: "unavailable" } };
  const tape = tapeAt({ resolveSide: async (h) => sides[h] });
  tape.push([
    mk(swap(6, 1, NOW - HOUR, "CFB", 5000, 2000)), // swap, QU in: buy 5,000 QU, 2,000 units
    mk(swap(8, 2, NOW - 2 * HOUR, "CFB", 800, 2000)), // swap, asset in: sell 2,000 QU, 800 units
    mk(qx(3, NOW - 3 * HOUR, "CFB", 10, 100), "txBuy"), // QX fill, bid: buy 1,000 QU, 100 units
    mk(qx(4, NOW - 4 * HOUR, "CFB", 7, 10), "txLost"), // QX fill whose transaction could not be read: 70 QU, 10 units
    mk(swap(6, 5, NOW - HOUR / 2, "QWIN", 900, 30)), // another asset
    mk(qx(6, NOW - 30 * HOUR, "CFB", 1, 1), "txSell"), // outside 24 hours
  ]);
  return tape;
}

test("flow adds up buys and sells in QU and units, counts trades, and keeps unknown directions out of the pressure", async () => {
  const tape = flowTape();
  await tape.settled();
  const f = tape.flow("CFB", NOW - DAY);
  assert.deepEqual(f.buy, { qu: 6000, qty: 2100, trades: 2 });
  assert.deepEqual(f.sell, { qu: 2000, qty: 800, trades: 1 });
  assert.deepEqual(f.unknown, { qu: 70, qty: 10, trades: 1 });
  assert.equal(f.trades, 4);
  assert.equal(f.netQu, 4000);
  assert.equal(f.pressure, 0.5, "(6000 - 2000) / (6000 + 2000), the unknown 70 QU does not count");
});

test("flow can cover all assets, one venue, or a shorter window, and a window start is included", async () => {
  const tape = flowTape();
  await tape.settled();
  const all = tape.flow(undefined, NOW - DAY);
  assert.deepEqual(all.buy, { qu: 6900, qty: 2130, trades: 3 });
  assert.equal(tape.flow("QWIN", NOW - DAY).trades, 1);
  assert.equal(tape.flow("cfb", NOW - DAY, "QSwap").trades, 2, "any case, and one venue");
  assert.equal(tape.flow("CFB", NOW - DAY, "QX").pressure, 1, "the only QX trade with a known side was a buy");
  const short = tape.flow("CFB", NOW - 2.5 * HOUR);
  assert.deepEqual([short.buy.qu, short.sell.qu, short.trades], [5000, 2000, 2]);
  assert.equal(short.pressure, 3000 / 7000);
  assert.equal(tape.flow("CFB", NOW - HOUR).trades, 1, "a trade exactly at the start is in the window");
  assert.equal(tape.flow("CFB", NOW - HOUR + 1).trades, 0);
});

test("with nothing, or nothing whose direction is known, the pressure is null rather than zero", async () => {
  assert.deepEqual(tapeAt().flow(undefined, 0), { sinceMs: 0, buy: { qu: 0, qty: 0, trades: 0 }, sell: { qu: 0, qty: 0, trades: 0 }, unknown: { qu: 0, qty: 0, trades: 0 }, trades: 0, netQu: 0, pressure: null, partial: true, coveredFromMs: NOW });
  const tape = tapeAt();
  tape.push([fill(1)]);
  const f = tape.flow("CFB", 0);
  assert.equal(f.pressure, null);
  assert.equal(f.unknown.trades, 1);
  tape.push([mk(swap(6, 2, NOW, "CFB", 10, 1)), mk(swap(8, 3, NOW, "CFB", 1, 10))]);
  assert.equal(tape.flow("CFB", 0).pressure, 0, "balanced is zero, which is different from null");
});

test("flow says when the tape cannot vouch for the whole window", () => {
  assert.equal(tapeAt().flow(undefined, NOW - DAY).partial, true, "a tape that only just started has not seen the day");
  assert.equal(tapeAt().flow(undefined, NOW).partial, false);
  const tape = new TradeTape({ symbolOf }, { capacity: 2, now: () => NOW - DAY }); // started a day ago, so it has seen everything since
  tape.push([fill(1, "CFB", NOW - 3000), fill(2, "CFB", NOW - 2000), fill(3, "CFB", NOW - 1000)]);
  assert.equal(tape.coveredFromMs, NOW - 3000, "the oldest row had to go, so nothing before it can be vouched for");
  assert.equal(tape.flow(undefined, NOW - 3000).partial, false);
  assert.equal(tape.flow(undefined, NOW - 3001).partial, true);
});

/* ---------- side of a QX fill ---------- */

test("a bid is a buy and an ask is a sell, and only for a call to QX itself", () => {
  assert.equal(sideFromTransaction(realBid), "buy");
  assert.equal(sideFromTransaction(realAsk), "sell");
  assert.equal(sideFromTransaction({ ...realBid, inputType: 7 }), undefined, "cancelling an order places no trade");
  assert.equal(sideFromTransaction({ ...realBid, destination: "QXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" }), undefined, "another contract that happens to use call 6");
  assert.equal(sideFromTransaction({}), undefined);
  assert.equal(sideFromTransaction(null), undefined);
});

test("a QX row is on the tape at once without a side, and gets its side later under the same id", async () => {
  const late = deferred<SideResult>();
  const tape = tapeAt({ resolveSide: () => late.promise });
  assert.equal(tape.push([mk(qx(1, NOW, "CFB", 10, 5), "tx1")]), 1, "pushing does not wait for the lookup");
  const [before] = tape.recent();
  assert.equal(before.side, undefined);
  assert.equal(tape.stats().lookingUp, 1);
  tape.push([fill(2)]);
  late.resolve({ side: "buy" });
  await tape.settled();
  const rows = tape.recent();
  const same = rows.find((r) => r.txHash === "tx1")!;
  assert.equal(same.id, before.id);
  assert.equal(same.side, "buy");
  assert.equal(tape.recent({ sinceId: before.id }).length, 1, "ids did not move, so only the newer row is newer");
  assert.equal(tape.stats().withSide, 1);
});

test("all fills of one transaction share one lookup and one side", async () => {
  const asked: string[] = [];
  const tape = tapeAt({ resolveSide: async (h) => (asked.push(h), { side: "sell" }) });
  tape.push([mk(qx(1, NOW, "CFB", 20, 5), "txA"), mk(qx(1, NOW, "CFB", 27, 5), "txA"), mk(qx(1, NOW, "CFB", 34, 5), "txA"), mk(qx(2, NOW, "CFB", 40, 5), "txB")]);
  await tape.settled();
  assert.deepEqual(asked.sort(), ["txA", "txB"]);
  assert.deepEqual(tape.recent().map((r) => r.side), ["sell", "sell", "sell", "sell"]);
});

test("a QSwap row takes its side from the swap itself and is never looked up", async () => {
  const asked: string[] = [];
  const tape = tapeAt({ resolveSide: async (h) => (asked.push(h), { side: "sell" }) });
  tape.push([mk(swap(7, 1, NOW, "CFB", 100, 10), "txS"), mk(swap(9, 2, NOW, "CFB", 10, 100), "txT")]);
  await tape.settled();
  assert.deepEqual(asked, []);
  assert.deepEqual(tape.recent().map((r) => r.side), ["sell", "buy"]);
});

test("a QX fill without a transaction, or a tape without a resolver, just has no side", async () => {
  const tape = tapeAt({ resolveSide: async () => ({ side: "buy" }) });
  tape.push([mk(qx(1, NOW, "CFB", 1, 1))]);
  await tape.settled();
  assert.equal(tape.recent()[0].side, undefined);
  const bare = tapeAt();
  bare.push([mk(qx(1, NOW, "CFB", 1, 1), "tx")]);
  await bare.settled();
  assert.equal(bare.recent()[0].side, undefined);
  assert.equal(bare.stats().lookingUp, 0, "nothing is waiting for a lookup that was never going to happen");
});

test("a lookup that fails leaves the row without a side, and can be tried again", async () => {
  let up = false;
  let calls = 0;
  const tape = tapeAt({ resolveSide: async () => (calls++, up ? { side: "buy" } : { unknown: "unavailable" }) });
  tape.push([mk(qx(1, NOW, "CFB", 1, 1), "tx1")]);
  await tape.settled();
  assert.equal(tape.recent()[0].side, undefined);
  assert.equal(tape.stats().lookupFailed, 1);
  assert.equal(await tape.resolvePending(), 0, "still down");
  up = true;
  assert.equal(await tape.resolvePending(), 1);
  assert.equal(tape.recent()[0].side, "buy");
  assert.equal(tape.recent()[0].id, 1);
  const before = calls;
  assert.equal(await tape.resolvePending(), 0);
  assert.equal(calls, before, "nothing left to try, so nothing is asked");
});

test("a resolver that throws is the same as one that failed, and a transaction that is no order is not asked about again", async () => {
  let calls = 0;
  const tape = tapeAt({ resolveSide: async () => { calls++; throw new Error("boom"); } });
  tape.push([mk(qx(1, NOW, "CFB", 1, 1), "tx1")]);
  await tape.settled();
  assert.equal(tape.stats().lookupFailed, 1);

  const final = tapeAt({ resolveSide: async () => ({ unknown: "not-an-order" }) });
  final.push([mk(qx(1, NOW, "CFB", 1, 1), "tx2")]);
  await final.settled();
  assert.equal(final.stats().lookupFailed, 0);
  assert.equal(await final.resolvePending(), 0);
  assert.equal(final.stats().lookingUp, 0);
  assert.equal(calls, 1);
});

test("a side that arrives after its row was pushed out of the tape is simply dropped", async () => {
  const late = deferred<SideResult>();
  const tape = tapeAt({ capacity: 1, resolveSide: () => late.promise });
  tape.push([mk(qx(1, NOW, "CFB", 1, 1), "tx1")]);
  tape.push([fill(2)]);
  late.resolve({ side: "buy" });
  await tape.settled();
  assert.deepEqual(ticks(tape.recent()), [2]);
  assert.equal(tape.recent()[0].side, undefined);
});

/* ---------- the resolver ---------- */

function fakeRpc(handle: (hash: string, call: number) => unknown) {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const hashes: string[] = [];
  const rpc = {
    async post(path: string, body: { hash: string }) {
      assert.ok(path.endsWith("/query/v1/getTransactionByHash"), path);
      calls++;
      hashes.push(body.hash);
      active++;
      peak = Math.max(peak, active);
      try {
        return await handle(body.hash, calls);
      } finally {
        active--;
      }
    },
  };
  return { rpc: rpc as unknown as Pick<QubicRpc, "post">, hashes, get calls() { return calls; }, get peak() { return peak; } };
}
const fast = { retryDelayMs: 1, breakAfter: 1000 };

test("the resolver reads the side from the transaction, in the shape the live API gives and the shape its spec shows", async () => {
  const live = sideResolver(fakeRpc((h) => (h === realBid.hash ? realBid : realAsk)).rpc, fast);
  assert.deepEqual(await live(realBid.hash), { side: "buy" });
  assert.deepEqual(await live(realAsk.hash), { side: "sell" });
  const wrapped = sideResolver(fakeRpc((h) => ({ transaction: h === realBid.hash ? realBid : realAsk })).rpc, fast);
  assert.deepEqual(await wrapped(realBid.hash), { side: "buy" });
  assert.deepEqual(await wrapped(realAsk.hash), { side: "sell" });
});

test("the resolver asks the archive once per transaction, even when asked together or again later", async () => {
  const rpc = fakeRpc(async () => (await new Promise((r) => setTimeout(r, 5)), realBid));
  const lookup = sideResolver(rpc.rpc, fast);
  const together = await Promise.all([lookup("h1"), lookup("h1"), lookup("h1")]);
  assert.deepEqual(together.map((r) => r.side), ["buy", "buy", "buy"]);
  assert.equal(rpc.calls, 1, "shared while in flight");
  await lookup("h1");
  assert.equal(rpc.calls, 1, "remembered");
  assert.equal(lookup.stats().cached, 1);
});

test("the resolver runs only a few lookups at once and still finishes them all", async () => {
  const rpc = fakeRpc(async () => (await new Promise((r) => setTimeout(r, 8)), realBid));
  const lookup = sideResolver(rpc.rpc, { ...fast, concurrency: 2 });
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => lookup(`h${i}`)));
  assert.ok(results.every((r) => r.side === "buy"));
  assert.equal(rpc.calls, 9);
  assert.equal(rpc.peak, 2);
});

test("a failed lookup is retried, and one that keeps failing answers 'unavailable' without being remembered", async () => {
  const flaky = fakeRpc((_, call) => {
    if (call === 1) throw new Error("Qubic RPC unavailable: network down");
    return realAsk;
  });
  assert.deepEqual(await sideResolver(flaky.rpc, fast)("h1"), { side: "sell" });
  assert.equal(flaky.calls, 2);

  const down = fakeRpc(() => { throw new Error("Qubic RPC unavailable: network down"); });
  const lookup = sideResolver(down.rpc, { ...fast, retries: 2 });
  assert.deepEqual(await lookup("h1"), { unknown: "unavailable" });
  assert.equal(down.calls, 3, "the first try and two retries");
  await lookup("h1");
  assert.equal(down.calls, 6, "a failure is not cached: asking again tries again");
});

test("a slow lookup gives up after the timeout and frees its place for the next one", async () => {
  const rpc = fakeRpc((h) => (h === "slow" ? new Promise(() => {}) : realBid));
  const lookup = sideResolver(rpc.rpc, { ...fast, concurrency: 1, timeoutMs: 20, retries: 0 });
  const started = Date.now();
  const [a, b] = await Promise.all([lookup("slow"), lookup("quick")]);
  assert.deepEqual(a, { unknown: "unavailable" });
  assert.deepEqual(b, { side: "buy" }, "the single place was not held by the stuck lookup");
  assert.ok(Date.now() - started < 1000);
});

test("a transaction that is not a QX order is a final answer, and an answer with no transaction in it is a failure", async () => {
  const other = fakeRpc(() => ({ ...realBid, inputType: 8 }));
  const lookup = sideResolver(other.rpc, fast);
  assert.deepEqual(await lookup("h1"), { unknown: "not-an-order" });
  await lookup("h1");
  assert.equal(other.calls, 1, "remembered: it will never become an order");
  const empty = fakeRpc(() => ({}));
  assert.deepEqual(await sideResolver(empty.rpc, { ...fast, retries: 0 })("h1"), { unknown: "unavailable" });
});

test("the resolver leaves a failing archive alone for a while, but a plain refusal is not a failing archive", async () => {
  let t = 1_000_000;
  const refusing = fakeRpc(() => { throw new Error("RPC 404 for /query/v1/getTransactionByHash: not found"); });
  const polite = sideResolver(refusing.rpc, { ...fast, retries: 0, breakAfter: 2, now: () => t });
  for (const h of ["a", "b", "c", "d"]) assert.deepEqual(await polite(h), { unknown: "unavailable" });
  assert.equal(refusing.calls, 4, "an archive that answers 404 is up, so every lookup is still made");

  const down = fakeRpc(() => { throw new Error("Qubic RPC unavailable: fetch failed"); });
  const lookup = sideResolver(down.rpc, { ...fast, retries: 0, breakAfter: 2, cooldownMs: 30_000, now: () => t });
  await lookup("a");
  await lookup("b");
  assert.equal(down.calls, 2);
  assert.equal(lookup.stats().open, true);
  assert.deepEqual(await lookup("c"), { unknown: "unavailable" });
  assert.equal(down.calls, 2, "no request while it rests");
  t += 31_000;
  await lookup("c");
  assert.equal(down.calls, 3, "tried again once the pause is over");
  assert.equal(lookup.stats().open, true, "and it failed again, so it rests again");
});

test("the resolver and the tape together: a fill gets its side from the transaction", async () => {
  const rpc = fakeRpc((h) => (h === realBid.hash ? realBid : realAsk));
  const tape = new TradeTape({ symbolOf, resolveSide: sideResolver(rpc.rpc, fast) }, { now: () => NOW });
  tape.push([mk(qx(1, NOW, "CFB", 10, 5), realBid.hash), mk(qx(2, NOW, "CFB", 12, 5), realAsk.hash)]);
  await tape.settled();
  assert.deepEqual(tape.recent().map((r) => r.side), ["sell", "buy"]);
});

/* ---------- warmup ---------- */

/** The fake archive, plus the transaction lookup it does not offer. */
function withTransactions(rpc: QubicRpc & { calls: unknown[] }, txs: Record<string, unknown> = {}) {
  const inner = rpc as unknown as { get(p: string): Promise<unknown>; post(p: string, b: unknown): Promise<unknown> };
  const lookups: string[] = [];
  let active = 0;
  let peak = 0;
  const wrapped = {
    calls: rpc.calls,
    lookups,
    get peakArchiveCalls() { return peak; },
    get: (p: string) => inner.get(p),
    async post(p: string, b: { hash?: string }) {
      if (p.endsWith("/getTransactionByHash")) {
        lookups.push(b.hash!);
        if (!(b.hash! in txs)) throw new Error("RPC 404 for /query/v1/getTransactionByHash");
        return txs[b.hash!];
      }
      active++;
      peak = Math.max(peak, active);
      try {
        return await inner.post(p, b);
      } finally {
        active--;
      }
    },
  };
  return wrapped as unknown as QubicRpc & { calls: { ranges: { timestamp?: { gte: string; lte: string }; tickNumber?: { lte?: string } } }[]; lookups: string[]; peakArchiveCalls: number };
}
const at = (hoursAgo: number) => NOW - hoursAgo * HOUR;
const withHash = (e: EventLog, h: string): EventLog => ({ ...e, transactionHash: h });

test("warmup reads the last day in windows of both contracts, newest window first, never past the last finished tick", async () => {
  const events = [
    qx(900, at(1), "CFB", 10, 1),
    swap(6, 880, at(2), "CFB", 5000, 2000),
    qx(800, at(5), "CFB", 11, 1),
    qx(700, at(9), "QWIN", 12, 1),
    swap(8, 600, at(13), "QWIN", 10, 100),
    qx(300, at(23), "CFB", 13, 1),
    qx(100, at(30), "CFB", 14, 1), // older than a day: not asked for
  ];
  const rpc = withTransactions(archive(events, { lastTick: 1000 }));
  const tape = new TradeTape({ symbolOf }, { now: () => NOW });
  const r = await tape.warmup(rpc, 24, { windowMs: 4 * HOUR });
  assert.equal(r.windows, 6);
  assert.equal(r.windowsRead, 6);
  assert.equal(r.complete, true);
  assert.equal(r.error, undefined);
  assert.equal(r.tradesRead, 6);
  assert.equal(r.rowsAdded, 6);
  assert.deepEqual(ticks(tape.recent()), [10, 2.5, 11, 12, 10, 13], "newest first (the price is QU over units), and the 30-hour-old trade is not there");
  assert.equal(r.coveredFromMs, NOW - DAY);

  // two queries per window, QX then QSwap, contiguous time ranges from now back to 24 hours ago, all under the last tick
  assert.equal(rpc.calls.length, 12);
  const ranges = rpc.calls.filter((_, i) => i % 2 === 0).map((c) => c.ranges.timestamp!);
  assert.deepEqual(ranges.map((x) => Number(x.gte)), [4, 8, 12, 16, 20, 24].map(at));
  assert.equal(Number(ranges[0].lte), NOW + DAY, "the newest window may reach past now: a tick's clock can run ahead");
  for (let i = 1; i < ranges.length; i++) assert.equal(Number(ranges[i].lte), Number(ranges[i - 1].gte) - 1, "no gap and no overlap");
  assert.ok(rpc.calls.every((c) => c.ranges.tickNumber?.lte === "1000"));
  assert.equal(rpc.peakArchiveCalls, 1, "one request at a time");

  // so the whole day can be vouched for, and a longer window cannot
  assert.equal(tape.flow(undefined, NOW - DAY).partial, false);
  assert.equal(tape.flow(undefined, NOW - 30 * HOUR).partial, true);
});

test("warmup is safe to repeat and to overlap with trades announced live", async () => {
  const events = [qx(900, at(1), "CFB", 10, 1), swap(6, 880, at(2), "CFB", 5000, 2000)];
  const rpc = withTransactions(archive(events, { lastTick: 1000 }));
  const tape = new TradeTape({ symbolOf }, { now: () => NOW });
  await tape.warmup(rpc, 6);
  assert.equal(tape.size, 2);
  assert.equal(tape.push([mk(events[0])]), 0, "a live announcement of a trade the warmup already read");
  const again = await tape.warmup(rpc, 6);
  assert.equal(again.rowsAdded, 0);
  assert.equal(again.tradesRead, 2);
  assert.equal(tape.size, 2);
  assert.equal(tape.latestId, 2);
});

test("warmup that fails partway keeps the newest part and says how far back it can vouch for", async () => {
  const events = [qx(900, at(1), "CFB", 10, 1), qx(800, at(5), "CFB", 11, 1), qx(700, at(9), "CFB", 12, 1)];
  // calls 1 and 2 are window 1 (QX, QSwap), 3 and 4 window 2, 5 is window 3's QX query
  const rpc = withTransactions(archive(events, { lastTick: 1000, failOnCall: 5 }));
  const tape = new TradeTape({ symbolOf }, { now: () => NOW });
  const r = await tape.warmup(rpc, 24, { windowMs: 4 * HOUR });
  assert.equal(r.complete, false);
  assert.match(r.error!, /archive hiccup/);
  assert.equal(r.windowsRead, 2);
  assert.deepEqual(ticks(tape.recent()), [10, 11]);
  assert.equal(r.coveredFromMs, at(8));
  assert.equal(tape.flow(undefined, at(6)).partial, false);
  assert.equal(tape.flow(undefined, at(12)).partial, true, "the 9-hour-old trade was never read, and the flow says so");
});

test("warmup that fails to learn the last tick reads nothing and does not throw", async () => {
  const broken = { get: async () => { throw new Error("no archive"); }, post: async () => { throw new Error("unreachable"); } } as unknown as QubicRpc;
  const r = await new TradeTape({ symbolOf }, { now: () => NOW }).warmup(broken, 24);
  assert.equal(r.complete, false);
  assert.match(r.error!, /no archive/);
  assert.equal(r.windowsRead, 0);
});

test("warmup stops reading older windows when it runs out of time", async () => {
  let t = NOW;
  const events = [qx(900, at(1), "CFB", 10, 1), qx(700, at(9), "CFB", 12, 1), qx(500, at(17), "CFB", 14, 1)];
  const tape = new TradeTape({ symbolOf }, { now: () => (t += 60_000) }); // every look at the clock costs a minute
  const r = await tape.warmup(withTransactions(archive(events, { lastTick: 1000 })), 24, { windowMs: 4 * HOUR, scanBudgetMs: 100_000 });
  assert.equal(r.complete, false);
  assert.match(r.error!, /stopped after/);
  assert.equal(r.windowsRead, 1);
  assert.deepEqual(ticks(tape.recent()), [10]);
});

test("warmup looks up the sides of QX rows, once per transaction, and takes swap sides from the swaps", async () => {
  const events = [
    withHash(qx(900, at(1), "CFB", 10, 5), realBid.hash),
    withHash(qx(900, at(1), "CFB", 11, 5), realBid.hash), // a second fill of the same transaction
    withHash(qx(800, at(3), "CFB", 12, 5), realAsk.hash),
    withHash(swap(8, 700, at(4), "CFB", 100, 400), "swapTx"),
  ];
  const rpc = withTransactions(archive(events, { lastTick: 1000 }), { [realBid.hash]: realBid, [realAsk.hash]: realAsk });
  const tape = new TradeTape({ symbolOf, resolveSide: sideResolver(rpc, fast) }, { now: () => NOW });
  const r = await tape.warmup(rpc, 12);
  assert.deepEqual(rpc.lookups.sort(), [realAsk.hash, realBid.hash].sort(), "two transactions, three QX fills, and no lookup for the swap");
  assert.equal(r.sidesPending, 0);
  assert.deepEqual(tape.recent().map((x) => [x.venue, x.side]), [["QX", "buy"], ["QX", "buy"], ["QX", "sell"], ["QSwap", "sell"]]);
  const f = tape.flow(undefined, NOW - DAY);
  assert.equal(f.buy.trades, 2);
  assert.equal(f.sell.trades, 2);
});

test("warmup does not wait forever for sides: it returns on time and the rows stay without one", async () => {
  const events = [withHash(qx(900, at(1), "CFB", 10, 5), "stuck")];
  const tape = new TradeTape({ symbolOf, resolveSide: () => new Promise<SideResult>(() => {}) }, { now: () => NOW });
  const started = Date.now();
  const r = await tape.warmup(withTransactions(archive(events, { lastTick: 1000 })), 6, { resolveBudgetMs: 30 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(r.complete, true, "the reading itself finished");
  assert.equal(r.sidesPending, 1);
  assert.equal(tape.size, 1);
  assert.equal(tape.recent()[0].side, undefined);
});

test("warmup with failing lookups still fills the tape, and the sides can be filled in afterwards", async () => {
  const events = [withHash(qx(900, at(1), "CFB", 10, 5), realBid.hash)];
  const txs: Record<string, unknown> = {};
  const rpc = withTransactions(archive(events, { lastTick: 1000 }), txs);
  const tape = new TradeTape({ symbolOf, resolveSide: sideResolver(rpc, { ...fast, retries: 0 }) }, { now: () => NOW });
  const r = await tape.warmup(rpc, 6, { retryPauseMs: 5 });
  assert.equal(r.rowsAdded, 1);
  assert.equal(r.sidesPending, 1, "the archive could not give the transaction (404) so there is no side yet");
  txs[realBid.hash] = realBid; // it turns up in the archive's index later
  assert.equal(await tape.resolvePending(), 1);
  assert.equal(tape.recent()[0].side, "buy");
});

test("warmup tries failed lookups again after a pause, a limited number of times", async () => {
  const events = [withHash(qx(900, at(1), "CFB", 10, 5), "txA"), withHash(qx(800, at(2), "CFB", 11, 5), "txB")];
  let calls = 0;
  const flaky = new TradeTape({ symbolOf, resolveSide: async () => (++calls <= 2 ? { unknown: "unavailable" } : { side: "buy" }) }, { now: () => NOW });
  const r = await flaky.warmup(withTransactions(archive(events, { lastTick: 1000 })), 6, { retryPauseMs: 5 });
  assert.equal(r.sidesPending, 0, "the second try got through");
  assert.deepEqual(flaky.recent().map((x) => x.side), ["buy", "buy"]);
  assert.equal(calls, 4, "two lookups, then the same two again");

  let asked = 0;
  const hopeless = new TradeTape({ symbolOf, resolveSide: async () => (asked++, { unknown: "unavailable" }) }, { now: () => NOW });
  const h = await hopeless.warmup(withTransactions(archive(events.slice(0, 1), { lastTick: 1000 })), 6, { retryPauseMs: 5, retryPasses: 2 });
  assert.equal(h.sidesPending, 1);
  assert.equal(asked, 3, "the first try and two more, and then it stops");
  assert.equal(h.complete, true);
});

test("warmup does not retry past its time budget", async () => {
  const events = [withHash(qx(900, at(1), "CFB", 10, 5), "txA")];
  let asked = 0;
  const tape = new TradeTape({ symbolOf, resolveSide: async () => (asked++, { unknown: "unavailable" }) }, { now: () => NOW });
  const started = Date.now();
  const r = await tape.warmup(withTransactions(archive(events, { lastTick: 1000 })), 6, { retryPauseMs: 10_000, resolveBudgetMs: 50 });
  assert.ok(Date.now() - started < 1000, "it did not sleep through a 10 second pause that would end after the budget");
  assert.equal(asked, 1);
  assert.equal(r.sidesPending, 1);
});

test("warmup asks for no more than a week", async () => {
  const rpc = withTransactions(archive([], { lastTick: 1000 }));
  const r = await new TradeTape({ symbolOf }, { now: () => NOW }).warmup(rpc, 1000, { windowMs: 24 * HOUR });
  assert.equal(r.hours, 168);
  assert.equal(r.windows, 7);
});

/* ---------- connecting to the catalog ---------- */

test("the catalog's symbol lookup is built once, and reread on expiry or when a key it does not know turns up", () => {
  let t = 0;
  let reads = 0;
  let entries = [{ id: "CFB", symbol: "CFB", issuer: "I1" }];
  const of = catalogSymbolOf(() => (reads++, entries), { keyOf: (s, i) => `${s}|${i}`, ttlMs: 60_000, missMs: 5_000, now: () => t });
  assert.equal(of("CFB|I1"), "CFB");
  assert.equal(of("CFB|I1"), "CFB");
  assert.equal(reads, 1);
  entries = [...entries, { id: "NEW", symbol: "NEW", issuer: "I2" }];
  t = 1_000;
  assert.equal(of("NEW|I2"), undefined, "asked again too soon after the last read");
  assert.equal(reads, 1);
  t = 6_000;
  assert.equal(of("NEW|I2"), "NEW");
  assert.equal(reads, 2);
  t = 70_000;
  assert.equal(of("CFB|I1"), "CFB");
  assert.equal(reads, 3, "expired");
});

test("an asset whose name cannot be turned into a key is skipped, not fatal", () => {
  const of = catalogSymbolOf(() => [{ id: "BAD", symbol: "BAD", issuer: "x" }, { id: "OK", symbol: "OK", issuer: "y" }], { keyOf: (s) => { if (s === "BAD") throw new Error("no"); return s; } });
  assert.equal(of("OK"), "OK");
});

/* ---------- the web view's helpers ---------- */

const row = (id: number, t: number, extra: Partial<TapeRow> = {}): TapeRow => ({ id, t, venue: "QSwap", asset: "CFB", assetKey: "k", qty: 1, qu: 1, price: 1, side: "buy", ...extra });

test("new rows are merged in by id, newest first, and a refetched row replaces its old copy", () => {
  const shown = [row(3, 300), row(2, 200, { venue: "QX", side: undefined, txHash: "t" }), row(1, 100)];
  const merged = mergeTape(shown, [row(4, 400), row(2, 200, { venue: "QX", side: "sell", txHash: "t" })], 10);
  assert.deepEqual(merged.map((r) => r.id), [4, 3, 2, 1]);
  assert.equal(merged.find((r) => r.id === 2)!.side, "sell", "the late side shows");
  assert.deepEqual(mergeTape(shown, [row(9, 50)], 10).map((r) => r.id), [3, 2, 1, 9], "an older row that arrived later goes in its place by time");
  assert.deepEqual(mergeTape(shown, [row(4, 400)], 2).map((r) => r.id), [4, 3], "trimmed to the limit");
  assert.deepEqual(mergeTape([], [], 5), []);
});

test("the poll cursor is the newest id, unless a young QX row is still waiting for its side", () => {
  const now = 1_000_000;
  assert.equal(pollCursor([row(5, now - 1000)], 5, now), 5);
  const waiting = row(4, now - 10_000, { venue: "QX", side: undefined, txHash: "t" });
  assert.equal(pollCursor([row(5, now - 1000), waiting], 5, now), 3, "ask from just before the row that has no side");
  assert.equal(pollCursor([row(5, now - 1000), { ...waiting, side: "buy" }], 5, now), 5);
  assert.equal(pollCursor([row(5, now - 1000), { ...waiting, t: now - 10 * 60_000 }], 5, now), 5, "an old row without a side is given up on");
  assert.equal(pollCursor([{ ...waiting, txHash: undefined }], 5, now), 5, "without a transaction there is nothing to look up");
  assert.equal(pollCursor([row(1, now - 1000, { venue: "QX", side: undefined, txHash: "t" })], 1, now), 0);
  assert.equal(pollCursor([], 0, now), 0);
});

test("big QU amounts are shortened for the strip", () => {
  assert.equal(compactQu(186_900_922), "186.9M");
  assert.equal(compactQu(2_500), "2.5K");
  assert.equal(compactQu(840), "840");
  assert.equal(compactQu(1_100_000_000), "1.1B");
});

test("ages read as people say them", () => {
  assert.equal(agoLabel(-3000), "just now");
  assert.equal(agoLabel(4_999), "just now");
  assert.equal(agoLabel(5_000), "5 s ago");
  assert.equal(agoLabel(59_999), "59 s ago");
  assert.equal(agoLabel(60_000), "1 min ago");
  assert.equal(agoLabel(59 * 60_000 + 59_000), "59 min ago");
  assert.equal(agoLabel(HOUR), "1 h ago");
  assert.equal(agoLabel(23.9 * HOUR), "23 h ago");
  assert.equal(agoLabel(2 * DAY), "2 d ago");
  assert.equal(agoLabel(NaN), "just now");
});

test("the short age, for a narrow Time column, is the same without the word ago", () => {
  assert.equal(agoShort(2_000), "now");
  assert.equal(agoShort(12_000), "12 s");
  assert.equal(agoShort(4 * 60_000), "4 min");
  assert.equal(agoShort(HOUR), "1 h");
  assert.equal(agoShort(3 * DAY), "3 d");
});

/* ---------- the API ---------- */

function routesFor(tape: TradeTape, ids = ["CFB", "QWIN"]) {
  const [tapeRoute, flowRoute] = tapeRoutes({ tape, knownAsset: (id) => ids.some((x) => x.toUpperCase() === id.toUpperCase()), now: () => NOW });
  const call = (route: typeof tapeRoute, query: string) => route.handler({ query: new URLSearchParams(query), body: undefined }) as Promise<any> | any;
  return { tapeRoute, flowRoute, tape: (q = "") => call(tapeRoute, q), flow: (q = "") => call(flowRoute, q) };
}
const refuses = (fn: () => unknown, status: number, text: RegExp) =>
  assert.throws(fn, (e) => e instanceof RouteError && e.status === status && text.test(e.message));

function busyTape() {
  const tape = tapeAt();
  for (let i = 1; i <= 60; i++) tape.push([mk(swap(i % 3 ? 6 : 8, i, NOW - (61 - i) * 60_000, i % 2 ? "CFB" : "QWIN", 1000 + i, 100))]);
  return tape;
}

test("the tape endpoint gives the newest 50 by default, with the latest id and the 24 hour flow", () => {
  const r = routesFor(busyTape()).tape();
  assert.equal(r.trades.length, 50);
  assert.equal(r.latestId, 60);
  assert.ok(r.instance.length >= 6, "a token that is different for every tape");
  assert.equal(routesFor(busyTape()).tape().instance === r.instance, false, "another tape, another instance");
  assert.equal(r.trades[0].id, 60);
  assert.equal(r.trades[49].id, 11);
  assert.equal(r.flow24h.trades, 60);
  assert.equal(r.flow24h.buy.trades + r.flow24h.sell.trades, 60);
  assert.equal(r.flow24h.partial, true, "this tape started at NOW, so it cannot vouch for the day before");
});

test("limit must be a whole number from 1 to 200", () => {
  const { tape } = routesFor(busyTape());
  assert.equal(tape("limit=1").trades.length, 1);
  assert.equal(tape("limit=200").trades.length, 60);
  assert.equal(tape("limit=").trades.length, 50, "empty means the default");
  for (const bad of ["0", "201", "-1", "1.5", "ten", "1e2x"]) refuses(() => tape(`limit=${bad}`), 400, /limit must be a whole number from 1 to 200/);
});

test("since returns only newer rows, and must be a whole number", () => {
  const { tape } = routesFor(busyTape());
  assert.deepEqual(tape("since=57").trades.map((r: TapeRow) => r.id), [60, 59, 58]);
  assert.equal(tape("since=60").trades.length, 0);
  assert.equal(tape("since=60").latestId, 60, "the cursor is still there to poll with");
  assert.equal(tape("since=0&limit=5").trades.length, 5);
  assert.equal(tape("since=9999").trades.length, 0);
  for (const bad of ["-1", "1.5", "abc"]) refuses(() => tape(`since=${bad}`), 400, /since must be a whole number/);
});

test("the tape can be narrowed to an asset, and a venue, and an unknown asset is a 404", () => {
  const { tape } = routesFor(busyTape());
  const cfb = tape("asset=cfb&limit=200");
  assert.equal(cfb.trades.length, 30);
  assert.ok(cfb.trades.every((r: TapeRow) => r.asset === "CFB"));
  assert.equal(cfb.flow24h.trades, 30, "the flow is for the same asset");
  assert.equal(cfb.latestId, 60, "the cursor is the whole tape's");
  assert.equal(tape("venue=qx").trades.length, 0, "case does not matter");
  assert.equal(tape("venue=QSwap&limit=200").trades.length, 60);
  assert.equal(tape("venue=QSwap").flow24h.trades, 60);
  refuses(() => tape("venue=nasdaq"), 400, /venue must be one of QX, QSwap/);
  refuses(() => tape("asset=NOPE"), 404, /Unknown asset 'NOPE'/);
  assert.equal(tape("asset=").trades.length, 50, "an empty asset means all");
});

test("the tape of an asset that is known but has not traded is empty, not an error", () => {
  const { tape } = routesFor(tapeAt(), ["CFB"]);
  const r = tape("asset=CFB");
  assert.deepEqual(r.trades, []);
  assert.equal(r.latestId, 0);
  assert.equal(r.flow24h.pressure, null);
});

test("the flow endpoint reports one hour or 24 hours, for all assets or one", () => {
  const { flow } = routesFor(busyTape());
  const day = flow();
  assert.equal(day.window, "24h");
  assert.equal(day.asset, null);
  assert.equal(day.venue, null);
  assert.equal(day.trades, 60);
  assert.equal(day.sinceMs, NOW - DAY);
  const hour = flow("window=1h");
  assert.equal(hour.window, "1h");
  assert.equal(hour.sinceMs, NOW - HOUR);
  assert.equal(hour.trades, 60, "all 60 trades are within the last hour");
  const one = flow("asset=QWIN&window=24h");
  assert.equal(one.asset, "QWIN");
  assert.equal(one.trades, 30);
  assert.equal(flow("venue=QX").trades, 0);
  refuses(() => flow("window=7d"), 400, /window must be one of 1h, 24h/);
  refuses(() => flow("asset=NOPE"), 404, /Unknown asset/);
});

test("the flow of a window is cut at its start", () => {
  const tape = tapeAt();
  tape.push([mk(swap(6, 1, NOW - 2 * HOUR, "CFB", 1000, 10)), mk(swap(8, 2, NOW - 30 * 60_000, "CFB", 10, 400))]);
  const { flow } = routesFor(tape);
  assert.equal(flow("window=1h").trades, 1);
  assert.equal(flow("window=1h").pressure, -1);
  assert.equal(flow("window=24h").trades, 2);
  assert.equal(flow("window=24h").pressure, (1000 - 400) / 1400);
});

test("both endpoints are described and exempt from the rate limit, as they are served from memory", () => {
  const { tapeRoute, flowRoute } = routesFor(tapeAt());
  for (const r of [tapeRoute, flowRoute]) {
    assert.equal(r.method, "GET");
    assert.equal(r.limited, false);
    assert.ok(r.doc.summary.length > 10);
    assert.ok(r.doc.parameters!.length >= 3);
  }
  assert.equal(tapeRoute.path, "/v1/tape");
  assert.equal(flowRoute.path, "/v1/flow");
});

const data: MarketData = { assets: () => [], venues: async () => null };
const liveTape = busyTape();
const server = createApi({ data, routes: tapeRoutes({ tape: liveTape, knownAsset: (id) => id.toUpperCase() === "CFB" || id.toUpperCase() === "QWIN" }), freePerMin: 2 });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("over HTTP: the endpoints are served, validated, described in the OpenAPI document, and not counted against the free allowance", async () => {
  // freePerMin is 2 here: more calls than that only succeed if the routes are exempt
  let last = 0;
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${base}/v1/tape?limit=3`);
    assert.equal(res.status, 200);
    const j = (await res.json()) as { trades: TapeRow[]; latestId: number };
    assert.equal(j.trades.length, 3);
    last = j.latestId;
  }
  assert.equal(last, 60);
  const polled = (await (await fetch(`${base}/v1/tape?since=${last}`)).json()) as { trades: TapeRow[] };
  assert.equal(polled.trades.length, 0);
  liveTape.push([mk(swap(6, 100, NOW, "CFB", 7000, 100))]);
  const next = (await (await fetch(`${base}/v1/tape?since=${last}`)).json()) as { trades: TapeRow[]; latestId: number };
  assert.deepEqual(next.trades.map((r) => r.id), [61]);
  assert.equal(next.latestId, 61);
  assert.equal((await fetch(`${base}/v1/tape?asset=NOPE`)).status, 404);
  assert.equal((await fetch(`${base}/v1/tape?limit=0`)).status, 400);
  const flow = (await (await fetch(`${base}/v1/flow?window=1h`)).json()) as { window: string; trades: number };
  assert.equal(flow.window, "1h");
  const spec = (await (await fetch(`${base}/v1/openapi.json`)).json()) as { paths: Record<string, { get?: { summary: string } }> };
  assert.ok(spec.paths["/v1/tape"].get!.summary);
  assert.ok(spec.paths["/v1/flow"].get!.summary);
});
