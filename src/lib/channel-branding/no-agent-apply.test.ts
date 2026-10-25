import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MCP_TOOL_CLASSIFICATION } from "@/mcp/tool-classification";
import { agentSurface } from "./index";

// BL-223 AC-CB-09 (CHANNEL_BRANDING_PLAN.md §4/§5, ADR 0050; like BL-210's AC-CL-10): no MCP tool or agent endpoint can reach the
// banner upload or the branding update -- only the owner's Web UI route calls the apply. Checked by source scan, like the
// write-gateway inventory.

const SRC = path.resolve(process.cwd(), "src");

/** The names through which the apply or the two branding writes can be reached. */
const BRANDING_WRITERS = ["createChannelBrandingOwnerCore", "createChannelBrandingService", "createChannelBrandingYoutubeAdapter", "insertChannelBanner", "updateChannelBrandingSettings"];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("AC-CB-09: no MCP server, agent endpoint or MCP route code names the apply or a branding write", async () => {
  const roots = ["mcp", "app/api/mcp", "lib/agent-mcp-endpoint", "lib/producer-mcp-endpoint", "lib/factory-mcp-endpoint", "lib/agent-operations"];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of await files(path.join(SRC, root))) {
      const content = await readFile(file, "utf8");
      if (BRANDING_WRITERS.some((name) => new RegExp(`\\b${name}\\b`).test(content))) offenders.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("AC-CB-09: the owner's surface is used only by the Web UI's channel-branding routes; the writes only by the module's adapter", async () => {
  const ownerCallers: string[] = [];
  const writeCallers: string[] = [];
  for (const file of await files(SRC)) {
    const content = await readFile(file, "utf8");
    const rel = path.relative(SRC, file);
    if (/\bcreateChannelBrandingOwnerCore\b/.test(content)) ownerCallers.push(rel);
    if (/\b(insertChannelBanner|updateChannelBrandingSettings)\b/.test(content)) writeCallers.push(rel);
  }
  assert.deepEqual(ownerCallers.sort(), ["app/api/channels/[channelId]/channel-branding/shared.ts", "lib/channel-branding/index.ts"]);
  assert.deepEqual(writeCallers.sort(), ["lib/channel-branding/adapters/youtube-api.ts", "lib/youtube-write-gateway/index.ts"]);
});

test("AC-CB-09: the agents' surface has only get and save; no channel-session tool names a branding apply", () => {
  const surface = agentSurface({ get: async () => ({}) as never, save: async () => ({ draft: null }) });
  assert.deepEqual(Object.keys(surface).sort(), ["get", "save"]);
  assert.deepEqual(Object.keys(MCP_TOOL_CLASSIFICATION).filter((name) => /branding|banner/i.test(name)).sort(), ["agent_channel_get_branding", "agent_channel_save_branding"]);
});
