import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isObject, readJsonFile, writeJsonFile } from "./safefile.ts";
import { bytesToHex, hexToBytes, identityToBytes } from "./identity.ts";
import { computeReceiptKey, getReceipt } from "./qpay.ts";
import type { FullReceipt } from "./qpay.ts";
import type { QubicRpc } from "./rpc.ts";

/**
 * x402 on Qubic, in the wire format of Q+Pay: an HTTP 402 answer says what to pay, the buyer pays QPAYHUB.Pay
 * on-chain, and retries with an X-PAYMENT header that points at the receipt. QMax sells one thing this way: a
 * session, a stretch of time with a higher rate limit and no per-call charge, which suits agents that make many calls.
 */
export const X402_VERSION = 2;
export const SCHEME = "exact";
/** Qubic is not in the CAIP-2 registry yet, so this is Q+Pay's own identifier. */
export const NETWORK = "qubic:mainnet";
export const ASSET = "QUBIC";
/** QPayhub's identity (contract 29): where a payment settled through the contract is sent. */
export const QPAYHUB_IDENTITY = "DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH";
export const SESSION_RESOURCE_ID = "qmax:session:v1";
/** Seconds per tick, used only to turn "paid within N seconds" into ticks. Measured on mainnet in October 2026: 0.55 s, steady from 200 to 20,000 ticks. */
const TICK_SECONDS = 0.55;

/** The 32 bytes QPayhub files a resource under: the SHA-256 of its name. */
export const resourceTag = (id: string): Uint8Array => new Uint8Array(createHash("sha256").update(id, "utf8").digest());

// ---------------------------------------------------------------------------------------------- secrets

export interface Secrets {
  /** Signs payment tickets. */
  ticket: string;
  /** Signs session grants. */
  grant: string;
}

/**
 * The keys that sign tickets and grants. Taken from X402_TICKET_SECRET and X402_GRANT_SECRET; if either is missing a random
 * one is made and kept in `file`, so sessions survive a restart.
 */
export function loadSecrets(file?: string, env: Record<string, string | undefined> = process.env): Secrets {
  let stored: Partial<Secrets> = {};
  if (file) {
    const read = readJsonFile<Partial<Secrets>>(file, isObject);
    if (read) stored = { ticket: typeof read.ticket === "string" ? read.ticket : undefined, grant: typeof read.grant === "string" ? read.grant : undefined };
  }
  const make = () => randomBytes(32).toString("hex");
  // One secret set in the environment serves for both, as in Q+Pay; set both, and different, for a real deployment.
  const envTicket = env.X402_TICKET_SECRET || env.X402_GRANT_SECRET;
  const envGrant = env.X402_GRANT_SECRET || env.X402_TICKET_SECRET;
  const secrets = { ticket: envTicket || stored.ticket || make(), grant: envGrant || stored.grant || make() };
  // Only what did not come from the environment needs keeping.
  const keep = { ticket: envTicket ? stored.ticket : secrets.ticket, grant: envGrant ? stored.grant : secrets.grant };
  if (file && (keep.ticket !== stored.ticket || keep.grant !== stored.grant)) {
    writeJsonFile(file, keep);
  }
  return secrets;
}

const b64u = (x: string | Buffer) => Buffer.from(x).toString("base64url");
const sign = (payloadB64: string, secret: string) => createHmac("sha256", secret).update(payloadB64).digest("base64url");
const sameSig = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function openToken<T>(token: unknown, secret: string): { ok: true; claims: T } | { ok: false; reason: "malformed" | "bad_signature" } {
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const payload = token.slice(0, dot);
  if (!sameSig(token.slice(dot + 1), sign(payload, secret))) return { ok: false, reason: "bad_signature" };
  try {
    return { ok: true, claims: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

// ---------------------------------------------------------------------------------------------- tickets

export interface TicketClaims {
  v: "pt1";
  sellerId: string;
  resourceId: string;
  amount: string;
  /** 8 random bytes in hex: the buyer must put exactly this on-chain as the payment's nonce. */
  nonce: string;
  iat: number;
  exp: number;
}

/**
 * A ticket is handed out in the 402 answer, before any payment exists, with a random nonce only that caller has seen. The
 * buyer has to use that nonce in the on-chain payment, so a stranger who spots the payment on the chain cannot redeem it.
 */
export function issueTicket(p: { sellerId: string; resourceId: string; amount: string; seconds?: number }, secret: string, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const claims: TicketClaims = { v: "pt1", sellerId: p.sellerId, resourceId: p.resourceId, amount: p.amount, nonce: randomBytes(8).toString("hex"), iat, exp: iat + Math.max(1, Math.floor(p.seconds ?? 600)) };
  const payload = b64u(JSON.stringify(claims));
  return { token: `${payload}.${sign(payload, secret)}`, nonceHex: claims.nonce, expiresAt: claims.exp };
}

export type TicketCheck = { valid: true; claims: TicketClaims } | { valid: false; reason: string };

export function verifyTicket(token: unknown, expect: { sellerId: string; resourceId: string; amount: string }, secret: string, now = Date.now()): TicketCheck {
  if (token === undefined || token === null || token === "") return { valid: false, reason: "ticket_missing" };
  const opened = openToken<TicketClaims>(token, secret);
  if (!opened.ok) return { valid: false, reason: opened.reason === "bad_signature" ? "ticket_bad_signature" : "ticket_malformed" };
  const c = opened.claims;
  if (c.v !== "pt1" || typeof c.nonce !== "string" || !/^[0-9a-f]{16}$/.test(c.nonce)) return { valid: false, reason: "ticket_malformed" };
  if (c.exp <= Math.floor(now / 1000)) return { valid: false, reason: "ticket_expired" };
  if (c.sellerId !== expect.sellerId || c.resourceId !== expect.resourceId || c.amount !== expect.amount) return { valid: false, reason: "ticket_mismatch" };
  return { valid: true, claims: c };
}

// ---------------------------------------------------------------------------------------------- grants

export interface GrantClaims {
  v: "ag1";
  /** Who paid (the payer's key, in hex). */
  sub: string;
  rid: string;
  /** The receipt that bought it. */
  ref: string;
  iat: number;
  exp: number;
}

export function issueGrant(p: { subject: string; resourceId: string; seconds: number; reference: string }, secret: string, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const claims: GrantClaims = { v: "ag1", sub: p.subject, rid: p.resourceId, ref: p.reference, iat, exp: iat + Math.max(1, Math.floor(p.seconds)) };
  const payload = b64u(JSON.stringify(claims));
  return { token: `${payload}.${sign(payload, secret)}`, expiresAt: claims.exp };
}

export type GrantCheck = { valid: true; claims: GrantClaims } | { valid: false; reason: string };

export function verifyGrant(token: unknown, resourceId: string, secret: string, now = Date.now()): GrantCheck {
  if (typeof token !== "string" || !token) return { valid: false, reason: "grant_missing" };
  const opened = openToken<GrantClaims>(token, secret);
  if (!opened.ok) return { valid: false, reason: opened.reason === "bad_signature" ? "grant_bad_signature" : "grant_malformed" };
  const c = opened.claims;
  if (c.v !== "ag1") return { valid: false, reason: "grant_malformed" };
  if (c.exp <= Math.floor(now / 1000)) return { valid: false, reason: "grant_expired" };
  if (c.rid !== resourceId) return { valid: false, reason: "grant_wrong_resource" };
  return { valid: true, claims: c };
}

// ---------------------------------------------------------------------------------------------- replay ledger

/** Payments already used to buy something. A receipt on QPayhub proves a payment; this makes sure it buys only once. */
export class UsedLedger {
  private used = new Map<string, number>();
  private file?: string;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(file?: string, now = Date.now()) {
    this.file = file;
    if (file) {
      // A file that cannot be read is moved aside, not replaced by an empty one: this is what stops a payment buying twice.
      const raw = readJsonFile<Record<string, number>>(file, isObject);
      // QPayhub forgets receipts after two epochs, so a payment older than that cannot be presented again anyway.
      if (raw) for (const [k, t] of Object.entries(raw)) if (typeof t === "number" && now - t < 21 * 86_400_000) this.used.set(k, t);
    }
  }

  has(reference: string): boolean {
    return this.used.has(reference);
  }

  /** Marks a payment used. False if it already was. */
  claim(reference: string, now = Date.now()): boolean {
    if (this.used.has(reference)) return false;
    this.used.set(reference, now);
    this.saveSoon();
    return true;
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    writeJsonFile(this.file, Object.fromEntries(this.used));
  }

  private saveSoon() {
    if (this.timer || !this.file) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref();
  }
}

// ---------------------------------------------------------------------------------------------- chain access

export interface ChainTx {
  sourceId: string;
  destId: string;
  amount: string;
  moneyFlew: boolean;
}

/** What the payment check needs to read from the network. */
export interface ChainReader {
  receiptKey(payer: Uint8Array, seller: Uint8Array, resourceId: Uint8Array, nonce: bigint): Promise<Uint8Array | null>;
  getReceipt(key: Uint8Array): Promise<FullReceipt | null>;
  transaction(txId: string): Promise<ChainTx | null>;
  tick(): Promise<number>;
}

export function rpcChain(rpc: QubicRpc, baseUrl = "https://rpc.qubic.org", fetchFn: typeof fetch = fetch): ChainReader {
  const base = baseUrl.replace(/\/$/, "");
  const json = async (path: string) => {
    const res = await fetchFn(base + path, { signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as any) : null;
  };
  return {
    receiptKey: (payer, seller, resourceId, nonce) => computeReceiptKey(rpc, payer, seller, resourceId, nonce),
    getReceipt: (key) => getReceipt(rpc, key),
    async transaction(txId) {
      const j = await json(`/v2/transactions/${txId}`);
      return j?.transaction ? { sourceId: j.transaction.sourceId, destId: j.transaction.destId, amount: String(j.transaction.amount), moneyFlew: j.moneyFlew === true } : null;
    },
    async tick() {
      const j = await json("/live/v1/tick-info");
      if (!j?.tickInfo?.tick) throw new Error("no tick");
      return Number(j.tickInfo.tick);
    },
  };
}

// ---------------------------------------------------------------------------------------------- the payment check

export interface PaymentRequirements {
  scheme: typeof SCHEME;
  network: typeof NETWORK;
  /** QU, as a string, like every x402 amount. */
  amount: string;
  asset: typeof ASSET;
  /** Where the payment is sent: QPayhub, which keeps its fee and forwards the rest to the seller. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { sellerId: string; resourceId: string; settlement: "contract"; grantSeconds?: number; note?: string };
}

const TX_ID = /^[a-z]{60}$/;
const REF = /^[0-9a-fA-F]{64}$/;

export type Verified = { ok: true; payer: string; reference: string; amountQu: number; tick: number } | { ok: false; reason: string };

/**
 * Reads QPayhub's receipt and checks it is the payment this challenge asked for: the right seller, resource and amount, not
 * marked used, carrying the nonce from this caller's ticket, and recent. The payer hands in either the receipt key or just the
 * transaction id (the key is then worked out from the transaction and the ticket). "invalid_transaction_state" means the
 * network has not caught up yet, and the buyer should try again in a moment.
 */
export async function verifyPayment(p: { payload: any; req: PaymentRequirements; expectedNonceHex: string; chain: ChainReader; ledger: UsedLedger }): Promise<Verified> {
  const { req, chain } = p;
  const raw = p.payload?.reference ?? p.payload?.txHash;
  const sellerBytes = identityToBytes(req.extra.sellerId);
  const tag = resourceTag(req.extra.resourceId);
  const nonce = Buffer.from(p.expectedNonceHex, "hex").readBigUInt64LE(0);

  let key: Uint8Array | null = null;
  if (typeof raw === "string" && REF.test(raw)) key = hexToBytes(raw.toLowerCase());
  else if (typeof raw === "string" && TX_ID.test(raw)) {
    let tx;
    try {
      tx = await chain.transaction(raw);
    } catch {
      return { ok: false, reason: "invalid_transaction_state" };
    }
    if (!tx || !tx.moneyFlew) return { ok: false, reason: "invalid_transaction_state" };
    if (tx.destId !== req.payTo) return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch" };
    try {
      key = await chain.receiptKey(identityToBytes(tx.sourceId), sellerBytes, tag, nonce);
    } catch {
      return { ok: false, reason: "invalid_transaction_state" };
    }
    if (!key) return { ok: false, reason: "invalid_transaction_state" };
  }
  if (!key) return { ok: false, reason: "invalid_payload" };

  const reference = bytesToHex(key);
  if (p.ledger.has(reference)) return { ok: false, reason: "payment_already_used" };

  let receipt: FullReceipt | null;
  try {
    receipt = await chain.getReceipt(key);
  } catch {
    return { ok: false, reason: "invalid_transaction_state" };
  }
  if (!receipt) return { ok: false, reason: "invalid_transaction_state" };
  if (bytesToHex(receipt.seller) !== bytesToHex(sellerBytes) || bytesToHex(receipt.resourceId) !== bytesToHex(tag)) return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch" };
  if (BigInt(receipt.amountPaid) !== BigInt(req.amount)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_value_mismatch" };
  if (receipt.consumed) return { ok: false, reason: "payment_already_used" };
  if (receipt.nonce !== nonce) return { ok: false, reason: "invalid_payment_nonce_mismatch" };
  let tick: number;
  try {
    tick = await chain.tick();
  } catch {
    return { ok: false, reason: "invalid_transaction_state" };
  }
  if (tick - receipt.tickPaid > Math.ceil(req.maxTimeoutSeconds / TICK_SECONDS)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before" };
  return { ok: true, payer: bytesToHex(receipt.payer), reference, amountQu: receipt.amountPaid, tick: receipt.tickPaid };
}

// ---------------------------------------------------------------------------------------------- the gate

export interface GateOptions {
  /** QU one session costs. QPayhub refuses payments under 100 QU and its fee floor dominates below about 13,000 QU, so keep this well above that. */
  priceQu: number;
  seconds: number;
  /** Who is paid. */
  sellerId: string;
  chain: ChainReader;
  ledger: UsedLedger;
  secrets: Secrets;
  payTo?: string;
  resourceId?: string;
  /** This server's public address, for the resource address in a challenge. Without it the request's own Host is used. */
  publicBaseUrl?: string;
  maxTimeoutSeconds?: number;
  now?: () => number;
}

export type Settled = { ok: true; payer: string; reference: string; grant: { token: string; expiresAt: number }; response: Record<string, unknown> } | { ok: false; reason: string };

/** Sells sessions by x402: builds the 402 challenge, checks the payment that comes back, and recognises the session afterwards. */
export class X402Gate {
  readonly priceQu: number;
  readonly seconds: number;
  readonly resourceId: string;
  readonly sellerId: string;
  readonly payTo: string;
  readonly publicBaseUrl?: string;
  private o: GateOptions;

  constructor(o: GateOptions) {
    if (!Number.isInteger(o.priceQu) || o.priceQu < 100) throw new Error("The session price must be a whole number of QU, at least 100 (QPayhub's minimum).");
    if (!Number.isInteger(o.seconds) || o.seconds < 1) throw new Error("The session length must be a whole number of seconds.");
    this.o = o;
    this.priceQu = o.priceQu;
    this.seconds = o.seconds;
    this.resourceId = o.resourceId ?? SESSION_RESOURCE_ID;
    this.sellerId = o.sellerId;
    this.payTo = o.payTo ?? QPAYHUB_IDENTITY;
    this.publicBaseUrl = o.publicBaseUrl;
  }

  private now() {
    return this.o.now ? this.o.now() : Date.now();
  }

  requirements(): PaymentRequirements {
    return {
      scheme: SCHEME,
      network: NETWORK,
      amount: String(this.priceQu),
      asset: ASSET,
      payTo: this.payTo,
      maxTimeoutSeconds: this.o.maxTimeoutSeconds ?? 300,
      extra: {
        sellerId: this.sellerId,
        resourceId: this.resourceId,
        settlement: "contract",
        grantSeconds: this.seconds,
        note: "Pay with QPAYHUB.Pay (inputType 1): seller = sellerId, resource = sha256(resourceId), nonce = the ticket's nonce, amount exactly as stated. Then retry with X-PAYMENT.",
      },
    };
  }

  /** The 402 body: what to pay and a fresh ticket. `url` is the address the buyer asked for. */
  challenge(url: string, error: string): Record<string, unknown> {
    const req = this.requirements();
    const ticket = issueTicket({ sellerId: this.sellerId, resourceId: this.resourceId, amount: req.amount }, this.o.secrets.ticket, this.now());
    return {
      x402Version: X402_VERSION,
      error,
      resource: { url, description: `QMax session: ${this.seconds / 60} minutes of higher rate limits, no per-call charge`, mimeType: "application/json" },
      accepts: [req],
      paymentTicket: ticket.token,
      paymentTicketField: "paymentPayload.payload.ticket",
      extensions: {},
    };
  }

  /** The same 402 body for an error after a payment attempt: no new ticket, so the buyer keeps the one they paid against. */
  rejection(url: string, error: string): Record<string, unknown> {
    return { x402Version: X402_VERSION, error, resource: { url, description: "QMax session", mimeType: "application/json" }, accepts: [this.requirements()], extensions: {} };
  }

  /** Checks an X-PAYMENT header and, if it holds a valid, unused payment, sells the session. */
  async settle(header: string): Promise<Settled> {
    let payment: any;
    try {
      payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      return { ok: false, reason: "invalid_payload" };
    }
    if (!payment || typeof payment !== "object" || typeof payment.payload !== "object" || payment.payload === null) return { ok: false, reason: "invalid_payload" };
    const accepted = payment.accepted;
    if (!accepted || accepted.scheme !== SCHEME || accepted.network !== NETWORK) return { ok: false, reason: "invalid_network" };

    const req = this.requirements();
    const ticket = verifyTicket(payment.payload.ticket, { sellerId: this.sellerId, resourceId: this.resourceId, amount: req.amount }, this.o.secrets.ticket, this.now());
    if (!ticket.valid) return { ok: false, reason: ticket.reason };

    const verified = await verifyPayment({ payload: payment.payload, req, expectedNonceHex: ticket.claims.nonce, chain: this.o.chain, ledger: this.o.ledger });
    if (!verified.ok) return verified;
    // The receipt proves the payment happened; this makes it buy one session only, even if two requests race.
    if (!this.o.ledger.claim(verified.reference, this.now())) return { ok: false, reason: "payment_already_used" };

    const grant = issueGrant({ subject: verified.payer, resourceId: this.resourceId, seconds: this.seconds, reference: verified.reference }, this.o.secrets.grant, this.now());
    return {
      ok: true,
      payer: verified.payer,
      reference: verified.reference,
      grant,
      response: { success: true, payer: verified.payer, transaction: verified.reference, network: NETWORK },
    };
  }

  /** Is this grant a live session? */
  checkGrant(token: unknown): GrantCheck {
    return verifyGrant(token, this.resourceId, this.o.secrets.grant, this.now());
  }

  /** What an agent needs to know to buy a session, for discovery. */
  info(): Record<string, unknown> {
    return {
      x402Version: X402_VERSION,
      kinds: [{ x402Version: X402_VERSION, scheme: SCHEME, network: NETWORK }],
      asset: ASSET,
      payTo: this.payTo,
      sellerId: this.sellerId,
      session: { priceQu: this.priceQu, seconds: this.seconds, resourceId: this.resourceId },
      how: "Call any metered endpoint (or GET /v1/session) without a session; a 402 answer carries the price, a ticket and the exact payment to make. Pay with QPAYHUB.Pay, then retry the same request with an X-PAYMENT header. The reply carries X-ACCESS-GRANT: send it on later requests until it expires.",
    };
  }
}
