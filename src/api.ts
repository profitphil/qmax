import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { MarketData } from "./data.ts";
import type { ExecutionHint } from "./exec.ts";
import { findArbitrageVenues } from "./arbitrage.ts";
import { buildBook } from "./book.ts";
import { HOUR, DAY, RANGES, candles as buildCandles, isRange } from "./history.ts";
import type { HistoryStore } from "./history.ts";
import type { X402Gate } from "./x402.ts";
import type { TradeCandle } from "./trades.ts";
import { parseArbQuery } from "./arbfilters.ts";
import type { Meter } from "./meter.ts";
import type { RefLog } from "./refs.ts";
import type { UsageLog } from "./usage.ts";
import { RateLimiter } from "./ratelimit.ts";
import { openapi } from "./openapi.ts";
import { Raw, RouteError, plainNumber } from "./routes.ts";
import type { Route } from "./routes.ts";
import { QswapVenue, QxVenue } from "./venues.ts";
import { OPEN_PAGE_HTML } from "./openpage.ts";
import { RpcBusyError } from "./rpc.ts";
import { buildQuote } from "./quoteapi.ts";
import type { Side } from "./types.ts";

export interface ApiOptions {
  data: MarketData;
  /**
   * Without `meter`: if set, requests must send `x-api-key` with this value.
   * With `meter`: this key is QMax's own (the Discord bot, say) and is never charged.
   */
  apiKey?: string;
  /**
   * The key for the owner's endpoints (subscribers, profit sharing, payouts, usage stats, referral counts). Kept apart from `apiKey` so the
   * Discord bot, which holds `apiKey` and could be tricked or compromised, cannot read them or plan a payout. Without it `apiKey` does both.
   */
  adminKey?: string;
  /** Prepaid per-call billing for other sites. Without it the API is open (or guarded by `apiKey` alone). */
  meter?: Meter;
  /**
   * The API is free for everyone, with no key and no billing. Callers are limited per IP on the market endpoints (`freePerMin`) so one of
   * them cannot swamp the node; QMax's own `apiKey` (the Discord bot) is not limited. With `meter` and no `freeAccess` every metered result is billed;
   * with both, the meter sells only Max quotes (`maxPriceQu`) and everything else stays free.
   */
  freeAccess?: boolean;
  /**
   * What an agent pays for a Max quote (`GET /v1/max`), in QU: taken from a prepaid key's balance once the plan is made (a refusal costs nothing), or nothing for a
   * caller holding an x402 session. 0 or unset: Max quotes are free. Needs `meter` (and `x402` for sessions). QMax's own keys never pay, and neither does the
   * website's own page (see `fromSite`).
   */
  maxPriceQu?: number;
  /** The API's public address, with any path prefix (https://qmax.exchange/api behind nginx): listed in the OpenAPI document as its server, so a client builds URLs that work. */
  publicUrl?: string;
  /** Counts people sent from other sites (`ref`). Without it /v1/ref is not served. */
  refs?: RefLog;
  /** Counts who trades through QMax, checked on-chain. Without it /v1/trade-report and /v1/stats are not served. */
  usage?: UsageLog;
  /** Prices recorded over time. Without it /v1/history is not served. */
  history?: HistoryStore;
  /** Candles of past trades. Without it /v1/candles is not served. */
  trades?: TradeSource;
  /** Extra endpoints that features bring with them (see routes.ts). */
  routes?: Route[];
  /** Sells sessions by x402 (pay QPayhub, present the receipt). Agents use it instead of a key. */
  x402?: X402Gate;
  /** Calls per minute per IP for callers without a key, on metered endpoints. Default 60. */
  freePerMin?: number;
  /**
   * Take the client IP from X-Forwarded-For, behind a proxy you control: `true` (or 1) trusts one proxy hop, a number trusts that many.
   * The address is the one the nearest trusted proxy added (counted from the right), because anything to its left is written by the caller.
   */
  trustProxy?: boolean | number;
  /** Most sockets open at once (default 1024), so a flood of slow or parked requests cannot exhaust file descriptors. */
  maxConnections?: number;
}

class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Endpoints that hit the market data hard, so everyone but QMax itself is rate limited on them (the paid results are billed separately). */
const BASE_LIMITED = new Set(["/v1/quote", "/v1/arbitrage", "/v1/book", "/v1/history", "/v1/candles", "/v1/assets/search"]);

/** Where the API gets candles from (the trade index, matched to the asset list). Returns null for an asset it does not know. */
export interface AssetVolume {
  volume24hQu: number;
  /** QU traded in the last 72 hours. */
  volume72hQu?: number;
  volume7dQu: number;
  trades24h: number;
  /** The price change over 24 hours, in percent; null when there is nothing to measure it against. */
  change24hPct?: number | null;
  /** The same over 72 hours and over 7 days, so the change can follow the window the volume is shown over. */
  change72hPct?: number | null;
  change7dPct?: number | null;
}
export interface TradeSource {
  /** Volume for every listed asset, by upper-case asset id (cached for a minute by the source). */
  volumes?(): Map<string, AssetVolume>;
  /** The newest trade of every listed asset that has one, by upper-case asset id: its price (QU per unit) and when it was (ms). Cached for a few seconds by the source. */
  lasts?(): Map<string, { price: number; ms: number }>;
  candles(assetId: string, q: { venue: "auto" | "QX" | "QSwap" | "all"; intervalMs: number; sinceMs: number; /** Add older QX history from Quhub (marked, unverified) before the archive starts. Only the candle chart asks. */ withImported?: boolean }): { asset: string; venue: "QX" | "QSwap" | "all"; candles: TradeCandle[]; volume24hQu: number; trades24h: number } | null;
}

/** "1 hour", "2 hours", "30 minutes": how long an x402 session lasts, for a sentence. */
const spanOf = (seconds: number) => (seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}` : `${Math.round(seconds / 60)} minutes`);

/**
 * The document's own "Billing:" paragraph describes a server that bills every metered result. A server where everything is free but Max plans (an agent pays `maxPriceQu` for
 * GET /v1/max) says what is true instead, so an agent reading /v1/openapi.json is not told about charges that do not exist, or kept in the dark about the one that does.
 */
type ApiDoc = { info: { description: string }; paths: Record<string, any> } & Record<string, unknown>;
function withBilling(doc: ApiDoc, b: { billing: boolean; maxPriceQu: number; session: { priceQu: number; seconds: number } | null }) {
  if (b.billing && !b.maxPriceQu) return doc;
  const at = doc.info.description.indexOf(" Billing: ");
  const head = at >= 0 ? doc.info.description.slice(0, at) : doc.info.description;
  const session = b.session ? `${b.session.priceQu.toLocaleString("en-US")} QU for ${spanOf(b.session.seconds)} of unlimited plans` : null;
  const max = b.maxPriceQu
    ? `Max plans (GET /v1/max: the best position for a trade, not just the best route) cost ${b.maxPriceQu} QU for agents: taken from a prepaid key's balance once the plan is made (POST /v1/keys, fill it with GET /v1/topup, then POST /v1/topup/claim, and send x-api-key)${session ? `, or free inside an x402 session (see GET /v1/x402): ${session}` : ""}. Without either, GET /v1/max answers 402 with the price${session ? " and an x402 ticket" : ""}. The website's own Max is free. `
    : "";
  const billing = b.billing
    ? ` Billing: only a split quote (a route across both QX and QSwap) costs a prepaid amount when you send an x-api-key, an arbitrage check that finds an opportunity costs its own price, and listings, search and these docs cost nothing. ${max}`
    : ` Billing: everything is free for everyone, no key needed (without QMax's own key the market endpoints are limited per IP and answer 429 past the allowance). ${max}`;
  const keyDoc = (extra: string) => ({ "200": { description: `{ ${extra}balanceQu, ${b.billing ? "splitPriceQu, arbitragePriceQu, " : ""}${b.maxPriceQu ? "maxPriceQu, " : ""}minTopupQu }` } });
  const paths = { ...doc.paths };
  if (paths["/v1/keys"]) paths["/v1/keys"] = { post: { ...paths["/v1/keys"].post, responses: { "201": keyDoc("key, keyId, ")["200"] } } };
  if (paths["/v1/account"]) paths["/v1/account"] = { get: { ...paths["/v1/account"].get, responses: { ...paths["/v1/account"].get.responses, ...keyDoc("keyId, calls, ") } } };
  return { ...doc, info: { ...doc.info, description: (head + billing).trimEnd() }, paths };
}

/** The OpenAPI document with the endpoints that features added. */
function withRoutes(routes: Route[]) {
  if (!routes.length) return openapi;
  const paths: Record<string, Record<string, unknown>> = { ...(openapi.paths as Record<string, Record<string, unknown>>) };
  for (const r of routes.filter((x) => !x.keyed)) paths[r.path] = { ...paths[r.path], [r.method.toLowerCase()]: { ...r.doc, responses: r.doc.responses ?? { "200": { description: "OK" } } } };
  return { ...openapi, paths };
}

/** An address as a rate-limit key: an IPv6 caller can pick any address in its /64, so all of them are one caller. */
export function subnet(addr: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (v4) return v4[1];
  if (!addr.includes(":")) return addr;
  const [head, tail = ""] = addr.split("::");
  const groups = head.split(":").filter(Boolean);
  const rest = tail.split(":").filter(Boolean);
  const full = [...groups, ...Array(Math.max(0, 8 - groups.length - rest.length)).fill("0"), ...rest];
  return full.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function send(res: ServerResponse, status: number, body: unknown) {
  // Turned into text first: a value that cannot be (a BigInt, a circular object) must fail before any header is sent, not after.
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    console.error("A response could not be turned into JSON");
    status = 500;
    text = JSON.stringify({ error: "Internal error" });
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-api-key,x-payment,x-access-grant",
    "access-control-expose-headers": "x-qmax-balance-qu,x-qmax-charged-qu,retry-after,x-payment-response,x-access-grant,x-access-grant-expires,x-access-grant-status",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 10_000) throw new HttpError(413, "Request body too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

export function createApi(opts: ApiOptions): Server {
  const meter = opts.meter;
  const maxPrice = meter ? Math.max(0, Math.floor(opts.maxPriceQu ?? 0)) : 0;
  const freeCalls = new RateLimiter(opts.freePerMin ?? 60, 60_000);
  const newKeys = new RateLimiter(5, 3_600_000);
  const claims = new RateLimiter(30, 60_000);
  const refReports = new RateLimiter(60, 60_000);
  const tradeReports = new RateLimiter(60, 60_000);
  // Even paying callers are capped, because single-venue quotes cost nothing and still use the node.
  const keyed = new RateLimiter((opts.freePerMin ?? 60) * 10, 60_000);
  const hops = opts.trustProxy === true ? 1 : opts.trustProxy || 0;
  const ipOf = (req: IncomingMessage) => {
    const chain = hops ? String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
    // `hops` trusted proxies each appended the address they saw, so the client is `hops` from the right; anything further left is the caller's own claim.
    const fromProxy = chain.length >= hops ? chain[chain.length - hops] : "";
    return subnet(fromProxy || req.socket.remoteAddress || "unknown");
  };
  const limit = (l: RateLimiter, req: IncomingMessage, what: string) => {
    const r = l.hit(ipOf(req));
    if (!r.ok) throw new HttpError(429, `Too many ${what}. Try again in ${r.retryAfterSec}s.`, { retryAfterSec: r.retryAfterSec });
  };
  const headerKey = (req: IncomingMessage) => String(req.headers["x-api-key"] ?? "");
  const sameKey = (req: IncomingMessage, want: string | undefined) => {
    const given = Buffer.from(headerKey(req));
    const own = Buffer.from(want ?? "");
    return own.length > 0 && given.length === own.length && timingSafeEqual(given, own);
  };
  /**
   * Whether the website's own page made this request: a browser says so itself in `Sec-Fetch-Site`, a header a page's script cannot set or change, so another site's
   * page (cross-site) is not mistaken for it. A program outside a browser can send the header too, so this is a soft check: it keeps the site's Max free for people,
   * it is not what protects the money (a Max quote costs little, and an agent that fakes the header only saves that little).
   */
  const fromSite = (req: IncomingMessage) => String(req.headers["sec-fetch-site"] ?? "") === "same-origin";
  /** True only for QMax's own keys (compared in constant time): the bot's, or the owner's. */
  const ownKey = (req: IncomingMessage) => sameKey(req, opts.apiKey) || sameKey(req, opts.adminKey);
  /** The owner's key: `adminKey`, or `apiKey` when no separate one is set. */
  const adminOk = (req: IncomingMessage) => sameKey(req, opts.adminKey ?? opts.apiKey);
  // A wrong key is guessed at by trying: after a few misses from one address it is told to wait, which is also what keeps a weak key usable.
  const badKeys = new RateLimiter(20, 60_000);
  /** Lets QMax's own key through; anyone else gets a 401, and an address that keeps guessing a 429. */
  const requireOwnKey = (req: IncomingMessage, message: string) => {
    if (ownKey(req)) return;
    if (headerKey(req)) limit(badKeys, req, "attempts with a wrong key");
    throw new HttpError(401, message);
  };
  /** Lets only the owner's key through (see `adminKey`). */
  const requireAdminKey = (req: IncomingMessage, message: string) => {
    if (adminOk(req)) return;
    if (headerKey(req)) limit(badKeys, req, "attempts with a wrong key");
    throw new HttpError(401, message);
  };
  const paymentAttempts = new RateLimiter(20, 60_000);
  const x402 = opts.x402;
  /** The address the caller asked for, as the 402 answer should name it. */
  const resourceUrl = (req: IncomingMessage) => (x402?.publicBaseUrl ?? `http://${req.headers.host ?? "localhost"}`).replace(/\/$/, "") + (req.url ?? "/");
  const limitId = (l: RateLimiter, id: string, what: string) => {
    const r = l.hit(id);
    if (!r.ok) throw new HttpError(429, `Too many ${what}. Try again in ${r.retryAfterSec}s.`, { retryAfterSec: r.retryAfterSec });
  };

  // Endpoints that features add are served beside the built-in ones, and limited like them unless they say otherwise.
  const routes = new Map((opts.routes ?? []).map((r) => [`${r.method} ${r.path}`, r]));
  const LIMITED = new Set([...BASE_LIMITED, ...(opts.routes ?? []).filter((r) => r.limited !== false).map((r) => r.path)]);
  const billedDocs = withBilling(withRoutes(opts.routes ?? []), { billing: !!meter && !opts.freeAccess, maxPriceQu: maxPrice, session: x402 ? { priceQu: x402.priceQu, seconds: x402.seconds } : null });
  const docs = /^https?:\/\//.test(opts.publicUrl ?? "") ? { ...billedDocs, servers: [{ url: opts.publicUrl!.replace(/\/+$/, "") }] } : billedDocs;
  const routeLimits = new Map((opts.routes ?? []).filter((r) => r.rate).map((r) => [r.path, new RateLimiter(r.rate!.perMin, 60_000)]));

  const server = createServer(async (req, res) => {
    let caller: { keyId: string; balanceQu: number } | null = null; // set for a customer key
    try {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        throw new HttpError(400, "Bad request address");
      }
      if (req.method === "OPTIONS") return send(res, 204, null);
      if (url.pathname === "/health") return send(res, 200, { ok: true });
      if (url.pathname === "/v1/openapi.json") return send(res, 200, docs);
      if (x402 && url.pathname === "/v1/x402" && req.method === "GET") {
        const billingAll = !!meter && !opts.freeAccess;
        return send(res, 200, {
          ...x402.info(),
          ...(maxPrice > 0 ? { maxQuotePriceQu: maxPrice } : {}),
          covers: billingAll ? "every metered endpoint (the free per-minute limit is lifted)" : "Max plans (GET /v1/max); every other endpoint is free",
          ...(billingAll ? {} : { how: "Call GET /v1/max (or GET /v1/session) without a session; a 402 answer carries the price, a ticket and the exact payment to make. Pay with QPAYHUB.Pay, then retry the same request with an X-PAYMENT header. The reply carries X-ACCESS-GRANT: send it on later calls to GET /v1/max for the rest of the session, with no per-plan charge. Everything else is free without it." }),
        });
      }
      if (url.pathname === "/open" && req.method === "GET") {
        // The wallet-link page: plain HTML, no data in or out. Strict headers so nothing else can run on it or read the link.
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        return void res.end(OPEN_PAGE_HTML);
      }

      // A private API (a key is set, nothing is sold, nothing is free) lets nobody in without the key: this comes before every handler below,
      // including the ones that write (/v1/ref, /v1/trade-report) and are otherwise open.
      if (!meter && !opts.freeAccess && (opts.apiKey || opts.adminKey)) requireOwnKey(req, "Invalid or missing x-api-key");

      if (opts.refs) {
        if (url.pathname === "/v1/ref" && req.method === "POST") {
          limit(refReports, req, "reports");
          const b = (await readBody(req)) as Record<string, unknown>;
          if (!opts.refs.record(b?.ref, b?.event, b?.txIds)) throw new HttpError(400, "ref must be 1-32 letters, digits, - or _, event 'open' or 'trade' (a trade needs transaction ids)");
          return send(res, 200, { ok: true });
        }
        if (url.pathname === "/v1/refs" && req.method === "GET") {
          requireAdminKey(req, "Only QMax's admin key can read referral counts");
          return send(res, 200, opts.refs.summary());
        }
      }

      if (opts.usage) {
        if (url.pathname === "/v1/trade-report" && req.method === "POST") {
          limit(tradeReports, req, "reports");
          const queued = opts.usage.report(await readBody(req), ipOf(req));
          if (queued === null) throw new HttpError(400, `Send { wallet: 60-letter identity, txIds: 1-10 transaction ids (60 lowercase letters), ref?, channel?: "web" | "discord" | "agent" }`);
          return send(res, 202, { ok: true, queued });
        }
        if (url.pathname === "/v1/stats" && req.method === "GET") {
          requireAdminKey(req, "Only QMax's admin key can read usage stats (set ADMIN_KEY, or API_KEY if there is no separate admin key, and send it as x-api-key)");
          const wallet = url.searchParams.get("wallet") ?? undefined;
          if (wallet !== undefined && !/^[A-Z]{60}$/.test(wallet)) throw new HttpError(400, "wallet must be a 60-letter identity");
          const days = url.searchParams.get("days");
          if (days !== null && !(Number.isInteger(plainNumber(days)) && plainNumber(days) >= 1 && plainNumber(days) <= 365)) throw new HttpError(400, "days must be 1 to 365");
          return send(res, 200, wallet ? opts.usage.walletStats(wallet) : opts.usage.stats(days !== null ? { days: plainNumber(days) } : {}));
        }
      }

      // A session (x402): a live access grant, or a payment that buys one right now.
      let session: { subject: string; expiresAt: number } | null = null;
      if (x402 && (LIMITED.has(url.pathname) || url.pathname === "/v1/session")) {
        const grant = String(req.headers["x-access-grant"] ?? "");
        if (grant) {
          const g = x402.checkGrant(grant);
          if (g.valid) session = { subject: g.claims.sub, expiresAt: g.claims.exp };
          else res.setHeader("x-access-grant-status", g.reason); // not an error: the caller can still pay again
        }
        const payment = String(req.headers["x-payment"] ?? "");
        if (!session && payment) {
          // Checking a payment is a few reads from the Qubic node: attempts are limited per address before any of that, tickets being free.
          limit(paymentAttempts, req, "payment attempts");
          const r = await x402.settle(payment);
          if (!r.ok) throw new HttpError(402, r.reason, x402.rejection(resourceUrl(req), r.reason));
          session = { subject: r.payer, expiresAt: r.grant.expiresAt };
          res.setHeader("x-access-grant", r.grant.token);
          res.setHeader("x-access-grant-expires", String(r.grant.expiresAt));
          res.setHeader("x-payment-response", Buffer.from(JSON.stringify(r.response)).toString("base64"));
        }
      }
      if (x402 && url.pathname === "/v1/session") {
        if (!session) throw new HttpError(402, "X-PAYMENT header is required", x402.challenge(resourceUrl(req), "X-PAYMENT header is required"));
        return send(res, 200, { ok: true, expiresAt: session.expiresAt, seconds: x402.seconds, note: "Send the X-ACCESS-GRANT value on later requests until it expires." });
      }

      // With a meter and no free access every metered result is billed. With free access too the meter only sells Max quotes: keys and top-ups work, nothing else is charged.
      const billing = !!meter && !opts.freeAccess;
      let maxKey: string | null = null; // the prepaid key a Max quote is charged to once the plan is made
      let maxPaid = false;
      if (meter) {
        const pricing = billing ? { splitPriceQu: meter.splitPriceQu, arbitragePriceQu: meter.arbitragePriceQu, minTopupQu: meter.minTopupQu } : { maxPriceQu: maxPrice, minTopupQu: meter.minTopupQu };
        if (url.pathname === "/v1/keys" && req.method === "POST") {
          limit(newKeys, req, "new keys");
          const k = meter.createKey();
          return send(res, 201, { ...k, balanceQu: 0, ...pricing, note: "Keep the key secret: it is shown once. Fill its balance with GET /v1/topup, then POST /v1/topup/claim." });
        }
        if (url.pathname === "/v1/account" && req.method === "GET") {
          const found = meter.find(headerKey(req));
          if (!found) throw new HttpError(401, "Invalid or missing x-api-key");
          return send(res, 200, { keyId: found.keyId, balanceQu: found.account.balanceQu, calls: found.account.calls, ...pricing });
        }
        if (url.pathname === "/v1/topup" && req.method === "GET") {
          const keyId = url.searchParams.get("keyId") ?? "";
          const amountQu = plainNumber(url.searchParams.get("amountQu"));
          const nonce = url.searchParams.get("nonce");
          try {
            return send(res, 200, meter.topup(keyId, amountQu, nonce && /^\d{1,19}$/.test(nonce) ? BigInt(nonce) : undefined));
          } catch (e) {
            throw new HttpError(400, e instanceof Error ? e.message : String(e));
          }
        }
        if (url.pathname === "/v1/topup/claim" && req.method === "POST") {
          limit(claims, req, "claims");
          const body = (await readBody(req)) as Record<string, unknown>;
          const r = await meter.claim({ keyId: String(body?.keyId ?? ""), payer: String(body?.payer ?? ""), nonce: String(body?.nonce ?? "") });
          if (!r.ok) throw new HttpError(400, r.reason);
          return send(res, 200, r);
        }

        const key = headerKey(req);
        if (!billing) {
          // the meter only sells Max quotes here (below)
        } else if (session) {
          // paid by x402: no per-call charge, a higher limit that follows the payer rather than the address
          if (LIMITED.has(url.pathname)) limitId(keyed, `session:${session.subject}`, "requests");
        } else if (key && key === opts.apiKey) {
          // QMax's own key: never charged or limited
        } else if (key) {
          const found = meter.find(key);
          if (!found) throw new HttpError(401, "Invalid or missing x-api-key");
          if (LIMITED.has(url.pathname)) limit(keyed, req, "requests");
          caller = { keyId: found.keyId, balanceQu: found.account.balanceQu };
        } else if (LIMITED.has(url.pathname)) {
          try {
            limit(freeCalls, req, "requests without a key");
          } catch (e) {
            if (e instanceof HttpError && e.status === 429) {
              // Where an agent can pay, the answer is a 402 it knows how to act on; otherwise the plain limit message.
              if (x402) {
                const why = `${e.message} Buy a session by x402 (see GET /v1/x402), or prepay with a key (POST /v1/keys).`;
                throw new HttpError(402, why, { ...x402.challenge(resourceUrl(req), why), retryAfterSec: e.extra.retryAfterSec });
              }
              e.message += " Create a key with POST /v1/keys and prepay for unlimited split quotes.";
            }
            throw e;
          }
        }
      }

      // Max quotes are sold to agents. QMax's own keys and the website's own page never pay. An agent pays from a prepaid key's balance (taken after the plan is made,
      // so a refused request costs nothing) or holds an x402 session; anyone else is told the price and the ways to pay.
      if (maxPrice > 0 && meter && url.pathname === "/v1/max" && req.method === "GET" && !ownKey(req) && !fromSite(req)) {
        const key = headerKey(req);
        if (session) {
          limitId(keyed, `session:${session.subject}`, "requests");
          maxPaid = true;
        } else if (key) {
          const found = meter.find(key);
          if (!found) throw new HttpError(401, "Invalid or missing x-api-key");
          limit(keyed, req, "requests");
          if (found.account.balanceQu < maxPrice)
            throw new HttpError(402, `Prepaid balance too low: a Max quote costs ${maxPrice} QU. Top up with GET /v1/topup.`, { balanceQu: found.account.balanceQu, priceQu: maxPrice });
          maxKey = found.keyId;
          maxPaid = true;
        } else {
          const why = `A Max quote costs ${maxPrice} QU for agents. Prepay a key (POST /v1/keys, then GET /v1/topup and POST /v1/topup/claim)${x402 ? " or buy a session by x402 (GET /v1/x402)" : ""}. The website's own Max is free.`;
          throw new HttpError(402, why, { priceQu: maxPrice, ...(x402 ? x402.challenge(resourceUrl(req), why) : {}) });
        }
      }

      if (!billing) {
        if (opts.freeAccess) {
          // Free for everyone. Only QMax's own key (and a paid Max caller) skips the per-IP limit; any other key is simply ignored.
          if (LIMITED.has(url.pathname) && !ownKey(req) && !maxPaid) limit(freeCalls, req, "requests");
        } else if ((opts.apiKey || opts.adminKey) && !ownKey(req)) {
          throw new HttpError(401, "Invalid or missing x-api-key");
        }
      }

      const route = routes.get(`${req.method} ${url.pathname}`);
      if (route) {
        if (route.keyed) requireAdminKey(req, "Only QMax's admin key can use this endpoint (set ADMIN_KEY, or API_KEY if there is no separate admin key, and send it as x-api-key)");
        const own = routeLimits.get(route.path);
        if (own && !route.keyed) limit(own, req, "requests");
        try {
          const out = await route.handler({ query: url.searchParams, body: route.method === "POST" ? await readBody(req) : undefined });
          if (maxKey && meter) {
            // charged only now, for a plan that was made; if the balance was spent by another request meanwhile, the plan is not handed over
            if (!meter.charge(maxKey, maxPrice)) throw new HttpError(402, `Prepaid balance too low: a Max quote costs ${maxPrice} QU. Top up with GET /v1/topup.`, { priceQu: maxPrice });
            res.setHeader("x-qmax-charged-qu", String(maxPrice));
            res.setHeader("x-qmax-balance-qu", String(meter.info(maxKey)?.balanceQu ?? 0));
          }
          if (out instanceof Raw) {
            res.writeHead(200, {
              "content-type": out.contentType,
              "access-control-allow-origin": "*",
              ...(out.filename ? { "content-disposition": `attachment; filename="${out.filename.replace(/[^\w.-]/g, "_")}"` } : {}),
            });
            return void res.end(out.body);
          }
          return send(res, 200, out);
        } catch (e) {
          if (e instanceof RouteError) throw new HttpError(e.status, e.message, e.extra);
          throw e;
        }
      }

      if (url.pathname === "/v1/assets" && req.method === "GET") {
        const category = url.searchParams.get("category");
        if (category && category !== "contract" && category !== "token") throw new HttpError(400, "category must be 'contract' or 'token'");
        const order = url.searchParams.get("sort") ?? "volume";
        if (order !== "volume" && order !== "liquidity") throw new HttpError(400, "sort must be 'volume' or 'liquidity'");
        if (opts.data.listAssets) {
          const r = opts.data.listAssets({ category: (category as "contract" | "token" | null) ?? undefined, q: url.searchParams.get("q") ?? undefined });
          // Each asset carries what it traded in the last day and week, and by default the list is the busiest first: most QU traded in 24 hours, then
          // in 7 days, then (for the many that did not trade) the most liquid. `sort=liquidity` keeps the old order.
          const volumes = opts.trades?.volumes?.();
          if (!volumes) return send(res, 200, r);
          const lasts = opts.trades?.lasts?.();
          const withVolume = r.assets.map((a) => {
            const last = lasts?.get(a.id.toUpperCase());
            return { ...a, ...(volumes.get(a.id.toUpperCase()) ?? { volume24hQu: 0, volume72hQu: 0, volume7dQu: 0, trades24h: 0, change24hPct: null, change72hPct: null, change7dPct: null }), ...(last ? { lastPriceQu: last.price, lastTradeAt: last.ms } : {}) };
          });
          if (order === "volume") withVolume.sort((a, b) => b.volume24hQu - a.volume24hQu || b.volume7dQu - a.volume7dQu); // a stable sort: ties stay most liquid first
          return send(res, 200, { ...r, assets: withVolume });
        }
        return send(res, 200, { assets: opts.data.assets().map((id) => ({ id, symbol: id })), ready: true });
      }
      if (url.pathname === "/v1/arbitrage" && req.method === "GET") {
        const asset = (url.searchParams.get("asset") ?? "").trim();
        if (!asset) throw new HttpError(400, "asset is required");
        const venues = await opts.data.venues(asset);
        if (!venues) throw new HttpError(404, `Unknown asset '${asset}'`);
        const qx = venues.find((v) => v.name === "QX");
        const qswap = venues.find((v) => v.name === "QSwap");
        const checkedAt = new Date().toISOString();
        if (!qx || !qswap) return send(res, 200, { asset, checkedAt, bothMarkets: false, opportunity: null });
        let filters;
        try {
          filters = parseArbQuery(url.searchParams);
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
        const opportunity = findArbitrageVenues(qx, qswap, filters);
        // Only an arbitrage that is actually found is billed; "none right now" is free.
        if (meter && caller) {
          if (opportunity && !meter.charge(caller.keyId, meter.arbitragePriceQu))
            throw new HttpError(402, `Prepaid balance too low: an arbitrage result costs ${meter.arbitragePriceQu} QU. Top up with GET /v1/topup.`, {
              balanceQu: caller.balanceQu,
              priceQu: meter.arbitragePriceQu,
              opportunityProfitQu: Math.round(opportunity.profitQu),
            });
          res.setHeader("x-qmax-charged-qu", String(opportunity ? meter.arbitragePriceQu : 0));
          res.setHeader("x-qmax-balance-qu", String(meter.info(caller.keyId)?.balanceQu ?? 0));
        }
        return send(res, 200, { asset, checkedAt, bothMarkets: true, opportunity });
      }
      if (url.pathname === "/v1/book" && req.method === "GET") {
        const asset = (url.searchParams.get("asset") ?? "").trim();
        if (!asset) throw new HttpError(400, "asset is required");
        const levels = plainNumber(url.searchParams.get("levels") ?? 15);
        if (!Number.isInteger(levels) || levels < 1 || levels > 50) throw new HttpError(400, "levels must be a whole number from 1 to 50");
        const venues = await opts.data.venues(asset);
        if (!venues) throw new HttpError(404, `Unknown asset '${asset}'`);
        const view = buildBook(venues.find((v): v is QxVenue => v instanceof QxVenue), venues.find((v): v is QswapVenue => v instanceof QswapVenue), { levels });
        return send(res, 200, { asset: asset.toUpperCase(), checkedAt: new Date().toISOString(), ...view });
      }
      if (url.pathname === "/v1/history" && req.method === "GET") {
        if (!opts.history) throw new HttpError(404, "Price history is not recorded on this server");
        const asset = (url.searchParams.get("asset") ?? "").trim();
        if (!asset) throw new HttpError(400, "asset is required");
        const range = url.searchParams.get("range") ?? "7d";
        if (!isRange(range)) throw new HttpError(400, `range must be one of ${Object.keys(RANGES).join(", ")}`);
        const intervals: Record<string, number> = { "1h": HOUR, "4h": 4 * HOUR, "1d": DAY };
        const interval = url.searchParams.get("interval");
        if (interval && !Object.hasOwn(intervals, interval)) throw new HttpError(400, `interval must be one of ${Object.keys(intervals).join(", ")}`);
        // the id as recorded, matched without regard to case ("cfb" finds "CFB")
        const key = opts.history.assets().find((a) => a.toUpperCase() === asset.toUpperCase()) ?? asset;
        const full = opts.history.series(key, RANGES[range], Date.now(), interval ? 100_000 : 400);
        return send(res, 200, { asset: key, range, since: opts.history.since(key), recordedSince: opts.history.recordedSince(key), points: full, ...(interval ? { candles: buildCandles(full, intervals[interval]) } : {}) });
      }
      if (url.pathname === "/v1/candles" && req.method === "GET") {
        if (!opts.trades) throw new HttpError(404, "Trade history is not available on this server");
        const asset = (url.searchParams.get("asset") ?? "").trim();
        if (!asset) throw new HttpError(400, "asset is required");
        const range = url.searchParams.get("range") ?? "7d";
        if (!isRange(range)) throw new HttpError(400, `range must be one of ${Object.keys(RANGES).join(", ")}`);
        const MIN = 60_000;
        const widths: Record<string, number> = { "1m": MIN, "5m": 5 * MIN, "15m": 15 * MIN, "30m": 30 * MIN, "1h": HOUR, "4h": 4 * HOUR, "1d": DAY };
        // A sensible width for the range unless one is asked for: about 24 to 200 candles. (Finer widths are asked for by name.)
        const interval = url.searchParams.get("interval") ?? { "1d": "1h", "7d": "1h", "30d": "4h", "90d": "1d", all: "1d" }[range]!;
        if (!Object.hasOwn(widths, interval)) throw new HttpError(400, `interval must be one of ${Object.keys(widths).join(", ")}`);
        const venue = url.searchParams.get("venue") ?? "auto";
        if (venue !== "auto" && venue !== "QX" && venue !== "QSwap" && venue !== "all") throw new HttpError(400, "venue must be auto, QX, QSwap or all");
        const span = RANGES[range];
        const found = opts.trades.candles(asset, { venue, intervalMs: widths[interval], sinceMs: span === null ? 0 : Date.now() - span, withImported: true });
        if (!found) throw new HttpError(404, `Unknown asset '${asset}'`);
        // One answer is at most the latest 5,000 candles (a minute-wide chart of a long range would otherwise be the whole history): `truncated` says so.
        const MAX_CANDLES = 5000;
        const truncated = found.candles.length > MAX_CANDLES;
        return send(res, 200, { asset: found.asset, range, interval, venue: found.venue, candles: truncated ? found.candles.slice(-MAX_CANDLES) : found.candles, ...(truncated ? { truncated: true, available: found.candles.length } : {}), volume24hQu: found.volume24hQu, trades24h: found.trades24h });
      }
      if (url.pathname === "/v1/assets/search" && req.method === "GET") {
        const name = (url.searchParams.get("name") ?? "").trim();
        if (!/^[A-Za-z0-9]{1,7}$/.test(name)) throw new HttpError(400, "name must be 1-7 letters or digits");
        return send(res, 200, { assets: (await opts.data.searchAssets?.(name)) ?? [] });
      }
      if (url.pathname === "/v1/quote") {
        let input: Record<string, unknown>;
        if (req.method === "GET") input = Object.fromEntries(url.searchParams);
        else if (req.method === "POST") {
          const body = await readBody(req);
          if (typeof body !== "object" || body === null) throw new HttpError(400, "Body must be a JSON object");
          input = body as Record<string, unknown>;
        } else throw new HttpError(405, "Use GET or POST");
        const result = await buildQuote(opts.data, input);
        // Only a split across both venues is billed: that is the part nobody gets from QX or QSwap alone.
        if (meter && caller) {
          const split = result.route.length > 1;
          if (split && !meter.charge(caller.keyId, meter.splitPriceQu)) {
            const singles = result.alternatives.filter((a) => a.fillable && a.totalQu !== null).map((a) => a.totalQu!);
            const best = singles.length ? (result.side === "buy" ? Math.min(...singles) : Math.max(...singles)) : null;
            throw new HttpError(402, `Prepaid balance too low: a split quote costs ${meter.splitPriceQu} QU. Top up with GET /v1/topup.`, {
              balanceQu: caller.balanceQu,
              priceQu: meter.splitPriceQu,
              splitWouldSaveQu: best === null ? null : Math.round(Math.abs(best - result.totalQu)),
            });
          }
          res.setHeader("x-qmax-charged-qu", String(split ? meter.splitPriceQu : 0));
          res.setHeader("x-qmax-balance-qu", String(meter.info(caller.keyId)?.balanceQu ?? 0));
        }
        return send(res, 200, result);
      }
      throw new HttpError(404, "Not found");
    } catch (err) {
      if (res.headersSent) {
        // Something failed after the answer began: there is nothing sensible left to say, and writing again would throw out of this handler.
        console.error(err);
        return void res.destroy();
      }
      if (err instanceof RpcBusyError) {
        res.setHeader("retry-after", String(Math.min(60, err.retryAfterSec)));
        return send(res, 503, { error: err.message, retryAfterSec: Math.min(60, err.retryAfterSec) });
      }
      const e = err instanceof RouteError ? new HttpError(err.status, err.message, err.extra) : err;
      if (e instanceof HttpError) {
        if (e.extra.retryAfterSec !== undefined || e.status === 429) res.setHeader("retry-after", String(e.extra.retryAfterSec ?? 60));
        return send(res, e.status, { error: e.message, ...e.extra });
      }
      console.error(e);
      send(res, 500, { error: "Internal error" });
    }
  });
  // Slow, parked or flooding connections: bounded in number and in how long they may idle or take to send a request.
  server.maxConnections = opts.maxConnections ?? 1024;
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 120_000;
  return server;
}
