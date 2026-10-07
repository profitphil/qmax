import { useEffect, useMemo, useState } from "react";
import { compactPrice } from "./AssetList.tsx";
import { SideMark, useTapeFeed } from "./TradeTape.tsx";
import { quietWords } from "../src/tapewords.ts";
import { useMaxMode } from "./maxmode.tsx";
import { agoShort, compactQu } from "./tape-api.ts";
import type { TapeRow } from "./tape-api.ts";
import { AssetName, Icon } from "./ui.tsx";
import { olderThan, useOlderTrades, whenLabel } from "./history-api.ts";
import type { ListRow } from "./history-api.ts";

/** The live rows asked for: a few for the all-assets tab, as many as the server gives for one asset (its older trades follow them). */
const LIVE_ALL = 25;
const LIVE_ASSET = 200;
/** How many older rows are added each time the list is scrolled to its end. */
const PAGE = 60;
const EXPLORER_TX = "https://explorer.qubic.org/network/tx/";
const n = (x: number) => x.toLocaleString("en-US");

type Tab = "asset" | "all";
/** The tab last used, kept from one asset to the next. */
let lastTab: Tab = "asset";

/** A quantity from 100,000 to a million in short form (668,747 is 668.7K), so the column stays narrow; smaller ones in full, millions as the list writes them (1.14M). */
const qtyOf = (q: number) => (q >= 100_000 && q < 1_000_000 ? compactQu(q) : compactPrice(q));

function Row({ r, now, isNew, showAsset, onOpenAsset }: { r: ListRow; now: number; isNew: boolean; showAsset: boolean; onOpenAsset?: (asset: string) => void }) {
  const max = useMaxMode();
  const word = r.side === "buy" ? "Buy" : r.side === "sell" ? "Sell" : "";
  // From the trade history, not the live tape: one row for a minute of trading, dated once it is a couple of days old, with no side.
  const old = r.trades !== undefined;
  return (
    <li className={isNew ? "dock-row new" : old ? "dock-row old" : "dock-row"}>
      <time className="num dock-time" dateTime={new Date(r.t).toISOString()} title={new Date(r.t).toLocaleString()}>
        {(old && whenLabel(r.t, now)) || agoShort(now - r.t)}
      </time>
      <span className={`dock-side ${r.side ?? "unknown"}`} title={old ? "Buy or sell is only known for trades from the last 24 hours" : r.side ? `${word}: the side that started this trade` : "The direction of this trade could not be read"}>
        {old ? <span>–</span> : <><SideMark side={r.side} /><span>{word}</span></>}
      </span>
      <span className="num dock-amt" title={`${n(r.qty)} ${r.asset}${r.trades && r.trades > 1 ? `, ${r.trades} trades in this minute added up` : ""}`}>
        {qtyOf(r.qty)}
        {r.trades !== undefined && r.trades > 1 && <small className="dock-many">×{r.trades}</small>}
        {showAsset && (
          <button type="button" className="dock-asset" onClick={() => onOpenAsset?.(r.asset)} title={`Open ${r.asset}`}>
            <AssetName id={r.asset} />
          </button>
        )}
      </span>
      <span className="num dock-price" title={`${n(r.price)} QU each`}>{compactPrice(r.price)}</span>
      <span className="num dock-total" title={`${n(r.qu)} QU in total`}>{compactQu(r.qu)}</span>
      {max.active ? (
        <span className="dock-venue" title={r.src === "quhub" ? "From Quhub's trade history (before the Qubic archive began): the chain cannot confirm it" : r.venue === "QX" ? "Matched on the QX order book" : "Swapped in a QSwap pool"}>
          <i className={r.venue === "QX" ? "dot qx" : "dot qswap"} /> {r.venue}
        </span>
      ) : (
        <button type="button" className="dock-venue locked" onClick={() => max.setOn(true)} title="Which market each trade was on, QX or QSwap, is part of Max. Click to switch Max on.">
          &ndash;
        </button>
      )}
      {r.txHash ? (
        <a className="dock-link" href={EXPLORER_TX + r.txHash} target="_blank" rel="noopener noreferrer" aria-label={`View this ${r.asset} trade on the Qubic explorer`} title="View on the Qubic explorer">
          <Icon name="external" size={12} />
        </a>
      ) : (
        <span className="dock-link" />
      )}
    </li>
  );
}

/** One list of trades. Mounted only while its tab is showing, so only that one asks the server for more. */
function List({ assetId, onOpenAsset }: { assetId?: string; onOpenAsset?: (asset: string) => void }) {
  const live = assetId ? LIVE_ASSET : LIVE_ALL;
  const { rows, flow, loaded, error, fresh, now } = useTapeFeed({ asset: assetId, limit: live });
  // One asset goes back past the tape's day: the exact trades first, then one row for each earlier minute it traded in, a page at a time as the list is scrolled.
  const older = useOlderTrades(assetId, loaded);
  const cutoff = rows.length >= live ? rows[rows.length - 1].t : (flow?.coveredFromMs ?? now - 24 * 3_600_000);
  const history = useMemo(() => olderThan(older.rows, cutoff), [older.rows, cutoff]);
  const [more, setMore] = useState(PAGE);
  useEffect(() => setMore(PAGE), [assetId]);
  return (
    <div
      className={assetId ? "dock-body one-asset" : "dock-body"}
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) setMore((m) => Math.min(m + PAGE, Math.max(history.length, PAGE)));
      }}
    >
      <div className="dock-cols" aria-hidden="true">
        <span>Time</span>
        <span>Side</span>
        <span>Qty</span>
        <span className="r">Price</span>
        <span className="r">QU</span>
        <span className="dock-market-h">Market</span>
      </div>
      {!loaded && !error && (
        <div className="dock-status" role="status">
          <span className="skeleton line" style={{ width: "70%" }} />
          <span className="skeleton line" style={{ width: "55%" }} />
        </div>
      )}
      {error && rows.length === 0 && <p className="note dock-status" role="alert">Could not load trades ({error}). Trying again shortly.</p>}
      {loaded && rows.length === 0 && history.length === 0 && !older.loading && <p className="note dock-status">{quietWords({ asset: assetId, partial: !!flow?.partial, coveredFromMs: flow?.coveredFromMs ?? null, now }).detail}</p>}
      {(rows.length > 0 || history.length > 0) && (
        <ol className="dock-list">
          {rows.map((r) => (
            <Row key={r.id} r={r} now={now} isNew={fresh.has(r.id)} showAsset={!assetId} onOpenAsset={onOpenAsset} />
          ))}
          {history.slice(0, more).map((r, i) => (
            <Row key={`${r.venue}${r.t}`} r={r} now={now} isNew={false} showAsset={!assetId} onOpenAsset={onOpenAsset} />
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The latest trades beside the chart: this asset's, and a tab for every asset's. Clicking an asset in the second tab opens it. With no asset (the Qubic
 * home view) there is only the all-assets list.
 * Buy or sell is the side that started the trade; a row without one is a QX fill whose transaction could not be read.
 */
export function TradesDock({ symbol, assetId, onOpenAsset }: { symbol?: string; assetId?: string; onOpenAsset?: (asset: string) => void }) {
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };
  const shown: Tab = assetId ? tab : "all";
  return (
    <section className="dock" aria-label="Recent trades">
      <div className="dock-tabs" role="tablist">
        {assetId && <button role="tab" aria-selected={shown === "asset"} className={shown === "asset" ? "on" : ""} onClick={() => setTab("asset")}>{symbol} trades</button>}
        <button role="tab" aria-selected={shown === "all"} className={shown === "all" ? "on" : ""} onClick={() => setTab("all")}>All recent trades</button>
      </div>
      <List key={shown === "asset" ? assetId : "all"} assetId={shown === "asset" ? assetId : undefined} onOpenAsset={onOpenAsset} />
    </section>
  );
}
