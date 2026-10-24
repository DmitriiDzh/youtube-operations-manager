// BL-118: the agent's capability inventory (`agent_get_capabilities`) is a literal, human-maintained list. It drifted once already:
// `agent_query_channel_reach` was built and registered but had no entry, so an agent reported "no capability exposes impressions
// or CTR". This test ties the inventory to the real MCP tool registry so that cannot happen silently again.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listAgentCapabilityDescriptors } from "./services";

async function registeredToolNames(): Promise<string[]> {
  const source = await readFile(path.join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
  const names: string[] = [];
  for (const match of source.matchAll(/registerTool\(\s*"([A-Za-z0-9_]+)"/g)) names.push(match[1]);
  return names;
}

test("every registered agent_* / analytics_* MCP tool is named by a capability's mcpTools, and every named tool really is registered", async () => {
  const registered = await registeredToolNames();
  assert.ok(registered.length > 20, "the registry scan found the MCP tools (sanity)");

  const wanted = registered.filter((name) => name.startsWith("agent_") || name.startsWith("analytics_"));
  const covered = new Set(listAgentCapabilityDescriptors().flatMap((c) => c.mcpTools ?? []));

  const missing = wanted.filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], `registered MCP tools with no capability entry: ${missing.join(", ")}`);

  // BL-217's worker versions of the Operator's tools are registered in a loop (no literal name here); the AC-WK-05 test below checks
  // them against the real registry.
  const { WORKER_FACTORY_TOOL_NAMES } = await import("@/mcp/worker-factory-tools");
  const unknown = [...covered].filter((name) => !registered.includes(name) && !WORKER_FACTORY_TOOL_NAMES.includes(name));
  assert.deepEqual(unknown, [], `capabilities naming a tool that is not registered: ${unknown.join(", ")}`);
});

test("the reach tool is advertised (the exact drift the first agent test found)", () => {
  const reach = listAgentCapabilityDescriptors().find((c) => (c.mcpTools ?? []).includes("agent_query_channel_reach"));
  assert.ok(reach, "no capability names agent_query_channel_reach");
  assert.match(reach.description, /impressions/i);
  assert.match(reach.description, /click-through/i);
});

test("capability ids are unique", () => {
  const ids = listAgentCapabilityDescriptors().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

// BL-215 (ADR 0048, WORKER_CAPABILITIES_PLAN.md AC-WK-05): the first test above only covers agent_*/analytics_* names, and the
// inventory missed 26 channel tools (among them every YouTube write), so workers believed their token could not write. Every tool a
// channel session registers (classified `bound`) must be named by a capability, and nothing else may be named.
test("AC-WK-05: the capability list names exactly the tools a channel session registers, and every capability names its tools", async () => {
  // The real registry of a channel session (BL-217 registers the worker versions of the Operator's tools in a loop, so a scan of
  // server.ts's literal names is not enough).
  const { createMcpServer } = await import("@/mcp/server");
  const stub = new Proxy({}, { get: () => async () => ({}) }) as Parameters<typeof createMcpServer>[0];
  const server = createMcpServer(stub, { connectionEnabled: true, agentSession: { tokenId: "t", channelId: "UC_T", reverify: async () => {} } });
  const bound = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  const visible = listAgentCapabilityDescriptors().filter((capability) => capability.domain !== "operations_workspace");

  const unnamed = visible.filter((capability) => (capability.mcpTools ?? []).length === 0).map((capability) => capability.id);
  assert.deepEqual(unnamed, [], `capabilities that name no tool: ${unnamed.join(", ")}`);

  const named = [...new Set(visible.flatMap((capability) => capability.mcpTools ?? []))].sort();
  assert.deepEqual(named, bound);
  assert.ok(!named.includes("playlist_delete"), "playlist_delete is owner-only (ADR 0048 §3)");
});
