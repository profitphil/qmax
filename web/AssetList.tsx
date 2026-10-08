import { useEffect, useMemo, useRef, useState } from "react";
import { fetchAssetList, lastTradeAge, livePrice, searchAssets, shownName } from "./client.ts";
import { VolSelect, changeOf, useVolWindow, volLong, volumeOf } from "./volwin.tsx";
import { defaultDir, sortAssets, spreadOf } from "../src/listsort.ts";
import type { SortDir, SortKey } from "../src/listsort.ts";
import type { AssetItem } from "./client.ts";
import { fetchOwned, fetchRestingOrders } from "./exec/chain.ts";
import { ConsolidateModal } from "./ConsolidateModal.tsx";
import { useFavorites } from "./favorites.ts";
import { OrdersPanel } from "./OrdersPanel.tsx";
import { PoolsPanel } from "./PoolsPanel.tsx";
import { HealthBadge } from "./HealthBadge.tsx";
import { LedgerPanel } from "./LedgerPanel.tsx";
import { SwapModal } from "./SwapModal.tsx";
import { SwapPanel } from "./SwapPanel.tsx";
import { useHealthAll } from "./health-api.ts";
import { usePortfolio } from "./portfolio-api.ts";
import { MyAssetsSummary } from "./MyAssetsSummary.tsx";
import { useQuPrice } from "./qu-api.ts";
import { compactQu, shortDate, signedPct, signedQu } from "./format.ts";
import { proTitle, useMaxMode } from "./maxmode.tsx";
import { comparePrices, findArbitrage } from "../src/arbitrage.ts";
import { arbFiltersOf } from "../src/settings.ts";
import { useSettings } from "./settings.tsx";
import { Avatar, Icon } from "./ui.tsx";
import { useMedia } from "./media.ts";
import type { MarketStats } from "./chrome.tsx";

export const formatPrice = (p: number | null) =>
  p === null ? "–" : p >= 100 ? p.toLocaleString("en-US", { maximumFractionDigits: 0 }) : p.toLocaleString("en-US", { maximumFractionDigits: p < 1 ? 4 : 2 });

/** Short form for rows: 8,750,000,000 becomes 8.75B. The trade panel shows the full number. */
export const compactPrice = (p: number | null, compact = true) =>
  compact && p !== null && p >= 1_000_000
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(p)
    : formatPrice(p);

/** 1 to 5 bars from a rough market size in QU (log scale). */
const depthBars = (liquidityQu: number) => Math.max(1, Math.min(5, Math.floor((Math.log10(Math.max(liquidityQu, 1)) - 6) / 1.1) + 1));

export const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
/** A whole-number percent for the change column (the sign is written beside it). */
const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
export { spreadOf };

type Tab = "mine" | "orders" | "history" | "favs" | "all" | "contract" | "token" | "pools" | "swap";
/** The screens that are a page of their own in the workspace layout, where the list shows only the one. */
export type ListPage = "mine" | "orders" | "history" | "pools" | "swap";

const HINTS: Record<Tab, string> = {
  orders: "Your resting QX orders. Cancel any you no longer want.",
  history: "What you bought and sold on QX and QSwap, with profit and loss. Estimated from on-chain transfers.",
  mine: "Assets in your wallet that can be traded here.",
  favs: "Assets you starred.",
  all: "Every tradable asset.",
  contract: "Shares of Qubic smart contracts (QX, QUTIL, QEARN…)",
  token: "Community tokens issued on Qubic (CFB, QXMR…)",
  pools: "QSwap liquidity pools: what each earns in fees from real swap volume, and what price moves cost.",
  swap: "Give one token, get another: two trades on the best routes across QX and QSwap.",
};

const PAGE_TITLES: Record<ListPage, string> = { mine: "Portfolio", orders: "Open orders", history: "History", pools: "Pools", swap: "Swap" };
/** Names for the tabs of the narrow watchlist. */
const WATCH_LABELS: Partial<Record<Tab, string>> = { mine: "Mine", favs: "Favorites", all: "All", contract: "Contracts", token: "Tokens" };
const WATCH_TABS: Tab[] = ["mine", "favs", "all", "contract", "token"];
/** The two screens a small screen splits the list into (see `show`): the markets, and what is yours or a tool for it. */
const MARKET_TABS: Tab[] = ["favs", "all", "contract", "token"];
const PORTFOLIO_TABS: Tab[] = ["mine", "orders", "history", "pools", "swap"];

interface Props {
  /**
   * `list`: the whole market in one list with its tabs (a phone or a narrow window; a row opens the trade dialog).
   * `watch`: a dense watchlist for the side of the workspace (a row selects the asset shown beside it).
   * `page`: only the screen named by `page` (open orders, history, pools or swap).
   */
  mode?: "list" | "watch" | "page";
  /** With `list`: only the markets' tabs (Favorites, All, Contracts, Tokens) or only the portfolio's (My assets, Orders, History, Pools, Swap): the two screens of the small-screen layout. Left out, the one list has every tab. */
  show?: "market" | "portfolio";
  page?: ListPage;
  /** The asset open in the workspace (marked in the watchlist). */
  selectedId?: string | null;
  /** The watchlist found its busiest asset: the workspace opens it when nothing else is selected. */
  onDefault?: (asset: AssetItem) => void;
  /** Open the order for an asset. `avgCost` is what each unit the wallet holds cost, when this list knows it (it sets the profit on a Max exit). */
  onTrade: (asset: AssetItem, side: "buy" | "sell", qty?: number, avgCost?: number | null) => void;
  onConnect: () => void;
  /** Connected wallet's identity, if any. */
  walletId: string | null;
  /** Change this to re-read the wallet (e.g. after a trade). */
  refreshKey: number;
  /** Told what the list holds, for the numbers at the top of the page. */
  onStats?: (s: MarketStats) => void;
  /** Told when something that moves the wallet's holdings finished (a swap), so the page can read the wallet again. */
  onChanged?: () => void;
}

/** A column heading that sorts: the arrow shows the column in use and the way round, and ↕ marks one that can be chosen. */
function SortHead({ id, label, title, sort, dir, onSort, left }: { id: SortKey; label: string; title: string; sort: SortKey; dir: SortDir; onSort: (k: SortKey) => void; left?: boolean }) {
  const on = sort === id;
  return (
    <button type="button" className={`sh${left ? "" : " r"}${on ? " on" : ""}`} aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : "none"} onClick={() => onSort(id)} title={title}>
      {label}
      <span className="sh-arrow" aria-hidden="true">{on ? (dir === "desc" ? "▼" : "▲") : "↕"}</span>
    </button>
  );
}

export function AssetList({ mode = "list", show, page, selectedId, onDefault, onTrade, onConnect, walletId, refreshKey, onStats, onChanged }: Props) {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>(mode === "page" && page ? page : show === "portfolio" ? "mine" : "all");
  useEffect(() => {
    if (mode === "page" && page) setTab(page);
  }, [mode, page]);
  const { settings } = useSettings();
  const [sort, setSort] = useState<SortKey>(settings.defaultSort);
  const [dir, setDir] = useState<SortDir>(defaultDir(settings.defaultSort));
  /** A sort chosen from the buttons above the list: that column, the way it sorts first. */
  const chooseSort = (k: SortKey) => {
    setSort(k);
    setDir(defaultDir(k));
  };
  /** A column heading: the same column again turns it round, another column sorts by that. */
  const headSort = (k: SortKey) => (k === sort ? setDir((d) => (d === "asc" ? "desc" : "asc")) : chooseSort(k));
  const [consolidating, setConsolidating] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState("");
  const [owned, setOwned] = useState<Record<string, number>>({});
  const [bestOf2, setBestOf2] = useState(false);
  const [activeOnly, setActiveOnly] = useState(settings.hideQuiet);
  const [arbOnly, setArbOnly] = useState(false);
  const [orderCount, setOrderCount] = useState(0);
  const [activity, setActivity] = useState<{ ready: boolean; progress: number }>({ ready: false, progress: 0 });
  const favs = useFavorites();
  const [volWin, setVolWin] = useVolWindow();
  // Max mode (the switch in Settings): on, a held asset can be swapped for another asset, and a trade can use QMax's best-position search.
  const max = useMaxMode();
  // The arbitrage filter, flags and count are part of Max: with Max off the filter is ignored (the chip asks to switch Max on instead).
  const arbOnlyOn = arbOnly && max.active;
  const health = useHealthAll();
  const [swapFrom, setSwapFrom] = useState<AssetItem | null>(null);

  // The list is read again every 20 seconds while the page is in view (and at once when it comes back into view), so the prices, changes and volumes move with the market;
  // while the API is still doing its first network scan it is read more often, so the list fills in on its own.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const load = async () => {
      clearTimeout(timer);
      // the first read goes ahead whatever the page is showing; later ones wait for it to be in view
      if (!first && document.visibilityState !== "visible") {
        timer = setTimeout(load, 20_000);
        return;
      }
      first = false;
      let wait = 20_000;
      try {
        const res = await fetchAssetList();
        if (stop) return;
        // an asset found by searching the network that this answer does not list yet stays where it is
        setAssets((cur) => (cur.length ? [...res.assets, ...cur.filter((c) => !res.assets.some((r) => r.id === c.id))] : res.assets));
        setReady(res.ready);
        if (res.activity) setActivity(res.activity);
        setError("");
        if (!res.ready || res.activity?.ready === false) wait = res.ready ? 15000 : 4000;
      } catch (e) {
        if (stop) return;
        setError(`Cannot reach the server: ${e instanceof Error ? e.message : e}`);
        wait = 8000;
      }
      timer = setTimeout(load, wait);
    };
    const onVisible = () => document.visibilityState === "visible" && void load();
    void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // What the connected wallet holds, so "My assets" needs no scrolling.
  const [switched, setSwitched] = useState(false);
  useEffect(() => {
    if (!walletId) {
      setOwned({});
      setSwitched(false);
      if (tab === "mine" && mode !== "page" && show !== "portfolio") setTab("all");
      return;
    }
    let alive = true;
    fetchOwned(walletId)
      .then((o) => alive && setOwned(o))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [walletId, refreshKey]);

  // Open-order count for the tab badge (the panel itself loads the details).
  useEffect(() => {
    if (!walletId) return setOrderCount(0);
    let alive = true;
    fetchRestingOrders(walletId).then((o) => alive && setOrderCount(o.length)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [walletId, refreshKey]);

  const heldOf = (a: AssetItem) => owned[`${a.symbol}|${a.issuer}`] ?? 0;
  const mine = useMemo(() => assets.filter((a) => a.issuer && heldOf(a) > 0), [assets, owned]);

  const filters = arbFiltersOf(settings);
  // Price comparison and arbitrage per asset, from the top of each market (cheap to compute, so recomputed when data changes).
  const market = useMemo(() => {
    const m = new Map<string, { cmp: ReturnType<typeof comparePrices>; arb: ReturnType<typeof findArbitrage> }>();
    for (const a of assets) if (a.venues.length > 1) {
        m.set(a.id, { cmp: comparePrices(a), arb: findArbitrage(a, filters) });
      }
    return m;
  }, [assets, filters.minProfitQu, filters.minProfitPct, filters.maxCostQu]);
  useEffect(() => {
    setSort(settings.defaultSort);
    setDir(defaultDir(settings.defaultSort));
  }, [settings.defaultSort]);
  useEffect(() => setActiveOnly(settings.hideQuiet), [settings.hideQuiet]);
  const arbCount = useMemo(() => [...market.values()].filter((x) => x.arb).length, [market]);
  const bothCount = useMemo(() => assets.filter((a) => a.venues.length > 1).length, [assets]);
  useEffect(() => {
    onStats?.({ assets: assets.length, both: bothCount, arb: arbCount, ready });
  }, [assets.length, bothCount, arbCount, ready]);

  // "/" jumps to the search box, as in most trading and docs sites.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // First time the wallet shows holdings, open "My assets".
  useEffect(() => {
    if (mode !== "page" && !show && walletId && !switched && mine.length > 0) {
      setTab("mine");
      setSwitched(true);
    }
  }, [walletId, mine.length, switched]);

  const q = query.trim().toUpperCase();
  const searchingAll = q.length > 0;

  const shown = useMemo(() => {
    const pool = searchingAll
      ? assets.filter((a) => a.symbol.toUpperCase().includes(q)) // typing searches everything
      : tab === "mine"
        ? mine
        : tab === "favs"
          ? assets.filter((a) => favs.has(a.id))
          : tab === "all"
            ? assets
            : assets.filter((a) => a.category === tab);
    // The filters narrow what you browse; they never hide what you hold.
    const filtered = tab === "mine" && !searchingAll
      ? pool
      : pool.filter((a) => (!bestOf2 || a.venues.length > 1) && (!activeOnly || a.activity !== "inactive") && (!arbOnlyOn || !!market.get(a.id)?.arb));
    // The sorts are made here rather than trusted to the order the server sent (src/listsort.ts): by any column, either way; busiest first is the QU traded
    // over the chosen window, then 7 days, then (for the many that did not trade) the most liquid. Rows with nothing in the column go last.
    return sortAssets(filtered, sort, dir, volWin);
  }, [assets, mine, tab, q, sort, dir, favs.ids, bestOf2, activeOnly, arbOnlyOn, market, volWin]);

  // The workspace opens the busiest asset by itself, once the network scan has finished and the volumes are known.
  useEffect(() => {
    if (mode === "watch" && ready && !selectedId && shown.length > 0) onDefault?.(shown[0]);
  }, [mode, ready, selectedId, shown]);

  /** The filters are a choice of one: picking one puts the others down, and picking the one that is on puts it down too (the whole list again). */
  const pickFilter = (f: "both" | "active" | "arb") => {
    const on = f === "both" ? bestOf2 : f === "active" ? activeOnly : arbOnly;
    setBestOf2(f === "both" && !on);
    setActiveOnly(f === "active" && !on);
    setArbOnly(f === "arb" && !on);
  };
  const hiddenInactive = useMemo(() => (activeOnly ? assets.filter((a) => a.activity === "inactive").length : 0), [assets, activeOnly]);

  const phone = useMedia("(max-width: 720px)");
  const allTabs = ([
    { id: "mine", label: "My assets", count: mine.length },
    { id: "orders", label: "Open orders", count: orderCount },
    { id: "history", label: "History", count: 0 },
    { id: "favs", label: "Favorites", count: assets.filter((a) => favs.has(a.id)).length },
    { id: "all", label: "All assets", count: assets.length },
    { id: "contract", label: "Smart contracts", count: assets.filter((a) => a.category === "contract").length },
    { id: "token", label: "Tokens", count: assets.filter((a) => a.category === "token").length },
    { id: "pools", label: "Pools", count: assets.filter((a) => a.poolQu != null && a.poolAsset != null).length },
    { id: "swap", label: "Swap", count: 0 },
  ] as { id: Tab; label: string; count: number }[])
    .filter((t) => mode !== "watch" || WATCH_TABS.includes(t.id))
    .filter((t) => !show || (show === "portfolio" ? PORTFOLIO_TABS : MARKET_TABS).includes(t.id))
    // A phone's rows of tabs fit when the longest names are the short ones.
    .map((t) => (mode === "watch" ? { ...t, label: WATCH_LABELS[t.id] ?? t.label } : phone && t.id === "contract" ? { ...t, label: "Contracts" } : show === "portfolio" && t.id === "orders" ? { ...t, label: "Orders" } : t));
  const tabs = mode === "page" ? [] : allTabs;
  // The bar is two halves: what is yours (left) and the markets (right, with every asset first).
  const personal: Tab[] = ["mine", "orders", "history", "favs"];

  const searchNetwork = async () => {
    setSearching(true);
    setSearchNote("");
    try {
      const found = await searchAssets(q);
      if (found.length === 0) setSearchNote(`No tradable asset named ${q} was found on QX or QSwap.`);
      else setAssets((cur) => [...cur.filter((a) => !found.some((f) => f.id === a.id)), ...found]);
    } catch (e) {
      setSearchNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const showFilters = (tab !== "mine" && tab !== "orders" && tab !== "pools" && tab !== "history" && tab !== "swap") || searchingAll;
  const showTable = !((tab === "orders" || tab === "pools" || tab === "history" || tab === "swap") && !searchingAll);
  const watch = mode === "watch";
  // The portfolio numbers (worth if sold now, cost, profit) are read only while My assets is showing.
  const mineView = tab === "mine" && !searchingAll && !watch;
  const portfolio = usePortfolio({ walletId, assets, owned, enabled: !!walletId && tab === "mine" && !searchingAll });
  const qu = useQuPrice();

  // The tab bar. In the list (a phone, a tablet) it comes first and the search, the sort and the filter chips follow it as one group; in the workspace's
  // narrow watchlist the search stays on top.
  const tabsEl = mode === "page" ? null : (
  <div className="tabs" role="tablist">
          {(show ? (["solo"] as const) : (["me", "market"] as const)).map((group) => (
            <div key={group} className={`tab-group ${group}`} role="presentation">
              {tabs.filter((t) => group === "solo" || personal.includes(t.id) === (group === "me")).map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  data-tab={t.id}
                  aria-selected={!searchingAll && tab === t.id}
                  className={!searchingAll && tab === t.id ? "tab on" : "tab"}
                  onClick={(e) => {
                    setQuery("");
                    setTab(t.id);
                    // keep the active tab visible when the row is wider than the screen: this row only scrolls (scrollIntoView would also move the swipe screens)
                    const btn = e.currentTarget;
                    const row = btn.closest<HTMLElement>(".tabs");
                    if (row && row.scrollWidth > row.clientWidth) {
                      const r = btn.getBoundingClientRect();
                      const c = row.getBoundingClientRect();
                      row.scrollBy({ left: r.left + r.width / 2 - (c.left + c.width / 2), behavior: "smooth" });
                    }
                  }}
                >
                  {t.id === "favs" && <Icon name="star" size={14} fill={!searchingAll && tab === t.id} />}
                  {t.label}{t.id !== "history" && t.id !== "swap" && !(show === "portfolio" && t.id === "pools") && <> <span className={t.count === 0 ? "count zero" : "count"}>{t.count}</span></>}
                </button>
              ))}
            </div>
          ))}
        </div>
  );

  return (
    <section className={mode === "list" ? "markets" : `markets ${mode}`} aria-label={mode === "page" ? PAGE_TITLES[tab as ListPage] : "Markets"}>
      {!watch && tabsEl}
      {mode !== "page" && (show !== "portfolio" || tab === "mine") && <div className="browse-head">
        <div className="toolbar">
          <label className="searchbox">
            <Icon name="search" size={17} />
            <input
              ref={searchRef}
              className="search"
              placeholder="Search assets"
              aria-label="Search assets"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchNote("");
              }}
            />
            {query ? (
              <button type="button" className="iconbtn sm" aria-label="Clear search" onClick={() => { setQuery(""); setSearchNote(""); }}>
                <Icon name="close" size={14} />
              </button>
            ) : (
              <kbd aria-hidden="true">/</kbd>
            )}
          </label>
          <div className="sort" role="group" aria-label="Sort">
            <button className={sort === "volume" ? "on" : ""} aria-pressed={sort === "volume"} onClick={() => chooseSort("volume")} title="Busiest first: the most QU traded in the last 24 hours">Volume</button>
            {/* a phone's list has no column headings, so the window for the volume and the change (24h, 72h, 7d) is chosen here */}
            <VolSelect value={volWin} onChange={setVolWin} />
            <button className={sort === "liquidity" ? "on" : ""} aria-pressed={sort === "liquidity"} onClick={() => chooseSort("liquidity")} title="Most liquid first: the deepest order book and pool">Liquidity</button>
            <button className={sort === "az" ? "on" : ""} aria-pressed={sort === "az"} onClick={() => chooseSort("az")}>A–Z</button>
          </div>
        </div>
      </div>}
      {watch && tabsEl}

      {mode !== "page" && (!watch || searchingAll || (tab === "mine" && walletId)) && (
        <div className="listbar">
          <p className={searchingAll ? "note" : "note hint"}>{searchingAll ? `Results for “${query.trim()}” across all assets` : tab === "swap" || watch ? "" : HINTS[tab]}</p>
          {tab === "mine" && walletId && !searchingAll && (
            <button className="link" onClick={() => setConsolidating(true)} title="Move every share in your wallet under QX (or QSwap) management">Keep all under one contract</button>
          )}
        </div>
      )}

      {showFilters && (
        <div className="filters">
          <button className={bestOf2 ? "fchip on" : "fchip"} aria-pressed={bestOf2} onClick={() => pickFilter("both")} title="Only assets that trade on both QX and QSwap, so an order can be split between them for the best price">
            <Icon name="layers" size={14} /> Both markets
          </button>
          <button className={activeOnly ? "fchip on" : "fchip"} aria-pressed={activeOnly} onClick={() => pickFilter("active")} title={`Hide assets with no QX orders or pool changes in the last 2 epochs (14 days)${activeOnly && activity.ready && hiddenInactive > 0 ? `: ${hiddenInactive} hidden` : ""}`}>
            <Icon name="clock" size={14} /> Active<span className="hide-sm"> (last 2 epochs)</span>
          </button>
          <button
            className={arbOnlyOn ? "fchip on" : max.active ? "fchip" : "fchip locked"}
            aria-pressed={arbOnlyOn}
            onClick={() => (max.active ? pickFilter("arb") : max.setOn(true))}
            title={max.active ? "Assets where buying on one market and selling on the other leaves a profit after all fees" : `Finding the assets where buying on one market and selling on the other leaves a profit is part of Max. Click to switch Max on${proTitle(max.access)}`}
          >
            <Icon name="bolt" size={14} /> Arbitrage{max.active && arbCount > 0 ? ` (${arbCount})` : ""}
          </button>
        </div>
      )}
      {showFilters && activeOnly && !activity.ready && (
        <p className="note filters-note">Still checking order history ({Math.round(activity.progress * 100)}%), so some quiet assets may still show.</p>
      )}

      {error && (
        <div className="banner err" role="alert">
          <Icon name="alert" size={16} /> <span>{error}</span>
        </div>
      )}

      {!ready && !error && (
        <div className="scan" role="status">
          <span className="scan-bar"><i /></span>
          <span>Scanning the network for tradable assets. The list fills in as it goes.</span>
        </div>
      )}

      {tab === "swap" && !searchingAll && (
        <SwapPanel assets={assets} owned={owned} walletId={walletId} onConnect={onConnect} onChanged={onChanged} onBuy={(a) => onTrade(a, "buy")} />
      )}

      {tab === "history" && !searchingAll && <LedgerPanel walletId={walletId} assets={assets} onConnect={onConnect} />}

      {tab === "pools" && !searchingAll && (
        <PoolsPanel assets={assets} walletId={walletId} onConnect={onConnect} onChanged={onChanged} onSelectAsset={(id) => { const a = assets.find((x) => x.id === id); if (a) onTrade(a, "buy"); }} />
      )}

      {tab === "orders" && !searchingAll && (
        <OrdersPanel walletId={walletId} assets={assets} refreshKey={refreshKey} onConnect={onConnect} onCount={setOrderCount} onChanged={() => setOrderCount((c) => c)} />
      )}

      {tab === "mine" && !searchingAll && walletId && <MyAssetsSummary pf={portfolio} qu={qu} compact={watch} />}
      <div className={mineView ? "mtable has-swap mine" : "mtable"} hidden={!showTable}>
        {watch ? (
          <div className="mhead">
            <span />
            <button className={sort === "az" ? "hs on" : "hs"} data-dir={dir} aria-sort={sort === "az" ? (dir === "asc" ? "ascending" : "descending") : "none"} onClick={() => headSort("az")} title="Sort by name">Symbol</button>
            <button className={sort === "price" ? "hs r on" : "hs r"} data-dir={dir} aria-sort={sort === "price" ? (dir === "asc" ? "ascending" : "descending") : "none"} onClick={() => headSort("price")} title="Sort by price">Last</button>
            <button className={sort === "change" ? "hs r on" : "hs r"} data-dir={dir} aria-sort={sort === "change" ? (dir === "asc" ? "ascending" : "descending") : "none"} onClick={() => headSort("change")} title={`Sort by how far the price moved in ${volLong(volWin)}`}>{volWin}</button>
            <span className="hs-vol">
              <button className={sort === "volume" ? "hs r on" : "hs r"} data-dir={dir} aria-sort={sort === "volume" ? (dir === "asc" ? "ascending" : "descending") : "none"} onClick={() => headSort("volume")} title={`Sort by the QU traded in ${volLong(volWin)}`}>Vol</button>
              <VolSelect value={volWin} onChange={setVolWin} />
            </span>
            <button className={sort === "liquidity" ? "hs r on" : "hs r"} data-dir={dir} aria-sort={sort === "liquidity" ? (dir === "asc" ? "ascending" : "descending") : "none"} onClick={() => headSort("liquidity")} title="Sort by the size of the order book and pool">Depth</button>
          </div>
        ) : mineView ? (
          <div className="mhead" aria-hidden="true">
            <span />
            <span>Asset</span>
            <span className="r">Price</span>
            <span className="r">Held</span>
            <span className="r" title="What the units you bought cost on average, fees included">Avg cost</span>
            <span className="r" title="What the holding would fetch if sold now: the real order book and pool, with fees">Worth if sold</span>
            <span className="r" title="Worth if sold now minus cost, for the units whose purchase was found">Profit / loss</span>
            <span className="r">Bought</span>
            <span />
          </div>
        ) : (
          <div className="mhead">
            <span />
            <SortHead id="az" label="Asset" title="Sort by name" sort={sort} dir={dir} onSort={headSort} left />
            <SortHead id="price" label="Price" title="Sort by price" sort={sort} dir={dir} onSort={headSort} />
            <SortHead id="change" label={volWin} title={`Sort by how far the price moved in ${volLong(volWin)}`} sort={sort} dir={dir} onSort={headSort} />
            <span className="vol-head">
              <SortHead id="volume" label="Vol" title={`Sort by the QU traded in ${volLong(volWin)}`} sort={sort} dir={dir} onSort={headSort} />
              <VolSelect value={volWin} onChange={setVolWin} />
            </span>
            <SortHead id="liquidity" label="Depth" title="Sort by the size of the order book and pool" sort={sort} dir={dir} onSort={headSort} />
            <span>Markets</span>
            <SortHead id="spread" label="Spread" title="Sort by the gap between the best QX bid and ask: the tightest first" sort={sort} dir={dir} onSort={headSort} />
            <span />
          </div>
        )}
        <ul
          className="assets"
          // The watchlist is driven from the keyboard: up and down move between assets, Enter opens the one in focus.
          onKeyDown={(e) => {
            if (!watch || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
            const cells = [...e.currentTarget.querySelectorAll<HTMLElement>(".cell.asset")];
            const at = cells.indexOf(document.activeElement as HTMLElement);
            if (at < 0) return;
            e.preventDefault();
            cells[Math.max(0, Math.min(cells.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
          }}
        >
          {shown.map((a) => {
            const held = heldOf(a);
            const pf = mineView ? portfolio.rowsByKey.get(`${a.symbol}|${a.issuer}`) ?? null : null;
            const bars = depthBars(a.liquidityQu);
            const spread = spreadOf(a);
            const change = changeOf(a, volWin);
            const mk = market.get(a.id);
            const cmp = mk?.cmp ?? null;
            const arb = mk?.arb ?? null;
            const buyEdge = cmp && cmp.buy.pct >= 0.005 ? cmp.buy : null;
            const fav = favs.has(a.id);
            return (
              <li
                key={`${a.id}|${a.issuer}`}
                className={selectedId === a.id ? "mrow open selected" : "mrow open"}
                aria-current={selectedId === a.id ? "true" : undefined}
                // The whole row opens the market card, as well as the Buy and Sell buttons. A click on the star or one of the buttons is theirs, not the row's.
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
                  if (window.getSelection()?.toString()) return; // someone selecting text (to copy a symbol) is not asking to open it
                  onTrade(a, "buy");
                }}
              >
                <button
                  className={fav ? "star on" : "star"}
                  aria-label={fav ? `Remove ${shownName(a)} from favorites` : `Add ${shownName(a)} to favorites`}
                  aria-pressed={fav}
                  onClick={() => favs.toggle(a.id)}
                >
                  <Icon name="star" size={17} fill={fav} />
                </button>

                <div
                  className="cell asset"
                  // For the keyboard: the row's click cannot be reached by Tab, so the asset itself is a button that opens the card.
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${shownName(a)}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onTrade(a, "buy");
                    }
                  }}
                >
                  <Avatar symbol={a.symbol} category={a.category} issuer={a.issuer} size={40} />
                  <div className="asset-text">
                    <div className="l1">
                      <strong>{shownName(a)}</strong>
                      <HealthBadge health={health.data?.assets[a.id]} loading={health.loading} />
                      {a.id !== shownName(a) && <small className="tag" title={`Issuer ${a.issuer}`}>#{a.id.slice(shownName(a).length + 1)}</small>}
                      {arb && max.active && (
                        <span className="arb" title={`Arbitrage: ${arb.direction === "buy-qx-sell-qswap" ? "buy on QX, sell to the QSwap pool" : "buy from the QSwap pool, sell on QX"}. About ${arb.qty.toLocaleString("en-US")} units could leave roughly +${Math.round(arb.profitQu).toLocaleString("en-US")} QU (+${arb.profitPct.toFixed(1)}%) after every fee. Two separate trades, so prices can move.`}>
                          <Icon name="bolt" size={11} fill /> ARB
                        </span>
                      )}
                      {arb && !max.active && (
                        <button type="button" className="arb locked" onClick={(e) => (e.stopPropagation(), max.setOn(true))} title={`An arbitrage looks open on ${shownName(a)}. How much it could leave, and which way, is part of Max. Click to switch Max on${proTitle(max.access)}`}>
                          <Icon name="bolt" size={11} fill /> ARB
                        </button>
                      )}
                      {a.activity === "active" && <span className="pulse" title="Active: orders or pool changes in the last 2 epochs" />}
                      {a.activity === "inactive" && !activeOnly && <span className="quiet" title="No QX orders or pool changes in the last 2 epochs (14 days)">quiet</span>}
                    </div>
                    <div className="l3">
                      <span>{a.category === "contract" ? "Contract shares" : "Token"}</span>
                      {held > 0 && <span className="held">Holds {compactPrice(held, settings.compactPrices)}</span>}
                      {pf && pf.firstBuyMs !== null && <span className="boughtline">Bought {shortDate(pf.firstBuyMs)}</span>}
                    </div>
                  </div>
                </div>

                <div className="cell price">
                  <span className="val num" title={`${formatPrice(livePrice(a))} QU${lastTradeAge(a) ? ` · last QX trade ${lastTradeAge(a)}` : ""}${a.lastPriceQu != null && a.priceQu !== a.lastPriceQu ? ` at ${formatPrice(a.lastPriceQu)} QU: an old trade, kept inside today's QX bid and ask` : ""}`}>{compactPrice(livePrice(a), settings.compactPrices)}</span>
                  <small>QU</small>
                </div>

                <div className="meta">
                  {pf ? (
                    <>
                      <div className="cell held num"><small className="mlabel">held </small>{compactQu(pf.held)}</div>
                      <div className="cell cost num" title={pf.avgCost !== null ? `${n(pf.avgCost, 2)} QU each on average, fees included, for ${n(pf.costedQty)} units` : undefined}>
                        <small className="mlabel">cost </small>{pf.avgCost !== null ? compactQu(pf.avgCost) : portfolio.ledger.status === "loading" ? <span className="skeleton line" style={{ width: 40 }} /> : <span className="muted">–</span>}
                      </div>
                      <div className="cell worth num" title={pf.error ?? (pf.proceedsQu !== null ? `${n(pf.proceedsQu)} QU for ${n(pf.fillableQty)} ${shownName(a)} sold now${pf.venues.length ? ` on ${pf.venues.join(" and ")}` : ""}${pf.haircutPct !== null ? `; ${pf.haircutPct.toFixed(1)}% under the last price, from fees and the depth of the market` : ""}${pf.complete ? "" : `. Only able to sell ${n(pf.fillableQty)}/${n(pf.held)} shares currently: buyers want ${n(pf.fillableQty)} right now, so the other ${n(pf.held - pf.fillableQty)} are not counted`}` : undefined)}>
                        <small className="mlabel">worth </small>
                        {pf.proceedsQu === null ? (portfolio.liqError ? <span className="muted">–</span> : <span className="skeleton line" style={{ width: 48 }} />) : pf.error ? <span className="muted">–</span> : pf.fillableQty <= 0 ? <span className="muted" title="Nobody is bidding for it on QX and the pool cannot take it">No buyers</span> : compactQu(pf.proceedsQu)}
                        {pf.proceedsQu !== null && !pf.error && !pf.complete && pf.fillableQty > 0 && <small className="partial warn">only {n(pf.fillableQty)}/{n(pf.held)} sellable</small>}
                        {pf.proceedsQu !== null && qu && !pf.error && <small className="usd">≈ ${(pf.proceedsQu * qu.usdPerQu).toLocaleString("en-US", { maximumFractionDigits: pf.proceedsQu * qu.usdPerQu < 100 ? 2 : 0 })}</small>}
                      </div>
                      <div className={`cell pl num ${pf.plQu === null ? "" : pf.plQu > 0.5 ? "up" : pf.plQu < -0.5 ? "down" : ""}`} title={pf.plQu !== null ? `${signedQu(pf.plQu)} QU on ${n(pf.comparedQty)} units: what they would fetch now against what they cost${pf.realizedQu ? `. Already made from sales: ${signedQu(pf.realizedQu)} QU` : ""}` : pf.bought === "no" ? "No purchase found in the last year (bought earlier, or received from another wallet), so there is no cost to compare with" : undefined}>
                        <small className="mlabel">P/L </small>
                        {pf.plQu !== null ? <>{signedQu(pf.plQu)}{pf.plPct !== null && <small className="pct">{signedPct(pf.plPct)}</small>}</> : portfolio.ledger.status === "loading" ? <span className="skeleton line" style={{ width: 44 }} /> : <span className="muted">–</span>}
                      </div>
                      <div className="cell bought" title={pf.firstBuyMs !== null ? `First bought ${shortDate(pf.firstBuyMs)}${pf.lastBuyMs !== null && pf.lastBuyMs !== pf.firstBuyMs ? `, last ${shortDate(pf.lastBuyMs)}` : ""}; ${pf.buys} purchase${pf.buys === 1 ? "" : "s"} in the last year${pf.bought === "partly" ? ". Some of the units were not bought in that time" : ""}` : pf.bought === "no" ? "No purchase in the last year: bought earlier, or received from another wallet" : undefined}>
                        {pf.firstBuyMs !== null ? <>{shortDate(pf.firstBuyMs)}{pf.bought === "partly" && <small className="pct">partly</small>}</> : pf.bought === "unknown" ? (portfolio.ledger.status === "loading" ? <span className="skeleton line" style={{ width: 52 }} /> : <span className="muted">–</span>) : <span className="muted">Not found</span>}
                      </div>
                    </>
                  ) : (
                    <>

                  <div className="cell change">
                    {change != null ? (
                      <span className={`num ${change > 0.05 ? "up" : change < -0.05 ? "down" : ""}`} title={`The price moved ${change >= 0 ? "+" : ""}${change.toFixed(2)}% in ${volLong(volWin)} (last trade against the price at the start of it)`}>
                        <small className="mlabel">{volWin} </small>{change > 0.05 ? "+" : change < -0.05 ? "−" : ""}{Math.abs(change) < 10 ? Math.abs(change).toFixed(1) : n0(Math.abs(change))}%
                      </span>
                    ) : (
                      <span className="muted" title={`No trades in ${volLong(volWin)} to measure a change from`}>–</span>
                    )}
                  </div>
                  <div className="cell volume">
                    {volumeOf(a, volWin) ? (
                      <span className="num" title={`${formatPrice(volumeOf(a, volWin))} QU in ${volLong(volWin)}. 24 hours: ${formatPrice(a.volume24hQu ?? 0)} QU in ${a.trades24h ?? 0} trade${a.trades24h === 1 ? "" : "s"}; 72 hours: ${formatPrice(volumeOf(a, "72h"))} QU; 7 days: ${formatPrice(a.volume7dQu ?? 0)} QU`}>
                        <small className="mlabel"><span className="mwin">{volWin} </span>vol </small>{compactPrice(volumeOf(a, volWin), true)}
                      </span>
                    ) : (
                      <span className="muted" title={a.volume7dQu ? `Nothing traded in ${volLong(volWin)}; ${formatPrice(a.volume7dQu)} QU in the last 7 days` : "No trades in the last 7 days"}>–</span>
                    )}
                  </div>
                  <div className="cell depth">
                    <span className="meter" title={`Market depth ${bars} of 5 (QX order book plus pool size)`} aria-label={`Depth ${bars} of 5`}>
                      {[1, 2, 3, 4, 5].map((n) => <i key={n} className={n <= bars ? "on" : ""} style={{ height: 5 + n * 2.4 }} />)}
                    </span>
                  </div>
                  <div className="cell venues">
                    {a.venues.length > 1 ? (
                      <span className="route" title="Trades on both QX and QSwap. QMax compares them and can split your order for the best price.">
                        <b className="vqx">QX</b><Icon name="swap" size={12} /><b className="vqs">QSwap</b>
                      </span>
                    ) : (
                      <span className="route single"><b>{a.venues[0]}</b></span>
                    )}
                    {buyEdge && max.active && (
                      <span className="edge" title={`Buying is ${(buyEdge.pct * 100).toFixed(1)}% cheaper on ${buyEdge.cheaperOn}. QMax picks the cheaper one for you.`}>
                        {(buyEdge.pct * 100).toFixed(buyEdge.pct < 0.1 ? 1 : 0)}% cheaper on {buyEdge.cheaperOn}
                      </span>
                    )}
                    {buyEdge && !max.active && (
                      <button type="button" className="edge locked" onClick={(e) => (e.stopPropagation(), max.setOn(true))} title={`One market is cheaper for ${shownName(a)} right now. Max shows which one and by how much. Click to switch Max on${proTitle(max.access)}`}>
                        cheaper price
                      </button>
                    )}
                  </div>
                  <div className="cell spread">
                    {spread !== null ? (
                      <span className={`num ${spread < 3 ? "tight" : spread > 15 ? "wide" : ""}`} title={`QX bid ${formatPrice(a.bestBid ?? null)} / ask ${formatPrice(a.bestAsk ?? null)}`}>
                        <small className="mlabel">spread </small>{spread < 10 ? spread.toFixed(1) : Math.round(spread)}%
                      </span>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </div>
                    </>
                  )}
                </div>

                <div className="cell actions">
                  <button className="tbtn buy" aria-label={`Buy ${shownName(a)}`} title={`Buy ${shownName(a)}`} onClick={() => onTrade(a, "buy", undefined, pf?.avgCost ?? null)}>Buy</button>
                  <button className="tbtn sell" aria-label={`Sell ${shownName(a)}`} title={`Sell ${shownName(a)}`} onClick={() => onTrade(a, "sell", undefined, pf?.avgCost ?? null)}>Sell</button>
                  {max.active && tab === "mine" && !searchingAll && held > 0 && (
                    <button className="tbtn swap" aria-label={`Max swap: ${shownName(a)} for another asset`} title={`Max swap: ${shownName(a)} for another asset, sold and bought at the best routes in one review${proTitle(max.access)}`} onClick={() => setSwapFrom(a)}>
                      <Icon name="swap" size={13} /> Swap
                    </button>
                  )}
                </div>
              </li>
            );
          })}
          {!ready && shown.length === 0 && !error && [0, 1, 2, 3, 4, 5].map((k) => (
            <li key={k} className="mrow skel-row" aria-hidden="true">
              <span />
              <div className="cell asset"><span className="skeleton circle" /><span className="skeleton line" style={{ width: 90 }} /></div>
              <div className="cell price"><span className="skeleton line" style={{ width: 70 }} /></div>
              <div className="meta" />
              <div className="cell actions" />
            </li>
          ))}
        </ul>
      </div>

      {shown.length === 0 && tab !== "orders" && tab !== "pools" && tab !== "history" && tab !== "swap" && (bestOf2 || activeOnly || arbOnlyOn) && !(tab === "mine" && !searchingAll) && (
        <div className="empty">
          <span className="empty-icon"><Icon name="search" size={22} /></span>
          <p>
            {arbOnlyOn ? "No arbitrage opportunities right now: after fees, the two markets are in line. Check back later. " : ""}No assets match these filters{tab === "contract" && bestOf2 ? " (smart contract shares only trade on QX, so none are on both markets)" : ""}.
          </p>
          <button className="ghost" onClick={() => { setBestOf2(false); setActiveOnly(false); setArbOnly(false); }}>Clear filters</button>
        </div>
      )}

      {shown.length === 0 && ready && tab !== "orders" && tab !== "pools" && tab !== "history" && tab !== "swap" && ((tab === "mine" && !searchingAll) || (!bestOf2 && !activeOnly && !arbOnlyOn)) && (
        <div className="empty">
          {searchingAll ? (
            <>
              <span className="empty-icon"><Icon name="search" size={22} /></span>
              <p>Nothing matches “{query.trim()}”.</p>
              {/^[A-Za-z0-9]{1,7}$/.test(q) && (
                <button disabled={searching} onClick={searchNetwork}>{searching ? "Searching…" : `Search the network for ${q}`}</button>
              )}
              {searchNote && <p className="note">{searchNote}</p>}
            </>
          ) : tab === "mine" && !walletId ? (
            <>
              <span className="empty-icon"><Icon name="wallet" size={22} /></span>
              <p>Connect your wallet to see the assets you hold.</p>
              <button className="primary" onClick={onConnect}>Connect wallet</button>
            </>
          ) : tab === "mine" ? (
            <>
              <span className="empty-icon"><Icon name="inbox" size={22} /></span>
              <p>You don’t hold any tradable assets yet. Press <b>Buy</b> on any asset to start.</p>
            </>
          ) : tab === "favs" ? (
            <>
              <span className="empty-icon"><Icon name="star" size={22} /></span>
              <p>Nothing here yet. Tap the star next to an asset to pin it for quick access.</p>
            </>
          ) : (
            <p>Nothing to show here yet.</p>
          )}
        </div>
      )}
      {swapFrom && (
        <SwapModal
          from={swapFrom}
          assets={assets}
          holdings={null}
          onClose={() => {
            setSwapFrom(null);
            onChanged?.();
          }}
          onBuy={(asset) => {
            setSwapFrom(null);
            onChanged?.();
            onTrade(asset, "buy");
          }}
          onConnect={onConnect}
        />
      )}
      {consolidating && walletId && <ConsolidateModal walletId={walletId} onClose={() => setConsolidating(false)} />}
    </section>
  );
}
