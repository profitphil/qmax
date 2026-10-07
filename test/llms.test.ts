import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { llmsRoutes, llmsText } from "../src/llms.ts";
import { Raw } from "../src/routes.ts";

/** /llms.txt is what an AI agent reads first: it must say the real address and the real prices, and nothing that is not so. */

test("with everything free it says so, and names no price", () => {
  const t = llmsText({});
  assert.match(t, /^# QMax\n/);
  assert.match(t, /^> QMax is a non-custodial liquidity router/m);
  assert.match(t, /API base URL: https:\/\/qmax\.exchange\/api/);
  assert.match(t, /\[OpenAPI document\]\(https:\/\/qmax\.exchange\/api\/v1\/openapi\.json\)/);
  assert.match(t, /Max plan.*Free\./);
  assert.doesNotMatch(t, /Paying for Max plans/);
  assert.doesNotMatch(t, /Costs \d/);
  assert.match(t, /limited to 60 requests a minute per IP/);
});

test("with a Max price it states the price and both ways to pay, from the same settings the API runs on", () => {
  const t = llmsText({ PUBLIC_BASE_URL: "https://example.org/api/", API_MAX_PRICE_QU: "250", API_SESSION_PRICE_QU: "30000", API_SESSION_SECONDS: "7200", API_FREE_PER_MIN: "20" });
  assert.match(t, /API base URL: https:\/\/example\.org\/api\n/, "the trailing slash is dropped");
  assert.match(t, /Costs 250 QU per plan for agents/);
  assert.match(t, /30,000 QU buys 2 hours of unlimited Max plans/);
  assert.match(t, /each plan takes 250 QU from the balance/);
  assert.match(t, /x-api-key/);
  assert.match(t, /network `qubic:mainnet`/);
  assert.match(t, /limited to 20 requests a minute per IP/);
  assert.match(t, /\[QMax website\]\(https:\/\/example\.org\/\)/, "the site is the API's address without /api");
  assert.doesNotMatch(t, /qmax\.exchange/, "nothing of the default address is left over");
});

test("it tells an agent where to download the MCP server and the SDK, from the site's own address", () => {
  const t = llmsText({});
  assert.match(t, /\[MCP server\]\(https:\/\/qmax\.exchange\/agents\/qmax-mcp\.mjs\)/);
  assert.match(t, /\[TypeScript SDK\]\(https:\/\/qmax\.exchange\/agents\/qmax-sdk\.tgz\)/);
  assert.match(t, /npm install https:\/\/qmax\.exchange\/agents\/qmax-sdk\.tgz/);
  assert.match(t, /\[SHA256SUMS\]\(https:\/\/qmax\.exchange\/agents\/SHA256SUMS\)/);
  assert.doesNotMatch(t, /qmax_best_position/, "free Max: nothing to warn about");
  const priced = llmsText({ PUBLIC_BASE_URL: "https://example.org/api", API_MAX_PRICE_QU: "100" });
  assert.match(priced, /\[MCP server\]\(https:\/\/example\.org\/agents\/qmax-mcp\.mjs\)/, "the site is the API's address without /api");
  assert.match(priced, /`qmax_best_position` \(Max\), which costs 100 QU a plan/);
});

test("with x402 off it does not offer a session", () => {
  const t = llmsText({ API_MAX_PRICE_QU: "100", API_X402: "off" });
  assert.doesNotMatch(t, /An x402 session/);
  assert.match(t, /A prepaid key/);
});

test("the tip jar is listed when there is one", () => {
  assert.doesNotMatch(llmsText({}), /Support QMax/);
  assert.match(llmsText({ SUPPORT_URL: "https://useqpay.com/s/abc" }), /\[Support QMax\]\(https:\/\/useqpay\.com\/s\/abc\)/);
});

test("it never claims that QMax signs or holds anything", () => {
  const t = llmsText({ API_MAX_PRICE_QU: "100" });
  assert.match(t, /never holds keys/);
  assert.match(t, /never signs or sends a transaction/);
});

const data: MarketData = { assets: () => [], venues: async () => null };
const server = createApi({ data, routes: llmsRoutes({ API_MAX_PRICE_QU: "100" }), publicUrl: "https://qmax.exchange/api/", freeAccess: true });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("the API serves it as plain text at /llms.txt", async () => {
  const r = await fetch(`${base}/llms.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /^text\/plain; charset=utf-8/);
  assert.match(await r.text(), /Costs 100 QU per plan/);
  assert.ok(llmsRoutes({})[0].handler({ query: new URLSearchParams(), body: undefined }) instanceof Raw);
});

test("the OpenAPI document names the API's public address, so a client builds URLs that work", async () => {
  const j = (await (await fetch(`${base}/v1/openapi.json`)).json()) as any;
  assert.deepEqual(j.servers, [{ url: "https://qmax.exchange/api" }]);
  assert.ok(j.paths["/llms.txt"].get);
  const plain = createApi({ data, freeAccess: true });
  await new Promise<void>((r) => plain.listen(0, () => r()));
  after(() => plain.close());
  const k = (await (await fetch(`http://localhost:${(plain.address() as AddressInfo).port}/v1/openapi.json`)).json()) as any;
  assert.equal(k.servers, undefined, "without a public address it says none");
});
