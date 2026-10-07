import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { parseDeepLink } from "../src/deeplink.ts";
import { AssetList } from "./AssetList.tsx";
import type { ListPage } from "./AssetList.tsx";
import { TradePanel } from "./TradePanel.tsx";
import { ConnectModal } from "./wallet/ConnectModal.tsx";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { useWalletConnect } from "./wallet/WalletConnectContext.tsx";
import { lookupAsset, lookupAssetById, reportRef } from "./client.ts";
import { rememberRef } from "./usage.ts";
import type { AssetItem } from "./client.ts";
import { fetchBalance } from "./exec/chain.ts";
import { SettingsModal } from "./settings.tsx";
import { MarketBar, Nav, StatusBar } from "./chrome.tsx";
import type { MarketStats, NavPage } from "./chrome.tsx";
import { Icon } from "./ui.tsx";
import { TickerStrip } from "./TickerStrip.tsx";
import { useMedia, useWorkspaceScale, WORKSPACE_QUERY } from "./media.ts";
import { useQuPrice } from "./qu-api.ts";
import { QubicDesk } from "./QubicDesk.tsx";
import { Resizer } from "./Resizer.tsx";
import { WelcomeModal, welcomeOff } from "./WelcomeModal.tsx";
import { SupportModal } from "./SupportModal.tsx";
import { CHART_PANE, ORDER_PANE, PagerTabs, usePager } from "./Pager.tsx";
import { applySavedWidths } from "./layout.ts";

type Page = "trade" | ListPage;
const PAGES: NavPage[] = [
  { id: "trade", label: "Trade" },
  { id: "mine", label: "Portfolio" },
  { id: "orders", label: "Orders" },
  { id: "history", label: "History" },
  { id: "pools", label: "Pools" },
  { id: "swap", label: "Swap" },
];

/** What is open for trading. */
interface Selection {
  asset: AssetItem;
  side: "buy" | "sell";
  qty?: number;
  /** What each held unit cost, for the profit on an exit (from My assets). */
  avgCost?: number | null;
}

export function App() {
  const { connected, wallet, disconnect: disconnectWallet } = useQubicConnect();
  const { disconnect: disconnectWc } = useWalletConnect();
  const disconnect = async () => {
    if (wallet?.connectType === "walletconnect") await disconnectWc();
    disconnectWallet();
  };

  const workspace = useMedia(WORKSPACE_QUERY);
  const scale = useWorkspaceScale(workspace);
  // Narrower than the workspace the three columns are three screens in a row, swiped sideways (see Pager.tsx).
  const pager = usePager(!workspace);
  // The panel widths a person dragged the dividers to (kept in this browser) go on the workspace as CSS variables.
  const appRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (workspace && appRef.current) applySavedWidths(appRef.current);
  }, [workspace]);
  const [showConnect, setShowConnect] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  // What QMax does, shown when the site loads until the person ticks "Don't show this again".
  const [showWelcome, setShowWelcome] = useState(() => !welcomeOff());
  const [showSupport, setShowSupport] = useState(false);
  const qu = useQuPrice();
  const [trade, setTrade] = useState<Selection | null>(null);
  const [page, setPage] = useState<Page>("trade");
  const [refTag, setRefTag] = useState<string | undefined>();
  const [linkError, setLinkError] = useState("");
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [balanceQu, setBalanceQu] = useState<number | null>(null);

  // The wallet's QU balance for the header; read again after every trade.
  useEffect(() => {
    setBalanceQu(null);
    if (!wallet) return;
    let alive = true;
    fetchBalance(wallet.publicKey).then((b) => alive && setBalanceQu(b)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [wallet?.publicKey, refreshKey]);

  // A link from another site (?asset=CFB&side=buy&qty=1000&ref=partner) opens the trade screen already filled in.
  useEffect(() => {
    const link = parseDeepLink(window.location.search);
    if (!link) return;
    window.history.replaceState(null, "", window.location.pathname); // so a refresh does not reopen it
    if (link.ref) {
      setRefTag(link.ref);
      rememberRef(link.ref);
      reportRef(link.ref, "open");
    }
    lookupAsset(link.asset).then((asset) => {
      if (asset) {
        setTrade({ asset, side: link.side, qty: link.qty });
        if (link.qty !== undefined) setTimeout(() => pager.go(ORDER_PANE, false), 0); // a small screen: the link brings an amount, so open at the order panel
      } else setLinkError(`${link.asset} is not tradable on QX or QSwap right now.`);
    }).catch(() => setLinkError(`Could not open ${link.asset}. Try searching for it.`));
  }, []);

  // Opening an asset (from the watchlist, the tape, a pool, a swap) always goes to the trading screen: on a small screen its chart, or the order panel when an amount came with it.
  const open = (asset: AssetItem, side: "buy" | "sell", qty?: number, avgCost?: number | null) => {
    setTrade({ asset, side, qty, avgCost });
    setPage("trade");
    if (!workspace) pager.go(qty !== undefined ? ORDER_PANE : CHART_PANE);
  };
  // The home of the trading screen is Qubic's own chart.
  const goQubic = () => {
    setTrade(null);
    setPage("trade");
    if (!workspace) pager.go(CHART_PANE);
  };
  const openById = (id: string) => void lookupAssetById(id).then((asset) => asset && open(asset, "buy")).catch(() => {});

  const listProps = {
    onTrade: open,
    onConnect: () => setShowConnect(true),
    onStats: setStats,
    onChanged: () => setRefreshKey((k) => k + 1),
    walletId: connected && wallet ? wallet.publicKey : null,
    refreshKey,
  };

  const banner = linkError && (
    <div className="banner err" role="alert">
      <Icon name="alert" size={16} /> <span>{linkError}</span>
      <button className="iconbtn sm" onClick={() => setLinkError("")} aria-label="Dismiss"><Icon name="close" size={14} /></button>
    </div>
  );

  return (
    <div ref={appRef} className={workspace ? "app terminal" : "app pager"} style={workspace && scale < 1 ? ({ "--ui-zoom": scale, "--ui-unzoom": 1 / scale } as CSSProperties) : undefined}>
      <Nav
        pages={workspace ? PAGES : undefined}
        page={page}
        onPage={(id) => setPage(id as Page)}
        qu={qu}
        onQubic={goQubic}
        connected={connected}
        address={wallet?.publicKey}
        alias={wallet?.alias}
        balanceQu={balanceQu}
        onConnect={() => setShowConnect(true)}
        onDisconnect={disconnect}
        onSettings={() => setShowSettings(true)}
        onSupport={() => setShowSupport(true)}
      />
      <MarketBar stats={stats}>
        <TickerStrip onSelectAsset={openById} />
      </MarketBar>
      {banner}

      {workspace ? (
        // The workspace: watchlist on the left, chart and order ticket for the selected asset filling the rest. The other pages replace both.
        <main className={page === "trade" ? "workspace" : "workspace single"}>
          <div className="watch" hidden={page !== "trade"}>
            <AssetList
              {...listProps}
              mode="watch"
              selectedId={trade?.asset.id ?? null}
            />
            <Resizer panel="watch" />
          </div>
          {page === "trade" ? (
            <div className="desk">
              {trade ? (
                <TradePanel
                  key={trade.asset.id}
                  docked
                  asset={trade.asset}
                  initialSide={trade.side}
                  initialQty={trade.qty}
                  avgCostQu={trade.avgCost}
                  refTag={refTag}
                  onConnect={() => setShowConnect(true)}
                  onRefresh={() => setRefreshKey((k) => k + 1)}
                  onSwitch={open}
                onQubic={goQubic}
                />
              ) : (
                <QubicDesk qu={qu} onOpenAsset={openById} walletId={listProps.walletId} refreshKey={refreshKey} onConnect={listProps.onConnect} onChanged={listProps.onChanged} onBuy={(a) => open(a, "buy")} />
              )}
            </div>
          ) : (
            <div className="page">
              <AssetList {...listProps} mode="page" page={page} />
            </div>
          )}
        </main>
      ) : (
        // Small screens: the same three columns as screens in one row, swiped sideways: assets, then the chart (open on it), then the latest trades and the order panel; then the portfolio.
        <main className="workspace pager-row" ref={pager.ref} onScroll={pager.onScroll}>
          <div className="watch">
            <AssetList {...listProps} show="market" selectedId={trade?.asset.id ?? null} />
          </div>
          <div className="desk">
            {trade ? (
              <TradePanel
                key={trade.asset.id}
                docked
                asset={trade.asset}
                initialSide={trade.side}
                initialQty={trade.qty}
                avgCostQu={trade.avgCost}
                refTag={refTag}
                onConnect={() => setShowConnect(true)}
                onRefresh={() => setRefreshKey((k) => k + 1)}
                onSwitch={open}
                onQubic={goQubic}
              />
            ) : (
              <QubicDesk qu={qu} onOpenAsset={openById} walletId={listProps.walletId} refreshKey={refreshKey} onConnect={listProps.onConnect} onChanged={listProps.onChanged} onBuy={(a) => open(a, "buy")} />
            )}
          </div>
          <div className="watch">
            {/* the portfolio's own screen (the first list already tells the title bar the counts) */}
            <AssetList {...listProps} onStats={undefined} show="portfolio" />
          </div>
        </main>
      )}
      {workspace ? <StatusBar onSupport={() => setShowSupport(true)} /> : <PagerTabs pane={pager.pane} onGo={(i) => pager.go(i)} />}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} onSupport={() => { setShowSettings(false); setShowSupport(true); }} />}
      {showWelcome && <WelcomeModal onClose={() => setShowWelcome(false)} onSupport={() => setShowSupport(true)} />}
      {showSupport && <SupportModal onClose={() => setShowSupport(false)} />}
      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
    </div>
  );
}
