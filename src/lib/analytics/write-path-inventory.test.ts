// ---------------------------------------------------------------------------
// docs/roadmap/plans/PHASE_8_PLAN.md §7: "A metrics-collection test proves the adapter never
// writes to videos/channels." Mirrors src/lib/ai-localization/write-path-inventory.test.ts's
// pattern -- an automated inventory check, not a one-time manual grep, so a future change that
// introduces a real videos/channels write, or a direct mutating YouTube API call, inside
// src/lib/analytics/** fails the build immediately.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = THIS_DIR;

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
      files.push(...(await listTsFilesRecursively(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Strips comments before scanning, mirroring `src/lib/ai-localization/write-path-inventory.test.ts`'s
 * `stripComments` -- a doc comment merely *naming* a forbidden symbol to explain why it must never
 * be called (as this module's own adapters/store.ts does) must never itself trip this check; only
 * an actual reference in real code counts.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// This module's only legitimate write target is video_metrics_daily, via upsertVideoMetric. It
// must never reach for any videos/channels-mutating db.ts function, nor any YouTube-write-gateway
// symbol (there is nothing on the read-only Analytics API surface for the gateway to own, so a
// reference to one here would only ever mean this module started calling the wrong API).
const FORBIDDEN_SYMBOLS = [
  "upsertVideos",
  "upsertChannel",
  "markChannelSynced",
  "deleteStoredChangeSet",
  "deleteStoredChange",
  "applyVideoMetadataUpdate",
  "applyVideoDetailsUpdate",
  "createPlaylistForAuthenticated",
  "updatePlaylistForAuthenticated",
  "addVideoToPlaylistForAuthenticated",
  "deletePlaylistItemById",
  "deletePlaylistForAuthenticated",
  "assertLiveWritesAuthorized",
];

test("analytics write-path-inventory: no file in src/lib/analytics references a videos/channels write or a YouTube write-gateway symbol", async () => {
  const files = await listTsFilesRecursively(MODULE_ROOT);
  const offenders: string[] = [];

  for (const file of files) {
    const content = stripComments(await readFile(file, "utf8"));
    for (const symbol of FORBIDDEN_SYMBOLS) {
      if (content.includes(symbol)) {
        offenders.push(`${file}: references forbidden symbol "${symbol}"`);
      }
    }
  }

  assert.deepEqual(offenders, [], `Found forbidden write references:\n${offenders.join("\n")}`);
});

// A "write" import from db.ts is anything not obviously read-only by name (get*/list*). This is
// deliberately a denylist-by-shape check, not an allowlist of two exact names, so a future
// legitimate read (e.g. a third get*/list* helper) never needs this test edited to pass, while
// any new write import DOES need a human to update ALLOWED_DB_WRITE_IMPORTS with a reason --
// mirroring gateway-inventory.test.ts's own "curated by inspection" allowlist discipline.
const ALLOWED_DB_WRITE_IMPORTS = new Set([
  "upsertVideoMetric", // this module's own metric rows
  "markAnalyticsAutoCollected", // this module's own single channels column (BL-054)
]);

test("analytics write-path-inventory: adapters/store.ts imports no db.ts write function beyond its own two", async () => {
  const content = await readFile(path.join(MODULE_ROOT, "adapters", "store.ts"), "utf8");
  const importMatch = content.match(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/db["']/);
  assert.ok(importMatch, "expected an import from @/lib/db");

  const importedNames = importMatch![1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const looksLikeWrite = (name: string) => !/^(get|list)[A-Z]/.test(name);
  const offenders = importedNames.filter((name) => looksLikeWrite(name) && !ALLOWED_DB_WRITE_IMPORTS.has(name));

  assert.deepEqual(offenders, [], `Unexpected write-shaped db.ts import(s): ${offenders.join(", ")}`);
});
