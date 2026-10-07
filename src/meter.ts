import { createHash, randomBytes } from "node:crypto";
import { readJsonFile, writeJsonFile, isObject } from "./safefile.ts";
import { identityToBytes, bytesToHex } from "./identity.ts";
import { dirname } from "node:path";
import { randomNonce, receiptPays } from "./qpay.ts";
import type { Receipt } from "./qpay.ts";
import { apiResourceId, topupTx } from "./topup.ts";
import type { TopupTx } from "./topup.ts";

export interface Account {
  balanceQu: number;
  calls: number;
  createdAt: number;
  /** Top-ups already credited ("payer:nonce"), so one receipt can never be counted twice. */
  claims: string[];
}

export interface MeterOptions {
  /** JSON file for balances; omit to keep them in memory (tests). */
  file?: string;
  /** QU charged per split quote. */
  splitPriceQu: number;
  /** QU charged per arbitrage result found. */
  arbitragePriceQu: number;
  /** Smallest top-up accepted. QPayhub keeps at least 100 QU of every payment, so tiny top-ups lose most of their value. */
  minTopupQu: number;
  /** Who top-ups are paid to (through QPayhub). */
  recipient: string;
  /** Reads a receipt from QPayhub. */
  lookupReceipt: (payer: string, seller: string, resourceId: Uint8Array, nonce: bigint) => Promise<Receipt | null>;
}

export type ClaimResult = { ok: true; creditedQu: number; balanceQu: number } | { ok: false; reason: string };

const IDENTITY = /^[A-Z]{60}$/;

/**
 * Prepaid balances for API keys. A key is created free; its balance is filled by paying QPayhub with the
 * key's id in the receipt, and each billed result takes its price from it. Only a hash of the key is kept.
 */
export class Meter {
  readonly splitPriceQu: number;
  readonly arbitragePriceQu: number;
  readonly minTopupQu: number;
  private opts: MeterOptions;
  // No prototype: a key id like "__proto__" or "constructor" must be an unknown key, not a property of every object.
  private accounts: Record<string, Account> = Object.create(null);
  private inflight = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: MeterOptions) {
    this.opts = opts;
    this.splitPriceQu = opts.splitPriceQu;
    this.arbitragePriceQu = opts.arbitragePriceQu;
    this.minTopupQu = opts.minTopupQu;
    if (opts.file) {
      const saved = readJsonFile<Record<string, Account>>(opts.file, isObject);
      if (saved) Object.assign(this.accounts, saved);
    }
  }

  keyIdOf(key: string): string {
    return createHash("sha256").update(key).digest("hex").slice(0, 32);
  }

  createKey(): { key: string; keyId: string } {
    const key = "qm_" + randomBytes(24).toString("hex");
    const keyId = this.keyIdOf(key);
    this.accounts[keyId] = { balanceQu: 0, calls: 0, createdAt: Date.now(), claims: [] };
    this.flush();
    return { key, keyId };
  }

  /** The account a key belongs to, or null if the key is unknown. */
  find(key: string): { keyId: string; account: Account } | null {
    const keyId = this.keyIdOf(key);
    const account = this.accounts[keyId];
    return account ? { keyId, account } : null;
  }

  info(keyId: string): Account | null {
    return this.accounts[keyId] ?? null;
  }

  /** Takes `qu` from the balance. False (and nothing taken) if there is not enough. */
  charge(keyId: string, qu: number): boolean {
    const a = this.accounts[keyId];
    if (!a || a.balanceQu < qu) return false;
    a.balanceQu -= qu;
    a.calls++;
    this.flushSoon();
    return true;
  }

  /** The transaction that tops up `keyId` with `amountQu`. */
  topup(keyId: string, amountQu: number, nonce: bigint = randomNonce()): TopupTx {
    if (!/^[0-9a-f]{32}$/.test(keyId) || !this.accounts[keyId]) throw new Error("Unknown keyId");
    if (!Number.isInteger(amountQu) || amountQu < this.minTopupQu || amountQu > 1e12)
      throw new Error(`amountQu must be a whole number from ${this.minTopupQu} to 1,000,000,000,000`);
    return topupTx(this.opts.recipient, keyId, amountQu, nonce);
  }

  /** Counts a top-up after checking QPayhub's receipt for it. The full amount paid becomes balance. */
  async claim(p: { keyId: string; payer: string; nonce: string }): Promise<ClaimResult> {
    if (!/^[0-9a-f]{32}$/.test(p.keyId)) return { ok: false, reason: "Unknown keyId" };
    const account = this.accounts[p.keyId];
    if (!account) return { ok: false, reason: "Unknown keyId" };
    if (!IDENTITY.test(p.payer)) return { ok: false, reason: "payer must be a 60-letter Qubic identity" };
    if (!/^(0|[1-9]\d{0,19})$/.test(p.nonce) || BigInt(p.nonce) >= 1n << 64n) return { ok: false, reason: "nonce must be a number below 2^64, written without leading zeros" };
    // The payment is the same payment however it is spelled: the receipt is found by the payer's 32 bytes (the last four letters of an
    // identity are a checksum, so thousands of spellings reach one receipt) and the nonce's value. That, not the text, is what is remembered.
    const claimId = `${bytesToHex(identityToBytes(p.payer))}:${BigInt(p.nonce)}`;
    if (account.claims.includes(claimId) || account.claims.includes(`${p.payer}:${p.nonce}`) || this.inflight.has(p.keyId + claimId)) return { ok: false, reason: "That payment was already credited." };
    this.inflight.add(p.keyId + claimId);
    try {
      const receipt = await this.opts.lookupReceipt(p.payer, this.opts.recipient, apiResourceId(p.keyId), BigInt(p.nonce));
      // Whatever was really paid counts, even below the advised minimum.
      if (!receiptPays(receipt, this.opts.recipient, 1))
        return { ok: false, reason: "QPayhub has no receipt for this payment yet. Wait for the transaction to be confirmed and try again." };
      account.balanceQu += receipt!.amountPaid;
      // QPayhub keeps receipts for about two epochs: the record of what was credited must outlast that, whatever else is claimed meanwhile.
      account.claims = [...account.claims.slice(-19_999), claimId];
      this.flush();
      return { ok: true, creditedQu: receipt!.amountPaid, balanceQu: account.balanceQu };
    } finally {
      this.inflight.delete(p.keyId + claimId);
    }
  }

  /** Writes now (used after money moves). Per-call charges are written shortly after instead. */
  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const file = this.opts.file;
    if (!file) return;
    writeJsonFile(file, this.accounts);
  }

  private flushSoon() {
    if (this.flushTimer || !this.opts.file) return;
    this.flushTimer = setTimeout(() => this.flush(), 500);
    this.flushTimer.unref();
  }
}
