import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchArbitrage, fetchBook, fetchQuote, livePrice, lookupAssetById, shownName } from "./client.ts";
import type { ArbitrageResult, AssetItem, QuoteResponse } from "./client.ts";
import { useSettings } from "./settings.tsx";
import { arbFiltersOf } from "../src/settings.ts";
import { describeFilters, hasFilters } from "../src/arbfilters.ts";
import { PAYWALL } from "../src/config.ts";
import { usePass } from "./exec/pass.ts";
import { PassModal } from "./PassModal.tsx";
import { MarketPanel } from "./MarketPanel.tsx";
import { compactPrice, formatPrice, spreadOf } from "./AssetList.tsx";
import { fetchBalance, fetchHoldings } from "./exec/chain.ts";
import { assessLimitReadiness, assessReadiness } from "../src/readiness.ts";
import { farFromMarket, limitProblem, placement } from "../src/limit.ts";
import type { QxBook } from "../src/book.ts";
import { LimitOrderModal, PlacementNote } from "./LimitOrderModal.tsx";
import { comparePrices } from "../src/arbitrage.ts";
import type { Holdings } from "../src/exec.ts";
import { ExecuteModal } from "./ExecuteModal.tsx";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Avatar, Icon, Modal, Spinner } from "./ui.tsx";
import { useMedia } from "./media.ts";
import { useAssetCatalog } from "./catalog.ts";
import { AssetSwitcher } from "./AssetSwitcher.tsx";
import { useVolWindow, volLong, volumeOf } from "./volwin.tsx";
import { TradesDock } from "./TradesDock.tsx";
import { presetLabel, presetsFor } from "../src/amounts.ts";
import { MaxModal } from "./MaxModal.tsx";
import { useMaxMode } from "./maxmode.tsx";
import { SavingsLine } from "./savings.tsx";
import { HealthPanel } from "./HealthPanel.tsx";
import { HealthBadge } from "./HealthBadge.tsx";
import { Resizer } from "./Resizer.tsx";
import { useHealthAll } from "./health-api.ts";

const n = (x: number, d = 2) => x.toLocaleString("en-US", { maximumFractionDigits: d });
/** Contracts whose shares QMax can trade directly: QX (1) and QSwap (13). */
const TRADABLE_CONTRACTS = [1, 13];

/** Adds thousands separators while typing and keeps the caret next to the same digit. */
function formatTyped(raw: string, caret: number) {
  const digitsBefore = raw.slice(0, caret).replace(/\D/g, "").length;
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  const text = digits === "" ? "" : Number(digits).toLocaleString("en-US");
  let pos = 0;
  let seen = 0;
  while (pos < text.length && seen < digitsBefore) if (/\d/.test(text[pos++])) seen++;
  return { text, caret: pos };
}

interface Props {
  asset: AssetItem;
  initialSide: "buy" | "sell";
  /** Prefilled from a link another site sent the user to. */
  initialQty?: number;
  /** What each unit of this asset the wallet holds cost, in QU, when the page knows it (it sets the profit on an exit). */
  avgCostQu?: number | null;
  /** The partner that sent the user, if any. */
  refTag?: string;
  /** Closes the dialog. Not used when `docked`: the panel is part of the page and stays. */
  onClose?: () => void;
  onConnect: () => void;
  /** Part of the workspace page instead of a dialog over it: no close button, and the amount box does not grab the keyboard. */
  docked?: boolean;
  /** Told when the review dialog is closed, so the page can read the wallet again (a trade may have gone through). */
  onRefresh?: () => void;
  /** Go to another asset (from the arrows or the picker beside the symbol), keeping the side. */
  onSwitch?: (asset: AssetItem, side: "buy" | "sell") => void;
  /** Go to Qubic's own chart (offered in the switcher beside the symbol, as the entry before the first asset). */
  onQubic?: () => void;
}

/** Whether the chart was left in wide mode: kept from one asset to the next, so switching does not undo it. */
let wideChart = false;

const PANEL_KEY = "qmax.trade.panel";
/** Whether the order panel under the chart is open: remembered in this browser (open until it is hidden once). */
let panelOpenPref: boolean | null = null;
const readPanelOpen = () => {
  if (panelOpenPref === null) {
    try {
      panelOpenPref = localStorage.getItem(PANEL_KEY) !== "0";
    } catch {
      panelOpenPref = true;
    }
  }
  return panelOpenPref;
};
const writePanelOpen = (open: boolean) => {
  panelOpenPref = open;
  try {
    localStorage.setItem(PANEL_KEY, open ? "1" : "0");
  } catch {
    // not remembered: it still holds until the page is reloaded
  }
};

/** Last, bid, ask, spread and volume in a row, as the header of a trading screen. */
function QuoteStrip({ asset: picked }: { asset: AssetItem }) {
  // the figures follow the market: the list is read again every 20 seconds, and the open asset's latest entry is shown (what it was opened with is the fallback)
  const asset = useAssetCatalog().find((a) => a.id === picked.id) ?? picked;
  const spread = spreadOf(asset);
  const [win] = useVolWindow();
  const cells: [string, string, string][] = [
    ["Last", compactPrice(livePrice(asset)), `${formatPrice(livePrice(asset))} QU`],
    ["Bid", compactPrice(asset.bestBid ?? null), `Best QX buy order: ${formatPrice(asset.bestBid ?? null)} QU`],
    ["Ask", compactPrice(asset.bestAsk ?? null), `Best QX sell order: ${formatPrice(asset.bestAsk ?? null)} QU`],
    ["Spread", spread === null ? "–" : `${spread < 10 ? spread.toFixed(1) : Math.round(spread)}%`, "The gap between the best QX bid and ask"],
    [`Vol ${win}`, volumeOf(asset, win) ? compactPrice(volumeOf(asset, win)) : "–", `${formatPrice(volumeOf(asset, win))} QU in ${volLong(win)} (24 hours: ${formatPrice(asset.volume24hQu ?? 0)} QU in ${asset.trades24h ?? 0} trade${asset.trades24h === 1 ? "" : "s"}). Change the window in the list's Vol heading.`],
    ["Depth", compactPrice(asset.liquidityQu), "QU in the QX order book and the pool"],
  ];
  return (
    <dl className="qstrip" aria-label={`${shownName(asset)} quote`}>
      {cells.map(([label, value, title]) => (
        <div key={label} title={title}>
          <dt>{label}</dt>
          <dd className="num">{value}</dd>
        </div>
      ))}
      <div className="qstrip-unit"><dt>&nbsp;</dt><dd>QU</dd></div>
    </dl>
  );
}

export function TradePanel({ asset, initialSide, initialQty, avgCostQu, refTag, onClose, onConnect, docked, onRefresh, onSwitch, onQubic }: Props) {
  const { connected, wallet } = useQubicConnect();
  /** From tablet width up the order ticket is a slim bar under the chart (the chart gets the room); on a phone it stays a block above it. */
  const bar = useMedia("(min-width: 901px)") || !!docked;
  const [side, setSide] = useState(initialSide);
  const [qtyText, setQtyText] = useState(initialQty ? initialQty.toLocaleString("en-US") : "");
  const { settings } = useSettings();
  const [slippagePct, setSlippagePct] = useState(String(settings.slippagePct));
  const [liveArb, setLiveArb] = useState<ArbitrageResult | null | "loading">(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** The chart takes the whole dialog (the order ticket is hidden until it is switched back): room for the chart tools. */
  // The order panel can be put away to give the chart the whole screen; a link that brings an amount keeps it open.
  const [panelOpen, setPanelOpen] = useState(() => !!initialQty || readPanelOpen());
  const togglePanel = () =>
    setPanelOpen((open) => {
      writePanelOpen(!open);
      return !open;
    });
  const [chartFocusState, setChartFocusState] = useState(wideChart);
  const chartFocus = chartFocusState;
  const setChartFocus = (f: boolean | ((v: boolean) => boolean)) =>
    setChartFocusState((cur) => {
      wideChart = typeof f === "function" ? f(cur) : f;
      return wideChart;
    });
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [held, setHeld] = useState<number | null>(null);
  const [elsewhere, setElsewhere] = useState(0);
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  // Max: QMax searching for the best position for this trade (see MaxModal), a Pro feature.
  const [maxOpen, setMaxOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // Market (the default: QMax finds the best route and the order fills now) or limit (an order at a price of your own, placed on the QX book).
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [priceText, setPriceText] = useState("");
  const [qxBook, setQxBook] = useState<QxBook | null>(null);
  const [reviewingLimit, setReviewingLimit] = useState(false);
  // On a phone the order panel is a sheet that a floating Buy / Sell pill opens: the chart gets the screen. A link with an amount opens it at once.
  const [sheetOpen, setSheetOpen] = useState(() => !!initialQty);
  const openSheet = (s: "buy" | "sell") => {
    setSide(s);
    setSheetOpen(true);
  };
  const priceRef = useRef<HTMLInputElement>(null);
  const onQx = asset.venues.includes("QX");
  const isLimit = orderType === "limit" && onQx;
  const [unlocking, setUnlocking] = useState(false);
  const { hasPass, refresh: refreshPass } = usePass(wallet?.publicKey);
  // Max mode (the switch in Settings): on, the order panel can search the best position for the trade (see MaxModal).
  const max = useMaxMode();

  // Moved to another asset with the picker: the amount was for the last one.
  const lastAsset = useRef(asset.id);
  useEffect(() => {
    if (lastAsset.current === asset.id) return;
    lastAsset.current = asset.id;
    setQtyText("");
    setPriceText("");
    setQxBook(null);
    setMaxOpen(false); // a search that was open is for the last asset
  }, [asset.id]);

  const qty = Number(qtyText.replace(/,/g, ""));
  const slippageBps = Math.round(Number(slippagePct) * 100);
  const validQty = Number.isInteger(qty) && qty > 0;
  const price = Number(priceText.replace(/,/g, ""));
  const priceProblem = limitProblem({ side, price, qty: validQty ? qty : 1 });

  // What the wallet holds and its QU balance: used for Max (to size its search), and for the trade-ready checklist.
  useEffect(() => {
    setHeld(null);
    setElsewhere(0);
    setHoldings(null);
    setBalance(null);
    if (!wallet) return;
    let alive = true;
    fetchBalance(wallet.publicKey).then((b) => alive && setBalance(b)).catch(() => {});
    if (!asset.issuer) {
      setHoldings({});
      return;
    }
    fetchHoldings(wallet.publicKey, asset.issuer, asset.symbol)
      .then((h) => {
        if (!alive) return;
        setHoldings(h);
        const tradable = TRADABLE_CONTRACTS.reduce((sum, c) => sum + (h[c] ?? 0), 0);
        setHeld(tradable);
        setElsewhere(Object.entries(h).filter(([c]) => !TRADABLE_CONTRACTS.includes(Number(c))).reduce((sum, [, v]) => sum + v, 0));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [wallet?.publicKey, asset.id]);

  useEffect(() => {
    if (isLimit || !validQty || !(slippageBps >= 0 && slippageBps <= 1000)) {
      setQuote(null);
      setError("");
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      fetchQuote({ side, asset: asset.id, qty, slippageBps }, ctl.signal)
        .then((q) => {
          setQuote(q);
          setError("");
        })
        .catch((e) => {
          if (e.name !== "AbortError") {
            setQuote(null);
            setError(e.message);
          }
        })
        .finally(() => setLoading(false));
    }, 350);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [asset.id, side, qty, slippageBps, isLimit]);

  // For a limit order: the book as it stands, to say whether the price waits or matches now (read again every 15 seconds while this is open).
  useEffect(() => {
    if (!isLimit) return;
    const ctl = new AbortController();
    const load = () => fetchBook(asset.id, ctl.signal).then((b) => setQxBook(b.qx)).catch(() => {});
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => {
      ctl.abort();
      clearInterval(timer);
    };
  }, [asset.id, isLimit]);

  // A sheet that was just opened is for typing an amount.
  useEffect(() => {
    if (sheetOpen && !bar) inputRef.current?.focus({ preventScroll: true });
  }, [sheetOpen]);

  // Put the caret back where the user was typing after the commas were re-inserted.
  useLayoutEffect(() => {
    if (caretRef.current !== null && inputRef.current && document.activeElement === inputRef.current) {
      inputRef.current.setSelectionRange(caretRef.current, caretRef.current);
    }
    caretRef.current = null;
  }, [qtyText]);

  const readiness = assessReadiness({
    side,
    qty,
    connected,
    quote: validQty ? quote : null,
    balanceQu: balance,
    holdings,
    activity: asset.activity,
    hasPass: connected ? hasPass : false,
  });
  const limitReadiness = assessLimitReadiness({ side, qty, price, connected, hasPass: connected ? hasPass : false, balanceQu: balance, heldQty: held, onQx, problem: validQty ? priceProblem : "Enter an amount." });
  const shownReadiness = isLimit ? limitReadiness : readiness;
  const comparison = comparePrices(asset);
  const arbFilters = arbFiltersOf(settings);
  // Live check (full depth, fresh data) for assets on both markets; the card flag is only an estimate from cached data.
  useEffect(() => {
    if (asset.venues.length < 2 || !max.active) {
      setLiveArb(null); // the arbitrage check is part of Max
      return;
    }
    const ctl = new AbortController();
    setLiveArb("loading");
    fetchArbitrage(asset.id, arbFilters, ctl.signal).then(setLiveArb).catch((e) => e.name !== "AbortError" && setLiveArb(null));
    return () => ctl.abort();
  }, [asset.id, max.active, arbFilters.minProfitQu, arbFilters.minProfitPct, arbFilters.maxCostQu]);
  // The search already applies your arbitrage settings, so what comes back is the best one that fits them.
  const arb = max.active && liveArb && liveArb !== "loading" ? liveArb.opportunity : null;

  const tooMany = side === "sell" && held !== null && validQty && qty > held;
  const canReview = validQty && readiness.ready && !tooMany;
  const canReviewLimit = validQty && limitReadiness.ready;
  const bestBid = qxBook?.bestBid ?? asset.bestBid ?? null;
  const bestAsk = qxBook?.bestAsk ?? asset.bestAsk ?? null;
  const placed = isLimit && validQty && !priceProblem ? placement({ side, price, qty }, qxBook) : null;
  const far = isLimit && price > 0 ? farFromMarket(price, bestBid, bestAsk) : null;

  const qxPrice = asset.poolQu && asset.poolAsset ? asset.poolQu / asset.poolAsset : null;
  const health = useHealthAll();
  const refreshing = loading && !!quote;
  const noLiquidity = !!quote && quote.route.length === 0 && (quote.warnings.length === 0 || quote.warnings[0].startsWith("No market"));

  const cta =
    connected && hasPass === false ? (
      <button className={`go ${side}`} onClick={() => setUnlocking(true)}>
        <Icon name="bolt" size={17} /> Unlock trading · {n(PAYWALL.priceQu, 0)} QU for {PAYWALL.hours} hours
      </button>
    ) : connected && isLimit ? (
      <button className={`go ${side}`} disabled={!canReviewLimit} onClick={() => setReviewingLimit(true)}>
        {!validQty ? "Enter an amount" : priceProblem ? (price > 0 ? "Fix the price" : "Enter a price") : `Review limit ${side} ${shownName(asset)} at ${n(price, 0)}`}
      </button>
    ) : connected ? (
      <button className={`go ${side}`} disabled={!canReview} onClick={() => setReviewing(true)}>
        {!validQty ? "Enter an amount" : `Review ${side} ${shownName(asset)}`}
      </button>
    ) : (
      <button className={`go ${side}`} onClick={onConnect}>
        <Icon name="wallet" size={17} /> Connect wallet to {side}
      </button>
    );

  // In Max mode the QMax search is the main button, and the ordinary order is still there under it.
  const maxReady = side === "sell" ? held !== null && held > 0 : balance !== null && balance > 0;
  const ctas =
    max.active && connected ? (
      <div className="cta-stack">
        <button type="button" className="go max-go" disabled={!maxReady} onClick={() => setMaxOpen(true)} title="QMax searches for the best position for this trade: the best way to execute, the best size, an arbitrage, the best exit">
          {validQty ? `Max: best ${side} of ${n(qty, 0)} ${shownName(asset)}` : `Max: best position to ${side} ${shownName(asset)}`}
        </button>
        <div className="cta-plain">{cta}</div>
      </div>
    ) : (
      cta
    );

  const readyList = (
    <ul className="ready" aria-label="Trade readiness">
      {shownReadiness.checks.map((c) => (
        <li key={c.id} className={c.state}>
          <span className="mark" aria-hidden="true">
            {c.state === "ok" ? <Icon name="check" size={13} /> : c.state === "warn" ? <Icon name="alert" size={13} /> : c.state === "fail" ? <Icon name="close" size={13} /> : <i />}
          </span>
          <span>{c.label}{c.detail && <small>{c.detail}</small>}</span>
        </li>
      ))}
    </ul>
  );

  /** The price: typed with thousands separators like the amount; a whole number of QU, as QX takes no fractions. */
  const typePrice = (e: React.ChangeEvent<HTMLInputElement>) => setPriceText(formatTyped(e.target.value, e.target.selectionStart ?? e.target.value.length).text);
  const setPriceTo = (v: number | null | undefined) => v && v >= 1 && setPriceText(Math.round(v).toLocaleString("en-US"));
  const refs: [string, number | null | undefined][] = [["Bid", bestBid], ["Ask", bestAsk], ["Last", livePrice(asset)]];
  const pickType = (t: "market" | "limit") => {
    setOrderType(t);
    // Starts at the price that would sit at the front of its side of the book: the best bid for a buy, the best ask for a sale.
    if (t === "limit" && !priceText) setPriceTo(side === "buy" ? bestBid ?? asset.priceQu : bestAsk ?? asset.priceQu);
  };
  const orderTypeSeg = (
    <div className="seg ordertype" role="group" aria-label="Order type">
      <button className={!isLimit ? "on neutral" : ""} aria-pressed={!isLimit} onClick={() => pickType("market")} title="Fill now at the best price QMax finds across QX and QSwap">Market</button>
      <button className={isLimit ? "on neutral" : ""} aria-pressed={isLimit} disabled={!onQx} onClick={() => pickType("limit")} title={onQx ? "Name your own price: it waits on the QX order book until someone takes it" : "Limit orders are placed on the QX order book, and this asset only trades in a QSwap pool"}>Limit</button>
    </div>
  );
  const limitFields = (
    <div className="limit-fields">
      <label className="amount">
        <span className="amount-top">
          <span>Limit price</span>
          <small>QU for one {shownName(asset)}</small>
        </span>
        <span className="inputwrap">
          <input ref={priceRef} value={priceText} onChange={typePrice} inputMode="numeric" placeholder="Limit price" aria-label={`Limit price in QU for one ${shownName(asset)}`} />
          <span className="unit">QU</span>
        </span>
      </label>
      <div className="chips presets">
        {refs.map(([label, v]) => (v && v >= 1 ? <button key={label} className="chip" onClick={() => setPriceTo(v)} title={`Use the ${label.toLowerCase()} price`}>{label} {compactPrice(Math.round(v))}</button> : null))}
      </div>
      {priceText && priceProblem && validQty && <p className="err inline"><Icon name="alert" size={15} /> {priceProblem}</p>}
      {far !== null && Math.abs(far) >= 20 && <p className="err inline"><Icon name="alert" size={15} /> This price is {n(Math.abs(far), 0)}% {far > 0 ? "above" : "below"} the middle of the book. Check it.</p>}
      <PlacementNote side={side} symbol={shownName(asset)} price={price} qty={qty} placed={placed} />
      {validQty && !priceProblem && (
        <p className="note limit-note">
          {side === "buy" ? <>Up to {n(price * qty)} QU is held in the order while it waits.</> : <>{n(price * qty)} QU if all of it sells, before QX’s fee.</>} QMax charges nothing.
        </p>
      )}
    </div>
  );

  const Rail: React.ElementType = docked && bar ? "aside" : Fragment;
  const railProps = docked && bar ? { className: "rail", "aria-label": "Latest trades and order panel" } : {};

  const content = (
    <>
      <div className="trade-head">
        <Avatar symbol={asset.symbol} category={asset.category} issuer={asset.issuer} size={docked ? 32 : 44} />
        <div className="trade-title">
          {onSwitch ? <AssetSwitcher current={asset} onPick={(a) => onSwitch(a, side)} onQubic={onQubic} slash={!docked} /> : <h2>{shownName(asset)}</h2>}
          <span className="trade-sub">
            {asset.category === "contract" ? "Contract shares" : "Token"}
            <span className="sep">·</span>
            {asset.venues.length > 1 ? (
              <span className="route"><b className="vqx">QX</b><Icon name="swap" size={12} /><b className="vqs">QSwap</b></span>
            ) : (
              <span className="route single"><b>{asset.venues[0]}</b></span>
            )}
            <HealthBadge health={health.data?.assets[asset.id]} loading={health.loading} onClick={() => document.getElementById("trade-health")?.scrollIntoView({ behavior: "smooth", block: "start" })} />
          </span>
        </div>
        {docked ? (
          <QuoteStrip asset={asset} />
        ) : (
          <div className="trade-price" title={`${formatPrice(livePrice(asset))} QU`}>
            <span className="num">{compactPrice(livePrice(asset))}</span>
            <small>QU</small>
          </div>
        )}
        {!docked && (
          <button className="iconbtn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" />
          </button>
        )}
      </div>

      <div className="trade-body">
        <section className="pane market-pane" aria-label={`${shownName(asset)} market`}>
          <MarketPanel key={asset.id} assetId={asset.id} symbol={shownName(asset)} venues={asset.venues} defaultTab="chart" focus={{ on: chartFocus, toggle: () => setChartFocus((v) => !v) }} />
          <p className="venue-note">
            <Icon name="info" size={15} />
            <span>
              {asset.venues.length > 1
                ? <><b>Both markets:</b> trades on both QX and QSwap. QMax compares them and can split your order for the best price.</>
                : <>Only trades on <b>{asset.venues[0]}</b>, so there is no cheaper route to find. {asset.venues[0] === "QX" ? "Large orders are still split across QX price levels to keep the average down." : "The price follows the pool, so larger orders move it more."}</>}
            </span>
          </p>
          {comparison && !max.active && (
            <p className="infoline compare-locked">
              <span>Which market is cheaper to buy and to sell, by how much, and whether an arbitrage is open between the two markets, are part of Max. <button type="button" className="linklike" onClick={() => max.setOn(true)}>Turn on Max</button> to see them.</span>
            </p>
          )}
          {comparison && max.active && (
            <div className="compare" aria-label="Price comparison between QX and QSwap">
              <div className="compare-head">
                <span />
                <span><i className="dot qx" /> QX</span>
                <span><i className="dot qswap" /> QSwap</span>
                <span className="r">Edge</span>
              </div>
              <div className="compare-row">
                <span className="muted">Buy</span>
                <b className="num">{formatPrice(asset.bestAsk ?? null)}</b>
                <b className="num">{formatPrice(qxPrice ? qxPrice / 0.997 : null)}</b>
                <em className={comparison.buy.pct >= 0.005 ? "good" : ""}>{comparison.buy.pct >= 0.005 ? `${(comparison.buy.pct * 100).toFixed(1)}% cheaper on ${comparison.buy.cheaperOn}` : "about equal"}</em>
              </div>
              <div className="compare-row">
                <span className="muted">Sell</span>
                <b className="num">{formatPrice(asset.bestBid ? asset.bestBid * 0.997 : null)}</b>
                <b className="num">{formatPrice(qxPrice ? qxPrice * 0.997 : null)}</b>
                <em className={comparison.sell.pct >= 0.005 ? "good" : ""}>{comparison.sell.pct >= 0.005 ? `${(comparison.sell.pct * 100).toFixed(1)}% better on ${comparison.sell.betterOn}` : "about equal"}</em>
              </div>
              <p className="note">Per unit, after the 0.3% fees. QSwap also charges a flat 100,000 QU per swap, so for smaller orders the cheaper market can differ. Your quote picks the best one for your size.</p>
            </div>
          )}
          {max.active && asset.venues.length > 1 && liveArb === "loading" && (
            <p className="infoline"><Spinner size={14} /> Checking for arbitrage…</p>
          )}
          {max.active && asset.venues.length > 1 && liveArb && liveArb !== "loading" && !arb && (
            <p className="infoline">
              <Icon name="check" size={15} />
              <span>Arbitrage check: none right now{hasFilters(arbFilters) ? ` that meets your settings (${describeFilters(arbFilters)})` : ""}. Checked live against the full order book and pool.</span>
            </p>
          )}
          {arb && (
            <div className="arbbox">
              <b><Icon name="bolt" size={15} fill /> Arbitrage spotted (checked live)</b>
              <p>
                {arb.direction === "buy-qx-sell-qswap" ? "Buy on QX, sell to the QSwap pool" : "Buy from the QSwap pool, sell on QX"}:
                about {arb.qty.toLocaleString("en-US")} units could leave roughly <b>+{Math.round(arb.profitQu).toLocaleString("en-US")} QU</b> ({arb.profitPct.toFixed(1)}%) after every fee.
              </p>
              <p className="note">It is two separate trades, so the price can move between them and the second may fill worse. This is a snapshot of the top of the QX book and the pool; QMax does not run it for you.</p>
            </div>
          )}
          <div id="trade-health"><HealthPanel key={asset.id} assetId={asset.id} /></div>
        </section>

        {/* Docked (the workspace): the right-hand rail, latest trades on top and the order panel under them. In the dialog it is just the bar under the chart. */}
        <Rail {...railProps}>
        {docked && bar && <Resizer panel="rail" />}
        {docked && bar && (
          <TradesDock
            symbol={shownName(asset)}
            assetId={asset.id}
            onOpenAsset={(id) => void lookupAssetById(id).then((a) => a && onSwitch?.(a, side)).catch(() => {})}
          />
        )}
        {bar && (
          <button type="button" className="bar-toggle" onClick={togglePanel} aria-expanded={panelOpen} title={panelOpen ? "Hide the order panel: the chart gets the room" : "Show the order panel"}>
            <Icon name="chevron" size={13} className={panelOpen ? "" : "flip"} />
            <span>{panelOpen ? "Hide order panel" : "Show order panel"}</span>
            <Icon name="chevron" size={13} className={panelOpen ? "" : "flip"} />
          </button>
        )}
        <section className={!bar && sheetOpen ? "pane ticket sheet" : "pane ticket"} aria-label="Order ticket">
          {!bar && (
            <div className="sheet-head">
              <b>{side === "buy" ? "Buy" : "Sell"} {shownName(asset)}</b>
              <button type="button" className="iconbtn sm" onClick={() => setSheetOpen(false)} aria-label="Close the order panel" title="Close">
                <Icon name="chevron" size={16} />
              </button>
            </div>
          )}
          <div className="ticket-order">
            {orderTypeSeg}
            <div className="seg" role="group" aria-label="Side">
              <button className={side === "buy" ? "on" : ""} aria-pressed={side === "buy"} onClick={() => setSide("buy")}>Buy</button>
              <button className={side === "sell" ? "on sell" : ""} aria-pressed={side === "sell"} onClick={() => setSide("sell")}>Sell</button>
          </div>

          <label className="amount">
            <span className="amount-top">
              <span>Amount</span>
              {connected && side === "sell" && held !== null && <small>Available {n(held, 0)} {shownName(asset)}</small>}
              {connected && side === "buy" && balance !== null && <small>Balance {n(balance, 0)} QU</small>}
            </span>
            <span className="inputwrap">
              <input
                ref={inputRef}
                autoFocus={!docked}
                value={qtyText}
                onChange={(e) => {
                  const f = formatTyped(e.target.value, e.target.selectionStart ?? e.target.value.length);
                  caretRef.current = f.caret;
                  setQtyText(f.text);
                }}
                inputMode="numeric"
                placeholder="0"
                aria-label={`How many ${shownName(asset)}`}
              />
              <span className="unit">{shownName(asset)}</span>
            </span>
          </label>
          <div className="chips presets">
            {presetsFor(asset.category).map((c) => (
              <button key={c} className="chip" onClick={() => setQtyText(c.toLocaleString("en-US"))} title={asset.priceQu ? `${n(c, 0)} ${shownName(asset)}, about ${compactPrice(Math.round(c * asset.priceQu))} QU at the last price` : `${n(c, 0)} ${shownName(asset)}`}>
                {presetLabel(c)}
              </button>
            ))}
          </div>
          {side === "sell" && connected && (
            <p className="note">
              {held === null ? "Checking your balance…" : <>You can sell up to {n(held, 0)} {shownName(asset)}.</>}
              {elsewhere > 0 && <> Another {n(elsewhere, 0)} {shownName(asset)} is managed by other contracts and can't be traded here.</>}
            </p>
          )}
          {tooMany && <p className="err inline"><Icon name="alert" size={15} /> You only hold {n(held ?? 0, 0)} {shownName(asset)}.</p>}
          {bar && <div className="ticket-cta">{ctas}</div>}
          </div>

          <div className="ticket-quote">
            {isLimit && limitFields}
            {!isLimit && error && <p className="err inline"><Icon name="alert" size={15} /> {error}</p>}
            {!isLimit && loading && !quote && validQty && (
              <div className="quote loading" role="status" aria-label="Finding the best price">
                <span className="skeleton line" style={{ width: "40%" }} />
                <span className="skeleton line big" style={{ width: "62%" }} />
                <span className="skeleton line" style={{ width: "100%", height: 10 }} />
                <span className="skeleton line" style={{ width: "80%" }} />
              </div>
            )}

            {!isLimit && quote && validQty && (
              <div className={refreshing ? "quote refreshing" : "quote"} aria-live="polite">
                {quote.route.length > 0 && (
                  <div className="quote-top">
                    <span className="quote-label">{quote.side === "buy" ? "You pay" : "You receive"}</span>
                    <strong className="quote-total num">≈ {n(quote.totalQu, 0)} <small>QU</small></strong>
                    {quote.averagePriceQu !== null && <span className="quote-avg">{n(quote.averagePriceQu, 2)} QU each on average, fees included</span>}
                  </div>
                )}
                {noLiquidity && (
                  <p className="err inline"><Icon name="alert" size={15} /> Not enough liquidity to fill this order. Try a smaller amount.</p>
                )}
                {quote.route.length > 0 && (
                  <div className="routebar" role="img" aria-label={quote.route.map((r) => `${r.venue} ${n(r.shareOfOrder * 100, 0)}%`).join(", ")}>
                    {quote.route.map((r) => (
                      <span key={r.venue} className={r.venue === "QX" ? "seg qx" : "seg qswap"} style={{ flexGrow: Math.max(r.shareOfOrder, 0.03) }} />
                    ))}
                  </div>
                )}
                <ul className="legs">
                  {quote.route.map((r) => (
                    <li key={r.venue}>
                      <span className="leg-name">
                        <i className={r.venue === "QX" ? "dot qx" : "dot qswap"} />
                        <strong>{r.venue}</strong>
                        {quote.route.length > 1 && <span className="muted">{n(r.shareOfOrder * 100, 0)}% of your order</span>}
                      </span>
                      <span className="leg-detail">
                        {n(r.qty, 0)} {r.priceRangeQu ? (
                          <>
                            filled at {r.priceRangeQu.best === r.priceRangeQu.worst ? n(r.priceRangeQu.best, 0) : `${n(r.priceRangeQu.best, 0)} to ${n(r.priceRangeQu.worst, 0)}`} QU
                            {r.depth && r.depth.levelsUsed > 1 && <> across {n(r.depth.levelsUsed, 0)} orders</>}
                            <small className="muted"> (avg {n(r.effectivePriceQu, 2)} QU)</small>
                          </>
                        ) : (
                          <>@ {n(r.effectivePriceQu, 4)} QU</>
                        )}
                      </span>
                    </li>
                  ))}
                  {quote.route.length > 0 && (
                    <li className="fees">
                      <span className="leg-name muted">Market fees (trading + fixed)</span>
                      <span className="leg-detail">{n(quote.route.reduce((a, r) => a + r.feesQu + r.fixedCostQu, 0), 0)} QU</span>
                    </li>
                  )}
                </ul>
                {quote.route.some((r) => r.venue === "QSwap") && quote.qty * (asset.priceQu ?? 0) < 1_000_000 && (
                  <p className="note">QSwap charges a flat 100,000 QU per swap, so very small orders cost more per unit.</p>
                )}
                <SavingsLine quote={quote} />
                {quote.warnings.filter((w) => !(noLiquidity && w.startsWith("No market"))).map((w) => <p key={w} className="warn inline"><Icon name="alert" size={15} /> {w}</p>)}
                {!quote.executable && <p className="note">This server is showing demo data, so trading is disabled.</p>}
              </div>
            )}

            {!isLimit && (
              <>
                <button className="link advanced-toggle" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
                  <Icon name="sliders" size={14} /> {showAdvanced ? "Hide" : "Advanced"} settings
                </button>
                {showAdvanced && (
                  <label className="field">
                    Maximum price movement (slippage) %
                    <input value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} inputMode="decimal" />
                  </label>
                )}
              </>
            )}

            {readyList}
          </div>
          {!bar && (
            <div className="ticket-cta sheet-cta">
              {ctas}
              <p className="trade-trust"><Icon name="shield" size={14} /> Non-custodial: you review and sign each transaction in your own wallet.</p>
            </div>
          )}
          {bar && panelOpen && !docked && (
            <TradesDock
              symbol={shownName(asset)}
              assetId={asset.id}
              onOpenAsset={(id) => void lookupAssetById(id).then((a) => a && onSwitch?.(a, side)).catch(() => {})}
            />
          )}
        </section>
        </Rail>
      </div>

      {!bar && sheetOpen && <button type="button" className="sheet-scrim" aria-label="Close the order panel" onClick={() => setSheetOpen(false)} />}
      {!bar && !sheetOpen && (
        <div className="order-pill" role="group" aria-label="Place an order">
          <button type="button" className="buy" onClick={() => openSheet("buy")}>Buy</button>
          <button type="button" className="sell" onClick={() => openSheet("sell")}>Sell</button>
        </div>
      )}

      {unlocking && <PassModal onClose={() => setUnlocking(false)} onUnlocked={refreshPass} />}
      {maxOpen && (
        <MaxModal
          asset={asset}
          side={side}
          qty={validQty ? qty : undefined}
          balanceQu={balance}
          heldQty={held}
          avgCostQu={avgCostQu}
          slippageBps={slippageBps >= 0 && slippageBps <= 1000 ? slippageBps : 100}
          refTag={refTag}
          onClose={() => setMaxOpen(false)}
          onDone={() => onRefresh?.()}
        />
      )}
      {reviewingLimit && isLimit && <LimitOrderModal asset={asset} side={side} qty={qty} price={price} onClose={() => { setReviewingLimit(false); onRefresh?.(); }} />}
      {reviewing && quote && <ExecuteModal shown={quote} slippageBps={slippageBps} expected={{ assetName: asset.symbol, issuer: asset.issuer }} refTag={refTag} onClose={() => { setReviewing(false); onRefresh?.(); }} />}
    </>
  );

  const away = bar && !panelOpen ? " no-ticket" : "";
  if (docked) return <section className={`trade docked bar${chartFocus ? " focus" : ""}${away}`} aria-label={`${shownName(asset)} trading`}>{content}</section>;
  return (
    <Modal onClose={onClose} size="xl" className={`trade${bar ? " bar" : ""}${chartFocus ? " focus" : ""}${away}`} bare>
      {content}
    </Modal>
  );
}
