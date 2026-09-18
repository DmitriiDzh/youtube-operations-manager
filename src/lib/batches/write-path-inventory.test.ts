// ---------------------------------------------------------------------------
// AC-SCOPE-01 + the mandatory live-write barrier (docs/acceptance/PHASE_5_ACCEPTANCE.md;
// this task's explicit "audit every write-capable path" requirement, 2026-09-18).
//
// Revised 2026-09-18 (Phase 5 completion task): a Web UI/API workflow for Batches now
// legitimately exists (create/list/inspect/dry-run-prepare/view audit+errors, all
// dry-run-only, DEC-OQ-5) and necessarily imports from `src/lib/batches/` -- so this
// test no longer bans importing the module outright. What it still bans, absolutely,
// is any API route, MCP tool, or CLI command referencing any symbol that can reach a
// real `videos.update` call: `executeBatch`, `executeWithRetry`, `recoverBatch`,
// `resolveUnknownLedgerRow` (all four are the only functions that ever accept or invoke
// a `WriteExecutor`), the `WriteExecutor`/`createYoutubeWriteExecutor`/
// `createScriptedFakeWriteExecutor` symbols themselves, and `performYoutubeWrite`. This
// fails loudly the moment any future change adds such a reference, rather than relying
// on a one-time manual grep that can go stale.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");

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

// Every one of these is either a function that accepts/invokes a `WriteExecutor`
// (`executeBatch`, `executeWithRetry`, `recoverBatch`, `resolveUnknownLedgerRow`), or a
// symbol that IS the real/fake write executor itself. Read-only/dry-run-only symbols
// (`createBatchCore`, `createBatch`, `listBatchesByChannel`, `requireBatchForChannel`,
// `listLedgerRows`, `prepareBatchExecution`, `getBatchErrorReport`, audit readers, etc.)
// are legitimately used by the Web UI/API and are NOT on this list.
const FORBIDDEN_SYMBOLS = [
  "executeBatch",
  "executeWithRetry",
  "recoverBatch",
  "resolveUnknownLedgerRow",
  "WriteExecutor",
  "createYoutubeWriteExecutor",
  "createScriptedFakeWriteExecutor",
  "performYoutubeWrite",
];

test("write-path inventory: no API route, MCP tool, or CLI command references any live-write-capable batches symbol", async () => {
  const surfaces = [
    path.join(REPO_ROOT, "src", "app", "api"),
    path.join(REPO_ROOT, "src", "mcp"),
    path.join(REPO_ROOT, "src", "cli"),
  ];

  const offenders: string[] = [];
  for (const surfaceDir of surfaces) {
    const files = await listTsFilesRecursively(surfaceDir);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const hit = FORBIDDEN_SYMBOLS.find((symbol) => content.includes(symbol));
      if (hit) {
        offenders.push(`${path.relative(REPO_ROOT, file)} (references "${hit}")`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following API/MCP/CLI files reference a live-write-capable batches symbol, which ` +
      `would make the real WriteExecutor reachable from a live interface without a ` +
      `separate, explicitly-authorized activation procedure: ${offenders.join(", ")}`
  );
});

test("write-path inventory: createYoutubeWriteExecutor is constructed nowhere except its own adapter file and its own test", async () => {
  const batchesDir = path.join(REPO_ROOT, "src", "lib", "batches");
  const srcDir = path.join(REPO_ROOT, "src");
  const allFiles = await listAllTsFiles(srcDir);

  const referencingFiles: string[] = [];
  for (const file of allFiles) {
    const content = await readFile(file, "utf8");
    if (content.includes("createYoutubeWriteExecutor")) {
      referencingFiles.push(path.relative(REPO_ROOT, file));
    }
  }

  const allowed = new Set([
    path.relative(REPO_ROOT, path.join(batchesDir, "adapters", "write-executor.youtube.ts")),
    path.relative(REPO_ROOT, path.join(batchesDir, "adapters", "write-executor.youtube.test.ts")),
    path.relative(REPO_ROOT, path.join(batchesDir, "write-path-inventory.test.ts")),
  ]);
  const unexpected = referencingFiles.filter((f) => !allowed.has(f));

  assert.deepEqual(unexpected, [], `Unexpected reference(s) to createYoutubeWriteExecutor outside its own adapter/test: ${unexpected.join(", ")}`);
});

test("write-path inventory: src/lib/batches/index.ts never constructs a WriteExecutor (createBatchCore's returned services object has no wired executor)", async () => {
  const indexPath = path.join(REPO_ROOT, "src", "lib", "batches", "index.ts");
  const content = await readFile(indexPath, "utf8");

  assert.ok(!content.includes("createYoutubeWriteExecutor"), "index.ts must never import/construct the real WriteExecutor");
  assert.ok(!content.includes("createScriptedFakeWriteExecutor"), "index.ts must never wire the fake WriteExecutor into production either");
});

async function listAllTsFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...(await listAllTsFiles(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}
