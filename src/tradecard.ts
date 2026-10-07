/**
 * What the trade card shows while a trade is signed, sent and checked: how far along it is, which step it is on, and whether it ended well. It is plain
 * logic with no screen in it (web/TradeCard.tsx draws it), so every state is tested. The dialogs hand it what they already know (the steps, each step's
 * state, whether it is still running, what the wallet check found) and take back one view.
 */

export type CardTone = "idle" | "working" | "success" | "attention" | "failed";
export type SegmentState = "pending" | "active" | "done" | "failed";

export interface CardStep {
  id: string;
  description: string;
}

export interface CardInput {
  steps: CardStep[];
  /** Each step's state by its id, as the runner reports it (a step not in here has not started). */
  states: Record<string, { status: string; error?: string } | undefined>;
  /** A step is being signed or sent. */
  running: boolean;
  /** Every step went through (true), one stopped it (false), or it is not over (null). */
  finished: boolean | null;
  /** The wallet is being read again to see what really happened. */
  checking: boolean;
  /** What that check found: all of it done, part of it, nothing yet; null until it is in. */
  verdict: "good" | "partial" | "none" | null;
  /** What went wrong after the steps went through (the wallet could not be read afterwards, say). */
  note?: string;
  /** Why it stopped, when no step says so (a swap whose second trade was refused before it was sent). */
  reason?: string;
  labels?: {
    /** The headline when it all went well. */
    success?: string;
    /** The last part of the bar, after the steps. */
    verify?: string;
  };
}

export interface CardView {
  tone: CardTone;
  title: string;
  detail: string;
  /** One part of the bar for each step, and a last one for checking the wallet. */
  segments: { label: string; state: SegmentState }[];
  /** 0 to 100: 100 only when it ended well. */
  percent: number;
  /** The step being worked on, counted from 1; null before the first and after the last. */
  step: { at: number; of: number } | null;
}

/** How much of a step counts as done at each point in it: waiting for the wallet is a start, being on the chain is most of it. */
const WEIGHT: Record<string, number> = { pending: 0, signing: 0.25, confirming: 0.6, done: 1, failed: 0 };
/** Checking the wallet is a step's worth of waiting too, but a shorter one. */
const CHECK_WEIGHT = 0.5;

const firstLine = (s: string | undefined): string => (s ?? "").split("\n")[0].trim();

export function tradeCard(input: CardInput): CardView {
  const { steps, states, running, finished, checking, verdict, note } = input;
  const successTitle = input.labels?.success ?? "Trade complete";
  const verifyLabel = input.labels?.verify ?? "Check wallet";
  const status = (s: CardStep) => states[s.id]?.status ?? "pending";
  const statuses = steps.map(status);
  const failedAt = statuses.findIndex((s) => s === "failed");
  const doneCount = statuses.filter((s) => s === "done").length;
  const activeAt = statuses.findIndex((s) => s === "signing" || s === "confirming");
  const started = statuses.some((s) => s !== "pending");

  const segments: CardView["segments"] = steps.map((s, i) => ({
    label: s.description,
    state: statuses[i] === "done" ? "done" : statuses[i] === "failed" ? "failed" : statuses[i] === "signing" || statuses[i] === "confirming" ? "active" : "pending",
  }));
  const verifying = finished === true && verdict === null && !note;
  segments.push({ label: verifyLabel, state: verdict !== null ? "done" : verifying || checking ? "active" : "pending" });

  const total = steps.length + CHECK_WEIGHT;
  const progress = statuses.reduce((sum, s) => sum + (WEIGHT[s] ?? 0), 0) + (verdict !== null ? CHECK_WEIGHT : finished === true && !note ? CHECK_WEIGHT / 2 : 0);
  const raw = Math.min(100, Math.round((progress / total) * 100));
  const view = (tone: CardTone, title: string, detail: string, percent: number, step: CardView["step"] = null): CardView => ({ tone, title, detail, segments, percent, step });

  if (finished === false || failedAt >= 0) {
    const bad = failedAt >= 0 ? steps[failedAt] : null;
    const why = firstLine(bad ? states[bad.id]?.error : undefined) || firstLine(input.reason);
    const detail = why || "Later steps were not sent.";
    return view("failed", bad && steps.length > 1 ? `Stopped at step ${failedAt + 1} of ${steps.length}` : "The trade failed", detail, Math.min(raw, 99), bad ? { at: failedAt + 1, of: steps.length } : null);
  }
  if (finished === true) {
    if (note) return view("attention", "Sent, but not confirmed", firstLine(note), Math.min(raw, 99));
    if (verdict === null) return view("working", "Confirmed on-chain", "Checking your wallet to see what happened…", Math.min(raw, 99));
    if (verdict === "good") return view("success", successTitle, "Every step is on-chain and your wallet shows it.", 100);
    if (verdict === "partial") return view("attention", "Partly done", "Only part of it has gone through so far; the details are below.", Math.min(raw, 99));
    return view("attention", "Sent, nothing has moved yet", "The balance may still be updating: check the explorer before trying again.", Math.min(raw, 99));
  }
  if (running || started) {
    const at = activeAt >= 0 ? activeAt : Math.min(doneCount, steps.length - 1);
    const here = steps[at];
    const signing = statuses[at] !== "confirming";
    const place = steps.length > 1 ? `Step ${at + 1} of ${steps.length}: ` : "";
    // Between two steps nothing is being signed: the wallet is read, or the person is asked before the next one goes.
    if (!running) {
      return view("working", checking ? "Checking your wallet" : "Ready for the next step", `${place}${here?.description ?? ""}`.trim(), Math.min(raw, 99), { at: at + 1, of: steps.length });
    }
    return view(
      "working",
      signing ? "Waiting for your wallet" : "Confirming on-chain",
      `${place}${here?.description ?? ""}${signing ? "" : " · waiting to be included in a block"}`.trim(),
      Math.min(raw, 99),
      { at: at + 1, of: steps.length },
    );
  }
  return view("idle", "Ready to sign", "", 0);
}

/** How the dialog around the card is outlined: nothing before a trade starts, and a failure before anything was signed counts as failed too. */
export function dialogTone(card: CardView | null, preflightError: boolean): CardTone {
  if (card && card.tone !== "idle") return card.tone;
  return preflightError ? "failed" : "idle";
}

/** Whole seconds as m:ss for the clock on the card. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
