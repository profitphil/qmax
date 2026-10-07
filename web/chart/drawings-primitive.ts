import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, PrimitivePaneViewZOrder, SeriesAttachedParameter, Time } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { FIB_RATIOS, anchorsPx, describeDuration, fibLevels, measureStats, rayEnd } from "../../src/drawings.ts";
import type { Anchor, DrawKind, Drawing, Geo, Px } from "../../src/drawings.ts";
import { axisPrice } from "../../src/lwdata.ts";

/**
 * Draws the chart's drawings (src/drawings.ts) on top of the candles, as a primitive attached to the price series, so they move and scale with
 * the chart and are in its screenshots. It only draws what it is told; the pointer handling that creates and edits them is in LwChart.
 */

export interface Draft {
  kind: DrawKind;
  color: string;
  /** Clicked so far. */
  points: Anchor[];
  /** Where the pointer is now (the point being placed). */
  cursor: Anchor | null;
}
export interface DrawState {
  drawings: Drawing[];
  selectedId: string | null;
  draft: Draft | null;
  /** A measurement being shown (the measuring tool leaves no drawing behind). */
  measure: { a: Anchor; b: Anchor; stepSec: number; /** Both ends are placed (otherwise the second follows the pointer). */ done: boolean } | null;
  /** Colours of the page, for the labels. */
  ink: { text: string; bg: string; up: string; down: string };
}

export const EMPTY_STATE: DrawState = { drawings: [], selectedId: null, draft: null, measure: null, ink: { text: "#e6e8f5", bg: "rgba(20,22,40,0.85)", up: "#4ade80", down: "#f87171" } };

/** A colour (#rrggbb, or the page's rgb()/rgba()) with the given opacity. */
const withAlpha = (color: string, a: number) => {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hex) return `rgba(${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ${parseInt(hex[3], 16)}, ${a})`;
  const rgb = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (rgb) return `rgba(${rgb[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).join(", ")}, ${a})`;
  return color;
};

type Ctx = CanvasRenderingContext2D;

function label(ctx: Ctx, text: string, x: number, y: number, ink: DrawState["ink"], align: "left" | "right" | "center" = "left", fill?: string) {
  ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
  const w = ctx.measureText(text).width + 10;
  const left = align === "left" ? x : align === "right" ? x - w : x - w / 2;
  ctx.fillStyle = fill ?? ink.bg;
  ctx.beginPath();
  ctx.roundRect(left, y - 9, w, 18, 4);
  ctx.fill();
  ctx.fillStyle = ink.text;
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + 5, y);
}

function handle(ctx: Ctx, p: Px, color: string) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function drawOne(ctx: Ctx, d: Drawing, geo: Geo, selected: boolean, ink: DrawState["ink"], preview = false) {
  const px = anchorsPx(d, geo);
  if (!px) return;
  const [a, b] = px;
  ctx.save();
  ctx.lineWidth = selected ? 2.5 : 1.75;
  ctx.strokeStyle = d.color;
  ctx.fillStyle = d.color;
  if (preview) ctx.setLineDash([5, 4]);
  switch (d.kind) {
    case "trend":
    case "ray": {
      const end = d.kind === "ray" ? rayEnd(a, b, geo.w, geo.h) : b;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      break;
    }
    case "hline":
      ctx.beginPath();
      ctx.moveTo(0, a.y);
      ctx.lineTo(geo.w, a.y);
      ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, axisPrice(d.points[0].p), geo.w - 4, a.y, ink, "right", withAlpha(d.color, 0.9));
      break;
    case "vline":
      ctx.beginPath();
      ctx.moveTo(a.x, 0);
      ctx.lineTo(a.x, geo.h);
      ctx.stroke();
      break;
    case "rect":
      ctx.fillStyle = withAlpha(d.color, 0.12);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      break;
    case "fib": {
      const left = Math.min(a.x, b.x);
      const levels = fibLevels(d.points[0], d.points[1]).map((l) => ({ ...l, y: geo.y(l.price) }));
      // Light bands between neighbouring levels, then the lines and their labels.
      levels.forEach((l, i) => {
        const next = levels[i + 1];
        if (l.y === null || !next || next.y === null) return;
        ctx.fillStyle = withAlpha(d.color, i % 2 ? 0.05 : 0.1);
        ctx.fillRect(left, Math.min(l.y, next.y), geo.w - left, Math.abs(next.y - l.y));
      });
      ctx.lineWidth = selected ? 2 : 1.25;
      for (const l of levels) {
        if (l.y === null) continue;
        ctx.setLineDash(l.ratio === 0 || l.ratio === 1 ? [] : [4, 3]);
        ctx.beginPath();
        ctx.moveTo(left, l.y);
        ctx.lineTo(geo.w, l.y);
        ctx.stroke();
        ctx.setLineDash([]);
        label(ctx, `${l.ratio} · ${axisPrice(l.price)}`, left + 4, l.y - 11, ink, "left", withAlpha(d.color, 0.85));
      }
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
  if (selected && !preview) {
    if (d.kind !== "hline" && d.kind !== "vline") for (const p of px) handle(ctx, p, d.color);
    else handle(ctx, d.kind === "hline" ? { x: geo.w / 2, y: a.y } : { x: a.x, y: geo.h / 2 }, d.color);
  }
}

function drawMeasure(ctx: Ctx, m: NonNullable<DrawState["measure"]>, geo: Geo, ink: DrawState["ink"]) {
  const x1 = geo.x(m.a.t);
  const y1 = geo.y(m.a.p);
  const x2 = geo.x(m.b.t);
  const y2 = geo.y(m.b.p);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return;
  const s = measureStats(m.a, m.b, m.stepSec);
  const color = s.dPrice >= 0 ? ink.up : ink.down;
  ctx.save();
  ctx.fillStyle = withAlpha(color, 0.12);
  ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
  const sign = s.dPrice >= 0 ? "+" : "";
  const text = `${sign}${axisPrice(s.dPrice)} QU (${sign}${s.dPct.toFixed(2)}%) · ${s.bars} candle${s.bars === 1 ? "" : "s"} · ${describeDuration(s.seconds)}`;
  const mx = Math.min(Math.max((x1 + x2) / 2, 120), geo.w - 120);
  const my = Math.min(y1, y2) - 14 < 12 ? Math.max(y1, y2) + 16 : Math.min(y1, y2) - 14;
  label(ctx, text, mx, my, ink, "center", withAlpha(color, 0.9));
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  state: DrawState = EMPTY_STATE;
  /** Set by the chart: how times and prices become pixels. Null until it has data. */
  mapper: { x(t: number): number | null; y(p: number): number | null } | null = null;
  /** How many times bigger everything is drawn than on screen (for a picture in 4K or 8K): the shapes are the same, scaled. */
  k = 1;
  private redraw: (() => void) | null = null;
  private plot = { w: 0, h: 0 };

  attached(p: SeriesAttachedParameter<Time>): void {
    this.redraw = p.requestUpdate;
  }
  detached(): void {
    this.redraw = null;
  }
  set(next: DrawState): void {
    this.state = next;
    this.redraw?.();
  }
  refresh(): void {
    this.redraw?.();
  }
  /** The geometry for hit-testing, from the last drawn size. */
  geo(): Geo | null {
    return this.mapper ? { x: this.mapper.x, y: this.mapper.y, w: this.plot.w, h: this.plot.h } : null;
  }

  private view: IPrimitivePaneView = {
    zOrder: (): PrimitivePaneViewZOrder => "top",
    renderer: (): IPrimitivePaneRenderer | null => ({
      draw: (target: CanvasRenderingTarget2D) => {
        const m = this.mapper;
        if (!m) return;
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          const k = this.k;
          this.plot = { w: mediaSize.width, h: mediaSize.height };
          // At k times the size, everything is worked out as if on screen and then scaled up, so lines, type and handles keep their proportions.
          const geo: Geo = { x: (t) => { const v = m.x(t); return v === null ? null : v / k; }, y: (p) => { const v = m.y(p); return v === null ? null : v / k; }, w: mediaSize.width / k, h: mediaSize.height / k };
          const st = this.state;
          context.save();
          if (k !== 1) context.scale(k, k);
          context.beginPath();
          context.rect(0, 0, geo.w, geo.h);
          context.clip();
          for (const d of st.drawings) drawOne(context, d, geo, d.id === st.selectedId, st.ink);
          if (st.draft) {
            const pts = st.draft.cursor ? [...st.draft.points, st.draft.cursor] : st.draft.points;
            if (st.draft.kind === "hline" || st.draft.kind === "vline" ? pts.length >= 1 : pts.length >= 2) {
              drawOne(context, { id: "draft", kind: st.draft.kind, color: st.draft.color, points: pts.slice(0, st.draft.kind === "hline" || st.draft.kind === "vline" ? 1 : 2) }, geo, false, st.ink, true);
            }
          }
          if (st.measure) drawMeasure(context, st.measure, geo, st.ink);
          context.restore();
        });
      },
    }),
  };

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }
}

export { FIB_RATIOS };
