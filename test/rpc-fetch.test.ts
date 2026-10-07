import test from "node:test";
import assert from "node:assert/strict";
import { QubicRpc } from "../src/rpc.ts";
import { QMaxClient } from "../sdk/client.ts";

// In a browser, window.fetch only works when it is called as a plain function. Calling it as a method of another
// object ("this.fetchFn(...)") throws "Illegal invocation", which broke every read through QubicRpc in the web app
// (open orders, My assets, fees, QPayhub receipts) while Node, which does not care, kept working.
const strict = (calls: unknown[]) =>
  function (this: unknown) {
    calls.push(this);
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
  } as unknown as typeof fetch;

test("the default fetch is called as a plain function, not as a method of the client", async () => {
  const real = globalThis.fetch;
  const calls: unknown[] = [];
  globalThis.fetch = strict(calls);
  try {
    const rpc = new QubicRpc({ baseUrl: "http://example.invalid", retries: 0, maxRps: 1000 });
    assert.deepEqual(await rpc.get("/x"), { ok: true });
    assert.deepEqual(await rpc.post("/y", {}), { ok: true });
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = real;
  }
});

test("an injected fetch is also called as a plain function", async () => {
  const calls: unknown[] = [];
  const rpc = new QubicRpc({ baseUrl: "http://example.invalid", retries: 0, maxRps: 1000, fetch: strict(calls) });
  assert.deepEqual(await rpc.get("/x"), { ok: true });
  assert.equal(calls.length, 1);
});

test("the SDK client calls the default fetch as a plain function too (it runs in browsers)", async () => {
  const real = globalThis.fetch;
  const calls: unknown[] = [];
  globalThis.fetch = strict(calls);
  try {
    const client = new QMaxClient({ baseUrl: "http://example.invalid" });
    await client.assets();
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});
