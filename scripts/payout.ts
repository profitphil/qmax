// Pays the subscribers their share of QMax's fees. QMax works out who is owed what and builds the transactions; you sign them,
// here, in your own terminal, with your own seed. Nothing is signed without --send, and nothing is ever sent anywhere but QUtil.
//
//   npm run payout                       what is owed and the transactions that would pay it (signs nothing)
//   npm run payout -- --send             asks for the seed (hidden), then signs and sends each batch from QMax's own address, asking you to confirm the total first
//   --allow-repeat                        pays a wallet that this machine's own journal says it paid in the last 25 days (see below)
//
// The seed is the 55-lowercase-letter seed of the QMax address (the one subscribers pay). Type it when asked: it is not shown and not kept in your shell's history. QMAX_PAYOUT_SEED works too, but then set it with `read -s QMAX_PAYOUT_SEED; export QMAX_PAYOUT_SEED` rather than on the command line. Never put it in a file
// or a chat. ADMIN_KEY (the owner's key, from .env; API_KEY when there is no separate one) and QMAX_API (default http://localhost:8787) say where to ask.
//
// The server draws up the plan, and this script does not take its word for it: the batches' bytes are checked against QUtil's layout, the totals are
// added up here, and what each wallet has earned is worked out here again from the public archive (set PROFIT_SHARE_PCT, _CAP, _EXCLUDE and
// SUBSCRIPTION_MIN_QU the same way as for the server): a line above that is refused. It also keeps two things of its own in .cache (mode 600): a
// lock, so two runs cannot sign at once, and a journal of every batch it signed, so a server that lost or restored its ledger (and would plan
// everyone again) cannot make it pay the same wallets twice within 25 days without --allow-repeat.
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { PAYWALL } from "../src/config.ts";
import { checkPlan, overEntitlement, QUTIL_INDEX, REPEAT_WINDOW_MS, readJournalFile, recentlyPaid, takeLock, writeJournalFile } from "../src/payouts.ts";
import type { BatchView, JournalEntry } from "../src/payouts.ts";
import { balancesFor, periodBounds, shareConfigFromEnv } from "../src/profitshare.ts";
import { QubicRpc } from "../src/rpc.ts";
import { UsageLog } from "../src/usage.ts";
import type { TxStep } from "../src/exec.ts";
import { seedSigner } from "../sdk/agent.ts";
import { readSecret } from "./secret-prompt.ts";
import { runSteps } from "../web/exec/run.ts";

const args = process.argv.slice(2);
const send = args.includes("--send");
const yes = args.includes("--yes");
const allowRepeat = args.includes("--allow-repeat");
const base = (process.env.QMAX_API ?? "http://localhost:8787").replace(/\/$/, "");
const key = process.env.ADMIN_KEY || process.env.API_KEY;
// Whatever the server sends is shown to a person, so it is shown as plain text: no control characters that could redraw the terminal.
const clean = (x: unknown) => String(x).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 200);
const n = (x: number) => (Number.isFinite(Number(x)) ? Number(x).toLocaleString("en-US") : "?");
const short = (w: string) => clean(`${w.slice(0, 6)}…${w.slice(-4)}`);
const root = new URL("../", import.meta.url); // the project folder, whether this runs as scripts/payout.ts or as the bundle in .cache
const lockPath = fileURLToPath(new URL(".cache/payout.lock", root));
const journalPath = fileURLToPath(new URL(".cache/payout-journal.json", root));

if (!key) {
  console.error("ADMIN_KEY is not set (nor API_KEY: it is the owner's key, from .env). Nothing to do.");
  process.exit(1);
}
// QMax's own key goes to this address with every request: never in the clear across a network.
{
  const u = new URL(base);
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
    console.error(`QMAX_API is ${u.origin}: not this machine and not https, so the API key would travel in the clear. Not running.`);
    process.exit(1);
  }
}
async function api<T>(path: string, post?: unknown): Promise<T> {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(120_000), method: post === undefined ? "GET" : "POST", headers: { "x-api-key": key!, "content-type": "application/json" }, ...(post === undefined ? {} : { body: JSON.stringify(post) }) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${clean((j as { error?: string }).error ?? "")}`);
  return j;
}

interface Plan {
  owner: string;
  throughPeriod: string;
  feeQu: number;
  wallets: number;
  toWalletsQu: number;
  totalAttachedQu: number;
  batches: (BatchView & { wallets: number; toWalletsQu: number; tx: BatchView["tx"] & { description: string } })[];
  skipped: { wallet: string; owedQu: number; reason: string }[];
}

const bal = await api<{ start: string; periods: string[]; totalEarnedQu: number; totalPaidQu: number; totalOwedQu: number; balances: { wallet: string; discordIds: string[]; earnedQu: number; paidQu: number; owedQu: number }[] }>("/v1/profit-share/balances");
console.log(`Profit share from ${clean(bal.start)}; complete months: ${bal.periods.map(clean).join(", ") || "none yet"}`);
console.log(`  earned ${n(bal.totalEarnedQu)} QU, paid ${n(bal.totalPaidQu)} QU, owed ${n(bal.totalOwedQu)} QU`);
for (const b of bal.balances.filter((x) => x.owedQu > 0).slice(0, 15)) console.log(`    ${short(b.wallet)}  owed ${n(b.owedQu).padStart(14)} QU  (earned ${n(b.earnedQu)}, paid ${n(b.paidQu)})${b.discordIds.length ? `  discord ${b.discordIds.map(clean).join(",")}` : ""}`);

let plan: Plan;
try {
  plan = await api<Plan>("/v1/profit-share/payouts/prepare", {});
} catch (e) {
  console.log(`\nNothing to pay: ${clean(e instanceof Error ? e.message : e)}`);
  process.exit(0);
}
// Never sign what was not checked, and never trust the plan's own summary: the server only describes the batches, so the totals shown,
// confirmed and funded below are added up here from the batches themselves. Each batch's bytes must be exactly QUtil's send-to-many input
// for its listed wallets with the right amount; no wallet may be paid twice or be QMax's own address; no line may be more than that wallet is
// owed; and the plan must be paid from QMax's own address, which is a constant here and not something the server gets to name.
const check = checkPlan(plan, { owner: PAYWALL.recipient, owed: new Map(bal.balances.map((x) => [x.wallet, x.owedQu])) });
if (plan.toWalletsQu !== check.toWalletsQu || plan.totalAttachedQu !== check.totalAttachedQu || plan.wallets !== check.wallets) check.problems.push(`The plan's own totals (${plan.wallets} wallets, ${plan.toWalletsQu} QU, ${plan.totalAttachedQu} QU attached) are not what its batches add up to (${check.wallets}, ${check.toWalletsQu}, ${check.totalAttachedQu})`);
// The server drew up the plan, so it is also checked against the chain itself: the payments to QMax's address are read here, from the public
// archive, and what each wallet has earned over the complete months is worked out here with the same rules. A line above that is refused.
// (The same settings are used, so set them the same way as for the server: PROFIT_SHARE_PCT, _CAP, _EXCLUDE, SUBSCRIPTION_MIN_QU and so on.)
let independent = "";
try {
  if (!periodBounds(bal.start)) throw new Error(`the start month '${clean(bal.start)}' is not a month like 2026-10`);
  const usage = new UsageLog({ archive: new QubicRpc({ baseUrl: process.env.QUBIC_RPC_URL, maxRps: 2 }), recipient: PAYWALL.recipient });
  await usage.scanPayments();
  const mine = balancesFor(usage.allPayments(), shareConfigFromEnv(process.env, PAYWALL.recipient), bal.start, Date.now(), usage.scanState().at, new Map());
  const earned = new Map(mine.balances.map((x) => [x.wallet, x.earnedQu]));
  check.problems.push(...overEntitlement(plan.batches, earned));
  independent = `checked against the chain: ${earned.size} wallet${earned.size === 1 ? "" : "s"} have earned something over ${mine.periods.length} complete month${mine.periods.length === 1 ? "" : "s"}`;
} catch (e) {
  const why = `could not check the plan against the chain itself (${clean(e instanceof Error ? e.message : e)})`;
  if (send) check.problems.push(why + ": not signing what only the server vouches for");
  else console.warn(`\nWarning: ${why}.`);
}
if (check.problems.length) {
  console.error(`\nThis plan is not safe to sign:\n  - ${check.problems.map(clean).join("\n  - ")}`);
  process.exit(1);
}
if (independent) console.log(`\nIndependent check passed: ${independent}.`);
console.log(`\nPlan through ${clean(plan.throughPeriod)}: ${check.wallets} wallet${check.wallets === 1 ? "" : "s"}, ${n(check.toWalletsQu)} QU in ${plan.batches.length} transaction${plan.batches.length === 1 ? "" : "s"} (QUtil burns ${n(plan.feeQu)} QU per transaction; ${n(check.totalAttachedQu)} QU leaves ${short(plan.owner)} in all)`);
// Every wallet in full, so the list can be read against what is expected: this is who the money goes to, and the server drew up the list.
for (const b of plan.batches) {
  console.log(`  batch ${clean(b.id)}: ${b.lines.length} wallets, ${n(b.lines.reduce((t, l) => t + l.amountQu, 0))} QU`);
  for (const l of b.lines) console.log(`      ${l.wallet}  ${n(l.amountQu).padStart(14)} QU`);
}
for (const s of plan.skipped) console.log(`  waiting: ${short(s.wallet)} is owed ${n(s.owedQu)} QU, ${clean(s.reason)}`);
if (!plan.batches.length) process.exit(0);

if (!send) {
  console.log(`\nDry run: nothing was signed. To pay this, run again with --send in your own terminal and type the seed when asked.`);
  process.exit(0);
}
// Asked for at the terminal with nothing shown, so it is not left in the shell's history or in the process list; QMAX_PAYOUT_SEED still works for scripts.
const seed = process.env.QMAX_PAYOUT_SEED || (await readSecret(`\nSeed of ${plan.owner} (55 lowercase letters, nothing is shown as you type): `));
if (!seed) {
  console.error(`\nNo seed given. Run this in your own terminal and type it when asked (or set QMAX_PAYOUT_SEED in that shell), with --send.`);
  process.exit(1);
}
const signer = await seedSigner(seed);
if (signer.identity !== PAYWALL.recipient) {
  console.error(`\nThat seed is for ${signer.identity}, not QMax's address ${PAYWALL.recipient}. Not signing anything.`);
  process.exit(1);
}
const live = (await (await fetch(`${process.env.QUBIC_RPC_URL ?? "https://rpc.qubic.org"}/live/v1/balances/${signer.identity}`)).json().catch(() => null)) as { balance?: { balance?: string } } | null;
const have = Number(live?.balance?.balance ?? NaN);
if (!Number.isFinite(have)) {
  console.error("\nCould not read the wallet's balance, so not signing.");
  process.exit(1);
}
if (have < check.totalAttachedQu) {
  console.error(`\nThe wallet holds ${n(have)} QU but this payout needs ${n(check.totalAttachedQu)} QU. Not signing.`);
  process.exit(1);
}
// From here on this run signs: only one at a time, and never the same wallets again within a month by accident.
const lock = takeLock(lockPath);
if (!lock.ok) {
  console.error(`\nAnother payout run${lock.heldBy > 0 ? ` (process ${lock.heldBy})` : ""} is signing right now. Not signing anything.`);
  process.exit(1);
}
process.on("exit", lock.release);
let journal: JournalEntry[];
try {
  journal = readJournalFile(journalPath);
} catch (e) {
  // Not guessing: an unreadable journal would mean paying without the check it exists for.
  console.error(`\n${clean(e instanceof Error ? e.message : e)}. Not signing without it: fix or restore it (remove it only if you are sure nothing was ever paid from this machine).`);
  process.exit(1);
}
const repeats = recentlyPaid(plan.batches, journal, Date.now());
if (repeats.length && !allowRepeat) {
  console.error(`\nThis machine's own journal says it already paid ${repeats.length} of these wallets in the last ${Math.round(REPEAT_WINDOW_MS / 86_400_000)} days (the server's ledger may have been lost or restored):`);
  for (const r of repeats.slice(0, 20)) console.error(`  ${r.wallet}  paid ${n(r.paidQu)} QU on ${new Date(r.paidAt).toISOString().slice(0, 10)}, planned again for ${n(r.amountQu)} QU`);
  console.error("Payouts are monthly, so this is probably the same month paid twice. If it really is owed, run again with --allow-repeat. Nothing was signed.");
  process.exit(1);
}
if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`\nThis sends ${n(check.toWalletsQu)} QU to ${check.wallets} wallets from ${short(signer.identity)}. Type the amount to confirm: `)).replace(/[, ]/g, "");
  rl.close();
  if (typed !== String(check.toWalletsQu)) {
    console.log("That is not the amount. Nothing was signed.");
    process.exit(1);
  }
}

for (const b of plan.batches) {
  console.log(`\nBatch ${b.id}`);
  try {
    await api("/v1/profit-share/payouts/signing", { id: b.id }); // reserves its wallets, and refuses a batch that is not a live plan
  } catch (e) {
    console.error(`\nCould not reserve batch ${b.id} (${clean(e instanceof Error ? e.message : e)}). Nothing was signed for it or for any later batch.`);
    process.exitCode = 1;
    break;
  }
  // Written before signing, so a crash while signing still leaves a record of what may have been sent.
  const entry: JournalEntry = { at: Date.now(), batchId: b.id, lines: b.lines.map((l) => ({ wallet: l.wallet, amountQu: l.amountQu })) };
  journal.push(entry);
  writeJournalFile(journalPath, journal);
  let txId = "";
  let moved = true;
  const step: TxStep = {
    id: `payout-${b.id}`,
    kind: "payout",
    description: b.tx.description,
    to: { contractIndex: QUTIL_INDEX },
    inputType: b.tx.inputType,
    amountQu: b.tx.amountQu,
    payload: Uint8Array.from(Buffer.from(b.tx.payloadBase64, "base64")),
  };
  const ok = await runSteps(signer.identity, [step], (tx) => signer.sign(tx), (_id, s) => {
    if ("txId" in s && s.txId) txId = s.txId;
    if (s.status === "done" && !s.moneyFlew) moved = false; // included, but the QU never left the wallet (it could not cover it)
    console.log(`  ${s.status}${"txId" in s ? ` ${s.txId}` : ""}${s.status === "failed" ? `: ${s.error}` : ""}`);
  });
  if (txId) {
    entry.txId = txId;
    writeJournalFile(journalPath, journal);
  }
  if (txId) await api("/v1/profit-share/payouts/sent", { id: b.id, txId }).catch((e) => console.warn(`  could not tell QMax the transaction id (it will find it on-chain): ${clean(e.message)}`));
  if (ok && !moved) {
    console.error(`\nBatch ${b.id}: the transaction was included but no money moved (the wallet could not cover it). Later batches were not sent.`);
    process.exitCode = 1;
    break;
  }
  if (!ok) {
    // Without a transaction id nothing is known to have been sent, but a broadcast that timed out can still have gone through: the batch stays
    // reserved for an hour and QMax looks for it on-chain by its bytes, so do not sign it again by hand in the meantime.
    console.error(`\nStopped at batch ${b.id}. ${txId ? `Its transaction ${txId} may still have landed; QMax checks the chain and will record it if so.` : "No transaction id came back, so it was probably not sent, but it may have been: its wallets stay reserved for an hour while QMax looks for it on-chain. Do not sign it again by hand."} Later batches were not sent.`);
    process.exitCode = 1;
    break;
  }
}

console.log("\nChecking the chain…");
await new Promise((r) => setTimeout(r, 15_000));
const r = await api<{ verified: string[]; failed: { id: string; reason: string }[] }>("/v1/profit-share/payouts/reconcile", {});
console.log(`  confirmed as paid: ${r.verified.length ? r.verified.map(clean).join(", ") : "none yet"}${r.failed.length ? `; failed: ${r.failed.map((f) => `${clean(f.id)} (${clean(f.reason)})`).join("; ")}` : ""}`);
console.log("Anything not yet confirmed is checked again every two minutes by the server; run `npm run payout` again to see where it stands.");

