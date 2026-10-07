# @qmax/sdk

A typed client for the QMax API, the pieces that turn a quote into transactions, and links that send a user to QMax with the order filled in. Use it on your **server**: your API key spends your prepaid balance, so never put it in a browser.

**Install** it from the site (an npm package with types; also one ES module file, `qmax-sdk.js`, for any runtime), and check the download against [SHA256SUMS](https://qmax.exchange/agents/SHA256SUMS):
```bash
npm install https://qmax.exchange/agents/qmax-sdk.tgz
```

```ts
import { QMaxClient, buildExecutionPlan, stepDestinationKey } from "@qmax/sdk";

const qmax = new QMaxClient({ baseUrl: "https://api.qmax.example", apiKey: process.env.QMAX_KEY });

// Best price for 5,000 CFB. Only a split across QX and QSwap is billed; split: false is always free.
const quote = await qmax.quote({ side: "buy", asset: "CFB", qty: 5000, slippageBps: 100 });
quote.route;        // [{ venue: "QX", qty, totalQu, ... }, { venue: "QSwap", ... }]

// The transactions your wallet flow signs, in order. Limits (slippage) are already in the payloads.
const plan = buildExecutionPlan(quote, holdings);   // holdings: shares per managing contract, needed when selling
for (const step of plan.steps) {
  step.to;          // { contractIndex } or { identity }; stepDestinationKey(step.to) gives the 32-byte key
  step.amountQu;    // QU to attach
  step.inputType;   // procedure number
  step.payload;     // Uint8Array
}
```

## Order books and price history
```ts
const book = await qmax.book("CFB", 15);        // QX ladder (grouped by price, cumulative size, spread) and the QSwap pool (price, and how far bigger trades move it)
const history = await qmax.history("CFB", "7d", "1h"); // prices the server recorded; "1h" also returns open/high/low/close candles
const svg = priceChartSvg(history.points, { symbol: "CFB", rangeLabel: "7D" }); // an SVG string you can put in a page
const depth = depthChartSvg(book.qx!, { symbol: "CFB" });
const bars = await qmax.candles("CFB", "30d");   // { candles: [{ t, o, h, l, c, volumeQu, volumeQty, trades }], volume24hQu, trades24h, ... }
const svg2 = candleChartSvg(bars.candles, { symbol: "CFB", rangeLabel: "30D", intervalMs: 4 * 3_600_000 }); // candles with a volume panel
```
Free (limited per IP without a key). Points before `recordedSince` are hourly averages rebuilt from past QX and QSwap trades (marked `src: "trades"`, about six months back); after it they are recorded about every 10 minutes. An asset with no history returns an empty list, not an error.

## Funding a key
```ts
const { key, keyId } = await new QMaxClient({ baseUrl }).createKey();   // shown once: store it
const tx = await qmax.topupTransaction(keyId, 50_000);                    // a QPayhub payment to sign and send
//   send tx.amountQu to contract tx.contractIndex, inputType tx.inputType, payload base64 tx.payload
await qmax.claimTopup({ keyId, payer: "YOUR_IDENTITY", nonce: tx.nonce }); // after it confirms
await qmax.account();                                                      // balance and prices
```
Prices are in `account()`: a split quote and an arbitrage result each have their own. A call that cannot be paid throws `QMaxError` with `status 402` and `needsTopup`; its `body` says what you would have gained (`splitWouldSaveQu`, `opportunityProfitQu`).

## Max: the best position for a trade (100 QU a plan)
```ts
const plan = await qmax.max({ asset: "CFB", side: "buy", balanceQu: 2_000_000, slippageBps: 100 });
// plan.picks: ordinary actions (a market order at the best route, a resting limit order at the touch, an arbitrage, an exit) with what each should give; plan.recommendedId
```
Max searches for the best position, not just the best route; nothing is signed or sent, and prices move, so quote and check every action again before signing. **For agents a plan costs QU** (`account().maxPriceQu`, 100 at qmax.exchange): it is taken from your key's balance once the plan is made, or free inside an x402 session. Without either the call throws `QMaxError` with `status 402` and `body.priceQu`. A request that cannot be planned (bad asset, nothing to plan from) is not charged. Keys and top-ups are as under "Funding a key" (a 10,000 QU top-up buys 100 plans; a payment per plan is not offered, because QPayhub's 100 QU minimum fee would eat it).

## Agents: pay by x402, sign your own trades
No account is needed. An agent buys a time-limited session through QPayhub (the Q+Pay x402 format) and signs its own trades; QMax never holds its key.

```ts
import { QMaxClient, createX402Fetch } from "@qmax/sdk";
import { agentTrade, contractPayer, seedSigner } from "@qmax/sdk/agent";   // Node only

const signer = await seedSigner(process.env.QMAX_AGENT_SEED!);            // 55 lowercase letters; keep it in the environment
const pay = createX402Fetch({
  payer: contractPayer(signer),     // only ever pays QPayhub, whatever a 402 says
  maxAmountPerCall: 10_000,         // refuses a price above this
  maxTotalSpend: 30_000,            // and stops after this much in total
});
const qmax = new QMaxClient({ baseUrl: "https://api.qmax.example", fetch: pay });

// Past the free limit the API answers 402; the client pays for a session once, then reuses it.
const trade = await agentTrade({
  client: qmax,
  signer,
  side: "buy",
  asset: "CFB",
  qty: 5000,
  limits: { maxOutlayQu: 120_000, maxAveragePriceQu: 22 },   // required; selling also needs minAveragePriceQu
  slippageBps: 100,
});
trade.ok;        // every step confirmed
trade.outcome;   // what the wallet really received, read back after the trade
```
- `limits.maxOutlayQu` is required and is checked against the plan's worst case (venue fees included) before anything is signed. A violation throws `TradeRefused` with every problem listed (`problems`).
- The plan can only call QX and QSwap; the payer can only pay QPayhub. A hostile or buggy server cannot make the agent send money elsewhere.
- A session costs `session.priceQu` for `session.seconds` (see `GET /v1/x402`). Payments are single-flight, so concurrent calls share one purchase. `pay.stats()` shows the total spent; `pay.clearSession()` forgets the session.
- Errors are `X402Error` with a `code` (`limit_per_call` and `limit_total` for your caps, `payer_wrong_destination`, `pay_failed`, `pay_no_money`, `confirm_timeout`, ...).
- This pays real QU. Use a wallet that holds only what the agent needs.

## Sending users to QMax instead
```ts
buildDeepLink("https://qmax.example", { asset: "CFB", side: "buy", qty: 5000, ref: "yoursite" });
// https://qmax.example/?asset=CFB&side=buy&qty=5000&ref=yoursite
```
QMax opens its trade screen with the order filled in; the user connects a wallet and signs there. `ref` is a tag (1 to 32 letters, digits, `-` or `_`) that QMax counts, for opens and completed trades.

## Things to plan for
- A quote is a snapshot. Keep the slippage limits and re-quote shortly before the user signs (a re-quote that is still a split is billed again).
- A sell from shares managed by the other venue starts with a rights-move step. The steps are separate transactions, so show progress and stop at the first failure.
- `buildExecutionPlan` throws on a quote from a server serving demo data, which has no execution details.

Build with `npm run sdk:build` in the QMax repo (output in `sdk/dist`).
