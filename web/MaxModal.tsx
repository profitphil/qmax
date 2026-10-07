import { useEffect, useRef, useState } from "react";
import type { MaxAction, MaxPick, MaxPlan } from "../src/maxplan.ts";
import { shownName } from "./client.ts";
import type { AssetItem, QuoteResponse } from "./client.ts";
import { fetchQuote } from "./client.ts";
import { ExecuteModal } from "./ExecuteModal.tsx";
import { LimitOrderModal } from "./LimitOrderModal.tsx";
import { fetchMaxPlan, fetchVenueQuote } from "./max-api.ts";
import { Icon, Modal, Spinner } from "./ui.tsx";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const pct = (p: number) => (Math.abs(p) < 10 ? p.toFixed(1) : n(p));

/** What each kind of pick is called on its tag. */
const KIND: Record<MaxPick["kind"], string> = { route: "Best route", touch: "Resting order", size: "Best size", split: "Now + resting", arbitrage: "Arbitrage" };

/** The searches Max makes, shown while it works. */
const SEARCHES = ["Best route for the order", "Resting at the touch on QX", "The size the market takes cleanly", "QX against QSwap", "What it returns against what it cost"];

const chance = (c: number) => (c >= 0.7 ? "likely" : c >= 0.4 ? "possible" : "unlikely");

interface Props {
  asset: AssetItem;
  side: "buy" | "sell";
  /** The amount typed in the order panel, if any. */
  qty?: number;
  balanceQu: number | null;
  heldQty: number | null;
  avgCostQu?: number | null;
  slippageBps: number;
  refTag?: string;
  onClose: () => void;
  /** A trade of this plan finished: read the wallet again. */
  onDone?: () => void;
}

interface Run {
  pick: MaxPick;
  index: number;
  /** Units the last action matched (null: not known). */
  filled: number | null;
}

/**
 * Max: QMax's search for the best position for this trade. It shows what it found (the best way to execute, the best size, an arbitrage, the best exit),
 * recommends one, and builds it as ordinary orders that go through the same review-and-sign dialogs as any trade, one after the other. Nothing is signed
 * here, and every order is quoted again, and checked again, right before the wallet is asked.
 */
export function MaxModal({ asset, side, qty, balanceQu, heldQty, avgCostQu, slippageBps, refTag, onClose, onDone }: Props) {
  const [plan, setPlan] = useState<(MaxPlan & { checkedAt?: string }) | null>(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    fetchMaxPlan({ asset: asset.id, side, qty, balanceQu, heldQty, avgCostQu, slippageBps }, ctl.signal)
      .then(setPlan)
      .catch((e) => e.name !== "AbortError" && setError(e.message));
    // the list of searches ticks along while the one request is made: it is a progress display, not separate calls
    const t = setInterval(() => setStep((s) => Math.min(SEARCHES.length - 1, s + 1)), 650);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, []);

  const all: MaxPick[] = plan ? [...plan.picks, ...(plan.arbitrage ? [plan.arbitrage] : [])] : [];
  const shownPick = all.find((p) => p.id === (chosen ?? plan?.recommendedId)) ?? all[0] ?? null;
  const verbBuy = side === "buy";

  const first = (p: MaxPick) => setRun({ pick: p, index: 0, filled: null });
  const finishedAction = (r: { finished: boolean; filledQty: number | null } | null) => {
    if (!run) return;
    if (r?.finished) onDone?.();
    const more = run.index + 1 < run.pick.actions.length;
    if (r?.finished && more && r.filledQty !== 0) return setRun({ ...run, index: run.index + 1, filled: r.filledQty });
    setRun(null);
    if (r?.finished) onClose(); // the plan is done (or the next step is pointless): back to the page
  };

  return (
    <>
      <Modal
        size="lg"
        className="max-modal"
        title="QMax Max"
        subtitle={`The best position for ${verbBuy ? "buying" : "selling"} ${shownName(asset)}: searched, compared and built for you.`}
        onClose={run ? undefined : onClose}
        footer={<button className="ghost wide" onClick={onClose} disabled={!!run}>Close</button>}
      >
        {!plan && !error && (
          <div className="max-search" role="status" aria-label="Searching for the best position">
            <p className="max-search-head"><Spinner size={15} /> Searching…</p>
            <ol>
              {SEARCHES.map((s, i) => (
                <li key={s} className={i < step ? "done" : i === step ? "now" : ""}>
                  {i < step ? <Icon name="check" size={13} /> : i === step ? <Spinner size={12} /> : <i />}
                  {s}
                </li>
              ))}
            </ol>
          </div>
        )}
        {error && <p className="err inline"><Icon name="alert" size={15} /> {error}</p>}

        {plan && shownPick && (
          <>
            <p className="max-lead">
              {plan.cut ? <>Planned for <b>{n(plan.qty)} {shownName(asset)}</b>, the most that {verbBuy ? "your QU buys here" : "can be sold"} at once. </> : <>Planned for <b>{n(plan.qty)} {shownName(asset)}</b>. </>}
              A normal order would {verbBuy ? "pay" : "receive"} <b>{n(plan.baseline.totalQu)} QU</b>{plan.baseline.avgPriceQu !== null && <> ({n(plan.baseline.avgPriceQu, 2)} each)</>} at the best route: {plan.baseline.route.map((r) => `${r.venue} ${Math.round(r.shareOfOrder * 100)}%`).join(" + ")}.
            </p>

            <PickCard pick={shownPick} recommended={shownPick.id === plan.recommendedId} side={side} symbol={shownName(asset)} onBuild={() => first(shownPick)} />

            {all.length > 1 && (
              <div className="max-others" role="group" aria-label="Other positions">
                <h3>{all.length > 2 ? "Other ways" : "The other way"}</h3>
                {all.filter((p) => p.id !== shownPick.id).map((p) => (
                  <button key={p.id} type="button" className={p.kind === "arbitrage" ? "max-row arb" : "max-row"} onClick={() => setChosen(p.id)}>
                    <span className="max-tag">{KIND[p.kind]}</span>
                    <span className="max-row-title">{p.title}</span>
                    <span className={p.gainQu > 0 ? "max-row-gain up" : "max-row-gain"}>
                      {p.kind === "arbitrage" ? `+${n(p.gainQu)} QU` : p.gainQu > 0 ? `${verbBuy ? "saves" : "earns"} ${pct(p.gainPct)}%` : "the normal order"}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <details className="max-searched">
              <summary>What QMax searched ({plan.quotesUsed} quotes)</summary>
              <ul>
                {plan.searched.map((s, i) => (
                  <li key={i}><b>{s.label}.</b> {s.found}</li>
                ))}
              </ul>
            </details>
            <p className="note">Prices move: every order is quoted again, and checked again, right before your wallet is asked to sign. Max only builds orders; you review and approve each one.</p>
          </>
        )}
      </Modal>

      {run && <RunStep key={`${run.pick.id}-${run.index}`} asset={asset} pick={run.pick} index={run.index} filled={run.filled} slippageBps={slippageBps} refTag={refTag} onDone={finishedAction} />}
    </>
  );
}

/** One position: its numbers, why, what could go wrong, and the orders it is made of. */
function PickCard({ pick, recommended, side, symbol, onBuild }: { pick: MaxPick; recommended: boolean; side: "buy" | "sell"; symbol: string; onBuild: () => void }) {
  const buy = side === "buy";
  const arb = pick.kind === "arbitrage";
  const first = pick.actions[0];
  return (
    <section className={`max-card${recommended ? " rec" : ""}`} aria-label={pick.title}>
      <div className="max-card-head">
        {recommended && <span className="max-badge"><Icon name="bolt" size={12} fill /> Recommended</span>}
        <span className="max-tag">{KIND[pick.kind]}</span>
      </div>
      <h3>{pick.title}</h3>
      <dl className="max-nums">
        <div><dt>{arb ? "You lay out" : buy ? "You pay" : "You receive"}</dt><dd className="num">≈ {n(pick.totalQu)} <small>QU</small></dd></div>
        <div><dt>Average</dt><dd className="num">{pick.avgPriceQu !== null ? n(pick.avgPriceQu, 2) : "–"} <small>QU</small></dd></div>
        <div>
          <dt>{arb ? "Profit after fees" : pick.id === "route" ? "Against a normal order" : buy ? "Saves" : "Earns"}</dt>
          <dd className={`num${pick.gainQu > 0 ? " up" : ""}`}>{pick.id === "route" && !arb ? "the same" : `${pick.gainQu >= 0 ? "+" : "−"}${n(Math.abs(pick.gainQu))} QU`} {!(pick.id === "route" && !arb) && <small>({pct(pick.gainPct)}%)</small>}</dd>
        </div>
      </dl>
      {pick.profitQu !== null && !arb && (
        <p className={pick.profitQu >= 0 ? "max-pl up" : "max-pl down"}>
          Against what these {n(pick.qty)} {symbol} cost you: {pick.profitQu >= 0 ? "a profit" : "a loss"} of <b>{n(Math.abs(pick.profitQu))} QU</b>.
        </p>
      )}
      <p className="max-why">{pick.why}</p>
      <ol className="max-steps">
        {pick.actions.map((a, i) => (
          <li key={i}>
            <b>{i + 1}</b>
            <span>{a.label}</span>
            <small className="num">{a.certain ? "fills now" : "if it fills"} · ≈ {n(a.expectedQu)} QU</small>
          </li>
        ))}
      </ol>
      {!pick.certain && !arb && <p className="max-chance"><Icon name="clock" size={13} /> Chance the resting part fills: <b>{chance(pick.fillChance)}</b>, going by how often QX traded at its price in the last day.</p>}
      {pick.risks.length > 0 && (
        <ul className="max-risks">
          {pick.risks.map((r) => <li key={r}><Icon name="alert" size={13} /> {r}</li>)}
        </ul>
      )}
      <button className={`go ${first.side}`} onClick={onBuild}>
        {pick.actions.length > 1 ? `Review step 1 of ${pick.actions.length}` : "Review and sign"}
      </button>
    </section>
  );
}

/** Runs one action of a position through the ordinary dialog for it, then reports how it ended. */
function RunStep({ asset, pick, index, filled, slippageBps, refTag, onDone }: { asset: AssetItem; pick: MaxPick; index: number; filled: number | null; slippageBps: number; refTag?: string; onDone: (r: { finished: boolean; filledQty: number | null } | null) => void }) {
  const action = pick.actions[index];
  // After a first trade, what the second one sells is what the first one bought (an arbitrage's two legs).
  const qty = pick.kind === "arbitrage" && index > 0 && filled !== null && filled > 0 ? Math.min(action.qty, filled) : action.qty;
  const [ready, setReady] = useState<"ask" | "quote" | "go">(index === 0 ? "quote" : "ask");
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState("");
  const result = useRef<{ finished: boolean; filledQty: number | null } | null>(null);
  const total = pick.actions.length;

  useEffect(() => {
    if (ready !== "quote" || action.kind !== "market") return;
    let alive = true;
    (action.venue ? fetchVenueQuote({ asset: asset.id, side: action.side, qty, venue: action.venue, slippageBps }) : fetchQuote({ asset: asset.id, side: action.side, qty, slippageBps }))
      .then((q) => alive && (setQuote(q), setReady("go")))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [ready]);

  const finish = () => onDone(result.current);
  const told = (r: { finished: boolean; filledQty: number | null }) => (result.current = r);

  // the next step of a position waits for the person: the price may have moved, and the first trade may not have gone through in full
  if (ready === "ask") {
    return (
      <Modal size="sm" className="max-between" title={`Step ${index + 1} of ${total}`} subtitle="The first step is done." onClose={() => onDone(null)} footer={
        <>
          <button className={`go ${action.side}`} onClick={() => setReady(action.kind === "market" ? "quote" : "go")}>Review step {index + 1}</button>
          <button className="ghost wide" onClick={() => onDone(null)}>Stop here</button>
        </>
      }>
        <p>{action.kind === "market" && qty !== action.qty ? <>The first trade matched {n(qty)} of the planned {n(action.qty)}, so this is for {n(qty)}: </> : null}<b>{action.label}</b></p>
        {pick.kind === "arbitrage" && <p className="note">The price may have moved since the plan was made. It is quoted again, and checked again, before you sign; you can stop here and keep the {shownName(asset)}.</p>}
      </Modal>
    );
  }
  if (error)
    return (
      <Modal size="sm" title="Could not get a price" onClose={() => onDone(null)} footer={<button className="ghost wide" onClick={() => onDone(null)}>Close</button>}>
        <p className="err inline"><Icon name="alert" size={15} /> {error}</p>
      </Modal>
    );
  if (action.kind === "limit") {
    return <LimitOrderModal asset={asset} side={action.side} qty={qty} price={action.price!} onFinished={told} onClose={finish} />;
  }
  if (ready !== "go" || !quote) {
    return (
      <Modal size="sm" title="Getting a fresh price" onClose={() => onDone(null)}>
        <div className="quote loading" role="status" aria-label="Getting a fresh quote">
          <span className="skeleton line" style={{ width: "45%" }} />
          <span className="skeleton line big" style={{ width: "60%" }} />
        </div>
      </Modal>
    );
  }
  return <ExecuteModal shown={quote} slippageBps={slippageBps} expected={{ assetName: asset.symbol, issuer: asset.issuer }} refTag={refTag} venue={action.venue} onFinished={told} onClose={finish} />;
}

export type { MaxAction };
