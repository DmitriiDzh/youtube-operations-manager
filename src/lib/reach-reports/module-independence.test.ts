import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AGENTS.md §M: a feature module can be switched off or fail without breaking the others. Reach reports
// (BL-114) and Analytics are separate feature modules, so neither may import the other, and the Reach
// module may not touch the write gateway (a reporting job is not a YouTube write, ADR 0014).
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(THIS_DIR, "..");

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTsFiles(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function filesImporting(dir: string, specifier: RegExp): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await listTsFiles(dir)) {
    if (file.endsWith(".test.ts")) continue;
    const content = await readFile(file, "utf8");
    const importLines = content.split("\n").filter((line) => /\bfrom\s+["']/.test(line) || /\bimport\s*\(/.test(line));
    if (importLines.some((line) => specifier.test(line))) offenders.push(path.relative(LIB_DIR, file));
  }
  return offenders;
}

test("reach-reports does not import analytics, and analytics does not import reach-reports", async () => {
  assert.deepEqual(await filesImporting(path.join(LIB_DIR, "reach-reports"), /["']@\/lib\/analytics(\/|["'])/), []);
  assert.deepEqual(await filesImporting(path.join(LIB_DIR, "analytics"), /["']@\/lib\/reach-reports(\/|["'])/), []);
});

test("reach-reports never imports the YouTube write gateway", async () => {
  assert.deepEqual(await filesImporting(path.join(LIB_DIR, "reach-reports"), /youtube-write-gateway/), []);
});
