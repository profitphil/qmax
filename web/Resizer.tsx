import { useRef } from "react";
import { CENTER_MIN, WIDTH_LIMITS, applySavedWidths, saveWidth } from "./layout.ts";
import type { Panel } from "./layout.ts";
import { uiZoom } from "./media.ts";

const STEP = 16;

/**
 * The divider on the edge of a side panel: drag it (or use the arrow keys when it has focus) to make the panel wider or narrower; double-click puts it back. It
 * sits inside the panel it sizes (the watchlist, on its right edge; the trades-and-order rail, on its left). While dragging, the panel's width is written straight
 * to the workspace's CSS variable (the page is not re-drawn for it); it is remembered when the pointer is let go.
 */
export function Resizer({ panel }: { panel: Panel }) {
  const drag = useRef<{ x: number; start: number; zoom: number } | null>(null);
  const { min, max, cssVar } = WIDTH_LIMITS[panel];
  const app = () => document.querySelector<HTMLElement>(".app.terminal");
  const panelEl = (p: Panel) => document.querySelector<HTMLElement>(p === "watch" ? ".workspace > .watch" : ".trade.docked.bar .rail");
  /** A panel's width now, in the page's own pixels (inside a scaled-down workspace the screen shows less than that). */
  const widthOf = (p: Panel, zoom: number) => (panelEl(p)?.getBoundingClientRect().width ?? 0) / zoom;

  /** Sets the width (clamped: the panel's limits, and the chart's column keeps its minimum) and, if asked, remembers it. */
  const set = (px: number, remember: boolean) => {
    const a = app();
    if (!a) return;
    const zoom = uiZoom(a);
    const other = widthOf(panel === "watch" ? "rail" : "watch", zoom);
    const room = a.getBoundingClientRect().width / zoom - other - CENTER_MIN;
    const w = Math.round(Math.max(min, Math.min(max, room, px)));
    a.style.setProperty(cssVar, `${w}px`);
    if (remember) saveWidth(panel, w);
    return w;
  };

  const reset = () => {
    saveWidth(panel, null);
    const a = app();
    if (a) applySavedWidths(a);
  };

  return (
    <div
      className={`resizer resizer-${panel}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={panel === "watch" ? "Resize the asset list" : "Resize the trades and order panel"}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        const a = app();
        if (!a) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const zoom = uiZoom(a);
        drag.current = { x: e.clientX, start: widthOf(panel, zoom), zoom };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = (e.clientX - d.x) / d.zoom;
        set(panel === "watch" ? d.start + dx : d.start - dx, false);
      }}
      onPointerUp={() => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        document.body.classList.remove("resizing");
        set(widthOf(panel, d.zoom), true);
      }}
      onPointerCancel={() => {
        drag.current = null;
        document.body.classList.remove("resizing");
      }}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        const a = app();
        if (!a) return;
        const sign = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!sign) return;
        e.preventDefault();
        const w = widthOf(panel, uiZoom(a));
        set(w + (panel === "watch" ? sign : -sign) * STEP, true);
      }}
    />
  );
}
