import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MCP_TOOL_CLASSIFICATION } from "./tool-classification";
import { createFactoryMcpServer, FACTORY_API_VERSION, FACTORY_TOOL_NAMES, FACTORY_WRITE_TOOL_NAMES } from "./factory-server";

// Mechanical enforcement from docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md §2.5 (AC-FO-07, AC-FO-09,
// AC-FO-13): the Factory Operator's tool set is closed and separate from the channel agents' tool set.

// BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.6, ADR 0025): eight media tools join the four 1.0.0 tools; BL-133
// (FACTORY_GPU_SESSIONS_PLAN.md, ADR 0026): seven more -- its own sessions, jobs in them, the capacity log.
const EXPECTED_TOOLS = [
  "factory_get_capabilities",
  "factory_get_logical_path",
  "factory_list_channels",
  "factory_list_logical_paths",
  "factory_media_adopt_template",
  "factory_media_cancel_job",
  "factory_media_cancel_pull",
  "factory_media_capacity_log",
  "factory_media_create_job",
  "factory_media_delete_model",
  "factory_media_delete_template",
  "factory_media_get_job",
  "factory_media_get_pull",
  "factory_media_get_session",
  "factory_media_get_settings",
  "factory_media_list_models",
  "factory_media_list_templates",
  "factory_media_pull_model",
  "factory_media_start_session",
  "factory_media_stop_session",
  "factory_media_storage_status",
  "factory_media_sync_templates",
  "factory_plan_clone_group",
  "factory_plan_close",
  "factory_plan_create",
  "factory_plan_get",
  "factory_plan_import",
  "factory_plan_list",
  "factory_plan_move",
  "factory_plan_report",
  "factory_plan_rerun",
  "factory_plan_run_stage",
  "factory_plan_todo",
  "factory_plan_update",
];

function registeredNames(): string[] {
  const server = createFactoryMcpServer(
    {
      async readLogicalPath() { return { name: "x", path: "y" }; },
      async listLogicalPaths() { return []; },
      async listChannels() { return []; },
      async recordOutcome() {},
      media: {} as never,
      plans: {} as never,
      async assertMutationAllowed() {},
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

// AC-FO-09 as amended by ADR 0025 (BL-132) and ADR 0026 (BL-133): the factory writes ONLY through the tools named in
// FACTORY_WRITE_TOOL_NAMES (four media actions, then its own sessions and jobs; FO-REQ-0005 adds deleting and adopting a
// local template; BL-143 / ADR 0029 adds its generation plans: create, import, update, close, report); every other tool is a read; no tool sets a path, a workspace or a token, and none approves or rejects a
// session for anyone else.
test("AC-FO-09 (amended by ADR 0025/0026): writes are exactly the named media/session/job actions; everything else is a read; nothing sets a path, workspace or token", () => {
  assert.deepEqual([...FACTORY_WRITE_TOOL_NAMES].sort(), [
    "factory_media_adopt_template",
    "factory_media_cancel_job",
    "factory_media_cancel_pull",
    "factory_media_create_job",
    "factory_media_delete_model",
    "factory_media_delete_template",
    "factory_media_pull_model",
    "factory_media_start_session",
    "factory_media_stop_session",
    "factory_media_sync_templates",
    "factory_plan_clone_group",
    "factory_plan_close",
    "factory_plan_create",
    "factory_plan_import",
    "factory_plan_move",
    "factory_plan_report",
    "factory_plan_rerun",
    "factory_plan_run_stage",
    "factory_plan_update",
  ]);
  const writes = new Set<string>(FACTORY_WRITE_TOOL_NAMES);
  for (const name of FACTORY_TOOL_NAMES) {
    if (!writes.has(name)) assert.match(name, /^factory_(get|list|media_(get|list|storage|capacity)|plan_(get|list|todo))_?/, `${name} must be a read`);
    assert.doesNotMatch(name, /_(set|issue|revoke)_|workspace|token|approve|reject/, `${name} must not touch paths, workspaces or tokens, or approve for anyone`);
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
    // BL-132: the media core (models, storage, templates) and the shared device mutation gate for the write tools.
    "@/lib/media-generation",
    "@/lib/device-mutation-gate",
    // BL-143 (ADR 0029): the generation plans core for the factory_plan_* tools.
    "@/lib/generation-plans",
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

test("AC-FO-13 / AC-FM-15: the factory API has its own version constant (1.8.0 since BL-157), separate from the channel agents' version", async () => {
  // BL-153 (FO-REQ-0008): reviewRejected, split waiting counts and overridesValidator are additive -> a minor version.
  // BL-155 (FO-REQ-0007, CUDA_HOSTS_PLAN.md "Contract"): the jobs' errorCode, the error media_gpu_host_incompatible and the
  // stopReason "all jobs failed (release when done)" are additive -> 1.7.0, as the plan states.
  // BL-157 (SERVERS_MEDIA_PLAN.md §G): the new tool factory_plan_move and the event plan_moved are additive -> 1.8.0.
  assert.equal(FACTORY_API_VERSION, "1.8.0");
  const agentOperations = await readFile("src/lib/agent-operations/contracts.ts", "utf8");
  assert.equal(agentOperations.includes("FACTORY_API_VERSION"), false);
});
