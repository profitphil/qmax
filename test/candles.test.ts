import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { TradeSource } from "../src/api.ts";
import { candleChartSvg } from "../src/chart.ts";
import type { CandleBar } from "../src/chart.ts";
import type { MarketData } from "../src/data.ts";
import { DAY, HOUR } from "../src/history.ts";
import { TradeIndex } from "../src/trades.ts";
import { QMaxClient } from "../sdk/client.ts";
import { NOW, archive, key, qx, swap } from "./trade-helpers.ts";

const H0 = Math.floor(NOW / DAY) * DAY - 3 * DAY; // midnight UTC, three days back: a clean place to start

async function indexOf(events: ReturnType<typeof qx>[]) {
  const idx = new TradeIndex(archive(events, { lastTick: 10_000 }), { days: 30 });
  await idx.update(NOW);
  return idx;
}

/* ---------- aggregation ---------- */

test("candles sum hours into wider buckets with the right open, close, high, low and volume", async () => {
  const idx = await indexOf([
    qx(100, H0 + 1 * HOUR + 1000, "CFB", 10, 100), // 00:xx-04:xx bucket: open
    qx(101, H0 + 2 * HOUR + 1000, "CFB", 15, 50), // high
    qx(102, H0 + 3 * HOUR + 1000, "CFB", 8, 50), // low
    qx(103, H0 + 3 * HOUR + 2000, "CFB", 12, 100), // close
    qx(104, H0 + 5 * HOUR, "CFB", 20, 10), // next 4h bucket
  ]);
  const bars = idx.candles(key("CFB"), "QX", 4 * HOUR);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], { t: H0, o: 10, h: 15, l: 8, c: 12, volumeQu: 1000 + 750 + 400 + 1200, volumeQty: 300, trades: 4 });
  assert.equal(bars[1].t, H0 + 4 * HOUR);
  assert.deepEqual([bars[1].o, bars[1].c, bars[1].trades], [20, 20, 1]);
  // hour candles are the hours themselves, and a day is one bucket
  assert.equal(idx.candles(key("CFB"), "QX", HOUR).length, 4);
  const day = idx.candles(key("CFB"), "QX", DAY);
  assert.equal(day.length, 1);
  assert.deepEqual([day[0].o, day[0].h, day[0].l, day[0].c, day[0].trades], [10, 20, 8, 20, 5]);
});

test("a stretch with no trades has no candles, and the start of a range cuts the oldest off", async () => {
  const idx = await indexOf([qx(100, H0 + HOUR, "CFB", 10, 1), qx(101, H0 + 30 * HOUR, "CFB", 12, 1)]);
  const bars = idx.candles(key("CFB"), "QX", HOUR);
  assert.deepEqual(bars.map((b) => b.t), [H0 + HOUR, H0 + 30 * HOUR]);
  assert.deepEqual(idx.candles(key("CFB"), "QX", HOUR, H0 + 10 * HOUR).map((b) => b.t), [H0 + 30 * HOUR]);
  assert.deepEqual(idx.candles(key("NOPE"), "QX", HOUR), []);
});

test("'all' treats the two venues as one market: highs and lows span both, volume adds up, and open and close follow the order of trades", async () => {
  const idx = await indexOf([
    swap(6, 100, H0 + HOUR + 1000, "CFB", 1000, 100), // QSwap first: 10 per unit
    qx(101, H0 + HOUR + 2000, "CFB", 14, 10), // QX: 14
    swap(8, 102, H0 + HOUR + 3000, "CFB", 100, 900), // QSwap last: 9 per unit
  ]);
  const [bar] = idx.candles(key("CFB"), "all", HOUR);
  assert.deepEqual([bar.o, bar.h, bar.l, bar.c, bar.trades], [10, 14, 9, 9, 3]);
  assert.equal(bar.volumeQu, 1000 + 140 + 900);
  const onlyQx = idx.candles(key("CFB"), "QX", HOUR)[0];
  assert.deepEqual([onlyQx.o, onlyQx.c, onlyQx.trades], [14, 14, 1]);
  assert.equal(idx.venueFor(key("CFB"), "QSwap"), "QSwap");
  assert.equal(idx.venueFor(key("CFB"), "QX"), "QX");
});

test("24-hour volume adds both venues and ignores older trades", async () => {
  const idx = await indexOf([qx(100, NOW - 2 * HOUR, "CFB", 10, 100), swap(6, 101, NOW - HOUR, "CFB", 500, 50), qx(102, NOW - 3 * DAY, "CFB", 10, 1000)]);
  assert.deepEqual(idx.volume(key("CFB"), NOW - DAY), { volumeQu: 1000 + 500, trades: 2 });
});

/* ---------- the chart ---------- */

const bar = (t: number, o: number, c: number, h: number, l: number, volumeQu: number): CandleBar => ({ t, o, c, h, l, volumeQu });
const count = (svg: string, re: RegExp) => (svg.match(re) ?? []).length;

test("the candle chart draws one wick, one body and one volume bar per candle, coloured by direction", () => {
  const svg = candleChartSvg([bar(0, 10, 12, 13, 9, 100), bar(HOUR, 12, 11, 12.5, 10.5, 400), bar(2 * HOUR, 11, 11, 11, 11, 0)], { symbol: "CFB", rangeLabel: "1D", intervalMs: HOUR, palette: { up: "#00ff00", down: "#ff0000", bg: "none" } });
  assert.equal(count(svg, /stroke="#00ff00" stroke-width="1"\/>/g), 2, "the rising candle and the flat one (a close at the open counts as up)");
  assert.equal(count(svg, /stroke="#ff0000" stroke-width="1"\/>/g), 1, "one falling wick");
  assert.equal(count(svg, /fill-opacity="0.45"/g), 3, "a volume bar for each candle");
  assert.match(svg, /CFB\s+11\.00 QU/);
  assert.match(svg, /\+10\.00% · 1D/); // 10 -> 11 over the range
  assert.match(svg, /Volume 500 QU/);
  assert.match(svg, /fill="none"/, "transparent background when asked");
});

test("the busiest candle gets the tallest volume bar and a flat candle still shows", () => {
  const svg = candleChartSvg([bar(0, 10, 10, 10, 10, 10), bar(HOUR, 10, 11, 11, 10, 1000)], { symbol: "X", rangeLabel: "1D", intervalMs: HOUR });
  const heights = [...svg.matchAll(/fill-opacity="0.45"/g)].map((m) => Number(/height="([\d.]+)"/.exec(svg.slice(svg.lastIndexOf("<rect", m.index!), m.index!))![1]));
  assert.ok(heights[1] > heights[0] * 10, `volume bars scale with volume: ${heights}`);
  assert.ok(heights.every((h) => h >= 1), "even tiny volume is visible");
});

test("no trades gives a message instead of an empty chart, and a single candle works", () => {
  assert.match(candleChartSvg([], { symbol: "X", rangeLabel: "7D", intervalMs: HOUR }), /No trades in this range/);
  const one = candleChartSvg([bar(NOW, 5, 6, 7, 4, 50)], { symbol: "X", rangeLabel: "7D", intervalMs: DAY });
  assert.match(one, /<svg/);
  assert.equal(count(one, /fill-opacity="0.45"/g), 1);
  assert.doesNotMatch(one, /NaN|Infinity/);
});

/* ---------- the endpoint ---------- */

const seen: { assetId: string; venue: string; intervalMs: number; sinceMs: number }[] = [];
const source: TradeSource = {
  candles(assetId, q) {
    seen.push({ assetId, ...q });
    if (assetId.toUpperCase() !== "CFB") return null;
    return { asset: "CFB", venue: q.venue === "auto" ? "QSwap" : q.venue, candles: [{ t: H0, o: 1, h: 2, l: 1, c: 2, volumeQu: 10, volumeQty: 5, trades: 3 }], volume24hQu: 10, trades24h: 3 };
  },
};
const data: MarketData = { assets: () => ["CFB"], venues: async () => null };
const server = createApi({ data, trades: source });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const get = (path: string) => fetch(base + path).then(async (r) => ({ r, j: (await r.json()) as Record<string, any> }));

test("GET /v1/candles returns the candles, the venue used and the 24-hour volume", async () => {
  const { r, j } = await get("/v1/candles?asset=cfb&range=7d");
  assert.equal(r.status, 200);
  assert.deepEqual([j.asset, j.range, j.interval, j.venue, j.volume24hQu, j.trades24h], ["CFB", "7d", "1h", "QSwap", 10, 3]);
  assert.deepEqual(j.candles[0], { t: H0, o: 1, h: 2, l: 1, c: 2, volumeQu: 10, volumeQty: 5, trades: 3 });
});

test("the candle width follows the range unless one is asked for", async () => {
  seen.length = 0;
  for (const range of ["1d", "7d", "30d", "90d", "all"]) await get(`/v1/candles?asset=CFB&range=${range}`);
  assert.deepEqual(seen.map((s) => s.intervalMs), [HOUR, HOUR, 4 * HOUR, DAY, DAY]);
  seen.length = 0;
  await get("/v1/candles?asset=CFB&range=all&interval=4h&venue=all");
  assert.deepEqual([seen[0].intervalMs, seen[0].venue, seen[0].sinceMs], [4 * HOUR, "all", 0]);
  seen.length = 0;
  await get("/v1/candles?asset=CFB&range=1d");
  assert.ok(Math.abs(seen[0].sinceMs - (Date.now() - DAY)) < 5000, "a range starts that long ago");
});

test("GET /v1/candles refuses bad requests and unknown assets", async () => {
  assert.equal((await get("/v1/candles")).r.status, 400);
  assert.equal((await get("/v1/candles?asset=CFB&range=2y")).r.status, 400);
  assert.equal((await get("/v1/candles?asset=CFB&interval=2m")).r.status, 400, "widths are a minute, 5, 15, 30, an hour, 4 hours or a day");
  assert.equal((await get("/v1/candles?asset=CFB&venue=binance")).r.status, 400);
  assert.equal((await get("/v1/candles?asset=NOPE")).r.status, 404);
});

test("a server without trade history says so", async () => {
  const s = createApi({ data });
  await new Promise<void>((r) => s.listen(0, () => r()));
  const res = await fetch(`http://localhost:${(s.address() as AddressInfo).port}/v1/candles?asset=CFB`);
  s.close();
  assert.equal(res.status, 404);
});

test("the SDK asks for candles with the options it was given", async () => {
  const urls: string[] = [];
  const client = new QMaxClient({ baseUrl: "http://example.invalid", fetch: (async (u: string) => (urls.push(u), new Response(JSON.stringify({ candles: [] })))) as unknown as typeof fetch });
  await client.candles("CFB", "30d", { interval: "4h", venue: "QX" });
  await client.candles("CFB");
  assert.match(urls[0], /\/v1\/candles\?asset=CFB&range=30d&interval=4h&venue=QX$/);
  assert.match(urls[1], /\/v1\/candles\?asset=CFB&range=7d$/);
});

/* ---------- minute resolution ---------- */

const MIN = 60_000;

test("trades are kept by the minute, so candles can be a minute, 5, 15 or 30 wide, aligned to the clock, with the right open, high, low, close and volume", async () => {
  const idx = await indexOf([
    qx(100, H0 + 1 * MIN + 5_000, "CFB", 10, 10), // 00:01  open of the 5 and 15 and 30 minute candles
    qx(101, H0 + 1 * MIN + 30_000, "CFB", 12, 10), // same minute
    qx(102, H0 + 3 * MIN, "CFB", 9, 10), // 00:03: the low
    qx(103, H0 + 4 * MIN + 59_000, "CFB", 11, 10), // 00:04: the 5-minute close
    qx(104, H0 + 7 * MIN, "CFB", 20, 10), // 00:07: the next 5-minute candle, same 15
    qx(105, H0 + 16 * MIN, "CFB", 30, 10), // 00:16: the next 15-minute candle, same 30
    qx(106, H0 + 31 * MIN, "CFB", 40, 10), // 00:31: the next 30-minute candle
  ]);
  const k = key("CFB");
  const one = idx.candles(k, "QX", MIN);
  assert.deepEqual(one.map((c) => c.t - H0), [1, 3, 4, 7, 16, 31].map((m) => m * MIN), "a minute with no trades has no candle");
  assert.deepEqual([one[0].o, one[0].h, one[0].l, one[0].c, one[0].trades, one[0].volumeQu], [10, 12, 10, 12, 2, 100 + 120]);
  const five = idx.candles(k, "QX", 5 * MIN);
  assert.deepEqual(five.map((c) => c.t - H0), [0, 5 * MIN, 15 * MIN, 30 * MIN]);
  assert.deepEqual([five[0].o, five[0].h, five[0].l, five[0].c, five[0].trades], [10, 12, 9, 11, 4], "open from the first trade, close from the last, wherever in the bucket");
  const fifteen = idx.candles(k, "QX", 15 * MIN);
  assert.deepEqual(fifteen.map((c) => [c.t - H0, c.trades]), [[0, 5], [15 * MIN, 1], [30 * MIN, 1]]);
  assert.deepEqual([fifteen[0].o, fifteen[0].h, fifteen[0].l, fifteen[0].c], [10, 20, 9, 20]);
  const thirty = idx.candles(k, "QX", 30 * MIN);
  assert.deepEqual(thirty.map((c) => [c.t - H0, c.trades, c.c]), [[0, 6, 30], [30 * MIN, 1, 40]]);
  // The same trades as hours: one bucket, and the hourly sums the rest of QMax reads agree with it.
  const [hour] = idx.candles(k, "QX", HOUR);
  assert.deepEqual([hour.o, hour.h, hour.l, hour.c, hour.trades], [10, 40, 9, 40, 7]);
  const [h] = idx.hours(k, "QX");
  assert.deepEqual([h.hour, h.open, h.high, h.low, h.close, h.n, h.qu], [H0, 10, 40, 9, 40, 7, hour.volumeQu]);
});

test("a width that is not a whole number of minutes is rounded to one, and both venues merge by minute too", async () => {
  const idx = await indexOf([swap(6, 100, H0 + MIN + 1000, "CFB", 1000, 100), qx(101, H0 + MIN + 2000, "CFB", 14, 10), swap(8, 102, H0 + MIN + 3000, "CFB", 100, 900)]);
  const [m] = idx.candles(key("CFB"), "all", MIN + 7);
  assert.equal(m.t, H0 + MIN, "rounded to a minute");
  assert.deepEqual([m.o, m.h, m.l, m.c, m.trades], [10, 14, 9, 9, 3]);
});

test("hourly sums are rebuilt when new trades arrive (they are not served stale)", async () => {
  const events = [qx(100, NOW - 2 * HOUR, "CFB", 10, 10)];
  const arch = { lastTick: 200 };
  const idx = new TradeIndex(archive(events, arch), { days: 30 });
  await idx.update(NOW);
  const before = idx.hours(key("CFB"), "QX");
  assert.deepEqual([before.length, before[0].n, before[0].close], [1, 1, 10], "this builds (and keeps) the hourly sums");
  // A new trade in the same hour arrives on a later tick, and the SAME index reads it.
  events.push(qx(260, NOW - 2 * HOUR + 5_000, "CFB", 12, 10));
  arch.lastTick = 300;
  await idx.update(NOW);
  const rows = idx.hours(key("CFB"), "QX");
  assert.deepEqual([rows.length, rows[0].n, rows[0].close], [1, 2, 12], "the hour now includes it");
  // The array handed out is the caller's: emptying it does not change what the next caller gets.
  rows.length = 0;
  assert.equal(idx.hours(key("CFB"), "QX").length, 1);
});

test("one answer holds at most the latest 5,000 candles, and says so", async () => {
  const many = Array.from({ length: 6000 }, (_, i) => ({ t: H0 + i * MIN, o: 1, h: 2, l: 1, c: i, volumeQu: 10, volumeQty: 5, trades: 1 }));
  const big: TradeSource = { candles: () => ({ asset: "CFB", venue: "QX", candles: many, volume24hQu: 0, trades24h: 0 }) };
  const s = createApi({ data, trades: big });
  await new Promise<void>((r) => s.listen(0, () => r()));
  try {
    const j = (await (await fetch(`http://localhost:${(s.address() as AddressInfo).port}/v1/candles?asset=CFB&range=all&interval=1m`)).json()) as { candles: { c: number }[]; truncated?: boolean; available?: number; interval: string };
    assert.equal(j.interval, "1m");
    assert.equal(j.candles.length, 5000);
    assert.deepEqual([j.truncated, j.available], [true, 6000]);
    assert.equal(j.candles[0].c, 1000, "the latest ones are kept");
    assert.equal(j.candles.at(-1)!.c, 5999);
    // Few enough candles: nothing is said about truncation.
    const small = (await get("/v1/candles?asset=CFB&interval=15m")).j;
    assert.equal(small.truncated, undefined);
    assert.equal(small.interval, "15m");
  } finally {
    s.close();
  }
});

/* ---------- 24 hour change ---------- */

test("the 24 hour change is the last trade against the last trade before the window, in percent", async () => {
  const idx = await indexOf([
    qx(100, NOW - 30 * HOUR, "CFB", 100, 10),
    qx(101, NOW - 26 * HOUR, "CFB", 80, 10), // the latest one before the window: the reference
    qx(102, NOW - 10 * HOUR, "CFB", 90, 10),
    qx(103, NOW - 1 * HOUR, "CFB", 120, 10), // the last trade
  ]);
  assert.ok(Math.abs(idx.change(key("CFB"), NOW)! - 50) < 1e-9); // 80 to 120
  // a narrower window moves the reference: 12 hours back the latest earlier trade is still the one 26 hours ago
  assert.ok(Math.abs(idx.change(key("CFB"), NOW, 12 * HOUR)! - 50) < 1e-9);
  // 5 hours back the reference is the trade 10 hours ago (90)
  assert.ok(Math.abs(idx.change(key("CFB"), NOW, 5 * HOUR)! - (120 / 90 - 1) * 100) < 1e-9);
});

test("an asset that began trading inside the window is measured from its first trade there", async () => {
  const idx = await indexOf([qx(100, NOW - 5 * HOUR, "CFB", 50, 10), qx(101, NOW - 2 * HOUR, "CFB", 40, 10)]);
  assert.ok(Math.abs(idx.change(key("CFB"), NOW)! - -20) < 1e-9);
});

test("no change is reported with nothing to compare: no trade in the window, one lone trade, or an unknown asset", async () => {
  const quiet = await indexOf([qx(100, NOW - 40 * HOUR, "CFB", 50, 10), qx(101, NOW - 30 * HOUR, "CFB", 60, 10)]);
  assert.equal(quiet.change(key("CFB"), NOW), null);
  const lone = await indexOf([qx(100, NOW - 3 * HOUR, "CFB", 50, 10)]);
  assert.equal(lone.change(key("CFB"), NOW), null);
  assert.equal(lone.change(key("NOPE"), NOW), null);
});

test("the change is measured on the one market that traded last, not across QX and QSwap", async () => {
  const idx = await indexOf([
    qx(100, NOW - 30 * HOUR, "CFB", 100, 10), // QX before the window
    swap(6, 101, NOW - 20 * HOUR, "CFB", 1040, 10), // QSwap sits a little higher: it must not be compared with QX
    swap(6, 102, NOW - 2 * HOUR, "CFB", 1100, 10), // the last trade, on QSwap
  ]);
  // On QSwap alone: first trade inside the window (104) to the last (110)
  assert.ok(Math.abs(idx.change(key("CFB"), NOW)! - (110 / 104 - 1) * 100) < 1e-6);
});
