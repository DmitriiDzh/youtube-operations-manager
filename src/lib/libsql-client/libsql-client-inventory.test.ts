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

const CLIENT_PACKAGE = String.raw`["'\`]@libsql\/client(?:\/[^"'\`]*)?["'\`]`;
// Every static `import ... from` / `export ... from` of @libsql/client, with its clause captured.
const CLIENT_STATIC = new RegExp(String.raw`\b(import|export)\s+([^;"'\`]*?)\s*from\s*${CLIENT_PACKAGE}`, "g");
// Side-effect import, dynamic import and require of @libsql/client, in any quote style.
const CLIENT_OTHER = new RegExp(String.raw`\bimport\s*${CLIENT_PACKAGE}|\b(?:import|require)\s*\(\s*${CLIENT_PACKAGE}`);
// The raw driver, in any import form and quote style.
const RAW_DRIVER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]libsql(?:\/[^"'`]*)?["'`]/;

/** A clause is harmless only when nothing in it exists at runtime: `type { ... }`, or `{ type A, type B }`. */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\b/.test(trimmed)) return true;
  const braces = /^\{([^}]*)\}$/.exec(trimmed);
  if (!braces) return false;
  const specifiers = braces[1].split(",").map((part) => part.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((specifier) => /^type\s/.test(specifier));
}

/** `drizzle("file:...")` / `drizzle({ connection })` make drizzle-orm/libsql open its own client. */
function drizzleOpensItsOwnClient(source: string): boolean {
  for (const match of source.matchAll(/\bdrizzle\s*\(\s*/g)) {
    const rest = source.slice(match.index + match[0].length);
    if (/^["'`]/.test(rest)) return true;
    if (!rest.startsWith("{")) continue;
    let depth = 0;
    let end = rest.length;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (/\bconnection\b/.test(rest.slice(0, end))) return true;
  }
  return false;
}

function opensLibsqlConnectionItself(source: string): boolean {
  for (const match of source.matchAll(CLIENT_STATIC)) {
    if (!isTypeOnlyClause(match[2])) return true;
  }
  return CLIENT_OTHER.test(source) || RAW_DRIVER.test(source) || drizzleOpensItsOwnClient(source);
}

test("no file outside src/lib/libsql-client/ opens a libSQL connection itself", async () => {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of await listSourceFiles(path.join(REPO_ROOT, root))) {
      if (!path.relative(THIS_DIR, file).startsWith("..")) continue;
      if (opensLibsqlConnectionItself(await readFile(file, "utf8"))) offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], "open libSQL connections only through createLibsqlClient (src/lib/libsql-client)");
});

test("the inventory check catches every form it claims to, and allows type-only imports and drizzle(client)", () => {
  const forbidden = [
    'import { createClient } from "@libsql/client";',
    'import { type Client, createClient } from "@libsql/client";',
    'import { createClient } from "@libsql/client/sqlite3";',
    'import { LibsqlError } from "@libsql/client";',
    'import libsql, { type Client } from "@libsql/client";',
    'import * as libsql from "@libsql/client";',
    'import "@libsql/client";',
    'export { createClient } from "@libsql/client";',
    'export * from "@libsql/client";',
    'export * as libsql from "@libsql/client";',
    'await import("@libsql/client");',
    "await import('@libsql/client');",
    "await import(`@libsql/client`);",
    'require("@libsql/client")',
    'import Database from "libsql";',
    'const D = require("libsql");',
    'await import("libsql/promise");',
    "await import(`libsql`);",
    'const db = drizzle("file:local.db");',
    "const db = drizzle(`file:${dbPath}`);",
    'const db = drizzle({ connection: { url: "file:local.db" } });',
    "const db = drizzle({ schema: { users }, connection: url });",
  ];
  for (const line of forbidden) assert.ok(opensLibsqlConnectionItself(line), line);
  const allowed = [
    'import type { Client } from "@libsql/client";',
    'import { type Client, type ResultSet } from "@libsql/client";',
    'export type { Client } from "@libsql/client";',
    "const db = drizzle(client, { schema: dbSchema });",
    "const db = drizzle({ client, schema });",
    'import { drizzle } from "drizzle-orm/libsql";',
  ];
  for (const line of allowed) assert.ok(!opensLibsqlConnectionItself(line), line);
});
