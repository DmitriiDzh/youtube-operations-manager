import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MCP_TOOL_CLASSIFICATION } from "./tool-classification";
import { createFactoryMcpServer, FACTORY_API_VERSION, FACTORY_TOOL_NAMES } from "./factory-server";

// Mechanical enforcement from docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md §2.5 (AC-FO-07, AC-FO-09,
// AC-FO-13): the Factory Operator's tool set is closed and separate from the channel agents' tool set.

const EXPECTED_TOOLS = [
  "factory_get_capabilities",
  "factory_get_logical_path",
  "factory_list_channels",
  "factory_list_logical_paths",
];

function registeredNames(): string[] {
  const server = createFactoryMcpServer(
    {
      async readLogicalPath() { return { name: "x", path: "y" }; },
      async listLogicalPaths() { return []; },
      async listChannels() { return []; },
      async recordOutcome() {},
    },
    { connectionEnabled: true, session: { tokenId: "t", async reverify() {} } }
  );
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
}

test("§2.5(1): the factory server registers exactly the explicit allowlist, and nothing else", () => {
  assert.deepEqual(registeredNames(), EXPECTED_TOOLS);
  assert.deepEqual([...FACTORY_TOOL_NAMES].sort(), EXPECTED_TOOLS);
});

test("§2.5(2): no factory tool is classified for channel sessions, and the factory server registers no channel tool", () => {
  for (const name of Object.keys(MCP_TOOL_CLASSIFICATION)) {
    assert.equal(name.startsWith("factory_"), false, `${name} must not be a channel-session tool`);
  }
  const channelTools = new Set(Object.keys(MCP_TOOL_CLASSIFICATION));
  for (const name of registeredNames()) assert.equal(channelTools.has(name), false, name);
});

test("§2.5(2): the channel-agent server's source never registers a factory_ tool", async () => {
  const source = await readFile("src/mcp/server.ts", "utf8");
  assert.equal(/registerTool\(\s*"factory_/.test(source), false);
  assert.equal(source.includes("factory-server"), false);
});

test("AC-FO-09: no factory tool name implies a write, and none is a setter of a path, workspace or token", () => {
  for (const name of FACTORY_TOOL_NAMES) {
    assert.match(name, /^factory_(get|list)_/, `${name} must be a read`);
  }
});

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]);
}

test("§2.5(3): factory-server.ts imports only the MCP SDK, zod and shared-domain -- no domain module, gateway, db or channel-scope state", async () => {
  const imports = importsOf(await readFile("src/mcp/factory-server.ts", "utf8"));
  const allowed = (spec: string) =>
    spec === "zod" || spec === "@/lib/shared-domain" || spec.startsWith("@modelcontextprotocol/sdk/");
  assert.deepEqual(imports.filter((spec) => !allowed(spec)), []);
  assert.ok(imports.length >= 3, "the scan must actually see the imports");
});

test("§2.5(3): the factory route and endpoint reach only the allowlisted modules", async () => {
  const route = importsOf(await readFile("src/app/api/mcp/factory/route.ts", "utf8"));
  const routeAllowed = new Set([
    "@/lib/channel-connections",
    "@/lib/channel-workspaces",
    "@/lib/db",
    "@/lib/factory-mcp-endpoint",
    "@/lib/factory-agent-tokens",
    "@/lib/logical-paths",
    "@/mcp/factory-server",
  ]);
  assert.deepEqual(route.filter((spec) => !routeAllowed.has(spec)), []);
  assert.ok(route.length >= 5);

  const endpoint = importsOf(await readFile("src/lib/factory-mcp-endpoint/index.ts", "utf8"));
  const endpointAllowed = (spec: string) =>
    spec === "@/lib/loopback-guard" || spec === "@/lib/shared-domain" || spec.startsWith("@modelcontextprotocol/sdk/");
  assert.deepEqual(endpoint.filter((spec) => !endpointAllowed(spec)), []);
});

test("§2.5(4): none of the factory files reads channel-scope state (agent-session, selected channel, credentials)", async () => {
  for (const file of ["src/mcp/factory-server.ts", "src/app/api/mcp/factory/route.ts", "src/lib/factory-mcp-endpoint/index.ts"]) {
    const source = await readFile(file, "utf8");
    for (const forbidden of ["agent-session", "getSelectedChannelId", "resolveEffectiveCredentialRef", "credentialRef", "googleapis", "youtube-read-gateway", "youtube-write-gateway"]) {
      // Comments may mention a forbidden name; strip them before scanning.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      assert.equal(code.includes(forbidden), false, `${file} must not use ${forbidden}`);
    }
  }
});

test("AC-FO-13: the factory API has its own version constant 1.0.0, separate from the channel agents' version", async () => {
  assert.equal(FACTORY_API_VERSION, "1.0.0");
  const agentOperations = await readFile("src/lib/agent-operations/contracts.ts", "utf8");
  assert.equal(agentOperations.includes("FACTORY_API_VERSION"), false);
});
