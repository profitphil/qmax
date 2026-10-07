import { test } from "node:test";
import assert from "node:assert/strict";
import { AssetCatalog, CONTRACT_ISSUER } from "../src/catalog.ts";
import { QubicRpc } from "../src/rpc.ts";
import { assetNameToU64 } from "../src/identity.ts";

const TOKEN_ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const OTHER_ISSUER = "QXMRTKAIIGLUREPIQPCMHCKWSIPDTUYFCFNYXQLTECSUJVYEMMDELBMDOEYB";

const i64 = (...v: number[]) => {
  const b = Buffer.alloc(8 * v.length);
  v.forEach((x, i) => b.writeBigInt64LE(BigInt(x), i * 8));
  return b;
};
const book = (price: number, qty: number) => {
  const first = Buffer.concat([Buffer.alloc(32, 1), i64(price, qty)]);
  return Buffer.concat([first, Buffer.alloc(255 * 48)]);
};
const emptyBook = () => Buffer.alloc(256 * 48);

/** Fake chain: AAAA-issued QX share with a book, CFB token with book + pool, DEAD token with nothing. */
function fakeRpc() {
  const fetch = (async (url: string, init?: { body?: string }) => {
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
    if (url.includes("/v1/assets/issuances")) {
      const u = new URL(url);
      const all = [
        { name: "QX", issuerIdentity: CONTRACT_ISSUER },
        { name: "CFB", issuerIdentity: TOKEN_ISSUER },
        { name: "CFB", issuerIdentity: OTHER_ISSUER }, // same name, different issuer
        { name: "DEAD", issuerIdentity: OTHER_ISSUER },
      ];
      const byIssuer = u.searchParams.get("issuerIdentity");
      const byName = u.searchParams.get("assetName");
      const rows = all.filter((a) => (!byIssuer || a.issuerIdentity === byIssuer) && (!byName || a.name === byName));
      return json({ assets: rows.map((data) => ({ data })) });
    }
    const { contractIndex, inputType, requestData } = JSON.parse(init!.body!);
    const input = Buffer.from(requestData, "base64");
    const name = input.readBigUInt64LE(32);
    let out = emptyBook();
    const isQxShare = input.subarray(0, 32).every((b) => b === 0); // the contract issuer decodes to zero bytes
    if (contractIndex === 1 && (inputType === 2 || inputType === 3)) {
      if (isQxShare && name === assetNameToU64("QX")) out = book(inputType === 2 ? 1_100 : 1_000, 7);
      else if (name === assetNameToU64("CFB")) out = book(inputType === 2 ? 3 : 2, 100);
    } else if (contractIndex === 13 && inputType === 2) {
      out = name === assetNameToU64("CFB") ? Buffer.concat([i64(1, 1_000_000, 500_000, 9, 0)]) : Buffer.concat([i64(0, 0, 0, 0, 0)]);
    }
    return json({ responseData: out.toString("base64") });
  }) as never;
  return new QubicRpc({ fetch, retries: 0, maxRps: 10_000 });
}

test("catalog separates contract shares from tokens, prices them and drops dead markets", async () => {
  const cat = new AssetCatalog(fakeRpc(), { seeds: ["CFB", "DEAD"], concurrency: 2 });
  await cat.start();
  cat.stop();
  const contracts = cat.list({ category: "contract" });
  assert.deepEqual(contracts.map((e) => e.symbol), ["QX"]);
  assert.equal(contracts[0].priceQu, 1_050); // mid of 1000/1100
  assert.deepEqual(contracts[0].venues, ["QX"]);

  const tokens = cat.list({ category: "token" });
  assert.ok(tokens.every((e) => e.symbol === "CFB")); // DEAD has no market, so it is not listed
  assert.ok(tokens.length >= 1);
  assert.equal(cat.ready, true);
});

test("search filters by name, and unknown ids resolve to nothing", async () => {
  const cat = new AssetCatalog(fakeRpc(), { seeds: ["CFB"] });
  await cat.start();
  cat.stop();
  assert.equal(cat.list({ q: "qx" }).length, 1);
  assert.equal(cat.find("NOPE"), undefined);
  assert.equal(cat.find("qx")!.symbol, "QX");
  assert.deepEqual(await cat.search("not a name!"), []);
});

test("an asset whose name is not plain letters and digits is never listed, wherever the name came from", async () => {
  const names = ["**BOLD**", "@every", "a`b", "[x](y)", "CF B", "ABCDEFGH", "OK1"];
  const fetch = (async (url: string, init?: { body?: string }) => {
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
    if (url.includes("/v1/assets/issuances")) return json({ assets: [...names.map((name) => ({ data: { name, issuerIdentity: TOKEN_ISSUER } })), { data: { name: "OK2", issuerIdentity: "not an issuer" } }].map((data) => ({ data: data.data })) });
    const { requestData } = JSON.parse(init!.body!);
    void requestData;
    return json({ responseData: Buffer.concat([Buffer.alloc(32, 1), i64(5, 10), Buffer.alloc(255 * 48)]).toString("base64") });
  }) as never;
  const cat = new AssetCatalog(new QubicRpc({ fetch, retries: 0, maxRps: 10_000 }), { concurrency: 2 });
  await cat.start();
  cat.stop();
  for (const e of cat.list({})) assert.match(e.symbol, /^[A-Za-z0-9]{1,7}$/);
  assert.deepEqual(cat.list({}).map((e) => e.symbol).filter((s) => names.includes(s) && s !== "OK1"), []);
  assert.ok(cat.list({}).every((e) => e.symbol !== "OK2"), "a row with no valid issuer is dropped too");
});
