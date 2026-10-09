/**
 * The in-app MCP endpoint of the read-only Producer role (BL-161, FO-REQ-0012, `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md` §3).
 * `src/app/api/mcp/producer/route.ts` is a thin adapter over `createProducerMcpEndpoint().handle`.
 *
 * The same checks as the Factory Operator's endpoint, with its own token type (`ytom_pr_`) and verifier. Unlike the channel endpoint
 * it does NOT enter a channel scope for the request: the Producer names a channel per call, and the server enters that channel's
 * agent scope for that one call (`createMcpServer`'s producer mode). Stateless: every request builds a fresh server from a token it
 * has just verified, so a revoked token or a toggled "MCP connection" switch takes effect on the very next request.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLoopbackRequest } from "@/lib/loopback-guard";
import { DomainError, isDomainError } from "@/lib/shared-domain";

/**
 * The verified Producer session of one request. `noteRecorded` is called by the server's call log for each tool call it records, so
 * the endpoint can log the calls the MCP layer refused before any tool ran (an unknown tool, an input the schema rejects).
 */
export type ProducerMcpSession = { tokenId: string; reverify(): Promise<void>; noteRecorded(tool: string): void };

/** A `tools/call` the MCP layer answered without reaching a tool: what the endpoint logs for it. */
export type ProducerRefusedCall = { tool: string; channelId: string | null; errorCode: "TOOL_NOT_FOUND" | "INVALID_PARAMS" };

export type ProducerMcpEndpointDeps = {
  /** The persisted "MCP connection" toggle, read fresh on every request (same master switch as channel agents). */
  isConnectionEnabled(): Promise<boolean>;
  /** Throws `AGENT_TOKEN_INVALID` for a missing/unknown/revoked/wrong-type token; returns the binding otherwise. */
  verifyToken(token: string): Promise<{ tokenId: string }>;
  /** Builds the per-request MCP server (only the Producer's tools) for this one verified session. */
  createServer(options: { session: ProducerMcpSession }): McpServer;
  /** Whether a name is one of the Producer's tools (an unknown name is logged as `TOOL_NOT_FOUND`). */
  isProducerTool(name: string): boolean;
  /** Logs a call the MCP layer refused before any tool ran (FO-REQ-0012 §2.4: every call is logged). Best effort. */
  recordRefusedCall(call: ProducerRefusedCall): Promise<void>;
};

/** The `tools/call` messages of a request body (one message or a batch): their tool names and named channels, bounded. */
function toolCallsOf(body: unknown): Array<{ tool: string; channelId: string | null }> {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object" || (message as { method?: unknown }).method !== "tools/call") return [];
    const params = (message as { params?: { name?: unknown; arguments?: { channelId?: unknown } } }).params;
    const tool = typeof params?.name === "string" ? params.name.slice(0, 100) : "(no tool name)";
    const channelId = params?.arguments?.channelId;
    return [{ tool, channelId: typeof channelId === "string" && channelId.length <= 64 ? channelId : null }];
  });
}

export type ProducerMcpErrorCode =
  | "AGENT_ENDPOINT_NOT_LOOPBACK"
  | "AGENT_ENDPOINT_METHOD_NOT_ALLOWED"
  | "MCP_CONNECTION_DISABLED"
  | "AGENT_TOKEN_REQUIRED"
  | "AGENT_TOKEN_INVALID"
  | "AGENT_ENDPOINT_UNAVAILABLE";

function errorResponse(status: number, code: ProducerMcpErrorCode, message: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** Extracts the token of an `Authorization: Bearer <token>` header; `null` for anything else. */
function bearerToken(headers: Headers): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "");
  return match ? match[1] : null;
}

export function createProducerMcpEndpoint(deps: ProducerMcpEndpointDeps) {
  async function handle(request: Request): Promise<Response> {
    if (!isLoopbackRequest(request.headers)) {
      return errorResponse(403, "AGENT_ENDPOINT_NOT_LOOPBACK", "This endpoint only accepts requests addressed to this computer (localhost / 127.0.0.1).");
    }
    if (request.method !== "POST") {
      return errorResponse(405, "AGENT_ENDPOINT_METHOD_NOT_ALLOWED", "Only POST is supported (stateless Streamable HTTP).", { allow: "POST" });
    }
    if (!(await deps.isConnectionEnabled())) {
      return errorResponse(403, "MCP_CONNECTION_DISABLED", "The MCP / agent connection is switched off. Turn it on in Settings → AI Agent.");
    }

    const token = bearerToken(request.headers);
    if (!token) {
      return errorResponse(401, "AGENT_TOKEN_REQUIRED", "A Producer token is required: send it as 'Authorization: Bearer <token>'. Issue one in Settings → AI Agent.");
    }
    let binding: { tokenId: string };
    try {
      binding = await deps.verifyToken(token);
    } catch (error) {
      // Only a real "token not accepted" is a 401. A database/initialization failure must not tell the
      // Producer its (perfectly good) token was revoked -- that would send the operator chasing the wrong problem.
      if (!isDomainError(error) || error.code !== "AGENT_TOKEN_INVALID") {
        return errorResponse(503, "AGENT_ENDPOINT_UNAVAILABLE", "The app could not verify the token right now (database unavailable). Open the app and check /recovery, then retry.");
      }
      return errorResponse(401, "AGENT_TOKEN_INVALID", "The Producer token is unknown or has been revoked. Issue a new one in Settings → AI Agent.");
    }

    const recorded: string[] = [];
    const session: ProducerMcpSession = {
      tokenId: binding.tokenId,
      noteRecorded(tool) {
        recorded.push(tool);
      },
      async reverify() {
        const current = await deps.verifyToken(token);
        if (current.tokenId !== binding.tokenId) {
          throw new DomainError({ code: "AGENT_TOKEN_INVALID", message: "agent token is missing, unknown, or revoked" });
        }
      },
    };

    const calls = toolCallsOf(await request.clone().json().catch(() => null));
    // No `runInAgentSession` here, on purpose: the server enters the scope of the channel each call names, per call.
    const server = deps.createServer({ session });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      // Every tools/call the server's own log did not record never reached a tool: the MCP layer refused it. Log it here.
      for (const call of calls) {
        const index = recorded.indexOf(call.tool);
        if (index >= 0) {
          recorded.splice(index, 1);
          continue;
        }
        await deps
          .recordRefusedCall({ ...call, errorCode: deps.isProducerTool(call.tool) ? "INVALID_PARAMS" : "TOOL_NOT_FOUND" })
          .catch(() => undefined);
      }
    }
  }

  return { handle };
}
