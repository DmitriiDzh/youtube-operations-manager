// BL-156: `src/lib/libsql-client/` is the only place a libSQL connection may be opened. Opening one
// anywhere else (`@libsql/client`'s `createClient`, or the `libsql` driver directly) brings back the
// leaked-connection SIGSEGV that module exists to prevent -- see its header comment. Type-only
// imports from `@libsql/client` (`Client`, `ResultSet`, ...) stay allowed everywhere.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");
const SCAN_ROOTS = ["src", "scripts"];

async function listSourceFiles(dir: string): Promise<string[]> {
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
    if (entry.isDirectory()) files.push(...(await listSourceFiles(full)));
    else if (entry.isFile() && /\.(ts|tsx|mjs|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

// `createClient` named in a non-type import from @libsql/client (any of its entry points).
const CREATE_CLIENT_IMPORT = /import\s+(?!type\b)\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*["']@libsql\/client(?:\/[^"']*)?["']/;
// The raw driver, in any import form.
const RAW_DRIVER_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']libsql(?:\/[^"']*)?["']/;
// Namespace / default / dynamic / require forms of @libsql/client that could reach createClient.
const INDIRECT_CLIENT_IMPORT =
  /import\s+\*\s+as\s+\w+\s+from\s*["']@libsql\/client|import\s+\w+\s*(?:,|from)\s*["']@libsql\/client|import\s*\(\s*["']@libsql\/client|require\s*\(\s*["']@libsql\/client/;

test("no file outside src/lib/libsql-client/ opens a libSQL connection itself", async () => {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of await listSourceFiles(path.join(REPO_ROOT, root))) {
      if (!path.relative(THIS_DIR, file).startsWith("..")) continue;
      const source = await readFile(file, "utf8");
      if (CREATE_CLIENT_IMPORT.test(source) || RAW_DRIVER_IMPORT.test(source) || INDIRECT_CLIENT_IMPORT.test(source)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
  }
  assert.deepEqual(offenders, [], "open libSQL connections only through createLibsqlClient (src/lib/libsql-client)");
});

test("the inventory patterns catch every import form they claim to, and allow type-only imports", () => {
  for (const line of [
    'import { createClient } from "@libsql/client";',
    'import { type Client, createClient } from "@libsql/client";',
    'import { createClient } from "@libsql/client/sqlite3";',
  ]) {
    assert.ok(CREATE_CLIENT_IMPORT.test(line), line);
  }
  for (const line of ['import Database from "libsql";', 'const D = require("libsql");', 'await import("libsql/promise");']) {
    assert.ok(RAW_DRIVER_IMPORT.test(line), line);
  }
  for (const line of ['import * as libsql from "@libsql/client";', 'await import("@libsql/client");', 'require("@libsql/client")']) {
    assert.ok(INDIRECT_CLIENT_IMPORT.test(line), line);
  }
  for (const line of ['import type { Client } from "@libsql/client";', 'import { type Client, type ResultSet } from "@libsql/client";']) {
    assert.ok(!CREATE_CLIENT_IMPORT.test(line) && !RAW_DRIVER_IMPORT.test(line) && !INDIRECT_CLIENT_IMPORT.test(line), line);
  }
});
