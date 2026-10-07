import { FLAG_LABEL, GRADE_LABEL } from "./health-api.ts";
import type { Grade, HealthFlag } from "./health-api.ts";

/** What a badge needs: `/v1/health/all` gives the first four (and `reason`), `/v1/health` gives `reasons` and `partial` too. */
export interface BadgeHealth {
  grade: Grade;
  score: number;
  flags: HealthFlag[];
  reason?: string;
  reasons?: string[];
  partial?: boolean;
}

/** The sentence a hover shows: the grade, the score, and the most important reason (or, failing that, the flags). */
function badgeText(h: BadgeHealth): string {
  const why = h.reason ?? h.reasons?.[0] ?? h.flags.map((f) => FLAG_LABEL[f].label).join(", ");
  return `${GRADE_LABEL[h.grade]}: ${h.score} out of 100${h.partial ? " (an estimate: some data was missing)" : ""}.${why ? ` ${why}` : ""}`;
}

/**
 * A small A to E chip for a table row or a heading: green to red by grade, the letter always shown so colour is never the only signal. Hover (or a screen reader) gives the score and the top reason. With no `health` it shows a quiet dash, or a skeleton while `loading`.
 * `showScore` adds the number. `onClick` makes it a button, for opening the full panel.
 */
export function HealthBadge({ health, loading = false, showScore = false, onClick }: { health?: BadgeHealth | null; loading?: boolean; showScore?: boolean; onClick?: () => void }) {
  if (!health) {
    if (loading) return <span className="health-badge health-badge-loading skeleton" role="status" aria-label="Loading the health grade" />;
    return (
      <span className="health-badge health-badge-none" title="No health grade for this asset yet" aria-label="No health grade for this asset yet">
        –
      </span>
    );
  }
  const text = badgeText(health);
  const classes = `health-badge health-grade-${health.grade}${health.partial ? " health-badge-partial" : ""}${showScore ? " with-score" : ""}`;
  const body = (
    <>
      <span className="health-badge-grade">{health.grade}</span>
      {showScore && <span className="health-badge-score num">{health.score}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={classes} title={text} aria-label={`Health grade ${health.grade}. ${text}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className={classes} role="img" title={text} aria-label={`Health grade ${health.grade}. ${text}`}>
      {body}
    </span>
  );
}
