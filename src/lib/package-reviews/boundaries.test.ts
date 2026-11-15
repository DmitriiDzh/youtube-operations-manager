import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MCP_TOOL_CLASSIFICATION } from "@/mcp/tool-classification";
import { FACTORY_TOOL_NAMES } from "@/mcp/factory-server";
import { WORKER_FACTORY_TOOLS } from "@/mcp/worker-factory-tools";

// BL-257 (PACKAGE_REVIEW_PLAN.md AC-PR-08; ADR 0070 §1, §4; AGENTS.md §M): the package-reviews module is a feature module of its own --
// no other feature module, no Google client, no network -- and only the owner's Web UI decides or switches: the owner's surface is
// created only by the composition file the package-review route handlers use. No MCP tool, agent endpoint or factory path names it.
// The symbols are assembled from parts so this file never matches a scan of its own.

const SRC = path.resolve(process.cwd(), "src");
const FEATURE_MODULES = ["media-generation", "generation-plans", "gemini-media", "live-streams", "publishing", "publishing-plans", "publishing-plan-progress", "batches", "changesets", "video-details", "playlist-management", "video-comments", "storyboards", "storyboard-takes", "channel-branding", "channel-localizations", "agent-proposals", "clip-reviews", "review-notify"];
const OWNER_CORE = ["createPackageReviews", "OwnerCore"].join("");
const OWNER_SYMBOLS = [OWNER_CORE, ["PackageReviews", "OwnerSurface"].join(""), ["createPackageReviews", "Service"].join(""), ["packageReviews", "OwnerSurface"].join("")];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("AC-PR-08 / §M: package-reviews imports no other feature module, no Google client and no network", async () => {
  const offenders: string[] = [];
  for (const file of await files(path.join(SRC, "lib", "package-reviews"))) {
    const text = await readFile(file, "utf8");
    if (new RegExp(`from\\s+["']@/lib/(${FEATURE_MODULES.join("|")})(/|["'])`).test(text)) offenders.push(path.relative(SRC, file));
    if (/from\s+["']googleapis["']|fetch\(|youtube-(read|write)-gateway|media-gateway/.test(text)) offenders.push(`${path.relative(SRC, file)} (network)`);
  }
  assert.deepEqual(offenders, []);
});

test("AC-PR-08: no MCP server, agent endpoint, MCP route, CLI or agent-operations file names the owner's surface", async () => {
  const roots = ["mcp", "cli", "app/api/mcp", "lib/agent-mcp-endpoint", "lib/producer-mcp-endpoint", "lib/factory-mcp-endpoint", "lib/agent-operations"];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of await files(path.join(SRC, root))) {
      const content = await readFile(file, "utf8");
      for (const symbol of [...OWNER_SYMBOLS, "composition/package-reviews"]) if (content.includes(symbol)) offenders.push(`${path.relative(SRC, file)}: ${symbol}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("AC-PR-08: the owner's surface is created only by the composition file, which only the package-review route handlers use", async () => {
  const creators: string[] = [];
  const composers: string[] = [];
  for (const file of await files(SRC)) {
    const content = await readFile(file, "utf8");
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    if (content.includes(OWNER_CORE)) creators.push(rel);
    if (content.includes("@/composition/package-reviews")) composers.push(rel);
  }
  assert.deepEqual(creators.sort(), ["composition/package-reviews.ts", "lib/package-reviews/index.ts"]);
  assert.deepEqual(composers.sort(), ["app/api/channels/[channelId]/package-reviews/handlers.ts"]);
});

test("AC-PR-08: no MCP tool, worker tool or factory tool reviews packages", () => {
  assert.deepEqual(Object.keys(MCP_TOOL_CLASSIFICATION).filter((name) => name.includes("package_review")), []);
  assert.deepEqual(FACTORY_TOOL_NAMES.filter((name) => name.includes("package_review")), []);
  assert.deepEqual(Object.keys(WORKER_FACTORY_TOOLS).filter((name) => name.includes("package_review")), []);
});
