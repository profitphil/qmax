import { routeSaving, savingHeadline } from "./savings.ts";

/**
 * A quote said in words. A quote's JSON is exact, but a person or an AI assistant asking "what would I get for 50 million of this?" does better with the answer written out: the total, the
 * average, which markets the order goes to, what the splitting is worth, and that a quote is only a snapshot. Software that wants the numbers uses the fields; this is for everyone who reads.
 */
export interface QuoteSummaryInput {
  asset: string;
  side: "buy" | "sell";
  qty: number;
  filledQty: number;
  fillable: boolean;
  totalQu: number;
  averagePriceQu: number | null;
  route: { venue: string; qty: number; totalQu: number }[];
  alternatives: { venue: string; fillable: boolean; totalQu: number | null }[];
}

const n = (x: number) => Math.round(x).toLocaleString("en-US");
const avg = (x: number) => (x >= 100 ? n(x) : x.toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function quoteSummary(q: QuoteSummaryInput): string {
  const buy = q.side === "buy";
  if (!q.fillable) {
    if (q.filledQty > 0 && q.route.length)
      return `Only ${n(q.filledQty)} of the ${n(q.qty)} ${q.asset} could be ${buy ? "bought" : "sold"} with the liquidity on QX and QSwap right now, for about ${n(q.totalQu)} QU. Try a smaller amount.`;
    return `${q.asset} cannot be ${buy ? "bought" : "sold"} in that amount on QX or QSwap right now: there is not enough liquidity. Try a smaller amount.`;
  }
  const legs = q.route.length === 1 ? `all on ${q.route[0].venue}` : `split ${q.route.map((r) => `${n(r.qty)} on ${r.venue} (${n(r.totalQu)} QU)`).join(" and ")}`;
  const worth = routeSaving({ side: q.side, totalQu: q.totalQu, fillable: q.fillable, route: q.route, alternatives: q.alternatives });
  const saving = worth ? savingHeadline(worth) : null;
  return [
    `${buy ? "Buying" : "Selling"} ${n(q.qty)} ${q.asset} by the best route would ${buy ? "cost" : "return"} about ${n(q.totalQu)} QU${q.averagePriceQu !== null ? ` (${avg(q.averagePriceQu)} QU each on average, fees included)` : ""}, ${legs}.`,
    ...(saving ? [saving] : []),
    "A quote is a snapshot: prices move, so quote again before signing.",
  ].join(" ");
}
