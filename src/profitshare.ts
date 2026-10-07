import type { PaymentKind, PaymentRecord } from "./usage.ts";

/**
 * Sharing QMax's fee income with its subscribers, worked out from the chain.
 *
 * QMax takes no per-trade fee. Its income is what people pay to its address through QPayhub (passes, subscriptions, API top-ups and
 * x402 sessions), and every such payment is on-chain, so the income is not something QMax reports about itself: it is read back from
 * the archive (`UsageLog`). Only the Discord subscription is paid for now (the website, API, SDK and MCP are free), so by default only
 * subscription payments are income. Each calendar month (UTC) is one period:
 *
 *   pool          = sharePct % of the period's net income (what QPayhub forwarded to QMax, after its own cut)
 *   weight        = what each eligible subscriber paid in that period, net
 *   share         = pool x weight / total weight, rounded down
 *   earned        = the smaller of share and `capFraction` x what that wallet paid in gross
 *
 * The cap is what keeps this honest: pool shares follow a wallet's own payments, so splitting one subscription across many wallets
 * gains nothing, and with the cap at 1 nobody is ever paid back more than they paid. Pennies lost to rounding and to the cap stay
 * with QMax. Nothing here sends money: the statement says what is owed, `payouts.ts` turns it into transactions for the owner to sign.
 */

export interface ShareConfig {
  /** Percent of the period's net income that goes into the pool (0 to 100). */
  sharePct: number;
  /** Most a wallet can earn in a period, as a multiple of what it paid in gross (1 = never more than it paid). 0 turns the cap off. */
  capFraction: number;
  /** Which payments count as income. */
  incomeKinds: PaymentKind[];
  /** Whose payers share in the pool. */
  eligibleKinds: PaymentKind[];
  /**
   * Anyone can pay QPayhub with QMax as the seller and a `QMAXSUB` resource id (naming any Discord user) for any amount from QPayhub's own
   * minimum of 100 QU up, and the chain accepts it. A subscription payment of less than this many QU (what the payer sent, before QPayhub's
   * fee) is not a subscription: it is not income, its payer shares nothing and is not a member. 0 (the default) counts every one. Set it to
   * a little under the real price (the bot's price in QU can drift between offers) so dust cannot make a wallet a subscriber.
   */
  minSubscriptionQu: number;
  /** A balance below this waits for the next payout instead of paying a tiny transfer. */
  minPayoutQu: number;
  /** Wallets left out entirely, as payers and as income: QMax's own address and any team or test wallets. */
  excludeWallets: string[];
}

export const DEFAULT_SHARE_CONFIG: ShareConfig = {
  sharePct: 75,
  capFraction: 1,
  incomeKinds: ["subscription"],
  eligibleKinds: ["subscription"],
  minSubscriptionQu: 0,
  minPayoutQu: 1_000,
  excludeWallets: [],
};

const KINDS: readonly PaymentKind[] = ["pass", "subscription", "api-topup", "session", "pro", "proset", "other"];

/** Reads the settings from the server's environment, refusing values that make no sense instead of guessing. */
export function shareConfigFromEnv(env: Record<string, string | undefined>, recipient: string): ShareConfig {
  const num = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
    return n;
  };
  const kinds = (name: string, fallback: PaymentKind[]) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const list = raw.split(",").map((s) => s.trim());
    const bad = list.find((k) => !KINDS.includes(k as PaymentKind));
    if (bad) throw new Error(`${name}: '${bad}' is not one of ${KINDS.join(", ")}`);
    return list as PaymentKind[];
  };
  const exclude = (env.PROFIT_SHARE_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const badWallet = exclude.find((w) => !/^[A-Z]{60}$/.test(w));
  if (badWallet) throw new Error(`PROFIT_SHARE_EXCLUDE: '${badWallet}' is not a 60-letter identity`);
  return {
    sharePct: num("PROFIT_SHARE_PCT", DEFAULT_SHARE_CONFIG.sharePct, 0, 100),
    capFraction: num("PROFIT_SHARE_CAP", DEFAULT_SHARE_CONFIG.capFraction, 0, 1000),
    incomeKinds: kinds("PROFIT_SHARE_INCOME", DEFAULT_SHARE_CONFIG.incomeKinds),
    eligibleKinds: kinds("PROFIT_SHARE_ELIGIBLE", DEFAULT_SHARE_CONFIG.eligibleKinds),
    minSubscriptionQu: num("SUBSCRIPTION_MIN_QU", DEFAULT_SHARE_CONFIG.minSubscriptionQu, 0, 1e12),
    minPayoutQu: num("PROFIT_SHARE_MIN_PAYOUT_QU", DEFAULT_SHARE_CONFIG.minPayoutQu, 0, 1e12),
    excludeWallets: [...new Set([recipient, ...exclude])],
  };
}

/* ---------- periods ---------- */

/** The payment scan must have finished this long after a period ends before it counts as complete (the archive indexes a little late). */
export const SCAN_MARGIN_MS = 15 * 60_000;

/** The calendar month (UTC) a moment falls in, as "2026-10". */
export const periodOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/** The first moment of a period and of the next one (ms), or null if `id` is not "YYYY-MM". */
export function periodBounds(id: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(id);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { from: Date.UTC(y, mo - 1, 1), to: Date.UTC(y, mo, 1) };
}

/** The period before / after one. */
export const previousPeriod = (id: string): string => periodOf(periodBounds(id)!.from - 1);
export const nextPeriod = (id: string): string => periodOf(periodBounds(id)!.to);

export interface PeriodStatus {
  id: string;
  from: number;
  to: number;
  /** It has ended. */
  closed: boolean;
  /** It has ended and the payment scan has read everything up to a little after its end, so its numbers are final. */
  complete: boolean;
}

export function periodStatus(id: string, now: number, scanAt: number): PeriodStatus {
  const b = periodBounds(id);
  if (!b) throw new Error(`'${id}' is not a period like 2026-10`);
  const closed = now >= b.to;
  return { id, ...b, closed, complete: closed && scanAt >= b.to + SCAN_MARGIN_MS };
}

/* ---------- a period's statement ---------- */

export interface StatementLine {
  wallet: string;
  discordIds: string[];
  payments: number;
  /** What the wallet paid in the period before QPayhub's fee, and the part QMax received. */
  paidQu: number;
  weightQu: number;
  /** pool x weight / total weight, before the cap. */
  shareQu: number;
  /** The most it could earn, or null with no cap. */
  capQu: number | null;
  earnedQu: number;
  capped: boolean;
}

export interface Statement {
  period: PeriodStatus;
  config: Omit<ShareConfig, "excludeWallets"> & { excludedWallets: number };
  income: {
    byKind: Partial<Record<PaymentKind, { count: number; grossQu: number; netQu: number; counted: boolean }>>;
    /** What counts as income (the kinds in `incomeKinds`), net of QPayhub's fee. */
    countedNetQu: number;
    /** Received but not counted (a kind that is not income, such as an unknown payment). */
    notCountedNetQu: number;
    /** Payments from excluded wallets, left out of everything. */
    excluded: { payments: number; netQu: number };
    /** Subscription payments under `minSubscriptionQu`: not subscriptions, so left out of everything too. */
    belowMinimum: { payments: number; netQu: number };
  };
  pool: {
    poolQu: number;
    eligibleWeightQu: number;
    distributedQu: number;
    /** What the pool did not hand out: the cap, rounding, or nobody eligible. It stays with QMax. */
    retainedQu: number;
  };
  lines: StatementLine[];
  warnings: string[];
}

const big = (n: number) => BigInt(Math.trunc(n));

export function statementFor(payments: PaymentRecord[], cfg: ShareConfig, id: string, now: number, scanAt: number): Statement {
  const period = periodStatus(id, now, scanAt);
  const skip = new Set(cfg.excludeWallets);
  const min = cfg.minSubscriptionQu ?? 0;
  const isSmall = (p: PaymentRecord) => p.kind === "subscription" && p.amountQu < min;
  const inPeriod = payments.filter((p) => p.t >= period.from && p.t < period.to);
  const small = inPeriod.filter((p) => !skip.has(p.payer) && isSmall(p));
  const kept = inPeriod.filter((p) => !skip.has(p.payer) && !isSmall(p));
  const left = inPeriod.filter((p) => skip.has(p.payer));

  const byKind: Statement["income"]["byKind"] = {};
  for (const p of kept) {
    const k = (byKind[p.kind] ??= { count: 0, grossQu: 0, netQu: 0, counted: cfg.incomeKinds.includes(p.kind) });
    k.count++;
    k.grossQu += p.amountQu;
    k.netQu += p.forwardedQu;
  }
  const countedNetQu = kept.filter((p) => cfg.incomeKinds.includes(p.kind)).reduce((s, p) => s + p.forwardedQu, 0);
  const notCountedNetQu = kept.filter((p) => !cfg.incomeKinds.includes(p.kind)).reduce((s, p) => s + p.forwardedQu, 0);

  // Whole QU, exact: pool x weight can be far past 2^53 as a plain number.
  const poolQu = Number((big(countedNetQu) * BigInt(Math.round(cfg.sharePct * 1000))) / 100_000n);
  const eligible = kept.filter((p) => cfg.eligibleKinds.includes(p.kind));
  const byWallet = new Map<string, { gross: number; net: number; count: number; discord: Set<string> }>();
  for (const p of eligible) {
    const w = byWallet.get(p.payer) ?? { gross: 0, net: 0, count: 0, discord: new Set<string>() };
    w.gross += p.amountQu;
    w.net += p.forwardedQu;
    w.count++;
    if (p.discordId) w.discord.add(p.discordId);
    byWallet.set(p.payer, w);
  }
  const totalWeight = [...byWallet.values()].reduce((s, w) => s + w.net, 0);

  const lines: StatementLine[] = [...byWallet.entries()].map(([wallet, w]) => {
    const shareQu = totalWeight > 0 ? Number((big(poolQu) * big(w.net)) / big(totalWeight)) : 0;
    const capQu = cfg.capFraction > 0 ? Math.floor(w.gross * cfg.capFraction) : null;
    const earnedQu = capQu === null ? shareQu : Math.min(shareQu, capQu);
    return { wallet, discordIds: [...w.discord].sort(), payments: w.count, paidQu: w.gross, weightQu: w.net, shareQu, capQu, earnedQu, capped: capQu !== null && shareQu > capQu };
  });
  lines.sort((a, b) => b.earnedQu - a.earnedQu || (a.wallet < b.wallet ? -1 : 1));
  const distributedQu = lines.reduce((s, l) => s + l.earnedQu, 0);

  const warnings: string[] = [];
  if (!period.closed) warnings.push("This period is still open: income and shares are provisional and nothing is paid for it yet.");
  else if (!period.complete) warnings.push("This period has ended but the payment scan has not read past its end yet, so its numbers can still change.");
  if (left.length) warnings.push(`${left.length} payment${left.length === 1 ? "" : "s"} from excluded wallets (QMax's own address, team or test wallets) are left out.`);
  if (small.length) warnings.push(`${small.length} subscription payment${small.length === 1 ? "" : "s"} below the ${min.toLocaleString("en-US")} QU minimum ${small.length === 1 ? "is" : "are"} not counted as a subscription.`);
  if (lines.some((l) => l.capped)) warnings.push("Some wallets hit the cap (never more than they paid); what the cap held back stays with QMax.");
  if (period.closed && lines.length === 0 && countedNetQu > 0) warnings.push("There is income but no eligible subscriber, so the whole pool stays with QMax.");

  const { excludeWallets, ...publicConfig } = cfg;
  return {
    period,
    config: { ...publicConfig, excludedWallets: excludeWallets.length },
    income: { byKind, countedNetQu, notCountedNetQu, excluded: { payments: left.length, netQu: left.reduce((s, p) => s + p.forwardedQu, 0) }, belowMinimum: { payments: small.length, netQu: small.reduce((s, p) => s + p.forwardedQu, 0) } },
    pool: { poolQu, eligibleWeightQu: totalWeight, distributedQu, retainedQu: poolQu - distributedQu },
    lines,
    warnings,
  };
}

/* ---------- what each wallet is owed, over all periods ---------- */

export interface Balance {
  wallet: string;
  discordIds: string[];
  /** Earned over every complete period from the start of the programme. */
  earnedQu: number;
  /** Paid out and confirmed on-chain. */
  paidQu: number;
  /** earned less paid (never below 0). */
  owedQu: number;
  /**
   * Paid beyond what was earned so far (a batch signed twice, say). It is not clawed back, but it is set against what the wallet earns in
   * later months (`owedQu` is earned less paid over all months), so the wallet is not paid again until its earnings have caught up.
   */
  overpaidQu: number;
  periods: { period: string; earnedQu: number }[];
}

export interface Balances {
  /** The periods counted: complete ones from the start. */
  periods: string[];
  balances: Balance[];
  totalEarnedQu: number;
  totalPaidQu: number;
  totalOwedQu: number;
}

/**
 * Adds up every complete period from `start` and takes off what has been paid. `paid` is what each wallet has really received from
 * confirmed payouts. Only complete periods count, so nothing is owed on numbers that can still change.
 */
export function balancesFor(payments: PaymentRecord[], cfg: ShareConfig, start: string, now: number, scanAt: number, paid: Map<string, number>): Balances {
  const periods: string[] = [];
  const lastEnded = previousPeriod(periodOf(now));
  for (let id = start; id <= lastEnded; id = nextPeriod(id)) if (periodStatus(id, now, scanAt).complete) periods.push(id);

  const by = new Map<string, Balance>();
  for (const id of periods) {
    for (const l of statementFor(payments, cfg, id, now, scanAt).lines) {
      if (l.earnedQu <= 0) continue;
      const b = by.get(l.wallet) ?? { wallet: l.wallet, discordIds: [], earnedQu: 0, paidQu: 0, owedQu: 0, overpaidQu: 0, periods: [] };
      b.earnedQu += l.earnedQu;
      b.periods.push({ period: id, earnedQu: l.earnedQu });
      b.discordIds = [...new Set([...b.discordIds, ...l.discordIds])];
      by.set(l.wallet, b);
    }
  }
  // A wallet paid out but with nothing earned (the settings changed, say) still shows, with what it was paid.
  for (const [wallet, amount] of paid) if (!by.has(wallet) && amount > 0) by.set(wallet, { wallet, discordIds: [], earnedQu: 0, paidQu: 0, owedQu: 0, overpaidQu: 0, periods: [] });
  for (const b of by.values()) {
    b.paidQu = paid.get(b.wallet) ?? 0;
    b.owedQu = Math.max(0, b.earnedQu - b.paidQu);
    b.overpaidQu = Math.max(0, b.paidQu - b.earnedQu);
  }
  const list = [...by.values()].sort((a, b) => b.owedQu - a.owedQu || (a.wallet < b.wallet ? -1 : 1));
  return {
    periods,
    balances: list,
    totalEarnedQu: list.reduce((s, b) => s + b.earnedQu, 0),
    totalPaidQu: list.reduce((s, b) => s + b.paidQu, 0),
    totalOwedQu: list.reduce((s, b) => s + b.owedQu, 0),
  };
}
