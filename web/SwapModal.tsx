import { useEffect, useMemo, useRef, useState } from "react";
import { PAYWALL, passRequired } from "../src/config.ts";
import { QSWAP_OPERATION_FEE_QU } from "../src/exec.ts";
import type { Holdings, TxStep } from "../src/exec.ts";
import { fitBuyToBalance, freeHoldings, planSwapSteps, restingOrderClash, worstLegProceedsQu } from "../src/swap.ts";
import type { FitResult, QuoteLeg, SwapPlan, SwapSteps } from "../src/swap.ts";
import { summarizeOutcome } from "../src/verify.ts";
import type { OpenOrder, Outcome, Snapshot } from "../src/verify.ts";
import { shownName } from "./client.ts";
import type { AssetItem } from "./client.ts";
import { fetchOpenOrders, fetchSnapshot } from "./exec/chain.ts";
import { usePass, verifiedPass } from "./exec/pass.ts";
import { runSteps } from "./exec/run.ts";
import { useCloseSignal } from "./exec/abort.ts";
import { UsageNote } from "./UsageNote.tsx";
import type { StepState } from "./exec/run.ts";
import { PassModal } from "./PassModal.tsx";
import { useSettings } from "./settings.tsx";
import { fetchSwapQuote, swapLegQuote } from "./swap-api.ts";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Avatar, Icon, Modal, Spinner, StepMark } from "./ui.tsx";
import { TradeCard, dialogClass } from "./TradeCard.tsx";
import { dialogTone, tradeCard } from "../src/tradecard.ts";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const signedQu = (x: number) => `${x > 0 ? "+" : x < 0 ? "\u2212" : ""}${n(Math.abs(x))} QU`;
const EXPLORER = "https://explorer.qubic.org/network/tx/";
/** Contracts whose shares QMax can trade: QX (1) and QSwap (13). */
const TRADABLE = [1, 13];
const tradable = (h: Holdings) => TRADABLE.reduce((s, c) => s + (h[c] ?? 0), 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Props {
  /** The token being sold. */
  from: AssetItem;
  /** Tokens to choose the one to buy from (the one being sold is left out). */
  assets: AssetItem[];
  /** The wallet's shares of `from` per managing contract, if already known (they are read again here). */
  holdings?: Holdings | null;
  onClose: () => void;
  /** Opens the normal buy screen: offered when the second trade cannot go ahead and the wallet is left holding QU. */
  onBuy?: (asset: AssetItem) => void;
  /** Opens the wallet picker. */
  onConnect?: () => void;
  /** Start with this token (an asset id) already chosen as the one to buy, and this many units to sell: the Swap tab hands over what the person entered. */
  initialTo?: string;
  initialQty?: number;
}

type Phase = "form" | "checking" | "review" | "leg1" | "settling" | "ready2" | "leg2" | "verifying" | "done" | "stopped";

interface Review {
  plan: SwapPlan;
  steps: SwapSteps;
  before: Snapshot;
  /** The amounts got worse between the form and this fresh plan. */
  moved: boolean;
  shown: { expectedOutQty: number; minOutQty: number };
}

interface Leg1Result {
  /** Every step of the sale was confirmed. If not, step 2 is never started. */
  ok: boolean;
  base: Snapshot;
  after: Snapshot;
  soldQty: number;
  sold: Outcome;
}

/** Most QU one buy leg attaches: limit x qty on QX, maxQuIn + the flat fee on QSwap. */
const legMaxQu = (l: QuoteLeg) =>
  l.execution?.type === "qx-bid" ? l.execution.limitPrice * l.execution.qty : l.execution?.type === "qswap-buy" ? l.execution.maxQuIn + QSWAP_OPERATION_FEE_QU : 0;

/** Re-reads the wallet until `moved` says the trade shows in it (or it gives up), then once more so the balance is not a tick behind. */
async function settledSnapshot(read: () => Promise<Snapshot>, moved: (s: Snapshot) => boolean, tries = 8): Promise<Snapshot> {
  let snap = await read();
  for (let i = 0; i < tries && !moved(snap); i++) {
    await sleep(5000);
    snap = await read().catch(() => snap);
  }
  if (moved(snap)) {
    await sleep(3000);
    const again = await read().catch(() => snap);
    if (moved(again)) snap = again;
  }
  return snap;
}

export function SwapModal({ from, assets, holdings: initialHoldings, onClose, onBuy, onConnect, initialTo, initialQty }: Props) {
  const { connected, wallet, getSignedTx } = useQubicConnect();
  const closeSignal = useCloseSignal();
  const { settings } = useSettings();
  const { hasPass, refresh: refreshPass } = usePass(wallet?.publicKey);
  const [phase, setPhase] = useState<Phase>("form");
  const [toId, setToId] = useState<string | null>(initialTo ?? null);
  const [search, setSearch] = useState("");
  const [qtyText, setQtyText] = useState(initialQty && initialQty > 0 ? Math.floor(initialQty).toLocaleString("en-US") : "");
  const [slippagePct, setSlippagePct] = useState(String(settings.slippagePct));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<Holdings | null>(initialHoldings ?? null);
  const [openA, setOpenA] = useState<OpenOrder[] | null>(null);
  const [plan, setPlan] = useState<SwapPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [planLoading, setPlanLoading] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [leg1, setLeg1] = useState<Leg1Result | null>(null);
  const [fit, setFit] = useState<FitResult | null>(null);
  const [bought, setBought] = useState<{ outcome: Outcome; after: Snapshot } | null>(null);
  const [stopReason, setStopReason] = useState("");
  const [error, setError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const busy = phase === "checking" || phase === "leg1" || phase === "settling" || phase === "leg2" || phase === "verifying";
  // False once the dialog is gone: nothing may then open a signing request the user cannot see.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const to = assets.find((a) => a.id === toId) ?? null;
  const qty = Number(qtyText.replace(/,/g, ""));
  const validQty = Number.isInteger(qty) && qty > 0;
  const slippageBps = Math.round(Number(slippagePct) * 100);
  const validSlippage = Number.isFinite(slippageBps) && slippageBps >= 0 && slippageBps <= 1000;
  const free = holdings && openA ? freeHoldings(holdings, openA) : holdings;
  const available = free ? tradable(free) : null;

  // What the wallet holds of the token being sold, its QU, and its resting QX orders (their shares cannot be sold again).
  useEffect(() => {
    setBalance(null);
    setOpenA(null);
    if (!wallet) return;
    let alive = true;
    if (!from.issuer) {
      setHoldings({});
      setOpenA([]);
      return;
    }
    fetchSnapshot(wallet.publicKey, from.issuer, from.symbol)
      .then((s) => {
        if (!alive) return;
        setBalance(s.balanceQu);
        setHoldings(s.holdings);
      })
      .catch(() => {});
    fetchOpenOrders(wallet.publicKey, from.issuer, from.symbol)
      .then((o) => alive && setOpenA(o))
      .catch(() => alive && setOpenA([]));
    return () => {
      alive = false;
    };
  }, [wallet?.publicKey, from.id]);

  // Plan the swap as the amount, target or slippage change (only while the form is showing).
  useEffect(() => {
    if (phase !== "form") return;
    if (!to || !validQty || !validSlippage) {
      setPlan(null);
      setPlanError("");
      return;
    }
    const ctl = new AbortController();
    setPlanLoading(true);
    const t = setTimeout(() => {
      fetchSwapQuote({ from: from.id, to: to.id, qty, slippageBps }, ctl.signal)
        .then((p) => {
          setPlan(p);
          setPlanError("");
        })
        .catch((e) => {
          if (e.name !== "AbortError") {
            setPlan(null);
            setPlanError(e.message);
          }
        })
        .finally(() => setPlanLoading(false));
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [from.id, to?.id, qty, slippageBps, phase]);

  // The steps with the wallet's real holdings: the QU up front then includes any share move.
  const localSteps = useMemo(() => {
    if (!plan?.executable || !plan.sell || !plan.buy || !free) return null;
    try {
      return { steps: planSwapSteps(plan.sell, plan.buy, free), error: "" };
    } catch (e) {
      return { steps: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [plan, holdings, openA]);
  const upfront = localSteps?.steps?.sell.maxOutlayQu ?? plan?.upfrontQu ?? null;

  const checks = readinessChecks({ connected, hasPass, plan, planLoading: planLoading && !plan, validQty, qty, available, balance, upfront, localSteps, from, openA });
  const canReview = connected && validQty && validSlippage && !!plan?.executable && checks.every((c) => c.state === "ok" || c.state === "warn");

  // ---- the run ------------------------------------------------------------------------------------------------

  const onState = (id: string, s: StepState) => setStates((cur) => ({ ...cur, [id]: s }));
  const sign = (tx: Parameters<typeof getSignedTx>[0]) => getSignedTx(tx);

  /** Re-plans right before signing (prices move), and checks the wallet, the pass and the QU up front again. */
  const startReview = async () => {
    if (!wallet || !to || !plan) return;
    setPhase("checking");
    setError("");
    try {
      const fresh = await fetchSwapQuote({ from: from.id, to: to.id, qty, slippageBps });
      if (!fresh.executable || !fresh.sell || !fresh.buy) throw new Error(fresh.warnings[0] ?? "This swap can no longer be done at current prices and liquidity.");
      const a = fresh.sell.assetInfo!;
      const b = fresh.buy.assetInfo!;
      const [snap, open, openB] = await Promise.all([
        fetchSnapshot(wallet.publicKey, a.issuer, a.assetName),
        fetchOpenOrders(wallet.publicKey, a.issuer, a.assetName),
        fetchOpenOrders(wallet.publicKey, b.issuer, b.assetName),
      ]);
      // Trading needs an active pass (checked against QPayhub's receipt, not just what this browser remembers).
      if (!(await verifiedPass(wallet.publicKey))) throw new Error("Your QMax pass has ended. Close this and unlock trading again.");
      // Both legs are checked now: a clash only found after the sale would leave the wallet holding QU instead.
      const clash = restingOrderClash(fresh.sell, open) ?? restingOrderClash(fresh.buy, openB) ?? (fresh.buyAtWorst ? restingOrderClash(fresh.buyAtWorst, openB) : null);
      if (clash) throw new Error(clash);
      const steps = planSwapSteps(fresh.sell, fresh.buy, freeHoldings(snap.holdings, open));
      if (steps.sell.maxOutlayQu > snap.balanceQu)
        throw new Error(`Not enough QU: the first trade needs up to ${n(steps.sell.maxOutlayQu)} QU in the wallet before the sale pays out (flat market fees are paid in QU, even when selling), and the wallet has ${n(snap.balanceQu)} QU.`);
      setBalance(snap.balanceQu);
      setHoldings(snap.holdings);
      setOpenA(open);
      const moved = fresh.expectedOutQty < plan.expectedOutQty * 0.995 || fresh.minOutQty < plan.minOutQty;
      setReview({ plan: fresh, steps, before: snap, moved, shown: { expectedOutQty: plan.expectedOutQty, minOutQty: plan.minOutQty } });
      setStates({});
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("form");
    }
  };

  /** Leg 1: sell. Then wait until the sale shows in the wallet and size leg 2 from the QU that really came in. */
  const signAndSwap = async () => {
    if (!wallet || !review) return;
    setPhase("leg1");
    setError("");
    const a = review.plan.sell!.assetInfo!;
    // A fresh baseline at the moment of signing, so earlier activity is not counted as the sale's.
    const base = await fetchSnapshot(wallet.publicKey, a.issuer, a.assetName).catch(() => review.before);
    const ok = await runSteps(wallet.publicKey, review.steps.sell.steps, sign, onState, undefined, undefined, closeSignal());
    await afterLeg1(base, ok, true);
  };

  /** `auto`: leg 2 may start straight away if it is exactly as reviewed. A later re-check always asks first. */
  const afterLeg1 = async (base: Snapshot, leg1Ok: boolean, auto: boolean) => {
    if (!wallet || !review) return;
    setPhase("settling");
    const sell = review.plan.sell!;
    const a = sell.assetInfo!;
    try {
      const after = await settledSnapshot(
        () => fetchSnapshot(wallet.publicKey, a.issuer, a.assetName),
        (s) => tradable(s.holdings) < tradable(base.holdings) && s.balanceQu !== base.balanceQu,
        leg1Ok ? 8 : 2,
      );
      const soldQty = Math.max(0, tradable(base.holdings) - tradable(after.holdings));
      const open = sell.route.some((r) => r.venue === "QX") ? await fetchOpenOrders(wallet.publicKey, a.issuer, a.assetName).catch(() => []) : [];
      const sold = summarizeOutcome({ side: "sell", requestedQty: review.plan.qty, quotedQu: sell.totalQu, before: base, after, openOrders: open });
      setLeg1({ ok: leg1Ok, base, after, soldQty, sold });
      setBalance(after.balanceQu);
      if (!leg1Ok) return stop("The first trade stopped before all its steps were sent, so the second trade was not started.");
      const b = review.plan.buy!.assetInfo!;
      const openB = await fetchOpenOrders(wallet.publicKey, b.issuer, b.assetName).catch(() => []);
      const f = await fitBuyToBalance({
        // buyAtWorst and buyMaxOutlayQu come with the plan: the reviewed minimum and the reviewed "at most".
        plan: { ...review.plan, upfrontQu: review.steps.sell.maxOutlayQu },
        balanceBeforeQu: base.balanceQu,
        balanceNowQu: after.balanceQu,
        soldQty,
        quoteFn: swapLegQuote,
        openOrders: openB,
      });
      setFit(f);
      if (!f.ok) return stop(f.reason);
      if (!alive.current) return;
      // Exactly as reviewed (same size, no more QU attached than shown): go straight on, the wallet still asks before
      // the signature. Smaller, or dearer because the price moved: ask here first.
      if (f.needsConfirmation || !auto) setPhase("ready2");
      else await runLeg2(f);
    } catch (e) {
      stop(`Could not read the wallet after the first trade: ${e instanceof Error ? e.message : String(e)}. The second trade was not sent.`);
    }
  };

  const stop = (reason: string) => {
    setStopReason(reason);
    setPhase("stopped");
  };

  /** Leg 2: buy exactly the steps fitBuyToBalance returned, then read the wallet back to report what really happened. */
  const runLeg2 = async (f: FitResult) => {
    if (!wallet || !f.ok || !alive.current) return;
    setPhase("leg2");
    const b = f.quote.assetInfo!;
    // Read again right before signing: the user may have taken a while to confirm, and QU may have left meanwhile.
    const baseB = await fetchSnapshot(wallet.publicKey, b.issuer, b.assetName).catch(() => null);
    if (!baseB) return stop("The wallet could not be read right before the second trade, so it was not sent. You keep the QU.");
    if (baseB.balanceQu < f.maxOutlayQu)
      return stop(`Your wallet now holds ${n(baseB.balanceQu)} QU, less than the ${n(f.maxOutlayQu)} QU the second trade attaches, so it was not sent.`);
    if (!alive.current) return;
    const ok = await runSteps(wallet.publicKey, f.steps, sign, onState, undefined, undefined, closeSignal());
    setPhase("verifying");
    try {
      const after = await settledSnapshot(() => fetchSnapshot(wallet.publicKey, b.issuer, b.assetName), (s) => tradable(s.holdings) > tradable(baseB.holdings), ok ? 8 : 2);
      const open = f.quote.route.some((r) => r.venue === "QX") ? await fetchOpenOrders(wallet.publicKey, b.issuer, b.assetName).catch(() => []) : [];
      setBought({ outcome: summarizeOutcome({ side: "buy", requestedQty: f.qty, quotedQu: f.quote.totalQu, before: baseB, after, openOrders: open }), after });
      setBalance(after.balanceQu);
    } catch (e) {
      setError(`Could not read the wallet after the second trade: ${e instanceof Error ? e.message : String(e)}. Check the explorer.`);
    }
    if (ok) setPhase("done");
    else stop("The second trade stopped before its steps were all sent.");
  };

  // ---- view ---------------------------------------------------------------------------------------------------

  const title = to ? `Max swap ${shownName(from)} for ${shownName(to)}` : `Max swap ${shownName(from)}`;
  const shownPlan = review?.plan ?? plan;
  const running = phase === "leg1" || phase === "leg2";
  // How far along the swap is (both trades and the wallet checks between them), for the card and the outline that bounces or shakes the dialog.
  const userStopped = phase === "stopped" && /^You stopped/.test(stopReason);
  const partlyBought = phase === "stopped" && !!bought && bought.outcome.filledQty > 0;
  const swapCard =
    review && (phase === "leg1" || phase === "settling" || phase === "ready2" || phase === "leg2" || phase === "verifying" || phase === "done" || phase === "stopped")
      ? tradeCard({
          steps: [...review.steps.sell.steps, ...(fit?.ok ? fit.steps : review.steps.buy.steps)].map((s) => ({ id: s.id, description: s.description })),
          states,
          running,
          // A swap the person stopped between the trades, or whose second trade went through in part, is something to look at, not a failure.
          finished: phase === "done" || userStopped || partlyBought ? true : phase === "stopped" ? false : null,
          checking: phase === "settling" || phase === "verifying",
          verdict: bought ? (bought.outcome.status === "filled" || bought.outcome.status === "oversold" ? "good" : bought.outcome.status === "partial" ? "partial" : "none") : userStopped ? "partial" : null,
          note: phase === "done" && !bought ? error || undefined : undefined,
          reason: phase === "stopped" ? stopReason : undefined,
          labels: { success: "Swap complete" },
        })
      : null;
  const footer =
    phase === "form" ? (
      <>
        {!connected ? (
          <button className="go buy" onClick={onConnect} disabled={!onConnect}><Icon name="wallet" size={17} /> Connect wallet to swap</button>
        ) : hasPass === false ? (
          <button className="go buy" onClick={() => setUnlocking(true)}><Icon name="bolt" size={17} /> Unlock trading · {n(PAYWALL.priceQu)} QU for {PAYWALL.hours} hours</button>
        ) : (
          <button className="go buy" disabled={!canReview} onClick={startReview}>{!to ? "Choose a token to get" : !validQty ? "Enter an amount" : "Review and sign"}</button>
        )}
        <button className="ghost wide" onClick={onClose}>Cancel</button>
      </>
    ) : phase === "checking" ? (
      <button className="go buy" disabled><Spinner size={16} /> Getting fresh prices and checking your wallet…</button>
    ) : phase === "review" ? (
      <>
        <button className="go buy" onClick={signAndSwap}>{review?.moved ? "Accept the new amounts and sign" : "Sign and swap"}</button>
        <button className="ghost wide" onClick={() => setPhase("form")}>Back</button>
      </>
    ) : phase === "ready2" && fit?.ok ? (
      <>
        <button className="go buy" onClick={() => runLeg2(fit)}>Sign step 2: buy {n(fit.qty)} {(to ? shownName(to) : "")}</button>
        <button className="ghost wide" onClick={() => stop("You stopped before the second trade.")}>Stop here and keep the QU</button>
      </>
    ) : busy ? (
      <button className="go buy" disabled><Spinner size={16} /> {running ? "Waiting for your wallet and the network…" : "Checking your wallet…"}</button>
    ) : (
      <button className="ghost wide" onClick={onClose}>Close</button>
    );

  return (
    <Modal size="lg" className={`swap ${dialogClass(dialogTone(swapCard, false))}`.trim()} title={title} subtitle="Max swap: two trades, one review. Sell for QU, then buy with that QU, each at the best route." onClose={busy ? undefined : onClose} footer={footer}>
      {error && <p className="err inline"><Icon name="alert" size={15} /> {error}</p>}

      {phase === "form" && (
        <>
          <div className="swap-pair">
            <label className="amount">
              <span className="amount-top">
                <span>You give</span>
                {connected && available !== null && <small>Available {n(available)} {shownName(from)}</small>}
              </span>
              <span className="inputwrap">
                <input
                  autoFocus
                  value={qtyText}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
                    setQtyText(digits === "" ? "" : Number(digits).toLocaleString("en-US"));
                  }}
                  inputMode="numeric"
                  placeholder="0"
                  aria-label={`How many ${shownName(from)} to swap`}
                />
                <span className="unit">{shownName(from)}</span>
                {connected && (
                  <button type="button" className="allbtn" disabled={!available} onClick={() => setQtyText(n(available ?? 0))} title="Everything you have of this">All</button>
                )}
              </span>
            </label>
            <span className="swap-arrow" aria-hidden="true"><Icon name="swap" size={16} /></span>
            <TargetPicker from={from} assets={assets} to={to} search={search} onSearch={setSearch} onPick={(a) => setToId(a?.id ?? null)} />
          </div>

          {planError && <p className="err inline"><Icon name="alert" size={15} /> {planError}</p>}
          {planLoading && !plan && to && validQty && (
            <div className="quote loading" role="status" aria-label="Planning the swap">
              <span className="skeleton line" style={{ width: "45%" }} />
              <span className="skeleton line big" style={{ width: "70%" }} />
              <span className="skeleton line" style={{ width: "90%" }} />
              <span className="skeleton line" style={{ width: "75%" }} />
            </div>
          )}
          {plan && to && validQty && <Summary plan={plan} fromSym={shownName(from)} toSym={shownName(to)} upfront={upfront} refreshing={planLoading} />}

          {to && validQty && (
            <ul className="ready" aria-label="Swap readiness">
              {checks.map((c) => (
                <li key={c.id} className={c.state}>
                  <span className="mark" aria-hidden="true">
                    {c.state === "ok" ? <Icon name="check" size={13} /> : c.state === "warn" ? <Icon name="alert" size={13} /> : c.state === "fail" ? <Icon name="close" size={13} /> : <i />}
                  </span>
                  <span>{c.label}{c.detail && <small>{c.detail}</small>}</span>
                </li>
              ))}
            </ul>
          )}

          <button className="link advanced-toggle" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
            <Icon name="sliders" size={14} /> {showAdvanced ? "Hide" : "Advanced"} settings
          </button>
          {showAdvanced && (
            <label className="field">
              Maximum price movement (slippage) per trade, %
              <input value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} inputMode="decimal" />
              <small>Both trades are limited by it. Lower keeps more of the value but fails more often; up to 10%.</small>
            </label>
          )}
        </>
      )}

      {phase !== "form" && shownPlan && to && (
        <>
          {review && phase === "review" && (
            <>
              <Summary plan={review.plan} fromSym={shownName(from)} toSym={shownName(to)} upfront={review.steps.sell.maxOutlayQu} />
              {review.moved && (
                <p className="warn inline">
                  <Icon name="alert" size={15} /> Prices moved since you looked: you were shown about {n(review.shown.expectedOutQty)} {shownName(to)} (at least {n(review.shown.minOutQty)}).
                </p>
              )}
            </>
          )}
          {swapCard && <TradeCard view={swapCard} />}
          {phase === "checking" && (
            <div className="quote loading" role="status" aria-label="Getting fresh prices">
              <span className="skeleton line" style={{ width: "45%" }} />
              <span className="skeleton line big" style={{ width: "60%" }} />
              <span className="skeleton line" style={{ width: "90%" }} />
            </div>
          )}
          {phase === "stopped" && (
            <div className="result swap-stopped" role="status">
              <p className="warn inline"><Icon name="alert" size={16} /> <strong>{bought ? "The second trade did not finish." : "The swap stopped after the first trade."}</strong></p>
              <p>{stopReason}</p>
              {leg1 && (
                <p>
                  {leg1.soldQty > 0 ? <>Your {n(leg1.soldQty)} {shownName(from)} were sold. </> : <>No {shownName(from)} was sold. </>}
                  Your wallet now holds {n((bought?.after ?? leg1.after).balanceQu)} QU{leg1.soldQty > 0 && !bought?.outcome.filledQty ? ", including what the sale brought in" : ""}.
                </p>
              )}
              <span className="swap-actions">
                {leg1 && leg1.ok && leg1.soldQty === 0 && review && !fit?.ok && (
                  <button className="ghost" onClick={() => afterLeg1(leg1.base, leg1.ok, false)}>Check my wallet again</button>
                )}
                {leg1 && leg1.soldQty > 0 && (!bought || bought.outcome.filledQty === 0) && onBuy && (
                  <button className="ghost" onClick={() => onBuy(to)}>Buy {shownName(to)} with my QU</button>
                )}
              </span>
            </div>
          )}

          {(phase === "done" || (phase === "stopped" && !!bought?.outcome.filledQty)) && leg1 && bought && (
            <SwapResult fromSym={shownName(from)} toSym={shownName(to)} leg1={leg1} bought={bought.outcome} quChange={bought.after.balanceQu - leg1.base.balanceQu} finished={phase === "done"} />
          )}

          {review && (phase === "leg1" || phase === "settling" || phase === "ready2" || phase === "leg2" || phase === "verifying") && (
            <p className="swap-deal">
              Swapping {n(review.plan.qty)} {shownName(from)} for about <b>{n(review.plan.expectedOutQty)} {shownName(to)}</b> (at least {n(review.plan.minOutQty)}). Keep this open until both steps are done.
            </p>
          )}
          {review && phase !== "checking" && (
            <div className="swap-run">
              <section className="swap-phase" aria-label={`Step 1: sell ${shownName(from)} for QU`}>
                <h3><span className="swap-num">1</span> Sell {n(review.plan.qty)} {shownName(from)} for QU</h3>
                <Timeline steps={review.steps.sell.steps} states={states} />
                {leg1 && (
                  <p className="note first">
                    {leg1.soldQty > 0
                      ? <>Sold {n(leg1.soldQty)} {shownName(from)}; your QU changed by {leg1.after.balanceQu - leg1.base.balanceQu >= 0 ? "+" : ""}{n(leg1.after.balanceQu - leg1.base.balanceQu)} QU (after the flat fees).</>
                      : <>No {shownName(from)} has left the wallet yet.</>}
                    {leg1.sold.openOrders.some((o) => o.side === "ask") && <> Still for sale on QX: {leg1.sold.openOrders.filter((o) => o.side === "ask").map((o) => `${n(o.qty)} at ${n(o.price)} QU`).join(", ")} (cancel it under Orders if you want the shares back).</>}
                  </p>
                )}
              </section>
              <section className="swap-phase" aria-label={`Step 2: buy ${shownName(to)} with the QU`}>
                <h3><span className="swap-num">2</span> Buy {shownName(to)} with that QU</h3>
                {fit?.ok ? (
                  <>
                    <Timeline steps={fit.steps} states={states} />
                    <p className="note first">
                      The sale brought in {n(fit.receivedQu)} QU. This buys {n(fit.qty)} {shownName(to)} and attaches at most {n(fit.maxOutlayQu)} QU; what the trade does not use is refunded{fit.quote.route.some((l) => l.venue === "QX") ? " (on QX, any part not filled waits as an open order)" : ""}.
                      {fit.resized && <> It is smaller than reviewed ({n(review.plan.expectedOutQty)}) because the QU from the sale no longer covers that many at current prices, but it is not below the {n(review.plan.minOutQty)} minimum.</>}
                      {fit.reviewedLimits && <> {shownName(to)}'s price moved but stayed inside your limits, so it is signed with the limits you reviewed for the minimum.</>}
                      {!fit.resized && fit.maxOutlayQu > review.plan.buyMaxOutlayQu && <> It attaches more than the {n(review.plan.buyMaxOutlayQu)} QU you reviewed because {shownName(to)}'s price moved; it is still paid from what the sale brought in.</>}
                    </p>
                  </>
                ) : phase === "stopped" ? (
                  <p className="note first">Not sent: nothing was signed for this step.</p>
                ) : (
                  <p className="note first">
                    Planned: buy about {n(review.plan.expectedOutQty)} {shownName(to)}. It is sized again from your real balance once step 1 has settled, so it can never need more QU than the sale brought in.
                  </p>
                )}
              </section>
            </div>
          )}

          {phase === "settling" && <p className="status-line swap-status"><Spinner size={14} /> Waiting for the sale to show in your wallet, then sizing step 2 from the QU it brought in…</p>}

        </>
      )}

      {phase === "form" && (
        <p className="note swap-trust">
          <Icon name="shield" size={13} /> Nothing is sent until you sign in your wallet, one transaction at a time. The second trade is sized from what the first really paid, and never sent for less than the minimum shown.
        </p>
      )}
      {phase === "form" && <UsageNote />}
      {unlocking && <PassModal onClose={() => setUnlocking(false)} onUnlocked={refreshPass} />}
    </Modal>
  );
}

/** The token to get: a searchable list, or the chosen one with a way to change it. */
function TargetPicker({ from, assets, to, search, onSearch, onPick }: { from: AssetItem; assets: AssetItem[]; to: AssetItem | null; search: string; onSearch: (s: string) => void; onPick: (a: AssetItem | null) => void }) {
  const options = useMemo(() => {
    const q = search.trim().toUpperCase();
    return assets
      .filter((a) => a.id !== from.id && a.venues.length > 0 && (!q || a.symbol.toUpperCase().includes(q) || a.id.toUpperCase().includes(q)))
      .sort((a, b) => (q ? Number(b.symbol.toUpperCase().startsWith(q)) - Number(a.symbol.toUpperCase().startsWith(q)) : 0) || b.liquidityQu - a.liquidityQu)
      .slice(0, 8);
  }, [assets, from.id, search]);

  if (to)
    return (
      <div className="swap-target">
        <span className="amount-top"><span>You get</span></span>
        <div className="swap-chosen">
          <Avatar symbol={to.symbol} category={to.category} issuer={to.issuer} size={30} />
          <span className="swap-chosen-name"><b>{shownName(to)}</b><small>{to.priceQu !== null ? `about ${n(to.priceQu, to.priceQu < 10 ? 4 : 2)} QU each` : "no price yet"}</small></span>
          <button className="link" onClick={() => onPick(null)}>Change</button>
        </div>
      </div>
    );
  return (
    <div className="swap-target">
      <span className="amount-top"><span>You get</span></span>
      <label className="swap-search">
        <Icon name="search" size={15} />
        <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search a token to get" aria-label="Search a token to get" />
      </label>
      {options.length === 0 ? (
        <p className="note first">{search ? `No token matches “${search}”.` : "No other tokens to swap into."}</p>
      ) : (
        <ul className="swap-options" aria-label="Tokens to get">
          {options.map((a) => (
            <li key={a.id}>
              <button className="swap-option" onClick={() => onPick(a)}>
                <Avatar symbol={a.symbol} category={a.category} issuer={a.issuer} size={26} />
                <span className="swap-option-name">{a.id}</span>
                <span className="swap-option-price num">{a.priceQu !== null ? `${n(a.priceQu, a.priceQu < 10 ? 4 : 2)} QU` : "—"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "You give N A, you get about X B (at least Y B)", then both legs, the QU needed up front and the warnings. */
function Summary({ plan, fromSym, toSym, upfront, refreshing }: { plan: SwapPlan; fromSym: string; toSym: string; upfront: number | null; refreshing?: boolean }) {
  const sell = plan.sell;
  const buy = plan.buy;
  return (
    <div className={refreshing ? "quote swap-summary refreshing" : "quote swap-summary"} aria-live="polite">
      {plan.executable && buy ? (
        <div className="swap-headline">
          <span className="quote-label">You give {n(plan.qty)} {fromSym}, you get about</span>
          <strong className="quote-total num">{n(plan.expectedOutQty)} <small>{toSym}</small></strong>
          <span className="swap-min">
            <Icon name="shield" size={13} /> at least {n(plan.minOutQty)} {toSym} while prices stay within your {plan.slippageBps / 100}% limits
          </span>
          <small className="swap-if">
            QMax never sends step 2 for less. If a price moves past your limits first, the sale does not go through on QSwap (you keep the {fromSym}) or waits on QX as an open order, or step 2 is not sent and you keep the QU.
          </small>
        </div>
      ) : (
        <p className="err inline"><Icon name="alert" size={15} /> {plan.warnings[0] ?? "This swap cannot be done right now."}</p>
      )}
      {sell && plan.executable && (
        <ol className="swap-legs">
          <li>
            <span className="swap-num">1</span>
            <div>
              <b>Sell {n(plan.qty)} {fromSym}</b>
              <Venues legs={sell.route} />
              <small>
                About {n(plan.expectedProceedsQu)} QU comes in; at least {n(plan.worstProceedsQu)} QU within your limits
                {sell.route.length > 1 && <> ({sell.route.map((l) => `${l.venue} ${n(worstLegProceedsQu(l))}`).join(" + ")})</>}.
              </small>
            </div>
          </li>
          {buy && (
            <li>
              <span className="swap-num">2</span>
              <div>
                <b>Buy {n(plan.expectedOutQty)} {toSym} with it</b>
                <Venues legs={buy.route} />
                <small>
                  Pays about {n(buy.totalQu)} QU, at most {n(buy.route.reduce((s, l) => s + legMaxQu(l), 0))} QU (unused QU is refunded{buy.route.some((l) => l.venue === "QX") ? "; on QX, any part not filled waits as an open order" : ""}).
                </small>
              </div>
            </li>
          )}
        </ol>
      )}
      {plan.executable && (
        <dl className="swap-facts">
          <div>
            <dt>QU needed up front</dt>
            <dd className="num">{upfront === null ? "…" : `${n(upfront)} QU`}</dd>
          </div>
          <div>
            <dt>Your QU, both trades (estimate)</dt>
            <dd className="num">{signedQu(plan.expectedLeftoverQu - (upfront ?? plan.upfrontQu))}</dd>
          </div>
        </dl>
      )}
      {plan.executable && (
        <p className="note first">
          {upfront === 0
            ? "A QX sale attaches no QU, so nothing is needed up front."
            : `The up-front QU pays the sale's flat market fees (QSwap takes 100,000 QU per swap${upfront !== null && upfront > plan.upfrontQu ? ", plus a share move" : ""}) before the sale pays out.`}{" "}
          Step 2 is sized so even its worst price fits what step 1 is
          sure to pay, so some QU (mostly the slippage room) usually comes back to you; the QU estimate counts that and the flat fees. Estimates from current prices; they ignore orders others place before yours land.
        </p>
      )}
      {plan.executable && plan.sell && plan.sell.route.some((l) => l.venue === "QX") && (
        <p className="note first">QX fills as a limit order: if the book moves first, any part not filled stays on QX as an open order. Step 2 then goes ahead only if what was really sold still buys the minimum; otherwise you keep the QU.</p>
      )}
      {plan.warnings.slice(plan.executable ? 0 : 1).map((w) => (
        <p key={w} className="warn inline"><Icon name="alert" size={15} /> {w}</p>
      ))}
    </div>
  );
}

function Venues({ legs }: { legs: QuoteLeg[] }) {
  const total = legs.reduce((s, l) => s + l.qty, 0);
  return (
    <span className="swap-venues">
      {legs.map((l) => (
        <span key={l.venue}><i className={l.venue === "QX" ? "dot qx" : "dot qswap"} /> {l.venue}{legs.length > 1 && <span className="muted"> {n((l.qty / total) * 100)}%</span>}</span>
      ))}
    </span>
  );
}

function Timeline({ steps, states }: { steps: TxStep[]; states: Record<string, StepState> }) {
  return (
    <ol className="timeline">
      {steps.map((s) => {
        const st = states[s.id] ?? { status: "pending" };
        return (
          <li key={s.id} className={st.status}>
            <StepMark status={st.status} />
            <div>
              <div className="step-title">{s.description}</div>
              <small className="step-meta">
                sends {n(s.amountQu)} QU · {st.status}
                {"txId" in st && (
                  <> · <a href={EXPLORER + st.txId} target="_blank" rel="noreferrer">{st.txId.slice(0, 10)}… <Icon name="external" size={11} /></a></>
                )}
                {st.status === "failed" && <span className="err"> {st.error}</span>}
              </small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** What actually changed in the wallet, read back after both trades. */
function SwapResult({ fromSym, toSym, leg1, bought, quChange, finished }: { fromSym: string; toSym: string; leg1: Leg1Result; bought: Outcome; quChange: number; finished: boolean }) {
  const full = bought.status === "filled" && leg1.sold.status === "filled";
  const open = [...leg1.sold.openOrders.filter((o) => o.side === "ask").map((o) => `sell ${n(o.qty)} ${fromSym} at ${n(o.price)} QU`), ...bought.openOrders.filter((o) => o.side === "bid").map((o) => `buy ${n(o.qty)} ${toSym} at ${n(o.price)} QU`)];
  return (
    <div className={full ? "result good" : "result"}>
      <p className={full ? "ok inline" : "warn inline"}>
        <Icon name={full ? "check" : "alert"} size={16} /> <strong>{full ? "Swap complete." : "The swap went through only in part."}</strong>
      </p>
      <dl className="swap-facts">
        <div><dt>You gave</dt><dd className="num">{n(leg1.soldQty)} {fromSym}</dd></div>
        <div><dt>You got</dt><dd className="num">{n(bought.filledQty)} {toSym}</dd></div>
        <div><dt>QU, both trades together</dt><dd className="num">{quChange >= 0 ? "+" : ""}{n(quChange)} QU</dd></div>
      </dl>
      <p className="note first">Read from your wallet after the trades. The QU line is what step 2 did not need, less the flat fees{bought.lockedInOrdersQu > 0 ? `, less ${n(bought.lockedInOrdersQu)} QU still locked in an open order` : ""}.</p>
      {bought.status === "nothing" && (
        <p className="warn">{finished ? `No ${toSym} has arrived yet. The balance may still be updating; check the explorer before trying again. If the price moved past your limit, a QSwap buy is refused and its QU refunded, and a QX buy waits as an open order.` : `No ${toSym} was bought: step 2 did not go through.`}</p>
      )}
      {open.length > 0 && <p className="warn">Still open on QX: {open.join("; ")}. It stays there until it fills or you cancel it under Orders.</p>}
    </div>
  );
}

// ---- checklist ------------------------------------------------------------------------------------------------

type CheckState = "ok" | "warn" | "fail" | "pending";

function readinessChecks(i: {
  connected: boolean;
  hasPass: boolean | null;
  plan: SwapPlan | null;
  planLoading: boolean;
  validQty: boolean;
  qty: number;
  available: number | null;
  balance: number | null;
  upfront: number | null;
  localSteps: { steps: SwapSteps | null; error: string } | null;
  from: AssetItem;
  openA: OpenOrder[] | null;
}): { id: string; label: string; state: CheckState; detail?: string }[] {
  const out: { id: string; label: string; state: CheckState; detail?: string }[] = [];
  out.push(i.connected ? { id: "wallet", label: "Wallet connected", state: "ok" } : { id: "wallet", label: "Connect your wallet", state: "fail" });
  if (i.connected && passRequired())
    out.push(
      i.hasPass === null
        ? { id: "pass", label: "Checking your QMax pass", state: "pending" }
        : i.hasPass
          ? { id: "pass", label: "QMax pass active", state: "ok", detail: "No per-trade fee." }
          : { id: "pass", label: "Unlock trading", state: "fail", detail: `${n(PAYWALL.priceQu)} QU for ${PAYWALL.hours} hours, then no per-trade fee.` },
    );
  if (i.planLoading || !i.plan) out.push({ id: "plan", label: "Finding the best route for both trades", state: "pending" });
  else if (!i.plan.executable) out.push({ id: "plan", label: "Both trades can be filled", state: "fail", detail: i.plan.warnings[0] });
  else out.push({ id: "plan", label: "Both trades can be filled", state: "ok" });

  if (i.connected && i.validQty) {
    if (i.available === null) out.push({ id: "shares", label: `Checking your ${shownName(i.from)}`, state: "pending" });
    else if (i.available < i.qty)
      out.push({ id: "shares", label: `Not enough ${shownName(i.from)}`, state: "fail", detail: `You can sell ${n(i.available)} ${shownName(i.from)}${i.openA?.some((o) => o.side === "ask") ? " (shares already offered in your open QX orders are not counted)" : ""}.` });
    else if (i.localSteps?.error) out.push({ id: "shares", label: `${shownName(i.from)} to sell`, state: "fail", detail: i.localSteps.error });
    else {
      const moves = i.localSteps?.steps?.sell.steps.filter((s) => s.kind === "transfer-rights") ?? [];
      out.push(moves.length ? { id: "shares", label: "Shares need moving first", state: "warn", detail: moves.map((m) => m.description).join("; ") + "." } : { id: "shares", label: `${shownName(i.from)} ready to sell`, state: "ok" });
    }
  }
  if (i.connected && i.plan?.executable) {
    if (i.balance === null || i.upfront === null) out.push({ id: "fees", label: "Checking your QU", state: "pending" });
    else if (i.balance < i.upfront) out.push({ id: "fees", label: "Not enough QU for the fees up front", state: "fail", detail: `Needs ${n(i.upfront)} QU before the sale pays out; you have ${n(i.balance)} QU.` });
    else if (i.upfront === 0) out.push({ id: "fees", label: "No QU needed up front", state: "ok" });
    else out.push({ id: "fees", label: "QU for the fees up front", state: "ok", detail: `${n(i.upfront)} QU leaves before the sale pays out.` });
  }
  return out;
}
