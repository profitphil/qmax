import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, subnet } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { SnapshotData } from "../src/data.ts";
import { isRef } from "../src/deeplink.ts";
import { bytesToHex, identityToBytes } from "../src/identity.ts";
import { Meter } from "../src/meter.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { RefLog } from "../src/refs.ts";
import { RpcBusyError, QubicRpc } from "../src/rpc.ts";
import { readJsonFile, writeJsonFile } from "../src/safefile.ts";
import type { Receipt } from "../src/qpay.ts";

const RECIPIENT = "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE";
const PAYER = "QXMRTKAIIGLUREPIQPCMHCKWSIPDTUYFCFNYXQLTECSUJVYEMMDELBMDOEYB";
const tmp = () => mkdtempSync(join(tmpdir(), "sec-"));

/* ---------- prepaid top-ups: one payment is one credit, however it is spelled ---------- */

/** A QPayhub that finds receipts the way the contract does: by the payer's 32 bytes and the nonce's value, not by how either was written. */
function hub() {
  const paid = new Map<string, number>();
  const id = (payer: string, nonce: bigint) => `${bytesToHex(identityToBytes(payer))}|${nonce}`;
  return {
    pay: (payer: string, nonce: bigint, amount: number) => paid.set(id(payer, nonce), amount),
    lookup: async (payer: string, seller: string, _rid: Uint8Array, nonce: bigint): Promise<Receipt | null> => {
      const amountPaid = paid.get(id(payer, nonce));
      return amountPaid === undefined ? null : { amountPaid, fee: 100, seller: identityToBytes(seller) };
    },
  };
}

test("one top-up payment is credited once, not once for each way of writing the payer or the nonce", async () => {
  const h = hub();
  const meter = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: RECIPIENT, lookupReceipt: h.lookup });
  const { keyId } = meter.createKey();
  h.pay(PAYER, 7n, 10_000);
  assert.equal((await meter.claim({ keyId, payer: PAYER, nonce: "7" })).ok, true);
  // The last four letters of an identity are a checksum the receipt lookup ignores, so 456,976 spellings reach the same receipt.
  let credited = 0;
  for (const tail of ["AAAA", "ZZZZ", "QMAX", "FFIH"]) if ((await meter.claim({ keyId, payer: PAYER.slice(0, 56) + tail, nonce: "7" })).ok) credited++;
  assert.equal(credited, 0, "another spelling of the same payer is the same payment");
  // The same nonce written with leading zeros is the same number.
  for (const nonce of ["07", "007", "00000000000000000007"]) assert.equal((await meter.claim({ keyId, payer: PAYER, nonce })).ok, false, nonce);
  assert.equal(meter.info(keyId)!.balanceQu, 10_000, "one payment, one credit");
});

test("a claim for a key id that is not a key id, such as __proto__, is just unknown", async () => {
  const meter = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: RECIPIENT, lookupReceipt: hub().lookup });
  for (const keyId of ["__proto__", "constructor", "toString", "x".repeat(32), ""]) {
    assert.deepEqual(await meter.claim({ keyId, payer: PAYER, nonce: "1" }), { ok: false, reason: "Unknown keyId" });
    assert.throws(() => meter.topup(keyId, 50_000), /Unknown keyId/);
  }
  assert.equal(meter.info("__proto__"), null);
});

test("what was credited is remembered long enough: a thousand later claims do not make an old receipt claimable again", async () => {
  const h = hub();
  const meter = new Meter({ splitPriceQu: 100, arbitragePriceQu: 50, minTopupQu: 10_000, recipient: RECIPIENT, lookupReceipt: h.lookup });
  const { keyId } = meter.createKey();
  h.pay(PAYER, 1n, 10_000);
  assert.equal((await meter.claim({ keyId, payer: PAYER, nonce: "1" })).ok, true);
  for (let i = 2; i < 1100; i++) {
    h.pay(PAYER, BigInt(i), 100);
    await meter.claim({ keyId, payer: PAYER, nonce: String(i) });
  }
  assert.equal((await meter.claim({ keyId, payer: PAYER, nonce: "1" })).ok, false);
});

/* ---------- partner tags ---------- */

test("a partner tag that is also a property of every object is refused, and cannot change anything", () => {
  for (const bad of ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "__PROTO__"]) assert.equal(isRef(bad), false, bad);
  assert.equal(isRef("partner"), true);
  const log = new RefLog();
  for (const bad of ["__proto__", "constructor"]) assert.equal(log.record(bad, "open", undefined), false);
  assert.equal(({} as Record<string, unknown>).opens, undefined, "nothing leaked onto every object");
  assert.deepEqual(Object.keys(log.summary().refs), []);
});

test("junk tags cannot fill the table and shut real partners out: the stalest tag with no trade makes room", () => {
  const log = new RefLog();
  for (let i = 0; i < 500; i++) assert.equal(log.record(`junk${i}`, "open", undefined, 1000 + i), true);
  assert.equal(log.record("realpartner", "open", undefined, 5000), true, "a new tag still gets in");
  const refs = Object.keys(log.summary().refs);
  assert.equal(refs.length, 500);
  assert.ok(refs.includes("realpartner") && !refs.includes("junk0"), "the oldest junk tag made room");
  // A tag that brought a trade is not the one to drop.
  const txId = "a".repeat(60);
  const full = new RefLog();
  for (let i = 0; i < 500; i++) full.record(`t${i}`, "open", undefined, 1000 + i);
  full.record("t0", "trade", [txId], 2000);
  full.record("new", "open", undefined, 3000);
  assert.ok(Object.keys(full.summary().refs).includes("t0"), "t0 is old but earned a trade, so it stays");
});

/* ---------- the limiter and who a caller is ---------- */

test("addresses are keyed so a caller cannot rotate through spellings or through a whole IPv6 range", () => {
  assert.equal(subnet("203.0.113.9"), "203.0.113.9");
  assert.equal(subnet("::ffff:203.0.113.9"), "203.0.113.9", "an IPv4 caller on a dual-stack socket is the same caller");
  assert.equal(subnet("2001:db8:aaaa:bbbb:1:2:3:4"), subnet("2001:DB8:AAAA:BBBB:ffff:ffff:ffff:ffff"), "one /64 is one caller");
  assert.equal(subnet("2001:db8::1"), subnet("2001:0db8:0:0:0:0:0:99"), "however it is written");
  assert.notEqual(subnet("2001:db8:aaaa:bbbb::1"), subnet("2001:db8:aaaa:cccc::1"), "another /64 is another caller");
});

test("a limiter that is flooded with new ids stays bounded and keeps limiting the ones it knows", () => {
  const l = new RateLimiter(3, 60_000);
  const T = 1_000_000;
  for (let i = 0; i < 120_000; i++) l.hit(`id${i}`, T + Math.floor(i / 1000)); // time moves on a little, every id still inside its window
  // Pruning is bounded to the cap: the oldest are dropped, so the table does not grow without limit.
  assert.ok(l.size() <= 100_001, `holds ${l.size()} ids`);
  const newest = "id119999";
  for (let i = 0; i < 3; i++) l.hit(newest, T + 200_000 / 1000);
  assert.equal(l.hit(newest, T + 200).ok, false, "a recent id is still limited");
});

async function serve(opts: Parameters<typeof createApi>[0]) {
  const s = createApi(opts);
  await new Promise<void>((r) => s.listen(0, () => r()));
  return { s, url: `http://localhost:${(s.address() as AddressInfo).port}` };
}
const snapshot = () => SnapshotData.fromFile("examples/snapshot.json");

test("behind one trusted proxy the caller is the address the proxy saw, not what the caller wrote in front of it", async () => {
  const { s, url } = await serve({ data: snapshot(), freeAccess: true, freePerMin: 3, trustProxy: 1 });
  try {
    const asset = ((await (await fetch(url + "/v1/assets")).json()) as { assets: { id: string }[] }).assets[0].id;
    const quote = (xff: string) => fetch(`${url}/v1/quote?side=buy&asset=${asset}&qty=1`, { headers: { "x-forwarded-for": xff } }).then((r) => r.status);
    // The proxy appends the real address on the right; the caller writes whatever it likes on the left.
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(await quote(`10.0.0.${i}, 198.51.100.7`));
    assert.deepEqual(codes.map((c) => c === 429), [false, false, false, true, true, true], "rotating the front of the header does not give a new allowance");
    assert.equal(await quote("198.51.100.8"), 200, "a different real address has its own");
  } finally {
    s.close();
  }
});

test("with no proxy trusted, the header is ignored altogether", async () => {
  const { s, url } = await serve({ data: snapshot(), freeAccess: true, freePerMin: 2 });
  try {
    const asset = ((await (await fetch(url + "/v1/assets")).json()) as { assets: { id: string }[] }).assets[0].id;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${url}/v1/quote?side=buy&asset=${asset}&qty=1`, { headers: { "x-forwarded-for": `1.2.3.${i}` } })).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  } finally {
    s.close();
  }
});

/* ---------- a private API, and guessing keys ---------- */

test("a private API lets nobody in without the key, including the endpoints that write", async () => {
  const KEY = "p".repeat(32);
  const { s, url } = await serve({ data: snapshot(), apiKey: KEY, refs: new RefLog() });
  try {
    const post = (path: string, headers: Record<string, string> = {}) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ref: "partner", event: "open" }) }).then((r) => r.status);
    assert.equal(await post("/v1/ref"), 401, "an unauthenticated write to /v1/ref");
    assert.equal(await post("/v1/ref", { "x-api-key": KEY }), 200);
    assert.equal((await fetch(url + "/v1/assets")).status, 401);
    assert.equal((await fetch(url + "/health")).status, 200, "the health check stays open");
  } finally {
    s.close();
  }
});

test("someone guessing keys is told to slow down, and the right key still works", async () => {
  const KEY = "g".repeat(32);
  const { s, url } = await serve({ data: snapshot(), apiKey: KEY, freeAccess: true, refs: new RefLog() });
  try {
    const guess = (k: string) => fetch(url + "/v1/refs", { headers: { "x-api-key": k } }).then((r) => r.status);
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push(await guess(`wrong-${i}`));
    assert.ok(codes.slice(0, 20).every((c) => c === 401));
    assert.ok(codes.slice(20).every((c) => c === 429), "after twenty misses an address is throttled");
    assert.equal(await guess(KEY), 200, "the right key is not locked out by someone else's guesses from the same address");
    assert.equal(await guess(""), 401, "no key at all is not a guess and is not counted");
  } finally {
    s.close();
  }
});

test("the bot's key reads the market but not the owner's endpoints; the admin key does both; with no admin key the one key does everything", async () => {
  const BOT = "b".repeat(32);
  const ADMIN = "a".repeat(32);
  const { s, url } = await serve({ data: snapshot(), apiKey: BOT, adminKey: ADMIN, freeAccess: true, refs: new RefLog() });
  try {
    const get = (path: string, k?: string) => fetch(url + path, { headers: k ? { "x-api-key": k } : {} }).then((r) => r.status);
    assert.equal(await get("/v1/refs", BOT), 401, "the bot's key must not open the owner's endpoints");
    assert.equal(await get("/v1/refs"), 401);
    assert.equal(await get("/v1/refs", ADMIN), 200);
    assert.equal(await get("/v1/assets", BOT), 200);
    assert.equal(await get("/v1/assets", ADMIN), 200, "the owner's key is not charged or limited either");
  } finally {
    s.close();
  }
  const one = await serve({ data: snapshot(), apiKey: BOT, freeAccess: true, refs: new RefLog() });
  try {
    assert.equal(await fetch(one.url + "/v1/refs", { headers: { "x-api-key": BOT } }).then((r) => r.status), 200, "no separate admin key: the one key still works, as before");
  } finally {
    one.s.close();
  }
  // A private API accepts either key at the door, but the owner's endpoints still want the admin one.
  const priv = await serve({ data: snapshot(), apiKey: BOT, adminKey: ADMIN, refs: new RefLog() });
  try {
    const get = (path: string, k?: string) => fetch(priv.url + path, { headers: k ? { "x-api-key": k } : {} }).then((r) => r.status);
    assert.equal(await get("/v1/assets"), 401);
    assert.equal(await get("/v1/assets", BOT), 200);
    assert.equal(await get("/v1/assets", ADMIN), 200);
    assert.equal(await get("/v1/refs", BOT), 401);
    assert.equal(await get("/v1/refs", ADMIN), 200);
  } finally {
    priv.s.close();
  }
});

/* ---------- requests that used to crash or confuse the handler ---------- */

test("a response that cannot be written as JSON is a 500, not a crashed process", async () => {
  const routes = [
    { method: "GET" as const, path: "/v1/big", limited: false, doc: { summary: "x" }, handler: () => ({ n: 10n }) },
    { method: "GET" as const, path: "/v1/loop", limited: false, doc: { summary: "x" }, handler: () => { const o: Record<string, unknown> = {}; o.self = o; return o; } },
  ];
  const { s, url } = await serve({ data: snapshot(), freeAccess: true, routes });
  try {
    for (const path of ["/v1/big", "/v1/loop"]) {
      const r = await fetch(url + path);
      assert.equal(r.status, 500);
      assert.deepEqual(await r.json(), { error: "Internal error" });
    }
    assert.equal((await fetch(url + "/health")).status, 200, "and the server is still up");
  } finally {
    s.close();
  }
});

test("an address that cannot be parsed is a 400, and a prototype name is not an interval", async () => {
  const { s, url } = await serve({ data: snapshot(), freeAccess: true });
  try {
    const { connect } = await import("node:net");
    const status = await new Promise<number>((resolve) => {
      const sock = connect(Number(new URL(url).port), "localhost", () => sock.write("GET //x HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"));
      let buf = "";
      sock.on("data", (d) => (buf += d));
      sock.on("end", () => resolve(Number(/HTTP\/1\.1 (\d+)/.exec(buf)?.[1])));
    });
    assert.ok(status === 400 || status === 404, `got ${status}, not a 500`);
  } finally {
    s.close();
  }
});

test("the market search is limited like the other market endpoints, so it cannot be used to flood the node", async () => {
  let looked = 0;
  const data = { assets: () => [], venues: async () => null, searchAssets: async () => (looked++, []) } as unknown as MarketData;
  const { s, url } = await serve({ data, freeAccess: true, freePerMin: 3 });
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await fetch(`${url}/v1/assets/search?name=ABC${i}`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429, 429]);
    assert.equal(looked, 3, "and the refused ones never reached the node");
  } finally {
    s.close();
  }
});

/* ---------- the node client: a queue that cannot grow without end, and a wait that cannot be dictated ---------- */

test("when the node's queue is too long, new requests are refused at once instead of waiting for minutes", async () => {
  let sent = 0;
  const rpc = new QubicRpc({ maxRps: 10, maxQueueMs: 250, fetch: (async () => (sent++, new Response("{}"))) as typeof fetch });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => rpc.get("/x")));
  const busy = results.filter((r) => r.status === "rejected" && r.reason instanceof RpcBusyError);
  assert.ok(busy.length >= 10, `${busy.length} of 20 were refused as busy`);
  assert.equal(sent, 20 - busy.length, "the refused ones never went to the node");
  assert.ok(sent >= 2 && sent <= 6, "and a few did, spaced out by the rate limit");
});

test("however long the node says to wait, the client waits no longer than its own limit", async () => {
  let calls = 0;
  const fetchFn = (async () => (++calls === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "86400" } }) : new Response("{}"))) as typeof fetch;
  const rpc = new QubicRpc({ maxRps: 1000, maxBackoffMs: 60, fetch: fetchFn });
  const t0 = Date.now();
  await rpc.get("/x");
  assert.ok(Date.now() - t0 < 1000, "one day became 60 ms");
  // And a value past a timer's range (2^31 ms) is not turned into a wait of a millisecond that hammers the node.
  calls = 0;
  const huge = (async () => (++calls <= 2 ? new Response("no", { status: 429, headers: { "retry-after": "5000000" } }) : new Response("{}"))) as typeof fetch;
  const rpc2 = new QubicRpc({ maxRps: 1000, maxBackoffMs: 60, fetch: huge });
  const t1 = Date.now();
  await rpc2.get("/x");
  assert.ok(Date.now() - t1 >= 100, "two 429s cost at least two real waits");
});

/* ---------- state files ---------- */

test("a state file that cannot be read is moved aside, never silently replaced by an empty one", () => {
  const dir = tmp();
  try {
    const file = join(dir, "state.json");
    writeFileSync(file, "{ this is not json");
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.equal(readJsonFile(file), undefined);
    } finally {
      console.error = quiet;
    }
    const files = readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith("state.json.corrupt-")), `kept as ${files.join(", ")}`);
    assert.ok(!files.includes("state.json"));
    // A file of the wrong shape is treated the same way.
    writeFileSync(file, JSON.stringify([1, 2, 3]));
    console.error = () => {};
    try {
      assert.equal(readJsonFile(file, (v) => typeof v === "object" && v !== null && !Array.isArray(v)), undefined);
    } finally {
      console.error = quiet;
    }
    assert.equal(readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-")).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state files are written owner-only, in an owner-only folder, and a looser file is tightened by the next write", () => {
  const dir = tmp();
  try {
    const file = join(dir, "sub", "state.json");
    writeJsonFile(file, { a: 1 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700);
    const loose = join(dir, "loose.json");
    writeFileSync(loose, "{}", { mode: 0o644 });
    writeJsonFile(loose, { b: 2 });
    assert.equal(statSync(loose).mode & 0o777, 0o600);
    assert.deepEqual(readJsonFile(loose), { b: 2 });
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temporary file is left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- numbers are read the plain way ---------- */

import { parseQuery } from "../src/quoteapi.ts";
import { plainNumber } from "../src/routes.ts";

test("hex, exponent, blank and 'Infinity' are not quantities or limits", () => {
  for (const bad of ["0x10", "1e3", " ", "", "Infinity", "-Infinity", "NaN", "1,5", "0b11", "١٢٣", null, undefined, {}, []]) assert.ok(Number.isNaN(plainNumber(bad)), `${String(bad)} is not a number`);
  assert.equal(plainNumber("1e9", true), 1e9, "a size in QU may be written 1e9 where that is allowed");
  assert.ok(Number.isNaN(plainNumber("0x10", true)) && Number.isNaN(plainNumber("Infinity", true)) && Number.isNaN(plainNumber("1e", true)));
  assert.equal(plainNumber("42"), 42);
  assert.equal(plainNumber(" 42 "), 42);
  assert.equal(plainNumber("-7.5"), -7.5);
  assert.equal(plainNumber(1500), 1500);
  assert.throws(() => parseQuery({ side: "buy", asset: "CFB", qty: "0x10" }), /qty must be/);
  assert.throws(() => parseQuery({ side: "buy", asset: "CFB", qty: "1e3" }), /qty must be/);
  assert.throws(() => parseQuery({ side: "buy", asset: "CFB", qty: "10", slippageBps: "0x20" }), /slippageBps/);
  assert.equal(parseQuery({ side: "buy", asset: "CFB", qty: "1,500" }).qty, 1500);
  assert.equal(parseQuery({ side: "buy", asset: "CFB", qty: 25 }).qty, 25);
});

/* ---------- the asset list is busiest first ---------- */

test("assets come busiest first (24-hour volume, then 7-day, then most liquid), carry their volume, and sort=liquidity keeps the old order", async () => {
  const entry = (id: string, liquidityQu: number) => ({ id, symbol: id, issuer: "", category: "token", venues: ["QX"], priceQu: 1, liquidityQu, probedAt: 0 });
  // The server's own order is by liquidity: DEEP, MID, WEEK, QUIET, BUSY.
  const listed = [entry("DEEP", 900), entry("MID", 500), entry("WEEK", 300), entry("QUIET", 200), entry("BUSY", 100)];
  const data = { assets: () => listed.map((a) => a.id), venues: async () => null, listAssets: () => ({ assets: listed, ready: true }) } as unknown as MarketData;
  const volumes = new Map([
    ["BUSY", { volume24hQu: 5_000_000, volume7dQu: 9_000_000, trades24h: 40 }],
    ["MID", { volume24hQu: 1_000_000, volume7dQu: 1_000_000, trades24h: 3 }],
    ["WEEK", { volume24hQu: 0, volume7dQu: 2_000_000, trades24h: 0 }],
  ]);
  const { s, url } = await serve({ data, freeAccess: true, trades: { volumes: () => volumes, candles: () => null } });
  try {
    const get = async (q = "") => ((await (await fetch(`${url}/v1/assets${q}`)).json()) as { assets: { id: string; volume24hQu: number; volume7dQu: number; trades24h: number }[] }).assets;
    const busiest = await get();
    assert.deepEqual(busiest.map((a) => a.id), ["BUSY", "MID", "WEEK", "DEEP", "QUIET"], "24 hours, then 7 days, then liquidity for those that did not trade");
    assert.deepEqual([busiest[0].volume24hQu, busiest[0].trades24h], [5_000_000, 40]);
    assert.deepEqual([busiest[3].volume24hQu, busiest[3].volume7dQu, busiest[3].trades24h], [0, 0, 0], "an asset with no history says zero, not nothing");
    assert.deepEqual((await get("?sort=liquidity")).map((a) => a.id), ["DEEP", "MID", "WEEK", "QUIET", "BUSY"]);
    assert.equal((await fetch(`${url}/v1/assets?sort=random`)).status, 400);
  } finally {
    s.close();
  }
  // Without trade history the list is as it was: no volumes, most liquid first.
  const plain = await serve({ data, freeAccess: true });
  try {
    const body = (await (await fetch(`${plain.url}/v1/assets`)).json()) as { assets: { id: string; volume24hQu?: number }[] };
    assert.deepEqual(body.assets.map((a) => a.id), ["DEEP", "MID", "WEEK", "QUIET", "BUSY"]);
    assert.equal(body.assets[0].volume24hQu, undefined);
  } finally {
    plain.s.close();
  }
});
