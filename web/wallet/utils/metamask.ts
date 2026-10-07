import { getSnaps } from "./snap";

// Module-level reference to the resolved MetaMask provider so all snap
// calls (wallet_requestSnaps, wallet_invokeSnap, etc.) use the same one.
let resolvedMetaMaskProvider: any = null;

export const getResolvedMetaMaskProvider = () => resolvedMetaMaskProvider;

/**
 * Discover the MetaMask provider via EIP-6963 (MetaMask v13+).
 * Dispatches `eip6963:requestProvider` and waits up to `timeoutMs` for
 * an announcement whose `rdns` is `io.metamask`.
 */
const getMetaMaskProviderEIP6963 = (timeoutMs = 500): Promise<any | null> => {
  return new Promise((resolve) => {
    const found: any[] = [];
    // Only a provider that announced itself as MetaMask is used. If none did, the answer is "none": the first provider that announced itself,
    // whatever it is, is not a safe stand-in (the signing snap would be asked of it).
    const timeoutId = setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", handler);
      resolve(null);
    }, timeoutMs);

    const handler = (event: any) => {
      const rdns: string = event.detail?.info?.rdns ?? "";
      if (rdns === "io.metamask" || rdns.startsWith("io.metamask.")) {
        clearTimeout(timeoutId);
        window.removeEventListener("eip6963:announceProvider", handler);
        resolve(event.detail.provider);
      } else if (event.detail?.provider) {
        found.push(event.detail.provider);
      }
    };

    window.addEventListener("eip6963:announceProvider", handler);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  });
};

/**
 * Tries to detect MetaMask and checks if the Snaps API is available.
 * Priority order:
 *  1. EIP-6963 announcement (MetaMask v13+)
 *  2. window.ethereum.detected  (legacy multi-wallet)
 *  3. window.ethereum.providers (legacy multi-wallet)
 *  4. window.ethereum directly  (single wallet fallback)
 *
 * @returns True if a MetaMask provider that supports Snaps was found.
 */
export const detectSnaps = async () => {
  // ── 1. EIP-6963 (MetaMask v13+) ───────────────────────────────────────
  const eip6963Provider = await getMetaMaskProviderEIP6963();
  if (eip6963Provider) {
    try {
      await getSnaps(eip6963Provider);
      resolvedMetaMaskProvider = eip6963Provider;
      try {
        window.ethereum = eip6963Provider;
      } catch {
        // window.ethereum may be read-only; ignore
      }
      return true;
    } catch {
      // snap API not available on this provider
    }
  }

  // ── 2. Legacy: window.ethereum.detected ───────────────────────────────
  if (window.ethereum?.detected) {
    for (const provider of window.ethereum.detected) {
      try {
        await getSnaps(provider as any);
        if (window.ethereum.setProvider) {
          window.ethereum.setProvider(provider);
        }
        resolvedMetaMaskProvider = provider;
        return true;
      } catch {
        // try next
      }
    }
  }

  // ── 3. Legacy: window.ethereum.providers ──────────────────────────────
  if (window.ethereum?.providers) {
    for (const provider of window.ethereum.providers) {
      try {
        await getSnaps(provider as any);
        resolvedMetaMaskProvider = provider;
        try {
          window.ethereum = provider;
        } catch {
          // read-only; ignore
        }
        return true;
      } catch {
        // try next
      }
    }
  }

  // ── 4. Direct window.ethereum fallback ────────────────────────────────
  try {
    await getSnaps();
    resolvedMetaMaskProvider = window.ethereum;
    return true;
  } catch {
    return false;
  }
};

/**
 * Detect if the wallet injecting the ethereum object is MetaMask Flask.
 *
 * @returns True if the MetaMask version is Flask, false otherwise.
 */
export const isFlask = async () => {
  const provider = resolvedMetaMaskProvider ?? window.ethereum;

  try {
    const clientVersion = await provider?.request({
      method: "web3_clientVersion",
    });

    const isFlaskDetected = (clientVersion as string[])?.includes("flask");

    return Boolean(provider && isFlaskDetected);
  } catch {
    return false;
  }
};

/**
 * Detect if MetaMask is installed.
 *
 * @returns True if MetaMask is installed, false otherwise.
 */
export const isMetaMaskInstalled = () => Boolean(window.ethereum);
