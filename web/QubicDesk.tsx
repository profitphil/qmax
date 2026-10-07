import { useEffect, useState } from "react";
import { ChartView } from "./ChartView.tsx";
import { SwapPanel } from "./SwapPanel.tsx";
import { AssetSwitcher, QU_ENTRY } from "./AssetSwitcher.tsx";
import { useAssetCatalog } from "./catalog.ts";
import { fetchOwned } from "./exec/chain.ts";
import type { AssetItem } from "./client.ts";
import { TradesDock } from "./TradesDock.tsx";
import { QU_SOURCE } from "./QubicChart.tsx";
import { QU_PER, usd, usdPerQu } from "./qu-api.ts";
import type { QuSnapshot } from "./qu-api.ts";
import { QubicMark } from "./ui.tsx";
import { Resizer } from "./Resizer.tsx";

const big = (x: number | null | undefined) => (x === null || x === undefined ? "–" : usd(x));

interface Props {
  qu: QuSnapshot | null;
  onOpenAsset: (id: string) => void;
  /** The connected wallet, for the swap panel's balances (null when none). */
  walletId: string | null;
  /** Bumped when something that moves the wallet's holdings finished, so they are read again. */
  refreshKey: number;
  onConnect: () => void;
  onChanged: () => void;
  /** Opens an asset's screen (the switcher in the header, and the swap's "buy this instead"). */
  onBuy: (asset: AssetItem) => void;
}

/**
 * The workspace's home: Qubic's own price chart, large, with every asset's latest trades beside it and, under them, the swap panel (QU for a token, or a token
 * for QU; with Max on, one asset for another). The order panel proper is for the asset picked on the left. It is what the page shows until an asset is chosen,
 * so the chart is the first thing anyone sees.
 */
export function QubicDesk({ qu, onOpenAsset, walletId, refreshKey, onConnect, onChanged, onBuy }: Props) {
  const assets = useAssetCatalog();
  // What the wallet holds that QX and QSwap can trade, so the swap knows what can be given.
  const [owned, setOwned] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!walletId) {
      setOwned({});
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
  const change = qu?.change24hPct ?? null;
  const dir = change === null ? "" : change > 0.05 ? "up" : change < -0.05 ? "down" : "";
  const cells: [string, string, string, string?][] = [
    ["Price", qu ? usdPerQu(qu.usdPerQu) : "–", "One QU in US dollars"],
    ["24h", change === null ? "–" : `${change > 0.05 ? "▲" : change < -0.05 ? "▼" : ""} ${Math.abs(change).toFixed(2)}%`, "How the price moved in the last 24 hours", dir],
    ["1M QU", qu ? usd(qu.usdPerQu * QU_PER) : "–", "What one million QU is worth in US dollars"],
    ["Market value", big(qu?.marketCapUsd), "All QU in existence at this price"],
    ["24h volume", big(qu?.volume24hUsd), "Dollars traded in the last 24 hours"],
  ];
  return (
    <section className="trade docked bar qu-desk" aria-label="Qubic price and market">
      <div className="trade-head">
        <QubicMark size={32} />
        <div className="trade-title">
          <AssetSwitcher current={QU_ENTRY} onPick={onBuy} />
          <span className="trade-sub">QU<span className="sep">·</span>One QU in US dollars</span>
        </div>
        <dl className="qstrip" aria-label="Qubic quote">
          {cells.map(([label, value, title, cls]) => (
            <div key={label} title={title}>
              <dt>{label}</dt>
              <dd className={`num ${cls ?? ""}`.trim()}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="trade-body">
        <section className="pane market-pane" aria-label="QU price chart">
          <div className="market">
            <ChartView assetId="QU" symbol="QU" source={QU_SOURCE} />
          </div>
        </section>
        <aside className="rail" aria-label="Latest trades and order panel">
          <Resizer panel="rail" />
          <TradesDock onOpenAsset={onOpenAsset} />
          <section className="pane ticket qu-ticket" aria-label="Swap">
            <b className="qu-ticket-title">Swap</b>
            <SwapPanel compact assets={assets} owned={owned} walletId={walletId} onConnect={onConnect} onChanged={onChanged} onBuy={onBuy} />
          </section>
        </aside>
      </div>
    </section>
  );
}
