import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fetchCandles, fetchHistory } from "./client.ts";
import type { CandlesResponse, HistoryResponse } from "./client.ts";
import { DEFAULT_STYLE, resolveStyle, sanitizeStyle } from "../src/chartstyle.ts";
import type { ChartStyle } from "../src/chartstyle.ts";
import { ChartSettings } from "./ChartSettings.tsx";
import { loadStyle, saveStyle } from "./chartstyle-store.ts";
import { readColors } from "./chart/build.ts";
import { useTheme } from "./theme.ts";
import { LwChart, indicatorColor } from "./LwChart.tsx";
import type { ChartApi, ChartType, ScaleMode, Tool } from "./LwChart.tsx";
import { PALETTE, loadDrawings, saveDrawings } from "../src/drawings.ts";
import type { Drawing } from "../src/drawings.ts";
import { INDICATORS, isIndicatorId } from "../src/indicators.ts";
import type { TradeCandle } from "../src/trades.ts";
import { fillQuietCandles } from "../src/lwdata.ts";
import { Icon } from "./ui.tsx";
import { useMaxMode } from "./maxmode.tsx";
import { uiZoom } from "./media.ts";
import { entitled, isFreeIndicator, isFreeInterval, isFreeScale, isFreeShot, isFreeTool, isFreeType } from "../src/chartaccess.ts";
import type { IndicatorId } from "../src/indicators.ts";

/**
 * The price chart's panel: what is drawn (style, candle width, which market), how far back, the indicators, the drawing tools, and the buttons
 * around them. The chart itself is LwChart; this keeps the choices (and the drawings, per asset, in this browser) and fetches the data.
 */

const RANGES = [
  ["1d", "1D"],
  ["7d", "7D"],
  ["30d", "30D"],
  ["90d", "90D"],
  ["all", "All"],
] as const;
type RangeId = (typeof RANGES)[number][0];

const INTERVAL_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 4 * 3_600_000, "1d": 24 * 3_600_000 } as const;
const INTERVAL_NAME = { "1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "30m": "30 minutes", "1h": "1 hour", "4h": "4 hours", "1d": "1 day" } as const;
/** The candle width "Auto" picks for each range: a few hundred candles, so a short range has the detail and a long one stays readable. */
const AUTO_WIDTH: Record<RangeId, keyof typeof INTERVAL_MS> = { "1d": "5m", "7d": "15m", "30d": "1h", "90d": "4h", all: "1d" };
const TYPES: { id: ChartType; label: string }[] = [
  { id: "candles", label: "Candles" },
  { id: "heikin", label: "Heikin-Ashi" },
  { id: "bars", label: "Bars" },
  { id: "area", label: "Area" },
  { id: "line", label: "Line" },
];
const INTERVALS = [
  ["auto", "Auto"],
  ["1m", "1 minute"],
  ["5m", "5 minutes"],
  ["15m", "15 minutes"],
  ["30m", "30 minutes"],
  ["1h", "1 hour"],
  ["4h", "4 hours"],
  ["1d", "1 day"],
] as const;

/** Picture sizes for saving. The width is in real pixels (not page pixels), so 8K is 7,680 across whatever the screen. */
const SHOT_SIZES = [
  { id: "screen", label: "Screen", note: "as it is on your screen, sharp", width: 0 },
  { id: "hd", label: "Full HD", note: "1,920 px wide", width: 1920 },
  { id: "4k", label: "4K", note: "3,840 px wide", width: 3840 },
  { id: "8k", label: "8K", note: "7,680 px wide (a big file)", width: 7680 },
] as const;

/** The indicators that get a button of their own on the chart to begin with; the person chooses (pins) which ones, and the rest are in the "More indicators" menu. */
const QUICK: IndicatorId[] = ["sma20", "ema21", "bb", "vwap", "rsi", "macd"];

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const date = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ---- what a person chose, remembered in this browser (a convenience: a blocked store changes nothing) ----------------------------

interface Prefs {
  type: ChartType;
  interval: (typeof INTERVALS)[number][0];
  indicators: IndicatorId[];
  /** Which indicators have a button in the bar. */
  pinned: IndicatorId[];
  volume: boolean;
  /** Mark where each Qubic epoch begins. */
  epochs: boolean;
  /** Carry the last price through hours with no trades. */
  fill: boolean;
  scale: ScaleMode;
  color: string;
}
const PREFS_KEY = "qmax.chart.prefs.v2";
const DEFAULTS: Prefs = { type: "candles", interval: "auto", indicators: ["sma20"], pinned: QUICK, volume: true, epochs: true, fill: false, scale: "normal", color: PALETTE[0].hex };

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
function loadPrefs(): Prefs {
  try {
    const r = JSON.parse(storage()?.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    if (!r || typeof r !== "object") return DEFAULTS;
    return {
      type: TYPES.some((t) => t.id === r.type) ? r.type! : DEFAULTS.type,
      interval: INTERVALS.some((i) => i[0] === r.interval) ? r.interval! : DEFAULTS.interval,
      indicators: Array.isArray(r.indicators) ? r.indicators.filter(isIndicatorId) : DEFAULTS.indicators,
      pinned: Array.isArray(r.pinned) ? INDICATORS.map((i) => i.id).filter((id) => (r.pinned as unknown[]).includes(id)) : DEFAULTS.pinned,
      volume: typeof r.volume === "boolean" ? r.volume : true,
      epochs: typeof r.epochs === "boolean" ? r.epochs : true,
      fill: typeof r.fill === "boolean" ? r.fill : false,
      scale: r.scale === "log" || r.scale === "percent" ? r.scale : "normal",
      color: PALETTE.some((p) => p.hex === r.color) ? r.color! : DEFAULTS.color,
    };
  } catch {
    return DEFAULTS;
  }
}
function savePrefs(p: Prefs) {
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // not remembered
  }
}

// ---- the drawing tools' icons -------------------------------------------------------------------------------------------------------

const svg = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const TOOLS: { id: Tool; label: string; hint: string; icon: ReactNode }[] = [
  { id: "cursor", label: "Cursor", hint: "Move around the chart; click a drawing to select it, drag it to move it, drag its dots to change it", icon: svg(<path d="M5 3l14 8-6 2-2 6z" />) },
  { id: "trend", label: "Trend line", hint: "Trend line: click its start, then its end", icon: svg(<><path d="M5 19L19 5" /><circle cx="5" cy="19" r="1.6" /><circle cx="19" cy="5" r="1.6" /></>) },
  { id: "ray", label: "Ray", hint: "Ray: a line from the first point, through the second, and on", icon: svg(<><path d="M5 19L21 4" /><circle cx="5" cy="19" r="1.6" /><path d="M16 4h5v5" /></>) },
  { id: "hline", label: "Horizontal line", hint: "Horizontal line at a price: one click", icon: svg(<><path d="M3 12h18" /><circle cx="12" cy="12" r="1.6" /></>) },
  { id: "vline", label: "Vertical line", hint: "Vertical line at a time: one click", icon: svg(<><path d="M12 3v18" /><circle cx="12" cy="12" r="1.6" /></>) },
  { id: "rect", label: "Rectangle", hint: "Rectangle: click two opposite corners", icon: svg(<rect x="4" y="6" width="16" height="12" rx="1" />) },
  { id: "fib", label: "Fibonacci retracement", hint: "Fibonacci retracement: click where a move began, then where it ended", icon: svg(<path d="M3 5h18M3 10h18M3 15h18M3 20h18" strokeDasharray="3 2" />) },
  { id: "measure", label: "Measure", hint: "Measure: click two points to read the change in price, percent, candles and time (it is not kept)", icon: svg(<><path d="M3 17L17 3l4 4L7 21z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" /></>) },
];

const ICON = {
  fit: svg(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />),
  latest: svg(<path d="M6 5l7 7-7 7M13 5l7 7-7 7" />),
  camera: svg(<><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>),
  settings: svg(<><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>),
  full: svg(<path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5" />),
  trash: svg(<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />),
};

// ---- the panel -----------------------------------------------------------------------------------------------------------------------

/** Lets the chart ask the dialog around it to give up the order ticket's space. */
export interface ChartFocus {
  on: boolean;
  toggle: () => void;
}

/** A price that is not an asset's trades on QX and QSwap (QU itself in dollars): where its candles come from, and what to say about them. */
export interface ChartSource {
  /** Candles for a range at a width ("1m" to "1d"). */
  candles: (range: string, interval: string, signal: AbortSignal) => Promise<CandlesResponse>;
  /** What a price is in, in the legend of the line. */
  priceUnit: string;
  /** The legend's line about a candle's volume. */
  volumeLine: (c: TradeCandle) => string;
  /** The text under the chart, once the candles are in (and what to say about the line). */
  note: (c: CandlesResponse | null, range: string) => ReactNode;
}

/**
 * `fit` (the default) makes the chart as tall as the room left in the box it sits in. That only works when the box has a height of its own (a dialog, the
 * workspace's desk). In a box that grows with its content (the Qubic chart on the page of a tablet, say) it must be off: the chart would measure a box made
 * of itself and its notes, grow into the difference, and go on growing without end. Then the chart keeps the height the stylesheet gives it.
 */
export function ChartView({ assetId, symbol, focus, source, venues, fit = true }: { assetId: string; symbol: string; focus?: ChartFocus; source?: ChartSource; venues?: ("QX" | "QSwap")[]; fit?: boolean }) {
  const [saved, setPrefs] = useState<Prefs>(loadPrefs);
  // Which market's trades the candles are made from: QX to start with (QSwap for an asset that trades only there), then whichever button was pressed. Not remembered
  // from one asset to the next, since an asset may not even trade on the other market. (Qubic's own chart has no markets: it draws from its own source.)
  const [venue, setVenue] = useState<"auto" | "QX" | "QSwap">(() => (source || !venues || venues.includes("QX") ? (source ? "auto" : "QX") : "QSwap"));
  const patch = (p: Partial<Prefs>) => setPrefs((now) => ({ ...now, ...p }));
  // Most of the chart's choices are part of Max (src/chartaccess.ts): with it off, what was chosen is kept but the basic version is what is drawn.
  // A locked choice switches Max on when it is picked (which asks for a pass instead, once the trial is over and a price is set).
  const max = useMaxMode();
  const pro = max.active;
  const prefs = useMemo(() => entitled(saved, pro), [saved, pro]);
  const unlock = (action: () => void) => {
    if (pro) return action();
    max.setOn(true);
    if (max.access.allowed) action();
  };
  // The chart settings: what was chosen, and what the chart is drawn with (shown in the panel's colour pickers when nothing was chosen).
  const [savedStyle, setStyle] = useState<ChartStyle>(loadStyle);
  const style = pro ? savedStyle : DEFAULT_STYLE;
  const patchStyle = (p: Partial<ChartStyle>) =>
    setStyle((now) => {
      const next = sanitizeStyle({ ...now, ...p });
      saveStyle(next);
      return next;
    });
  const resetStyle = () => {
    saveStyle(DEFAULT_STYLE);
    setStyle(DEFAULT_STYLE);
  };
  const { theme: pageTheme } = useTheme();
  const resolvedStyle = useMemo(() => resolveStyle(readColors(), style), [style, pageTheme]);
  useEffect(() => savePrefs(saved), [saved]);

  const [range, setRange] = useState<RangeId>("30d");
  const pickedRange = useRef(false);
  const [widened, setWidened] = useState<{ from: RangeId; count: number } | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [candles, setCandles] = useState<CandlesResponse | null>(null);
  const [error, setError] = useState("");
  const [tool, setTool] = useState<Tool>("cursor");
  const [selected, setSelected] = useState<string | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>(() => loadDrawings(storage(), assetId));
  const [menu, setMenu] = useState<null | "ind" | "color" | "shot" | "style">(null);
  const [fs, setFs] = useState(false);
  // On a phone the tools sit behind a button, so the chart is the first thing on screen.
  const [toolsOpen, setToolsOpen] = useState(false);
  const api = useRef<ChartApi | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // A different asset: its own drawings, and the range is the default again.
  useEffect(() => {
    setDrawings(loadDrawings(storage(), assetId));
    setSelected(null);
    setTool("cursor");
    pickedRange.current = false;
    setWidened(null);
    setRange("30d");
    setCandles(null);
    setHistory(null);
  }, [assetId]);
  const changeDrawings = (list: Drawing[]) => {
    setDrawings(list);
    saveDrawings(storage(), assetId, list);
  };

  // The data. It is read again every minute while the panel is open and the page is visible, and a fresh answer replaces the old one in place.
  const line = prefs.type === "line";
  useEffect(() => {
    setError("");
    const ctl = new AbortController();
    const load = (quiet: boolean) => {
      if (!quiet) (line ? setHistory(null) : setCandles(null));
      const width = prefs.interval === "auto" ? AUTO_WIDTH[range] : prefs.interval;
      const job = source && line
        ? source.candles(range, width, ctl.signal).then((c) => setHistory({ asset: assetId, range, since: c.candles[0]?.t ?? null, recordedSince: c.candles[0]?.t ?? null, points: c.candles.map((k) => ({ t: k.t, price: k.c, bid: null, ask: null, pool: null, liq: 0 })) }))
        : line
        ? fetchHistory(assetId, range, ctl.signal).then((h) => setHistory((old) => (old && JSON.stringify(old.points.at(-1)) === JSON.stringify(h.points.at(-1)) && old.points.length === h.points.length ? old : h)))
        : (source ? source.candles(range, width, ctl.signal) : fetchCandles(assetId, range, ctl.signal, { interval: width, venue })).then((c) =>
            setCandles((old) => (old && old.interval === c.interval && old.venue === c.venue && old.candles.length === c.candles.length && JSON.stringify(old.candles.at(-1)) === JSON.stringify(c.candles.at(-1)) ? old : c)),
          );
      job.catch((e) => e.name !== "AbortError" && !quiet && setError(e.message));
    };
    load(false);
    const timer = setInterval(() => document.visibilityState === "visible" && load(true), 60_000);
    return () => {
      ctl.abort();
      clearInterval(timer);
    };
  }, [assetId, range, line, prefs.interval, venue, source]);

  // A short range of a quiet market has too few candles to read: unless the person chose the range, go one step wider (and say so).
  useEffect(() => {
    if (line || !candles || pickedRange.current || range === "all" || candles.candles.length >= 12) return;
    const next = RANGES[RANGES.findIndex((r) => r[0] === range) + 1][0];
    setWidened((w) => w ?? { from: range, count: candles.candles.length });
    setRange(next);
  }, [candles, line, range]);

  useEffect(() => {
    const on = () => setFs(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  // Close the indicator menu on a click elsewhere, or Esc.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => !(e.target as HTMLElement | null)?.closest?.(".ind-menu, .ind-open, .color-open, .shot-open, .style-open") && setMenu(null);
    // Esc closes the menu and nothing else: caught before the dialog behind it, which would close too.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc, true);
    };
  }, [menu]);

  // A menu that would run off the edge of the screen is moved back onto it.
  useLayoutEffect(() => {
    if (!menu) return;
    const el = root.current?.querySelector<HTMLElement>(".ind-menu");
    if (!el) return;
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    const pad = 8;
    // The width of the screen itself: window.innerWidth grows with whatever overflows it, which is the very thing being avoided.
    const vw = Math.min(document.documentElement.clientWidth, window.visualViewport?.width ?? Infinity);
    const dx = r.left < pad ? pad - r.left : r.right > vw - pad ? vw - pad - r.right : 0;
    if (dx) el.style.transform = `translateX(${dx}px)`;
  }, [menu]);

  const lockedInd = (id: IndicatorId) => !isFreeIndicator(id);
  const togglePin = (id: IndicatorId) => setPrefs((now) => ({ ...now, pinned: INDICATORS.map((i) => i.id).filter((x) => (x === id ? !now.pinned.includes(id) : now.pinned.includes(x))) }));
  const flipIndicator = (id: IndicatorId) => setPrefs((now) => ({ ...now, indicators: now.indicators.includes(id) ? now.indicators.filter((x) => x !== id) : INDICATORS.map((i) => i.id).filter((x) => x === id || now.indicators.includes(x)) }));
  const toggleIndicator = (id: IndicatorId) => (lockedInd(id) ? unlock(() => flipIndicator(id)) : flipIndicator(id));
  const saveShot = (width: number) => {
    if (!isFreeShot(width) && !pro) return unlock(() => saveShot(width));
    setMenu(null);
    void api.current?.screenshot(`QMax-${symbol}-${range}`, width).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const pickColor = (hex: string) => {
    patch({ color: hex });
    if (selected) changeDrawings(drawings.map((d) => (d.id === selected ? { ...d, color: hex } : d)));
  };

  // With "fill gaps" the chart works on an unbroken series (the last price carried through hours with no trades); otherwise on the candles that exist.
  const shownCandles = useMemo(() => (candles && prefs.fill && !source ? fillQuietCandles(candles.candles, INTERVAL_MS[candles.interval], Date.now()) : (candles?.candles ?? [])), [candles, prefs.fill, source]);
  const have = shownCandles.length;
  // Candles read from Quhub (before the archive's records begin): said in a line under the chart, not marked on it.
  const older = useMemo(() => {
    const q = shownCandles.filter((c) => c.src === "quhub");
    return q.length ? { n: q.length, until: q[q.length - 1].t, daily: q.some((c) => c.approx) } : null;
  }, [shownCandles]);
  const short = useMemo(() => prefs.indicators.filter((id) => candles !== null && have < INDICATORS.find((i) => i.id === id)!.need), [prefs.indicators, candles, have]);
  const loading = !error && (line ? !history : !candles);
  const viewKey = `${assetId}|${range}|${prefs.interval}|${venue}|${prefs.fill}|${line ? "line" : "candles"}`;
  const candleWidth = candles?.interval ?? AUTO_WIDTH[range];
  const shown = !line && candles && candles.candles.length > 0;
  const drawable = !line;

  const barOpen = toolsOpen || tool !== "cursor" || selected !== null;

  // The chart is as tall as the room that is left under the controls (so it fills the dialog and nothing needs scrolling to see it); on a phone it
  // keeps a fixed height instead. Measured again when the dialog, the controls or the full-screen state change size.
  const [chartH, setChartH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const rootEl = root.current;
    if (!rootEl) return;
    const pane = rootEl.closest<HTMLElement>(".pane");
    const measure = () => {
      const stage = rootEl.querySelector<HTMLElement>(".stage");
      if (!fit || !stage || window.matchMedia("(max-width: 900px)").matches) return setChartH(null);
      // Inside the scaled-down workspace the page's own lengths are scaled up by 1/zoom: what is measured on screen is divided by it.
      const z = uiZoom(rootEl);
      const room = document.fullscreenElement === rootEl || !pane ? (window.innerHeight - stage.getBoundingClientRect().top) / z : pane.clientHeight - (stage.getBoundingClientRect().top - pane.getBoundingClientRect().top) / z - pane.scrollTop;
      setChartH((old) => {
        // never taller than the window: a chart that is would be a runaway measurement, not a fit
        const next = Math.min(Math.max(320, Math.floor(room - 16)), Math.max(320, window.innerHeight / z - 120));
        return old !== null && Math.abs(old - next) < 2 ? old : next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rootEl);
    if (pane) ro.observe(pane);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [fs, focus?.on, line, fit]);

  return (
    <div className={`${fs ? "chartview full" : focus?.on ? "chartview focus" : "chartview"}${chartH !== null ? " fit" : ""}`} ref={root} style={chartH ? ({ "--chart-h": `${chartH}px` } as React.CSSProperties) : undefined}>
      {/* What is drawn, and how far back. */}
      <div className="chartbar">
        <div className="chartpick">
          <label className="mini-select">
            <span className="sr-only">Chart style</span>
            <select value={prefs.type} onChange={(e) => (isFreeType(e.target.value) ? patch({ type: e.target.value as ChartType }) : unlock(() => patch({ type: e.target.value as ChartType })))} aria-label="Chart style">
              {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}{!isFreeType(t.id) ? " · Max" : ""}</option>)}
            </select>
          </label>
          {!line && (
            <>
              <label className="mini-select">
                <span className="sr-only">Candle width</span>
                <select value={prefs.interval} onChange={(e) => (isFreeInterval(e.target.value) ? patch({ interval: e.target.value as Prefs["interval"] }) : unlock(() => patch({ interval: e.target.value as Prefs["interval"] })))} aria-label="Candle width">
                  {INTERVALS.map(([id, label]) => <option key={id} value={id}>{id === "auto" ? `Auto · ${candles ? candleWidth : AUTO_WIDTH[range]}` : `${label}${!isFreeInterval(id) ? " · Max" : ""}`}</option>)}
                </select>
              </label>
              {!source && (
                <div className="seg-mini" role="group" aria-label="Which market the trades are from">
                  {(["QX", "QSwap"] as const).filter((v) => !venues || venues.includes(v)).map((v) => (
                    <button key={v} className={(venue === "auto" ? candles?.venue : venue) === v ? "on" : ""} aria-pressed={(venue === "auto" ? candles?.venue : venue) === v} title={`The chart from the trades on ${v}`} onClick={() => setVenue(v)}>{v} chart</button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="chips" role="group" aria-label="Chart range">
          {RANGES.map(([id, label]) => (
            <button key={id} className={range === id ? "chip on" : "chip"} onClick={() => ((pickedRange.current = true), setWidened(null), setRange(id))}>{label}</button>
          ))}
        </div>
      </div>

      <button className={barOpen ? "chip tools-toggle on" : "chip tools-toggle"} aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>
        Chart tools{prefs.indicators.length ? ` · ${prefs.indicators.length} indicator${prefs.indicators.length === 1 ? "" : "s"}` : ""}{drawings.length ? ` · ${drawings.length} drawing${drawings.length === 1 ? "" : "s"}` : ""} {toolsOpen ? "▴" : "▾"}
      </button>

      {/* Indicators, axis, and the buttons around the chart. */}
      <div className={barOpen ? "chartopts" : "chartopts collapsed"}>
        <div className="tools" role="group" aria-label="Chart options">
          {!line && prefs.pinned.map((id) => {
            const i = INDICATORS.find((x) => x.id === id)!;
            const need = candles !== null && have < i.need;
            return (
              <button key={id} className={prefs.indicators.includes(id) ? "chip on ind-chip" : "chip ind-chip"} aria-pressed={prefs.indicators.includes(id)} onClick={() => toggleIndicator(id)} title={need ? `${i.hint}. Needs ${i.need} candles; this range has ${have}.` : i.hint}>
                <i style={{ background: indicatorColor(id) }} aria-hidden="true" />
                {i.label}
                
              </button>
            );
          })}
          {!line && (
            <div className="ind-wrap">
              <button className={prefs.indicators.some((x) => !prefs.pinned.includes(x)) ? "chip on ind-open" : "chip ind-open"} aria-expanded={menu === "ind"} aria-haspopup="true" onClick={() => setMenu(menu === "ind" ? null : "ind")}>
                {prefs.pinned.length === 0 ? "Indicators" : "More indicators"} ▾
              </button>
              {menu === "ind" && (
                <div className="ind-menu" role="menu" aria-label="Indicators">
                  <div className="ind-title">On the price</div>
                  {INDICATORS.filter((i) => i.kind === "overlay").map((i) => <IndicatorRow key={i.id} id={i.id} isMax={lockedInd(i.id)} on={prefs.indicators.includes(i.id)} pinned={prefs.pinned.includes(i.id)} have={candles ? have : null} toggle={toggleIndicator} pin={togglePin} />)}
                  <div className="ind-title">Under the price</div>
                  {INDICATORS.filter((i) => i.kind === "pane").map((i) => <IndicatorRow key={i.id} id={i.id} isMax={lockedInd(i.id)} on={prefs.indicators.includes(i.id)} pinned={prefs.pinned.includes(i.id)} have={candles ? have : null} toggle={toggleIndicator} pin={togglePin} />)}
                  <p className="ind-hint"><Icon name="pin" size={12} /> Pin the ones you use to put a button for them in the bar.</p>
                  <button className="ind-clear" onClick={() => patch({ indicators: [] })} disabled={prefs.indicators.length === 0}>Turn all off</button>
                  <button className="ind-clear" onClick={() => patch({ pinned: QUICK })} disabled={prefs.pinned.length === QUICK.length && QUICK.every((q) => prefs.pinned.includes(q))}>Reset the bar’s buttons</button>
                </div>
              )}
            </div>
          )}
          {!line && <button className={prefs.volume ? "chip on" : "chip"} aria-pressed={prefs.volume} onClick={() => patch({ volume: !prefs.volume })} title="Volume bars under the price">Volume</button>}
          {!line && <button className={prefs.epochs ? "chip on" : "chip"} aria-pressed={prefs.epochs} onClick={() => unlock(() => patch({ epochs: !saved.epochs }))} title="Mark where each Qubic epoch begins (a week long, starting Wednesday at 12:00 UTC)">Epochs</button>}
          {!line && !source && <button className={prefs.fill ? "chip on" : "chip"} aria-pressed={prefs.fill} onClick={() => unlock(() => patch({ fill: !saved.fill }))} title="Carry the last price through hours with no trades, so a quiet market is an unbroken series and the indicators have more to work on">Fill gaps</button>}
          <div className="seg-mini" role="group" aria-label="Price axis">
            {([["normal", "Lin", "Linear price axis"], ["log", "Log", "Logarithmic: equal percentage moves look equally big"], ["percent", "%", "Percent change from the first candle shown"]] as const).map(([id, label, hint]) => (
              <button key={id} className={prefs.scale === id ? "on" : ""} aria-pressed={prefs.scale === id} title={hint} onClick={() => (isFreeScale(id) ? patch({ scale: id }) : unlock(() => patch({ scale: id })))}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* The drawing tools sit down the left side of the chart, as on a trading terminal; on a phone they fold into the tools button. */}
      <div className={`${chartH !== null && chartH < 470 ? "stage compact" : "stage"}${drawable ? "" : " solo"}`}>
        {drawable && (
          <div className={barOpen ? "drawbar" : "drawbar collapsed"} role="group" aria-label="Drawing tools">
            {TOOLS.map((t) => (
              <button key={t.id} className={tool === t.id ? "tool on" : "tool"} aria-pressed={tool === t.id} aria-label={t.label} title={`${t.hint}${isFreeTool(t.id) || pro ? "" : " (part of Max)"}`} onClick={() => (isFreeTool(t.id) ? setTool(t.id === tool && t.id !== "cursor" ? "cursor" : t.id) : unlock(() => setTool(t.id === tool ? "cursor" : t.id)))}>
                {t.icon}
              </button>
            ))}
            <span className="sep" aria-hidden="true" />
            <div className="ind-wrap">
              <button className="tool color-open" aria-label="Drawing colour and clearing" aria-expanded={menu === "color"} aria-haspopup="true" title="Colour for new drawings (and the selected one); clear all" onClick={() => setMenu(menu === "color" ? null : "color")}>
                <span className="swatch on" style={{ background: prefs.color }} />
              </button>
              {menu === "color" && (
                <div className="ind-menu color-menu" role="menu" aria-label="Drawing colour">
                  <div className="ind-title">Colour</div>
                  <div className="swatches" role="group" aria-label="Drawing colour">
                    {PALETTE.map((p) => (
                      <button key={p.hex} className={prefs.color === p.hex ? "swatch big on" : "swatch big"} style={{ background: p.hex }} aria-label={p.name} aria-pressed={prefs.color === p.hex} title={p.name} onClick={() => pickColor(p.hex)} />
                    ))}
                  </div>
                  <button className="ind-clear" disabled={drawings.length === 0} onClick={() => drawings.length > 0 && window.confirm(`Remove all ${drawings.length} drawing${drawings.length === 1 ? "" : "s"} on ${symbol}?`) && (changeDrawings([]), setSelected(null), setMenu(null))}>
                    Clear all drawings{drawings.length ? ` (${drawings.length})` : ""}
                  </button>
                </div>
              )}
            </div>
            <button className="tool" aria-label="Delete the selected drawing" title="Delete the selected drawing (Delete key)" disabled={!selected} onClick={() => selected && (changeDrawings(drawings.filter((d) => d.id !== selected)), setSelected(null))}>{ICON.trash}</button>
          </div>
        )}
        <div className="stagecol">
          {/* The chart's own buttons float over its top-right corner (clear of the price scale) instead of taking a row of their own. */}
            <div className="tools right chart-actions" role="group" aria-label="Chart actions">
              <button className="tool" aria-label="Show everything" title="Fit: show the whole range" onClick={() => api.current?.fit()}>{ICON.fit}</button>
              <button className="tool" aria-label="Go to the latest candle" title="Jump to the latest candle" onClick={() => api.current?.latest()}>{ICON.latest}</button>
              <div className="ind-wrap">
                <button className={menu === "style" ? "tool on style-open" : "tool style-open"} aria-label="Chart settings" aria-expanded={menu === "style"} aria-haspopup="true" title={`Chart settings: colours, background, candles, lines, grid and typeface${pro ? "" : " (part of Max)"}`} onClick={() => (pro || menu === "style" ? setMenu(menu === "style" ? null : "style") : unlock(() => setMenu("style")))}>{ICON.settings}</button>
                {menu === "style" && (
                  <div className="ind-menu style-menu" role="dialog" aria-label="Chart settings">
                    <ChartSettings style={style} resolved={resolvedStyle} onChange={patchStyle} onReset={resetStyle} line={line} />
                  </div>
                )}
              </div>
              <div className="ind-wrap">
                <button className="tool shot-open" aria-label="Save as a picture" aria-expanded={menu === "shot"} aria-haspopup="true" title="Save the chart as a picture" onClick={() => setMenu(menu === "shot" ? null : "shot")}>{ICON.camera}</button>
                {menu === "shot" && (
                  <div className="ind-menu shot-menu" role="menu" aria-label="Save as a picture">
                    <div className="ind-title">Save as PNG</div>
                    {SHOT_SIZES.map((s) => (
                      <button key={s.id} className="shot-row" role="menuitem" onClick={() => saveShot(s.width)}>
                        <b>{s.label}</b>
                        <small>{s.note}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {typeof document !== "undefined" && document.fullscreenEnabled && (
                <button className="tool" aria-label={fs ? "Leave full screen" : "Full screen"} title={fs ? "Leave full screen" : "Full screen"} onClick={() => void (fs ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(() => {})}>{ICON.full}</button>
              )}
              {focus && <button className={focus.on ? "chip on focus-btn" : "chip focus-btn"} aria-pressed={focus.on} title={focus.on ? "Bring the order ticket back" : "Give the chart the whole dialog (hides the order ticket)"} onClick={focus.toggle}>{focus.on ? "Show ticket" : "Wide chart"}</button>}
            </div>
          {tool !== "cursor" && drawable && (
            <p className="note tip" role="status">
              {tool === "measure" ? "Click a start point, then an end point. " : tool === "hline" || tool === "vline" ? "Click where the line goes. " : "Click the first point, then the second. "}
              Esc cancels.
            </p>
          )}
          {error && <p className="err">{error}</p>}
          {loading && <div className="skeleton block" role="status" aria-label="Loading the chart" />}
          {shown && (
            <LwChart
              type={prefs.type}
              candles={shownCandles}
              intervalMs={INTERVAL_MS[candles.interval]}
              indicators={prefs.indicators}
              volume={prefs.volume}
              epochs={prefs.epochs}
              chartStyle={style}
              scale={prefs.scale}
              symbol={symbol}
              volumeLine={source?.volumeLine}
              viewKey={viewKey}
              tool={tool}
              drawColor={prefs.color}
              drawings={drawings}
              onDrawingsChange={changeDrawings}
              selectedId={selected}
              onSelect={setSelected}
              onToolDone={() => setTool("cursor")}
              onApi={(a) => (api.current = a)}
            />
          )}
          {line && history && history.points.length > 0 && <LwChart type="line" points={history.points} symbol={symbol} priceUnit={source?.priceUnit} viewKey={viewKey} chartStyle={style} onApi={(a) => (api.current = a)} />}
        </div>
      </div>
      {!line && candles && (
        <>
          {widened && <p className="note">The last {RANGES.find((r) => r[0] === widened.from)![1]} had only {widened.count} candle{widened.count === 1 ? "" : "s"}, so this shows {RANGES.find((r) => r[0] === range)![1]}. Pick a range to choose your own.</p>}
          {older && (
            <p className="note">
              The {n(older.n)} candle{older.n === 1 ? "" : "s"} up to {new Date(older.until).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} come from <a href="https://quhub.app" target="_blank" rel="noreferrer noopener">Quhub</a>, a community copy of the QX service, because the Qubic archive has no trades before April 2026. QX only, and the chain cannot confirm them (where both exist they agree with the archive to within about 1%).
              {older.daily && " Where an asset trades too often for every trade to be listed there is only a daily summary, so those candles open and close at the day's average price."}
            </p>
          )}
          {candles.truncated && <p className="note">Showing the latest {n(candles.candles.length)}{candles.available ? ` of ${n(candles.available)}` : ""} candles at this width. A wider candle, or a shorter range, shows the rest.</p>}
          {prefs.fill && !source && candles.candles.length > 0 && shownCandles === candles.candles && <p className="note">There are too many candles to fill the gaps at this width: pick a wider candle.</p>}
          {candles.candles.length > 0 && short.length > 0 && (
            <p className="note">Not enough candles in this range for {short.map((id) => `${INDICATORS.find((i) => i.id === id)!.label} (needs ${INDICATORS.find((i) => i.id === id)!.need}, have ${have})`).join(", ")}. A longer range or narrower candles have more.</p>
          )}
          {source ? <p className="note chart-explain">{source.note(candles, range)}</p> : <p className="note chart-explain">
            {candles.candles.length === 0
              ? "Nothing traded in this range. Try a longer one, or switch to the line."
              : <>{candles.interval === "1d" ? "Day" : INTERVAL_NAME[candles.interval].replace(/^1 /, "").replace(/^(\w)/, (c) => c.toUpperCase())} candles on {candles.venue === "all" ? "QX and QSwap together" : candles.venue}. Last 24 hours: <b>{n(candles.volume24hQu)} QU</b> in {n(candles.trades24h)} trades. {prefs.type === "heikin" && "Heikin-Ashi is smoothed; the numbers above the chart are the real candle's. "}{range === "all" && !older && <>The Qubic archive's trade records begin around epoch 207 (April 2026): nothing older to load. </>}UTC, updates every minute.</>}
          </p>}
        </>
      )}
      {line && history && source && <p className="note">{source.note(null, range)}</p>}
      {line && history && !source && (
        <p className="note">
          {history.since === null
            ? "QMax has no price history for this asset yet."
            : history.recordedSince && history.recordedSince > history.since
              ? <>Before {date(history.recordedSince)} the line is rebuilt from trades on QX and QSwap (an hourly average, so quiet hours have no point). Since then QMax records the price about every 10 minutes.</>
              : history.recordedSince === null
                ? <>The line is rebuilt from trades on QX and QSwap, an hourly average, so quiet hours have no point. QMax has not started recording this asset live yet.</>
                : <>QMax records each price about every 10 minutes, starting {date(history.since)}.</>}{" "}
          Drawing tools and indicators are for the candle styles.
        </p>
      )}
      <p className="note fine">Charts by <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer noopener">TradingView Lightweight Charts</a>. Drawings are kept in this browser, per {source ? "chart" : "asset"}.{drawings.length > 0 && ` ${drawings.length} on ${symbol}.`}</p>
    </div>
  );
}

function IndicatorRow({ id, isMax, on, pinned, have, toggle, pin }: { id: IndicatorId; isMax: boolean; on: boolean; pinned: boolean; have: number | null; toggle: (id: IndicatorId) => void; pin: (id: IndicatorId) => void }) {
  const i = INDICATORS.find((x) => x.id === id)!;
  const short = have !== null && have < i.need;
  return (
    <label className={short ? "ind-row dim" : "ind-row"} title={short ? `${i.hint}. Needs ${i.need} candles; this range has ${have}.` : i.hint}>
      <input type="checkbox" checked={on} onChange={() => toggle(id)} />
      <i style={{ background: indicatorColor(id) }} aria-hidden="true" />
      <span>{i.label}</span>
      {short && <small>needs {i.need}</small>}
      <button
        type="button"
        className={pinned ? "ind-pin on" : "ind-pin"}
        aria-pressed={pinned}
        aria-label={pinned ? `Take ${i.label} off the bar` : `Put ${i.label} in the bar`}
        title={pinned ? "In the bar: click to take it off" : "Put a button for it in the bar"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          pin(id);
        }}
      >
        <Icon name="pin" size={13} />
      </button>
    </label>
  );
}

