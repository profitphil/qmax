import { useEffect, useMemo, useState } from "react";
import { buildConsolidation } from "../src/consolidate.ts";
import type { ManageTarget, OwnedAsset } from "../src/consolidate.ts";
import { fetchFees, fetchOwnedByContract } from "./exec/chain.ts";
import { MoveShares, targetName } from "./MoveShares.tsx";
import { useSettings } from "./settings.tsx";
import { Icon, Modal, Spinner } from "./ui.tsx";

/** Put every share in the wallet under one contract. QX is the default. */
export function ConsolidateModal({ walletId, onClose }: { walletId: string; onClose: () => void }) {
  const { settings } = useSettings();
  const [target, setTarget] = useState<ManageTarget>(settings.consolidateTo);
  const [owned, setOwned] = useState<OwnedAsset[] | null>(null);
  const [fees, setFees] = useState<{ qx: number; qswap: number } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([fetchOwnedByContract(walletId), fetchFees()])
      .then(([o, f]) => {
        setOwned(o);
        setFees(f);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [walletId]);

  const plan = useMemo(() => (owned && fees ? buildConsolidation(owned, target, fees) : null), [owned, fees, target]);

  return (
    <Modal size="lg" title="Keep all my shares under one contract" onClose={onClose} footer={<button className="ghost wide" onClick={onClose}>Close</button>}>
      <p className="note first">
        Shares you buy on QSwap are managed by QSwap and shares you buy on QX by QX, and a market can only trade shares it manages. Moving them all under
        one contract keeps your wallet tidy. Each move costs a small fee, and QMax moves shares back by itself when a sale needs the other market.
      </p>
      <div className="field">
        Keep them under
        <span className="chips">
          {(["qx", "qswap"] as const).map((t) => (
            <button key={t} className={target === t ? "chip on" : "chip"} onClick={() => setTarget(t)}>{targetName(t)}{t === "qx" ? " (default)" : ""}</button>
          ))}
        </span>
      </div>
      {error && <p className="err inline"><Icon name="alert" size={15} /> {error}</p>}
      {!plan && !error && <p className="status-line"><Spinner size={14} /> Reading your wallet…</p>}
      {plan && plan.steps.length === 0 && (
        <>
          <p className="ok inline"><Icon name="check" size={15} /> Nothing to move: everything that can be moved is already under {targetName(target)}.</p>
          {plan.stuck.length > 0 && (
            <p className="note">Not movable from here: {plan.stuck.map((s) => `${s.qty.toLocaleString("en-US")} ${s.symbol} (contract ${s.contractIndex})`).join(", ")}.</p>
          )}
        </>
      )}
      {plan && (plan.steps.length > 0 || plan.stuck.length > 0) && plan.steps.length > 0 && <MoveShares key={target} plan={plan} targetName={targetName(target)} />}
    </Modal>
  );
}
