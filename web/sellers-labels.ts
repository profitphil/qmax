import type { OriginKey } from "../src/sellers.ts";

/** Shorter names for the holding-period rows, which share a narrow screen with a bar and a percentage. */
export const ORIGIN_LABELS: Record<OriginKey, string> = {
  week: "Bought in the last 7 days",
  month: "Bought 8–30 days earlier",
  quarter: "Bought 1–3 months earlier",
  year: "Bought 3–12 months earlier",
  older: "Held over a year",
  received: "Received by transfer",
};
