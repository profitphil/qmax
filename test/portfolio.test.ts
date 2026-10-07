import test from "node:test";
import assert from "node:assert/strict";
import type { LedgerEntry, LedgerPosition } from "../src/ledger.ts";
import type { LiquidationItem } from "../src/liquidation.ts";
import { buildPortfolio } from "../src/portfolio.ts";
import type { HoldingIn } from "../src/portfolio.ts";

const ISSUER = "A".repeat(60);
const asset = (symbol: string) => ({ key: `${symbol}|${ISSUER}`, symbol, issuer: ISSUER });
const hold = (symbol: string, qty: number): HoldingIn => ({ key: `${symbol}|${ISSUER}`, id: symbol, symbol, qty });
const liq = (o: Partial<LiquidationItem> & { asset: string }): LiquidationItem => ({ qty: 0, fillableQty: o.qty ?? 0, proceedsQu: 0, avgPriceQu: null, midValueQu: null, haircutPct: null, venues: ["QX"], complete: true, ...o });
const pos = (symbol: string, o: Partial<LedgerPosition> = {}): LedgerPosition => ({ asset: asset(symbol), held: 100, costedQty: 100, avgCost: 10, costQu: 1000, realizedQu: 0, uncostedProceedsQu: 0, priceQu: 12, valueQu: 1200, unrealizedQu: 200, unrealizedPct: 20, feesQu: 0, bought: 100, sold: 0, spentQu: 1000, receivedQu: 0, trades: 1, preWindowQty: 0, ...o });
const buy = (symbol: string, t: number): LedgerEntry => ({ t, tick: 1, tx: `tx${t}`, kind: "buy", venue: "QX", asset: asset(symbol), qty: 10, quNet: -100, valueQu: 100, price: 10, feeQu: 0, position: 10, realizedQu: null });
const ledger = (positions: LedgerPosition[], entries: LedgerEntry[] = [], realizedQu = 0) => ({ positions, entries, totals: { realizedQu } as never });

test("worth is what a real sale brings, and profit is that against what the units cost", () => {
  const { rows, totals } = buildPortfolio([hold("AAA", 100)], [liq({ asset: "AAA", qty: 100, proceedsQu: 1500, midValueQu: 1600, haircutPct: 6.25 })], ledger([pos("AAA", { avgCost: 10, costedQty: 100 })], [buy("AAA", 1000), buy("AAA", 3000)]));
  const r = rows[0];
  assert.equal(r.proceedsQu, 1500);
  assert.equal(r.bought, "yes");
  assert.equal(r.avgCost, 10);
  assert.equal(r.costQu, 1000);
  assert.equal(r.plQu, 500); // 1500 now against 1000 paid
  assert.equal(r.plPct, 50);
  assert.equal(r.firstBuyMs, 1000);
  assert.equal(r.lastBuyMs, 3000);
  assert.equal(r.buys, 2);
  assert.equal(totals.worthQu, 1500);
  assert.equal(totals.plQu, 500);
  assert.equal(totals.plPct, 50);
  assert.equal(totals.costQu, 1000);
  assert.equal(totals.haircutQu, 100); // 1600 at mid, 1500 on a real sale
});

test("a loss shows as a loss, even when the last price said a profit", () => {
  // mid says 12 a unit (above the 10 paid), but selling the lot lands at 8 a unit
  const { rows } = buildPortfolio([hold("AAA", 100)], [liq({ asset: "AAA", qty: 100, proceedsQu: 800, midValueQu: 1200 })], ledger([pos("AAA", { avgCost: 10, costedQty: 100 })]));
  assert.equal(rows[0].plQu, -200);
  assert.equal(rows[0].plPct, -20);
});

test("units with no purchase found have a worth but no profit, and say so", () => {
  const { rows, totals } = buildPortfolio([hold("AAA", 100), hold("BBB", 50)], [liq({ asset: "AAA", qty: 100, proceedsQu: 1500 }), liq({ asset: "BBB", qty: 50, proceedsQu: 400 })], ledger([pos("AAA")]));
  const b = rows[1];
  assert.equal(b.bought, "no");
  assert.equal(b.plQu, null);
  assert.equal(b.avgCost, null);
  assert.equal(b.firstBuyMs, null);
  assert.equal(b.proceedsQu, 400);
  assert.equal(totals.worthQu, 1900);
  assert.equal(totals.uncosted, 1);
  assert.equal(totals.plQu, 500); // only AAA is compared
});

test("some units bought and some not: profit is on the bought ones only", () => {
  const { rows } = buildPortfolio([hold("AAA", 100)], [liq({ asset: "AAA", qty: 100, proceedsQu: 2000 })], ledger([pos("AAA", { costedQty: 40, avgCost: 10 })]));
  const r = rows[0];
  assert.equal(r.bought, "partly");
  assert.equal(r.comparedQty, 40);
  assert.equal(r.costQu, 400);
  assert.equal(r.plQu, 40 * (20 - 10)); // sold at 20 a unit on average, bought at 10
});

test("the ledger's units cannot exceed what is held now", () => {
  const { rows } = buildPortfolio([hold("AAA", 30)], [liq({ asset: "AAA", qty: 30, proceedsQu: 300 })], ledger([pos("AAA", { costedQty: 100, avgCost: 5 })]));
  assert.equal(rows[0].costedQty, 30);
  assert.equal(rows[0].comparedQty, 30);
  assert.equal(rows[0].plQu, 150); // 10 a unit against 5
});

test("when the market cannot take it all, only the part it can take is compared", () => {
  const { rows, totals } = buildPortfolio([hold("AAA", 100)], [liq({ asset: "AAA", qty: 100, fillableQty: 40, proceedsQu: 800, complete: false, midValueQu: 3000 })], ledger([pos("AAA", { costedQty: 100, avgCost: 10 })]));
  const r = rows[0];
  assert.equal(r.complete, false);
  assert.equal(r.comparedQty, 40);
  assert.equal(r.plQu, 40 * (20 - 10));
  assert.equal(totals.incomplete, 1);
  assert.equal(totals.partial, 1);
  assert.equal(totals.noBuyers, 0);
  assert.equal(totals.worthQu, 800);
  // the haircut is on the 40 that could be sold: 40% of 3000 at mid is 1200, against 800
  assert.equal(totals.haircutQu, 400);
});

test("before the sale is priced there is no worth, and before the ledger arrives there is no cost: nothing is invented", () => {
  const a = buildPortfolio([hold("AAA", 100)], null, ledger([pos("AAA")]));
  assert.equal(a.rows[0].proceedsQu, null);
  assert.equal(a.rows[0].plQu, null);
  assert.equal(a.totals.priced, false);
  assert.equal(a.totals.worthQu, 0);
  const b = buildPortfolio([hold("AAA", 100)], [liq({ asset: "AAA", qty: 100, proceedsQu: 1500 })], null);
  assert.equal(b.rows[0].bought, "unknown");
  assert.equal(b.rows[0].plQu, null);
  assert.equal(b.rows[0].realizedQu, null);
  assert.equal(b.totals.worthQu, 1500);
  assert.equal(b.totals.plQu, null);
  assert.equal(b.totals.realizedQu, null);
  assert.equal(b.totals.uncosted, 0);
});

test("an asset that could not be priced is kept, with its reason, and adds nothing to the worth", () => {
  const { rows, totals } = buildPortfolio([hold("AAA", 10), hold("BBB", 10)], [liq({ asset: "AAA", qty: 10, proceedsQu: 100 }), liq({ asset: "BBB", qty: 10, fillableQty: 0, complete: false, error: "Unknown asset" })], ledger([]));
  assert.equal(rows[1].error, "Unknown asset");
  assert.equal(rows[1].proceedsQu, 0);
  assert.equal(totals.worthQu, 100);
  assert.equal(totals.incomplete, 1);
  assert.equal(totals.noBuyers, 1); // nothing sells: counted as no buyers
  assert.equal(totals.partial, 0);
});

test("realized profit comes from the ledger, per asset and in total", () => {
  const { rows, totals } = buildPortfolio([hold("AAA", 10)], [liq({ asset: "AAA", qty: 10, proceedsQu: 100 })], ledger([pos("AAA", { realizedQu: 250 })], [], 250));
  assert.equal(rows[0].realizedQu, 250);
  assert.equal(totals.realizedQu, 250);
});
