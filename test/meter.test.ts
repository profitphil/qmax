import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import { SnapshotData } from "../src/data.ts";
import { identityToBytes } from "../src/identity.ts";
import { Meter } from "../src/meter.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { apiResourceId } from "../src/topup.ts";
import type { Receipt } from "../src/qpay.ts";

const RECIPIENT = "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE";
const PAYER = "QXMRTKAIIGLUREPIQPCMHCKWSIPDTUYFCFNYXQLTECSUJVYEMMDELBMDOEYB";
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** A fake QPayhub: receipts exist only for payments the test "made", keyed like the contract does (payer, resource, nonce). */
function hub() {
  const paid = new Map<string, number>();
  const id = (payer: string, rid: Uint8Array, nonce: bigint) => `${payer}|${[...rid].join(",")}|${nonce}`;
  return {
    pay: (payer: string, keyId: string, nonce: string, amount: number) => paid.set(id(payer, apiResourceId(keyId), BigInt(nonce)), amount),
    lookup: async (payer: string, seller: string, rid: Uint8Array, nonce: bigint): Promise<Receipt | null> => {
      const amountPaid = paid.get(id(payer, rid, nonce));
      return amountPaid === undefined ? null : { amountPaid, fee: 100, seller: identityToBytes(seller) };
    },
  };
}

const newMeter = (h = hub()) => ({ h, meter: new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: RECIPIENT, lookupReceipt: h.lookup }) });

test("the top-up transaction pays QPayhub with a receipt that names the key", () => {
  const { meter } = newMeter();
  const { keyId } = meter.createKey();
  const tx = meter.topup(keyId, 50_000, 7n);
  assert.equal(tx.contractIndex, 29);
  assert.equal(tx.inputType, 1);
  assert.equal(tx.amountQu, 50_000);
  const payload = Uint8Array.from(atob(tx.payload), (c) => c.charCodeAt(0));
  assert.equal(payload.length, 72);
  assert.deepEqual([...payload.slice(0, 32)], [...identityToBytes(RECIPIENT)]);
  assert.deepEqual([...payload.slice(32, 64)], [...apiResourceId(keyId)]);
  assert.equal(view(payload).getBigUint64(64, true), 7n);
  assert.throws(() => meter.topup(keyId, 9_999), /amountQu must be/);
  assert.throws(() => meter.topup("0".repeat(32), 50_000), /Unknown keyId/);
});

test("a confirmed top-up becomes balance once, and a charge takes the price", async () => {
  const { h, meter } = newMeter();
  const { key, keyId } = meter.createKey();
  assert.equal(meter.charge(keyId, 100), false); // nothing prepaid yet
  assert.deepEqual(await meter.claim({ keyId, payer: PAYER, nonce: "5" }), { ok: false, reason: "QPayhub has no receipt for this payment yet. Wait for the transaction to be confirmed and try again." });
  h.pay(PAYER, keyId, "5", 10_000);
  assert.deepEqual(await meter.claim({ keyId, payer: PAYER, nonce: "5" }), { ok: true, creditedQu: 10_000, balanceQu: 10_000 });
  const again = await meter.claim({ keyId, payer: PAYER, nonce: "5" });
  assert.equal(again.ok, false); // the same payment cannot be counted twice
  assert.equal(meter.find(key)!.account.balanceQu, 10_000);
  assert.equal(meter.charge(keyId, 100), true);
  assert.equal(meter.info(keyId)!.balanceQu, 9_900);
  assert.equal(meter.info(keyId)!.calls, 1);
});

test("a payment can only fill the key it names, and parallel claims count once", async () => {
  const { h, meter } = newMeter();
  const a = meter.createKey();
  const b = meter.createKey();
  h.pay(PAYER, a.keyId, "1", 20_000);
  assert.equal((await meter.claim({ keyId: b.keyId, payer: PAYER, nonce: "1" })).ok, false); // receipt names key a, not b
  const results = await Promise.all([1, 2, 3].map(() => meter.claim({ keyId: a.keyId, payer: PAYER, nonce: "1" })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(meter.info(a.keyId)!.balanceQu, 20_000);
  assert.equal(meter.info(b.keyId)!.balanceQu, 0);
});

test("bad claim input is refused before anything is looked up", async () => {
  const { meter } = newMeter();
  const { keyId } = meter.createKey();
  for (const bad of [{ keyId: "nope", payer: PAYER, nonce: "1" }, { keyId, payer: "short", nonce: "1" }, { keyId, payer: PAYER, nonce: "-1" }, { keyId, payer: PAYER, nonce: "99999999999999999999" }])
    assert.equal((await meter.claim(bad)).ok, false);
});

test("the rate limiter allows the limit, then waits for the window", () => {
  const l = new RateLimiter(2, 1000);
  assert.equal(l.hit("a", 0).ok, true);
  assert.equal(l.hit("a", 10).ok, true);
  const third = l.hit("a", 20);
  assert.deepEqual(third, { ok: false, retryAfterSec: 1 });
  assert.equal(l.hit("b", 20).ok, true); // other callers are not affected
  assert.equal(l.hit("a", 1001).ok, true);
});

// ---- over HTTP ----
const { h, meter } = newMeter();
const data = new SnapshotData([JSON.parse(readFileSync("examples/snapshot.json", "utf8"))]);
const server = createApi({ data, meter, apiKey: "internal", freePerMin: 6 });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const asset = data.assets()[0];
// In the demo data 100,000 is best split across QX and QSwap, and 1,000 is best on QX alone.
const splitUrl = `${base}/v1/quote?side=buy&asset=${asset}&qty=100000`;
const singleUrl = `${base}/v1/quote?side=buy&asset=${asset}&qty=1000`;
const json = (url: string, init?: RequestInit) => fetch(url, init).then(async (r) => ({ r, j: (await r.json()) as Record<string, any> }));

test("without a key, quotes are limited per IP and free endpoints are not", async () => {
  for (let i = 0; i < 6; i++) assert.equal((await json(splitUrl)).r.status, 200);
  const { r, j } = await json(splitUrl);
  assert.equal(r.status, 429);
  assert.match(j.error, /POST \/v1\/keys/);
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  assert.equal((await json(`${base}/v1/assets`)).r.status, 200);
  assert.equal((await json(`${base}/v1/openapi.json`)).r.status, 200);
});

test("the full prepaid flow: only a split quote is billed", async () => {
  const created = await json(`${base}/v1/keys`, { method: "POST" });
  assert.equal(created.r.status, 201);
  const { key, keyId } = created.j;
  assert.match(key, /^qm_[0-9a-f]{48}$/);
  assert.deepEqual([created.j.splitPriceQu, created.j.arbitragePriceQu], [100, 50]);
  const hdr = { "x-api-key": key };

  // single-venue quotes cost nothing, even with an empty balance
  const free = await json(singleUrl, { headers: hdr });
  assert.equal(free.r.status, 200);
  assert.equal(free.j.route.length, 1);
  assert.equal(free.r.headers.get("x-qmax-charged-qu"), "0");
  // a split with nothing prepaid is refused, and says what it would have saved
  const empty = await json(splitUrl, { headers: hdr });
  assert.equal(empty.r.status, 402);
  assert.equal(empty.j.priceQu, 100);
  assert.ok(empty.j.splitWouldSaveQu > 0);
  assert.equal(empty.j.route, undefined); // the route itself is withheld
  assert.equal((await json(`${base}/v1/account`, { headers: { "x-api-key": "qm_wrong" } })).r.status, 401);

  const tx = (await json(`${base}/v1/topup?keyId=${keyId}&amountQu=10200`)).j;
  assert.equal(tx.contractIndex, 29);
  assert.equal((await json(`${base}/v1/topup?keyId=${keyId}&amountQu=5`)).r.status, 400);
  const claim = (nonce: string) => json(`${base}/v1/topup/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyId, payer: PAYER, nonce }) });
  assert.equal((await claim(tx.nonce)).r.status, 400); // not paid yet
  h.pay(PAYER, keyId, tx.nonce, 10_200);
  const credited = await claim(tx.nonce);
  assert.deepEqual([credited.r.status, credited.j.creditedQu, credited.j.balanceQu], [200, 10_200, 10_200]);
  assert.equal((await claim(tx.nonce)).r.status, 400); // once only

  const ok = await json(splitUrl, { headers: hdr });
  assert.equal(ok.r.status, 200);
  assert.equal(ok.j.route.length, 2);
  assert.equal(ok.r.headers.get("x-qmax-charged-qu"), "100");
  assert.equal(ok.r.headers.get("x-qmax-balance-qu"), "10100");
  assert.equal((await json(`${base}/v1/account`, { headers: hdr })).j.balanceQu, 10_100);
  // a failed call, a single-venue quote and the free endpoints are not billed
  assert.equal((await json(`${base}/v1/quote?side=buy&asset=NOPE&qty=1`, { headers: hdr })).r.status, 404);
  assert.equal((await json(singleUrl, { headers: hdr })).r.status, 200);
  assert.equal((await json(`${base}/v1/assets`, { headers: hdr })).r.status, 200);
  assert.equal((await json(`${base}/v1/account`, { headers: hdr })).j.balanceQu, 10_100);
  // and a key is not held to the free per-minute limit
  for (let i = 0; i < 8; i++) assert.equal((await json(splitUrl, { headers: hdr })).r.status, 200);
  assert.equal((await json(`${base}/v1/account`, { headers: hdr })).j.balanceQu, 10_100 - 800);
});

test("QMax's own key is never charged or limited", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await json(splitUrl, { headers: { "x-api-key": "internal" } })).r.status, 200);
});

// ---- arbitrage billing: a market where QX sells at 80 and QSwap pays about 100 ----
import { QswapVenue, QxVenue } from "../src/venues.ts";
import type { MarketData } from "../src/data.ts";

const arbMarket = (profitable: boolean): MarketData => ({
  assets: () => ["ARB"],
  venues: async () => [
    new QxVenue({ asks: [{ price: profitable ? 80 : 105, qty: 200_000 }], bids: [{ price: 70, qty: 1000 }], buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 100, truncated: false }),
    new QswapVenue({ reserveQu: 100_000_000, reserveAsset: 1_000_000, swapFeeRate: 30, fixedCostQu: 100_100 }),
  ],
});

test("an arbitrage result is billed only when one is found", async () => {
  const m = newMeter();
  const open = createApi({ data: arbMarket(true), meter: m.meter });
  const none = createApi({ data: arbMarket(false), meter: m.meter });
  await Promise.all([open, none].map((s) => new Promise<void>((r) => s.listen(0, () => r()))));
  const url = (s: typeof open) => `http://localhost:${(s.address() as AddressInfo).port}/v1/arbitrage?asset=ARB`;
  const { key, keyId } = m.meter.createKey();
  const hdr = { "x-api-key": key };

  const free = await json(url(none), { headers: hdr });
  assert.deepEqual([free.r.status, free.j.opportunity, free.r.headers.get("x-qmax-charged-qu")], [200, null, "0"]); // "none right now" is free

  const broke = await json(url(open), { headers: hdr });
  assert.equal(broke.r.status, 402);
  assert.ok(broke.j.opportunityProfitQu > 0);
  assert.equal(broke.j.priceQu, 50);
  assert.equal(broke.j.opportunity, undefined); // direction and size are withheld

  m.h.pay(PAYER, keyId, "3", 10_000);
  await m.meter.claim({ keyId, payer: PAYER, nonce: "3" });
  const paid = await json(url(open), { headers: hdr });
  assert.equal(paid.r.status, 200);
  assert.equal(paid.j.opportunity.direction, "buy-qx-sell-qswap");
  assert.equal(paid.r.headers.get("x-qmax-charged-qu"), "50"); // arbitrage has its own price
  assert.equal(m.meter.info(keyId)!.balanceQu, 9_950);
  assert.equal((await json(url(none), { headers: hdr })).r.status, 200);
  assert.equal(m.meter.info(keyId)!.balanceQu, 9_950);
  open.close();
  none.close();
});

test("arbitrage filters work over the API: a budget finds a smaller loop, an impossible minimum is free, junk is refused", async () => {
  const m = newMeter();
  const open = createApi({ data: arbMarket(true), meter: m.meter });
  await new Promise<void>((r) => open.listen(0, () => r()));
  const url = (q: string) => `http://localhost:${(open.address() as AddressInfo).port}/v1/arbitrage?asset=ARB${q}`;
  const { key, keyId } = m.meter.createKey();
  const hdr = { "x-api-key": key };
  m.h.pay(PAYER, keyId, "4", 10_000);
  await m.meter.claim({ keyId, payer: PAYER, nonce: "4" });

  const all = await json(url(""), { headers: hdr });
  const capped = await json(url("&maxCostQu=1000000"), { headers: hdr });
  assert.ok(capped.j.opportunity.costQu <= 1_000_000);
  assert.ok(capped.j.opportunity.profitQu < all.j.opportunity.profitQu);
  const before = m.meter.info(keyId)!.balanceQu;
  const none = await json(url(`&minProfitQu=${Math.ceil(all.j.opportunity.profitQu) + 1}`), { headers: hdr });
  assert.equal(none.j.opportunity, null); // nothing clears your minimum, so nothing is billed
  assert.equal(m.meter.info(keyId)!.balanceQu, before);
  assert.equal((await json(url("&minProfitPct=-2"), { headers: hdr })).r.status, 400);
  assert.equal((await json(url("&maxCostQu=lots"), { headers: hdr })).r.status, 400);
  open.close();
});
