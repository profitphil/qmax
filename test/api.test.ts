import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApi } from "../src/api.ts";
import { SnapshotData } from "../src/data.ts";

let server: Server;
let base = "";
const open = (apiKey?: string) =>
  new Promise<void>((resolve) => {
    server = createApi({ data: SnapshotData.fromFile("examples/snapshot.json"), apiKey });
    server.listen(0, () => {
      base = `http://localhost:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });

before(() => open());
after(() => server.close());

test("GET /v1/quote returns a route", async () => {
  const r = await fetch(`${base}/v1/quote?side=buy&asset=demo&qty=100000`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.fillable, true);
  assert.equal(j.route.length, 2);
  assert.equal(j.routingFee, undefined); // no per-trade fee
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("POST /v1/quote works with a JSON body", async () => {
  const r = await fetch(`${base}/v1/quote`, { method: "POST", body: JSON.stringify({ side: "sell", asset: "DEMO", qty: 500 }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).side, "sell");
});

test("validation and unknown asset errors", async () => {
  assert.equal((await fetch(`${base}/v1/quote?side=hold&asset=DEMO&qty=1`)).status, 400);
  assert.equal((await fetch(`${base}/v1/quote?side=buy&asset=DEMO&qty=-5`)).status, 400);
  assert.equal((await fetch(`${base}/v1/quote?side=buy&asset=NOPE&qty=5`)).status, 404);
});

test("unfillable order is reported, not an error", async () => {
  const j = await (await fetch(`${base}/v1/quote?side=buy&asset=DEMO&qty=999999999`)).json();
  assert.equal(j.fillable, false);
  assert.equal(j.route.length, 0);
});

test("api key is enforced when configured", async () => {
  server.close();
  await open("secret");
  assert.equal((await fetch(`${base}/v1/quote?side=buy&asset=DEMO&qty=1`)).status, 401);
  const ok = await fetch(`${base}/v1/quote?side=buy&asset=DEMO&qty=1`, { headers: { "x-api-key": "secret" } });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("a free API lets anyone in without a key, limits them per IP, and never limits QMax's own key", async () => {
  const s = createApi({ data: SnapshotData.fromFile("examples/snapshot.json"), apiKey: "internal", freeAccess: true, freePerMin: 3 });
  await new Promise<void>((r) => s.listen(0, () => r()));
  try {
    const base = `http://localhost:${(s.address() as import("node:net").AddressInfo).port}`;
    const asset = ((await (await fetch(base + "/v1/assets")).json()) as { assets: { id: string }[] }).assets[0].id;
    const q = (headers: Record<string, string> = {}) => fetch(`${base}/v1/quote?side=buy&asset=${asset}&qty=1`, { headers });
    assert.equal((await q()).status, 200, "no key needed");
    assert.equal((await q({ "x-api-key": "someone-elses-key" })).status, 200, "another key is ignored, not refused");
    assert.equal((await q()).status, 200);
    const limited = await q();
    assert.equal(limited.status, 429, "past the free allowance");
    const body = (await limited.json()) as { error: string };
    assert.doesNotMatch(body.error, /key|402|prepay|session/i, "and the message does not try to sell anything");
    for (let i = 0; i < 10; i++) assert.equal((await q({ "x-api-key": "internal" })).status, 200, "QMax's own key is never limited");
    assert.equal((await fetch(base + "/v1/keys", { method: "POST" })).status, 404, "there is nothing to prepay");
    assert.equal((await fetch(base + "/v1/x402")).status, 404, "and no sessions to buy");
  } finally {
    s.close();
  }
});
