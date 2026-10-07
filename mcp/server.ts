#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { QMaxClient, createX402Fetch } from "../sdk/index.ts";
import tools, { explain, fit } from "./tools.ts";
import type { QMaxApi } from "./tools.ts";

/**
 * QMax as an MCP server (stdio): market data, quotes, routing, candles, pools, backtests and unsigned trade plans for AI agents.
 *
 *   QMAX_API_URL       where the QMax API is (default http://localhost:8787)
 *   QMAX_API_KEY       a prepaid QMax key, if you have one
 *   QMAX_AGENT_SEED    optional: lets this server buy an x402 session when a call needs paying (a Max plan, or the free allowance running out on a server that bills). Paying spends REAL QU from
 *                      that wallet, so use a wallet that holds only what you are happy to spend, and cap it with QMAX_MAX_SPEND_QU.
 *   QMAX_MAX_SPEND_QU  most QU this server may ever pay in sessions (default 30000)
 *
 * No tool signs or sends a trade. `qmax_build_plan` returns unsigned steps for the caller's own wallet.
 */

export function createServer(api: QMaxApi): McpServer {
  const server = new McpServer({ name: "qmax-mcp-server", version: "1.0.0" });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: !t.paid, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await t.run(args, api);
          const { text } = fit(result);
          return { content: [{ type: "text" as const, text }], structuredContent: undefined };
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: `Error: ${explain(e)}` }] };
        }
      },
    );
  }
  return server;
}

/** Builds the API client from the environment, with automatic x402 payment only if a seed was given. */
export async function clientFromEnv(env: Record<string, string | undefined> = process.env): Promise<QMaxClient> {
  const baseUrl = env.QMAX_API_URL ?? "http://localhost:8787";
  let fetchFn: typeof fetch | undefined;
  if (env.QMAX_AGENT_SEED) {
    const { contractPayer, seedSigner } = await import("../sdk/agent.ts");
    const signer = await seedSigner(env.QMAX_AGENT_SEED);
    const max = env.QMAX_MAX_SPEND_QU === undefined || env.QMAX_MAX_SPEND_QU === "" ? 30_000 : Number(env.QMAX_MAX_SPEND_QU);
    // A mistyped limit ("30,000" is NaN) must stop the server, not be read as "no limit": a comparison with NaN is false, so it would pay anything.
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error(`QMAX_MAX_SPEND_QU must be a whole number above zero, written without commas (for example 30000), not '${env.QMAX_MAX_SPEND_QU}'`);
    // One payment may take only part of the budget, so a single hostile 402 cannot spend all of it.
    fetchFn = createX402Fetch({ payer: contractPayer(signer), maxAmountPerCall: Math.min(max, 10_000), maxTotalSpend: max }) as typeof fetch;
    console.error(`[qmax-mcp] x402 payments ON from ${signer.identity}, capped at ${max.toLocaleString("en-US")} QU in total.`);
  }
  return new QMaxClient({ baseUrl, ...(env.QMAX_API_KEY ? { apiKey: env.QMAX_API_KEY } : {}), ...(fetchFn ? { fetch: fetchFn } : {}) });
}

// Run only when started directly, not when a test imports createServer.
if (process.argv[1] && /server\.(ts|mjs|js)$/.test(process.argv[1]) && !process.env.QMAX_MCP_NO_START) {
  const client = await clientFromEnv();
  await createServer(client).connect(new StdioServerTransport());
  console.error("[qmax-mcp] ready on stdio");
}

void z; // zod is imported so the bundle keeps one copy for the tool schemas
