import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRef } from "./deeplink.ts";
import { QX_CONTRACT, QSWAP_CONTRACT, decodeTrade } from "./events.ts";
import type { EventLog } from "./events.ts";
import { assetNameFromU64, identityToBytes } from "./identity.ts";
import { QX_ID, QSWAP_ID, contractIndexOf } from "./ledger.ts";
import { QPAYHUB_MIN_PAYMENT_QU } from "./qpay.ts";
import { QPAYHUB_IDENTITY, SESSION_RESOURCE_ID, resourceTag } from "./x402.ts";
import { readResource } from "./procover.ts";

/**
 * Who trades through QMax, counted from the chain.
 *
 * QMax never sees a trade: the wallet signs it and the browser sends it to the public network. So the app tells QMax the
 * transaction ids it just sent, and this module does not take that on trust. Each id is looked up in the archive and counts only
 * if the transaction really was sent by that wallet to QX or QSwap, was recent, and really filled (the contract's own event log
 * says what changed hands and for how much). What that proves is "this wallet made this trade", not "it went through QMax":
 * anyone can name a real, recent trade of any wallet. Treat the numbers as measured usage, not as proof for paying anyone.
 *
 * Payments to QMax (the pass, the Discord subscription, API top-ups) need no report at all: QPayhub is a contract, so every
 * `Pay` to QMax's address is on-chain, and `PaymentScan` reads them from the archive.
 */

export type Channel = "web" | "discord" | "agent";
const CHANNELS: readonly Channel[] = ["web", "discord", "agent"];

export interface TradeRecord {
  tx: string;
  wallet: string;
  ref?: string;
  channel: Channel;
  venue: "QX" | "QSwap";
  /** `trade`: something changed hands. `liquidity`: QSwap liquidity was added or removed (no price, so no volume). */
  kind: "trade" | "liquidity";
  side?: "buy" | "sell";
  /** The asset that traded most, by name (the part before any dot is the symbol). */
  asset?: string;
  qty: number;
  /** QU that changed hands in the fills this transaction caused. */
  qu: number;
  fills: number;
  tick: number;
  /** ms since epoch, from the transaction */
  t: number;
  /** When QMax confirmed it. */
  at: number;
}

export type PaymentKind = "pass" | "subscription" | "api-topup" | "session" | "pro" | "proset" | "other";

export interface PaymentRecord {
  tx: string;
  payer: string;
  kind: PaymentKind;
  /** For a subscription: the Discord user it was paid for (the bot puts it in the receipt's resource id). */
  discordId?: string;
  /** For a Max pass (`pro`) or a change of its list (`proset`): the fingerprint of the list of covered addresses it carries, if any (see src/procover.ts). */
  cover?: string;
  amountQu: number;
  /** What QPayhub forwarded to QMax (the amount less its fee). */
  forwardedQu: number;
  tick: number;
  t: number;
}

interface Pending {
  tx: string;
  wallet: string;
  ref?: string;
  channel: Channel;
  reportedAt: number;
  tries: number;
  nextAt: number;
}

export interface UsageData {
  v: 2;
  /** When counting began: nothing before it is in the numbers. */
  since: number;
  trades: Record<string, TradeRecord>;
  pending: Pending[];
  /** Ids that failed verification for good, so a repeated report is not looked up again. */
  rejectedIds: string[];
  rejected: Record<string, number>;
  payments: Record<string, PaymentRecord>;
  /** Payments up to this tick have been read. */
  paymentTick: number;
  /** QPayhub payments to QMax that QPayhub refunded (nothing was forwarded). */
  refusedPayments: number;
  /** Their ids, so a payment seen twice (a wallet lookup, then the scan) is not counted twice. */
  refusedIds: string[];
  /** When the last full payment scan finished (ms): payments before this moment are all in `payments`. */
  paymentScanAt: number;
}

export type RejectReason = "wrong-wallet" | "not-a-trade" | "no-effect" | "too-old" | "bad-id" | "unverified";

/** What the archive gives back; only the parts used here. */
export interface Archive {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface ArchiveTx {
  hash?: string;
  source: string;
  destination: string;
  amount: string;
  tickNumber: number;
  timestamp: string;
  inputType: number;
  inputData?: string;
  moneyFlew?: boolean;
}

const MAX_TRADES = 100_000;
const MAX_PENDING = 5_000;
const MAX_REJECTED_IDS = 5_000;
const MAX_PER_REPORT = 10;
const TX_ID = /^[a-z]{60}$/;
const WALLET = /^[A-Z]{60}$/;
/** A report must come soon after the trade: this is what stops someone back-filling old history. */
export const REPORT_WINDOW_MS = 30 * 60_000;
/** Give up on an id the archive never confirms after this long (its events can lag, or the archive can be down). */
export const GIVE_UP_MS = 2 * 3_600_000;
/**
 * Give up sooner on an id the archive does not know at all: the app reports a trade only after seeing it included in a tick, so a real
 * one is indexed within a minute or so, and an id still missing after this is made up.
 */
export const NOT_FOUND_GIVE_UP_MS = 15 * 60_000;
/** Most ids one source (an IP address) may have waiting at once, so no one caller can fill the queue. */
export const MAX_PENDING_PER_SOURCE = 100;
const PAGE = 1000;
const MAX_HITS = 10_000;
/**
 * Refused payments are remembered so they are not looked up again. They cost their sender nothing (QPayhub gives the money back), so there can
 * be very many; a short memory would make every wallet lookup and scan ask the archive about the same ones again and again.
 */
const MAX_REFUSED_IDS = 100_000;
/** One wallet lookup asks the archive about at most this many payments it has not seen before; the next lookup (or the scan) does the rest. */
const REFRESH_LOOKUPS = 40;
/**
 * A payment that moved money always leaves events. If there are none, the archive has not indexed them yet, and the payment must be read again
 * instead of being taken for a refused one for good. Only after this long is "no events" believed (the archive has had its chance).
 */
const EVENTS_GRACE_MS = 6 * 3_600_000;

/** What a transaction to QX or QSwap is, from its procedure number (Qx.h and Qswap.h). */
export function classifyCall(venue: "QX" | "QSwap", inputType: number): { kind: "trade" | "liquidity"; side?: "buy" | "sell" } | null {
  if (venue === "QX") {
    if (inputType === 6) return { kind: "trade", side: "buy" }; // AddToBidOrder
    if (inputType === 5) return { kind: "trade", side: "sell" }; // AddToAskOrder
    return null; // cancelling an order, moving shares, transfers, or reading
  }
  if (inputType === 6 || inputType === 7) return { kind: "trade", side: "buy" }; // QU in
  if (inputType === 8 || inputType === 9) return { kind: "trade", side: "sell" }; // asset in
  if (inputType === 4 || inputType === 5) return { kind: "liquidity" };
  return null;
}

const venueOf = (destination: string): "QX" | "QSwap" | null => {
  if (destination === QX_ID || contractIndexOf(destination) === QX_CONTRACT) return "QX";
  if (destination === QSWAP_ID || contractIndexOf(destination) === QSWAP_CONTRACT) return "QSwap";
  return null;
};

/** The answer to getTransactionByHash: the live API returns the transaction itself; its schema shows it wrapped. */
const unwrap = (a: unknown): ArchiveTx | null => {
  const t = ((a as { transaction?: ArchiveTx } | null)?.transaction ?? a) as ArchiveTx | null;
  return t && typeof t.source === "string" && typeof t.inputType === "number" ? t : null;
};

export type Verdict =
  | { ok: true; record: Omit<TradeRecord, "ref" | "channel" | "wallet" | "at"> }
  | { ok: false; retry: true; reason: string; notFound?: true }
  | { ok: false; retry: false; reason: RejectReason };

/** The last tick whose events are complete. */
export async function lastLogTick(archive: Archive): Promise<number> {
  return (await archive.get<{ logTickNumber: number }>("/query/v1/getLastProcessedTick")).logTickNumber;
}

/**
 * The last tick that is complete in BOTH of the archive's indexes. The archive reports its transaction index (`tickNumber`) and its event
 * index (`logTickNumber`) separately, and they differ by a few ticks either way. Reading transactions up to the event counter, when it is
 * the one that is ahead, would move a scan's cursor past ticks whose transactions are not indexed yet, and those would never be read.
 */
export async function lastScanTick(archive: Archive): Promise<number> {
  const r = await archive.get<{ tickNumber?: number; logTickNumber?: number }>("/query/v1/getLastProcessedTick");
  const ticks = [r.tickNumber, r.logTickNumber].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (!ticks.length) throw new Error("The archive did not say how far it has got");
  return Math.min(...ticks);
}

/** An event as getEventLogs returns it: QU transfers carry their parties and amount. */
export type ChainEvent = EventLog & { quTransfer?: { source: string; destination: string; amount: string } };

export async function eventsOf(archive: Archive, hash: string): Promise<ChainEvent[]> {
  return (await eventsAt(archive, hash)).events;
}

/**
 * A transaction's events, and the tick the answer says it is valid up to (`validForTick`, the lowest of its pages). The archive may be served by
 * replicas at slightly different ticks, so an answer is complete for a transaction only if it is valid at least up to the transaction's own tick.
 * `validForTick` is left out when the answer does not say.
 */
export async function eventsAt(archive: Archive, hash: string): Promise<{ events: ChainEvent[]; validForTick?: number }> {
  const events: ChainEvent[] = [];
  let valid: number | undefined;
  for (let offset = 0; offset < MAX_HITS; offset += PAGE) {
    const r = await archive.post<{ hits: { total: number }; eventLogs?: ChainEvent[]; validForTick?: number }>("/query/v1/getEventLogs", { filters: { transactionHash: hash }, pagination: { offset, size: PAGE } });
    events.push(...(r.eventLogs ?? []));
    if (typeof r.validForTick === "number" && Number.isFinite(r.validForTick)) valid = Math.min(valid ?? Infinity, r.validForTick);
    if (offset + PAGE >= r.hits.total) break;
  }
  return { events, ...(valid !== undefined ? { validForTick: valid } : {}) };
}

/**
 * When a tick happened (ms), from the archive: how far behind real time the archive is, as far as anything that must not be decided on
 * stale data is concerned. An empty tick has no tick data (the archive answers `tickData: null`), so this walks back to the nearest earlier
 * tick that has some: a time at or before the real one, which can only make a decision wait longer. Null if none is found or the archive
 * cannot say.
 */
export async function tickTimeOf(archive: Archive, tick: number): Promise<number | null> {
  for (let t = tick; t > tick - 20 && t > 0; t--) {
    try {
      const r = await archive.post<{ tickData?: { timestamp?: string } | null }>("/query/v1/getTickData", { tickNumber: t });
      const at = Number(r.tickData?.timestamp);
      if (at > 0) return at;
    } catch {
      return null;
    }
  }
  return null;
}

/** True for an archive answer that means "not there (yet)" rather than "the archive is down". */
const notThere = (e: unknown) => /^RPC (4\d\d)/.test(e instanceof Error ? e.message : "");

/**
 * Looks one reported transaction up and decides. `retry` means the archive may simply not have it yet (a transaction takes a few
 * ticks to be indexed, and its events a few more); everything else is final.
 */
export async function verifyTrade(archive: Archive, tx: string, wallet: string, reportedAt: number, now: number, lastTick?: number): Promise<Verdict> {
  let found: ArchiveTx | null;
  try {
    found = unwrap(await archive.post("/query/v1/getTransactionByHash", { hash: tx }));
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (/^RPC 400/.test(m)) return { ok: false, retry: false, reason: "bad-id" }; // not a valid transaction id (the archive checks the checksum)
    return notThere(e) ? { ok: false, retry: true, reason: "not indexed yet", notFound: true } : { ok: false, retry: true, reason: "the archive did not answer" };
  }
  if (!found) return { ok: false, retry: true, reason: "not indexed yet", notFound: true };

  if (found.source !== wallet) return { ok: false, retry: false, reason: "wrong-wallet" };
  const venue = venueOf(found.destination);
  const call = venue ? classifyCall(venue, found.inputType) : null;
  if (!venue || !call) return { ok: false, retry: false, reason: "not-a-trade" };
  const t = Number(found.timestamp);
  if (!(t > 0) || reportedAt - t > REPORT_WINDOW_MS) return { ok: false, retry: false, reason: "too-old" };

  // The events of a tick are complete only up to the archive's last processed tick.
  let tick = lastTick;
  if (tick === undefined) {
    try {
      tick = await lastLogTick(archive);
    } catch {
      return { ok: false, retry: true, reason: "the archive did not answer" };
    }
  }
  if (found.tickNumber > tick) return { ok: false, retry: true, reason: "events not indexed yet" };

  let events: ChainEvent[];
  try {
    events = await eventsOf(archive, tx);
  } catch (e) {
    return { ok: false, retry: true, reason: notThere(e) ? "events not indexed yet" : "the archive did not answer" };
  }

  const base = { tx, venue, tick: found.tickNumber, t };
  if (call.kind === "liquidity") {
    const changed = events.some((e) => e.logType === 6 && Number(e.smartContractMessage?.contractIndex) === QSWAP_CONTRACT && [4, 5].includes(Number(e.smartContractMessage?.contractMessageType)));
    return changed ? { ok: true, record: { ...base, kind: "liquidity", qty: 0, qu: 0, fills: 0 } } : { ok: false, retry: false, reason: "no-effect" };
  }

  const fills = events.map(decodeTrade).filter((f): f is NonNullable<typeof f> => f !== null);
  if (!fills.length) return { ok: false, retry: false, reason: "no-effect" };
  // One transaction can touch several assets only by accident; name the one with the most QU.
  const byKey = new Map<string, { qu: number; qty: number }>();
  for (const f of fills) {
    const s = byKey.get(f.key) ?? { qu: 0, qty: 0 };
    s.qu += f.qu;
    s.qty += f.qty;
    byKey.set(f.key, s);
  }
  const [mainKey, main] = [...byKey.entries()].sort((a, b) => b[1].qu - a[1].qu)[0];
  const qu = fills.reduce((s, f) => s + f.qu, 0);
  return { ok: true, record: { ...base, kind: "trade", ...(call.side ? { side: call.side } : {}), asset: assetNameFromU64(BigInt(mainKey.split("|")[0])), qty: main.qty, qu, fills: fills.length } };
}

/* ---------- payments to QMax, read from QPayhub ---------- */

const PREFIXES: [string, PaymentKind][] = [
  ["QMAXPASS", "pass"],
  ["QMAXSUB", "subscription"],
  ["QMAXAPI", "api-topup"],
];

const SESSION_TAG = Buffer.from(resourceTag(SESSION_RESOURCE_ID));

/**
 * Decodes a QPayhub `Pay` call (seller, resource id, nonce) and says which of QMax's products it was for, or null if it was not to QMax.
 * A subscription also carries the Discord user it was paid for.
 */
export function decodePayment(inputData: string | undefined, recipient: string): { kind: PaymentKind; discordId?: string; cover?: string } | null {
  if (!inputData) return null;
  const b = Buffer.from(inputData, "base64");
  if (b.length < 72) return null;
  const seller = identityToBytes(recipient);
  if (!seller.every((x, i) => b[i] === x)) return null;
  const resource = b.subarray(32, 64);
  const text = resource.toString("latin1");
  const max = readResource(resource);
  if (max) return { kind: max.kind, ...(max.cover ? { cover: max.cover } : {}) };
  for (const [prefix, kind] of PREFIXES) {
    if (!text.startsWith(prefix)) continue;
    return kind === "subscription" ? { kind, discordId: resource.readBigUInt64LE(16).toString() } : { kind };
  }
  return resource.equals(SESSION_TAG) ? { kind: "session" } : { kind: "other" }; // an x402 session, or anything else sent to QMax's address
}

const DAY = 86_400_000;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/* ---------- the log ---------- */

export interface UsageOptions {
  file?: string;
  archive: Archive;
  /** QMax's own address: payments to it are QMax's sales. */
  recipient: string;
  now?: () => number;
}

export class UsageLog {
  private file?: string;
  private archive: Archive;
  private recipient: string;
  private now: () => number;
  private data: UsageData;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = { verify: false, payments: false };
  /** Who reported each waiting id and how many each source has waiting. Memory only: IP addresses are not written to disk. */
  private sourceOf = new Map<string, string>();
  private refreshedAt = new Map<string, number>();
  /** `data.refusedIds` as a set, so asking "was this one refused" costs nothing however many there are. */
  private refusedSet = new Set<string>();
  private paymentRev = 0;
  private refreshing = 0;
  private waiting = new Map<string, number>();

  constructor(o: UsageOptions) {
    this.file = o.file;
    this.archive = o.archive;
    this.recipient = o.recipient;
    this.now = o.now ?? Date.now;
    this.data = { v: 2, since: this.now(), trades: {}, pending: [], rejectedIds: [], rejected: {}, payments: {}, paymentTick: 0, refusedPayments: 0, refusedIds: [], paymentScanAt: 0 };
    if (o.file) {
      try {
        const saved = JSON.parse(readFileSync(o.file, "utf8")) as { v?: number } & Partial<UsageData>;
        // Version 1 kept payments without the subscriber's Discord id, so they are read again from the chain (it is all still there).
        if (saved?.v === 2) this.data = { ...this.data, ...(saved as UsageData) };
        else if (saved?.v === 1) this.data = { ...this.data, ...(saved as UsageData), v: 2, payments: {}, paymentTick: 0, refusedPayments: 0, refusedIds: [], paymentScanAt: 0 };
      } catch {
        // first run
      }
    }
    if (!Array.isArray(this.data.refusedIds)) this.data.refusedIds = [];
    this.refusedSet = new Set(this.data.refusedIds);
  }

  /**
   * Takes a report from the app: a wallet and the transaction ids it just sent. Returns how many were queued to be checked, or null if
   * the report is malformed. Nothing counts until it is verified.
   */
  report(body: unknown, source = "", now = this.now()): number | null {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof b.wallet !== "string" || !WALLET.test(b.wallet)) return null;
    if (!Array.isArray(b.txIds) || b.txIds.length === 0 || b.txIds.length > MAX_PER_REPORT) return null;
    const ids = [...new Set(b.txIds)];
    if (!ids.every((t): t is string => typeof t === "string" && TX_ID.test(t))) return null;
    const channel: Channel = CHANNELS.includes(b.channel as Channel) ? (b.channel as Channel) : "web";
    const ref = isRef(b.ref) ? b.ref : undefined;
    let queued = 0;
    for (const tx of ids) {
      if (this.data.trades[tx] || this.data.rejectedIds.includes(tx) || this.data.pending.some((p) => p.tx === tx)) continue;
      if (this.data.pending.length >= MAX_PENDING) break;
      if (source && (this.waiting.get(source) ?? 0) >= MAX_PENDING_PER_SOURCE) break;
      this.data.pending.push({ tx, wallet: b.wallet, ...(ref ? { ref } : {}), channel, reportedAt: now, tries: 0, nextAt: now });
      if (source) {
        this.sourceOf.set(tx, source);
        this.waiting.set(source, (this.waiting.get(source) ?? 0) + 1);
      }
      queued++;
    }
    if (queued) this.flushSoon();
    return queued;
  }

  /** Checks queued ids that are due, at most `max` of them. Returns how many were settled (counted or rejected). */
  async verifyPending(max = 5): Promise<number> {
    if (this.busy.verify) return 0;
    this.busy.verify = true;
    let settled = 0;
    try {
      const now = this.now();
      const due = this.data.pending.filter((p) => p.nextAt <= now).slice(0, max);
      if (!due.length) return 0;
      let tick: number | undefined;
      try {
        tick = await lastLogTick(this.archive);
      } catch {
        tick = undefined;
      }
      for (const p of due) {
        const v = await verifyTrade(this.archive, p.tx, p.wallet, p.reportedAt, this.now(), tick);
        if (v.ok) {
          this.data.trades[p.tx] = { ...v.record, wallet: p.wallet, ...(p.ref ? { ref: p.ref } : {}), channel: p.channel, at: this.now() };
          this.trim();
          this.settle(p.tx);
          settled++;
        } else if (!v.retry) {
          this.reject(p.tx, v.reason);
          settled++;
        } else if (this.now() - p.reportedAt > (v.notFound ? NOT_FOUND_GIVE_UP_MS : GIVE_UP_MS)) {
          this.reject(p.tx, "unverified");
          settled++;
        } else {
          p.tries++;
          p.nextAt = this.now() + Math.min(600_000, 8_000 * 2 ** p.tries);
        }
      }
      this.flushSoon();
    } finally {
      this.busy.verify = false;
    }
    return settled;
  }

  /**
   * Reads QPayhub payments since the last scan and keeps those to QMax's address that QPayhub really forwarded (a refused payment
   * confirms as a transaction but sends the money back, so the forward is what proves a sale). Returns the new payments.
   */
  async scanPayments(): Promise<PaymentRecord[]> {
    if (this.busy.payments) return [];
    this.busy.payments = true;
    const added: PaymentRecord[] = [];
    try {
      const asked = await lastScanTick(this.archive);
      const from = this.data.paymentTick + 1;
      if (asked < from) return added;
      const { txs, valid } = await this.readPayHub(from, asked);
      // An answer valid only up to tick V says nothing about the ticks after it: the cursor stops there, and the rest is read next time.
      const upTo = valid !== undefined ? Math.min(asked, valid) : asked;
      if (upTo < from) return added;
      for (const t of txs) {
        if (t.tickNumber > upTo) continue;
        const rec = await this.ingest(t);
        if (rec) added.push(rec);
      }
      // "Everything before this moment is read" is true of the chain's time, which is the archive's newest tick, not of the moment the scan
      // ran: an archive that is hours behind (catching up after an outage, say) must not make a month look complete while its last
      // payments are not in it yet. If the archive cannot say when that tick was, nothing new is claimed complete.
      const asOf = await tickTimeOf(this.archive, upTo);
      // Only after every payment in the span was handled, so a failure in the middle is read again next time.
      this.data.paymentTick = upTo;
      if (asOf !== null) this.data.paymentScanAt = Math.max(this.data.paymentScanAt, Math.min(this.now(), asOf));
      this.flushSoon();
    } finally {
      this.busy.payments = false;
    }
    return added;
  }

  /**
   * Reads one `Pay` call: keeps it if it is to QMax's address and QPayhub really forwarded it (a refused payment confirms as a transaction
   * but the money goes back, so the forward in the event log is the proof). Returns the new record, or null if it is not QMax's or was seen.
   * `budget` limits how many payments it may ask the archive about; past it, a payment is left unread (not refused) for a later look.
   */
  private async ingest(t: ArchiveTx, budget?: { left: number }): Promise<PaymentRecord | null> {
    if (!t.hash || this.data.payments[t.hash] || this.refusedSet.has(t.hash)) return null;
    const what = decodePayment(t.inputData, this.recipient);
    if (!what) return null;
    const gross = Number(t.amount);
    // Nothing can have been forwarded by a payment that never moved its money (the payer could not cover it) or that was under QPayhub's
    // minimum (the contract hands it back): no need to ask the archive, and none to be asked again.
    if (t.moneyFlew === false || !(Number.isSafeInteger(gross) && gross >= QPAYHUB_MIN_PAYMENT_QU)) {
      this.refuse(t.hash);
      return null;
    }
    if (budget) {
      if (budget.left <= 0) return null;
      budget.left--;
    }
    const { events, validForTick } = await eventsAt(this.archive, t.hash);
    // A scan and a wallet lookup can be reading the same payment at once: whichever finishes second finds it already recorded.
    if (this.data.payments[t.hash] || this.refusedSet.has(t.hash)) return null;
    // An answer that is only valid up to an earlier tick can show the money going in without QPayhub's forward: not the payment's whole story.
    if (validForTick !== undefined && validForTick < t.tickNumber) throw new Error(`The events of payment ${t.hash} are not indexed yet`);
    // A payment of at least the minimum that moved money always leaves events (the payer's transfer in, and either the forward or the refund).
    // None means the archive has not indexed them yet: read it again later, do not write it off as refused.
    if (!events.length && this.now() - Number(t.timestamp) < EVENTS_GRACE_MS) throw new Error(`The events of payment ${t.hash} are not indexed yet`);
    const forwarded = events
      .filter((e) => e.quTransfer?.source === QPAYHUB_IDENTITY && e.quTransfer.destination === this.recipient)
      .map((e) => Number(e.quTransfer!.amount))
      .filter((n) => Number.isSafeInteger(n) && n > 0) // an amount that is not a whole positive number of QU is not money QPayhub sent
      .reduce((s, n) => s + n, 0);
    if (forwarded <= 0 || !Number.isSafeInteger(forwarded)) {
      this.refuse(t.hash);
      return null;
    }
    const rec: PaymentRecord = { tx: t.hash, payer: t.source, kind: what.kind, ...(what.discordId ? { discordId: what.discordId } : {}), ...(what.cover ? { cover: what.cover } : {}), amountQu: gross, forwardedQu: forwarded, tick: t.tickNumber, t: Number(t.timestamp) };
    this.data.payments[t.hash] = rec;
    this.paymentRev++;
    return rec;
  }

  /** Remembers a payment that QPayhub refunded (or that never moved money), counting it once. */
  private refuse(hash: string) {
    if (this.refusedSet.has(hash)) return;
    this.data.refusedPayments++;
    this.refusedSet.add(hash);
    this.data.refusedIds.push(hash);
    if (this.data.refusedIds.length > MAX_REFUSED_IDS) for (const old of this.data.refusedIds.splice(0, Math.ceil(MAX_REFUSED_IDS / 10))) this.refusedSet.delete(old);
  }

  /**
   * Looks up one wallet's own payments to QPayhub right now, instead of waiting for the next full scan, so a member who has just paid
   * (on Discord, say) is recognised at once. Cached for a minute per wallet. Returns the wallet's payments to QMax.
   */
  async refreshWallet(wallet: string): Promise<PaymentRecord[]> {
    if (!WALLET.test(wallet)) return [];
    const fresh = this.refreshedAt.get(wallet);
    if (fresh !== undefined && this.now() - fresh < 60_000) return this.paymentsOf(wallet);
    if (this.refreshing >= 3) return this.paymentsOf(wallet); // busy: answer from what is known
    this.refreshing++;
    this.refreshedAt.set(wallet, this.now());
    if (this.refreshedAt.size > 2000) for (const k of [...this.refreshedAt.keys()].slice(0, 500)) this.refreshedAt.delete(k);
    try {
      const upTo = await lastScanTick(this.archive);
      const budget = { left: REFRESH_LOOKUPS };
      for (let offset = 0; offset < MAX_HITS; offset += PAGE) {
        const r = await this.archive.post<{ hits: { total: number }; transactions?: ArchiveTx[] }>("/query/v1/getTransactionsForIdentity", {
          identity: wallet,
          filters: { source: wallet, destination: QPAYHUB_IDENTITY, inputType: "1" },
          ranges: { tickNumber: { lte: String(upTo) } },
          pagination: { offset, size: PAGE },
        });
        for (const t of r.transactions ?? []) await this.ingest(t, budget);
        if (offset + PAGE >= r.hits.total) break;
      }
      this.flushSoon();
    } catch (e) {
      // A transient failure is tried again next time. An answer of "no" (a 4xx: the archive does not accept this identity) stays remembered
      // for the minute, so a flood of made-up identities cannot keep the server asking the archive about each one again.
      if (!/^RPC 4\d\d/.test(e instanceof Error ? e.message : "")) this.refreshedAt.delete(wallet);
      throw e;
    } finally {
      this.refreshing--;
    }
    return this.paymentsOf(wallet);
  }

  /** Counts the payments recorded so far, for a reader to tell cheaply whether what it worked out from them is still current. */
  paymentRevision(): number {
    return this.paymentRev;
  }

  /** Every payment to QMax read so far. */
  allPayments(): PaymentRecord[] {
    return Object.values(this.data.payments);
  }

  paymentsOf(wallet: string): PaymentRecord[] {
    return this.allPayments().filter((p) => p.payer === wallet);
  }

  /** How far the payment scan has got: every payment before `at` (ms) is in. 0 until the first scan finishes. */
  scanState() {
    return { tick: this.data.paymentTick, at: this.data.paymentScanAt };
  }

  /**
   * Every QPayhub `Pay` call in a tick span, splitting the span if the archive's 10,000-result cap would cut it short. Also the lowest tick any
   * answer said it was valid for: the list is complete only up to that tick.
   */
  private async readPayHub(from: number, to: number): Promise<{ txs: ArchiveTx[]; valid?: number }> {
    let valid: number | undefined;
    const page = async (lo: number, hi: number, offset: number) => {
      const r = await this.archive.post<{ hits: { total: number }; transactions?: ArchiveTx[]; validForTick?: number }>("/query/v1/getTransactionsForIdentity", {
        identity: QPAYHUB_IDENTITY,
        filters: { destination: QPAYHUB_IDENTITY, inputType: "1" },
        ranges: { tickNumber: { gte: String(lo), lte: String(hi) } },
        pagination: { offset, size: PAGE },
      });
      if (typeof r.validForTick === "number" && Number.isFinite(r.validForTick)) valid = Math.min(valid ?? Infinity, r.validForTick);
      return r;
    };
    const out: ArchiveTx[] = [];
    const read = async (lo: number, hi: number): Promise<void> => {
      // The archive rejects a range whose ends are equal, so one tick is widened by one and the extra tick dropped again.
      const wlo = lo === hi ? lo - 1 : lo;
      const first = await page(wlo, hi, 0);
      if (first.hits.total >= MAX_HITS && hi > lo) {
        const mid = Math.floor((lo + hi) / 2);
        await read(lo, mid);
        await read(mid + 1, hi);
        return;
      }
      const keep = (items: ArchiveTx[] = []) => out.push(...items.filter((t) => t.tickNumber >= lo && t.tickNumber <= hi));
      keep(first.transactions);
      for (let offset = PAGE; offset < Math.min(first.hits.total, MAX_HITS); offset += PAGE) keep((await page(wlo, hi, offset)).transactions);
    };
    await read(from, to);
    return { txs: out, ...(valid !== undefined ? { valid } : {}) };
  }

  /**
   * Starts the background work: confirming trade reports every few seconds and reading payments every few minutes (either can be left
   * out with `trades: false` / `payments: false`). Returns a function that stops it.
   */
  start(opts: { verifyEveryMs?: number; paymentsEveryMs?: number; onError?: (e: unknown) => void; trades?: boolean; payments?: boolean } = {}): () => void {
    const onError = opts.onError ?? ((e) => console.warn("usage:", e instanceof Error ? e.message : e));
    const timers: ReturnType<typeof setInterval>[] = [];
    if (opts.trades !== false) timers.push(setInterval(() => this.verifyPending().catch(onError), opts.verifyEveryMs ?? 10_000));
    if (opts.payments !== false) {
      timers.push(setInterval(() => this.scanPayments().catch(onError), opts.paymentsEveryMs ?? 300_000));
      timers.push(setTimeout(() => this.scanPayments().catch(onError), 20_000));
    }
    for (const t of timers) t.unref();
    return () => timers.forEach((t) => (clearInterval(t), clearTimeout(t)));
  }

  private settle(tx: string) {
    this.data.pending = this.data.pending.filter((p) => p.tx !== tx);
    const src = this.sourceOf.get(tx);
    if (src !== undefined) {
      this.sourceOf.delete(tx);
      const left = (this.waiting.get(src) ?? 1) - 1;
      if (left > 0) this.waiting.set(src, left);
      else this.waiting.delete(src);
    }
  }

  private reject(tx: string, reason: string) {
    this.settle(tx);
    this.data.rejected[reason] = (this.data.rejected[reason] ?? 0) + 1;
    this.data.rejectedIds = [...this.data.rejectedIds.slice(-(MAX_REJECTED_IDS - 1)), tx];
  }

  private trim() {
    const ids = Object.keys(this.data.trades);
    if (ids.length <= MAX_TRADES) return;
    const oldest = ids.sort((a, b) => this.data.trades[a].t - this.data.trades[b].t).slice(0, ids.length - MAX_TRADES);
    for (const id of oldest) delete this.data.trades[id];
  }

  /** The numbers behind GET /v1/stats. */
  stats(opts: { days?: number } = {}, now = this.now()) {
    return summarize(this.data, opts, now);
  }

  /** One wallet's verified trades and payments, for GET /v1/stats?wallet=. */
  walletStats(wallet: string) {
    return summarizeWallet(this.data, wallet);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 }); // wallets, payments and unconfirmed reports: for the owner only
    chmodSync(tmp, 0o600); // a leftover file from a crash keeps its old mode otherwise
    renameSync(tmp, this.file);
  }

  private flushSoon() {
    if (this.timer || !this.file) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref();
  }
}

/* ---------- the numbers ---------- */

interface Bucket {
  trades: number;
  wallets: number;
  quVolume: number;
}

/** Totals over a list of trade records. */
function bucket(records: TradeRecord[]): Bucket {
  const trades = records.filter((r) => r.kind === "trade");
  return { trades: trades.length, wallets: new Set(records.map((r) => r.wallet)).size, quVolume: trades.reduce((s, r) => s + r.qu, 0) };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    const l = m.get(k);
    if (l) l.push(i);
    else m.set(k, [i]);
  }
  return m;
}

const NOTE =
  "Verified from the chain: each trade was sent by that wallet to QX or QSwap and really filled, and was reported within 30 minutes. It proves the wallet made the trade, not that it went through QMax (anyone can name a real recent trade), so use it to measure usage, not to pay anyone. Orders that rest on the book without filling are not counted, nor is a later fill of them. Counting began at 'since'.";

export function summarizeWallet(data: UsageData, wallet: string) {
  const mine = Object.values(data.trades).filter((r) => r.wallet === wallet).sort((a, b) => b.t - a.t);
  const paid = Object.values(data.payments).filter((p) => p.payer === wallet).sort((a, b) => b.t - a.t);
  return {
    wallet,
    since: new Date(data.since).toISOString(),
    firstSeen: mine.length ? new Date(Math.min(...mine.map((r) => r.t))).toISOString() : null,
    totals: bucket(mine),
    trades: mine.slice(0, 200).map((r) => ({ ...r, time: new Date(r.t).toISOString() })),
    payments: paid.map((p) => ({ ...p, time: new Date(p.t).toISOString() })),
    note: NOTE,
  };
}

export function summarize(data: UsageData, opts: { days?: number } = {}, now = Date.now()) {
  const days = Math.min(365, Math.max(1, Math.floor(opts.days ?? 30)));
  const from = now - days * DAY;
  const all = Object.values(data.trades);

  const firstSeen = new Map<string, number>();
  for (const r of all) firstSeen.set(r.wallet, Math.min(firstSeen.get(r.wallet) ?? Infinity, r.t));

  const inWindow = all.filter((r) => r.t >= from);
  const sum = bucket;
  const newWallets = [...firstSeen.entries()].filter(([, t]) => t >= from).length;

  const byDay = [...groupBy(inWindow, (r) => dayOf(r.t)).entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, l]) => ({ day, ...sum(l), newWallets: new Set(l.filter((r) => dayOf(firstSeen.get(r.wallet)!) === day).map((r) => r.wallet)).size }));
  const byRef = [...groupBy(inWindow, (r) => r.ref ?? "direct").entries()].map(([ref, l]) => ({ ref, ...sum(l) })).sort((a, b) => b.quVolume - a.quVolume);
  const byChannel = [...groupBy(inWindow, (r) => r.channel).entries()].map(([channel, l]) => ({ channel, ...sum(l) })).sort((a, b) => b.quVolume - a.quVolume);
  const byVenue = [...groupBy(inWindow, (r) => r.venue).entries()].map(([venue, l]) => ({ venue, ...sum(l) }));
  const topAssets = [...groupBy(inWindow.filter((r) => r.kind === "trade" && r.asset), (r) => r.asset!).entries()]
    .map(([asset, l]) => ({ asset, ...sum(l) }))
    .sort((a, b) => b.quVolume - a.quVolume)
    .slice(0, 15);
  const topWallets = [...groupBy(inWindow, (r) => r.wallet).entries()]
    .map(([wallet, l]) => ({ wallet, ...sum(l), firstTrade: new Date(firstSeen.get(wallet)!).toISOString(), lastTrade: new Date(Math.max(...l.map((r) => r.t))).toISOString() }))
    .sort((a, b) => b.quVolume - a.quVolume)
    .slice(0, 20);

  const payments = Object.values(data.payments);
  const pay = (kind: PaymentKind) => {
    const l = payments.filter((p) => p.kind === kind);
    const w = l.filter((p) => p.t >= from);
    return { allTime: { count: l.length, wallets: new Set(l.map((p) => p.payer)).size, quPaid: l.reduce((s, p) => s + p.amountQu, 0), quReceived: l.reduce((s, p) => s + p.forwardedQu, 0) }, window: { count: w.length, wallets: new Set(w.map((p) => p.payer)).size, quPaid: w.reduce((s, p) => s + p.amountQu, 0), quReceived: w.reduce((s, p) => s + p.forwardedQu, 0) } };
  };
  const paymentsByDay = [...groupBy(payments.filter((p) => p.t >= from), (p) => dayOf(p.t)).entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, l]) => ({ day, count: l.length, quReceived: l.reduce((s, p) => s + p.forwardedQu, 0) }));

  return {
    window: { days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    since: new Date(data.since).toISOString(),
    totals: { ...sum(inWindow), newWallets, liquidityOps: inWindow.filter((r) => r.kind === "liquidity").length },
    allTime: { ...sum(all) },
    byDay,
    byRef,
    byChannel,
    byVenue,
    topAssets,
    topWallets,
    payments: { pass: pay("pass"), subscription: pay("subscription"), apiTopup: pay("api-topup"), session: pay("session"), other: pay("other"), refused: data.refusedPayments, byDay: paymentsByDay, scannedToTick: data.paymentTick },
    verification: { pending: data.pending.length, verified: all.length, rejected: data.rejected },
    note: NOTE,
  };
}
