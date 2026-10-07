// Runs the backtest engine on REAL trade history and checks its numbers by hand. Writes nothing and calls no network:
// it copies the trade index file first (so the live one is never touched) and reads the copy.
//   node --experimental-strip-types --no-warnings scripts/backtest-check.ts                  QDOGE, GARTH, QCAP and QMINE over the last 90 days
//   node --experimental-strip-types --no-warnings scripts/backtest-check.ts QCAP CFB          other assets (they must be in .cache/catalog.json)
// Environment: TRADES_FILE (default .cache/trades.json), START_QU (default 10,000,000).
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityKey } from "../src/activity.ts";
import { runBacktest } from "../src/backtest.ts";
import type { BacktestResult, StrategyInput } from "../src/backtest.ts";
import { TradeIndex } from "../src/trades.ts";
import type { TradeCandle } from "../src/trades.ts";

const HOUR = 3_600_000;
const root = new URL("../", import.meta.url).pathname;
const startQu = Number(process.env.START_QU ?? 10_000_000);
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ["QDOGE", "GARTH", "QCAP", "QMINE"];

const dir = mkdtempSync(join(tmpdir(), "qmax-backtest-"));
const file = join(dir, "trades.json");
copyFileSync(process.env.TRADES_FILE ?? root + ".cache/trades.json", file);
// the index is never asked to update(), so it never reads the network and never writes (and it would only write to the copy)
const index = new TradeIndex({} as never, { file });
const catalog: { symbol: string; issuer: string; venues: string[] }[] = JSON.parse(readFileSync(root + ".cache/catalog.json", "utf8"));

let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${what}`);
};
const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const close = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

/* ---- a second, independent implementation: walks the candles (not an hour grid) and writes the fee rules out by hand ---- */

const qxFee = (side: "buy" | "sell", v: number) => 100 + (side === "sell" ? Math.floor((v * 3) / 1000) + 1 : 0); // Qx.h: 0.3% from the seller, rounded up, plus the 100 QU management fee
const qswapFee = () => 100_100; // 100,000 QSWAP_ADDITIONAL_FEE + 100 management fee; the 0.3% pool fee is already inside swap prices
const feeOf = (venue: "QX" | "QSwap" | "all", side: "buy" | "sell", v: number) => (venue === "QX" ? qxFee(side, v) : venue === "QSwap" ? qswapFee() : Math.min(qxFee(side, v), qswapFee()));

interface Fill { t: number; side: "buy" | "sell"; qty: number; price: number }

function referenceDca(candles: TradeCandle[], from: number, hours: number, start: number, amount: number, every: number, venue: "QX" | "QSwap" | "all"): { fills: Fill[]; cash: number } {
  let cash = start;
  const fills: Fill[] = [];
  const end = from + hours * HOUR;
  for (let k = 0; from + k * every * HOUR < end; k++) {
    const due = from + k * every * HOUR;
    const next = from + (k + 1) * every * HOUR;
    const c = candles.find((x) => x.t >= due && x.t < Math.min(next, end)); // the first hour with trades before the next purchase falls due
    if (!c) continue;
    const budget = Math.min(amount, cash);
    let q = Math.floor((budget - feeOf(venue, "buy", 0)) / c.o);
    while (q > 0 && Math.ceil(q * c.o) + feeOf(venue, "buy", Math.ceil(q * c.o)) > budget) q--;
    if (q <= 0) continue;
    cash -= Math.ceil(q * c.o) + feeOf(venue, "buy", Math.ceil(q * c.o));
    fills.push({ t: c.t, side: "buy", qty: q, price: c.o });
  }
  return { fills, cash };
}

function referenceBands(all: TradeCandle[], from: number, hours: number, start: number, p: { lookbackHours: number; bandPct: number; fractionPct: number; cooldownHours: number }, venue: "QX" | "QSwap" | "all"): { fills: Fill[]; cash: number; qty: number } {
  const end = from + hours * HOUR;
  let cash = start;
  let qty = 0;
  let order: { side: "buy" | "sell"; budget: number; qty: number } | null = null;
  let lastTrade = -Infinity;
  const fills: Fill[] = [];
  for (let j = 0; j < all.length; j++) {
    const c = all[j];
    if (c.t < from || c.t >= end) continue;
    if (order) {
      const o = order;
      order = null;
      if (o.side === "buy") {
        let q = Math.floor((o.budget - feeOf(venue, "buy", 0)) / c.o);
        while (q > 0 && Math.ceil(q * c.o) + feeOf(venue, "buy", Math.ceil(q * c.o)) > o.budget) q--;
        if (q > 0) {
          cash -= Math.ceil(q * c.o) + feeOf(venue, "buy", Math.ceil(q * c.o));
          qty += q;
          lastTrade = c.t;
          fills.push({ t: c.t, side: "buy", qty: q, price: c.o });
        }
      } else {
        const q = Math.min(o.qty, qty);
        const gross = Math.floor(q * c.o);
        if (q > 0 && gross - feeOf(venue, "sell", gross) > 0) {
          cash += gross - feeOf(venue, "sell", gross);
          qty -= q;
          lastTrade = c.t;
          fills.push({ t: c.t, side: "sell", qty: q, price: c.o });
        }
      }
    }
    if ((c.t - lastTrade) / HOUR < p.cooldownHours) continue;
    const win = all.filter((x) => x.t <= c.t && x.t > c.t - p.lookbackHours * HOUR);
    if (win.length < 3) continue;
    const avg = win.reduce((s, x) => s + x.c, 0) / win.length;
    const dev = (c.c / avg - 1) * 100;
    if (dev <= -p.bandPct + 1e-9 && cash > 0) order = { side: "buy", budget: Math.floor((cash * p.fractionPct) / 100), qty: 0 };
    else if (dev >= p.bandPct - 1e-9 && qty > 0) order = { side: "sell", budget: 0, qty: Math.max(1, Math.floor((qty * p.fractionPct) / 100)) };
  }
  return { fills, cash, qty };
}

/* ---- the checks ---- */

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function report(label: string, r: BacktestResult) {
  const m = r.metrics;
  console.log(
    `  ${label.padEnd(18)} final ${n(m.finalValueQu).padStart(12)} QU (${(m.returnPct >= 0 ? "+" : "") + m.returnPct.toFixed(2)}%)  hold ${(m.holdReturnPct >= 0 ? "+" : "") + m.holdReturnPct.toFixed(2)}%  trades ${String(m.tradeCount).padStart(3)}  fees ${n(m.totalFeesQu).padStart(9)} QU (${m.totalFeesPctOfStart.toFixed(2)}%)  avg cost ${m.averageCostQu === null ? "n/a" : n(m.averageCostQu, 4)}  drawdown ${m.maxDrawdownPct.toFixed(1)}%`,
  );
}

for (const symbol of wanted) {
  const entry = catalog.find((e) => e.symbol.toUpperCase() === symbol.toUpperCase());
  if (!entry) {
    console.log(`\n${symbol}: not in the catalog, skipped`);
    continue;
  }
  const key = activityKey(entry.symbol, entry.issuer);
  // the same choice the server makes for "auto": the pool's swaps if the asset has a pool and it traded, else QX
  const venue = index.venueFor(key, entry.venues.includes("QSwap") ? "QSwap" : "QX");
  const everything = index.candles(key, venue, HOUR, 0);
  if (!everything.length) {
    console.log(`\n${symbol}: no trades on ${venue}, skipped`);
    continue;
  }
  const endMs = everything[everything.length - 1].t + HOUR;
  const startMs = endMs - 90 * 24 * HOUR;
  const candles = index.candles(key, venue, HOUR, startMs - 168 * HOUR); // a week before the start, so the averages are warm
  const inWindow = candles.filter((c) => c.t >= startMs);
  console.log(`\n${symbol} on ${venue}: ${inWindow.length} of ${(endMs - startMs) / HOUR} hours had trades, ${day(startMs)} to ${day(endMs)}; first open ${n(inWindow[0].o, 4)}, last close ${n(inWindow[inWindow.length - 1].c, 4)} QU; start ${n(startQu)} QU`);
  const fees = { venue } as const;
  const base = { candles, startingQu: startQu, fees, startMs, endMs };

  // 1. hold: all QU in at the first opening price, valued at the last close
  const hold = runBacktest({ ...base, strategy: { type: "hold" } });
  report("hold", hold);
  const p0 = inWindow[0].o;
  const pN = inWindow[inWindow.length - 1].c;
  const fee0 = feeOf(venue, "buy", 0);
  const units = Math.floor((startQu - fee0) / p0);
  const exact = startQu - Math.ceil(units * p0) - fee0 + units * pN;
  const continuous = ((startQu - fee0) / p0) * pN; // the same without whole units
  check(hold.trades.length === 1 && hold.trades[0].qty === units && hold.trades[0].price === p0, `bought ${n(units)} units at the first open ${n(p0, 4)} (floor((${n(startQu)} - ${n(fee0)}) / ${n(p0, 4)}))`);
  check(close(hold.metrics.finalValueQu, exact), `final ${n(hold.metrics.finalValueQu, 2)} = QU left + ${n(units)} x last close ${n(pN, 4)} = ${n(exact, 2)}`);
  check(Math.abs(hold.metrics.finalValueQu - continuous) <= pN + 1, `within one unit (${n(pN, 2)} QU) of start/open x close less the fee: ${n(continuous, 2)}`);
  check(hold.metrics.differenceQu === 0, "hold equals its own buy-and-hold comparison");

  // 2. a weekly DCA
  const dcaSettings = { amountQu: 500_000, everyHours: 168 };
  const dca = runBacktest({ ...base, strategy: { type: "dca", ...dcaSettings } });
  report("weekly dca 500k", dca);
  const spent = dca.trades.reduce((s, t) => s + t.quSpent!, 0);
  const bought = dca.trades.reduce((s, t) => s + t.qty, 0);
  const paid = dca.trades.reduce((s, t) => s + t.feeQu, 0);
  const refDca = referenceDca(candles, dca.window.fromMs, dca.window.hours, startQu, dcaSettings.amountQu, dcaSettings.everyHours, venue);
  check(dca.metrics.averageCostQu !== null && dca.metrics.averageCostQu === spent / bought, `average cost ${n(dca.metrics.averageCostQu ?? 0, 4)} = total spent ${n(spent)} QU / total units ${n(bought)}`);
  check(dca.metrics.averageCostWithFeesQu === (spent + paid) / bought, `with the ${n(paid)} QU of fees on the buys: ${n(dca.metrics.averageCostWithFeesQu ?? 0, 4)}`);
  check(JSON.stringify(dca.trades.map((t) => [t.t, t.qty, t.price])) === JSON.stringify(refDca.fills.map((f) => [f.t, f.qty, f.price])), `all ${dca.trades.length} purchases match an independent walk over the candles`);
  check(dca.metrics.finalCashQu === refDca.cash && dca.metrics.finalHoldingQty === bought, `QU in hand ${n(dca.metrics.finalCashQu)} = ${n(startQu)} - spent - fees`);

  // 3. bands
  const bandSettings = { lookbackHours: 168, bandPct: 5, fractionPct: 25, cooldownHours: 24 };
  const bands = runBacktest({ ...base, strategy: { type: "bands", ...bandSettings } });
  report("bands 7d 5% 25%", bands);
  const refBands = referenceBands(candles, bands.window.fromMs, bands.window.hours, startQu, bandSettings, venue);
  check(JSON.stringify(bands.trades.map((t) => [t.t, t.side, t.qty, t.price])) === JSON.stringify(refBands.fills.map((f) => [f.t, f.side, f.qty, f.price])), `all ${bands.trades.length} trades match an independent walk over the candles`);
  check(bands.metrics.finalCashQu === refBands.cash && bands.metrics.finalHoldingQty === refBands.qty, `QU in hand ${n(bands.metrics.finalCashQu)} and ${n(bands.metrics.finalHoldingQty)} units match`);
  let cash = startQu;
  let qty = 0;
  let worst = 0;
  for (const t of bands.trades) {
    const before = cash + qty * t.price;
    cash += t.netQu;
    qty += t.side === "buy" ? t.qty : -t.qty;
    worst = Math.max(worst, Math.abs(cash + qty * t.price - before + t.feeQu));
  }
  check(worst < 1 && cash >= 0 && qty >= 0, `no QU created or destroyed: every trade moved value by its fee and under 1 QU of rounding (worst ${worst.toFixed(3)})`);
  check(bands.trades.every((t) => t.t >= bands.window.fromMs), "no trade before the start");

  // 4. the other fee models on the same data, to show how much the venue's fees matter
  for (const v of ["QX", "QSwap", "all"] as const) {
    if (v === venue) continue;
    const alt = runBacktest({ ...base, fees: { venue: v }, strategy: { type: "dca", ...dcaSettings } });
    console.log(`  (same weekly dca charged as ${v}: fees ${n(alt.metrics.totalFeesQu)} QU, ${(alt.metrics.returnPct >= 0 ? "+" : "") + alt.metrics.returnPct.toFixed(2)}%)`);
  }
  console.log(`  one-off prices in the window: ${hold.odd.hours} of ${hold.window.candleHours} hours with trades${hold.odd.lastPriceIsOdd ? "; the last close is one" : ""}${hold.odd.holdBuyIsOdd ? "; the hold bought at one" : ""}; used by ${dca.odd.trades} of ${dca.trades.length} dca purchases and ${bands.odd.trades} of ${bands.trades.length} bands trades`);
  console.log(`  warnings on the hold run: ${hold.warnings.length}; the first: ${hold.warnings[0].slice(0, 110)}…`);

  // 5. the whole recorded history, buy and hold only
  const all = runBacktest({ candles: everything, startingQu: startQu, strategy: { type: "hold" }, fees, endMs });
  console.log(`  everything on record (${day(all.window.fromMs)} to ${day(all.window.toMs)}): hold ${(all.metrics.returnPct >= 0 ? "+" : "") + all.metrics.returnPct.toFixed(2)}% over ${n(all.window.hours)} hours, ${n(all.window.candleHours)} with trades`);
}

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
