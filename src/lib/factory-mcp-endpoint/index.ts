/**
 * The in-app MCP endpoint of the Factory Operator role (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md`
 * §2.1, slice F3). `src/app/api/mcp/factory/route.ts` is a thin adapter over `createFactoryMcpEndpoint().handle`.
 *
 * Deliberately NOT a mode of `src/lib/agent-mcp-endpoint` (the channel-agent endpoint): its own token
 * type (`ytom_fo_`), its own verifier and its own server factory. It never enters the channel-bound
 * agent scope (`src/lib/agent-session`), so nothing it serves can read the operator's selected
 * channel or any channel-scoped state. Stateless like the channel endpoint: every request builds a
 * fresh MCP server + transport from a token it has just verified, so a revoked token or a toggled
 * "MCP connection" switch takes effect on the very next request.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLoopbackRequest } from "@/lib/loopback-guard";
import { DomainError, isDomainError } from "@/lib/shared-domain";

/** The verified Factory Operator session of one request. */
export type FactoryMcpSession = { tokenId: string; reverify(): Promise<void> };

export type FactoryMcpEndpointDeps = {
  /** The persisted "MCP connection" toggle, read fresh on every request (same master switch as channel agents). */
  isConnectionEnabled(): Promise<boolean>;
  /** Throws `AGENT_TOKEN_INVALID` for a missing/unknown/revoked/wrong-type token; returns the binding otherwise. */
  verifyToken(token: string): Promise<{ tokenId: string }>;
  /** Builds the per-request MCP server (only the factory tools) for this one verified session. */
  createServer(options: { session: FactoryMcpSession }): McpServer;
};

export type FactoryMcpErrorCode =
  | "AGENT_ENDPOINT_NOT_LOOPBACK"
  | "AGENT_ENDPOINT_METHOD_NOT_ALLOWED"
  | "MCP_CONNECTION_DISABLED"
  | "AGENT_TOKEN_REQUIRED"
  | "AGENT_TOKEN_INVALID"
  | "AGENT_ENDPOINT_UNAVAILABLE";

function errorResponse(status: number, code: FactoryMcpErrorCode, message: string, headers?: Record<string, string>): Response {
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

export function createFactoryMcpEndpoint(deps: FactoryMcpEndpointDeps) {
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
      return errorResponse(401, "AGENT_TOKEN_REQUIRED", "A Factory Operator token is required: send it as 'Authorization: Bearer <token>'. Issue one in Settings → AI Agent.");
    }
    let binding: { tokenId: string };
    try {
      binding = await deps.verifyToken(token);
    } catch (error) {
      // Only a real "token not accepted" is a 401. A database/initialization failure must not tell the
      // role its (perfectly good) token was revoked -- that would send the operator chasing the wrong problem.
      if (!isDomainError(error) || error.code !== "AGENT_TOKEN_INVALID") {
        return errorResponse(503, "AGENT_ENDPOINT_UNAVAILABLE", "The app could not verify the token right now (database unavailable). Open the app and check /recovery, then retry.");
      }
      return errorResponse(401, "AGENT_TOKEN_INVALID", "The Factory Operator token is unknown or has been revoked. Issue a new one in Settings → AI Agent.");
    }

    const session: FactoryMcpSession = {
      tokenId: binding.tokenId,
      async reverify() {
        const current = await deps.verifyToken(token);
        if (current.tokenId !== binding.tokenId) {
          throw new DomainError({ code: "AGENT_TOKEN_INVALID", message: "agent token is missing, unknown, or revoked" });
        }
      },
    };

    // No `runInAgentSession` here, on purpose: this role has no channel, so the channel scope is never entered.
    const server = deps.createServer({ session });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
    }
  }

  return { handle };
}
