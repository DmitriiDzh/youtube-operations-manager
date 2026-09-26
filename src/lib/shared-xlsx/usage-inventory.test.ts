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
//
// Known, accepted limitation (same class already present in every regex-based inventory test
// in this repository -- not unique to this one): a determined obfuscation (e.g. building the
// module specifier from string concatenation, or a runtime `eval`) is not caught. What IS
// caught, deliberately widened past a bare `import ... from` after an independent review found
// the narrower form had real gaps: a static `from "..."` import, a side-effect-only
// `import "..."` (no `from`), a dynamic `import(...)`, and a CommonJS `require(...)` -- each in
// either double- or single-quoted form, with or without whitespace after the keyword.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");
const SCAN_ROOTS = ["src", "scripts"];

const ALLOWED_IMPORTERS = new Set([
  path.join("src", "lib", "localization", "adapters", "xlsx.ts"),
  path.join("src", "lib", "changesets", "import.ts"),
]);

// Matches the module specifier in any of: @/lib/shared-xlsx, a relative path ending in
// .../lib/shared-xlsx, or a relative path ending in .../shared-xlsx, optionally with a
// trailing /index -- as the argument to `from`, a bare `import`, `import(`, or `require(`.
const MODULE_SPECIFIER = String.raw`(?:@/lib/shared-xlsx|(?:\.\./)+lib/shared-xlsx|\.\.?/(?:.*/)?shared-xlsx)(?:/index)?`;
const IMPORT_PATTERNS = [
  new RegExp(String.raw`from\s*["']${MODULE_SPECIFIER}["']`),
  new RegExp(String.raw`^\s*import\s*["']${MODULE_SPECIFIER}["']`, "m"),
  new RegExp(String.raw`import\s*\(\s*["']${MODULE_SPECIFIER}["']\s*\)`),
  new RegExp(String.raw`require\s*\(\s*["']${MODULE_SPECIFIER}["']\s*\)`),
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
  const allFiles = (
    await Promise.all(SCAN_ROOTS.map((root) => listTsFilesRecursively(path.join(REPO_ROOT, root))))
  ).flat();
  const offenders: string[] = [];

  for (const file of allFiles) {
    if (file.endsWith(".test.ts")) continue;
    if (path.dirname(file) === THIS_DIR) continue; // this module's own files

    const relative = path.relative(REPO_ROOT, file);
    if (ALLOWED_IMPORTERS.has(relative)) continue;

    const content = await readFile(file, "utf8");
    if (IMPORT_PATTERNS.some((pattern) => pattern.test(content))) {
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

// Independent review finding (2026-09-26): a narrower `from "..."`-only pattern would miss a
// dynamic import(), a side-effect-only import, or a CommonJS require() -- each verified caught
// here so the widened IMPORT_PATTERNS above is proven, not merely asserted.
test("shared-xlsx usage inventory: the widened import patterns actually catch import(), require(), and side-effect imports, and don't false-positive on unrelated text", () => {
  const shouldMatch = [
    `import { buildWorkbook } from "@/lib/shared-xlsx";`,
    `import { buildWorkbook } from '@/lib/shared-xlsx';`,
    `import "@/lib/shared-xlsx";`,
    `const mod = await import("@/lib/shared-xlsx");`,
    `const mod = require("@/lib/shared-xlsx");`,
    `import { cellText } from "../../shared-xlsx";`,
    `import { cellText } from "../../shared-xlsx/index";`,
  ];
  const shouldNotMatch = [
    `import { something } from "@/lib/shared-crypto";`,
    `// mentions shared-xlsx only in a comment, not an import`,
    `const label = "shared-xlsx";`,
  ];

  for (const sample of shouldMatch) {
    assert.ok(
      IMPORT_PATTERNS.some((pattern) => pattern.test(sample)),
      `Expected this to be detected as a shared-xlsx import: ${sample}`
    );
  }
  for (const sample of shouldNotMatch) {
    assert.ok(
      !IMPORT_PATTERNS.some((pattern) => pattern.test(sample)),
      `Expected this NOT to be detected as a shared-xlsx import: ${sample}`
    );
  }
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
