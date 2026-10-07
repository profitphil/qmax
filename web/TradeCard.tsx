import { useEffect, useRef, useState } from "react";
import { clock } from "../src/tradecard.ts";
import type { CardTone, CardView } from "../src/tradecard.ts";
import { Icon, Spinner } from "./ui.tsx";

/**
 * The class that outlines and animates the dialog the card is in: a steady accent outline while the trade is under way, a green outline and a bounce
 * when it went through, a red outline and a sideways shake when it failed, an amber one (no jolt) when it needs a look. Nothing before it starts.
 * Put it on the `Modal`'s `className`; the styles are in styles/tradecard.css.
 */
export const dialogClass = (tone: CardTone): string => (tone === "idle" ? "" : `tc tc-${tone}`);

/** Seconds since the trade started: ticks while it is under way and stops where it ended. */
function useElapsed(over: boolean): number {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  const ended = useRef<number | null>(null);
  if (over && ended.current === null) ended.current = Date.now();
  useEffect(() => {
    if (over) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [over]);
  return ((ended.current ?? now) - start) / 1000;
}

/** How far a trade has got: a bar of its steps, what it is waiting for now, how long it has taken, and how it ended. Mounted once the first step starts. */
export function TradeCard({ view }: { view: CardView }) {
  const over = view.tone !== "working";
  const seconds = useElapsed(over);
  const icon =
    view.tone === "working" ? <Spinner size={20} /> : view.tone === "success" ? <Icon name="check" size={20} /> : <Icon name="alert" size={20} />;
  return (
    <section className={`tcard ${view.tone}`} role="status" aria-live="polite" aria-label="Trade progress">
      <div className="tcard-head">
        <span className="tcard-icon" aria-hidden="true">{icon}</span>
        <div className="tcard-text">
          <strong>{view.title}</strong>
          {view.detail && <small>{view.detail}</small>}
        </div>
        <span className="tcard-side num">
          <b>{view.percent}%</b>
          <small title="How long since the first step started">{clock(seconds)}</small>
        </span>
      </div>
      <div className="tcard-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} aria-label="Trade progress">
        {view.segments.map((s, i) => (
          <span key={i} className={`tcard-seg ${s.state}`} title={s.label} />
        ))}
      </div>
    </section>
  );
}
