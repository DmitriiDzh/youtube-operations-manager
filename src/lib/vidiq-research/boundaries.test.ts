import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-278 (ADR 0077 decision 7, AC-VQ-1.14, AGENTS.md §M): vidiq-research is an independent feature module. Nothing else in YTM
// depends on it -- only its own Web routes import it -- and it runs no background work (instrumentation starts nothing for it), so
// the rest of the app keeps working with it off, removed or failing. It reaches only the shared modules it needs.

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const IMPORTS_MODULE = /from\s+["']@\/lib\/vidiq-research(\/[^"']*)?["']|import\(\s*["']@\/lib\/vidiq-research/;

test("the import matcher catches the module and its children", () => {
  assert.ok(IMPORTS_MODULE.test('import { createVidiqResearchCore } from "@/lib/vidiq-research";'));
  assert.ok(IMPORTS_MODULE.test('import type { VidiqStatusView } from "@/lib/vidiq-research/contracts";'));
  assert.ok(!IMPORTS_MODULE.test('import { x } from "@/lib/vidiq-gateway";'));
});

test("AC-VQ-1.14: no file outside vidiq-research and its own routes imports it; instrumentation starts nothing for it", async () => {
  const src = path.join(process.cwd(), "src");
  const own = path.join(src, "lib", "vidiq-research");
  const routes = path.join(src, "app", "api", "vidiq");
  const offenders: string[] = [];
  for (const file of await sourceFiles(src)) {
    if (file.startsWith(own + path.sep) || file.startsWith(routes + path.sep)) continue;
    if (IMPORTS_MODULE.test(await readFile(file, "utf8"))) offenders.push(path.relative(src, file));
  }
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(await readFile(path.join(src, "instrumentation.ts"), "utf8"), /vidiq/i);
});

test("vidiq-research imports only the shared modules it needs (no other feature module)", async () => {
  const own = path.join(process.cwd(), "src", "lib", "vidiq-research");
  const allowed = new Set(["db", "device-secrets", "device-key-file", "shared-domain", "vidiq-gateway"]);
  const offenders: string[] = [];
  for (const file of await sourceFiles(own)) {
    for (const match of (await readFile(file, "utf8")).matchAll(/from\s+["']@\/lib\/([a-z0-9-]+)/g)) {
      if (!allowed.has(match[1])) offenders.push(`${path.relative(own, file)} -> ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
