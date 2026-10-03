import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// ADR 0015, stage 5: every "data is loading" line goes through the shared LoadingIndicator (spinner + text)
// so a loading screen is visibly different from an empty one. A bare `<p ...>Loading...</p>` added later
// would silently bring back the inconsistent, static state this replaced.
test("no component renders a bare <p>Loading...</p>; the shared LoadingIndicator is used instead", async () => {
  const dir = path.join(process.cwd(), "src", "components");
  const offenders: string[] = [];
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".tsx")) continue;
    const source = await readFile(path.join(dir, entry), "utf8");
    if (/<p\b[^>]*>\s*Loading\.\.\.\s*<\/p>/.test(source)) offenders.push(entry);
  }
  assert.deepEqual(offenders, []);
});
