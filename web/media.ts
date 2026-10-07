import { useEffect, useState } from "react";

/** Whether a CSS media query matches right now, kept up to date as the window changes. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** The narrowest window that gets the workspace (watchlist, chart and order ticket side by side) instead of a list that opens a dialog. */
export const WORKSPACE_MIN = 1000;
export const WORKSPACE_QUERY = `(min-width: ${WORKSPACE_MIN}px)`;
/**
 * The width the workspace is laid out for. A window between WORKSPACE_MIN and this gets the same layout scaled down to fit, as if the browser were zoomed out,
 * so a half-screen window still shows all three panels at their proper proportions instead of a cramped column.
 */
export const WORKSPACE_WIDTH = 1260;

/** How far the workspace is scaled down for this window (1 from WORKSPACE_WIDTH up, and always 1 when it is not the workspace). */
export function useWorkspaceScale(active: boolean): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? WORKSPACE_WIDTH : window.innerWidth));
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return active ? Math.min(1, width / WORKSPACE_WIDTH) : 1;
}

/** The scale the workspace is drawn at around this element (1 when it is not scaled down): lengths measured inside it are in its scaled-up units. */
export function uiZoom(el: Element): number {
  const v = parseFloat(getComputedStyle(el).getPropertyValue("--ui-zoom"));
  return v > 0 ? v : 1;
}
