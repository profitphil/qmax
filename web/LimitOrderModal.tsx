import { useEffect, useRef, useState } from "react";
import type { ExecutionPlan } from "../src/exec.ts";
import { shownName } from "./client.ts";
import type { AssetItem } from "./client.ts";
import { fetchBook } from "./client.ts";
import { fetchFees, fetchOpenOrders, fetchSnapshot } from "./exec/chain.ts";
import { verifiedPass } from "./exec/pass.ts";
import { useCloseSignal } from "./exec/abort.ts";
import { runSteps } from "./exec/run.ts";
import type { StepState } from "./exec/run.ts";
import { buildLimitPlan, checkLimitPlan, farFromMarket, placement } from "../src/limit.ts";
import type { Placement } from "../src/limit.ts";
import { summarizeOutcome } from "../src/verify.ts";
import type { OpenOrder, Snapshot } from "../src/verify.ts";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Icon, Modal, Spinner, StepMark } from "./ui.tsx";
import { TradeCard, dialogClass } from "./TradeCard.tsx";
import { dialogTone, tradeCard } from "../src/tradecard.ts";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const EXPLORER = "https://explorer.qubic.org/network/tx/";
/** A price this far from the middle of the book is probably a slip of the keyboard: say so in red. */
const FAR_PCT = 20;

interface Props {
  asset: AssetItem;
  side: "buy" | "sell";
  qty: number;
  price: number;
  /** Told when the order is over: `finished` is whether every step went through, `filledQty` what it matched at once (null if the wallet could not be read). */
  onFinished?: (r: { finished: boolean; filledQty: number | null }) => void;
  onClose: () => void;
}

/** What the order will do on arrival, in words. */
export function PlacementNote({ side, symbol, price, qty, placed }: { side: "buy" | "sell"; symbol: string; price: number; qty: number; placed: Placement | null }) {
  if (!placed) return null;
  if (placed.kind === "rests") {
    return (
      <p className="note limit-note">
        <Icon name="clock" size={14} /> <span>
          It waits on the QX order book until someone {side === "buy" ? "sells" : "buys"} at {n(price)} QU{placed.away !== null && placed.away >= 0.05 ? ` (${placed.away < 10 ? placed.away.toFixed(1) : n(placed.away)}% ${side === "buy" ? "below the lowest sell order" : "above the highest buy order"})` : ""}. It stays open until it fills or you cancel it.
        </span>
      </p>
    );
  }
  return (
    <p className="note limit-note">
      <Icon name="bolt" size={14} /> <span>
        {placed.restQty === 0 ? "All of it" : `${placed.atLeast ? "At least " : ""}${n(placed.fillQty)} of ${n(qty)} ${symbol}`} matches straight away at the prices on the book (average {n(placed.avgPrice, 2)} QU, {n(placed.costQu)} QU{placed.atLeast ? "+" : ""}), never above your {n(price)} QU
        {placed.restQty > 0 ? `; the other ${n(placed.restQty)} wait on the book at ${n(price)} QU.` : "."}
      </span>
    </p>
  );
}

/**
 * Review and sign a limit order on QX. Unlike a market order there is no quote to trust: the price and amount are the person's, the asset and
 * issuer are from the asset list, and what QX charges for moving shares is read from the network. The plan is built here and checked against
 * exactly that before anything is signed (src/limit.ts), then the wallet is read again afterwards to say what really happened.
 */
export function LimitOrderModal({ asset, side, qty, price, onFinished, onClose }: Props) {
  const { wallet, getSignedTx } = useQubicConnect();
  const closeSignal = useCloseSignal();
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [placed, setPlaced] = useState<Placement | null>(null);
  const [far, setFar] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ filledQty: number; open: OpenOrder[]; restedQty: number } | null>(null);
  const [before, setBefore] = useState<{ snap: Snapshot; open: OpenOrder[] } | null>(null);

  const issuer = asset.issuer;
  const assetName = asset.symbol;
  const wantSide = side === "buy" ? "bid" : "ask";

  // Everything the order depends on is read fresh and checked now, before the wallet is asked for anything.
  useEffect(() => {
    if (!wallet) return;
    (async () => {
      try {
        if (!issuer) throw new Error(`${assetName} has no issuer on record, so an order cannot be placed for it.`);
        if (!asset.venues.includes("QX")) throw new Error(`${assetName} does not trade on QX, which is where limit orders are placed.`);
        if (!(await verifiedPass(wallet.publicKey))) throw new Error("Your QMax pass has ended. Close this and unlock trading again.");
        const [snap, open, fees, book] = await Promise.all([
          fetchSnapshot(wallet.publicKey, issuer, assetName),
          fetchOpenOrders(wallet.publicKey, issuer, assetName),
          fetchFees(),
          fetchBook(asset.id).catch(() => null),
        ]);
        const restingAskQty = open.filter((o) => o.side === "ask").reduce((s, o) => s + o.qty, 0);
        const p = buildLimitPlan({ side, price, qty, assetName, issuer, fees, holdings: snap.holdings, restingAskQty });
        const check = checkLimitPlan(p, { side, price, qty, assetName, issuer, onChainFees: fees });
        if (check.problems.length) throw new Error(`The order does not match what you asked for, so nothing was signed: ${check.problems.join("; ")}.`);
        if (p.maxOutlayQu > snap.balanceQu) throw new Error(`Not enough QU: this order needs up to ${n(p.maxOutlayQu)} QU in the wallet and the wallet has ${n(snap.balanceQu)} QU.`);
        const qx = book?.qx ?? null;
        setPlaced(placement({ side, price, qty }, qx));
        setFar(farFromMarket(price, qx?.bestBid, qx?.bestAsk));
        setBefore({ snap, open });
        setBalance(snap.balanceQu);
        setPlan(p);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const execute = async () => {
    if (!wallet || !plan) return;
    setRunning(true);
    // A fresh baseline at the moment of signing, so earlier activity is not counted.
    const baseline = await Promise.all([fetchSnapshot(wallet.publicKey, issuer, assetName), fetchOpenOrders(wallet.publicKey, issuer, assetName)]).then(([snap, open]) => ({ snap, open })).catch(() => before);
    if (baseline) setBefore(baseline);
    const ok = await runSteps(wallet.publicKey, plan.steps, (tx) => getSignedTx(tx), (id, s) => setStates((cur) => ({ ...cur, [id]: s })), undefined, undefined, closeSignal());
    setFinished(ok);
    setRunning(false);
    if (ok && baseline) await readBack(baseline);
  };

  // Look at the wallet and the book again and say what the order did: matched now, waiting, or both.
  const readBack = async (base: { snap: Snapshot; open: OpenOrder[] }) => {
    if (!wallet) return;
    setChecking(true);
    try {
      let after = base.snap;
      let open = base.open;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 5000));
        [after, open] = await Promise.all([fetchSnapshot(wallet.publicKey, issuer, assetName), fetchOpenOrders(wallet.publicKey, issuer, assetName)]);
        if (JSON.stringify(after) !== JSON.stringify(base.snap) || JSON.stringify(open) !== JSON.stringify(base.open)) break;
      }
      const sum = (list: OpenOrder[]) => list.filter((o) => o.side === wantSide && o.price === price).reduce((s, o) => s + o.qty, 0);
      const restedQty = Math.max(0, sum(open) - sum(base.open));
      const out = summarizeOutcome({ side, requestedQty: qty, quotedQu: price * qty, before: base.snap, after, openOrders: open });
      setResult({ filledQty: out.filledQty, open, restedQty });
    } catch (e) {
      setError(`Could not read the wallet after the order: ${e instanceof Error ? e.message : e}`);
    } finally {
      setChecking(false);
    }
  };

  // Whoever opened this wants to know how it ended.
  const told = useRef(false);
  useEffect(() => {
    if (told.current || !onFinished || finished === null) return;
    if (finished === false) onFinished({ finished: false, filledQty: 0 });
    else if (result) onFinished({ finished: true, filledQty: result.filledQty });
    else if (!checking && error) onFinished({ finished: true, filledQty: null });
    else return;
    told.current = true;
  }, [finished, result, checking, error]);

  const busy = running || checking;
  const value = price * qty;
  // How far along the order is, for the card and for the outline that shakes or bounces the dialog when it ends.
  const card =
    plan && (running || finished !== null || Object.keys(states).length > 0)
      ? tradeCard({
          steps: plan.steps.map((s) => ({ id: s.id, description: s.description })),
          states,
          running,
          finished,
          checking,
          verdict: result ? (result.filledQty > 0 || result.restedQty > 0 ? "good" : "none") : null,
          note: finished === true && !result && !checking ? error || undefined : undefined,
          labels: { success: "Order placed" },
        })
      : null;
  const tone = dialogTone(card, !plan && !!error);
  return (
    <Modal
      size="lg"
      className={dialogClass(tone)}
      title={`Confirm limit ${side} ${n(qty)} ${shownName(asset)}`}
      subtitle="A limit order is placed on the QX order book at your price. A wallet app asks you to approve each step; a wallet opened with a seed or a vault file signs without asking again, so check them here."
      onClose={busy ? undefined : onClose}
      footer={
        <>
          {plan && finished === null && (
            <button className={`go ${side}`} disabled={running} onClick={execute}>
              {running ? <><Spinner size={16} /> Waiting for wallet and network…</> : "Sign and send"}
            </button>
          )}
          <button className="ghost wide" disabled={busy} onClick={onClose}>{finished === null ? "Cancel" : "Close"}</button>
        </>
      }
    >
      {error && <p className="err inline"><Icon name="alert" size={15} /> {error}</p>}
      {!plan && !error && (
        <div className="quote loading" role="status" aria-label="Checking the order">
          <span className="skeleton line" style={{ width: "45%" }} />
          <span className="skeleton line big" style={{ width: "60%" }} />
          <span className="skeleton line" style={{ width: "90%" }} />
        </div>
      )}
      {plan && (
        <>
          {card && <TradeCard view={card} />}
          <div className="quote-top summary">
            <span className="quote-label">{side === "buy" ? "Buy" : "Sell"} {n(qty)} {shownName(asset)} at</span>
            <strong className="quote-total num">{n(price)} <small>QU each</small></strong>
            <span className="quote-avg">{side === "buy" ? "At most" : "Up to"} {n(value)} QU in all{side === "sell" ? ", before QX's fee when it fills" : ""}.</span>
            <small className="quote-asset muted" title={issuer}>{shownName(asset)} issued by {issuer.slice(0, 8)}…{issuer.slice(-6)}</small>
          </div>
          {far !== null && Math.abs(far) >= FAR_PCT && (
            <p className="err inline"><Icon name="alert" size={15} /> This price is {n(Math.abs(far), 0)}% {far > 0 ? "above" : "below"} the middle of the book. Check it before you sign.</p>
          )}
          <PlacementNote side={side} symbol={shownName(asset)} price={price} qty={qty} placed={placed} />
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
            {side === "buy"
              ? `${n(plan.maxOutlayQu)} QU goes to QX with the order: what it matches now is paid at the resting prices, the rest stays locked in the order until it fills, and anything unused comes back. Cancelling an open order returns its QU.`
              : "Selling locks these units in the order while it waits; cancelling it releases them. QU is only paid out when someone buys."}
            {" "}QMax charges nothing for trading. Wallet balance: {balance === null ? "…" : n(balance)} QU.
          </p>
          {finished === false && <p className="err inline"><Icon name="alert" size={15} /> Stopped. Later steps were not sent. Check completed steps on the explorer.</p>}
          {result && (
            <div className={result.restedQty > 0 || result.filledQty > 0 ? "result good" : "result"}>
              {result.filledQty > 0 && (
                <p className="ok"><Icon name="check" size={16} /> <strong>{side === "buy" ? "Bought" : "Sold"} {n(result.filledQty)} {shownName(asset)} right away</strong>{result.filledQty >= qty ? ": the order filled in full." : "."}</p>
              )}
              {result.restedQty > 0 && (
                <p className={result.filledQty > 0 ? "warn" : "ok"}>
                  <Icon name="clock" size={16} /> <strong>{n(result.restedQty)} {shownName(asset)} {side === "buy" ? "bid" : "offered"} at {n(price)} QU is on the QX book.</strong> It waits there until it fills; cancel it any time under Orders.
                </p>
              )}
              {result.filledQty === 0 && result.restedQty === 0 && (
                <p className="warn"><Icon name="alert" size={16} /> Nothing has changed in your wallet or on the book yet. It may still be updating: check Orders and the explorer before placing it again.</p>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
