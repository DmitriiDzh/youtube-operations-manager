import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MCP_TOOL_CLASSIFICATION } from "@/mcp/tool-classification";

// BL-210 AC-CL-10 (CHANNEL_LOCALIZATIONS_PLAN.md §2/§5, ADR 0047; mirrors AC-UP-14): no MCP tool or agent endpoint can reach the
// YouTube write of a channel's translations -- only the owner's Web UI route calls the apply. Checked by source scan, like the
// write-gateway inventory.

const SRC = path.resolve(process.cwd(), "src");

/** The names through which the apply or the two channel writes can be reached. */
const CHANNEL_WRITERS = [
  "createChannelLocalizationsOwnerCore",
  "createChannelLocalizationsService",
  "createChannelLocalizationsYoutubeAdapter",
  "updateChannelLocalizations",
  "updateChannelBrandingChannel",
];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("AC-CL-10: no MCP server, agent endpoint or MCP route code names the apply or a channel write", async () => {
  const roots = ["mcp", "app/api/mcp", "lib/agent-mcp-endpoint", "lib/producer-mcp-endpoint", "lib/factory-mcp-endpoint", "lib/agent-operations"];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of await files(path.join(SRC, root))) {
      const content = await readFile(file, "utf8");
      if (CHANNEL_WRITERS.some((name) => new RegExp(`\\b${name}\\b`).test(content))) offenders.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("AC-CL-10: the owner's surface is used only by the Web UI's channel-localizations routes; the writes only by the module's adapter", async () => {
  const ownerCallers: string[] = [];
  const writeCallers: string[] = [];
  for (const file of await files(SRC)) {
    const content = await readFile(file, "utf8");
    const rel = path.relative(SRC, file);
    if (/\bcreateChannelLocalizationsOwnerCore\b/.test(content)) ownerCallers.push(rel);
    if (/\b(updateChannelLocalizations|updateChannelBrandingChannel)\b/.test(content)) writeCallers.push(rel);
  }
  assert.deepEqual(ownerCallers.sort(), ["app/api/channels/[channelId]/channel-localizations/shared.ts", "lib/channel-localizations/index.ts"]);
  assert.deepEqual(writeCallers.sort(), ["lib/channel-localizations/adapters/youtube-api.ts", "lib/youtube-write-gateway/index.ts"]);
});

test("AC-CL-10: no channel-session MCP tool names a channel translation apply", () => {
  assert.deepEqual(Object.keys(MCP_TOOL_CLASSIFICATION).filter((name) => /channel.*locali[sz]ation|channel.*translation/i.test(name)), []);
});
