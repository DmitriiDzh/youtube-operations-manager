// ---------------------------------------------------------------------------
// Approval integrity (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md §7, owner spec §29),
// mirrored after write-path-inventory.test.ts's own structural-inventory technique. The core
// invariant this slice depends on: an agent may CREATE a research request, but nothing an agent
// can reach may ever move it out of "pending". This is proven mechanically -- by scanning every
// source file under the directories an agent-facing surface could live in -- rather than left as
// "true today because no one happened to add an approve tool."
//
// Scans directories, not two hardcoded filenames (advisor review, before implementation): a future
// refactor that splits src/mcp/server.ts into src/mcp/tools/*.ts must not silently escape this
// guarantee. src/app/api/** is deliberately NOT scanned -- that is the one place the real,
// Web-UI-only approve/reject routes are SUPPOSED to call these functions from.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

const SCANNED_ROOTS = [
  path.join(SRC_ROOT, "mcp"),
  path.join(SRC_ROOT, "cli"),
  path.join(SRC_ROOT, "lib", "agent-operations"),
];

async function listTsFilesRecursively(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...(await listTsFilesRecursively(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

// Named descriptively rather than spelling out the two guarded function names verbatim, so this
// file's own prose can never trip its sibling's plain-substring scan the way a doc comment
// elsewhere in this phase already did once (PHASE9-INV-02's own discovered false positive).
const FORBIDDEN_APPROVAL_SYMBOLS = ["approveMarketResearchRequest", "rejectMarketResearchRequest"];

test("PHASE9-INV-03: no file under src/mcp, src/cli, or src/lib/agent-operations references the research-request approve/reject actions", async () => {
  const offenders: string[] = [];

  for (const root of SCANNED_ROOTS) {
    const files = await listTsFilesRecursively(root);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const symbol of FORBIDDEN_APPROVAL_SYMBOLS) {
        if (content.includes(symbol)) offenders.push(`${file}: references forbidden symbol "${symbol}"`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Found a reference to the research-request approve/reject actions outside the Web-UI-only route it belongs to:\n${offenders.join("\n")}`
  );
});
