// Plain-React port of ConnectModal from double-k-3033/QRaffle-frontend
// (MetaMask Snap, WalletConnect, private seed, vault file).
import { useContext, useEffect, useRef, useState } from "react";
import { qrWithLogo } from "../../src/qrlogo.ts";
import { MetaMaskContext } from "./MetamaskContext.tsx";
import { useQubicConnect } from "./QubicConnectContext.tsx";
import { useWalletConnect } from "./WalletConnectContext.tsx";
import { Icon, Modal } from "../ui.tsx";

type Mode = "none" | "metamask" | "walletconnect" | "private-seed" | "vault-file" | "account-select";
interface PickAccount {
  publicId: string;
  alias?: string;
}

export function ConnectModal({ onClose }: { onClose: () => void }) {
  const [mm] = useContext(MetaMaskContext);
  const { connect, mmSnapConnect, privateKeyConnect, vaultFileConnect } = useQubicConnect();
  const { connect: wcConnect, isConnected: wcConnected, requestAccounts } = useWalletConnect();

  const [mode, setMode] = useState<Mode>("none");
  const [seed, setSeed] = useState("");
  const seedRef = useRef<HTMLInputElement>(null);
  const [seedError, setSeedError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [vaultError, setVaultError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [qr, setQr] = useState("");
  const [uri, setUri] = useState("");
  const [accounts, setAccounts] = useState<PickAccount[]>([]);
  const [picked, setPicked] = useState(0);
  const [fromWc, setFromWc] = useState(false);
  // On a phone the wallet app is on the same device, so a deep link beats scanning a QR code.
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const vaultRef = useRef<{ revealSeed: (publicId: string) => Promise<string> } | null>(null);

  const [wcStatus, setWcStatus] = useState<"preparing" | "waiting" | "failed">("preparing");
  const [copied, setCopied] = useState<"" | "yes" | "failed">("");
  const attempt = useRef(0);

  /** Creates a fresh pairing link, shows it, and waits for the wallet to approve it. */
  const startWalletConnect = async () => {
    const mine = ++attempt.current;
    setMode("walletconnect");
    setWcStatus("preparing");
    setCopied("");
    setUri("");
    setQr("");
    const { uri, approve } = await wcConnect();
    if (mine !== attempt.current) return;
    if (!uri) return setWcStatus("failed");
    const approval = approve();
    setUri(uri);
    setWcStatus("waiting");
    setQr(`data:image/svg+xml;utf8,${encodeURIComponent(qrWithLogo(uri))}`); // the code with the QMax X in the middle
    const approved = await approval;
    if (mine === attempt.current && !approved) setWcStatus("failed"); // rejected in the wallet, or the link expired
  };

  const copyLink = async () => {
    const done = () => {
      setCopied("yes");
      setTimeout(() => setCopied(""), 2500);
    };
    try {
      await navigator.clipboard.writeText(uri);
      return done();
    } catch {
      // The clipboard API needs a secure page (https or localhost), so it is missing when the site is opened by its address on the local network.
      // The old way still works there.
      try {
        const box = document.createElement("textarea");
        box.value = uri;
        box.setAttribute("readonly", "");
        box.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
        document.body.appendChild(box);
        box.select();
        const ok = document.execCommand("copy");
        box.remove();
        if (ok) return done();
      } catch {
        // fall through to copying by hand
      }
    }
    // Neither worked (in-app browsers can block both): show the link so it can be copied by hand.
    setCopied("failed");
    setTimeout(() => linkRef.current?.select(), 0);
  };
  const linkRef = useRef<HTMLInputElement>(null);
  const deepLink = `qubic-wallet://pairwc/${uri}`;

  useEffect(() => {
    if (!wcConnected) return;
    requestAccounts().then((list) => {
      setAccounts(list.map((a) => ({ publicId: a.address, alias: a.name })));
      setFromWc(true);
      setMode("account-select");
    });
  }, [wcConnected]);

  const validateSeed = (v: string) => {
    setSeed(v);
    if (/[^a-z]/.test(v)) setSeedError("Seed must contain only lowercase letters");
    else if (v.length !== 55) setSeedError("Seed must be 55 characters long");
    else setSeedError("");
  };

  const unlockVault = async () => {
    if (!file) return setVaultError("Please select a .qubic-vault file.");
    if (!password) return setVaultError("Please enter your password.");
    setVaultError("");
    setUnlocking(true);
    try {
      const vault = await vaultFileConnect(file, password);
      vaultRef.current = vault;
      setAccounts(vault.getSeeds());
      setFromWc(false);
      setMode("account-select");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setVaultError(
        msg.includes("password") || msg.includes("Import Failed")
          ? "Incorrect password or invalid vault file."
          : "Failed to unlock vault. Please try again.",
      );
    } finally {
      setUnlocking(false);
    }
  };

  const mmLabel = !mm.snapsDetected && !mm.installedSnap ? "Install MetaMask" : "Connect MetaMask";

  return (
    <Modal title="Connect wallet" subtitle="Choose how you want to sign. QMax never sees your keys." size="sm" onClose={onClose}>

        {mode === "none" && (
          <>
            <button className="walletopt" onClick={() => setMode("metamask")}>
              <img src="/metamask.svg" alt="" width={28} height={28} />
              <span><b>MetaMask</b><small>Browser extension with the Qubic Snap</small></span>
            </button>
            <button className="walletopt" onClick={startWalletConnect}>
              <img src="/wallet-connect.svg" alt="" width={28} height={28} />
              <span><b>WalletConnect</b><small>Qubic Wallet app on your phone or computer</small></span>
            </button>
            <p className="divider"><span>Advanced, use with care</span></p>
            <button className="walletopt plain" onClick={() => setMode("private-seed")}>
              <span className="walletopt-icon"><Icon name="shield" size={18} /></span>
              <span><b>Private seed</b><small>Signs in this browser; the seed stays in memory only</small></span>
            </button>
            <button className="walletopt plain" onClick={() => { setVaultError(""); setMode("vault-file"); }}>
              <span className="walletopt-icon"><Icon name="inbox" size={18} /></span>
              <span><b>Vault file</b><small>Unlock a .qubic-vault file with its password</small></span>
            </button>
          </>
        )}

        {mode === "metamask" && (
          <>
            <p>Connect your MetaMask wallet. It must be installed and unlocked.</p>
            {mmLabel === "Install MetaMask" ? (
              <a href="https://metamask.io/" target="_blank" rel="noreferrer">Install MetaMask</a>
            ) : (
              <button onClick={async () => { await mmSnapConnect(); onClose(); }}>{mmLabel}</button>
            )}
            <button className="ghost" onClick={() => setMode("none")}>Back</button>
          </>
        )}

        {mode === "walletconnect" && (
          <>
            {wcStatus === "failed" ? (
              <>
                <p className="err">The connection was cancelled or the link expired.</p>
                <button onClick={startWalletConnect}>Try again</button>
              </>
            ) : (
              <>
                <ol className="how">
                  {isMobile ? (
                    <>
                      <li>Tap <b>Open in Qubic Wallet</b>.</li>
                      <li>Approve the connection in the wallet.</li>
                      <li>Come back to this page.</li>
                    </>
                  ) : (
                    <>
                      <li>Scan the code with the Qubic Wallet app, or copy the link into it.</li>
                      <li>Approve the connection in the wallet.</li>
                    </>
                  )}
                </ol>

                {/* The code comes first, above the buttons (on a phone, for a wallet on another device); the buttons are as wide as the code. */}
                <div className="wc-col">
                {qr && (
                  <>
                    {isMobile && <p className="note">Wallet on another device? Scan this code.</p>}
                    <img src={qr} alt="WalletConnect QR code" />
                  </>
                )}
                {isMobile ? (
                  <a className={uri ? "btn" : "btn disabled"} href={uri ? deepLink : undefined} role="button">Open in Qubic Wallet</a>
                ) : (
                  uri && <a className="btn" href={deepLink} role="button">Open in Qubic Wallet</a>
                )}

                <button className="ghost wide" disabled={!uri} onClick={copyLink}>{uri ? (copied === "yes" ? "Copied" : "Copy link") : "Preparing link…"}</button>
                {copied === "yes" && <p className="ok">Link copied. Paste it into the Qubic Wallet app.</p>}
                {copied === "failed" && (
                  <>
                    <p className="warn">Couldn't copy automatically. The link is selected below; copy it by hand.</p>
                    <div className="copyrow">
                      <input ref={linkRef} readOnly value={uri} onFocus={(e) => e.target.select()} aria-label="WalletConnect link" />
                    </div>
                  </>
                )}

                <p className="note status">{wcStatus === "waiting" ? "Waiting for approval in your wallet…" : "Preparing…"}</p>
                </div>
              </>
            )}
            <div className="wc-col">
              <button className="ghost" onClick={() => { attempt.current++; setMode("none"); }}>Back</button>
            </div>
          </>
        )}

        {mode === "private-seed" && (
          <>
            <p>Your 55 character private seed:</p>
            {/* Uncontrolled on purpose: a controlled input copies what is typed into the element's `value` attribute, where any style rule
                (input[value*="a"] { background: url(...) }) could read it. An uncontrolled one keeps it in the field only. */}
            <input ref={seedRef} type="password" autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => validateSeed(e.target.value)} />
            {seedError && <p className="err">{seedError}</p>}
            <button
              disabled={seed.length !== 55 || !!seedError}
              onClick={async () => { const typed = seedRef.current?.value ?? seed; if (seedRef.current) seedRef.current.value = ""; setSeed(""); await privateKeyConnect(typed); onClose(); }}
            >
              Unlock
            </button>
            <button className="ghost" onClick={() => { if (seedRef.current) seedRef.current.value = ""; setSeed(""); setMode("none"); }}>Back</button>
          </>
        )}

        {mode === "vault-file" && (
          <>
            <p>Load your Qubic vault file:</p>
            <input
              ref={fileRef}
              type="file"
              accept=".qubic-vault"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f && !f.name.toLowerCase().endsWith(".qubic-vault")) {
                  setVaultError("Please select a .qubic-vault file.");
                  e.target.value = "";
                  return setFile(null);
                }
                setVaultError("");
                setFile(f);
              }}
            />
            <input type="password" placeholder="Password" onChange={(e) => setPassword(e.target.value)} />
            {vaultError && <p className="err">{vaultError}</p>}
            <button disabled={unlocking} onClick={unlockVault}>{unlocking ? "Unlocking…" : "Unlock"}</button>
            <button className="ghost" onClick={() => setMode("none")}>Back</button>
          </>
        )}

        {mode === "account-select" && (
          <>
            <p>Select an account:</p>
            <select value={picked} onChange={(e) => setPicked(Number(e.target.value))}>
              {accounts.map((a, i) => (
                <option key={a.publicId} value={i}>{a.alias || `Account ${i + 1}`}</option>
              ))}
            </select>
            <button
              onClick={async () => {
                const a = accounts[picked];
                const all = accounts.map((x) => x.publicId);
                if (fromWc) {
                  connect({ connectType: "walletconnect", publicKey: a.publicId, alias: a.alias, accounts: all });
                } else {
                  // Vault accounts sign locally, so the seed is needed in memory (never persisted).
                  const privateKey = await vaultRef.current!.revealSeed(a.publicId);
                  connect({ connectType: "vaultFile", publicKey: a.publicId, alias: a.alias, privateKey, accounts: all });
                  vaultRef.current = null;
                }
                onClose();
              }}
            >
              Select account
            </button>
          </>
        )}

    </Modal>
  );
}
