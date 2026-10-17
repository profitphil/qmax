import { COUNTED_STEP_KINDS } from "../src/orderkinds.ts";
import { BASE } from "./base.ts";
import { setRelayTarget } from "./exec/chain.ts";
import { setStepListener } from "./exec/run.ts";
import { usageSharingOn } from "./sharing.ts";

export { usageSharingOn };

/** Steps that can fill a trade or change liquidity. Share moves, cancellations and payments are not trades and are not reported. */
const COUNTED: readonly string[] = COUNTED_STEP_KINDS;

let ref: string | undefined;
/** The partner tag from the link this visit came from, so a partner's trades can be told apart. */
export const rememberRef = (r: string | undefined) => {
  ref = r;
};

/** Tells QMax a trade was just sent: the wallet and the transaction id. QMax checks it against the chain before it counts. Never throws. */
export function reportTrade(wallet: string, txId: string): void {
  if (!usageSharingOn()) return;
  fetch(`${BASE}/v1/trade-report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, txIds: [txId], channel: "web", ...(ref ? { ref } : {}) }),
    keepalive: true,
  }).catch(() => {});
}

/** Reports every trade the app signs, and offers each order to QMax to send on (QMax then sees it itself). Both stop with the person's privacy switch. Called once at start-up. */
export function startUsageReporting(): void {
  setRelayTarget(() => (usageSharingOn() ? { url: BASE, channel: "web", ...(ref ? { ref } : {}) } : null));
  setStepListener((wallet, step, txId) => {
    if (COUNTED.includes(step.kind)) reportTrade(wallet, txId);
  });
}
