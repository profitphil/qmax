import { useCallback, useEffect, useState } from "react";
import type { Membership } from "../src/membership.ts";
import { BASE } from "./base.ts";
import { usageSharingOn } from "./sharing.ts";

/** What `GET /v1/membership` answers: the membership read from the chain, and the wallet's profit share. */
export interface MembershipResponse extends Membership {
  /** Whether this membership unlocks trading on the website (a pass always does; a subscription unless the operator turned that off). */
  unlocksWebTrading: boolean;
  profitShare: {
    sharePct: number;
    capFraction: number;
    since: string;
    earnedQu: number;
    paidQu: number;
    owedQu: number;
    periods: { period: string; earnedQu: number }[];
    thisMonth: { period: string; estimatedQu: number; provisional: boolean };
    note: string;
  } | null;
}

/** Whether this wallet is a member. Throws if QMax cannot be reached. */
export async function fetchMembership(wallet: string, signal?: AbortSignal): Promise<MembershipResponse> {
  const res = await fetch(`${BASE}/v1/membership?${new URLSearchParams({ wallet })}`, { signal });
  if (!res.ok) throw new Error(`Could not read your membership (${res.status})`);
  return (await res.json()) as MembershipResponse;
}

/** The connected wallet's membership: null while loading or if it could not be read, and read again on `refresh`. */
export function useMembership(wallet: string | undefined) {
  const [state, setState] = useState<{ wallet: string; m: MembershipResponse | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Asking about a wallet tells QMax the address: with counting turned off in Settings, the wallet menu does not ask.
    if (!wallet || !usageSharingOn()) return;
    const ctl = new AbortController();
    fetchMembership(wallet, ctl.signal)
      .then((m) => setState({ wallet, m }))
      .catch((e) => e.name !== "AbortError" && setState({ wallet, m: null }));
    return () => ctl.abort();
  }, [wallet, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { membership: wallet && state?.wallet === wallet ? state.m : null, refresh };
}
