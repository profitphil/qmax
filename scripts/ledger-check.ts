/**
 * Checks the trade ledger (src/ledger.ts) against real wallets on the public archive. Read-only; stays under 3 requests a second.
 *
 *   node --experimental-strip-types --no-warnings scripts/ledger-check.ts [IDENTITY ...] [--days=180] [--sample=25]
 *
 * Without identities it finds active traders itself: the senders of the latest QSwap swaps and QX trades. For each wallet it
 * builds the ledger exactly as the API does, then compares it with what the archive says independently:
 *  1. the wallet's own QX/QSwap transactions (getTransactionsForIdentity): every one that moved shares has a trade or transfer entry;
 *  2. QSwap's SwapMessage in each sampled QSwap trade (units, and QU = pool amount +/- the flat 100,000 QU fee), which also tests
 *     the venue method (counterparty identity) against the contract's own record;
 *  3. QX's TradeMessage in each sampled QX trade (units and price x units; for sales, the fee by Qx.h's formula);
 *  4. the wallet's current shares on chain (/v1/assets/<id>/owned) against the ledger's end position.
 */
import { QubicRpc } from "../src/rpc.ts";
import { decodeTrade } from "../src/events.ts";
import type { EventLog } from "../src/events.ts";
import { buildLedger, contractIndexOf, fetchLedgerInput, qswapFlatFee, qxFee } from "../src/ledger.ts";
import type { Ledger, LedgerEntry } from "../src/ledger.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const days = flag("days", 180);
const sample = flag("sample", 25);
const rpc = new QubicRpc({ maxRps: 2.5 });

interface FullEvent extends EventLog {
  quTransfer?: { source: string; destination: string; amount: string };
  assetOwnershipChange?: { source: string; destination: string; assetIssuer: string; assetName: string; numberOfShares: string };
}

const txEvents = async (hash: string) =>
  (await rpc.post<{ eventLogs?: FullEvent[] }>("/query/v1/getEventLogs", { filters: { transactionHash: hash }, pagination: { offset: 0, size: 1000 } })).eventLogs ?? [];

/** The most active senders among the latest QSwap swaps and QX trades. */
async function discover(n: number): Promise<string[]> {
  const last = (await rpc.get<{ logTickNumber: number }>("/query/v1/getLastProcessedTick")).logTickNumber;
  const hashes: string[] = [];
  for (const contract of ["13", "1"]) {
    const r = await rpc.post<{ eventLogs?: FullEvent[] }>("/query/v1/getEventLogs", {
      filters: { logType: "6", contractIndex: contract },
      ranges: { tickNumber: { gte: String(last - 600_000), lte: String(last) } },
      pagination: { offset: 0, size: 40 },
    });
    for (const e of r.eventLogs ?? []) if (e.transactionHash && decodeTrade(e) && !hashes.includes(e.transactionHash)) hashes.push(e.transactionHash);
  }
  const count = new Map<string, number>();
  for (const h of hashes.slice(0, 36)) {
    const r = await rpc.post<{ transaction?: { source: string }; source?: string }>("/query/v1/getTransactionByHash", { hash: h });
    const source = r.transaction?.source ?? r.source; // the live API returns the transaction itself, not wrapped as the spec says
    if (source) count.set(source, (count.get(source) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");

async function check(identity: string) {
  const started = Date.now();
  const input = await fetchLedgerInput(rpc, identity, { days, maxRequests: 80 });
  const ledger: Ledger = buildLedger(input.events, { ...input });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const trades = ledger.entries.filter((e) => e.kind === "buy" || e.kind === "sell");
  console.log(`\n=== ${identity}`);
  console.log(`built with ${input.requests} archive requests in ${seconds} s: ${input.events.length} events, ${input.ownTxs.length} own QX/QSwap txs, ${input.fills.size} transactions looked up for QX fills`);
  const kinds: Record<string, number> = {};
  for (const e of ledger.entries) kinds[`${e.kind}${e.venue ? `/${e.venue}` : ""}`] = (kinds[`${e.kind}${e.venue ? `/${e.venue}` : ""}`] ?? 0) + 1;
  console.log("entries:", JSON.stringify(kinds));
  console.log(`totals: realized ${ledger.totals.realizedQu} QU, fees ${ledger.totals.feesQu} QU, uncosted proceeds ${ledger.totals.uncostedProceedsQu} QU, escrow ${ledger.totals.escrowQu} QU`);
  for (const w of [...ledger.warnings, ...ledger.truncatedReasons]) console.log("note:", w);

  // 1. own transactions that moved shares must have an entry
  const entryTx = new Set(ledger.entries.map((e) => e.tx));
  const sharesTx = new Set(input.events.filter((e) => e.logType === 2).map((e) => e.transactionHash));
  const own = input.ownTxs.filter((t) => sharesTx.has(t.hash));
  const missingOwn = own.filter((t) => !entryTx.has(t.hash));
  console.log(`1. own transactions that moved shares: ${own.length}, with a ledger entry: ${own.length - missingOwn.length}${missingOwn.length ? ` MISSING ${missingOwn.map((t) => t.hash).join(" ")}` : ""}`);

  // 2 and 3. sampled trades against the contracts' own messages
  const results = { qswap: { ok: 0, bad: 0 }, qx: { ok: 0, bad: 0 }, feeExact: 0, feeOff: 0, venueWrong: 0 };
  const bad: string[] = [];
  const picks = [...trades.filter((e) => e.venue === "QSwap").slice(-sample), ...trades.filter((e) => e.venue === "QX").slice(-sample)];
  for (const e of picks) {
    const evs = (await txEvents(e.tx)).sort((a, b) => Number(a.logId) - Number(b.logId));
    const swaps = evs.filter((x) => x.smartContractMessage?.contractIndex === "13" && ["6", "7", "8", "9"].includes(x.smartContractMessage.contractMessageType));
    if (e.venue === "QSwap") {
      const m = swaps[0];
      if (!m || !m.rawPayload) {
        results.venueWrong++;
        bad.push(`${e.tx} QSwap entry but no SwapMessage`);
        continue;
      }
      const b = Buffer.from(m.rawPayload, "base64");
      const [inAmt, outAmt] = [Number(b.readBigInt64LE(40)), Number(b.readBigInt64LE(48))];
      const isBuy = ["6", "7"].includes(m.smartContractMessage!.contractMessageType);
      const flat = qswapFlatFee(m.epoch);
      const ok = isBuy ? e.kind === "buy" && outAmt === e.qty && inAmt + flat === e.valueQu : e.kind === "sell" && inAmt === e.qty && outAmt - flat === e.valueQu;
      results.qswap[ok ? "ok" : "bad"]++;
      if (!ok) bad.push(`${e.tx} QSwap ${e.kind} ${e.qty} for ${e.valueQu} QU; message says in ${inAmt}, out ${outAmt}`);
      continue;
    }
    if (swaps.length) {
      results.venueWrong++;
      bad.push(`${e.tx} QX entry but the transaction has a QSwap SwapMessage`);
    }
    // the wallet's share movements, each followed by its QX TradeMessage
    let qty = 0;
    let gross = 0;
    let fee = 0;
    for (let i = 0; i < evs.length; i++) {
      const c = evs[i].assetOwnershipChange;
      if (evs[i].logType !== 2 || !c || c.assetName !== e.asset!.symbol || c.assetIssuer !== e.asset!.issuer) continue;
      const mine = e.kind === "buy" ? c.destination === identity && c.source !== identity : c.source === identity && c.destination !== identity;
      if (!mine) continue;
      const tm = evs.slice(i + 1).find((x) => x.smartContractMessage?.contractIndex === "1" && x.smartContractMessage.contractMessageType === "0");
      const t = tm ? decodeTrade(tm) : null;
      if (!t || t.qty !== Number(c.numberOfShares)) continue;
      qty += t.qty;
      gross += t.qu;
      fee += qxFee(t.qu);
    }
    const ok = qty === e.qty && (e.kind === "buy" ? gross === e.valueQu : gross - fee === e.valueQu);
    results.qx[ok ? "ok" : "bad"]++;
    if (!ok) bad.push(`${e.tx} QX ${e.kind} ${e.qty} for ${e.valueQu} QU; trade messages say ${qty} for ${gross} QU (fee ${fee})`);
    if (e.kind === "sell") results[e.feeQu === fee ? "feeExact" : "feeOff"]++;
    if (e.kind === "sell" && e.feeQu !== fee) bad.push(`${e.tx} QX sale fee: ledger ${e.feeQu} QU, Qx.h on the trade messages ${fee} QU`);
  }
  console.log(`2. QSwap trades vs SwapMessage: ${results.qswap.ok} exact, ${results.qswap.bad} different (of ${results.qswap.ok + results.qswap.bad} sampled)`);
  console.log(`3. QX trades vs TradeMessage: ${results.qx.ok} exact, ${results.qx.bad} different (of ${results.qx.ok + results.qx.bad} sampled); QX sale fees exactly as Qx.h: ${results.feeExact}, off: ${results.feeOff}; venue contradicted: ${results.venueWrong}`);
  for (const line of bad.slice(0, 8)) console.log("   ", line);

  // 4. end positions against the shares the wallet owns now
  const owned = await rpc.get<{ ownedAssets?: { data: { numberOfUnits: string; issuedAsset: { name: string; issuerIdentity: string } } }[] }>(`/v1/assets/${identity}/owned`);
  const onChain = new Map<string, number>();
  for (const a of owned.ownedAssets ?? []) {
    const k = `${a.data.issuedAsset.name}|${a.data.issuedAsset.issuerIdentity}`;
    onChain.set(k, (onChain.get(k) ?? 0) + Number(a.data.numberOfUnits));
  }
  let exact = 0;
  let explained = 0;
  const off: string[] = [];
  for (const p of ledger.positions) {
    const chain = onChain.get(p.asset.key) ?? 0;
    // the window's own net change; whatever the wallet holds beyond it was there before the window
    const inWindow = p.held - p.preWindowQty;
    const before = chain - inWindow;
    if (chain === p.held && p.preWindowQty === 0) exact++;
    else if (before >= 0) explained++;
    else off.push(`${p.asset.symbol}: ledger end ${p.held} (net ${inWindow} in window), on chain ${chain}`);
  }
  console.log(`4. positions vs shares on chain now: ${exact} equal, ${explained} differ only by units held before the window, ${off.length} contradict${off.length ? ":" : ""}`);
  for (const line of off.slice(0, 6)) console.log("   ", line);
  return { identity, requests: input.requests, seconds: Number(seconds), trades: trades.length, results, positions: ledger.positions.length, exact, explained, contradicted: off.length, missingOwn: missingOwn.length, entries: ledger.entries as LedgerEntry[] };
}

const ids = args.filter((a) => !a.startsWith("--"));
const wallets = ids.length ? ids : await discover(4);
console.log(`checking ${wallets.length} wallets over ${days} days (sample ${sample} trades per venue each)`);
const all = [];
for (const id of wallets) all.push(await check(id));

let ok = 0;
let total = 0;
for (const r of all) (ok += r.results.qswap.ok + r.results.qx.ok), (total += r.results.qswap.ok + r.results.qswap.bad + r.results.qx.ok + r.results.qx.bad);
console.log(`\nsummary: ${all.length} wallets, ${all.reduce((s, r) => s + r.trades, 0)} trades; sampled trades exact against the contracts' messages: ${ok}/${total} (${pct(ok, total)}); positions contradicting the chain: ${all.reduce((s, r) => s + r.contradicted, 0)}; requests per ledger: ${all.map((r) => r.requests).join(", ")}`);
const contractTouches = all.flatMap((r) => r.entries).filter((e) => e.asset && contractIndexOf(e.asset.issuer) !== null).length;
console.log(`entries in contract shares (issuer is a contract): ${contractTouches}`);
