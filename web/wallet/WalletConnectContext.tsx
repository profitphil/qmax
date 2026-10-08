import { createContext, useContext, useEffect, useRef, useState } from "react";
import SignClient from "@walletconnect/sign-client";
import type { WalletConnectAccount } from "./types/account";
import { describeFailure, makePairing, MemoryStorage, newestQubicSession, pairingIsFresh, startClient } from "./pairing.ts";

interface WalletConnectContextType {
  signClient: SignClient | null;
  sessionTopic: string;
  isConnecting: boolean;
  isConnected: boolean;
  /** A pairing link and a way to wait for the wallet to approve it. When no link could be made, `uri` is empty and `error` says why, in words fit to show. */
  connect: () => Promise<{ uri: string; approve: () => Promise<boolean>; error?: string }>;
  disconnect: () => Promise<void>;
  /** When the page took up a connection the wallet approved while the page was away (null if it did not). */
  adoptedAt: number | null;
  /** Looks again, now, for a connection the wallet approved while the page was in the background, and takes it up. True if one was found. */
  recheck: () => Promise<boolean>;
  requestAccounts: () => Promise<WalletConnectAccount[]>;
  sendQubic: (params: { from: string; to: string; amount: number }) => Promise<any>;
  signTransaction: (params: {
    from: string;
    to: string;
    amount: number;
    tick: number;
    inputType: number;
    payload: string | null;
  }) => Promise<any>;
  signMessage: (params: { from: string; message: string }) => Promise<any>;
}

const WalletConnectContext = createContext<WalletConnectContextType | undefined>(undefined);

const clientOptions = () => ({
  // The WalletConnect project id, set when the site is built (VITE_WALLETCONNECT_PROJECT_ID, from cloud.walletconnect.com). There is no default: create your own project
  // there, and add this site's domain to its allowed origins, or wallets may flag the connection as unverified.
  projectId: (import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) || "",
  // What the person sees in their wallet when they approve the connection: it must say what is really asking.
  // A raster icon, not the SVG favicon: many wallets' connect-request UI doesn't render SVG and shows a blank/broken image instead.
  metadata: {
    name: "QMax",
    description: "The best route for your Qubic trades across QX and QSwap",
    url: window.location.origin,
    icons: [`${window.location.origin}/apple-touch-icon.png`],
  },
});

/** When this page last started a pairing, kept so a page that was thrown away while the wallet app was open still knows it was waiting for an answer. */
const PENDING_KEY = "qmax.wc.pending";
const readPending = (): number | null => {
  try {
    const v = Number(localStorage.getItem(PENDING_KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
};
const markPending = () => {
  try {
    localStorage.setItem(PENDING_KEY, String(Date.now()));
  } catch {
    // a browser that blocks storage just does not get the pick-up
  }
};
const clearPending = () => {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // nothing to clear
  }
};

let clientPromise: Promise<SignClient> | null = null;

/**
 * The one WalletConnect client for the page, started once and shared by everything that needs it. It starts the normal way and, where the browser blocks (or hangs on) its
 * storage, once more keeping everything in memory. A failed start is forgotten, so the next try starts again instead of replaying the failure.
 */
function getClient(): Promise<SignClient> {
  if (!clientPromise) {
    const p = startClient(
      () => SignClient.init(clientOptions()),
      // The same options with an in-memory store. (The storage option is typed as the library's own class; ours has the same methods.)
      () => SignClient.init({ ...clientOptions(), storage: new MemoryStorage() as any }),
    );
    clientPromise = p;
    p.catch(() => {
      if (clientPromise === p) clientPromise = null;
    });
  }
  return clientPromise;
}

interface WalletConnectProviderProps {
  children: React.ReactNode;
}

export function WalletConnectProvider({ children }: WalletConnectProviderProps) {
  const [signClient, setSignClient] = useState<SignClient | null>(null);
  const [sessionTopic, setSessionTopic] = useState<string>("");
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [adoptedAt, setAdoptedAt] = useState<number | null>(null);

  const connect = async () => {
    setIsConnecting(true);
    try {
      const { uri, approval } = await makePairing(
        () => getClient().then((client) => attach(client)),
        (client) =>
          client.connect({
            requiredNamespaces: {
              qubic: {
                chains: ["qubic:mainnet"],
                // Only what QMax uses: the accounts, and signing the transactions it builds. (It never asks the wallet to send QU or assets itself or to sign messages.)
                methods: ["qubic_requestAccounts", "qubic_signTransaction"],
                events: ["amountChanged", "assetAmountChanged", "accountsChanged"],
              },
            },
          }),
      );
      if (!uri) return { uri: "", approve: async () => false, error: "WalletConnect did not give a connection link. Try again." };
      markPending();

      // Resolves true once the wallet approves, false if it rejects or the request expires.
      const approve = async (): Promise<boolean> => {
        try {
          const session = await approval();
          setSessionTopic(session.topic);
          setIsConnected(true);
          localStorage.setItem("sessionTopic", session.topic);
          clearPending();
          return true;
        } catch (e) {
          console.error("Connection rejected:", e);
          return false;
        }
      };

      return { uri, approve };
    } catch (error) {
      console.error("Failed to connect:", error);
      return { uri: "", approve: async () => false, error: describeFailure(error) };
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!signClient || !sessionTopic) return;

    try {
      await signClient.disconnect({
        topic: sessionTopic,
        reason: { code: 6000, message: "User disconnected" },
      });

      setSessionTopic("");
      setIsConnected(false);
      localStorage.removeItem("sessionTopic");
    } catch (error) {
      console.error("Failed to disconnect:", error);
    }
  };

  const requestAccounts = async () => {
    const { client, topic } = getActiveSessionTopic();

    try {
      const result = await client.request({
        topic,
        chainId: "qubic:mainnet",
        request: {
          method: "qubic_requestAccounts",
          params: {
            nonce: Date.now().toString(),
          },
        },
      });
      return result as WalletConnectAccount[];
    } catch (error) {
      console.error("Failed to request accounts:", error);
      throw error;
    }
  };

  const sendQubic = async (params: { from: string; to: string; amount: number }) => {
    const { client, topic } = getActiveSessionTopic();

    return await client.request({
      topic,
      chainId: "qubic:mainnet",
      request: {
        method: "qubic_sendQubic",
        params: {
          ...params,
          nonce: Date.now().toString(),
        },
      },
    });
  };

  const signTransaction = async (params: {
    from: string;
    to: string;
    amount: number;
    tick: number;
    inputType: number;
    payload: string | null;
  }) => {
    const { client, topic } = getActiveSessionTopic();

    try {
      return await client.request({
        topic,
        chainId: "qubic:mainnet",
        request: {
          method: "qubic_signTransaction",
          params: {
            from: params.from,
            to: params.to,
            tick: params.tick,
            amount: params.amount,
            inputType: params.inputType,
            payload: params.payload,
            nonce: Date.now().toString(),
          },
        },
      });
    } catch (error) {
      throw error;
    }
  };

  const signMessage = async (params: { from: string; message: string }) => {
    const { client, topic } = getActiveSessionTopic();

    return await client.request({
      topic,
      chainId: "qubic:mainnet",
      request: {
        method: "qubic_sign",
        params,
      },
    });
  };

  /** Takes up the newest Qubic session when the page started a pairing recently and a session the page has not recorded exists (a newer one than the one it has). */
  const adoptAway = (client: SignClient): boolean => {
    if (!pairingIsFresh(readPending())) return false;
    let session;
    try {
      session = newestQubicSession(client.session.getAll());
    } catch {
      return false;
    }
    if (!session || session.topic === localStorage.getItem("sessionTopic")) return false;
    localStorage.setItem("sessionTopic", session.topic);
    setSessionTopic(session.topic);
    setIsConnected(true);
    clearPending();
    setAdoptedAt(Date.now());
    return true;
  };

  const recheck = async (): Promise<boolean> => {
    if (!pairingIsFresh(readPending())) return false;
    const client = await getClient().catch(() => null);
    if (!client) return false;
    attach(client);
    try {
      // The phone may have dropped the connection to the relay while the page slept: bring it back so an answer that is waiting gets delivered.
      if (client.core.relayer.connected === false) await client.core.relayer.restartTransport();
    } catch {
      // the library reconnects by itself too; this only hurries it
    }
    return adoptAway(client);
  };

  // Hooks the page's state up to the client once per client (the first thing to get it, the page or a connect, does it).
  const attached = useRef<SignClient | null>(null);
  const attach = (client: SignClient): SignClient => {
    if (attached.current === client) return client;
    attached.current = client;
    setSignClient(client);

    const storedTopic = localStorage.getItem("sessionTopic");
    if (storedTopic) {
      try {
        client.session.get(storedTopic);
        setSessionTopic(storedTopic);
        setIsConnected(true);
      } catch {
        localStorage.removeItem("sessionTopic");
      }
    }
    // A wallet that answered while this page was in the background (a phone puts the browser to sleep when the wallet app opens) left a session the page never saw approved.
    adoptAway(client);

    client.on("session_delete", () => {
      setSessionTopic("");
      setIsConnected(false);
      localStorage.removeItem("sessionTopic");
    });

    client.on("session_expire", () => {
      setSessionTopic("");
      setIsConnected(false);
      localStorage.removeItem("sessionTopic");
    });
    return client;
  };

  useEffect(() => {
    // A client that cannot start is not an error here: a person who never connects a wallet should not see one, and Connect tries again and says what went wrong.
    getClient().then(attach, (e) => console.warn("WalletConnect did not start:", e));
  }, []);

  const getActiveSessionTopic = () => {
    const client = signClient;
    const effectiveSessionTopic = sessionTopic || localStorage.getItem("sessionTopic") || "";

    if (!client || !effectiveSessionTopic) {
      throw new Error("WalletConnect not connected. Please reconnect your wallet.");
    }

    try {
      client.session.get(effectiveSessionTopic);
    } catch {
      localStorage.removeItem("sessionTopic");
      setSessionTopic("");
      setIsConnected(false);
      throw new Error("WalletConnect session expired. Please reconnect your wallet.");
    }

    return {
      client,
      topic: effectiveSessionTopic,
    };
  };

  const contextValue: WalletConnectContextType = {
    signClient,
    sessionTopic,
    isConnecting,
    isConnected,
    connect,
    disconnect,
    adoptedAt,
    recheck,
    requestAccounts,
    sendQubic,
    signTransaction,
    signMessage,
  };

  return <WalletConnectContext.Provider value={contextValue}>{children}</WalletConnectContext.Provider>;
}

export function useWalletConnect() {
  const context = useContext(WalletConnectContext);
  if (!context) {
    throw new Error("useWalletConnect must be used within a WalletConnectProvider");
  }
  return context;
}
