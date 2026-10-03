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

  const unknown = [...covered].filter((name) => !registered.includes(name));
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
