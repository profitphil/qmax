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
