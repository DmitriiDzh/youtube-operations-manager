import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Phase 14 -- AGENTS.md §G single gateway per API category: only `src/lib/media-gateway/` may
// reach a RunPod host (the REST API, the S3 endpoint, the pod HTTP proxy) or build a ComfyUI
// request. The same import-free, regex-over-sources shape as `wikipedia-gateway/inventory.test.ts`.
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

const HOST_PATTERN = /(api|rest)\.runpod\.io|s3api-[a-z0-9-]+\.runpod\.io|proxy\.runpod\.net/;

test("media-gateway inventory: no production file outside src/lib/media-gateway references a runpod.io host", async () => {
  const root = process.cwd();
  const gateway = path.join(root, "src", "lib", "media-gateway");
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

test("media-gateway inventory: callers import the barrel, never a child module directly", async () => {
  const root = process.cwd();
  const gateway = path.join(root, "src", "lib", "media-gateway");
  const offenders: string[] = [];
  for (const file of await listFiles(path.join(root, "src"))) {
    if (file.startsWith(gateway + path.sep)) continue;
    const text = await readFile(file, "utf8");
    if (/from\s+["']@\/lib\/media-gateway\/[^"']+["']/.test(text)) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, []);
});
