import { useEffect, useState } from "react";
import type { Consolidation } from "../src/consolidate.ts";
import { runSteps } from "./exec/run.ts";
import { useCloseSignal } from "./exec/abort.ts";
import type { StepState } from "./exec/run.ts";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Icon, Spinner, StepMark } from "./ui.tsx";

const n = (x: number) => x.toLocaleString("en-US");
const EXPLORER = "https://explorer.qubic.org/network/tx/";
const NAMES = { qx: "QX", qswap: "QSwap" };

/**
 * The share moves in a consolidation, what they cost, and a button that signs them one after another
 * (stopping at the first failure). Used for "move everything" and for the follow-up after a trade.
 */
export function MoveShares({ plan, targetName, auto, onDone }: { plan: Consolidation; targetName: string; /** Start signing at once: the person already chose this when they built the order. */ auto?: boolean; onDone?: () => void }) {
  const { wallet, getSignedTx } = useQubicConnect();
  const closeSignal = useCloseSignal();
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<boolean | null>(null);

  const go = async () => {
    if (!wallet) return;
    setRunning(true);
    const ok = await runSteps(wallet.publicKey, plan.steps, (tx) => getSignedTx(tx), (id, s) => setStates((cur) => ({ ...cur, [id]: s })), undefined, undefined, closeSignal());
    setFinished(ok);
    setRunning(false);
    if (ok) onDone?.();
  };

  useEffect(() => {
    if (auto && wallet) void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <ol className="timeline">
        {plan.steps.map((s) => {
          const st = states[s.id] ?? { status: "pending" };
          return (
            <li key={s.id} className={st.status}>
              <StepMark status={st.status} />
              <div>
                <div className="step-title">{s.description}</div>
                <small className="step-meta">
                  fee {n(s.amountQu)} QU · {st.status}
                  {"txId" in st && <> · <a href={EXPLORER + st.txId} target="_blank" rel="noreferrer">{st.txId.slice(0, 10)}… <Icon name="external" size={11} /></a></>}
                  {st.status === "failed" && <span className="err"> {st.error}</span>}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
      {plan.stuck.length > 0 && (
        <p className="note">
          Not moved: {plan.stuck.map((s) => `${n(s.qty)} ${s.symbol} (managed by contract ${s.contractIndex})`).join(", ")}. Only QX and QSwap can hand shares over from here.
        </p>
      )}
      {finished === true && <p className="ok inline"><Icon name="check" size={15} /> Done. Your shares are under {targetName} management.</p>}
      {finished === false && <p className="err inline"><Icon name="alert" size={15} /> Stopped. The moves after the failed one were not sent. You can run this again for what is left.</p>}
      {finished === null && plan.steps.length > 0 && (
        <button className="primary wide" disabled={running} onClick={go}>
          {running ? <><Spinner size={15} /> Waiting for wallet and network…</> : `Move ${plan.steps.length === 1 ? "them" : `${plan.steps.length} assets`} to ${targetName} (${n(plan.feeQu)} QU in fees)`}
        </button>
      )}
    </>
  );
}

export const targetName = (t: "qx" | "qswap") => NAMES[t];
