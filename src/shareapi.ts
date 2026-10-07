import { DAY_MS, membershipOf, subscribersOf } from "./membership.ts";
import type { Membership, MembershipConfig } from "./membership.ts";
import { QUTIL_INDEX, SEND_TO_MANY_PROC, batchStep } from "./payouts.ts";
import type { Batch, PayoutLog } from "./payouts.ts";
import { balancesFor, periodBounds, periodOf, statementFor } from "./profitshare.ts";
import type { Balance, Balances, ShareConfig } from "./profitshare.ts";
import { RouteError } from "./routes.ts";
import type { Route } from "./routes.ts";
import type { Archive, PaymentRecord, UsageLog } from "./usage.ts";

/**
 * Subscribers, membership and the profit share, as services and endpoints.
 *
 *   GET  /v1/membership?wallet=ID           public: is this wallet a member, and what has it earned (any wallet: it is chain data)
 *   GET  /v1/subscribers                    QMax's own key: everyone who has subscribed, with status, earnings and what is owed
 *   GET  /v1/profit-share?period=2026-10    QMax's own key: that month's statement
 *   GET  /v1/profit-share/balances          QMax's own key: what each wallet is owed over all complete months
 *   POST /v1/profit-share/payouts/prepare   QMax's own key: the unsigned transactions that pay it
 *   GET  /v1/profit-share/payouts           QMax's own key: every batch and what became of it
 *   POST /v1/profit-share/payouts/signing   {id}        the owner is about to sign it (reserves its wallets)
 *   POST /v1/profit-share/payouts/sent      {id, txId}  the owner sent it (a hint: the chain decides)
 *   POST /v1/profit-share/payouts/cancel    {id}        drop a plan nobody signed
 *   POST /v1/profit-share/payouts/reconcile              check the chain now
 *
 * Nothing here signs or sends: QMax never holds a key. The plan is for the owner's wallet to sign.
 */

export interface ProfitShareDeps {
  usage: UsageLog;
  payouts: PayoutLog;
  config: ShareConfig;
  membership: MembershipConfig;
  /** QMax's own address: the one that must sign the payouts. */
  owner: string;
  archive: Archive;
  /** Whether an active subscription also unlocks trading on the website (a pass always does). Default true. */
  subscriptionUnlocksWeb?: boolean;
  /** What QUtil charges per send-to-many, read from the contract (GetSendToManyV1Fee). */
  sendToManyFee(): Promise<number>;
  now?: () => number;
}

const IDENTITY = /^[A-Z]{60}$/;

export class ProfitShare {
  private d: ProfitShareDeps;
  private now: () => number;

  constructor(d: ProfitShareDeps) {
    // One setting (SUBSCRIPTION_MIN_QU) decides what a subscription is, for the profit share and for membership alike.
    this.d = { ...d, membership: { ...d.membership, minSubscriptionQu: d.membership.minSubscriptionQu ?? d.config.minSubscriptionQu } };
    this.now = d.now ?? Date.now;
  }

  get config() {
    return this.d.config;
  }

  private payments(): PaymentRecord[] {
    return this.d.usage.allPayments();
  }

  private balances() {
    return balancesFor(this.payments(), this.d.config, this.d.payouts.start, this.now(), this.d.usage.scanState().at, this.d.payouts.paidByWallet());
  }

  private memo?: { key: string; value: Balances };

  /**
   * The same balances, for the public lookup only, which anyone can call many times a minute: working them out walks every payment ever
   * received, and payments to QMax cost a sender next to nothing, so many lookups must not each repeat that. The answer is reused until a payment
   * is recorded, the ledger changes, the scan advances, or ten seconds pass. Planning and paying never use it: they always read the books fresh.
   */
  private balancesForDisplay(): Balances {
    const key = [this.d.usage.paymentRevision(), this.d.usage.scanState().at, this.d.payouts.revision, Math.floor(this.now() / 10_000)].join(":");
    if (this.memo?.key === key) return this.memo.value;
    const value = this.balances();
    this.memo = { key, value };
    return value;
  }

  /** Is this wallet a member, and what has it earned. Looks the wallet's own payments up first so a new member is seen at once. */
  async membership(wallet: string, fresh = true) {
    if (fresh) await this.d.usage.refreshWallet(wallet).catch(() => []);
    const now = this.now();
    const m = membershipOf(this.payments(), wallet, now, this.d.membership);
    // The website unlocks trading for a pass, and for a subscription unless the operator turned that off.
    const unlocksWebTrading = m.pass.active || (m.subscription.active && (this.d.subscriptionUnlocksWeb ?? true));
    return { ...m, unlocksWebTrading, profitShare: this.shareOf(wallet, now) };
  }

  /** One wallet's profit share: what it has earned in complete months, what has been paid, and an estimate for the month so far. */
  private shareOf(wallet: string, now: number) {
    const c = this.d.config;
    if (c.excludeWallets.includes(wallet)) return null;
    const scanAt = this.d.usage.scanState().at;
    const b = this.balancesForDisplay();
    const mine = b.balances.find((x) => x.wallet === wallet);
    const current = periodOf(now);
    const live = statementFor(this.payments(), c, current, now, scanAt).lines.find((l) => l.wallet === wallet);
    return {
      sharePct: c.sharePct,
      capFraction: c.capFraction,
      since: this.d.payouts.start,
      earnedQu: mine?.earnedQu ?? 0,
      paidQu: mine?.paidQu ?? 0,
      owedQu: mine?.owedQu ?? 0,
      periods: mine?.periods ?? [],
      thisMonth: { period: current, estimatedQu: live?.earnedQu ?? 0, provisional: true },
      note: "A month's share is final once the month has ended and QMax has read the chain past its end; payouts are made in batches, so an amount below the minimum waits for the next one. The estimate changes as the month's income does.",
    };
  }

  subscribers() {
    const now = this.now();
    const all = this.payments();
    const members = subscribersOf(all, now, this.d.membership);
    const b = this.balances();
    const by = new Map<string, Balance>(b.balances.map((x) => [x.wallet, x]));
    const rows = members.map((m: Membership) => {
      const bal = by.get(m.wallet);
      return {
        wallet: m.wallet,
        discordIds: m.subscription.discordIds,
        active: m.subscription.active,
        until: m.subscription.until ? new Date(m.subscription.until).toISOString() : null,
        since: m.subscription.since ? new Date(m.subscription.since).toISOString() : null,
        lastPaid: m.subscription.lastPaidAt ? new Date(m.subscription.lastPaidAt).toISOString() : null,
        payments: m.subscription.payments,
        paidQu: m.subscription.paidQu,
        excluded: this.d.config.excludeWallets.includes(m.wallet),
        earnedQu: bal?.earnedQu ?? 0,
        paidOutQu: bal?.paidQu ?? 0,
        owedQu: bal?.owedQu ?? 0,
      };
    });
    const counted = rows.filter((r) => !r.excluded);
    return {
      asOf: new Date(now).toISOString(),
      counts: { activeNow: counted.filter((r) => r.active).length, everSubscribed: counted.length, excluded: rows.length - counted.length, activeWithin7Days: counted.filter((r) => r.lastPaid && now - Date.parse(r.lastPaid) < 7 * DAY_MS).length },
      totals: { paidQu: counted.reduce((s, r) => s + r.paidQu, 0), earnedQu: b.totalEarnedQu, paidOutQu: b.totalPaidQu, owedQu: b.totalOwedQu },
      paymentsScannedUpTo: this.d.usage.scanState().at ? new Date(this.d.usage.scanState().at).toISOString() : null,
      subscribers: rows,
    };
  }

  statement(period?: string) {
    const now = this.now();
    const id = period ?? periodOf(now);
    if (!periodBounds(id)) throw new RouteError(400, "period must look like 2026-10");
    return statementFor(this.payments(), this.d.config, id, now, this.d.usage.scanState().at);
  }

  balancesView() {
    const b = this.balances();
    return { start: this.d.payouts.start, scannedUpTo: this.d.usage.scanState().at ? new Date(this.d.usage.scanState().at).toISOString() : null, minPayoutQu: this.d.config.minPayoutQu, ...b };
  }

  /**
   * The unsigned transactions that pay what is owed now. Reads the fee from QUtil first: the contract refunds a transaction that attaches
   * anything but the amounts plus its fee, so a fee that cannot be read stops the plan instead of being guessed.
   */
  async plan() {
    if (!this.balances().periods.length) throw new RouteError(409, "No month is complete yet (a month counts once it has ended and the payment scan has read past its end), so nothing is owed.");
    let feeQu: number;
    try {
      feeQu = await this.d.sendToManyFee();
    } catch (e) {
      throw new RouteError(502, `Could not read QUtil's send-to-many fee from the network (${e instanceof Error ? e.message : e}); not planning a payout without it.`);
    }
    // Read only now, after the wait for the fee: a payout confirmed meanwhile (the background check runs on its own) must already be off
    // the balances, or its wallets would be planned, and paid, again. From here to `prepare` nothing waits.
    const b = this.balances();
    if (!b.periods.length) throw new RouteError(409, "No month is complete yet, so nothing is owed.");
    const through = b.periods[b.periods.length - 1];
    const flying = this.d.payouts.inFlight();
    let batches: Batch[];
    try {
      batches = this.d.payouts.prepare(b.balances, { feeQu, minPayoutQu: this.d.config.minPayoutQu, throughPeriod: through, exclude: [this.d.owner, ...this.d.config.excludeWallets] });
    } catch (e) {
      // A line the contract would refuse, or one that could misdirect money (an all-zero or contract address): say so instead of failing blind.
      throw new RouteError(409, `Could not build the payout: ${e instanceof Error ? e.message : e}`);
    }
    const skipped = b.balances
      .filter((x) => x.owedQu > 0 && !batches.some((bt) => bt.lines.some((l) => l.wallet === x.wallet)))
      .map((x) => ({ wallet: x.wallet, owedQu: x.owedQu, reason: flying.has(x.wallet) ? "a payout for it is already being sent" : `below the ${this.d.config.minPayoutQu.toLocaleString("en-US")} QU minimum, so it waits for the next payout` }));
    return {
      owner: this.d.owner,
      throughPeriod: through,
      feeQu,
      wallets: batches.reduce((s, x) => s + x.lines.length, 0),
      toWalletsQu: batches.reduce((s, x) => s + x.lines.reduce((t, l) => t + l.amountQu, 0), 0),
      totalAttachedQu: batches.reduce((s, x) => s + x.amountQu, 0),
      batches: batches.map((x) => this.batchView(x)),
      skipped,
      howToSign: `Sign each batch from ${this.d.owner} (QMax's own address; anything else is refused). Each is one transaction to QUtil (contract ${QUTIL_INDEX}, procedure ${SEND_TO_MANY_PROC}) with exactly 'amountQu' attached and 'payloadBase64' as its input. Call /v1/profit-share/payouts/signing with the batch id before signing, and /sent with the transaction id after: a batch counts as paid only once the chain shows it.`,
    };
  }

  batchView(b: Batch) {
    const step = batchStep(b);
    return {
      id: b.id,
      status: b.status,
      throughPeriod: b.throughPeriod,
      wallets: b.lines.length,
      toWalletsQu: b.lines.reduce((s, l) => s + l.amountQu, 0),
      feeQu: b.feeQu,
      amountQu: b.amountQu,
      txId: b.txId ?? null,
      note: b.note ?? null,
      lines: b.lines,
      tx: { destinationContractIndex: step.to && "contractIndex" in step.to ? step.to.contractIndex : null, inputType: step.inputType, amountQu: step.amountQu, payloadBase64: b.payload, description: step.description },
      ...(b.paid ? { paid: b.paid } : {}),
      ...(b.duplicateTx?.length ? { duplicateTx: b.duplicateTx } : {}),
    };
  }

  payoutsView() {
    const list = this.d.payouts.list();
    return { owner: this.d.owner, batches: [...list].reverse().map((b) => this.batchView(b)), totalPaidQu: [...this.d.payouts.paidByWallet().values()].reduce((s, v) => s + v, 0) };
  }

  async reconcile() {
    return this.d.payouts.reconcile(this.d.archive, this.d.owner);
  }

  /**
   * The owner is about to sign a batch. A plan can wait: while it did, a payout signed by hand may have been found on the chain and credited, or a
   * wallet may have been left out of the programme. Signing it anyway would pay that wallet again, so a plan is checked against what is owed *now*
   * (less what is in flight) first, and refused whole if any line is more than that. Nothing is reserved then: ask for a new plan.
   */
  signing(id: string) {
    return this.wrap(() => {
      const b = this.d.payouts.get(id);
      if (b?.status === "prepared") this.assertStillOwed(b);
      return this.d.payouts.markSigning(id);
    });
  }

  private assertStillOwed(b: Batch) {
    const owed = new Map(this.balances().balances.map((x) => [x.wallet, x.owedQu]));
    const flying = this.d.payouts.inFlight();
    const left = new Set([this.d.owner, ...this.d.config.excludeWallets]);
    for (const l of b.lines) {
      const due = Math.max(0, (owed.get(l.wallet) ?? 0) - (flying.get(l.wallet) ?? 0));
      if (left.has(l.wallet) || l.amountQu > due) throw new Error(`This plan is out of date: ${l.wallet} is no longer owed ${l.amountQu} QU (${left.has(l.wallet) ? "it is left out of the programme" : `${due} QU is owed now`}). Nothing was reserved; ask for a new plan.`);
    }
  }

  sent(id: string, txId: string) {
    return this.wrap(() => this.d.payouts.markSent(id, txId));
  }

  cancel(id: string) {
    return this.wrap(() => this.d.payouts.cancel(id));
  }

  private wrap(f: () => Batch) {
    try {
      return this.batchView(f());
    } catch (e) {
      throw new RouteError(e instanceof Error && /No such batch/.test(e.message) ? 404 : 409, e instanceof Error ? e.message : String(e));
    }
  }
}

/** The endpoints. Admin ones are `keyed`: only QMax's own API key reaches them. */
export function profitShareRoutes(svc: ProfitShare): Route[] {
  const body = (b: unknown) => (typeof b === "object" && b !== null ? (b as Record<string, unknown>) : {});
  const id = (b: unknown) => {
    const v = body(b).id;
    if (typeof v !== "string" || !/^[0-9a-f]{16}$/.test(v)) throw new RouteError(400, "id must be a batch id (16 hex characters)");
    return v;
  };
  return [
    {
      method: "GET",
      path: "/v1/membership",
      limited: false,
      rate: { perMin: 30 },
      doc: {
        summary: "Is this wallet a QMax member, and what has it earned in profit share",
        description:
          "Read from the chain: a subscription paid through the Discord bot (or a pass) is a QPayhub payment signed by the wallet, so the same wallet is recognised here with nothing to link. Returns whether the membership is active and until when, and the wallet's profit share: earned over complete months, paid out, owed, and an estimate for the month so far. Any wallet may be asked about: it is all public chain data.",
        parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" }, description: "The wallet's 60-letter identity." }],
        responses: { "200": { description: "The membership." }, "400": { description: "Not a Qubic identity." } },
      },
      handler: async ({ query }) => {
        const wallet = (query.get("wallet") ?? "").trim();
        if (!IDENTITY.test(wallet)) throw new RouteError(400, "wallet must be a 60-letter Qubic identity (A-Z)");
        // Which Discord accounts a wallet paid for is the owner's to see (/v1/subscribers), not something anyone who knows a wallet should be handed.
        const { subscription, ...rest } = await svc.membership(wallet);
        const { discordIds: _private, ...publicSubscription } = subscription;
        return { ...rest, subscription: publicSubscription };
      },
    },
    { method: "GET", path: "/v1/subscribers", limited: false, keyed: true, doc: { summary: "Subscribers" }, handler: () => svc.subscribers() },
    {
      method: "GET",
      path: "/v1/profit-share",
      limited: false,
      keyed: true,
      doc: { summary: "A month's profit-share statement" },
      handler: ({ query }) => svc.statement(query.get("period") ?? undefined),
    },
    { method: "GET", path: "/v1/profit-share/balances", limited: false, keyed: true, doc: { summary: "What each wallet is owed" }, handler: () => svc.balancesView() },
    { method: "POST", path: "/v1/profit-share/payouts/prepare", limited: false, keyed: true, doc: { summary: "Plan the payout" }, handler: () => svc.plan() },
    { method: "GET", path: "/v1/profit-share/payouts", limited: false, keyed: true, doc: { summary: "Payout batches" }, handler: () => svc.payoutsView() },
    { method: "POST", path: "/v1/profit-share/payouts/signing", limited: false, keyed: true, doc: { summary: "About to sign a batch" }, handler: ({ body: b }) => svc.signing(id(b)) },
    {
      method: "POST",
      path: "/v1/profit-share/payouts/sent",
      limited: false,
      keyed: true,
      doc: { summary: "A batch was sent" },
      handler: ({ body: b }) => {
        const tx = body(b).txId;
        if (typeof tx !== "string") throw new RouteError(400, "txId is required");
        return svc.sent(id(b), tx);
      },
    },
    { method: "POST", path: "/v1/profit-share/payouts/cancel", limited: false, keyed: true, doc: { summary: "Drop an unsigned plan" }, handler: ({ body: b }) => svc.cancel(id(b)) },
    {
      method: "POST",
      path: "/v1/profit-share/payouts/reconcile",
      limited: false,
      keyed: true,
      doc: { summary: "Check the chain for batches now" },
      handler: async () => {
        const r = await svc.reconcile();
        return { verified: r.verified.map((b) => b.id), failed: r.failed.map((b) => ({ id: b.id, reason: b.note })) };
      },
    },
  ];
}

/** Reads QUtil's send-to-many fee: GetSendToManyV1Fee is function 1 of contract 4 and returns one signed 64-bit number. */
export async function readSendToManyFee(query: (contract: number, fn: number, input: Uint8Array) => Promise<Uint8Array>): Promise<number> {
  const out = await query(QUTIL_INDEX, 1, new Uint8Array());
  if (out.length < 8) throw new Error("QUtil's answer was too short");
  const fee = new DataView(out.buffer, out.byteOffset, out.byteLength).getBigInt64(0, true);
  if (fee < 0n || fee > 1_000_000n) throw new Error(`QUtil reported a fee of ${fee}, which does not look right`);
  return Number(fee);
}

