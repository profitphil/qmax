import test from "node:test";
import assert from "node:assert/strict";
import { broadcastVia } from "../web/exec/chain.ts";
import type { RelayTarget } from "../web/exec/chain.ts";
import { identityToBytes } from "../src/identity.ts";
import { QPAYHUB_IDENTITY } from "../src/x402.ts";
import { QX_ID } from "../src/ledger.ts";

const WALLET = "A".repeat(59) + "B";
const QMAX_ID = "m".repeat(60);
const NODE_ID = "n".repeat(60);

function signed(dest = QX_ID, inputType = 6): Uint8Array {
  const input = new Uint8Array(56).fill(3);
  const out = new Uint8Array(80 + input.length + 64);
  const view = new DataView(out.buffer);
  out.set(identityToBytes(WALLET), 0);
  out.set(identityToBytes(dest), 32);
  view.setBigUint64(64, 1000n, true);
  view.setUint32(72, 999, true);
  view.setUint16(76, inputType, true);
  view.setUint16(78, input.length, true);
  out.set(input, 80);
  out.set(new Uint8Array(64).fill(5), 80 + input.length);
  return out;
}

/** A fetch that answers QMax's relay and the public node differently and records who was asked. */
function net(o: { qmax?: "ok" | "refuse" | "down" | "junk" | "slow" } = {}) {
  const calls: { who: "qmax" | "node"; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
    const who = String(url).includes("/v1/broadcast-transaction") ? "node" : "qmax";
    calls.push({ who, headers: init.headers, body: JSON.parse(init.body) });
    if (who === "node") return { ok: true, status: 200, text: async () => "", json: async () => ({ transactionId: NODE_ID }) };
    if (o.qmax === "down") throw new Error("offline");
    if (o.qmax === "refuse") return { ok: false, status: 502, text: async () => "", json: async () => ({}) };
    if (o.qmax === "junk") return { ok: true, status: 200, text: async () => "", json: async () => ({ transactionId: "bad" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ transactionId: QMAX_ID }) };
  }) as unknown as typeof fetch;
  return { f, calls };
}
const target: RelayTarget = { url: "https://qmax.test/api/", channel: "web", ref: "partner" };

test("an order goes through QMax when it can, naming its wallet, channel and partner, and never also to the network", async () => {
  const { f, calls } = net();
  const id = await broadcastVia(signed(), WALLET, target, f);
  assert.equal(id, QMAX_ID);
  assert.deepEqual(calls.map((c) => c.who), ["qmax"]);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["channel", "encodedTransaction", "ref", "wallet"]);
  assert.equal(calls[0].body.wallet, WALLET);
  assert.equal(calls[0].body.channel, "web");
  assert.equal(calls[0].body.ref, "partner");
  assert.equal(Buffer.from(calls[0].body.encodedTransaction, "base64").length, signed().length, "the signed bytes, whole");
});

test("QMax's own key is sent when there is one (the bot), and not otherwise", async () => {
  const a = net();
  await broadcastVia(signed(), WALLET, { ...target, channel: "discord", apiKey: "secret-key-for-the-bot" }, a.f);
  assert.equal(a.calls[0].headers["x-api-key"], "secret-key-for-the-bot");
  const b = net();
  await broadcastVia(signed(), WALLET, target, b.f);
  assert.equal(b.calls[0].headers["x-api-key"], undefined);
});

test("when QMax cannot take it (down, refusing, or answering nonsense) the network is sent it instead", async () => {
  for (const mode of ["down", "refuse", "junk"] as const) {
    const { f, calls } = net({ qmax: mode });
    assert.equal(await broadcastVia(signed(), WALLET, target, f), NODE_ID, mode);
    assert.deepEqual(calls.map((c) => c.who), ["qmax", "node"], mode);
  }
});

test("only orders are offered to QMax: a payment, a share move, an unnamed wallet or a person who opted out go straight to the network", async () => {
  const cases: [string, Uint8Array, string | undefined, RelayTarget | null][] = [
    ["a payment", signed(QPAYHUB_IDENTITY, 1), WALLET, target],
    ["a share move", signed(QX_ID, 9), WALLET, target],
    ["no wallet", signed(), undefined, target],
    ["opted out", signed(), WALLET, null],
  ];
  for (const [what, tx, wallet, t] of cases) {
    const { f, calls } = net();
    assert.equal(await broadcastVia(tx, wallet, t, f), NODE_ID, what);
    assert.deepEqual(calls.map((c) => c.who), ["node"], what);
  }
});
