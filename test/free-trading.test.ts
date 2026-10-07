import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PAYWALL, passRequired } from "../src/config.ts";
import { verifiedPass } from "../web/exec/pass.ts";

const g = globalThis as unknown as Record<string, unknown>;
const real = { fetch: g.fetch, localStorage: g.localStorage };
afterEach(() => {
  g.fetch = real.fetch;
  if (real.localStorage === undefined) delete g.localStorage;
  else g.localStorage = real.localStorage;
});

test("trading is free by default: no pass is required", () => {
  assert.equal(passRequired(), false);
});

test("with trading free the website checks nothing: no network, no storage, and every wallet may trade", async () => {
  let touched = 0;
  g.fetch = async () => (touched++, new Response("{}"));
  g.localStorage = { getItem: () => (touched++, null), setItem: () => touched++ };
  const pass = await verifiedPass(PAYWALL.recipient);
  assert.ok(pass, "a wallet with no pass is not stopped");
  assert.equal(pass!.wallet, PAYWALL.recipient);
  assert.equal(touched, 0, "and nothing was asked of the network or the browser's storage");
});
