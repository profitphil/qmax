import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { Raw, RouteError, oneOf, required } from "../src/routes.ts";
import type { Route } from "../src/routes.ts";
import { Meter } from "../src/meter.ts";

const routes: Route[] = [
  {
    method: "GET",
    path: "/v1/demo",
    doc: { summary: "A demo endpoint", parameters: [{ name: "asset", in: "query", required: true, schema: { type: "string" } }] },
    handler: ({ query }) => {
      const asset = required(query, "asset");
      const mode = oneOf(query, "mode", ["fast", "slow"] as const, "fast");
      if (asset === "NOPE") throw new RouteError(404, "Unknown asset 'NOPE'", { hint: "try CFB" });
      return { asset, mode };
    },
  },
  { method: "GET", path: "/v1/file", doc: { summary: "A download" }, handler: () => new Raw("a,b\n1,2\n", "text/csv; charset=utf-8", "my file (1).csv") },
  { method: "POST", path: "/v1/echo", limited: false, doc: { summary: "Echo" }, handler: ({ body }) => ({ got: body }) },
];
const data: MarketData = { assets: () => [], venues: async () => null };
const server = createApi({ data, routes, freePerMin: 3 });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const get = (path: string) => fetch(base + path).then(async (r) => ({ r, j: (await r.json()) as Record<string, any> }));

test("a feature's endpoint is served, with its parameters checked", async () => {
  assert.deepEqual((await get("/v1/demo?asset=CFB")).j, { asset: "CFB", mode: "fast" });
  assert.deepEqual((await get("/v1/demo?asset=CFB&mode=slow")).j, { asset: "CFB", mode: "slow" });
  assert.equal((await get("/v1/demo")).r.status, 400);
  assert.equal((await get("/v1/demo?asset=CFB&mode=warp")).r.status, 400);
});

test("a refusal keeps its status and its extra fields", async () => {
  const { r, j } = await get("/v1/demo?asset=NOPE");
  assert.equal(r.status, 404);
  assert.equal(j.error, "Unknown asset 'NOPE'");
  assert.equal(j.hint, "try CFB");
});

test("a POST route gets the parsed body, and an unknown path is still a 404", async () => {
  const r = await fetch(base + "/v1/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
  assert.deepEqual(await r.json(), { got: { a: 1 } });
  assert.equal((await get("/v1/nothing")).r.status, 404);
});

test("a handler can return a download instead of JSON", async () => {
  const r = await fetch(base + "/v1/file");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/csv/);
  assert.equal(r.headers.get("content-disposition"), 'attachment; filename="my_file__1_.csv"', "the file name is made safe for a header");
  assert.equal(await r.text(), "a,b\n1,2\n");
});

test("the OpenAPI document describes the added endpoints beside the built-in ones", async () => {
  const { j } = await get("/v1/openapi.json");
  assert.equal(j.paths["/v1/demo"].get.summary, "A demo endpoint");
  assert.ok(j.paths["/v1/echo"].post);
  assert.ok(j.paths["/v1/quote"], "built-in endpoints are still there");
});

test("limited endpoints share the free per-minute allowance, and unlimited ones are exempt", async () => {
  // the free allowance is part of metering, so a meter has to be on for it to apply
  const meter = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE", lookupReceipt: async () => null });
  const s = createApi({ data, routes, meter, freePerMin: 2 });
  await new Promise<void>((r) => s.listen(0, () => r()));
  const b = `http://localhost:${(s.address() as AddressInfo).port}`;
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await fetch(`${b}/v1/demo?asset=CFB`)).status);
  const echo = await fetch(`${b}/v1/echo`, { method: "POST", body: "{}" });
  s.close();
  assert.deepEqual(codes, [200, 200, 429, 429]);
  assert.equal(echo.status, 200, "an unlimited route is not counted");
});
