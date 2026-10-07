import { useEffect, useMemo, useState } from "react";
import { depthChartSvg } from "../src/chart.ts";
import type { Palette } from "../src/chart.ts";
import type { BookRow } from "../src/book.ts";
import { fetchBook } from "./client.ts";
import type { BookResponse } from "./client.ts";
import { formatPrice } from "./AssetList.tsx";
import { useTheme } from "./theme.ts";
import { Icon } from "./ui.tsx";
import { ChartView } from "./ChartView.tsx";
import type { ChartFocus } from "./ChartView.tsx";
import { PremiumView } from "./PremiumView.tsx";
import { BacktestView } from "./BacktestView.tsx";
import { TradeTape } from "./TradeTape.tsx";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const pct = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(2)}%`);
const date = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Tab = "book" | "chart" | "venues" | "trades" | "backtest" | null;

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
export function MarketPanel({ assetId, symbol, defaultTab = null, focus, venues }: { assetId: string; symbol: string; defaultTab?: Tab; focus?: ChartFocus; venues?: ("QX" | "QSwap")[] }) {
  const [tab, setTab] = useState<Tab>(defaultTab);
  return (
    <div className="market">
      <div className="segtabs" role="tablist" aria-label="Market data">
        <button role="tab" aria-selected={tab === "chart"} className={tab === "chart" ? "on" : ""} onClick={() => setTab(tab === "chart" ? null : "chart")}><Icon name="chart" size={15} /> Price chart</button>
        <button role="tab" aria-selected={tab === "book"} className={tab === "book" ? "on" : ""} onClick={() => setTab(tab === "book" ? null : "book")}><Icon name="book" size={15} /> Order book</button>
        <button role="tab" aria-selected={tab === "trades"} className={tab === "trades" ? "on" : ""} onClick={() => setTab(tab === "trades" ? null : "trades")}><Icon name="bolt" size={15} /> Trades</button>
        <button role="tab" aria-selected={tab === "venues"} className={tab === "venues" ? "on" : ""} onClick={() => setTab(tab === "venues" ? null : "venues")}><Icon name="swap" size={15} /> Markets</button>
        <button role="tab" aria-selected={tab === "backtest"} className={tab === "backtest" ? "on" : ""} onClick={() => setTab(tab === "backtest" ? null : "backtest")}><Icon name="clock" size={15} /> Backtest</button>
      </div>
      {tab === "book" && <BookView assetId={assetId} symbol={symbol} />}
      {tab === "chart" && <ChartView assetId={assetId} symbol={symbol} focus={focus} venues={venues} />}
      {tab === "venues" && <PremiumView assetId={assetId} symbol={symbol} />}
      {tab === "trades" && <TradeTape assetId={assetId} limit={200} />}
      {tab === "backtest" && <BacktestView assetId={assetId} symbol={symbol} />}
    </div>
  );
}

function BookView({ assetId, symbol }: { assetId: string; symbol: string }) {
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
  return (
    <div className="book">
      {qx && (
        <>
          <div className="chart" dangerouslySetInnerHTML={{ __html: depthChartSvg(qx, { symbol, palette }) }} />
          <div className="ladder" aria-label="QX order book">
            <div className="ladder-head"><span>Price (QU)</span><span>Size</span><span>Total</span></div>
            {[...qx.asks].reverse().map((r) => <Row key={`a${r.price}`} r={r} side="ask" />)}
            <div className="ladder-mid">
              {qx.mid === null ? "No orders" : <>Middle {formatPrice(qx.mid)} QU · spread {pct(qx.spreadPct)}</>}
            </div>
            {qx.bids.map((r) => <Row key={`b${r.price}`} r={r} side="bid" />)}
          </div>
          <p className="note">
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

function Row({ r, side }: { r: BookRow; side: "ask" | "bid" }) {
  return (
    <div className="ladder-row">
      <span className={side}>{formatPrice(r.price)}</span>
      <span>{n(r.qty)}{r.orders > 1 && <small> ({r.orders})</small>}</span>
      <span>{n(r.cumQty)}</span>
    </div>
  );
}
