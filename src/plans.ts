import { PAYWALL } from "./config.ts";
import type { Route } from "./routes.ts";

/**
 * QMax is free for everyone: the website, the API and the Discord bot. The bot's subscription still exists in the code but is switched off (BOT_SUBSCRIPTIONS=on brings it
 * back); this says which it is, what it would cost (BOT_SUBSCRIPTION_PRICE_QU or BOT_SUBSCRIPTION_USD, BOT_SUB_DAYS, BOT_FREE_UNTIL: the settings the bot reads) and
 * where support goes, so the website says what is true without copies to keep up to date.
 */
export const subscriptionsOn = (env: Record<string, string | undefined>): boolean => /^(on|1|true|yes)$/i.test((env.BOT_SUBSCRIPTIONS ?? "").trim());

/**
 * The Q+Pay tip jar that support goes through (SUPPORT_URL: a tip jar link from the QPay dashboard, https only), or null while there is none. Visiting it opens a checkout
 * where the person chooses an amount and pays in QU.
 */
export function supportUrl(env: Record<string, string | undefined>): string | null {
  const v = (env.SUPPORT_URL ?? "").trim();
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Where support (donations of QU) goes: SUPPORT_ADDRESS, else the address QMax is paid to. */
export function supportAddress(env: Record<string, string | undefined>): string {
  const a = (env.SUPPORT_ADDRESS ?? "").trim();
  return /^[A-Z]{60}$/.test(a) ? a : PAYWALL.recipient;
}

/**
 * What the bot's alerts cost, in QU for one subscription period (BOT_ALERTS_PRICE_QU), or null while alerts are free. The bot checks the market for every active alert
 * about every minute, which uses real resources, so alerts are the one part of the bot that is sold: trading, quotes and everything else stay free.
 */
export function alertsPriceQu(env: Record<string, string | undefined>): number | null {
  const n = Number((env.BOT_ALERTS_PRICE_QU ?? "").replace(/[,_]/g, ""));
  return Number.isInteger(n) && n >= 100 && n <= 1_000_000_000 ? n : null;
}

export interface DiscordPlan {
  /** Whether the subscription is switched on at all. Off (the default): the bot is free for everyone. */
  subscriptions: boolean;
  /** The subscription's length in days. */
  days: number;
  /** A fixed price in QU, or null when the price is a dollar amount that follows the QU price. */
  priceQu: number | null;
  priceUsd: number | null;
  /** When the free launch period ends (ms since epoch), or null when there is none. */
  freeUntil: number | null;
  /** Share of the fees that goes to subscribers, in percent. */
  profitSharePct: number;
  /** What alerts cost for one period (`days`), in QU, or null while they are free. */
  alertsPriceQu: number | null;
}

export function discordPlan(env: Record<string, string | undefined>): DiscordPlan {
  const fixed = Number((env.BOT_SUBSCRIPTION_PRICE_QU ?? "").replace(/[,_]/g, ""));
  const usd = Number(env.BOT_SUBSCRIPTION_USD ?? 1);
  const days = Number(env.BOT_SUB_DAYS ?? 30);
  const free = env.BOT_FREE_UNTIL?.trim() ? Date.parse(env.BOT_FREE_UNTIL.trim()) : NaN;
  const share = Number(env.PROFIT_SHARE_PCT ?? 75);
  return {
    subscriptions: subscriptionsOn(env),
    days: Number.isInteger(days) && days > 0 ? days : 30,
    priceQu: Number.isInteger(fixed) && fixed >= 100 ? fixed : null,
    priceUsd: Number.isFinite(usd) && usd > 0 ? usd : null,
    freeUntil: Number.isFinite(free) ? free : null,
    profitSharePct: Number.isFinite(share) && share >= 0 && share <= 100 ? share : 75,
    alertsPriceQu: alertsPriceQu(env),
  };
}

export interface AgentPlan {
  /** What an agent pays for a Max plan (GET /v1/max), in QU, or null while Max plans are free. */
  maxPriceQu: number | null;
  /** An x402 session (unlimited Max plans for its length): its price in QU and length in seconds, or null where sessions are not sold. */
  sessionPriceQu: number | null;
  sessionSeconds: number | null;
  /** The smallest prepaid top-up in QU (what buys the first plans), or null where nothing is sold. */
  minTopupQu: number | null;
}

const whole = (v: string | undefined, fallback: number): number => {
  const n = Number((v ?? "").replace(/[,_]/g, ""));
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * What agents pay, read from the same settings the API starts with (API_MAX_PRICE_QU, API_SESSION_PRICE_QU, API_SESSION_SECONDS, API_X402, API_ACCESS), so the website's
 * welcome window states the real numbers instead of a copy that goes stale. Sessions exist where something is sold (Max plans, or the whole API in billing mode).
 */
export function agentPlan(env: Record<string, string | undefined>): AgentPlan {
  const maxPriceQu = whole(env.API_MAX_PRICE_QU, 0) || null;
  const selling = maxPriceQu !== null || (env.API_ACCESS ?? "free") === "billing";
  const sessions = selling && env.API_X402 !== "off";
  return {
    maxPriceQu,
    sessionPriceQu: sessions ? whole(env.API_SESSION_PRICE_QU, 10_000) : null,
    sessionSeconds: sessions ? whole(env.API_SESSION_SECONDS, 3600) : null,
    minTopupQu: selling ? whole(env.API_MIN_TOPUP_QU, 10_000) : null,
  };
}

export function plansRoutes(env: Record<string, string | undefined>): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/plans",
      limited: false,
      rate: { perMin: 30 },
      doc: {
        summary: "Is QMax free, and where to send support",
        description:
          "QMax is free for everyone: the website, the API and the Discord bot (`discord.subscriptions` is false). Support is welcome: `support.url` is the Q+Pay tip jar it goes through (null until one is set) and `support.address` is the address QU can also be sent to. If the bot's subscription is ever switched on, `discord` also gives its length in days, its price (a fixed amount of QU, or dollars at the live QU price), when a free period ends (null if there is none) and the share of fees that goes to subscribers.",
        responses: { "200": { description: "{ discord: { subscriptions, days, priceQu, priceUsd, freeUntil, freeNow, profitSharePct }, support: { url, address }, agents: { maxPriceQu, sessionPriceQu, sessionSeconds } }" } },
      },
      handler: () => {
        const p = discordPlan(env);
        return { discord: { ...p, freeNow: p.freeUntil !== null && p.freeUntil > Date.now() }, support: { url: supportUrl(env), address: supportAddress(env) }, agents: agentPlan(env) };
      },
    },
  ];
}
