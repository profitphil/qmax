import React, { createContext, useContext, useEffect, useState } from "react";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper";
import Crypto, { SIGNATURE_LENGTH } from "@qubic-lib/qubic-ts-library/dist/crypto";
import { MetamaskActions, MetaMaskContext, MetaMaskProvider } from "./MetamaskContext";
import { connectTypes, defaultSnapOrigin } from "./config";
import { useWalletConnect } from "./WalletConnectContext";
import { currentExtensionAccount, extensionMessage, extensionProvider, signWithExtension, waitForExtension, watchExtension } from "./extension.ts";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction";
import { base64ToUint8Array, decodeUint8ArrayTx, uint8ArrayToBase64 } from "./utils/tx.ts";
import { toast } from "sonner";
import { getSnap } from "./utils/snap";
import { connectSnap } from "./utils/snap";
import { getResolvedMetaMaskProvider } from "./utils/metamask";
// @ts-ignore
import { QubicVault } from "@qubic-lib/qubic-ts-vault-library";

interface Wallet {
  connectType: string;
  publicKey: string;
  alias?: string;
  privateKey?: string;
  /** The public identities of the wallet's accounts, when the wallet listed them (a wallet app, a vault file). Used to prefill the addresses a Max pass covers; never a seed. */
  accounts?: string[];
}

interface QubicConnectContextType {
  connected: boolean;
  wallet: Wallet | null;
  showConnectModal: boolean;
  connect: (wallet: Wallet) => void;
  disconnect: () => void;
  toggleConnectModal: () => void;
  getMetaMaskPublicId: (accountIdx?: number, confirm?: boolean) => Promise<string>;
  getSignedTx: (tx: Uint8Array | QubicTransaction) => Promise<{ tx: Uint8Array }>;
  mmSnapConnect: () => Promise<void>;
  privateKeyConnect: (privateSeed: string) => Promise<void>;
  vaultFileConnect: (selectedFile: File, password: string) => Promise<QubicVault>;
}

const QubicConnectContext = createContext<QubicConnectContextType | undefined>(undefined);

interface QubicConnectProviderProps {
  children: React.ReactNode;
}

export function QubicConnectProvider({ children }: QubicConnectProviderProps) {
  const [connected, setConnected] = useState<boolean>(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [showConnectModal, setShowConnectModal] = useState<boolean>(false);
  const { signTransaction, isConnected: wcConnected, adoptedAt } = useWalletConnect();
  const [state, dispatch] = useContext(MetaMaskContext);

  const qHelper = new QubicHelper();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const WALLETCONNECT_SIGN_TIMEOUT_MS = 120000;
  /** The extension itself waits up to 150 seconds for the person to approve and enter their passphrase. */
  const EXTENSION_SIGN_TIMEOUT_MS = 170_000;

  const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      });

      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  const withVisibilityAwareTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return await withTimeout(promise, timeoutMs, message);
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let remainingMs = timeoutMs;
    let lastStartedAt = 0;
    let settled = false;
    let rejectTimeout: ((reason?: unknown) => void) | null = null;

    const isHidden = () => document.visibilityState === "hidden";

    const clearTimer = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const pauseTimer = () => {
      if (!timeoutId) return;
      remainingMs -= Date.now() - lastStartedAt;
      clearTimer();
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      rejectTimeout?.(new Error(message));
    };

    const startTimer = () => {
      if (settled || isHidden() || timeoutId) return;
      if (remainingMs <= 0) {
        fail();
        return;
      }
      lastStartedAt = Date.now();
      timeoutId = setTimeout(fail, remainingMs);
    };

    const handleVisibilityChange = () => {
      if (isHidden()) {
        pauseTimer();
      } else {
        startTimer();
      }
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("focus", handleVisibilityChange);
      window.addEventListener("pageshow", handleVisibilityChange);
      window.addEventListener("pagehide", pauseTimer);
      startTimer();
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      settled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
      window.removeEventListener("pageshow", handleVisibilityChange);
      window.removeEventListener("pagehide", pauseTimer);
    }
  };

  const isRateLimitError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /rate limit|429|failed to get current tick|tick value is expired|tick value is already in the past|expired|already in the past/i.test(
      message,
    );
  };

  const isRetryableWalletConnectSignError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return (
      isRateLimitError(error) || /timed out|timeout|request expired|session expired|session not found|network error/i.test(message)
    );
  };

  const isWalletConnectTimeoutError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out|timeout/i.test(message);
  };

  const connect = (wallet: Wallet): void => {
    // Never persist the private key: it stays in memory only.
    localStorage.setItem("wallet", JSON.stringify({ ...wallet, privateKey: undefined }));
    // A vault login leaves the vault library's copy of the account list (aliases, public ids and the wrapped seeds) in storage; the chosen
    // account is in memory now and nothing needs that copy again.
    localStorage.removeItem("wallet-config");
    setWallet(wallet);
    setConnected(true);
  };

  const disconnect = (): void => {
    // Ending it here ends it in the extension too, so the site is not left approved there.
    if (wallet?.connectType === "extension") void extensionProvider()?.disconnect().catch(() => {});
    localStorage.removeItem("wallet");
    localStorage.removeItem("wallet-config");
    setWallet(null);
    setConnected(false);
  };

  const toggleConnectModal = (): void => {
    setShowConnectModal(!showConnectModal);
  };

  // A connection that can be picked up again after a reload is picked up: the wallet app's session while it is still alive, and the extension while it still shares the same account.
  // A seed or a vault was only ever in memory, so those start from the dialog again. (The saved record holds no secret: the type, the address, the name and the account list.)
  useEffect(() => {
    if (wallet || adoptedAt) return; // already connected, or a new connection was just made and the person is choosing the account
    let saved: Wallet | null = null;
    try {
      saved = JSON.parse(localStorage.getItem("wallet") ?? "null");
    } catch {
      return;
    }
    if (!saved || !/^[A-Z]{60}$/.test(String(saved.publicKey))) return;
    const keep = { connectType: saved.connectType, publicKey: saved.publicKey, alias: saved.alias, accounts: saved.accounts };
    if (saved.connectType === "walletconnect") {
      if (wcConnected) {
        setWallet(keep);
        setConnected(true);
      }
      return;
    }
    if (saved.connectType === "extension") {
      let alive = true;
      (async () => {
        const provider = await waitForExtension();
        const account = provider ? await currentExtensionAccount(provider) : null;
        if (!alive || !account || account.identity !== saved!.publicKey) return;
        setWallet({ ...keep, alias: account.name ?? keep.alias, accounts: [account.identity] });
        setConnected(true);
      })();
      return () => {
        alive = false;
      };
    }
  }, [wallet === null, wcConnected, adoptedAt]);

  // Switching account or disconnecting the site inside the extension is followed here: the extension signs with its active account, so the page must not go on thinking it is the old one.
  useEffect(() => {
    if (wallet?.connectType !== "extension") return;
    const provider = extensionProvider();
    if (!provider) return;
    const was = wallet.publicKey;
    return watchExtension(
      provider,
      (account) => {
        if (!account) {
          disconnect();
          toast.error("The extension no longer shares an account with QMax. Connect it again.");
        } else if (account.identity !== was) {
          connect({ connectType: "extension", publicKey: account.identity, alias: account.name, accounts: [account.identity] });
          toast(`Switched to ${account.name ?? `${account.identity.slice(0, 6)}…${account.identity.slice(-4)}`} in the extension`);
        }
      },
      () => {
        disconnect();
        toast("Disconnected in the Qubic Wallet extension.");
      },
    );
  }, [wallet?.connectType, wallet?.publicKey]);

  // A connection the wallet approved while the page was away is picked up (WalletConnectContext): open the dialog at the choice of account instead of leaving the person to ask again.
  useEffect(() => {
    if (adoptedAt && !wallet) setShowConnectModal(true);
  }, [adoptedAt]);

  const getMetaMaskPublicId = async (accountIdx: number = 0, confirm: boolean = false): Promise<string> => {
    const provider = getResolvedMetaMaskProvider() ?? window.ethereum;
    return await provider.request({
      method: "wallet_invokeSnap",
      params: {
        snapId: defaultSnapOrigin,
        request: {
          method: "getPublicId",
          params: {
            accountIdx,
            confirm,
          },
        },
      },
    });
  };

  const getMetaMaskSignedTx = async (tx: Uint8Array, offset: number, accountIdx: number = 0) => {
    const base64Tx = btoa(String.fromCharCode(...Array.from(tx)));
    const provider = getResolvedMetaMaskProvider() ?? window.ethereum;

    return await provider.request({
      method: "wallet_invokeSnap",
      params: {
        snapId: defaultSnapOrigin,
        request: {
          method: "signTransaction",
          params: {
            base64Tx,
            accountIdx,
            offset,
          },
        },
      },
    });
  };

  const getSignedTx = async (tx: Uint8Array | QubicTransaction): Promise<{ tx: Uint8Array }> => {
    if (!wallet || !connectTypes.includes(wallet.connectType)) {
      throw new Error(`Unsupported connectType: ${wallet?.connectType}`);
    }

    const processedTx = tx instanceof QubicTransaction ? await tx.build("0".repeat(55)) : tx;

    switch (wallet.connectType) {
      case "mmSnap": {
        const mmResult = await getMetaMaskSignedTx(processedTx, processedTx.length - SIGNATURE_LENGTH);
        const binaryTx = atob(mmResult.signedTx);
        const signature = new Uint8Array(binaryTx.length);
        for (let i = 0; i < binaryTx.length; i++) {
          signature[i] = binaryTx.charCodeAt(i);
        }
        processedTx.set(signature, processedTx.length - SIGNATURE_LENGTH);
        return { tx: processedTx };
      }

      case "walletconnect": {
        const decodedTx = processedTx instanceof Uint8Array ? decodeUint8ArrayTx(processedTx) : processedTx;
        const [from, to] = await Promise.all([
          qHelper.getIdentity(decodedTx.sourcePublicKey.getIdentity()),
          qHelper.getIdentity(decodedTx.destinationPublicKey.getIdentity()),
        ]);
        const payloadBase64 = uint8ArrayToBase64(decodedTx.payload.getPackageData());
        let signToastId: string | number | undefined;
        if (wallet?.connectType == "walletconnect") {
          signToastId = toast.loading("Sign in your wallet, then return here", {
            icon: "🔑",
          });
        }
        try {
          let wcResult:
            | {
                signedTransaction: string;
              }
            | undefined;
          const maxSignAttempts = 2;
          for (let attempt = 1; attempt <= maxSignAttempts; attempt++) {
            try {
              wcResult = await withVisibilityAwareTimeout(
                signTransaction({
                  from,
                  to,
                  amount: Number(decodedTx.amount.getNumber()),
                  tick: decodedTx.tick,
                  inputType: decodedTx.inputType,
                  payload: payloadBase64 == "" ? null : payloadBase64,
                }),
                WALLETCONNECT_SIGN_TIMEOUT_MS,
                "Wallet signing timed out. Return to this browser after approving in your wallet, then try again.",
              );
              break;
            } catch (error) {
              const retryable = !isWalletConnectTimeoutError(error) && isRetryableWalletConnectSignError(error);
              if (!retryable || attempt === maxSignAttempts) {
                throw error;
              }
              const backoffMs = attempt * 1500;
              console.warn(
                `[WalletConnect] rate limited while signing (attempt ${attempt}/${maxSignAttempts}), retrying in ${backoffMs}ms`,
              );
              await sleep(backoffMs);
            }
          }
          if (!wcResult?.signedTransaction) {
            throw new Error("WalletConnect signing failed");
          }
          return { tx: base64ToUint8Array(wcResult.signedTransaction) };
        } finally {
          if (signToastId !== undefined) {
            toast.dismiss(signToastId);
          }
        }
      }

      case "extension": {
        const provider = extensionProvider();
        if (!provider) throw new Error("The Qubic Wallet extension is not available on this page any more. Connect it again.");
        const decodedTx = processedTx instanceof Uint8Array ? decodeUint8ArrayTx(processedTx) : processedTx;
        const toastId = toast.loading("Approve in the Qubic Wallet extension", { icon: "🔑" });
        try {
          const destinationIdentity = await qHelper.getIdentity(decodedTx.destinationPublicKey.getIdentity());
          // The extension signs with whichever account is active in it, so what comes back is checked against exactly what was asked (signWithExtension), account included.
          const signed = await withVisibilityAwareTimeout(
            signWithExtension(provider, {
              source: decodedTx.sourcePublicKey.getPackageData(),
              dest: decodedTx.destinationPublicKey.getPackageData(),
              destinationIdentity,
              amount: BigInt(decodedTx.amount.getNumber()),
              tick: decodedTx.tick,
              inputType: decodedTx.inputType,
              payload: decodedTx.payload.getPackageData(),
            }),
            EXTENSION_SIGN_TIMEOUT_MS,
            "The extension did not answer in time. Open it, approve the request, and try again.",
          );
          return { tx: signed };
        } catch (error) {
          throw new Error(extensionMessage(error));
        } finally {
          toast.dismiss(toastId);
        }
      }

      default: {
        if (!wallet.privateKey) throw new Error("Private key required");
        const qCrypto = await Crypto;
        const idPackage = await qHelper.createIdPackage(wallet.privateKey);
        const digest = new Uint8Array(SIGNATURE_LENGTH);
        const toSign = processedTx.slice(0, processedTx.length - SIGNATURE_LENGTH);

        qCrypto.K12(toSign, digest, SIGNATURE_LENGTH);
        const signedTx =
          tx instanceof QubicTransaction
            ? await tx.build(wallet.privateKey)
            : qCrypto.schnorrq.sign(idPackage.privateKey, idPackage.publicKey, digest);
        return { tx: signedTx || new Uint8Array(144) };
      }
    }
  };

  const mmSnapConnect = async () => {
    try {
      await connectSnap(!state.isFlask ? "npm:@qubic-lib/qubic-mm-snap" : undefined);
      const installedSnap = await getSnap();
      // get publicId from snap
      const publicKey = await getMetaMaskPublicId(0);
      const wallet = {
        connectType: "mmSnap",
        publicKey,
      };
      connect(wallet);
      dispatch({
        type: MetamaskActions.SetInstalled,
        payload: installedSnap,
      });
    } catch (error) {
      console.error(error);
      dispatch({
        type: MetamaskActions.SetError,
        payload: error,
      });
    }
  };

  const privateKeyConnect = async (privateSeed: string) => {
    const idPackage = await new QubicHelper().createIdPackage(privateSeed);
    connect({
      connectType: "privateKey",
      privateKey: privateSeed,
      publicKey: idPackage.publicId,
    });
  };

  const vaultFileConnect = async (selectedFile: File, password: string): Promise<QubicVault> => {
    if (!selectedFile || !password) {
      throw new Error("Please select a file and enter a password.");
    }
    const vault = new QubicVault();
    await vault.importAndUnlock(
      true,  // selectedFileIsVaultFile
      password,
      null,  // selectedConfigFile
      selectedFile,
      true,  // unlock
    );
    return vault;
  };

  const contextValue: QubicConnectContextType = {
    connected,
    wallet,
    showConnectModal,
    connect,
    disconnect,
    toggleConnectModal,
    getMetaMaskPublicId,
    getSignedTx,
    mmSnapConnect,
    privateKeyConnect,
    vaultFileConnect,
  };

  return (
    <MetaMaskProvider>
      <QubicConnectContext.Provider value={contextValue}>{children}</QubicConnectContext.Provider>
    </MetaMaskProvider>
  );
}

export function useQubicConnect(): QubicConnectContextType {
  const context = useContext(QubicConnectContext);
  if (context === undefined) {
    throw new Error("useQubicConnect() hook must be used within a <QubicConnectProvider>");
  }
  return context;
}
