// Runs the pool analytics on real data and shows what they say. Writes nothing and calls no RPC.
//   node --experimental-strip-types --no-warnings scripts/pools-check.ts <copy of trades.json> [http://localhost:8787]
// Use a COPY of .cache/trades.json (that file belongs to the running server); this script refuses the original.
// The pools come from the API's /v1/assets (poolQu and poolAsset on each asset), the swaps from the copy.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { activityKey } from "../src/activity.ts";
import { QubicRpc } from "../src/rpc.ts";
import { TradeIndex } from "../src/trades.ts";
import { FEE_MODEL, LP_FEE_FRACTION, poolStats, poolsRoutes } from "../src/pools.ts";
import type { PoolDetailResponse, PoolItem, PoolsDeps, PoolsResponse, PoolWindow } from "../src/pools.ts";
import type { AssetItem } from "../src/apitypes.ts";

const file = process.argv[2];
const api = (process.argv[3] ?? "http://localhost:8787").replace(/\/$/, "");
if (!file) {
  console.error("Give the path of a COPY of trades.json: cp .cache/trades.json /some/scratch/dir/trades.json");
  process.exit(2);
}
if (/\.cache[\\/]trades\.json$/.test(resolve(file))) {
  console.error("That is the live trade index's own file. Copy it first and pass the copy.");
  process.exit(2);
}

const assets = ((await (await fetch(`${api}/v1/assets`)).json()) as { assets: AssetItem[] }).assets.filter((a) => a.poolQu != null && a.poolAsset != null);
const trades = new TradeIndex(new QubicRpc(), { file }); // only reads: update() is never called
const keyOf = (a: { symbol: string; issuer: string }) => {
  try {
    return activityKey(a.symbol, a.issuer);
  } catch {
    return null;
  }
};
const byId = new Map(assets.map((a) => [a.id, a]));
const now = Date.now();
const stats = trades.stats();
console.log(`Trade index copy: ${stats.trades.toLocaleString("en-US")} trades in ${stats.hours.toLocaleString("en-US")} asset-hours from ${stats.firstMs ? new Date(stats.firstMs).toISOString().slice(0, 10) : "n/a"}; read back to ${new Date(stats.lowMs).toISOString().slice(0, 10)}.`);
console.log(`${assets.length} assets with a QSwap pool (of the API's list). The LP share of a swap: ${FEE_MODEL.lpFeePctOfVolume}% (${FEE_MODEL.split.map((s) => `${s.who} ${s.pct}%`).join(", ")} of the ${FEE_MODEL.swapFeePct}% fee).\n`);

// The deps, built the way src/server.ts should build them.
const deps: PoolsDeps = {
  pools: () => assets.map((a) => ({ id: a.id, symbol: a.symbol, poolQu: a.poolQu!, poolAsset: a.poolAsset!, priceQu: a.priceQu })),
  hours: (id) => {
    const a = byId.get(id);
    const k = a && keyOf(a);
    return k ? trades.hours(k, "QSwap") : null;
  },
  coveredSince: () => (trades.stats().highTick ? trades.stats().lowMs : Date.now()),
};
const routes = poolsRoutes(deps, { now: () => now });
const list = (window: string, sort: string) => routes[0].handler({ query: new URLSearchParams({ window, sort }), body: undefined }) as PoolsResponse;

/* 1. An independent re-sum of the raw rows (columns: hour, qu, qty, n, ...), to check the path through TradeIndex and poolStats. */
const raw = JSON.parse(readFileSync(file, "utf8")) as { assets: Record<string, { QSwap?: number[][] }> };
let mismatches = 0;
for (const w of ["7d", "30d"] as PoolWindow[]) {
  const start = now - (w === "7d" ? 7 : 30) * 86_400_000;
  for (const p of list(w, "tvl").pools) {
    const k = keyOf(byId.get(p.id)!);
    const rows = (k && raw.assets[k]?.QSwap) || [];
    let qu = 0;
    let n = 0;
    for (const r of rows) if (r[0] + 3_600_000 > start) (qu += r[1]), (n += r[3]);
    if (qu !== p.volumeQu || n !== p.swaps) (mismatches++, console.log(`  MISMATCH ${p.id} ${w}: raw ${qu} QU / ${n} swaps, stats ${p.volumeQu} / ${p.swaps}`));
    const fees = qu * LP_FEE_FRACTION;
    if (Math.abs(fees - p.feesToLpQu) > 0.01) (mismatches++, console.log(`  MISMATCH fees ${p.id} ${w}`));
  }
}
console.log(`Independent re-sum of the raw hourly rows vs poolStats (volume, swaps, fees, both windows, every pool): ${mismatches === 0 ? "all agree" : `${mismatches} DISAGREE`}\n`);

/* 2. The rankings. */
const M = (x: number) => (x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : `${(x / 1e6).toFixed(1)}M`);
const pct = (x: number | null, d = 1) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`);
const row = (p: PoolItem) =>
  `${String(p.rank).padStart(2)}  ${p.symbol.padEnd(8)} TVL ${M(p.tvlQu).padStart(8)}  vol ${M(p.volumeQu).padStart(9)}  swaps ${String(p.swaps).padStart(4)}  APR ${p.feeAprPct.toFixed(2).padStart(8)}%  price ${pct(p.priceChangePct).padStart(9)}  IL ${pct(p.impermanentLossPct, 2).padStart(8)}  net ${pct(p.netVsHoldPct, 2).padStart(8)}  ${p.lowConfidence ? "[" + p.quality.map((q) => q.label).join("; ") + "]" : ""}`;
for (const w of ["7d", "30d"] as PoolWindow[]) {
  console.log(`=== ${w}, ranked by fee APR (pools without quality notes first) ===`);
  for (const p of list(w, "apr").pools) console.log(row(p));
  console.log();
}
console.log("=== 7d, by raw APR with no demotion, for comparison ===");
console.log(
  list("7d", "apr")
    .pools.slice()
    .sort((a, b) => b.feeAprPct - a.feeAprPct)
    .slice(0, 5)
    .map((p) => `${p.symbol} ${p.feeAprPct.toFixed(1)}%${p.lowConfidence ? " (flagged)" : ""}`)
    .join(", "),
);

/* 3. Hand-check trail: the numbers behind the top and bottom entries. */
const hand = (id: string, w: PoolWindow) => {
  const a = byId.get(id)!;
  const k = keyOf(a)!;
  const start = now - (w === "7d" ? 7 : 30) * 86_400_000;
  const hrs = trades.hours(k, "QSwap");
  const inWin = hrs.filter((h) => h.hour + 3_600_000 > start);
  const before = hrs.filter((h) => h.hour + 3_600_000 <= start).at(-1);
  const vol = inWin.reduce((s, h) => s + h.qu, 0);
  const top = [...inWin].sort((x, y) => y.qu - x.qu).slice(0, 3);
  const p = list(w, "tvl").pools.find((x) => x.id === id)!;
  console.log(`\n--- ${id} ${w}: pool ${M(a.poolQu!)} QU + ${a.poolAsset!.toLocaleString("en-US")} units, price ${(a.poolQu! / a.poolAsset!).toPrecision(5)} QU`);
  console.log(`    volume ${M(vol)} x ${LP_FEE_FRACTION} = ${M(vol * LP_FEE_FRACTION)} fees; / TVL ${M(2 * a.poolQu!)} = ${((vol * LP_FEE_FRACTION) / (2 * a.poolQu!) * 100).toFixed(4)}% in ${w}; x 365/${w === "7d" ? 7 : 30} = ${p.feeAprPct}% a year`);
  console.log(`    last swap before the window: ${before ? `${new Date(before.hour).toISOString().slice(0, 13)}h at ${before.close.toPrecision(5)}` : "none"}; first in it: ${inWin[0] ? `${new Date(inWin[0].hour).toISOString().slice(0, 13)}h at ${inWin[0].open.toPrecision(5)}` : "none"}`);
  console.log(`    busiest hours: ${top.map((h) => `${new Date(h.hour).toISOString().slice(5, 13)}h ${M(h.qu)} in ${h.n} swaps (price ${h.low.toPrecision(4)}-${h.high.toPrecision(4)})`).join("; ") || "none"}`);
  console.log(`    -> price change ${pct(p.priceChangePct)} (${p.priceChangeFrom}), IL ${pct(p.impermanentLossPct, 3)}, fee return ${p.feeReturnPct}%, net ${pct(p.netVsHoldPct, 3)}`);
  for (const q of p.quality) console.log(`    note: ${q.message}`);
};
const ranked = list("7d", "apr").pools;
const picks = [...new Set([ranked[0].id, ranked[1].id, ranked.find((p) => p.lowConfidence)?.id, ranked.slice().sort((a, b) => b.feeAprPct - a.feeAprPct)[0].id, ranked.at(-1)!.id].filter((x): x is string => !!x))];
for (const id of picks) hand(id, "7d");

/* 4. The detail endpoint with a deposit, as the web panel calls it. */
const top = ranked[0];
const d = routes[1].handler({ query: new URLSearchParams({ asset: top.id, window: "7d", positionQu: "100000000" }), body: undefined }) as PoolDetailResponse;
const e = d.positionEstimate!;
console.log(`\nDetail for ${top.id}, a 100M QU deposit: ${e.sharePct}% of the pool, ${e.feesPerDayQu.toLocaleString("en-US")} QU/day, ${e.feesPer30dQu.toLocaleString("en-US")} QU per 30 days (${e.aprAfterDepositPct}% APR after dilution); the two flat 100,000 QU fees take ${e.costs.daysToCoverCosts ?? "never"} days of fees to cover.`);
console.log(`  IL table: ${e.il.map((r) => `${r.movePct > 0 ? "+" : ""}${r.movePct}%: ${r.ilPct}% (${r.ilQu.toLocaleString("en-US")} QU)`).join("; ")}`);

// poolStats called directly, without the routes, for one pool, to show the pure function needs nothing else.
const sample = poolStats({ id: top.id, poolQu: top.poolQu, poolAsset: top.poolAsset, hours: deps.hours(top.id), window: "30d", now });
console.log(`\npoolStats() direct, ${top.id} 30d: APR ${sample.feeAprPct}%, ${sample.swaps} swaps, IL ${sample.impermanentLossPct}%`);
