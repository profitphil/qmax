import { PAYWALL, passRequired } from "./config.ts";
import { buildExecutionPlan } from "./exec.ts";
import type { ExecutableQuote, Holdings } from "./exec.ts";

export type CheckState = "ok" | "warn" | "fail" | "pending";

export interface Check {
  id: "wallet" | "pass" | "liquidity" | "fees" | "shares" | "activity" | "costs";
  label: string;
  state: CheckState;
  detail?: string;
}

export interface Readiness {
  checks: Check[];
  /** True when nothing failed and nothing is still loading: safe to open the review step. */
  ready: boolean;
}

export interface ReadinessInput {
  side: "buy" | "sell";
  qty: number;
  connected: boolean;
  /** The latest quote, or null while it is loading or when the amount is empty. */
  quote: (ExecutableQuote & { fillable: boolean; executable: boolean; warnings: string[] }) | null;
  /** Wallet QU balance and shares per managing contract; null while loading. */
  balanceQu: number | null;
  holdings: Holdings | null;
  activity?: "active" | "inactive" | "unknown";
  /** Whether this wallet has an active QMax pass; null while it is being checked. */
  hasPass: boolean | null;
  /** Whether a pass is asked for at all (the website is free unless built to ask). Defaults to `passRequired()`. */
  passRequired?: boolean;
}

const n = (x: number) => x.toLocaleString("en-US");

/** Everything that has to be true before a trade can go through, as a checklist the user can read. */
export function assessReadiness(i: ReadinessInput): Readiness {
  const checks: Check[] = [];

  checks.push(
    i.connected
      ? { id: "wallet", label: "Wallet connected", state: "ok" }
      : { id: "wallet", label: "Connect your wallet", state: "fail" },
  );

  if (i.connected && (i.passRequired ?? passRequired())) {
    checks.push(
      i.hasPass === null
        ? { id: "pass", label: "Checking your QMax pass", state: "pending" }
        : i.hasPass
          ? { id: "pass", label: "QMax pass active", state: "ok", detail: "No per-trade fee." }
          : { id: "pass", label: "Unlock trading", state: "fail", detail: `${PAYWALL.priceQu.toLocaleString("en-US")} QU for ${PAYWALL.hours} hours, then no per-trade fee.` },
    );
  }

  if (!i.quote) {
    checks.push({ id: "liquidity", label: "Finding the best price", state: "pending" });
  } else if (!i.quote.executable) {
    checks.push({ id: "liquidity", label: "Trading is off on this server", state: "fail", detail: "It is serving demo data." });
  } else if (!i.quote.fillable) {
    checks.push({ id: "liquidity", label: "Enough liquidity for this size", state: "fail", detail: i.quote.warnings[0] ?? "Try a smaller amount." });
  } else {
    checks.push({ id: "liquidity", label: "Enough liquidity for this size", state: "ok" });
  }

  const tradable = i.quote?.fillable && i.quote.executable;
  if (i.connected && tradable) {
    if (i.balanceQu === null || (i.side === "sell" && i.holdings === null)) {
      checks.push({ id: "fees", label: "Checking your balance", state: "pending" });
    } else {
      try {
        const plan = buildExecutionPlan(i.quote!, i.side === "sell" ? i.holdings! : {});
        const enough = i.balanceQu >= plan.maxOutlayQu;
        checks.push({
          id: "fees",
          label: i.side === "sell" ? "QU for fees" : "QU to pay",
          state: enough ? "ok" : "fail",
          detail: enough
            ? `Up to ${n(plan.maxOutlayQu)} QU may leave your wallet (unused QU is refunded).`
            : `Needs up to ${n(plan.maxOutlayQu)} QU; you have ${n(i.balanceQu)} QU. Fees are paid in QU, even when selling.`,
        });
        const moves = plan.steps.filter((s) => s.kind === "transfer-rights");
        if (i.side === "sell") {
          checks.push(
            moves.length === 0
              ? { id: "shares", label: "Shares are ready to sell", state: "ok" }
              : { id: "shares", label: "Shares need moving first", state: "warn", detail: `${moves.length} extra step${moves.length > 1 ? "s" : ""}: ${moves.map((m) => m.description).join("; ")}.` },
          );
        }
      } catch (e) {
        checks.push({ id: i.side === "sell" ? "shares" : "fees", label: i.side === "sell" ? "Shares to sell" : "Order can be built", state: "fail", detail: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (i.activity === "inactive") {
    checks.push({ id: "activity", label: "Market is quiet", state: "warn", detail: "No QX orders or pool changes in 2 epochs, so the price may be stale." });
  }
  const feeWarning = i.quote?.warnings.find((w) => w.startsWith("Fees are"));
  if (feeWarning) checks.push({ id: "costs", label: "Fees are a big share of this trade", state: "warn", detail: feeWarning });

  return { checks, ready: checks.every((c) => c.state === "ok" || c.state === "warn") };
}


export interface LimitReadinessInput {
  side: "buy" | "sell";
  qty: number;
  price: number;
  connected: boolean;
  hasPass: boolean | null;
  passRequired?: boolean;
  /** Wallet QU balance; null while loading. */
  balanceQu: number | null;
  /** Units of the asset the wallet holds under QX or QSwap; null while loading. */
  heldQty: number | null;
  /** Whether the asset trades on QX, the only market with an order book to rest an order on. */
  onQx: boolean;
  /** Why the price and amount cannot be an order (from `limitProblem`), or null. */
  problem: string | null;
}

/** The same checklist for a limit order: a limit order needs QX, a valid price and amount, and the QU (a buy) or the units (a sale) to back it. */
export function assessLimitReadiness(i: LimitReadinessInput): Readiness {
  const checks: Check[] = [];
  checks.push(i.connected ? { id: "wallet", label: "Wallet connected", state: "ok" } : { id: "wallet", label: "Connect your wallet", state: "fail" });
  if (i.connected && (i.passRequired ?? passRequired())) {
    checks.push(
      i.hasPass === null
        ? { id: "pass", label: "Checking your QMax pass", state: "pending" }
        : i.hasPass
          ? { id: "pass", label: "QMax pass active", state: "ok", detail: "No per-trade fee." }
          : { id: "pass", label: "Unlock trading", state: "fail", detail: `${PAYWALL.priceQu.toLocaleString("en-US")} QU for ${PAYWALL.hours} hours, then no per-trade fee.` },
    );
  }
  if (!i.onQx) {
    checks.push({ id: "liquidity", label: "A limit order needs QX", state: "fail", detail: "This asset only trades in a QSwap pool, which has no order book to rest an order on." });
  } else if (i.problem) {
    checks.push({ id: "liquidity", label: "Price and amount", state: "fail", detail: i.problem });
  } else {
    checks.push({ id: "liquidity", label: "Price and amount are valid", state: "ok" });
  }
  if (i.connected && i.onQx && !i.problem) {
    if (i.side === "buy") {
      if (i.balanceQu === null) checks.push({ id: "fees", label: "Checking your balance", state: "pending" });
      else {
        const need = i.price * i.qty;
        checks.push(
          i.balanceQu >= need
            ? { id: "fees", label: "QU to back the order", state: "ok", detail: `${need.toLocaleString("en-US")} QU is held in the order until it fills or you cancel it.` }
            : { id: "fees", label: "QU to back the order", state: "fail", detail: `Needs ${need.toLocaleString("en-US")} QU; you have ${i.balanceQu.toLocaleString("en-US")} QU.` },
        );
      }
    } else if (i.heldQty === null) {
      checks.push({ id: "shares", label: "Checking your balance", state: "pending" });
    } else {
      checks.push(
        i.heldQty >= i.qty
          ? { id: "shares", label: "Units to offer", state: "ok" }
          : { id: "shares", label: "Units to offer", state: "fail", detail: `You hold ${i.heldQty.toLocaleString("en-US")} that QX or QSwap can trade; this offers ${i.qty.toLocaleString("en-US")}.` },
      );
    }
  }
  return { checks, ready: checks.every((c) => c.state === "ok" || c.state === "warn") };
}
