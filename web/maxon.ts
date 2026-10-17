/**
 * Whether Max mode is on for this browser. It is on unless the person switched it off (in Settings): Max is free for everyone, so a new visitor gets everything, including the
 * market each trade was on, the arbitrage flags and Max swaps, and is not asked to turn anything on. A mark of "0" is the person's own choice to switch it off; any other
 * state (nothing stored, "1", a browser that blocks storage) means on.
 */
export const MAX_KEY = "qmax.max.on";

export function readMaxOn(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(MAX_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * Whether the order panel puts the "Max: best position" button above the ordinary one. Max plans a trade that fills now (and may suggest a bid beside it): it knows nothing of the price
 * a person typed for a limit order, so while Limit is chosen the limit button is the only action and Max stays out of its way (a limit order is exactly what was asked for).
 */
export const showMaxButton = (maxActive: boolean, connected: boolean, limitOrder: boolean): boolean => maxActive && connected && !limitOrder;
