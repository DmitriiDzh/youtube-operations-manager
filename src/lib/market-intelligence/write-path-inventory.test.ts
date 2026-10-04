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

// Narrow, single-file exception (found necessary while fixing RISK-52, 2026-09-27): the device-
// handoff snapshot mechanism (`src/lib/snapshot/contracts.ts`'s `SNAPSHOT_TRANSFERRED_TABLES`) is
// cross-cutting infrastructure that must know the raw SQL table name of every table it transfers,
// across every domain -- it already lists `batches`/`audit_events`/etc. from other domains the same
// way. This is categorically different from what PHASE9-INV-02 exists to prevent (another domain
// reaching into market-intelligence's internals to read/write its data live, which would break if
// market-intelligence were removed) -- if market-intelligence were removed, this list's own market-
// intelligence entries would need deleting too, a visible, understood coordination point, not a
// hidden coupling. Scoped to ONLY the raw snake_case table-name strings, never the camelCase
// TypeScript symbols above -- this file must still fail if it ever imports actual business logic.
// Phase 13 slice 13.1/13.2: the YouTube API data-policy classification must name every table (its
// own completeness test enforces that), and its purge test seeds those tables -- same narrow,
// snake_case-only exemption as the snapshot allowlist.
const SNAKE_CASE_TABLE_NAME_EXEMPT_FILES = [
  path.join(SRC_ROOT, "lib", "snapshot", "contracts.ts"),
  path.join(SRC_ROOT, "lib", "youtube-data-policy", "contracts.ts"),
  path.join(SRC_ROOT, "lib", "youtube-data-policy", "services.test.ts"),
  // Phase 13 slice 13.8: the Wikipedia-signals test seeds a topic row by raw SQL (its links' FK target).
  path.join(SRC_ROOT, "lib", "wikipedia-signals", "services.test.ts"),
];

function isSnakeCaseTableName(symbol: string): boolean {
  return /^[a-z]+(?:_[a-z]+)+$/.test(symbol);
}

function isExemptReference(file: string, symbol: string): boolean {
  const isExemptFile = SNAKE_CASE_TABLE_NAME_EXEMPT_FILES.some((exempt) => path.resolve(file) === path.resolve(exempt));
  return isExemptFile && isSnakeCaseTableName(symbol);
}

// Derived from db.ts's own exports (rather than a hand-maintained literal list) so a future
// research_*-named export can never be silently forgotten here the way `deleteResearchChannel`
// was in the first version of this fix (found by independent review, round 2, 2026-09-26: this
// exact function, added in the same commit that introduced this derivation's predecessor, was
// never added to the old hardcoded list -- a probe file importing it directly from `@/lib/db`
// passed PHASE9-INV-02 undetected). Plus the underlying snake_case SQL table names, which cannot
// be derived the same way (they are string literals inside `sqliteTable(...)` calls, not exported
// identifiers) -- a raw `sql\`... research_channels ...\`` escape hatch (already used elsewhere in
// this codebase, e.g. migrations) would bypass a camelCase-only list entirely.
//
// Widened for Phase 9 slice 9A (found by independent review, 2026-09-26): the pattern originally
// only matched `Research(Channel|Evidence)`-shaped names, so none of slice 9A's own
// `Market(Channel|Video)Snapshot`-shaped exports (or their two raw table names) were ever added to
// this list -- a probe file importing `insertMarketChannelSnapshot`/`marketChannelSnapshots`
// directly from `@/lib/db` passed this test undetected, exactly the class of gap this test's own
// dynamic derivation exists to prevent.
//
// Generalized further by independent review, round 2, 2026-09-26: hand-widening the pattern by
// exact shape (`Research(Channel|Evidence)`, then also `Market(Channel|Video)Snapshot`) only defers
// the identical gap to the NEXT new table this module ever adds (e.g. slice 9B's own
// `market_intelligence_collection_runs`) -- every future table would need its own manual regex
// addition, the same class of oversight this derivation exists to prevent in the first place.
// Replaced with a plain substring match on "research" or "market" (case-insensitive) -- verified by
// direct inspection that every one of this module's own db.ts exports contains one of these two
// words, and that no OTHER export anywhere else in db.ts does (so this widening adds no false
// positives) -- any future market-intelligence table/export automatically stays covered without
// this file ever needing to change again for that reason.
async function deriveForbiddenDbSymbols(): Promise<string[]> {
  const dbTsContent = await readFile(path.join(SRC_ROOT, "lib", "db.ts"), "utf8");
  const pattern = /\bexport\s+(?:async function|function|const)\s+(\w*(?:[Rr]esearch|[Mm]arket)\w*)\b/g;
  const derived = new Set<string>();
  for (const match of dbTsContent.matchAll(pattern)) derived.add(match[1]);
  return [
    ...derived,
    "research_channels",
    "research_evidence",
    "market_channel_snapshots",
    "market_video_snapshots",
    "market_intelligence_collection_runs",
    // Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md).
    "market_discovery_candidates",
    "market_discovery_runs",
    // Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md).
    "market_topics",
    "market_topic_assignments",
    "market_trend_candidates",
    "market_trend_evidence",
    // Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md).
    "market_research_requests",
    "market_collection_requests",
    // Found by independent review during 9H part A planning (2026-09-27): these four `db.ts`
    // exports operate on market-intelligence tables (`marketTopicAssignments`/`marketTrendEvidence`)
    // but their own function names contain neither "research" nor "market", so the derivation
    // above never finds them -- confirmed by a probe file importing all four directly from
    // `@/lib/db`, which passed this test undetected before this list was widened.
    "listTrendEvidence",
    "listTopicsForSubject",
    "listAssignmentsForTopic",
    "getTopicAssignment",
  ];
}

test("PHASE9-INV-02: no file outside market-intelligence's own module references its db.ts symbols", async () => {
  const forbiddenDbSymbols = await deriveForbiddenDbSymbols();
  // Sanity check on the derivation itself -- if this ever comes back empty or missing a symbol
  // this test itself already knows about, the derivation regex broke, not the invariant.
  assert.ok(forbiddenDbSymbols.includes("deleteResearchChannel"), "derivation must find deleteResearchChannel");
  assert.ok(forbiddenDbSymbols.includes("researchChannels"), "derivation must find the researchChannels table export");
  assert.ok(
    forbiddenDbSymbols.includes("insertMarketChannelSnapshot"),
    "derivation must find slice 9A's insertMarketChannelSnapshot (independent review, 2026-09-26 -- the original pattern missed every Market*Snapshot export entirely)"
  );
  assert.ok(forbiddenDbSymbols.includes("marketChannelSnapshots"), "derivation must find the marketChannelSnapshots table export");
  assert.ok(
    forbiddenDbSymbols.includes("market_intelligence_collection_runs"),
    "the raw table name (found missing by independent review, 2026-09-27 -- present in every camelCase-derived symbol's sibling list except this literal one) must be in the explicit literal list, since it cannot be derived by the export-name regex"
  );
  assert.ok(forbiddenDbSymbols.length >= 16, "derivation returned suspiciously few symbols -- regex likely broke");

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
      if (isExemptReference(file, symbol)) continue;
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

test("PHASE9-INV-02 helper: isExemptReference (RISK-52's snapshot-contracts exception) stays narrow -- only the exact exempt file, and only for snake_case table names, never a camelCase TS symbol", () => {
  const snapshotContracts = path.join(SRC_ROOT, "lib", "snapshot", "contracts.ts");
  assert.equal(isExemptReference(snapshotContracts, "research_channels"), true);
  assert.equal(isExemptReference(snapshotContracts, "market_research_requests"), true);
  // A camelCase TS symbol must still be caught even in the one exempt file -- this exemption is
  // only for the raw SQL table-name strings the snapshot mechanism genuinely needs, never for an
  // actual business-logic import, which would be a real violation of this module's isolation.
  assert.equal(isExemptReference(snapshotContracts, "deleteResearchChannel"), false);
  // A different file referencing the same snake_case table name is NOT exempt -- this is a
  // single-file exception, not a blanket rule for every snake_case-looking string.
  assert.equal(isExemptReference(path.join(SRC_ROOT, "lib", "some-other-module", "index.ts"), "research_channels"), false);
});
