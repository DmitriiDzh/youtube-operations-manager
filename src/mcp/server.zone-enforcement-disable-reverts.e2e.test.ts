import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "./server";
import { createAgentConnectionsCore } from "@/lib/agent-connections";

// BL-091 (docs/roadmap/plans/AGENT_ZONES_PLAN.md) -- deliberately a SEPARATE file from
// server.zone-enforcement.e2e.test.ts (each test FILE gets its own pristine real database, per
// src/lib/platform-paths/runtime.ts). This scenario needs "exactly 1 connection enabled" to hold
// for `channel_sync`'s zone to be genuinely unassigned-and-open -- true only as the sole test
// registering any connection in its own file's database; sharing a file with any other test that
// also enables a connection would make this assertion meaningless (there is no delete operation
// in src/lib/agent-connections, so registered connections accumulate for the lifetime of a test
// file's process).
test("real agent-connections core: disabling one of two enabled connections reverts a previously-blocked unassigned zone back to open for the one still enabled", async () => {
  const core = createAgentConnectionsCore();
  const oneId = `solo-${randomUUID().slice(0, 8)}`;
  const twoId = `duo-${randomUUID().slice(0, 8)}`;
  await core.registerConnection({ id: oneId, label: "Solo (test)" });
  await core.registerConnection({ id: twoId, label: "Duo (test)" });

  const serverWithTwoEnabled = createMcpServer(undefined, { connectionEnabled: true, callerConnectionId: oneId }, core);
  const toolsWithTwoEnabled = (serverWithTwoEnabled as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
  const blockedResult = await toolsWithTwoEnabled.channel_sync.handler({});
  assert.equal(blockedResult.isError, true);
  assert.equal(JSON.parse(blockedResult.content[0]?.text ?? "{}").error.code, "AGENT_ZONE_VIOLATION");

  await core.setConnectionEnabled({ id: twoId, enabled: false });

  const serverWithOneEnabled = createMcpServer(undefined, { connectionEnabled: true, callerConnectionId: oneId }, core);
  const toolsWithOneEnabled = (serverWithOneEnabled as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
  const openResult = await toolsWithOneEnabled.channel_sync.handler({});
  const openPayload = JSON.parse(openResult.content[0]?.text ?? "{}");
  // Still fails (no real OAuth session in this test environment), but never for
  // AGENT_ZONE_VIOLATION -- the zone check passed because `oneId` is now the only enabled
  // connection in this file's own, otherwise-empty database.
  assert.notEqual(openPayload?.error?.code, "AGENT_ZONE_VIOLATION");
});
