import { useEffect, useState } from "react";
import { DEFAULT_VOL_WINDOW, VOL_WINDOWS, isVolWindow } from "../src/volwin.ts";
import type { VolWindow } from "../src/volwin.ts";

export { VOL_WINDOWS, busiestIn, changeOf, volLong, volumeOf } from "../src/volwin.ts";
export type { VolWindow } from "../src/volwin.ts";

const KEY = "qmax.volwindow";
const listeners = new Set<(w: VolWindow) => void>();

const read = (): VolWindow => {
  try {
    const v = window.localStorage.getItem(KEY);
    return isVolWindow(v) ? v : DEFAULT_VOL_WINDOW;
  } catch {
    return DEFAULT_VOL_WINDOW;
  }
};
let current: VolWindow | null = null;

/** The window the volume figures are shown over, remembered in this browser and the same everywhere on the page at once (the list, the trade header, the picker). */
export function useVolWindow(): [VolWindow, (w: VolWindow) => void] {
  const [w, setW] = useState<VolWindow>(() => (current ??= read()));
  useEffect(() => {
    listeners.add(setW);
    return () => void listeners.delete(setW);
  }, []);
  const set = (next: VolWindow) => {
    current = next;
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // not remembered: it still holds until the page is reloaded
    }
    listeners.forEach((f) => f(next));
  };
  return [w, set];
}

/** A small menu for the window, for a column heading. */
export function VolSelect({ value, onChange }: { value: VolWindow; onChange: (w: VolWindow) => void }) {
  return (
    <select className="volwin" value={value} onChange={(e) => onChange(e.target.value as VolWindow)} aria-label="Volume and change over" title="Show volume and price change over the last 24 hours, 72 hours or 7 days" onClick={(e) => e.stopPropagation()}>
      {VOL_WINDOWS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
    </select>
  );
}
