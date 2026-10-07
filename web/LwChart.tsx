import { useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, MouseEventParams, Time } from "lightweight-charts";
import type { Sample } from "../src/history.ts";
import { INDICATORS } from "../src/indicators.ts";
import type { IndicatorId } from "../src/indicators.ts";
import { POINTS_NEEDED, hitTest, moveAnchor, newDrawingId, translate } from "../src/drawings.ts";
import type { Anchor, DrawKind, Drawing, Hit, Px } from "../src/drawings.ts";
import { axisPrice, axisVolume, lineData } from "../src/lwdata.ts";
import type { TradeCandle } from "../src/trades.ts";
import { HUE, buildChart, readColors, withAlpha } from "./chart/build.ts";
import { DEFAULT_STYLE, resolveStyle } from "../src/chartstyle.ts";
import type { ChartStyle } from "../src/chartstyle.ts";
import type { BuildCfg, ChartType, ScaleMode } from "./chart/build.ts";
import type { Draft, DrawState } from "./chart/drawings-primitive.ts";
import { useTheme } from "./theme.ts";

/**
 * The market's price chart, drawn by TradingView's Lightweight Charts (https://www.tradingview.com/lightweight-charts/, Apache-2.0: the
 * library shows its own attribution mark in a corner of the chart, which is part of its licence and is left on). The library draws to a
 * canvas, so nothing here puts text into the page as markup.
 *
 * The library has no indicators and no drawing tools of its own. The indicators (src/indicators.ts) are worked out by QMax from the candles and
 * added as more lines on the price or, for the oscillators, as panes under it. Drawings (src/drawings.ts) are a primitive attached to the price
 * series (web/chart/drawings-primitive.ts). web/chart/build.ts builds the chart; the pointer handling that creates, selects and drags drawings,
 * the legend, and saving a picture are here.
 */

/**
 * How the chart may be panned. Narrower than the workspace the screen is a row of swipe screens (see Pager.tsx), so a sideways touch drag on the chart has to
 * swipe to the next screen, and an up-down one to scroll the screen: the chart is panned there by the mouse, by pinching to zoom, and by the buttons above it.
 */
const swipeScreens = () => typeof matchMedia === "function" && matchMedia("(max-width: 999.98px)").matches;
const scrollOptions = (on: boolean) => ({ mouseWheel: on, pressedMouseMove: on, horzTouchDrag: on && !swipeScreens(), vertTouchDrag: on && !swipeScreens() });

export type { ChartType, ScaleMode };
export type Tool = DrawKind | "measure" | "cursor";
export { HUE };
export const indicatorColor = (id: IndicatorId): string => HUE[id];

export interface ChartApi {
  /** Show everything. */
  fit(): void;
  /** Jump to the newest candle. */
  latest(): void;
  /** Saves the chart (with its drawings) as a PNG; `width` is its width in real pixels (0: as sharp as the screen is). */
  screenshot(name: string, width?: number): Promise<void>;
}

interface Props {
  type: ChartType;
  /** What traded, and how wide each candle is (every type but "line"). */
  candles?: TradeCandle[];
  intervalMs?: number;
  /** For "line": the price samples. */
  points?: Sample[];
  indicators?: IndicatorId[];
  volume?: boolean;
  /** Mark where each Qubic epoch begins. */
  epochs?: boolean;
  /** How the chart looks (the chart settings): the page's own look when absent. */
  chartStyle?: ChartStyle;
  /** The legend's line about a candle's volume, for a chart whose volume is not "QU in N trades" (QU itself in dollars). */
  volumeLine?: (c: TradeCandle) => string;
  /** What the price is in, said after a value in the legend of the line (QU by default). */
  priceUnit?: string;
  scale?: ScaleMode;
  symbol: string;
  /** What is being shown (asset, range, width, source, style): the zoom is kept while this stays the same, so a refresh does not jump. */
  viewKey?: string;
  tool?: Tool;
  drawColor?: string;
  drawings?: Drawing[];
  onDrawingsChange?: (list: Drawing[]) => void;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** A drawing was finished (or a measurement taken): the toolbar goes back to the cursor. */
  onToolDone?: () => void;
  onApi?: (api: ChartApi | null) => void;
}

interface Item {
  label: string;
  color: string;
  text: string;
}
interface Legend {
  time: number;
  lines: string[];
  items: Item[];
}

const stamp = (seconds: number) => new Date(seconds * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";

// Defaults that are the same array every time: a new `[]` per render would restart the chart's effect on every render, which sets state, which renders...
const NO_CANDLES: TradeCandle[] = [];
const NO_POINTS: Sample[] = [];
const NO_INDICATORS: IndicatorId[] = [];
const NO_DRAWINGS: Drawing[] = [];

/** What was in view when the chart was last taken down, in times, so it can be put back on data that has since changed. */
interface SavedView {
  key: string;
  fromT: number;
  toT: number;
  /** The right edge was at the newest candle: stay with the newest as more arrive. */
  atEnd: boolean;
  /** How far past the newest candle the right edge was, in candles. */
  gap: number;
  width: number;
}

/** The biggest picture offered is 8K. A browser can refuse a canvas that large, and then the next size down is tried. */
const SHOT_SIZES = [7680, 3840, 1920];

export function LwChart(props: Props) {
  const { type, candles = NO_CANDLES, intervalMs = 3_600_000, points = NO_POINTS, indicators = NO_INDICATORS, volume = true, epochs = false, chartStyle = DEFAULT_STYLE, volumeLine, priceUnit = "QU", scale = "normal", symbol, viewKey = "", onApi } = props;
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  // What the chart is built from: the page's colours, the chosen scheme, and the person's own choices on top.
  const resolved = useMemo(() => resolveStyle(readColors(), chartStyle), [chartStyle, theme]);
  // A scheme, colour or gradient also gives what sits on the chart (the legend) and the frame behind it their colours: the page's variables are set again here.
  const c = resolved.colors;
  const wrapStyle = {
    fontFamily: resolved.fontFamily,
    ...(resolved.bgCss
      ? { background: resolved.bgCss, "--surface": c.surface, "--surface-2": c.surface3, "--surface-3": c.surface3, "--fg": c.fg, "--fg-2": c.fg, "--muted": c.muted, "--line": c.surface3, "--line-strong": c.surface3 }
      : {}),
  } as React.CSSProperties;
  const [legend, setLegend] = useState<Legend | null>(null);
  const [working, setWorking] = useState("");
  const saved = useRef<SavedView | null>(null);
  const push = useRef<(() => void) | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Always the latest props, for the pointer handlers that live as long as one chart does.
  const live = useRef(props);
  live.current = props;
  // What the person is in the middle of: a drawing being placed, a measurement.
  const ui = useRef<{ draft: Draft | null; measure: DrawState["measure"] }>({ draft: null, measure: null });

  const candleLike = type !== "line";
  const wanted = candleLike ? indicators : NO_INDICATORS;
  const key = wanted.join(",");
  const paneCount = wanted.filter((id) => INDICATORS.find((i) => i.id === id)?.kind === "pane").length;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const colors = resolved.colors;
    const ink = { text: colors.fg, bg: withAlpha(colors.surface, 0.92), up: colors.up, down: colors.down };
    const cfg: BuildCfg = { type, candles, intervalMs, points, indicators: new Set<IndicatorId>(wanted), volume, epochs, style: resolved, scale, symbol, drawings: live.current.drawings ?? NO_DRAWINGS, selectedId: null };
    const built = buildChart(el, cfg, colors, 1);
    const { chart, main, times, grid: gridT, byTime, tracked, dp } = built;
    chartRef.current = chart;

    // Put the view back where it was if this is the same chart with fresher data; otherwise show everything.
    const s0 = saved.current;
    const lastIdx = times.length - 1;
    if (s0 && s0.key === viewKey && gridT && !gridT.empty) {
      const to = s0.atEnd ? lastIdx + s0.gap : gridT.indexOf(s0.toT);
      const from = s0.atEnd ? to - s0.width : gridT.indexOf(s0.fromT);
      chart.timeScale().setVisibleLogicalRange({ from, to });
    } else chart.timeScale().fitContent();

    // ---- drawings -------------------------------------------------------------------------
    let dragging: Drawing[] | null = null; // the drawings while one is being dragged
    const pushState = () => dp?.set({ drawings: dragging ?? live.current.drawings ?? NO_DRAWINGS, selectedId: live.current.selectedId ?? null, draft: ui.current.draft, measure: ui.current.measure, ink });
    push.current = pushState;
    pushState();

    const plotSize = () => ({ w: chart.timeScale().width(), h: chart.paneSize(0).height });
    const rel = (e: PointerEvent): Px => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inPlot = (p: Px) => {
      const s = plotSize();
      return p.x >= 0 && p.y >= 0 && p.x <= s.w && p.y <= s.h;
    };
    const anchorAt = (p: Px): Anchor | null => {
      if (!gridT) return null;
      const lg = chart.timeScale().coordinateToLogical(p.x);
      const price = main.coordinateToPrice(p.y);
      return lg === null || price === null ? null : { t: gridT.timeAt(lg), p: price };
    };
    const scrollOnly = (yes: boolean) => chart.applyOptions({ handleScroll: scrollOptions(yes), handleScale: yes });
    let drag: { id: string; start: Anchor; part: Hit; original: Drawing } | null = null;
    const topHit = (p: Px): { d: Drawing; hit: NonNullable<Hit> } | null => {
      const geo = dp?.geo();
      const list = live.current.drawings ?? NO_DRAWINGS;
      if (!geo) return null;
      for (let i = list.length - 1; i >= 0; i--) {
        const hit = hitTest(list[i], geo, p, 7);
        if (hit) return { d: list[i], hit };
      }
      return null;
    };
    const step = Math.max(1, Math.floor(intervalMs / 1000));

    const onDown = (e: PointerEvent) => {
      if (!candleLike || (e.pointerType === "mouse" && e.button !== 0)) return;
      const p = rel(e);
      if (!inPlot(p)) return;
      const L = live.current;
      const tool = L.tool ?? "cursor";
      if (tool !== "cursor") {
        const a = anchorAt(p);
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        if (tool === "measure") {
          const m = ui.current.measure;
          if (m && !m.done) {
            ui.current.measure = { ...m, b: a, done: true };
            L.onToolDone?.();
          } else ui.current.measure = { a, b: a, stepSec: step, done: false };
        } else {
          const d: Draft = ui.current.draft ?? { kind: tool, color: L.drawColor ?? "#38bdf8", points: [], cursor: null };
          d.points = [...d.points, a];
          if (d.points.length >= POINTS_NEEDED[d.kind]) {
            const made: Drawing = { id: newDrawingId(), kind: d.kind, points: d.points, color: d.color };
            ui.current.draft = null;
            L.onDrawingsChange?.([...(L.drawings ?? NO_DRAWINGS), made]);
            L.onSelect?.(made.id);
            L.onToolDone?.();
          } else ui.current.draft = { ...d, cursor: a };
        }
        pushState();
        return;
      }
      // The cursor: pick up a drawing, or let the chart pan.
      ui.current.measure = null;
      const found = topHit(p);
      if (found) {
        const a = anchorAt(p);
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        scrollOnly(false);
        el.setPointerCapture?.(e.pointerId);
        drag = { id: found.d.id, start: a, part: found.hit, original: found.d };
        L.onSelect?.(found.d.id);
      } else if (L.selectedId) L.onSelect?.(null);
      pushState();
    };
    const onMove = (e: PointerEvent) => {
      if (!candleLike) return;
      const p = rel(e);
      const L = live.current;
      if (drag) {
        const cur = anchorAt(p);
        if (!cur) return;
        const o = drag.original;
        const next =
          drag.part && drag.part.part === "handle"
            ? moveAnchor(o, drag.part.index, cur)
            : translate(o, o.kind === "hline" ? 0 : cur.t - drag.start.t, o.kind === "vline" ? 0 : cur.p - drag.start.p);
        dragging = (L.drawings ?? NO_DRAWINGS).map((d) => (d.id === next.id ? next : d));
        pushState();
        return;
      }
      if (ui.current.draft && inPlot(p)) {
        ui.current.draft = { ...ui.current.draft, cursor: anchorAt(p) };
        pushState();
      }
      const m = ui.current.measure;
      if (m && !m.done && inPlot(p)) {
        const a = anchorAt(p);
        if (a) {
          ui.current.measure = { ...m, b: a };
          pushState();
        }
      }
      if ((L.tool ?? "cursor") === "cursor") {
        const h = inPlot(p) ? topHit(p) : null;
        el.style.cursor = h ? (h.hit.part === "handle" ? "grab" : "move") : "";
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      el.releasePointerCapture?.(e.pointerId);
      if (dragging) live.current.onDrawingsChange?.(dragging);
      drag = null;
      dragging = null;
      scrollOnly((live.current.tool ?? "cursor") === "cursor");
      pushState();
    };
    let hovering = false;
    // Caught before the dialog around the chart sees them: Esc while drawing must cancel the drawing, not close the dialog.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const L = live.current;
      if (!hovering && !wrap.current?.contains(document.activeElement)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && L.selectedId) {
        e.preventDefault();
        L.onDrawingsChange?.((L.drawings ?? NO_DRAWINGS).filter((d) => d.id !== L.selectedId));
        L.onSelect?.(null);
      } else if (e.key === "Escape" && (ui.current.draft || ui.current.measure || L.selectedId || (L.tool ?? "cursor") !== "cursor")) {
        e.stopPropagation();
        ui.current = { draft: null, measure: null };
        L.onSelect?.(null);
        L.onToolDone?.();
        pushState();
      }
    };
    const enter = () => (hovering = true);
    const leave = () => (hovering = false);
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", onKey, true);
    scrollOnly((live.current.tool ?? "cursor") === "cursor");

    // ---- the legend: what the pointer is over (or the latest, when it is not over the chart) ----
    const itemsAt = (time: number): Item[] => tracked.flatMap((t) => (t.by.has(time) ? [{ label: t.label, color: t.color, text: t.fmt(t.by.get(time)!) }] : []));
    const describe = (time: number, row: unknown): Legend | null => {
      if (candleLike) {
        const raw = byTime.get(time);
        if (!raw) return null;
        return { time, items: itemsAt(time), lines: [`O ${axisPrice(raw.o)}  H ${axisPrice(raw.h)}  L ${axisPrice(raw.l)}  C ${axisPrice(raw.c)}`, volumeLine ? volumeLine(raw) : `${axisVolume(raw.volumeQu)} QU in ${raw.trades.toLocaleString("en-US")} trade${raw.trades === 1 ? "" : "s"}`] };
      }
      const v = (row as { value?: number } | undefined)?.value;
      return v === undefined ? null : { time, items: [], lines: [`${axisPrice(v)} ${priceUnit}`] };
    };
    const lineRows = candleLike ? [] : lineData(points);
    const last = () => {
      const t = candleLike ? [...byTime.keys()].sort((a, b) => a - b).pop() : lineRows[lineRows.length - 1]?.time;
      if (t === undefined) return null;
      return describe(t, candleLike ? undefined : lineRows[lineRows.length - 1]);
    };
    setLegend(last());
    const onCrosshair = (p: MouseEventParams<Time>) => {
      if (p.time === undefined) return setLegend(last());
      setLegend(describe(Number(p.time), p.seriesData.get(main)) ?? last());
    };
    chart.subscribeCrosshairMove(onCrosshair);

    // ---- saving a picture ------------------------------------------------------------------
    /**
     * The same chart built again off screen at k times the size (type, lines and drawings scaled with it) and photographed, so a 4K or 8K picture
     * is sharp, not a stretched screenshot. `width` is in real pixels: the chart is made `width / devicePixelRatio` page pixels across.
     */
    const shoot = async (width: number): Promise<HTMLCanvasElement> => {
      if (!width) return chart.takeScreenshot(true);
      const ratio = window.devicePixelRatio || 1;
      const w0 = el.clientWidth;
      const h0 = el.clientHeight;
      const k = width / ratio / w0;
      const w = Math.round(w0 * k);
      const h = Math.round(h0 * k);
      const host = document.createElement("div");
      host.style.cssText = `position:fixed;left:-200000px;top:0;width:${w}px;height:${h}px;pointer-events:none`;
      document.body.appendChild(host);
      try {
        const big = buildChart(host, { ...cfg, drawings: live.current.drawings ?? NO_DRAWINGS, selectedId: null }, colors, k, { w, h });
        const r = chart.timeScale().getVisibleLogicalRange();
        if (r) big.chart.timeScale().setVisibleLogicalRange(r);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const shot = big.chart.takeScreenshot(true);
        big.chart.remove();
        return shot;
      } finally {
        host.remove();
      }
    };
    onApi?.({
      fit: () => chart.timeScale().fitContent(),
      latest: () => chart.timeScale().scrollToRealTime(),
      screenshot: async (name, width = 0) => {
        const sizes = width ? SHOT_SIZES.filter((s) => s <= width) : [0];
        setWorking(width ? "Rendering the picture…" : "");
        try {
          let shot: HTMLCanvasElement | null = null;
          let used = 0;
          for (const s of sizes) {
            try {
              shot = await shoot(s);
              used = s;
              break;
            } catch {
              // too big for this browser: try the next size down
            }
          }
          if (!shot) throw new Error("This browser could not make a picture.");
          const out = document.createElement("canvas");
          const pad = Math.round(shot.width * 0.026);
          out.width = shot.width;
          out.height = shot.height + pad;
          const ctx = out.getContext("2d");
          if (!ctx) throw new Error("This browser could not make a picture.");
          // The background of the picture: the chart's own, a gradient as well if it has one (the chart itself is transparent over it).
          const grad = resolved.gradient;
          if (grad) {
            const g = ctx.createLinearGradient(0, 0, grad.dir === "vertical" ? 0 : out.width, grad.dir === "horizontal" ? 0 : out.height);
            g.addColorStop(0, grad.from);
            g.addColorStop(1, grad.to);
            ctx.fillStyle = g;
          } else ctx.fillStyle = colors.surface;
          ctx.fillRect(0, 0, out.width, out.height);
          const fs = Math.round(pad * 0.5);
          const left = Math.round(pad * 0.4);
          ctx.textBaseline = "middle";
          ctx.fillStyle = colors.fg;
          ctx.font = `600 ${fs}px ${resolved.fontFamily}`;
          ctx.fillText(symbol, left, pad / 2);
          const symW = ctx.measureText(symbol).width;
          ctx.fillStyle = colors.muted;
          ctx.font = `400 ${Math.round(fs * 0.85)}px ${resolved.fontFamily}`;
          ctx.fillText(`QMax  ·  ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, left + symW + fs, pad / 2);
          ctx.drawImage(shot, 0, pad);
          await new Promise<void>((res, rej) =>
            out.toBlob((blob) => {
              if (!blob) return rej(new Error("The picture was too large for this browser."));
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${name}${used ? `-${out.width}x${out.height}` : ""}.png`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 10_000);
              res();
            }, "image/png"),
          );
        } finally {
          setWorking("");
        }
      },
    });

    return () => {
      const r = chart.timeScale().getVisibleLogicalRange();
      if (r && gridT && !gridT.empty) saved.current = { key: viewKey, fromT: gridT.timeAt(r.from), toT: gridT.timeAt(r.to), atEnd: r.to >= lastIdx - 0.5, gap: r.to - lastIdx, width: r.to - r.from };
      onApi?.(null);
      chart.unsubscribeCrosshairMove(onCrosshair);
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", onKey, true);
      el.style.cursor = "";
      push.current = null;
      chartRef.current = null;
      chart.remove();
    };
    // `key` stands for the list of indicators, which is a new array each time but changes only when its contents do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, candles, intervalMs, points, theme, key, volume, epochs, resolved, scale, viewKey]);

  // Drawings and selection change without rebuilding the chart.
  useEffect(() => {
    push.current?.();
  }, [props.drawings, props.selectedId]);

  // A different tool: forget a half-placed drawing, and let the chart pan only while the cursor is the tool. A finished measurement stays on
  // screen after the tool goes back to the cursor (it is cleared by the next click, or Esc), but not when a drawing tool is picked.
  const tool = props.tool ?? "cursor";
  useEffect(() => {
    ui.current = { draft: null, measure: tool === "measure" || (tool === "cursor" && ui.current.measure?.done) ? ui.current.measure : null };
    chartRef.current?.applyOptions({ handleScroll: scrollOptions(tool === "cursor"), handleScale: tool === "cursor" });
    push.current?.();
  }, [tool]);

  return (
    <div className="lwchart-wrap" ref={wrap} tabIndex={-1} style={wrapStyle}>
      <div className="lw-legend" aria-live="off">
        <b>{symbol}</b>
        {legend && <span>{stamp(legend.time)}</span>}
        {legend?.lines.map((l, i) => (
          <span key={l} className={i === 0 ? "num" : "num vol"}>{l}</span>
        ))}
        {legend?.items.map((it) => (
          <span key={it.label} className="num lw-ind">
            <i style={{ background: it.color }} aria-hidden="true" />
            {it.label} <b>{it.text}</b>
          </span>
        ))}
        {working && <span className="shot-working" role="status">{working}</span>}
      </div>
      <div
        className={tool === "cursor" ? "lwchart" : "lwchart drawing"}
        style={{ "--lw-panes": paneCount } as React.CSSProperties}
        ref={box}
        role="img"
        aria-label={`${type === "line" ? "Price line" : type === "area" ? "Price area" : "Candles and volume"} for ${symbol}${wanted.length ? ` with ${wanted.join(", ")}` : ""}`}
      />
    </div>
  );
}
