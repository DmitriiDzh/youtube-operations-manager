import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-176 (LIVE_STREAMS_PLAN.md §3.2, ADR 0036 §2, AGENTS.md §M): the live-streams module depends only on shared modules
// and the gateways, no other feature module imports it, and it reaches YouTube only through the gateways' barrels.

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
const FEATURE_MODULES = ["media-generation", "generation-plans", "gemini-media", "batches", "changesets", "video-details", "playlist-management", "video-comments"];

test("live-streams imports no other feature module and no Google client directly", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles(path.join(lib, "live-streams"))) {
    const text = await readFile(file, "utf8");
    const feature = new RegExp(`from\\s+["']@/lib/(${FEATURE_MODULES.join("|")})(/|["'])`);
    if (feature.test(text)) offenders.push(path.relative(lib, file));
    if (/from\s+["']googleapis["']|fetch\(/.test(text)) offenders.push(`${path.relative(lib, file)} (direct network)`);
    if (/@\/lib\/youtube-(read|write)-gateway\//.test(text)) offenders.push(`${path.relative(lib, file)} (a gateway child, not the barrel)`);
  }
  assert.deepEqual(offenders, []);
});

test("no other module under src/lib imports live-streams", async () => {
  const offenders: string[] = [];
  for (const entry of await readdir(lib, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "live-streams") continue;
    for (const file of await sourceFiles(path.join(lib, entry.name))) {
      if (/from\s+["']@\/lib\/live-streams/.test(await readFile(file, "utf8"))) offenders.push(path.relative(lib, file));
    }
  }
  assert.deepEqual(offenders, []);
});
