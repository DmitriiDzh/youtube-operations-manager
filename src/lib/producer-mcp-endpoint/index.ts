/**
 * The in-app MCP endpoint of the Producer role -- reads, plus proposals the owner approves (BL-161, BL-163, FO-REQ-0012, `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md` §3).
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
export type ProducerMcpSession = { tokenId: string; reverify(): Promise<void>; noteRecorded(tool: string, channelId: string | null): void };

/**
 * A `tools/call` that never reached a tool: an unknown tool, an input the schema refused, or a request the transport rejected
 * outright (a wrong `Accept` header or protocol version, a malformed message, a call sent as a notification).
 */
export type ProducerRefusedCall = { tool: string; channelId: string | null; errorCode: "TOOL_NOT_FOUND" | "INVALID_PARAMS" | "REQUEST_REJECTED" };

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

/**
 * The `tools/call` messages of a request body (one message or a batch): their tool names and named channels, bounded, and whether
 * each was sent as a notification (no `id`) -- the MCP layer drops such a call without running it.
 */
function toolCallsOf(body: unknown): Array<{ tool: string; channelId: string | null; notification: boolean }> {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object" || (message as { method?: unknown }).method !== "tools/call") return [];
    const params = (message as { params?: { name?: unknown; arguments?: { channelId?: unknown } } }).params;
    const tool = typeof params?.name === "string" ? params.name.slice(0, 100) : "(no tool name)";
    const channelId = params?.arguments?.channelId;
    const notification = !("id" in (message as object)) || (message as { id?: unknown }).id === undefined;
    return [{ tool, channelId: typeof channelId === "string" && channelId.length <= 64 ? channelId : null, notification }];
  });
}

export type ProducerMcpErrorCode =
  | "AGENT_ENDPOINT_NOT_LOOPBACK"
  | "AGENT_ENDPOINT_METHOD_NOT_ALLOWED"
  | "MCP_CONNECTION_DISABLED"
  | "AGENT_TOKEN_REQUIRED"
  | "AGENT_TOKEN_INVALID"
  | "AGENT_ENDPOINT_UNAVAILABLE";

/**
 * A batch this stateless endpoint refuses before the transport sees it (review round 5): a repeated request id (MCP forbids it; the
 * transport would answer before the second call finished, and the log would record it twice) and a cancellation notification
 * (the transport would never answer the cancelled call, so the request would hang -- RISK-118). Null when the body is acceptable.
 */
function refusedBatchReason(body: unknown): string | null {
  if (!Array.isArray(body)) return null;
  const ids = new Set<string>();
  for (const message of body) {
    if (!message || typeof message !== "object") continue;
    const { method, id } = message as { method?: unknown; id?: unknown };
    if (method === "notifications/cancelled") return "A batch must not cancel a request: this endpoint is stateless.";
    if (typeof method === "string" && id !== undefined) {
      const key = JSON.stringify(id);
      if (ids.has(key)) return "A batch must not repeat a request id.";
      ids.add(key);
    }
  }
  return null;
}

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
    const callKey = (tool: string, channelId: string | null) => `${tool}\u0000${channelId ?? ""}`;
    const session: ProducerMcpSession = {
      tokenId: binding.tokenId,
      noteRecorded(tool, channelId) {
        recorded.push(callKey(tool, channelId));
      },
      async reverify() {
        const current = await deps.verifyToken(token);
        if (current.tokenId !== binding.tokenId) {
          throw new DomainError({ code: "AGENT_TOKEN_INVALID", message: "agent token is missing, unknown, or revoked" });
        }
      },
    };

    const body = await request.clone().json().catch(() => null);
    const calls = toolCallsOf(body);
    const refusedBatch = refusedBatchReason(body);
    if (refusedBatch) {
      for (const call of calls) {
        await deps.recordRefusedCall({ tool: call.tool, channelId: call.channelId, errorCode: "REQUEST_REJECTED" }).catch(() => undefined);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: refusedBatch } }), {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    // No `runInAgentSession` here, on purpose: the server enters the scope of the channel each call names, per call.
    const server = deps.createServer({ session });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let status = 500;
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      status = response.status;
      return response;
    } finally {
      await transport.close();
      // Every tools/call the server's own log did not record (matched by tool AND channel) never reached a tool. Log it here: as
      // refused by the transport when it rejected the request as a whole, else as an unknown tool or a refused input.
      for (const call of calls) {
        // A notification never runs, so it can never be the call a recorded entry belongs to (review round 4).
        const index = call.notification ? -1 : recorded.indexOf(callKey(call.tool, call.channelId));
        if (index >= 0) {
          recorded.splice(index, 1);
          continue;
        }
        const errorCode =
          status !== 200 || call.notification ? "REQUEST_REJECTED" : deps.isProducerTool(call.tool) ? "INVALID_PARAMS" : "TOOL_NOT_FOUND";
        await deps.recordRefusedCall({ tool: call.tool, channelId: call.channelId, errorCode }).catch(() => undefined);
      }
    }
  }

  return { handle };
}
