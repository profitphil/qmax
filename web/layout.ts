/**
 * The workspace's side panels can be resized by dragging the dividers (see Resizer). What a person chose is remembered in this browser (a convenience: a blocked
 * store changes nothing). The width is kept in the page's own pixels, and applied as a CSS variable on the workspace, capped to a share of the width so a window
 * made smaller later never squeezes the chart away.
 */
export type Panel = "watch" | "rail";

/** The narrowest and widest each panel can be made, and the share of its container it may take. */
export const WIDTH_LIMITS: Record<Panel, { min: number; max: number; share: number; key: string; cssVar: string }> = {
  watch: { min: 280, max: 560, share: 0.4, key: "qmax.layout.watch", cssVar: "--watch-w" },
  rail: { min: 320, max: 680, share: 0.5, key: "qmax.layout.rail", cssVar: "--rail-w" },
};
/** The chart's column never gets narrower than this when a divider is dragged. */
export const CENTER_MIN = 380;

export function savedWidth(panel: Panel): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_LIMITS[panel].key));
    const { min, max } = WIDTH_LIMITS[panel];
    return Number.isFinite(v) && v >= min && v <= max ? v : null;
  } catch {
    return null;
  }
}

export function saveWidth(panel: Panel, px: number | null) {
  try {
    if (px === null) localStorage.removeItem(WIDTH_LIMITS[panel].key);
    else localStorage.setItem(WIDTH_LIMITS[panel].key, String(Math.round(px)));
  } catch {
    // not remembered: it still holds until the page is reloaded
  }
}

/** The CSS value for a chosen width: that many pixels, but never more than the panel's share of its container. */
export const widthValue = (panel: Panel, px: number) => `min(${Math.round(px)}px, ${WIDTH_LIMITS[panel].share * 100}%)`;

/** Puts what was chosen on the workspace element (leaving the stylesheet's default for a panel that was never resized). */
export function applySavedWidths(app: HTMLElement) {
  for (const panel of ["watch", "rail"] as const) {
    const px = savedWidth(panel);
    if (px === null) app.style.removeProperty(WIDTH_LIMITS[panel].cssVar);
    else app.style.setProperty(WIDTH_LIMITS[panel].cssVar, widthValue(panel, px));
  }
}
