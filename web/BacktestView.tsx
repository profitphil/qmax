import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { equityChartSvg } from "../src/backtestchart.ts";
import type { EquityPalette } from "../src/backtestchart.ts";
import { BACKTEST_LIMITS, STRATEGY_DEFAULTS, STRATEGY_LABELS, STRATEGY_TYPES, resolveStrategy, validateStrategy } from "../src/backtest.ts";
import type { BacktestRange, BacktestVenueRequest, StrategyInput, StrategyType } from "../src/backtest.ts";
import { runBacktestRequest } from "./backtest-api.ts";
import type { BacktestResponse } from "./backtest-api.ts";
import { formatPrice } from "./AssetList.tsx";
import { useTheme } from "./theme.ts";
import { Icon } from "./ui.tsx";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
/** +1,234 or −1,234, so a gain and a loss are told apart by more than colour. */
const signed = (x: number, d = 0) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${n(Math.abs(x), d)}`;
const tone = (x: number) => (x > 0 ? "good" : x < 0 ? "bad" : "");
const stamp = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

const RANGES: { id: BacktestRange; label: string }[] = [
  { id: "30d", label: "30D" },
  { id: "90d", label: "90D" },
  { id: "all", label: "All" },
];
const VENUES: { id: BacktestVenueRequest; label: string }[] = [
  { id: "auto", label: "Automatic: the market QMax charts" },
  { id: "QX", label: "QX order book" },
  { id: "QSwap", label: "QSwap pool" },
  { id: "all", label: "QX and QSwap together" },
];
const BLURB: Record<StrategyType, string> = {
  hold: "Buys once with all the starting QU at the first opening price and holds. Every strategy is compared with this.",
  dca: "Spends a fixed amount of QU (fees included) at regular intervals, until the starting QU runs out.",
  bands: "Buys with part of its QU when an hour closes below the recent average price, and sells part of what it holds when one closes above it.",
};
/** What a setting is called on the page, for messages that came from the API's own names. */
const LABELS: Record<string, string> = {
  startingQu: "Starting QU",
  amountQu: "Amount",
  everyHours: "Interval",
  lookbackHours: "Average over",
  bandPct: "Band",
  fractionPct: "Trade size",
  cooldownHours: "Wait between trades",
};
const plain = (message: string) => message.replace(/^(?:strategy\.)?(\w+)/, (_, name: string) => LABELS[name] ?? name);

interface Form {
  type: StrategyType;
  startingQu: string;
  amountQu: string;
  everyHours: string;
  lookbackHours: string;
  bandPct: string;
  fractionPct: string;
  cooldownHours: string;
  range: BacktestRange;
  venue: BacktestVenueRequest;
}

const INITIAL: Form = {
  type: "dca",
  startingQu: n(STRATEGY_DEFAULTS.startingQu),
  amountQu: n(STRATEGY_DEFAULTS.dca.amountQu),
  everyHours: String(STRATEGY_DEFAULTS.dca.everyHours),
  lookbackHours: String(STRATEGY_DEFAULTS.bands.lookbackHours),
  bandPct: String(STRATEGY_DEFAULTS.bands.bandPct),
  fractionPct: String(STRATEGY_DEFAULTS.bands.fractionPct),
  cooldownHours: String(STRATEGY_DEFAULTS.bands.cooldownHours),
  range: "90d",
  venue: "auto",
};

const num = (text: string) => (text.trim() === "" ? Number.NaN : Number(text.replace(/,/g, "")));

/** The request the form describes, or the messages for what is wrong with it. The same checks the server makes. */
function readForm(f: Form): { startingQu: number; strategy: StrategyInput; errors: string[] } {
  const startingQu = num(f.startingQu);
  const errors: string[] = [];
  if (!(Number.isInteger(startingQu) && startingQu >= BACKTEST_LIMITS.minStartingQu && startingQu <= BACKTEST_LIMITS.maxStartingQu))
    errors.push(`Starting QU must be a whole number from ${n(BACKTEST_LIMITS.minStartingQu)} to ${n(BACKTEST_LIMITS.maxStartingQu)}.`);
  const strategy: StrategyInput =
    f.type === "hold"
      ? { type: "hold" }
      : f.type === "dca"
        ? { type: "dca", amountQu: num(f.amountQu), everyHours: num(f.everyHours) }
        : { type: "bands", lookbackHours: num(f.lookbackHours), bandPct: num(f.bandPct), fractionPct: num(f.fractionPct), cooldownHours: num(f.cooldownHours) };
  errors.push(...validateStrategy(resolveStrategy(strategy)).map(plain));
  return { startingQu, strategy, errors };
}

/** The chart is SVG text made elsewhere, so it gets the page's colours here and follows the light and dark themes. */
function useBacktestPalette(): Partial<EquityPalette> {
  const { theme } = useTheme();
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
      bg: "none",
      grid: v("--chart-grid", "#2a2f55"),
      text: v("--muted", "#9a9fc0"),
      strong: v("--fg", "#f2f3fb"),
      up: v("--buy", "#4ade80"),
      down: v("--sell", "#f87171"),
      accent: v("--accent", "#6ee7ff"),
      violet: v("--violet", "#a78bfa"),
      font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
    };
  }, [theme]);
}

/** The width an element has now and as it changes, so the chart can be drawn at the size it is shown at (text stays readable on a phone). */
function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.round(el.getBoundingClientRect().width) || 640);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}

type Phase = { s: "idle" } | { s: "running" } | { s: "error"; message: string } | { s: "result"; res: BacktestResponse };

/**
 * Test a simple strategy on an asset's real trade history before risking QU. A price-based strategy decides on the close of an hour and trades at
 * the next hour's opening price; the result lists what it ignores (no order book depth was kept) as plainly as what it found.
 */
export function BacktestView({ assetId, symbol }: { assetId: string; symbol: string }) {
  const [form, setForm] = useState<Form>(INITIAL);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const ctl = useRef<AbortController | null>(null);
  const id = useId();
  const palette = useBacktestPalette();
  const parsed = readForm(form);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  // another asset starts from a clean page, and nothing keeps running for one that is no longer shown
  useEffect(() => {
    setPhase({ s: "idle" });
    return () => ctl.current?.abort();
  }, [assetId]);

  function run(e: FormEvent) {
    e.preventDefault();
    if (parsed.errors.length || phase.s === "running") return;
    ctl.current?.abort();
    const c = (ctl.current = new AbortController());
    setPhase({ s: "running" });
    runBacktestRequest({ asset: assetId, range: form.range, venue: form.venue, startingQu: parsed.startingQu, strategy: parsed.strategy }, c.signal)
      .then((res) => !c.signal.aborted && setPhase({ s: "result", res }))
      .catch((err) => !c.signal.aborted && setPhase({ s: "error", message: err instanceof Error ? err.message : String(err) }));
  }

  const running = phase.s === "running";
  const rangeLabel = RANGES.find((r) => r.id === form.range)!.label;
  return (
    <div className="backtest">
      <form className="backtest-form" onSubmit={run} aria-label={`Backtest a strategy on ${symbol}`}>
        <div className="backtest-field">
          <label htmlFor={`${id}-type`}>Strategy</label>
          <select id={`${id}-type`} value={form.type} onChange={(e) => set("type", e.target.value as StrategyType)}>
            {STRATEGY_TYPES.map((t) => <option key={t} value={t}>{STRATEGY_LABELS[t]}</option>)}
          </select>
          <small>{BLURB[form.type]}</small>
        </div>

        <div className="backtest-fields">
          <Field id={`${id}-start`} label="Starting QU" value={form.startingQu} onChange={(v) => set("startingQu", v)} unit="QU" />
          {form.type === "dca" && (
            <>
              <Field id={`${id}-amount`} label="Amount each time" value={form.amountQu} onChange={(v) => set("amountQu", v)} unit="QU, fees included" />
              <Field id={`${id}-every`} label="Every" value={form.everyHours} onChange={(v) => set("everyHours", v)} unit="hours" quick={[["Daily", "24"], ["Weekly", "168"], ["2 weeks", "336"]]} />
            </>
          )}
          {form.type === "bands" && (
            <>
              <Field id={`${id}-look`} label="Average over" value={form.lookbackHours} onChange={(v) => set("lookbackHours", v)} unit="hours of closing prices" quick={[["1 day", "24"], ["3 days", "72"], ["1 week", "168"]]} />
              <Field id={`${id}-band`} label="Band" value={form.bandPct} onChange={(v) => set("bandPct", v)} unit="% away from the average" />
              <Field id={`${id}-frac`} label="Trade size" value={form.fractionPct} onChange={(v) => set("fractionPct", v)} unit="% of the QU or holding" />
              <Field id={`${id}-cool`} label="Wait between trades" value={form.cooldownHours} onChange={(v) => set("cooldownHours", v)} unit="hours" />
            </>
          )}
        </div>

        <div className="backtest-options">
          <div className="chips" role="group" aria-label="How far back to test">
            {RANGES.map((r) => (
              <button type="button" key={r.id} className={form.range === r.id ? "chip on" : "chip"} aria-pressed={form.range === r.id} onClick={() => set("range", r.id)}>{r.label}</button>
            ))}
          </div>
          <div className="backtest-venue">
            <label htmlFor={`${id}-venue`} className="muted">Market</label>
            <select id={`${id}-venue`} value={form.venue} onChange={(e) => set("venue", e.target.value as BacktestVenueRequest)}>
              {VENUES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>
        </div>

        {parsed.errors.length > 0 && <ul className="backtest-errors err" role="alert">{parsed.errors.map((m) => <li key={m}>{m}</li>)}</ul>}
        <div className="backtest-actions">
          <button type="submit" className="primary" disabled={running || parsed.errors.length > 0}>
            {running ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Running</> : <><Icon name="bolt" size={16} /> Run backtest</>}
          </button>
          <p className="note backtest-rule">Decides on the closing price of an hour and trades at the next hour's opening price. Hours with no trades have no price, so nothing is traded in them.</p>
        </div>
      </form>

      {phase.s === "idle" && <p className="note backtest-hint">Pick a strategy and run it on {symbol}'s real trades from QX and QSwap. What it shows is what would have happened, not what will.</p>}
      {running && (
        <div className="backtest-running" role="status" aria-live="polite">
          <div className="skeleton block" />
          <p className="status-line"><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Replaying {form.range === "all" ? "all the recorded trades" : `the last ${rangeLabel.replace("D", " days")}`} of {symbol} hour by hour…</p>
        </div>
      )}
      {phase.s === "error" && (
        <div className="banner err" role="alert">
          <Icon name="alert" size={18} />
          <span>{phase.message}</span>
        </div>
      )}
      {phase.s === "result" && <Result res={phase.res} symbol={symbol} palette={palette} />}
    </div>
  );
}

function Field(p: { id: string; label: string; value: string; onChange: (v: string) => void; unit: string; quick?: [string, string][] }) {
  return (
    <div className="backtest-field">
      <label htmlFor={p.id}>{p.label}</label>
      <input id={p.id} type="text" inputMode="decimal" autoComplete="off" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
      <small>{p.unit}</small>
      {p.quick && (
        <div className="chips backtest-quick">
          {p.quick.map(([label, v]) => <button type="button" key={label} className={p.value === v ? "chip on" : "chip"} onClick={() => p.onChange(v)}>{label}</button>)}
        </div>
      )}
    </div>
  );
}

const SHOWN_TRADES = 300;

function Result({ res, symbol, palette }: { res: BacktestResponse; symbol: string; palette: Partial<EquityPalette> }) {
  const m = res.metrics;
  const rangeLabel = res.range === "all" ? "all" : res.range.toUpperCase();
  const [box, boxWidth] = useWidth<HTMLDivElement>();
  const width = Math.max(280, Math.min(760, boxWidth));
  const svg = useMemo(
    () => equityChartSvg(res.equity, { symbol, rangeLabel, trades: res.trades, palette, width, height: width < 480 ? Math.round(width * 0.78) : 300 }),
    [res, symbol, rangeLabel, palette, width],
  );
  const feeHeavy = m.totalFeesPctOfStart >= 1;
  return (
    <div className="backtest-result">
      <p className="backtest-summary">{res.summary}</p>
      <div className="backtest-chart" ref={box} dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="note first">Value is the QU in hand plus the units held at each hour's closing price. It only changes in hours with trades.{res.venue === "all" ? " Prices from QX and QSwap are joined into one series." : ` Prices from ${res.venue === "QX" ? "QX trades" : "QSwap swaps"}.`}</p>

      <div className="backtest-stats">
        <Tile label="Final value" value={`${n(m.finalValueQu)} QU`} hint={`${signed(m.returnPct, 2)}% on ${n(m.startingValueQu)} QU`} tone={tone(m.returnPct)} />
        <Tile label="Just holding" value={`${n(m.holdFinalValueQu)} QU`} hint={`${signed(m.holdReturnPct, 2)}%`} tone={tone(m.holdReturnPct)} />
        <Tile label="Against holding" value={`${signed(m.differenceQu)} QU`} hint={`${signed(m.differencePct, 2)} percentage points`} tone={tone(m.differenceQu)} />
        <Tile label="Worst drop" value={`${n(m.maxDrawdownPct, 2)}%`} hint={`holding: ${n(m.holdMaxDrawdownPct, 2)}%`} />
        <Tile label="Trades" value={n(m.tradeCount)} hint={`${n(m.buyCount)} ${m.buyCount === 1 ? "buy" : "buys"}, ${n(m.sellCount)} ${m.sellCount === 1 ? "sell" : "sells"}`} />
        <Tile label="Fees paid" value={`${n(m.totalFeesQu)} QU`} hint={`${n(m.totalFeesPctOfStart, 2)}% of the start`} warn={feeHeavy} />
        <Tile label="Average cost" value={m.averageCostQu === null ? "n/a" : `${formatPrice(m.averageCostQu)} QU`} hint={m.averageCostWithFeesQu === null ? "nothing bought" : `${formatPrice(m.averageCostWithFeesQu)} QU with fees`} />
        <Tile label="Held at the end" value={`${n(m.finalHoldingQty)} ${symbol}`} hint={`${n(m.finalCashQu)} QU in hand`} />
      </div>

      <section className="backtest-warnings" aria-label="What this result leaves out">
        <h4><Icon name="alert" size={16} /> Read this before trusting the result</h4>
        <ul>{res.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      </section>

      <details className="backtest-trades">
        <summary><span>Trades ({n(res.trades.length)})</span><Icon name="chevron" size={16} /></summary>
        {res.trades.length === 0 ? (
          <p className="note">No trades were made.</p>
        ) : (
          <div className="backtest-table" role="table" aria-label="Trades, times in UTC">
            <div className="backtest-trade backtest-trade-head" role="row"><span>Time (UTC)</span><span /><span>Units</span><span>Price</span><span>QU</span><span>Fee</span></div>
            {res.trades.slice(0, SHOWN_TRADES).map((t) => (
              <div className="backtest-trade" role="row" key={`${t.t}-${t.side}`}>
                <span className="num">{stamp(t.t)}</span>
                <span className={t.side === "buy" ? "backtest-buy" : "backtest-sell"}>{t.side === "buy" ? "Buy" : "Sell"}</span>
                <span className="num">{n(t.qty)}</span>
                <span className="num">{formatPrice(t.price)}</span>
                <span className="num">{n(t.quSpent ?? t.quReceived ?? 0)}</span>
                <span className="num">{n(t.feeQu)}</span>
              </div>
            ))}
            {res.trades.length > SHOWN_TRADES && <p className="note">Showing the first {n(SHOWN_TRADES)} of {n(res.trades.length)} trades.</p>}
          </div>
        )}
      </details>
    </div>
  );
}

function Tile({ label, value, hint, tone: t = "", warn = false }: { label: string; value: string; hint: string; tone?: string; warn?: boolean }) {
  return (
    <div className={warn ? "stat warn" : "stat"}>
      <span className="stat-label">{label}</span>
      <span className={`stat-value num ${t}`}>{value}</span>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}
