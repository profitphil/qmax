import { randomBytes } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { writeJsonFile } from "./safefile.ts";
import { NO_FILTERS, arbQuery, hasFilters, passesFilters } from "./arbfilters.ts";
import type { ArbFilters } from "./arbfilters.ts";
import type { ArbitrageResult } from "./apitypes.ts";

/**
 * Alerts: "tell me when X happens", ending in a trade. This file is the rules and the maths (no Discord, no network, so it
 * can be tested with plain objects); `bot/alerts.ts` sends the messages.
 *
 * Three kinds of rule:
 *  - price: an asset's price crosses a level (QU), up or down. It fires on the CROSSING, not on every check while the price stays beyond it.
 *  - arbitrage: an arbitrage appears on one asset, or on any asset, that meets the owner's own arbitrage filters.
 *  - bigtrade: a single trade of at least N QU, on one asset or any, read from the live tape.
 *
 * The caveat to keep in mind everywhere: prices here are QMax's price for an asset (the price of its newest QX trade; with none, the middle of its best QX bid and ask), sampled when the service checks, not every tick. A price that spikes and falls back between two checks is not seen.
 */

export const MAX_RULES = 10;
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;
export const MAX_COOLDOWN_MINUTES = 7 * 24 * 60;
/** The smallest "big trade" someone can ask about. A policy choice, not a market fact: below it a busy asset would fill their messages. */
export const MIN_BIGTRADE_QU = 10_000;
/** A price level above this is a typo, not a price. */
export const MAX_LEVEL = 1e15;
/** A trade older than this is not worth a message (the bot may have been down, or a new tape may replay old rows). */
export const MAX_TRADE_AGE_MS = 15 * 60_000;

export type Mode = "once" | "repeat";
export type Opportunity = NonNullable<ArbitrageResult["opportunity"]>;

/** What a rule remembers between checks. Which fields are used depends on the kind. */
export interface RuleState {
  /** When an alert for this rule was last delivered (ms). The cooldown counts from here. */
  lastFiredAt?: number;
  /** price: was the price beyond the level at the last check? Unset until a price has been seen. */
  beyond?: boolean;
  /** arbitrage: the assets that had a matching opportunity at the last check (sorted), so a lasting one fires once, when it appears. */
  present?: string[];
  /** bigtrade: the newest tape id this rule has looked at, so a trade is never judged twice. */
  lastTradeId?: number;
}

interface Common {
  id: string;
  /** The Discord user id that owns the rule. */
  userId: string;
  mode: Mode;
  /** Quiet time after an alert, in ms. 0 means none. */
  cooldownMs: number;
  createdAt: number;
  state: RuleState;
}
export interface PriceRule extends Common { kind: "price"; asset: string; direction: "above" | "below"; level: number }
/** `asset: null` means any asset that trades on both markets. */
export interface ArbitrageRule extends Common { kind: "arbitrage"; asset: string | null }
export interface BigTradeRule extends Common { kind: "bigtrade"; asset: string | null; minQu: number }
export type Rule = PriceRule | ArbitrageRule | BigTradeRule;

type Own = "id" | "userId" | "createdAt" | "state";
/** A rule that passed validation but has no id yet. */
export type RuleDraft = Omit<PriceRule, Own> | Omit<ArbitrageRule, Own> | Omit<BigTradeRule, Own>;

/** One row of the live tape (`GET /v1/tape`). `asset` must be the same id `/v1/assets` uses; `t` is ms since epoch. */
export interface TapeRow {
  id: number;
  t: number;
  venue: string;
  asset: string;
  qty: number;
  qu: number;
  price: number;
  side?: "buy" | "sell";
  txHash?: string;
}
export interface TapeResponse {
  trades: TapeRow[];
  latestId: number;
}

/** An arbitrage lookup: what was found per asset, and which checks did not work this round (so they are not mistaken for "gone"). */
export interface ArbView {
  found: Map<string, Opportunity>;
  failed?: Set<string>;
}

/** Everything evaluate() looks at, gathered once per check for all users. */
export interface Snapshot {
  /** QU per unit by asset id. An asset with no price is left out. */
  prices: Map<string, number>;
  /** The best arbitrage per asset found WITHOUT filters (what an owner with no filters sees). */
  arbitrage: Map<string, Opportunity>;
  /** Assets whose unfiltered lookup failed this round. Their old standing is kept instead of being read as "no opportunity". */
  arbitrageFailed?: Set<string>;
  /** For owners who have filters: the best arbitrage per asset found WITH those filters, keyed by `filterKey(filters)`. The budget filter changes which loop is best, so it has to be asked of the API. */
  arbitrageWith?: Map<string, ArbView>;
  /** The owners' arbitrage filters by user id. An owner who is missing has none. */
  filters?: Map<string, ArbFilters>;
  /** Tape rows to judge. Rows a rule has already seen are skipped, so overlapping fetches are safe. */
  trades: TapeRow[];
}

export const filterKey = (f: ArbFilters) => arbQuery(f);

export interface Triggered {
  ruleId: string;
  userId: string;
  kind: Rule["kind"];
  mode: Mode;
  /** The asset the alert is about, as an asset id. */
  asset: string;
  /** The text to send. Always the same for the same input. */
  message: string;
  at: number;
  /** arbitrage: the size of the opportunity, so a button can open a quote of that size. */
  qty?: number;
  /** bigtrade: the transaction, so a button can open it on the explorer. */
  txHash?: string;
}

// ---------------------------------------------------------------- text

/** A whole number with thousands separators. */
export const fmtWhole = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
/** A QU price as people read it: up to four decimals from 1 up, six significant digits below 1, so a level someone typed shows back as typed. */
export function fmtPrice(x: number): string {
  return x >= 1 ? x.toLocaleString("en-US", { maximumFractionDigits: 4 }) : x.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

/** The symbol part of an asset id ("QTREAT.QDOGE" is the QTREAT token issued by QDOGE's issuer). */
export const symbolOf = (asset: string) => asset.split(".")[0];
const sameAsset = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

const minutesText = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} min`;
};

/** One line about a rule, for lists and for what was just set up. */
export function describeRule(r: Rule): string {
  const where = r.kind === "price" ? "" : r.asset ?? "any asset";
  const what =
    r.kind === "price" ? `${r.asset} price ${r.direction} ${fmtPrice(r.level)} QU`
    : r.kind === "arbitrage" ? `Arbitrage on ${where}`
    : `Trade of at least ${fmtWhole(r.minQu)} QU on ${where}`;
  const when = r.mode === "once" ? "alerts once" : r.cooldownMs > 0 ? `repeats, at most once every ${minutesText(r.cooldownMs)}` : "repeats, no cooldown";
  return `${what} (${when})`;
}

// ---------------------------------------------------------------- validation

export interface RuleInput {
  kind: string;
  asset?: string | null;
  direction?: string | null;
  level?: number | null;
  minQu?: number | null;
  /** true = keep alerting, false = once. Unset: price alerts fire once, the others keep going. */
  repeat?: boolean | null;
  cooldownMinutes?: number | null;
}

export type Validation = { ok: true; draft: RuleDraft } | { ok: false; error: string };
const fail = (error: string): Validation => ({ ok: false, error });

const ASSET_RE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;

/** Checks what someone asked for and says, in words they can act on, what is wrong. `existing` is the rules they already have. */
export function validateRule(input: RuleInput, existing: readonly Rule[]): Validation {
  if (existing.length >= MAX_RULES)
    return fail(`You already have ${MAX_RULES} alerts, the most allowed. Remove one first (/alerts remove, or the Remove buttons in /alerts list), then add this one.`);

  let cooldownMs = DEFAULT_COOLDOWN_MS;
  if (input.cooldownMinutes !== undefined && input.cooldownMinutes !== null) {
    const m = input.cooldownMinutes;
    if (!Number.isInteger(m) || m < 0 || m > MAX_COOLDOWN_MINUTES) return fail(`The cooldown must be a whole number of minutes, from 0 to ${fmtWhole(MAX_COOLDOWN_MINUTES)} (one week).`);
    cooldownMs = m * 60_000;
  }

  const typed = (input.asset ?? "").trim();
  const asset = typed ? typed.toUpperCase() : null;
  if (asset !== null && !ASSET_RE.test(asset)) return fail("That does not look like an asset name. Use its symbol, like CFB.");

  const mode: Mode = (input.repeat ?? input.kind !== "price") ? "repeat" : "once";
  const has = (f: (r: Rule) => boolean) => existing.some(f);
  const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : sameAsset(a, b));

  if (input.kind === "price") {
    if (asset === null) return fail("A price alert needs an asset. Give its symbol, like CFB.");
    if (input.direction !== "above" && input.direction !== "below") return fail("Choose above or below.");
    const level = input.level;
    if (typeof level !== "number" || !Number.isFinite(level) || level <= 0) return fail("The price must be a number above 0, in QU.");
    if (level > MAX_LEVEL) return fail(`${fmtWhole(level)} QU is too large to be a price. Check the number.`);
    const direction = input.direction;
    if (has((r) => r.kind === "price" && sameAsset(r.asset, asset) && r.direction === direction && r.level === level)) return fail("You already have that exact alert.");
    return { ok: true, draft: { kind: "price", asset, direction, level, mode, cooldownMs } };
  }

  if (input.kind === "arbitrage") {
    if (has((r) => r.kind === "arbitrage" && same(r.asset, asset))) return fail(asset === null ? "You already have an arbitrage alert on any asset." : "You already have an arbitrage alert on that asset.");
    return { ok: true, draft: { kind: "arbitrage", asset, mode, cooldownMs } };
  }

  if (input.kind === "bigtrade") {
    const minQu = input.minQu;
    if (typeof minQu !== "number" || !Number.isFinite(minQu) || minQu < MIN_BIGTRADE_QU)
      return fail(`A big-trade alert needs a size of at least ${fmtWhole(MIN_BIGTRADE_QU)} QU, so a busy asset does not fill your messages.`);
    if (minQu > MAX_LEVEL) return fail(`${fmtWhole(minQu)} QU is too large to be a trade size. Check the number.`);
    if (has((r) => r.kind === "bigtrade" && same(r.asset, asset) && r.minQu === minQu)) return fail("You already have that exact alert.");
    return { ok: true, draft: { kind: "bigtrade", asset, minQu, mode, cooldownMs } };
  }

  return fail("Unknown alert kind. Use add-price, add-arbitrage or add-bigtrade.");
}

// ---------------------------------------------------------------- evaluation

const cooling = (r: Rule, now: number) => r.state.lastFiredAt !== undefined && now - r.state.lastFiredAt < r.cooldownMs;

/** Is the price on the far side of the rule's level? Exactly at the level is not beyond, so "crossed above 22" is always literally true. */
export const isBeyond = (r: PriceRule, price: number) => (r.direction === "above" ? price > r.level : price < r.level);

const trigger = (r: Rule, asset: string, message: string, at: number, extra: { qty?: number; txHash?: string } = {}): Triggered => ({
  ruleId: r.id, userId: r.userId, kind: r.kind, mode: r.mode, asset, message, at, ...extra,
});

/**
 * Judges every rule against what was just looked up and returns the alerts that should go out. It also updates each rule's
 * `state` IN PLACE (what side the price was on, which opportunities were present, the newest trade seen): that memory is
 * what makes a crossing fire once, so the caller must keep the same rule objects between calls and save them (`AlertStore.save`).
 *
 * It does NOT set `lastFiredAt`: the cooldown and `once` only start when a message was really delivered (`AlertStore.markFired`),
 * so a failed send does not use up an alert.
 * The caller decides which rules to pass: leave out the rules of a user who is switched off, and the arbitrage rules of a user
 * who is not subscribed (they pause: nothing is deleted, and evaluating them again later just works).
 */
export function evaluate(rules: readonly Rule[], snap: Snapshot, now: number): Triggered[] {
  const out: Triggered[] = [];
  for (const rule of rules) {
    const t = rule.kind === "price" ? checkPrice(rule, snap, now) : rule.kind === "arbitrage" ? checkArbitrage(rule, snap, now) : checkBigTrade(rule, snap, now);
    if (t) out.push(t);
  }
  return out;
}

function checkPrice(rule: PriceRule, snap: Snapshot, now: number): Triggered | null {
  const price = snap.prices.get(rule.asset);
  // No price this round (no market, or the lookup failed): say nothing and keep the memory.
  if (price === undefined || !Number.isFinite(price) || price <= 0) return null;
  const beyond = isBeyond(rule, price);
  const was = rule.state.beyond;
  // Even while cooling down the side is remembered, so the next real crossing is still seen as one.
  rule.state.beyond = beyond;
  // `was` unset: the first price ever seen. The rule was made while the price was already there, so there was no crossing.
  if (!beyond || was !== false || cooling(rule, now)) return null;
  return trigger(rule, rule.asset, `${rule.asset} crossed ${rule.direction} ${fmtPrice(rule.level)} QU (now ${fmtPrice(price)} QU).`, now);
}

function arbitrageText(asset: string, o: Opportunity): string {
  const [buy, sell] = o.direction === "buy-qx-sell-qswap" ? ["QX", "QSwap"] : ["QSwap", "QX"];
  const pct = o.profitPct.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `Arbitrage on ${asset}: buy ${fmtWhole(o.qty)} on ${buy}, sell on ${sell}. Cost ${fmtWhole(o.costQu)} QU, profit about ${fmtWhole(o.profitQu)} QU (${pct}%) after fees.`;
}

function checkArbitrage(rule: ArbitrageRule, snap: Snapshot, now: number): Triggered | null {
  const f = snap.filters?.get(rule.userId) ?? NO_FILTERS;
  const view: ArbView | undefined = hasFilters(f) ? snap.arbitrageWith?.get(filterKey(f)) : { found: snap.arbitrage, failed: snap.arbitrageFailed };
  // Nothing was looked up for this owner's filters this round: change nothing.
  if (!view) return null;

  const matched = new Map<string, Opportunity>();
  for (const [asset, opp] of view.found) {
    if (rule.asset !== null && !sameAsset(asset, rule.asset)) continue;
    // The API already applied the filters; checking again keeps a stale or unfiltered answer from slipping through.
    if (opp.profitQu > 0 && passesFilters(opp, f)) matched.set(asset, opp);
  }
  const before = new Set(rule.state.present ?? []);
  // An asset whose lookup failed keeps its old standing, so a hiccup does not make a lasting opportunity look new again.
  const kept = [...before].filter((a) => view.failed?.has(a));
  rule.state.present = [...new Set([...matched.keys(), ...kept])].sort();

  const fresh = [...matched].filter(([a]) => !before.has(a)).sort((x, y) => y[1].profitQu - x[1].profitQu);
  if (!fresh.length || cooling(rule, now)) return null;
  const [asset, best] = fresh[0];
  const others = fresh.slice(1, 6).map(([a, o]) => `${a} (about ${fmtWhole(o.profitQu)} QU)`);
  const more = fresh.length - 1 > others.length ? `, and ${fresh.length - 1 - others.length} more` : "";
  const text = [
    arbitrageText(asset, best),
    ...(others.length ? [`Also open now: ${others.join(", ")}${more}.`] : []),
    "A snapshot, not a promise: the two legs are separate trades, and the market can move between them.",
  ].join("\n");
  return trigger(rule, asset, text, now, { qty: best.qty });
}

function tradeText(asset: string, row: TapeRow, extra: number): string {
  const sym = symbolOf(asset);
  const each = Number.isFinite(row.price) && row.price > 0 ? ` (${fmtPrice(row.price)} QU each)` : "";
  const what = row.side === "buy" ? `a buy of ${fmtWhole(row.qty)} ${sym}` : row.side === "sell" ? `a sale of ${fmtWhole(row.qty)} ${sym}` : `${fmtWhole(row.qty)} ${sym} changing hands`;
  const more = extra > 0 ? ` ${extra} other trade${extra === 1 ? "" : "s"} met your size since the last check.` : "";
  return `Big trade on ${asset}: ${what} for ${fmtWhole(row.qu)} QU${each} on ${row.venue}.${more}`;
}

function checkBigTrade(rule: BigTradeRule, snap: Snapshot, now: number): Triggered | null {
  const seen = rule.state.lastTradeId;
  let top = seen ?? -Infinity;
  const hits: TapeRow[] = [];
  for (const row of snap.trades) {
    if (seen !== undefined && row.id <= seen) continue; // already judged on an earlier check
    top = Math.max(top, row.id);
    if (row.t < rule.createdAt || now - row.t > MAX_TRADE_AGE_MS) continue; // from before the alert existed, or too old to matter
    if (row.qu < rule.minQu) continue;
    if (rule.asset !== null && !sameAsset(row.asset, rule.asset)) continue;
    hits.push(row);
  }
  if (top !== -Infinity) rule.state.lastTradeId = top;
  // Trades that arrive during the cooldown are skipped for good (the id above has moved past them): that is what the cooldown is for.
  if (!hits.length || cooling(rule, now)) return null;
  const biggest = hits.reduce((a, b) => (b.qu > a.qu ? b : a));
  return trigger(rule, biggest.asset, tradeText(biggest.asset, biggest, hits.length - 1), now, { qty: biggest.qty, ...(biggest.txHash ? { txHash: biggest.txHash } : {}) });
}

// ---------------------------------------------------------------- reading the API defensively

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One arbitrage answer's `opportunity`, or null if it is missing or not shaped like one. */
export function parseOpportunity(raw: unknown): Opportunity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.direction !== "buy-qx-sell-qswap" && o.direction !== "buy-qswap-sell-qx") return null;
  if (!finite(o.qty) || !finite(o.costQu) || !finite(o.profitQu) || !finite(o.profitPct)) return null;
  return { direction: o.direction, qty: o.qty, costQu: o.costQu, profitQu: o.profitQu, profitPct: o.profitPct };
}

/**
 * Reads the tape answer. The endpoint is new, so nothing is trusted: rows that are not shaped like a trade are dropped (and
 * counted), `t` that is clearly in seconds is turned into ms, a missing price is worked out from QU over units.
 * Throws if the answer has no list of trades at all.
 */
export function parseTape(raw: unknown): TapeResponse & { dropped: number } {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as { trades?: unknown; latestId?: unknown };
  if (!Array.isArray(body.trades)) throw new Error("The tape answer has no list of trades.");
  const trades: TapeRow[] = [];
  let dropped = 0;
  for (const r of body.trades as unknown[]) {
    const x = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    const id = typeof x.id === "string" && x.id.trim() !== "" ? Number(x.id) : x.id;
    if (!finite(id) || !finite(x.t) || typeof x.asset !== "string" || !x.asset || !finite(x.qty) || !finite(x.qu) || x.qty <= 0 || x.qu <= 0) {
      dropped++;
      continue;
    }
    trades.push({
      id,
      t: x.t < 1e11 ? x.t * 1000 : x.t, // seconds since epoch are below 1e11 until the year 5138; ms are above it since 1973
      venue: typeof x.venue === "string" ? x.venue : "",
      asset: x.asset,
      qty: x.qty,
      qu: x.qu,
      price: finite(x.price) && x.price > 0 ? x.price : x.qu / x.qty,
      ...(x.side === "buy" || x.side === "sell" ? { side: x.side } : {}),
      ...(typeof x.txHash === "string" && x.txHash ? { txHash: x.txHash } : {}),
    });
  }
  const top = trades.reduce((m, t) => Math.max(m, t.id), -Infinity);
  const latestId = finite(body.latestId) ? body.latestId : top === -Infinity ? 0 : top;
  return { trades, latestId, dropped };
}

// ---------------------------------------------------------------- the store

interface UserEntry {
  rules: Rule[];
  /** Set when alerts to this user are switched off (their DMs are closed to the bot). `reason` is meant to be shown to them. */
  disabled?: { reason: string; at: number };
}

function sanitizeState(raw: unknown): RuleState {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: RuleState = {};
  if (finite(s.lastFiredAt)) out.lastFiredAt = s.lastFiredAt;
  if (typeof s.beyond === "boolean") out.beyond = s.beyond;
  if (Array.isArray(s.present) && s.present.every((a) => typeof a === "string")) out.present = s.present as string[];
  if (finite(s.lastTradeId)) out.lastTradeId = s.lastTradeId;
  return out;
}

/** A rule read back from the file, or null if it is not a rule. One bad entry never costs the others. */
function sanitizeRule(raw: unknown, userId: string): Rule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const mode: Mode | null = r.mode === "once" ? "once" : r.mode === "repeat" ? "repeat" : null;
  if (typeof r.id !== "string" || !r.id || !mode || !finite(r.cooldownMs) || r.cooldownMs < 0 || !finite(r.createdAt)) return null;
  const base = { id: r.id, userId, mode, cooldownMs: r.cooldownMs, createdAt: r.createdAt, state: sanitizeState(r.state) };
  const asset = r.asset === null || r.asset === undefined ? null : typeof r.asset === "string" && ASSET_RE.test(r.asset) ? r.asset : undefined;
  if (asset === undefined) return null;
  if (r.kind === "price") {
    if (asset === null || (r.direction !== "above" && r.direction !== "below") || !finite(r.level) || r.level <= 0) return null;
    return { ...base, kind: "price", asset, direction: r.direction, level: r.level };
  }
  if (r.kind === "arbitrage") return { ...base, kind: "arbitrage", asset };
  if (r.kind === "bigtrade") return finite(r.minQu) && r.minQu > 0 ? { ...base, kind: "bigtrade", asset, minQu: r.minQu } : null;
  return null;
}

/**
 * Everyone's alert rules in one JSON file, keyed by Discord user id and written atomically (to a temp file, then renamed), like
 * the history store. An unreadable file is moved aside to `<path>.corrupt` and the store starts empty, so a bad file never
 * stops the bot (and is not silently overwritten); `recovered` says why. Rules with a bad shape are dropped one by one.
 */
export class AlertStore {
  private users = new Map<string, UserEntry>();
  private path: string;
  private written = "";
  private newId: () => string;
  /** Why the file could not be read, if that happened. */
  recovered?: string;

  constructor(path: string, opts: { newId?: () => string } = {}) {
    this.path = path;
    this.newId = opts.newId ?? (() => randomBytes(4).toString("hex"));
    this.load();
  }

  private load() {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return; // first run
    }
    try {
      const raw = JSON.parse(text) as { v?: unknown; users?: unknown };
      if (typeof raw !== "object" || raw === null || raw.v !== 1 || typeof raw.users !== "object" || raw.users === null || Array.isArray(raw.users)) throw new Error("the file is not an alerts file");
      for (const [userId, e] of Object.entries(raw.users as Record<string, unknown>)) {
        const entry = (typeof e === "object" && e !== null ? e : {}) as { rules?: unknown; disabled?: { reason?: unknown; at?: unknown } };
        const rules = (Array.isArray(entry.rules) ? entry.rules : []).map((r) => sanitizeRule(r, userId)).filter((r): r is Rule => r !== null).slice(0, MAX_RULES);
        const d = entry.disabled;
        const disabled = d && typeof d.reason === "string" && finite(d.at) ? { reason: d.reason, at: d.at } : undefined;
        if (rules.length || disabled) this.users.set(userId, { rules, ...(disabled ? { disabled } : {}) });
      }
      this.written = JSON.stringify(this.toJSON());
    } catch (e) {
      this.users.clear();
      this.recovered = e instanceof Error ? e.message : String(e);
      try {
        renameSync(this.path, this.path + ".corrupt");
      } catch {
        // could not move it aside: it will be overwritten by the next save
      }
    }
  }

  private toJSON() {
    const users: Record<string, UserEntry> = {};
    for (const [id, e] of this.users) users[id] = e;
    return { v: 1, users };
  }

  /** Writes the file if anything changed since the last write. Rule state changed by evaluate() is picked up here. */
  save(): void {
    const json = JSON.stringify(this.toJSON());
    if (json === this.written) return;
    writeJsonFile(this.path, this.toJSON());
    this.written = json;
  }

  /** A user's rules, oldest first. These are the live objects: evaluate() updates their `state`. */
  list(userId: string): Rule[] {
    return [...(this.users.get(userId)?.rules ?? [])];
  }

  /** Every rule of every user who is not switched off. */
  active(): Rule[] {
    return [...this.users.values()].filter((e) => !e.disabled).flatMap((e) => e.rules);
  }

  userIds(): string[] {
    return [...this.users.keys()];
  }

  /**
   * Stores a validated rule. `price` is the asset's price right now, if known: a price rule starts out knowing which side it is
   * on, so a rule made while the price is already beyond the level fires only when it comes back and crosses again.
   * Throws if the user is at the limit (validateRule says it more kindly; this is the backstop).
   */
  add(userId: string, draft: RuleDraft, now: number, price?: number): Rule {
    const entry = this.users.get(userId) ?? { rules: [] };
    if (entry.rules.length >= MAX_RULES) throw new Error(`At most ${MAX_RULES} alerts per user.`);
    let id = this.newId();
    while (entry.rules.some((r) => r.id === id)) id = this.newId();
    const rule = { ...draft, id, userId, createdAt: now, state: {} } as Rule;
    if (rule.kind === "price" && price !== undefined && Number.isFinite(price) && price > 0) rule.state.beyond = isBeyond(rule, price);
    entry.rules.push(rule);
    this.users.set(userId, entry);
    this.save();
    return rule;
  }

  remove(userId: string, ruleId: string): boolean {
    const entry = this.users.get(userId);
    const at = entry?.rules.findIndex((r) => r.id === ruleId) ?? -1;
    if (!entry || at < 0) return false;
    entry.rules.splice(at, 1);
    if (!entry.rules.length && !entry.disabled) this.users.delete(userId);
    this.save();
    return true;
  }

  /**
   * Records that an alert was delivered: the cooldown starts now. A `once` rule is finished, so it is removed
   * ("removed"); otherwise it stays ("kept"). "missing" if the rule is gone (removed while the message was being sent).
   */
  markFired(userId: string, ruleId: string, now: number): "kept" | "removed" | "missing" {
    const rule = this.users.get(userId)?.rules.find((r) => r.id === ruleId);
    if (!rule) return "missing";
    if (rule.mode === "once") {
      this.remove(userId, ruleId);
      return "removed";
    }
    rule.state.lastFiredAt = now;
    this.save();
    return "kept";
  }

  /** Switches alerts to this user off (their rules stay). `reason` is shown to them in /alerts list. */
  disable(userId: string, reason: string, now: number): void {
    const entry = this.users.get(userId) ?? { rules: [] };
    entry.disabled = { reason, at: now };
    this.users.set(userId, entry);
    this.save();
  }

  /** Switches alerts back on. Price rules forget which side they were on, so a crossing that happened while they were off is not reported as new. */
  enable(userId: string): void {
    const entry = this.users.get(userId);
    if (!entry?.disabled) return;
    delete entry.disabled;
    for (const r of entry.rules) delete r.state.beyond;
    if (!entry.rules.length) this.users.delete(userId);
    this.save();
  }

  disabled(userId: string): { reason: string; at: number } | undefined {
    return this.users.get(userId)?.disabled;
  }

  /** Forgets which tape rows were seen (for when the tape's ids start over). */
  resetTape(): void {
    for (const e of this.users.values()) for (const r of e.rules) delete r.state.lastTradeId;
    this.save();
  }
}
