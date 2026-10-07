import { PAYWALL } from "./config.ts";
import type { TxStep } from "./exec.ts";
import type { Pass } from "./pass.ts";

/**
 * QMax Pro: the pass logic behind Max. NOT part of this repository: this file keeps the types and signatures with stand-ins that make Max free for everyone
 * (which it is on QMax's own site too), so the website still builds and runs.
 */
export type ProMode = "free" | "paid";

export interface ProConfig {
  mode: ProMode;
  priceQu: number;
  days: number;
  recipient: string;
}

export const DEFAULT_PRO: ProConfig = { mode: "free", priceQu: 0, days: 30, recipient: PAYWALL.recipient };

export function parseProConfig(_env: Record<string, string | undefined> = {}): ProConfig {
  return DEFAULT_PRO;
}
export const proConfig = (): ProConfig => DEFAULT_PRO;

export type ProState = "free" | "pass" | "locked";

export interface ProAccess {
  allowed: boolean;
  state: ProState;
  charging: boolean;
}

/** Here Max is free for everyone. */
export function proAccess(_config: ProConfig, _input: { passActive: boolean }): ProAccess {
  return { allowed: true, state: "free", charging: false };
}

export function proResourceId(_config: ProConfig = proConfig(), _fp?: string): Uint8Array {
  return new Uint8Array(32);
}
export function proStep(_nonce: bigint, _config: ProConfig = proConfig(), _fp?: string): TxStep {
  throw new Error("Max passes are not part of the open-source release of QMax.");
}
export function proListStep(_nonce: bigint, _fp: string, _config: ProConfig = proConfig()): TxStep {
  throw new Error("Max passes are not part of the open-source release of QMax.");
}
export function proPassIsActive(_pass: Pass | undefined, _wallet: string, _config: ProConfig, _now = Date.now()): boolean {
  return false;
}

/** Whether Max mode is working: switched on, and allowed. */
export const maxIsActive = (on: boolean, access: ProAccess): boolean => on && access.allowed;
