import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportedHistory, QUHUB_API, cleanDaily, cleanTrades, dailyCandles, olderCandles, readQuhub, saveSnapshot } from "../src/quhub.ts";
import type { DailyPoint, QuhubTrade, Snapshot } from "../src/quhub.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const ISSUER = "QMINEQQXYBEGBHNSUPOUYDIQKZPCBPQIIHUUZMCPLBPCCAIARVZBTYKGFCWM";
const hash = (n: number) => String.fromCharCode(97 + (n % 26)).repeat(60);

const day = (d: string, o: Partial<DailyPoint> = {}): DailyPoint => ({ time: `${d}T00:00:00Z`, min: 100, max: 120, totalShares: 1000, totalAmount: 110_000, averagePrice: 110, totalTrades: 4, ...o });
const trade = (iso: string, price: number, shares: number, n = 0, o: Partial<QuhubTrade> = {}): QuhubTrade => ({ tickTime: iso, transactionHash: hash(n), price, numberOfShares: shares, bid: true, ...o });

/* ---------- what comes off the network is checked ---------- */

test("daily points: only well-formed days, one per day, oldest first", () => {
  const raw = [
    day("2025-03-02"),
    day("2025-03-01"),
    day("2025-03-01", { min: 90 }), // the same day twice: one is kept
    { ...day("2025-03-03"), min: 130 }, // lowest above highest
    { ...day("2025-03-04"), averagePrice: 500 }, // average outside its own range
    { ...day("2025-03-05"), totalTrades: 0 },
    { ...day("2025-03-06"), totalShares: 1.5 },
    { ...day("2025-03-07"), min: -1 },
    { ...day("2025-03-08"), totalAmount: "abc" },
    { ...day("2025-03-09"), time: "2025-03-09T13:00:00Z" }, // not a day boundary
    { ...day("2023-01-01") }, // before QX had anything
    day("2026-12-31"), // in the future
    null,
    "junk",
    { time: 5 },
  ];
  const out = cleanDaily(raw, NOW);
  assert.deepEqual(out.map((d) => d.time.slice(0, 10)), ["2025-03-01", "2025-03-02"]);
  assert.equal(out[0].min, 90, "the later of two copies of a day wins");
  assert.deepEqual(cleanDaily("nope"), []);
  assert.equal(cleanDaily(Array.from({ length: 9000 }, () => day("2025-03-01"))).length, 1);
});

test("trades: real transactions only, oldest first, and two identical fills of one transaction are two trades", () => {
  const out = cleanTrades(
    [
      trade("2025-05-02T10:00:00Z", 12, 5, 2),
      trade("2025-05-01T10:00:00Z", 10, 3, 1),
      trade("2025-05-01T10:00:00Z", 10, 3, 1), // the same transaction filling a second order of the same size at the same price: a second trade
      trade("2025-05-01T10:00:00Z", 11, 3, 1), // and a third, at another price
      trade("2025-05-03T10:00:00Z", 12, 5, 3, { transactionHash: "../../etc/passwd" }),
      trade("2025-05-03T10:00:00Z", 12, 5, 4, { transactionHash: "A".repeat(60) }), // capitals are not a transaction id
      trade("2025-05-04T10:00:00Z", 0, 5, 5),
      trade("2025-05-04T10:00:00Z", 12, 0, 6),
      trade("2025-05-04T10:00:00Z", 12, 2.5, 7),
      trade("not a time", 12, 5, 8),
      trade("2020-01-01T00:00:00Z", 12, 5, 9),
      { ...trade("2025-05-04T10:00:00Z", 12, 5, 10), price: "1e999" },
      null,
    ] as unknown[],
    NOW,
  );
  assert.deepEqual(out.map((t) => [t.tickTime, t.price, t.numberOfShares]), [["2025-05-01T10:00:00Z", 10, 3], ["2025-05-01T10:00:00Z", 10, 3], ["2025-05-01T10:00:00Z", 11, 3], ["2025-05-02T10:00:00Z", 12, 5]]);
  assert.ok(out.every((t) => !("ms" in t)));
});

/* ---------- candles from it ---------- */

test("a daily summary is drawn as a candle from the day's average, and says it is approximate", () => {
  const c = dailyCandles([day("2025-03-01", { averagePrice: 110, min: 100, max: 120 }), day("2025-03-02", { averagePrice: 118, min: 105, max: 125, totalAmount: 5000, totalShares: 40, totalTrades: 7 })]);
  assert.deepEqual([c[0].o, c[0].c], [110, 110], "the first day has no day before it: opens at its own average");
  assert.deepEqual([c[1].o, c[1].h, c[1].l, c[1].c, c[1].volumeQu, c[1].volumeQty, c[1].trades], [110, 125, 105, 118, 5000, 40, 7]);
  assert.ok(c.every((x) => x.src === "quhub" && x.approx === true));
  assert.equal(c[1].t, Date.UTC(2025, 2, 2));
});

const snap = (): Snapshot => ({
  v: 1,
  source: "quhub",
  fetchedAt: NOW,
  assets: {
    [`THIN|${ISSUER}`]: { symbol: "THIN", issuer: ISSUER, daily: [day("2025-03-01", { totalTrades: 3 })], trades: [trade("2025-03-01T10:00:10Z", 100, 10, 1), trade("2025-03-01T10:00:50Z", 120, 10, 2), trade("2025-03-01T10:07:00Z", 110, 20, 3)] },
    [`BUSY|${ISSUER}`]: { symbol: "BUSY", issuer: ISSUER, daily: [day("2025-03-01"), day("2025-03-02"), day("2025-03-03")] },
  },
});

test("an asset with every trade gets real candles of any width; one with only a summary gets daily candles and nothing narrower", () => {
  const h = new ImportedHistory(snap());
  const thinKey = [...(h as unknown as { slots: Map<string, unknown> }).slots.keys()][0];
  const busyKey = [...(h as unknown as { daily: Map<string, unknown> }).daily.keys()].find((k) => k !== thinKey)!;
  const before = Date.UTC(2026, 3, 1);
  const minute = h.candles(thinKey, 60_000, 0, before);
  assert.deepEqual(minute.map((c) => [new Date(c.t).toISOString().slice(11, 16), c.o, c.h, c.l, c.c, c.trades]), [["10:00", 100, 120, 100, 120, 2], ["10:07", 110, 110, 110, 110, 1]]);
  assert.ok(minute.every((c) => c.src === "quhub" && !c.approx), "trade-level candles are real trades, from an unverified source");
  const hour = h.candles(thinKey, 3_600_000, 0, before);
  assert.deepEqual([hour.length, hour[0].o, hour[0].c, hour[0].trades, hour[0].volumeQu], [1, 100, 110, 3, 100 * 10 + 120 * 10 + 110 * 20]);
  assert.equal(h.candles(thinKey, DAY, 0, before)[0].trades, 3);
  // The busy asset has only its daily summary.
  assert.equal(h.candles(busyKey, 3_600_000, 0, before).length, 0, "nothing narrower than a day can be made from a daily summary");
  assert.equal(h.candles(busyKey, 60_000, 0, before).length, 0);
  assert.deepEqual(h.candles(busyKey, DAY, 0, before).map((c) => c.approx), [true, true, true]);
  // Only days before the archive's own records, and not before the range asked for.
  assert.equal(h.candles(busyKey, DAY, 0, Date.UTC(2025, 2, 3)).length, 2);
  assert.equal(h.candles(busyKey, DAY, Date.UTC(2025, 2, 2), before).length, 2);
  assert.equal(h.candles(thinKey, 60_000, 0, Date.UTC(2025, 2, 1, 10, 0, 30)).length, 1, "a trade at or after the cut is the archive's to supply");
  assert.deepEqual(h.candles("0|nobody", DAY, 0, before), []);
  assert.deepEqual(h.stats(), { assets: 2, tradeAssets: 1, trades: 3, days: 4, fetchedAt: NOW });
});

test("older candles go in front only when asked for, not for QSwap, and only before the archive's own day", () => {
  const h = new ImportedHistory(snap());
  const busyKey = [...(h as unknown as { daily: Map<string, unknown> }).daily.keys()][1];
  const archiveStart = Date.UTC(2025, 2, 3, 15, 0, 0); // the archive's records begin mid-afternoon on 2025-03-03
  const ask = (o: object) => olderCandles(h, busyKey, { venue: "QX", intervalMs: DAY, sinceMs: 0, withImported: true, ...o }, archiveStart);
  assert.deepEqual(ask({}).map((c) => new Date(c.t).toISOString().slice(0, 10)), ["2025-03-01", "2025-03-02"], "the day the archive begins is the archive's");
  assert.deepEqual(ask({ withImported: false }), [], "only the candle chart asks");
  assert.deepEqual(ask({ withImported: undefined }), []);
  assert.deepEqual(ask({ venue: "QSwap" }), [], "Quhub is QX only");
  assert.equal(ask({ venue: "all" }).length, 2);
  assert.equal(ask({ venue: "auto" }).length, 2);
  assert.deepEqual(olderCandles(h, busyKey, { venue: "QX", intervalMs: DAY, sinceMs: 0, withImported: true }, null), [], "nothing to put it in front of");
});

test("a snapshot that is saved loads again, and a damaged file is just no history", () => {
  const dir = mkdtempSync(join(tmpdir(), "qmax-quhub-"));
  try {
    const file = join(dir, "quhub.json");
    saveSnapshot(file, snap());
    assert.equal(ImportedHistory.fromFile(file).stats().assets, 2);
    assert.equal(ImportedHistory.fromFile(join(dir, "missing.json")).stats().assets, 0);
    saveSnapshot(file, { v: 2 } as unknown as Snapshot);
    assert.equal(ImportedHistory.fromFile(file).stats().assets, 0, "a file of another shape is set aside, not trusted");
    // Hostile content inside a well-formed file is cleaned on the way in.
    const bad = snap();
    bad.assets[`BAD|${ISSUER}`] = { symbol: "BAD", issuer: ISSUER, daily: [{ ...day("2025-03-01"), min: 500 }] as DailyPoint[], trades: [trade("2025-03-01T10:00:00Z", -5, 1, 1)] };
    bad.assets["bad name|x"] = { symbol: "bad name", issuer: "x", daily: [day("2025-03-01")] };
    assert.equal(new ImportedHistory(bad).stats().assets, 2, "an asset whose days are all broken, or whose name cannot be keyed, is left out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- reading it ---------- */

function server(opts: { total: number; listed?: number; fail?: Set<string>; tooMany?: boolean }) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal(init?.redirect, "error", "a redirect would be followed to somewhere else");
    const u = new URL(String(url));
    const sym = u.pathname.split("/asset/")[1].split("/")[0];
    if (opts.fail?.has(sym)) return new Response("nope", { status: 500 });
    if (u.pathname.endsWith("/chart/average-price")) return Response.json([day("2025-03-01", { totalTrades: opts.total })]);
    return Response.json(Array.from({ length: opts.listed ?? opts.total }, (_, i) => trade(`2025-03-01T10:${String(i % 60).padStart(2, "0")}:00Z`, 100 + i, 1, i + 1)));
  }) as typeof fetch;
  return { f, calls };
}
const A = (symbol: string) => ({ symbol, issuer: ISSUER });
const fast = { sleep: async () => {}, now: () => NOW };

test("a thin asset's whole trade list is kept; a busy one gets its daily summary only, and its list is never asked for", async () => {
  const thin = server({ total: 5 });
  const s = await readQuhub({ assets: [A("THIN")], fetch: thin.f, ...fast });
  assert.equal(s.assets[`THIN|${ISSUER}`].trades?.length, 5);
  assert.deepEqual(thin.calls.map((u) => u.replace(QUHUB_API, "").replace(ISSUER, "ISSUER")), ["/issuer/ISSUER/asset/THIN/chart/average-price", "/issuer/ISSUER/asset/THIN/trades?page=0&size=1000"]);
  const busy = server({ total: 5000 });
  const b = await readQuhub({ assets: [A("BUSY")], fetch: busy.f, ...fast });
  assert.equal(b.assets[`BUSY|${ISSUER}`].trades, undefined);
  assert.equal(busy.calls.length, 1, "one request: no point asking for a list that cannot be the whole history");
});

test("a list that is not the whole history is not used as if it were", async () => {
  const notes: string[] = [];
  const s = await readQuhub({ assets: [A("PART")], fetch: server({ total: 10, listed: 7 }).f, onAsset: (_s, i) => notes.push(i.note ?? ""), ...fast });
  assert.equal(s.assets[`PART|${ISSUER}`].trades, undefined);
  assert.equal(s.assets[`PART|${ISSUER}`].daily.length, 1, "the daily summary still is");
  assert.match(notes[0], /7 of 10 trades/);
});

test("it goes slowly, obeys a request to slow down, and gives up on a server that keeps failing", async () => {
  const pauses: number[] = [];
  const sleep = async (ms: number) => void pauses.push(ms);
  let n = 0;
  const flaky = (async () => (++n <= 2 ? new Response("slow down", { status: 429 }) : Response.json([day("2025-03-01")]))) as typeof fetch;
  const s = await readQuhub({ assets: [A("ONE"), A("TWO")], fetch: flaky, delayMs: 1000, sleep, now: () => NOW });
  assert.equal(Object.keys(s.assets).length, 2, "it got there after waiting");
  assert.ok(pauses.includes(2000) && pauses.includes(4000), `backed off, then longer: ${pauses}`);
  assert.ok(pauses.filter((p) => p === 1000).length >= 2, "and a second between assets");
  const down = server({ total: 1, fail: new Set(["A1", "A2", "A3", "A4", "A5", "A6"]) });
  await assert.rejects(readQuhub({ assets: ["A1", "A2", "A3", "A4", "A5", "A6"].map(A), fetch: down.f, ...fast }), /five times in a row/);
  assert.ok(down.calls.length <= 5 * 4, `it stopped hitting the server (${down.calls.length} requests)`);
});

test("names that are not an asset's are never put into a web address", async () => {
  const s = server({ total: 1 });
  const out = await readQuhub({ assets: [A("../x"), { symbol: "OK", issuer: "not an issuer" }, A("FINE")], fetch: s.f, ...fast });
  assert.deepEqual(Object.keys(out.assets), [`FINE|${ISSUER}`]);
  assert.ok(s.calls.every((u) => !u.includes("..")));
});
