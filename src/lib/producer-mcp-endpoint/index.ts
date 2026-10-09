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

/** The verified Producer session of one request. */
export type ProducerMcpSession = { tokenId: string; reverify(): Promise<void> };

export type ProducerMcpEndpointDeps = {
  /** The persisted "MCP connection" toggle, read fresh on every request (same master switch as channel agents). */
  isConnectionEnabled(): Promise<boolean>;
  /** Throws `AGENT_TOKEN_INVALID` for a missing/unknown/revoked/wrong-type token; returns the binding otherwise. */
  verifyToken(token: string): Promise<{ tokenId: string }>;
  /** Builds the per-request MCP server (only the Producer's tools) for this one verified session. */
  createServer(options: { session: ProducerMcpSession }): McpServer;
};

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

    const session: ProducerMcpSession = {
      tokenId: binding.tokenId,
      async reverify() {
        const current = await deps.verifyToken(token);
        if (current.tokenId !== binding.tokenId) {
          throw new DomainError({ code: "AGENT_TOKEN_INVALID", message: "agent token is missing, unknown, or revoked" });
        }
      },
    };

    // No `runInAgentSession` here, on purpose: the server enters the scope of the channel each call names, per call.
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
