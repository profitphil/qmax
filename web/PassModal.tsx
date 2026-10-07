import { useState } from "react";
import { PAYWALL } from "../src/config.ts";
import { buyPass } from "./exec/pass.ts";
import type { StepState } from "./exec/run.ts";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Icon, Modal, Spinner } from "./ui.tsx";

const EXPLORER = "https://explorer.qubic.org/network/tx/";
const n = (x: number) => x.toLocaleString("en-US");

interface Props {
  onClose: () => void;
  onUnlocked: () => void;
}

/** Pay once, trade fee-free for a day. */
export function PassModal({ onClose, onUnlocked }: Props) {
  const { wallet, getSignedTx } = useQubicConnect();
  const [state, setState] = useState<StepState>({ status: "pending" });
  const [done, setDone] = useState(false);
  const running = state.status === "signing" || state.status === "confirming";

  const pay = async () => {
    if (!wallet) return;
    const ok = await buyPass(wallet.publicKey, (tx) => getSignedTx(tx), setState);
    if (ok) {
      setDone(true);
      onUnlocked();
    }
  };

  return (
    <Modal
      size="sm"
      title="Unlock trading"
      subtitle="One payment, then trade freely for the day."
      onClose={running ? undefined : onClose}
      footer={
        <>
          {!done && (
            <button className="primary wide" disabled={running || !wallet} onClick={pay}>
              {running ? <><Spinner size={15} /> Working…</> : `Pay ${n(PAYWALL.priceQu)} QU and unlock`}
            </button>
          )}
          <button className="ghost wide" disabled={running} onClick={onClose}>{done ? "Done" : "Not now"}</button>
        </>
      }
    >
      <div className="price-card">
        <span className="price-amount num">{n(PAYWALL.priceQu)} <small>QU</small></span>
        <span className="price-for">for {PAYWALL.hours} hours of trading</span>
        <ul className="price-points">
          <li><Icon name="check" size={14} /> No fee on each trade</li>
          <li><Icon name="check" size={14} /> Prices and quotes stay free</li>
          <li><Icon name="check" size={14} /> Pass belongs to this wallet</li>
        </ul>
      </div>
      <p className="note">
        The payment goes through QPayhub, which records an on-chain receipt as proof. Your wallet will ask you to sign it once. The pass is remembered in this browser.
      </p>
      {state.status === "signing" && <p className="status-line"><Spinner size={14} /> Approve the payment in your wallet…</p>}
      {state.status === "confirming" && (
        <p className="status-line"><Spinner size={14} /> Waiting for the network… <a href={EXPLORER + state.txId} target="_blank" rel="noreferrer">{state.txId.slice(0, 10)}…</a></p>
      )}
      {state.status === "failed" && <p className="err inline"><Icon name="alert" size={15} /> {state.error}</p>}
      {done && <p className="ok inline"><Icon name="check" size={15} /> Unlocked for {PAYWALL.hours} hours.</p>}
    </Modal>
  );
}
