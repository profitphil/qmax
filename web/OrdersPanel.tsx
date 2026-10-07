import { useEffect, useMemo, useState } from "react";
import { buildCancelStep } from "../src/exec.ts";
import { assetNameToU64, bytesToHex, identityToBytes } from "../src/identity.ts";
import type { RestingOrder } from "../src/verify.ts";
import { shownName } from "./client.ts";
import type { AssetItem } from "./client.ts";
import { formatPrice } from "./AssetList.tsx";
import { fetchRestingOrders } from "./exec/chain.ts";
import { runSteps } from "./exec/run.ts";
import type { StepState } from "./exec/run.ts";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Avatar, Icon, Modal, Spinner } from "./ui.tsx";

const n = (x: number) => x.toLocaleString("en-US");
const EXPLORER = "https://explorer.qubic.org/network/tx/";

interface Props {
  walletId: string | null;
  assets: AssetItem[];
  refreshKey: number;
  onConnect: () => void;
  /** Reports how many orders are open, for the tab badge. */
  onCount: (n: number) => void;
  onChanged: () => void;
}

/** The wallet's resting QX orders, with a one-tap cancel. */
export function OrdersPanel({ walletId, assets, refreshKey, onConnect, onCount, onChanged }: Props) {
  const [orders, setOrders] = useState<RestingOrder[] | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState<RestingOrder | null>(null);

  const load = () => {
    if (!walletId) return;
    fetchRestingOrders(walletId)
      .then((o) => {
        setOrders(o);
        setError("");
        onCount(o.length);
      })
      .catch((e) => setError(`Could not read your orders: ${e instanceof Error ? e.message : e}`));
  };

  useEffect(() => {
    setOrders(null);
    onCount(0);
    if (!walletId) return;
    load();
    const t = setInterval(load, 20_000); // pick up fills as they happen
    return () => clearInterval(t);
  }, [walletId, refreshKey]);

  const byKey = useMemo(() => {
    const m = new Map<string, AssetItem>();
    for (const a of assets) {
      if (!a.issuer) continue;
      try {
        m.set(`${assetNameToU64(a.symbol)}|${bytesToHex(identityToBytes(a.issuer))}`, a);
      } catch {
        // skip names that cannot be encoded
      }
    }
    return m;
  }, [assets]);

  if (!walletId)
    return (
      <div className="empty">
        <span className="empty-icon"><Icon name="wallet" size={22} /></span>
        <p>Connect your wallet to see your open orders.</p>
        <button className="primary" onClick={onConnect}>Connect wallet</button>
      </div>
    );
  if (error) return <div className="banner err" role="alert"><Icon name="alert" size={16} /> <span>{error}</span></div>;
  if (orders === null) return <p className="status-line"><Spinner size={14} /> Reading your orders from QX…</p>;
  if (orders.length === 0)
    return (
      <div className="empty">
        <span className="empty-icon"><Icon name="inbox" size={22} /></span>
        <p>No open orders. When a QX buy or sell is only partly matched, the rest waits here until it fills or you cancel it.</p>
      </div>
    );

  return (
    <>
      <ul className="orders">
        {orders.map((o, i) => {
          const a = byKey.get(o.key);
          const locked = o.side === "bid" ? o.price * o.qty : 0;
          const best = a ? (o.side === "bid" ? a.bestAsk : a.bestBid) : null;
          return (
            <li key={`${o.key}|${o.side}|${o.price}|${i}`} className="order">
              <span className={`side ${o.side}`}>{o.side === "bid" ? "BUY" : "SELL"}</span>
              <div className="what">
                <strong className="what-name">{a && <Avatar symbol={a.symbol} category={a.category} issuer={a.issuer} size={22} />} {a ? shownName(a) : o.assetName}</strong>
                <div className="note">
                  {n(o.qty)} at {n(o.price)} QU
                  {best ? <> · market {o.side === "bid" ? "ask" : "bid"} {formatPrice(best)}</> : null}
                </div>
              </div>
              <div className="locked">{locked > 0 ? <>{n(locked)} QU <small>locked</small></> : <small>shares listed</small>}</div>
              <button className="ghost" onClick={() => setCancelling(o)}>Cancel</button>
            </li>
          );
        })}
      </ul>
      {cancelling && (
        <CancelModal
          order={cancelling}
          walletId={walletId}
          onClose={(changed) => {
            setCancelling(null);
            if (changed) {
              onChanged();
              load();
            }
          }}
        />
      )}
    </>
  );
}

function CancelModal({ order, walletId, onClose }: { order: RestingOrder; walletId: string; onClose: (changed: boolean) => void }) {
  const { getSignedTx } = useQubicConnect();
  const step = useMemo(() => buildCancelStep(order), [order]);
  const [state, setState] = useState<StepState>({ status: "pending" });
  const [done, setDone] = useState(false);
  const running = state.status === "signing" || state.status === "confirming";

  const go = async () => {
    const ok = await runSteps(walletId, [step], (tx) => getSignedTx(tx), (_id, s) => setState(s));
    setDone(ok);
  };

  return (
    <Modal
      size="sm"
      title="Cancel order"
      onClose={running ? undefined : () => onClose(done)}
      footer={
        <>
          {!done && <button className="primary wide" disabled={running} onClick={go}>{running ? <><Spinner size={15} /> Working…</> : "Cancel this order"}</button>}
          <button className="ghost wide" disabled={running} onClick={() => onClose(done)}>{done ? "Done" : "Keep it"}</button>
        </>
      }
    >
      <p className="first">{step.description}</p>
      <p className="note">
        Cancelling is free.{" "}
        {order.side === "bid" ? `The ${n(order.price * order.qty)} QU locked in this order returns to your wallet.` : "The listed shares return to your wallet."} You sign one transaction.
      </p>
      {state.status !== "pending" && (
        <p className={state.status === "failed" ? "err inline" : done ? "ok inline" : "status-line"}>
          {state.status === "signing" && <><Spinner size={14} /> Approve the request in your wallet…</>}
          {state.status === "confirming" && <><Spinner size={14} /> Waiting for the network…</>}
          {state.status === "done" && <><Icon name="check" size={15} /> Order cancelled. <a href={EXPLORER + state.txId} target="_blank" rel="noreferrer">View transaction</a></>}
          {state.status === "failed" && <><Icon name="alert" size={15} /> {state.error}</>}
        </p>
      )}
    </Modal>
  );
}
