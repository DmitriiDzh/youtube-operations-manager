// ---------------------------------------------------------------------------
// Approval integrity (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md §5, FUTURE_PHASES.md §6: "no
// consequential action executes merely because an AI agent proposed it"), mirrored after
// market-research-request-approval-inventory.test.ts's own structural-inventory technique. The
// core invariant this slice depends on: an agent may CREATE an experiment proposal, but nothing
// an agent can reach may create a hypothesis from scratch, transition an experiment's status, or
// record an outcome. Proven mechanically -- by scanning every source file under the directories
// an agent-facing surface could live in -- rather than left as "true today because no one
// happened to add those tools."
//
// Scans directories, not hardcoded filenames (same precedent). src/app/api/** is deliberately NOT
// scanned -- that is the one place the real, Web-UI-only routes are SUPPOSED to call these
// functions from.
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

// Named descriptively in this file's own prose above rather than spelling these out again, so
// this comment block can never trip its own scan (PHASE9-INV-02's own discovered false positive).
// `addHypothesisEvidence` (Phase 10 slice 3) added to this list for the same reason as the other
// three -- this slice deliberately ships no MCP/CLI surface for structured evidence at all (see
// docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md §7), so proving it stays unreachable belongs here
// alongside the actions slice 2 already covers, not as a separate new inventory test.
const FORBIDDEN_AGENT_SYMBOLS = ["createHypothesis", "transitionExperiment", "createExperimentOutcome", "addHypothesisEvidence"];

test("PHASE10-INV-02: no file under src/mcp, src/cli, or src/lib/agent-operations references createHypothesis/transitionExperiment/createExperimentOutcome/addHypothesisEvidence", async () => {
  const offenders: string[] = [];

  for (const root of SCANNED_ROOTS) {
    const files = await listTsFilesRecursively(root);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const symbol of FORBIDDEN_AGENT_SYMBOLS) {
        if (content.includes(symbol)) offenders.push(`${file}: references forbidden symbol "${symbol}"`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Found a reference to a Web-UI-only decision-engine action outside the route it belongs to:\n${offenders.join("\n")}`
  );
});
