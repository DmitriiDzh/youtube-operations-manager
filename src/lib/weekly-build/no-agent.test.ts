import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-231 acceptance 11 (WEEKLY_BUILD_BUTTON_PLAN.md "Security"): the factory scripts are run only from the owner's Web UI --
// no MCP server, agent endpoint or MCP route imports the module; only its own Web routes do. Source scan, like BL-223's AC-CB-09.

const SRC = path.resolve(process.cwd(), "src");

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const IMPORTS_MODULE = /from\s+["']@\/lib\/weekly-build(\/[^"']*)?["']|import\(\s*["']@\/lib\/weekly-build/;

test("AC 11: only the weekly-build Web routes import @/lib/weekly-build", async () => {
  const callers: string[] = [];
  for (const file of await files(SRC)) {
    if (file.startsWith(path.join(SRC, "lib", "weekly-build") + path.sep)) continue;
    if (IMPORTS_MODULE.test(await readFile(file, "utf8"))) callers.push(path.relative(SRC, file).split(path.sep).join("/"));
  }
  const allowed = (rel: string) => rel.startsWith("app/api/channels/[channelId]/weekly-build/") || rel.startsWith("app/api/weekly-build/") || rel.startsWith("components/");
  assert.deepEqual(callers.filter((rel) => !allowed(rel)), []);
  const agentRoots = ["mcp/", "app/api/mcp/", "lib/agent-mcp-endpoint/", "lib/producer-mcp-endpoint/", "lib/factory-mcp-endpoint/", "lib/agent-operations/"];
  assert.deepEqual(callers.filter((rel) => agentRoots.some((root) => rel.startsWith(root))), []);
});
