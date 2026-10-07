import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityIndex } from "../src/activity.ts";
import { AssetCatalog } from "../src/catalog.ts";
import { assetNameToU64, identityToBytes } from "../src/identity.ts";
import type { QubicRpc } from "../src/rpc.ts";

const ISSUER = "CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL";
const OTHER = "QXMRTKAIIGLUREPIQPCMHCKWSIPDTUYFCFNYXQLTECSUJVYEMMDELBMDOEYB";

const order = (issuer: string, name: string) => {
  const b = Buffer.alloc(56);
  b.set(identityToBytes(issuer), 0);
  b.writeBigUInt64LE(assetNameToU64(name), 32);
  return b.toString("base64");
};

interface Call { lo: number; hi: number; type: string; offset: number }

/** Fake archive: orders for CFB at tick 1,000,000 (ts 5000), a failed one for QXMR, and a wide-range cap. */
function fakeRpc(latest: number, calls: Call[]) {
  return {
    get: async () => ({ tickInfo: { tick: latest } }),
    post: async (_path: string, body: any) => {
      const lo = Number(body.ranges.tickNumber.gte);
      const hi = Number(body.ranges.tickNumber.lte);
      calls.push({ lo, hi, type: body.filters.inputType, offset: body.pagination.offset });
      if (hi - lo > 60_000) return { hits: { total: 10_000 }, transactions: [] }; // exceeds the cap, must be split
      const txs = [];
      if (body.filters.inputType === "5" && lo <= 1_000_000 && 1_000_000 <= hi) {
        txs.push({ timestamp: "5000", inputData: order(ISSUER, "CFB"), moneyFlew: true });
        txs.push({ timestamp: "9000", inputData: order(OTHER, "QXMR"), moneyFlew: false }); // failed: ignored
      }
      return { hits: { total: txs.length }, transactions: txs };
    },
  } as unknown as QubicRpc;
}

test("scans two epochs of QX orders, splits oversized ranges, ignores failed orders", async () => {
  const calls: Call[] = [];
  const idx = new ActivityIndex(fakeRpc(3_000_000, calls));
  await idx.update();
  assert.equal(idx.complete, true);
  assert.equal(idx.lastQxOrderAt("CFB", ISSUER), 5000);
  assert.equal(idx.lastQxOrderAt("QXMR", OTHER), null);
  assert.ok(calls.every((c) => c.hi - c.lo <= 60_000 || c.offset === 0)); // oversized ranges were only probed once, then split
  assert.ok(calls.some((c) => c.hi - c.lo <= 60_000));
});

test("a second update only scans the new ticks", async () => {
  const calls: Call[] = [];
  const rpc1 = fakeRpc(3_800_000, calls);
  const idx = new ActivityIndex(rpc1);
  await idx.update();
  const before = calls.length;
  (idx as any).rpc = fakeRpc(3_800_050, calls);
  await idx.update();
  const fresh = calls.slice(before);
  assert.ok(fresh.length > 0 && fresh.length <= 2);
  assert.ok(fresh.every((c) => c.lo >= 3_800_000 && c.hi <= 3_800_050));
});

test("catalog labels assets active, inactive or unknown", () => {
  const now = Date.now();
  const day = 24 * 3_600_000;
  const index = { complete: true, progress: 1, lastQxOrderAt: (s: string) => (s === "LIVE" ? now - day : null) } as unknown as ActivityIndex;
  const cat = new AssetCatalog({} as QubicRpc, { activity: index });
  const base = { issuer: ISSUER, category: "token" as const, priceQu: 1, liquidityQu: 1, probedAt: now };
  const put = (e: object) => (cat as any).entries.set(Math.random().toString(), e);
  put({ ...base, id: "LIVE", symbol: "LIVE", venues: ["QX"] }); // recent order
  put({ ...base, id: "DEAD", symbol: "DEAD", venues: ["QX"] }); // book but no orders in the window
  put({ ...base, id: "POOLQ", symbol: "POOLQ", venues: ["QSwap"], observedSince: now - 2 * day }); // pool unchanged for 2 days
  put({ ...base, id: "POOLN", symbol: "POOLN", venues: ["QSwap"], observedSince: now - 1000 }); // only just seen
  put({ ...base, id: "SWAPS", symbol: "SWAPS", venues: ["QSwap"], observedSince: now - 2 * day, poolChangedAt: now - 3600_000 });
  const by = Object.fromEntries(cat.list().map((e) => [e.id, e.activity]));
  assert.deepEqual(by, { LIVE: "active", DEAD: "inactive", POOLQ: "inactive", POOLN: "unknown", SWAPS: "active" });
});

test("assets are unknown while the order history is still loading", () => {
  const index = { complete: false, progress: 0.3, lastQxOrderAt: () => null } as unknown as ActivityIndex;
  const cat = new AssetCatalog({} as QubicRpc, { activity: index });
  (cat as any).entries.set("x", { id: "X", symbol: "X", issuer: ISSUER, category: "token", venues: ["QX"], priceQu: 1, liquidityQu: 1, probedAt: 0 });
  assert.equal(cat.list()[0].activity, "unknown");
  assert.equal(cat.activityStatus.progress, 0.3);
});

test("ids stay unique while a scan is still running", async () => {
  const cat = new AssetCatalog({} as QubicRpc, {});
  const mk = (issuer: string) => ({ id: "GARTH", symbol: "GARTH", issuer, category: "token", venues: ["QX"], priceQu: 1, liquidityQu: 1, probedAt: 0 });
  (cat as any).entries.set("a", mk(ISSUER));
  (cat as any).entries.set("b", mk(OTHER));
  (cat as any).assignIds();
  const ids = cat.list().map((e) => e.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => id.startsWith("GARTH.")));
});

test("a contract's shares that share a name with a token are NAMESC, and the token keeps the plain name", () => {
  const cat = new AssetCatalog({} as QubicRpc, {});
  const mk = (issuer: string, category: string) => ({ id: "QTREAT", symbol: "QTREAT", issuer, category, venues: ["QX"], priceQu: 1, liquidityQu: 1, probedAt: 0 });
  (cat as any).entries.set("c", mk("A".repeat(55) + "FXIB", "contract"));
  (cat as any).entries.set("t", mk(ISSUER, "token"));
  (cat as any).assignIds();
  const byCategory = (c: string) => cat.list().find((e) => e.category === c)!;
  assert.equal(byCategory("contract").id, "QTREATSC");
  assert.equal(byCategory("token").id, "QTREAT");
  assert.equal(byCategory("contract").symbol, "QTREAT"); // on the chain it is still QTREAT
  // it can be found by its id as well as by its name on the chain
  assert.deepEqual(cat.list({ q: "QTREATSC" }).map((e) => e.id), ["QTREATSC"]);
  assert.deepEqual(cat.list({ q: "QTREAT" }).map((e) => e.id).sort(), ["QTREAT", "QTREATSC"]);
  // a third issuer of the same name: the two tokens are told apart by their issuers, the contract is still NAMESC
  (cat as any).entries.set("t2", mk(OTHER, "token"));
  (cat as any).assignIds();
  const ids = cat.list().map((e) => e.id).sort();
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.includes("QTREATSC") && ids.filter((i) => i.startsWith("QTREAT.")).length === 2);
});

test("hidden assets are never probed, listed or kept from the cache", async () => {
  const mk = (issuer: string) => ({ id: "GARTH", symbol: "GARTH", issuer, category: "token", venues: ["QX"], priceQu: 1, liquidityQu: 1, probedAt: 0 });
  const cat = new AssetCatalog({} as QubicRpc, { hidden: [{ issuer: ISSUER, symbol: "GARTH" }] });
  (cat as any).probe = async (c: { issuer: string }) => mk(c.issuer);
  await (cat as any).probeAll([{ symbol: "GARTH", issuer: ISSUER }, { symbol: "GARTH", issuer: OTHER }]);
  (cat as any).assignIds();
  const listed = cat.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].issuer, OTHER);
  assert.equal(listed[0].id, "GARTH"); // no suffix needed once the other issuer is gone
});
