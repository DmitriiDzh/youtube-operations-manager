/**
 * The in-app, channel-bound MCP endpoint (`docs/decisions/0013-in-app-http-mcp-transport.md`,
 * `docs/roadmap/plans/HTTP_MCP_SERVER_PLAN.md`). `src/app/api/mcp/route.ts` is a thin adapter over
 * `createAgentMcpEndpoint().handle`.
 *
 * Stateless by design: every request builds a fresh MCP server + transport from a token it has just
 * verified, so nothing survives a revoked token or a toggled "MCP connection" switch -- both take
 * effect on the very next request. Each check fails closed with an explicit, human-readable error.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runInAgentSession } from "@/lib/agent-session";
import { isDomainError } from "@/lib/shared-domain";
import type { AgentTokenBinding } from "@/lib/agent-tokens";
import { isLoopbackRequest } from "./loopback";

export type AgentMcpSession = { tokenId: string; channelId: string; reverify(): Promise<void> };

export type AgentMcpEndpointDeps = {
  /** The persisted "MCP connection" toggle, read fresh on every request. */
  isConnectionEnabled(): Promise<boolean>;
  /** Throws for a missing/unknown/revoked token; returns the token's binding otherwise. */
  verifyToken(token: string): Promise<AgentTokenBinding>;
  /** Builds the per-request MCP server (all tools registered for this one bound session). */
  createServer(options: { connectionEnabled: true; agentSession: AgentMcpSession }): McpServer;
};

export type AgentMcpErrorCode =
  | "AGENT_ENDPOINT_NOT_LOOPBACK"
  | "AGENT_ENDPOINT_METHOD_NOT_ALLOWED"
  | "MCP_CONNECTION_DISABLED"
  | "AGENT_TOKEN_REQUIRED"
  | "AGENT_TOKEN_INVALID"
  | "AGENT_ENDPOINT_UNAVAILABLE";

function errorResponse(status: number, code: AgentMcpErrorCode, message: string, headers?: Record<string, string>): Response {
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

export function createAgentMcpEndpoint(deps: AgentMcpEndpointDeps) {
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
      return errorResponse(401, "AGENT_TOKEN_REQUIRED", "A channel agent token is required: send it as 'Authorization: Bearer <token>'. Issue one in Settings → Channels.");
    }
    let binding: AgentTokenBinding;
    try {
      binding = await deps.verifyToken(token);
    } catch (error) {
      // Only a real "token not accepted" is a 401. A database/initialization failure must not tell an agent
      // its (perfectly good) token was revoked -- that would send the operator chasing the wrong problem.
      if (!isDomainError(error) || error.code !== "AGENT_TOKEN_INVALID") {
        return errorResponse(503, "AGENT_ENDPOINT_UNAVAILABLE", "The app could not verify the token right now (database unavailable). Open the app and check /recovery, then retry.");
      }
      return errorResponse(401, "AGENT_TOKEN_INVALID", "The agent token is unknown or has been revoked. Issue a new one in Settings → Channels.");
    }

    const session: AgentMcpSession = {
      tokenId: binding.tokenId,
      channelId: binding.channelId,
      async reverify() {
        const current = await deps.verifyToken(token);
        if (current.tokenId !== binding.tokenId) {
          throw new Error("agent token is missing, unknown, or revoked");
        }
      },
    };

    return runInAgentSession({ tokenId: binding.tokenId, channelId: binding.channelId, userId: binding.userId }, async () => {
      const server = deps.createServer({ connectionEnabled: true, agentSession: session });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await transport.close();
      }
    });
  }

  return { handle };
}
