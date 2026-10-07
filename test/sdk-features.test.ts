import test from "node:test";
import assert from "node:assert/strict";
import { QMaxClient } from "../sdk/client.ts";

/** Each new SDK method must hit the endpoint the server mounts, with the parameters the server reads. */
function recorder() {
  const seen: { url: string; method: string; body?: unknown }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { seen, client: new QMaxClient({ baseUrl: "http://example.invalid", fetch: fetchFn }) };
}

test("premium, pools and pool detail ask for the right endpoints and options", async () => {
  const { seen, client } = recorder();
  await client.premium("QDOGE", "90d", { referenceQu: 5_000_000, carry: 2 });
  await client.premium("QDOGE");
  await client.pools({ window: "30d", sort: "tvl" });
  await client.pools();
  await client.poolDetail("QDOGE", { window: "7d", positionQu: 1_000_000 });
  assert.equal(seen[0].url, "http://example.invalid/v1/premium?asset=QDOGE&range=90d&referenceQu=5000000&carry=2");
  assert.equal(seen[1].url, "http://example.invalid/v1/premium?asset=QDOGE&range=30d");
  assert.equal(seen[2].url, "http://example.invalid/v1/pools?window=30d&sort=tvl");
  assert.equal(seen[3].url, "http://example.invalid/v1/pools?");
  assert.equal(seen[4].url, "http://example.invalid/v1/pools/detail?asset=QDOGE&window=7d&positionQu=1000000");
});

test("health, tape and flow ask for the right endpoints", async () => {
  const { seen, client } = recorder();
  await client.health("CFB");
  await client.healthAll();
  await client.tape({ asset: "CFB", limit: 20, since: 7, venue: "QX" });
  await client.tape();
  await client.flow({ asset: "CFB", window: "1h" });
  assert.equal(seen[0].url, "http://example.invalid/v1/health?asset=CFB");
  assert.equal(seen[1].url, "http://example.invalid/v1/health/all");
  assert.equal(seen[2].url, "http://example.invalid/v1/tape?asset=CFB&limit=20&since=7&venue=QX");
  assert.equal(seen[3].url, "http://example.invalid/v1/tape?");
  assert.equal(seen[4].url, "http://example.invalid/v1/flow?asset=CFB&window=1h");
});

test("backtest and swap quote post their bodies as JSON", async () => {
  const { seen, client } = recorder();
  await client.backtest({ asset: "QDOGE", range: "90d", startingQu: 10_000_000, strategy: { type: "dca" } });
  await client.swapQuote({ from: "CFB", to: "QDOGE", qty: 1000, slippageBps: 50, compare: true });
  assert.deepEqual([seen[0].url, seen[0].method], ["http://example.invalid/v1/backtest", "POST"]);
  assert.deepEqual(seen[0].body, { asset: "QDOGE", range: "90d", startingQu: 10_000_000, strategy: { type: "dca" } });
  assert.deepEqual([seen[1].url, seen[1].method], ["http://example.invalid/v1/swap-quote", "POST"]);
  assert.deepEqual(seen[1].body, { from: "CFB", to: "QDOGE", qty: 1000, slippageBps: 50, compare: true });
});

test("the liquidity reads send the identity or the asset, encoded", async () => {
  const { seen, client } = recorder();
  const id = "A".repeat(60);
  await client.liquidityPositions(id);
  await client.liquidityPositions(id, { fresh: true });
  await client.liquidityPool("CFB-ISSUER/CFB");
  assert.equal(seen[0].url, `http://example.invalid/v1/liquidity/positions?identity=${id}`);
  assert.equal(seen[1].url, `http://example.invalid/v1/liquidity/positions?identity=${id}&fresh=1`);
  assert.equal(seen[2].url, "http://example.invalid/v1/liquidity/pool?asset=CFB-ISSUER%2FCFB");
});

test("the ledger asks for JSON or CSV with the window", async () => {
  const { seen, client } = recorder();
  const id = "A".repeat(60);
  await client.ledger(id, { days: 30 });
  await client.ledger(id);
  await client.ledgerCsv(id, { days: 90 });
  assert.equal(seen[0].url, `http://example.invalid/v1/ledger?identity=${id}&days=30`);
  assert.equal(seen[1].url, `http://example.invalid/v1/ledger?identity=${id}`);
  assert.equal(seen[2].url, `http://example.invalid/v1/ledger?identity=${id}&format=csv&days=90`);
});
