import { useCallback, useEffect, useState } from "react";
import { PAYWALL, passRequired } from "../../src/config.ts";
import { passIsActive, passResourceId, passStep } from "../../src/pass.ts";
import type { Pass } from "../../src/pass.ts";
import { fetchReceipt, randomNonce, receiptPays, waitForReceipt } from "../../src/qpay.ts";
import type { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction";
import { getRpc } from "./chain.ts";
import { runSteps } from "./run.ts";
import type { StepState } from "./run.ts";

const KEY = "qmax.pass";

function readAll(): Record<string, Pass> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

function save(p: Pass) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [p.wallet]: p }));
  } catch {
    // storage blocked: the pass then lasts only until the page is closed
  }
}

/**
 * This wallet's pass if it is still inside its 24 hours and QPayhub holds the receipt for it. If the
 * network cannot be reached the stored pass is trusted, so a hiccup never makes someone pay twice.
 */
export async function verifiedPass(wallet: string, now = Date.now()): Promise<Pass | null> {
  // Trading is free: there is nothing to check unless the site was built to ask for a pass.
  if (!passRequired()) return { wallet, paidAt: now, nonce: "0", txId: "" };
  const pass = readAll()[wallet];
  if (!passIsActive(pass, wallet, now)) return null;
  try {
    const receipt = await fetchReceipt(getRpc(), wallet, PAYWALL.recipient, passResourceId(), BigInt(pass.nonce));
    return receiptPays(receipt, PAYWALL.recipient, PAYWALL.priceQu) ? pass : null;
  } catch {
    return pass;
  }
}

/** Pays for a pass: one QPayhub payment, confirmed by its receipt before the pass is saved. */
export async function buyPass(
  wallet: string,
  sign: (tx: QubicTransaction) => Promise<{ tx: Uint8Array }>,
  onState: (s: StepState) => void,
): Promise<boolean> {
  const nonce = randomNonce();
  const step = passStep(nonce);
  return runSteps(wallet, [step], sign, (_id, s) => onState(s), async (_s, txId) => {
    // QPayhub refunds (and the transaction still confirms) when it refuses a payment, so the receipt is the proof.
    const ok = await waitForReceipt(getRpc(), { payer: wallet, seller: PAYWALL.recipient, resourceId: step.qpay!.resourceId, nonce, amountQu: PAYWALL.priceQu });
    if (!ok) throw new Error("QPayhub did not record the payment, so it was refunded. Nothing was lost. Please try again.");
    save({ wallet, paidAt: Date.now(), nonce: nonce.toString(), txId });
  });
}

/** Whether the connected wallet has an active pass; null while it is being checked. */
export function usePass(wallet: string | undefined) {
  const [state, setState] = useState<{ wallet?: string; pass: Pass | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!wallet) return;
    let live = true;
    verifiedPass(wallet).then((pass) => live && setState({ wallet, pass }));
    return () => {
      live = false;
    };
  }, [wallet, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const current = wallet && state?.wallet === wallet ? state.pass : undefined;
  if (!passRequired()) return { hasPass: true, expiresAt: null, refresh };
  return { hasPass: !wallet ? false : current === undefined ? null : current !== null, expiresAt: current ? current.paidAt + PAYWALL.hours * 3_600_000 : null, refresh };
}
