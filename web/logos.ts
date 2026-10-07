import { useEffect, useState } from "react";
import { useTheme } from "./theme.ts";
import { logoFor } from "../src/logos.ts";
import type { LogoIndex } from "../src/logos.ts";

/** The asset logos QMax has a copy of: the index is read once, the first time a badge is drawn (see src/logos.ts). */
let index: LogoIndex | null | undefined; // undefined: not asked yet; null: could not be read
let pending = false;
const listeners = new Set<() => void>();

function load() {
  if (index !== undefined || pending) return;
  pending = true;
  fetch("/logos/index.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      index = j && typeof j.assets === "object" ? (j.assets as LogoIndex) : null;
    })
    .catch(() => {
      index = null;
    })
    .finally(() => {
      pending = false;
      listeners.forEach((f) => f());
    });
}

/** The logo to show for an asset right now (null until the index is in, and for an asset without one). */
export function useLogo(symbol: string, issuer?: string): string | null {
  const { theme } = useTheme();
  const [, bump] = useState(0);
  useEffect(() => {
    load();
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  return logoFor(index, symbol, issuer, theme);
}
