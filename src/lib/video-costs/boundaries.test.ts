import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-194 (VIDEO_COST_PLAN.md §2 stage 3, ADR 0041, AGENTS.md §M): video-costs reads the run rows, the reports and the storyboards
// document through shared modules only -- no media module, Publishing or the storyboards module -- so each keeps working without it,
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

test("video-costs imports no feature module, no Google client and no network", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles(path.join(lib, "video-costs"))) {
    const text = await readFile(file, "utf8");
    if (new RegExp(`from\\s+["']@/lib/(${FEATURE_MODULES.join("|")})(/|["'])`).test(text)) offenders.push(path.relative(lib, file));
    if (/from\s+["']googleapis["']|fetch\(|youtube-(read|write)-gateway|media-gateway/.test(text)) offenders.push(`${path.relative(lib, file)} (network)`);
  }
  assert.deepEqual(offenders, []);
});

test("no media module imports video-costs (criterion 8: Servers and Media work when it fails); Publishing reaches it only lazily", async () => {
  const offenders: string[] = [];
  for (const dependent of ["media-generation", "gemini-media", "media-jobs-pool", "storyboards", "video-projects"]) {
    for (const file of await sourceFiles(path.join(lib, dependent))) {
      if (/@\/lib\/video-costs/.test(await readFile(file, "utf8"))) offenders.push(path.relative(lib, file));
    }
  }
  for (const file of await sourceFiles(path.join(lib, "publishing"))) {
    if (/^import[^;]*["']@\/lib\/video-costs/m.test(await readFile(file, "utf8"))) offenders.push(`${path.relative(lib, file)} (static import)`);
  }
  assert.deepEqual(offenders, []);
});
