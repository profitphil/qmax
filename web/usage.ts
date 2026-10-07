import type { TxStep } from "../src/exec.ts";
import { BASE } from "./base.ts";
import { setStepListener } from "./exec/run.ts";
import { usageSharingOn } from "./sharing.ts";

export { usageSharingOn };

/** Steps that can fill a trade or change liquidity. Share moves, cancellations and payments are not trades and are not reported. */
const COUNTED: readonly TxStep["kind"][] = ["qx-bid", "qx-ask", "qswap-buy", "qswap-sell", "add-liquidity", "remove-liquidity"];

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

/** Reports every trade the app signs. Called once at start-up. */
export function startUsageReporting(): void {
  setStepListener((wallet, step, txId) => {
    if (COUNTED.includes(step.kind)) reportTrade(wallet, txId);
  });
}
