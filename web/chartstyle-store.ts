import { DEFAULT_STYLE, sanitizeStyle } from "../src/chartstyle.ts";
import type { ChartStyle } from "../src/chartstyle.ts";
import { isChartThemeId } from "../src/charttheme.ts";

/** Where the chart settings are kept in this browser (a convenience: a blocked store changes nothing). */
const STYLE_KEY = "qmax.chart.style.v1";
/** The older entry, which held a colour scheme before the settings panel existed: it is carried over once. */
const OLD_PREFS_KEY = "qmax.chart.prefs.v2";

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function loadStyle(): ChartStyle {
  try {
    const raw = storage()?.getItem(STYLE_KEY);
    if (raw) return sanitizeStyle(JSON.parse(raw));
    const old = JSON.parse(storage()?.getItem(OLD_PREFS_KEY) ?? "null") as { theme?: unknown } | null;
    if (old && isChartThemeId(old.theme) && old.theme !== "match") return { ...DEFAULT_STYLE, preset: old.theme };
  } catch {
    // unreadable: the plain look
  }
  return DEFAULT_STYLE;
}

export function saveStyle(s: ChartStyle): void {
  try {
    storage()?.setItem(STYLE_KEY, JSON.stringify(s));
  } catch {
    // not remembered
  }
}
