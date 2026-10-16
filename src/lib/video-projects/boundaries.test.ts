import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-194 (VIDEO_COST_PLAN.md §2 stage 1, ADR 0040, AGENTS.md §M): video-projects is a shared module that the storyboards, the plans
// and both media modules depend on -- so it must depend on none of them (a storyboard's or a plan's video reaches it through ports),
// and it reaches no network.

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
const FEATURE_MODULES = ["storyboards", "storyboard-takes", "media-generation", "generation-plans", "gemini-media", "media-jobs-pool", "live-streams", "publishing", "batches", "changesets", "video-details"];

test("video-projects imports no feature module, no Google client and no network", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles(path.join(lib, "video-projects"))) {
    const text = await readFile(file, "utf8");
    if (new RegExp(`from\\s+["']@/lib/(${FEATURE_MODULES.join("|")})(/|["'])`).test(text)) offenders.push(path.relative(lib, file));
    if (/from\s+["']googleapis["']|fetch\(|youtube-(read|write)-gateway|media-gateway/.test(text)) offenders.push(`${path.relative(lib, file)} (network)`);
  }
  assert.deepEqual(offenders, []);
});
