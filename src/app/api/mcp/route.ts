import { createAgentMcpEndpoint } from "@/lib/agent-mcp-endpoint";
import { createAgentTokenCore } from "@/lib/agent-tokens";
import { getMcpConnectionEnabled } from "@/lib/db";
import { createMcpServer } from "@/mcp/server";
import { createFactoryMediaDeps } from "./factory-media-deps";

// Never cached or prerendered: every call is an authenticated, per-request agent session.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const endpoint = createAgentMcpEndpoint({
  isConnectionEnabled: getMcpConnectionEnabled,
  verifyToken: (token) => createAgentTokenCore().verifyToken(token),
  // BL-218: the Operator's media wiring for the worker's own paid work (pinned to its channel inside the server).
  createServer: (options) => createMcpServer(undefined, { ...options, workerMediaDeps: createFactoryMediaDeps }),
});

// Stateless Streamable HTTP: only POST is meaningful. GET/DELETE get the endpoint's own explicit 405
// (after the same loopback check), never Next's generic one.
export const POST = endpoint.handle;
export const GET = endpoint.handle;
export const DELETE = endpoint.handle;
