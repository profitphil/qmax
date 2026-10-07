import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { GRADE_FLOOR, HEALTH_FLAGS, assessHealth, createHealth, gradeFor, healthRoutes } from "../src/health.ts";
import type { HealthAsset, HealthInput, HealthFlag, HourSum } from "../src/health.ts";
import { RouteError } from "../src/routes.ts";
import type { Route } from "../src/routes.ts";
import { TradeIndex } from "../src/trades.ts";
import { NOW, archive, key, qx, swap } from "./trade-helpers.ts";
import { REAL_BUSY, REAL_CFB_QX, REAL_CFB_SWAPS, toHours } from "./health-fixtures.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The history reaches back further than any window the assessment looks at. */
const SINCE = NOW - 200 * DAY;

/* ---------- fixtures ---------- */

/** One hour of trades, `ago` hours before NOW. */
const hr = (ago: number, n: number, qu: number, extra: Partial<HourSum> = {}): HourSum => ({ hour: NOW - ago * HOUR, n, qu, qty: Math.max(1, Math.round(qu / 10)), high: 10.2, low: 9.8, ...extra });

/** A market that trades every other hour on `activeHours` hours of each day, for `days` days: `perHour` trades of `size` QU each time. */
function steady(days: number, activeHours: number, perHour: number, size: number): HourSum[] {
  const rows: HourSum[] = [];
  for (let d = 0; d < days; d++) for (let k = 0; k < activeHours; k++) rows.push(hr(d * 24 + k * 2, perHour, perHour * size));
  return rows;
}

/** `count` hours in a row of `n` tiny swaps each, the newest `ago` hours before NOW. */
const burst = (ago: number, count: number, n = 2400, size = 103): HourSum[] => Array.from({ length: count }, (_, i) => hr(ago + i, n, n * size, { high: 1, low: 0.981 }));

/** A pool 10B QU deep priced at 10 QU, and a QX book one step wide. About 100M QU can be sold near the price. */
const deep: HealthAsset = { id: "DEEP", venues: ["QX", "QSwap"], priceQu: 10, liquidityQu: 2e10, bestBid: 9, bestAsk: 10, bidQty: 1000, askQty: 1000, poolQu: 1e10, poolAsset: 1e9, activity: "active" };
const GOOD = steady(30, 12, 5, 1e7);

const run = (asset: HealthAsset, swaps: HourSum[], opts: Partial<HealthInput> & { qxHours?: HourSum[] } = {}) => {
  const { qxHours = [], ...rest } = opts;
  return assessHealth({ asset, hours: { QX: qxHours, QSwap: swaps }, historySince: SINCE, now: NOW, ...rest });
};
/** A market with only QX trades. */
const runQx = (asset: HealthAsset, qxHours: HourSum[], opts: Partial<HealthInput> = {}) => run(asset, [], { ...opts, qxHours });
const flagsOf = (h: ReturnType<typeof assessHealth>): string => h.flags.join(",");

/** Every number anywhere in a value, to check none is NaN or infinite. */
function numbers(v: unknown, path = "$"): [string, number][] {
  if (typeof v === "number") return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => numbers(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => numbers(x, `${path}.${k}`));
  return [];
}
function assertSane(h: ReturnType<typeof assessHealth>) {
  for (const [path, x] of numbers(h)) assert.ok(Number.isFinite(x), `${path} is ${x}`);
  assert.ok(Number.isInteger(h.score) && h.score >= 0 && h.score <= 100, `score ${h.score}`);
  assert.equal(h.grade, gradeFor(h.score));
  assert.ok(h.reasons.length >= 1 && h.reasons.every((r) => typeof r === "string" && r.length > 10), "at least one real sentence");
  assert.ok(h.flags.every((f) => HEALTH_FLAGS.includes(f)));
  assert.ok(!/NaN|undefined|Infinity|null/.test(h.reasons.join(" ")), h.reasons.join(" | "));
}

/* ---------- a healthy asset ---------- */

test("a deep pool that trades steadily is an A with no flags and nothing to worry about", () => {
  const h = run(deep, steady(30, 12, 3, 1e7), { qxHours: steady(30, 12, 2, 1e7) });
  assertSane(h);
  assert.equal(h.grade, "A");
  assert.deepEqual(h.flags, []);
  assert.ok(h.score >= 95, `score ${h.score}`);
  assert.match(h.reasons[0], /^No warning signs found/);
  assert.equal(h.partial, false);
  const m = h.metrics;
  // 12 active hours a day for 7 days, plus the hour that starts exactly 7 days ago, which still overlaps the window (as it does in TradeIndex.volume)
  assert.equal(m.trades7d, 85 * 5);
  assert.deepEqual([m.tradesQswap7d, m.tradesQx7d], [85 * 3, 85 * 2]);
  assert.equal(m.activeHours7d, 85);
  assert.equal(m.poolPriceQu, 10);
  assert.ok(m.exitDepthQu > 99_000_000 && m.exitDepthQu < 102_000_000, `the pool takes about 1% of its QU reserve one way, got ${m.exitDepthQu}`);
  assert.equal(m.qxDepthBasis, "best-level");
});

/* ---------- each flag ---------- */

test("wash-suspected: hours of thousands of tiny swaps, in a row, all the same size", () => {
  const h = run(deep, [...GOOD.filter((r) => r.hour < NOW - 3 * DAY), ...burst(10, 30)]);
  assertSane(h);
  assert.ok(h.flags.includes("wash-suspected"));
  assert.ok(!h.flags.includes("bot-burst"), "strong evidence replaces the weak flag");
  assert.match(h.reasons[0], /^Looks like wash trading/, "the most important reason comes first");
  assert.match(h.reasons[0], /30 hours/);
  assert.match(h.reasons[0], /103 QU/);
  assert.match(h.reasons[0], /estimate/, "says it is an estimate");
  assert.equal(h.metrics.washLikeHours7d, 30);
  assert.equal(h.metrics.washPeakPerHour, 2400);
  assert.equal(h.metrics.washAvgTradeQu, 103);
  assert.ok(h.metrics.washLikeShare7d! > 0.95);
  assert.ok(h.grade !== "A" && h.grade !== "B", `a strongly suspected asset is not graded well: ${h.grade}`);
});

test("bot-burst: one burst of tiny swaps is weak evidence, so it costs a little and does not accuse", () => {
  const clean = run(deep, GOOD);
  const h = run(deep, [...GOOD, ...burst(30, 1, 2073)]);
  assert.ok(h.flags.includes("bot-burst"));
  assert.ok(!h.flags.includes("wash-suspected"));
  assert.match(h.reasons.join(" "), /not enough on its own/);
  const drop = clean.score - h.score;
  assert.ok(drop > 0 && drop <= 12, `a weak sign costs a little, not ${drop}`);
  const strong = run(deep, [...GOOD, ...burst(30, 20)]);
  assert.ok(clean.score - strong.score >= 30, `strong evidence costs a lot: ${clean.score - strong.score}`);
  assert.ok(strong.score < h.score && h.score < clean.score, "strong < weak < none");
});

test("wash-past: a strong burst that ended more than 7 days ago is noted but does not change the score", () => {
  const clean = run(deep, GOOD);
  const h = run(deep, [...GOOD, ...burst(70 * 24, 30)]);
  assert.ok(h.flags.includes("wash-past"));
  assert.ok(!h.flags.includes("wash-suspected") && !h.flags.includes("bot-burst"));
  assert.equal(h.score, clean.score, "it is history, so it is a note and not a penalty");
  assert.match(h.reasons.join(" "), /Between 2026-0\d-\d\d and 2026-0\d-\d\d this asset had 30 hours that looked like wash trading/);
  assert.equal(h.metrics.washLikeHours7d, 0);
  assert.equal(h.metrics.washLikeHoursTotal, 30);
});

test("churn needs to be strong evidence before anyone is accused", () => {
  const base = [...GOOD];
  const check = (label: string, extra: HourSum[], expected: HealthFlag[]) => {
    const h = run(deep, [...base, ...extra]);
    assert.deepEqual(h.flags.filter((f) => f === "wash-suspected" || f === "bot-burst" || f === "wash-past"), expected, label);
  };
  check("five hours is not enough", burst(10, 5), ["bot-burst"]);
  check("six hours in a row is", burst(10, 6), ["wash-suspected"]);
  check("six hours with gaps never reach three in a row", [0, 2, 4, 6, 8, 10].flatMap((g) => burst(20 + g, 1)), ["bot-burst"]);
  // sizes that wander by a factor of 10 between hours are not one bot doing the same thing
  const wander = Array.from({ length: 10 }, (_, i) => hr(10 + i, 2400, 2400 * (i % 2 ? 20 : 400)));
  check("sizes that jump around are not the same bot", wander, ["bot-burst"]);
  check("big swaps, however many, are ordinary trading", Array.from({ length: 12 }, (_, i) => hr(10 + i, 500, 500 * 2_000_000)), []);
  check("hundreds of swaps an hour is below the bar", Array.from({ length: 12 }, (_, i) => hr(10 + i, 250, 250 * 100)), []);
});

test("QX is held to a higher bar, because one transaction can fill many orders", () => {
  const fills = (n: number, count: number) => Array.from({ length: count }, (_, i) => hr(10 + i, n, n * 50));
  assert.ok(!run(deep, GOOD, { qxHours: fills(1000, 12) }).flags.some((f) => f.startsWith("wash") || f === "bot-burst"), "1,000 fills an hour is not churn on QX");
  const h = run(deep, GOOD, { qxHours: fills(2000, 12) });
  assert.ok(h.flags.includes("wash-suspected"));
  assert.match(h.reasons[0], /fills/, "it says fills, not swaps");
});

test("the real busiest hours of genuine markets are not churn", () => {
  for (const [name, rows] of Object.entries(REAL_BUSY)) {
    const venue = name.endsWith("QSwap") ? "QSwap" : "QX";
    const hours = toHours(rows);
    const now = Math.max(...hours.map((r) => r.hour)) + DAY;
    const h = assessHealth({ asset: { id: name }, hours: { QX: venue === "QX" ? hours : [], QSwap: venue === "QSwap" ? hours : [] }, historySince: now - 200 * DAY, now });
    assert.ok(!h.flags.some((f) => f.startsWith("wash") || f === "bot-burst"), `${name}: ${flagsOf(h)}`);
    assert.equal(h.metrics.washLikeHoursTotal, 0, name);
  }
});

test("no-market: nothing on QX and no pool is the worst grade there is", () => {
  const h = run({ id: "GONE", venues: [] }, []);
  assertSane(h);
  assert.deepEqual(h.flags.slice(0, 1), ["no-market"]);
  assert.equal(h.grade, "E");
  assert.ok(h.score <= 10);
  assert.match(h.reasons[0], /nothing to trade against/);
});

test("one-sided: only sell orders and no pool means you may be unable to sell, which caps the grade at E", () => {
  const wall: HealthAsset = { id: "WALL", venues: ["QX"], priceQu: 1, bestAsk: 1, askQty: 5e9, activity: "active" };
  const h = runQx(wall, steady(30, 12, 5, 1e6));
  assertSane(h);
  assert.ok(h.flags.includes("one-sided"));
  assert.equal(h.grade, "E");
  assert.ok(h.score <= 29);
  assert.match(h.reasons.join(" "), /only sell orders on QX and no QSwap pool/);
  // with a pool there is somebody to sell to
  assert.ok(!run({ ...wall, venues: ["QX", "QSwap"], poolQu: 1e9, poolAsset: 1e9 }, steady(30, 12, 5, 1e6)).flags.includes("one-sided"));
});

test("one-sided: only buy orders means you cannot buy more, which costs little and does not cap the grade", () => {
  const bids: HealthAsset = { id: "BIDS", venues: ["QX"], priceQu: 1000, bestBid: 1000, bidQty: 50_000_000, activity: "active" };
  const h = runQx(bids, steady(30, 12, 5, 1e7));
  assert.ok(h.flags.includes("one-sided"));
  assert.match(h.reasons.join(" "), /only buy orders on QX/);
  assert.ok(h.score > 29 && h.metrics.exitDepthQu === 50_000_000_000);
});

test("thin-book: under 10M QU can be sold near the price", () => {
  const thin = { ...deep, poolQu: 5e8 }; // the pool takes about 5M
  const h = run(thin, GOOD);
  assert.ok(h.flags.includes("thin-book"));
  assert.match(h.reasons[0], /Only about 5(\.\d)?M QU can be sold within 2% of the pool's price/);
  assert.ok(!run({ ...deep, poolQu: 1.2e9 }, GOOD).flags.includes("thin-book"), "about 12M is not thin");
  assert.ok(h.score < run(deep, GOOD).score);
});

test("wide-spread: a gap above 10% of the middle that is more than one QU step", () => {
  const wide: HealthAsset = { id: "WIDE", venues: ["QX"], priceQu: 125, bestBid: 100, bestAsk: 150, bidQty: 1_000_000, askQty: 1_000_000, activity: "active" };
  const h = runQx(wide, steady(30, 12, 5, 1e7));
  assert.ok(h.flags.includes("wide-spread"));
  assert.equal(h.metrics.spreadPct, 40);
  assert.match(h.reasons.join(" "), /you would pay 150 QU per unit to buy but get only 100 QU if you sold straight back, a gap of 40%/);
  // a cheap token whose two nearest prices are one QU apart cannot do better, so it is not a wide spread
  const cheap = runQx({ ...wide, id: "CHEAP", bestBid: 9, bestAsk: 10 }, steady(30, 12, 5, 1e7));
  assert.ok(!cheap.flags.includes("wide-spread"));
  assert.ok(cheap.metrics.spreadPct! > 10, "the percentage is still reported");
  assert.ok(cheap.score > h.score);
  // next to a pool a wide book matters less, and says why
  const pooled = runQx({ ...wide, venues: ["QX", "QSwap"], poolQu: 1e10, poolAsset: 1e8 }, steady(30, 12, 5, 1e7));
  assert.ok(pooled.score > h.score);
  assert.match(pooled.reasons.join(" "), /QSwap pool gives a tighter price/);
});

test("quiet: no trade in 14 days, or the catalogue's own inactive mark with almost no trading", () => {
  const old = [hr(20 * 24, 3, 3e7)];
  const h = run(deep, old);
  assert.ok(h.flags.includes("quiet"));
  assert.ok(!h.flags.includes("few-trades"), "quiet covers it");
  assert.match(h.reasons[0], /The last trade was about 20 days ago/);
  assert.equal(h.metrics.trades7d, 0);
  const nothing = run(deep, []);
  assert.ok(nothing.flags.includes("quiet"));
  assert.match(nothing.reasons.join(" "), /no trade recorded for it since 2026-/);
  const inactive = run({ ...deep, activity: "inactive" }, [hr(30, 2, 2e7)]);
  assert.ok(inactive.flags.includes("quiet"));
  assert.match(inactive.reasons.join(" "), /no order or pool change in about 2 epochs/);
  assert.ok(!run({ ...deep, activity: "inactive" }, GOOD).flags.includes("quiet"), "trading proves it is not dead");
});

test("few-trades: under 5 in a week, but something in the last 2 weeks", () => {
  const h = run(deep, [hr(30, 2, 2e7), hr(10 * 24, 5, 5e7)]);
  assert.ok(h.flags.includes("few-trades"));
  assert.ok(!h.flags.includes("quiet"));
  assert.match(h.reasons.join(" "), /Only 2 trades in the last 7 days \(in 1 hour\)/);
  assert.match(run(deep, [hr(10 * 24, 5, 5e7)]).reasons.join(" "), /No trades in the last 7 days/);
  assert.ok(!run(deep, steady(30, 1, 5, 1e7)).flags.includes("few-trades"), "35 trades is plenty to not be flagged");
});

test("new-listing: the first trade is under 14 days old and the history reaches back far enough to know", () => {
  const fresh = steady(3, 12, 5, 1e7);
  const h = run(deep, fresh);
  assert.ok(h.flags.includes("new-listing"));
  assert.match(h.reasons.join(" "), /first trade was only about 2 days ago/);
  assert.ok(!run(deep, GOOD).flags.includes("new-listing"));
  // a history that only goes back 20 days cannot tell a new asset from an old one that was quiet before
  const short = run(deep, fresh, { historySince: NOW - 20 * DAY });
  assert.ok(!short.flags.includes("new-listing"));
});

test("volume-spike: one hour holds most of the month's volume", () => {
  const spiky = [hr(100, 8, 9e9), ...Array.from({ length: 5 }, (_, i) => hr(200 + i * 10, 1, 2e8))];
  const h = run(deep, spiky);
  assert.ok(h.flags.includes("volume-spike"));
  assert.match(h.reasons.join(" "), /90%|89%|88%/);
  assert.ok(h.metrics.busiestHourVolumeShare30d! > 0.85);
  assert.ok(!run(deep, GOOD).flags.includes("volume-spike"));
  // with only a few trades behind it the share means nothing
  assert.ok(!run(deep, [hr(100, 2, 9e9), hr(200, 1, 2e8)]).flags.includes("volume-spike"));
});

test("pool-dominated: nearly every recent trade is a swap, so the pool alone sets the price", () => {
  const h = run(deep, steady(7, 6, 5, 1e7));
  assert.ok(h.flags.includes("pool-dominated"));
  assert.match(h.reasons.join(" "), /All 210 trades in the last 7 days were QSwap swaps/);
  const mixed = run(deep, steady(7, 6, 5, 1e7), { qxHours: steady(7, 6, 5, 1e7) });
  assert.ok(!mixed.flags.includes("pool-dominated"));
  assert.equal(mixed.metrics.tradesQx7d, 210);
  assert.equal(mixed.metrics.tradesQswap7d, 210);
});

test("every flag id is listed once, and the flags of an assessment come in the listed order", () => {
  assert.equal(new Set(HEALTH_FLAGS).size, HEALTH_FLAGS.length);
  const h = run({ id: "MESSY", venues: ["QX"], bestAsk: 50, askQty: 3, activity: "inactive" }, [hr(20 * 24, 3, 1e6)]);
  const order = h.flags.map((f) => HEALTH_FLAGS.indexOf(f));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

/* ---------- grades ---------- */

test("grade boundaries: each grade starts at its floor and the point below belongs to the grade under it", () => {
  const pairs: [number, string][] = [[100, "A"], [80, "A"], [79, "B"], [65, "B"], [64, "C"], [50, "C"], [49, "D"], [30, "D"], [29, "E"], [0, "E"]];
  for (const [score, grade] of pairs) assert.equal(gradeFor(score), grade, String(score));
  assert.deepEqual(Object.values(GRADE_FLOOR), [80, 65, 50, 30, 0]);
  assert.equal(gradeFor(79.99), "B", "a score is a whole number, but a fraction does not round up into a better grade");
  assert.equal(gradeFor(NaN), "E");
  assert.equal(gradeFor(-5), "E");
});

test("real-looking assets land in every grade", () => {
  const trades = steady(30, 12, 5, 1e7);
  const qxBook = (bestAsk: number): HealthAsset => ({ id: "QXONLY", venues: ["QX"], priceQu: 125, bestBid: 100, bestAsk, bidQty: 1e6, askQty: 1e6 });
  const cases: [string, string, () => ReturnType<typeof run>][] = [
    ["A", "deep pool, steady trading", () => run(deep, trades, { qxHours: trades })],
    ["B", "a thin pool but steady trading", () => run({ ...deep, poolQu: 3e8 }, trades, { qxHours: trades })],
    ["C", "QX only, a 26% spread, a trade or two a day", () => runQx(qxBook(130), steady(30, 1, 2, 1e7))],
    ["D", "QX only, a 67% spread, two trades in a week", () => runQx(qxBook(200), [hr(30, 2, 1e7), hr(100, 2, 1e7)])],
    ["E", "a wall of sell orders nobody buys back", () => runQx({ id: "WALL", venues: ["QX"], priceQu: 1, bestAsk: 1, askQty: 5e9 }, [])],
  ];
  for (const [grade, why, make] of cases) {
    const h = make();
    assertSane(h);
    assert.equal(h.grade, grade, `${why}: got ${h.grade} (${h.score}), flags ${flagsOf(h)}`);
    assert.ok(h.score >= GRADE_FLOOR[grade as keyof typeof GRADE_FLOOR]);
  }
});

test("more depth never lowers the score, and neither do more trades or a tighter spread", () => {
  const score = (a: HealthAsset, hours = steady(30, 12, 5, 1e7)) => run(a, hours).score;
  let last = -1;
  for (const pool of [1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11]) {
    const s = score({ id: "P", venues: ["QSwap"], poolQu: pool, poolAsset: pool / 10 }, steady(30, 12, 5, 1e7));
    assert.ok(s >= last, `pool ${pool}: ${s} < ${last}`);
    last = s;
  }
  last = -1;
  for (const perHour of [0, 1, 2, 5, 20, 100]) {
    const s = run(deep, perHour ? steady(30, 6, perHour, 1e7) : []).score;
    assert.ok(s >= last, `${perHour} trades an hour: ${s} < ${last}`);
    last = s;
  }
  last = 101;
  for (const ask of [101, 105, 120, 150, 300]) {
    const s = runQx({ id: "S", venues: ["QX"], bestBid: 100, bestAsk: ask, bidQty: 1e6, askQty: 1e6 }, steady(30, 12, 5, 1e7)).score;
    assert.ok(s <= last, `ask ${ask}: ${s} > ${last}`);
    last = s;
  }
});

/* ---------- depth and windows ---------- */

test("depth counts QX orders near the price and the pool's own 2% move, and says which it used", () => {
  // no pool: orders within 2% of the best price on each side
  const book = { bids: [{ price: 100, qty: 1000 }, { price: 99, qty: 500 }, { price: 90, qty: 10_000 }], asks: [{ price: 110, qty: 10 }, { price: 111, qty: 20 }, { price: 130, qty: 99 }] };
  const h = run({ id: "BOOK", venues: ["QX"] }, [], { book });
  assert.equal(h.metrics.qxDepthBasis, "full-book");
  assert.equal(h.metrics.qxBidDepthQu, 100 * 1000 + 99 * 500, "the bid at 90 is more than 2% below the best bid");
  assert.equal(h.metrics.qxAskDepthQu, 110 * 10 + 111 * 20);
  assert.equal(h.metrics.exitDepthQu, 149_500);
  assert.equal(h.metrics.qxMidQu, 105);
  assert.equal(h.metrics.spreadPct, round2((10 / 105) * 100));
  // with a pool: orders are near the pool's price, wherever the QX gap is, so a bid wall far below it is not depth
  const withPool = run({ id: "BOOK", venues: ["QX", "QSwap"], poolQu: 1e9, poolAsset: 1e7 }, [], { book: { bids: [{ price: 101, qty: 10 }, { price: 50, qty: 1e9 }], asks: [] } });
  assert.equal(withPool.metrics.qxBidDepthQu, 1010, "only the bid near the pool's price of 100 counts");
  assert.ok(Math.abs(withPool.metrics.exitDepthQu - (1010 + 1e9 * (1 - Math.sqrt(0.98)))) < 1);
  assert.ok(Math.abs(withPool.metrics.entryDepthQu - 1e9 * (Math.sqrt(1.02) - 1)) < 1);
  // constant product: a swap of that size moves the price by 2%
  const x = 1e9;
  const y = 1e7;
  const dx = withPool.metrics.entryDepthQu;
  assert.ok(Math.abs((((x + dx) ** 2) / (x * y)) / (x / y) - 1.02) < 1e-9);
});

test("a bid wall far from the pool price does not make a thin market look deep", () => {
  // the real shape of CFB's QX book: a huge bid at 1 QU while the pool prices it at 1.75
  const h = run({ id: "CFBISH", venues: ["QX", "QSwap"], bestBid: 1, bidQty: 1_850_000_000, bestAsk: 2, askQty: 57_000_000, poolQu: 3.3e9, poolAsset: 1.88e9 }, steady(30, 12, 5, 1e7));
  assert.equal(h.metrics.qxBidDepthQu, 0);
  assert.ok(h.metrics.exitDepthQu < 40_000_000);
});

test("24 hour, 7 day and 30 day numbers are the ones TradeIndex.volume and the candles report", async () => {
  const events = [
    qx(100, NOW - 2 * HOUR, "CFB", 10, 100), // 1,000 QU
    swap(6, 101, NOW - 23 * HOUR, "CFB", 500, 40),
    qx(102, NOW - 24 * HOUR + 10_000, "CFB", 10, 10), // in the hour that starts exactly 24 hours ago: it counts, as TradeIndex counts it
    qx(103, NOW - 25 * HOUR + 10_000, "CFB", 10, 10), // the hour before: outside the 24 hours, inside the week
    qx(104, NOW - 5 * DAY, "CFB", 20, 100),
    qx(105, NOW - 20 * DAY, "CFB", 20, 100),
    qx(106, NOW - 40 * DAY, "CFB", 20, 100),
  ];
  const idx = new TradeIndex(archive(events, { lastTick: 200 }), { days: 100 });
  await idx.update(NOW);
  const k = key("CFB");
  const h = assessHealth({ asset: { id: "CFB" }, hours: { QX: idx.hours(k, "QX"), QSwap: idx.hours(k, "QSwap") }, historySince: idx.stats().lowMs, now: NOW });
  for (const [ms, vol, n] of [[DAY, h.metrics.volume24hQu, h.metrics.trades24h], [7 * DAY, h.metrics.volume7dQu, h.metrics.trades7d], [30 * DAY, h.metrics.volume30dQu, h.metrics.trades30d]] as const) {
    const real = idx.volume(k, NOW - ms);
    assert.deepEqual([vol, n], [real.volumeQu, real.trades], `${ms / DAY} days`);
  }
  assert.deepEqual([h.metrics.trades24h, h.metrics.trades7d, h.metrics.trades30d], [3, 5, 6]);
  assert.equal(h.metrics.tradesQswap7d, 1);
  assert.equal(h.metrics.tradesQx7d, 4);
});

test("windows the history does not reach are unknown, not zero", () => {
  const h = run(deep, steady(10, 12, 5, 1e7), { historySince: NOW - 10 * DAY });
  assert.notEqual(h.metrics.trades7d, null);
  assert.equal(h.metrics.trades30d, null);
  assert.equal(h.metrics.volume30dQu, null);
  assert.equal(h.metrics.busiestHourShare30d, null);
  const young = run(deep, steady(2, 12, 5, 1e7), { historySince: NOW - 2 * DAY });
  assert.equal(young.metrics.trades7d, null);
  assert.equal(young.metrics.trades24h, 5 * 12 + 5, "24 hours is covered even though a week is not");
  assert.ok(young.partial);
  assert.match(young.reasons.join(" "), /has not finished loading/);
});

/* ---------- missing data ---------- */

test("no trade history at all: graded on the book alone, marked as an estimate, and never claims it does not trade", () => {
  const h = assessHealth({ asset: deep, hours: null, historySince: null, now: NOW });
  assertSane(h);
  assert.ok(h.partial);
  assert.equal(h.metrics.trades7d, null);
  assert.equal(h.metrics.volume24hQu, null);
  assert.ok(!h.flags.includes("quiet") && !h.flags.includes("few-trades"));
  assert.match(h.reasons.join(" "), /trade history is not available/);
  assert.match(h.reasons.at(-1)!, /estimate/);
  assert.ok(h.score < run(deep, GOOD).score, "an unchecked asset cannot score as well as a checked one");
});

test("a trade index that has not started scanning (its lowMs is 0) is not read as covering all of history", () => {
  const h = run(deep, [], { historySince: 0 });
  assert.ok(h.partial);
  assert.equal(h.metrics.trades7d, null);
  assert.ok(!h.flags.includes("quiet"), "an asset is not called quiet on the strength of a history that is not there");
  assert.match(h.reasons.join(" "), /has not finished loading/);
  assert.deepEqual(run(deep, [], { historySince: null }).flags, run(deep, [], { historySince: 0 }).flags);
});

test("no book and no pool numbers: says they could not be read instead of grading nothing as empty", () => {
  const h = run({ id: "BLIND", venues: ["QX", "QSwap"] }, GOOD);
  assertSane(h);
  assert.ok(h.partial);
  assert.ok(!h.flags.includes("no-market") && !h.flags.includes("thin-book"));
  assert.match(h.reasons.join(" "), /could not be read/);
  // with no venue list either it is the same
  assert.ok(run({ id: "BARE" }, GOOD).partial);
});

test("one venue only, no trades, a lone id: each still gives a sane answer", () => {
  assertSane(run({ id: "QXONLY", venues: ["QX"], bestBid: 5, bestAsk: 7, bidQty: 100, askQty: 100 }, []));
  assertSane(run({ id: "POOLONLY", venues: ["QSwap"], poolQu: 2e9, poolAsset: 1e9 }, GOOD));
  assertSane(run({ id: "ONLYID" }, []));
  assertSane(assessHealth({ asset: { id: "X" }, hours: { QX: [], QSwap: [] }, historySince: 0, now: NOW }));
  const pool = run({ id: "POOLONLY", venues: ["QSwap"], poolQu: 2e9, poolAsset: 1e9 }, GOOD);
  assert.equal(pool.metrics.spreadPct, null, "a pool has no spread");
  assert.equal(pool.metrics.qxDepthBasis, "none");
});

test("a catalogue that lists a pool but gives no reserves is marked partial", () => {
  const h = run({ id: "NOPOOL", venues: ["QX", "QSwap"], bestBid: 9, bestAsk: 10, bidQty: 100, askQty: 100 }, GOOD);
  assert.ok(h.partial);
});

/* ---------- determinism and safety ---------- */

test("the same input always gives the same answer, however the hours are ordered, and the input is left alone", () => {
  const rows = [...GOOD.filter((r) => r.hour < NOW - 3 * DAY), ...burst(10, 30)];
  const input = { asset: deep, hours: { QX: [] as HourSum[], QSwap: rows }, historySince: SINCE, now: NOW };
  const frozen = JSON.stringify(input);
  const first = assessHealth(input);
  assert.equal(JSON.stringify(input), frozen, "not modified");
  assert.deepEqual(assessHealth(input), first);
  const shuffled = { ...input, hours: { QX: [], QSwap: [...rows].reverse() } };
  assert.deepEqual(assessHealth(shuffled), first);
  assert.equal(JSON.stringify(assessHealth(JSON.parse(frozen))), JSON.stringify(first), "a copy gives byte-identical output");
});

test("NaN, Infinity, negative and nonsense values in any field never reach the output", () => {
  const junk: unknown[] = [NaN, Infinity, -Infinity, -1, 0, 1e308, "12", null, undefined, {}, [], 5e15, -5e15, Number.MAX_SAFE_INTEGER];
  const fields = ["priceQu", "liquidityQu", "bestBid", "bestAsk", "bidQty", "askQty", "poolQu", "poolAsset"] as const;
  let checked = 0;
  for (const field of fields) {
    for (const bad of junk) {
      const asset = { ...deep, [field]: bad } as unknown as HealthAsset;
      assertSane(run(asset, GOOD));
      checked++;
    }
  }
  // the same in the trade rows
  for (const field of ["hour", "n", "qu", "qty", "high", "low"] as const) {
    for (const bad of junk) {
      const rows = [...GOOD, { ...hr(5, 10, 1e6), [field]: bad } as unknown as HourSum, ...burst(40, 8, 2400, 103)];
      assertSane(run(deep, rows));
      assertSane(run(deep, rows.map((r) => ({ ...r, [field]: bad }) as unknown as HourSum)));
      checked += 2;
    }
  }
  // now, historySince, and a book full of junk
  for (const bad of junk) {
    assertSane(assessHealth({ asset: deep, hours: { QX: [], QSwap: GOOD }, historySince: bad as number, now: NOW }));
    assertSane(assessHealth({ asset: deep, hours: { QX: [], QSwap: GOOD }, historySince: SINCE, now: bad as number }));
    assertSane(run(deep, GOOD, { book: { bids: [{ price: bad as number, qty: 5 }, { price: 5, qty: bad as number }], asks: [{ price: bad as number, qty: bad as number }] } }));
    checked += 3;
  }
  // null and undefined where arrays are expected
  assertSane(assessHealth({ asset: deep, hours: { QX: undefined as unknown as HourSum[], QSwap: null as unknown as HourSum[] }, historySince: SINCE, now: NOW }));
  assertSane(assessHealth({ asset: { id: "X", venues: "QX" as unknown as [] }, hours: null, historySince: null, now: NOW }));
  assert.ok(checked > 200);
});

test("a zero-size world: zero volume, zero liquidity, zero everything", () => {
  const zero = [hr(1, 1, 0), hr(2, 3, 0, { high: 0, low: 0 })];
  assertSane(run({ id: "Z", venues: ["QX", "QSwap"], priceQu: 0, liquidityQu: 0, bestBid: 0, bestAsk: 0, bidQty: 0, askQty: 0, poolQu: 0, poolAsset: 0 }, zero));
  assertSane(run({ ...deep, liquidityQu: 0 }, zero));
  assert.equal(run({ ...deep, liquidityQu: 0 }, GOOD).metrics.turnover7d, null, "no division by a zero liquidity");
});

test("turnover is volume over the catalogue's liquidity", () => {
  const h = run({ ...deep, liquidityQu: 1e9 }, GOOD);
  assert.equal(h.metrics.turnover7d, h.metrics.volume7dQu! / 1e9);
  assert.equal(h.metrics.turnover24h, h.metrics.volume24hQu! / 1e9);
});

/* ---------- the real wash pattern ---------- */

test("regression: the real CFB epoch 211 pattern is flagged for exactly the days it was fresh, and nothing else is", () => {
  const swaps = toHours(REAL_CFB_SWAPS);
  const qxRows = toHours(REAL_CFB_QX);
  const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
  const check = (day: string) => assessHealth({ asset: { id: "CFB" }, hours: { QX: qxRows, QSwap: swaps }, historySince: Date.parse("2026-03-08T00:00:00Z"), now: at(day) });

  // the burst: 2026-05-01 02:00 to 2026-05-04 08:00 UTC, with a pause on the morning of the 2nd
  const mid = check("2026-05-03");
  assert.ok(mid.flags.includes("wash-suspected"));
  assert.match(mid.reasons[0], /^Looks like wash trading/);
  assert.equal(mid.metrics.washPeakPerHour, 2774, "the busiest real hour had 2,774 swaps");
  assert.equal(mid.metrics.washAvgTradeQu, 103, "and they averaged 103 QU each");
  assert.ok(mid.metrics.washLikeShare7d! > 0.99, "they are nearly all of the week's trades");
  assert.ok(mid.grade === "C" || mid.grade === "D", mid.grade);

  const suspected: string[] = [];
  const past: string[] = [];
  for (let t = at("2026-04-09"); t <= at("2026-05-16"); t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    const h = check(day);
    assertSane(h);
    if (h.flags.includes("wash-suspected")) suspected.push(day);
    if (h.flags.includes("wash-past")) past.push(day);
  }
  assert.equal(suspected[0], "2026-05-01");
  assert.equal(suspected.at(-1), "2026-05-10", "7 days after the last burst hour on 05-04 08:00 it drops out of the window");
  assert.equal(suspected.length, 10, "ten days in a row");
  assert.equal(past[0], "2026-05-11");
  assert.equal(past.at(-1), "2026-05-16");

  // before the main burst: one real hour of 2,073 swaps on 2026-04-03 is a burst, not an accusation
  const early = check("2026-04-05");
  assert.ok(early.flags.includes("bot-burst") && !early.flags.includes("wash-suspected"), flagsOf(early));
  assert.equal(early.metrics.washLikeHours7d, 1);
  // a week later it is out of the window and the asset looks like any other
  assert.deepEqual(check("2026-04-20").flags.filter((f) => f.startsWith("wash") || f === "bot-burst"), []);
});

/* ---------- the endpoints ---------- */

function setup(over: { assets?: HealthAsset[]; clock?: { now: number } } = {}) {
  const clock = over.clock ?? { now: NOW };
  const calls = { assets: 0, hours: 0 };
  const catalogue = over.assets ?? [deep, { ...deep, id: "WASHY" }, { id: "BARE" }];
  const hours: Record<string, HourSum[]> = { DEEP: GOOD, WASHY: [...GOOD.filter((r) => r.hour < NOW - 3 * DAY), ...burst(10, 30)] };
  const service = createHealth({
    assets: () => (calls.assets++, catalogue),
    hours: (a, venue) => {
      calls.hours++;
      if (a.id === "BROKEN") throw new Error("cannot encode this name");
      return venue === "QSwap" ? (hours[a.id] ?? []) : [];
    },
    historySince: () => SINCE,
    now: () => clock.now,
  });
  const route = (path: string) => service.routes.find((r) => r.path === path)!;
  const call = async (r: Route, query = "") => r.handler({ query: new URLSearchParams(query), body: undefined }) as Promise<any>;
  return { service, route, call, calls, clock, catalogue };
}

test("GET /v1/health returns the whole assessment for one asset, 404 for an unknown one, 400 without a parameter", async () => {
  const { route, call } = setup();
  const h = await call(route("/v1/health"), "asset=DEEP");
  assert.equal(h.asset, "DEEP");
  assert.equal(h.grade, "A");
  assert.deepEqual(Object.keys(h).sort(), ["asset", "computedAt", "flags", "grade", "metrics", "note", "partial", "reasons", "score"]);
  assert.equal(h.computedAt, new Date(NOW).toISOString());
  assert.match(h.note, /not financial advice/);
  assert.equal((await call(route("/v1/health"), "asset=deep")).asset, "DEEP", "case does not matter");
  await assert.rejects(async () => call(route("/v1/health"), "asset=NOPE"), (e) => e instanceof RouteError && e.status === 404 && /Unknown asset 'NOPE'/.test(e.message));
  await assert.rejects(async () => call(route("/v1/health"), ""), (e) => e instanceof RouteError && e.status === 400);
  await assert.rejects(async () => call(route("/v1/health"), "asset=%20"), (e) => e instanceof RouteError && e.status === 400);
});

test("GET /v1/health/all gives every asset's grade, score, flags and top reason, and is not rate limited", async () => {
  const { route, call, catalogue } = setup();
  assert.equal(route("/v1/health/all").limited, false, "cheap, cached");
  assert.notEqual(route("/v1/health").limited, false, "the single lookup keeps the default");
  const all = await call(route("/v1/health/all"));
  assert.deepEqual(Object.keys(all.assets), catalogue.map((a) => a.id));
  assert.deepEqual(Object.keys(all.assets.DEEP).sort(), ["flags", "grade", "reason", "score"]);
  assert.equal(all.assets.DEEP.grade, "A");
  assert.ok(all.assets.WASHY.flags.includes("wash-suspected"));
  assert.match(all.assets.WASHY.reason, /^Looks like wash trading/);
  assert.equal(all.computedAt, new Date(NOW).toISOString());
  // the two endpoints agree
  for (const id of Object.keys(all.assets)) {
    const one = await call(route("/v1/health"), `asset=${id}`);
    assert.deepEqual([one.grade, one.score, one.flags], [all.assets[id].grade, all.assets[id].score, all.assets[id].flags], id);
  }
});

test("the catalogue is graded once a minute however many ask", async () => {
  const { route, call, calls, clock } = setup();
  await call(route("/v1/health/all"));
  const first = { ...calls };
  assert.equal(first.assets, 1);
  assert.equal(first.hours, 6, "two venues for each of three assets");
  for (let i = 0; i < 20; i++) {
    await call(route("/v1/health/all"));
    await call(route("/v1/health"), "asset=DEEP");
  }
  clock.now = NOW + 59_000;
  await call(route("/v1/health/all"));
  assert.deepEqual(calls, first, "nothing recomputed in 59 seconds");
  clock.now = NOW + 61_000;
  const again = await call(route("/v1/health/all"));
  assert.equal(calls.assets, 2, "recomputed after a minute");
  assert.equal(again.computedAt, new Date(NOW + 61_000).toISOString());
  clock.now = NOW; // a clock that jumps back does not serve a stale answer for ever
  await call(route("/v1/health/all"));
  assert.equal(calls.assets, 3);
});

test("an asset that is not graded yet is graded the moment someone asks, and one that fails does not break the rest", async () => {
  const late: HealthAsset = { ...deep, id: "LATE" };
  const { route, call, catalogue } = setup();
  await call(route("/v1/health/all"));
  catalogue.push(late, { ...deep, id: "BROKEN" });
  assert.equal((await call(route("/v1/health"), "asset=late")).asset, "LATE", "found before the next minute");
  const broken = await call(route("/v1/health"), "asset=BROKEN");
  assert.ok(broken.partial, "graded without trades");
  assert.match(broken.reasons.join(" "), /trade history is not available/);
  assert.ok(Object.keys((await call(route("/v1/health/all"))).assets).includes("LATE"), "and it is in the list the same minute");
});

test("deps can use the catalogue's own entries, and no trade index means every asset is graded on its book and marked partial", async () => {
  const entries = [{ ...deep, symbol: "DEEP", issuer: "ISSUER" }];
  const seen: string[] = [];
  const withIndex = createHealth({ assets: () => entries, hours: (a, venue) => (seen.push(`${a.symbol}/${a.issuer}/${venue}`), []), historySince: () => SINCE, now: () => NOW });
  assert.equal(withIndex.health("DEEP")!.partial, false);
  assert.deepEqual(seen, ["DEEP/ISSUER/QX", "DEEP/ISSUER/QSwap"], "the typed entry reaches the hours function with its symbol and issuer");
  const none = createHealth({ assets: () => entries, hours: () => null, historySince: () => null, now: () => NOW });
  const h = none.health("DEEP")!;
  assert.ok(h.partial);
  assert.equal(h.metrics.trades7d, null);
  assert.equal(none.all().assets.DEEP.grade, h.grade);
});

test("washSuspected tells the pools feature which assets have inflated trade counts", () => {
  const { service } = setup();
  assert.equal(service.washSuspected("WASHY"), true);
  assert.equal(service.washSuspected("washy"), true);
  assert.equal(service.washSuspected("DEEP"), false);
  assert.equal(service.washSuspected("BARE"), false);
  assert.equal(service.washSuspected("NOPE"), false);
  assert.equal(service.health("NOPE"), null);
});

test("healthRoutes is the two routes, documented for the OpenAPI document", () => {
  const routes = healthRoutes({ assets: () => [], hours: () => [], historySince: () => null });
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ["GET /v1/health", "GET /v1/health/all"]);
  const one = routes[0].doc;
  assert.match(one.summary, /safe an asset is to trade/);
  assert.deepEqual((one.parameters as { name: string; required: boolean }[]).map((p) => [p.name, p.required]), [["asset", true]]);
  assert.ok(one.responses && "404" in one.responses);
  assert.match(routes[0].doc.description ?? "", /not financial advice/);
});

test("mounted in the real API server the two endpoints answer over HTTP and appear in the OpenAPI document", async () => {
  const { service } = setup();
  const data: MarketData = { assets: () => [], venues: async () => null };
  const server = createApi({ data, routes: service.routes, freePerMin: 100 });
  await new Promise<void>((r) => server.listen(0, () => r()));
  after(() => server.close());
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const r = await fetch(base + path);
    return { r, j: (await r.json()) as Record<string, any> };
  };
  const one = await get("/v1/health?asset=DEEP");
  assert.equal(one.r.status, 200);
  assert.equal(one.j.grade, "A");
  assert.equal((await get("/v1/health?asset=NOPE")).r.status, 404);
  assert.equal((await get("/v1/health")).r.status, 400);
  const all = await get("/v1/health/all");
  assert.equal(all.r.status, 200);
  assert.equal(all.j.assets.WASHY.flags.includes("wash-suspected"), true);
  const docs = (await get("/v1/openapi.json")).j;
  assert.match(docs.paths["/v1/health"].get.summary, /safe an asset is to trade/);
  assert.ok(docs.paths["/v1/health/all"].get);
});

test("an empty catalogue and a missing clock work", async () => {
  const service = createHealth({ assets: () => [], hours: () => [], historySince: () => null });
  const all = service.routes[1].handler({ query: new URLSearchParams(), body: undefined }) as { assets: object; computedAt: string };
  assert.deepEqual(all.assets, {});
  assert.ok(!Number.isNaN(Date.parse(all.computedAt)), "uses the real clock");
});

function round2(x: number) {
  return Math.round(x * 100) / 100;
}
