import { test } from "node:test";
import assert from "node:assert/strict";
import { PriceFeed, aggregate, ceilSig, usdToQu } from "../bot/price.ts";
import type { PriceSource } from "../bot/price.ts";

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a / b - 1) < 1e-9, `${a} vs ${b}`);

test("readings become one price: the median of those that agree, from at least three sources", () => {
  near(aggregate([5.7e-7, 5.71e-7, 5.69e-7, 5.7e-7, 5.72e-7], null).price, 5.7e-7);
  near(aggregate([5.7e-7, 5.8e-7, 5.75e-7], null).price, 5.75e-7);
  // With fewer than three answering, one of them could be anything: no price is better than that one.
  assert.equal(aggregate([5.7e-7], null).price, null);
  assert.match(aggregate([5.7e-7], null).note, /only 1 source answered and at least 3 are needed/);
  assert.equal(aggregate([5.7e-7, 5.8e-7], null).price, null);
});

test("a reading far from the others is thrown out, and sources that split into camps are refused", () => {
  const withOutlier = aggregate([5.7e-7, 5.71e-7, 5.69e-7, 9e-7], null); // one source is wrong
  near(withOutlier.price, 5.7e-7);
  assert.equal(withOutlier.agreeing, 3);
  assert.equal(aggregate([5e-7, 9e-7], null).price, null); // two that disagree: no way to know which is right
  assert.equal(aggregate([4e-7, 5.7e-7, 9e-7], null).price, null); // nobody agrees with anybody
  assert.equal(aggregate([NaN, -1, 0], null).price, null);
  assert.equal(aggregate([], null).price, null);
});

test("a big move needs three sources behind it, and is taken a step at a time", () => {
  const last = 5e-7;
  assert.equal(aggregate([8e-7], last).price, null); // one source, +60%: not believed
  assert.equal(aggregate([8e-7, 8.1e-7], last).price, null); // two sources are too few to move anything
  assert.equal(aggregate([8e-7, 8.1e-7, 5e-7], last).price, null, "two of three behind +60% is not a majority to trust");
  // Three agree: the price really moved, but is taken 25% at a time, so a wrong (or bought) price cannot make the subscription nearly free at once.
  const step = aggregate([8e-7, 8.1e-7, 7.9e-7], last);
  near(step.price, 6.25e-7);
  assert.match(step.note, /a big move; taking it 25% at a time/);
  near(aggregate([8e-7, 8.1e-7, 7.9e-7], 6.25e-7).price, 7.8125e-7, ); // the next reading takes another step
  const down = aggregate([2e-7, 2.1e-7, 1.9e-7], last);
  near(down.price, 3.75e-7);
  near(aggregate([5.5e-7, 5.6e-7, 5.4e-7], last).price, 5.5e-7); // a normal move is taken as it is
});

test("tidy amounts: rounded up to three significant figures, never below QPayhub's 100 QU", () => {
  assert.equal(ceilSig(1_751_334), 1_760_000);
  assert.equal(ceilSig(1_750_000), 1_750_000);
  assert.equal(ceilSig(99), 99);
  assert.equal(ceilSig(0.5, 3), 0.5);
  assert.equal(usdToQu(1, 5.7e-7), 1_760_000); // $1 at $0.00000057 per QU is 1,754,386 QU
  assert.ok(usdToQu(1, 5.7e-7) * 5.7e-7 >= 1); // never less than a dollar
  assert.ok(usdToQu(1, 5.7e-7) * 5.7e-7 < 1.01); // and never more than 1% over
  assert.equal(usdToQu(0.00001, 5.7e-7), 100);
  assert.equal(usdToQu(1, 1), 100); // a dollar-per-QU price would be 1 QU; the minimum applies
});

const source = (name: string, fn: () => number): PriceSource => ({ name, fetch: async () => fn() });

test("the feed uses the median, keeps it for its time-to-live, then asks again", async () => {
  let t = 0;
  let calls = 0;
  const feed = new PriceFeed([source("a", () => (calls++, 5.7e-7)), source("b", () => 5.71e-7), source("c", () => 5.69e-7)], { now: () => t });
  near((await feed.rate()).usdPerQu, 5.7e-7);
  await feed.rate();
  assert.equal(calls, 1); // the second call used the stored price
  t = 5 * 60_000 + 1;
  await feed.rate();
  assert.equal(calls, 2);
});

test("simultaneous requests share one round of lookups", async () => {
  let calls = 0;
  const feed = new PriceFeed([source("a", () => (calls++, 5.7e-7)), source("b", () => 5.71e-7), source("c", () => 5.69e-7)]);
  await Promise.all([feed.rate(), feed.rate(), feed.rate()]);
  assert.equal(calls, 1);
});

test("one source down is fine; all down means the last good price for a while, then an honest error", async () => {
  let t = 0;
  let down = false;
  const failing = (v: number): PriceSource => ({ name: "x", fetch: async () => { if (down) throw new Error("boom"); return v; } });
  const logs: string[] = [];
  const feed = new PriceFeed([failing(5.7e-7), failing(5.71e-7), failing(5.69e-7), source("steady", () => 5.7e-7)], { now: () => t, log: (m) => logs.push(m) });
  near((await feed.rate()).usdPerQu, 5.7e-7);
  down = true;
  t += 10 * 60_000;
  near((await feed.rate()).usdPerQu, 5.7e-7); // three sources fail, one answers: too few, the last good price is kept
  assert.ok(logs.some((l) => l.includes("failed: boom")));
  assert.ok(logs.some((l) => l.includes("only 1 source answered")));
  t += 7 * 3_600_000;
  await assert.rejects(feed.rate(), /price is not available/); // too old to trust
});

test("a price that no source can back is not accepted, and the last good one stays", async () => {
  let t = 0;
  let values = [5.7e-7, 5.71e-7, 5.69e-7];
  const feed = new PriceFeed([source("a", () => values[0]), source("b", () => values[1]), source("c", () => values[2])], { now: () => t });
  near((await feed.rate()).usdPerQu, 5.7e-7);
  values = [5e-7, 9e-7, 7e-7]; // the three now disagree wildly
  t += 6 * 60_000;
  near((await feed.rate()).usdPerQu, 5.7e-7);
  const fresh = new PriceFeed([source("a", () => 5e-7), source("b", () => 9e-7), source("c", () => 7e-7)]);
  await assert.rejects(fresh.rate(), /not available/); // and with nothing good to fall back on there is no price
});

test("the last good price survives a restart, so the first reading after one is still checked against it", async () => {
  const saved: { usdPerQu: number; at: number }[] = [];
  const three = (v: number) => [source("a", () => v), source("b", () => v * 1.01), source("c", () => v * 0.99)];
  const first = new PriceFeed(three(5.7e-7), { now: () => 1000, save: (r) => saved.push(r) });
  await first.rate();
  assert.equal(saved.length, 1);
  assert.ok(Math.abs(saved[0].usdPerQu / 5.7e-7 - 1) < 1e-9);
  // After the restart a wildly different reading, even backed by all three, is only taken a step at a time from where it left off.
  const after = new PriceFeed(three(5.7e-6), { now: () => 1000 + 10 * 60_000, initial: { usdPerQu: saved[0].usdPerQu, at: saved[0].at, note: "saved" } });
  near((await after.rate()).usdPerQu, 5.7e-7 * 1.25);
  // And nothing is read from a saved price that is not a real number.
  const junk = new PriceFeed(three(5.7e-6), { now: () => 1000 + 10 * 60_000, initial: { usdPerQu: NaN, at: 1, note: "x" } });
  near((await junk.rate()).usdPerQu, 5.7e-6);
});
