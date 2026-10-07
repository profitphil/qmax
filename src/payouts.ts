import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { TxStep } from "./exec.ts";
import { identityToBytes } from "./identity.ts";
import { contractIndexOf } from "./ledger.ts";
import type { Balance } from "./profitshare.ts";
import { eventsAt, lastLogTick, tickTimeOf } from "./usage.ts";
import type { Archive, ArchiveTx } from "./usage.ts";

/**
 * Paying the shares out, without QMax ever holding a key.
 *
 * QMax works out who is owed what (`profitshare.ts`) and turns it into QUtil `SendToManyV1` transactions: one transaction pays up to 25
 * wallets, so a month's payout for a hundred subscribers is four transactions the owner signs in their own wallet or shell. This
 * module builds those transactions, remembers them, and finds out from the chain what really happened, because the chain, not a
 * promise from whoever signed, decides what counts as paid:
 *
 *   prepared   built and waiting for the owner to sign (a plan; replacing it is harmless)
 *   sent       the owner is signing it, or a transaction for it was reported or found on-chain, not yet confirmed. Its wallets are
 *              reserved: they are not planned again until it settles
 *   verified   the transaction is in, from the owner's address to QUtil, with exactly this payload, and QUtil's own transfer events
 *              show each wallet received exactly its amount: only now does it count as paid
 *   failed     the transaction is in but the contract refunded it (wrong fee, say), paid only some of its wallets (what did move is still
 *              credited, so those wallets are not paid again), or it never appeared
 *   cancelled  a plan dropped before anything was sent
 *
 * From Qubic's QUtil.h (SendToManyV1, procedure 1): the input is 25 destination ids (800 bytes) then 25 signed 64-bit amounts (200
 * bytes), unused slots zero; the QU attached must equal the sum of the amounts plus the contract's fee (10 QU at the time of writing,
 * read live with GetSendToManyV1Fee) exactly, otherwise everything is refunded; the fee is burned.
 */

export const QUTIL_INDEX = 4;
/** QUtil's identity (contract 4), as seen on real send-to-many transactions. */
export const QUTIL_ID = "EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVWRF";
export const SEND_TO_MANY_PROC = 1;
export const MAX_RECIPIENTS = 25;
/** QU's total supply is 1e15, and the contract refuses an amount at or above it. */
const MAX_AMOUNT = 1_000_000_000_000_000;
/** A sent batch the archive never shows is given up on after this long. */
export const NOT_FOUND_AFTER_MS = 60 * 60_000;
/** A plan nobody signed is dropped after this long (a late signature is still found and credited). */
export const PLAN_EXPIRES_MS = 24 * 3_600_000;
/** How far back a dropped or failed batch is still looked for on-chain, in case it was signed late. */
const WATCH_MS = 30 * 24 * 3_600_000;
/**
 * How far a plan's time may differ from the chain's time for a transaction to still belong to it. The plan is stamped with this server's
 * clock and the transaction with the network's, so a clock that is a few minutes off must not hide a payment that was really made (the
 * wallets would then be planned and paid again). Transactions with the same bytes are normally far apart (a month), so this costs nothing.
 */
const CLOCK_SKEW_MS = 10 * 60_000;

export interface PayoutLine {
  wallet: string;
  amountQu: number;
}

export type BatchStatus = "prepared" | "sent" | "verified" | "failed" | "cancelled";

export interface Batch {
  id: string;
  createdAt: number;
  /** When this plan was last made current: a plan nobody signs for a day is dropped. (`createdAt` stays, as it starts the window its transactions are matched in.) */
  planAt?: number;
  /** The last period these balances include. */
  throughPeriod: string;
  lines: PayoutLine[];
  /** What the contract charges per call, read from it when the plan was made. */
  feeQu: number;
  /** The amount to attach: every line plus the fee. */
  amountQu: number;
  /** The transaction's input, base64 (1000 bytes). */
  payload: string;
  status: BatchStatus;
  /** The transaction reported for it, or the first one found with its payload. */
  txId?: string;
  sentAt?: number;
  verifiedAt?: number;
  /** What each wallet really received, adding up every transaction of this batch that the contract paid out. */
  paid?: PayoutLine[];
  /** Other transactions with exactly this payload sent while this plan was current: signed more than once, so the wallets were paid again. */
  duplicateTx?: string[];
  /** Transactions already checked (and credited if they paid). */
  checkedTx?: string[];
  /** Those that actually paid the wallets. More than one means the batch was paid more than once. */
  paidTx?: string[];
  /** Those that moved money to only some of the wallets (or other amounts than planned): what moved is credited, the batch is flagged. */
  partialTx?: string[];
  note?: string;
}

/* ---------- the transaction ---------- */

const isWallet = (w: string) => /^[A-Z]{60}$/.test(w);

/**
 * A destination that is a person's wallet and not the all-zero id or a contract's address (an index in the first byte, zeros after it).
 * QUtil skips the all-zero id but still counts its amount toward the total, so that QU would stay in the contract for good.
 */
const isPayableWallet = (w: string) => identityToBytes(w).subarray(1).some((x) => x !== 0);

/** The 1000-byte input of SendToManyV1 for these lines. Refuses anything the contract would refuse or that would misdirect money. */
export function sendToManyPayload(lines: PayoutLine[]): Uint8Array {
  if (lines.length < 1 || lines.length > MAX_RECIPIENTS) throw new Error(`A batch pays 1 to ${MAX_RECIPIENTS} wallets, not ${lines.length}`);
  const seen = new Set<string>();
  const out = new Uint8Array(1000);
  const view = new DataView(out.buffer);
  lines.forEach((l, i) => {
    if (!isWallet(l.wallet)) throw new Error(`'${l.wallet}' is not a 60-letter identity`);
    if (seen.has(l.wallet)) throw new Error(`${l.wallet} is listed twice in one batch`);
    if (!isPayableWallet(l.wallet)) throw new Error(`'${l.wallet}' is not a wallet that can be paid (the all-zero id and contract addresses are refused: QUtil would keep the money)`);
    seen.add(l.wallet);
    if (!Number.isSafeInteger(l.amountQu) || l.amountQu < 1 || l.amountQu >= MAX_AMOUNT) throw new Error(`Amount ${l.amountQu} for ${l.wallet} is not a whole number of QU from 1 up to the contract's limit`);
    out.set(identityToBytes(l.wallet), i * 32);
    view.setBigInt64(800 + i * 8, BigInt(l.amountQu), true);
  });
  return out;
}

/** The transaction the owner signs for one batch. Its `payload` is the base64 of the input. */
export function batchStep(b: Batch): TxStep {
  return {
    id: `payout-${b.id}`,
    kind: "payout",
    description: `Profit share: pay ${b.lines.length} subscriber${b.lines.length === 1 ? "" : "s"} ${b.lines.reduce((s, l) => s + l.amountQu, 0).toLocaleString("en-US")} QU in one transaction (plus the ${b.feeQu} QU fee QUtil burns)`,
    to: { contractIndex: QUTIL_INDEX },
    inputType: SEND_TO_MANY_PROC,
    amountQu: b.amountQu,
    payload: Uint8Array.from(Buffer.from(b.payload, "base64")),
  };
}

/** Adds two lists of payments, wallet by wallet. */
function mergePaid(a: PayoutLine[], b: PayoutLine[]): PayoutLine[] {
  const m = new Map<string, number>();
  for (const l of [...a, ...b]) m.set(l.wallet, (m.get(l.wallet) ?? 0) + l.amountQu);
  return [...m].map(([wallet, amountQu]) => ({ wallet, amountQu }));
}

/** Still looked for on-chain: made (or last made current) within the watch window. A plan brought back after a month is as live as a new one. */
const watched = (b: Batch, now: number) => now - (b.planAt ?? b.createdAt) < WATCH_MS;

const idOf = (payloadB64: string, feeQu: number, createdAt: number) => createHash("sha256").update(`${payloadB64}:${feeQu}:${createdAt}`).digest("hex").slice(0, 16);

/**
 * Splits what is owed into batches of up to 25, biggest first. The same lines and fee always give the same bytes (the same
 * transaction); the id also carries the time, because the same lines can be owed again next month and are then a new payment.
 */
export function buildBatches(lines: PayoutLine[], feeQu: number, throughPeriod: string, now: number): Batch[] {
  if (!Number.isSafeInteger(feeQu) || feeQu < 0 || feeQu > 1_000_000) throw new Error(`The send-to-many fee ${feeQu} does not look right; refusing to build a payout`);
  const sorted = [...lines].sort((a, b) => b.amountQu - a.amountQu || (a.wallet < b.wallet ? -1 : 1));
  const out: Batch[] = [];
  for (let i = 0; i < sorted.length; i += MAX_RECIPIENTS) {
    const chunk = sorted.slice(i, i + MAX_RECIPIENTS);
    const payload = Buffer.from(sendToManyPayload(chunk)).toString("base64");
    const amountQu = chunk.reduce((s, l) => s + l.amountQu, 0) + feeQu;
    if (!Number.isSafeInteger(amountQu) || amountQu >= MAX_AMOUNT) throw new Error("A batch is too large for one transaction");
    out.push({ id: idOf(payload, feeQu, now), createdAt: now, throughPeriod, lines: chunk, feeQu, amountQu, payload, status: "prepared" });
  }
  return out;
}

/** What the API returns for a batch: what a signer is shown and signs. */
export interface BatchView {
  id: string;
  status: BatchStatus;
  lines: PayoutLine[];
  feeQu: number;
  amountQu: number;
  tx: { destinationContractIndex: number | null; inputType: number; amountQu: number; payloadBase64: string };
}

/**
 * Checks a batch the way a signer should before signing it, without trusting whoever built it: the bytes must be exactly the
 * SendToManyV1 input for the listed lines, going to QUtil's procedure 1, attaching exactly the amounts plus the fee. Returns the
 * problems found (none means it is safe to sign as shown).
 */
export function checkBatchView(v: BatchView): string[] {
  const problems: string[] = [];
  let expected: string | undefined;
  try {
    expected = Buffer.from(sendToManyPayload(v.lines)).toString("base64");
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  if (expected !== undefined && v.tx.payloadBase64 !== expected) problems.push("The transaction's bytes do not match the listed wallets and amounts");
  const sum = v.lines.reduce((s, l) => s + l.amountQu, 0);
  if (!Number.isSafeInteger(v.feeQu) || v.feeQu < 0 || v.feeQu > 1_000_000) problems.push(`The fee ${v.feeQu} does not look right`);
  if (v.tx.amountQu !== sum + v.feeQu || v.amountQu !== v.tx.amountQu) problems.push(`The amount to attach (${v.tx.amountQu}) is not the listed amounts (${sum}) plus the fee (${v.feeQu}); QUtil would refund it`);
  if (v.tx.destinationContractIndex !== QUTIL_INDEX || v.tx.inputType !== SEND_TO_MANY_PROC) problems.push("It is not a send-to-many call to QUtil");
  return problems;
}

export interface PlanCheck {
  problems: string[];
  /** Counted from the batches themselves, never from the plan's own summary: this is what is shown, confirmed and funded. */
  wallets: number;
  toWalletsQu: number;
  totalAttachedQu: number;
}

/**
 * What a signer checks about a whole plan before signing any of it, without trusting the server that built it: every batch passes
 * `checkBatchView`, is a live plan, no wallet is paid in two batches or is the signer itself, each line is no more than that wallet is
 * owed (when the owed amounts are known), and the totals are added up here instead of read from the plan, so the amount the owner is asked
 * to confirm, and the balance that is checked, are what the transactions really send.
 */
export function checkPlan(plan: { owner: string; batches: BatchView[] }, opts: { owner: string; owed?: Map<string, number> }): PlanCheck {
  const problems: string[] = [];
  if (plan.owner !== opts.owner) problems.push(`The plan says it is paid from ${plan.owner}, not ${opts.owner}`);
  const ids = new Set<string>();
  const wallets = new Set<string>();
  let toWalletsQu = 0;
  let totalAttachedQu = 0;
  for (const b of plan.batches) {
    if (ids.has(b.id)) problems.push(`Batch ${b.id} is listed twice`);
    ids.add(b.id);
    if (b.status !== "prepared") problems.push(`Batch ${b.id} is ${b.status}, not a plan waiting to be signed`);
    for (const p of checkBatchView(b)) problems.push(`Batch ${b.id}: ${p}`);
    for (const l of b.lines) {
      if (l.wallet === opts.owner) problems.push(`Batch ${b.id} pays the signing address itself`);
      if (wallets.has(l.wallet)) problems.push(`${l.wallet} is paid in more than one batch`);
      wallets.add(l.wallet);
      if (opts.owed && !(l.amountQu <= (opts.owed.get(l.wallet) ?? 0))) problems.push(`Batch ${b.id} pays ${l.wallet} ${l.amountQu} QU, more than the ${opts.owed.get(l.wallet) ?? 0} QU it is owed`);
      toWalletsQu += l.amountQu;
    }
    totalAttachedQu += b.tx.amountQu;
  }
  return { problems, wallets: wallets.size, toWalletsQu, totalAttachedQu };
}

/* ---------- the signer's own memory ---------- */

/** What the signing script writes down, in its own file, before it signs each batch. It does not depend on the server's ledger. */
export interface JournalEntry {
  at: number;
  batchId: string;
  txId?: string;
  lines: PayoutLine[];
}

/** Payouts are monthly, so a wallet paid by this machine more recently than this is probably being paid for the same month again. */
export const REPEAT_WINDOW_MS = 25 * 24 * 3_600_000;

/**
 * Wallets in a plan that the signer's own journal says it already paid recently. The server keeps its own ledger, but a ledger that was lost,
 * restored from an old copy or deleted (its error message even offers that) would make the server plan everyone again; this is the check that
 * does not depend on it.
 */
export function recentlyPaid(batches: { lines: PayoutLine[] }[], journal: JournalEntry[], now: number, withinMs = REPEAT_WINDOW_MS): { wallet: string; amountQu: number; paidAt: number; paidQu: number }[] {
  const out = new Map<string, { wallet: string; amountQu: number; paidAt: number; paidQu: number }>();
  for (const e of journal) {
    if (!(now - e.at < withinMs)) continue;
    for (const p of e.lines) for (const b of batches) for (const l of b.lines) if (l.wallet === p.wallet) out.set(l.wallet, { wallet: l.wallet, amountQu: l.amountQu, paidAt: e.at, paidQu: p.amountQu });
  }
  return [...out.values()];
}

/**
 * Lines of a plan that are more than the chain itself entitles the wallet to. `earned` is what each wallet has earned over all complete months,
 * worked out by the signer from its own read of the public archive with the same rules, not taken from the server that drew up the plan: a
 * server that was tampered with can invent wallets or inflate amounts, but it cannot change what the chain says.
 */
export function overEntitlement(batches: { lines: PayoutLine[] }[], earned: Map<string, number>): string[] {
  const problems: string[] = [];
  for (const b of batches) for (const l of b.lines) if (!(l.amountQu <= (earned.get(l.wallet) ?? 0))) problems.push(`${l.wallet} would be paid ${l.amountQu} QU, but the chain itself entitles it to at most ${earned.get(l.wallet) ?? 0} QU in all`);
  return problems;
}

/** Reads the journal: none yet is an empty one; a file that is there but cannot be read is an error, because paying without the check would defeat it. */
export function readJournalFile(path: string): JournalEntry[] {
  if (!existsSync(path)) return [];
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    j = undefined;
  }
  if (!Array.isArray(j) || !j.every((e) => e && typeof e.at === "number" && Array.isArray(e.lines))) throw new Error(`${path} exists but cannot be read`);
  return j as JournalEntry[];
}

/** Written whole to a temporary file and moved into place, readable by its owner only. */
export function writeJournalFile(path: string, journal: JournalEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(journal), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const processAlive = (pid: number) => {
  try {
    return process.kill(pid, 0), true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM"; // it exists, we are just not allowed to signal it
  }
};

/** One signing run at a time: a lock file naming the process that holds it. A lock left by a run that died, or an old one, is taken over. */
export function takeLock(path: string, o: { now?: number; pid?: number; alive?: (pid: number) => boolean; staleMs?: number } = {}): { ok: true; release(): void } | { ok: false; heldBy: number } {
  const now = o.now ?? Date.now();
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: o.pid ?? process.pid, at: now }), { flag: "wx", mode: 0o600 });
      return {
        ok: true,
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
        },
      };
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      let held: { pid?: number; at?: number } = {};
      try {
        held = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // unreadable: as good as stale
      }
      if (typeof held.pid === "number" && (o.alive ?? processAlive)(held.pid) && now - (held.at ?? 0) < (o.staleMs ?? 2 * 3_600_000)) return { ok: false, heldBy: held.pid };
      try {
        unlinkSync(path); // left by a run that died
      } catch {
        // another run just took it: the next attempt finds out
      }
    }
  }
  return { ok: false, heldBy: -1 };
}

/* ---------- checking a batch against the chain ---------- */

/**
 * `retry: false` is a final answer, except with `unconfirmed`: the archive showed nothing for long enough that the wallets are released, but
 * a transaction it indexes later must still be found and credited, because money that moved is never left off the books. `mismatch` means the
 * transaction named for the batch is not this batch's (someone else's, or other bytes): it says nothing about whether the batch itself was
 * signed, so it cannot release the wallets by itself.
 */
export type BatchVerdict =
  | { ok: true; paid: PayoutLine[] }
  | { ok: false; retry: true; reason: string }
  /** `moved`: what QUtil did send to the batch's wallets although not all of it matches the plan (credited, so those wallets are not paid again). */
  | { ok: false; retry: false; reason: string; unconfirmed?: true; mismatch?: true; moved?: PayoutLine[] };

/**
 * A transaction the archive does not show only counts as "never sent" once the archive has itself processed well past the time it was sent:
 * an archive that is hours behind (catching up after an outage) says nothing about it, and giving up then would release the wallets while
 * the transaction may be about to appear, to be planned and paid again.
 */
async function archiveHasPassed(archive: Archive, since: number, lastTick?: number): Promise<boolean> {
  try {
    const at = await tickTimeOf(archive, lastTick ?? (await lastLogTick(archive)));
    return at !== null && at - since > NOT_FOUND_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * Looks a sent batch up and decides whether it paid. It must be the owner's own transaction to QUtil carrying exactly this payload
 * and amount, and QUtil's transfer events must show each wallet receiving exactly its line.
 */
export async function verifyBatch(archive: Archive, b: Batch, owner: string, now: number, lastTick?: number): Promise<BatchVerdict> {
  const since = b.sentAt ?? b.createdAt;
  if (!b.txId) {
    // Marked as being signed, but no transaction has turned up: give it an hour (of the archive's time too), then release the wallets.
    return now - since > NOT_FOUND_AFTER_MS && (await archiveHasPassed(archive, since, lastTick)) ? { ok: false, retry: false, unconfirmed: true, reason: "no transaction for this batch was found on-chain" } : { ok: false, retry: true, reason: "no transaction id yet" };
  }
  let tx: ArchiveTx | null;
  try {
    const a = await archive.post<{ transaction?: ArchiveTx } & Partial<ArchiveTx>>("/query/v1/getTransactionByHash", { hash: b.txId });
    tx = ((a.transaction ?? a) as ArchiveTx) ?? null;
    if (!tx || typeof tx.source !== "string") tx = null;
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (/^RPC 400/.test(m)) return { ok: false, retry: false, reason: "that is not a valid transaction id" };
    // Only an answer of "no such transaction" (a 4xx) counts as not there. A 429, a 5xx or a timeout says nothing about it, and giving up on
    // one would release the wallets while the transaction may well have landed: they would be planned and paid a second time.
    if (!/^RPC 4\d\d/.test(m)) return { ok: false, retry: true, reason: "the archive did not answer" };
    tx = null;
  }
  if (!tx) return now - since > NOT_FOUND_AFTER_MS && (await archiveHasPassed(archive, since, lastTick)) ? { ok: false, retry: false, unconfirmed: true, reason: "the archive never showed that transaction" } : { ok: false, retry: true, reason: "not indexed yet" };

  if (tx.source !== owner) return { ok: false, retry: false, mismatch: true, reason: "that transaction was not sent from QMax's address" };
  if (!(tx.destination === QUTIL_ID || contractIndexOf(tx.destination) === QUTIL_INDEX) || tx.inputType !== SEND_TO_MANY_PROC) return { ok: false, retry: false, mismatch: true, reason: "that transaction is not a send-to-many to QUtil" };
  if (String(tx.amount) !== String(b.amountQu) || tx.inputData !== b.payload) return { ok: false, retry: false, mismatch: true, reason: "that transaction does not match this batch (a different payload or amount)" };

  let tick = lastTick;
  if (tick === undefined) {
    try {
      tick = await lastLogTick(archive);
    } catch {
      return { ok: false, retry: true, reason: "the archive did not answer" };
    }
  }
  if (tx.tickNumber > tick) return { ok: false, retry: true, reason: "events not indexed yet" };

  let events;
  let validForTick: number | undefined;
  try {
    ({ events, validForTick } = await eventsAt(archive, b.txId));
  } catch {
    return { ok: false, retry: true, reason: "the archive did not answer" };
  }
  // The archive may be served by replicas at different ticks: an answer valid only up to an earlier tick can hold some of this transaction's events and
  // not the rest, and 'only some wallets were paid' would then be taken as final while the others arrive a moment later.
  if (validForTick !== undefined && validForTick < tx.tickNumber) return { ok: false, retry: true, reason: "events not indexed yet" };
  // A transaction whose money moved always leaves events (a refund has two: the money in and the money back). None means the archive has not
  // indexed them yet, and judging that a refund would release the wallets of a batch that may have paid them. If the money never left the
  // wallet there will never be any events, and that is final.
  if (!events.length) return tx.moneyFlew === false ? { ok: false, retry: false, reason: "that transaction was included, but the QU never left the wallet (it could not cover the amount): nothing was sent" } : { ok: false, retry: true, reason: "events not indexed yet" };
  // QUtil moves the money itself, so its payments to the wallets are transfers whose source is QUtil.
  const got = new Map<string, number>();
  for (const e of events) if (e.quTransfer?.source === QUTIL_ID) got.set(e.quTransfer.destination, (got.get(e.quTransfer.destination) ?? 0) + Number(e.quTransfer.amount));
  // The owner's own address is never a wallet that this batch pays: with a fee of zero, QUtil's refund of everything attached would look like a payment of that line.
  const exact = b.lines.filter((l) => l.wallet !== owner && got.get(l.wallet) === l.amountQu);
  if (exact.length === b.lines.length) return { ok: true, paid: exact };
  // Whatever did reach the wallets is what they were paid, whether or not it is what was planned: it must be on the books or they are paid again.
  const moved = b.lines.filter((l) => l.wallet !== owner && Number.isSafeInteger(got.get(l.wallet)) && got.get(l.wallet)! > 0).map((l) => ({ wallet: l.wallet, amountQu: got.get(l.wallet)! }));
  if (!moved.length) return { ok: false, retry: false, reason: "QUtil sent nothing to these wallets: the transaction was refunded (a wrong fee or amount refunds everything)" };
  return { ok: false, retry: false, reason: `only ${exact.length} of ${b.lines.length} wallets received their amount; check this batch by hand`, moved };
}

/* ---------- the ledger of batches ---------- */

export interface PayoutData {
  v: 1;
  /** The first period the programme counts (the month it was switched on, unless set). */
  start: string;
  batches: Batch[];
}

export interface PayoutOptions {
  file?: string;
  now?: () => number;
}

export class PayoutLog {
  private file?: string;
  private now: () => number;
  private data: PayoutData;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private rev = 0;

  constructor(start: string, o: PayoutOptions = {}) {
    this.file = o.file;
    this.now = o.now ?? Date.now;
    this.data = { v: 1, start, batches: [] };
    if (o.file) this.adoptCompleteTemp(o.file);
    if (o.file && existsSync(o.file)) {
      // A ledger that is there but cannot be read must stop the payout. Starting empty would forget every payout already made and plan all
      // of it again (the start month comes from the settings), so the owner would pay everyone twice. No file at all is a first run.
      let saved: PayoutData | undefined;
      try {
        saved = JSON.parse(readFileSync(o.file, "utf8")) as PayoutData;
      } catch {
        saved = undefined;
      }
      if (!(saved?.v === 1 && typeof saved.start === "string" && Array.isArray(saved.batches))) {
        throw new Error(`The payout ledger ${o.file} exists but cannot be read, so QMax will not plan payouts: starting empty would pay everyone again. Fix or restore it (${o.file}.bak is the version before the last save), or remove it only if you are sure nothing was ever paid.`);
      }
      this.data = saved;
    } else if (o.file) {
      // The start of the programme is fixed by the file, so the file must exist from now on: if it were written only at the first plan, a crash
      // before that, and a restart in a later month, would take that later month for the start and silently forget the months before it.
      this.flush();
    }
  }

  /**
   * `flush` writes the new ledger to a temporary file, syncs it, and only then moves it over the ledger. A temporary file that is still there at
   * start is therefore either complete (the process died between those two steps: it is the newest state, and may hold a reservation made just
   * before signing) or cut short (it died while writing: nothing was lost, the ledger itself is intact). A complete one is moved into place.
   */
  private adoptCompleteTemp(file: string) {
    const tmp = file + ".tmp";
    if (!existsSync(tmp)) return;
    try {
      const t = JSON.parse(readFileSync(tmp, "utf8")) as PayoutData;
      if (t?.v === 1 && typeof t.start === "string" && Array.isArray(t.batches)) {
        if (existsSync(file)) {
          copyFileSync(file, file + ".bak");
          chmodSync(file + ".bak", 0o600);
        }
        renameSync(tmp, file);
        return;
      }
    } catch {
      // cut short
    }
    try {
      unlinkSync(tmp);
    } catch {
      // gone already
    }
  }

  /** Counts every change to the ledger, so a reader can tell whether what it worked out from it is still current. */
  get revision(): number {
    return this.rev;
  }

  /** The first period the programme counts. Fixed the first time the log is created. */
  get start(): string {
    return this.data.start;
  }

  list(): Batch[] {
    return this.data.batches;
  }

  get(id: string): Batch | undefined {
    return this.data.batches.find((b) => b.id === id);
  }

  /** What each wallet has really received from confirmed payouts. */
  paidByWallet(): Map<string, number> {
    const m = new Map<string, number>();
    for (const b of this.data.batches) for (const l of b.paid ?? []) m.set(l.wallet, (m.get(l.wallet) ?? 0) + l.amountQu);
    return m;
  }

  /** Wallets that are in a batch which was sent but not yet confirmed: they must not be paid again until it settles. */
  inFlight(): Map<string, number> {
    const m = new Map<string, number>();
    for (const b of this.data.batches) if (b.status === "sent") for (const l of b.lines) m.set(l.wallet, (m.get(l.wallet) ?? 0) + l.amountQu);
    return m;
  }

  /**
   * Plans what to pay now: every wallet whose balance (what it is owed, less anything sent and not yet confirmed) reaches the minimum.
   * Plans that were never signed are replaced; batches already sent or confirmed are untouched.
   */
  prepare(balances: Balance[], opts: { feeQu: number; minPayoutQu: number; throughPeriod: string; /** Never planned: QMax's own address and any wallet that is left out of the programme. */ exclude?: string[] }): Batch[] {
    const now = this.now();
    for (const b of this.data.batches) if (b.status === "prepared") (b.status = "cancelled"), (b.note = "replaced by a newer plan");
    const flying = this.inFlight();
    const skip = new Set(opts.exclude ?? []);
    const lines: PayoutLine[] = [];
    for (const bal of balances) {
      if (skip.has(bal.wallet)) continue;
      const due = bal.owedQu - (flying.get(bal.wallet) ?? 0);
      if (due >= Math.max(1, opts.minPayoutQu)) lines.push({ wallet: bal.wallet, amountQu: due });
    }
    const batches = buildBatches(lines, opts.feeQu, opts.throughPeriod, now).map((nb) => {
      // The same plan again (same bytes) that was never signed is the same plan: bring it back instead of making a second one.
      const same = this.data.batches.find((b) => b.payload === nb.payload && b.amountQu === nb.amountQu && b.status === "cancelled" && !b.txId);
      if (same) {
        same.status = "prepared";
        same.planAt = now;
        same.note = undefined;
        return same;
      }
      this.data.batches.push(nb);
      return nb;
    });
    this.flushSoon();
    return batches;
  }

  /**
   * The owner is about to sign it: its wallets are reserved from now, so planning again cannot list them a second time. Refused for a
   * batch that is not a live plan, which is what stops the same batch being signed twice.
   */
  markSigning(id: string): Batch {
    const b = this.get(id);
    if (!b) throw new Error("No such batch");
    if (b.status !== "prepared") throw new Error(`That batch is ${b.status}, not waiting to be signed. Ask for a new plan.`);
    b.status = "sent";
    b.sentAt = this.now();
    b.note = "being signed";
    this.flush(); // at once: the owner signs right after this, and a crash must not forget that these wallets are reserved
    return b;
  }

  /** The owner says they sent it. Taken as a hint: the batch counts as paid only once the chain shows it. */
  markSent(id: string, txId: string): Batch {
    const b = this.get(id);
    if (!b) throw new Error("No such batch");
    if (!/^[a-z]{60}$/.test(txId)) throw new Error("A transaction id is 60 lowercase letters");
    if (b.status === "verified") throw new Error("That batch is already confirmed as paid");
    if (b.txId && b.txId !== txId) throw new Error("That batch was already sent in another transaction");
    // A transaction the chain was already asked about, and that did not pay, is not news: reporting it again would only put a settled batch back into
    // "sent", a state nothing then moves it out of, with its wallets reserved for good.
    if (b.checkedTx?.includes(txId) && !b.paidTx?.includes(txId) && !b.partialTx?.includes(txId)) throw new Error("That transaction was already checked and did not pay this batch");
    // One transaction moved its money once. Attaching it to a second batch (the same lines owed again next month have the same bytes) would
    // credit that money twice, to wallets that were never paid for the second month.
    const owner = this.claimedBy(txId, b);
    if (owner) throw new Error(`That transaction already belongs to batch ${owner.id}`);
    b.txId = txId;
    b.status = "sent";
    b.sentAt = b.sentAt ?? this.now();
    b.note = undefined;
    this.flush();
    return b;
  }

  /**
   * The other batch this transaction already counts for: one that was credited for it, or one with exactly the same bytes that has it as its
   * own (two such batches cannot both be right, and the money moved once). A batch with different bytes that was merely told about it does
   * not count: its claim is a mistake that verification will reject, and it must not hide the transaction from the batch it really paid.
   */
  private claimedBy(txId: string, b: Batch): Batch | undefined {
    return this.data.batches.find((o) => o !== b && (o.paidTx?.includes(txId) || o.partialTx?.includes(txId) || ((o.txId === txId || o.duplicateTx?.includes(txId)) && o.payload === b.payload && o.amountQu === b.amountQu)));
  }

  /** Drops a plan nobody signed. A batch that is being signed or was sent cannot be cancelled: money may already have moved. */
  cancel(id: string): Batch {
    const b = this.get(id);
    if (!b) throw new Error("No such batch");
    if (b.status !== "prepared") throw new Error(`A ${b.status} batch cannot be cancelled`);
    b.status = "cancelled";
    b.note = "cancelled by the owner";
    this.flushSoon();
    return b;
  }

  /**
   * Finds out what happened to the batches, from the chain. The owner's own send-to-many transactions are searched for each batch's
   * payload (exact, so a match is unmistakable). Every such transaction belongs to the batch whose plan was current when it was sent,
   * so the same lines owed again next month are told apart by time. The first is the batch's transaction; any more are the batch
   * signed again, and paid the wallets again. Every transaction is verified, and whatever really moved is credited, so the books
   * match the chain: money that moved is never left unrecorded, even for a plan that was dropped or marked failed. Plans older than a
   * day are dropped, and dropped or failed ones are still looked for a month in case they were signed late.
   */
  async reconcile(archive: Archive, owner: string): Promise<{ verified: Batch[]; failed: Batch[] }> {
    if (this.busy) return { verified: [], failed: [] };
    this.busy = true;
    const out = { verified: [] as Batch[], failed: [] as Batch[] };
    try {
      const now = this.now();
      for (const b of this.data.batches) if (b.status === "prepared" && now - (b.planAt ?? b.createdAt) > PLAN_EXPIRES_MS) (b.status = "cancelled"), (b.note = "not signed within a day");

      const recent = this.data.batches.filter((b) => watched(b, now));
      if (recent.length) {
        const sent = await this.ownSends(archive, owner, Math.min(...recent.map((b) => b.createdAt)) - CLOCK_SKEW_MS, now);
        const groups = new Map<string, Batch[]>();
        for (const b of recent) groups.set(`${b.payload}:${b.amountQu}`, [...(groups.get(`${b.payload}:${b.amountQu}`) ?? []), b]);
        for (const list of groups.values()) {
          list.sort((a, b) => a.createdAt - b.createdAt);
          const hits = sent.filter((t) => t.hash && t.source === owner && t.inputData === list[0].payload && String(t.amount) === String(list[0].amountQu)).sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
          list.forEach((b, i) => {
            const lo = b.createdAt - CLOCK_SKEW_MS;
            const hi = i + 1 < list.length ? list[i + 1].createdAt - CLOCK_SKEW_MS : Infinity;
            for (const t of hits.filter((h) => Number(h.timestamp) >= lo && Number(h.timestamp) < hi)) {
              if (this.claimedBy(t.hash!, b)) continue; // already another batch's: the same money is never counted for two
              if (!b.txId) {
                b.txId = t.hash;
                b.sentAt = Number(t.timestamp) || now;
                if (b.status !== "verified") b.status = "sent";
                b.note = "found on-chain";
              } else if (t.hash !== b.txId && !b.duplicateTx?.includes(t.hash!)) {
                b.duplicateTx = [...(b.duplicateTx ?? []), t.hash!];
              }
            }
          });
        }
      }

      const open = this.data.batches.filter((b) => b.status === "sent" || (watched(b, now) && [b.txId, ...(b.duplicateTx ?? [])].some((t) => t && !b.checkedTx?.includes(t))));
      let tick: number | undefined;
      if (open.length) {
        try {
          tick = await lastLogTick(archive);
        } catch {
          tick = undefined;
        }
      }
      for (const b of open) {
        const before = b.status;
        let primary: BatchVerdict | undefined;
        for (const tx of [b.txId, ...(b.duplicateTx ?? [])]) {
          if (!tx || b.checkedTx?.includes(tx)) continue;
          const v = await verifyBatch(archive, { ...b, txId: tx }, owner, now, tick);
          if (tx === b.txId) primary = v;
          if (v.ok) (b.paid = mergePaid(b.paid ?? [], v.paid)), (b.paidTx = [...(b.paidTx ?? []), tx]);
          // Money that reached some of the wallets is on the books even though the batch did not pay as planned: those wallets are not paid again.
          else if (!v.retry && !v.unconfirmed && !v.mismatch && v.moved?.length) (b.paid = mergePaid(b.paid ?? [], v.moved)), (b.partialTx = [...(b.partialTx ?? []), tx]);
          // A verdict of "the archive never showed it" is not final: the transaction may still be indexed later, and then it is credited.
          if (v.ok || (!v.retry && !v.unconfirmed && !v.mismatch)) b.checkedTx = [...(b.checkedTx ?? []), tx];
        }
        if (!b.txId && b.status === "sent") {
          // Marked as being signed, but nothing has turned up.
          const v = await verifyBatch(archive, b, owner, now, tick);
          if (!v.ok && !v.retry) (b.status = "failed"), (b.note = v.reason), out.failed.push(b);
          continue;
        }
        if (b.paidTx?.length) {
          if (before !== "verified") (b.verifiedAt = now), out.verified.push(b);
          b.status = "verified";
          b.note = b.paidTx.length + (b.partialTx?.length ?? 0) > 1 ? "SIGNED MORE THAN ONCE: the wallets were paid by more than one transaction (see paidTx)" : undefined;
        } else if (primary && !primary.ok && !primary.retry && b.status !== "failed") {
          // A transaction that is not this batch's (a wrong id was reported) does not show that the batch was never signed: its own may be
          // on-chain and not indexed yet. Treat it as if no transaction had been named: look for the batch's own for the usual hour.
          const verdict = primary.mismatch ? await verifyBatch(archive, { ...b, txId: undefined }, owner, now, tick) : primary;
          if (!verdict.ok && !verdict.retry) {
            b.status = "failed";
            b.note = primary.reason;
            out.failed.push(b);
          } else if (!verdict.ok) {
            b.note = `${primary.reason}; still looking for the batch's own transaction`;
          }
        } else if (b.status === "sent" && b.txId && [b.txId, ...(b.duplicateTx ?? [])].every((t) => b.checkedTx?.includes(t))) {
          // Every transaction it has was checked and none paid it in full, yet it is still "sent": nothing else would ever settle it, and its wallets
          // would stay reserved for good.
          b.status = "failed";
          b.note = b.partialTx?.length ? "only some of its wallets were paid; check this batch by hand" : "its transaction was checked and did not pay";
          out.failed.push(b);
        }
      }
      this.flushSoon();
    } finally {
      this.busy = false;
    }
    return out;
  }

  private async ownSends(archive: Archive, owner: string, fromMs: number, toMs: number): Promise<ArchiveTx[]> {
    const out: ArchiveTx[] = [];
    for (let offset = 0; offset < 10_000; offset += 1000) {
      const r = await archive.post<{ hits: { total: number }; transactions?: ArchiveTx[] }>("/query/v1/getTransactionsForIdentity", {
        identity: owner,
        filters: { source: owner, destination: QUTIL_ID, inputType: String(SEND_TO_MANY_PROC) },
        ranges: { timestamp: { gte: String(fromMs), lte: String(toMs + CLOCK_SKEW_MS) } },
        pagination: { offset, size: 1000 },
      });
      out.push(...(r.transactions ?? []));
      if (offset + 1000 >= r.hits.total) break;
    }
    return out;
  }

  /**
   * Checks every couple of minutes while any batch is waiting or unaccounted for, and every half hour regardless (to catch a confirmed
   * batch that was signed a second time). Returns a function that stops it.
   */
  watch(archive: Archive, owner: string, everyMs = 120_000, onError: (e: unknown) => void = (e) => console.warn("payouts:", e instanceof Error ? e.message : e)): () => void {
    // A dropped or failed batch is looked for only for as long as `reconcile` would still match it (a month), not forever.
    const waiting = () => this.data.batches.some((b) => b.status === "prepared" || b.status === "sent" || ((b.status === "failed" || b.status === "cancelled") && !b.txId && watched(b, this.now())));
    const t = setInterval(() => waiting() && this.reconcile(archive, owner).catch(onError), everyMs);
    const slow = setInterval(() => this.data.batches.length && this.reconcile(archive, owner).catch(onError), 30 * 60_000);
    t.unref();
    slow.unref();
    return () => (clearInterval(t), clearInterval(slow));
  }

  flush() {
    this.rev++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    // Written and synced before it replaces the old file, so a crash or a power cut leaves the old ledger or the new one, never half of one.
    const fd = openSync(tmp, "w", 0o600);
    try {
      fchmodSync(fd, 0o600); // who is owed what is for the owner only
      writeSync(fd, JSON.stringify(this.data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(this.file)) {
      copyFileSync(this.file, this.file + ".bak");
      chmodSync(this.file + ".bak", 0o600);
    }
    renameSync(tmp, this.file);
  }

  private flushSoon() {
    this.rev++;
    if (this.timer || !this.file) return;
    this.timer = setTimeout(() => this.flush(), 500);
    this.timer.unref();
  }
}
