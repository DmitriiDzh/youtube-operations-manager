import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-184 (STORYBOARD_PLAN.md §2.1, ADR 0038, AGENTS.md §M): storyboards are a feature module of their own. They depend on shared
// modules only (the storyboards sync family, the workspace exchange, channel lookups) -- never on another feature module, a Google
// client or the network.

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const lib = path.join(process.cwd(), "src", "lib");
const FEATURE_MODULES = ["media-generation", "generation-plans", "gemini-media", "live-streams", "publishing", "batches", "changesets", "video-details", "playlist-management", "video-comments"];

test("storyboards import no other feature module, no Google client and no network", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles(path.join(lib, "storyboards"))) {
    const text = await readFile(file, "utf8");
    if (new RegExp(`from\\s+["']@/lib/(${FEATURE_MODULES.join("|")})(/|["'])`).test(text)) offenders.push(path.relative(lib, file));
    if (/from\s+["']googleapis["']|fetch\(|youtube-(read|write)-gateway|media-gateway/.test(text)) offenders.push(`${path.relative(lib, file)} (network)`);
  }
  assert.deepEqual(offenders, []);
});
