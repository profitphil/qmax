import { createContext, useContext, useEffect, useState } from "react";
import SignClient from "@walletconnect/sign-client";
import type { WalletConnectAccount } from "./types/account";

interface WalletConnectContextType {
  signClient: SignClient | null;
  sessionTopic: string;
  isConnecting: boolean;
  isConnected: boolean;
  connect: () => Promise<{ uri: string; approve: () => Promise<boolean> }>;
  disconnect: () => Promise<void>;
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

interface WalletConnectProviderProps {
  children: React.ReactNode;
}

export function WalletConnectProvider({ children }: WalletConnectProviderProps) {
  const [signClient, setSignClient] = useState<SignClient | null>(null);
  const [sessionTopic, setSessionTopic] = useState<string>("");
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);

  const connect = async () => {
    if (!signClient) return { uri: "", approve: async () => false };
    setIsConnecting(true);
    try {
      const { uri, approval } = await signClient.connect({
        requiredNamespaces: {
          qubic: {
            chains: ["qubic:mainnet"],
            // Only what QMax uses: the accounts, and signing the transactions it builds. (It never asks the wallet to send QU or assets itself or to sign messages.)
            methods: ["qubic_requestAccounts", "qubic_signTransaction"],
            events: ["amountChanged", "assetAmountChanged", "accountsChanged"],
          },
        },
      });

      // Resolves true once the wallet approves, false if it rejects or the request expires.
      const approve = async (): Promise<boolean> => {
        try {
          const session = await approval();
          setSessionTopic(session.topic);
          setIsConnected(true);
          localStorage.setItem("sessionTopic", session.topic);
          return true;
        } catch (e) {
          console.error("Connection rejected:", e);
          return false;
        }
      };

      return { uri: uri || "", approve };
    } catch (error) {
      console.error("Failed to connect:", error);
      return { uri: "", approve: async () => false };
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

  useEffect(() => {
    SignClient.init({
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
    }).then((client) => {
      setSignClient(client);

      const storedTopic = localStorage.getItem("sessionTopic");
      if (storedTopic) {
        const session = client.session.get(storedTopic);
        if (session) {
          setSessionTopic(storedTopic);
          setIsConnected(true);
        } else {
          localStorage.removeItem("sessionTopic");
        }
      }

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
    });
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
