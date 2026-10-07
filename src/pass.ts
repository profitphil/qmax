import { PAYWALL } from "./config.ts";
import type { TxStep } from "./exec.ts";
import { QPAYHUB_INDEX, QPAYHUB_PROC_PAY, payPayload } from "./qpay.ts";

export const PASS_MS = PAYWALL.hours * 3_600_000;

/** What the receipt says it was paid for: "QMAXPASS", a layout version and the pass length in hours. */
export function passResourceId(): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode("QMAXPASS"), 0);
  out[10] = 1;
  new DataView(out.buffer).setUint32(12, PAYWALL.hours, true);
  return out;
}

/** The one payment that unlocks trading: PAYWALL.priceQu through QPayhub to the QMax address. */
export function passStep(nonce: bigint): TxStep {
  const resourceId = passResourceId();
  return {
    id: "pass",
    kind: "payment",
    description: `QMax pass: ${PAYWALL.priceQu.toLocaleString("en-US")} QU for ${PAYWALL.hours} hours of trading, via QPayhub`,
    to: { contractIndex: QPAYHUB_INDEX },
    inputType: QPAYHUB_PROC_PAY,
    amountQu: PAYWALL.priceQu,
    payload: payPayload(PAYWALL.recipient, resourceId, nonce),
    qpay: { seller: PAYWALL.recipient, resourceId, nonce },
  };
}

/** A paid pass, kept in the browser so it can be checked against QPayhub's receipt later. */
export interface Pass {
  wallet: string;
  paidAt: number;
  nonce: string;
  txId: string;
}

/** Still inside its window, for this wallet. (The receipt on QPayhub is checked separately.) */
export function passIsActive(pass: Pass | undefined, wallet: string, now = Date.now()): boolean {
  return !!pass && pass.wallet === wallet && pass.paidAt <= now + 60_000 && now < pass.paidAt + PASS_MS;
}
