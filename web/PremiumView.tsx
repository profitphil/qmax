import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_REFERENCE_QU, MAX_CARRY_HOURS, describePremium, gapText, hourLabel, quText, shareText } from "../src/premium.ts";
import type { BigGap, PremiumRange, PremiumResponse } from "../src/premium.ts";
import { premiumChartSvg } from "../src/premiumchart.ts";
import type { PremiumPalette } from "../src/premiumchart.ts";
import { fetchPremium } from "./premium-api.ts";
import { useTheme } from "./theme.ts";
import { Icon } from "./ui.tsx";

const RANGES: [PremiumRange, string][] = [
  ["7d", "7D"],
  ["30d", "30D"],
  ["90d", "90D"],
  ["all", "All"],
];
/** Trade sizes the break-even can be worked out for. The middle one is the API's default. */
const SIZES: [number, string][] = [
  [1_000_000, "1M"],
  [DEFAULT_REFERENCE_QU, "10M"],
  [100_000_000, "100M"],
];

const n = (x: number) => x.toLocaleString("en-US");
const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "-" : ""}${gapText(x)}`;

/** The chart is SVG text made elsewhere, so it gets the page's colours here and follows the theme. QSwap is the site's violet. */
function useChartPalette(): Partial<PremiumPalette> {
  const { theme } = useTheme();
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
      bg: "none",
      grid: v("--chart-grid", "#2a2f55"),
      text: v("--muted", "#9a9fc0"),
      strong: v("--fg", "#f2f3fb"),
      up: v("--buy", "#4ade80"),
      down: v("--sell", "#f87171"),
      accent: v("--accent", "#6ee7ff"),
      violet: v("--violet", "#8f86ff"),
      font: "Inter, system-ui, sans-serif",
    };
  }, [theme]);
}

/** The width of an element, so the chart is drawn at the size it is shown (text stays readable on a phone instead of shrinking with the picture). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.max(300, Math.min(720, Math.round(el.clientWidth))));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="premium-stat">
      <span className="premium-stat-label">{label}</span>
      <span className="premium-stat-value">{value}</span>
      <span className="premium-stat-hint">{hint}</span>
    </div>
  );
}

function BigGaps({ gaps, referenceQu }: { gaps: BigGap[]; referenceQu: number }) {
  return (
    <>
      <h4 className="premium-h">Biggest gaps, one per day, where {quText(referenceQu)} or more traded on each market</h4>
      <ol className="premium-gaps">
        {gaps.map((g) => (
          <li key={g.t}>
            <span className="premium-gap-date">{hourLabel(g.t)}</span>
            <b className={`premium-gap-size ${g.dearer === "QSwap" ? "swap" : "qx"}`}>{signed(g.premiumPct)}</b>
            <span className="premium-gap-note">{g.dearer} dearer · {quText(g.thinnerQu)} traded on the quieter market</span>
          </li>
        ))}
      </ol>
    </>
  );
}

/**
 * How far apart QX and QSwap priced one token over time, and how often that gap would have paid after fees: a price chart with
 * the premium underneath, then the same story in words. It is an indication from hourly averages, and says so.
 * Meant for a "Markets" tab in the market panel; loads only when it is shown.
 */
export function PremiumView({ assetId, symbol }: { assetId: string; symbol: string }) {
  const palette = useChartPalette();
  const [box, width] = useWidth();
  const [range, setRange] = useState<PremiumRange>("30d");
  const [size, setSize] = useState(DEFAULT_REFERENCE_QU);
  const [carry, setCarry] = useState(0);
  const [res, setRes] = useState<PremiumResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError("");
    fetchPremium(assetId, range, { referenceQu: size, carry }, ctl.signal)
      .then((r) => (setRes(r), setLoading(false)))
      .catch((e) => {
        if (e.name === "AbortError") return;
        setError(e.message);
        setLoading(false);
      });
    return () => ctl.abort();
  }, [assetId, range, size, carry, tries]);

  // another asset's answer is never shown under this one's name
  const shown = res && res.asset === assetId ? res : null;
  const rangeLabel = RANGES.find((r) => r[0] === range)![1];
  const svg = useMemo(
    () => (shown?.bothVenues ? premiumChartSvg(shown.points, { symbol, rangeLabel, barMs: shown.barMs, breakEvenPct: shown.breakEvenPct, width, height: Math.max(280, Math.min(420, Math.round(width * 0.66))), palette }) : ""),
    [shown, symbol, rangeLabel, width, palette],
  );
  const words = shown?.bothVenues ? describePremium(shown, symbol) : null;
  const s = shown?.summary ?? null;
  const only = shown && !shown.bothVenues ? (shown.tradedHours.QX ? "QX" : shown.tradedHours.QSwap ? "QSwap" : null) : null;

  return (
    <div className="premium" ref={box}>
      <div className="premium-controls">
        <div className="chips" role="group" aria-label="Range">
          {RANGES.map(([id, label]) => (
            <button key={id} className={range === id ? "chip on" : "chip"} aria-pressed={range === id} onClick={() => setRange(id)}>{label}</button>
          ))}
        </div>
        <div className="premium-opts">
          <div className="premium-opt">
            <span className="premium-optlabel">Trade size (QU)</span>
            <div className="seg-mini" role="group" aria-label="Trade size in QU">
              {SIZES.map(([qu, label]) => (
                <button key={qu} className={size === qu ? "on" : ""} aria-pressed={size === qu} onClick={() => setSize(qu)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="premium-opt">
            <span className="premium-optlabel">Prices</span>
            <div className="seg-mini" role="group" aria-label="How to match prices between markets">
              <button className={carry === 0 ? "on" : ""} aria-pressed={carry === 0} onClick={() => setCarry(0)}>Same hour</button>
              <button className={carry > 0 ? "on" : ""} aria-pressed={carry > 0} onClick={() => setCarry(MAX_CARRY_HOURS)}>{`Carry ${MAX_CARRY_HOURS} h`}</button>
            </div>
          </div>
        </div>
      </div>

      {carry > 0 && <p className="note premium-carrynote">A market's last price may stand in for up to {MAX_CARRY_HOURS} hours when only the other market traded. That adds points (shown faded) but widens the gaps, because the market moves while a price is carried. They are left out of the biggest gaps.</p>}
      {error && <p className="err inline" role="alert"><Icon name="alert" size={16} /><span>{error}{" "}<button className="link" onClick={() => setTries((t) => t + 1)}>Try again</button></span></p>}
      {!shown && !error && (
        <div aria-busy="true">
          <div className="skeleton block" role="status" aria-label="Loading the market comparison" />
          <div className="skeleton line" style={{ width: "92%", marginTop: 10 }} />
          <div className="skeleton line" style={{ width: "70%", marginTop: 8 }} />
        </div>
      )}

      {shown && !shown.bothVenues && (
        <div className="empty premium-empty">
          <div className="empty-icon"><Icon name="swap" size={22} /></div>
          {only ? (
            <>
              <p><b>{symbol} only trades on {only}.</b></p>
              <p>The comparison needs a token that has traded on both QX and QSwap. {only === "QX" ? "There is no QSwap pool for it, or nobody has swapped in it yet" : "It has no QX trades yet"}, so there is no second price to measure against.</p>
            </>
          ) : (
            <p>QMax has not recorded any trades of {symbol} yet, so there is nothing to compare.</p>
          )}
        </div>
      )}

      {shown?.bothVenues && words && (
        <div className={loading ? "premium-body busy" : "premium-body"} aria-busy={loading}>
          <div className="chart premium-chart" role="group" aria-label={`${symbol} price on QX and QSwap, and the premium between them`} dangerouslySetInnerHTML={{ __html: svg }} />
          {s && s.enough && s.medianPct !== null && s.profitableShare !== null && s.profitableDeepShare !== null && (
            <div className="premium-stats">
              <Stat label="Comparable hours" value={n(s.hours)} hint={s.carried ? `${n(s.sameHour)} same hour, ${n(s.carried)} carried` : "both markets traded"} />
              <Stat label="Median gap" value={signed(s.medianPct)} hint={s.medianPct === 0 ? "even" : s.medianPct > 0 ? "QSwap dearer" : "QX dearer"} />
              <Stat label="Gap above costs" value={shareText(s.profitableShare)} hint={`upper bound, not profit (${quText(shown.referenceQu)} trade)`} />
              <Stat label="…with that much traded" value={shareText(s.profitableDeepShare)} hint={`${quText(shown.referenceQu)} on each market`} />
            </div>
          )}
          <p className="premium-lead">{words.lines[0]}</p>
          {words.lines.slice(1).map((l, i) => <p className="premium-text" key={i}>{l}</p>)}
          {words.caution && <p className="inline warn premium-caution"><Icon name="alert" size={16} /><span><b>Caution.</b> {words.caution}</span></p>}
          {s && s.enough && s.largest.length > 0 && <BigGaps gaps={s.largest} referenceQu={shown.referenceQu} />}
        </div>
      )}

      {shown?.bothVenues && (
        <p className="note premium-caveat"><Icon name="info" size={14} /><span>{shown.note}</span></p>
      )}
    </div>
  );
}
