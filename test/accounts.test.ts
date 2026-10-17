import { test } from "node:test";
import assert from "node:assert/strict";
import { otherAccounts, switchHint } from "../web/accounts.ts";

const A = "A".repeat(59) + "B";
const B = "B".repeat(60);
const C = "C".repeat(60);

test("a wallet app's other accounts are offered, in its order, never the one in use, real addresses once each", () => {
  assert.deepEqual(otherAccounts("walletconnect", A, [A, B, C]), [B, C]);
  assert.deepEqual(otherAccounts("walletconnect", B, [A, B, C]), [A, C], "the one in use is left out wherever it sits in the list");
  assert.deepEqual(otherAccounts("walletconnect", A, [A, B, B, "junk", "", C, B]), [B, C]);
  assert.deepEqual(otherAccounts("walletconnect", A, [A]), [], "one account: nothing to switch to");
  assert.deepEqual(otherAccounts("walletconnect", A, undefined), []);
  assert.deepEqual(otherAccounts("walletconnect", A, "not a list" as never), []);
});

test("only a wallet app's connection can switch: a seed, a vault, MetaMask and the extension cannot", () => {
  for (const t of ["privateKey", "vaultFile", "mmSnap", "extension", undefined, ""]) assert.deepEqual(otherAccounts(t, A, [A, B, C]), [], String(t));
});

test("the extension says to switch there, and nothing else says anything", () => {
  assert.match(switchHint("extension")!, /switch in the Qubic Wallet extension: QMax follows/);
  assert.equal(switchHint("walletconnect"), null);
  assert.equal(switchHint(undefined), null);
});
