import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { identityToBytes } from "../src/identity.ts";
import { Meter } from "../src/meter.ts";
import type { Receipt } from "../src/qpay.ts";
import { RouteError } from "../src/routes.ts";
import type { Route } from "../src/routes.ts";
import { agentPlan, plansRoutes } from "../src/plans.ts";
import { apiResourceId } from "../src/topup.ts";
import { UsedLedger, X402Gate } from "../src/x402.ts";
import { PAYER, SELLER, fakeNetwork, header } from "./x402-helpers.ts";

/**
 * A Max quote costs agents API_MAX_PRICE_QU: from a prepaid key's balance, or free inside an x402 session. QMax's own keys and the website's own page never pay,
 * and the meter sells nothing else (the rest of the API stays free).
 */

const OWN_KEY = "own-key-own-key-own-key-1234";
const PRICE = 100;

/** A fake QPayhub: a top-up exists only for a payment the test "made". */
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

const routes: Route[] = [
  {
    method: "GET",
    path: "/v1/max",
    doc: { summary: "A stand-in for the Max planner" },
    handler: ({ query }) => {
      if (query.get("asset") === "BAD") throw new RouteError(400, "asset is not one QMax knows");
      return { plan: true, asset: query.get("asset") };
    },
  },
  { method: "GET", path: "/v1/other", doc: { summary: "Any other endpoint" }, handler: () => ({ other: true }) },
];
const data: MarketData = { assets: () => [], venues: async () => null };

const h = hub();
const net = fakeNetwork();
const meter = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: SELLER, lookupReceipt: h.lookup });
const gate = new X402Gate({ priceQu: 10_000, seconds: 3600, sellerId: SELLER, chain: net.chain, ledger: new UsedLedger(), secrets: { ticket: "t", grant: "g" } });
const priced = createApi({ data, routes, meter, x402: gate, apiKey: OWN_KEY, freeAccess: true, maxPriceQu: PRICE, freePerMin: 3 });
const free = createApi({ data, routes, freePerMin: 3 });
await Promise.all([priced, free].map((s) => new Promise<void>((r) => s.listen(0, () => r()))));
const urlOf = (s: typeof priced) => `http://localhost:${(s.address() as AddressInfo).port}`;
const base = urlOf(priced);
const freeBase = urlOf(free);
after(() => {
  priced.close();
  free.close();
});
const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers }).then(async (r) => ({ r, j: (await r.json()) as any }));
const post = (url: string, body: unknown = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ r, j: (await r.json()) as any }));
const max = `${base}/v1/max?asset=CFB`;

/** A key with `amount` QU of balance, paid for the way a top-up is. */
async function fundedKey(amount: number, nonce: string) {
  const k = await post(`${base}/v1/keys`);
  assert.equal(k.r.status, 201);
  h.pay(PAYER, k.j.keyId, nonce, amount);
  const claim = await post(`${base}/v1/topup/claim`, { keyId: k.j.keyId, payer: PAYER, nonce });
  assert.equal(claim.j.balanceQu, amount);
  return k.j.key as string;
}

test("with no price set, Max quotes are free for everyone, as before", async () => {
  assert.equal((await get(`${freeBase}/v1/max?asset=CFB`)).r.status, 200);
});

test("an agent with nothing to pay with is told the price and how to pay", async () => {
  const { r, j } = await get(max);
  assert.equal(r.status, 402);
  assert.equal(j.priceQu, PRICE);
  assert.match(j.error, /costs 100 QU/);
  assert.match(j.error, /POST \/v1\/keys/);
  assert.match(j.error, /x402/);
  assert.equal(j.x402Version, 2, "the 402 carries the x402 challenge too");
  assert.equal(j.accepts[0].amount, "10000", "an x402 session is the other way to pay");
});

test("the website's own page does not pay, and another site's page is not mistaken for it", async () => {
  assert.equal((await get(max, { "sec-fetch-site": "same-origin" })).r.status, 200);
  assert.equal((await get(max, { "sec-fetch-site": "cross-site" })).r.status, 402);
  assert.equal((await get(max, { "sec-fetch-site": "same-site" })).r.status, 402);
});

test("QMax's own key (the Discord bot) never pays", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await get(max, { "x-api-key": OWN_KEY })).r.status, 200);
});

test("a prepaid key pays the price per quote, shown in the headers, until its balance runs out", async () => {
  const key = await fundedKey(300, "11");
  const first = await get(max, { "x-api-key": key });
  assert.equal(first.r.status, 200);
  assert.equal(first.j.plan, true);
  assert.equal(first.r.headers.get("x-qmax-charged-qu"), "100");
  assert.equal(first.r.headers.get("x-qmax-balance-qu"), "200");
  assert.equal((await get(max, { "x-api-key": key })).r.headers.get("x-qmax-balance-qu"), "100");
  assert.equal((await get(max, { "x-api-key": key })).r.headers.get("x-qmax-balance-qu"), "0");
  const broke = await get(max, { "x-api-key": key });
  assert.equal(broke.r.status, 402);
  assert.equal(broke.j.priceQu, PRICE);
  assert.equal(broke.j.balanceQu, 0);
  assert.match(broke.j.error, /Top up with GET \/v1\/topup/);
});

test("a quote that cannot be made costs nothing", async () => {
  const key = await fundedKey(100, "12");
  const bad = await get(`${base}/v1/max?asset=BAD`, { "x-api-key": key });
  assert.equal(bad.r.status, 400);
  const account = await get(`${base}/v1/account`, { "x-api-key": key });
  assert.equal(account.j.balanceQu, 100, "the refused request was not charged");
  assert.equal((await get(max, { "x-api-key": key })).r.status, 200, "and the balance still buys the next quote");
});

test("a key that does not exist is refused, and a paid caller is not held to the free per-minute limit", async () => {
  assert.equal((await get(max, { "x-api-key": "qm_nope" })).r.status, 401);
  const key = await fundedKey(100 * 8, "13");
  for (let i = 0; i < 8; i++) assert.equal((await get(max, { "x-api-key": key })).r.status, 200, `quote ${i + 1}`); // the free limit here is 3 a minute
});

test("everything else stays free: no charge, no key needed", async () => {
  const key = await fundedKey(500, "14");
  const other = await get(`${base}/v1/other`, { "x-api-key": key });
  assert.equal(other.r.status, 200);
  assert.equal(other.r.headers.get("x-qmax-charged-qu"), null);
  assert.equal((await get(`${base}/v1/account`, { "x-api-key": key })).j.balanceQu, 500);
  assert.equal((await get(`${base}/v1/other`)).r.status, 200, "no key at all");
});

test("a key's account tells it the Max price, not the old per-call prices that are not charged here", async () => {
  const k = await post(`${base}/v1/keys`);
  assert.equal(k.j.maxPriceQu, PRICE);
  assert.equal(k.j.splitPriceQu, undefined);
  const info = await get(`${base}/v1/x402`);
  assert.equal(info.j.maxQuotePriceQu, PRICE);
});

test("an x402 session covers Max quotes: pay once, then no per-quote charge", async () => {
  const challenge = await get(max);
  assert.equal(challenge.r.status, 402);
  const { txId } = net.pay(challenge.j);
  const bought = await get(max, { "x-payment": header(challenge.j, { txHash: txId }) });
  assert.equal(bought.r.status, 200, "the quote asked for comes back in the same round trip");
  const grant = bought.r.headers.get("x-access-grant")!;
  assert.ok(grant);
  for (let i = 0; i < 6; i++) assert.equal((await get(max, { "x-access-grant": grant })).r.status, 200); // past the free limit of 3 a minute, and no key
  assert.equal((await get(max)).r.status, 402, "a stranger without the session still pays");
});

test("agentPlan says what agents pay from the same settings the API starts with", () => {
  assert.deepEqual(agentPlan({}), { maxPriceQu: null, sessionPriceQu: null, sessionSeconds: null, minTopupQu: null }, "everything free: nothing sold, no sessions");
  assert.deepEqual(agentPlan({ API_MAX_PRICE_QU: "100" }), { maxPriceQu: 100, sessionPriceQu: 10_000, sessionSeconds: 3600, minTopupQu: 10_000 });
  assert.deepEqual(agentPlan({ API_MAX_PRICE_QU: "100", API_SESSION_PRICE_QU: "25,000", API_SESSION_SECONDS: "7200", API_MIN_TOPUP_QU: "50000" }), { maxPriceQu: 100, sessionPriceQu: 25_000, sessionSeconds: 7200, minTopupQu: 50_000 });
  assert.deepEqual(agentPlan({ API_MAX_PRICE_QU: "100", API_X402: "off" }), { maxPriceQu: 100, sessionPriceQu: null, sessionSeconds: null, minTopupQu: 10_000 }, "x402 can be turned off (a prepaid key still works)");
  assert.deepEqual(agentPlan({ API_ACCESS: "billing" }), { maxPriceQu: null, sessionPriceQu: 10_000, sessionSeconds: 3600, minTopupQu: 10_000 }, "billing mode sells sessions, with Max free");
  assert.equal(agentPlan({ API_MAX_PRICE_QU: "lots" }).maxPriceQu, null, "a bad number is no price");
  assert.equal(agentPlan({ API_MAX_PRICE_QU: "-5" }).maxPriceQu, null);
});

test("/v1/plans carries the agent prices for the welcome window", async () => {
  const [route] = plansRoutes({ API_MAX_PRICE_QU: "100" });
  const out = (await route.handler({ query: new URLSearchParams(), body: undefined })) as any;
  assert.deepEqual(out.agents, { maxPriceQu: 100, sessionPriceQu: 10_000, sessionSeconds: 3600, minTopupQu: 10_000 });
  assert.ok(out.support && out.discord, "the rest of the answer is unchanged");
});

test("the OpenAPI intro says what is true: free, except Max plans for agents, with the ways to pay", async () => {
  const { j } = await get(`${base}/v1/openapi.json`);
  const text: string = j.info.description;
  assert.match(text, /Billing: everything is free for everyone/);
  assert.match(text, /Max plans .* cost 100 QU for agents/);
  assert.match(text, /prepaid key/);
  assert.match(text, /x402 session .*10,000 QU for 1 hour of unlimited plans/);
  assert.match(text, /website's own Max is free/);
  assert.doesNotMatch(text, /split quote .* costs a prepaid amount \(100 QU by default\)/, "no charges that do not exist here");
  assert.match(j.paths["/v1/keys"].post.responses["201"].description, /maxPriceQu/);
  assert.doesNotMatch(j.paths["/v1/keys"].post.responses["201"].description, /splitPriceQu/);
  // a server with no price at all just says it is free
  const plain = (await get(`${freeBase}/v1/openapi.json`)).j.info.description as string;
  assert.match(plain, /Billing: everything is free for everyone/);
  assert.doesNotMatch(plain, /Max plans/);
});

test("a server that bills everything keeps its own billing text", async () => {
  const m = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: SELLER, lookupReceipt: h.lookup });
  const billed = createApi({ data, routes, meter: m });
  await new Promise<void>((r) => billed.listen(0, () => r()));
  after(() => billed.close());
  const text = (await get(`${urlOf(billed)}/v1/openapi.json`)).j.info.description as string;
  assert.match(text, /only a split quote/);
  assert.match(text, /50 QU by default/);
});

test("/v1/x402 says what a session covers here, and how to get one for Max", async () => {
  const { j } = await get(`${base}/v1/x402`);
  assert.match(j.covers, /Max plans/);
  assert.match(j.how, /GET \/v1\/max/);
  assert.match(j.how, /Everything else is free/);
  assert.equal(j.session.priceQu, 10_000);
});
