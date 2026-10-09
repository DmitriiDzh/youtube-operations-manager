import { getMcpConnectionEnabled, insertProducerCallLogEntry, recordGatewayCallOutcome } from "@/lib/db";
import { createProducerTokenCore } from "@/lib/producer-agent-tokens";
import { createProducerMcpEndpoint } from "@/lib/producer-mcp-endpoint";
import { createProducerSessionDeps } from "@/lib/producer-mcp-endpoint/session-deps";
import { PRODUCER_TOOL_NAMES } from "@/mcp/producer-tools";
import { createMcpServer } from "@/mcp/server";

// Never cached or prerendered: every call is an authenticated, per-request Producer session.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-161 (docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §3). Wiring only: which tools the Producer gets is the closed list in
// `src/mcp/producer-tools.ts`; each channel tool runs in the named channel's agent scope (`createMcpServer`'s producer mode). The
// session's deps are built in `src/lib/producer-mcp-endpoint/session-deps.ts`.

const endpoint = createProducerMcpEndpoint({
  isConnectionEnabled: getMcpConnectionEnabled,
  verifyToken: (token) => createProducerTokenCore().verifyToken(token),
  createServer: ({ session }) => createMcpServer(undefined, { connectionEnabled: true, producerSession: createProducerSessionDeps(session) }),
  isProducerTool: (name) => PRODUCER_TOOL_NAMES.includes(name),
  async recordRefusedCall(call) {
    await recordGatewayCallOutcome("mcp_tool_calls", "blocked");
    await insertProducerCallLogEntry({ at: new Date(), tool: call.tool, channelId: call.channelId, outcome: "error", errorCode: call.errorCode });
  },
});

// Stateless Streamable HTTP: only POST is meaningful. GET/DELETE get the endpoint's own explicit 405
// (after the same loopback check), never Next's generic one.
export const POST = endpoint.handle;
export const GET = endpoint.handle;
export const DELETE = endpoint.handle;
