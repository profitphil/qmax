import { useEffect, useMemo, useRef, useState } from "react";
import { compactPrice, formatPrice } from "./AssetList.tsx";
import { agoLabel, compactQu, fetchTape, mergeTape, pollCursor } from "./tape-api.ts";
import type { Flow, TapeRow } from "./tape-api.ts";
import { AssetName, Icon } from "./ui.tsx";
import { olderThan, useOlderTrades, whenLabel } from "./history-api.ts";
import type { ListRow } from "./history-api.ts";

const POLL_MS = 10_000;
/** How many rows of older trades are added each time the list is scrolled to its end. */
const PAGE = 60;
const HIGHLIGHT_MS = 2600;
const EXPLORER_TX = "https://explorer.qubic.org/network/tx/";
const NONE: ReadonlySet<number> = new Set();

const n = (x: number) => x.toLocaleString("en-US");
import { quietWords } from "../src/tapewords.ts";
import { useMaxMode } from "./maxmode.tsx";
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** True while the page is on screen. A hidden tab polls nothing. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

export interface TapeFeed {
  /** Newest first. */
  rows: TapeRow[];
  flow: Flow | null;
  /** True once a first answer has arrived. */
  loaded: boolean;
  /** The last problem, cleared by the next good answer. Rows already shown stay on screen. */
  error: string;
  /** Rows that arrived in the latest poll, to highlight for a moment. Empty after the first load. */
  fresh: ReadonlySet<number>;
  /** Ticks once a second while the page is visible, for "12 s ago". */
  now: number;
}

/**
 * The live tape for one asset or all of them. Polls `/v1/tape?since=` every 10 seconds, but only while the component is mounted
 * AND the page is visible (it asks again at once when the tab comes back). New rows are folded into what is shown; a failed poll
 * keeps the old rows. If the server has restarted (its ids start over) the old rows are dropped and the list is read afresh.
 */
export function useTapeFeed({ asset, limit }: { asset?: string; limit: number }): TapeFeed {
  const visible = usePageVisible();
  const [rows, setRows] = useState<TapeRow[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState<ReadonlySet<number>>(NONE);
  const [now, setNow] = useState(() => Date.now());
  // What the poll remembers from one round to the next. In a ref so a poll always sees the latest, not what it started with.
  const mem = useRef({ rows: [] as TapeRow[], cursor: 0, instance: "", loaded: false });
  const fade = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A different asset is a different list: start over (declared before the polling effect so it runs first).
  useEffect(() => {
    mem.current = { rows: [], cursor: 0, instance: "", loaded: false };
    setRows([]);
    setFlow(null);
    setLoaded(false);
    setError("");
    setFresh(NONE);
  }, [asset, limit]);

  useEffect(() => {
    if (!visible) return;
    const ctl = new AbortController();
    let busy = false;
    const poll = async () => {
      if (busy) return; // a slow answer is not stacked on top of
      busy = true;
      try {
        const m = mem.current;
        let res = await fetchTape({ asset, limit, since: m.loaded ? pollCursor(m.rows, m.cursor, Date.now()) : undefined }, ctl.signal);
        let startedOver = false;
        if (m.loaded && res.instance !== m.instance) {
          m.rows = [];
          startedOver = true;
          res = await fetchTape({ asset, limit }, ctl.signal);
        }
        if (ctl.signal.aborted) return;
        const had = new Set(m.rows.map((r) => r.id));
        const merged = mergeTape(m.rows, res.trades, limit);
        const arrived = m.loaded && !startedOver ? merged.filter((r) => !had.has(r.id)).map((r) => r.id) : [];
        m.rows = merged;
        m.cursor = res.latestId;
        m.instance = res.instance;
        m.loaded = true;
        setRows(merged);
        setFlow(res.flow24h);
        setError("");
        setLoaded(true);
        if (arrived.length) {
          setFresh(new Set(arrived));
          clearTimeout(fade.current);
          fade.current = setTimeout(() => setFresh(NONE), HIGHLIGHT_MS);
        }
      } catch (e) {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Could not load trades");
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      ctl.abort();
      clearInterval(timer);
    };
  }, [asset, limit, visible]);

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  useEffect(() => () => clearTimeout(fade.current), []);

  return { rows, flow, loaded, error, fresh, now };
}

/** An arrow for the side of a trade (up for a buy, down for a sell), so direction never depends on colour alone. */
export function SideMark({ side }: { side?: "buy" | "sell" }) {
  if (!side) return <span aria-hidden="true">–</span>;
  return (
    <svg className="tape-arrow" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={side === "buy" ? "M6 10V2.5M2.8 5.6 6 2.4l3.2 3.2" : "M6 2v7.5M2.8 6.4 6 9.6l3.2-3.2"} />
    </svg>
  );
}

const sideWord = (side?: "buy" | "sell") => (side === "buy" ? "Buy" : side === "sell" ? "Sell" : "Unknown");

/**
 * Buy versus sell by QU over the last 24 hours (or since the tape started, which it says). Direction is the side that started the
 * trade; trades whose direction could not be read are counted in a note but left out of the bar, so a gap cannot tilt it.
 */
function Pressure({ flow, loading, assetId, now }: { flow: Flow | null; loading: boolean; assetId?: string; now: number }) {
  if (!flow) return loading ? <div className="skeleton line tape-press-skeleton" role="status" aria-label="Loading buy and sell pressure" /> : null;
  // "last 24 hours" if the tape holds the whole day, otherwise from when it starts to be complete
  const period = flow.partial ? `since ${clock(flow.coveredFromMs)}` : "last 24 hours";
  const within = flow.partial ? period : `in the ${period}`;
  if (flow.trades === 0) return <p className="note tape-press-note">{quietWords({ asset: assetId, partial: flow.partial, coveredFromMs: flow.coveredFromMs, now }).headline}.</p>;
  if (flow.pressure === null)
    return <p className="note tape-press-note">Buy and sell pressure ({period}): not enough data. The direction of {n(flow.unknown.trades)} trade{flow.unknown.trades === 1 ? "" : "s"} could not be read.</p>;
  const buyPct = Math.round(((1 + flow.pressure) / 2) * 100);
  const sellPct = 100 - buyPct;
  return (
    <div className="tape-press">
      <div className="tape-press-head">
        <span>Buy vs sell, {period}</span>
        <span className="tape-press-nums">
          <b className="tape-buy">Buy {buyPct}%</b> · <b className="tape-sell">Sell {sellPct}%</b>
        </span>
      </div>
      <div className="tape-bar" role="img" aria-label={`By QU traded ${within}: ${buyPct} percent buys, ${sellPct} percent sells`}>
        <i className="tape-bar-buy" style={{ width: `${buyPct}%` }} />
        <i className="tape-bar-sell" style={{ width: `${sellPct}%` }} />
      </div>
      <p className="note">
        {n(flow.buy.trades)} buy{flow.buy.trades === 1 ? "" : "s"} ({compactQu(flow.buy.qu)} QU) and {n(flow.sell.trades)} sell{flow.sell.trades === 1 ? "" : "s"} ({compactQu(flow.sell.qu)} QU), by the side that started each trade.
        {flow.unknown.trades > 0 && ` ${n(flow.unknown.trades)} trade${flow.unknown.trades === 1 ? "" : "s"} whose direction could not be read ${flow.unknown.trades === 1 ? "is" : "are"} not counted.`}
        {flow.partial && " The tape has not been running for a full 24 hours."}
      </p>
    </div>
  );
}

function TapeLine({ r, now, fresh, showAsset }: { r: ListRow; now: number; fresh: boolean; showAsset: boolean }) {
  const max = useMaxMode();
  // A row from the trade history (not the live tape) is a minute of trading: dated once it is a couple of days old, with no buy or sell side.
  const old = r.trades !== undefined;
  const ago = (old && whenLabel(r.t, now)) || agoLabel(now - r.t);
  return (
    <li className={fresh ? "tape-row new" : old ? "tape-row old" : "tape-row"}>
      <time className="tape-time num" dateTime={new Date(r.t).toISOString()} title={new Date(r.t).toLocaleString()}>
        {ago}
      </time>
      {old ? (
        <span className="tape-side unknown" title="Buy or sell is only known for trades from the last 24 hours">–</span>
      ) : (
        <span className={`tape-side ${r.side ?? "unknown"}`} title={r.side ? `${sideWord(r.side)}: the side that started this trade` : "The direction of this trade could not be read"}>
          <SideMark side={r.side} />
          {r.side ? sideWord(r.side) : <span className="tape-sr">Direction unknown</span>}
        </span>
      )}
      <span className="tape-amt num">
        {n(r.qty)}
        {showAsset && <b> <AssetName id={r.asset} /></b>}
        {r.trades !== undefined && r.trades > 1 && <small className="tape-many" title={`${r.trades} trades in this minute, added up (the price is their average)`}> ×{r.trades}</small>}
      </span>
      <span className="tape-total num" title={`${n(r.qu)} QU in total`}>
        {compactQu(r.qu)} QU
      </span>
      <span className="tape-price num" title={`${formatPrice(r.price)} QU each`}>
        {compactPrice(r.price)} <small>QU</small>
      </span>
      {max.active ? (
        <span className="tape-venue" title={r.src === "quhub" ? "From Quhub's trade history (before the Qubic archive began): the chain cannot confirm it" : r.venue === "QX" ? "Matched on the QX order book" : "Swapped in a QSwap pool"}>
          <i className={r.venue === "QX" ? "dot qx" : "dot qswap"} /> {r.venue}
        </span>
      ) : (
        <button type="button" className="tape-venue locked" onClick={() => max.setOn(true)} title="Which market each trade was on, QX or QSwap, is part of Max. Click to switch Max on.">
          &ndash;
        </button>
      )}
      {r.txHash ? (
        <a className="tape-link" href={EXPLORER_TX + r.txHash} target="_blank" rel="noopener noreferrer" aria-label={`View this ${[r.asset, r.side].filter(Boolean).join(" ")} trade on the Qubic explorer`} title="View on the Qubic explorer">
          <Icon name="external" size={14} />
        </a>
      ) : (
        <span className="tape-link" />
      )}
    </li>
  );
}

/**
 * Live trades from both venues: when, which way, how much, at what price in QU, on which venue, and a link to the transaction.
 * With `assetId` (an id from the asset list) it is that asset's tape, for the trade dialog's market tab; without, every asset.
 */
export function TradeTape({ assetId, limit = 30 }: { assetId?: string; limit?: number }) {
  // One asset's list goes further than the tape's day: the exact trades first, then the minutes it traded in before that, a page at a time as you scroll.
  const live = assetId ? Math.max(limit, 200) : limit;
  const { rows, flow, loaded, error, fresh, now } = useTapeFeed({ asset: assetId, limit: live });
  const showAsset = !assetId;
  const older = useOlderTrades(assetId, loaded);
  const cutoff = rows.length >= live ? rows[rows.length - 1].t : (flow?.coveredFromMs ?? now - 24 * 3_600_000);
  const history = useMemo(() => olderThan(older.rows, cutoff), [older.rows, cutoff]);
  const [more, setMore] = useState(PAGE);
  useEffect(() => setMore(PAGE), [assetId]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) setMore((m) => Math.min(m + PAGE, Math.max(history.length, PAGE)));
  };
  return (
    <section className="tape" aria-label={assetId ? `Recent ${assetId} trades` : "Recent trades"}>
      <div className="tape-head">
        <h4>Recent trades</h4>
        {!error && loaded && (
          <span className="tape-live" title="Checked every 10 seconds while this page is open">
            <i className="pulse" /> Live
          </span>
        )}
      </div>
      <Pressure flow={flow} loading={!loaded && !error} assetId={assetId} now={now} />

      {error && rows.length > 0 && (
        <p className="inline err tape-err" role="status">
          <Icon name="alert" size={15} /> <span>Could not refresh just now. Showing the last trades received; trying again shortly.</span>
        </p>
      )}
      {error && !loaded && (
        <p className="inline err tape-err" role="alert">
          <Icon name="alert" size={15} /> <span>Could not load trades ({error}). Trying again shortly.</span>
        </p>
      )}
      {!loaded && !error && (
        <div className="tape-skeleton" role="status" aria-label="Loading trades">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton line" />
          ))}
        </div>
      )}
      {loaded && rows.length === 0 && history.length === 0 && !older.loading && (
        <div className="empty tape-empty">
          <span className="empty-icon"><Icon name="swap" size={22} /></span>
          <p>{quietWords({ asset: assetId, partial: !!flow?.partial, coveredFromMs: flow?.coveredFromMs ?? null, now }).headline}</p>
          <p className="note">{quietWords({ asset: assetId, partial: !!flow?.partial, coveredFromMs: flow?.coveredFromMs ?? null, now }).detail}</p>
        </div>
      )}
      {(rows.length > 0 || history.length > 0) && (
        <div className={assetId ? "tape-scroll" : undefined} onScroll={assetId ? onScroll : undefined} tabIndex={assetId ? 0 : undefined} aria-label={assetId ? `${assetId} trades, newest first (scroll for older ones)` : undefined}>
          <ol className="tape-list">
            {rows.map((r) => (
              <TapeLine key={r.id} r={r} now={now} fresh={fresh.has(r.id)} showAsset={showAsset} />
            ))}
            {history.length > 0 && (
              <li className="tape-divider" role="separator">
                <span>Earlier: one row for each minute the asset traded</span>
              </li>
            )}
            {history.slice(0, more).map((r) => (
              <TapeLine key={`${r.venue}${r.t}`} r={r} now={now} fresh={false} showAsset={showAsset} />
            ))}
          </ol>
          {history.length > more && (
            <button type="button" className="ghost tape-more" onClick={() => setMore((m) => m + PAGE)}>
              Show {Math.min(PAGE, history.length - more)} more ({n(history.length - more)} older)
            </button>
          )}
        </div>
      )}
      {assetId && loaded && rows.length === 0 && history.length === 0 && older.loading && <p className="note">Looking for older trades…</p>}
      {rows.length > 0 && <p className="note">Buy or sell is the side that started the trade. A row without one is a QX fill whose transaction could not be read.</p>}
      {history.length > 0 && (
        <p className="note">
          Trades older than the live list are one row for each minute the asset traded (several in a minute are added up and marked ×n, the price is their average), with no buy or sell side.
          {older.rows.some((r) => r.src === "quhub") && " Rows before April 2026 come from Quhub’s trade history, which the chain cannot confirm."}
        </p>
      )}
    </section>
  );
}
