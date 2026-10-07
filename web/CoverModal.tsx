import { useState } from "react";
import { COVER_UPDATE_QU } from "../src/procover.ts";
import { changeCover } from "./exec/pro.ts";
import type { StepState } from "./exec/run.ts";
import { CoverEditor } from "./CoverEditor.tsx";
import { checkCover } from "./cover.ts";
import type { ProServerStatus } from "./pro-api.ts";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";
import { Icon, Modal, Spinner } from "./ui.tsx";

const n = (x: number) => x.toLocaleString("en-US");

interface Props {
  cover: ProServerStatus;
  onClose: () => void;
  onChanged: () => void;
}

/** The paying address changes which addresses its Max pass covers: a small payment that carries the new list. It adds no time to the pass. */
export function CoverModal({ cover, onClose, onChanged }: Props) {
  const { wallet, getSignedTx } = useQubicConnect();
  const payer = cover.wallet;
  const current = (cover.covered ?? [payer]).filter((a) => a !== payer);
  const [text, setText] = useState(current.join("\n"));
  const [state, setState] = useState<StepState>({ status: "pending" });
  const [done, setDone] = useState<null | { listSent: boolean }>(null);
  const running = state.status === "signing" || state.status === "confirming";
  const check = checkCover(payer, text);
  const same = check.ok && check.list.join() === (cover.covered ?? [payer]).join();
  const mine = !!wallet && wallet.publicKey === payer;

  const pay = async () => {
    if (!check.ok || !wallet) return;
    const r = await changeCover(payer, (tx) => getSignedTx(tx), setState, check.list);
    if (r.ok) {
      setDone({ listSent: r.listSent });
      onChanged();
    }
  };

  return (
    <Modal
      size="sm"
      title="Addresses your pass covers"
      subtitle={cover.until ? `Your Max pass runs until ${new Date(cover.until).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.` : undefined}
      onClose={running ? undefined : onClose}
      footer={
        <>
          {!done && (
            <button className="primary wide" disabled={running || !mine || !check.ok || same} onClick={pay}>
              {running ? <><Spinner size={15} /> Working…</> : `Pay ${n(COVER_UPDATE_QU)} QU and change the list`}
            </button>
          )}
          <button className="ghost wide" disabled={running} onClick={onClose}>{done ? "Done" : "Cancel"}</button>
        </>
      }
    >
      <CoverEditor payer={payer} value={text} onChange={setText} disabled={running || !!done} />
      {cover.listPending && !done && <p className="note first">Your last change is paid for but QMax has not been given the list yet, so only this address is covered until it is. Opening QMax with this wallet sends it again.</p>}
      {state.status === "failed" && <p className="err inline"><Icon name="alert" size={15} /> {state.error}</p>}
      {done && <p className="ok inline"><Icon name="check" size={15} /> Paid. {done.listSent ? "The new list is in force." : "QMax could not be given the list just yet; it will send it again the next time QMax is opened in this browser, and until then the old list stays in force."}</p>}
      {!mine && <p className="note first">Connect the wallet that paid for the pass ({payer.slice(0, 5)}…{payer.slice(-5)}) to change its list.</p>}
      <p className="note">Changing the list is one small payment through QPayhub ({n(COVER_UPDATE_QU)} QU) and adds no time to the pass. Public addresses only, never a seed.</p>
    </Modal>
  );
}
