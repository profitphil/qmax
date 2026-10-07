// Reads past QX trades and QSwap swaps from the public archive and shows what history that gives. Writes nothing.
//   npm run trades-check             the last 30 days
//   npm run trades-check -- 210      the last 210 days (about as far back as the archive's events go)
import { readFileSync } from "node:fs";
import { QubicRpc } from "../src/rpc.ts";
import { TradeIndex } from "../src/trades.ts";
import { HistoryStore } from "../src/history.ts";
import { assetNameFromU64 } from "../src/identity.ts";

const days = Number(process.argv[2] ?? 30);
const root = new URL("../", import.meta.url).pathname;
const rpc = new QubicRpc({ baseUrl: process.env.QUBIC_RPC_URL, maxRps: 3 });
const index = new TradeIndex(rpc, { days });

const started = Date.now();
const tick = setInterval(() => process.stdout.write(`\r  reading the archive... ${Math.round(index.progress * 100)}%   `), 1000);
await index.update();
clearInterval(tick);
const s = index.stats();
const day = (ms: number | null) => (ms === null ? "n/a" : new Date(ms).toISOString().slice(0, 10));
console.log(`\rRead ${days} days in ${((Date.now() - started) / 1000).toFixed(0)} s: ${s.trades.toLocaleString("en-US")} trades by ${s.assets} assets, in ${s.slots.toLocaleString("en-US")} asset-minutes, from ${day(s.firstMs)}.\n`);

// The busiest assets by QU traded.
const volume: { key: string; qu: number; qx: number; swaps: number }[] = [];
const keys = new Set<string>();
// the index keeps its assets private; ask it by name through samples() for the ones we can derive keys for
const probe = (index as unknown as { assets: Map<string, Record<"QX" | "QSwap", Map<number, { qu: number; n: number }>>> }).assets;
for (const [key, book] of probe) {
  keys.add(key);
  const sum = (m: Map<number, { qu: number; n: number }>) => [...m.values()].reduce((a, h) => ({ qu: a.qu + h.qu, n: a.n + h.n }), { qu: 0, n: 0 });
  const qx = sum(book.QX);
  const qs = sum(book.QSwap);
  volume.push({ key, qu: qx.qu + qs.qu, qx: qx.n, swaps: qs.n });
}
volume.sort((a, b) => b.qu - a.qu);
console.log("Busiest assets (QU traded):");
for (const v of volume.slice(0, 10)) {
  const name = assetNameFromU64(BigInt(v.key.split("|")[0]));
  console.log(`  ${name.padEnd(8)} ${Math.round(v.qu / 1e6).toLocaleString("en-US").padStart(12)} M QU   ${String(v.qx).padStart(5)} QX trades  ${String(v.swaps).padStart(5)} swaps`);
}

// Compare the rebuilt prices with what QMax recorded live over the same hours.
try {
  const live = new HistoryStore(root + ".cache/history.json");
  console.log("\nRebuilt hourly prices vs prices QMax recorded live (same hours, assets with both):");
  let shown = 0;
  for (const asset of live.assets()) {
    const key = [...keys].find((k) => assetNameFromU64(BigInt(k.split("|")[0])) === asset);
    if (!key || shown >= 6) continue;
    const venue = (index.samples(key, "QSwap")[0] ? "QSwap" : "QX") as "QSwap" | "QX";
    const rebuilt = index.samples(key, venue);
    const recorded = live.series(asset, null, Date.now(), 100_000).filter((x) => !x.src && x.price !== null);
    const diffs: number[] = [];
    for (const r of rebuilt) {
      const same = recorded.filter((x) => Math.floor(x.t / 3_600_000) === Math.floor(r.t / 3_600_000));
      if (same.length && r.price) diffs.push(Math.abs(same[same.length - 1].price! - r.price) / r.price);
    }
    if (!diffs.length) continue;
    diffs.sort((a, b) => a - b);
    shown++;
    console.log(`  ${asset.padEnd(8)} ${venue.padEnd(6)} ${String(diffs.length).padStart(3)} shared hours, median difference ${(diffs[Math.floor(diffs.length / 2)] * 100).toFixed(1)}%`);
  }
  if (!shown) console.log("  (QMax has no recorded samples that overlap yet)");
} catch {
  console.log("\n(no recorded history to compare with)");
}
