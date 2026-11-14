import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-252 (ADR 0068) -- AGENTS.md §G single gateway per API category: only `src/lib/social-gateway/` may reach a social network's
// API host (Meta's Graph API and its OAuth dialog today). Same regex-over-sources shape as `media-gateway/inventory.test.ts`.
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === "node_modules") continue;
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (/\.(ts|tsx|mjs|js|sh)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const HOST_PATTERN = /graph\.facebook\.com|graph\.instagram\.com|www\.facebook\.com\/v\d|facebook\.com\/[^"'\s]*dialog\/oauth/;

test("social-gateway inventory: no production file outside src/lib/social-gateway references a Meta API host", async () => {
  const root = process.cwd();
  const gateway = path.join(root, "src", "lib", "social-gateway");
  const offenders: string[] = [];
  for (const dir of ["src", "scripts"]) {
    let files: string[] = [];
    try {
      files = await listFiles(path.join(root, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.startsWith(gateway + path.sep)) continue;
      if (HOST_PATTERN.test(await readFile(file, "utf8"))) offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("social-gateway inventory: callers import the barrel, never a child module directly", async () => {
  const root = process.cwd();
  const gateway = path.join(root, "src", "lib", "social-gateway");
  const offenders: string[] = [];
  for (const file of await listFiles(path.join(root, "src"))) {
    if (file.startsWith(gateway + path.sep)) continue;
    if (/from\s+["']@\/lib\/social-gateway\/[^"']+["']/.test(await readFile(file, "utf8"))) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, []);
});
