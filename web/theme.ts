import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "qmax.theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage blocked: follow the system
  }
}

const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
let pref: ThemePref = readPref();
const listeners = new Set<() => void>();

const resolve = (): Theme => (pref === "system" ? (media?.matches ? "light" : "dark") : pref);

function apply() {
  const t = resolve();
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#f4f7fb" : "#070a0f");
}

function emit() {
  apply();
  listeners.forEach((l) => l());
}

media?.addEventListener?.("change", () => {
  if (pref === "system") emit();
});

export function setTheme(next: ThemePref) {
  pref = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // the choice then lasts until the page is closed
  }
  emit();
}

apply();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The theme in use ("light" or "dark") and a way to flip it. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, resolve, () => "dark" as Theme);
  return { theme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") };
}
