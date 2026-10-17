import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { mcpHandler } from "../src/mcphost.ts";
import { QswapVenue, QxVenue } from "../src/venues.ts";
import tools from "../mcp/tools.ts";

const data: MarketData = {
  assets: () => ["CFB"],
  venues: async (a) =>
    a.toUpperCase() === "CFB"
      ? [new QxVenue({ asks: [{ price: 110, qty: 50 }], bids: [{ price: 100, qty: 50 }, { price: 95, qty: 100 }], buyerFeeRate: 0, sellerFeeRate: 0.003, fixedCostQu: 0 }), new QswapVenue({ reserveQu: 1_000_000, reserveAsset: 10_000, swapFeeRate: 30, fixedCostQu: 100_100 })]
      : null,
};
const server = createApi({ data, freeAccess: true, mcp: mcpHandler() });
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

async function connect() {
  const client = new Client({ name: "test-assistant", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

test("an assistant connects over HTTP, is told what QMax is, and lists every free tool but not the paid one", async () => {
  const client = await connect();
  assert.equal(client.getServerVersion()?.name, "qmax-mcp-server");
  assert.match(client.getInstructions() ?? "", /Everything here is free, needs no key/);
  const { tools: listed } = await client.listTools();
  const names = listed.map((t) => t.name);
  assert.deepEqual(names.sort(), tools.filter((t) => !t.paid).map((t) => t.name).sort());
  assert.ok(!names.includes("qmax_best_position"), "the Max plan costs QU: a hosted endpoint cannot pay for the caller");
  assert.ok(names.includes("qmax_get_quote") && names.includes("qmax_build_plan"));
  assert.ok(listed.every((t) => t.annotations?.readOnlyHint === true));
  await client.close();
});

test("a quote through MCP is the real quote, with its summary in words", async () => {
  const client = await connect();
  const r = JSON.parse(text(await client.callTool({ name: "qmax_get_quote", arguments: { side: "sell", asset: "CFB", qty: 100 } })));
  assert.equal(r.fillable, true);
  assert.ok(r.totalQu > 0);
  assert.match(r.summary, /^Selling 100 CFB by the best route would return about [\d,]+ QU/);
  // the same figure the HTTP API gives for the same order
  const direct = (await (await fetch(`${base}/v1/quote?side=sell&asset=CFB&qty=100`)).json()) as { totalQu: number };
  assert.equal(r.totalQu, direct.totalQu);
  const unknown = await client.callTool({ name: "qmax_get_quote", arguments: { side: "sell", asset: "NOPE", qty: 1 } });
  assert.equal((unknown as { isError?: boolean }).isError, true, "a failed call is an error result the assistant can read, not a crash");
  await client.close();
});

test("it is stateless: no session to open or end, and a plain GET or DELETE is told so", async () => {
  for (const method of ["GET", "DELETE"]) {
    const r = await fetch(`${base}/mcp`, { method });
    assert.equal(r.status, 405, method);
    assert.match(r.headers.get("allow") ?? "", /POST/);
    assert.equal(((await r.json()) as { jsonrpc: string }).jsonrpc, "2.0");
  }
  const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{nope" });
  assert.equal(bad.status, 400);
});

test("a browser-based assistant may call it: the preflight allows the MCP headers", async () => {
  const r = await fetch(`${base}/mcp`, { method: "OPTIONS" });
  assert.equal(r.status, 204);
  const allowed = (r.headers.get("access-control-allow-headers") ?? "").split(",");
  for (const h of ["content-type", "mcp-protocol-version", "mcp-session-id"]) assert.ok(allowed.includes(h), h);
  const post = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(post.headers.get("access-control-allow-origin"), "*");
});

test("an API without the hosted MCP does not serve it", async () => {
  const bare = createApi({ data, freeAccess: true });
  await new Promise<void>((r) => bare.listen(0, () => r()));
  try {
    const r = await fetch(`http://localhost:${(bare.address() as AddressInfo).port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 404);
  } finally {
    bare.close();
  }
});

test("the calls an assistant makes are limited per address, like the rest of the API", async () => {
  const limited = createApi({ data, freeAccess: true, mcp: mcpHandler() });
  await new Promise<void>((r) => limited.listen(0, () => r()));
  try {
    const url = `http://localhost:${(limited.address() as AddressInfo).port}/mcp`;
    const call = () => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await call()).status;
    assert.equal(last, 429);
    const refused = await call();
    assert.equal(((await refused.json()) as { code: string }).code, "rate_limited");
  } finally {
    limited.close();
  }
});

test("the registry entry (mcp/server.json) names this hosted endpoint and keeps to the registry's rules", async () => {
  const { readFileSync } = await import("node:fs");
  const entry = JSON.parse(readFileSync(new URL("../mcp/server.json", import.meta.url), "utf8")) as { $schema: string; name: string; description: string; version: string; remotes: { type: string; url: string }[] };
  assert.match(entry.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
  assert.match(entry.name, /^io\.github\.profitphil\/[a-zA-Z0-9._-]+$/, "a GitHub-verified name starts with the GitHub user's own name");
  assert.ok(entry.description.length > 20 && entry.description.length <= 100, `the registry refuses a description over 100 characters (this is ${entry.description.length})`);
  assert.deepEqual(entry.remotes, [{ type: "streamable-http", url: "https://qmax.exchange/api/mcp" }]);
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
});
