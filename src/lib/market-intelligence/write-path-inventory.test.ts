// ---------------------------------------------------------------------------
// Structural inventory (docs/roadmap/plans/PHASE_9_PLAN.md §5/§7), mirroring
// src/lib/ai-connections/write-path-inventory.test.ts's pattern. This module describes channels
// the operator does not (necessarily) own -- it must never gain a path to a YouTube write, and
// nothing outside this module may reach into its tables directly (AGENTS.md §M).
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

const FORBIDDEN_WRITE_SYMBOLS = [
  "assertWriteChannel",
  "write-context",
  "youtube-write-gateway",
  "WriteExecutor",
  "assertLiveWritesAuthorized",
];

test("PHASE9-INV-01: no file in src/lib/market-intelligence references a write-capable symbol", async () => {
  const files = await listTsFilesRecursively(MODULE_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const symbol of FORBIDDEN_WRITE_SYMBOLS) {
      if (content.includes(symbol)) offenders.push(`${file}: references forbidden symbol "${symbol}"`);
    }
  }

  assert.deepEqual(offenders, [], `Found forbidden write-path references:\n${offenders.join("\n")}`);
});

// Everything outside this module's own tree (and its eventual API routes / Web UI panel, which
// legitimately need to call into it) must reach `research_channels`/`research_evidence` only
// through this module's own exported core -- never a raw db.ts import of the research_* helpers,
// and never a second, competing read of those tables from an unrelated domain module (AGENTS.md
// §M: this module must be independently removable without breaking anything that doesn't
// actually depend on it).
//
// Found by independent review (2026-09-26): `startsWith` on a raw path prefix is a real bypass --
// "src/lib/market-intelligence-v2/x.ts".startsWith(".../market-intelligence") is true with no
// path-separator boundary. Fixed with the same `isInsideDir` (path.relative-based) helper
// `youtube-read-gateway/read-gateway-inventory.test.ts` already uses for exactly this reason.
function isInsideDir(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const ALLOWED_IMPORTER_DIRS = [
  path.join(SRC_ROOT, "lib", "market-intelligence"),
  path.join(SRC_ROOT, "app", "api", "market-intelligence"),
];
// The Web UI panel is a single file directly under src/components, not its own directory --
// matched by exact path, not isInsideDir (there is no "market-intelligence" subdirectory there).
const ALLOWED_IMPORTER_FILES = [path.join(SRC_ROOT, "components", "market-research-panel.tsx")];

// Both the camelCase Drizzle identifiers AND the underlying snake_case SQL table names --
// found by independent review (2026-09-26): a raw `sql\`... research_channels ...\`` escape
// hatch (already used elsewhere in this codebase, e.g. migrations) would bypass a camelCase-only
// list entirely.
const FORBIDDEN_DB_SYMBOLS = [
  "researchChannels",
  "researchEvidence",
  "insertResearchChannel",
  "listResearchChannels",
  "getResearchChannelById",
  "insertResearchEvidence",
  "listResearchEvidenceByChannel",
  "research_channels",
  "research_evidence",
];

test("PHASE9-INV-02: no file outside market-intelligence's own module/routes/UI references its db.ts symbols", async () => {
  // Also scans scripts/, not just src/ -- same same-day widening the read/write gateway
  // inventory tests already applied (found by independent review, 2026-09-26): a one-off script
  // is just as capable of a violation as production source.
  const files = [...(await listTsFilesRecursively(SRC_ROOT)), ...(await listTsFilesRecursively(SCRIPTS_ROOT))];
  const offenders: string[] = [];

  for (const file of files) {
    if (ALLOWED_IMPORTER_DIRS.some((dir) => isInsideDir(file, dir))) continue;
    if (ALLOWED_IMPORTER_FILES.some((allowed) => path.resolve(file) === path.resolve(allowed))) continue;
    if (path.resolve(file) === path.resolve(SRC_ROOT, "lib", "db.ts")) continue;
    const content = await readFile(file, "utf8");
    for (const symbol of FORBIDDEN_DB_SYMBOLS) {
      // Word-boundary match -- avoids false positives from an unrelated identifier merely
      // containing one of these names as a substring.
      if (new RegExp(`\\b${symbol}\\b`).test(content)) {
        offenders.push(`${file}: references forbidden symbol "${symbol}"`);
      }
    }
  }

  assert.deepEqual(offenders, [], `Found forbidden research_* references outside market-intelligence:\n${offenders.join("\n")}`);
});

test("PHASE9-INV-02 helper: isInsideDir rejects a same-prefix sibling directory (the actual bug this fixes)", () => {
  const dir = path.join(SRC_ROOT, "lib", "market-intelligence");
  assert.equal(isInsideDir(path.join(SRC_ROOT, "lib", "market-intelligence", "services.ts"), dir), true);
  assert.equal(isInsideDir(path.join(SRC_ROOT, "lib", "market-intelligence-v2", "x.ts"), dir), false);
  assert.equal(isInsideDir(path.join(SRC_ROOT, "lib", "market-intelligenceother.ts"), dir), false);
});
