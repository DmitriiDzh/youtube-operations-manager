import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  initializeDatabaseSchema,
  SCHEMA_BASELINE_VERSION,
  SCHEMA_CURRENT_VERSION,
  SCHEMA_MIGRATIONS,
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

// AC-SCHEMA-01
test("initializeDatabaseSchema: a fresh database ends stamped at SCHEMA_CURRENT_VERSION with every table present", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    assert.equal(await readSchemaVersion(client), SCHEMA_CURRENT_VERSION);
    assert.equal(await tableExists(client, "users"), true);
    assert.equal(await tableExists(client, "app_operation_locks"), true);
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
