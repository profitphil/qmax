import { useEffect, useMemo, useRef, useState } from "react";
import { depthChartSvg } from "../src/chart.ts";
import type { Palette } from "../src/chart.ts";
import type { BookRow } from "../src/book.ts";
import { fetchBook } from "./client.ts";
import type { BookResponse } from "./client.ts";
import { formatPrice } from "./AssetList.tsx";
import { compactPrices, compactQu, compactUnits } from "./format.ts";
import { useTheme } from "./theme.ts";
import { Icon } from "./ui.tsx";
import { ChartView } from "./ChartView.tsx";
import type { ChartFocus } from "./ChartView.tsx";
import { PremiumView } from "./PremiumView.tsx";
import { BacktestView } from "./BacktestView.tsx";
import { SellersView } from "./SellersView.tsx";
import { TradeTape } from "./TradeTape.tsx";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const pct = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(2)}%`);
const date = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export type MarketTab = "book" | "chart" | "venues" | "trades" | "backtest" | "sellers" | null;
type Tab = MarketTab;

/** The charts are SVG text made elsewhere (the Discord bot draws the same ones), so they get the page's colours here and follow the theme. */
function useChartPalette(): Partial<Palette> {
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
      font: "Inter, system-ui, sans-serif",
    };
  }, [theme]);
}

/** The market for one asset: what is resting on the QX order book, how the QSwap pool prices bigger trades, and the price over time. Loads only when opened. */
export function MarketPanel({ assetId, symbol, defaultTab = null, focus, venues, tab: shownTab, onTab }: { assetId: string; symbol: string; defaultTab?: Tab; focus?: ChartFocus; venues?: ("QX" | "QSwap")[]; tab?: Tab; onTab?: (t: Tab) => void }) {
  // The page can hold the tab (`tab` with `onTab`) so something outside the panel, a phone's order book button, can switch it; without those the panel keeps its own.
  const [ownTab, setOwnTab] = useState<Tab>(defaultTab);
  const tab = shownTab === undefined ? ownTab : shownTab;
  // In a narrow column (the workspace's chart column, a phone) the six tabs are shown as short words only, so all of them fit.
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    setNarrow(el.getBoundingClientRect().width < 560); // measured at once, then followed
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const setTab = (t: Tab) => {
    setOwnTab(t);
    onTab?.(t);
  };
  return (
    <div className={narrow ? "market narrow" : "market"} ref={root}>
      <div className="segtabs" role="tablist" aria-label="Market data">
        <button role="tab" aria-selected={tab === "chart"} className={tab === "chart" ? "on" : ""} onClick={() => setTab(tab === "chart" ? null : "chart")} title="Price chart"><Icon name="chart" size={15} /> {narrow ? "Chart" : "Price chart"}</button>
        <button role="tab" aria-selected={tab === "book"} className={tab === "book" ? "on" : ""} onClick={() => setTab(tab === "book" ? null : "book")} title="Order book"><Icon name="book" size={15} /> {narrow ? "Book" : "Order book"}</button>
        <button role="tab" aria-selected={tab === "trades"} className={tab === "trades" ? "on" : ""} onClick={() => setTab(tab === "trades" ? null : "trades")}><Icon name="bolt" size={15} /> Trades</button>
        <button role="tab" aria-selected={tab === "venues"} className={tab === "venues" ? "on" : ""} onClick={() => setTab(tab === "venues" ? null : "venues")}><Icon name="swap" size={15} /> Markets</button>
        <button role="tab" aria-selected={tab === "backtest"} className={tab === "backtest" ? "on" : ""} onClick={() => setTab(tab === "backtest" ? null : "backtest")}><Icon name="clock" size={15} /> Backtest</button>
        <button role="tab" aria-selected={tab === "sellers"} className={tab === "sellers" ? "on" : ""} onClick={() => setTab(tab === "sellers" ? null : "sellers")} title="Who has been selling this asset, and what they paid"><Icon name="logout" size={15} /> Sellers</button>
      </div>
      {tab === "book" && <BookView assetId={assetId} symbol={symbol} />}
      {tab === "chart" && <ChartView assetId={assetId} symbol={symbol} focus={focus} venues={venues} />}
      {tab === "venues" && <PremiumView assetId={assetId} symbol={symbol} />}
      {tab === "trades" && <TradeTape assetId={assetId} limit={200} />}
      {tab === "backtest" && <BacktestView assetId={assetId} symbol={symbol} />}
      {tab === "sellers" && <SellersView assetId={assetId} symbol={symbol} />}
    </div>
  );
}

export function BookView({ assetId, symbol }: { assetId: string; symbol: string }) {
  const palette = useChartPalette();
  const [book, setBook] = useState<BookResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const ctl = new AbortController();
    const load = () => fetchBook(assetId, ctl.signal).then((b) => (setBook(b), setError(""))).catch((e) => e.name !== "AbortError" && setError(e.message));
    load();
    const t = setInterval(load, 20_000); // the book moves: keep it fresh while it is open
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [assetId]);

  if (error && !book) return <p className="err">{error}</p>;
  if (!book) return <div className="skeleton block" role="status" aria-label="Reading the order book" />;
  const { qx, qswap } = book;
  const askRows = qx ? [...qx.asks].reverse() : [];
  const askShort = compactPrices(askRows.map((r) => r.price));
  const bidShort = compactPrices((qx?.bids ?? []).map((r) => r.price));
  /** How many characters the longest price label is (a phone shows the short ones): the price column is made that wide, so no price runs into the wallet beside it. */
  const priceChars = Math.max(6, ...askShort.map((t) => t.length), ...bidShort.map((t) => t.length));
  return (
    <div className="book">
      {qx && (
        <>
          <div className="chart" dangerouslySetInnerHTML={{ __html: depthChartSvg(qx, { symbol, palette }) }} />
          <div className="ladder five" aria-label="QX order book" style={{ "--price-ch": priceChars } as React.CSSProperties}>
            <div className="ladder-head">
              <span>Price (QU)</span>
              <span title="The wallet that placed the orders at this price: its first four letters, linked to the explorer">Wallet</span>
              <span title="Units resting at this price">Size</span>
              <span title="Units you would take going from the best price down to this row">Total</span>
              <span title="What those units cost (or pay) in QU, going from the best price down to this row">Total (QU)</span>
            </div>
            {askRows.map((r, i) => <Row key={`a${r.price}`} r={r} side="ask" short={askShort[i]} />)}
            <div className="ladder-mid">
              {qx.mid === null ? "No orders" : <>Middle {formatPrice(qx.mid)} QU · spread {pct(qx.spreadPct)}</>}
            </div>
            {qx.bids.map((r, i) => <Row key={`b${r.price}`} r={r} side="bid" short={bidShort[i]} />)}
          </div>
          <p className="note">
            Total adds up from the middle: the units, and the QU, you would take going from the best price out to that row.{" "}
            {n(qx.asksTotal.orders)} sell and {n(qx.bidsTotal.orders)} buy orders on QX in {n(qx.asksTotal.levels)} and {n(qx.bidsTotal.levels)} price levels.
            {qx.truncated && " QX returns at most 256 orders per side, so there may be more beyond these."}
          </p>
        </>
      )}
      {!qx && <p className="note">This asset has no QX order book.</p>}
      {qswap && (
        <div className="pool">
          <h4><span className="dot qswap" /> QSwap pool</h4>
          <p className="note">
            {formatPrice(qswap.price)} QU each · {n(qswap.reserveQu)} QU and {n(qswap.reserveAsset)} {symbol} in the pool · fee {qswap.feePct}%. Price per unit, fee included, for a trade of:
          </p>
          <div className="ladder">
            <div className="ladder-head pool-head"><span>Size</span><span>Buy at</span><span>Sell at</span></div>
            {qswap.depth.map((d) => (
              <div className="ladder-row pool-row" key={d.fraction}>
                <span>{n(d.qty)} <small>({d.fraction * 100}% of pool)</small></span>
                <span className="ask">{d.buyAvgPrice === null ? "n/a" : <>{formatPrice(d.buyAvgPrice)} <small>+{pct(d.buyImpactPct)}</small></>}</span>
                <span className="bid">{d.sellAvgPrice === null ? "n/a" : <>{formatPrice(d.sellAvgPrice)} <small>−{pct(d.sellImpactPct)}</small></>}</span>
              </div>
            ))}
          </div>
          <p className="note">QSwap also charges a flat 100,000 QU per swap on top of this.</p>
        </div>
      )}
    </div>
  );
}

/** A count of units: written out, and (on a phone, by the page's styles) as "241.2K" so five columns fit. */
const Units = ({ x }: { x: number }) => (
  <span title={n(x)}>
    <span className="n-full">{n(x)}</span>
    <span className="n-short">{compactUnits(x)}</span>
  </span>
);

/** Who has the orders at a price: the wallet's first four letters (a link to it in the explorer), "3×" when that many different wallets are there, a dash when the book did not say. */
function Owner({ r }: { r: BookRow }) {
  if (r.owner) {
    return (
      <a className="owner" href={`https://explorer.qubic.org/network/address/${r.owner}`} target="_blank" rel="noreferrer" title={`${r.owner}\nOpen this wallet in the explorer`}>
        {r.owner.slice(0, 4)}
      </a>
    );
  }
  if ((r.owners ?? 0) > 1) return <span className="owner many" title={`${r.owners} different wallets have orders at this price`}>{r.owners}×</span>;
  return <span className="owner none">–</span>;
}

function Row({ r, side, short }: { r: BookRow; side: "ask" | "bid"; short: string }) {
  return (
    <div className="ladder-row">
      <span className={side} title={`${n(r.price)} QU`}>
        <span className="n-full">{formatPrice(r.price)}</span>
        <span className="n-short">{short}</span>
      </span>
      <Owner r={r} />
      <span><Units x={r.qty} />{r.orders > 1 && <small> ({r.orders})</small>}</span>
      <span><Units x={r.cumQty} /></span>
      <span title={`${n(r.cumQu)} QU`}>{compactQu(r.cumQu)}</span>
    </div>
  );
}
