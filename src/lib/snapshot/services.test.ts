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
    await seedChannel(source, "chan-1");
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

    // Receiving device: its own OAuth session + its own local AI connection + credential.
    const receiving = await makeClient(dir, "receiving.db");
    await seedUser(receiving, "receiving-user", "receiving-secret-token");
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

    // channels replaced from snapshot.
    const channels = await receiving.execute("SELECT id FROM channels");
    assert.deepEqual(channels.rows.map((r) => r.id), ["chan-1"]);

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

    const found = await scanForUnresolvedExecutionState(path.join(dir, "source.db"));
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
