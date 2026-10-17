import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/api.ts";
import type { MarketData } from "../src/data.ts";
import { identityToBytes } from "../src/identity.ts";
import { QSWAP_ID, QX_ID } from "../src/ledger.ts";
import { MAX_RELAY_BYTES, Relay, readRelayable } from "../src/relay.ts";
import { QPAYHUB_IDENTITY } from "../src/x402.ts";

const WALLET = "A".repeat(59) + "B";
const OTHER = "C".repeat(59) + "D";
const ID = "q".repeat(60);

/** A signed transaction as bytes: source, destination, amount, tick, input type, input size, input, signature. */
function signed(o: { source?: string; dest?: string; amount?: bigint; tick?: number; inputType?: number; input?: Uint8Array; signature?: Uint8Array } = {}): Uint8Array {
  const input = o.input ?? new Uint8Array(56).fill(7);
  const out = new Uint8Array(80 + input.length + 64);
  const view = new DataView(out.buffer);
  out.set(identityToBytes(o.source ?? WALLET), 0);
  out.set(identityToBytes(o.dest ?? QX_ID), 32);
  view.setBigUint64(64, o.amount ?? 5000n, true);
  view.setUint32(72, o.tick ?? 12345, true);
  view.setUint16(76, o.inputType ?? 6, true);
  view.setUint16(78, input.length, true);
  out.set(input, 80);
  out.set(o.signature ?? new Uint8Array(64).fill(9), 80 + input.length);
  return out;
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

test("what counts as an order QMax will carry", () => {
  assert.deepEqual(readRelayable(signed({ inputType: 6 }))?.venue, "QX", "a QX buy order");
  assert.equal(readRelayable(signed({ inputType: 5 }))?.venue, "QX", "a QX sell order");
  assert.equal(readRelayable(signed({ dest: QSWAP_ID, inputType: 8 }))?.venue, "QSwap", "a QSwap swap");
  assert.equal(readRelayable(signed({ dest: QSWAP_ID, inputType: 4 }))?.venue, "QSwap", "QSwap liquidity");
  const r = readRelayable(signed({ amount: 77n, tick: 4321 }))!;
  assert.deepEqual([r.amount, r.tick, r.inputType], [77n, 4321, 6]);
  assert.equal(readRelayable(signed({ inputType: 7 })), null, "cancelling a QX order");
  assert.equal(readRelayable(signed({ inputType: 9 })), null, "moving shares");
  assert.equal(readRelayable(signed({ dest: QPAYHUB_IDENTITY, inputType: 1 })), null, "a payment");
  assert.equal(readRelayable(signed({ dest: OTHER })), null, "a transfer to a wallet");
  assert.equal(readRelayable(signed({ signature: new Uint8Array(64) })), null, "no signature");
  assert.equal(readRelayable(new Uint8Array(100)), null, "not a transaction");
  assert.equal(readRelayable(signed({ input: new Uint8Array(MAX_RELAY_BYTES) })), null, "too big to be an order");
  const cut = signed();
  assert.equal(readRelayable(cut.subarray(0, cut.length - 1)), null, "the length does not match the size it states");
});

function relay(o: { status?: number; json?: unknown; throws?: boolean } = {}) {
  const sent: { url: string; body: any }[] = [];
  const reports: { body: any; source?: string }[] = [];
  const fetchFn = (async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    if (o.throws) throw new Error("down");
    return { ok: (o.status ?? 200) < 400, status: o.status ?? 200, text: async () => "node said no", json: async () => o.json ?? { transactionId: ID, peersBroadcasted: 12 } };
  }) as unknown as typeof fetch;
  const r = new Relay({ rpcUrl: "https://node.test/", usage: { report: (body, source) => (reports.push({ body, source }), 1) }, fetch: fetchFn });
  return { r, sent, reports };
}

test("an order is passed to the node and noted for counting, with its channel and partner", async () => {
  const { r, sent, reports } = relay();
  const tx = signed();
  const res = await r.send({ encodedTransaction: b64(tx), wallet: WALLET, channel: "discord", ref: "partner" }, "1.2.3.0");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { transactionId: ID, peersBroadcasted: 12 });
  assert.equal(sent[0].url, "https://node.test/v1/broadcast-transaction");
  assert.deepEqual(sent[0].body, { encodedTransaction: b64(tx) }, "the node is sent exactly the signed bytes");
  assert.deepEqual(reports[0].body, { wallet: WALLET, txIds: [ID], channel: "discord", ref: "partner" });
  assert.equal(reports[0].source, "1.2.3.0");
  const web = relay();
  await web.r.send({ encodedTransaction: b64(tx), wallet: WALLET, channel: "nonsense", ref: "bad ref!" });
  assert.deepEqual(web.reports[0].body, { wallet: WALLET, txIds: [ID], channel: "web" }, "an unknown channel is the website; a malformed partner tag is dropped");
});

test("anything that is not an order from that wallet is refused before the node hears of it", async () => {
  const { r, sent } = relay();
  const ok = b64(signed());
  const cases: [unknown, string][] = [
    [null, "no body"],
    [{ wallet: WALLET }, "no transaction"],
    [{ encodedTransaction: "not base64!", wallet: WALLET }, "not base64"],
    [{ encodedTransaction: ok }, "no wallet"],
    [{ encodedTransaction: ok, wallet: "short" }, "a bad wallet"],
    [{ encodedTransaction: b64(signed({ dest: QPAYHUB_IDENTITY, inputType: 1 })), wallet: WALLET }, "a payment"],
    [{ encodedTransaction: b64(signed({ inputType: 9 })), wallet: WALLET }, "a share move"],
    [{ encodedTransaction: ok, wallet: OTHER }, "signed by someone else"],
    [{ encodedTransaction: "A".repeat(4000), wallet: WALLET }, "far too long"],
  ];
  for (const [body, what] of cases) assert.equal((await r.send(body)).status, 400, what);
  assert.equal(sent.length, 0, "nothing reached the node");
});

test("a refusal by the node is passed on as a refusal, and a node that is down is a 502 (the sender then goes to the network itself)", async () => {
  const body = { encodedTransaction: b64(signed()), wallet: WALLET };
  const refused = await relay({ status: 400 }).r.send(body);
  assert.equal(refused.status, 400);
  assert.match(String(refused.body.error), /node said no/);
  assert.equal((await relay({ status: 503 }).r.send(body)).status, 502);
  assert.equal((await relay({ throws: true }).r.send(body)).status, 502);
  assert.equal((await relay({ json: { transactionId: "nope" } }).r.send(body)).status, 502, "no usable transaction id");
  const noCount = relay({ status: 400 });
  await noCount.r.send(body);
  assert.equal(noCount.reports.length, 0, "an order the node refused is not counted");
});

/* ---------- over HTTP ---------- */

const data: MarketData = { assets: () => [], venues: async () => null };
const KEY = "k".repeat(24);
const hit = relay();
const server = createApi({ data, relay: hit.r, apiKey: KEY, freeAccess: true });
const bare = createApi({ data });
await new Promise<void>((r) => server.listen(0, () => r()));
await new Promise<void>((r) => bare.listen(0, () => r()));
const url = `http://localhost:${(server.address() as AddressInfo).port}`;
const bareUrl = `http://localhost:${(bare.address() as AddressInfo).port}`;
after(() => {
  server.close();
  bare.close();
});
const send = (base: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + "/v1/broadcast", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("POST /v1/broadcast carries an order, refuses other things, limits callers, and is absent without a relay", async () => {
  const body = { encodedTransaction: b64(signed()), wallet: WALLET, channel: "web" };
  const ok = await send(url, body);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { transactionId: string }).transactionId, ID);
  assert.equal((await send(url, { ...body, wallet: OTHER })).status, 400);
  assert.equal((await send(bareUrl, body)).status, 404, "an API without the relay does not serve it");
  // 30 a minute for a caller; QMax's own key (the bot) is not limited
  for (let i = 0; i < 40; i++) await send(url, body, { "x-api-key": KEY });
  assert.equal((await send(url, body, { "x-api-key": KEY })).status, 200, "the bot is never limited");
  let last = 0;
  for (let i = 0; i < 40; i++) last = (await send(url, body)).status;
  assert.equal(last, 429, "a caller without the key is limited");
});

test("the relay's idea of QX's and QSwap's addresses is the real one (it does not read them from the ledger, which a page must not import)", () => {
  for (const [dest, venue] of [[QX_ID, "QX"], [QSWAP_ID, "QSwap"]] as const) assert.equal(readRelayable(signed({ dest, inputType: venue === "QX" ? 6 : 8 }))?.venue, venue);
});
