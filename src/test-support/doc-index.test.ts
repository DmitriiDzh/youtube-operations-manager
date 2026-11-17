import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { checkDocIndex } from "../../scripts/check-doc-index.mjs";

// docs/roadmap/plans/DOCS_SPLIT_PLAN.md §5: SYSTEM_MAP.md and ARCHITECTURE.md are indexes (<= 30 KB) over
// docs/system/*.md and docs/architecture/*.md; every section is listed in its index and every row has its section.
test("SYSTEM_MAP.md and ARCHITECTURE.md indexes list every section of their subsystem files", () => {
  assert.deepEqual(checkDocIndex(path.resolve(process.cwd())), []);
});
