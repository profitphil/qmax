import { useState } from "react";
import type { IconName } from "./ui.tsx";
import { Icon } from "./ui.tsx";
import { parseWallet, shortAddress } from "./viewwallet.ts";
import { useViewing } from "./viewing.tsx";

/** A box to paste a Qubic address into, to see its portfolio without connecting a wallet. */
export function ViewWalletForm({ onDone, compact, label }: { onDone?: () => void; compact?: boolean; label?: string }) {
  const { view } = useViewing();
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const submit = (pasted: string) => {
    const problem = view(pasted);
    setError(problem ?? "");
    if (!problem) {
      setText("");
      onDone?.();
    }
  };

  return (
    <form
      className={compact ? "view-form compact" : "view-form"}
      onSubmit={(e) => {
        e.preventDefault();
        submit(text);
      }}
    >
      <label className="view-label" htmlFor="view-wallet-input">
        {label ?? (compact ? "Look at another wallet" : "Or look at any wallet without connecting one")}
      </label>
      <div className="view-row">
        <input
          id="view-wallet-input"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError("");
          }}
          onPaste={(e) => {
            // a whole address pasted is looked at at once, with no second tap
            const pasted = e.clipboardData.getData("text");
            if (parseWallet(pasted).ok) {
              e.preventDefault();
              submit(pasted);
            }
          }}
          placeholder="Paste a Qubic address"
          aria-label="Qubic address to look at"
          aria-invalid={!!error}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
        />
        <button type="submit" disabled={!text.trim()}>View</button>
      </div>
      {error && <p className="view-error" role="alert">{error}</p>}
      {!compact && <small className="muted view-note">Everything shown is public on the Qubic network. Nothing is signed, and no wallet is connected.</small>}
    </form>
  );
}

/** The empty state of a screen that needs a wallet: connect one, or paste an address to look at. */
export function ConnectOrView({ icon, text, onConnect }: { icon: IconName; text: string; onConnect?: () => void }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={22} /></span>
      <p>{text}</p>
      {onConnect && <button className="primary" onClick={onConnect}>Connect wallet</button>}
      <ViewWalletForm />
    </div>
  );
}

/** Says whose portfolio this is when it is not the connected wallet's, that it cannot be signed for, and how to change or stop. */
export function ViewingBanner() {
  const { viewing, stop } = useViewing();
  const [changing, setChanging] = useState(false);
  if (!viewing) return null;
  return (
    <div className="viewing" role="status">
      <div className="viewing-line">
        <Icon name="wallet" size={15} />
        <span>
          Looking at <a href={`https://explorer.qubic.org/network/address/${viewing}`} target="_blank" rel="noreferrer" title={`${viewing}\nOpen in the explorer`}><code>{shortAddress(viewing)}</code></a>
          <small className="muted"> · read-only, nothing here can be signed</small>
        </span>
        <button type="button" className="link" onClick={() => setChanging((c) => !c)}>{changing ? "Cancel" : "Change"}</button>
        <button type="button" className="link" onClick={stop}>Stop viewing</button>
      </div>
      {changing && <ViewWalletForm compact onDone={() => setChanging(false)} />}
    </div>
  );
}
