/**
 * Drawing tools for the price chart (trend lines, rays, horizontal and vertical lines, rectangles, Fibonacci retracements, a measuring tool):
 * what a drawing is, where it is on screen, whether a click is on it, and how it is kept. No chart library and no canvas in here, so it is tested in
 * Node; the chart's own layer (web/chart/drawings-primitive.ts) only draws what this works out.
 *
 * A drawing is fixed to times and prices (its anchors), not to pixels or candles, so it stays where it was drawn when the chart is zoomed, the
 * candles change width, or the price axis goes logarithmic. They are kept per asset in this browser.
 */

export const DRAW_KINDS = ["trend", "ray", "hline", "vline", "rect", "fib"] as const;
export type DrawKind = (typeof DRAW_KINDS)[number];
export const isDrawKind = (v: unknown): v is DrawKind => typeof v === "string" && (DRAW_KINDS as readonly string[]).includes(v);

/** A point on the chart: a time (seconds, UTC; may fall between candles or ahead of the last) and a price in QU. */
export interface Anchor {
  t: number;
  p: number;
}
export interface Drawing {
  id: string;
  kind: DrawKind;
  points: Anchor[];
  color: string;
}

/** How many clicks each tool takes. */
export const POINTS_NEEDED: Record<DrawKind, number> = { trend: 2, ray: 2, hline: 1, vline: 1, rect: 2, fib: 2 };

/** Colours that read on the dark and the light page. */
export const PALETTE: readonly { name: string; hex: string }[] = [
  { name: "Sky", hex: "#38bdf8" },
  { name: "Amber", hex: "#f5b73b" },
  { name: "Pink", hex: "#f472b6" },
  { name: "Green", hex: "#4ade80" },
  { name: "Violet", hex: "#a78bfa" },
  { name: "Grey", hex: "#94a3b8" },
];

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/**
 * Retracement levels for a move from `a` to `b`: 0 is where the move ended (b) and 1 where it began (a), so after a rise the levels run down
 * from the high, which is how they are read.
 */
export function fibLevels(a: Anchor, b: Anchor): { ratio: number; price: number }[] {
  return FIB_RATIOS.map((ratio) => ({ ratio, price: b.p - ratio * (b.p - a.p) }));
}

export interface Measure {
  /** Change in price, QU. */
  dPrice: number;
  /** Change in percent of the first price (0 when that is 0). */
  dPct: number;
  /** How many candles apart. */
  bars: number;
  /** How much time apart, in seconds (never negative). */
  seconds: number;
}

export function measureStats(a: Anchor, b: Anchor, stepSec: number): Measure {
  const dPrice = b.p - a.p;
  return { dPrice, dPct: a.p !== 0 ? (dPrice / Math.abs(a.p)) * 100 : 0, bars: Math.round(Math.abs(b.t - a.t) / (stepSec > 0 ? stepSec : 3600)), seconds: Math.abs(b.t - a.t) };
}

/** "3d 2h", "5h 30m", "45m": a span of time, with the two biggest units that apply. */
export function describeDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// ---------------------------------------------------------------------------------------------- geometry

export interface Px {
  x: number;
  y: number;
}
/** How anchors become screen positions (given by the chart; null where one cannot be placed), and how big the plot is. */
export interface Geo {
  x(t: number): number | null;
  y(p: number): number | null;
  w: number;
  h: number;
}

/** Distance from a point to a line segment. */
export function distToSegment(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The far end of a ray from `a` through `b`: well past the edge of the plot, so it is clipped by the canvas. */
export function rayEnd(a: Px, b: Px, w: number, h: number): Px {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return b;
  const reach = (Math.max(w, h) * 4 + Math.hypot(a.x, a.y)) / len;
  return { x: a.x + dx * reach, y: a.y + dy * reach };
}

/** Where a drawing's anchors are on screen, or null if any cannot be placed. */
export function anchorsPx(d: Drawing, geo: Geo): Px[] | null {
  const out: Px[] = [];
  for (const a of d.points) {
    const x = geo.x(a.t);
    const y = geo.y(a.p);
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push({ x, y });
  }
  return out;
}

export type Hit = { part: "handle"; index: number } | { part: "body" } | null;

/** Is `at` on this drawing (within `tol` pixels): on one of its handles (anchors), or on the drawing itself? Handles win. */
export function hitTest(d: Drawing, geo: Geo, at: Px, tol = 7): Hit {
  const px = anchorsPx(d, geo);
  if (!px) return null;
  if (d.kind !== "hline" && d.kind !== "vline") {
    for (let i = 0; i < px.length; i++) if (Math.hypot(at.x - px[i].x, at.y - px[i].y) <= tol + 2) return { part: "handle", index: i };
  }
  const [a, b] = px;
  switch (d.kind) {
    case "hline": return Math.abs(at.y - a.y) <= tol ? { part: "body" } : null;
    case "vline": return Math.abs(at.x - a.x) <= tol ? { part: "body" } : null;
    case "trend": return distToSegment(at, a, b) <= tol ? { part: "body" } : null;
    case "ray": return distToSegment(at, a, rayEnd(a, b, geo.w, geo.h)) <= tol ? { part: "body" } : null;
    case "rect": {
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      return at.x >= x0 - tol && at.x <= x1 + tol && at.y >= y0 - tol && at.y <= y1 + tol ? { part: "body" } : null;
    }
    case "fib": {
      if (distToSegment(at, a, b) <= tol) return { part: "body" };
      const left = Math.min(a.x, b.x);
      for (const l of fibLevels(d.points[0], d.points[1])) {
        const y = geo.y(l.price);
        if (y !== null && Math.abs(at.y - y) <= tol && at.x >= left - tol && at.x <= geo.w) return { part: "body" };
      }
      return null;
    }
  }
}

/** The drawing moved by a time and a price. */
export function translate(d: Drawing, dt: number, dp: number): Drawing {
  return { ...d, points: d.points.map((a) => ({ t: a.t + dt, p: a.p + dp })) };
}

/** One anchor moved to a new place (dragging a handle). */
export function moveAnchor(d: Drawing, index: number, to: Anchor): Drawing {
  return { ...d, points: d.points.map((a, i) => (i === index ? { ...to } : a)) };
}

// ---------------------------------------------------------------------------------------------- keeping them

const MAX_PER_ASSET = 60;
const MAX_ASSETS = 40;
const MAX_TIME = 4_102_444_800; // year 2100
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9]{1,32}$/;

let counter = 0;
export const newDrawingId = (): string => `d${Date.now().toString(36)}${(counter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

const sane = (a: unknown): a is Anchor => {
  const x = a as Partial<Anchor> | null;
  return typeof x === "object" && x !== null && typeof x.t === "number" && Number.isFinite(x.t) && x.t >= 0 && x.t <= MAX_TIME && typeof x.p === "number" && Number.isFinite(x.p) && Math.abs(x.p) < 1e15;
};

/** Drawings read back from storage (or anywhere else): only well-formed ones, at most 60. Anything odd is dropped, never trusted. */
export function sanitizeDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  const out: Drawing[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (out.length >= MAX_PER_ASSET) break;
    const d = r as Partial<Drawing> | null;
    if (typeof d !== "object" || d === null || !isDrawKind(d.kind) || !Array.isArray(d.points) || d.points.length !== POINTS_NEEDED[d.kind] || !d.points.every(sane)) continue;
    let id = typeof d.id === "string" && ID.test(d.id) && !seen.has(d.id) ? d.id : newDrawingId();
    while (seen.has(id)) id = newDrawingId();
    seen.add(id);
    out.push({ id, kind: d.kind, points: d.points.map((a) => ({ t: a.t, p: a.p })), color: typeof d.color === "string" && COLOR.test(d.color) ? d.color : PALETTE[0].hex });
  }
  return out;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const STORE_KEY = "qmax.chart.drawings.v1";

function readAll(store: KeyValueStore): Record<string, unknown> {
  try {
    const raw = JSON.parse(store.getItem(STORE_KEY) ?? "null");
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** This asset's saved drawings. Never throws (a blocked or full store just means none). */
export function loadDrawings(store: KeyValueStore | null, asset: string): Drawing[] {
  if (!store) return [];
  const all = readAll(store);
  return Object.hasOwn(all, asset) ? sanitizeDrawings(all[asset]) : [];
}

/** Saves this asset's drawings, keeping the 40 most recently saved assets. Never throws. */
export function saveDrawings(store: KeyValueStore | null, asset: string, list: Drawing[]): void {
  if (!store) return;
  try {
    const all = readAll(store);
    delete all[asset];
    if (list.length) all[asset] = sanitizeDrawings(list);
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) delete all[k];
    store.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // not saved: drawings still work for this visit
  }
}
