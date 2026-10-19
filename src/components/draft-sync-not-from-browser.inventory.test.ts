import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-203 AC-NAV-06 (docs/roadmap/plans/FAST_NAVIGATION_PLAN.md): the draft sync cycle runs on the server's own 60 s scheduler
// (src/instrumentation.ts). A tab that starts it on mount or on a timer kept the server busy for seconds per tab; only the Merge
// tab's "Sync now" button (device-handoff-panel.tsx) may call the route.
test("only the Merge tab's Sync now calls POST /api/change-drafts/sync from the browser", async () => {
  const offenders: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "api") await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
      if (entry.name.includes(".test.")) continue;
      const source = await readFile(full, "utf8");
      if (/["'`]\/api\/change-drafts\/sync["'`]/.test(source)) offenders.push(path.relative(process.cwd(), full));
    }
  }
  await walk(path.join(process.cwd(), "src", "app"));
  await walk(path.join(process.cwd(), "src", "components"));
  assert.deepEqual(offenders, [path.join("src", "components", "device-handoff-panel.tsx")]);
});
