import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "./server";
import { createAgentConnectionsCore } from "@/lib/agent-connections";
import { getGatewayTrafficLast24h } from "@/lib/db";

// BL-091 (docs/roadmap/plans/AGENT_ZONES_PLAN.md) -- real, end-to-end cross-module test: the
// REAL agent-connections core against this test file's own isolated real database (each test
// FILE gets its own pristine temp DB under Node's test runner, src/lib/platform-paths/runtime.ts
// -- registering real connections here cannot leak into any other test file's "zero connections
// registered" assumption). Deliberately in its own file, not appended to server.test.ts, for
// exactly that isolation.
//
// Most other MCP zone tests (server.test.ts) use fake AgentConnectionsCoreSubset stubs to prove
// wiring in isolation; this file (alongside its sibling
// server.zone-enforcement-disable-reverts.e2e.test.ts) instead proves the real module's
// fail-closed/exclusivity logic (src/lib/agent-connections/services.ts) reaches a real MCP tool
// call end to end, registering real connections and real zone assignments rather than fakes.

test("real agent-connections core: an unassigned zoned tool is rejected once 2 connections are enabled, then allowed for the one it's assigned to", async () => {
  const core = createAgentConnectionsCore();
  const claudeId = `claude-${randomUUID().slice(0, 8)}`;
  const codexId = `codex-${randomUUID().slice(0, 8)}`;
  await core.registerConnection({ id: claudeId, label: "Claude (test)" });
  await core.registerConnection({ id: codexId, label: "Codex (test)" });

  // Unassigned zone, 2 real enabled connections -- must reject BOTH callers per the owner's
  // exclusivity rule.
  const claudeServerBeforeAssignment = createMcpServer(undefined, { connectionEnabled: true, callerConnectionId: claudeId }, core);
  const claudeToolsBeforeAssignment = (claudeServerBeforeAssignment as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
  const beforeAssignment = await claudeToolsBeforeAssignment.channel_sync.handler({});
  assert.equal(beforeAssignment.isError, true);
  assert.equal(JSON.parse(beforeAssignment.content[0]?.text ?? "{}").error.code, "AGENT_ZONE_VIOLATION");

  const codexServerBeforeAssignment = createMcpServer(undefined, { connectionEnabled: true, callerConnectionId: codexId }, core);
  const codexToolsBeforeAssignment = (codexServerBeforeAssignment as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
  const codexBeforeAssignment = await codexToolsBeforeAssignment.channel_sync.handler({});
  assert.equal(codexBeforeAssignment.isError, true);
  assert.equal(JSON.parse(codexBeforeAssignment.content[0]?.text ?? "{}").error.code, "AGENT_ZONE_VIOLATION");

  // A zone rejection is a real, countable "blocked" attempt through the mcp_tool_calls gateway.
  const trafficAfterRejection = await getGatewayTrafficLast24h();
  const mcpTrafficAfterRejection = trafficAfterRejection.find((c) => c.category === "mcp_tool_calls");
  assert.ok(mcpTrafficAfterRejection && mcpTrafficAfterRejection.totalAttempts >= 1);
  assert.ok(mcpTrafficAfterRejection.totalAttempts > mcpTrafficAfterRejection.succeeded);

  // Assign channel_sync exclusively to codex.
  await core.assignCapabilityZone({ capabilityId: "channel_sync", assignedConnectionId: codexId });

  // claude is now rejected (assigned to someone else).
  const claudeServer = createMcpServer(undefined, { connectionEnabled: true, callerConnectionId: claudeId }, core);
  const claudeTools = (claudeServer as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
  const claudeResult = await claudeTools.channel_sync.handler({});
  assert.equal(claudeResult.isError, true);
  assert.equal(JSON.parse(claudeResult.content[0]?.text ?? "{}").error.code, "AGENT_ZONE_VIOLATION");

  // codex passes the zone check -- reaches the real channelSync handler, which then fails for an
  // UNRELATED reason (no real OAuth session in this test environment), never AGENT_ZONE_VIOLATION.
  const codexServer = createMcpServer(undefined, { connectionEnabled: true, callerConnectionId: codexId }, core);
  const codexTools = (codexServer as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
  const codexResult = await codexTools.channel_sync.handler({});
  const codexPayload = JSON.parse(codexResult.content[0]?.text ?? "{}");
  assert.notEqual(codexPayload?.error?.code, "AGENT_ZONE_VIOLATION");
});
