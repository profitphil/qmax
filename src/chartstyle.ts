import { paletteOf, rgbOf } from "./charttheme.ts";
import type { ChartThemeId } from "./charttheme.ts";
import { DEFAULT_CHART_THEME, isChartThemeId } from "./charttheme.ts";

/**
 * How the price chart looks, as the person set it up in the chart settings panel: a starting scheme (src/charttheme.ts) with their own choices
 * on top: colours for the background (flat or a gradient), candles, wicks, lines and grid, the type, and how thick and how faint things are.
 * Stored in this browser, so everything read back is checked again here (`sanitizeStyle`): a colour is a #rrggbb value and nothing else, a
 * number is clamped, a name is one of ours. `resolveStyle` turns it into what the chart is built from.
 */

export type GradientDir = "vertical" | "horizontal" | "diagonal";
export type GridLine = "default" | "solid" | "dotted" | "dashed";

/** Typefaces the chart can use. All of them are on the person's own computer: no font is downloaded for the chart. */
export const FONTS = [
  { id: "system", label: "System", stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  { id: "mono", label: "Monospace", stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" },
  { id: "serif", label: "Serif", stack: "Georgia, 'Times New Roman', Times, serif" },
  { id: "rounded", label: "Rounded", stack: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Nunito, system-ui, sans-serif" },
  { id: "condensed", label: "Condensed", stack: "'Arial Narrow', 'Helvetica Neue Condensed', 'Roboto Condensed', Arial, sans-serif" },
] as const;
export type FontId = (typeof FONTS)[number]["id"];

export interface ChartStyle {
  /** The starting scheme; the choices below are on top of it. */
  preset: ChartThemeId;
  /** Background: a colour (null = the scheme's), and optionally a gradient from it to a second colour. */
  bg: string | null;
  bgGradient: boolean;
  bg2: string | null;
  gradientDir: GradientDir;
  /** Text on the chart and its axes; the crosshair lines. Null = the scheme's. */
  text: string | null;
  crosshair: string | null;
  /** Rising and falling candles (and bars, and the volume under them). */
  up: string | null;
  down: string | null;
  /** Wicks the same colour as the candle, or colours of their own. */
  wicksMatch: boolean;
  wickUp: string | null;
  wickDown: string | null;
  /** Rising candles drawn as an outline only. */
  hollowUp: boolean;
  /** The line of the line chart, the edge of the area chart and the highlight colour. */
  line: string | null;
  /** How thick lines are, 1 to 4 (indicator lines and the price line). */
  lineWidth: number;
  /** The fading fill under an area chart's line. */
  areaFill: boolean;
  grid: string | null;
  gridVert: boolean;
  gridHorz: boolean;
  gridLine: GridLine;
  /** How strong the volume bars are, in percent. */
  volumeOpacity: number;
  /** The asset's name, large and very faint, behind the chart. */
  watermark: boolean;
  font: FontId;
  fontSize: number;
}

export const DEFAULT_STYLE: ChartStyle = {
  preset: DEFAULT_CHART_THEME,
  bg: null,
  bgGradient: false,
  bg2: null,
  gradientDir: "vertical",
  text: null,
  crosshair: null,
  up: null,
  down: null,
  wicksMatch: true,
  wickUp: null,
  wickDown: null,
  hollowUp: false,
  line: null,
  lineWidth: 2,
  areaFill: true,
  grid: null,
  gridVert: true,
  gridHorz: true,
  gridLine: "default",
  volumeOpacity: 45,
  watermark: true,
  font: "system",
  fontSize: 12,
};

const HEX = /^#[0-9a-f]{6}$/i;
const colour = (v: unknown): string | null => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : null);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const whole = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

/** Anything read back from storage (or anywhere else) becomes a style that is safe to use: unknown or broken parts take their defaults. */
export function sanitizeStyle(raw: unknown): ChartStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_STYLE;
  return {
    preset: isChartThemeId(r.preset) ? r.preset : d.preset,
    bg: colour(r.bg),
    bgGradient: bool(r.bgGradient, d.bgGradient),
    bg2: colour(r.bg2),
    gradientDir: oneOf(r.gradientDir, ["vertical", "horizontal", "diagonal"] as const, d.gradientDir),
    text: colour(r.text),
    crosshair: colour(r.crosshair),
    up: colour(r.up),
    down: colour(r.down),
    wicksMatch: bool(r.wicksMatch, d.wicksMatch),
    wickUp: colour(r.wickUp),
    wickDown: colour(r.wickDown),
    hollowUp: bool(r.hollowUp, d.hollowUp),
    line: colour(r.line),
    lineWidth: whole(r.lineWidth, 1, 4, d.lineWidth),
    areaFill: bool(r.areaFill, d.areaFill),
    grid: colour(r.grid),
    gridVert: bool(r.gridVert, d.gridVert),
    gridHorz: bool(r.gridHorz, d.gridHorz),
    gridLine: oneOf(r.gridLine, ["default", "solid", "dotted", "dashed"] as const, d.gridLine),
    volumeOpacity: whole(r.volumeOpacity, 10, 90, d.volumeOpacity),
    watermark: bool(r.watermark, d.watermark),
    font: oneOf(r.font, FONTS.map((f) => f.id), d.font),
    fontSize: whole(r.fontSize, 10, 16, d.fontSize),
  };
}

/** True when any choice differs from the plain defaults (the scheme counts). */
export const isCustomised = (s: ChartStyle): boolean => JSON.stringify(sanitizeStyle(s)) !== JSON.stringify(DEFAULT_STYLE);

/** The colours the chart can start from: the page's own, read from the page. All as "rgb(r, g, b)". */
export interface BaseColors {
  muted: string;
  fg: string;
  surface: string;
  surface3: string;
  grid: string;
  up: string;
  down: string;
  accent: string;
}

export interface ResolvedStyle {
  colors: BaseColors & { crosshair: string };
  wickUp: string;
  wickDown: string;
  hollowUp: boolean;
  /** The CSS background of the chart's frame; null means the page's own. */
  bgCss: string | null;
  fontFamily: string;
  fontSize: number;
  lineWidth: number;
  areaFill: boolean;
  gridVert: boolean;
  gridHorz: boolean;
  gridLine: GridLine;
  watermark: boolean;
  /** 0 to 1. */
  volumeOpacity: number;
  /** The two ends of a gradient background, when there is one (for a picture, which is not drawn with CSS). */
  gradient: { from: string; to: string; dir: GradientDir } | null;
}

type Rgb = [number, number, number];
/** "rgb(1, 2, 3)", "rgba(1, 2, 3, 0.5)" or "#rrggbb" as numbers; null if it is none of those. */
export function parseRgb(c: string): Rgb | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim());
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const m = /^rgba?\(([^)]+)\)$/.exec(c.trim());
  if (!m) return null;
  const p = m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number);
  return p.length === 3 && p.every((v) => Number.isFinite(v)) ? [p[0], p[1], p[2]] : null;
}
const rgbStr = ([r, g, b]: Rgb) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** A colour as #rrggbb, for a colour input (which only takes that form). Black for anything that cannot be read. */
export function hexOf(c: string): string {
  const p = parseRgb(c);
  return p ? `#${hex2(p[0])}${hex2(p[1])}${hex2(p[2])}` : "#000000";
}

/** `t` of the way from `a` to `b` (0 is a, 1 is b). */
export function mix(a: string, b: string, t: number): string {
  const x = parseRgb(a) ?? [0, 0, 0];
  const y = parseRgb(b) ?? [0, 0, 0];
  return rgbStr([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

const ANGLE: Record<GradientDir, string> = { vertical: "180deg", horizontal: "90deg", diagonal: "135deg" };

export const fontStack = (id: FontId): string => FONTS.find((f) => f.id === id)?.stack ?? FONTS[0].stack;

/** The chart's colours and settings from the page's colours, the scheme and the person's choices (in that order, each over the last). */
export function resolveStyle(base: BaseColors, input: ChartStyle): ResolvedStyle {
  const s = sanitizeStyle(input);
  const p = paletteOf(s.preset);
  let c: BaseColors = p
    ? { muted: rgbOf(p.muted), fg: rgbOf(p.fg), surface: rgbOf(p.bg), surface3: rgbOf(p.raised), grid: rgbOf(p.grid), up: rgbOf(p.up), down: rgbOf(p.down), accent: rgbOf(p.accent) }
    : { ...base };
  if (s.bg) c = { ...c, surface: rgbOf(s.bg), surface3: mix(rgbOf(s.bg), c.fg, 0.12) };
  if (s.text) c = { ...c, fg: rgbOf(s.text), muted: mix(rgbOf(s.text), c.surface, 0.35) };
  if (s.up) c = { ...c, up: rgbOf(s.up) };
  if (s.down) c = { ...c, down: rgbOf(s.down) };
  if (s.line) c = { ...c, accent: rgbOf(s.line) };
  if (s.grid) c = { ...c, grid: rgbOf(s.grid) };
  const crosshair = s.crosshair ? rgbOf(s.crosshair) : c.muted;

  // The frame behind the chart: the page's own unless the scheme, a colour or a gradient says otherwise.
  const custom = p !== null || s.bg !== null || s.bgGradient;
  let gradient: ResolvedStyle["gradient"] = null;
  let bgCss: string | null = null;
  if (custom) {
    if (s.bgGradient) {
      const to = s.bg2 ? rgbOf(s.bg2) : mix(c.surface, c.accent, 0.22);
      gradient = { from: c.surface, to, dir: s.gradientDir };
      bgCss = `linear-gradient(${ANGLE[s.gradientDir]}, ${c.surface}, ${to})`;
    } else bgCss = c.surface;
  }
  return {
    colors: { ...c, crosshair },
    wickUp: s.wicksMatch ? c.up : s.wickUp ? rgbOf(s.wickUp) : c.up,
    wickDown: s.wicksMatch ? c.down : s.wickDown ? rgbOf(s.wickDown) : c.down,
    hollowUp: s.hollowUp,
    bgCss,
    fontFamily: fontStack(s.font),
    fontSize: s.fontSize,
    lineWidth: s.lineWidth,
    areaFill: s.areaFill,
    gridVert: s.gridVert,
    gridHorz: s.gridHorz,
    gridLine: s.gridLine,
    watermark: s.watermark,
    volumeOpacity: s.volumeOpacity / 100,
    gradient,
  };
}

/** What the chart is built with when nothing was chosen: the page's colours and the original look. */
export const plainResolved = (base: BaseColors): ResolvedStyle => resolveStyle(base, DEFAULT_STYLE);
