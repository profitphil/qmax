import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ProAccess } from "../src/pro.ts";
import { maxIsActive } from "../src/pro.ts";
import { useProAccess } from "./exec/pro.ts";
import type { ProServerStatus } from "./pro-api.ts";
import { ProModal } from "./ProModal.tsx";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";

const KEY = "qmax.max.on";

const readOn = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const writeOn = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // not remembered: it still holds until the page is reloaded
  }
};

export interface MaxMode {
  /** Max mode is on and allowed: Buy, Sell and Swap use QMax's best-position search. When false everything works the plain way. */
  active: boolean;
  access: ProAccess;
  setOn: (on: boolean) => void;
  toggle: () => void;
  /** QMax's record of the Max pass that covers this wallet (its own, or one that lists it), or null. */
  cover: ProServerStatus | null;
  /** Looks the wallet's pass up again (after a payment). */
  refreshPass: () => void;
}

const Context = createContext<MaxMode>({ active: false, access: { allowed: true, state: "free", charging: false }, setOn: () => {}, toggle: () => {}, cover: null, refreshPass: () => {} });

/**
 * Max mode: one switch for the whole app. Off, Buy, Sell and Swap are the ordinary trades. On, the order panel gets a Max button that searches the best position
 * for the trade (best way to execute, best size, arbitrage, best exit), and Swap can swap one asset for another. Max is free for everyone; only a site built with
 * `VITE_PRO_MODE=paid` and a price asks for a Pro pass when it is switched on.
 */
export function MaxModeProvider({ children }: { children: ReactNode }) {
  const { wallet } = useQubicConnect();
  const { access, refresh, cover } = useProAccess(wallet?.publicKey);
  const [on, setOnState] = useState(readOn);
  const [locked, setLocked] = useState(false);
  const active = maxIsActive(on, access);

  const setOn = useCallback(
    (next: boolean) => {
      if (next && !access.allowed) return setLocked(true);
      writeOn(next);
      setOnState(next);
    },
    [access.allowed],
  );
  const value = useMemo<MaxMode>(() => ({ active, access, setOn, toggle: () => setOn(!active), cover, refreshPass: refresh }), [active, access, setOn, cover, refresh]);

  return (
    <Context.Provider value={value}>
      {children}
      {locked && (
        <ProModal
          access={access}
          onClose={() => setLocked(false)}
          onUnlocked={() => {
            refresh();
            writeOn(true);
            setOnState(true);
          }}
        />
      )}
    </Context.Provider>
  );
}

export const useMaxMode = (): MaxMode => useContext(Context);

/** The line for a tooltip: where this person stands with Max. */
export function proTitle(access: ProAccess): string {
  if (!access.allowed) return " · part of QMax Pro";
  if (access.state === "pass") return " · QMax Pro";
  return "";
}
