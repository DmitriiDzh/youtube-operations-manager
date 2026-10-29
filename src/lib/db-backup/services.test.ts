import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createLibsqlClient } from "@/lib/libsql-client";
import { copyDatabaseConsistently, createMigrationBackups, isMissingTableError, MIGRATION_BACKUPS_KEEP, MIGRATION_SUCCESS_MARKER, pruneMigrationBackups, readMigrationBackupState, RETAINED_BACKUP_PREFIXES } from "./services";
import { initializeDatabaseSchema } from "@/lib/db";
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

// Independent review (BL-237 blocker, two rounds): migrations are not transactional, and a failing one is retried -- every
// attempt takes a new pre-migration copy. Requirement: the copy taken before an upgrade (its FIRST copy, C1) survives until
// that upgrade succeeds, whatever prunes run meanwhile, with or without an earlier record, and whatever the clock says; after
// the success the normal retention applies. Every successful start writes the record, so a missing or stale one heals.

/** A boot with the same order db.ts uses: takeCopy inside the migration, succeeded() only after it went through. */
function bootSession(dir: string, clock: { t: number }, copies: string[]) {
  let n = 0;
  return createMigrationBackups({
    dir,
    copy: async (destPath) => {
      await writeFile(destPath, "copy");
      copies.push(path.basename(destPath));
    },
    now: () => clock.t,
    suffix: () => `s${String(n++).padStart(4, "0")}`,
  });
}

async function boot(dir: string, clock: { t: number }, copies: string[], migrate: (takeCopy: () => Promise<string>) => Promise<void>) {
  const session = bootSession(dir, clock, copies);
  await migrate(() => session.takeCopy());
  await session.succeeded();
}

const failing = async (takeCopy: () => Promise<string>) => {
  await takeCopy();
  throw new Error("migration 116 failed");
};
const passing = async (takeCopy: () => Promise<string>) => {
  await takeCopy();
};

async function preMigration(dir: string) {
  return (await readdir(dir)).filter((n) => n.startsWith("pre-migration-")).sort();
}

test("no record at all (first start on this build), 12 failed attempts with prunes in between, then success: C1 survives", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    await seed(dir, Array.from({ length: 15 }, (_, i) => `pre-migration-${100 + i}-old000.db`)); // older upgrades' copies
    const clock = { t: 1000 };
    const copies: string[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      clock.t += 3000;
      await assert.rejects(() => boot(dir, clock, copies, failing));
      await pruneMigrationBackups(dir, { prefixes: ["pre-migration"] }); // e.g. an automatic import meanwhile
      assert.ok((await preMigration(dir)).includes(copies[0]), `C1 after attempt ${attempt + 1}`);
    }
    clock.t += 3000;
    await boot(dir, clock, copies, passing);
    const left = await preMigration(dir);
    assert.ok(left.includes(copies[0]), "C1 survives the success's own prune");
    assert.ok(left.includes(copies[12]), "the copy of the successful start survives");
    assert.equal(left.length, 11, "newest 10 + C1");
    const state = await readMigrationBackupState(dir);
    assert.deepEqual(state, { pendingUpgradeCopy: null, lastSuccessAt: clock.t, lastProtectedCopy: copies[0] });
    // After the success, ordinary retention: the next prune keeps just the newest 10.
    assert.deepEqual(await pruneMigrationBackups(dir, { prefixes: ["pre-migration"] }), [copies[0]]);
  }));

test("a stale record from an earlier upgrade, then a new upgrade failing 12 times: the NEW C1 survives", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    const clock = { t: 1000 };
    const copies: string[] = [];
    await boot(dir, clock, copies, passing); // the earlier upgrade, recorded
    const earlierC1 = copies[0];
    for (let i = 0; i < 12; i++) {
      clock.t += 3000;
      await assert.rejects(() => boot(dir, clock, copies, failing));
      await pruneMigrationBackups(dir, { prefixes: ["pre-migration"] });
    }
    const newC1 = copies[1];
    assert.ok((await preMigration(dir)).includes(newC1));
    assert.equal((await readMigrationBackupState(dir)).pendingUpgradeCopy, newC1);
    assert.ok(!(await preMigration(dir)).includes(earlierC1), "the earlier upgrade's copy follows ordinary retention");
  }));

test("the upgrade's first copy is kept by NAME: a clock set back after the last success does not lose it", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    const clock = { t: 900_000 };
    const copies: string[] = [];
    await boot(dir, clock, copies, passing); // the last success, recorded with a clock that was ahead
    clock.t = 1000; // set back: the new upgrade's copies all carry times BEFORE that success
    for (let i = 0; i < 12; i++) {
      clock.t += 10;
      await assert.rejects(() => boot(dir, clock, copies, failing));
      await pruneMigrationBackups(dir, { prefixes: ["pre-migration"] });
    }
    const newC1 = copies[1];
    assert.ok((await preMigration(dir)).includes(newC1), "kept although its time sorts before the last success");
    clock.t += 10;
    await boot(dir, clock, copies, passing);
    assert.ok((await preMigration(dir)).includes(newC1));
    assert.equal((await readMigrationBackupState(dir)).lastProtectedCopy, newC1);
  }));

test("a crash between recording C1's name and writing it: the next attempt's copy becomes C1", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    const clock = { t: 1000 };
    const crashing = createMigrationBackups({ dir, copy: async () => Promise.reject(new Error("killed")), now: () => clock.t, suffix: () => "dead00" });
    await assert.rejects(() => crashing.takeCopy());
    assert.equal((await readMigrationBackupState(dir)).pendingUpgradeCopy, "pre-migration-1000-dead00.db");
    clock.t = 2000;
    const copies: string[] = [];
    await assert.rejects(() => boot(dir, clock, copies, failing));
    assert.equal((await readMigrationBackupState(dir)).pendingUpgradeCopy, copies[0]);
  }));

test("a start with nothing to migrate prunes nothing, but writes a missing or stale record (it heals)", () =>
  withTempDir("db-backup-retention-", async (dir) => {
    const names = Array.from({ length: 14 }, (_, i) => `pre-migration-${100 + i}-old000.db`);
    await seed(dir, names);
    const clock = { t: 5000 };
    await boot(dir, clock, [], async () => undefined);
    assert.equal((await preMigration(dir)).length, 14, "no migration ran: nothing pruned");
    assert.deepEqual(await readMigrationBackupState(dir), { pendingUpgradeCopy: null, lastSuccessAt: 5000, lastProtectedCopy: null });
    // A stale "upgrade pending" record (a crash after the migrations, before the record) is cleared on the next good start.
    await writeFile(path.join(dir, MIGRATION_SUCCESS_MARKER), JSON.stringify({ pendingUpgradeCopy: names[0], lastSuccessAt: 1, lastProtectedCopy: null }));
    clock.t = 6000;
    await boot(dir, clock, [], async () => undefined);
    assert.deepEqual(await readMigrationBackupState(dir), { pendingUpgradeCopy: null, lastSuccessAt: 6000, lastProtectedCopy: null });
  }));

test("the real schema initialization: a fresh database migrates, the copy is taken inside the hook, the record after it", () =>
  withTempDir("db-backup-boot-", async (root) => {
    const dir = path.join(root, "backups", "migrations");
    const client = createLibsqlClient({ url: `file:${path.join(root, "live.db")}` });
    const session = createMigrationBackups({ dir, copy: async (destPath) => void (await copyDatabaseConsistently(client, destPath)), now: () => 7000, suffix: () => "real00" });
    let stateInsideHook: unknown = "not called";
    await initializeDatabaseSchema(client, {
      beforeMigrations: async () => {
        await session.takeCopy();
        stateInsideHook = await readMigrationBackupState(dir);
      },
    });
    assert.deepEqual(stateInsideHook, { pendingUpgradeCopy: "pre-migration-7000-real00.db", lastSuccessAt: null, lastProtectedCopy: null });
    await session.succeeded();
    assert.deepEqual(await readMigrationBackupState(dir), { pendingUpgradeCopy: null, lastSuccessAt: 7000, lastProtectedCopy: "pre-migration-7000-real00.db" });
    assert.deepEqual(await preMigration(dir), ["pre-migration-7000-real00.db"]);
    client.close();
  }));
