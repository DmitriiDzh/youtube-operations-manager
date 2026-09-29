// ---------------------------------------------------------------------------
// Structural inventory (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md §6), mirroring
// src/lib/market-intelligence/write-path-inventory.test.ts's PHASE9-INV-02 pattern
// (AGENTS.md §M -- this module must be independently removable without breaking anything that
// doesn't actually depend on it).
//
// Deliberately scans IMPORT SPECIFIERS from db.ts only, not a whole-file substring search like
// PHASE9-INV-02 uses. Tried the substring approach first and it produced real false positives:
// unlike market-intelligence's compound table names (`research_channels`), this module's own
// table names -- `hypotheses`, `experiments` -- are plain English words that legitimately appear
// in unrelated prose (a comment in src/components/metric-delta.tsx, another in
// src/lib/agent-operations/contracts.ts) AND, worse, collide with this module's own public
// method names (`listHypotheses` exists at both the db.ts layer and the services layer) and its
// own natural JSON response keys (`{ hypotheses }`, `{ experiments }`). Scanning only actual
// `import { X } from ".../db"` specifiers is immune to all three of those false-positive classes
// while still catching the one thing this test exists to prevent: another file reaching past
// this module's own core into `@/lib/db`'s hypotheses/experiments symbols directly. This also
// means `src/lib/snapshot/contracts.ts`'s `SNAPSHOT_TRANSFERRED_TABLES` entries (plain string
// literals, never an import) need no special exemption here, unlike PHASE9-INV-02's own
// `isExemptReference` mechanism.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = THIS_DIR;
const REPO_ROOT = path.resolve(THIS_DIR, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const SCRIPTS_ROOT = path.join(REPO_ROOT, "scripts");

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

function isInsideDir(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const ALLOWED_IMPORTER_DIRS = [MODULE_ROOT];

// Derived from db.ts's own exports (never a hand-maintained literal list) -- PHASE9-INV-02's own
// history (round 2 review found a hand-written list missing `deleteResearchChannel`) is exactly
// why this module doesn't repeat that mistake on day one.
async function deriveForbiddenDbSymbols(): Promise<string[]> {
  const dbTsContent = await readFile(path.join(SRC_ROOT, "lib", "db.ts"), "utf8");
  const pattern = /\bexport\s+(?:async function|function|const|type)\s+(\w*(?:[Hh]ypothes|[Ee]xperiment)\w*)\b/g;
  const derived = new Set<string>();
  for (const match of dbTsContent.matchAll(pattern)) derived.add(match[1]);
  return [...derived, "hypotheses", "experiments", "experimentOutcomes"];
}

/** Every named specifier imported from `@/lib/db` or a relative `.../db` in this file --
 * `import { a, b as c } from "@/lib/db"` yields `["a", "b"]` (the ORIGINAL name, before any
 * `as` alias, since that's what must match a forbidden db.ts export). */
function extractDbImportSpecifiers(content: string): string[] {
  const importBlockPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](?:@\/lib\/db|\.{1,2}(?:\/[.\w-]+)*\/db)["']/g;
  const specifiers: string[] = [];
  for (const match of content.matchAll(importBlockPattern)) {
    for (const rawSpecifier of match[1].split(",")) {
      const name = rawSpecifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
      if (name) specifiers.push(name);
    }
  }
  return specifiers;
}

test("PHASE10-INV-01: no file outside decision-engine's own module imports its db.ts symbols", async () => {
  const forbiddenDbSymbols = await deriveForbiddenDbSymbols();
  assert.ok(forbiddenDbSymbols.includes("insertHypothesis"), "derivation must find insertHypothesis");
  assert.ok(forbiddenDbSymbols.includes("hypotheses"), "derivation must find the hypotheses table export");
  assert.ok(forbiddenDbSymbols.includes("transitionExperimentStatusIfValid"), "derivation must find transitionExperimentStatusIfValid");
  assert.ok(forbiddenDbSymbols.includes("StoredExperimentOutcome"), "derivation must find the StoredExperimentOutcome type export");
  assert.ok(forbiddenDbSymbols.length >= 10, "derivation returned suspiciously few symbols -- regex likely broke");

  const files = [...(await listTsFilesRecursively(SRC_ROOT)), ...(await listTsFilesRecursively(SCRIPTS_ROOT))];
  const offenders: string[] = [];

  for (const file of files) {
    if (ALLOWED_IMPORTER_DIRS.some((dir) => isInsideDir(file, dir))) continue;
    if (path.resolve(file) === path.resolve(SRC_ROOT, "lib", "db.ts")) continue;
    const content = await readFile(file, "utf8");
    const imported = extractDbImportSpecifiers(content);
    for (const symbol of imported) {
      if (forbiddenDbSymbols.includes(symbol)) {
        offenders.push(`${file}: imports forbidden db.ts symbol "${symbol}"`);
      }
    }
  }

  assert.deepEqual(offenders, [], `Found forbidden hypotheses/experiment db.ts imports outside decision-engine:\n${offenders.join("\n")}`);
});

test("PHASE10-INV-01 helper: extractDbImportSpecifiers finds @/lib/db and relative ../db imports, ignores everything else", () => {
  assert.deepEqual(
    extractDbImportSpecifiers('import { insertHypothesis, hypotheses as h } from "@/lib/db";'),
    ["insertHypothesis", "hypotheses"]
  );
  assert.deepEqual(extractDbImportSpecifiers('import type { StoredHypothesis } from "@/lib/db";'), ["StoredHypothesis"]);
  assert.deepEqual(extractDbImportSpecifiers('import { insertHypothesis } from "../../db";'), ["insertHypothesis"]);
  // A JSON response key or a services-layer method call must never trigger this -- neither is an
  // import specifier, which is the whole reason this test scans imports, not raw text.
  assert.deepEqual(extractDbImportSpecifiers("return NextResponse.json({ hypotheses });"), []);
  assert.deepEqual(extractDbImportSpecifiers("const x = await core.listHypotheses(ctx);"), []);
  assert.deepEqual(extractDbImportSpecifiers('import { createDecisionEngineCore } from "@/lib/decision-engine";'), []);
});

// Phase 10 slice 3 (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md §4) -- the reverse direction of
// PHASE10-INV-01 above: this module must never import analytics/market-intelligence itself
// (AGENTS.md §M). The real dependency lives only in the interface layer
// (src/app/api/decision-engine/hypotheses/[hypothesisId]/evidence/route.ts's own
// `createRealEvidenceReferenceResolver`), which is explicitly OUTSIDE this module's own
// `MODULE_ROOT` and therefore untouched by this scan. Named PHASE10-INV-03, not -02 -- that
// number is already `decision-engine-agent-approval-inventory.test.ts`'s own (slice 2), a
// different invariant in a different file.
//
// Widened in slice 5 (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §3) to also forbid
// @/lib/changesets and @/lib/batches, the same reasoning in the new direction: the real
// dependency lives only in src/app/api/decision-engine/experiment-execution-resolver.ts, also
// outside MODULE_ROOT.
test("PHASE10-INV-03: decision-engine's own module never imports @/lib/analytics, @/lib/market-intelligence, @/lib/changesets, or @/lib/batches", async () => {
  const files = await listTsFilesRecursively(MODULE_ROOT);
  assert.ok(files.length > 0, "must actually scan some files -- an empty list would make this test vacuously pass");
  const offenders: string[] = [];
  const forbiddenModuleSpecifiers = [
    /["']@\/lib\/analytics(?:\/|["'])/,
    /["']@\/lib\/market-intelligence(?:\/|["'])/,
    /["']@\/lib\/changesets(?:\/|["'])/,
    /["']@\/lib\/batches(?:\/|["'])/,
  ];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of forbiddenModuleSpecifiers) {
      if (pattern.test(content)) {
        offenders.push(`${file}: imports a forbidden module (matches ${pattern})`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `decision-engine/** must never import analytics/market-intelligence/changesets/batches directly:\n${offenders.join("\n")}`
  );
});
