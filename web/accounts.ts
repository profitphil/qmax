/**
 * Switching to another of a wallet's accounts while connected. A wallet app's connection lists all of its accounts in the session and signs for any of them when asked, so QMax can
 * offer them without another trip to the wallet. A seed or a vault was connected with one account (switching would need the seed again), MetaMask holds one, and the browser
 * extension signs with whichever account is active in it, which QMax already follows (so there the person switches in the extension).
 */
export const SWITCHABLE_TYPES: readonly string[] = ["walletconnect"];

/** The other accounts that can be switched to: real addresses, once each, never the current one, in the order the wallet listed them. */
export function otherAccounts(connectType: string | undefined, current: string, accounts: readonly string[] | undefined): string[] {
  if (!connectType || !SWITCHABLE_TYPES.includes(connectType) || !Array.isArray(accounts)) return [];
  const out: string[] = [];
  for (const a of accounts) {
    if (typeof a === "string" && /^[A-Z]{60}$/.test(a) && a !== current && !out.includes(a)) out.push(a);
  }
  return out;
}

/** What the wallet menu says about switching when the list cannot be offered (the extension: it is done there). */
export const switchHint = (connectType: string | undefined): string | null => (connectType === "extension" ? "To use another account, switch in the Qubic Wallet extension: QMax follows." : null);
