/**
 * Which calls to QX and QSwap are orders, swaps and liquidity changes. Kept apart from the usage counting (which reads files) so the browser can use it too: the page and
 * the broadcast relay both need to tell such a call from a share move or a payment.
 */

/** What a transaction to QX or QSwap is, from its procedure number (Qx.h and Qswap.h). Null for anything that is not an order, a swap or a liquidity change. */
export function classifyCall(venue: "QX" | "QSwap", inputType: number): { kind: "trade" | "liquidity"; side?: "buy" | "sell" } | null {
  if (venue === "QX") {
    if (inputType === 6) return { kind: "trade", side: "buy" }; // AddToBidOrder
    if (inputType === 5) return { kind: "trade", side: "sell" }; // AddToAskOrder
    return null; // cancelling an order, moving shares, transfers, or reading
  }
  if (inputType === 6 || inputType === 7) return { kind: "trade", side: "buy" }; // QU in
  if (inputType === 8 || inputType === 9) return { kind: "trade", side: "sell" }; // asset in
  if (inputType === 4 || inputType === 5) return { kind: "liquidity" };
  return null;
}

/** The steps of a plan that are an order, a swap or a liquidity change, so what the page and the Discord bot tell QMax about. Share moves, cancellations and payments are not. */
export const COUNTED_STEP_KINDS: readonly string[] = ["qx-bid", "qx-ask", "qswap-buy", "qswap-sell", "add-liquidity", "remove-liquidity"];
