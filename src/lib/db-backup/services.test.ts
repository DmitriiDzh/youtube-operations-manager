import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { copyDatabaseConsistently, isMissingTableError } from "./services";
import { DatabaseBackupError } from "./contracts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-backup-test-"));
  try {
    await fn(dir);
  } finally {
    // Windows can briefly hold a file lock after a libSQL client.close() returns (native
    // binding handle release is not perfectly synchronous) -- retry cleanup rather than
    // fail the test on an unrelated EBUSY.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

test("copyDatabaseConsistently produces a readable, consistent copy via VACUUM INTO", () =>
  withTempDir(async (dir) => {
    const srcPath = path.join(dir, "source.db");
    const client = createClient({ url: `file:${srcPath}` });
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    await client.execute({ sql: "INSERT INTO t (value) VALUES (?)", args: ["hello"] });

    const destPath = path.join(dir, "copy.db");
    const result = await copyDatabaseConsistently(client, destPath);
    assert.equal(result.path, destPath);

    const copyClient = createClient({ url: `file:${destPath}` });
    const rows = await copyClient.execute("SELECT value FROM t");
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].value, "hello");

    copyClient.close();
    client.close();
  }));

test("copyDatabaseConsistently refuses to overwrite an existing destination file", () =>
  withTempDir(async (dir) => {
    const srcPath = path.join(dir, "source.db");
    const client = createClient({ url: `file:${srcPath}` });
    await client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");

    const destPath = path.join(dir, "copy.db");
    await copyDatabaseConsistently(client, destPath);

    await assert.rejects(
      () => copyDatabaseConsistently(client, destPath),
      (error: unknown) => error instanceof DatabaseBackupError && error.code === "backup_destination_exists"
    );

    client.close();
  }));

// isMissingTableError: single shared implementation (RISK-19/21, docs/TECHNICAL_DEBT.md),
// previously duplicated verbatim in operation-lock/services.ts and snapshot/adapters/
// lineage-store.ts.
test("isMissingTableError matches a real 'no such table' error", () => {
  assert.equal(isMissingTableError(new Error("SQLITE_ERROR: no such table: app_operation_locks")), true);
});

test("isMissingTableError rejects an unrelated error", () => {
  assert.equal(isMissingTableError(new Error("CLIENT_CLOSED: The client is closed")), false);
});
