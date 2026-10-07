import { useEffect, useRef, useState } from "react";
import { buildExecutionPlan } from "../src/exec.ts";
import type { ExecutionPlan } from "../src/exec.ts";
import { fetchQuote, reportRef, shownName } from "./client.ts";
import { fetchVenueQuote } from "./max-api.ts";
import { UsageNote } from "./UsageNote.tsx";
import type { QuoteResponse } from "./client.ts";
import { fetchFees, fetchHoldings, fetchOpenOrders, fetchSnapshot } from "./exec/chain.ts";
import { summarizeOutcome } from "../src/verify.ts";
import type { Outcome, Snapshot } from "../src/verify.ts";
import { verifiedPass } from "./exec/pass.ts";
import { useCloseSignal } from "./exec/abort.ts";
import { buildConsolidation, previewKeep } from "../src/consolidate.ts";
import type { Consolidation, ManageTarget } from "../src/consolidate.ts";
import { MoveShares, targetName } from "./MoveShares.tsx";
import { useSettings } from "./settings.tsx";
import { runSteps } from "./exec/run.ts";
import type { StepState } from "./exec/run.ts";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Icon, Modal, Spinner, StepMark } from "./ui.tsx";
import { TradeCard, dialogClass } from "./TradeCard.tsx";
import { dialogTone, tradeCard } from "../src/tradecard.ts";
import { SavingsReceipt, loadTally, recordTrade } from "./savings.tsx";
import { routeSaving } from "../src/savings.ts";
import { checkQuotePlan } from "../src/plancheck.ts";
import type { SavingsTally } from "../src/savings.ts";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const EXPLORER = "https://explorer.qubic.org/network/tx/";

interface Props {
  shown: QuoteResponse;
  slippageBps: number;
  /** The asset the person chose (its listed name and issuer, from the asset list): the quote is checked against it, not trusted to say which asset it is for. */
  expected: { assetName: string; issuer: string };
  /** The partner that sent the user, told about the finished trade (counting only). */
  refTag?: string;
  /** Route on this one market only, instead of the best route (a plain QSwap swap, or a leg of a Max arbitrage). The quote is re-made the same way before signing. */
  venue?: "QX" | "QSwap";
  /** Told when the trade is over: `finished` is whether every step went through, `filledQty` what the wallet check found (null if it could not be read). */
  onFinished?: (r: { finished: boolean; filledQty: number | null }) => void;
  onClose: () => void;
}

export function ExecuteModal({ shown, slippageBps, expected, refTag, venue, onFinished, onClose }: Props) {
  const { wallet, getSignedTx } = useQubicConnect();
  const closeSignal = useCloseSignal();
  const { settings } = useSettings();
  const [keepPlan, setKeepPlan] = useState<Consolidation | null>(null);
  // Asked while the buy is being built; the saved setting only sets the starting answer.
  const [keep, setKeep] = useState(settings.consolidate);
  const [keepTo, setKeepTo] = useState<ManageTarget>(settings.consolidateTo);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [planWarnings, setPlanWarnings] = useState<string[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<boolean | null>(null);
  const [before, setBefore] = useState<Snapshot | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [checking, setChecking] = useState(false);
  const [tally, setTally] = useState<SavingsTally | undefined>(() => (wallet ? loadTally(wallet.publicKey) : undefined));

  // Re-quote right before trading so the signed limits are based on current prices.
  useEffect(() => {
    if (!wallet) return;
    (async () => {
      try {
        const fresh = venue
          ? await fetchVenueQuote({ side: shown.side, asset: shown.asset, qty: shown.qty, venue, slippageBps })
          : await fetchQuote({ side: shown.side, asset: shown.asset, qty: shown.qty, slippageBps });
        if (!fresh.fillable || !fresh.executable) throw new Error("This order can no longer be filled at current liquidity.");
        const snap = await fetchSnapshot(wallet.publicKey, fresh.assetInfo.issuer, fresh.assetInfo.assetName);
        const bal = snap.balanceQu;
        const holdings = snap.holdings;
        // What moving shares costs is read from the network, never taken from the quote: a share move attaches that fee to the call.
        const onChainFees = await fetchFees().catch(() => undefined);
        const trusted = onChainFees ? { ...fresh, assetInfo: { ...fresh.assetInfo, transferFeeQu: onChainFees } } : fresh;
        // Trading needs an active pass (checked against QPayhub's receipt, not just what this browser remembers).
        if (!(await verifiedPass(wallet.publicKey))) throw new Error("Your QMax pass has ended. Close this and unlock trading again.");
        const p = buildExecutionPlan(trusted, shown.side === "sell" ? holdings : {});
        // What is about to be signed must be what was asked for: this asset and issuer, this side and size, limits inside the slippage setting.
        const check = checkQuotePlan(trusted, p, { side: shown.side, qty: shown.qty, assetName: expected.assetName, issuer: expected.issuer, slippageBps, onChainFees });
        if (check.problems.length) throw new Error(`QMax's answer does not match what you asked for, so nothing was signed: ${check.problems.join("; ")}.`);
        setPlanWarnings(check.warnings);
        // Sells need QU too: the routing fee is paid up front, and QSwap takes a flat 100,000 QU per swap.
        if (p.maxOutlayQu > bal)
          throw new Error(`Not enough QU: this trade needs up to ${n(p.maxOutlayQu)} QU in the wallet (flat market fees are paid in QU, even when selling) and the wallet has ${n(bal)} QU.`);
        setBefore(snap);
        setQuote(trusted);
        setPlan(p);
        setBalance(bal);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const worse =
    quote && (shown.side === "buy" ? quote.totalQu > shown.totalQu * 1.005 : quote.totalQu < shown.totalQu * 0.995);

  const execute = async () => {
    if (!wallet || !plan || !quote) return;
    setRunning(true);
    // Fresh baseline taken at the moment of signing, so unrelated earlier activity is not counted.
    const baseline = await fetchSnapshot(wallet.publicKey, quote.assetInfo.issuer, quote.assetInfo.assetName).catch(() => before);
    setBefore(baseline);
    const txIds = new Set<string>();
    const ok = await runSteps(
      wallet.publicKey,
      plan.steps,
      (tx) => getSignedTx(tx),
      (id, s) => {
        if ("txId" in s) txIds.add(s.txId);
        setStates((cur) => ({ ...cur, [id]: s }));
      },
      undefined,
      undefined,
      closeSignal(),
    );
    if (ok && refTag) reportRef(refTag, "trade", [...txIds]);
    setFinished(ok);
    setRunning(false);
    await verifyResult(baseline);
    // A buy asks the question up front (keep); a sale only offers the move when the saved setting is on.
    if (ok && (quote.side === "buy" ? keep : settings.consolidate)) await offerKeepManaged(quote.side === "buy" ? keepTo : settings.consolidateTo);
  };

  // The person asked to keep shares under one contract: after the trade, read what they now hold and offer the moves.
  const offerKeepManaged = async (target: ManageTarget) => {
    if (!wallet || !quote) return;
    try {
      const { issuer, assetName } = quote.assetInfo;
      const [holdings, fees] = await Promise.all([fetchHoldings(wallet.publicKey, issuer, assetName), fetchFees()]);
      const plan = buildConsolidation([{ symbol: quote.asset, issuer, assetName, holdings }], target, fees);
      if (plan.steps.length) setKeepPlan(plan);
    } catch {
      // the offer is a convenience; the trade itself is done
    }
  };

  // Re-read the wallet after the trade to report what really happened (not just that transactions were included).
  const verifyResult = async (before: Snapshot | null) => {
    if (!wallet || !quote || !before) return;
    setChecking(true);
    try {
      let after = before;
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((r) => setTimeout(r, 5000));
        after = await fetchSnapshot(wallet.publicKey, quote.assetInfo.issuer, quote.assetInfo.assetName);
        if (JSON.stringify(after) !== JSON.stringify(before)) break; // balances have moved
      }
      const openOrders = quote.route.some((r) => r.venue === "QX")
        ? await fetchOpenOrders(wallet.publicKey, quote.assetInfo.issuer, quote.assetInfo.assetName).catch(() => [])
        : [];
      const summary = summarizeOutcome({ side: quote.side, requestedQty: quote.qty, quotedQu: quote.totalQu, before, after, openOrders });
      setOutcome(summary);
      // Count the saving only for what really filled (a partial fill counts its share), and only once.
      const saving = routeSaving(quote);
      if (saving && (summary.status === "filled" || summary.status === "partial") && summary.requestedQty > 0)
        setTally(recordTrade(wallet.publicKey, saving, Math.min(1, summary.filledQty / summary.requestedQty)));
    } catch (e) {
      setError(`Could not read the wallet after the trade: ${e instanceof Error ? e.message : e}`);
    } finally {
      setChecking(false);
    }
  };

  // Whoever opened this wants to know how it ended: after a failure at once, otherwise when the wallet has been read (or could not be).
  const told = useRef(false);
  useEffect(() => {
    if (told.current || !onFinished || finished === null) return;
    if (finished === false) onFinished({ finished: false, filledQty: 0 });
    else if (outcome) onFinished({ finished: true, filledQty: outcome.filledQty });
    else if (!checking && error) onFinished({ finished: true, filledQty: null });
    else return;
    told.current = true;
  }, [finished, outcome, checking, error]);

  const stepsRunning = running || checking;
  // How far along the trade is, for the card and for the outline that shakes or bounces the dialog when it ends.
  const card =
    plan && (running || finished !== null || Object.keys(states).length > 0)
      ? tradeCard({
          steps: plan.steps.map((s) => ({ id: s.id, description: s.description })),
          states,
          running,
          finished,
          checking,
          verdict: outcome ? (outcome.status === "filled" || outcome.status === "oversold" ? "good" : outcome.status === "partial" ? "partial" : "none") : null,
          note: finished === true && !outcome && !checking ? error || undefined : undefined,
          labels: { success: shown.side === "buy" ? "Bought" : "Sold" },
        })
      : null;
  const tone = dialogTone(card, !plan && !!error);
  return (
    <Modal
      size="lg"
      className={dialogClass(tone)}
      title={`Confirm ${shown.side} ${n(shown.qty)} ${shown.asset}`}
      subtitle="Review the steps. A wallet app asks you to approve each one; a wallet opened with a seed or a vault file signs them without asking again, so check them here."
      onClose={stepsRunning ? undefined : onClose}
      footer={
        <>
          {plan && quote && finished === null && (
            <button className={`go ${shown.side}`} disabled={running} onClick={execute}>
              {running ? <><Spinner size={16} /> Waiting for wallet and network…</> : worse ? "Accept new price and sign" : "Sign and send"}
            </button>
          )}
          <button className="ghost wide" disabled={stepsRunning} onClick={onClose}>{finished === null ? "Cancel" : "Close"}</button>
        </>
      }
    >
      {error && <p className="err inline"><Icon name="alert" size={15} /> {error}</p>}
      {!plan && !error && (
        <div className="quote loading" role="status" aria-label="Getting a fresh quote">
          <span className="skeleton line" style={{ width: "45%" }} />
          <span className="skeleton line big" style={{ width: "60%" }} />
          <span className="skeleton line" style={{ width: "90%" }} />
        </div>
      )}
      {plan && quote && (
        <>
          {card && <TradeCard view={card} />}
          <div className="quote-top summary">
            <span className="quote-label">{shown.side === "buy" ? "Total cost" : "You receive"}</span>
            <strong className="quote-total num">{n(quote.totalQu)} <small>QU</small></strong>
            {worse && <span className="warn inline"><Icon name="alert" size={14} /> Price moved against you: was {n(shown.totalQu)} QU</span>}
            <small className="quote-asset muted" title={quote.assetInfo.issuer}>{shownName({ id: quote.asset, symbol: quote.assetInfo.assetName })} issued by {quote.assetInfo.issuer.slice(0, 8)}…{quote.assetInfo.issuer.slice(-6)}</small>
          </div>
          {planWarnings.map((w) => (
            <p key={w} className="warn inline"><Icon name="alert" size={14} /> {w}</p>
          ))}
          <ol className="timeline">
            {plan.steps.map((s) => {
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
          <p className="note">
            Slippage limit {slippageBps / 100}%. Up to {n(plan.maxOutlayQu)} QU may leave your wallet; unused QU is refunded
            by the contracts. QMax charges nothing for trading. Wallet balance: {balance === null ? "…" : n(balance)} QU.
          </p>
          <UsageNote />
          {quote.side === "buy" && quote.route.some((r) => r.venue === "QX") && (
            <p className="note">
              QX fills as a limit order: if the book moves before it lands, any part not filled stays on QX as an open bid.
            </p>
          )}
          {finished === false && (
            <p className="err inline"><Icon name="alert" size={15} /> Stopped. Later steps were not sent. Check completed steps on the explorer.</p>
          )}
          {outcome && <ResultPanel o={outcome} side={quote.side} asset={quote.asset} />}
          {outcome && (outcome.status === "filled" || outcome.status === "partial") && (
            <SavingsReceipt saving={routeSaving(quote)} side={quote.side} asset={quote.asset} filledQty={outcome.filledQty} actualQu={outcome.actualQu} tally={tally} />
          )}
          {keepPlan && (
            <div className="result">
              <p><strong>Keep {quote.asset} under {targetName(quote.side === "buy" ? keepTo : settings.consolidateTo)}</strong> <span className="muted">({quote.side === "buy" ? "you chose this for this order" : "your setting"})</span></p>
              <MoveShares plan={keepPlan} targetName={targetName(quote.side === "buy" ? keepTo : settings.consolidateTo)} auto={quote.side === "buy"} />
            </div>
          )}
          {quote.side === "buy" && finished === null && (
            <div className="field keep">
              <label className="check">
                <input type="checkbox" checked={keep} disabled={running} onChange={(e) => setKeep(e.target.checked)} /> After buying, keep my {quote.asset} under one contract
              </label>
              {keep && (
                <span className="chips">
                  {(["qx", "qswap"] as const).map((t) => (
                    <button key={t} className={keepTo === t ? "chip on" : "chip"} disabled={running} onClick={() => setKeepTo(t)}>{targetName(t)}{t === "qx" ? " (default)" : ""}</button>
                  ))}
                </span>
              )}
              {keep && <small>{previewKeep({ asset: quote.asset, route: quote.route, fees: quote.assetInfo.transferFeeQu, to: keepTo, held: before?.holdings })}</small>}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function ResultPanel({ o, side, asset }: { o: Outcome; side: "buy" | "sell"; asset: string }) {
  const verb = side === "buy" ? "Bought" : "Sold";
  const quLabel = side === "buy" ? "Spent" : "Received";
  const headline =
    o.status === "filled" ? `${verb} ${n(o.filledQty)} ${asset}, order filled in full.`
    : o.status === "partial" ? `Partly filled: ${verb.toLowerCase()} ${n(o.filledQty)} of ${n(o.requestedQty)} ${asset}.`
    : o.status === "oversold" ? `${verb} ${n(o.filledQty)} ${asset}, more than requested (other activity in the wallet may be included).`
    : `No ${asset} moved in your wallet yet. The balance may still be updating; check the explorer before retrying.`;
  return (
    <div className={o.status === "filled" ? "result good" : "result"}>
      <p className={o.status === "filled" ? "ok" : "warn"}><Icon name={o.status === "filled" ? "check" : "alert"} size={16} /> <strong>{headline}</strong></p>
      {o.filledQty > 0 && (
        <p>
          {quLabel} {n(o.actualQu)} QU (about {n(o.actualPriceQu ?? 0, 4)} QU each, including market fees).
          {o.slippage !== null && <> Quoted {n(o.quotedQu)} QU, {n(Math.abs(o.slippage) * 100, 2)}% {o.slippage > 0 ? "worse" : "better"} than quoted.</>}
        </p>
      )}
      {o.openOrders.length > 0 && (
        <p className="warn">
          Still open on QX: {o.openOrders.map((x) => `${x.side} ${n(x.qty)} @ ${n(x.price)} QU`).join(", ")}
          {o.lockedInOrdersQu > 0 && <> ({n(o.lockedInOrdersQu)} QU locked until it fills or you cancel it)</>}.
        </p>
      )}
    </div>
  );
}

