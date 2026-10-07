/**
 * Who a Max pass covers. The pass logic is NOT part of this repository: this file keeps the constants, the types and the signatures, with stand-ins that behave as
 * "no pass exists", so everything that depends on it still builds and runs. QMax's own server runs the real one.
 */

export const COVER_MAX = 15;
/** What a change of list costs, in QU. */
export const COVER_UPDATE_QU = 1_000;

export type NormalizedCover = { ok: true; list: string[] } | { ok: false; error: string };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function normalizeCover(_raw: unknown, _payer: string): NormalizedCover {
  return { ok: false, error: "Max passes are not part of the open-source release of QMax." };
}
export async function coverFingerprint(_list: string[]): Promise<string> {
  return "0".repeat(32);
}
export const fingerprintBytes = (fp: string): Uint8Array => Uint8Array.from(fp.match(/../g)!.map((h) => parseInt(h, 16)));
export const bytesToFingerprint = (b: Uint8Array): string => hex(b);

export function passResource(_days: number, _fp?: string): Uint8Array {
  return new Uint8Array(32);
}
export function listResource(_fp: string): Uint8Array {
  return new Uint8Array(32);
}
/** What a receipt's resource id says it was paid for. Here nothing is a pass. */
export function readResource(_resource: Uint8Array): { kind: "pro" | "proset"; cover: string | null } | null {
  return null;
}

export interface ProPayment {
  payer: string;
  kind: "pro" | "proset";
  amountQu: number;
  t: number;
  cover?: string;
}

export interface ProRules {
  days: number;
  minQu: number;
}

export interface ProStatus {
  wallet: string;
  active: boolean;
  until: number | null;
  via: "own" | "cover" | null;
  payer: string | null;
  covered: string[] | null;
  listPending: boolean;
  coverMax: number;
}

export function proStatus(_payments: ProPayment[], _sets: (fp: string) => string[] | null, wallet: string, _now: number, _rules: ProRules): ProStatus {
  return { wallet, active: false, until: null, via: null, payer: null, covered: null, listPending: false, coverMax: COVER_MAX };
}
