/** 19460000000 becomes "19.46B"; small numbers keep their digits. For amounts of QU that run from a few to billions. */
export const compactQu = (x: number): string => (Math.abs(x) >= 1_000_000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(x) : Math.abs(x) >= 100 ? Math.round(x).toLocaleString("en-US") : x.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** The sign always written: "+1.2M", "−340", "0". */
export const signedQu = (x: number): string => (Math.abs(x) < 0.5 ? "0" : `${x > 0 ? "+" : "−"}${compactQu(Math.abs(x))}`);

/** "+5.4%", "−12%": one decimal below 10, none from there. */
export const signedPct = (p: number): string => {
  const a = Math.abs(p);
  if (a < 0.05) return "0%";
  return `${p > 0 ? "+" : "−"}${a < 10 ? a.toFixed(1) : Math.round(a).toLocaleString("en-US")}%`;
};

export const shortDate = (ms: number): string => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
