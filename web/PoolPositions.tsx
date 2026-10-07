import { useEffect, useState } from "react";
import type { AssetItem } from "./client.ts";
import { fetchPositions } from "./liquidity-api.ts";
import type { LiquidityPosition, PositionsResponse } from "./liquidity-api.ts";
import { Avatar, Icon } from "./ui.tsx";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const compactFmt = (digits: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: digits });
/** 3,600,000,000 becomes "3.6B"; the full figure goes in a tooltip. */
const compact = (x: number) => compactFmt(Math.abs(x) >= 1e9 ? 2 : Math.abs(x) >= 1e6 ? 1 : 0).format(x);
const pct = (x: number) => `${n(x, x < 0.01 ? 4 : x < 1 ? 3 : 2)}%`;

interface Props {
  /** The connected wallet's identity, or null when none is connected. */
  walletId: string | null;
  /** The asset list (/v1/assets), to hand the modal the asset a position is in. */
  assets: AssetItem[];
  onAdd(asset: AssetItem): void;
  onRemove(asset: AssetItem): void;
  /** Change it to read the positions again (after adding or removing, say). */
  reloadKey?: number;
}

/**
 * The wallet's QSwap liquidity: every pool it has a share of, what that share is worth at the pool's price, and buttons to add
 * to it or take it out. Read live from the QSwap contract through the API (cached there for 30 seconds).
 */
export function PoolPositions({ walletId, assets, onAdd, onRemove, reloadKey = 0 }: Props) {
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setData(null);
    setError("");
    if (!walletId) {
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    // After an add or remove (reloadKey) or a manual refresh, skip the server's 30-second cache: it may predate the change.
    fetchPositions(walletId, ctl.signal, reloadKey > 0 || retry > 0)
      .then((r) => (setData(r), setError("")))
      .catch((e) => e.name !== "AbortError" && setError(e.message))
      .finally(() => !ctl.signal.aborted && setLoading(false));
    return () => ctl.abort();
  }, [walletId, reloadKey, retry]);

  const assetOf = (p: LiquidityPosition) => assets.find((a) => a.id === p.asset) ?? assets.find((a) => a.symbol === p.symbol && a.issuer === p.issuer) ?? null;
  const total = data?.positions.reduce((s, p) => s + p.valueQu, 0) ?? 0;

  return (
    <section className="liqpos" aria-label="Your liquidity" aria-busy={loading}>
      <header className="liqpos-head">
        <div>
          <h3>Your liquidity</h3>
          {data && data.positions.length > 0 && (
            <p className="note first num" title={`${n(total)} QU`}>
              {data.positions.length} {data.positions.length === 1 ? "pool" : "pools"}, worth about {compact(total)} QU at the pools' prices
            </p>
          )}
        </div>
        {walletId && (
          <button className="ghost liqpos-refresh" onClick={() => setRetry((x) => x + 1)} disabled={loading} aria-label="Read the positions again">
            <Icon name="clock" size={14} /> {loading ? "Reading…" : "Refresh"}
          </button>
        )}
      </header>

      {!walletId && (
        <div className="empty liqpos-empty">
          <span className="empty-icon"><Icon name="wallet" size={22} /></span>
          <p>Connect a wallet to see the pools you provide liquidity to.</p>
        </div>
      )}

      {walletId && error && (
        <div className="banner err" role="alert">
          <Icon name="alert" size={18} />
          <span>Could not read your liquidity: {error}</span>
          <button className="ghost" onClick={() => setRetry((x) => x + 1)}>Try again</button>
        </div>
      )}

      {walletId && !data && !error && (
        <ul className="liqpos-list" role="status" aria-label="Reading your liquidity">
          {[0, 1].map((i) => (
            <li key={i} className="liqpos-card">
              <span className="liqpos-id"><span className="skeleton circle" /><span className="skeleton line" style={{ width: 80 }} /></span>
              <span className="skeleton line" style={{ width: "70%" }} />
              <span className="skeleton line" style={{ width: "50%" }} />
            </li>
          ))}
        </ul>
      )}

      {data && data.positions.length === 0 && (
        <div className="empty liqpos-empty">
          <span className="empty-icon"><Icon name="layers" size={22} /></span>
          <p>No liquidity yet: add some from a pool below.</p>
        </div>
      )}

      {data && data.positions.length > 0 && (
        <ul className={loading ? "liqpos-list loading" : "liqpos-list"}>
          {data.positions.map((p) => {
            const a = assetOf(p);
            return (
              <li key={p.asset} className="liqpos-card">
                <span className="liqpos-id">
                  <Avatar symbol={p.symbol} category={a?.category} issuer={a?.issuer} size={34} />
                  <span className="liqpos-name">
                    <strong>{p.symbol}</strong>
                    <small className="num">{pct(p.sharePct)} of the pool</small>
                  </span>
                  <span className="liqpos-value num" title={`${n(p.valueQu)} QU: ${n(p.quOut)} QU plus ${n(p.assetOut)} ${p.symbol} at the pool's price`}>
                    <b>{compact(p.valueQu)} <small>QU</small></b>
                    <small>estimated value</small>
                  </span>
                </span>
                <dl className="liqpos-facts">
                  <div>
                    <dt>Removing all pays</dt>
                    <dd className="num">{n(p.quOut)} QU + {n(p.assetOut)} {p.symbol}</dd>
                  </div>
                  <div>
                    <dt>Liquidity units</dt>
                    <dd className="num">{n(p.liquidity)}</dd>
                  </div>
                  <div>
                    <dt title="The contract's own figure. The fees are already inside what removing pays; nothing pays them separately.">Fees earned <Icon name="info" size={12} /></dt>
                    <dd className="num">{n(p.earnedFeesQu)} QU</dd>
                  </div>
                </dl>
                <span className="liqpos-actions">
                  <button className="ghost" disabled={!a} onClick={() => a && onAdd(a)}>Add</button>
                  <button className="ghost" disabled={!a} onClick={() => a && onRemove(a)}>Remove</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {data && !data.complete && (
        <p className="warn note">Some pools could not be read ({data.failed.map((f) => f.asset).join(", ")}), so a position there may be missing. Refresh to try again.</p>
      )}
      {data && data.positions.length > 0 && (
        <p className="note liqpos-note">
          Value is what removing everything pays (QU plus tokens valued at the pool's own price), before QSwap's flat 100,000 QU fee to remove. Fees earned are already inside it. Price moves change it (impermanent loss).
        </p>
      )}
    </section>
  );
}
