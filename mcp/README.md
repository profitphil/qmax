# QMax MCP server

QMax for AI agents: market data, quotes, routing, candles, pools, backtests and **unsigned** trade plans, over the Model Context Protocol (stdio).

No tool signs or sends anything. `qmax_build_plan` returns the transactions a quote needs, in order, for the caller's own wallet to sign (or for `@qmax/sdk/agent`, which has spending limits built in). Every tool is marked read-only.

## Get it (hosted)
The built server is one file, hosted on the site with its checksum: see [qmax.exchange/agents](https://qmax.exchange/agents/).
```bash
curl -O https://qmax.exchange/agents/qmax-mcp.mjs
curl -O https://qmax.exchange/agents/SHA256SUMS && shasum -a 256 -c SHA256SUMS   # check it first
node qmax-mcp.mjs      # needs Node 22 or newer; talks to https://qmax.exchange/api unless QMAX_API_URL is set
```
`npm run agents:build` makes these files (`scripts/build-agents.mjs`: the server is built with the live API as its default address, the SDK is packed, the checksums are written) into `web/public/agents/`, and `deploy/deploy.sh` runs it before building the site.

## Run it
```bash
npm run mcp:build        # bundles mcp/dist/server.mjs (one file, no node_modules needed)
npm run mcp              # starts it on stdio
```

Add it to an MCP client, for example Claude Desktop (`claude_desktop_config.json`) or Claude Code (`claude mcp add`):
```json
{ "mcpServers": { "qmax": { "command": "node", "args": ["/path/to/qroute/mcp/dist/server.mjs"], "env": { "QMAX_API_URL": "https://your-qmax-api" } } } }
```

| Variable | Meaning |
|---|---|
| `QMAX_API_URL` | Where the QMax API is (default `http://localhost:8787`). |
| `QMAX_API_KEY` | A prepaid QMax key, if you have one (removes the free-tier rate limit). |
| `QMAX_AGENT_SEED` | Optional. Lets the server buy an x402 session through QPayhub when a call needs paying: a Max plan (`qmax_best_position`) at qmax.exchange, or the free allowance running out on a server that bills. **This spends real QU from that wallet**: use a wallet that holds only what you are happy to spend. Set it in your own environment, never in a chat. |
| `QMAX_MAX_SPEND_QU` | The most QU the server will ever pay for sessions (default 30,000). |

## Tools
| Tool | What it does |
|---|---|
| `qmax_list_assets` | Find assets and see which markets they trade on. |
| `qmax_get_quote` | Price an order across QX and QSwap, with the route, each single market alone and what routing saved. |
| `qmax_build_plan` | The unsigned, ordered transactions for a trade, with `maxOutlayQu` to check against your own limit. |
| `qmax_get_candles` | Open/high/low/close and QU volume from real trades (hourly at the finest, about six months). |
| `qmax_get_price_history` | The price line (rebuilt from trades before QMax started recording). |
| `qmax_get_order_book` | The QX ladder and the QSwap pool's depth. |
| `qmax_check_arbitrage` | Live QX/QSwap arbitrage search after every fee. |
| `qmax_best_position` | **Max: the best position for a trade** (best way to execute, best size, an arbitrage sized to the wallet, the best exit for what is held). Signs nothing, but **costs QU**: 100 QU a plan at qmax.exchange, from the prepaid key's balance (`QMAX_API_KEY`) or free inside an x402 session (`QMAX_AGENT_SEED`); a request that cannot be planned is not charged. The only tool not marked idempotent. |
| `qmax_venue_premium` | How far apart the two markets' prices were, hour by hour (an upper bound on arbitrage, not a profit). |
| `qmax_get_tape`, `qmax_get_flow` | The latest trades on both markets with the taker's direction, and buy-versus-sell pressure over the last hour or 24 hours. |
| `qmax_swap_quote` | Plan a token-to-token swap as two linked trades, with the QU needed up front and the guaranteed minimum (read-only). |
| `qmax_get_liquidity_positions` | A wallet's QSwap liquidity: units, share of each pool, what removing it all pays and its value (read live from the contract; read-only, no add/remove through MCP). |
| `qmax_get_liquidity_pool` | One QSwap pool's live reserves, total liquidity and price. |
| `qmax_get_wallet_ledger` | A wallet's QX and QSwap trades with fees, position and average-cost P&L (estimated from on-chain transfers; read its warnings). |
| `qmax_get_health` | A 0 to 100 score and A to E grade for an asset from its book, pool and trade history, with reasons. |
| `qmax_list_pools`, `qmax_pool_detail` | QSwap pools ranked by real fee income, with impermanent loss and a deposit estimate. |
| `qmax_backtest` | Replay hold, DCA or bands over real history with the venues' real fees. |

Long lists are trimmed to their newest entries (and say so) so one call cannot fill an agent's context; errors say what to do next.
