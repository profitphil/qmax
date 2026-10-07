import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { GRADE_FLOOR, HEALTH_LIMITS as L } from "../src/health.ts";
import { HealthBadge } from "./HealthBadge.tsx";
import { FLAG_LABEL, GRADE_LABEL, GRADE_SUMMARY, fetchHealth } from "./health-api.ts";
import type { HealthResponse } from "./health-api.ts";
import { Icon } from "./ui.tsx";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "empty" } | { status: "ready"; health: HealthResponse };

const REFRESH_MS = 60_000; // the server computes a grade at most once a minute, so asking more often gains nothing

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
/** 93.1M QU. The exact figure is in the hover. */
function qu(x: number): string {
  for (const [size, mark] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) if (x >= size) return `${n(x / size, 1)}${mark} QU`;
  return `${n(x)} QU`;
}
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const time = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const NA = <span className="muted">not enough data</span>;
const amount = (x: number | null) => (x === null ? NA : <span title={`${n(x)} QU`}>{qu(x)}</span>);
/** Three figures in a row, "?" for one the history does not reach. */
const triple = (a: number | null, b: number | null, c: number | null, fmt: (x: number) => string) => (a === null && b === null && c === null ? NA : [a, b, c].map((x) => (x === null ? "?" : fmt(x))).join(" · "));

/** The numbers behind the grade, each with its unit, for the "How is this measured?" part. */
function Metrics({ h }: { h: HealthResponse }) {
  const m = h.metrics;
  const rows: [string, ReactNode][] = [
    [`Can be sold within ${L.depthBand * 100}% of the price`, amount(m.exitDepthQu)],
    [`Can be bought within ${L.depthBand * 100}% of the price`, amount(m.entryDepthQu)],
    ["QSwap pool, one way", m.poolDepthQu === null ? <span className="muted">no pool</span> : amount(m.poolDepthQu)],
    ["QX spread (best buy against best sell)", m.spreadPct === null ? <span className="muted">needs orders on both sides</span> : `${n(m.spreadPct, 1)}%`],
    ["Trades: 24 hours · 7 days · 30 days", triple(m.trades24h, m.trades7d, m.trades30d, (x) => n(x))],
    ["Volume: 24 hours · 7 days · 30 days", triple(m.volume24hQu, m.volume7dQu, m.volume30dQu, qu)],
    ["Hours with a trade, last 7 days", m.activeHours7d === null ? NA : `${n(m.activeHours7d)} of 168`],
    ["Average trade, last 7 days", amount(m.avgTradeQu7d)],
    ["Turnover, 7 days (volume ÷ market size)", m.turnover7d === null ? NA : `${n(m.turnover7d, 2)}×`],
    ["Busiest hour's share of 30 days: trades · volume", m.busiestHourShare30d === null || m.busiestHourVolumeShare30d === null ? NA : `${n(m.busiestHourShare30d * 100)}% · ${n(m.busiestHourVolumeShare30d * 100)}%`],
    ["First and last trade seen", m.firstTradeAt === null || m.lastTradeAt === null ? NA : `${day(m.firstTradeAt)} · ${day(m.lastTradeAt)}`],
    [`Churn-like hours: last ${L.washWindowDays} days · ever`, m.washLikeHours7d === null || m.washLikeHoursTotal === null ? NA : `${n(m.washLikeHours7d)} · ${n(m.washLikeHoursTotal)}`],
  ];
  return (
    <dl className="health-metrics">
      {rows.map(([label, value]) => (
        <div key={label} className="health-metric">
          <dt>{label}</dt>
          <dd className="num">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Skeleton() {
  return (
    <div className="health-skel" role="status" aria-label="Loading the health grade">
      <div className="health-head">
        <span className="skeleton health-skel-badge" />
        <div className="health-head-text">
          <span className="skeleton line big" style={{ width: "55%" }} />
          <span className="skeleton line" style={{ width: "85%", marginTop: 8 }} />
        </div>
      </div>
      <div className="health-flags">
        <span className="skeleton health-skel-chip" />
        <span className="skeleton health-skel-chip" />
      </div>
      <span className="skeleton line" />
      <span className="skeleton line" style={{ width: "92%" }} />
      <span className="skeleton line" style={{ width: "70%" }} />
    </div>
  );
}

/**
 * How safe one asset is to trade: the grade, what it comes from, and how it was measured. Loads `/v1/health` for the asset when shown and refreshes
 * quietly every minute. It is an estimate from public data and says so; nothing here is advice.
 */
export function HealthPanel({ assetId }: { assetId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setState({ status: "loading" });
    const load = () =>
      fetchHealth(assetId, ctl.signal).then(
        (health) => setState(health ? { status: "ready", health } : { status: "empty" }),
        (e: unknown) => {
          if (ctl.signal.aborted) return;
          // a refresh that fails leaves the grade that is already showing
          setState((s) => (s.status === "ready" ? s : { status: "error", message: e instanceof Error ? e.message : "Could not load the health grade" }));
        },
      );
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      ctl.abort();
      clearInterval(timer);
    };
  }, [assetId, attempt]);

  return (
    <section className="health-panel" aria-label={`Health of ${assetId}`} aria-busy={state.status === "loading"}>
      <h4 className="health-title">
        <Icon name="shield" size={15} /> Asset health
      </h4>

      {state.status === "loading" && <Skeleton />}

      {state.status === "error" && (
        <div className="health-state">
          <p className="inline err">
            <Icon name="alert" size={16} />
            <span>{state.message}</span>
          </p>
          <button type="button" className="ghost" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      )}

      {state.status === "empty" && (
        <div className="empty health-empty">
          <span className="empty-icon">
            <Icon name="shield" size={22} />
          </span>
          <p>There is no health grade for this asset. QMax grades the assets in its catalogue.</p>
        </div>
      )}

      {state.status === "ready" && <Ready h={state.health} />}
    </section>
  );
}

function Ready({ h }: { h: HealthResponse }) {
  return (
    <>
      <div className="health-head">
        <span className="health-big">
          <HealthBadge health={h} />
        </span>
        <div className="health-head-text">
          <div className="health-grade-line">
            <strong>{GRADE_LABEL[h.grade]}</strong>
            <span className="num muted">{h.score} / 100</span>
          </div>
          <p className="health-summary">{GRADE_SUMMARY[h.grade]}</p>
        </div>
      </div>

      {h.partial && (
        <p className="infoline health-partial">
          <Icon name="info" size={15} />
          <span>Some data was missing, so this grade is an estimate from the rest.</span>
        </p>
      )}

      {h.flags.length > 0 && (
        <ul className="health-flags" aria-label="Flags">
          {h.flags.map((f) => (
            <li key={f} className={`health-flag tone-${FLAG_LABEL[f].tone}`} title={FLAG_LABEL[f].hint}>
              {FLAG_LABEL[f].label}
            </li>
          ))}
        </ul>
      )}

      <ol className="health-reasons" aria-label="Why this grade">
        {h.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ol>

      <details className="health-how">
        <summary>
          How is this measured? <Icon name="chevron" size={15} />
        </summary>
        <div className="health-how-body">
          <p>
            This is an automated estimate from public trade data on QX and QSwap. It is not financial advice. It cannot see who is trading, who issued the asset, or anything that happens off the network, and it
            ignores swap fees and price moves beyond {L.depthBand * 100}%. Where only the best QX order on each side is known, it counts only that order, so depth is a floor, not the whole book.
          </p>
          <p>
            The grade starts at 100 and loses points for thin liquidity, a wide QX spread, few or irregular trades, no trades lately, a new listing, one hour holding most of the volume, and trading that looks like one
            bot churning. A is {GRADE_FLOOR.A} or more, B {GRADE_FLOOR.B}, C {GRADE_FLOOR.C}, D {GRADE_FLOOR.D}, E below that. Calling something wash trading needs strong evidence; weaker signs cost far fewer points and are worded as
            possibilities.
          </p>
          <Metrics h={h} />
          {h.flags.length > 0 && (
            <>
              <h5 className="health-how-head">What the flags mean</h5>
              <ul className="health-flag-help">
                {h.flags.map((f) => (
                  <li key={f}>
                    <b>{FLAG_LABEL[f].label}.</b> {FLAG_LABEL[f].hint}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </details>

      <p className="note health-asof">Calculated {time(h.computedAt)} from past trades and the order book and pool at that moment. Automated estimate, not advice.</p>
    </>
  );
}
