/**
 * Colour schemes for the price chart, chosen separately from the page's light or dark theme (a chart is something people set up the way they like to
 * read it). "match" follows the page; the others are fixed palettes that look the same whichever theme the page is in. Pure data, so a test can hold
 * every scheme to a readable contrast.
 */
export interface ChartPalette {
  /** The chart's background. */
  bg: string;
  /** Text and the strongest lines. */
  fg: string;
  /** Axis labels and quiet text. */
  muted: string;
  /** The base of the grid lines (the chart makes them faint). */
  grid: string;
  /** Rising candles and buying volume. */
  up: string;
  /** Falling candles and selling volume. */
  down: string;
  /** Lines (the price line, drawings' highlight) and the area fill. */
  accent: string;
  /** A little lighter than the background: labels on the crosshair. */
  raised: string;
}

export interface ChartThemeDef {
  id: string;
  label: string;
  /** Null for "match": the page's own colours. */
  palette: ChartPalette | null;
}

export const CHART_THEMES = [
  { id: "match", label: "Match the page", palette: null },
  { id: "classic", label: "Classic", palette: { bg: "#131722", fg: "#d1d4dc", muted: "#787b86", grid: "#94a3b8", up: "#26a69a", down: "#ef5350", accent: "#2962ff", raised: "#2a2e39" } },
  { id: "midnight", label: "Midnight", palette: { bg: "#0b0e11", fg: "#eaecef", muted: "#848e9c", grid: "#94a3b8", up: "#0ecb81", down: "#f6465d", accent: "#f0b90b", raised: "#1e2329" } },
  { id: "amber", label: "Amber", palette: { bg: "#0d0a00", fg: "#ffcc66", muted: "#a8832f", grid: "#c8962a", up: "#ffb000", down: "#c25400", accent: "#ffd24d", raised: "#2a2000" } },
  { id: "bluorange", label: "Blue and orange", palette: { bg: "#14181f", fg: "#e6edf3", muted: "#8b949e", grid: "#94a3b8", up: "#3b8eea", down: "#f2a03d", accent: "#a371f7", raised: "#262c36" } },
  { id: "paper", label: "Paper", palette: { bg: "#ffffff", fg: "#1f2328", muted: "#656d76", grid: "#64748b", up: "#2da44e", down: "#cf222e", accent: "#0969da", raised: "#e6e8eb" } },
  { id: "mono", label: "Mono", palette: { bg: "#111111", fg: "#f0f0f0", muted: "#8a8a8a", grid: "#8a8a8a", up: "#f0f0f0", down: "#6a6a6a", accent: "#bdbdbd", raised: "#262626" } },
] as const satisfies readonly ChartThemeDef[];

export type ChartThemeId = (typeof CHART_THEMES)[number]["id"];
export const DEFAULT_CHART_THEME: ChartThemeId = "match";
export const isChartThemeId = (v: unknown): v is ChartThemeId => CHART_THEMES.some((t) => t.id === v);

/** The palette of a scheme, or null for "match the page". */
export const paletteOf = (id: ChartThemeId): ChartPalette | null => (CHART_THEMES.find((t) => t.id === id)?.palette as ChartPalette | null | undefined) ?? null;

/** #rrggbb as "rgb(r, g, b)", the form the chart's colour helpers (which add transparency) work with. */
export function rgbOf(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}
