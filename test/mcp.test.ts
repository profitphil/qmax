import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApi } from "../src/api.ts";
import { SnapshotData } from "../src/data.ts";
import { QMaxError } from "../sdk/client.ts";
import { setFeeReader } from "../mcp/tools.ts";
import type { QuoteResponse } from "../src/apitypes.ts";
import tools, { explain, fit } from "../mcp/tools.ts";
import type { QMaxApi } from "../mcp/tools.ts";

process.env.QMAX_MCP_NO_START = "1";
const { createServer } = await import("../mcp/server.ts");

/** A quote the way the API returns it for a split buy with execution hints, so build_plan can run for real. */
const quote: QuoteResponse = {
  asset: "CFB",
  side: "buy",
  qty: 1000,
  filledQty: 1000,
  fillable: true,
  totalQu: 9_800,
  averagePriceQu: 9.8,
  slippageBps: 100,
  executable: true,
  assetInfo: { issuer: "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL", assetName: "CFB", transferFeeQu: { qx: 100, qswap: 100 } },
  route: [
    { venue: "QX", qty: 600, shareOfOrder: 0.6, totalQu: 5_800, effectivePriceQu: 9.66, priceImpact: 0.01, feesQu: 100, fixedCostQu: 0, priceRangeQu: { best: 9, worst: 10 }, execution: { type: "qx-bid", qty: 600, limitPrice: 10 } },
    { venue: "QSwap", qty: 400, shareOfOrder: 0.4, totalQu: 4_000, effectivePriceQu: 10, priceImpact: 0.02, feesQu: 12, fixedCostQu: 0, execution: { type: "qswap-buy", qty: 400, maxQuIn: 4_040 } },
  ],
  alternatives: [
    { venue: "QX", fillable: true, totalQu: 10_000, effectivePriceQu: 10 },
    { venue: "QSwap", fillable: true, totalQu: 10_400, effectivePriceQu: 10.4 },
  ],
  warnings: [],
  quotedAt: "2026-10-04T12:00:00.000Z",
} as unknown as QuoteResponse;

setFeeReader(async () => ({ qx: 100, qswap: 100 })); // no network in tests
const calls: string[] = [];
const fake: QMaxApi = {
  assets: async () => [{ id: "CFB", symbol: "CFB", category: "token", venues: ["QX", "QSwap"], priceQu: 10, liquidityQu: 5e9, activity: "active" }] as never,
  quote: async (req) => (calls.push(`quote ${req.side} ${req.asset} ${req.qty}`), quote),
  arbitrage: async () => ({ asset: "CFB", checkedAt: "now", bothMarkets: true, opportunity: null }) as never,
  book: async () => ({ asset: "CFB" }) as never,
  candles: async (asset, range, opts) => ({ asset, range, interval: opts?.interval ?? "1h", venue: "QX", candles: Array.from({ length: 4000 }, (_, i) => ({ t: i, o: 1, h: 2, l: 1, c: 2, volumeQu: 10, volumeQty: 5, trades: 1 })), volume24hQu: 1, trades24h: 1 }) as never,
  history: async () => ({ asset: "CFB", range: "7d", since: 1, recordedSince: 2, points: [{ t: 1, price: 5, bid: null, ask: null, pool: null, liq: 0, src: "trades" }] }) as never,
  premium: async () => ({ points: [] }) as never,
  pools: async () => ({ pools: [{ id: "A" }, { id: "B" }, { id: "C" }] }) as never,
  poolDetail: async () => ({}) as never,
  backtest: async () => ({ equity: Array.from({ length: 500 }, (_, i) => ({ t: i, valueQu: i })), trades: Array.from({ length: 100 }, (_, i) => ({ t: i })), summary: "ok" }) as never,
  health: async (a) => ({ asset: a, grade: "C", score: 55 }) as never,
  healthAll: async () => ({ assets: {}, computedAt: "now" }) as never,
  tape: async () => ({ trades: [], latestId: 0, instance: "x", flow24h: {} }) as never,
  flow: async () => ({}) as never,
  swapQuote: async () => ({}) as never,
  ledger: async () => ({ entries: [] }) as never,
  liquidityPositions: async (identity) => ({ identity, positions: [], poolsChecked: 3, failed: [], complete: true }) as never,
  liquidityPool: async (asset) => ({ asset, reserveQu: 1, reserveAsset: 1 }) as never,
  max: async (req) => (calls.push(`max ${req.side} ${req.asset}`), { asset: req.asset, side: req.side, picks: [] }) as never,
};

async function connect(api: QMaxApi) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(api);
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);

test("every tool has a unique snake_case name with the qmax_ prefix, a title and a real description", () => {
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of tools) {
    assert.match(t.name, /^qmax_[a-z_]+$/);
    assert.ok(t.title.length > 5 && t.description.length > 80, t.name);
  }
});

test("an agent can list the tools and each is marked read-only", async () => {
  const { client } = await connect(fake);
  const { tools: listed } = await client.listTools();
  assert.equal(listed.length, tools.length);
  assert.ok(listed.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false));
  assert.ok(listed.some((t) => t.name === "qmax_build_plan" && /UNSIGNED|signs nothing/i.test(t.description ?? "")));
});

test("a quote comes back reduced to what an agent decides with, including what routing saved", async () => {
  const { client } = await connect(fake);
  const r = JSON.parse(text(await client.callTool({ name: "qmax_get_quote", arguments: { side: "buy", asset: "CFB", qty: 1000 } })));
  assert.equal(r.totalQu, 9_800);
  assert.equal(r.route.length, 2);
  assert.match(r.routingSaving, /saves you 200 QU \(2\.0%\) versus the best single market/);
  assert.equal(r.assetInfo, undefined, "internal details are not passed along");
  assert.ok(calls.includes("quote buy CFB 1000"));
});

test("a plan lists the exact unsigned steps in order with the most that can leave the wallet, and a warning", async () => {
  const { client } = await connect(fake);
  const r = JSON.parse(text(await client.callTool({ name: "qmax_build_plan", arguments: { side: "buy", asset: "CFB", qty: 1000 } })));
  assert.deepEqual(r.steps.map((s: { kind: string }) => s.kind), ["qx-bid", "qswap-buy"]);
  assert.equal(r.maxOutlayQu, 600 * 10 + (4_040 + 100_000), "a QX bid locks limit x quantity; a QSwap buy attaches the worst-case input plus its flat fee");
  assert.ok(r.steps.every((s: { payloadBase64: string }) => /^[A-Za-z0-9+/=]+$/.test(s.payloadBase64) && s.payloadBase64.length > 20));
  assert.match(r.warning, /UNSIGNED/);
});

test("a plan for an order that cannot be filled refuses with advice instead of inventing steps", async () => {
  const { client } = await connect({ ...fake, quote: async () => ({ ...quote, fillable: false, warnings: ["No market (or combination) can fill the full order: insufficient depth"] }) as never });
  const r = await client.callTool({ name: "qmax_build_plan", arguments: { side: "buy", asset: "CFB", qty: 1000 } });
  assert.equal(r.isError, true);
  assert.match(text(r), /cannot be filled.*smaller quantity/);
});

test("a long list is trimmed to the newest entries and says so, instead of flooding the agent", async () => {
  const { client } = await connect(fake);
  const t = text(await client.callTool({ name: "qmax_get_candles", arguments: { asset: "CFB", range: "all" } }));
  assert.ok(t.length <= 40_000);
  const r = JSON.parse(t);
  assert.ok(r.candles.length < 4000 && r.candles.length > 100);
  assert.equal(r.candles.at(-1).t, 3999, "the newest candle is kept");
  assert.match(r._trimmed, /Oldest entries were left out/);
});

test("a backtest reply is sampled so it stays small", async () => {
  const { client } = await connect(fake);
  const r = JSON.parse(text(await client.callTool({ name: "qmax_backtest", arguments: { asset: "CFB", starting_qu: 1_000_000, strategy: { type: "dca", amountQu: 500_000, everyHours: 168 } } })));
  assert.ok(r.equity.length <= 60 && r.trades.length === 60);
  assert.match(r.tradesNote, /last 60 of 100/);
});

test("bad arguments are refused by the schema, and API failures come back as advice", async () => {
  const { client } = await connect({ ...fake, quote: async () => { throw new QMaxError(402, { error: "Over the free limit" }); } });
  const bad = await client.callTool({ name: "qmax_get_quote", arguments: { side: "hold", asset: "CFB", qty: 1000 } });
  assert.equal(bad.isError, true);
  const paid = await client.callTool({ name: "qmax_get_quote", arguments: { side: "buy", asset: "CFB", qty: 1000 } });
  assert.equal(paid.isError, true);
  assert.match(text(paid), /QMAX_API_KEY.*QMAX_AGENT_SEED/);
});

test("explain gives each failure a next step", () => {
  assert.match(explain(new QMaxError(404, { error: "Unknown asset 'X'" })), /qmax_list_assets/);
  assert.match(explain(new QMaxError(429, { error: "Too many requests" })), /slow down/);
  assert.equal(explain(new Error("boom")), "boom");
});

test("fit leaves a short reply alone", () => {
  assert.deepEqual(fit({ a: [1, 2, 3] }), { text: '{"a":[1,2,3]}', trimmed: false });
});

test("the packaged server works over stdio against a real QMax API", async () => {
  const data = new SnapshotData([JSON.parse(readFileSync("examples/snapshot.json", "utf8"))]);
  const api = createApi({ data, trades: undefined });
  await new Promise<void>((r) => api.listen(0, () => r()));
  after(() => api.close());
  execFileSync("npx", ["esbuild", "mcp/server.ts", "--bundle", "--platform=node", "--format=esm", "--outfile=.cache/mcp-test/server.mjs", "--log-level=error", "--banner:js=import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"], { stdio: "pipe" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [".cache/mcp-test/server.mjs"], env: { ...process.env, QMAX_API_URL: `http://localhost:${(api.address() as AddressInfo).port}`, QMAX_MCP_NO_START: "" } as Record<string, string> });
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(transport);
  after(() => void client.close());
  const listed = await client.listTools();
  assert.ok(listed.tools.length >= 10);
  const assets = JSON.parse(text(await client.callTool({ name: "qmax_list_assets", arguments: { limit: 3 } })));
  assert.ok(assets.count > 0 && assets.assets[0].symbol);
  const q = JSON.parse(text(await client.callTool({ name: "qmax_get_quote", arguments: { side: "buy", asset: assets.assets[0].symbol, qty: 10 } })));
  assert.equal(q.side, "buy");
  assert.ok(q.totalQu > 0);
  const missing = await client.callTool({ name: "qmax_get_quote", arguments: { side: "buy", asset: "NOPE", qty: 10 } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /qmax_list_assets/);
});

test("a plan from a hostile quote is refused with the reasons, instead of being handed to an agent with a friendly total", async () => {
  const hostile = JSON.parse(JSON.stringify(quote)) as { route: { execution: { limitPrice?: number; maxQuIn?: number } }[]; assetInfo: { assetName: string } };
  hostile.route[0].execution.limitPrice = 2_000_000; // a QX bid at two million QU each, under the same "total cost" headline
  const { client } = await connect({ ...fake, quote: async () => hostile as never });
  const r = await client.callTool({ name: "qmax_build_plan", arguments: { side: "buy", asset: "CFB", qty: 1000 } });
  assert.equal(r.isError, true);
  assert.match(text(r), /does not match what you asked for.*looser than/);
  const other = JSON.parse(JSON.stringify(quote));
  other.assetInfo.assetName = "SCAMTOK";
  const { client: c2 } = await connect({ ...fake, quote: async () => other as never });
  const r2 = await c2.callTool({ name: "qmax_build_plan", arguments: { side: "buy", asset: "CFB", qty: 1000 } });
  assert.match(text(r2), /not 'CFB'/);
});

test("a reply is cut to the size limit even when the length is in one long string or a deeply nested list", async () => {
  const { fit } = await import("../mcp/tools.ts");
  assert.ok(fit({ note: "x".repeat(5_000_000) }).text.length <= 40_000);
  assert.ok(fit({ a: { b: { c: Array.from({ length: 200_000 }, (_, i) => ({ i })) } } }).text.length <= 40_000);
  assert.equal(fit({ small: 1 }).trimmed, false);
  assert.ok(fit({ note: "y".repeat(100_000) }).trimmed);
});

test("a spending limit that is not a plain number stops the server instead of switching the limit off", async () => {
  const { clientFromEnv } = await import("../mcp/server.ts");
  const SEED = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabc";
  for (const bad of ["30,000", "abc", "-5", "0", "1e999", "3.5"]) await assert.rejects(clientFromEnv({ QMAX_AGENT_SEED: SEED, QMAX_MAX_SPEND_QU: bad, QMAX_MCP_NO_START: "1" }), /QMAX_MAX_SPEND_QU must be a whole number above zero/, bad);
  await clientFromEnv({ QMAX_AGENT_SEED: SEED, QMAX_MAX_SPEND_QU: "30000", QMAX_MCP_NO_START: "1" });
});

test("Max is a paid tool: it says it costs QU, is not marked idempotent, and a 402 with its price reads as that", async () => {
  const { client } = await connect(fake);
  const { tools: listed } = await client.listTools();
  const t = listed.find((x) => x.name === "qmax_best_position")!;
  assert.ok(t, "the tool is offered");
  assert.match(t.description ?? "", /COSTS QU/);
  assert.equal(t.annotations?.readOnlyHint, true, "it signs nothing");
  assert.equal(t.annotations?.idempotentHint, false, "each call can cost QU");
  assert.ok(listed.filter((x) => x.name !== "qmax_best_position").every((x) => x.annotations?.idempotentHint === true), "the free tools are still idempotent");
  const r = JSON.parse(text(await client.callTool({ name: "qmax_best_position", arguments: { asset: "CFB", side: "buy", balance_qu: 1_000_000 } })));
  assert.deepEqual([r.asset, r.side], ["CFB", "buy"]);
  assert.ok(calls.includes("max buy CFB"));
  const msg = explain(new QMaxError(402, { error: "A Max quote costs 100 QU for agents.", priceQu: 100 }));
  assert.match(msg, /Max plans cost 100 QU/);
  assert.match(msg, /QMAX_API_KEY/);
  assert.doesNotMatch(msg, /free allowance is used up/, "this is not the free-limit message");
});
