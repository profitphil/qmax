// Fills the live trade tape from the public archive and shows what it holds. Read-only: it writes nothing.
//   node ... scripts/tape-check.ts              the last 2 hours
//   node ... scripts/tape-check.ts 24           the last 24 hours (a few hundred rows, about a minute)
//   node ... scripts/tape-check.ts 2 --verify   also re-check the direction of some QX fills a second way (extra requests)
// The tape ignores assets QMax does not list; here there is no catalog, so every asset the archive shows is named from its key.
import { QubicRpc } from "../src/rpc.ts";
import { TradeTape, sideResolver } from "../src/tape.ts";
import type { TapeRow } from "../src/tape.ts";
import { assetNameFromU64 } from "../src/identity.ts";

const hours = Number(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? 2);
const verify = process.argv.includes("--verify");
if (!(hours > 0)) throw new Error("hours must be a positive number");

// One client for everything, so the archive sees at most 3 requests a second however the work is split.
const rpc = new QubicRpc({ baseUrl: process.env.QUBIC_RPC_URL, maxRps: 3 });
const lookup = sideResolver(rpc);
const tape = new TradeTape({ symbolOf: (key) => assetNameFromU64(BigInt(key.split("|")[0])), resolveSide: lookup });

const n = (x: number) => x.toLocaleString("en-US");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "n/a");

console.log(`Reading the last ${hours} hour${hours === 1 ? "" : "s"} of QX fills and QSwap swaps (at most 3 requests a second)...`);
const r = await tape.warmup(rpc, hours);
console.log(`Read ${r.windowsRead} of ${r.windows} time windows in ${(r.ms / 1000).toFixed(1)} s: ${n(r.tradesRead)} trades from the archive, ${n(r.rowsAdded)} rows on the tape.${r.error ? `\n  STOPPED EARLY: ${r.error}` : ""}`);
console.log(`The tape vouches for everything since ${new Date(r.coveredFromMs).toISOString()}.\n`);

const rows = tape.recent({ limit: 3000 });
const stats = tape.stats();

console.log("By venue (direction known / rows):");
for (const venue of ["QX", "QSwap"] as const) {
  const v = rows.filter((x) => x.venue === venue);
  const known = v.filter((x) => x.side).length;
  console.log(`  ${venue.padEnd(6)} ${String(v.length).padStart(5)} rows, direction known for ${String(known).padStart(5)} (${pct(known, v.length)})`);
}
const sided = rows.filter((x) => x.side).length;
console.log(`  all    ${String(rows.length).padStart(5)} rows, direction known for ${String(sided).padStart(5)} (${pct(sided, rows.length)}); QX sides still being looked up: ${stats.lookingUp}, lookups that failed: ${stats.lookupFailed}`);
const qxTx = new Set(rows.filter((x) => x.venue === "QX" && x.txHash).map((x) => x.txHash));
const lk = lookup.stats();
console.log(`  QX fills came from ${qxTx.size} transactions; archive transaction requests: ${lk.calls} (${lk.cached} answered from the cache, ${lk.failed} failed attempts)\n`);

const flow = tape.flow(undefined, Date.now() - hours * 3_600_000);
const pctOf = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`Buy versus sell over the window (the side that started the trade):`);
console.log(`  buys   ${String(flow.buy.trades).padStart(5)} trades  ${n(flow.buy.qu).padStart(18)} QU`);
console.log(`  sells  ${String(flow.sell.trades).padStart(5)} trades  ${n(flow.sell.qu).padStart(18)} QU`);
console.log(`  unknown${String(flow.unknown.trades).padStart(5)} trades  ${n(flow.unknown.qu).padStart(18)} QU   (left out of the pressure)`);
console.log(`  pressure ${flow.pressure === null ? "n/a (no trade with a known direction)" : `${flow.pressure >= 0 ? "+" : ""}${flow.pressure.toFixed(3)}  (buy ${pctOf((1 + flow.pressure) / 2)} of the QU, sell ${pctOf((1 - flow.pressure) / 2)})`}`);
console.log(`  by count: ${flow.buy.trades} buys, ${flow.sell.trades} sells\n`);

const byAsset = new Map<string, { buy: number; sell: number; unknown: number; n: number }>();
for (const x of rows) {
  const a = byAsset.get(x.asset) ?? { buy: 0, sell: 0, unknown: 0, n: 0 };
  a[x.side ?? "unknown"] += x.qu;
  a.n++;
  byAsset.set(x.asset, a);
}
console.log("Busiest assets on the tape (QU):");
for (const [asset, a] of [...byAsset].sort((p, q) => q[1].buy + q[1].sell + q[1].unknown - (p[1].buy + p[1].sell + p[1].unknown)).slice(0, 6))
  console.log(`  ${asset.padEnd(10)} ${String(a.n).padStart(4)} trades   buy ${n(a.buy).padStart(16)}   sell ${n(a.sell).padStart(16)}${a.unknown ? `   unknown ${n(a.unknown)}` : ""}`);

console.log("\nNewest rows:");
for (const x of rows.slice(0, 6)) console.log(`  ${new Date(x.t).toISOString().slice(11, 19)}  ${x.venue.padEnd(5)} ${(x.side ?? "?").padEnd(4)} ${n(x.qty).padStart(12)} ${x.asset.padEnd(8)} @ ${n(x.price).padStart(12)} QU`);

if (verify) await verifyDirections(rows);

/**
 * A second, independent look at the direction of QX fills: not the call type, but who ended up holding the shares. In a bid the
 * shares the archive logs as moving go TO the sender of the transaction; in an ask they leave the sender.
 */
async function verifyDirections(all: TapeRow[]) {
  // up to four buys and four sells, so both directions are tested, not only whichever happened most recently
  const txs = (side: string) => [...new Set(all.filter((x) => x.venue === "QX" && x.side === side && x.txHash).map((x) => x.txHash!))].slice(0, 4);
  const picks = [...txs("buy"), ...txs("sell")];
  console.log(`\nChecking the direction of ${picks.length} QX transactions against who received the shares:`);
  let agree = 0;
  let checked = 0;
  let selfTrades = 0;
  for (const hash of picks) {
    try {
      const txRes = await rpc.post<{ transaction?: { source: string }; source?: string }>("/query/v1/getTransactionByHash", { hash });
      const source = (txRes.transaction ?? txRes).source!;
      const logs = (await rpc.post<{ eventLogs?: { logType: number; assetOwnershipChange?: { source: string; destination: string; numberOfShares: string } }[] }>("/query/v1/getEventLogs", { filters: { transactionHash: hash }, pagination: { offset: 0, size: 200 } })).eventLogs ?? [];
      const moves = logs.filter((e) => e.logType === 2 && e.assetOwnershipChange).map((e) => e.assetOwnershipChange!);
      const gained = moves.filter((m) => m.destination === source).reduce((a, m) => a + Number(m.numberOfShares), 0);
      const gave = moves.filter((m) => m.source === source).reduce((a, m) => a + Number(m.numberOfShares), 0);
      // shares moving from the sender to the sender means the order matched the sender's own resting order: no one bought or sold
      const self = moves.filter((m) => m.source === source && m.destination === source).reduce((a, m) => a + Number(m.numberOfShares), 0);
      const byShares = self > 0 ? "self-trade" : gained > 0 && gave === 0 ? "buy" : gave > 0 && gained === 0 ? "sell" : "unclear";
      const tapeSide = all.find((x) => x.txHash === hash)!.side;
      if (byShares === "self-trade") {
        selfTrades++;
        console.log(`  ${hash.slice(0, 10)}...  tape says ${tapeSide}, but the order matched the sender's own resting order (${n(self)} shares moved from the sender to the sender): not counted either way`);
        continue;
      }
      checked++;
      if (byShares === tapeSide) agree++;
      console.log(`  ${hash.slice(0, 10)}...  tape says ${tapeSide}, the sender ${gained ? `received ${n(gained)}` : `gave away ${n(gave)}`} shares -> ${byShares === tapeSide ? "agrees" : "DISAGREES"}`);
    } catch (e) {
      console.log(`  ${hash.slice(0, 10)}...  could not check: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`  ${agree} of ${checked} checked agree${selfTrades ? `; ${selfTrades} more were self-trades` : ""}.`);
}
