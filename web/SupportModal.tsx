import { useEffect, useMemo, useState } from "react";
import { fetchPlans } from "./client.ts";
import { PAYWALL } from "../src/config.ts";
import { qrWithLogo } from "../src/qrlogo.ts";
import { Icon, Modal } from "./ui.tsx";

/**
 * QMax is free for everyone; this is how to support it. Support goes through a Q+Pay tip jar (`/v1/plans` gives its link, the SUPPORT_URL setting): a button and a QR
 * code that open its checkout, where any amount can be paid in QU. Until a tip jar is set, the address QU can be sent to is shown instead, with a Copy button.
 */
export function SupportModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [address, setAddress] = useState(PAYWALL.recipient);
  const [copied, setCopied] = useState<"" | "yes" | "failed">("");
  useEffect(() => {
    let alive = true;
    fetchPlans().then((p) => {
      if (!alive || !p) return;
      if (p.supportUrl) setUrl(p.supportUrl);
      if (p.supportAddress) setAddress(p.supportAddress);
    });
    return () => {
      alive = false;
    };
  }, []);
  const qr = useMemo(() => `data:image/svg+xml;utf8,${encodeURIComponent(qrWithLogo(url || address))}`, [url, address]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };
  const addressBlock = (
    <>
      <code className="support-address" title="Press to select">
        {address}
      </code>
      <button type="button" className="ghost wide" onClick={copy}>
        <Icon name="copy" size={15} /> {copied === "yes" ? "Copied" : "Copy address"}
      </button>
      {copied === "failed" && <p className="warn inline">Could not copy automatically. Select the address above and copy it by hand.</p>}
    </>
  );

  return (
    <Modal
      title="Support QMax"
      subtitle="QMax is free for everyone: no fees, no subscription. If it helps you, a tip in QU supports its running costs and what comes next."
      size="sm"
      className="support"
      onClose={onClose}
      footer={
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="support-body">
        <img className="support-qr" src={qr} alt={url ? "QR code of the Q+Pay tip jar" : "QR code of the support address"} />
        {url ? (
          <>
            <a className="btn support-tip" href={url} target="_blank" rel="noopener noreferrer">
              <Icon name="heart" size={15} /> Tip with Q+Pay
            </a>
            <p className="note support-note">Q+Pay opens a checkout where you choose the amount and pay in QU. Thank you!</p>
            <details className="support-direct">
              <summary>Or send QU straight to the address</summary>
              <div className="support-body">{addressBlock}</div>
            </details>
          </>
        ) : (
          <>
            <p className="note support-note">Any amount, from any wallet. Thank you!</p>
            {addressBlock}
          </>
        )}
      </div>
    </Modal>
  );
}
