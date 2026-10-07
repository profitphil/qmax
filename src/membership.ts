import type { PaymentRecord } from "./usage.ts";

/**
 * Who is a member, worked out from the chain alone.
 *
 * A subscription is a QPayhub payment to QMax's address whose receipt names a Discord user (`QMAXSUB`), and a pass is the same for
 * `QMAXPASS`. Both are signed by the wallet that pays, so the payer wallet is on-chain: someone who subscribes through the Discord bot
 * can be recognised by that wallet on the website too, with nothing to link or log in to. Each payment extends the membership by its
 * length from the later of "now it was paid" and "when the last one ended", the same way the bot extends a subscription.
 */

export const DAY_MS = 86_400_000;

export interface MembershipConfig {
  /** How long one subscription payment lasts (the bot's BOT_SUB_DAYS). */
  subscriptionDays: number;
  /** How long one pass lasts (PAYWALL.hours). */
  passHours: number;
  /** A subscription payment of fewer QU than this (what the payer sent) is not a subscription (SUBSCRIPTION_MIN_QU). Default 0: every one counts. */
  minSubscriptionQu?: number;
}

/**
 * Whether a payment is a subscription. Anyone can pay QPayhub with QMax as the seller and a `QMAXSUB` resource id naming any Discord user, for
 * any amount from 100 QU up, so what makes it a subscription is also what was paid.
 */
export const isSubscription = (p: PaymentRecord, minQu = 0): boolean => p.kind === "subscription" && p.amountQu >= minQu;

/** When coverage ends if each payment (by its time, ms) buys `lengthMs`, stacking after the previous one. 0 for none. */
export function coverageUntil(times: number[], lengthMs: number): number {
  let until = 0;
  for (const t of [...times].sort((a, b) => a - b)) until = Math.max(t, until) + lengthMs;
  return until;
}

export interface Membership {
  wallet: string;
  active: boolean;
  /** When the membership ends (ms), the later of the two kinds; null when not active. */
  until: number | null;
  /** What keeps it active now (the one that lasts longer), or null. */
  source: "subscription" | "pass" | null;
  subscription: {
    active: boolean;
    until: number | null;
    /** First and latest payment (ms), null if there has been none. */
    since: number | null;
    lastPaidAt: number | null;
    payments: number;
    /** What the wallet paid in all, before QPayhub's fee. */
    paidQu: number;
    /** The Discord accounts this wallet's subscriptions were paid for. */
    discordIds: string[];
  };
  pass: { active: boolean; until: number | null };
}

export function membershipOf(payments: PaymentRecord[], wallet: string, now: number, cfg: MembershipConfig): Membership {
  const mine = payments.filter((p) => p.payer === wallet);
  const subs = mine.filter((p) => isSubscription(p, cfg.minSubscriptionQu));
  const passes = mine.filter((p) => p.kind === "pass");
  const subUntil = coverageUntil(subs.map((p) => p.t), cfg.subscriptionDays * DAY_MS);
  const passUntil = coverageUntil(passes.map((p) => p.t), cfg.passHours * 3_600_000);
  const subActive = subUntil > now;
  const passActive = passUntil > now;
  const until = Math.max(subActive ? subUntil : 0, passActive ? passUntil : 0) || null;
  return {
    wallet,
    active: subActive || passActive,
    until,
    source: subActive && (!passActive || subUntil >= passUntil) ? "subscription" : passActive ? "pass" : null,
    subscription: {
      active: subActive,
      until: subActive ? subUntil : null,
      since: subs.length ? Math.min(...subs.map((p) => p.t)) : null,
      lastPaidAt: subs.length ? Math.max(...subs.map((p) => p.t)) : null,
      payments: subs.length,
      paidQu: subs.reduce((s, p) => s + p.amountQu, 0),
      discordIds: [...new Set(subs.map((p) => p.discordId).filter((d): d is string => !!d))],
    },
    pass: { active: passActive, until: passActive ? passUntil : null },
  };
}

/** Every wallet that has ever paid for a subscription, with its membership. Newest payer first. */
export function subscribersOf(payments: PaymentRecord[], now: number, cfg: MembershipConfig): Membership[] {
  // Grouped by payer once: asking for each wallet's own payments by scanning all of them would cost wallets x payments, and payments to QMax
  // cost a sender next to nothing.
  const by = new Map<string, PaymentRecord[]>();
  for (const p of payments) {
    const l = by.get(p.payer);
    if (l) l.push(p);
    else by.set(p.payer, [p]);
  }
  const wallets = [...by.entries()].filter(([, l]) => l.some((p) => isSubscription(p, cfg.minSubscriptionQu))).map(([w]) => w);
  return wallets.map((w) => membershipOf(by.get(w)!, w, now, cfg)).sort((a, b) => (b.subscription.lastPaidAt ?? 0) - (a.subscription.lastPaidAt ?? 0));
}
