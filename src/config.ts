/**
 * Whether the website asks for a pass before trading. It does not: trading on the website, the API, the SDK and MCP are free, and the only
 * thing QMax charges for is the Discord bot's subscription. Build the website with VITE_REQUIRE_PASS=on to bring the pass back.
 * (`import.meta.env` is Vite's, so outside it, in tests and Node, the answer is always "not required".)
 */
export const passRequired = (): boolean => (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_REQUIRE_PASS === "on";

/**
 * QMax has no per-trade fee. Trading is unlocked for a wallet by paying `priceQu` once to `recipient`
 * (through QPayhub) for `hours` hours.
 */
export const PAYWALL = {
  recipient: "QDOGEEESKYPAICECHEAHOXPULEOADTKGEJHAVYPFKHLEWGXXZQUGIGMBUTZE",
  priceQu: 1000,
  hours: 24,
};
