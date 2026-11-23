import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FACTORY_TOOL_NAMES } from "@/mcp/factory-server";
import { MCP_TOOL_CLASSIFICATION } from "@/mcp/tool-classification";
import { WORKER_FACTORY_TOOLS } from "@/mcp/worker-factory-tools";

// BL-272 (ADR 0076; AGENTS.md §M): the image-reviews module is a feature module of its own -- no other feature module (the clips
// for review included), no Google client, no network -- and clip-reviews never imports it either (what both need is in the shared
// `review-items` module and the sync-gateway family). No MCP path can reach the owner's decision: his surface is used only by the
// Web UI's image-review routes. The symbols are assembled from parts so this file never matches a scan of its own.

const SRC = path.resolve(process.cwd(), "src");
const FEATURE_MODULES = ["media-generation", "generation-plans", "gemini-media", "live-streams", "publishing", "publishing-plans", "batches", "changesets", "video-details", "playlist-management", "video-comments", "storyboards", "storyboard-takes", "channel-branding", "channel-localizations", "agent-proposals", "clip-reviews", "package-reviews"];
const OWNER_CORE = ["createImageReviews", "OwnerCore"].join("");
const OWNER_SYMBOLS = [OWNER_CORE, ["ImageReviews", "OwnerSurface"].join(""), ["createImageReviews", "Service"].join("")];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("BL-272: image-reviews imports no other feature module, no Google client and no network", async () => {
  const offenders: string[] = [];
  for (const file of await files(path.join(SRC, "lib", "image-reviews"))) {
    const text = await readFile(file, "utf8");
    if (new RegExp(`from\\s+["']@/lib/(${FEATURE_MODULES.join("|")})(/|["'])`).test(text)) offenders.push(path.relative(SRC, file));
    if (/from\s+["']googleapis["']|fetch\(|youtube-(read|write)-gateway|media-gateway/.test(text)) offenders.push(`${path.relative(SRC, file)} (network)`);
  }
  assert.deepEqual(offenders, []);
});

test("BL-272 (AGENTS.md §M): clip-reviews and the shared review-items module never import image-reviews", async () => {
  const offenders: string[] = [];
  for (const dir of ["clip-reviews", "review-items"]) {
    for (const file of await files(path.join(SRC, "lib", dir))) {
      if (/from\s+["']@\/lib\/image-reviews(\/|["'])/.test(await readFile(file, "utf8"))) offenders.push(path.relative(SRC, file));
    }
  }
  for (const file of await files(path.join(SRC, "lib", "review-items"))) {
    if (/from\s+["']@\/lib\/clip-reviews(\/|["'])/.test(await readFile(file, "utf8"))) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(offenders, []);
});

test("BL-272: no MCP server, agent endpoint, MCP route or agent-operations file names the owner's surface", async () => {
  const roots = ["mcp", "cli", "app/api/mcp", "lib/agent-mcp-endpoint", "lib/producer-mcp-endpoint", "lib/factory-mcp-endpoint", "lib/agent-operations"];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of await files(path.join(SRC, root))) {
      const content = await readFile(file, "utf8");
      for (const symbol of OWNER_SYMBOLS) if (content.includes(symbol)) offenders.push(`${path.relative(SRC, file)}: ${symbol}`);
      if (/imageReviews\.\s*decide|ownerSurface\(.*image/i.test(content)) offenders.push(`${path.relative(SRC, file)}: decide`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("BL-272: the owner's surface is created only by the Web UI's image-review route handlers", async () => {
  const callers: string[] = [];
  for (const file of await files(SRC)) {
    if ((await readFile(file, "utf8")).includes(OWNER_CORE)) callers.push(path.relative(SRC, file).split(path.sep).join("/"));
  }
  assert.deepEqual(callers.sort(), ["app/api/channels/[channelId]/image-reviews/handlers.ts", "lib/image-reviews/index.ts"]);
});

test("BL-272: the image review tools are the Producer's only -- no channel worker or factory tool reviews images", () => {
  assert.deepEqual(
    Object.entries(MCP_TOOL_CLASSIFICATION).filter(([name]) => name.includes("image_review")).map(([name, cls]) => [name, cls]).sort(),
    [
      ["producer_image_review_get", "producer-only"],
      ["producer_image_review_list", "producer-only"],
      ["producer_image_review_submit", "producer-only"],
      ["producer_image_review_withdraw", "producer-only"],
    ]
  );
  assert.deepEqual(FACTORY_TOOL_NAMES.filter((name) => name.includes("image_review")), []);
  assert.deepEqual(Object.keys(WORKER_FACTORY_TOOLS).filter((name) => name.includes("image_review")), []);
});
