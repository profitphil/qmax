// Grades the real catalogue from the real trade index and replays the wash-trading check over the whole history. Writes nothing.
//   node --experimental-strip-types --no-warnings scripts/health-check.ts
//   ... scripts/health-check.ts --trades /path/to/copy-of-trades.json     (default: a private copy of .cache/trades.json)
//   ... scripts/health-check.ts --api http://localhost:8787               (where /v1/assets is read from)
//   ... scripts/health-check.ts --deep CFB                                (also reads a small window of raw events for that asset: about 6 archive requests)
// The trade index is only read, and from a copy: nothing here calls update(), so it never scans the archive or touches the live file.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityKey } from "../src/activity.ts";
import { decodeTrade } from "../src/events.ts";
import type { EventLog } from "../src/events.ts";
import { assessHealth, createHealth } from "../src/health.ts";
import type { HealthAsset } from "../src/health.ts";
import { QubicRpc } from "../src/rpc.ts";
import { TradeIndex } from "../src/trades.ts";
import { assetNameFromU64 } from "../src/identity.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const root = new URL("../", import.meta.url).pathname;
const api = arg("api") ?? "http://localhost:8787";
const dir = mkdtempSync(join(tmpdir(), "qmax-health-"));
const file = arg("trades") ?? join(dir, "trades.json");
if (!arg("trades")) copyFileSync(root + ".cache/trades.json", file);

try {
  const rpc = new QubicRpc({ maxRps: 2 });
  const index = new TradeIndex(rpc, { file, days: 210 });
  const s = index.stats();
  const day = (ms: number | null) => (ms === null ? "n/a" : new Date(ms).toISOString().slice(0, 10));
  console.log(`Trade index: ${s.trades.toLocaleString("en-US")} trades by ${s.assets} assets in ${s.hours.toLocaleString("en-US")} asset-hours, from ${day(s.firstMs)}, complete back to ${day(s.lowMs)}.\n`);

  /* 1. The catalogue, graded exactly as the server will grade it. */
  const items = ((await (await fetch(`${api}/v1/assets`)).json()) as { assets: (HealthAsset & { symbol: string; issuer: string })[] }).assets;
  const keyOf = (a: { symbol: string; issuer: string }) => {
    try {
      return activityKey(a.symbol, a.issuer);
    } catch {
      return null;
    }
  };
  const health = createHealth({
    assets: () => items,
    hours: (a, venue) => {
      const key = keyOf(a);
      return key ? index.hours(key, venue) : null;
    },
    historySince: () => index.stats().lowMs,
  });
  const all = health.all();
  const rows = items.map((a) => ({ id: a.id, ...all.assets[a.id], flags: all.assets[a.id].flags.join(" ") }));
  const byGrade: Record<string, number> = {};
  for (const r of rows) byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1;
  console.log("Catalogue grades:", byGrade, "\n");
  console.table(rows.map(({ id, grade, score, flags }) => ({ id, grade, score, flags })));
  const sample = health.health(items[0].id)!;
  console.log(`\nOne in full (${sample.asset}):`, JSON.stringify({ score: sample.score, grade: sample.grade, flags: sample.flags, reasons: sample.reasons, partial: sample.partial }, null, 2));

  /* 2. Replay the wash check at noon UTC on every day of the history, for every asset in the index. */
  const probe = index as unknown as { assets: Map<string, unknown> };
  const keys = [...probe.assets.keys()];
  const name = (k: string) => assetNameFromU64(BigInt(k.split("|")[0]));
  const flaggedDays = new Map<string, { suspected: string[]; burst: string[]; past: string[] }>();
  const first = (s.firstMs ?? 0) + 7 * 86_400_000;
  let checked = 0;
  for (let t = Math.ceil(first / 86_400_000) * 86_400_000 + 12 * 3_600_000; t <= Date.now(); t += 86_400_000) {
    for (const k of keys) {
      const h = assessHealth({ asset: { id: name(k) }, hours: { QX: index.hours(k, "QX"), QSwap: index.hours(k, "QSwap") }, historySince: s.firstMs, now: t });
      checked++;
      const f = flaggedDays.get(name(k)) ?? { suspected: [], burst: [], past: [] };
      if (h.flags.includes("wash-suspected")) f.suspected.push(day(t));
      if (h.flags.includes("bot-burst")) f.burst.push(day(t));
      if (h.flags.includes("wash-past")) f.past.push(day(t));
      if (f.suspected.length + f.burst.length + f.past.length) flaggedDays.set(name(k), f);
    }
  }
  console.log(`\nWash check replayed on ${checked.toLocaleString("en-US")} asset-days (${keys.length} assets, one check per day at 12:00 UTC):`);
  if (!flaggedDays.size) console.log("  nothing flagged");
  for (const [n, f] of flaggedDays) console.log(`  ${n}: wash-suspected on ${f.suspected.length} days (${f.suspected[0] ?? "-"} to ${f.suspected.at(-1) ?? "-"}), bot-burst on ${f.burst.length}, wash-past on ${f.past.length}`);

  /* 3. Optional: look at the raw events behind one asset's busiest churn-like hour. A small, polite sample. */
  const deep = arg("deep");
  if (deep) {
    const item = items.find((a) => a.id.toUpperCase() === deep.toUpperCase());
    const key = item && keyOf(item);
    if (!key) throw new Error(`no asset ${deep}`);
    const busiest = index.hours(key, "QSwap").sort((a, b) => b.n - a.n)[0];
    if (!busiest) throw new Error("it has no swaps");
    const events: EventLog[] = [];
    // The hour's first and last tick bound it; read the first 1,000 swaps of the hour (one page).
    const r = await rpc.post<{ eventLogs?: EventLog[] }>("/query/v1/getEventLogs", {
      filters: { logType: "6", contractIndex: "13" },
      ranges: { tickNumber: { gte: String(busiest.first[0]), lte: String(busiest.last[0]) } },
      pagination: { offset: 0, size: 1000 },
    });
    events.push(...(r.eventLogs ?? []));
    const trades = events.map(decodeTrade).filter((t) => t && t.key === key).sort((a, b) => a!.tick - b!.tick || Number(a!.logId) - Number(b!.logId)) as NonNullable<ReturnType<typeof decodeTrade>>[];
    const switches = trades.slice(1).filter((t, i) => t.side !== trades[i].side).length;
    const sizes = new Map<string, number>();
    for (const t of trades) sizes.set(`${t.side} ${t.qu} QU / ${t.qty} units`, (sizes.get(`${t.side} ${t.qu} QU / ${t.qty} units`) ?? 0) + 1);
    console.log(`\nRaw events, ${deep}'s busiest hour (${new Date(busiest.hour).toISOString()}, ${busiest.n} swaps), first ${trades.length} read:`);
    console.log(`  consecutive swaps that change side: ${switches} of ${trades.length - 1}`);
    console.log("  most common swaps:", [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4));
    // Who sent them: look up about 30 transactions spread over the sample (counts only).
    const picks = trades.filter((_, i) => i % Math.max(1, Math.floor(trades.length / 30)) === 0).slice(0, 30);
    const senders = new Map<string, number>();
    for (const t of picks) {
      if (!t.txHash) continue;
      const tx = await rpc.post<{ source: string }>("/query/v1/getTransactionByHash", { hash: t.txHash });
      senders.set(tx.source, (senders.get(tx.source) ?? 0) + 1);
    }
    console.log(`  sampled ${picks.length} transactions: ${senders.size} distinct sender${senders.size === 1 ? "" : "s"}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
