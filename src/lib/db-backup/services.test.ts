import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createLibsqlClient } from "@/lib/libsql-client";
import { copyDatabaseConsistently, isMissingTableError, MIGRATION_BACKUPS_KEEP, pruneMigrationBackups, RETAINED_BACKUP_PREFIXES } from "./services";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { DatabaseBackupError } from "./contracts";
import { withTempDir } from "@/test-support/temp-dir";

test("copyDatabaseConsistently produces a readable, consistent copy via VACUUM INTO", () =>
  withTempDir("db-backup-test-", async (dir) => {
    const srcPath = path.join(dir, "source.db");
    const client = createLibsqlClient({ url: `file:${srcPath}` });
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    await client.execute({ sql: "INSERT INTO t (value) VALUES (?)", args: ["hello"] });

    const destPath = path.join(dir, "copy.db");
    const result = await copyDatabaseConsistently(client, destPath);
    assert.equal(result.path, destPath);

    const copyClient = createLibsqlClient({ url: `file:${destPath}` });
    const rows = await copyClient.execute("SELECT value FROM t");
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].value, "hello");

    copyClient.close();
    client.close();
  }));

test("copyDatabaseConsistently refuses to overwrite an existing destination file", () =>
  withTempDir("db-backup-test-", async (dir) => {
    const srcPath = path.join(dir, "source.db");
    const client = createLibsqlClient({ url: `file:${srcPath}` });
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

// BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866): backups/migrations keeps the newest 10 automatic backups (pre-migration
// and pre-auto-import, each counted on its own -- see MIGRATION_BACKUPS_KEEP), deletes the older ones after a new backup
// was written, never the one just written, and never anything else (manual/, per-channel, other kinds of backup).

async function seed(dir: string, names: string[]) {
  for (const name of names) await writeFile(path.join(dir, name), "x");
}

test("the retention count is 10 of each automatic kind", () => {
  assert.equal(MIGRATION_BACKUPS_KEEP, 10);
  assert.deepEqual([...RETAINED_BACKUP_PREFIXES], ["pre-migration", "pre-auto-import"]);
});

test("the newest 10 pre-migration and the newest 10 pre-auto-import stay; the older ones are deleted", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    const migrations = Array.from({ length: 13 }, (_, i) => `pre-migration-${1_790_000_000_000 + i}-ab${i}cd.db`);
    const imports = Array.from({ length: 11 }, (_, i) => `pre-auto-import-${1_791_000_000_000 + i}-0f0f0f0${i % 10}.db`);
    await seed(dir, [...migrations, ...imports]);
    const removed = await pruneMigrationBackups(dir);
    assert.deepEqual(removed.sort(), [migrations[0], migrations[1], migrations[2], imports[0]].sort());
    const left = await readdir(dir);
    assert.equal(left.filter((n) => n.startsWith("pre-migration-")).length, 10);
    assert.equal(left.filter((n) => n.startsWith("pre-auto-import-")).length, 10);
  }));

test("newest is by the timestamp in the name, not by the order of the names as text", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    // 999 sorts after 1000 as text, but is older.
    const names = ["pre-migration-999-aaaaaa.db", ...Array.from({ length: 10 }, (_, i) => `pre-migration-${1000 + i}-aaaaaa.db`)];
    await seed(dir, names);
    assert.deepEqual(await pruneMigrationBackups(dir), ["pre-migration-999-aaaaaa.db"]);
  }));

test("the backup just written is never deleted, even when its name sorts as the oldest", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    const newer = Array.from({ length: 10 }, (_, i) => `pre-migration-${2000 + i}-bbbbbb.db`);
    await seed(dir, [...newer, "pre-migration-5-cccccc.db"]);
    const removed = await pruneMigrationBackups(dir, { protect: [path.join(dir, "pre-migration-5-cccccc.db")] });
    assert.deepEqual(removed, []);
    assert.equal((await readdir(dir)).length, 11);
  }));

test("10 or fewer of a kind: nothing is deleted", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    await seed(dir, Array.from({ length: 10 }, (_, i) => `pre-migration-${3000 + i}-dddddd.db`));
    assert.deepEqual(await pruneMigrationBackups(dir), []);
    assert.equal((await readdir(dir)).length, 10);
  }));

test("other backups, malformed names and sub-folders are never touched", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    const others = [
      "pre-take-theirs-1-abcdef01.db",
      "pre-superseded-1-abcdef01.db",
      "pre-import-1-abcdef01.db",
      "pre-api-retention-1-7064330e.db",
      "pre-migration-latest.db",
      "pre-migration-1-aaaaaa.db.bak",
      "notes.txt",
    ];
    await seed(dir, [...others, ...Array.from({ length: 12 }, (_, i) => `pre-migration-${4000 + i}-eeeeee.db`)]);
    await mkdir(path.join(dir, "manual"));
    await seed(path.join(dir, "manual"), ["pre-migration-1-ffffff.db"]);
    const removed = await pruneMigrationBackups(dir);
    assert.deepEqual(removed.sort(), ["pre-migration-4000-eeeeee.db", "pre-migration-4001-eeeeee.db"]);
    const left = await readdir(dir);
    for (const name of [...others, "manual"]) assert.ok(left.includes(name), name);
    assert.deepEqual(await readdir(path.join(dir, "manual")), ["pre-migration-1-ffffff.db"]);
  }));

test("a missing folder prunes nothing and does not throw", async () => {
  assert.deepEqual(await pruneMigrationBackups(path.join("/nonexistent-ytm", "backups", "migrations")), []);
});
