import { readFileSync } from "node:fs";
import { route } from "./router.ts";
import { QswapVenue, QxVenue } from "./venues.ts";
import type { VenueQuote } from "./types.ts";

const usage = `Usage: qmax <buy|sell> <qty> [--snapshot file.json] [--no-split]
  e.g. qmax buy 5000 --snapshot examples/snapshot.json`;

const args = process.argv.slice(2);
const flag = (n: string) => args.indexOf(n);
const snapIdx = flag("--snapshot");
const snapPath = snapIdx >= 0 ? args[snapIdx + 1] : new URL("../examples/snapshot.json", import.meta.url).pathname;
const [sideArg, qtyArg] = args.filter((a, i) => !a.startsWith("--") && (snapIdx < 0 || i !== snapIdx + 1));
const side = sideArg?.toLowerCase();
const qty = Number(qtyArg?.replace(/,/g, ""));
if ((side !== "buy" && side !== "sell") || !Number.isInteger(qty) || qty <= 0) {
  console.error(usage);
  process.exit(1);
}

const snap = JSON.parse(readFileSync(snapPath, "utf8"));
const venues = [new QxVenue(snap.qx), new QswapVenue(snap.qswap)];
const plan = route(venues, side, qty, { split: !args.includes("--no-split") });

const n = (x: number, d = 2) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const line = (q: VenueQuote) =>
  `${q.venue.padEnd(6)} ${n(q.qty).padStart(10)} @ ${n(q.effectivePrice, 4).padStart(10)} QU  ` +
  `total ${n(q.netQu, 0).padStart(12)}  impact ${n(q.priceImpact * 100)}%  fees ${n(q.feesQu, 0)}  fixed ${n(q.fixedCostQu, 0)}` +
  (q.depth ? `  book ${q.depth.levelsUsed} orders, ${n(q.qty / q.depth.qtyAvailable * 100, 1)}% of depth` : "");

console.log(`${side.toUpperCase()} ${n(qty)} ${snap.asset}\n`);
console.log("Single-venue options:");
for (const s of plan.singleVenue) console.log("  " + (s.quote ? line(s.quote) : `${s.venue.padEnd(6)} cannot fill`));
console.log("\nBest route:");
for (const a of plan.allocations) console.log("  → " + line(a.quote));
console.log();
console.log(
  `Total ${side === "buy" ? "cost" : "proceeds"}: ${n(plan.totalNetQu, 0)} QU  (avg ${n(plan.averagePrice, 4)} QU)`,
);
console.log(`(${plan.quoteCalls} venue quotes)`);
for (const w of plan.warnings) console.log(`WARNING: ${w}`);
if (plan.filledQty < qty) console.log(`WARNING: only ${n(plan.filledQty)} of ${n(qty)} fillable`);
