import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Architecture audit 2026-10-01 (M8, AGENTS.md §M, DEVELOPMENT_PLAYBOOK §6.2): no code may reach into
// ANOTHER module's `adapters/` or `services` -- a module is used through its barrel (`index.ts`) or
// its `contracts`/`schemas`. Before this test, per-feature inventory tests existed but nothing
// guarded the general rule, and six such reach-ins had accumulated.

// Narrow, justified exceptions -- `importer -> target` exact pairs, each with a reason.
const ALLOWED = new Map<string, string>([
  [
    "lib/operations-instructions/services.ts -> @/lib/local-path-validation/services",
    "pure path functions; the local-path-validation barrel wires the real app-data dir from db.ts, which a services layer must not import",
  ],
  [
    "lib/channel-workspaces/services.ts -> @/lib/local-path-validation/services",
    "type-only import of the validation result, same reason as above",
  ],
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("no file imports another module's adapters/ or services directly", async () => {
  const src = path.resolve(process.cwd(), "src");
  const violations: string[] = [];
  for (const file of await sourceFiles(src)) {
    const rel = path.relative(src, file).split(path.sep).join("/");
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(/from "(@\/lib\/([a-z0-9-]+)\/(adapters\/[^"]+|services))"/g)) {
      const [, target, targetModule] = match;
      if (rel.startsWith(`lib/${targetModule}/`)) continue; // inside the module itself
      const key = `${rel} -> ${target}`;
      if (!ALLOWED.has(key)) violations.push(key);
    }
  }
  assert.deepEqual(violations, []);
});
