import { useEffect, useRef, useState } from "react";
import { fetchSellers } from "./sellers-api.ts";
import type { SellerRow, SellersAnalysis, SellersView as View } from "./sellers-api.ts";
import { compactUnits, shortDate } from "./format.ts";
import { Spinner } from "./ui.tsx";
import { ORIGIN_LABELS } from "./sellers-labels.ts";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const short = (w: string) => `${w.slice(0, 5)}…${w.slice(-5)}`;
const pct = (x: number | null, signed = false) => (x === null || !Number.isFinite(x) ? "–" : `${signed && x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(Math.abs(x) < 10 ? 1 : 0)}%`);

/** Which wallets have been selling this asset, how long they held it and what they paid, read from the public chain (see src/sellers.ts). */
export function SellersView({ assetId, symbol }: { assetId: string; symbol: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setView(null);
    setError("");
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const v = await fetchSellers(assetId, ctl.signal);
        if (!alive.current) return;
        setView(v);
        setError("");
        // Still being read (or busy, or failed): ask again soon, instead of leaving the page waiting for ever.
        const wait = v.status === "working" ? 4000 : v.status === "ready" ? 0 : Math.min(120, v.retryAfterSec) * 1000;
        if (wait) timer = setTimeout(load, wait);
      } catch (e) {
        if (!alive.current || (e instanceof Error && e.name === "AbortError")) return;
        setError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(load, 15_000);
      }
    };
    void load();
    return () => {
      alive.current = false;
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [assetId]);

  if (error && !view) return <p className="err">{error}</p>;
  if (!view) return <div className="skeleton block" role="status" aria-label="Reading who has been selling" />;
  if (view.status === "busy") return <p className="note">{view.message} It will try again by itself.</p>;
  if (view.status === "error") return <p className="err">{view.message}</p>;
  const a = view.status === "ready" ? view.analysis : view.analysis;
  return (
    <div className="sellers">
      <p className="note first">
        Who sold {symbol} on QX and QSwap in the last 7 days, read from the public chain: each unit sold is matched to the purchase it came from, so you can see how long they held it and what they paid. It shows what the chain records,
        not why.
      </p>
      {view.status === "working" && (
        <div className="sellers-progress" role="status">
          <span className="sellers-bar"><i style={{ width: `${view.progress.total ? Math.round((view.progress.done / view.progress.total) * 100) : 4}%` }} /></span>
          <span>
            <Spinner size={13} /> {view.progress.total ? `Reading wallet ${Math.min(view.progress.done + 1, view.progress.total)} of ${view.progress.total}…` : "Finding the wallets that moved it…"} A first reading takes a minute or two; it is kept for six hours.
          </span>
        </div>
      )}
      {a ? <Analysis a={a} symbol={symbol} /> : null}
      {a && view.status === "ready" && <p className="note sellers-note">{a.note}</p>}
    </div>
  );
}

function Analysis({ a, symbol }: { a: SellersAnalysis; symbol: string }) {
  const sold = a.sold;
  return (
    <>
      <div className="sellers-stats">
        <div><small>Sold</small><b className="num">{compactUnits(sold.units)}</b><small>{symbol}</small></div>
        <div><small>Sellers</small><b className="num">{sold.sellers}</b><small>wallets</small></div>
        <div><small>Average price</small><b className="num">{sold.avgPriceQu !== null ? n(sold.avgPriceQu, sold.avgPriceQu < 100 ? 2 : 0) : "–"}</b><small>QU each</small></div>
        <div><small>Against their cost</small><b className={`num ${sold.plPct === null ? "" : sold.plPct >= 0 ? "up" : "down"}`}>{pct(sold.plPct, true)}</b><small>{sold.costedUnits > 0 ? `${n(sold.costedUnits > 0 && sold.units > 0 ? (sold.costedUnits / sold.units) * 100 : 0)}% of units known` : "no cost on record"}</small></div>
      </div>

      <h4>What the numbers say</h4>
      <ul className="sellers-reading">
        {a.reading.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {sold.units > 0 && (
        <>
          <h4>How long they had held what they sold</h4>
          <div className="sellers-buckets" role="list">
            {a.buckets.map((b) => (
              <div key={b.key} className="sellers-bucket" role="listitem" title={`${n(b.units)} units from ${b.sellers} wallets`}>
                <span className="sellers-bucket-label">{ORIGIN_LABELS[b.key] ?? b.label}</span>
                <span className="sellers-bucket-bar"><i className={`b-${b.key}`} style={{ width: `${Math.max(b.sharePct, b.units > 0 ? 1.5 : 0)}%` }} /></span>
                <span className="sellers-bucket-n num">{b.sharePct.toFixed(b.sharePct < 10 && b.sharePct > 0 ? 1 : 0)}%</span>
              </div>
            ))}
          </div>
          <h4>The sellers, biggest first</h4>
          <div className="wrap">
            <table className="sellers-table">
              <thead>
                <tr><th>Wallet</th><th className="r">Sold</th><th className="r">Average price</th><th>First got it</th><th className="r">Held (days)</th><th className="r">Their cost</th><th className="r">Result</th><th className="r">Still holds</th></tr>
              </thead>
              <tbody>
                {a.sellers.map((r) => (
                  <Row key={r.wallet} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="note">
        {a.analyzed.wallets} of {a.analyzed.senders} wallets that sent {symbol} were read ({a.analyzed.coveragePct.toFixed(0)}% of the units wallets sent{a.analyzed.failed ? `; ${a.analyzed.failed} could not be read` : ""}). {n(a.discovered.shareMovements)} share movements in all.
      </p>
    </>
  );
}

function Row({ r }: { r: SellerRow }) {
  const tags = [r.roundTrip ? "bought this week" : "", r.soldOfPositionPct !== null && r.soldOfPositionPct >= 90 ? "sold out" : "", r.mainOrigin === "received" ? "received by transfer" : ""].filter(Boolean);
  return (
    <tr>
      <td>
        <a href={`https://explorer.qubic.org/network/address/${r.wallet}`} target="_blank" rel="noreferrer" title={`${r.wallet}\nOpen this wallet in the explorer`}><code>{short(r.wallet)}</code></a>
        {tags.length > 0 && <small className="sellers-tags"> {tags.join(" · ")}</small>}
      </td>
      <td className="r num" title={`${n(r.units)} units, ${r.sharePct.toFixed(1)}% of what was sold`}>{compactUnits(r.units)} <small>({r.sharePct.toFixed(0)}%)</small></td>
      <td className="r num">{r.avgPriceQu !== null ? n(r.avgPriceQu, r.avgPriceQu < 100 ? 2 : 0) : "–"}</td>
      <td>{r.firstAcquiredAt ? <>{shortDate(r.firstAcquiredAt)} <small>{r.firstAcquiredHow === "received" ? "received" : "bought"}</small></> : <small>before the history read</small>}</td>
      <td className="r num">{r.holdDays !== null ? n(r.holdDays) : "–"}</td>
      <td className="r num">{r.avgCostQu !== null ? n(r.avgCostQu, r.avgCostQu < 100 ? 2 : 0) : <small>not on record</small>}</td>
      <td className={`r num ${r.plPct === null ? "" : r.plPct >= 0 ? "up" : "down"}`}>{pct(r.plPct, true)}</td>
      <td className="r num">{r.heldNow !== null ? compactUnits(r.heldNow) : "–"}</td>
    </tr>
  );
}
