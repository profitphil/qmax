import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../mcp/create.ts";
import { QMaxClient } from "../sdk/index.ts";

/**
 * QMax's MCP server, hosted: an AI assistant connects to https://qmax.exchange/api/mcp (MCP over Streamable HTTP) and has the tools, with nothing to download or run. Stateless: each request
 * stands alone (no session to keep or lose, so any number can run at once and a restart costs nobody anything), and the answer is plain JSON.
 *
 * It offers the same tools as the downloadable server except the paid one (the Max plan): a hosted endpoint cannot pay for a caller, whose own wallet does that through x402. The tools call
 * this same API on the loopback address, naming the caller's address in X-Forwarded-For, so the free per-address limits apply to what an assistant does through MCP exactly as to a direct call.
 */
export type McpHandler = (req: IncomingMessage, res: ServerResponse, body: unknown, callerIp: string) => Promise<void>;

export function mcpHandler(): McpHandler {
  return async (req, res, body, callerIp) => {
    // The API this very process serves: the port the request came in on.
    const base = `http://127.0.0.1:${req.socket.localPort}`;
    const api = new QMaxClient({
      baseUrl: base,
      fetch: ((url: string, init?: RequestInit) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "x-forwarded-for": callerIp } })) as typeof fetch,
    });
    const server = createServer(api, { hosted: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
