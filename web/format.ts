/** 19460000000 becomes "19.46B"; small numbers keep their digits. For amounts of QU that run from a few to billions. */
export const compactQu = (x: number): string => (Math.abs(x) >= 1_000_000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(x) : Math.abs(x) >= 100 ? Math.round(x).toLocaleString("en-US") : x.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** 241235 becomes "241.2K", 2078713 "2.1M": a count of units in little room (a phone's order book). Under a thousand it is written out. */
export const compactUnits = (x: number): string => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(x);

/**
 * Prices for a phone's order book, where a price of 68,000,000 does not fit its column: from a million up they are written "68M", "59.5M", "2.75B"; below that, in full. Rows are
 * different prices, so two must never come out looking the same ("59,999,999" and "60,000,000" are both "60M" at two decimals): those get more digits, and if that is not enough,
 * the whole number.
 */
export function compactPrices(prices: number[]): string[] {
  const label = (p: number, digits: number) => (p >= 1_000_000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: digits }).format(p) : p.toLocaleString("en-US"));
  let out = prices.map((p) => label(p, 2));
  for (const digits of [3, 4, 6]) {
    const seen = new Map<string, number>();
    for (const t of out) seen.set(t, (seen.get(t) ?? 0) + 1);
    out = out.map((t, i) => (seen.get(t)! > 1 ? label(prices[i], digits) : t));
  }
  const seen = new Map<string, number>();
  for (const t of out) seen.set(t, (seen.get(t) ?? 0) + 1);
  return out.map((t, i) => (seen.get(t)! > 1 ? prices[i].toLocaleString("en-US") : t));
}

/** The sign always written: "+1.2M", "−340", "0". */
export const signedQu = (x: number): string => (Math.abs(x) < 0.5 ? "0" : `${x > 0 ? "+" : "−"}${compactQu(Math.abs(x))}`);

/** "+5.4%", "−12%": one decimal below 10, none from there. */
export const signedPct = (p: number): string => {
  const a = Math.abs(p);
  if (a < 0.05) return "0%";
  return `${p > 0 ? "+" : "−"}${a < 10 ? a.toFixed(1) : Math.round(a).toLocaleString("en-US")}%`;
};

export const shortDate = (ms: number): string => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
