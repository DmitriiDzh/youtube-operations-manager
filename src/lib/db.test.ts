import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  channels,
  copyLegacyDatabaseInto,
  createIsolatedDb,
  initializeDatabaseSchema,
  listVideoMetricsByVideo,
  SCHEMA_BASELINE_VERSION,
  SCHEMA_CURRENT_VERSION,
  SCHEMA_MIGRATIONS,
  type AppDb,
  upsertVideoMetric,
  videos,
} from "./db";
import { readSchemaVersion } from "@/lib/schema-versioning";
import { SchemaVersionError } from "@/lib/schema-versioning/contracts";

async function withTempClient(fn: (client: Client, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-integration-test-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await fn(client, dir);
  } finally {
    client.close();
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

async function tableExists(client: Client, name: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [name],
  });
  return result.rows.length > 0;
}

// video_metrics_daily.videoId has a real FK on videos.id (Phase 8, PHASE_8_PLAN.md §5) -- a
// channel + video row must exist first, or the insert fails closed with a constraint error.
async function seedChannelAndVideo(database: AppDb, channelId: string, videoId: string): Promise<void> {
  await database.insert(channels).values({
    id: channelId,
    title: "Test Channel",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_TEST",
    connectedUserId: null,
  });
  await database.insert(videos).values({
    id: videoId,
    channelId,
    title: "Test Video",
    description: "",
    publishedAt: "2026-01-01T00:00:00Z",
    privacyStatus: "public",
    thumbnailsJson: "{}",
    localizationsJson: "{}",
  });
}

// AC-SCHEMA-01
test("initializeDatabaseSchema: a fresh database ends stamped at SCHEMA_CURRENT_VERSION with every table present", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    assert.equal(await readSchemaVersion(client), SCHEMA_CURRENT_VERSION);
    assert.equal(await tableExists(client, "users"), true);
    assert.equal(await tableExists(client, "app_operation_locks"), true);
    assert.equal(await tableExists(client, "video_metrics_daily"), true);
  }));

// Phase 8 (docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 2, §7 acceptance criteria).
test("video_metrics_daily: upserting the same (videoId, metricDate, metricName) updates the existing row instead of creating a duplicate", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannelAndVideo(isolatedDb, "UC_TEST", "vid1");

    await upsertVideoMetric(
      { channelId: "UC_TEST", videoId: "vid1", metricDate: "2026-09-20", metricName: "views", metricValue: 100 },
      isolatedDb
    );
    await upsertVideoMetric(
      { channelId: "UC_TEST", videoId: "vid1", metricDate: "2026-09-20", metricName: "views", metricValue: 150 },
      isolatedDb
    );

    const rows = await listVideoMetricsByVideo("vid1", isolatedDb);
    assert.equal(rows.length, 1, "re-collecting an already-collected date must update, not duplicate, the row");
    assert.equal(rows[0].metricValue, 150, "the later collection's value must win");
  }));

test("video_metrics_daily: distinct metric names for the same video/date coexist as separate rows", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannelAndVideo(isolatedDb, "UC_TEST", "vid1");

    await upsertVideoMetric(
      { channelId: "UC_TEST", videoId: "vid1", metricDate: "2026-09-20", metricName: "views", metricValue: 100 },
      isolatedDb
    );
    await upsertVideoMetric(
      { channelId: "UC_TEST", videoId: "vid1", metricDate: "2026-09-20", metricName: "watchTimeMinutes", metricValue: 42 },
      isolatedDb
    );

    const rows = await listVideoMetricsByVideo("vid1", isolatedDb);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.metricName, r.metricValue]).sort(),
      [["views", 100], ["watchTimeMinutes", 42]].sort()
    );
  }));

test("video_metrics_daily: a videoId with no matching videos row is rejected by its foreign key", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await assert.rejects(
      () =>
        upsertVideoMetric(
          { channelId: "UC_TEST", videoId: "nonexistent", metricDate: "2026-09-20", metricName: "views", metricValue: 100 },
          isolatedDb
        ),
      // drizzle wraps the raw libsql error as `.cause` -- the FK failure text lives there,
      // not on the outer "Failed query: insert into ..." message (verified against the actual
      // rejection shape, not assumed).
      (error: unknown) =>
        error instanceof Error && /FOREIGN KEY constraint failed/.test(String(error.cause) + error.message),
      "must fail specifically on the videoId foreign key, not some unrelated error"
    );
  }));

// AC-SCHEMA-02
test("initializeDatabaseSchema: an existing pre-versioning database (baseline tables, no schema_meta) is stamped at the baseline version without altering existing data", () =>
  withTempClient(async (client) => {
    // Simulate a pre-this-task database: run only the baseline (no schema_meta yet). We do
    // this by calling initializeDatabaseSchema once (creates schema_meta as a side effect of
    // migrations), then manually drop schema_meta to simulate "legacy" and insert a row.
    await initializeDatabaseSchema(client);
    await client.execute("DROP TABLE schema_meta");
    await client.execute({
      sql: "INSERT INTO users (id, email) VALUES (?, ?)",
      args: ["legacy-user", "legacy@example.com"],
    });

    await initializeDatabaseSchema(client);

    const users = await client.execute("SELECT id, email FROM users WHERE id = 'legacy-user'");
    assert.equal(users.rows.length, 1, "pre-existing row must survive re-initialization untouched");
    assert.equal(await readSchemaVersion(client), SCHEMA_CURRENT_VERSION);
  }));

// AC-SCHEMA-04
test("initializeDatabaseSchema: rejects a database reporting a version newer than SCHEMA_CURRENT_VERSION, before any mutation", () =>
  withTempClient(async (client) => {
    await client.execute("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await client.execute({
      sql: "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)",
      args: [String(SCHEMA_CURRENT_VERSION + 1000)],
    });

    const before = await client.execute("SELECT name FROM sqlite_master ORDER BY name");
    const beforeNames = before.rows.map((r) => r.name);

    await assert.rejects(
      () => initializeDatabaseSchema(client),
      (error: unknown) => error instanceof SchemaVersionError
    );

    const after = await client.execute("SELECT name FROM sqlite_master ORDER BY name");
    const afterNames = after.rows.map((r) => r.name);
    assert.deepEqual(afterNames, beforeNames, "rejected database must be byte-for-byte unchanged in shape");
  }));

// AC-SCHEMA-08
test("initializeDatabaseSchema: beforeMigrations hook fires with a real pre-migration backup opportunity before pending migrations run", () =>
  withTempClient(async (client, dir) => {
    // Force a scenario where at least one migration is pending: stamp the DB at the baseline
    // version only (simulating "already migrated once, one new migration shipped since").
    await client.execute("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await client.execute({
      sql: "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)",
      args: [String(SCHEMA_BASELINE_VERSION)],
    });
    // Baseline tables must exist too (initializeDatabaseSchema's own baseline block is
    // idempotent and would create them, but the hook fires before that point isn't relevant
    // here -- we only care that the hook fires exactly when migrations are pending).

    let hookCalled = false;
    let hookSawPendingMigrations: number[] = [];
    const backupPath = path.join(dir, "pre-migration-backup.db");

    await initializeDatabaseSchema(client, {
      beforeMigrations: async ({ fromVersion, pendingMigrations }) => {
        hookCalled = true;
        hookSawPendingMigrations = pendingMigrations.map((m) => m.version);
        assert.equal(fromVersion, SCHEMA_BASELINE_VERSION);
        // Real backup mechanism, same one db.ts's singleton boot uses.
        const { copyDatabaseConsistently } = await import("@/lib/db-backup");
        await copyDatabaseConsistently(client, backupPath);
      },
    });

    assert.equal(hookCalled, SCHEMA_MIGRATIONS.some((m) => m.version > SCHEMA_BASELINE_VERSION));
    if (hookCalled) {
      assert.deepEqual(
        hookSawPendingMigrations,
        SCHEMA_MIGRATIONS.filter((m) => m.version > SCHEMA_BASELINE_VERSION).map((m) => m.version)
      );
      const files = await readdir(dir);
      assert.ok(files.includes("pre-migration-backup.db"), "backup file must exist");
    }
  }));

// AC-SCHEMA-03
test("initializeDatabaseSchema: is idempotent -- re-running against an already-current database is a no-op on the version", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const first = await readSchemaVersion(client);
    await initializeDatabaseSchema(client);
    const second = await readSchemaVersion(client);
    assert.equal(first, second);
    assert.equal(second, SCHEMA_CURRENT_VERSION);
  }));

// AC-PATH-05: the previously entirely-untested legacy-migration core, found by independent
// review to be unreachable in a prior version of this file (a module-load-order bug meant
// existsSync(appPaths.dbPath) was always true by the time it was checked, silently skipping
// every legacy migration forever). This test exercises copyLegacyDatabaseInto directly,
// against real temp files, independent of the singleton/module-load wiring around it.
test("copyLegacyDatabaseInto: copies every table's schema and rows from the legacy file into an already-open destination connection", () =>
  withTempClient(async (destClient, dir) => {
    const legacyDbPath = path.join(dir, "legacy.db");
    const legacyClient = createClient({ url: `file:${legacyDbPath}` });
    try {
      await legacyClient.execute(
        "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)"
      );
      await legacyClient.execute({
        sql: "INSERT INTO users (id, email) VALUES (?, ?)",
        args: ["legacy-user", "legacy@example.com"],
      });
      await legacyClient.execute(
        "CREATE TABLE channels (id TEXT PRIMARY KEY, title TEXT NOT NULL)"
      );
      await legacyClient.execute({
        sql: "INSERT INTO channels (id, title) VALUES (?, ?)",
        args: ["chan-1", "Legacy Channel"],
      });
    } finally {
      legacyClient.close();
    }

    // Destination starts truly empty (no baseline schema yet) -- copyLegacyDatabaseInto must
    // recreate each table from the legacy file's own CREATE TABLE statement, not assume the
    // current baseline schema already exists.
    await copyLegacyDatabaseInto(destClient, legacyDbPath);

    const users = await destClient.execute("SELECT id, email FROM users");
    assert.deepEqual(users.rows, [{ id: "legacy-user", email: "legacy@example.com" }]);
    const channels = await destClient.execute("SELECT id, title FROM channels");
    assert.deepEqual(channels.rows, [{ id: "chan-1", title: "Legacy Channel" }]);

    // The legacy file itself must be untouched -- copyLegacyDatabaseInto never writes to it.
    const legacyRecheck = createClient({ url: `file:${legacyDbPath}` });
    const legacyUsersAfter = await legacyRecheck.execute("SELECT id, email FROM users");
    assert.deepEqual(legacyUsersAfter.rows, [{ id: "legacy-user", email: "legacy@example.com" }]);
    legacyRecheck.close();
  }));

// RISK-25 (docs/TECHNICAL_DEBT.md): a retry (e.g. after a previous boot's crashed migration
// attempt) must be safe to redo -- not fail on "table already exists" and not duplicate rows
// via a second INSERT into an already-populated table.
test("copyLegacyDatabaseInto: is idempotent -- calling it twice against the same destination never duplicates rows or fails", () =>
  withTempClient(async (destClient, dir) => {
    const legacyDbPath = path.join(dir, "legacy.db");
    const legacyClient = createClient({ url: `file:${legacyDbPath}` });
    try {
      await legacyClient.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)");
      await legacyClient.execute({
        sql: "INSERT INTO users (id, email) VALUES (?, ?)",
        args: ["legacy-user", "legacy@example.com"],
      });
    } finally {
      legacyClient.close();
    }

    await copyLegacyDatabaseInto(destClient, legacyDbPath);
    await copyLegacyDatabaseInto(destClient, legacyDbPath);

    const users = await destClient.execute("SELECT id, email FROM users");
    assert.deepEqual(users.rows, [{ id: "legacy-user", email: "legacy@example.com" }]);
  }));

// RISK-25: a failure partway through copying multiple tables must roll back completely --
// never leave the destination with some tables copied and others not (which previously
// permanently orphaned the rest of the operator's legacy data, since the retry gate saw the
// resulting file and concluded "already migrated").
test("copyLegacyDatabaseInto: a failure partway through rolls back every table, not just the one that failed", () =>
  withTempClient(async (destClient, dir) => {
    const legacyDbPath = path.join(dir, "legacy.db");
    const legacyClient = createClient({ url: `file:${legacyDbPath}` });
    try {
      await legacyClient.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)");
      await legacyClient.execute({
        sql: "INSERT INTO users (id, email) VALUES (?, ?)",
        args: ["legacy-user", "legacy@example.com"],
      });
      await legacyClient.execute("CREATE TABLE channels (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
      await legacyClient.execute({
        sql: "INSERT INTO channels (id, title) VALUES (?, ?)",
        args: ["chan-1", "Legacy Channel"],
      });
    } finally {
      legacyClient.close();
    }

    // A minimal fake wrapping the real client's `execute`, failing only on the INSERT for the
    // second table (`channels`) -- everything else (including COMMIT/ROLLBACK/DETACH) goes to
    // the real connection, so this exercises the real transaction boundary, not a mock of it.
    const flaky = {
      execute: (query: string | { sql: string; args?: unknown[] }) => {
        const sql = typeof query === "string" ? query : query.sql;
        if (sql.includes('INSERT INTO "channels"')) {
          throw new Error("simulated disk failure partway through the copy");
        }
        return destClient.execute(query as never);
      },
    } as unknown as Client;

    await assert.rejects(
      () => copyLegacyDatabaseInto(flaky, legacyDbPath),
      /simulated disk failure/
    );

    // Neither table survived -- not even `users`, whose own copy succeeded before `channels`
    // failed. A partial result here would be exactly the silent data loss RISK-25 describes.
    assert.equal(await tableExists(destClient, "users"), false);
    assert.equal(await tableExists(destClient, "channels"), false);
  }));
