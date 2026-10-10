import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-174 AC-GM-14 (GEMINI_MEDIA_PLAN.md §2.1, AGENTS.md §M): the Gemini module is independent of RunPod media generation and
// of generation plans in both directions, and reaches Google only through the media gateway's barrel.

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

test("gemini-media imports neither media-generation nor generation-plans, and reaches Google only through @/lib/media-gateway", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles(path.join(lib, "gemini-media"))) {
    const text = await readFile(file, "utf8");
    if (/from\s+["']@\/lib\/(media-generation|generation-plans)(\/|["'])/.test(text)) offenders.push(path.relative(lib, file));
    if (/googleapis|fetch\(/.test(text)) offenders.push(`${path.relative(lib, file)} (direct network)`);
  }
  assert.deepEqual(offenders, []);
});

test("media-generation and generation-plans do not import gemini-media", async () => {
  const offenders: string[] = [];
  for (const name of ["media-generation", "generation-plans"]) {
    for (const file of await sourceFiles(path.join(lib, name))) {
      if (/from\s+["']@\/lib\/gemini-media/.test(await readFile(file, "utf8"))) offenders.push(path.relative(lib, file));
    }
  }
  assert.deepEqual(offenders, []);
});
