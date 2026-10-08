import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTrade, scanTrades } from "../src/events.ts";
import type { EventLog } from "../src/events.ts";
import { TradeIndex } from "../src/trades.ts";
import { HistoryStore, HOUR, DAY } from "../src/history.ts";
import type { Sample } from "../src/history.ts";

import { NOW, archive, ev, issuer, key, qx, swap } from "./trade-helpers.ts";

/* ---------- decoding ---------- */

test("decodes real QX trade messages captured from the archive", () => {
  const real = (rawPayload: string): EventLog => ({ epoch: 233, tickNumber: 83086142, timestamp: "1791147112000", logType: 6, logId: "6022501", rawPayload, smartContractMessage: { contractIndex: "1", contractMessageType: "0" } });
  const a = decodeTrade(real("nUK6b51yrX1XVLeAs3RUCDWjHF2BzL5Ky7+cDsP4UTRCSVRFAAAAABQAAAAAAAAAKLMAAAAAAAA="))!;
  assert.equal(a.venue, "QX");
  assert.equal(a.price, 20);
  assert.equal(a.qty, 45_864);
  assert.equal(a.qu, 917_280);
  assert.equal(a.t, 1791147112000);
  const b = decodeTrade(real("BrDwcDzmfU+0yq8Ni4TEEumR61o2TI/+i07nqpaWpTJRVFJFQVQAAABaYgIAAAAAAQAAAAAAAAA="))!;
  assert.deepEqual([b.price, b.qty, b.qu], [40_000_000, 1, 40_000_000]);
});

test("a QSwap swap's price is QU over units, whichever way it went", () => {
  // QU in, asset out
  assert.equal(decodeTrade(swap(6, 1, 1000, "CFB", 5000, 2000))!.price, 2.5);
  assert.equal(decodeTrade(swap(7, 1, 1000, "CFB", 5000, 2000))!.price, 2.5);
  // asset in, QU out
  const sold = decodeTrade(swap(8, 1, 1000, "CFB", 2000, 5000))!;
  assert.deepEqual([sold.price, sold.qty, sold.qu, sold.venue], [2.5, 2000, 5000, "QSwap"]);
  assert.equal(decodeTrade(swap(9, 1, 1000, "CFB", 2000, 5000))!.price, 2.5);
});

test("a trade carries its transaction, and a swap says which way it went", () => {
  const withTx = (e: EventLog): EventLog => ({ ...e, transactionHash: "abc" });
  assert.equal(decodeTrade(withTx(swap(6, 1, 1000, "CFB", 5, 2)))!.txHash, "abc");
  assert.equal(decodeTrade(withTx(swap(7, 1, 1000, "CFB", 5, 2)))!.side, "buy");
  assert.equal(decodeTrade(withTx(swap(8, 1, 1000, "CFB", 2, 5)))!.side, "sell");
  assert.equal(decodeTrade(withTx(swap(9, 1, 1000, "CFB", 2, 5)))!.side, "sell");
  assert.equal(decodeTrade(withTx(qx(1, 1000, "CFB", 5, 5)))!.side, undefined, "a QX fill is logged the same for both sides");
  assert.equal(decodeTrade(qx(1, 1000, "CFB", 5, 5))!.txHash, undefined);
});

test("events that are not trades are ignored", () => {
  assert.equal(decodeTrade(swap(4, 1, 1000, "CFB", 5, 5)), null, "add liquidity");
  assert.equal(decodeTrade(swap(5, 1, 1000, "CFB", 5, 5)), null, "remove liquidity");
  assert.equal(decodeTrade(ev(1, 0, 1, 1000, "CFB", 5, 5, 0)), null, "a QU transfer, not a contract message");
  assert.equal(decodeTrade(ev(5, 0, 1, 1000, "CFB", 5, 5)), null, "another contract");
  assert.equal(decodeTrade(qx(1, 1000, "CFB", 5, 0)), null, "no units");
  assert.equal(decodeTrade(swap(6, 1, 1000, "CFB", 0, 5)), null, "no QU");
  assert.equal(decodeTrade({ ...qx(1, 1000, "CFB", 5, 5), rawPayload: "AAAA" }), null, "too short to hold a trade");
  assert.equal(decodeTrade({ ...qx(1, 1000, "CFB", 5, 5), rawPayload: undefined }), null, "no payload");
});

/* ---------- reading ---------- */

test("reads every page of a long span", async () => {
  const events = Array.from({ length: 2500 }, (_, i) => qx(1000 + i, NOW - i * 1000, "CFB", 10, 1));
  const rpc = archive(events);
  const got: number[] = [];
  await scanTrades(rpc, 1, { fromTick: 1000, toTick: 5000 }, (t) => got.push(...t.map((x) => x.tick)));
  assert.equal(got.length, 2500);
  assert.equal(new Set(got).size, 2500);
  assert.equal(rpc.calls.length, 3, "three pages of at most 1000");
});

test("a span that would pass the 10,000 cap is halved, so nothing is cut off or counted twice", async () => {
  const events = Array.from({ length: 10_500 }, (_, i) => qx(1000 + i, NOW - 10_500_000 + i * 1000, "CFB", 10, 1));
  const rpc = archive(events);
  const ids = new Set<string>();
  let total = 0;
  await scanTrades(rpc, 1, { fromMs: NOW - 11_000_000, toMs: NOW, toTick: 99_999 }, (t) => t.forEach((x) => (ids.add(x.logId), total++)));
  assert.equal(total, 10_500);
  assert.equal(ids.size, 10_500);
});

test("a single tick works even though the API refuses a range with equal ends", async () => {
  const events = [qx(99, NOW, "CFB", 10, 1), qx(100, NOW, "CFB", 11, 2), qx(100, NOW, "CFB", 12, 3), qx(101, NOW, "CFB", 13, 4)];
  const got: number[] = [];
  await scanTrades(archive(events), 1, { fromTick: 100, toTick: 100 }, (t) => got.push(...t.map((x) => x.price)));
  assert.deepEqual(got.sort(), [11, 12], "tick 99, read only because the range was widened, is dropped again");
});

/* ---------- the index ---------- */

test("sums trades into hours with a volume-weighted price and open, high, low, close", async () => {
  const h = Math.floor(NOW / HOUR) * HOUR - 5 * HOUR;
  const events = [
    qx(100, h + 1_000, "CFB", 10, 100), // open
    qx(101, h + 2_000, "CFB", 14, 100), // high
    qx(102, h + 3_000, "CFB", 8, 100), // low
    qx(103, h + 4_000, "CFB", 12, 700), // close, big
    qx(104, h + HOUR + 1_000, "CFB", 20, 10),
  ];
  const idx = new TradeIndex(archive(events, { lastTick: 200 }), { days: 30 });
  await idx.update(NOW);
  const hours = idx.hours(key("CFB"), "QX");
  assert.equal(hours.length, 2);
  const [first, second] = hours;
  assert.deepEqual([first.n, first.qty, first.qu], [4, 1000, 1000 + 1400 + 800 + 8400]);
  assert.deepEqual([first.open, first.high, first.low, first.close], [10, 14, 8, 12]);
  assert.equal(second.hour, h + HOUR);
  const samples = idx.samples(key("CFB"), "QX");
  assert.equal(samples.length, 2);
  assert.equal(samples[0].price, 11_600 / 1000, "volume-weighted, so the big trade counts most");
  assert.equal(samples[0].src, "trades");
  assert.equal(samples[0].t, h + 4_000, "stamped with the last trade of the hour");
});

test("the newest trade's price and time, on whichever market traded last", async () => {
  const h = NOW - 3 * HOUR;
  const idx = new TradeIndex(archive([qx(100, h, "CFB", 10, 10), qx(101, h + 5_000, "CFB", 12, 10), swap(6, 102, h + HOUR, "CFB", 150, 10), qx(103, h + 5_000, "ONLYQX", 7, 10)], { lastTick: 200 }), { days: 30 });
  await idx.update(NOW);
  assert.equal(idx.last(key("CFB"))?.price, 15, "the QSwap swap is the newest");
  assert.equal(idx.last(key("ONLYQX"))?.price, 7);
  assert.ok((idx.last(key("CFB"))?.ms ?? 0) > h + HOUR - 1, "and says when it was");
  assert.equal(idx.last(key("NOPE")), null);
  // asked for one market only, it answers for that market: QX's own newest trade, however much newer the QSwap swap is
  assert.deepEqual([idx.last(key("CFB"))?.price, idx.last(key("CFB"))?.venue], [15, "QSwap"], "and says which market it was on");
  assert.equal(idx.last(key("CFB"), "QX")?.price, 12, "QX's newest trade, not the QSwap swap");
  assert.equal(idx.last(key("CFB"), "QSwap")?.price, 15);
  assert.equal(idx.last(key("ONLYQX"), "QSwap"), null, "no swap on record");
  assert.equal(idx.last(key("NOPE"), "QX"), null);
});

test("an asset is drawn from the venue asked for, or the other one if it never traded there", async () => {
  const h = NOW - 3 * HOUR;
  const idx = new TradeIndex(archive([qx(100, h, "CFB", 10, 10), swap(6, 101, h, "CFB", 300, 10), qx(102, h, "ONLYQX", 5, 10)], { lastTick: 200 }), { days: 30 });
  await idx.update(NOW);
  assert.equal(idx.samples(key("CFB"), "QSwap")[0].price, 30);
  assert.equal(idx.samples(key("CFB"), "QX")[0].price, 10);
  assert.equal(idx.samples(key("ONLYQX"), "QSwap")[0].price, 5, "falls back to QX");
  assert.deepEqual(idx.samples(key("NOPE"), "QX"), []);
});

test("new ticks are announced as they are read, but the backward scan is not", async () => {
  const told: number[] = [];
  const events = [qx(100, NOW - 2 * DAY, "CFB", 10, 5), qx(150, NOW - HOUR, "CFB", 12, 5)];
  const idx = new TradeIndex(archive(events, { lastTick: 200 }), { days: 30, onTrades: (t) => told.push(t.length) });
  await idx.update(NOW);
  assert.equal(told.length, 0, "the first run is all backward scan");
  events.push(qx(260, NOW + 60_000, "CFB", 15, 5), qx(261, NOW + 61_000, "CFB", 16, 5));
  const later = new TradeIndex(archive(events, { lastTick: 300 }), { days: 30, onTrades: (t) => told.push(t.length) });
  await later.update(NOW);
  assert.equal(told.length, 0, "a fresh index starts with its own backward scan");
  (later as unknown as { rpc: unknown }).rpc = archive(events, { lastTick: 400 });
  events.push(qx(350, NOW + 120_000, "CFB", 17, 5));
  await later.update(NOW + 130_000);
  assert.deepEqual(told, [1]);
});

test("later runs read only new ticks, and a restart picks up where it stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qmax-trades-"));
  try {
    const file = join(dir, "trades.json");
    const events = [qx(100, NOW - 2 * DAY, "CFB", 10, 5), qx(150, NOW - HOUR, "CFB", 12, 5)];
    const first = new TradeIndex(archive(events, { lastTick: 200 }), { file, days: 30 });
    await first.update(NOW);
    assert.equal(first.stats().trades, 2);

    // a new trade arrives after tick 200
    events.push(qx(260, NOW + 60_000, "CFB", 15, 5));
    const rpc = archive(events, { lastTick: 300 });
    const restarted = new TradeIndex(rpc, { file, days: 30 });
    assert.equal(restarted.stats().trades, 2, "loaded from disk");
    await restarted.update(NOW + 120_000);
    assert.equal(restarted.stats().trades, 3);
    const asked = (rpc.calls as { ranges?: { tickNumber?: { gte?: string } } }[]).map((c) => c.ranges?.tickNumber?.gte);
    assert.ok(asked.every((g) => g === "201"), `only ticks after 200 were read, got ${asked}`);

    // asking again with nothing new changes nothing
    await restarted.update(NOW + 180_000);
    assert.equal(restarted.stats().trades, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run that fails halfway can be repeated without counting anything twice", async () => {
  const events = [qx(100, NOW - 2 * DAY, "CFB", 10, 5), swap(6, 101, NOW - 2 * DAY, "CFB", 100, 10), qx(102, NOW - DAY, "CFB", 11, 5)];
  // calls: 1 = QX first window, 2 = QSwap first window (fails)
  const rpc = archive(events, { lastTick: 200, failOnCall: 2 });
  const idx = new TradeIndex(rpc, { days: 20 });
  await assert.rejects(idx.update(NOW), /archive hiccup/);
  assert.equal(idx.stats().trades, 0, "nothing from the unfinished window was kept");
  await idx.update(NOW);
  assert.equal(idx.stats().trades, 3);
  assert.equal(idx.complete, true);
});

test("the backward scan stops at the configured number of days", async () => {
  const events = [qx(100, NOW - 40 * DAY, "OLD", 10, 5), qx(101, NOW - 2 * DAY, "NEW", 10, 5)];
  const idx = new TradeIndex(archive(events, { lastTick: 200 }), { days: 30 });
  await idx.update(NOW);
  assert.equal(idx.samples(key("OLD"), "QX").length, 0);
  assert.equal(idx.samples(key("NEW"), "QX").length, 1);
});

/* ---------- merging into the history ---------- */

const derived = (t: number, price: number): Sample => ({ t, price, bid: null, ask: null, pool: null, liq: 0, src: "trades" });
const live = (t: number, price: number): Sample => ({ t, price, bid: price - 1, ask: price + 1, pool: price, liq: 100 });

test("rebuilt points fill only the gaps and never replace what QMax recorded", () => {
  const now = NOW;
  const store = new HistoryStore();
  store.record("CFB", live(now - 2 * HOUR, 10), now);
  store.record("CFB", live(now - HOUR, 11), now);
  const added = store.backfill("CFB", [derived(now - 5 * HOUR, 9), derived(now - 4 * HOUR + 5, 9.5), derived(now - 2 * HOUR + 60_000, 99), derived(now - HOUR + 60_000, 99)], now);
  assert.equal(added, 2, "the two hours that already had a recorded sample were left alone");
  const series = store.series("CFB", null, now);
  assert.deepEqual(series.map((s) => s.price), [9, 9.5, 10, 11], "in time order, recorded values intact");
  assert.equal(store.recordedSince("CFB"), now - 2 * HOUR);
  assert.equal(store.since("CFB"), now - 5 * HOUR);
});

test("backfilling again changes nothing, and recording carries on afterwards", () => {
  const now = NOW;
  const store = new HistoryStore();
  const points = [derived(now - 30 * DAY, 5), derived(now - 100 * DAY, 4), derived(now - 100 * DAY + HOUR, 4.1)];
  assert.equal(store.backfill("CFB", points, now), 2, "the oldest two share a day, as thinned data would");
  assert.equal(store.backfill("CFB", points, now), 0);
  store.record("CFB", live(now, 7), now);
  assert.equal(store.series("CFB", null, now).length, 3);
  assert.equal(store.recordedSince("CFB"), now);
});

test("rebuilt points survive saving and loading, and stay marked as rebuilt", () => {
  const dir = mkdtempSync(join(tmpdir(), "qmax-history-"));
  try {
    const file = join(dir, "history.json");
    const now = Date.now();
    const a = new HistoryStore(file);
    a.backfill("CFB", [derived(now - 10 * DAY, 3)], now);
    a.record("CFB", live(now, 4), now);
    a.flush();
    const b = new HistoryStore(file);
    const pts = b.series("CFB", null, now);
    assert.equal(pts.length, 2);
    assert.equal(pts[0].src, "trades");
    assert.equal(pts[1].src, undefined);
    assert.equal(b.recordedSince("CFB"), now);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file of hours from the first version is put aside, and everything is read again as minutes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qmax-trades-v1-"));
  try {
    const file = join(dir, "trades.json");
    writeFileSync(file, JSON.stringify({ state: { v: 1, highTick: 150, ceilTick: 150, lowMs: NOW - 30 * DAY }, assets: { [key("CFB")]: { QX: [[NOW - HOUR, 100, 10, 1, 10, 10, NOW - HOUR, 10, 10, 1, 1, 1, 1]], QSwap: [] } } }));
    const events = [qx(100, NOW - 2 * DAY, "CFB", 10, 5), qx(150, NOW - HOUR, "CFB", 12, 5)];
    const idx = new TradeIndex(archive(events, { lastTick: 200 }), { file, days: 30 });
    assert.equal(idx.stats().trades, 0, "hours cannot be split into minutes, so they are not used");
    assert.ok(existsSync(`${file}.v1.bak`), "but the old file is kept, not thrown away");
    await idx.update(NOW);
    assert.equal(idx.stats().trades, 2, "read again from the archive");
    assert.equal(idx.stats().slots, 2);
    // A restart now loads the new file (minutes), keeping the counts.
    const again = new TradeIndex(archive(events, { lastTick: 200 }), { file, days: 30 });
    assert.deepEqual([again.stats().trades, again.stats().slots], [2, 2]);
    assert.equal(again.candles(key("CFB"), "QX", 60_000).length, 2);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).state.v, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
