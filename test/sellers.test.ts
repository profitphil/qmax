import test from "node:test";
import assert from "node:assert/strict";
import { QSWAP_ID, QX_ID } from "../src/ledger.ts";
import type { Ledger, LedgerEntry } from "../src/ledger.ts";
import { SellerService, analyzeWallet, discover, sellersRoutes, summarize } from "../src/sellers.ts";
import type { Discovery, OriginKey, SellerAsset, WalletSales } from "../src/sellers.ts";

const ISSUER = "Q".repeat(60);
const ASSET: SellerAsset = { id: "QDOGE", symbol: "QDOGE", issuer: ISSUER };
const OTHER = { symbol: "QMINE", issuer: "M".repeat(60) };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const FROM = NOW - 7 * DAY;
const w1 = "A".repeat(59) + "B";

let tick = 1;
const entry = (kind: LedgerEntry["kind"], daysAgo: number, qty: number, price: number | null, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  t: NOW - daysAgo * DAY, tick: tick++, tx: `tx${tick}`, kind, qty, quNet: 0, valueQu: price === null ? null : price * qty, price, feeQu: null, position: null, realizedQu: null,
  asset: { key: `${ASSET.symbol}|${ISSUER}`, symbol: ASSET.symbol, issuer: ISSUER }, venue: kind === "buy" || kind === "sell" ? "QX" : undefined, ...over,
});
const ledger = (entries: LedgerEntry[], held = 0): Pick<Ledger, "entries" | "positions"> => ({
  entries,
  positions: [{ asset: { key: `${ASSET.symbol}|${ISSUER}`, symbol: ASSET.symbol, issuer: ISSUER }, held } as never],
});

test("a sale is matched first in, first out to the purchases it came from, with how long they were held and what they cost", () => {
  const w = analyzeWallet(w1, ledger([
    entry("buy", 200, 100, 10), // bought 200 days ago at 10
    entry("buy", 3, 50, 30), //   bought 3 days ago at 30
    entry("sell", 1, 120, 24), // sold 120 at 24: 100 from the old lot, 20 from the new one
  ], 30), ASSET, FROM);
  assert.equal(w.unitsSold, 120);
  assert.equal(w.units.year, 100, "the 100 units held 199 days");
  assert.equal(w.units.week, 20, "and the 20 held 2 days");
  assert.equal(w.units.received + w.units.older, 0);
  assert.equal(Math.round(w.holdDays!), Math.round((100 * 199 + 20 * 2) / 120));
  assert.equal(w.costedUnits, 120);
  // cost: 100 x 10 + 20 x 30 = 1,600; sale: 120 x 24 = 2,880
  assert.equal(Math.round(w.avgCost! * 100) / 100, Math.round((1600 / 120) * 100) / 100);
  assert.equal(Math.round(w.plPct!), Math.round((2880 / 1600 - 1) * 100));
  assert.equal(w.unitsAtLoss, 20, "the 20 bought at 30 sold at 24: below cost");
  assert.equal(w.held, 30);
  assert.equal(w.firstAcquiredHow, "bought");
  assert.deepEqual(w.venues, ["QX"]);
});

test("units that arrived by transfer have no cost on record, and units from before the history are 'older'", () => {
  const w = analyzeWallet(w1, ledger([
    entry("transfer-in", 5, 40, null),
    entry("sell", 1, 60, 20), // 40 received, then 20 more than the history shows
  ]), ASSET, FROM);
  assert.equal(w.units.received, 40);
  assert.equal(w.units.older, 20);
  assert.equal(w.costedUnits, 0);
  assert.equal(w.plPct, null);
  assert.equal(w.avgCost, null);
  assert.equal(w.firstAcquiredHow, "received");
});

test("only sales inside the window count, but older sales still use up the old lots", () => {
  const w = analyzeWallet(w1, ledger([
    entry("buy", 100, 100, 10),
    entry("sell", 50, 60, 12), // before the window: uses 60 of the 100
    entry("sell", 2, 30, 15), //  in the window: from the remaining 40
  ]), ASSET, FROM);
  assert.equal(w.unitsSold, 30);
  assert.equal(w.trades, 1);
  assert.equal(w.units.year, 30, "98 days old when sold");
  assert.equal(w.proceedsQu, 450);
});

test("units sent to another wallet are moved, not sold, but they still use up the oldest units", () => {
  const w = analyzeWallet(w1, ledger([
    entry("buy", 30, 100, 10),
    entry("buy", 2, 100, 20),
    entry("transfer-out", 3, 100, null), // the old 100 leave without a sale
    entry("sell", 1, 50, 25), //            so this sale comes from the 100 bought 2 days ago
  ]), ASSET, FROM);
  assert.equal(w.unitsMoved, 100);
  assert.equal(w.unitsSold, 50);
  assert.equal(w.units.week, 50);
  assert.equal(Math.round(w.avgCost!), 20);
});

test("another asset's entries are ignored", () => {
  const other = entry("sell", 1, 999, 5, { asset: { key: "x", symbol: OTHER.symbol, issuer: OTHER.issuer } });
  const w = analyzeWallet(w1, ledger([entry("buy", 10, 10, 10), entry("sell", 1, 5, 12), other]), ASSET, FROM);
  assert.equal(w.unitsSold, 5);
});

test("discovery sums what each wallet sent and received, leaves out the two contracts and orders by what was sent", async () => {
  const ev = (source: string, destination: string, qty: number) => ({ timestamp: String(NOW - DAY), assetOwnershipChange: { source, destination, numberOfShares: String(qty) } });
  const calls: { path: string; body: any }[] = [];
  const archive = {
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path, body });
      return { hits: { total: 4 }, eventLogs: [ev(w1, QX_ID, 100), ev(w1, "C".repeat(59) + "D", 50), ev(QSWAP_ID, w1, 70), ev("E".repeat(59) + "F", w1, 10)] } as T;
    },
  };
  const d = await discover(archive, ASSET, FROM, NOW);
  assert.deepEqual(calls[0].body.filters, { logType: "2", assetName: "QDOGE", assetIssuer: ISSUER }, "asked for this asset only");
  assert.equal(d.shareMovements, 4);
  assert.equal(d.unitsMoved, 230);
  assert.equal(d.senders, 3);
  assert.equal(d.wallets[0].wallet, w1);
  assert.equal(d.wallets[0].sent, 150);
  assert.equal(d.wallets[0].received, 80, "70 from the pool and 10 from a wallet");
  assert.ok(!d.wallets.some((w) => w.wallet === QSWAP_ID || w.wallet === QX_ID));
});

const sale = (wallet: string, o: Omit<Partial<WalletSales>, "units"> & { units?: Partial<Record<OriginKey, number>> }): WalletSales => ({
  wallet, unitsSold: 100, proceedsQu: 2000, trades: 2, venues: ["QX"], unitsMoved: 0, receivedInWindow: 0, held: 0, firstAcquiredAt: NOW - 40 * DAY, firstAcquiredHow: "bought",
  holdDays: 40, costedUnits: 100, avgCost: 10, plPct: 100, unitsAtLoss: 0, ...o, units: { week: 0, month: 0, quarter: 100, year: 0, older: 0, received: 0, ...(o.units ?? {}) },
});
const discovery = (wallets: string[]): Discovery => ({ shareMovements: 50, unitsMoved: 1000, senders: wallets.length + 3, wallets: wallets.map((wallet) => ({ wallet, sent: 100, received: 0 })), walletUnitsSent: 100 * wallets.length + 300 });

test("the reading says who sold, how long they held, and whether they sold at a profit, in plain sentences", () => {
  const a = "A".repeat(59) + "1", b = "B".repeat(59) + "2", c = "C".repeat(59) + "3";
  const s = summarize({
    asset: ASSET, days: 7, now: NOW, discovery: discovery([a, b, c]), failed: 0,
    wallets: [
      sale(a, { unitsSold: 500, proceedsQu: 10_000, units: { quarter: 500 }, costedUnits: 500, avgCost: 10, plPct: 100, held: 0 }), //   a holder of a few months, doubled, left
      sale(b, { unitsSold: 250, proceedsQu: 2_500, units: { received: 250, quarter: 0 }, costedUnits: 0, avgCost: null, plPct: null, held: 700 }), // received by transfer
      sale(c, { unitsSold: 250, proceedsQu: 2_000, units: { week: 250, quarter: 0 }, costedUnits: 250, avgCost: 10, plPct: -20, unitsAtLoss: 250, receivedInWindow: 250, held: 50 }), // bought this week, sold at a loss
    ],
  });
  assert.equal(s.sold.units, 1000);
  assert.equal(s.sold.sellers, 3);
  assert.deepEqual(s.buckets.map((x) => [x.key, Math.round(x.sharePct)]), [["week", 25], ["month", 0], ["quarter", 50], ["year", 0], ["older", 0], ["received", 25]]);
  assert.equal(s.sellers[0].wallet, a);
  assert.equal(s.sellers[0].soldOfPositionPct, 100);
  assert.equal(s.sellers[2].roundTrip, true);
  const text = s.reading.join(" ");
  assert.match(text, /3 wallets sold 1K QDOGE/);
  assert.match(text, /biggest, AAAAA…AAAA1, sold 50% of it; the three biggest together 100%/);
  assert.match(text, /25% of the units sold \(250\) were received by transfer/);
  assert.match(text, /25% of the units sold had been bought within the previous 7 days/);
  assert.match(text, /50% of the units sold had been held for more than a month/);
  assert.match(text, /1 of the 3 sellers sold nearly everything they held \(50% of the units sold came from them\)/);
  assert.match(text, /1 seller received about as many units in the same week as they sold \(25% of the units sold\)/);
  assert.doesNotMatch(text, /not counted/, "every sender was read");
  const partial = summarize({ asset: ASSET, days: 7, now: NOW, discovery: discovery([a, b, c, "D".repeat(59) + "4"]), failed: 0, wallets: [sale(a, {}), sale(b, {}), sale(c, {})] });
  assert.match(partial.reading.join(" "), /The 3 biggest senders were read, 43% of the units wallets sent in the window; 1 smaller sender is not counted/);
  assert.ok(!/because|intend|panic|dump/i.test(text), "it says what the chain shows, not why");
  // costed: 750 units that cost 7,500; they sold for 500 x 20 + 250 x 8 = 12,000: +60.0%; the 250 sold below cost are a third
  assert.match(text, /\+60\.0% against what they paid, and 33% of those units sold below cost/);
});

test("with no sales it says so, and what moved instead", () => {
  const a = "A".repeat(59) + "1";
  const s = summarize({ asset: ASSET, days: 7, now: NOW, discovery: discovery([a]), failed: 0, wallets: [sale(a, { unitsSold: 0, proceedsQu: 0, unitsMoved: 5000, units: { quarter: 0 } })] });
  assert.equal(s.sold.units, 0);
  assert.match(s.reading[0], /None of the wallets that moved QDOGE in the last 7 days sold it on QX or QSwap/);
  assert.match(s.reading.join(" "), /5K units were sent to other wallets/);
  const none = summarize({ asset: ASSET, days: 7, now: NOW, discovery: { shareMovements: 0, unitsMoved: 0, senders: 0, wallets: [], walletUnitsSent: 0 }, wallets: [], failed: 0 });
  assert.equal(none.reading[0], "No QDOGE moved in the last 7 days.");
});

function service(o: { ledgers?: Record<string, Pick<Ledger, "entries" | "positions"> | Error>; assets?: string[]; clock?: { t: number }; maxStarts?: number; wallets?: string[] } = {}) {
  const clock = o.clock ?? { t: NOW };
  const sellerWallets = o.wallets ?? [w1];
  const reads: string[] = [];
  const archiveCalls = { n: 0 };
  const svc = new SellerService({
    archive: {
      async post<T>(): Promise<T> {
        archiveCalls.n++;
        return { hits: { total: sellerWallets.length }, eventLogs: sellerWallets.map((s) => ({ timestamp: String(NOW - DAY), assetOwnershipChange: { source: s, destination: QX_ID, numberOfShares: "100" } })) } as T;
      },
    },
    ledgerOf: async (id) => {
      reads.push(id);
      const l = o.ledgers?.[id];
      if (l instanceof Error) throw l;
      return (l ?? ledger([entry("buy", 30, 100, 10), entry("sell", 1, 100, 20)])) as Ledger;
    },
    lookup: (id) => ((o.assets ?? ["QDOGE"]).includes(id.toUpperCase()) ? { id: id.toUpperCase(), symbol: id.toUpperCase(), issuer: ISSUER } : null),
    now: () => clock.t,
    sleep: async () => {},
    pauseMs: 0,
    maxStartsPerHour: o.maxStarts ?? 12,
  });
  return { svc, reads, archiveCalls, clock };
}
const settle = async (svc: SellerService, id: string) => {
  for (let i = 0; i < 50; i++) {
    const v = svc.view(id);
    if (v && v.status !== "working") return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("did not settle");
};

test("the first request starts the reading and says it is working; a later one gets the finished reading, kept for six hours", async () => {
  const { svc, reads, archiveCalls, clock } = service();
  const first = svc.view("qdoge")!;
  assert.equal(first.status, "working");
  const done = await settle(svc, "QDOGE");
  assert.equal(done.status, "ready");
  assert.equal((done as { analysis: { sold: { units: number } } }).analysis.sold.units, 100);
  assert.equal(reads.length, 1);
  assert.equal(svc.view("QDOGE")!.status, "ready");
  assert.equal(archiveCalls.n, 1, "asking again reads nothing");
  clock.t += 7 * 3_600_000;
  assert.equal(svc.view("QDOGE")!.status, "working", "after six hours it is read again");
  assert.equal(svc.view("NOPE"), null, "an unlisted asset");
});

test("what is known so far is shown while the wallets are being read", async () => {
  const wallets = ["A".repeat(59) + "1", "B".repeat(59) + "2", "C".repeat(59) + "3"];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reads: string[] = [];
  const svc = new SellerService({
    archive: { post: async <T>() => ({ hits: { total: 3 }, eventLogs: wallets.map((s) => ({ timestamp: String(NOW - DAY), assetOwnershipChange: { source: s, destination: QX_ID, numberOfShares: "100" } })) }) as T },
    ledgerOf: async (id) => {
      reads.push(id);
      if (reads.length === 2) await gate;
      return ledger([entry("buy", 30, 100, 10), entry("sell", 1, 100, 20)]) as Ledger;
    },
    lookup: () => ASSET,
    now: () => NOW,
    sleep: async () => {},
    pauseMs: 0,
  });
  svc.view("QDOGE");
  await new Promise((r) => setTimeout(r, 20));
  const mid = svc.view("QDOGE")!;
  assert.equal(mid.status, "working");
  if (mid.status === "working") {
    assert.deepEqual(mid.progress, { done: 1, total: 3 });
    assert.equal(mid.analysis?.sold.sellers, 1, "the first wallet is already in the figures");
  }
  release();
  assert.equal((await settle(svc, "QDOGE")).status, "ready");
});

test("a wallet that cannot be read is counted as failed and the rest still finish; if none can be read it is an error that is retried soon", async () => {
  const bad = "B".repeat(59) + "2";
  const { svc } = service({ wallets: [w1, bad], ledgers: { [bad]: new Error("archive 429") } });
  const done = await settle(svc, "QDOGE");
  assert.equal(done.status, "ready");
  assert.equal((done as { analysis: { analyzed: { failed: number; wallets: number } } }).analysis.analyzed.failed, 1);
  const all = service({ wallets: [w1], ledgers: { [w1]: new Error("archive 429") } });
  const err = await settle(all.svc, "QDOGE");
  assert.equal(err.status, "error");
  assert.ok((err as { retryAfterSec: number }).retryAfterSec >= 60);
  assert.equal(all.svc.view("QDOGE")!.status, "error", "the error is shown for a few minutes, not retried on every request");
  all.clock.t += 4 * 60_000;
  assert.equal(all.svc.view("QDOGE")!.status, "working", "then tried again");
});

test("only so many new readings start an hour, so asking for every asset cannot wear out the archive", async () => {
  const { svc } = service({ assets: ["QDOGE", "QMINE", "CODED"], maxStarts: 2 });
  assert.equal(svc.view("QDOGE")!.status, "working");
  assert.equal(svc.view("QMINE")!.status, "working");
  const third = svc.view("CODED")!;
  assert.equal(third.status, "busy");
  assert.ok((third as { retryAfterSec: number }).retryAfterSec >= 60);
  await settle(svc, "QDOGE");
  assert.equal(svc.view("QDOGE")!.status, "ready", "one already read is still served");
});

test("the route answers with the reading, 404 for an unknown asset, 503 when busy", async () => {
  const { svc } = service({ assets: ["QDOGE", "A", "B"], maxStarts: 1 });
  const [route] = sellersRoutes(svc);
  const out = (await route.handler({ query: new URLSearchParams("asset=QDOGE"), body: undefined })) as { status: string };
  assert.equal(out.status, "working");
  await assert.rejects(Promise.resolve().then(() => route.handler({ query: new URLSearchParams("asset=NOPE"), body: undefined })), /Unknown asset/);
  await assert.rejects(Promise.resolve().then(() => route.handler({ query: new URLSearchParams("asset=A"), body: undefined })), /busy/);
  await assert.rejects(Promise.resolve().then(() => route.handler({ query: new URLSearchParams(""), body: undefined })), /asset/);
});

test("every holding-period row has a short label for the screen", async () => {
  const { ORIGINS } = await import("../src/sellers.ts");
  const { ORIGIN_LABELS } = await import("../web/sellers-labels.ts");
  assert.deepEqual(Object.keys(ORIGIN_LABELS).sort(), ORIGINS.map((o) => o.key).sort());
  for (const label of Object.values(ORIGIN_LABELS)) assert.ok(label.length > 8 && label.length <= 32, label);
});
