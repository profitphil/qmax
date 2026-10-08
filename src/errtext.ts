/**
 * The words in anything that was thrown. A wallet answers over WalletConnect with a { code, message } object, not an Error, and printing that gave "[object Object]" in the
 * middle of a failed trade: the person had no idea whether the wallet had refused, timed out or been rate limited.
 */
export function errorText(e: unknown, depth = 0): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && depth < 3) {
    const o = e as { message?: unknown; error?: unknown; reason?: unknown };
    if (typeof o.message === "string" && o.message) return o.message;
    if (o.error !== undefined) {
      const inner = errorText(o.error, depth + 1);
      if (inner && inner !== "[object Object]") return inner;
    }
    if (typeof o.reason === "string" && o.reason) return o.reason;
    try {
      const json = JSON.stringify(e);
      if (json && json !== "{}") return json.slice(0, 200);
    } catch {
      // not printable: fall through
    }
  }
  return String(e);
}

/**
 * What a person is told when a step failed, for the failures a wallet is known to give: what happened, whether anything was sent, and what to do. Anything else keeps the wallet's own words.
 * (These are the wallet's messages, so the step failed before anything was broadcast.)
 */
export function stepFailure(e: unknown): string {
  const text = errorText(e);
  if (/failed to get current tick/i.test(text) && /rate.?limit|\b429\b/i.test(text))
    return "Your wallet app could not reach the Qubic network: the public node is rate limiting requests right now (many apps share it, and a VPN makes it worse). Nothing was sent. Wait a minute and try again.";
  if (/tick value is expired|tick.{0,20}expired/i.test(text) && !/signing took too long/i.test(text))
    return "The transaction's time slot had already passed when the wallet signed it (approving took too long). Nothing was sent. Try again and approve within about 30 seconds.";
  if (/user (rejected|denied|declined|cancel)|rejected by (the )?user|request (was )?(rejected|declined)/i.test(text)) return "You rejected the request in your wallet. Nothing was sent.";
  return text;
}
