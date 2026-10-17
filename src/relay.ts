import { identityToBytes } from "./identity.ts";
import { isRef } from "./deeplink.ts";
import { MAX_RELAY_BYTES, readRelayable } from "./relayable.ts";
import type { Channel } from "./usage.ts";

/**
 * Sending an order through QMax. The page (or the bot) hands QMax the signed transaction, QMax checks it is an order, a swap or a liquidity change for QX or QSwap and nothing
 * else, passes it on to the network, and notes it for counting. So an order that began in QMax is known to have: QMax saw it go by, instead of taking someone's word for it afterwards.
 * It is never needed: the sender falls back to the public network itself if QMax cannot take it, so QMax being down can never stop a trade.
 *
 * The transaction is already signed by its owner: all this does is carry it, the same as the public node would. It cannot move anyone's money, and only calls to QX and QSwap
 * of the kinds the app itself makes are carried, so it is not a general way to send transactions.
 */

export { MAX_RELAY_BYTES, readRelayable };

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface RelayResult {
  status: number;
  body: Record<string, unknown>;
}

export interface RelayOptions {
  /** The Qubic node to pass transactions on to. */
  rpcUrl: string;
  /** Where an accepted order is noted for counting (the usage log). Without it orders are carried but not counted. */
  usage?: { report(body: unknown, source?: string): number | null };
  /** Longest to wait for the node (ms). Default 8000. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

const CHANNELS: readonly Channel[] = ["web", "discord", "agent"];
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const TX_ID = /^[a-z]{60}$/;
const WALLET = /^[A-Z]{60}$/;

const fail = (status: number, error: string): RelayResult => ({ status, body: { error } });

export class Relay {
  private o: RelayOptions;

  constructor(o: RelayOptions) {
    this.o = o;
  }

  /** Takes `{ encodedTransaction, wallet, channel?, ref? }`, passes the transaction on and notes it. `source` is who asked (an address, for the usage log's per-source limit). */
  async send(input: unknown, source = ""): Promise<RelayResult> {
    const b = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    if (typeof b.encodedTransaction !== "string" || b.encodedTransaction.length > Math.ceil(MAX_RELAY_BYTES / 3) * 4 || !B64.test(b.encodedTransaction)) return fail(400, "encodedTransaction must be the signed transaction in base64");
    if (typeof b.wallet !== "string" || !WALLET.test(b.wallet)) return fail(400, "wallet must be the 60-letter identity that signed it");
    const tx = Uint8Array.from(Buffer.from(b.encodedTransaction, "base64"));
    const what = readRelayable(tx);
    if (!what) return fail(400, "Only orders, swaps and liquidity changes for QX and QSwap are carried; send anything else to the network yourself");
    let owner: Uint8Array;
    try {
      owner = identityToBytes(b.wallet);
    } catch {
      return fail(400, "wallet must be the 60-letter identity that signed it");
    }
    if (!same(owner, what.source)) return fail(400, "The transaction was not sent from that wallet");

    let id: string;
    let extra: Record<string, unknown> = {};
    try {
      const f = this.o.fetch ?? fetch;
      const res = await f(this.o.rpcUrl.replace(/\/$/, "") + "/v1/broadcast-transaction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ encodedTransaction: b.encodedTransaction }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000),
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
        return fail(res.status >= 500 ? 502 : 400, `The network refused it (${res.status})${text ? `: ${text}` : ""}`);
      }
      const json = (await res.json()) as { transactionId?: unknown; peersBroadcasted?: unknown };
      if (typeof json.transactionId !== "string" || !TX_ID.test(json.transactionId)) return fail(502, "The network did not give a transaction id");
      id = json.transactionId;
      if (typeof json.peersBroadcasted === "number") extra = { peersBroadcasted: json.peersBroadcasted };
    } catch {
      return fail(502, "The network did not answer in time");
    }

    // Counted from the moment it was sent, so an order counts even if the page that sent it is closed before the order is confirmed.
    try {
      const channel: Channel = CHANNELS.includes(b.channel as Channel) ? (b.channel as Channel) : "web";
      this.o.usage?.report({ wallet: b.wallet, txIds: [id], channel, ...(isRef(b.ref) ? { ref: b.ref } : {}) }, source);
    } catch {
      // noting it must never fail an order that has gone out
    }
    return { status: 200, body: { transactionId: id, ...extra } };
  }
}
