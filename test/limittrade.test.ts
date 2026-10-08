import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookView, QxBook } from "../src/book.ts";
import { executeLimitOrder, prepareLimitOrder } from "../src/limittrade.ts";
import type { LimitEnv, LimitRequest } from "../src/limittrade.ts";
import type { OpenOrder, Snapshot } from "../src/verify.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const WALLET = "A".repeat(59) + "B";
const row = (price: number, qty: number, cumQty = qty, cumQu = qty * price) => ({ price, qty, orders: 1, cumQty, cumQu });

/** A QDOGE book: sellers at 24 (500 units) and 25 (1,000); buyers at 22 (300) and 20 (700). */
const qx = (over: Partial<QxBook> = {}): QxBook => ({
  asks: [row(24, 500), row(25, 1000, 1500, 500 * 24 + 1000 * 25)],
  bids: [row(22, 300), row(20, 700, 1000, 300 * 22 + 700 * 20)],
  bestAsk: 24, bestBid: 22, mid: 23, spreadPct: 8.7,
  asksTotal: { levels: 2, orders: 2, qty: 1500 }, bidsTotal: { levels: 2, orders: 2, qty: 1000 }, truncated: false, ...over,
});
const book = (b: QxBook | null = qx()): BookView => ({ qx: b, qswap: null });

const req = (over: Partial<LimitRequest> = {}): LimitRequest => ({ side: "buy", assetId: "QDOGE", assetName: "QDOGE", issuer: ISSUER, qty: 1000, price: 23, ...over });

function rig(o: { balance?: number; holdings?: Record<number, number>; open?: OpenOrder[]; book?: BookView | Error; runOk?: boolean } = {}) {
  const snaps: Snapshot[] = [];
  let reads = 0;
  const calls: string[] = [];
  const env: LimitEnv = {
    snapshot: async () => {
      calls.push("snapshot");
      reads++;
      return snaps.length ? snaps[Math.min(snaps.length - 1, reads - 1)] : { balanceQu: o.balance ?? 100_000_000, holdings: o.holdings ?? { 1: 5000 } };
    },
    openOrders: async () => (calls.push("open"), o.open ?? []),
    fees: async () => ({ qx: 100, qswap: 100 }),
    book: async () => {
      if (o.book instanceof Error) throw o.book;
      return o.book ?? book();
    },
    run: async (_w, steps) => (calls.push(`run:${steps.map((s) => s.kind).join("+")}`), o.runOk ?? true),
    sleep: async () => {},
  };
  return { env, snaps, calls };
}

test("a buy below the market is a bid that waits: it locks price x quantity and says how far the market is", async () => {
  const { env } = rig();
  const p = await prepareLimitOrder(env, req({ price: 22 }), WALLET);
  assert.deepEqual(p.plan.steps.map((s) => s.kind), ["qx-bid"]);
  assert.equal(p.plan.maxOutlayQu, 22 * 1000);
  assert.equal(p.plan.steps[0].amountQu, 22_000);
  assert.equal(p.placement!.kind, "rests");
  assert.ok(Math.abs((p.placement as { away: number }).away - (2 / 24) * 100) < 1e-9, "the best seller is 2 QU (8.3%) above");
  assert.ok(Math.abs(p.farPct! - ((22 - 23) / 23) * 100) < 1e-9);
});

test("a buy at or above the best seller matches at once, at the prices resting there, and the rest waits", async () => {
  const { env } = rig();
  const p = await prepareLimitOrder(env, req({ price: 24, qty: 800 }), WALLET);
  assert.equal(p.placement!.kind, "fills-now");
  const f = p.placement as { fillQty: number; restQty: number; costQu: number; avgPrice: number };
  assert.equal(f.fillQty, 500);
  assert.equal(f.restQty, 300);
  assert.equal(f.costQu, 12_000);
  assert.equal(f.avgPrice, 24);
  assert.equal(p.plan.maxOutlayQu, 24 * 800); // the most it could cost: what does not match stays locked
});

test("a sale lists shares at the price and attaches nothing; it only offers shares the wallet has free", async () => {
  const { env } = rig({ holdings: { 1: 5000 }, open: [{ side: "ask", price: 30, qty: 4500 }] });
  const ok = await prepareLimitOrder(env, req({ side: "sell", price: 26, qty: 400 }), WALLET);
  assert.deepEqual(ok.plan.steps.map((s) => s.kind), ["qx-ask"]);
  assert.equal(ok.plan.maxOutlayQu, 0);
  // 5,000 held, 4,500 already offered: only 500 are free
  await assert.rejects(prepareLimitOrder(env, req({ side: "sell", price: 26, qty: 600 }), WALLET), /already offered in your other open sell orders/);
});

test("shares that QSwap manages are moved to QX first, for the fee the contracts charge", async () => {
  const { env } = rig({ holdings: { 13: 1000 } });
  const p = await prepareLimitOrder(env, req({ side: "sell", price: 26, qty: 400 }), WALLET);
  assert.deepEqual(p.plan.steps.map((s) => s.kind), ["transfer-rights", "qx-ask"]);
  assert.equal(p.plan.steps[0].amountQu, 100);
  assert.equal(p.plan.maxOutlayQu, 100);
});

test("a wallet that cannot cover the order is refused before anything is signed, and a bad price or size says why", async () => {
  const { env, calls } = rig({ balance: 10_000 });
  await assert.rejects(prepareLimitOrder(env, req({ price: 22 }), WALLET), /Not enough QU: this order needs up to 22,000 QU in the wallet and the wallet has 10,000 QU/);
  assert.ok(!calls.some((c) => c.startsWith("run")));
  await assert.rejects(prepareLimitOrder(env, req({ price: 0 }), WALLET), /price must be a whole number/);
  await assert.rejects(prepareLimitOrder(env, req({ price: 24.5 }), WALLET), /whole number of QU/);
  await assert.rejects(prepareLimitOrder(env, req({ qty: 0 }), WALLET), /whole number of units/);
  await assert.rejects(prepareLimitOrder(env, req({ issuer: "" }), WALLET), /no issuer on record/);
});

test("an order is still prepared when the book cannot be read: it just cannot say where the order would land", async () => {
  const { env } = rig({ book: new Error("down") });
  const p = await prepareLimitOrder(env, req({ price: 22 }), WALLET);
  assert.equal(p.placement, null);
  assert.equal(p.farPct, null);
  assert.equal(p.plan.steps.length, 1);
});

test("placing the order signs the plan, then reads the wallet and the book again and says what it did", async () => {
  const { env, calls } = rig();
  const p = await prepareLimitOrder(env, req({ price: 24, qty: 800 }), WALLET);
  // The wallet and the book change when the order is sent: 500 units matched at 24 and 300 are left waiting on the book.
  let sent = false;
  env.run = async (_w, steps, _sign, onState) => {
    sent = true;
    for (const s of steps) onState(s.id, { status: "done", txId: "tx" });
    return true;
  };
  env.snapshot = async () => (sent ? { balanceQu: 100_000_000 - 800 * 24, holdings: { 1: 500 } } : { balanceQu: 100_000_000, holdings: { 1: 0 } });
  env.openOrders = async () => (sent ? [{ side: "bid", price: 24, qty: 300 }] : []);
  const states: string[] = [];
  const r = await executeLimitOrder(env, p, WALLET, async () => ({ tx: new Uint8Array(4) }), (id, s) => states.push(`${id}:${s.status}`));
  assert.equal(r.ok, true);
  assert.deepEqual(states, ["qx-bid:done"]);
  assert.equal(r.result!.restedQty, 300, "300 units now wait on the book at 24");
  assert.equal(r.result!.filledQty, 500, "500 matched at once");
  void calls;
});

test("an order that only waits reports nothing matched and the units resting", async () => {
  const { env } = rig();
  const p = await prepareLimitOrder(env, req({ price: 22, qty: 100 }), WALLET);
  let sent = false;
  env.run = async () => ((sent = true), true);
  env.snapshot = async () => (sent ? { balanceQu: 100_000_000 - 2200, holdings: { 1: 0 } } : { balanceQu: 100_000_000, holdings: { 1: 0 } });
  env.openOrders = async () => (sent ? [{ side: "bid", price: 22, qty: 100 }, { side: "bid", price: 21, qty: 50 }] : [{ side: "bid", price: 21, qty: 50 }]);
  const r = await executeLimitOrder(env, p, WALLET, async () => ({ tx: new Uint8Array(4) }), () => {});
  assert.equal(r.result!.filledQty, 0);
  assert.equal(r.result!.restedQty, 100, "only the orders at this price count, and only what is new");
});

test("if signing does not finish nothing is read back and no result is claimed", async () => {
  const { env } = rig({ runOk: false });
  const p = await prepareLimitOrder(env, req({ price: 22 }), WALLET);
  const r = await executeLimitOrder(env, p, WALLET, async () => ({ tx: new Uint8Array(4) }), () => {});
  assert.equal(r.ok, false);
  assert.equal(r.result, null);
});

// The bot's source is not in the public copy of the repository: this test is skipped there.
const botHere = (await import("node:fs")).existsSync(new URL("../bot/index.ts", import.meta.url)) ? false : "bot/ is not in this copy";

test("the bot asks for no more book levels than the API allows (it refuses more than 50, and the order would then never say where it lands)", { skip: botHere }, async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bot/index.ts", import.meta.url), "utf8");
  const asked = [...src.matchAll(/api\.book\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(asked.length >= 2, "the bot reads the book in more than one place");
  for (const a of asked) {
    const n = Number(a.split(",")[1]);
    if (Number.isFinite(n)) assert.ok(n >= 1 && n <= 50, `api.book(${a}) asks for more than the API gives`);
  }
  const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  assert.match(api, /levels > 50/); // the limit this test is about
});
