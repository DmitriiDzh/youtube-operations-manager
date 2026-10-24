import assert from "node:assert/strict";
import test from "node:test";
import { runInAgentSession } from "@/lib/agent-session";
import { listWorkerActionLogEntries, rawSqlClient } from "@/lib/db";
import { createMcpServer } from "./server";

// BL-220 (RESTART_WHEN_IDLE_PLAN.md AC-RI-03/04, "MCP": "A worker releases only its own holds; holds are logged in the worker log").
// Expected values from the plan: a worker's hold is `worker:<its channel>`; another worker releasing it gets not_found; the owner of
// the hold releases it; hold and release each leave one worker-log row (the hold's id as the target); the status read is not counted
// as an MCP call. The test database is the runner's temporary one (shared by this file: each test uses its own channels).

type Tools = Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }> }>;

async function inSession<T>(channelId: string, fn: (tools: Tools) => Promise<T>): Promise<T> {
  const stub = new Proxy({}, { get: () => async () => ({}) }) as Parameters<typeof createMcpServer>[0];
  const server = createMcpServer(stub, { connectionEnabled: true, agentSession: { tokenId: `tok-${channelId}`, channelId, reverify: async () => {} } });
  const tools = (server as unknown as { _registeredTools: Tools })._registeredTools;
  return runInAgentSession({ tokenId: `tok-${channelId}`, channelId, userId: "u-1" }, () => fn(tools));
}

const payload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text) as Record<string, unknown>;

test("AC-RI-04 (MCP): a worker's hold is its own; another worker cannot release it (not_found); both calls are in the worker log", async () => {
  const held = await inSession("UC_RH_A", async (tools) => {
    assert.ok(tools.agent_restart_status && tools.agent_hold_restart && tools.agent_release_hold, "registered for a worker");
    return tools.agent_hold_restart.handler({ minutes: 15, reason: "finishing plan P1" });
  });
  assert.equal(held.isError, undefined);
  const hold = payload(held).hold as { holdId: string; heldBy: string; reason: string };
  assert.equal(hold.heldBy, "worker:UC_RH_A");
  assert.equal(hold.reason, "finishing plan P1");

  const foreign = await inSession("UC_RH_B", (tools) => tools.agent_release_hold.handler({ holdId: hold.holdId }));
  assert.equal(foreign.isError, true);
  assert.equal((payload(foreign).error as { code: string }).code, "not_found");

  const own = await inSession("UC_RH_A", (tools) => tools.agent_release_hold.handler({ holdId: hold.holdId }));
  assert.equal((payload(own) as { released: boolean }).released, true);

  const rowsA = await listWorkerActionLogEntries("UC_RH_A", 10);
  assert.deepEqual(
    rowsA.map((row) => [row.tool, row.target, row.outcome]).sort(),
    [
      ["agent_hold_restart", hold.holdId, "ok"],
      ["agent_release_hold", hold.holdId, "ok"],
    ]
  );
  const rowsB = await listWorkerActionLogEntries("UC_RH_B", 10);
  assert.deepEqual(rowsB.map((row) => [row.tool, row.target, row.outcome, row.errorCode]), [["agent_release_hold", hold.holdId, "error", "not_found"]]);
});

test("AC-RI-03 (MCP): a worker's hold outside 1-60 minutes or without a reason is validation_failed and stores nothing", async () => {
  await inSession("UC_RH_C", async (tools) => {
    for (const args of [{ minutes: 0, reason: "x" }, { minutes: 61, reason: "x" }, { minutes: 5, reason: "  " }]) {
      const result = await tools.agent_hold_restart.handler(args);
      assert.equal(result.isError, true);
      assert.equal((payload(result).error as { code: string }).code, "validation_failed");
    }
    const status = payload(await tools.agent_restart_status.handler({})) as { holds: Array<{ heldBy: string }> };
    assert.equal(status.holds.filter((h) => h.heldBy === "worker:UC_RH_C").length, 0);
  });
});

test("BL-220: agent_restart_status is not counted as an MCP call (the quiet window); a hold is", async () => {
  const count = async () => Number((await rawSqlClient.execute("SELECT COUNT(*) AS n FROM gateway_call_events WHERE category = 'mcp_tool_calls'")).rows[0].n);
  await inSession("UC_RH_D", async (tools) => {
    const before = await count();
    const status = await tools.agent_restart_status.handler({});
    assert.equal(status.isError, undefined);
    assert.deepEqual(Object.keys(payload(status)).sort(), ["holds", "lastRestart", "quietMinutes", "request", "serviceMode", "waitingFor"]);
    assert.equal(await count(), before);
    await tools.agent_hold_restart.handler({ minutes: 1, reason: "short" });
    assert.equal(await count(), before + 1);
  });
});
