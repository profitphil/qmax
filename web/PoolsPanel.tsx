import { useEffect, useId, useMemo, useState } from "react";
import { FEE_MODEL, MAX_POSITION_QU, POOLS_CAVEAT, parseQuAmount, rankPools } from "../src/pools.ts";
import { fetchPoolDetail, fetchPools } from "./pools-api.ts";
import type { PoolDetailResponse, PoolItem, PoolSort, PoolWindow, PoolsResponse } from "./pools-api.ts";
import type { AssetItem } from "./client.ts";
import { LiquidityModal } from "./LiquidityModal.tsx";
import { PoolPositions } from "./PoolPositions.tsx";
import { Avatar, Icon } from "./ui.tsx";

const WINDOWS: PoolWindow[] = ["7d", "30d"];
const SORTS: [PoolSort, string][] = [
  ["apr", "Fee APR"],
  ["tvl", "TVL"],
  ["volume", "Volume"],
];
const PRESETS = ["10M", "100M", "1B"];
const MINUS = "−";

/* ---------- formatting: every QU figure carries its unit, every estimate says so ---------- */

const compactFmt = (digits: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: digits });
/** 3,600,000,000 becomes "3.6B"; the full number goes in a tooltip. */
const compact = (x: number) => compactFmt(Math.abs(x) >= 1e9 ? 2 : Math.abs(x) >= 1e6 ? 1 : 0).format(x);
const full = (x: number) => `${x.toLocaleString("en-US", { maximumFractionDigits: 2 })} QU`;
const qu = (x: number) => `${compact(x)} QU`;
/** A percentage with a real minus sign, and no sign at all on something that rounds to zero. */
const pct = (x: number | null, digits = 2, signed = true) => {
  if (x === null) return "n/a";
  const r = Number(Math.abs(x).toFixed(digits));
  return `${r === 0 ? "" : x < 0 ? MINUS : signed ? "+" : ""}${r.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
};
/** An APR needs fewer decimals as it grows: 6.77%, 39.7%, 5,005%. */
const apr = (x: number) => (x === 0 ? "0%" : x < 10 ? `${x.toFixed(2)}%` : x < 1000 ? `${x.toFixed(1)}%` : `${Math.round(x).toLocaleString("en-US")}%`);
const price = (x: number | null) => (x === null ? "n/a" : x >= 100 ? x.toLocaleString("en-US", { maximumFractionDigits: 0 }) : x.toLocaleString("en-US", { maximumFractionDigits: x < 1 ? 4 : 2 }));
const tone = (x: number | null) => (x === null || Math.abs(x) < 0.005 ? "" : x > 0 ? "up" : "down");
/** Impermanent loss is never a gain: grey when negligible, amber when it matters, red when it is large. */
const ilTone = (x: number | null) => (x === null || x > -0.5 ? "" : x > -2 ? "mid" : "down");

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const FROM = {
  "before-window": "from the last swap before the window",
  "first-swap-in-window": "from its first swap inside the window",
  "no-swaps": "no swaps, so it did not move",
} as const;

/* ---------- the panel ---------- */

/**
 * Where to provide liquidity on QSwap: every pool ranked by what it really earned from swap volume, what the price moving cost,
 * and how far to trust the numbers. Selecting a pool opens a plain-English breakdown and a deposit calculator below its row.
 * `onSelectAsset` is told the asset id when someone asks to trade that asset (the button is left out without it).
 */
export function PoolsPanel({ onSelectAsset, assets, walletId, onConnect, onChanged }: {
  onSelectAsset?: (assetId: string) => void;
  /** The asset list: with it the panel shows the wallet's positions and offers adding and removing liquidity. */
  assets?: AssetItem[];
  walletId?: string | null;
  onConnect?: () => void;
  /** Told when liquidity was added or removed, so the page can read the wallet again. */
  onChanged?: () => void;
}) {
  const [liq, setLiq] = useState<{ asset: AssetItem; mode: "add" | "remove" } | null>(null);
  const [posReload, setPosReload] = useState(0);
  const [win, setWin] = useState<PoolWindow>("7d");
  const [sort, setSort] = useState<PoolSort>("apr");
  const [data, setData] = useState<PoolsResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // The server ranks and caches the list for a minute; reading it again a little later keeps the panel fresh while it is open.
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    fetchPools(win, sort, ctl.signal)
      .then((r) => (setData(r), setError("")))
      .catch((e) => e.name !== "AbortError" && setError(e.message))
      .finally(() => !ctl.signal.aborted && setLoading(false));
    return () => ctl.abort();
  }, [win, reload]);
  useEffect(() => {
    const t = setInterval(() => setReload((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  // Sorting is the server's own function, applied here too, so the chips answer at once.
  const pools = useMemo(() => (data ? rankPools(data.pools, sort) : []), [data, sort]);
  const scale = useMemo(() => Math.max(5, ...pools.filter((p) => !p.lowConfidence).map((p) => p.feeAprPct)), [pools]);
  const firstFlagged = sort === "apr" ? pools.findIndex((p) => p.lowConfidence) : -1;
  const label = data?.window ?? win;

  return (
    <section className="pools" aria-label="Liquidity pools" aria-busy={loading}>
      <header className="pools-head">
        <div>
          <h2>Liquidity pools</h2>
          <p className="note first">What each QSwap pool really earned from swap volume, and what the price moving cost the people providing liquidity.</p>
        </div>
        <div className="pools-controls">
          <div className="chips" role="group" aria-label="Window">
            {WINDOWS.map((w) => (
              <button key={w} className={win === w ? "chip on" : "chip"} aria-pressed={win === w} onClick={() => setWin(w)}>{w}</button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Sort by">
            {SORTS.map(([id, text]) => (
              <button key={id} className={sort === id ? "chip on" : "chip"} aria-pressed={sort === id} onClick={() => setSort(id)}>{text}</button>
            ))}
          </div>
        </div>
      </header>
      <p className="infoline pools-caveat">
        <Icon name="info" size={16} />
        <span>{POOLS_CAVEAT}</span>
      </p>

      {error && !data && (
        <div className="banner err" role="alert">
          <Icon name="alert" size={18} />
          <span>Could not load the pools: {error}</span>
          <button className="ghost" onClick={() => setReload((n) => n + 1)}>Try again</button>
        </div>
      )}
      {error && data && <p className="err note">Could not refresh ({error}); showing what was loaded earlier.</p>}

      {!data && !error && <Skeleton />}

      {data && pools.length === 0 && (
        <div className="empty">
          <span className="empty-icon"><Icon name="layers" size={22} /></span>
          <p>No QSwap pools to show yet. Pools appear here once an asset has liquidity on QSwap and QMax has read its swaps.</p>
        </div>
      )}

      {assets && (
        <PoolPositions walletId={walletId ?? null} assets={assets} reloadKey={posReload} onAdd={(asset) => setLiq({ asset, mode: "add" })} onRemove={(asset) => setLiq({ asset, mode: "remove" })} />
      )}

      {data && pools.length > 0 && (
        <div className={loading ? "pools-table loading" : "pools-table"}>
          <div className="pools-cols" aria-hidden="true">
            <span>#</span>
            <span>Pool</span>
            <span className="r">Price</span>
            <span className="r">TVL</span>
            <span className="r">Volume {label}</span>
            <span>Fee APR</span>
            <span className="r">Change {label}</span>
            <span className="r">IL</span>
          </div>
          <ul className="pools-list">
            {pools.map((p, i) => (
              <li key={p.id} className={open === p.id ? "pools-item open" : "pools-item"}>
                {i === firstFlagged && (
                  <p className="pools-divider">
                    <Icon name="info" size={14} /> Lower confidence from here: few swaps, a tiny pool, a one-off burst or suspected wash volume. Their APR is shown but ranked below the rest.
                  </p>
                )}
                <PoolRow pool={p} scale={scale} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />
                {open === p.id && (
                  <PoolDetail
                    pool={p}
                    onSelectAsset={onSelectAsset}
                    onAddLiquidity={assets ? (id) => { const a = assets.find((x) => x.id === id); if (a) setLiq({ asset: a, mode: "add" }); } : undefined}
                    reload={reload}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {liq && (
        <LiquidityModal
          asset={liq.asset}
          mode={liq.mode}
          onConnect={onConnect}
          onClose={() => setLiq(null)}
          onChanged={() => {
            setPosReload((k) => k + 1);
            setReload((k) => k + 1);
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="pools-table" role="status" aria-label="Loading the pools">
      <ul className="pools-list">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="pools-item">
            <div className="pools-row skel">
              <span className="skeleton line" style={{ width: 18 }} />
              <span className="pools-pool">
                <span className="skeleton circle" />
                <span className="pools-names"><span className="skeleton line" style={{ width: 70 }} /><span className="skeleton line" style={{ width: 110 }} /></span>
              </span>
              <span className="skeleton line" style={{ width: 70, justifySelf: "end" }} />
              <span className="skeleton line" style={{ width: 70, justifySelf: "end" }} />
              <span className="skeleton line" />
              <span className="skeleton line" style={{ width: 54, justifySelf: "end" }} />
              <span className="skeleton line" style={{ width: 54, justifySelf: "end" }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PoolRow({ pool: p, scale, open, onToggle }: { pool: PoolItem; scale: number; open: boolean; onToggle: () => void }) {
  const detailId = useId();
  const note = p.quality.find((q) => q.code !== "inflated-volume");
  const width = Math.min(100, (p.feeAprPct / scale) * 100);
  return (
    <button type="button" className="pools-row" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={onToggle}>
      <span className="pools-rank num">{p.rank}</span>
      <span className="pools-pool">
        <Avatar symbol={p.symbol} size={36} />
        <span className="pools-names">
          <span className="pools-symbol">
            <strong>{p.symbol}</strong>
            {p.volumeInflated && (
              <span className="pools-flag" role="img" aria-label="Volume looks inflated" title="Volume looks inflated: some of it may be wash trading, so the fee APR may be higher than ordinary trading would pay.">
                <Icon name="alert" size={14} />
              </span>
            )}
          </span>
          <span className="pools-sub">
            {note ? <span className="pools-pill" title={note.message}>{note.label}</span> : plural(p.swaps, "swap")}
          </span>
        </span>
        <Icon name="chevron" size={16} className="pools-chev" />
      </span>
      <span className="pools-cell pools-lprice r" title={`The pool's price right now: its QU divided by its ${p.symbol}`}>
        <span className="pools-label">Latest price</span>
        <span className="num pools-lprice-v">{price(p.poolPriceQu ?? p.priceQu)} <small>QU</small></span>
      </span>
      <span className="pools-cell pools-tvl r" title={full(p.tvlQu)}>
        <span className="pools-label">TVL</span>
        <span className="num">{compact(p.tvlQu)} <small>QU</small></span>
      </span>
      <span className="pools-cell pools-vol r" title={full(p.volumeQu)}>
        <span className="pools-label">Volume {p.window}</span>
        <span className="num">{compact(p.volumeQu)} <small>QU</small></span>
      </span>
      <span className="pools-cell pools-aprcell">
        <span className="pools-label">Fee APR</span>
        <span className="pools-apr">
          <span className="num pools-aprnum">{apr(p.feeAprPct)}</span>
          <span className={p.lowConfidence ? "pools-bar low" : "pools-bar"} aria-hidden="true"><i style={{ width: `${width}%` }} /></span>
        </span>
      </span>
      <span className="pools-cell pools-price r">
        <span className="pools-label">Change {p.window}</span>
        <span className={`num pools-tone ${tone(p.priceChangePct)}`}>{pct(p.priceChangePct, 1)}</span>
      </span>
      <span className="pools-cell pools-il r">
        <span className="pools-label" title="Impermanent loss: holding the pool share vs holding the two assets">IL</span>
        <span className={`num pools-tone ${ilTone(p.impermanentLossPct)}`}>{pct(p.impermanentLossPct, 2)}</span>
      </span>
    </button>
  );
}

/* ---------- one pool in plain English, and the deposit calculator ---------- */

function PoolDetail({ pool, onSelectAsset, onAddLiquidity, reload }: { pool: PoolItem; onSelectAsset?: (assetId: string) => void; onAddLiquidity?: (assetId: string) => void; reload: number }) {
  const id = useId();
  const [text, setText] = useState("100M");
  const [amount, setAmount] = useState<number | null>(parseQuAmount("100M"));
  const [detail, setDetail] = useState<PoolDetailResponse | null>(null);
  const [error, setError] = useState("");
  const parsed = parseQuAmount(text);

  // Wait for the typing to settle before asking the server.
  useEffect(() => {
    if (parsed === null) return;
    const t = setTimeout(() => setAmount(parsed), 350);
    return () => clearTimeout(t);
  }, [parsed]);

  useEffect(() => {
    if (amount === null) return;
    const ctl = new AbortController();
    fetchPoolDetail(pool.id, pool.window, amount, ctl.signal)
      .then((d) => (setDetail(d), setError("")))
      .catch((e) => e.name !== "AbortError" && setError(e.message));
    return () => ctl.abort();
  }, [pool.id, pool.window, amount, reload]);

  const s = detail && detail.pool.window === pool.window && detail.pool.id === pool.id ? detail.pool : pool;
  const est = detail?.positionEstimate && detail.positionEstimate.positionQu === amount ? detail.positionEstimate : null;
  const days = s.windowDays;
  const inputError = text.trim() === "" ? "Enter an amount in QU, for example 100M." : parsed === null ? `Enter an amount in QU, like 100,000,000 or 100M (at most ${MAX_POSITION_QU.toLocaleString("en-US")}).` : "";

  return (
    <div className="pools-detail" id={id} role="region" aria-label={`${pool.symbol} pool details`}>
      <div className="pools-dhead">
        <h3>{pool.symbol} pool, last {days} days</h3>
        <span className="pools-latest" title={`The pool's price right now: its ${pool.poolQu.toLocaleString("en-US")} QU divided by its ${pool.poolAsset.toLocaleString("en-US")} ${pool.symbol}`}>
          Latest price <b className="num">{price(pool.poolPriceQu ?? pool.priceQu)} QU</b>
          {pool.priceQu !== null && pool.poolPriceQu !== null && Math.abs(pool.priceQu - pool.poolPriceQu) / pool.priceQu > 0.005 && <small className="muted"> (market {price(pool.priceQu)} QU)</small>}
        </span>
        {onAddLiquidity && (
          <button type="button" className="primary" onClick={() => onAddLiquidity(pool.id)}>
            <Icon name="layers" size={14} /> Add liquidity
          </button>
        )}
        {onSelectAsset && (
          <button type="button" className="ghost" onClick={() => onSelectAsset(pool.id)}>
            Trade {pool.symbol} <Icon name="arrowUpRight" size={14} />
          </button>
        )}
      </div>

      {s.quality.length > 0 && (
        <ul className="pools-notes" aria-label="How far to trust these numbers">
          {s.quality.map((q) => (
            <li key={q.code} className={q.code === "inflated-volume" ? "pools-note warn" : "pools-note"}>
              <Icon name={q.code === "inflated-volume" ? "alert" : "info"} size={15} />
              <span><b>{q.label}.</b> {q.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="pools-cols2">
        <div>
          <h4>What it means</h4>
          <ul className="pools-explain">
            <li>
              <b>Fees.</b> {plural(s.swaps, "swap")} moved <b className="num" title={full(s.volumeQu)}>{qu(s.volumeQu)}</b> through the pool.{" "}
              {FEE_MODEL.lpFeePctOfVolume}% of each swap's value stays in the pool for liquidity providers, which came to <b className="num" title={full(s.feesToLpQu)}>{qu(s.feesToLpQu)}</b>. The pool holds <b className="num" title={full(pool.poolQu)}>{qu(pool.poolQu)}</b> plus {pool.poolAsset.toLocaleString("en-US")} {pool.symbol}.
            </li>
            <li>
              <b>Fee APR.</b> That is {pct(s.feeReturnPct, 3, false)} of the pool's value (TVL {qu(s.tvlQu)}) in {days} days. If it kept exactly this pace it would be about <b className="num">{apr(s.feeAprPct)}</b> a year. It is a trailing figure, not a promise, and it can change fast.
            </li>
            <li>
              <b>Price.</b>{" "}
              {s.priceChangePct === null ? (
                "The pool has no price right now (one side is empty), so there is nothing to compare."
              ) : (
                <>
                  The pool price {s.priceChangePct === 0 ? "did not change" : <>moved <b className={`num pools-tone ${tone(s.priceChangePct)}`}>{pct(s.priceChangePct, 1)}</b></>}{s.priceChangeFrom && s.priceChangeFrom !== "no-swaps" ? ` (measured ${FROM[s.priceChangeFrom]}, to ${s.poolPriceQu === null ? "now" : `${price(s.poolPriceQu)} QU now`})` : ""}.
                  {" "}Holding the pool share instead of the two assets would have left you <b className={`num pools-tone ${ilTone(s.impermanentLossPct)}`}>{pct(s.impermanentLossPct === null ? null : Math.abs(s.impermanentLossPct), 2, false)}</b> behind. This is impermanent loss, and it shrinks if the price comes back.
                </>
              )}
            </li>
            <li>
              <b>Net against holding.</b> Fees plus impermanent loss is <b className={`num pools-tone ${tone(s.netVsHoldPct)}`}>{pct(s.netVsHoldPct, 2)}</b> over the window. It is an estimate for someone who held the pool share for the whole window; it ignores when within the window you would have joined and any change in the pool's size.
            </li>
            <li>
              <b>TVL</b> is twice the QU in the pool. That assumes the pool is balanced at its own price; if the asset sells for less elsewhere, the real value is lower.
            </li>
          </ul>

          <h4>Where the swap fee goes</h4>
          <div className="pools-split" role="img" aria-label={FEE_MODEL.split.map((x) => `${x.who} ${x.pct}%`).join(", ")}>
            {FEE_MODEL.split.map((x, i) => <span key={x.who} className={`pools-seg s${i}`} style={{ flexBasis: `${x.pct}%` }} />)}
          </div>
          <ul className="pools-legend">
            {FEE_MODEL.split.map((x, i) => <li key={x.who}><i className={`pools-seg s${i}`} />{x.who} <b className="num">{x.pct}%</b></li>)}
          </ul>
          <p className="note">QSwap charges {FEE_MODEL.swapFeePct}% of each swap and splits it as above, so {FEE_MODEL.lpFeePctOfVolume}% of the swap's value reaches liquidity providers. Traders also pay a flat {FEE_MODEL.flatFeeQu.toLocaleString("en-US")} QU per swap; it goes to shareholders and burning, not to liquidity providers.</p>
        </div>

        <div className="pools-calc">
          <h4>If you added liquidity</h4>
          <label className="field" htmlFor={`${id}-qu`}>
            <span id={`${id}-lbl`}>Deposit, both sides together, in QU</span>
            <span className="inputwrap">
              <input id={`${id}-qu`} inputMode="decimal" autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} aria-labelledby={`${id}-lbl`} aria-invalid={inputError !== ""} aria-describedby={`${id}-hint`} />
              <span className="unit">QU</span>
            </span>
            <small id={`${id}-hint`} className={inputError ? "err" : undefined}>{inputError || "The QU value of the QU and the asset you would put in, at today's pool price (half and half)."}</small>
          </label>
          <div className="chips pools-presets" role="group" aria-label="Deposit presets">
            {PRESETS.map((p) => (
              <button key={p} type="button" className={parseQuAmount(p) === parsed ? "chip on" : "chip"} onClick={() => setText(p)}>{p} QU</button>
            ))}
          </div>

          {error && !est && <p className="err note">Could not work out the estimate: {error}</p>}
          {!est && !error && amount !== null && <div className="skeleton block pools-skel" role="status" aria-label="Working out the estimate" />}
          {est && (
            <div className={parsed !== amount ? "pools-est stale" : "pools-est"} aria-live="polite">
              <div className="pools-stats">
                <div className="stat"><span className="stat-label">Fees per day</span><span className="stat-value num" title={full(est.feesPerDayQu)}>{qu(est.feesPerDayQu)}</span></div>
                <div className="stat"><span className="stat-label">Fees per 30 days</span><span className="stat-value num" title={full(est.feesPer30dQu)}>{qu(est.feesPer30dQu)}</span></div>
                <div className="stat"><span className="stat-label">Fee APR for you</span><span className="stat-value num">{apr(est.aprAfterDepositPct)}</span><span className="stat-hint">{pct(est.sharePct, 2, false)} of the pool</span></div>
              </div>
              <p className="note">
                At the trailing rate, with your deposit counted in the pool (a bigger deposit lowers the rate for everyone). Fees stay in the pool and come back when you remove liquidity.
              </p>
              <p className="note">
                <b>Costs:</b> adding and removing liquidity each cost a flat {est.costs.addQu.toLocaleString("en-US")} QU ({est.costs.roundTripQu.toLocaleString("en-US")} QU both ways).{" "}
                {est.costs.daysToCoverCosts === null ? "At this pool's pace the fees would never cover that." : `At this pace the fees take about ${est.costs.daysToCoverCosts.toLocaleString("en-US", { maximumFractionDigits: 1 })} days to cover it.`}
              </p>

              <table className="pools-iltable">
                <caption>Impermanent loss if the price moves, against holding the two assets</caption>
                <thead>
                  <tr><th scope="col">Price moves</th><th scope="col" className="r">Loss</th><th scope="col" className="r">In QU</th></tr>
                </thead>
                <tbody>
                  {est.il.map((r) => (
                    <tr key={r.movePct}>
                      <th scope="row" className="num">{r.movePct > 0 ? "+" : MINUS}{Math.abs(r.movePct)}%</th>
                      <td className={`num r pools-tone ${ilTone(r.ilPct)}`}>{pct(r.ilPct, 2)}</td>
                      <td className="num r" title={full(r.ilQu)}>{MINUS}{compact(Math.abs(r.ilQu))} <small>QU</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note">{est.notes[0]}</p>
            </div>
          )}
        </div>
      </div>
      <p className="note pools-foot">{POOLS_CAVEAT}</p>
    </div>
  );
}
