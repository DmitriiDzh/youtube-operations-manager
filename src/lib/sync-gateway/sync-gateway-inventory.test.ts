// ---------------------------------------------------------------------------
// Mechanical enforcement of this module's own single-entry-point rule (owner instruction,
// 2026-09-22, Telegram: "Объединяем весь этот функционал в отдельный модуль"), mirroring
// `src/lib/youtube-read-gateway/read-gateway-inventory.test.ts`'s "no direct child import"
// check for the same reason: a future re-shuffling of which child (`change-drafts`,
// `change-drafts-sync`) owns which function should never touch a caller's import path.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");
const SYNC_GATEWAY_DIR = THIS_DIR;

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
    if (entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      files.push(...(await listTsFilesRecursively(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function isInsideDir(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

test("sync-gateway inventory: no production file outside this gateway imports a child module (change-drafts, change-drafts-sync, editorial-profile, editorial-profile-sync, ai-connections-catalog, ai-connections-catalog-sync, automerge-core) directly instead of the barrel", async () => {
  const allFiles = await listTsFilesRecursively(path.join(REPO_ROOT, "src"));
  const offenders: string[] = [];
  const directChildImportPattern = /from\s+["']@\/lib\/sync-gateway\/[a-zA-Z0-9_-]+["']/;

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue;
    if (isInsideDir(file, SYNC_GATEWAY_DIR)) continue;

    const content = await readFile(file, "utf8");
    if (directChildImportPattern.test(content)) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following files import a sync-gateway child module directly instead of the barrel ` +
      `(@/lib/sync-gateway): ${offenders.join(", ")}`
  );
});
