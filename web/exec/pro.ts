import { useCallback, useEffect, useMemo, useState } from "react";
import { proAccess, proConfig, proListStep, proPassIsActive, proResourceId, proStep } from "../../src/pro.ts";
import type { ProAccess } from "../../src/pro.ts";
import { coverFingerprint, normalizeCover } from "../../src/procover.ts";
import { fetchProStatus, sendCover } from "../pro-api.ts";
import type { ProServerStatus } from "../pro-api.ts";
import type { Pass } from "../../src/pass.ts";
import { fetchReceipt, randomNonce, receiptPays, waitForReceipt } from "../../src/qpay.ts";
import type { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction";
import { getRpc } from "./chain.ts";
import { runSteps } from "./run.ts";
import type { StepState } from "./run.ts";

const PASS_KEY = "qmax.pro.pass";
/** Lists that are paid for on-chain but not yet handed to QMax (the page was closed, the network dropped): tried again the next time. */
const COVER_KEY = "qmax.pro.cover";

/** A paid pass; `fp` is the fingerprint of the list of addresses it was bought for, when there was one. */
type ProPass = Pass & { fp?: string };
interface PendingCover {
  fp: string;
  list: string[];
}

const read = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: the choice then lasts only until the page is closed
  }
};

/** This wallet's Pro pass if it is inside its days and QPayhub holds the receipt (a network that cannot be reached trusts the saved pass, so nobody pays twice). */
export async function verifiedPro(wallet: string, now = Date.now()): Promise<Pass | null> {
  const config = proConfig();
  const pass = read<Record<string, ProPass>>(PASS_KEY, {})[wallet];
  if (!proPassIsActive(pass, wallet, config, now)) return null;
  try {
    const receipt = await fetchReceipt(getRpc(), wallet, config.recipient, proResourceId(config, pass.fp), BigInt(pass.nonce));
    return receiptPays(receipt, config.recipient, config.priceQu) ? pass : null;
  } catch {
    return pass;
  }
}

/** What came of a payment: whether it went through, and whether QMax has been given the list of addresses it covers (true when there was no list to give). */
export interface PayResult {
  ok: boolean;
  listSent: boolean;
}

/**
 * Hands QMax the list a payment committed to. QMax accepts it only when a payment from this wallet carries its fingerprint, which takes a moment to show up
 * (404): so it asks again a few times. A list that was refused outright (400) is a mistake in the list, not a wait.
 */
async function giveList(payer: string, list: string[], attempts = 8, delayMs = 4000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      await sendCover(payer, list);
      return true;
    } catch (e) {
      if ((e as { status?: number }).status === 400) return false;
    }
  }
  return false;
}

const pendingCovers = () => read<Record<string, PendingCover>>(COVER_KEY, {});
function setPendingCover(wallet: string, value: PendingCover | null) {
  const all = { ...pendingCovers() };
  if (value) all[wallet] = value;
  else delete all[wallet];
  write(COVER_KEY, all);
}

/** Tries once more to hand QMax a list that was paid for but not delivered. Returns true when there was nothing left to deliver. */
export async function retryPendingCover(wallet: string): Promise<boolean> {
  const pending = pendingCovers()[wallet];
  if (!pending) return true;
  if (await giveList(wallet, pending.list, 1)) {
    setPendingCover(wallet, null);
    return true;
  }
  return false;
}

/** The list a purchase covers, checked: public addresses only, the payer always in it, at most 15. Throws a sentence for the person if it is not. */
export function coverList(payer: string, addresses: string[]): string[] {
  const n = normalizeCover(addresses, payer);
  if (!n.ok) throw new Error(n.error);
  return n.list;
}

/**
 * Pays for a Pro pass: one QPayhub payment, confirmed by its receipt before the pass is saved. With `addresses` the pass covers those addresses too
 * (the payer is always included, 15 at the most): the payment carries a fingerprint of the list, and once it is confirmed QMax is given the list itself.
 */
export async function buyPro(wallet: string, sign: (tx: QubicTransaction) => Promise<{ tx: Uint8Array }>, onState: (s: StepState) => void, addresses: string[] = []): Promise<PayResult> {
  const config = proConfig();
  const list = coverList(wallet, addresses);
  const fp = list.length > 1 ? await coverFingerprint(list) : undefined;
  const nonce = randomNonce();
  const step = proStep(nonce, config, fp);
  const ok = await runSteps(wallet, [step], sign, (_id, s) => onState(s), async (_s, txId) => {
    // QPayhub refunds (and the transaction still confirms) when it refuses a payment, so the receipt is the proof.
    const paid = await waitForReceipt(getRpc(), { payer: wallet, seller: config.recipient, resourceId: step.qpay!.resourceId, nonce, amountQu: config.priceQu });
    if (!paid) throw new Error("QPayhub did not record the payment, so it was refunded. Nothing was lost. Please try again.");
    write(PASS_KEY, { ...read<Record<string, ProPass>>(PASS_KEY, {}), [wallet]: { wallet, paidAt: Date.now(), nonce: nonce.toString(), txId, ...(fp ? { fp } : {}) } satisfies ProPass });
    if (fp) setPendingCover(wallet, { fp, list });
  });
  if (!ok) return { ok: false, listSent: false };
  const listSent = !fp || (await giveList(wallet, list));
  if (listSent) setPendingCover(wallet, null);
  return { ok: true, listSent };
}

/** Changes the addresses a pass covers: a small payment (COVER_UPDATE_QU) that carries the new list's fingerprint. It adds no time. */
export async function changeCover(wallet: string, sign: (tx: QubicTransaction) => Promise<{ tx: Uint8Array }>, onState: (s: StepState) => void, addresses: string[]): Promise<PayResult> {
  const config = proConfig();
  const list = coverList(wallet, addresses);
  const fp = await coverFingerprint(list);
  const nonce = randomNonce();
  const step = proListStep(nonce, fp, config);
  const ok = await runSteps(wallet, [step], sign, (_id, s) => onState(s), async () => {
    const paid = await waitForReceipt(getRpc(), { payer: wallet, seller: config.recipient, resourceId: step.qpay!.resourceId, nonce, amountQu: step.amountQu });
    if (!paid) throw new Error("QPayhub did not record the payment, so it was refunded. Nothing was lost. Please try again.");
    setPendingCover(wallet, { fp, list });
  });
  if (!ok) return { ok: false, listSent: false };
  const listSent = await giveList(wallet, list);
  if (listSent) setPendingCover(wallet, null);
  return { ok: true, listSent };
}

/**
 * Whether Pro features (Max) may be used now: free (the default), or with a pass where the site asks for one. A pass is found two ways: the wallet's own receipt on QPayhub
 * (what it paid for itself, checked in this browser), and QMax's record of who a pass covers (so an address on someone's list is covered too; GET /v1/pro).
 * `cover` is QMax's answer for this wallet (null while it is asked, or when QMax cannot be reached).
 */
export function useProAccess(wallet: string | undefined): { access: ProAccess; refresh: () => void; cover: ProServerStatus | null } {
  const config = useMemo(proConfig, []);
  const [pass, setPass] = useState<{ wallet?: string; pass: Pass | null } | null>(null);
  const [server, setServer] = useState<{ wallet: string; status: ProServerStatus } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!wallet || config.mode === "free") return;
    let live = true;
    verifiedPro(wallet).then((p) => live && setPass({ wallet, pass: p }));
    return () => {
      live = false;
    };
  }, [wallet, tick, config.mode]);
  useEffect(() => {
    if (!wallet || config.mode === "free" || config.priceQu <= 0) return;
    const ctl = new AbortController();
    (async () => {
      await retryPendingCover(wallet).catch(() => false);
      const status = await fetchProStatus(wallet, ctl.signal);
      if (!ctl.signal.aborted) setServer({ wallet, status });
    })().catch(() => {
      // QMax cannot be reached: the wallet's own receipt still counts
    });
    return () => ctl.abort();
  }, [wallet, tick, config.mode, config.priceQu]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const cover = server && server.wallet === wallet ? server.status : null;
  const passActive = !!wallet && ((pass?.wallet === wallet && pass.pass !== null) || cover?.active === true);
  return { access: proAccess(config, { passActive }), refresh, cover };
}
