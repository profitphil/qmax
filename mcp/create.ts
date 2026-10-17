import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import tools, { explain, fit } from "./tools.ts";
import type { QMaxApi } from "./tools.ts";

/**
 * The QMax MCP server's tools, as an `McpServer` ready to be given a transport. Apart from `server.ts` (which starts it on stdio when run directly) so that importing it, from a test or
 * from the API that hosts it, never starts anything.
 *
 * `hosted` is the copy the API serves over HTTP at /api/mcp: every tool that costs QU is left out (a Max plan is paid for by the caller's own wallet through x402, which a hosted
 * endpoint cannot do for them), and the server tells the client what it is and what is free.
 */
export function createServer(api: QMaxApi, opts: { hosted?: boolean } = {}): McpServer {
  const server = new McpServer(
    { name: "qmax-mcp-server", version: "1.0.0" },
    opts.hosted
      ? {
          instructions:
            "QMax compares the QX order book with the QSwap pool for Qubic assets and splits an order across both for the best price. Everything here is free, needs no key and reads public data; no tool signs or sends anything (qmax_build_plan returns unsigned steps for the caller's own wallet). Prices are in QU, Qubic's coin; quantities are whole units. A quote is a snapshot: quote again before signing. To answer how much a sale would fetch, call qmax_get_quote with side=sell: its summary field says the result in words. The Max plan (best position, 100 QU) is not offered here: see https://qmax.exchange/llms.txt.",
        }
      : undefined,
  );
  for (const t of tools) {
    if (opts.hosted && t.paid) continue;
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
