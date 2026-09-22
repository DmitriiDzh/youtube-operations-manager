import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { initializeDatabaseSchema } from "../db";
import {
  applySnapshotToDatabase,
  exportSnapshot,
  migrateStagedCopy,
  readLineageState,
  scanForUnresolvedExecutionState,
  verifySnapshotForImport,
} from "./services";
import { listPublishedSnapshotIds, createStagingDir, writeManifest } from "./adapters/filesystem";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { SnapshotError } from "./contracts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snapshot-test-"));
  try {
    await fn(dir);
  } finally {
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

async function makeClient(dir: string, name: string): Promise<Client> {
  const client = createClient({ url: `file:${path.join(dir, name)}` });
  await initializeDatabaseSchema(client);
  return client;
}

async function seedChannel(client: Client, channelId: string) {
  await client.execute({
    sql: "INSERT INTO channels (id, title, uploads_playlist_id) VALUES (?, ?, ?)",
    args: [channelId, "Channel " + channelId, "UU" + channelId],
  });
}

async function seedChangeSet(client: Client, changeSetId: string, channelId: string) {
  await client.execute({
    sql: "INSERT INTO change_sets (id, channel_id, source, status) VALUES (?, ?, ?, ?)",
    args: [changeSetId, channelId, "ai_generated", "in_review"],
  });
}

async function seedChange(client: Client, changeId: string, changeSetId: string) {
  await client.execute({
    sql: "INSERT INTO changes (id, change_set_id, video_id, language, field, baseline_value, proposed_value, change_type, validation_status, conflict_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [changeId, changeSetId, "video-1", "en", "title", "Old", "New", "update", "valid", "none"],
  });
}

async function seedUser(client: Client, userId: string, accessToken: string) {
  await client.execute({
    sql: "INSERT INTO users (id, email, access_token, refresh_token) VALUES (?, ?, ?, ?)",
    args: [userId, userId + "@example.com", accessToken, "refresh-" + accessToken],
  });
}

// AC-CONN-02 (INV-CP.1/CP.2): secrets never survive export.
test("exportSnapshot: the published data.db contains zero users rows and zero token bytes", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    await seedUser(client, "user-1", "super-secret-access-token-xyz");

    const manifest = await exportSnapshot({
      client,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });

    const dbPath = path.join(dir, "snapshots", manifest.snapshotId, "data.db");
    const buffer = await readFile(dbPath);
    assert.ok(!buffer.toString("latin1").includes("super-secret-access-token-xyz"));

    const scrubbedClient = createClient({ url: `file:${dbPath}` });
    const users = await scrubbedClient.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
    );
    assert.equal(users.rows.length, 0, "users table must not exist in the scrubbed copy");
    scrubbedClient.close();
    client.close();
  }));

// AC-CONN-01
test("exportSnapshot: the published data.db contains zero ai_connection_credentials rows/table", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    await client.execute({
      sql: "INSERT INTO ai_connections (id, display_name, adapter_type, model_id, capabilities_json) VALUES (?, ?, ?, ?, ?)",
      args: ["conn-1", "Conn 1", "mock", "model-1", "{}"],
    });
    await client.execute({
      sql: "INSERT INTO ai_connection_credentials (connection_id, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?)",
      args: ["conn-1", "ciphertext-bytes", "iv-bytes", "tag-bytes"],
    });

    const manifest = await exportSnapshot({
      client,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });

    const dbPath = path.join(dir, "snapshots", manifest.snapshotId, "data.db");
    const scrubbedClient = createClient({ url: `file:${dbPath}` });
    const credTable = await scrubbedClient.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_connection_credentials'"
    );
    assert.equal(credTable.rows.length, 0);
    const connections = await scrubbedClient.execute("SELECT id FROM ai_connections");
    assert.equal(connections.rows.length, 1, "ai_connections metadata itself must still travel");
    scrubbedClient.close();
    client.close();
  }));

// AC-SNAP-01
test("a snapshot is not visible under its final id until publish (staging is not listed)", () =>
  withTempDir(async (dir) => {
    const snapshotsDir = path.join(dir, "snapshots");
    const { dir: stagingDir } = await createStagingDir(snapshotsDir);
    await writeFile(path.join(stagingDir, "data.db"), "not a real db, doesn't matter for this check");
    // Deliberately never call publishSnapshot -- simulates a crash before the rename.

    const published = await listPublishedSnapshotIds(snapshotsDir);
    assert.deepEqual(published, []);
  }));

// AC-SNAP-02
test("exportSnapshot: manifest checksum matches the actual published (post-scrub) file", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    const manifest = await exportSnapshot({
      client,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });

    const { sha256File } = await import("./adapters/checksum");
    const dbPath = path.join(dir, "snapshots", manifest.snapshotId, "data.db");
    const { sha256 } = await sha256File(dbPath);
    assert.equal(sha256, manifest.files[0].sha256);
    client.close();
  }));

// AC-SNAP-03
test("verifySnapshotForImport rejects a snapshot missing the complete marker", () =>
  withTempDir(async (dir) => {
    const snapshotsDir = path.join(dir, "snapshots");
    const { dir: stagingDir } = await createStagingDir(snapshotsDir);
    const dbPath = path.join(stagingDir, "data.db");
    await writeFile(dbPath, "x");
    await writeManifest(stagingDir, {
      formatVersion: 1,
      snapshotId: "s1",
      parentSnapshotId: null,
      sourceDeviceId: "device-a",
      generation: 1,
      schemaVersion: 3,
      createdAt: new Date().toISOString(),
      files: [{ path: "data.db", sha256: "0".repeat(64), sizeBytes: 1 }],
      complete: false,
    });

    await assert.rejects(
      () =>
        verifySnapshotForImport({
          snapshotDir: stagingDir,
          localLineage: { lastSnapshotId: null, lastGeneration: 0 },
        }),
      (error: unknown) => error instanceof SnapshotError && error.code === "snapshot_incomplete"
    );
  }));

// AC-SNAP-04
test("verifySnapshotForImport rejects a checksum mismatch", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    const manifest = await exportSnapshot({
      client,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);
    await writeFile(path.join(snapshotDir, "data.db"), "corrupted bytes");

    await assert.rejects(
      () =>
        verifySnapshotForImport({
          snapshotDir,
          localLineage: { lastSnapshotId: null, lastGeneration: 0 },
        }),
      (error: unknown) => error instanceof SnapshotError && error.code === "snapshot_checksum_mismatch"
    );
    client.close();
  }));

// AC-SNAP-05
test("verifySnapshotForImport rejects a snapshot with a missing referenced file", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    const manifest = await exportSnapshot({
      client,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);
    await rm(path.join(snapshotDir, "data.db"));

    await assert.rejects(
      () =>
        verifySnapshotForImport({
          snapshotDir,
          localLineage: { lastSnapshotId: null, lastGeneration: 0 },
        }),
      (error: unknown) => error instanceof SnapshotError && error.code === "snapshot_file_missing"
    );
    client.close();
  }));

// AC-SNAP-06
test("verifySnapshotForImport blocks a divergent lineage rather than guessing by timestamp", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    const manifest = await exportSnapshot({
      client,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);

    // Local device claims to already be at some unrelated snapshot -- not this one's parent.
    await assert.rejects(
      () =>
        verifySnapshotForImport({
          snapshotDir,
          localLineage: { lastSnapshotId: "some-other-unrelated-snapshot", lastGeneration: 5 },
        }),
      (error: unknown) => error instanceof SnapshotError && error.code === "snapshot_divergent_lineage"
    );
    client.close();
  }));

// AC-SNAP-07
test("verifySnapshotForImport recognizes a duplicate of the current local snapshot as a safe no-op, not divergence", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    const manifest = await exportSnapshot({
      client,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);

    const result = await verifySnapshotForImport({
      snapshotDir,
      localLineage: { lastSnapshotId: manifest.snapshotId, lastGeneration: manifest.generation },
    });
    assert.equal(result.isDuplicateOfCurrent, true);
    client.close();
  }));

// AC-SNAP-08
test("publishing never overwrites an existing snapshot id", () =>
  withTempDir(async (dir) => {
    const snapshotsDir = path.join(dir, "snapshots");
    const { dir: stagingDir } = await createStagingDir(snapshotsDir);
    await writeFile(path.join(stagingDir, "data.db"), "content-a");
    const { publishSnapshot } = await import("./adapters/filesystem");
    const snapshotId = "fixed-id-for-test";
    await publishSnapshot(snapshotsDir, stagingDir, snapshotId);

    const { dir: stagingDir2 } = await createStagingDir(snapshotsDir);
    await writeFile(path.join(stagingDir2, "data.db"), "content-b");
    await assert.rejects(
      () => publishSnapshot(snapshotsDir, stagingDir2, snapshotId),
      (error: unknown) => error instanceof SnapshotError && error.code === "snapshot_already_exists"
    );
  }));

// AC-SURVIVE-01 / AC-CONN-03 -- the full export -> verify -> migrate -> merge pipeline
test("applySnapshotToDatabase: replaces application-state tables and upserts ai_connections while never touching users/credentials", () =>
  withTempDir(async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedUser(source, "source-user", "source-secret-token");
    // `channels` itself is no longer transferred (2026-09-22, both devices sync it independently
    // from the real YouTube API instead, `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md`
    // §2 Category A) -- seeded here only so `change_sets.channel_id`'s FK is satisfiable, exactly
    // as it would be in reality (both devices manage the same real channel, each having synced it
    // locally under the same id).
    await seedChannel(source, "chan-1");
    await source.execute({
      sql: "INSERT INTO change_sets (id, channel_id, source, status) VALUES (?, ?, ?, ?)",
      args: ["cs-1", "chan-1", "ai_generated", "in_review"],
    });
    await source.execute({
      sql: "INSERT INTO ai_connections (id, display_name, adapter_type, model_id, capabilities_json) VALUES (?, ?, ?, ?, ?)",
      args: ["conn-shared", "From Source", "mock", "model-1", "{}"],
    });
    await source.execute({
      sql: "INSERT INTO ai_connections (id, display_name, adapter_type, model_id, capabilities_json) VALUES (?, ?, ?, ?, ?)",
      args: ["conn-source-only", "Source Only", "mock", "model-1", "{}"],
    });

    const manifest = await exportSnapshot({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);

    // Receiving device: its own OAuth session + its own local AI connection + credential, plus
    // its own independently-synced copy of the same real channel (never received from the
    // snapshot itself -- see the comment on the source side above).
    const receiving = await makeClient(dir, "receiving.db");
    await seedUser(receiving, "receiving-user", "receiving-secret-token");
    await seedChannel(receiving, "chan-1");
    await receiving.execute({
      sql: "INSERT INTO ai_connections (id, display_name, adapter_type, model_id, capabilities_json) VALUES (?, ?, ?, ?, ?)",
      args: ["conn-shared", "Local Name Before Import", "mock", "model-1", "{}"],
    });
    await receiving.execute({
      sql: "INSERT INTO ai_connection_credentials (connection_id, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?)",
      args: ["conn-shared", "local-ciphertext", "local-iv", "local-tag"],
    });
    await receiving.execute({
      sql: "INSERT INTO ai_connections (id, display_name, adapter_type, model_id, capabilities_json) VALUES (?, ?, ?, ?, ?)",
      args: ["conn-receiving-only", "Receiving Only", "mock", "model-1", "{}"],
    });

    // Step 1: verify (already covered above) -- proceed directly to migrate + merge.
    const workingCopyPath = path.join(dir, "working-copy.db");
    await copyDatabaseConsistently(
      createClient({ url: `file:${path.join(snapshotDir, "data.db")}` }),
      workingCopyPath
    );
    await migrateStagedCopy(workingCopyPath);

    await applySnapshotToDatabase(receiving, workingCopyPath);

    // users untouched.
    const users = await receiving.execute("SELECT id, access_token FROM users ORDER BY id");
    assert.deepEqual(
      users.rows.map((r) => r.id),
      ["receiving-user"]
    );
    assert.equal(users.rows[0].access_token, "receiving-secret-token");

    // change_sets replaced from snapshot -- the still-transferred, plain replace-style table
    // this test exercises alongside ai_connections' distinct upsert-by-id behavior.
    const changeSets = await receiving.execute("SELECT id FROM change_sets");
    assert.deepEqual(changeSets.rows.map((r) => r.id), ["cs-1"]);

    // ai_connections: shared connection's metadata updated from snapshot, receiving-only
    // connection preserved, source-only connection added.
    const connections = await receiving.execute("SELECT id, display_name FROM ai_connections ORDER BY id");
    const byId = Object.fromEntries(connections.rows.map((r) => [r.id, r.display_name]));
    assert.equal(byId["conn-shared"], "From Source");
    assert.equal(byId["conn-receiving-only"], "Receiving Only");
    assert.equal(byId["conn-source-only"], "Source Only");

    // The receiving device's own credential for conn-shared must survive untouched.
    const cred = await receiving.execute({
      sql: "SELECT ciphertext FROM ai_connection_credentials WHERE connection_id = ?",
      args: ["conn-shared"],
    });
    assert.equal(cred.rows.length, 1);
    assert.equal(cred.rows[0].ciphertext, "local-ciphertext");

    source.close();
    receiving.close();
  }));

// RISK-33 (docs/TECHNICAL_DEBT.md): reproduces the real-world crash reported by a user importing
// into a device that had already synced its own data. `@libsql/client` defaults
// `PRAGMA foreign_keys=ON` for every connection (unlike stock better-sqlite3, which the rest of
// this codebase implicitly assumed FK enforcement matched) -- so `DELETE FROM "<table>"` fails
// immediately with SQLITE_CONSTRAINT the moment the receiving device still has a local child row
// referencing an existing parent row that hasn't been deleted yet. Every device that has ever
// synced at least one change set with changes hits this on its very next import. Uses
// `change_sets`/`changes` as the example pair (2026-09-22: `channels`/`videos`, this test's
// original example, are no longer transferred at all -- `docs/roadmap/plans/
// FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §2 Category A) -- `channels` is still seeded locally on
// both sides purely to satisfy `change_sets.channel_id`'s FK, exactly as it would in reality
// (both devices independently sync the same real channel).
test("applySnapshotToDatabase: succeeds when the receiving device already has local rows whose foreign keys point at tables being replaced (RISK-33)", () =>
  withTempDir(async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "chan-1");
    await seedChangeSet(source, "cs-new", "chan-1");
    await seedChange(source, "change-new", "cs-new");

    const manifest = await exportSnapshot({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);

    // Receiving device: already has its own previously-synced channel plus its own previous
    // change set/change, exactly like a real returning device performing a routine (not
    // first-ever) import.
    const receiving = await makeClient(dir, "receiving.db");
    await seedChannel(receiving, "chan-1");
    await seedChangeSet(receiving, "cs-old", "chan-1");
    await seedChange(receiving, "change-old", "cs-old");

    const workingCopyPath = path.join(dir, "working-copy.db");
    await copyDatabaseConsistently(
      createClient({ url: `file:${path.join(snapshotDir, "data.db")}` }),
      workingCopyPath
    );
    await migrateStagedCopy(workingCopyPath);

    await applySnapshotToDatabase(receiving, workingCopyPath);

    const changeSets = await receiving.execute("SELECT id FROM change_sets");
    assert.deepEqual(changeSets.rows.map((r) => r.id), ["cs-new"]);
    const changes = await receiving.execute("SELECT id, change_set_id FROM changes");
    assert.deepEqual(changes.rows.map((r) => r.id), ["change-new"]);

    // FK enforcement must be restored afterward -- this is a shared connection, and a later,
    // unrelated write must not silently run with foreign keys disabled.
    const pragmaAfter = await receiving.execute("PRAGMA foreign_keys");
    assert.equal(pragmaAfter.rows[0].foreign_keys, 1);

    source.close();
    receiving.close();
  }));

// RISK-29 (docs/TECHNICAL_DEBT.md): the merge previously used `SELECT *`, which is purely
// positional. Two devices whose table has a genuinely different physical column order for the
// identical logical schema (e.g. one built fresh from the current baseline CREATE TABLE, one
// upgraded via a later ALTER TABLE ADD COLUMN, which SQLite always appends at the physical end)
// would get their columns silently swapped on import. This test manually reorders `change_sets`'
// physical columns on the source side (standing in for that real-world divergence) and asserts
// the merge still lands every value in the receiving device's correctly-named column. Uses
// `change_sets` rather than this test's original `channels` example (2026-09-22: `channels` is
// no longer transferred at all, `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §2
// Category A) -- `channels` is still seeded locally on the source side purely to satisfy
// `change_sets.channel_id`'s FK at insert time (FK enforcement is OFF for the entire import
// itself, per this same file's RISK-33 fix, so the receiving side needs no matching local row).
test("applySnapshotToDatabase: merges by column name, not physical position (RISK-29)", () =>
  withTempDir(async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "chan-1");
    await source.execute(`
      CREATE TABLE change_sets_reordered (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        imported_filename TEXT,
        status TEXT NOT NULL,
        schema_version TEXT,
        exported_at TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    await source.execute({
      sql: "INSERT INTO change_sets_reordered (id, channel_id, source, status) VALUES (?, ?, ?, ?)",
      args: ["cs-1", "chan-1", "ai_generated", "in_review"],
    });
    await source.execute("DROP TABLE change_sets");
    await source.execute("ALTER TABLE change_sets_reordered RENAME TO change_sets");

    const manifest = await exportSnapshot({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);

    const receiving = await makeClient(dir, "receiving.db"); // baseline (unreordered) column order

    const workingCopyPath = path.join(dir, "working-copy.db");
    await copyDatabaseConsistently(
      createClient({ url: `file:${path.join(snapshotDir, "data.db")}` }),
      workingCopyPath
    );
    await migrateStagedCopy(workingCopyPath);

    await applySnapshotToDatabase(receiving, workingCopyPath);

    const result = await receiving.execute({
      sql: "SELECT source, channel_id, status FROM change_sets WHERE id = ?",
      args: ["cs-1"],
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].source, "ai_generated");
    assert.equal(result.rows[0].channel_id, "chan-1");
    assert.equal(result.rows[0].status, "in_review");

    source.close();
    receiving.close();
  }));

test("scanForUnresolvedExecutionState finds APPLYING/UNKNOWN rows but not PENDING/SUCCESS", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    await seedChannel(client, "chan-1");
    await client.execute({
      sql: "INSERT INTO batches (id, channel_id, status) VALUES (?, ?, ?)",
      args: ["batch-1", "chan-1", "RUNNING"],
    });
    const rows: Array<[string, string]> = [
      ["row-pending", "PENDING"],
      ["row-applying", "APPLYING"],
      ["row-unknown", "UNKNOWN"],
      ["row-success", "SUCCESS"],
    ];
    for (const [id, status] of rows) {
      await client.execute({
        sql: "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES (?, ?, ?, ?, ?)",
        args: [id, "batch-1", "video-" + id, "[]", status],
      });
    }

    const found = await scanForUnresolvedExecutionState(client);
    const ids = found.map((r) => r.ledgerRowId).sort();
    assert.deepEqual(ids, ["row-applying", "row-unknown"]);
    client.close();
  }));

test("readLineageState returns null/0 for a device that has never exported or imported anything", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    const state = await readLineageState(client);
    assert.deepEqual(state, { lastSnapshotId: null, lastGeneration: 0 });
    client.close();
  }));

test("exportSnapshot advances this device's own lineage state", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "source.db");
    const first = await exportSnapshot({
      client,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    assert.equal(first.parentSnapshotId, null);
    assert.equal(first.generation, 1);

    const second = await exportSnapshot({
      client,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    assert.equal(second.parentSnapshotId, first.snapshotId);
    assert.equal(second.generation, 2);
    client.close();
  }));
