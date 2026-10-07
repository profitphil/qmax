import { useMemo, useState } from "react";
import { COVER_MAX, COVER_UPDATE_QU } from "../src/procover.ts";
import { proConfig } from "../src/pro.ts";
import type { ProAccess } from "../src/pro.ts";
import { buyPro } from "./exec/pro.ts";
import type { StepState } from "./exec/run.ts";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { CoverEditor } from "./CoverEditor.tsx";
import { checkCover, prefillCover } from "./cover.ts";
import { Icon, Modal, Spinner } from "./ui.tsx";

const n = (x: number) => x.toLocaleString("en-US");

interface Props {
  access: ProAccess;
  onClose: () => void;
  onUnlocked: () => void;
}

/** QMax Pro: one payment unlocks Max for a while. Shown only where the site asks for a pass (built with `VITE_PRO_MODE=paid` and a price). */
export function ProModal({ access, onClose, onUnlocked }: Props) {
  const config = proConfig();
  const { wallet, getSignedTx } = useQubicConnect();
  const [state, setState] = useState<StepState>({ status: "pending" });
  const [done, setDone] = useState(false);
  const [listLate, setListLate] = useState(false);
  const prefill = useMemo(() => (wallet ? prefillCover(wallet.publicKey, wallet.accounts) : { text: "", skipped: 0 }), [wallet?.publicKey]);
  const [others, setOthers] = useState(prefill.text);
  const check = wallet ? checkCover(wallet.publicKey, others) : { ok: true as const, list: [] as string[] };
  const running = state.status === "signing" || state.status === "confirming";

  const pay = async () => {
    if (!wallet) return;
    if (!check.ok) return;
    const r = await buyPro(wallet.publicKey, (tx) => getSignedTx(tx), setState, check.list);
    if (r.ok) {
      setDone(true);
      setListLate(!r.listSent);
      onUnlocked();
    }
  };

  return (
    <Modal
      size="sm"
      title="QMax Pro"
      subtitle="Max is part of QMax Pro."
      onClose={running ? undefined : onClose}
      footer={
        <>
          {!done && (
            <button className="primary wide" disabled={running || !wallet || !check.ok} onClick={pay}>
              {running ? <><Spinner size={15} /> Working…</> : check.ok && check.list.length > 1 ? `Pay ${n(config.priceQu)} QU and unlock ${check.list.length} addresses` : `Pay ${n(config.priceQu)} QU and unlock`}
            </button>
          )}
          <button className="ghost wide" disabled={running} onClick={onClose}>{done ? "Done" : "Not now"}</button>
        </>
      }
    >
      <div className="price-card">
        <span className="price-amount num">{n(config.priceQu)} <small>QU</small></span>
        <span className="price-for">for {config.days} days of Pro</span>
        <ul className="price-points">
          <li><Icon name="check" size={14} /> Max: QMax searches for the best position for a trade (best way to execute, best size, arbitrage, best exit)</li>
          <li><Icon name="check" size={14} /> Max swaps: Asset ⇄ Asset, routed and compared for the best price (QSwap, Qubic ⇄ Token, stays free)</li>
          <li><Icon name="check" size={14} /> Quotes, charts and ordinary trades stay free</li>
          <li><Icon name="check" size={14} /> One pass covers this address and up to {COVER_MAX - 1} more of yours, for the same price</li>
        </ul>
      </div>
      {wallet && !done && <CoverEditor payer={wallet.publicKey} value={others} onChange={setOthers} disabled={running} skipped={prefill.skipped} />}
      {state.status === "failed" && <p className="err inline"><Icon name="alert" size={15} /> {state.error}</p>}
      {done && <p className="ok inline"><Icon name="check" size={15} /> Pro is unlocked. Press Max again.</p>}
      {done && listLate && <p className="note first">The payment is recorded. QMax could not be given your list of addresses just yet; it will send it again the next time QMax is opened in this browser.</p>}
      <p className="note">The payment goes through QPayhub, which records an on-chain receipt as proof. Your wallet will ask you to sign it once. List public addresses only, never a seed: QMax is told which addresses you listed together, and nothing else about them. Changing the list later costs {n(COVER_UPDATE_QU)} QU and adds no time.</p>
    </Modal>
  );
}
