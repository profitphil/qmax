/**
 * Checks src/usage.ts against the real archive. Read-only; nothing is stored. Run:
 *   node --experimental-strip-types --no-warnings scripts/usage-check.ts
 *
 * 1. Takes real recent QX and QSwap trades, finds each one's sender, and verifies them as the app's report would.
 * 2. Tries the cases that must be refused, on real data: a stranger's wallet, a report that arrives late.
 * 3. Scans real QPayhub payments, once for a real seller (to check the reading) and once for QMax's own address.
 */
import { PAYWALL } from "../src/config.ts";
import { UsageLog, verifyTrade } from "../src/usage.ts";
import { QubicRpc } from "../src/rpc.ts";

const rpc = new QubicRpc({ maxRps: 2 });
const lastTick = (await rpc.get<{ logTickNumber: number }>("/query/v1/getLastProcessedTick")).logTickNumber;
console.log("last processed tick", lastTick);

const picks: { hash: string; contract: number }[] = [];
for (const contract of [1, 13]) {
  const r = await rpc.post<{ eventLogs?: { transactionHash?: string }[] }>("/query/v1/getEventLogs", {
    filters: { logType: "6", contractIndex: String(contract) },
    ranges: { tickNumber: { gte: String(lastTick - 12_000), lte: String(lastTick) } },
    pagination: { offset: 0, size: 60 },
  });
  const seen = new Set<string>();
  for (const e of r.eventLogs ?? []) if (e.transactionHash && !seen.has(e.transactionHash) && seen.size < 4) (seen.add(e.transactionHash), picks.push({ hash: e.transactionHash, contract }));
}

for (const p of picks) {
  const t = await rpc.post<{ source: string; timestamp: string; inputType: number }>("/query/v1/getTransactionByHash", { hash: p.hash });
  const at = Number(t.timestamp) + 60_000;
  const v = await verifyTrade(rpc, p.hash, t.source, at, at, lastTick);
  const stranger = await verifyTrade(rpc, p.hash, "A".repeat(59) + "B", at, at, lastTick);
  const late = await verifyTrade(rpc, p.hash, t.source, Number(t.timestamp) + 31 * 60_000, at, lastTick);
  console.log(`${p.contract === 1 ? "QX   " : "QSwap"} proc ${t.inputType} ${t.source.slice(0, 8)}…:`, v.ok ? `${v.record.kind} ${v.record.side ?? ""} ${v.record.asset ?? ""} qty ${v.record.qty} qu ${v.record.qu} fills ${v.record.fills}` : `${v.reason}${v.retry ? " (retry)" : ""}`, "| stranger:", stranger.ok ? "COUNTED (bad)" : stranger.reason, "| late:", late.ok ? "COUNTED (bad)" : late.reason);
}

// A real seller, to check the reading of Pay calls and the forward.
const hub = await rpc.post<{ transactions?: { inputData: string }[] }>("/query/v1/getTransactionsForIdentity", {
  identity: "DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH",
  filters: { destination: "DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH", inputType: "1" },
  pagination: { offset: 0, size: 1 },
});
const { identityToBytes } = await import("../src/identity.ts");
void identityToBytes;
const sellerHex = Buffer.from(hub.transactions![0].inputData, "base64").subarray(0, 32).toString("hex");
// That seller's identity is in the forward event of the same payment; read it from the archive instead of guessing.
const first = hub.transactions![0] as unknown as { hash: string };
const ev = await rpc.post<{ eventLogs?: { quTransfer?: { source: string; destination: string } }[] }>("/query/v1/getEventLogs", { filters: { transactionHash: first.hash }, pagination: { offset: 0, size: 20 } });
const seller = ev.eventLogs!.find((e) => e.quTransfer?.source.startsWith("DBAAAA"))!.quTransfer!.destination;
console.log("real seller", seller, "key", sellerHex.slice(0, 12));

const real = new UsageLog({ archive: rpc, recipient: seller });
const found = await real.scanPayments();
console.log(`payments to that seller: ${found.length}`, found.slice(0, 3).map((p) => `${p.kind} ${p.amountQu} -> ${p.forwardedQu}`));
console.log("summary:", JSON.stringify((real.stats({ days: 365 }) as { payments: unknown }).payments, null, 0).slice(0, 400));

const qmax = new UsageLog({ archive: rpc, recipient: PAYWALL.recipient });
console.log(`payments to QMax's own address: ${(await qmax.scanPayments()).length} (none expected until passes are sold)`);
