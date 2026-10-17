import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { isReadOnly, parseWallet, readViewed, writeViewed } from "./viewwallet.ts";
import { useQubicConnect } from "./wallet/QubicConnectContext.tsx";

/**
 * The wallet the portfolio screens are looking at without it being connected (see viewwallet.ts), shared by everything that shows or hides something because of it. It is remembered in
 * this browser until the person stops looking at it, or connects a wallet of their own (their own wallet then takes the place of the one they were only looking at).
 */
interface Viewing {
  /** The address being looked at, or null. */
  viewing: string | null;
  /** The portfolio shows a wallet that is not the connected one: nothing on those screens may be signed. */
  readOnly: boolean;
  /** Starts looking at what was pasted. Returns a sentence saying what is wrong with it, or null when it worked. */
  view: (pasted: string) => string | null;
  stop: () => void;
}

const ViewingContext = createContext<Viewing | undefined>(undefined);

export function ViewingProvider({ children }: { children: ReactNode }) {
  const { connected, wallet } = useQubicConnect();
  const own = connected && wallet ? wallet.publicKey : null;
  const [viewing, setViewing] = useState<string | null>(() => readViewed(typeof localStorage === "undefined" ? null : localStorage));

  const set = useCallback((id: string | null) => {
    setViewing(id);
    writeViewed(typeof localStorage === "undefined" ? null : localStorage, id);
  }, []);

  // Connecting a wallet of one's own ends the looking: the portfolio is then that wallet's.
  const hadOwn = useRef(own !== null);
  useEffect(() => {
    if (own && !hadOwn.current) set(null);
    hadOwn.current = own !== null;
  }, [own, set]);

  const value = useMemo<Viewing>(
    () => ({
      viewing,
      readOnly: isReadOnly(viewing, own),
      view: (pasted) => {
        const r = parseWallet(pasted);
        if (!r.ok) return r.error;
        set(r.id);
        return null;
      },
      stop: () => set(null),
    }),
    [viewing, own, set],
  );
  return <ViewingContext.Provider value={value}>{children}</ViewingContext.Provider>;
}

export function useViewing(): Viewing {
  const v = useContext(ViewingContext);
  if (!v) throw new Error("useViewing must be used within a ViewingProvider");
  return v;
}
