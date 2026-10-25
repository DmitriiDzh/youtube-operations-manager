import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MCP_TOOL_CLASSIFICATION } from "@/mcp/tool-classification";
import { FACTORY_TOOL_NAMES, FACTORY_WRITE_TOOL_NAMES } from "@/mcp/factory-server";
import { WORKER_FACTORY_TOOLS } from "@/mcp/worker-factory-tools";

// BL-225 (WEEKLY_PUBLISHING_PLAN.md stage 1 item 7, AC-WP-05 / AC-WP-16; ADR 0051 §1, §6; AGENTS.md §M): the publishing-plans
// module is a feature module of its own -- no other feature module, no Google client, no network (stage 1 makes no YouTube
// call) -- and no MCP path can reach a decision: the owner's surface is used only by the Web UI's publishing-plans routes.

const SRC = path.resolve(process.cwd(), "src");
const FEATURE_MODULES = ["media-generation", "generation-plans", "gemini-media", "live-streams", "publishing", "batches", "changesets", "video-details", "playlist-management", "video-comments", "storyboards", "channel-branding", "channel-localizations"];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("AC-WP-16: publishing-plans imports no other feature module, no Google client and no network", async () => {
  const offenders: string[] = [];
  for (const file of await files(path.join(SRC, "lib", "publishing-plans"))) {
    const text = await readFile(file, "utf8");
    if (new RegExp(`from\\s+["']@/lib/(${FEATURE_MODULES.join("|")})(/|["'])`).test(text)) offenders.push(path.relative(SRC, file));
    if (/from\s+["']googleapis["']|fetch\(|youtube-(read|write)-gateway|media-gateway/.test(text)) offenders.push(`${path.relative(SRC, file)} (network)`);
  }
  assert.deepEqual(offenders, []);
});

test("AC-WP-05: no MCP server, agent endpoint or MCP route names the owner's surface or a decision", async () => {
  const roots = ["mcp", "app/api/mcp", "lib/agent-mcp-endpoint", "lib/producer-mcp-endpoint", "lib/factory-mcp-endpoint", "lib/agent-operations"];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of await files(path.join(SRC, root))) {
      const content = await readFile(file, "utf8");
      if (/\b(createPublishingPlansOwnerCore|ownerSurface|createPublishingPlansService|addDecisions)\b/.test(content)) offenders.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("AC-WP-05: the owner's surface is used only by the Web UI's publishing-plans routes", async () => {
  const callers: string[] = [];
  for (const file of await files(SRC)) {
    if (/\bcreatePublishingPlansOwnerCore\b/.test(await readFile(file, "utf8"))) callers.push(path.relative(SRC, file));
  }
  assert.deepEqual(callers.sort(), ["app/api/channels/[channelId]/publishing-plans/handlers.ts", "lib/publishing-plans/index.ts"]);
});

test("AC-WP-05 / AC-WP-17: the plan tools are exactly save/get/list for the Operator and the worker; only save writes", () => {
  assert.deepEqual(FACTORY_TOOL_NAMES.filter((name) => /plan_(save|get|list)$/.test(name) && name.includes("publishing")).sort(), ["factory_publishing_plan_get", "factory_publishing_plan_list", "factory_publishing_plan_save"]);
  assert.deepEqual((FACTORY_WRITE_TOOL_NAMES as readonly string[]).filter((name) => name.includes("publishing_plan")), ["factory_publishing_plan_save"]);
  assert.deepEqual(Object.keys(MCP_TOOL_CLASSIFICATION).filter((name) => name.includes("publishing_plan")).sort(), ["agent_publishing_plan_get", "agent_publishing_plan_list", "agent_publishing_plan_save"]);
  assert.deepEqual(
    Object.entries(WORKER_FACTORY_TOOLS).filter(([name]) => name.includes("publishing_plan")).map(([name, t]) => [name, t.agentName, t.writes]).sort(),
    [
      ["factory_publishing_plan_get", "agent_publishing_plan_get", false],
      ["factory_publishing_plan_list", "agent_publishing_plan_list", false],
      ["factory_publishing_plan_save", "agent_publishing_plan_save", true],
    ]
  );
});
