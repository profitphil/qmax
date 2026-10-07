import { useEffect, useId, useMemo, useState } from "react";
import type { AssetItem } from "./client.ts";
import { formatPrice } from "./AssetList.tsx";
import { LedgerError, downloadLedgerCsv, fetchLedger } from "./ledger-api.ts";
import type { Ledger, LedgerEntry, LedgerPosition } from "./ledger-api.ts";
import { Avatar, Icon, Spinner } from "./ui.tsx";

const EXPLORER = "https://explorer.qubic.org/network/tx/";
const PERIODS = [30, 90, 180] as const;
const PAGE = 40;
const MINUS = "−";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const sign = (x: number) => (Math.round(x) > 0 ? "+" : Math.round(x) < 0 ? MINUS : "");
/** A signed QU amount in full: +1,234 QU. */
const signedQu = (x: number) => `${sign(x)}${n(Math.abs(Math.round(x)))} QU`;
/** Shortened for the summary cards: 316.06M QU (the full number is in the title). */
const short = (x: number) => `${Math.abs(x) >= 1e6 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Math.abs(x)) : n(Math.abs(Math.round(x)))} QU`;
const signedShort = (x: number) => `${sign(x)}${short(x)}`;
const tone = (x: number | null | undefined) => (x === null || x === undefined || Math.round(x) === 0 ? "" : x > 0 ? "up" : "down");
/** "Oct 4, 18:07" in local time (the year only when it is not this one); the row's title has the exact UTC time. */
const when = (ms: number) => {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  return `${date}, ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
};
const priceText = (p: number | null | undefined) => (p === null || p === undefined ? "–" : `${formatPrice(p)} QU`);

const SIDE: Record<LedgerEntry["kind"], { label: string; cls: string }> = {
  buy: { label: "Buy", cls: "buy" },
  sell: { label: "Sell", cls: "sell" },
  "transfer-in": { label: "In", cls: "move" },
  "transfer-out": { label: "Out", cls: "move" },
  other: { label: "Other", cls: "other" },
};

interface Props {
  /** The connected wallet's identity, or null when none is connected. */
  walletId: string | null;
  /** The asset list, for avatars and current prices. */
  assets: AssetItem[];
  /** Shown as a button when no wallet is connected. */
  onConnect?: () => void;
}

/**
 * The wallet's trade ledger: profit, fees, positions and every QX and QSwap trade, rebuilt by the API from the public archive,
 * with a CSV export. Everything here is an estimate from on-chain transfers and says so.
 */
export function LedgerPanel({ walletId, assets, onConnect }: Props) {
  const titleId = useId();
  const [days, setDays] = useState<number>(180);
  const [reload, setReload] = useState(0);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    setLedger(null);
    setError("");
    setBusy(false);
    setLimit(PAGE);
    setExportError("");
    if (!walletId) return;
    const ctl = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setElapsed(0);
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    const attempt = (left: number) =>
      fetchLedger(walletId, days, ctl.signal)
        .then((l) => {
          setLedger(l);
          clearInterval(tick);
        })
        .catch((e: unknown) => {
          if ((e as Error).name === "AbortError") return;
          // The server builds only a few ledgers at once; when it is busy it says when to come back.
          if (e instanceof LedgerError && e.status === 503 && left > 0) {
            setBusy(true);
            retry = setTimeout(() => attempt(left - 1), (e.retryAfterSec ?? 5) * 1000);
            return;
          }
          clearInterval(tick);
          setError(e instanceof Error ? e.message : String(e));
        });
    attempt(3);
    return () => {
      ctl.abort();
      clearTimeout(retry);
      clearInterval(tick);
    };
  }, [walletId, days, reload]);

  const byKey = useMemo(() => new Map(assets.map((a) => [`${a.symbol}|${a.issuer}`, a])), [assets]);

  // The name QMax uses elsewhere (the catalog's id); otherwise symbols that two issuers share get the issuer's first letters.
  const label = useMemo(() => {
    const issuers = new Map<string, Set<string>>();
    for (const e of ledger?.entries ?? []) if (e.asset) issuers.set(e.asset.symbol, (issuers.get(e.asset.symbol) ?? new Set()).add(e.asset.issuer));
    return (a: { key: string; symbol: string; issuer: string }) => byKey.get(a.key)?.id ?? ((issuers.get(a.symbol)?.size ?? 0) > 1 ? `${a.symbol}.${a.issuer.slice(0, 5)}` : a.symbol);
  }, [ledger, byKey]);

  // Current prices come from the asset list when it has them (the same prices the rest of the page shows).
  const positions = useMemo(
    () =>
      (ledger?.positions ?? [])
        .filter((p) => p.held > 0 || Math.round(p.realizedQu) !== 0)
        .map((p) => {
          const price = byKey.get(p.asset.key)?.priceQu ?? p.priceQu;
          const unrealized = price !== null && p.avgCost !== null && p.costedQty > 0 ? (price - p.avgCost) * p.costedQty : null;
          const pct = price !== null && p.avgCost ? (price / p.avgCost - 1) * 100 : null;
          return { p, price, unrealized, pct };
        })
        .sort((a, b) => (b.price ?? 0) * b.p.held - (a.price ?? 0) * a.p.held || b.p.trades - a.p.trades),
    [ledger, byKey],
  );
  const unrealized = positions.some((x) => x.unrealized !== null) ? positions.reduce((s, x) => s + (x.unrealized ?? 0), 0) : null;
  const rows = useMemo(() => [...(ledger?.entries ?? [])].reverse().filter((e) => all || e.kind === "buy" || e.kind === "sell"), [ledger, all]);

  const exportCsv = async () => {
    if (!walletId) return;
    setExporting(true);
    setExportError("");
    try {
      await downloadLedgerCsv(walletId, days);
    } catch (e) {
      setExportError(`Could not export: ${e instanceof Error ? e.message : e}`);
    } finally {
      setExporting(false);
    }
  };

  if (!walletId)
    return (
      <div className="empty">
        <span className="empty-icon"><Icon name="chart" size={22} /></span>
        <p>Connect your wallet to see what you bought and sold on QX and QSwap, your profit and the fees you paid.</p>
        {onConnect && <button className="primary" onClick={onConnect}>Connect wallet</button>}
      </div>
    );

  const t = ledger?.totals;
  return (
    <section className="ledger" aria-labelledby={titleId}>
      <div className="ledger-bar">
        <div className="ledger-heading">
          <h3 id={titleId}>Trade history and P&amp;L</h3>
          <p className="note first">Your QX and QSwap trades, rebuilt from the public Qubic archive.</p>
        </div>
        <div className="ledger-actions">
          <div className="chips" role="group" aria-label="Period">
            {PERIODS.map((d) => (
              <button key={d} className={d === days ? "chip on" : "chip"} aria-pressed={d === days} onClick={() => setDays(d)}>{d}D</button>
            ))}
          </div>
          <button className="ghost ledger-export" disabled={!ledger || exporting} onClick={exportCsv}>
            {exporting ? <Spinner size={14} /> : <DownloadIcon />} Export CSV
          </button>
        </div>
      </div>
      {exportError && <p className="err inline ledger-msg"><Icon name="alert" size={15} /> {exportError}</p>}

      {error && (
        <div className="banner err" role="alert">
          <Icon name="alert" size={16} /> <span><b>Ledger unavailable.</b> {error}</span>
          <button className="ghost" onClick={() => setReload((k) => k + 1)}>Try again</button>
        </div>
      )}

      {!ledger && !error && (
        <div className="ledger-loading" role="status" aria-live="polite">
          <div className="ledger-stats" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="stat"><span className="skeleton line" style={{ width: 90 }} /><span className="skeleton line big" /></div>
            ))}
          </div>
          <p className="status-line">
            <Spinner size={14} /> <span>{busy ? "QMax is building other ledgers right now; trying again in a few seconds…" : `Reading your transfers from the Qubic archive… ${elapsed} s`}</span>
          </p>
          <p className="note">Every QU and share transfer of the last {days} days is read and matched to its trade. Busy wallets take up to a minute.</p>
          <div className="ledger-skel" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <span key={i} className="skeleton line" />)}</div>
        </div>
      )}

      {ledger && t && (
        <>
          {ledger.truncated && (
            <div className="banner ledger-warn" role="note">
              <Icon name="alert" size={16} /> <span><b>Partial history.</b> {ledger.truncatedReasons.join(" ")} Totals cover only what was read.</span>
            </div>
          )}
          {ledger.warnings.map((w) => (
            <div key={w} className="banner ledger-warn" role="note"><Icon name="info" size={16} /> <span>{w}</span></div>
          ))}

          <div className="ledger-stats">
            <Stat label="Realized P&L" value={signedShort(t.realizedQu)} title={signedQu(t.realizedQu)} toneOf={t.realizedQu} hint="Average cost, fees included" />
            <Stat label="Unrealized P&L" value={unrealized === null ? "–" : signedShort(unrealized)} title={unrealized === null ? "No held units with a known cost and a current price" : signedQu(unrealized)} toneOf={unrealized} hint="At current mid or pool prices" />
            <Stat label="Fees paid" value={short(t.feesQu)} title={`${n(t.feesQu)} QU: ${n(t.tradeFeesQu)} QU trading, ${n(t.otherFeesQu)} QU transfers and share management`} hint="Estimated from the markets' fees" />
            <Stat label="Trades" value={n(t.trades)} hint={`${n(t.buys)} buys · ${n(t.sells)} sells`} />
          </div>

          {t.trades === 0 && (
            <div className="empty ledger-empty">
              <span className="empty-icon"><Icon name="inbox" size={22} /></span>
              <p>No QX or QSwap trades found in the last {days} days.</p>
              {ledger.entries.length > 0 && <button className="link" onClick={() => setAll(true)}>Show the {n(ledger.entries.length)} transfers and order operations</button>}
            </div>
          )}

          {positions.length > 0 && (
            <div className="ledger-block">
              <h4>Positions</h4>
              <div className="ledger-table ledger-pos" role="table" aria-label="Positions">
                <div className="ledger-head" role="row">
                  <span role="columnheader">Asset</span>
                  <span role="columnheader" className="r">Held</span>
                  <span role="columnheader" className="r">Avg cost</span>
                  <span role="columnheader" className="r">Price now</span>
                  <span role="columnheader" className="r">Unrealized</span>
                </div>
                {positions.map(({ p, price, unrealized: u, pct }) => (
                  <PositionRow key={p.asset.key} p={p} price={price} unrealized={u} pct={pct} name={label(p.asset)} item={byKey.get(p.asset.key)} />
                ))}
              </div>
            </div>
          )}

          {(t.trades > 0 || all) && (
            <div className="ledger-block">
              <div className="ledger-subbar">
                <h4>{all ? "All activity" : "Trades"}</h4>
                <div className="seg-mini" role="group" aria-label="Rows to show">
                  <button className={!all ? "on" : ""} aria-pressed={!all} onClick={() => (setAll(false), setLimit(PAGE))}>Trades</button>
                  <button className={all ? "on" : ""} aria-pressed={all} onClick={() => (setAll(true), setLimit(PAGE))}>All activity</button>
                </div>
              </div>
              {rows.length === 0 ? (
                <p className="note">Nothing to show for this period.</p>
              ) : (
                <div className="ledger-table ledger-trades" role="table" aria-label={all ? "All activity" : "Trades"}>
                  <div className="ledger-head" role="row">
                    <span role="columnheader">Date</span>
                    <span role="columnheader">Side</span>
                    <span role="columnheader">Asset</span>
                    <span role="columnheader" className="r">Quantity</span>
                    <span role="columnheader" className="r">Price</span>
                    <span role="columnheader" className="r">QU net</span>
                    <span role="columnheader">Market</span>
                    <span role="columnheader"><span className="ledger-sr">Explorer</span></span>
                  </div>
                  {rows.slice(0, limit).map((e) => (
                    <EntryRow key={`${e.tx}|${e.kind}|${e.asset?.key ?? ""}`} e={e} name={e.asset ? label(e.asset) : ""} item={e.asset ? byKey.get(e.asset.key) : undefined} />
                  ))}
                </div>
              )}
              {rows.length > limit && (
                <button className="ghost ledger-more" onClick={() => setLimit((l) => l + PAGE * 2)}>Show more ({n(rows.length - limit)} left)</button>
              )}
            </div>
          )}

          <Excluded ledger={ledger} />
          <p className="note ledger-disclaimer">
            <Icon name="info" size={14} /> <span><b>Estimated from on-chain transfers. Fees include the markets' fees. Not tax advice.</b> Profit uses the average cost method: units that arrived by transfer or before this {days}-day window have no known cost and are left out of profit. Unrealized profit uses QMax's current mid or pool price, which a large sale would not get. The CSV dates are UTC.</span>
          </p>
        </>
      )}
    </section>
  );
}

/** A download arrow in the same stroke style as the shared icons (web/ui.tsx has none). */
function DownloadIcon() {
  return (
    <svg className="icon" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
    </svg>
  );
}

function Stat({ label, value, hint, title, toneOf }: { label: string; value: string; hint: string; title?: string; toneOf?: number | null }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ledger-v ${tone(toneOf)}`} title={title}>{value}</span>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}

function AssetCell({ name, item, sub }: { name: string; item?: AssetItem; sub?: string }) {
  return (
    <span className="ledger-asset">
      <Avatar symbol={name} category={item?.category} issuer={item?.issuer} size={24} />
      <span>
        <b>{name}</b>
        {sub && <small>{sub}</small>}
      </span>
    </span>
  );
}

function PositionRow({ p, price, unrealized, pct, name, item }: { p: LedgerPosition; price: number | null; unrealized: number | null; pct: number | null; name: string; item?: AssetItem }) {
  const uncosted = p.held - p.costedQty;
  return (
    <div className="ledger-row" role="row">
      <span role="cell" className="ledger-c-asset">
        <AssetCell name={name} item={item} sub={`${n(p.trades)} ${p.trades === 1 ? "trade" : "trades"}${Math.round(p.realizedQu) !== 0 ? ` · realized ${signedQu(p.realizedQu)}` : ""}`} />
      </span>
      <span role="cell" className="r num ledger-c-held" data-label="Held">
        {n(p.held)}
        {uncosted > 0 && <small title="Units that arrived by transfer or before this window: their cost is not known">{n(uncosted)} cost unknown</small>}
      </span>
      <span role="cell" className="r num ledger-c-avg" data-label="Avg cost" title={p.avgCost === null ? "No units bought in this window are still held" : "Average cost per unit, fees included"}>{priceText(p.avgCost)}</span>
      <span role="cell" className="r num ledger-c-price" data-label="Price now">{priceText(price)}</span>
      <span role="cell" className={`r num ledger-c-pnl ledger-pnl ${tone(unrealized)}`} data-label="Unrealized">
        {unrealized === null ? <span className="muted" title={price === null ? "No current price" : "No units with a known cost"}>–</span> : <>{signedQu(unrealized)}{pct !== null && <small>{sign(pct)}{Math.abs(pct).toFixed(1)}%</small>}</>}
      </span>
    </div>
  );
}

function EntryRow({ e, name, item }: { e: LedgerEntry; name: string; item?: AssetItem }) {
  const side = SIDE[e.kind];
  const hasTx = !e.tx.startsWith("tick:");
  const sub =
    e.kind === "sell" && e.realizedQu !== null ? `P&L ${signedQu(e.realizedQu)}`
    : e.escrowQu && e.escrowQu < 0 && e.kind === "buy" ? "paid when the order was placed"
    : e.escrowQu && e.escrowQu > 0 ? `${n(e.escrowQu)} QU locked in the order`
    : e.escrowQu && e.escrowQu < 0 ? `${n(-e.escrowQu)} QU unlocked`
    : e.feeQu ? `fee ~${n(e.feeQu)} QU`
    : undefined;
  return (
    <div className="ledger-row" role="row" title={e.note}>
      <span role="cell" className="ledger-c-date" title={new Date(e.t).toISOString()}>{when(e.t)}</span>
      <span role="cell" className="ledger-c-side"><span className={`ledger-side ${side.cls}`}>{side.label}</span></span>
      <span role="cell" className="ledger-c-asset">
        {e.asset ? <AssetCell name={name} item={item} sub={e.kind === "buy" || e.kind === "sell" ? undefined : e.note} /> : <span className="muted ledger-opnote">{e.note}</span>}
      </span>
      <span role="cell" className="r num ledger-c-qty" data-label="Quantity">{e.asset && e.qty ? n(e.qty) : "–"}</span>
      <span role="cell" className="r num ledger-c-price" data-label="Price">{priceText(e.price)}</span>
      <span role="cell" className={`r num ledger-c-net ledger-pnl ${tone(e.quNet)}`} data-label="QU net">
        {e.quNet === 0 ? "0 QU" : signedQu(e.quNet)}
        {sub && <small className={e.kind === "sell" ? tone(e.realizedQu) : ""}>{sub}</small>}
      </span>
      <span role="cell" className="ledger-c-venue" data-label="Market">
        {e.venue ? <span className="ledger-venue"><span className={`dot ${e.venue === "QX" ? "qx" : e.venue === "QSwap" ? "qswap" : "other"}`} />{e.venue === "unknown" ? "Other" : e.venue}</span> : <span className="muted">–</span>}
      </span>
      <span role="cell" className="ledger-c-link">
        {hasTx && (
          <a href={EXPLORER + e.tx} target="_blank" rel="noreferrer" aria-label="View the transaction on the Qubic explorer" title="View on the Qubic explorer">
            <Icon name="external" size={15} />
          </a>
        )}
      </span>
    </div>
  );
}

/** What moved but is not a trade, so the totals can be read for what they are. */
function Excluded({ ledger }: { ledger: Ledger }) {
  const x = ledger.excluded;
  const parts = [
    x.contractIncome.count && `${n(x.contractIncome.count)} payouts from contracts (${n(x.contractIncome.qu)} QU)`,
    x.contractPayments.count && `${n(x.contractPayments.count)} payments to contracts (${n(x.contractPayments.qu)} QU)`,
    x.transfersIn.count + x.transfersOut.count && `${n(x.transfersIn.count + x.transfersOut.count)} QU transfers with other wallets`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <p className="note ledger-excluded">Not trades, so not in these totals: {parts.join(", ")}.</p>;
}
