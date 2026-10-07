/**
 * What to say when there is no trade to show. "No trades yet" does not say since when, and the live feed does not always go back a full day (it starts when the
 * server could first read the chain), so the words name the period: the last 24 hours, or since the moment the feed began.
 */

/** A moment for a sentence: just the time when it was today, the date and time otherwise. */
export function sinceLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const today = new Date(now);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `${time} today`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

export interface QuietInput {
  /** The asset's name, or none for every asset. */
  asset?: string;
  /** The feed does not cover the whole last day. */
  partial: boolean;
  /** Where the feed's coverage starts (ms since epoch), when known. */
  coveredFromMs: number | null;
  now: number;
}

export interface QuietWords {
  /** A short line: "No trades in the last 24 hours". */
  headline: string;
  /** A full sentence for an empty list. */
  detail: string;
}

export function quietWords(i: QuietInput): QuietWords {
  const what = i.asset ? `of ${i.asset} ` : "";
  if (i.partial && i.coveredFromMs !== null) {
    const since = sinceLabel(i.coveredFromMs, i.now);
    return {
      headline: `No trades ${what}since ${since}`,
      detail: `${i.asset ? `${i.asset} has not` : "Nothing has"} traded on QX or QSwap since QMax's live feed began, at ${since}. It could not read earlier than that, so there may be older trades.`,
    };
  }
  return {
    headline: `No trades ${what}in the last 24 hours`,
    detail: `${i.asset ? `${i.asset} has not` : "Nothing has"} traded on QX or QSwap in the last 24 hours. A new trade shows here as soon as it happens.`,
  };
}
