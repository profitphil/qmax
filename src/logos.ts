/**
 * The asset logos QMax has a copy of (`npm run logos` saves them in web/public/logos from qubictrade.com), by symbol. An asset with no logo of its own, or one the
 * site only has a placeholder for, is not in the index and keeps its lettered badge.
 */
export interface LogoEntry {
  issuer: string;
  light?: string;
  dark?: string;
}
export type LogoIndex = Record<string, LogoEntry[]>;

/** The picture for an asset, for the page's theme, or null. Without an issuer the symbol must belong to one asset only. */
export function logoFor(idx: LogoIndex | null | undefined, symbol: string, issuer: string | undefined, theme: "light" | "dark"): string | null {
  const list = idx?.[symbol];
  if (!list || list.length === 0) return null;
  const entry = issuer ? list.find((e) => e.issuer === issuer) : list.length === 1 ? list[0] : undefined;
  const file = entry ? (theme === "dark" ? entry.dark ?? entry.light : entry.light ?? entry.dark) : undefined;
  return file ? `/logos/${file}` : null;
}
