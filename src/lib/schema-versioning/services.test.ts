import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  assertSupportedSchemaVersion,
  readSchemaVersion,
  runSchemaMigrations,
} from "./services";
import { SchemaVersionError } from "./contracts";

async function withTempClient(fn: (client: Client, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "schema-versioning-test-"));
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

test("readSchemaVersion returns null for a brand-new database (no schema_meta table)", () =>
  withTempClient(async (client) => {
    assert.equal(await readSchemaVersion(client), null);
  }));

test("assertSupportedSchemaVersion never mutates the database when the version is missing or supported", () =>
  withTempClient(async (client) => {
    await assertSupportedSchemaVersion(client, 3);
    assert.equal(await tableExists(client, "schema_meta"), false);
  }));

// AC-SCHEMA-04
test("assertSupportedSchemaVersion rejects a newer-than-supported version, performing zero mutation", () =>
  withTempClient(async (client) => {
    await client.execute(
      "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    await client.execute({
      sql: "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)",
      args: ["999"],
    });
    await client.execute("CREATE TABLE sentinel (id INTEGER PRIMARY KEY)");

    const beforeMaster = await client.execute("SELECT name FROM sqlite_master ORDER BY name");
    const beforeNames = beforeMaster.rows.map((r) => r.name);

    await assert.rejects(
      () => assertSupportedSchemaVersion(client, 3),
      (error: unknown) => error instanceof SchemaVersionError && error.details.foundVersion === 999
    );

    const afterMaster = await client.execute("SELECT name FROM sqlite_master ORDER BY name");
    const afterNames = afterMaster.rows.map((r) => r.name);
    assert.deepEqual(afterNames, beforeNames, "no table should be created/dropped by a rejected check");

    const versionRow = await client.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'");
    assert.equal(versionRow.rows[0].value, "999", "schema_meta must be unchanged");
  }));

// AC-SCHEMA-01/02
test("runSchemaMigrations stamps the baseline version for a legacy/unversioned database, then applies pending migrations in order", () =>
  withTempClient(async (client) => {
    const applied: number[] = [];
    const finalVersion = await runSchemaMigrations(client, {
      currentVersion: null,
      baselineVersion: 1,
      migrations: [
        { version: 3, description: "third", apply: async () => { applied.push(3); } },
        { version: 2, description: "second", apply: async () => { applied.push(2); } },
      ],
    });

    assert.deepEqual(applied, [2, 3], "migrations must apply in version order regardless of list order");
    assert.equal(finalVersion, 3);
    assert.equal(await readSchemaVersion(client), 3);
  }));

// AC-SCHEMA-03
test("runSchemaMigrations only applies migrations strictly newer than the current stamped version", () =>
  withTempClient(async (client) => {
    const applied: number[] = [];
    await runSchemaMigrations(client, {
      currentVersion: 2,
      baselineVersion: 1,
      migrations: [
        { version: 1, description: "already applied (baseline)", apply: async () => { applied.push(1); } },
        { version: 2, description: "already applied", apply: async () => { applied.push(2); } },
        { version: 3, description: "pending", apply: async () => { applied.push(3); } },
      ],
    });
    assert.deepEqual(applied, [3]);
  }));

// AC-SCHEMA-05/06
test("a migration step that throws partway through does not advance schema_meta.schema_version, and a retry succeeds", () =>
  withTempClient(async (client) => {
    let attempt = 0;
    const flakyMigration = {
      version: 2,
      description: "flaky",
      apply: async () => {
        attempt += 1;
        await client.execute("CREATE TABLE IF NOT EXISTS flaky_marker (id INTEGER PRIMARY KEY)");
        if (attempt === 1) {
          throw new Error("simulated failure partway through migration 2");
        }
      },
    };

    await assert.rejects(() =>
      runSchemaMigrations(client, {
        currentVersion: null,
        baselineVersion: 1,
        migrations: [flakyMigration],
      })
    );
    assert.equal(await readSchemaVersion(client), 1, "version must stay at baseline after the failed step");

    // Retry: same migration, no longer forced to fail.
    const finalVersion = await runSchemaMigrations(client, {
      currentVersion: await readSchemaVersion(client),
      baselineVersion: 1,
      migrations: [flakyMigration],
    });
    assert.equal(finalVersion, 2);
    assert.equal(await readSchemaVersion(client), 2);
    assert.equal(attempt, 2);
  }));
