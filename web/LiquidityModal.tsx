import { useEffect, useMemo, useRef, useState } from "react";
import type { Holdings, TxStep } from "../src/exec.ts";
import { LIQUIDITY_FEE_QU, asTxSteps, maxAddQu, noChangeNotes, planAddLiquidity, planRemoveLiquidity, poolPriceQu, positionValue, recheckAdd, recheckRemove } from "../src/liquidity.ts";
import type { AddPlan, AssetRef, LiquidityOf, LiquidityStep, PoolState, RemovePlan, TxFate } from "../src/liquidity.ts";
import { FEE_MODEL } from "../src/pools.ts";
import { QSWAP_INDEX, QX_INDEX } from "../src/rpc.ts";
import { freeHoldings } from "../src/swap.ts";
import type { OpenOrder, Snapshot } from "../src/verify.ts";
import type { AssetItem } from "./client.ts";
import { fetchFees, fetchHoldings, fetchOpenOrders, fetchSnapshot } from "./exec/chain.ts";
import { runSteps } from "./exec/run.ts";
import { useCloseSignal } from "./exec/abort.ts";
import { UsageNote } from "./UsageNote.tsx";
import type { StepState } from "./exec/run.ts";
import { fetchLiquidityPool, readPoolLive, readPositionLive } from "./liquidity-api.ts";
import { useSettings } from "./settings.tsx";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Avatar, Icon, Modal, Spinner, StepMark } from "./ui.tsx";

const n = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const qu = (x: number) => `${n(x)} QU`;
const priceText = (p: number | null) => (p === null ? "no price" : `${n(p, p < 10 ? 4 : p < 1000 ? 2 : 0)} QU`);
const pct = (x: number) => `${n(x, x < 0.01 ? 4 : x < 1 ? 3 : 2)}%`;
const signed = (x: number, unit: string) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${n(Math.abs(x))} ${unit}`;
const EXPLORER = "https://explorer.qubic.org/network/tx/";
const SLIPPAGES = [0.5, 1, 3, 5, 10];
const PERCENTS = [25, 50, 75, 100];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tokensOf = (h: Holdings) => (h[QX_INDEX] ?? 0) + (h[QSWAP_INDEX] ?? 0);

/** Why a reviewed deposit's steps no longer fit the wallet's shares (they moved since the review), or null. */
function sharesProblem(plan: AddPlan, free: Holdings, sym: string): string | null {
  const underQswap = free[QSWAP_INDEX] ?? 0;
  const underQx = free[QX_INDEX] ?? 0;
  if (underQswap + plan.moveQty < plan.assetAmount || underQx < plan.moveQty)
    return `Your ${sym} changed since the review (${n(underQswap)} under QSwap, ${n(underQx)} under QX that can move). Review it again.`;
  return null;
}

type Mode = "add" | "remove";
type Phase = "form" | "checking" | "review" | "running" | "verifying" | "done" | "stopped";

interface Props {
  /** The asset whose QSwap pool to add to or remove from (as /v1/assets lists it). */
  asset: AssetItem;
  mode: Mode;
  onClose: () => void;
  /** Told after transactions were sent, so the caller can read positions and balances again. */
  onChanged?: () => void;
  /** Opens the wallet picker. */
  onConnect?: () => void;
}

interface WalletView {
  snap: Snapshot;
  open: OpenOrder[];
  /** Shares QX and QSwap can use: the ones in the wallet's own resting QX asks left out. */
  free: Holdings;
  position: LiquidityOf;
}

/** What the read-back after the run found: the wallet and the position before and after, and what was really sent. */
interface Outcome {
  liquidity: number;
  dLiquidity: number;
  dQu: number;
  dTokens: number;
  underQswapBefore: number;
  underQswapAfter: number;
  share: number;
  liquidityTx: TxFate;
  moveTx?: TxFate;
}

/**
 * Adding to, or taking out of, an existing QSwap pool. ADD: type the QU side; the token side follows the pool's ratio exactly
 * as the contract computes it, and the deposit is limited so a price move past the slippage refuses (QSwap then refunds
 * everything, its flat fee included). REMOVE: a share of the position, with minimums. Both re-read the pool straight from the
 * contract before signing, refuse rather than sign something different from what was reviewed, and read the wallet back after.
 */
export function LiquidityModal({ asset, mode, onClose, onChanged, onConnect }: Props) {
  const { connected, wallet, getSignedTx } = useQubicConnect();
  const closeSignal = useCloseSignal();
  const { settings } = useSettings();
  const ref: AssetRef = useMemo(() => ({ symbol: asset.symbol, issuer: asset.issuer, assetName: asset.symbol }), [asset.id]);
  const sym = asset.symbol;

  const [phase, setPhase] = useState<Phase>("form");
  const [pool, setPool] = useState<PoolState | null>(null);
  const [poolAt, setPoolAt] = useState<number>(0);
  const [poolError, setPoolError] = useState("");
  const [view, setView] = useState<WalletView | null>(null);
  const [walletError, setWalletError] = useState("");
  const [fees, setFees] = useState<{ qx: number; qswap: number } | null>(null);
  const [reload, setReload] = useState(0);
  const [slippagePct, setSlippagePct] = useState(() => Math.min(10, Math.max(0.5, settings.slippagePct || 1)));
  const [quText, setQuText] = useState("");
  const [removePct, setRemovePct] = useState<number | null>(null);
  const [unitsText, setUnitsText] = useState("");
  const [review, setReview] = useState<{ add?: AddPlan; remove?: RemovePlan; before: WalletView; notes: string[] } | null>(null);
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [stopReason, setStopReason] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const busy = phase === "checking" || phase === "running" || phase === "verifying";
  // False once the dialog is gone: nothing may then open a signing request the user cannot see.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // The pool: the server's read first (cached for seconds), or straight from the contract if the server cannot.
  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    setPoolError("");
    fetchLiquidityPool(asset.id, ctl.signal)
      .then((p) => ({ exists: p.exists, reserveQu: p.reserveQu, reserveAsset: p.reserveAsset, totalLiquidity: p.totalLiquidity }))
      .catch(() => readPoolLive(ref))
      .then((p) => {
        if (!live) return;
        setPool(p);
        setPoolAt(Date.now());
      })
      .catch((e) => live && setPoolError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
      ctl.abort();
    };
  }, [asset.id, reload]);

  // The wallet: QU, the token per managing contract, resting QX orders (their shares cannot move), and the position.
  useEffect(() => {
    setView(null);
    setWalletError("");
    if (!wallet) return;
    let live = true;
    readWallet(wallet.publicKey)
      .then((v) => live && setView(v))
      .catch((e) => live && setWalletError(e instanceof Error ? e.message : String(e)));
    fetchFees()
      .then((f) => live && setFees(f))
      .catch(() => live && setFees(null));
    return () => {
      live = false;
    };
  }, [wallet?.publicKey, asset.id, reload]);

  async function readWallet(id: string): Promise<WalletView> {
    const [snap, open, position] = await Promise.all([fetchSnapshot(id, asset.issuer, asset.symbol), fetchOpenOrders(id, asset.issuer, asset.symbol).catch(() => [] as OpenOrder[]), readPositionLive(id, ref)]);
    return { snap, open, free: freeHoldings(snap.holdings, open), position };
  }

  const slippageBps = Math.round(slippagePct * 100);
  const quAmount = Number(quText.replace(/[,\s]/g, ""));
  const validQu = quText !== "" && Number.isSafeInteger(quAmount) && quAmount > 0;
  const liquidity = view?.position.liquidity ?? 0;

  // Without a wallet the plan is a preview: as if the wallet held plenty, so it can show what a deposit takes.
  const addPlan = useMemo(() => {
    if (mode !== "add" || !pool || !validQu) return null;
    return planAddLiquidity({
      asset: ref,
      pool,
      quAmount,
      balanceQu: view ? view.snap.balanceQu : Number.MAX_SAFE_INTEGER,
      holdings: view ? view.free : { [QSWAP_INDEX]: Number.MAX_SAFE_INTEGER },
      slippageBps,
      transferFeeQu: fees ?? { qx: 100, qswap: 100 },
      currentLiquidity: liquidity,
    });
  }, [mode, pool, quAmount, validQu, view, slippageBps, fees]);

  const units = Number(unitsText.replace(/[,\s]/g, ""));
  const removeAmount = removePct !== null ? { percent: removePct } : unitsText !== "" ? { units } : null;
  const removePlan = useMemo(() => {
    if (mode !== "remove" || !pool || !view || !removeAmount) return null;
    return planRemoveLiquidity({ asset: ref, pool, liquidity, amount: removeAmount, balanceQu: view.snap.balanceQu, slippageBps });
  }, [mode, pool, view, removePct, unitsText, slippageBps]);

  const maxQu = useMemo(
    () => (mode === "add" && pool && view && fees ? maxAddQu({ asset: ref, pool, balanceQu: view.snap.balanceQu, holdings: view.free, slippageBps, transferFeeQu: fees, currentLiquidity: liquidity }) : null),
    [mode, pool, view, fees, slippageBps],
  );

  // ---- review and run -------------------------------------------------------------------------------------------

  const fail = (reason: string) => {
    setStopReason(reason);
    setPhase("stopped");
  };

  /** Re-reads the pool from the contract and the wallet; the reviewed call must still go through as it is. */
  const startReview = async () => {
    if (!wallet || !pool) return;
    setPhase("checking");
    setError("");
    try {
      const [fresh, before] = await Promise.all([readPoolLive(ref), readWallet(wallet.publicKey)]);
      setView(before);
      if (mode === "add") {
        if (!addPlan?.ok) throw new Error(addPlan?.refusal?.message ?? "This deposit is not ready.");
        // The same deposit against the wallet as it is now (the call depends only on the pool the user saw and the amount).
        const again = planAddLiquidity({ asset: ref, pool: addPlan.pool, quAmount, balanceQu: before.snap.balanceQu, holdings: before.free, slippageBps, transferFeeQu: fees ?? { qx: 100, qswap: 100 }, currentLiquidity: before.position.liquidity });
        if (!again.ok) throw new Error(again.refusal!.message);
        const check = recheckAdd(again, fresh);
        if (!check.ok) return reviewRefused(check.reason, fresh);
        // At the fresh price QSwap would take all the QU for the same tokens: plan again at that price instead.
        if (check.quSide) return reviewRefused(`${check.warnings[0] ?? "The price rose since you entered the amount."} So it was not offered for signing.`, fresh);
        setReview({ add: again, before, notes: check.warnings });
      } else {
        if (!removePlan?.ok) throw new Error(removePlan?.refusal?.message ?? "This removal is not ready.");
        const check = recheckRemove(removePlan, fresh, before.position.liquidity);
        if (!check.ok) return reviewRefused(check.reason, fresh);
        if (before.snap.balanceQu < LIQUIDITY_FEE_QU) throw new Error(`Removing costs a flat 100,000 QU and the wallet now has ${qu(before.snap.balanceQu)}.`);
        setReview({ remove: removePlan, before, notes: check.warnings });
      }
      setStates({});
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("form");
    }
  };

  /** The price moved past the limits since the form was filled: say so, and show the pool as it is now. */
  const reviewRefused = (reason: string, fresh: PoolState) => {
    setError(`${reason} The figures below are now at the new price; check them and review again.`);
    setPool(fresh);
    setPoolAt(Date.now());
    setPhase("form");
  };

  const sign = (tx: Parameters<typeof getSignedTx>[0]) => {
    if (!alive.current) return Promise.reject(new Error("The window was closed, so nothing more was sent."));
    return getSignedTx(tx);
  };
  // What each step really reached: broadcast (it got a transaction id) and included in a processed tick (afterConfirm ran).
  const sent = useRef<Record<string, boolean>>({});
  const included = useRef<Record<string, boolean>>({});
  const onState = (id: string, s: StepState) => {
    if (s.status === "confirming") sent.current[id] = true;
    setStates((cur) => ({ ...cur, [id]: s }));
  };
  const fateOf = (id: string): TxFate => (included.current[id] ? "included" : sent.current[id] ? "unconfirmed" : "not-sent");

  const signAndRun = async () => {
    if (!wallet || !review) return;
    const plan = review.add ?? review.remove!;
    setPhase("running");
    setError("");
    sent.current = {};
    included.current = {};
    // One last read of the pool right before the wallet is asked to sign: refuse rather than send into a moved pool.
    let base: WalletView;
    try {
      const [fresh, b] = await Promise.all([readPoolLive(ref), readWallet(wallet.publicKey)]);
      base = b;
      const check = review.add ? recheckAdd(review.add, fresh) : recheckRemove(review.remove!, fresh, b.position.liquidity);
      if (!check.ok) return fail(`${check.reason} Nothing was signed.`);
      if (check.quSide) return fail(`${check.warnings[0]} So nothing was signed; open it again to plan the deposit at the new price.`);
      if (b.snap.balanceQu < plan.maxOutlayQu) return fail(`The wallet now holds ${qu(b.snap.balanceQu)}, less than the ${qu(plan.maxOutlayQu)} these steps attach. Nothing was signed.`);
      const shares = review.add ? sharesProblem(review.add, b.free, sym) : null;
      if (shares) return fail(`${shares} Nothing was signed.`);
    } catch (e) {
      return fail(`Could not read the pool and the wallet right before signing (${e instanceof Error ? e.message : String(e)}). Nothing was signed.`);
    }
    if (!alive.current) return;
    // After a share move, make sure QSwap really manages the shares before the deposit is sent (QX moves nothing if they
    // are tied up in a resting ask). The deposit would be refunded in full anyway; this just saves the trip.
    const afterConfirm = async (step: TxStep) => {
      included.current[step.id] = true;
      if ((step as unknown as LiquidityStep).kind !== "transfer-rights" || !review.add) return;
      const add = review.add;
      let managed = false;
      for (let i = 0; i < 8 && !managed; i++) {
        const h = await fetchHoldings(wallet.publicKey, asset.issuer, asset.symbol).catch(() => null);
        if (h && (h[QSWAP_INDEX] ?? 0) >= add.assetAmount) managed = true;
        else await sleep(4000);
      }
      if (!managed)
        throw new Error(`QSwap does not manage enough ${sym} yet (the move may have been refused: shares in an open QX sell order cannot move). The deposit was not sent; you still have all your QU and ${sym}.`);
      // The deposit is signed only now, maybe a minute after the check above: read the pool again so it is never signed
      // into a pool that moved past the limit, or that would take all the QU for the same tokens.
      const fresh = await readPoolLive(ref).catch(() => null);
      if (!fresh) throw new Error(`The pool could not be read again before the deposit, so it was not sent. The ${n(add.moveQty)} ${sym} now managed by QSwap stay there.`);
      const check = recheckAdd(add, fresh);
      if (!check.ok) throw new Error(`${check.reason} The ${n(add.moveQty)} ${sym} now managed by QSwap stay there.`);
      if (check.quSide) throw new Error(`${check.warnings[0]} So the deposit was not sent; open it again to plan it at the new price.`);
    };
    const ok = await runSteps(wallet.publicKey, asTxSteps(plan.steps), sign, onState, afterConfirm, undefined, closeSignal());
    onChanged?.();
    setPhase("verifying");
    await readBack(base, ok);
    // Again once the change can be seen, so whatever the caller reads next is not from before it.
    onChanged?.();
  };

  /** Reads the wallet and the position again until the change shows (or it gives up), and says what really happened. */
  const readBack = async (base: WalletView, ok: boolean) => {
    if (!wallet) return;
    let after = base;
    try {
      const moved = (v: WalletView) => v.position.liquidity !== base.position.liquidity || v.snap.balanceQu !== base.snap.balanceQu;
      // Nothing broadcast: nothing to wait for.
      const rounds = ok ? 8 : Object.keys(sent.current).length > 0 ? 2 : 0;
      for (let i = 0; i < rounds; i++) {
        await sleep(5000);
        after = await readWallet(wallet.publicKey).catch(() => after);
        if (moved(after)) {
          await sleep(3000);
          after = await readWallet(wallet.publicKey).catch(() => after);
          break;
        }
      }
      const freshPool = await readPoolLive(ref).catch(() => pool);
      if (freshPool) setPool(freshPool);
      setView(after);
      const steps = (review?.add ?? review?.remove)?.steps ?? [];
      const liquidityStep = steps.find((s) => s.kind !== "transfer-rights");
      const moveStep = steps.find((s) => s.kind === "transfer-rights");
      setOutcome({
        liquidity: after.position.liquidity,
        dLiquidity: after.position.liquidity - base.position.liquidity,
        dQu: after.snap.balanceQu - base.snap.balanceQu,
        dTokens: tokensOf(after.snap.holdings) - tokensOf(base.snap.holdings),
        underQswapBefore: base.snap.holdings[QSWAP_INDEX] ?? 0,
        underQswapAfter: after.snap.holdings[QSWAP_INDEX] ?? 0,
        share: freshPool && freshPool.totalLiquidity > 0 ? (after.position.liquidity / freshPool.totalLiquidity) * 100 : 0,
        liquidityTx: liquidityStep ? fateOf(liquidityStep.id) : "not-sent",
        moveTx: moveStep ? fateOf(moveStep.id) : undefined,
      });
    } catch (e) {
      setError(`Could not read the wallet afterwards: ${e instanceof Error ? e.message : String(e)}. Check the explorer.`);
    }
    if (ok) setPhase("done");
    else fail("A step did not complete, so nothing after it was sent.");
  };

  // ---- view -----------------------------------------------------------------------------------------------------

  const price = pool ? poolPriceQu(pool) : null;
  const current = pool ? positionValue(pool, liquidity) : null;
  const title = mode === "add" ? `Add liquidity: ${sym}` : `Remove liquidity: ${sym}`;
  const plan = mode === "add" ? addPlan : removePlan;
  const poolUsable = !!pool && pool.exists && pool.totalLiquidity > 0;
  // Without the transfer fees a share move cannot be built with the right attachment; a deposit that needs none can go ahead.
  const ready = connected && !!view && poolUsable && !!plan?.ok && (mode === "remove" || !!fees || (addPlan?.moveQty ?? 0) === 0);
  const poolAge = poolAt ? Math.max(0, Math.round((now - poolAt) / 1000)) : null;

  const footer =
    phase === "form" ? (
      <>
        {!connected ? (
          <button className="go buy" onClick={onConnect} disabled={!onConnect}><Icon name="wallet" size={17} /> Connect wallet</button>
        ) : (
          <button className={mode === "add" ? "go buy" : "go sell"} disabled={!ready} onClick={startReview}>
            {mode === "add" ? (validQu ? "Review and sign" : "Enter an amount") : removeAmount ? "Review and sign" : "Choose how much"}
          </button>
        )}
        <button className="ghost wide" onClick={onClose}>Cancel</button>
      </>
    ) : phase === "checking" ? (
      <button className="go buy" disabled><Spinner size={16} /> Reading the pool and your wallet…</button>
    ) : phase === "review" ? (
      <>
        <button className={mode === "add" ? "go buy" : "go sell"} onClick={signAndRun}>{mode === "add" ? `Sign and add to the ${sym} pool` : `Sign and remove`}</button>
        <button className="ghost wide" onClick={() => setPhase("form")}>Back</button>
      </>
    ) : busy ? (
      <button className="go buy" disabled><Spinner size={16} /> {phase === "running" ? "Waiting for your wallet and the network…" : "Reading your wallet back…"}</button>
    ) : (
      <button className="ghost wide" onClick={onClose}>Close</button>
    );

  return (
    <Modal size="lg" className="liq" title={title} subtitle={mode === "add" ? "Put QU and tokens into the QSwap pool at its own ratio, and earn a share of its swap fees." : "Take your share of the QSwap pool back out, in QU and tokens."} onClose={busy ? undefined : onClose} footer={footer}>
      {error && <p className="err inline"><Icon name="alert" size={15} /> {error}</p>}

      <PoolStrip asset={asset} pool={pool} price={price} error={poolError} age={poolAge} position={connected ? (view ? { liquidity, value: current } : null) : undefined} onRetry={() => setReload((x) => x + 1)} />

      {phase === "form" && poolUsable && poolError === "" && mode === "add" && (
        <AddForm sym={sym} quText={quText} setQuText={setQuText} maxQu={maxQu} connected={connected} walletKnown={!!view} plan={addPlan} preview={!view} />
      )}
      {phase === "form" && poolUsable && mode === "remove" && (
        <RemoveForm sym={sym} liquidity={liquidity} known={!!view} connected={connected} removePct={removePct} setRemovePct={setRemovePct} unitsText={unitsText} setUnitsText={setUnitsText} plan={removePlan} />
      )}

      {phase === "form" && (
        <>
          <Checklist mode={mode} sym={sym} connected={connected} view={view} walletError={walletError} pool={pool} plan={plan} validInput={mode === "add" ? validQu : !!removeAmount} />
          <div className="liq-slip">
            <span>Price protection</span>
            <span className="chips" role="group" aria-label="How far the price may move before QSwap refuses">
              {SLIPPAGES.map((s) => (
                <button key={s} className={slippagePct === s ? "chip on" : "chip"} aria-pressed={slippagePct === s} onClick={() => setSlippagePct(s)}>{s}%</button>
              ))}
            </span>
            <small>If the pool's price moves more than this before your transaction lands, QSwap refuses it and refunds everything, its 100,000 QU fee included.</small>
          </div>
          <p className="note liq-trust">
            <Icon name="shield" size={13} /> Nothing is sent until you sign in your wallet. QMax reads the pool again right before you sign and stops if it has moved past your limit.
          </p>
          <UsageNote />
        </>
      )}

      {phase === "checking" && (
        <div className="quote loading" role="status" aria-label="Reading the pool and your wallet">
          <span className="skeleton line" style={{ width: "45%" }} />
          <span className="skeleton line big" style={{ width: "60%" }} />
          <span className="skeleton line" style={{ width: "90%" }} />
        </div>
      )}

      {review && phase !== "form" && phase !== "checking" && (
        <>
          {review.add && <AddSummary plan={review.add} sym={sym} compact />}
          {review.remove && <RemoveSummary plan={review.remove} sym={sym} compact />}
          {review.notes.map((w) => (
            <p key={w} className="warn inline"><Icon name="alert" size={15} /> {w}</p>
          ))}
          <section className="liq-run" aria-label="Transactions">
            <h3>{(review.add ?? review.remove)!.steps.length === 1 ? "One transaction" : `${(review.add ?? review.remove)!.steps.length} transactions, one after the other`}</h3>
            <Timeline steps={(review.add ?? review.remove)!.steps} states={states} />
            <p className="note first">
              Up to {qu((review.add ?? review.remove)!.maxOutlayQu)} leaves your wallet with {(review.add ?? review.remove)!.steps.length === 1 ? "it" : "them"}
              {review.add ? `; about ${qu(review.add.expectedRefundQu)} of that comes straight back.` : "; the 100,000 QU fee is kept only if the removal goes through."}
            </p>
          </section>
        </>
      )}

      {phase === "verifying" && <p className="status-line"><Spinner size={14} /> Reading your wallet and your position back from the network…</p>}
      {phase === "stopped" && (
        <div className="result liq-stopped" role="status">
          <p className="warn inline"><Icon name="alert" size={16} /> <strong>Stopped.</strong></p>
          <p>{stopReason}</p>
        </div>
      )}
      {outcome && review && <Result mode={mode} sym={sym} outcome={outcome} add={review.add} remove={review.remove} />}
    </Modal>
  );
}

/* ---------- pieces ---------- */

function PoolStrip({ asset, pool, price, error, age, position, onRetry }: {
  asset: AssetItem;
  pool: PoolState | null;
  price: number | null;
  error: string;
  age: number | null;
  /** undefined: not connected. null: still reading. */
  position?: { liquidity: number; value: ReturnType<typeof positionValue> | null } | null;
  onRetry: () => void;
}) {
  if (error)
    return (
      <div className="banner err" role="alert">
        <Icon name="alert" size={18} />
        <span>Could not read the {asset.symbol} pool: {error}</span>
        <button className="ghost" onClick={onRetry}>Try again</button>
      </div>
    );
  if (!pool)
    return (
      <div className="liq-pool" role="status" aria-label="Reading the pool">
        <span className="skeleton circle" />
        <span className="liq-pool-text"><span className="skeleton line" style={{ width: 140 }} /><span className="skeleton line" style={{ width: 220 }} /></span>
      </div>
    );
  if (!pool.exists || pool.totalLiquidity <= 0)
    return (
      <p className="warn inline"><Icon name="alert" size={15} /> {!pool.exists ? `${asset.symbol} has no QSwap pool.` : `The ${asset.symbol} pool has no liquidity yet.`} Creating a pool or making its first deposit is not something QMax does.</p>
    );
  return (
    <div className="liq-pool">
      <Avatar symbol={asset.symbol} category={asset.category} issuer={asset.issuer} size={38} />
      <span className="liq-pool-text">
        <b className="num">1 {asset.symbol} = {priceText(price)}</b>
        <small className="num">
          The pool holds {qu(pool.reserveQu)} and {n(pool.reserveAsset)} {asset.symbol} · {n(pool.totalLiquidity)} liquidity units{age !== null ? ` · read ${age < 5 ? "just now" : `${age}s ago`}` : ""}
        </small>
      </span>
      {position !== undefined && (
        <span className="liq-pool-mine num">
          {position === null ? (
            <span className="skeleton line" style={{ width: 90 }} />
          ) : position.liquidity > 0 && position.value ? (
            <>
              <small>Your share</small>
              <b>{pct(position.value.sharePct)}</b>
            </>
          ) : (
            <small>No position yet</small>
          )}
        </span>
      )}
    </div>
  );
}

function AddForm({ sym, quText, setQuText, maxQu, connected, walletKnown, plan, preview }: { sym: string; quText: string; setQuText: (s: string) => void; maxQu: number | null; connected: boolean; walletKnown: boolean; plan: AddPlan | null; preview: boolean }) {
  return (
    <>
      <label className="amount">
        <span className="amount-top">
          <span>QU you put in</span>
          {connected && <small>{!walletKnown ? "Reading your wallet…" : maxQu === null ? "Not enough in the wallet for a deposit" : `All ${qu(maxQu)} can go in`}</small>}
        </span>
        <span className="inputwrap">
          <input
            autoFocus
            value={quText}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
              setQuText(digits === "" ? "" : Number(digits).toLocaleString("en-US"));
            }}
            inputMode="numeric"
            placeholder="0"
            aria-label="QU to put into the pool"
          />
          <span className="unit">QU</span>
          {connected && (
            <button type="button" className="allbtn" disabled={maxQu === null} onClick={() => maxQu !== null && setQuText(n(maxQu))} title="All this wallet can put in, leaving the 100,000 QU fee and any share move">All</button>
          )}
        </span>
      </label>
      {plan && (plan.ok ? <AddSummary plan={plan} sym={sym} preview={preview} /> : <p className="err inline"><Icon name="alert" size={15} /> {plan.refusal!.message}</p>)}
    </>
  );
}

function AddSummary({ plan, sym, compact, preview }: { plan: AddPlan; sym: string; compact?: boolean; preview?: boolean }) {
  const pctRoom = (plan.slippageBps / 100).toFixed(2);
  return (
    <div className="quote liq-summary" aria-live="polite">
      <div className="liq-headline">
        <span className="quote-label">You put in</span>
        <strong className="quote-total num">{n(plan.assetAmount)} <small>{sym}</small> + {n(plan.expectedQu)} <small>QU</small></strong>
        <span className="liq-sub num">and get {n(plan.expectedLiquidity)} liquidity units, {pct(plan.shareAfterPct)} of the pool{plan.shareAfterPct > 50 ? " (most of it)" : ""}</span>
      </div>
      <dl className="liq-facts">
        <div>
          <dt>QU it can take</dt>
          <dd className="num">{n(plan.minQu)} to {n(plan.maxQu)} QU</dd>
          <small>about {n(plan.expectedQu)} at today's price; the rest comes back</small>
        </div>
        <div>
          <dt>{sym} it takes</dt>
          <dd className="num">exactly {n(plan.assetAmount)}</dd>
          <small>{preview ? "QSwap must manage them; QMax moves them from QX first if needed" : plan.moveQty ? `${n(plan.moveQty)} moved from QX to QSwap first` : "already managed by QSwap"}</small>
        </div>
        <div>
          <dt>Flat fee now</dt>
          <dd className="num">{qu(plan.addFeeQu)}</dd>
          <small>and {qu(plan.removeFeeQu)} again when you remove</small>
        </div>
      </dl>
      <p className="note first liq-protect">
        <Icon name="shield" size={13} /> Protected by your {pctRoom}% limit: if {sym}'s pool price moves past it either way before this lands, QSwap refuses and sends back everything, the 100,000 QU fee included.
        {plan.moveQty > 0 && ` The share move attaches ${qu(plan.moveAttachQu)}, which QX sends straight back.`}
      </p>
      {!compact && (
        <p className="note first">
          Up to {qu(plan.maxOutlayQu)} leaves the wallet for a moment; about {qu(plan.expectedRefundQu)} comes back in the same transactions. {preview ? "Connect a wallet to check what it holds." : ""}
          {" "}Your share earns its part of the {FEE_MODEL.lpFeePctOfVolume}% of every swap that stays in the pool; those fees come back when you remove. Price moves cause impermanent loss.
        </p>
      )}
      {plan.warnings.map((w) => (
        <p key={w} className="warn inline"><Icon name="alert" size={15} /> {w}</p>
      ))}
    </div>
  );
}

function RemoveForm({ sym, liquidity, known, connected, removePct, setRemovePct, unitsText, setUnitsText, plan }: {
  sym: string;
  liquidity: number;
  known: boolean;
  connected: boolean;
  removePct: number | null;
  setRemovePct: (p: number | null) => void;
  unitsText: string;
  setUnitsText: (s: string) => void;
  plan: RemovePlan | null;
}) {
  if (!connected) return <p className="note">Connect your wallet to see your liquidity in this pool.</p>;
  if (!known)
    return (
      <div className="quote loading" role="status" aria-label="Reading your position">
        <span className="skeleton line" style={{ width: "50%" }} />
        <span className="skeleton line big" style={{ width: "70%" }} />
      </div>
    );
  if (liquidity === 0)
    return (
      <div className="empty liq-empty">
        <span className="empty-icon"><Icon name="layers" size={22} /></span>
        <p>You have no liquidity in the {sym} pool.</p>
      </div>
    );
  return (
    <>
      <div className="liq-amount">
        <span className="amount-top"><span>How much of your {n(liquidity)} units</span></span>
        <span className="chips" role="group" aria-label="Share of your position">
          {PERCENTS.map((p) => (
            <button key={p} className={removePct === p ? "chip on" : "chip"} aria-pressed={removePct === p} onClick={() => (setRemovePct(p), setUnitsText(""))}>{p === 100 ? "All" : `${p}%`}</button>
          ))}
        </span>
        <label className="field">
          Or an exact number of units
          <input
            value={unitsText}
            inputMode="numeric"
            placeholder={n(liquidity)}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
              setUnitsText(digits === "" ? "" : Number(digits).toLocaleString("en-US"));
              setRemovePct(null);
            }}
            aria-label="Liquidity units to remove"
          />
        </label>
      </div>
      {plan && (plan.ok ? <RemoveSummary plan={plan} sym={sym} /> : <p className="err inline"><Icon name="alert" size={15} /> {plan.refusal!.message}</p>)}
    </>
  );
}

function RemoveSummary({ plan, sym, compact }: { plan: RemovePlan; sym: string; compact?: boolean }) {
  return (
    <div className="quote liq-summary" aria-live="polite">
      <div className="liq-headline">
        <span className="quote-label">You get back about</span>
        <strong className="quote-total num">{n(plan.expectedQu)} <small>QU</small> + {n(plan.expectedAsset)} <small>{sym}</small></strong>
        <span className="liq-sub num">for {n(plan.burnLiquidity)} liquidity units{plan.all ? ", all of your position" : `; ${pct(plan.shareAfterPct)} of the pool stays yours`}</span>
      </div>
      <dl className="liq-facts">
        <div>
          <dt>At least</dt>
          <dd className="num">{n(plan.minQu)} QU + {n(plan.minAsset)} {sym}</dd>
          <small>less and QSwap refuses, refunding the fee</small>
        </div>
        <div>
          <dt>Flat fee</dt>
          <dd className="num">{qu(plan.feeQu)}</dd>
          <small>paid from the wallet first</small>
        </div>
        <div>
          <dt>Your QU changes by</dt>
          <dd className="num">{signed(plan.netQu, "QU")}</dd>
          <small>QU paid out less the fee</small>
        </div>
      </dl>
      {!compact && (
        <p className="note first">
          Fees your share earned are already inside these amounts: QSwap pays nothing separately. The {sym} comes back managed by QSwap.
        </p>
      )}
      {plan.warnings.filter((w) => compact || !/managed by QSwap/.test(w)).map((w) => (
        <p key={w} className="warn inline"><Icon name="alert" size={15} /> {w}</p>
      ))}
    </div>
  );
}

type CheckState = "ok" | "warn" | "fail" | "pending";

function Checklist({ mode, sym, connected, view, walletError, pool, plan, validInput }: {
  mode: Mode;
  sym: string;
  connected: boolean;
  view: WalletView | null;
  walletError: string;
  pool: PoolState | null;
  plan: AddPlan | RemovePlan | null;
  validInput: boolean;
}) {
  const items: { id: string; label: string; state: CheckState; detail?: string }[] = [];
  items.push(connected ? { id: "wallet", label: "Wallet connected", state: "ok" } : { id: "wallet", label: "Connect your wallet", state: "fail" });
  items.push(!pool ? { id: "pool", label: "Reading the pool", state: "pending" } : pool.exists && pool.totalLiquidity > 0 ? { id: "pool", label: "Pool has liquidity", state: "ok" } : { id: "pool", label: "No pool to use", state: "fail" });
  if (connected) {
    if (walletError) items.push({ id: "read", label: "Could not read the wallet", state: "fail", detail: walletError });
    else if (!view) items.push({ id: "read", label: "Reading your wallet", state: "pending" });
    else if (mode === "add") {
      const add = plan as AddPlan | null;
      const need = add?.ok ? add.maxOutlayQu : null;
      items.push(
        need === null
          ? { id: "qu", label: `QU in the wallet: ${qu(view.snap.balanceQu)}`, state: validInput ? "pending" : "ok" }
          : view.snap.balanceQu >= need
            ? { id: "qu", label: "Enough QU", state: "ok", detail: `${qu(view.snap.balanceQu)} in the wallet; up to ${qu(need)} is attached, about ${qu(add!.expectedRefundQu)} comes back.` }
            : { id: "qu", label: "Not enough QU", state: "fail", detail: `Needs up to ${qu(need)}; the wallet has ${qu(view.snap.balanceQu)}.` },
      );
      const underQswap = view.free[QSWAP_INDEX] ?? 0;
      const underQx = view.free[QX_INDEX] ?? 0;
      const reserved = view.open.filter((o) => o.side === "ask").reduce((s, o) => s + o.qty, 0);
      const where = `${n(underQswap)} under QSwap, ${n(underQx)} under QX${reserved ? ` (${n(reserved)} more in your open QX sell orders, which cannot move)` : ""}`;
      if (!add?.ok) items.push({ id: "tokens", label: `Your ${sym}`, state: underQswap + underQx > 0 ? "ok" : "warn", detail: where });
      else if (add.moveQty > 0) items.push({ id: "tokens", label: `${n(add.moveQty)} ${sym} move to QSwap first`, state: "warn", detail: `QSwap only takes tokens it manages. One extra signature; QX sends its ${qu(add.moveAttachQu)} straight back. You hold ${where}.` });
      else items.push({ id: "tokens", label: `${n(add.assetAmount)} ${sym} ready under QSwap`, state: "ok", detail: where });
    } else {
      items.push(view.snap.balanceQu >= LIQUIDITY_FEE_QU ? { id: "qu", label: "QU for the 100,000 QU fee", state: "ok" } : { id: "qu", label: "Not enough QU for the 100,000 QU fee", state: "fail", detail: `The wallet has ${qu(view.snap.balanceQu)}.` });
      items.push(view.position.liquidity > 0 ? { id: "lp", label: `${n(view.position.liquidity)} liquidity units in this pool`, state: "ok" } : { id: "lp", label: "No liquidity in this pool", state: "fail" });
    }
  }
  // A refusal's reason is already shown above the checklist; here it is only marked.
  if (validInput && plan) items.push(plan.ok ? { id: "plan", label: "QSwap will accept it at today's price", state: "ok" } : { id: "plan", label: "Cannot be done as it is (see above)", state: "fail" });
  return (
    <ul className="ready" aria-label="Readiness">
      {items.map((c) => (
        <li key={c.id} className={c.state}>
          <span className="mark" aria-hidden="true">
            {c.state === "ok" ? <Icon name="check" size={13} /> : c.state === "warn" ? <Icon name="alert" size={13} /> : c.state === "fail" ? <Icon name="close" size={13} /> : <i />}
          </span>
          <span>{c.label}{c.detail && <small>{c.detail}</small>}</span>
        </li>
      ))}
    </ul>
  );
}

function Timeline({ steps, states }: { steps: LiquidityStep[]; states: Record<string, StepState> }) {
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
                sends {qu(s.amountQu)} · {st.status}
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

/** What the wallet really shows afterwards, against what was planned. */
function Result({ mode, sym, outcome: o, add, remove }: { mode: Mode; sym: string; outcome: Outcome; add?: AddPlan; remove?: RemovePlan }) {
  const fee = LIQUIDITY_FEE_QU;
  // When no liquidity changed, say what really happened: never sent, not confirmed, or refused and refunded.
  const none = noChangeNotes({ mode, symbol: sym, liquidityTx: o.liquidityTx, moveTx: o.moveTx, dLiquidity: o.dLiquidity, dQu: o.dQu, underQswapBefore: o.underQswapBefore, underQswapAfter: o.underQswapAfter });
  if (mode === "add" && add) {
    const went = o.dLiquidity > 0;
    const quIn = -o.dQu - fee;
    return (
      <div className={went ? "result good" : "result"} role="status">
        <p className={went ? "ok inline" : "warn inline"}>
          <Icon name={went ? "check" : "alert"} size={16} />
          <strong>{went ? `Added: ${n(o.dLiquidity)} liquidity units, ${pct(o.share)} of the pool.` : "Nothing was added to the pool."}</strong>
        </p>
        <dl className="liq-facts">
          <div><dt>Your QU</dt><dd className="num">{signed(o.dQu, "QU")}</dd><small>{went ? `${qu(Math.max(0, quIn))} into the pool + the ${qu(fee)} fee` : none.quCaption}</small></div>
          <div><dt>Your {sym}</dt><dd className="num">{signed(o.dTokens, sym)}</dd><small>planned {signed(-add.assetAmount, sym)}</small></div>
          <div><dt>Liquidity units</dt><dd className="num">{n(o.liquidity)}</dd><small>planned +{n(add.expectedLiquidity)}</small></div>
        </dl>
        {went && quIn !== add.expectedQu && quIn >= add.minQu && quIn <= add.maxQu && <p className="note first">The pool's price moved a little before it landed (inside your limit), so {qu(quIn)} went in instead of {qu(add.expectedQu)}.</p>}
        {!went && none.notes.map((t) => <p key={t} className="note first">{t}</p>)}
        <p className="note first">Read back from your wallet and the QSwap contract after the transactions.</p>
      </div>
    );
  }
  if (mode === "remove" && remove) {
    const went = o.dLiquidity < 0;
    return (
      <div className={went ? "result good" : "result"} role="status">
        <p className={went ? "ok inline" : "warn inline"}>
          <Icon name={went ? "check" : "alert"} size={16} />
          <strong>{went ? `Removed ${n(-o.dLiquidity)} liquidity units.` : "Nothing was removed."}</strong>
        </p>
        <dl className="liq-facts">
          <div><dt>Your QU</dt><dd className="num">{signed(o.dQu, "QU")}</dd><small>{went ? `${qu(o.dQu + fee)} paid out, less the ${qu(fee)} fee` : none.quCaption}</small></div>
          <div><dt>Your {sym}</dt><dd className="num">{signed(o.dTokens, sym)}</dd><small>planned {signed(remove.expectedAsset, sym)}</small></div>
          <div><dt>Units left</dt><dd className="num">{n(o.liquidity)}</dd><small>{o.liquidity > 0 ? `${pct(o.share)} of the pool` : "no position left"}</small></div>
        </dl>
        {went && o.dTokens > 0 && (
          <p className="note first liq-managed">
            <Icon name="info" size={13} /> The {n(o.dTokens)} {sym} {o.dTokens === 1 ? "is" : "are"} managed by QSwap ({n(o.underQswapAfter)} {sym} there now). Selling on QSwap works as it is. To sell on QX they need a share move first: QMax does that for you when you sell, or use “Keep all under one contract” in My assets.
          </p>
        )}
        {!went && none.notes.map((t) => <p key={t} className="note first">{t}</p>)}
        <p className="note first">Read back from your wallet and the QSwap contract after the transaction.</p>
      </div>
    );
  }
  return null;
}
