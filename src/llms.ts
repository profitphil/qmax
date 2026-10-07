import { agentPlan, supportUrl } from "./plans.ts";
import { Raw } from "./routes.ts";
import type { Route } from "./routes.ts";

/**
 * `GET /llms.txt`: the page an AI agent (or the crawler behind one) reads to learn what QMax is and how to use it, in the Markdown shape the llms.txt convention asks for.
 * It is made from the same settings the API starts with, so the prices and limits it states are the real ones and cannot go stale the way a hand-written file would.
 * nginx serves it at the site's root (`/llms.txt`), where agents look.
 */

const n = (x: number) => x.toLocaleString("en-US");
const span = (seconds: number) => (seconds === 3600 ? "1 hour" : seconds % 3600 === 0 ? `${seconds / 3600} hours` : `${Math.round(seconds / 60)} minutes`);

/** The API's public address (PUBLIC_BASE_URL, which includes /api behind nginx) without a trailing slash, or "" when it is not set. */
const apiBaseOf = (env: Record<string, string | undefined>) => (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
/** The website's address: the API's with its /api prefix taken off. */
const siteOf = (apiBase: string) => apiBase.replace(/\/api$/, "");

export function llmsText(env: Record<string, string | undefined>): string {
  const api = apiBaseOf(env) || "https://qmax.exchange/api";
  const site = siteOf(api);
  const agents = agentPlan(env);
  const perMin = Number(env.API_FREE_PER_MIN) > 0 ? Number(env.API_FREE_PER_MIN) : 60;
  const tip = supportUrl(env);

  const max =
    agents.maxPriceQu !== null
      ? `- [Max plan](${api}/v1/max?asset=QDOGE&side=buy&balanceQu=5000000): the best position for a trade, not just the best route (a normal quote already takes the best route): the best way to execute (a market order now, a resting limit order at the touch, or both), the size where one more unit starts to cost more, an arbitrage between QX and QSwap sized to the wallet, and, for a sale, the best exit. Nothing is signed or sent. **Costs ${n(agents.maxPriceQu)} QU per plan for agents**, charged only for a plan that was made.`
      : `- [Max plan](${api}/v1/max?asset=QDOGE&side=buy&balanceQu=5000000): the best position for a trade, not just the best route: how to execute, the best size, an arbitrage sized to the wallet, the best exit. Nothing is signed or sent. Free.`;

  const pay =
    agents.maxPriceQu !== null
      ? [
          "",
          "## Paying for Max plans (x402)",
          "",
          `QMax follows Q+Pay's x402 wire format (scheme \`exact\`, network \`qubic:mainnet\`, asset \`QUBIC\`), settled on-chain through QPayhub, so an agent that already pays Q+Pay resources can pay QMax the same way, with no account. Two ways to pay for a Max plan:`,
          "",
          ...(agents.sessionPriceQu && agents.sessionSeconds
            ? [`- **An x402 session:** ${n(agents.sessionPriceQu)} QU buys ${span(agents.sessionSeconds)} of unlimited Max plans. Call \`GET ${api}/v1/max\` without a session: the 402 answer carries the price, a payment ticket and the exact QPayhub payment to make; pay it, then repeat the same request with an \`X-PAYMENT\` header. The reply carries \`X-ACCESS-GRANT\`: send it on later calls for the rest of the session. [Offer](${api}/v1/x402)`]
            : []),
          `- **A prepaid key:** \`POST ${api}/v1/keys\` makes a key (shown once), \`GET ${api}/v1/topup\` gives the QPayhub payment that fills its balance, \`POST ${api}/v1/topup/claim\` counts it once it confirms, and then each plan takes ${n(agents.maxPriceQu)} QU from the balance (send \`x-api-key\`). A top-up of ${n(Math.max(10_000, agents.maxPriceQu * 100))} QU buys ${n(Math.max(10_000, agents.maxPriceQu * 100) / agents.maxPriceQu)} plans.`,
          "",
          "A payment per call is not offered: QPayhub keeps at least 100 QU of every payment, so a payment that small would lose its value to the fee. Everything else in the API is free.",
        ]
      : [];

  return [
    "# QMax",
    "",
    "> QMax is a non-custodial liquidity router and trading terminal for Qubic. It compares the QX order book with the QSwap pool and splits an order across both for the best price. It is free to use. AI agents can call its HTTP API, pay for Max plans with x402 and sign their own trades.",
    "",
    "QMax never holds keys: every trade is signed in the person's or the agent's own wallet, and QMax never signs or sends a transaction for anyone. Prices are in QU, Qubic's coin; quantities are whole units of an asset. A quote is a snapshot: prices move, so quote again before signing.",
    "",
    "## Use the API",
    "",
    `API base URL: ${api}`,
    "",
    `- [OpenAPI document](${api}/v1/openapi.json): every endpoint, its parameters and responses.`,
    `- [Plans](${api}/v1/plans): what is free and what agents pay, as JSON.`,
    `- [Assets](${api}/v1/assets): every tradable asset (QX tokens and smart-contract shares) with its markets, price, liquidity and volume.`,
    `- [Quote](${api}/v1/quote?side=buy&asset=QDOGE&qty=1000000): the cheapest way to fill an order across QX and QSwap, splits included, with each leg's venue, size, price, fees and the limits to sign against. Free.`,
    `- [Order book](${api}/v1/book?asset=QDOGE): the QX ladder and the QSwap pool's depth. Free.`,
    `- [Candles](${api}/v1/candles?asset=QDOGE&range=7d): open, high, low, close and QU volume from real trades, about six months back. Free.`,
    `- [Arbitrage check](${api}/v1/arbitrage?asset=QDOGE): a live search for a profitable loop between QX and QSwap after every fee. Free.`,
    `- Also free: price history, pools and their fee yield, asset health, the live trade tape, a wallet's trade ledger and QSwap liquidity positions. See the OpenAPI document.`,
    max,
    "",
    `Without a key the market endpoints are limited to ${perMin} requests a minute per IP, and answer 429 with Retry-After past that. No account or key is needed otherwise.`,
    ...pay,
    "",
    "## Trading safely",
    "",
    "- A quote's `route[].execution` carries the limits (minimum received or maximum paid) for each leg; sign only inside limits you set yourself, and refuse anything outside them.",
    "- Only QX and QSwap are ever involved. Check every transaction's destination before signing.",
    "- Steps run one at a time; stop at the first failure and read the wallet back to see what happened.",
    "",
    "## Optional",
    "",
    `- [QMax website](${site}/): the trading terminal: charts, order book, swap, portfolio, pools.`,
    ...(tip ? [`- [Support QMax](${tip}): a Q+Pay tip jar; QMax is free for everyone.`] : []),
    "",
  ].join("\n");
}

export function llmsRoutes(env: Record<string, string | undefined>): Route[] {
  return [
    {
      method: "GET",
      path: "/llms.txt",
      limited: false,
      rate: { perMin: 60 },
      doc: {
        summary: "What QMax is and how an agent uses it (llms.txt)",
        description: "A Markdown page for AI agents: what QMax is, the API's address and main endpoints, what is free, what Max plans cost and how to pay with x402. Made from the server's own settings, so it states the real prices. Served at the site's root as /llms.txt.",
        responses: { "200": { description: "Markdown text" } },
      },
      handler: () => new Raw(llmsText(env), "text/plain; charset=utf-8"),
    },
  ];
}
