import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";

const data: MarketData = {
  assets: () => ["CFB"],
  venues: async (a) =>
    a.toUpperCase() === "CFB"
      ? [new QxVenue({ asks: [{ price: 110, qty: 50 }], bids: [{ price: 100, qty: 50 }], buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 0 }), new QswapVenue({ reserveQu: 1_000_000, reserveAsset: 10_000, swapFeeRate: 30, fixedCostQu: 100_100 })]
      : null,
};
const server = createApi({ data, freeAccess: true, freePerMin: 3 });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("a caller is told its allowance on every limited call, and how long to wait once it is spent", async () => {
  const seen: [string | null, string | null, string | null][] = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/v1/quote?side=sell&asset=CFB&qty=10`);
    assert.equal(r.status, 200);
    seen.push([r.headers.get("x-ratelimit-limit"), r.headers.get("x-ratelimit-remaining"), r.headers.get("x-ratelimit-reset")]);
  }
  assert.deepEqual(seen.map((s) => s.slice(0, 2)), [["3", "2"], ["3", "1"], ["3", "0"]], "the allowance counts down");
  assert.ok(Number(seen[0][2]) >= 1 && Number(seen[0][2]) <= 60, "and says in seconds when it renews");
  const refused = await fetch(`${base}/v1/quote?side=sell&asset=CFB&qty=10`);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("x-ratelimit-remaining"), "0");
  assert.ok(Number(refused.headers.get("retry-after")) >= 1);
  const body = (await refused.json()) as { error: string; code: string; retryAfterSec: number };
  assert.equal(body.code, "rate_limited");
  assert.match(body.error, /Too many requests/);
  assert.ok(body.retryAfterSec >= 1);
});

test("the headers can be read by a page, so a browser-based agent can slow down too", async () => {
  const r = await fetch(`${base}/v1/assets`, { method: "OPTIONS" });
  const exposed = (r.headers.get("access-control-expose-headers") ?? "").split(",");
  for (const h of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) assert.ok(exposed.includes(h), h);
});

test("every error carries a steady code beside its sentence", async () => {
  // a fresh server, so the limit above does not get in the way
  const s = createApi({ data, freeAccess: true });
  await new Promise<void>((r) => s.listen(0, () => r()));
  try {
    const b = `http://localhost:${(s.address() as AddressInfo).port}`;
    const bad = await fetch(`${b}/v1/quote?side=sideways&asset=CFB&qty=10`);
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.assign({}, { code: ((await bad.json()) as { code: string }).code }), { code: "bad_request" });
    const unknown = await fetch(`${b}/v1/quote?side=sell&asset=NOPE&qty=10`);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code: string }).code, "not_found");
    const missing = await fetch(`${b}/v1/nothing-here`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code: string }).code, "not_found");
  } finally {
    s.close();
  }
});

test("a HEAD request to a route that is served at a path answers as the GET does, without the body", async () => {
  const { llmsRoutes } = await import("../src/llms.ts");
  const s = createApi({ data, freeAccess: true, routes: llmsRoutes({}) });
  await new Promise<void>((r) => s.listen(0, () => r()));
  try {
    const b = `http://localhost:${(s.address() as AddressInfo).port}`;
    const head = await fetch(`${b}/llms.txt`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(`${b}/llms.txt`)).status, 200);
  } finally {
    s.close();
  }
});
