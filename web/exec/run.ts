import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper";
import { stepFailure } from "../../src/errtext.ts";
import type { TxStep } from "../../src/exec.ts";
import { broadcast, fetchTick, waitForTx } from "./chain.ts";

const helper = new QubicHelper();

/**
 * Ticks of lead time between now and the tick a transaction is set to run at. Qubic ticks about one and a half times a second, so this is about 33 seconds for a person to see the
 * request, open the wallet app and approve it: a wallet answers "Tick value is Expired" once the tick has passed, and at 20 ticks (about 13 seconds) most people on a phone missed
 * it. The transaction runs at exactly this tick, so a longer lead also means a longer wait for it to confirm.
 */
export const TICK_OFFSET = 50;
/** The lead for a signer that answers at once (an agent signing with its own key): nobody has to open anything, so a short lead confirms sooner. */
export const INSTANT_SIGNER_TICK_OFFSET = 20;

/** What sending a transaction needs from the network. The default is the public Qubic RPC; tests and other setups can supply their own. */
export interface StepChain {
  tick(): Promise<number>;
  broadcast(tx: Uint8Array): Promise<string>;
  wait(txId: string, targetTick: number): Promise<{ included: boolean; moneyFlew: boolean }>;
}

export const liveChain: StepChain = { tick: fetchTick, broadcast, wait: waitForTx };

/**
 * Told about every step that was included in a tick (the wallet, the step, its transaction id). The app uses it to report trades;
 * it lives here, set from outside, so signing and sending know nothing about it and tests need no network.
 */
let stepListener: ((source: string, step: TxStep, txId: string) => void) | undefined;
export const setStepListener = (f: typeof stepListener) => {
  stepListener = f;
};

export type StepState =
  | { status: "pending" }
  | { status: "signing" }
  | { status: "confirming"; txId: string }
  | { status: "done"; txId: string; moneyFlew: boolean }
  | { status: "failed"; error: string };

async function destination(to: TxStep["to"]): Promise<string> {
  if ("identity" in to) return to.identity;
  const key = new Uint8Array(32);
  key[0] = to.contractIndex; // contracts are addressed by index in the first byte
  return helper.getIdentity(key);
}

export async function buildTx(source: string, step: TxStep, tick: number) {
  const tx = new QubicTransaction()
    .setSourcePublicKey(source)
    .setDestinationPublicKey(await destination(step.to))
    .setAmount(step.amountQu)
    .setTick(tick)
    .setInputType(step.inputType)
    .setInputSize(step.payload.length);
  if (step.payload.length) {
    const payload = new DynamicPayload(step.payload.length);
    payload.setPayload(step.payload);
    tx.setPayload(payload);
  }
  return tx;
}

/**
 * Signs and broadcasts the steps one at a time, waiting for each to be included before the next
 * (a later step depends on an earlier one, e.g. moving share rights before selling). Stops at the
 * first failure so nothing further is sent.
 */
export async function runSteps(
  source: string,
  steps: TxStep[],
  sign: (tx: QubicTransaction) => Promise<{ tx: Uint8Array }>,
  onState: (stepId: string, state: StepState) => void,
  /** Runs after a step is confirmed; throw to fail the step (e.g. a payment the contract refunded). */
  afterConfirm?: (step: TxStep, txId: string) => Promise<void>,
  chain: StepChain = liveChain,
  /** Aborted when the window that started this goes away (closed, navigated, crashed): nothing further is signed or sent after that. */
  signal?: AbortSignal,
  /** Ticks of lead time: the default is for a person approving in a wallet; a signer that answers at once passes INSTANT_SIGNER_TICK_OFFSET. */
  tickOffset: number = TICK_OFFSET,
): Promise<boolean> {
  const stopped = () => new Error("Stopped: the window was closed before this step was sent. Nothing more will be signed.");
  for (const step of steps) {
    try {
      if (signal?.aborted) throw stopped();
      onState(step.id, { status: "signing" });
      const tick = (await chain.tick()) + tickOffset;
      const signed = await sign(await buildTx(source, step, tick));
      // Signing in a wallet app can take long; make sure the tick is still ahead before broadcasting.
      if ((await chain.tick()) > tick - 3) throw new Error("Signing took too long and the tick expired. Please try again.");
      if (signal?.aborted) throw stopped(); // the wallet answered after the window was gone: do not broadcast it
      const txId = await chain.broadcast(signed.tx);
      onState(step.id, { status: "confirming", txId });
      const result = await chain.wait(txId, tick);
      if (!result.included) throw new Error(`Transaction ${txId} was not confirmed in time. Check it on the explorer before retrying.`);
      try {
        stepListener?.(source, step, txId);
      } catch {
        // reporting must never get in the way of a trade
      }
      await afterConfirm?.(step, txId);
      onState(step.id, { status: "done", txId, moneyFlew: result.moneyFlew });
    } catch (e) {
      onState(step.id, { status: "failed", error: stepFailure(e) });
      return false;
    }
  }
  return true;
}
