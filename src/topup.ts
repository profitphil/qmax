import { identityToBytes } from "./identity.ts";
import { QPAYHUB_INDEX, QPAYHUB_PROC_PAY, payPayload } from "./qpay.ts";

/** What a top-up receipt says it was paid for: "QMAXAPI", a layout version and the API key's id. */
export function apiResourceId(keyId: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(keyId)) throw new Error("keyId must be 32 hex characters");
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode("QMAXAPI"), 0);
  out[9] = 1; // layout version
  for (let i = 0; i < 16; i++) out[16 + i] = parseInt(keyId.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A transaction to sign and broadcast to top up an API key. */
export interface TopupTx {
  /** Destination: QPayhub, a smart contract addressed by index. */
  contractIndex: number;
  inputType: number;
  /** QU to attach to the transaction. */
  amountQu: number;
  /** Transaction payload, base64: Pay(seller, resourceId, nonce). */
  payload: string;
  /** Send this back with the payer's identity to /v1/topup/claim once the transaction is confirmed. */
  nonce: string;
}

export function topupTx(recipient: string, keyId: string, amountQu: number, nonce: bigint): TopupTx {
  const payload = payPayload(recipient, apiResourceId(keyId), nonce);
  identityToBytes(recipient); // fails early on a bad recipient
  return { contractIndex: QPAYHUB_INDEX, inputType: QPAYHUB_PROC_PAY, amountQu, payload: btoa(String.fromCharCode(...payload)), nonce: nonce.toString() };
}
