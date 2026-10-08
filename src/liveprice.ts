/**
 * The price to show for an asset. The API already decides it (`priceQu`: the price of the newest QX trade when that is recent, an older trade kept inside today's QX bid and ask,
 * and for an asset with no QX trade the middle of its QX bid and ask; see `priceFromQx` in src/api.ts). Where an answer carries only `lastPriceQu`, that is used.
 */
export function livePrice(a: { priceQu: number | null; lastPriceQu?: number | null; lastTradeAt?: number | null; probedAt?: number | null }): number | null {
  return a.priceQu ?? (a.lastPriceQu != null && a.lastPriceQu > 0 ? a.lastPriceQu : null);
}

/** How long ago the newest QX trade was, in words ("3 hours ago"), or null when there is none on record. */
export function lastTradeAge(a: { lastPriceQu?: number | null; lastTradeAt?: number | null }, now = Date.now()): string | null {
  if (a.lastTradeAt == null || !(a.lastPriceQu != null && a.lastPriceQu > 0)) return null;
  const minutes = Math.max(0, Math.round((now - a.lastTradeAt) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 120) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
