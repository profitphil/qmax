/**
 * The price to show for an asset right now. The order books and pools are read every few minutes, so `priceQu` (the middle of the best bid and ask, or the pool's price)
 * can be old; the newest trade is known to within seconds. When a trade happened after the books were last read, its price is the fresher one and is shown;
 * otherwise (no trade since, or none on record) it is `priceQu`.
 */
export function livePrice(a: { priceQu: number | null; lastPriceQu?: number | null; lastTradeAt?: number | null; probedAt?: number | null }): number | null {
  const fresher = a.lastTradeAt != null && a.lastPriceQu != null && a.lastPriceQu > 0 && a.lastTradeAt > (a.probedAt ?? 0);
  return fresher ? (a.lastPriceQu as number) : a.priceQu;
}
