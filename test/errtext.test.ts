import { test } from "node:test";
import assert from "node:assert/strict";
import { errorText, stepFailure } from "../src/errtext.ts";

test("the words in whatever was thrown, including the { code, message } object a wallet sends back (which printed as [object Object])", () => {
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("plain"), "plain");
  assert.equal(errorText({ code: -32603, message: "Failed to get current tick" }), "Failed to get current tick");
  assert.equal(errorText({ error: { code: 5000, message: "User rejected" } }), "User rejected");
  assert.equal(errorText({ reason: "closed" }), "closed");
  assert.equal(errorText({ code: 7, data: [1] }), '{"code":7,"data":[1]}');
  assert.notEqual(errorText({ code: 7 }), "[object Object]");
  assert.equal(errorText(undefined), "undefined");
  assert.equal(errorText(new Error("")), "Error");
  const loop: Record<string, unknown> = {};
  loop.error = loop;
  assert.ok(errorText(loop).length > 0); // a self-referencing object does not hang or throw
});

test("the failures a wallet is known to give are explained in plain words, with whether anything was sent and what to do", () => {
  const rate = stepFailure({ code: -32603, message: "Failed to get current tick: Server is rate limiting requests. This can happen when multiple apps are accessing the network or when using a VPN. (Status Code: 429)" });
  assert.match(rate, /rate limiting/);
  assert.match(rate, /Nothing was sent/);
  assert.match(rate, /try again/i);
  assert.doesNotMatch(rate, /\[object Object\]/);
  const expired = stepFailure({ code: -32603, message: "Failed to get current tick: JsonRpcError(code: -32002, message: Tick value is Expired)" });
  assert.match(expired, /approving took too long/);
  assert.match(expired, /about 30 seconds/);
  assert.match(stepFailure({ code: 5000, message: "User rejected." }), /You rejected the request in your wallet/);
});

test("anything else keeps its own words, and our own tick message is not mistaken for the wallet's", () => {
  assert.equal(stepFailure(new Error("Broadcast failed (429): too many requests")), "Broadcast failed (429): too many requests");
  assert.equal(stepFailure("Signing took too long and the tick expired. Please try again."), "Signing took too long and the tick expired. Please try again.");
  assert.equal(stepFailure({ message: "The wallet did not return a signed transaction." }), "The wallet did not return a signed transaction.");
});
