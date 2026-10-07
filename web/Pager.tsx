import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UIEvent } from "react";

/**
 * The screens of the small-screen layout, left to right as the columns of the workspace are: the list of assets, the chart, and the latest trades with the order
 * panel; then, past those, the portfolio (what you hold, your orders and history, the pools and the swap). They sit in one row that is swiped sideways; the chart is the one it opens on.
 */
export const PANES = [
  { id: "assets", label: "Assets" },
  { id: "chart", label: "Chart" },
  { id: "trade", label: "Trades & order" },
  { id: "portfolio", label: "Portfolio" },
] as const;
export const CHART_PANE = 1;
export const ORDER_PANE = 2;

/**
 * The row of screens: which one is showing, and a way to go to another. `active` is false on a wide window, where the three are side by side instead.
 * Put `ref`, `onScroll` on the element that scrolls (the row), one screen being as wide as it is.
 */
export function usePager(active: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [pane, setPane] = useState(CHART_PANE);
  const now = useRef(CHART_PANE);
  /** Until this time the screen is sliding to the one asked for, so the screens it passes on the way do not count as where it is. */
  const sliding = useRef(0);
  const go = useCallback((i: number, smooth = true) => {
    const el = ref.current;
    if (!el) return;
    now.current = i;
    setPane(i);
    const still = !smooth || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    sliding.current = still ? 0 : Date.now() + 700;
    el.scrollTo({ left: i * el.clientWidth, behavior: still ? "auto" : "smooth" });
  }, []);
  // It opens on the chart, and a turned phone stays on the screen it was on.
  useLayoutEffect(() => {
    if (active) go(CHART_PANE, false);
  }, [active, go]);
  useEffect(() => {
    if (!active) return;
    const keep = () => go(now.current, false);
    window.addEventListener("resize", keep);
    return () => window.removeEventListener("resize", keep);
  }, [active, go]);
  const onScroll = useCallback((e: UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (!el.clientWidth || Date.now() < sliding.current) return;
    const i = Math.min(PANES.length - 1, Math.max(0, Math.round(el.scrollLeft / el.clientWidth)));
    now.current = i;
    setPane(i);
  }, []);
  return { ref, pane, go, onScroll };
}

/** The strip along the bottom that says which screen this is and goes to another with a tap (a swipe does the same). */
export function PagerTabs({ pane, onGo }: { pane: number; onGo: (i: number) => void }) {
  return (
    <nav className="pager-tabs" aria-label="Screens: swipe sideways or tap">
      {PANES.map((p, i) => (
        <button key={p.id} type="button" className={i === pane ? "on" : ""} aria-current={i === pane ? "page" : undefined} onClick={() => onGo(i)}>
          {p.label}
        </button>
      ))}
    </nav>
  );
}
