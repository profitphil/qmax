const quoteParams = [
  { name: "side", in: "query", required: true, schema: { type: "string", enum: ["buy", "sell"] } },
  { name: "asset", in: "query", required: true, schema: { type: "string" }, example: "QX" },
  { name: "qty", in: "query", required: true, schema: { type: "integer", minimum: 1 }, example: 5000 },
  { name: "slippageBps", in: "query", schema: { type: "integer", minimum: 0, maximum: 1000, default: 100 }, description: "Slippage tolerance in basis points, applied to the execution limits in route[].execution" },
  { name: "split", in: "query", schema: { type: "boolean", default: true }, description: "Allow splitting across venues" },
];

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "QMax API",
    version: "1.0.0",
    description:
      "Liquidity router for Qubic. Quotes a buy or sell across the QX order book and QSwap pool and returns the cheapest route (single venue or split). All amounts are in QU; quantities are whole asset units. Billing: only a split quote (a route across both QX and QSwap) costs a prepaid amount (100 QU by default) when you send an x-api-key. An arbitrage check that finds an opportunity costs its own price (50 QU by default); \"none right now\", single-venue quotes, listings, search and these docs cost nothing. Without a key, quotes are limited per IP. Create a key with POST /v1/keys, fill it with GET /v1/topup (a QPayhub payment), then POST /v1/topup/claim. Agents with no account can instead buy a time-limited session by x402 (see GET /v1/x402): a 402 answer carries the price and a ticket, the agent pays QPayhub on-chain and retries with an X-PAYMENT header, and the reply carries an X-ACCESS-GRANT token that lifts the free rate limit for the session, with no per-call charge. ",
  },
  paths: {
    "/v1/quote": {
      get: {
        summary: "Get the best route for an order",
        parameters: quoteParams,
        responses: { "200": { description: "Route quote" }, "400": { description: "Invalid input" }, "404": { description: "Unknown asset" } },
      },
      post: {
        summary: "Same as GET, with a JSON body { side, asset, qty, split? }",
        responses: { "200": { description: "Route quote" }, "400": { description: "Invalid input" } },
      },
    },
    "/v1/assets": {
      get: {
        summary: "Tradable assets, busiest first",
        description: "Each asset has id, symbol, issuer, category ('contract' = smart contract shares, 'token' = everything else), venues, priceQu and liquidityQu (`priceQu` is drawn from QX, where every asset trades: the price of the asset's newest QX trade when that is within 7 days, an older trade kept inside today's QX bid and ask, and for an asset with no QX trade the middle of its QX bid and ask; `lastPriceQu` and `lastTradeAt` are the raw trade and when it was, and `bookPriceQu` is the order-book or pool price, which a QSwap pool nobody trades against can leave far from the market), and (when the server keeps trade history) volume24hQu, volume72hQu, volume7dQu and trades24h: what traded on QX and QSwap together, and change24hPct, change72hPct and change7dPct: how far the price moved in 24 hours, 72 hours and 7 days (null when nothing traded to measure it). The list is the busiest first (most QU traded in 24 hours, then in 7 days, then the most liquid); `sort=liquidity` gives the most liquid first. `ready` is false until the first network scan finishes.",
        parameters: [
          { name: "category", in: "query", schema: { type: "string", enum: ["contract", "token"] } },
          { name: "q", in: "query", schema: { type: "string" }, description: "Filter by symbol" },
          { name: "sort", in: "query", schema: { type: "string", enum: ["volume", "liquidity"], default: "volume" }, description: "volume: busiest first. liquidity: most liquid first." },
        ],
        responses: { "200": { description: "Asset list" } },
      },
    },
    "/v1/arbitrage": {
      get: {
        summary: "Check an asset for arbitrage between QX and QSwap, live and at full depth",
        description: "Searches buy-on-one-market, sell-on-the-other loops after every venue fee and returns the most profitable size, or null. A snapshot: the two legs are separate transactions.",
        parameters: [
          { name: "asset", in: "query", required: true, schema: { type: "string" } },
          { name: "minProfitQu", in: "query", schema: { type: "number", minimum: 0 }, description: "Only an arbitrage with at least this profit (QU)" },
          { name: "minProfitPct", in: "query", schema: { type: "number", minimum: 0 }, description: "Only an arbitrage with at least this profit as a percentage of the QU put in" },
          { name: "maxCostQu", in: "query", schema: { type: "number", minimum: 0 }, description: "Budget: the most QU to put in. The search returns the best loop that fits, not the biggest" },
        ],
        responses: { "200": { description: "{ asset, checkedAt, bothMarkets, opportunity }" } },
      },
    },
    "/v1/assets/search": {
      get: {
        summary: "Find a token by name on the network and add it to the list",
        parameters: [{ name: "name", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Tradable matches (several if different issuers use the same name)" } },
      },
    },
    "/v1/book": {
      get: {
        summary: "The order book and pool of an asset, ready to show",
        description: "QX: resting orders grouped by price with cumulative size, the best bid and ask and the spread. QSwap: pool reserves and the price, plus how far a trade of 0.1%, 0.5%, 1%, 2% and 5% of the pool would move it. Free; limited per IP without a key.",
        parameters: [
          { name: "asset", in: "query", required: true, schema: { type: "string" } },
          { name: "levels", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 15 }, description: "Price levels per side" },
        ],
        responses: { "200": { description: "{ asset, checkedAt, qx, qswap }" } },
      },
    },
    "/v1/history": {
      get: {
        summary: "Prices recorded over time",
        description: "Prices over time, in two parts. Before QMax started recording, points are rebuilt from the trades the network logged (QX fills and QSwap swaps): one hourly volume-weighted average per hour that had trades, marked `src: \"trades\"`, going back about six months. From `recordedSince` on, QMax records the price, best bid and ask and pool price each time it reads the markets (about every 10 minutes). Free; limited per IP without a key.",
        parameters: [
          { name: "asset", in: "query", required: true, schema: { type: "string" } },
          { name: "range", in: "query", schema: { type: "string", enum: ["1d", "7d", "30d", "90d", "all"], default: "7d" } },
          { name: "interval", in: "query", schema: { type: "string", enum: ["1h", "4h", "1d"] }, description: "Also return open, high, low, close candles of this size" },
        ],
        responses: { "200": { description: "{ asset, range, since, recordedSince, points, candles? }" } },
      },
    },
    "/v1/keys": {
      post: {
        summary: "Create an API key (free, balance starts at 0)",
        description: "The key is shown once. Limited to a few per hour per IP.",
        responses: { "201": { description: "{ key, keyId, balanceQu, splitPriceQu, arbitragePriceQu, minTopupQu }" } },
      },
    },
    "/v1/account": {
      get: {
        summary: "Balance and call count for your key",
        security: [{ apiKey: [] }],
        responses: { "200": { description: "{ keyId, balanceQu, calls, splitPriceQu, arbitragePriceQu, minTopupQu }" }, "401": { description: "Unknown key" } },
      },
    },
    "/v1/topup": {
      get: {
        summary: "The transaction that tops up a key",
        description:
          "Returns a transaction to sign and broadcast from any wallet: send `amountQu` QU to QPayhub (contract index 29) with inputType 1 and the given base64 payload, which is Pay(seller, resourceId, nonce). QPayhub forwards the payment to QMax and records a receipt that names the key. Then call POST /v1/topup/claim. Amounts below minTopupQu are refused because QPayhub keeps at least 100 QU of every payment.",
        parameters: [
          { name: "keyId", in: "query", required: true, schema: { type: "string" } },
          { name: "amountQu", in: "query", required: true, schema: { type: "integer" } },
          { name: "nonce", in: "query", schema: { type: "string" }, description: "Optional; random if omitted" },
        ],
        responses: { "200": { description: "{ contractIndex, inputType, amountQu, payload, nonce }" } },
      },
    },
    "/v1/topup/claim": {
      post: {
        summary: "Credit a confirmed top-up to a key",
        description: "Reads the receipt from QPayhub (payer + this key + nonce) and adds the amount paid to the balance. Each payment counts once.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["keyId", "payer", "nonce"], properties: { keyId: { type: "string" }, payer: { type: "string", description: "Identity that signed the payment" }, nonce: { type: "string" } } } } } },
        responses: { "200": { description: "{ ok, creditedQu, balanceQu }" }, "400": { description: "No receipt yet, or already credited" } },
      },
    },
    "/v1/candles": {
      get: {
        summary: "Candles of real trades, with volume",
        description:
          "Open, high, low, close, QU volume, units traded and trade count for each candle, built from the trades QX and QSwap logged (a minute wide at the finest, back about six months: the Qubic archive has no trade records before epoch 207, April 2026). If the server has read Quhub's older QX history (`npm run import-quhub`), candles before the archive's first day come from there, QX only, marked `src: \"quhub\"` (the chain cannot confirm them); `approx: true` says a candle is a daily summary drawn as a candle (it opens at the previous day's average price and closes at that day's), which is all there is for an asset with more than 1,000 trades before April 2026. A candle exists only where something traded, so a gap means no trades. `venue` is one market, or `all` to treat QX and QSwap as one (highs and lows span both, volumes add up); `auto` follows the market the live price comes from (QSwap if the asset has a pool, else QX). The response also gives the last 24 hours of volume across both venues. Free; limited per IP without a key.",
        parameters: [
          { name: "asset", in: "query", required: true, schema: { type: "string" } },
          { name: "range", in: "query", schema: { type: "string", enum: ["1d", "7d", "30d", "90d", "all"], default: "7d" } },
          { name: "interval", in: "query", schema: { type: "string", enum: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] }, description: "Candle width. Default: 1h for 1d and 7d, 4h for 30d, 1d for 90d and all. One answer holds at most the latest 5,000 candles (`truncated` and `available` say so)." },
          { name: "venue", in: "query", schema: { type: "string", enum: ["auto", "QX", "QSwap", "all"], default: "auto" } },
        ],
        responses: { "200": { description: "{ asset, range, interval, venue, candles: [{ t, o, h, l, c, volumeQu, volumeQty, trades }], truncated?, available?, volume24hQu, trades24h }" }, "404": { description: "Unknown asset, or trade history is off on this server" } },
      },
    },
    "/v1/x402": {
      get: {
        summary: "How to buy a session by x402 (Q+Pay format)",
        description:
          "Describes the x402 offer: scheme exact, network qubic:mainnet, asset QUBIC, the QPayhub address to pay, the seller id, and the session's price and length. Nothing here costs anything. Absent (404) when the operator has turned x402 off.",
        responses: { "200": { description: "{ x402Version, kinds, asset, payTo, sellerId, session: { priceQu, seconds, resourceId }, how }" }, "404": { description: "x402 is not enabled on this server" } },
      },
    },
    "/v1/session": {
      get: {
        summary: "Buy (or check) an x402 session",
        description:
          "Without a session or payment this answers 402 with the x402 body: accepts[0] gives the exact amount, payTo (QPayhub) and extra.{sellerId, resourceId, settlement:'contract'}, and paymentTicket carries a nonce. Pay on-chain with QPAYHUB.Pay (inputType 1; seller = sellerId, resource = sha256(resourceId), the ticket's nonce, exactly that amount), then repeat the request with `X-PAYMENT: base64(JSON { x402Version: 2, resource, accepted, payload: { txHash, ticket }, extensions })`. The server finds the payment in QPayhub's receipt, checks payer, seller, resource, nonce and amount, counts each payment once, and returns 200 with `X-ACCESS-GRANT` and `X-ACCESS-GRANT-EXPIRES`. Send the grant as `X-ACCESS-GRANT` on later requests. If the transaction is not confirmed yet the 402 says `invalid_transaction_state`: wait a few seconds and send the same header again. Inside a session there is no per-call charge for split quotes or arbitrage results, and the rate limit is the keyed one (ten times the free limit), counted for the session rather than the IP address.",
        parameters: [
          { name: "X-PAYMENT", in: "header", schema: { type: "string" }, description: "base64 JSON payment payload after paying QPayhub" },
          { name: "X-ACCESS-GRANT", in: "header", schema: { type: "string" }, description: "Session token from an earlier purchase" },
        ],
        responses: {
          "200": { description: "{ ok, expiresAt, seconds, note }; headers X-PAYMENT-RESPONSE, X-ACCESS-GRANT, X-ACCESS-GRANT-EXPIRES" },
          "402": { description: "x402 challenge, or a rejection with a reason such as invalid_transaction_state (retry), payment_already_used, invalid_payment_nonce_mismatch or recipient_mismatch" },
        },
      },
    },
    "/health": { get: { summary: "Liveness check", responses: { "200": { description: "ok" } } } },
  },
  components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } } },
};
