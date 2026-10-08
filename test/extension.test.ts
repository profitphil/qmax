import { test } from "node:test";
import assert from "node:assert/strict";
import { connectExtension, currentExtensionAccount, extensionMessage, extensionProvider, signRequest, signWithExtension, waitForExtension, watchExtension } from "../web/wallet/extension.ts";
import type { QubicProvider, SignTransactionParams } from "../web/wallet/extension.ts";
import type { TxExpectation } from "../src/signedtx.ts";

const ID_A = "A".repeat(59) + "B";
const ID_C = "C".repeat(60);
const key = (n: number) => new Uint8Array(32).fill(n);

function txBytes(w: TxExpectation): Uint8Array {
  const out = new Uint8Array(80 + w.payload.length + 64);
  const v = new DataView(out.buffer);
  out.set(w.source, 0); out.set(w.dest, 32);
  v.setBigUint64(64, w.amount, true); v.setUint32(72, w.tick, true); v.setUint16(76, w.inputType, true); v.setUint16(78, w.payload.length, true);
  out.set(w.payload, 80); out.set(new Uint8Array(64).fill(5), 80 + w.payload.length);
  return out;
}
const want = { source: key(1), dest: key(2), amount: 25_000n, tick: 83_000_100, inputType: 6, payload: Uint8Array.from({ length: 56 }, (_, i) => i), destinationIdentity: "D".repeat(60) };
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

type Fake = QubicProvider & { seen: SignTransactionParams[]; fire: (e: string, p: unknown) => void };

function fake(over: Partial<QubicProvider> = {}): Fake {
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const seen: SignTransactionParams[] = [];
  const base: QubicProvider = {
    isQubic: true,
    connect: async () => ({ connected: true, origin: "https://qmax.exchange" }),
    disconnect: async () => ({ disconnected: true }),
    getAccount: async () => ({ identity: ID_A, name: "Main" }),
    signTransaction: async (p: SignTransactionParams) => {
      seen.push(p);
      return { txId: "x", targetTick: p.targetTick, txBytesBase64: b64(txBytes(want)), txBytesHex: "" };
    },
    on: (e: string, cb: (payload: unknown) => void) => {
      handlers.set(e, [...(handlers.get(e) ?? []), cb]);
      return () => void handlers.set(e, (handlers.get(e) ?? []).filter((h) => h !== cb));
    },
  };
  return { ...base, ...over, seen, fire: (e, p) => (handlers.get(e) ?? []).forEach((h) => h(p)) };
}

test("the extension is found only when it really is the Qubic provider", () => {
  assert.equal(extensionProvider({}), null);
  assert.equal(extensionProvider({ qubic: { isQubic: false, connect() {}, getAccount() {}, signTransaction() {} } }), null);
  assert.equal(extensionProvider({ qubic: { isQubic: true } }), null, "a provider missing the methods this site needs is not used");
  const p = fake();
  assert.equal(extensionProvider({ qubic: p }), p);
  assert.equal(extensionProvider(undefined) === null || typeof window === "undefined", true);
});

test("it looks for the extension for a moment before saying it is missing", async () => {
  const w: { qubic?: QubicProvider } = {};
  let polls = 0;
  const found = await waitForExtension(1000, w, async () => {
    if (++polls === 3) w.qubic = fake(); // the extension's own script runs a little after the page's
  });
  assert.ok(found);
  assert.equal(polls, 3);
  let slept = 0;
  assert.equal(await waitForExtension(500, {}, async () => void slept++), null);
  assert.equal(slept, 5, "it gave up after the time was up, not before and not never");
});

test("connecting asks the extension and returns the account it shares, with a clean name", async () => {
  const a = await connectExtension(fake({ getAccount: async () => ({ identity: ID_A, name: "My <b>Main</b> wallet\n" }) }));
  assert.equal(a.identity, ID_A);
  assert.equal(a.name, "My bMainb wallet");
  await assert.rejects(connectExtension(fake({ getAccount: async () => null })), /did not share an account/);
  await assert.rejects(connectExtension(fake({ getAccount: async () => ({ identity: "not an identity" }) })), /did not share an account/);
  await assert.rejects(connectExtension(fake({ connect: async () => { throw Object.assign(new Error("no"), { code: "USER_REJECTED" }); } })), /no/);
  assert.equal((await currentExtensionAccount(fake()))!.identity, ID_A);
  assert.equal(await currentExtensionAccount(fake({ getAccount: async () => { throw new Error("x"); } })), null);
});

test("a transaction is sent to the extension as the person's own numbers, with the input as bytes", () => {
  const r = signRequest(want);
  assert.deepEqual(r, { toIdentity: "D".repeat(60), amount: "25000", targetTick: 83_000_100, inputType: 6, inputBytes: want.payload });
  assert.ok(r.inputBytes instanceof Uint8Array);
  assert.equal("inputBytes" in signRequest({ ...want, payload: new Uint8Array(0), inputType: 1 }), false);
});

test("the signed bytes are used only when they are exactly what was asked for", async () => {
  const p = fake();
  const bytes = await signWithExtension(p, want);
  assert.deepEqual(p.seen[0], signRequest(want));
  assert.equal(bytes.length, 80 + 56 + 64);
  // the extension signs with its active account, which is not the one that is connected
  const other = fake({ signTransaction: async (r) => ({ txId: "x", targetTick: r.targetTick, txBytesBase64: b64(txBytes({ ...want, source: key(9) })), txBytesHex: "" }) });
  await assert.rejects(signWithExtension(other, want), /signed from a different account than the one connected/);
  const wrongAmount = fake({ signTransaction: async (r) => ({ txId: "x", targetTick: r.targetTick, txBytesBase64: b64(txBytes({ ...want, amount: 1n })), txBytesHex: "" }) });
  await assert.rejects(signWithExtension(wrongAmount, want), /different amount/);
  await assert.rejects(signWithExtension(fake({ signTransaction: async () => ({}) as never }), want), /did not return a signed transaction/);
  await assert.rejects(signWithExtension(fake({ signTransaction: async () => ({ txId: "x", targetTick: 1, txBytesBase64: "!!!not base64!!!", txBytesHex: "" }) }), want), /not a signed transaction/);
});

test("the extension's error codes are explained, and an unknown one keeps its own words", () => {
  const code = (c: string, m = "x") => Object.assign(new Error(m), { code: c });
  assert.match(extensionMessage(code("USER_REJECTED")), /You rejected the request/);
  assert.match(extensionMessage(code("NOT_CONNECTED")), /Connect it again/);
  assert.match(extensionMessage(code("NO_ACCOUNT")), /no active account/);
  assert.match(extensionMessage(code("WATCH_ONLY_ACCOUNT")), /watch-only/);
  assert.match(extensionMessage(code("INVALID_PASSPHRASE")), /passphrase was wrong/);
  assert.match(extensionMessage(code("UNSUPPORTED_ORIGIN")), /does not allow this site/);
  assert.match(extensionMessage(code("INVALID_REQUEST")), /busy/);
  assert.match(extensionMessage(code("METHOD_NOT_SUPPORTED")), /Update the extension/);
  assert.match(extensionMessage(code("INVALID_PARAMS", "Invalid toIdentity")), /did not accept the request \(Invalid toIdentity\)/);
  assert.match(extensionMessage(new Error("Provider request timed out")), /did not answer in time/);
  assert.equal(extensionMessage(code("INTERNAL_ERROR", "disk full")), "disk full");
  assert.doesNotMatch(extensionMessage({ code: "FUNNY", message: "odd" }), /\[object Object\]/);
});

test("switching account or disconnecting inside the extension is reported, and listening can be stopped", () => {
  const p = fake();
  const seen: unknown[] = [];
  const stop = watchExtension(p, (a) => seen.push(a), () => seen.push("gone"));
  p.fire("accountChanged", { identity: ID_C, name: "Second" });
  p.fire("accountChanged", null);
  p.fire("accountChanged", { identity: "junk" }); // not a real identity: treated as no account
  p.fire("disconnect", undefined);
  assert.deepEqual(seen, [{ identity: ID_C, name: "Second" }, null, null, "gone"]);
  stop();
  p.fire("disconnect", undefined);
  assert.equal(seen.length, 4, "nothing more after stopping");
});
