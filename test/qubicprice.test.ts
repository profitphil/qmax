import test from "node:test";
import assert from "node:assert/strict";
import { QU_RANGES, QubicPrice, parseCandles, qubicRoutes } from "../src/qubicprice.ts";
import { RouteError } from "../src/routes.ts";

const rate = { usdPerQu: 5.9e-7, at: 1_000, note: "5 of 5 sources agree" };
const SIMPLE = { "qubic-network": { usd: 5.9e-7, usd_market_cap: 84_000_000, usd_24h_vol: 1_600_000, usd_24h_change: -3.3 } };
const OHLC = [[1000, 4e-7, 5e-7, 3e-7, 4.5e-7], [2000, 4.5e-7, 6e-7, 4e-7, 5e-7], [3000, 5e-7, 5.5e-7, 4.8e-7, 5.2e-7]];

/** A fetch that answers from a table and counts its calls; a null answer is a failure. */
function fake(table: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    const hit = Object.entries(table).find(([k]) => String(url).includes(k));
    if (!hit || hit[1] === null) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1] };
  }) as unknown as typeof fetch;
  return { fn, calls, table };
}

test("the price is the checked one, with the extras CoinGecko adds", async () => {
  const f = fake({ "simple/price": SIMPLE });
  const p = new QubicPrice({ rate: async () => rate, fetchFn: f.fn });
  assert.deepEqual(await p.current(), { usdPerQu: 5.9e-7, at: 1_000, note: "5 of 5 sources agree", change24hPct: -3.3, marketCapUsd: 84_000_000, volume24hUsd: 1_600_000 });
});

test("the extras are asked for once in a while, not on every call, and two calls at once make one request", async () => {
  let now = 0;
  const f = fake({ "simple/price": SIMPLE });
  const p = new QubicPrice({ rate: async () => rate, fetchFn: f.fn, now: () => now });
  await Promise.all([p.current(), p.current(), p.current()]);
  assert.equal(f.calls.length, 1);
  now = 4 * 60_000;
  await p.current();
  assert.equal(f.calls.length, 1);
  now = 6 * 60_000;
  await p.current();
  assert.equal(f.calls.length, 2);
});

test("with CoinGecko down the price still comes, with no extras; a kept answer is used for hours first", async () => {
  let now = 0;
  const f = fake({ "simple/price": SIMPLE });
  const p = new QubicPrice({ rate: async () => rate, fetchFn: f.fn, now: () => now });
  assert.equal((await p.current()).change24hPct, -3.3);
  f.table["simple/price"] = null;
  now = 30 * 60_000;
  assert.equal((await p.current()).change24hPct, -3.3); // the kept one
  now = 7 * 3_600_000;
  const late = await p.current();
  assert.equal(late.usdPerQu, 5.9e-7);
  assert.equal(late.change24hPct, null);
  assert.equal(late.marketCapUsd, null);
});

test("with no price that can be trusted the call fails as a 503, not as a made-up number", async () => {
  const p = new QubicPrice({ rate: async () => { throw new Error("The QU price is not available right now"); }, fetchFn: fake({}).fn });
  await assert.rejects(p.current(), (e: unknown) => e instanceof RouteError && e.status === 503 && /not available/.test(e.message));
});

test("candles are oldest first, one per time, with the spacing between them; junk rows are dropped", () => {
  const r = parseCandles([[3000, 5, 6, 4, 5], [1000, 1, 2, 1, 2], [2000, 2, 3, 1, 3], [2000, 9, 9, 9, 9], "x", [1, 2], [4000, 0, 1, 1, 1], [5000, "a", 1, 1, 1], [6000, 1, NaN, 1, 1]]);
  assert.deepEqual(r.candles.map((c) => c.t), [1000, 2000, 3000]);
  assert.equal(r.intervalMs, 60_000); // a spacing of 1000 ms is raised to a minute
  assert.equal(parseCandles(null).candles.length, 0);
  assert.equal(parseCandles({}).intervalMs, 3_600_000);
  const wide = parseCandles([[0, 1, 1, 1, 1], [14_400_000, 1, 1, 1, 1], [28_800_000, 1, 1, 1, 1]]);
  assert.equal(wide.intervalMs, 14_400_000);
});

test("a candle's high and low always hold its open and close", () => {
  const c = parseCandles([[1000, 5, 4, 6, 7]]).candles[0];
  assert.equal(c.h, 7);
  assert.equal(c.l, 5);
});

test("candles are kept for ten minutes, per range, and a failed refresh serves the kept ones", async () => {
  let now = 0;
  const f = fake({ "days=7": OHLC, "days=30": OHLC });
  const p = new QubicPrice({ rate: async () => rate, fetchFn: f.fn, now: () => now });
  const a = await p.candles("7d");
  assert.equal(a.candles.length, 3);
  assert.equal(a.range, "7d");
  await p.candles("7d");
  assert.equal(f.calls.length, 1);
  await p.candles("30d");
  assert.equal(f.calls.length, 2);
  f.table["days=7"] = null;
  now = 11 * 60_000;
  assert.equal((await p.candles("7d")).candles.length, 3); // refresh failed: the kept ones
  now = 7 * 3_600_000;
  await assert.rejects(p.candles("7d"), (e: unknown) => e instanceof RouteError && e.status === 503);
});

test("each range asks CoinGecko for the right number of days", async () => {
  const f = fake({ "ohlc": OHLC });
  const p = new QubicPrice({ rate: async () => rate, fetchFn: f.fn });
  for (const r of Object.keys(QU_RANGES).filter((x) => x !== "all") as (keyof typeof QU_RANGES)[]) await p.candles(r);
  assert.deepEqual(f.calls.map((u) => /days=([^&]+)/.exec(u)![1]), ["1", "7", "30", "90", "365"]);
});

test("the routes: a range must be one we know, and an empty answer is a 503", async () => {
  const p = new QubicPrice({ rate: async () => rate, fetchFn: fake({ "ohlc": [] }).fn });
  const routes = qubicRoutes({ price: p });
  assert.deepEqual(routes.map((r) => r.path), ["/v1/qu", "/v1/qu/candles"]);
  assert.ok(routes.every((r) => r.doc.summary && r.method === "GET"));
  const candles = routes[1];
  await assert.rejects(Promise.resolve(candles.handler({ query: new URLSearchParams("range=5y"), body: undefined })), (e: unknown) => e instanceof RouteError && e.status === 400);
  await assert.rejects(Promise.resolve(candles.handler({ query: new URLSearchParams("range=7d"), body: undefined })), (e: unknown) => e instanceof RouteError && e.status === 503);
});

test("the candles route gives exchange candles when a width is asked for, and refuses a width that is not offered", async () => {
  const now = 10_000_000_000;
  const hour = 3_600_000;
  const rows = Array.from({ length: 5 }, (_, i) => [now - (5 - i) * hour, "5e-7", "6e-7", "4e-7", "5.5e-7", "1000", 0, "0"]);
  const f = fake({ "api.mexc.com": rows });
  const p = new QubicPrice({ rate: async () => rate, fetchFn: f.fn, now: () => now });
  const candles = qubicRoutes({ price: p })[1];
  const out = (await candles.handler({ query: new URLSearchParams("range=1d&interval=1h"), body: undefined })) as { interval: string; intervalMs: number; truncated: boolean; candles: { v: number }[] };
  assert.equal(out.interval, "1h");
  assert.equal(out.intervalMs, hour);
  assert.equal(out.truncated, false);
  assert.equal(out.candles.length, 5);
  assert.equal(out.candles[0].v, 1000);
  assert.ok(f.calls[0].includes("interval=60m"));
  await assert.rejects(Promise.resolve(candles.handler({ query: new URLSearchParams("range=1d&interval=7m"), body: undefined })), (e: unknown) => e instanceof RouteError && e.status === 400);
  // without a width it is still CoinGecko's
  const g = new QubicPrice({ rate: async () => rate, fetchFn: fake({ ohlc: OHLC }).fn });
  assert.ok(!("truncated" in ((await qubicRoutes({ price: g })[1].handler({ query: new URLSearchParams("range=7d"), body: undefined })) as object)));
});

/* ---------- exchange candles ---------- */

import { KLINE_WIDTHS, parseGateKlines, parseMexcKlines } from "../src/qubicprice.ts";

const mexcRow = (t: number, o: number, c: number, v = 1000) => [t, String(o), String(Math.max(o, c)), String(Math.min(o, c)), String(c), String(v), t + 3_599_999, "9"];
const gateRow = (tSec: number, o: number, c: number, v = 1000) => [String(tSec), "9", String(c), String(Math.max(o, c)), String(Math.min(o, c)), String(o), String(v), "true"];

test("MEXC and Gate.io rows become candles with the QU traded, and rows that are not prices are dropped", () => {
  const m = parseMexcKlines([mexcRow(1000, 5e-7, 6e-7, 42), ["x"], [0, "1", "1", "1", "1", "1"], mexcRow(2000, 6e-7, 5e-7, 7)]);
  assert.deepEqual(m.map((k) => [k.t, k.o, k.c, k.v]), [[1000, 5e-7, 6e-7, 42], [2000, 6e-7, 5e-7, 7]]);
  const g = parseGateKlines([gateRow(1, 5e-7, 6e-7, 42), ["bad"], gateRow(0, 1, 1)]);
  assert.deepEqual(g.map((k) => [k.t, k.o, k.c, k.v]), [[1000, 5e-7, 6e-7, 42]]); // seconds become milliseconds
  assert.deepEqual(parseMexcKlines(null), []);
  assert.deepEqual(parseGateKlines({}), []);
  assert.equal(parseMexcKlines([[1000, "5", "4", "6", "5", "-1", 0, "0"]]).length, 0, "a negative volume is not a candle");
});

test("the candle widths the chart offers are all available, under each exchange's own names", () => {
  assert.deepEqual(Object.keys(KLINE_WIDTHS).map(Number), [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000]);
  assert.equal(KLINE_WIDTHS[3_600_000].mexc, "60m");
  assert.equal(KLINE_WIDTHS[3_600_000].gate, "1h");
});

test("klines come from MEXC, 500 a page and as many pages back as the range needs, oldest first", async () => {
  const now = 10_000_000;
  const hour = 3_600_000;
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    const end = Number(/endTime=(\d+)/.exec(String(url))![1]);
    // 500 hourly candles ending at `end`
    const rows = Array.from({ length: 500 }, (_, i) => mexcRow(Math.floor(end / hour) * hour - (499 - i) * hour, 5e-7, 5e-7));
    return { ok: true, status: 200, json: async () => rows };
  }) as unknown as typeof fetch;
  const p = new QubicPrice({ rate: async () => rate, fetchFn: fn, now: () => now * 1000 });
  const got = await p.klines(hour, 2400 * hour);
  assert.equal(calls.length, 5); // 2,400 candles take five pages of 500
  assert.ok(calls.every((c) => c.includes("api.mexc.com") && c.includes("interval=60m") && c.includes("startTime=") && c.includes("endTime=")), "MEXC only honours endTime together with startTime");
  assert.ok(got.length >= 2400 && got.length <= 2401, `got ${got.length}`);
  assert.ok(got.every((k, i) => i === 0 || k.t > got[i - 1].t), "oldest first, one per time");
  await p.klines(hour, 2400 * hour);
  assert.equal(calls.length, 5, "kept for a minute");
});

test("with MEXC down the candles come from Gate.io; with both down a kept answer is used, then it is a 503", async () => {
  let now = 1_000_000_000;
  const hour = 3_600_000;
  const state = { mexc: true, gate: true };
  const fn = (async (url: string) => {
    const u = String(url);
    if (u.includes("mexc") && !state.mexc) return { ok: false, status: 503, json: async () => ({}) };
    if (u.includes("gateio") && !state.gate) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (u.includes("mexc") ? [mexcRow(now - hour, 5e-7, 5e-7)] : [gateRow(Math.floor((now - hour) / 1000), 6e-7, 6e-7)]) };
  }) as unknown as typeof fetch;
  const p = new QubicPrice({ rate: async () => rate, fetchFn: fn, now: () => now });
  state.mexc = false;
  const fromGate = await p.klines(hour, 24 * hour);
  assert.equal(fromGate[0].o, 6e-7);
  state.gate = false;
  now += 2 * 60_000; // past the minute it is kept
  assert.equal((await p.klines(hour, 24 * hour))[0].o, 6e-7, "both down: the kept answer");
  now += 7 * 3_600_000;
  await assert.rejects(p.klines(hour, 24 * hour), (e: unknown) => e instanceof RouteError && e.status === 503);
});

test("a width that is not offered is refused", async () => {
  const p = new QubicPrice({ rate: async () => rate, fetchFn: fake({}).fn });
  await assert.rejects(p.klines(7 * 60_000, 1000), (e: unknown) => e instanceof RouteError && e.status === 400);
});

test("the whole history is made from the exchanges' daily candles (CoinGecko's free plan refuses \"max\")", async () => {
  const day = 86_400_000;
  const now = 5_000 * day;
  const f = fake({ "ohlc": null, "api.mexc.com": [mexcRow(now - 2 * day, 5e-7, 6e-7, 10), mexcRow(now - day, 6e-7, 5e-7, 20)] });
  const p = new QubicPrice({ rate: async () => rate, fetchFn: f.fn, now: () => now });
  const all = await p.candles("all");
  assert.equal(all.intervalMs, day);
  assert.deepEqual(all.candles.map((c) => c.c), [6e-7, 5e-7]);
  assert.ok(!("v" in all.candles[0]), "no volume in the CoinGecko-shaped candles");
  assert.ok(!f.calls.some((u) => u.includes("coingecko")), "it did not ask CoinGecko");
});

test("a long range at daily or 4-hour candles starts at Gate.io's first day, before MEXC had the market", async () => {
  const day = 86_400_000;
  const now = 5_000 * day;
  const gateDay = (d: number, c: number) => gateRow((d * day) / 1000, c, c, 100);
  const f = fake({
    "api.mexc.com": [mexcRow(4_900 * day, 5e-7, 5e-7), mexcRow(4_901 * day, 5e-7, 5e-7)],
    "api.gateio.ws": [gateDay(4_850, 1e-6), gateDay(4_851, 2e-6), gateDay(4_900, 9e-9)], // the last one overlaps MEXC's first: MEXC wins
  });
  const p = new QubicPrice({ rate: async () => rate, fetchFn: f.fn, now: () => now });
  const got = await p.klines(day, null);
  assert.deepEqual(got.map((k) => k.t / day), [4_850, 4_851, 4_900, 4_901]);
  assert.deepEqual(got.map((k) => k.c), [1e-6, 2e-6, 5e-7, 5e-7]);
  assert.ok(f.calls.some((u) => u.includes("to=") && u.includes("api.gateio.ws")));
  // a range MEXC covers fully does not ask Gate.io
  const g = fake({ "api.mexc.com": [mexcRow(now - 3 * day, 5e-7, 5e-7), mexcRow(now - 2 * day, 5e-7, 5e-7), mexcRow(now - day, 5e-7, 5e-7)] });
  await new QubicPrice({ rate: async () => rate, fetchFn: g.fn, now: () => now }).klines(day, 3 * day);
  assert.ok(!g.calls.some((u) => u.includes("gateio")));
  // widths Gate.io refuses that far back (hourly and finer) are left as MEXC's alone, without failing
  const h = fake({ "api.mexc.com": [mexcRow(now - 3_600_000, 5e-7, 5e-7)], "api.gateio.ws": null });
  const hourly = await new QubicPrice({ rate: async () => rate, fetchFn: h.fn, now: () => now }).klines(3_600_000, null);
  assert.equal(hourly.length, 1);
});
