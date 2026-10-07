import { AreaSeries, BarSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, PriceScaleMode, createChart, createTextWatermark } from "lightweight-charts";
import type { IChartApi, ISeriesApi, Logical, SeriesType, UTCTimestamp } from "lightweight-charts";
import type { Sample } from "../../src/history.ts";
import { INDICATORS } from "../../src/indicators.ts";
import type { IndicatorId } from "../../src/indicators.ts";
import type { Drawing } from "../../src/drawings.ts";
import { axisPrice, axisVolume, candleData, closeLine, heikinAshi, indicatorData, lineData, volumeData } from "../../src/lwdata.ts";
import { TimeGrid } from "../../src/timegrid.ts";
import { plainResolved } from "../../src/chartstyle.ts";
import type { ResolvedStyle } from "../../src/chartstyle.ts";
import type { TradeCandle } from "../../src/trades.ts";
import { DrawingsPrimitive } from "./drawings-primitive.ts";
import { EpochsPrimitive } from "./epochs-primitive.ts";

/**
 * Builds the price chart (series, indicators, panes, drawings) into an element. It is separate from the React component so the same chart can be
 * built again, off screen, at several times the size for a picture in 4K or 8K: `k` is how many times bigger everything is made (type, lines,
 * drawings), so a big picture is the same chart, not a stretched one.
 */

export type ChartType = "candles" | "heikin" | "bars" | "area" | "line";
export type ScaleMode = "normal" | "log" | "percent";

/** Colours that read on both the dark and the light page. */
export const HUE = { sma20: "#f5b73b", sma50: "#a78bfa", ema21: "#38bdf8", bb: "#94a3b8", vwap: "#f472b6", rsi: "#c084fc", macd: "#38bdf8", signal: "#fb923c", stoch: "#22d3ee", stochD: "#fb923c", atr: "#facc15", obv: "#2dd4bf" };

/** A page colour (a CSS variable, possibly written as `rgb(1 2 3 / .2)`) as the plain `rgba()` text the library can read. */
function pageColor(name: string, fallback: string): string {
  const el = document.createElement("span");
  el.style.color = `var(${name}, ${fallback})`;
  el.style.display = "none";
  document.body.appendChild(el);
  const out = getComputedStyle(el).color;
  el.remove();
  return out || fallback;
}

export interface Colors {
  muted: string;
  fg: string;
  surface: string;
  surface3: string;
  grid: string;
  up: string;
  down: string;
  accent: string;
}
export const readColors = (): Colors => ({
  muted: pageColor("--muted", "#9a9fc0"),
  fg: pageColor("--fg", "#e6e8f5"),
  surface: pageColor("--surface", "#14162b"),
  surface3: pageColor("--surface-3", "#1f2238"),
  grid: pageColor("--chart-grid", "rgba(148,163,184,0.16)"),
  up: pageColor("--buy", "#4ade80"),
  down: pageColor("--sell", "#f87171"),
  accent: pageColor("--accent", "#6ee7ff"),
});
export const withAlpha = (c: string, a: number) => c.replace(/rgba?\(([^)]+)\)/, (_m, inner: string) => `rgba(${inner.split(",").slice(0, 3).join(",")}, ${a})`);

/** One drawn series that the legend can read a value from at any time. */
export interface Tracked {
  label: string;
  color: string;
  by: Map<number, number>;
  fmt: (v: number) => string;
}

export interface BuildCfg {
  type: ChartType;
  candles: TradeCandle[];
  intervalMs: number;
  points: Sample[];
  indicators: ReadonlySet<IndicatorId>;
  volume: boolean;
  scale: ScaleMode;
  symbol: string;
  drawings: Drawing[];
  selectedId: string | null;
  /** Mark where each Qubic epoch begins (candle charts). */
  epochs?: boolean;
  /** How it looks (type, colours beyond `c`, lines, grid): the chart settings. The plain page look when absent. */
  style?: ResolvedStyle;
}

export interface Built {
  chart: IChartApi;
  main: ISeriesApi<SeriesType>;
  /** The time of every candle position (gaps included), in seconds. */
  times: number[];
  grid: TimeGrid | null;
  byTime: Map<number, TradeCandle>;
  tracked: Tracked[];
  dp: DrawingsPrimitive | null;
}

const lw = (w: number, k: number) => Math.max(1, Math.round(w * k)) as 1 | 2 | 3 | 4;

/** The chart in `el`. With `size` it is that many page pixels across and tall (for a picture); otherwise it follows its element. */
export function buildChart(el: HTMLElement, cfg: BuildCfg, c: Colors, k = 1, size?: { w: number; h: number }): Built {
  const candleLike = cfg.type !== "line";
  const st = cfg.style ?? plainResolved(c);
  /** A line's width under the chart settings (1 to 4 there; 2 is the original look). */
  const lws = (w: number) => lw((w * st.lineWidth) / 2, k);
  const gridStyle = (def: LineStyle) => (st.gridLine === "default" ? def : st.gridLine === "solid" ? LineStyle.Solid : st.gridLine === "dashed" ? LineStyle.Dashed : LineStyle.Dotted);
  const chart = createChart(el, {
    ...(size ? { width: size.w, height: size.h } : { autoSize: true }),
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: c.muted,
      fontFamily: st.fontFamily,
      fontSize: st.fontSize * k,
      panes: { separatorColor: withAlpha(c.grid, 0.5), separatorHoverColor: withAlpha(c.accent, 0.3), enableResize: true },
    },
    // Quiet grid: faint dotted price lines, and time lines fainter still, so the candles are what the eye finds.
    grid: {
      vertLines: { visible: st.gridVert, color: withAlpha(c.grid, 0.07), style: gridStyle(LineStyle.Solid) },
      horzLines: { visible: st.gridHorz, color: withAlpha(c.grid, 0.14), style: gridStyle(LineStyle.Dotted) },
    },
    rightPriceScale: { borderVisible: false, textColor: c.muted, minimumWidth: Math.round(64 * k) },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3, minBarSpacing: 0.4, tickMarkMaxCharacterLength: 8 },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: withAlpha(st.colors.crosshair, 0.55), width: lw(1, k), style: LineStyle.Dashed, labelBackgroundColor: c.surface3 },
      horzLine: { color: withAlpha(st.colors.crosshair, 0.55), width: lw(1, k), style: LineStyle.Dashed, labelBackgroundColor: c.surface3 },
    },
    handleScale: { axisPressedMouseMove: { time: true, price: true } },
  });
  // Each pane has its own price axis: the logarithmic (or percent) one is for the price only (RSI runs 0 to 100, and MACD goes below zero).
  chart.priceScale("right", 0).applyOptions({
    mode: cfg.scale === "log" ? PriceScaleMode.Logarithmic : cfg.scale === "percent" ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
    // The top is left clear for the legend card, the bottom for the volume bars.
    scaleMargins: { top: candleLike ? 0.15 : 0.1, bottom: candleLike && cfg.volume ? 0.26 : 0.08 },
  });
  const shown = { type: "custom" as const, formatter: axisPrice, minMove: 0.0001 };

  const byTime = new Map<number, TradeCandle>();
  const tracked: Tracked[] = [];
  const track = (label: string, color: string, rows: { time: number; value: number }[], fmt: (v: number) => string = axisPrice) => tracked.push({ label, color, by: new Map(rows.map((r) => [r.time, r.value])), fmt });
  const line = (rows: { time: number; value: number }[], color: string, pane: number, extra: object = {}) => {
    const s = chart.addSeries(LineSeries, { color, lineWidth: lws(1), priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: shown, ...extra }, pane);
    s.setData(rows.map((p) => ({ ...p, time: p.time as UTCTimestamp })));
    return s;
  };
  /** A pane that is always 0 to 100 (RSI, stochastic), with guide lines. */
  const percentPane = (rows: { time: number; value: number }[], color: string, pane: number, guides: number[]) => {
    const s = line(rows, color, pane, { lineWidth: lws(2), priceFormat: { type: "custom", formatter: (v: number) => v.toFixed(0), minMove: 1 }, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    for (const level of guides) s.createPriceLine({ price: level, color: withAlpha(c.grid, 0.4), lineWidth: lw(1, k), lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    return s;
  };

  let main: ISeriesApi<SeriesType>;
  let times: number[] = [];
  let grid: TimeGrid | null = null;
  const on = cfg.indicators;

  if (candleLike) {
    for (const t of cfg.candles) byTime.set(Math.floor(t.t / 1000), t);
    const shape = cfg.type === "heikin" ? heikinAshi(cfg.candles) : cfg.candles;
    const data = candleData(shape, cfg.intervalMs);
    times = data.map((p) => p.time);
    grid = new TimeGrid(times, Math.max(1, Math.floor(cfg.intervalMs / 1000)));
    const lastLine = { priceLineWidth: lw(1, k), priceLineStyle: LineStyle.Dashed };
    if (cfg.type === "bars") {
      const s = chart.addSeries(BarSeries, { upColor: c.up, downColor: c.down, priceFormat: shown, thinBars: false, ...lastLine });
      s.setData(data.map((p) => ({ ...p, time: p.time as UTCTimestamp })));
      main = s;
    } else if (cfg.type === "area") {
      const s = chart.addSeries(AreaSeries, { lineColor: c.accent, topColor: withAlpha(c.accent, st.areaFill ? 0.38 : 0), bottomColor: withAlpha(c.accent, st.areaFill ? 0.01 : 0), lineWidth: lws(2), priceFormat: shown, ...lastLine });
      s.setData(closeLine(cfg.candles).map((p) => ({ ...p, time: p.time as UTCTimestamp })));
      main = s;
    } else {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: st.hollowUp ? "rgba(0, 0, 0, 0)" : c.up,
        downColor: c.down,
        wickUpColor: st.wickUp,
        wickDownColor: st.wickDown,
        borderVisible: st.hollowUp,
        borderUpColor: c.up,
        borderDownColor: c.down,
        priceFormat: shown,
        ...lastLine,
      });
      s.setData(data.map((p) => ({ ...p, time: p.time as UTCTimestamp })));
      main = s;
    }
    if (cfg.volume) {
      const v = chart.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "custom", formatter: axisVolume, minMove: 1 }, lastValueVisible: false, priceLineVisible: false });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      v.setData(volumeData(cfg.candles, withAlpha(c.up, st.volumeOpacity), withAlpha(c.down, st.volumeOpacity)).map((p) => ({ ...p, time: p.time as UTCTimestamp })));
    }

    // Overlays share the price scale.
    for (const id of on) {
      const d = indicatorData(cfg.candles, id);
      const name = INDICATORS.find((i) => i.id === id)!.label;
      if (id === "sma20" || id === "sma50" || id === "ema21" || id === "vwap") {
        line(d.line, HUE[id], 0, { lineWidth: lws(2) });
        track(name, HUE[id], d.line);
      } else if (id === "bb") {
        line(d.upper, HUE.bb, 0);
        line(d.lower, HUE.bb, 0);
        line(d.mid, HUE.bb, 0, { lineStyle: LineStyle.Dashed });
        track("BB upper", HUE.bb, d.upper);
        track("BB lower", HUE.bb, d.lower);
      }
    }
    // Each oscillator gets a pane of its own under the price, in the list's order.
    let pane = 1;
    if (on.has("rsi")) {
      const d = indicatorData(cfg.candles, "rsi").line;
      percentPane(d, HUE.rsi, pane++, [70, 30]);
      track("RSI 14", HUE.rsi, d, (v) => v.toFixed(1));
    }
    if (on.has("macd")) {
      const d = indicatorData(cfg.candles, "macd");
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: shown }, pane);
      hist.setData(d.histogram.map((p) => ({ time: p.time as UTCTimestamp, value: p.value, color: withAlpha(p.value >= 0 ? c.up : c.down, 0.6) })));
      line(d.macd, HUE.macd, pane, { lineWidth: lws(2) });
      line(d.signal, HUE.signal, pane, { lineWidth: lws(2) });
      track("MACD", HUE.macd, d.macd);
      track("Signal", HUE.signal, d.signal);
      track("Hist", withAlpha(c.up, 0.8), d.histogram);
      pane++;
    }
    if (on.has("stoch")) {
      const d = indicatorData(cfg.candles, "stoch");
      percentPane(d.k, HUE.stoch, pane, [80, 20]);
      line(d.d, HUE.stochD, pane, { lineWidth: lws(1) });
      track("%K", HUE.stoch, d.k, (v) => v.toFixed(1));
      track("%D", HUE.stochD, d.d, (v) => v.toFixed(1));
      pane++;
    }
    if (on.has("atr")) {
      const d = indicatorData(cfg.candles, "atr").line;
      line(d, HUE.atr, pane++, { lineWidth: lws(2) });
      track("ATR 14", HUE.atr, d);
    }
    if (on.has("obv")) {
      const d = indicatorData(cfg.candles, "obv").line;
      line(d, HUE.obv, pane++, { lineWidth: lws(2), priceFormat: { type: "custom", formatter: axisVolume, minMove: 1 } });
      track("OBV", HUE.obv, d, axisVolume);
    }
    // The price keeps most of the height; each oscillator pane takes a slice.
    const panes = chart.panes();
    panes[0]?.setStretchFactor(3);
    for (let i = 1; i < panes.length; i++) {
      panes[i].setStretchFactor(1);
      chart.priceScale("right", i).applyOptions({ borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } });
    }
  } else {
    const s = chart.addSeries(LineSeries, { color: c.accent, lineWidth: lws(2), priceLineVisible: true, lastValueVisible: true, priceFormat: shown, priceLineWidth: lw(1, k), priceLineStyle: LineStyle.Dashed });
    s.setData(lineData(cfg.points).map((p) => ({ ...p, time: p.time as UTCTimestamp })));
    main = s;
  }

  // The asset's name, large and very faint, behind everything.
  if (st.watermark) createTextWatermark(chart.panes()[0], {
    horzAlign: "center",
    vertAlign: "center",
    lines: [{ text: cfg.symbol, color: withAlpha(c.fg, 0.05), fontSize: 84 * k, fontStyle: "700", fontFamily: st.fontFamily }],
  });

  // Drawings (a primitive on the price series): placed by time and price through the time grid, which can place any time, even one ahead of the last candle.
  let dp: DrawingsPrimitive | null = null;
  if (candleLike && grid) {
    const g = grid;
    dp = new DrawingsPrimitive();
    dp.k = k;
    dp.mapper = { x: (t) => chart.timeScale().logicalToCoordinate(g.indexOf(t) as Logical), y: (p) => main.priceToCoordinate(p) };
    main.attachPrimitive(dp);
  }
  // The start of each epoch, as a faint line behind the candles.
  if (candleLike && grid && cfg.epochs) {
    const g = grid;
    const ep = new EpochsPrimitive();
    ep.k = k;
    ep.ink = { line: withAlpha(c.fg, 0.3), text: withAlpha(c.fg, 0.65) };
    ep.mapper = (t) => chart.timeScale().logicalToCoordinate(g.indexOf(t) as Logical);
    main.attachPrimitive(ep);
  }
  return { chart, main, times, grid, byTime, tracked, dp };
}
