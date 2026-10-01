import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Phase 13 slice 13.8 -- AGENTS.md §G single gateway per API category: only this module may call
// the Wikimedia API (it carries the toggle, the traffic counter and the User-Agent).
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("wikipedia-gateway inventory: no file outside src/lib/wikipedia-gateway calls a wikimedia.org URL", async () => {
  const src = path.resolve(process.cwd(), "src");
  const gateway = path.join(src, "lib", "wikipedia-gateway");
  const offenders: string[] = [];
  for (const file of await listFiles(src)) {
    if (file.startsWith(gateway + path.sep)) continue;
    if (/https?:\/\/[^"'`\s]*wikimedia\.org/.test(await readFile(file, "utf8"))) offenders.push(path.relative(src, file));
  }
  assert.deepEqual(offenders, []);
});
