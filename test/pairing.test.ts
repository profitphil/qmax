import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFailure, makePairing, MemoryStorage, PairingError, startClient, TIMEOUT_MESSAGE, withTimeout } from "../web/wallet/pairing.ts";

const never = <T>() => new Promise<T>(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("withTimeout passes a result through and rejects a hang with the message", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, "late"), 7);
  await assert.rejects(withTimeout(never(), 10, "too slow"), (e: Error) => e instanceof PairingError && e.message === "too slow");
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 50, "late"), /boom/);
});

test("a pairing that never comes back ends with the network message instead of waiting for ever", async () => {
  const limits = { readyMs: 20, pairMs: 20 };
  await assert.rejects(
    makePairing(() => Promise.resolve("client"), () => never(), limits),
    (e: Error) => e instanceof PairingError && e.message === TIMEOUT_MESSAGE,
  );
  await assert.rejects(
    makePairing(() => never<string>(), async () => "uri", limits),
    (e: Error) => e instanceof PairingError && e.message === TIMEOUT_MESSAGE,
  );
  assert.equal(await makePairing(() => Promise.resolve("c"), async (c) => `uri:${c}`, limits), "uri:c");
});

test("startClient falls back to the in-memory client when the normal one fails or hangs", async () => {
  assert.equal(await startClient(async () => "normal", async () => "memory", 20), "normal");
  assert.equal(await startClient(async () => { throw new Error("storage blocked"); }, async () => "memory", 20), "memory");
  assert.equal(await startClient(() => never<string>(), async () => "memory", 20), "memory");
});

test("startClient reports the first failure when both fail", async () => {
  await assert.rejects(
    startClient(async () => { throw new Error("first"); }, async () => { throw new Error("second"); }, 20),
    /first/,
  );
  await assert.rejects(startClient(() => never(), () => never(), 10), (e: Error) => e instanceof PairingError);
});

test("MemoryStorage keeps, lists and removes entries", async () => {
  const m = new MemoryStorage();
  assert.equal(await m.getItem("a"), undefined);
  await m.setItem("a", { n: 1 });
  await m.setItem("b", 2);
  assert.deepEqual(await m.getItem("a"), { n: 1 });
  assert.deepEqual((await m.getKeys()).sort(), ["a", "b"]);
  assert.deepEqual((await m.getEntries()).length, 2);
  await m.removeItem("a");
  assert.equal(await m.getItem("a"), undefined);
  await sleep(0);
});

test("describeFailure shows our own messages as they are and wraps anything else in plain words", () => {
  assert.equal(describeFailure(new PairingError("Say this.")), "Say this.");
  const other = describeFailure(new Error("WebSocket   connection\nfailed"));
  assert.match(other, /^Could not create the connection link \(WebSocket connection failed\)\./);
  assert.match(other, /VPN or content blocker/);
  assert.match(describeFailure("odd"), /\(odd\)/);
  assert.doesNotMatch(describeFailure(new Error("")), /\(\)/);
});

import { inAppBrowser, newestQubicSession, pairingIsFresh } from "../web/wallet/pairing.ts";

test("a pairing the page started is expected to be answered for ten minutes, and not before it started", () => {
  const t = 1_000_000;
  assert.equal(pairingIsFresh(null, t), false);
  assert.equal(pairingIsFresh(t - 1_000, t), true);
  assert.equal(pairingIsFresh(t - 9 * 60_000, t), true);
  assert.equal(pairingIsFresh(t - 10 * 60_000, t), false);
  assert.equal(pairingIsFresh(t + 5_000, t), false, "a time in the future is not trusted");
  assert.equal(pairingIsFresh(Number.NaN, t), false);
});

test("of the sessions the client holds, the newest one for Qubic is the one to take up", () => {
  const s = (topic: string, expiry: number, ns: Record<string, unknown> = { qubic: {} }) => ({ topic, expiry, namespaces: ns });
  assert.equal(newestQubicSession([]), null);
  assert.equal(newestQubicSession([s("a", 1, { eip155: {} })]), null, "a session for another chain is not ours");
  assert.equal(newestQubicSession([s("a", 100), s("b", 300), s("c", 200)])!.topic, "b");
  assert.equal(newestQubicSession([s("a", 500, { eip155: {} }), s("b", 100)])!.topic, "b");
  assert.equal(newestQubicSession([{ topic: "x", expiry: 9 }]), null, "a session without namespaces is not used");
});

test("in-app browsers that often cannot open a wallet app are recognised, and ordinary browsers are not", () => {
  const safariIphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const chromeAndroid = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
  assert.equal(inAppBrowser(safariIphone), false);
  assert.equal(inAppBrowser(chromeAndroid), false);
  assert.equal(inAppBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"), false);
  assert.equal(inAppBrowser(chromeAndroid.replace("Pixel 8)", "Pixel 8; wv)")), true, "an Android web view");
  assert.equal(inAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]"), true, "Facebook's");
  assert.equal(inAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"), true, "an iPhone web view with no Safari in its name");
  assert.equal(inAppBrowser("Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile Safari/537.36 Instagram 330.0"), true);
});
