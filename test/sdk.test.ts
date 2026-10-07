import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import { SnapshotData } from "../src/data.ts";
import { identityToBytes } from "../src/identity.ts";
import { Meter } from "../src/meter.ts";
import { RefLog } from "../src/refs.ts";
import { HistoryStore } from "../src/history.ts";
import { apiResourceId } from "../src/topup.ts";
import type { Receipt } from "../src/qpay.ts";
import { QMaxClient, QMaxError, buildDeepLink, buildExecutionPlan, depthChartSvg, parseDeepLink, priceChartSvg, stepDestinationKey } from "../sdk/index.ts";

const RECIPIENT = "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE";
const PAYER = "QXMRTKAIIGLUREPIQPCMHCKWSIPDTUYFCFNYXQLTECSUJVYEMMDELBMDOEYB";
const paid = new Map<string, number>();
const idOf = (payer: string, rid: Uint8Array, nonce: bigint) => `${payer}|${[...rid].join(",")}|${nonce}`;
const meter = new Meter({
  splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: RECIPIENT,
  lookupReceipt: async (payer, seller, rid, nonce): Promise<Receipt | null> => {
    const amountPaid = paid.get(idOf(payer, rid, nonce));
    return amountPaid === undefined ? null : { amountPaid, fee: 100, seller: identityToBytes(seller) };
  },
});
const refs = new RefLog();
const info = { issuer: "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL", assetName: "DEMO", transferFeeQu: { qx: 100, qswap: 100 } };
class Executable extends SnapshotData {
  async assetInfo() {
    return { symbol: "DEMO", ...info };
  }
}
const data = new Executable([JSON.parse(readFileSync("examples/snapshot.json", "utf8"))]);
const demo = new SnapshotData([JSON.parse(readFileSync("examples/snapshot.json", "utf8"))]);
const history = new HistoryStore();
for (let k = 0; k < 10; k++) history.record("DEMO", { t: Date.now() - (9 - k) * 3_600_000, price: 100 + k, bid: 99 + k, ask: 101 + k, pool: 100 + k, liq: 5 });
const server = createApi({ data, meter, refs, history, apiKey: "internal" });
await new Promise<void>((r) => server.listen(0, () => r()));
const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const asset = data.assets()[0];

test("a partner's whole journey: key, top-up, claim, quotes, plan", async () => {
  const anon = new QMaxClient({ baseUrl });
  const { key, keyId } = await anon.createKey();
  const site = new QMaxClient({ baseUrl, apiKey: key });
  assert.equal((await site.account()).balanceQu, 0);

  // a split quote with nothing prepaid: refused, and the error says what it would have saved
  await assert.rejects(site.quote({ side: "buy", asset, qty: 100_000 }), (e: unknown) => {
    assert.ok(e instanceof QMaxError);
    assert.equal(e.status, 402);
    assert.equal(e.needsTopup, true);
    assert.ok((e.body.splitWouldSaveQu as number) > 0);
    return true;
  });
  // the same order priced on one venue is free, and so is a small order that never splits
  const single = await site.quote({ side: "buy", asset, qty: 100_000, split: false });
  assert.equal(single.route.length, 1);

  const tx = await site.topupTransaction(keyId, 10_200);
  assert.equal(tx.contractIndex, 29);
  paid.set(idOf(PAYER, apiResourceId(keyId), BigInt(tx.nonce)), 10_200); // the partner signs and sends it
  assert.deepEqual(await site.claimTopup({ keyId, payer: PAYER, nonce: tx.nonce }), { ok: true, creditedQu: 10_200, balanceQu: 10_200 });

  const split = await site.quote({ side: "buy", asset, qty: 100_000 });
  assert.equal(split.route.length, 2);
  assert.ok(split.totalQu < single.totalQu);
  assert.equal((await site.account()).balanceQu, 10_100);
  assert.equal((await site.arbitrage(asset, { minProfitQu: 1 })).bothMarkets, true);

  // the quote becomes the transactions to sign: a QX bid and a QSwap swap, with the limits already in
  const plan = buildExecutionPlan(split);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["qx-bid", "qswap-buy"]);
  assert.deepEqual(plan.steps.map((s) => s.to), [{ contractIndex: 1 }, { contractIndex: 13 }]);
  assert.equal((await anon.assets()).length > 0, true);
});

test("a wrong key is a clear 401", async () => {
  await assert.rejects(new QMaxClient({ baseUrl, apiKey: "qm_wrong" }).account(), (e: unknown) => e instanceof QMaxError && e.status === 401);
});

test("step destinations: a contract is its index in the first byte, an identity is its own key", () => {
  const swap = stepDestinationKey({ contractIndex: 13 });
  assert.equal(swap.length, 32);
  assert.deepEqual([swap[0], swap.slice(1).every((b) => b === 0)], [13, true]);
  assert.deepEqual([...stepDestinationKey({ identity: RECIPIENT })], [...identityToBytes(RECIPIENT)]);
});

test("links send a user to QMax with the order filled in, and bad input is refused", () => {
  const link = buildDeepLink("https://qmax.example/", { asset: "cfb", side: "sell", qty: 2500, ref: "qubictrade" });
  assert.equal(link, "https://qmax.example/?asset=CFB&side=sell&qty=2500&ref=qubictrade");
  assert.deepEqual(parseDeepLink(new URL(link).search), { asset: "CFB", side: "sell", qty: 2500, ref: "qubictrade" });
  assert.deepEqual(parseDeepLink("?asset=QX"), { asset: "QX", side: "buy" }); // side defaults to buy, qty and ref are optional
  assert.equal(parseDeepLink("?side=buy"), null);
  assert.equal(parseDeepLink("?asset=TOO-LONG-NAME"), null);
  assert.deepEqual(parseDeepLink("?asset=CFB&qty=-5&ref=bad ref!"), { asset: "CFB", side: "buy" }); // junk is dropped, not trusted
  assert.throws(() => buildDeepLink("https://x", { asset: "CFB", side: "buy", qty: 1.5 }), /whole number/);
  assert.throws(() => buildDeepLink("https://x", { asset: "CFB", side: "buy", ref: "no spaces" }), /ref must be/);
});

test("referrals are counted from the link, and only QMax's key can read them", async () => {
  const post = (body: unknown) => fetch(`${baseUrl}/v1/ref`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ ref: "qubictrade", event: "open" })).status, 200);
  assert.equal((await post({ ref: "qubictrade", event: "open" })).status, 200);
  const txId = "a".repeat(60);
  assert.equal((await post({ ref: "qubictrade", event: "trade", txIds: [txId] })).status, 200);
  assert.equal((await post({ ref: "qubictrade", event: "trade", txIds: ["nope"] })).status, 400); // a trade needs real-looking transaction ids
  assert.equal((await post({ ref: "bad ref!", event: "open" })).status, 400);
  assert.equal((await post({ ref: "x", event: "sell" })).status, 400);
  assert.equal((await fetch(`${baseUrl}/v1/refs`)).status, 401);
  const summary = (await (await fetch(`${baseUrl}/v1/refs`, { headers: { "x-api-key": "internal" } })).json()) as { refs: Record<string, { opens: number; trades: number }>; recentTrades: { txIds: string[] }[] };
  assert.deepEqual([summary.refs.qubictrade.opens, summary.refs.qubictrade.trades], [2, 1]);
  assert.deepEqual(summary.recentTrades[0].txIds, [txId]);
});

test("a quote from a demo server cannot be turned into transactions, and says why", async () => {
  const s = createApi({ data: demo });
  await new Promise<void>((r) => s.listen(0, () => r()));
  const quote = await new QMaxClient({ baseUrl: `http://localhost:${(s.address() as AddressInfo).port}` }).quote({ side: "buy", asset: demo.assets()[0], qty: 1000 });
  s.close();
  assert.throws(() => buildExecutionPlan(quote), /serving demo data/);
});

test("the SDK reads the order book and recorded history, and can draw them", async () => {
  const c = new QMaxClient({ baseUrl });
  const book = await c.book(asset, 5);
  assert.equal(book.asset, "DEMO");
  assert.ok(book.qx && book.qx.asks.length > 0 && book.qx.asks.length <= 5);
  assert.ok(book.qswap && book.qswap.depth.length === 5);
  const h = await c.history(asset, "1d", "4h");
  assert.equal(h.points.length, 10);
  assert.ok(h.candles && h.candles.length >= 3);
  assert.match(priceChartSvg(h.points, { symbol: "DEMO", rangeLabel: "1D" }), /^<svg /);
  assert.match(depthChartSvg(book.qx!, { symbol: "DEMO" }), /DEMO order book depth/);
  await assert.rejects(c.book("NOPE"), (e: unknown) => e instanceof QMaxError && e.status === 404);
});

test("max() asks for a plan with only the numbers given, and a Max price shows up as a 402 carrying it", async () => {
  const seen: string[] = [];
  const stub = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ error: "A Max quote costs 100 QU for agents.", priceQu: 100 }), { status: 402, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const c = new QMaxClient({ baseUrl: "http://x.test", fetch: stub });
  await assert.rejects(
    () => c.max({ asset: "CFB", side: "sell", heldQty: 500, avgCostQu: 12 }),
    (e: unknown) => e instanceof QMaxError && e.status === 402 && e.body.priceQu === 100,
  );
  const q = new URL(seen[0]).searchParams;
  assert.equal(new URL(seen[0]).pathname, "/v1/max");
  assert.deepEqual([q.get("asset"), q.get("side"), q.get("heldQty"), q.get("avgCostQu")], ["CFB", "sell", "500", "12"]);
  assert.equal(q.has("qty"), false, "what was not given is not sent");
  assert.equal(q.has("balanceQu"), false);
});
