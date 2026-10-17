import { QSWAP_ID, QX_ID } from "./ledger.ts";
import type { Ledger, LedgerEntry } from "./ledger.ts";
import { RouteError, required } from "./routes.ts";
import type { Route } from "./routes.ts";

/**
 * Who is selling an asset, and what they paid for it. For one asset and a window (the last seven days) this finds every wallet that moved the asset (the archive's share-movement
 * events can be filtered by asset), takes the biggest, reads each one's trade history (the same ledger a portfolio uses) and follows their units first in, first out: each unit sold
 * is matched to the purchase (or transfer in) it came from. That gives, for every sale, how long the seller had held the unit, what it cost them (when it was bought on QX or QSwap)
 * and whether it sold above or below that. The chain shows who sold and what they paid; it cannot show why, so the findings are said as what the numbers are, not as motives.
 */

export interface SellerAsset {
  id: string;
  symbol: string;
  issuer: string;
}

export type OriginKey = "week" | "month" | "quarter" | "year" | "older" | "received";

/** How long the units sold had been held, from the purchase they came from; and the units that were never bought on QX or QSwap. */
export const ORIGINS: { key: OriginKey; label: string }[] = [
  { key: "week", label: "Bought in the last 7 days" },
  { key: "month", label: "Bought 8 to 30 days earlier" },
  { key: "quarter", label: "Bought 1 to 3 months earlier" },
  { key: "year", label: "Bought 3 to 12 months earlier" },
  { key: "older", label: "Held since before the history QMax reads (over a year)" },
  { key: "received", label: "Received by transfer, not bought on QX or QSwap" },
];

const DAY = 86_400_000;

/** One stretch of a sale matched to the lot it came from. */
interface Piece {
  qty: number;
  /** When the lot was acquired; null when it is older than the history read. */
  lotAt: number | null;
  /** What the lot cost per unit, fees included; null for a transfer in and for units older than the history. */
  lotPrice: number | null;
  origin: "bought" | "received" | "older";
  salePrice: number | null;
  saleAt: number;
}

export interface WalletSales {
  wallet: string;
  unitsSold: number;
  proceedsQu: number;
  trades: number;
  venues: ("QX" | "QSwap")[];
  /** Units sent on to another wallet in the window without a sale. */
  unitsMoved: number;
  /** Units received in the window (bought or transferred in), from the share-movement events. */
  receivedInWindow: number;
  held: number | null;
  firstAcquiredAt: number | null;
  firstAcquiredHow: "bought" | "received" | null;
  units: Record<OriginKey, number>;
  /** Units-weighted days held, over the units whose lot has a date. */
  holdDays: number | null;
  /** Units sold from lots that cost something on record, and their average cost and the profit or loss against what they sold for. */
  costedUnits: number;
  avgCost: number | null;
  plPct: number | null;
  unitsAtLoss: number;
}

const sameAsset = (e: LedgerEntry, a: SellerAsset) => !!e.asset && e.asset.symbol === a.symbol && e.asset.issuer === a.issuer;

const bucketOf = (days: number): OriginKey => (days <= 7 ? "week" : days <= 30 ? "month" : days <= 90 ? "quarter" : days <= 365 ? "year" : "older");

/**
 * One wallet's sales of the asset in the window, each matched first in, first out to the lots (purchases and transfers in) it came from. Units that came from before the history
 * the ledger reads are "older". A sale whose lot was received by transfer has no cost on record.
 */
export function analyzeWallet(wallet: string, ledger: Pick<Ledger, "entries" | "positions">, asset: SellerAsset, fromMs: number, receivedInWindow = 0): WalletSales {
  type Lot = { at: number; qty: number; price: number | null; kind: "bought" | "received" };
  const lots: Lot[] = [];
  const pieces: Piece[] = [];
  let unitsMoved = 0;
  let firstAt: number | null = null;
  let firstHow: "bought" | "received" | null = null;
  let proceeds = 0;
  let trades = 0;
  const venues = new Set<"QX" | "QSwap">();

  const entries = ledger.entries.filter((e) => sameAsset(e, asset) && (e.kind === "buy" || e.kind === "transfer-in" || e.kind === "sell" || e.kind === "transfer-out")).sort((a, b) => a.t - b.t || a.tick - b.tick);
  for (const e of entries) {
    if (e.kind === "buy" || e.kind === "transfer-in") {
      lots.push({ at: e.t, qty: e.qty, price: e.kind === "buy" ? e.price : null, kind: e.kind === "buy" ? "bought" : "received" });
      if (firstAt === null) {
        firstAt = e.t;
        firstHow = e.kind === "buy" ? "bought" : "received";
      }
      continue;
    }
    // a sale or a transfer out: it uses up the oldest lots first
    let left = e.qty;
    const inWindow = e.t >= fromMs;
    while (left > 0) {
      const lot = lots[0];
      const take = lot ? Math.min(lot.qty, left) : left;
      if (inWindow && e.kind === "sell") pieces.push({ qty: take, lotAt: lot?.at ?? null, lotPrice: lot?.price ?? null, origin: lot ? lot.kind : "older", salePrice: e.price, saleAt: e.t });
      if (lot) {
        lot.qty -= take;
        if (lot.qty <= 0) lots.shift();
      }
      left -= take;
    }
    if (inWindow && e.kind === "sell") {
      proceeds += e.valueQu ?? 0;
      trades++;
      if (e.venue === "QX" || e.venue === "QSwap") venues.add(e.venue);
    }
    if (inWindow && e.kind === "transfer-out") unitsMoved += e.qty;
  }

  const units: Record<OriginKey, number> = { week: 0, month: 0, quarter: 0, year: 0, older: 0, received: 0 };
  let dated = 0;
  let datedDays = 0;
  let costed = 0;
  let costSum = 0;
  let saleOfCosted = 0;
  let atLoss = 0;
  let sold = 0;
  for (const p of pieces) {
    sold += p.qty;
    if (p.origin === "received") units.received += p.qty;
    else if (p.origin === "older" || p.lotAt === null) units.older += p.qty;
    else units[bucketOf((p.saleAt - p.lotAt) / DAY)] += p.qty;
    if (p.lotAt !== null) {
      dated += p.qty;
      datedDays += p.qty * ((p.saleAt - p.lotAt) / DAY);
    }
    if (p.origin === "bought" && p.lotPrice !== null && p.lotPrice > 0 && p.salePrice !== null) {
      costed += p.qty;
      costSum += p.qty * p.lotPrice;
      saleOfCosted += p.qty * p.salePrice;
      if (p.salePrice < p.lotPrice) atLoss += p.qty;
    }
  }
  const position = ledger.positions.find((x) => x.asset.symbol === asset.symbol && x.asset.issuer === asset.issuer);
  return {
    wallet,
    unitsSold: sold,
    proceedsQu: proceeds,
    trades,
    venues: [...venues],
    unitsMoved,
    receivedInWindow,
    held: position ? position.held : null,
    firstAcquiredAt: firstAt,
    firstAcquiredHow: firstHow,
    units,
    holdDays: dated > 0 ? datedDays / dated : null,
    costedUnits: costed,
    avgCost: costed > 0 ? costSum / costed : null,
    plPct: costed > 0 && costSum > 0 ? (saleOfCosted / costSum - 1) * 100 : null,
    unitsAtLoss: atLoss,
  };
}

/* ---------- discovery: who moved the asset ---------- */

interface ShareEvent {
  timestamp: string;
  assetOwnershipChange?: { source: string; destination: string; numberOfShares: string };
}

export interface Discovery {
  shareMovements: number;
  unitsMoved: number;
  senders: number;
  /** Wallets (not QX or QSwap) that sent the asset in the window, biggest first, with units sent and units received in the window. */
  wallets: { wallet: string; sent: number; received: number }[];
  /** Units QX-or-pool-bound or wallet-to-wallet: everything sent by wallets, for the coverage figure. */
  walletUnitsSent: number;
}

/** The archive's share movements of this asset in the window, summed by wallet. Pages of 1,000; a week of one asset is a few hundred. */
export async function discover(archive: { post<T>(path: string, body: unknown): Promise<T> }, asset: SellerAsset, fromMs: number, toMs: number, maxPages = 20): Promise<Discovery> {
  const sent = new Map<string, number>();
  const received = new Map<string, number>();
  let movements = 0;
  for (let page = 0; page < maxPages; page++) {
    const r = await archive.post<{ hits: { total: number }; eventLogs?: ShareEvent[] }>("/query/v1/getEventLogs", {
      filters: { logType: "2", assetName: asset.symbol, assetIssuer: asset.issuer },
      ranges: { timestamp: { gte: String(fromMs), lte: String(toMs) } },
      pagination: { offset: page * 1000, size: 1000 },
    });
    for (const e of r.eventLogs ?? []) {
      const o = e.assetOwnershipChange;
      if (!o) continue;
      const qty = Number(o.numberOfShares);
      if (!(qty > 0)) continue;
      movements++;
      sent.set(o.source, (sent.get(o.source) ?? 0) + qty);
      received.set(o.destination, (received.get(o.destination) ?? 0) + qty);
    }
    if ((page + 1) * 1000 >= r.hits.total) break;
  }
  const contracts = new Set([QX_ID, QSWAP_ID]);
  const wallets = [...sent.entries()].filter(([w]) => !contracts.has(w)).map(([wallet, s]) => ({ wallet, sent: s, received: received.get(wallet) ?? 0 })).sort((a, b) => b.sent - a.sent);
  return { shareMovements: movements, unitsMoved: [...sent.values()].reduce((a, b) => a + b, 0), senders: sent.size, wallets, walletUnitsSent: wallets.reduce((a, w) => a + w.sent, 0) };
}

/* ---------- the analysis ---------- */

export interface SellerRow {
  wallet: string;
  units: number;
  sharePct: number;
  proceedsQu: number;
  avgPriceQu: number | null;
  trades: number;
  venues: string[];
  firstAcquiredAt: number | null;
  firstAcquiredHow: "bought" | "received" | null;
  holdDays: number | null;
  avgCostQu: number | null;
  plPct: number | null;
  heldNow: number | null;
  /** Units sold as a share of what the wallet had (sold plus still held), when what it holds is known. */
  soldOfPositionPct: number | null;
  /** Where most of the units it sold came from. */
  mainOrigin: OriginKey | null;
  /** It received nearly as much as it sold in the window: it bought (or was sent) the units this week and passed them on. */
  roundTrip: boolean;
}

export interface SellersAnalysis {
  asset: { id: string; symbol: string };
  window: { days: number; from: string; to: string };
  discovered: { shareMovements: number; unitsMoved: number; senders: number };
  /** Wallets read, how many could not be read, how many wallets sent the asset in all, and the share of the units wallets sent that the ones read account for. */
  analyzed: { wallets: number; failed: number; senders: number; coveragePct: number };
  sold: { units: number; proceedsQu: number; avgPriceQu: number | null; sellers: number; trades: number; costedUnits: number; plPct: number | null; unitsAtLossPct: number | null };
  moved: { units: number; wallets: number };
  buckets: { key: OriginKey; label: string; units: number; sharePct: number; sellers: number }[];
  sellers: SellerRow[];
  /** What the numbers say, in plain sentences (what the chain shows, not why). */
  reading: string[];
  note: string;
}

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const compact = (x: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(x);
const short = (w: string) => `${w.slice(0, 5)}…${w.slice(-5)}`;
const pctOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

export function summarize(args: { asset: SellerAsset; days: number; now: number; discovery: Discovery; wallets: WalletSales[]; failed: number }): SellersAnalysis {
  const { asset, days, now, discovery, wallets, failed } = args;
  const sellersWith = wallets.filter((w) => w.unitsSold > 0);
  const soldUnits = sellersWith.reduce((a, w) => a + w.unitsSold, 0);
  const proceeds = sellersWith.reduce((a, w) => a + w.proceedsQu, 0);
  const costed = sellersWith.reduce((a, w) => a + w.costedUnits, 0);
  const costBasis = sellersWith.reduce((a, w) => a + (w.avgCost ?? 0) * w.costedUnits, 0);
  const saleOfCosted = sellersWith.reduce((a, w) => a + (w.plPct !== null && w.avgCost ? (w.plPct / 100 + 1) * w.avgCost * w.costedUnits : 0), 0);
  const atLoss = sellersWith.reduce((a, w) => a + w.unitsAtLoss, 0);
  const moved = wallets.reduce((a, w) => a + w.unitsMoved, 0);

  const buckets = ORIGINS.map((o) => {
    const units = sellersWith.reduce((a, w) => a + w.units[o.key], 0);
    return { key: o.key, label: o.label, units, sharePct: pctOf(units, soldUnits), sellers: sellersWith.filter((w) => w.units[o.key] > 0).length };
  });

  const rows: SellerRow[] = sellersWith
    .map((w): SellerRow => {
      const main = ORIGINS.map((o) => ({ key: o.key, u: w.units[o.key] })).sort((a, b) => b.u - a.u)[0];
      return {
        wallet: w.wallet,
        units: w.unitsSold,
        sharePct: pctOf(w.unitsSold, soldUnits),
        proceedsQu: w.proceedsQu,
        avgPriceQu: w.unitsSold > 0 && w.proceedsQu > 0 ? w.proceedsQu / w.unitsSold : null,
        trades: w.trades,
        venues: w.venues,
        firstAcquiredAt: w.firstAcquiredAt,
        firstAcquiredHow: w.firstAcquiredHow,
        holdDays: w.holdDays,
        avgCostQu: w.avgCost,
        plPct: w.plPct,
        heldNow: w.held,
        soldOfPositionPct: w.held !== null && w.unitsSold + w.held > 0 ? pctOf(w.unitsSold, w.unitsSold + w.held) : null,
        mainOrigin: main && main.u > 0 ? main.key : null,
        roundTrip: w.unitsSold > 0 && w.receivedInWindow >= 0.8 * w.unitsSold,
      };
    })
    .sort((a, b) => b.units - a.units);

  const coveragePct = pctOf(wallets.reduce((a, w) => a + (discovery.wallets.find((d) => d.wallet === w.wallet)?.sent ?? 0), 0), discovery.walletUnitsSent);

  const reading: string[] = [];
  const name = asset.symbol;
  if (soldUnits <= 0) {
    reading.push(discovery.shareMovements === 0 ? `No ${name} moved in the last ${days} days.` : `None of the wallets that moved ${name} in the last ${days} days sold it on QX or QSwap among the ${wallets.length} read${moved > 0 ? `; ${compact(moved)} units were sent to other wallets` : ""}.`);
  } else {
    const top1 = rows[0];
    const top3 = rows.slice(0, 3).reduce((a, r) => a + r.sharePct, 0);
    reading.push(`${rows.length} wallets sold ${compact(soldUnits)} ${name} on QX and QSwap in the last ${days} days${proceeds > 0 ? ` for about ${compact(proceeds)} QU` : ""}. The biggest, ${short(top1.wallet)}, sold ${top1.sharePct.toFixed(0)}% of it; the three biggest together ${top3.toFixed(0)}%.`);
    const get = (k: OriginKey) => buckets.find((b) => b.key === k)!;
    const received = get("received");
    if (received.sharePct >= 20) reading.push(`${received.sharePct.toFixed(0)}% of the units sold (${compact(received.units)}) were received by transfer, not bought on QX or QSwap: a distribution, an airdrop or a move from another wallet. Those sellers' cost is not on record.`);
    const week = get("week");
    if (week.sharePct >= 20) reading.push(`${week.sharePct.toFixed(0)}% of the units sold had been bought within the previous 7 days: short-term trading rather than long-term holders leaving.`);
    const long = buckets.filter((b) => b.key === "quarter" || b.key === "year" || b.key === "older").reduce((a, b) => a + b.units, 0);
    if (pctOf(long, soldUnits) >= 20) reading.push(`${pctOf(long, soldUnits).toFixed(0)}% of the units sold had been held for more than a month (older than 30 days when sold).`);
    if (costed > 0 && costBasis > 0) {
      const pl = (saleOfCosted / costBasis - 1) * 100;
      reading.push(`Where the purchase is on record (${pctOf(costed, soldUnits).toFixed(0)}% of the units sold), sellers got ${pl >= 0 ? "+" : "−"}${Math.abs(pl).toFixed(1)}% against what they paid, and ${pctOf(atLoss, costed).toFixed(0)}% of those units sold below cost.`);
    }
    const exits = rows.filter((r) => r.soldOfPositionPct !== null && r.soldOfPositionPct >= 90);
    if (exits.length > 0) reading.push(`${exits.length} of the ${rows.length} sellers sold nearly everything they held (${exits.reduce((a, r) => a + r.sharePct, 0).toFixed(0)}% of the units sold came from them): exits, not trimming.`);
    const trips = rows.filter((r) => r.roundTrip);
    if (trips.length > 0) reading.push(`${trips.length} seller${trips.length === 1 ? "" : "s"} received about as many units in the same week as they sold (${trips.reduce((a, r) => a + r.sharePct, 0).toFixed(0)}% of the units sold): bots, market makers or units passed straight on.`);
  }
  if (moved > 0) reading.push(`${compact(moved)} units were sent from these wallets to other wallets without a sale. Units moved are not sold yet, but they are now in other hands.`);
  if (wallets.length < discovery.wallets.length) {
    const rest = discovery.wallets.length - wallets.length;
    reading.push(`The ${wallets.length} biggest senders were read, ${coveragePct.toFixed(0)}% of the units wallets sent in the window; ${rest} smaller sender${rest === 1 ? " is" : "s are"} not counted.`);
  }

  return {
    asset: { id: asset.id, symbol: asset.symbol },
    window: { days, from: new Date(now - days * DAY).toISOString(), to: new Date(now).toISOString() },
    discovered: { shareMovements: discovery.shareMovements, unitsMoved: discovery.unitsMoved, senders: discovery.senders },
    analyzed: { wallets: wallets.length, failed, senders: discovery.wallets.length, coveragePct },
    sold: { units: soldUnits, proceedsQu: proceeds, avgPriceQu: soldUnits > 0 && proceeds > 0 ? proceeds / soldUnits : null, sellers: rows.length, trades: sellersWith.reduce((a, w) => a + w.trades, 0), costedUnits: costed, plPct: costed > 0 && costBasis > 0 ? (saleOfCosted / costBasis - 1) * 100 : null, unitsAtLossPct: costed > 0 ? pctOf(atLoss, costed) : null },
    moved: { units: moved, wallets: wallets.filter((w) => w.unitsMoved > 0).length },
    buckets,
    sellers: rows.slice(0, 25),
    reading,
    note: "Read from the public archive: who sold on QX or QSwap, matched first in, first out to the purchase (or transfer) each unit came from. It shows what the chain records, who sold and what they paid, and cannot show why. Costs include fees. A wallet can be one person's or an exchange's or a bot's.",
  };
}

/* ---------- the service: background jobs, cached ---------- */

export type SellersView =
  | { status: "working"; progress: { done: number; total: number }; analysis: SellersAnalysis | null; startedAt: number }
  | { status: "ready"; analysis: SellersAnalysis; at: number }
  | { status: "busy"; retryAfterSec: number; message: string }
  | { status: "error"; message: string; retryAfterSec: number };

export interface SellersDeps {
  /** The archive (QubicRpc in production). */
  archive: { post<T>(path: string, body: unknown): Promise<T> };
  /** One wallet's ledger, as the portfolio reads it (365 days). */
  ledgerOf(identity: string): Promise<Ledger>;
  /** The asset by id, or null when it is not listed. */
  lookup(id: string): SellerAsset | null;
  now?: () => number;
  /** Wallets read per asset. Default 12 (about 12 seconds each). */
  maxWallets?: number;
  /** How long a finished analysis is kept. Default 6 hours. */
  ttlMs?: number;
  /** New analyses started per hour, so the archive is not worn out by asking for every asset. Default 12. */
  maxStartsPerHour?: number;
  /** A pause between wallets, ms. Default 1000. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const WINDOW_DAYS = 7;

export class SellerService {
  private deps: SellersDeps;
  private jobs = new Map<string, { view: SellersView; at: number }>();
  private queue: string[] = [];
  private running = false;
  private starts: number[] = [];

  constructor(deps: SellersDeps) {
    this.deps = deps;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** What there is to show for an asset: a finished analysis, one in progress (starting it if nothing is), or why not. */
  view(id: string): SellersView | null {
    const asset = this.deps.lookup(id);
    if (!asset) return null;
    const key = asset.id.toUpperCase();
    const ttl = this.deps.ttlMs ?? 6 * 3_600_000;
    const hit = this.jobs.get(key);
    if (hit) {
      const v = hit.view;
      if (v.status === "working") return v;
      if (v.status === "ready" && this.now() - hit.at < ttl) return v;
      if (v.status === "error" && this.now() - hit.at < v.retryAfterSec * 1000) return v;
    }
    const recent = this.starts.filter((t) => this.now() - t < 3_600_000);
    if (recent.length >= (this.deps.maxStartsPerHour ?? 12)) {
      const wait = Math.ceil((recent[0] + 3_600_000 - this.now()) / 1000);
      return hit?.view.status === "ready" ? hit.view : { status: "busy", retryAfterSec: Math.max(60, wait), message: "QMax is busy reading other assets' sellers; try again later." };
    }
    this.starts = [...recent, this.now()];
    this.jobs.set(key, { view: { status: "working", progress: { done: 0, total: 0 }, analysis: null, startedAt: this.now() }, at: this.now() });
    this.queue.push(key);
    void this.pump();
    return this.jobs.get(key)!.view;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const key = this.queue.shift()!;
        const asset = this.deps.lookup(key);
        if (asset) await this.run(asset);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(asset: SellerAsset) {
    const key = asset.id.toUpperCase();
    const job = this.jobs.get(key)!;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const toMs = this.now();
    const fromMs = toMs - WINDOW_DAYS * DAY;
    try {
      const discovery = await discover(this.deps.archive, asset, fromMs, toMs);
      const chosen = discovery.wallets.slice(0, this.deps.maxWallets ?? 12);
      const done: WalletSales[] = [];
      let failed = 0;
      const publish = (finished: boolean) => {
        const analysis = summarize({ asset, days: WINDOW_DAYS, now: toMs, discovery, wallets: done, failed });
        job.view = finished ? { status: "ready", analysis, at: this.now() } : { status: "working", progress: { done: done.length + failed, total: chosen.length }, analysis, startedAt: (job.view as { startedAt: number }).startedAt };
        job.at = this.now();
      };
      job.view = { status: "working", progress: { done: 0, total: chosen.length }, analysis: null, startedAt: (job.view as { startedAt: number }).startedAt };
      for (const w of chosen) {
        let ledger: Ledger | null = null;
        for (let attempt = 0; attempt < 2 && !ledger; attempt++) {
          try {
            ledger = await this.deps.ledgerOf(w.wallet);
          } catch {
            if (attempt === 0) await sleep(5000);
          }
        }
        if (ledger) done.push(analyzeWallet(w.wallet, ledger, asset, fromMs, w.received));
        else failed++;
        publish(false);
        await sleep(this.deps.pauseMs ?? 1000);
      }
      if (chosen.length > 0 && failed === chosen.length) throw new Error("the archive did not answer for any wallet");
      publish(true);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      job.view = { status: "error", message: `Could not read the sellers just now (${why.slice(0, 120)}). It will be tried again shortly.`, retryAfterSec: 180 };
      job.at = this.now();
    }
  }

  /** Starts the analysis for an asset in the background without waiting (to have it ready before anyone asks). */
  warm(id: string): void {
    this.view(id);
  }
}

/* ---------- the API ---------- */

export function sellersRoutes(service: SellerService): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/sellers",
      limited: false,
      rate: { perMin: 30 },
      doc: {
        summary: "Who has been selling an asset, and what they paid",
        description:
          "For the last 7 days: the wallets that sold the asset on QX or QSwap, how long each had held the units (matched first in, first out to the purchase they came from), what they cost and whether they sold above or below that, with a plain-language reading. Read from the public archive, so the first request for an asset starts the reading and answers `status: working` with progress (and what is known so far); ask again every few seconds until `status: ready`. A finished reading is kept for 6 hours. The chain shows who sold and what they paid, not why.",
        parameters: [{ name: "asset", in: "query", required: true, schema: { type: "string" }, description: "Asset id or symbol, e.g. QDOGE" }],
        responses: { "200": { description: "The reading (working or ready), or why there is none yet" }, "400": { description: "Missing asset" }, "404": { description: "Unknown asset" } },
      },
      handler({ query }) {
        const asset = required(query, "asset").trim();
        if (!asset || asset.length > 40) throw new RouteError(400, "asset is required");
        const v = service.view(asset);
        if (!v) throw new RouteError(404, `Unknown asset '${asset}'`);
        if (v.status === "busy") throw new RouteError(503, v.message, { retryAfterSec: v.retryAfterSec });
        return v;
      },
    },
  ];
}

