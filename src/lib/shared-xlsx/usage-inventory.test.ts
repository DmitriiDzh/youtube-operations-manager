// ---------------------------------------------------------------------------
// Mechanical enforcement of the owner's instruction (2026-09-26, Telegram): this module's
// status must "always be an auxiliary, supplementary tool... never involved in the standard
// data-storage process" ("его статус всегда должен быть как вспомогательный, дополнительный
// инструмент и он никогда не задействован в стандартном процессе хранения данных"). A doc
// comment saying so is not a guarantee -- this test is, mirroring the pattern already used by
// `youtube-read-gateway/read-gateway-inventory.test.ts` and
// `batches/write-path-inventory.test.ts`.
//
// Any production file that imports this module must be an explicit, deliberately-added
// "format adapter" for one specific screen -- never a core persistence/service path. Today
// that is exactly two files (XLSX export for Localization, XLSX import for Change Sets).
// Adding a new screen's XLSX support later means adding its own adapter file to the
// allowlist below on purpose, not an accidental reach-in from a services.ts.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");

const ALLOWED_IMPORTERS = new Set([
  path.join("src", "lib", "localization", "adapters", "xlsx.ts"),
  path.join("src", "lib", "changesets", "import.ts"),
]);

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

test("shared-xlsx usage inventory: only the allowlisted format-adapter files import this module", async () => {
  const allFiles = await listTsFilesRecursively(path.join(REPO_ROOT, "src"));
  const importPattern = /from\s+["'](?:@\/lib\/shared-xlsx|(?:\.\.\/)+lib\/shared-xlsx|\.\.?\/(?:.*\/)?shared-xlsx)(?:\/index)?["']/;
  const offenders: string[] = [];

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue;
    if (path.dirname(file) === THIS_DIR) continue; // this module's own files

    const relative = path.relative(REPO_ROOT, file);
    if (ALLOWED_IMPORTERS.has(relative)) continue;

    const content = await readFile(file, "utf8");
    if (importPattern.test(content)) {
      offenders.push(relative);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following production files import shared-xlsx without being on the explicit ` +
      `allowlist of format adapters -- this module must stay an optional, auxiliary format ` +
      `concern, never a dependency of a core persistence/service path: ${offenders.join(", ")}`
  );
});

test("shared-xlsx usage inventory: every allowlisted file still exists and still actually imports this module", async () => {
  for (const relative of ALLOWED_IMPORTERS) {
    const absolute = path.join(REPO_ROOT, relative);
    const content = await readFile(absolute, "utf8").catch(() => null);
    assert.ok(content, `Allowlisted importer ${relative} no longer exists -- remove it from the allowlist`);
    assert.match(
      content!,
      /from\s+["']@\/lib\/shared-xlsx["']/,
      `Allowlisted importer ${relative} no longer imports shared-xlsx -- remove it from the allowlist ` +
        `so a future accidental import elsewhere doesn't silently expand the allowed set`
    );
  }
});
