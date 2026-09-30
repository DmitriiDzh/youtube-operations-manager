import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Review of the architecture-audit fixes (2026-10-01): a Settings card must POST only its OWN fields.
// Two cards used to POST their whole mount-time snapshot, which (a) re-sent stale values of other
// cards -- e.g. silently turning Live writes back ON after it had been switched off elsewhere -- and
// (b) after H2, could save a `null` placeholder of a field whose read failed. Every POST body to
// /api/settings in a component must therefore be an explicit object literal.
test("every component POST to /api/settings sends an explicit object literal, never a whole snapshot", async () => {
  const dir = path.resolve(process.cwd(), "src/components");
  const offenders: string[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".tsx")) continue;
    const content = await readFile(path.join(dir, name), "utf8");
    for (const match of content.matchAll(/fetch\("\/api\/settings",\s*\{[\s\S]*?body:\s*JSON\.stringify\(([^)]*)/g)) {
      if (!match[1].trim().startsWith("{")) offenders.push(`${name}: JSON.stringify(${match[1].trim()})`);
    }
  }
  assert.deepEqual(offenders, []);
});
