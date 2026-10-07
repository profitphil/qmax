import { useEffect, useState } from "react";
import { Icon, Spinner } from "./ui.tsx";
import { compactQu, signedPct, signedQu } from "./format.ts";
import { usd } from "./qu-api.ts";
import type { QuSnapshot } from "./qu-api.ts";
import type { usePortfolio } from "./portfolio-api.ts";

type Portfolio = ReturnType<typeof usePortfolio>;

function Tile({ label, value, sub, tone, title }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "up" | "down"; title?: string }) {
  return (
    <div className="pf-tile" title={title}>
      <dt>{label}</dt>
      <dd className={tone ? `num ${tone}` : "num"}>{value}</dd>
      {sub !== undefined && <small>{sub}</small>}
    </div>
  );
}

/** How old a pricing is, in words: "just now", "4 min ago", "1 h ago". */
const ageWords = (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3_600_000)} h ago`);

const tone = (x: number | null): "up" | "down" | undefined => (x === null || Math.abs(x) < 0.5 ? undefined : x > 0 ? "up" : "down");

/**
 * The top of My assets: what everything would fetch if sold now, what it cost, and the profit or loss between them. Worth comes first (it needs only
 * the market); cost and profit follow once the trade history has been read. In dollars too, from the QU price.
 */
export function MyAssetsSummary({ pf, qu, compact }: { pf: Portfolio; qu: QuSnapshot | null; compact?: boolean }) {
  const t = pf.totals;
  // the age of the pricing is shown to the minute, so it is looked at again every half minute
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const dollars = (q: number) => (qu ? `≈ ${usd(q * qu.usdPerQu)}` : "");
  const costKnown = pf.ledger.status === "ready";
  const haircutPct = t.midQu > 0 && t.haircutQu > 0 ? (t.haircutQu / (t.worthQu + t.haircutQu)) * 100 : null;

  if (pf.rows.length === 0) return null;
  return (
    <section className={compact ? "pf pf-compact" : "pf"} aria-label="Portfolio">
      <dl className="pf-tiles">
        <Tile
          label="Worth if sold now"
          value={pf.loadingWorth ? <Spinner size={14} /> : pf.liqError ? "–" : <>{compactQu(t.worthQu)} <small>QU</small></>}
          sub={pf.liqError ? pf.liqError : pf.loadingWorth ? "Pricing a real sale of each…" : [dollars(t.worthQu), haircutPct !== null ? `${haircutPct < 10 ? haircutPct.toFixed(1) : Math.round(haircutPct)}% under last prices` : ""].filter(Boolean).join(" · ")}
          title="What selling every holding now would bring in after fees: each one run through the market's real order book and pool, not units times the last price"
        />
        <Tile
          label="Cost of what you bought"
          value={!costKnown ? (pf.ledger.status === "loading" ? <Spinner size={14} /> : "–") : t.plQu === null ? "–" : <>{compactQu(t.costQu)} <small>QU</small></>}
          sub={!costKnown ? (pf.ledger.status === "loading" ? "Reading your trade history…" : "History not available") : t.plQu === null ? "No purchases found" : [dollars(t.costQu), t.uncosted > 0 ? `${t.uncosted} with no purchase found` : ""].filter(Boolean).join(" · ")}
          title="Average cost, fees included, of the units whose purchase is in your last year of trades"
        />
        <Tile
          label="Profit or loss"
          tone={tone(t.plQu)}
          value={t.plQu === null ? "–" : <>{signedQu(t.plQu)} <small>QU</small></>}
          sub={t.plQu === null ? "Needs a purchase and a sale price" : [t.plPct !== null ? signedPct(t.plPct) : "", t.plQu !== null && qu ? `${t.plQu < 0 ? "−" : ""}${usd(Math.abs(t.plQu) * qu.usdPerQu)}` : "", "if sold now"].filter(Boolean).join(" · ")}
          title="What the bought units would fetch on a real sale now, minus what they cost"
        />
        {!compact && (
          <Tile
            label="Already made"
            tone={tone(t.realizedQu)}
            value={t.realizedQu === null ? "–" : <>{signedQu(t.realizedQu)} <small>QU</small></>}
            sub={t.realizedQu === null ? "" : "from sales in the last year"}
            title="Profit or loss on units you have already sold, by average cost"
          />
        )}
      </dl>
      {pf.pricedAt !== null && (
        <p className="pf-updated">
          Priced {ageWords(now - pf.pricedAt)}.{" "}
          <button type="button" className="link" onClick={pf.refreshWorth} disabled={pf.refreshingWorth}>
            {pf.refreshingWorth ? "Pricing…" : "Refresh"}
          </button>
        </p>
      )}
      {!compact && (
        <p className="pf-note">
          {pf.ledger.status === "error" && (
            <>
              <Icon name="alert" size={13} />{" "}
              {pf.ledger.willRetry ? (
                <>Your purchase history is not ready: the Qubic archive is busy. Asking again shortly. </>
              ) : (
                <>
                  Your purchase history could not be read ({pf.ledger.message}). <button type="button" className="link" onClick={pf.retry}>Try again</button>.{" "}
                </>
              )}
            </>
          )}
          Costs come from your trades in the last {pf.ledgerDays} days by average cost, fees included; units bought earlier or received from another wallet have a worth but no profit.
          {t.noBuyers > 0 && ` ${t.noBuyers} holding${t.noBuyers === 1 ? " has" : "s have"} no buyers right now, so ${t.noBuyers === 1 ? "it adds" : "they add"} nothing to the worth.`}
          {t.partial > 0 && ` ${t.partial} can only be sold in part: only what the market would take is counted.`} Each asset is priced on its own. Not tax advice.
        </p>
      )}
    </section>
  );
}
