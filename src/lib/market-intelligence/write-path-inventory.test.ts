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

// Everything outside this module's own tree must reach `research_channels`/`research_evidence`
// only through this module's own exported core (`createMarketIntelligenceCore`) -- never a raw
// db.ts import of the research_* helpers, and never a second, competing read of those tables from
// an unrelated domain module (AGENTS.md §M: this module must be independently removable without
// breaking anything that doesn't actually depend on it). This includes this module's own API
// routes and the Web UI panel -- they call into `@/lib/market-intelligence`'s exported core, never
// into `@/lib/db`'s research_* symbols directly, so neither is exempted below.
//
// Found by independent review (2026-09-26): `startsWith` on a raw path prefix is a real bypass --
// "src/lib/market-intelligence-v2/x.ts".startsWith(".../market-intelligence") is true with no
// path-separator boundary. Fixed with the same `isInsideDir` (path.relative-based) helper
// `youtube-read-gateway/read-gateway-inventory.test.ts` already uses for exactly this reason.
function isInsideDir(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Found by independent review, round 2 (2026-09-26): an earlier version of this allowlist also
// exempted this module's own API-route directory and the UI panel file, on the theory that they
// "legitimately need to call into it" -- but calling in means importing
// `@/lib/market-intelligence`'s exported core, never reaching into `@/lib/db`'s research_*
// symbols directly, which neither the routes nor the panel actually do today (confirmed by grep).
// Exempting that directory anyway was a live loophole for tomorrow with no present-day need --
// removed. Only this module's own tree needs these symbols (via its own adapter).
const ALLOWED_IMPORTER_DIRS = [path.join(SRC_ROOT, "lib", "market-intelligence")];

// Derived from db.ts's own exports (rather than a hand-maintained literal list) so a future
// research_*-named export can never be silently forgotten here the way `deleteResearchChannel`
// was in the first version of this fix (found by independent review, round 2, 2026-09-26: this
// exact function, added in the same commit that introduced this derivation's predecessor, was
// never added to the old hardcoded list -- a probe file importing it directly from `@/lib/db`
// passed PHASE9-INV-02 undetected). Plus the two underlying snake_case SQL table names, which
// cannot be derived the same way (they are string literals inside `sqliteTable(...)` calls, not
// exported identifiers) -- a raw `sql\`... research_channels ...\`` escape hatch (already used
// elsewhere in this codebase, e.g. migrations) would bypass a camelCase-only list entirely.
async function deriveForbiddenDbSymbols(): Promise<string[]> {
  const dbTsContent = await readFile(path.join(SRC_ROOT, "lib", "db.ts"), "utf8");
  const pattern = /\bexport\s+(?:async function|function|const)\s+(\w*[Rr]esearch(?:Channel|Evidence)\w*)\b/g;
  const derived = new Set<string>();
  for (const match of dbTsContent.matchAll(pattern)) derived.add(match[1]);
  return [...derived, "research_channels", "research_evidence"];
}

test("PHASE9-INV-02: no file outside market-intelligence's own module references its db.ts symbols", async () => {
  const forbiddenDbSymbols = await deriveForbiddenDbSymbols();
  // Sanity check on the derivation itself -- if this ever comes back empty or missing a symbol
  // this test itself already knows about, the derivation regex broke, not the invariant.
  assert.ok(forbiddenDbSymbols.includes("deleteResearchChannel"), "derivation must find deleteResearchChannel");
  assert.ok(forbiddenDbSymbols.includes("researchChannels"), "derivation must find the researchChannels table export");
  assert.ok(forbiddenDbSymbols.length >= 8, "derivation returned suspiciously few symbols -- regex likely broke");

  // Also scans scripts/, not just src/ -- same same-day widening the read/write gateway
  // inventory tests already applied (found by independent review, 2026-09-26): a one-off script
  // is just as capable of a violation as production source.
  const files = [...(await listTsFilesRecursively(SRC_ROOT)), ...(await listTsFilesRecursively(SCRIPTS_ROOT))];
  const offenders: string[] = [];

  for (const file of files) {
    if (ALLOWED_IMPORTER_DIRS.some((dir) => isInsideDir(file, dir))) continue;
    if (path.resolve(file) === path.resolve(SRC_ROOT, "lib", "db.ts")) continue;
    const content = await readFile(file, "utf8");
    for (const symbol of forbiddenDbSymbols) {
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
