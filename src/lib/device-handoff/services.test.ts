import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { initializeDatabaseSchema } from "../db";
import {
  acknowledgeRecoveryDiagnostics,
  assertDeviceAvailableForMutation,
  assertNotInRecoveryMode,
  exportHandoff,
  importHandoff,
  isDeviceInRecoveryMode,
  RecoveryModeError,
} from "./services";
import { OperationLockError } from "@/lib/operation-lock";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "device-handoff-test-"));
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

async function seedLedgerRow(client: Client, id: string, batchId: string, status: string) {
  await client.execute({
    sql: "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES (?, ?, ?, ?, ?)",
    args: [id, batchId, "video-" + id, "[]", status],
  });
}

// AC-HANDOFF-03
test("importHandoff activates normal mutation capability when the snapshot has no unresolved execution state", () =>
  withTempDir(async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "chan-1");
    const exportResult = await exportHandoff({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });

    const receiving = await makeClient(dir, "receiving.db");
    await mkdir(path.join(dir, "backups"), { recursive: true });
    await mkdir(path.join(dir, "work"), { recursive: true });

    const result = await importHandoff({
      liveClient: receiving,
      snapshotDir: path.join(dir, "snapshots", exportResult.manifest.snapshotId),
      migrationBackupsDir: path.join(dir, "backups"),
      workingDir: path.join(dir, "work"),
    });

    assert.equal(result.status, "activated_normal");
    assert.equal(await isDeviceInRecoveryMode(receiving), false);
    await assert.doesNotReject(() => assertNotInRecoveryMode(receiving));

    const channels = await receiving.execute("SELECT id FROM channels");
    assert.deepEqual(channels.rows.map((r) => r.id), ["chan-1"]);

    source.close();
    receiving.close();
  }));

// AC-HANDOFF-04
test("importHandoff leaves the device in recovery mode when the snapshot carries unresolved execution rows, but still preserves the data", () =>
  withTempDir(async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "chan-1");
    await source.execute({
      sql: "INSERT INTO batches (id, channel_id, status) VALUES (?, ?, ?)",
      args: ["batch-1", "chan-1", "RUNNING"],
    });
    await seedLedgerRow(source, "row-unknown", "batch-1", "UNKNOWN");
    await seedLedgerRow(source, "row-pending", "batch-1", "PENDING");

    const exportResult = await exportHandoff({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });

    const receiving = await makeClient(dir, "receiving.db");
    await mkdir(path.join(dir, "backups"), { recursive: true });
    await mkdir(path.join(dir, "work"), { recursive: true });

    const result = await importHandoff({
      liveClient: receiving,
      snapshotDir: path.join(dir, "snapshots", exportResult.manifest.snapshotId),
      migrationBackupsDir: path.join(dir, "backups"),
      workingDir: path.join(dir, "work"),
    });

    assert.equal(result.status, "activated_recovery_mode");
    if (result.status === "activated_recovery_mode") {
      assert.equal(result.unresolved.length, 1);
      assert.equal(result.unresolved[0].ledgerRowId, "row-unknown");
    }

    // Data preserved despite recovery mode.
    const rows = await receiving.execute("SELECT id, status FROM batch_ledger_rows ORDER BY id");
    assert.equal(rows.rows.length, 2);

    assert.equal(await isDeviceInRecoveryMode(receiving), true);
    await assert.rejects(
      () => assertNotInRecoveryMode(receiving),
      (error: unknown) => error instanceof RecoveryModeError
    );
    await assert.rejects(
      () => assertDeviceAvailableForMutation(receiving),
      (error: unknown) => error instanceof RecoveryModeError
    );

    source.close();
    receiving.close();
  }));

// AC-HANDOFF-05 -- the single most safety-critical scenario.
test("acknowledgeRecoveryDiagnostics never changes any row's status and never lifts the recovery-mode gate", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "receiving.db");
    await seedChannel(client, "chan-1");
    await client.execute({
      sql: "INSERT INTO batches (id, channel_id, status) VALUES (?, ?, ?)",
      args: ["batch-1", "chan-1", "RUNNING"],
    });
    await seedLedgerRow(client, "row-unknown", "batch-1", "UNKNOWN");

    const before = await client.execute("SELECT id, status FROM batch_ledger_rows WHERE id = 'row-unknown'");

    const ack = await acknowledgeRecoveryDiagnostics(client, { note: "operator reviewed" });
    assert.equal(ack.affectedBatches.length, 1);

    const after = await client.execute("SELECT id, status FROM batch_ledger_rows WHERE id = 'row-unknown'");
    assert.deepEqual(after.rows, before.rows, "row must be byte-identical after acknowledgement");

    // The gate is still engaged immediately after acknowledgement.
    assert.equal(await isDeviceInRecoveryMode(client), true);
    await assert.rejects(
      () => assertDeviceAvailableForMutation(client),
      (error: unknown) => error instanceof RecoveryModeError
    );

    // The acknowledgement itself was recorded, immutably, as its own audit trail.
    const log = await client.execute("SELECT note FROM recovery_acknowledgements");
    assert.equal(log.rows.length, 1);
    assert.equal(log.rows[0].note, "operator reviewed");

    client.close();
  }));

// AC-HANDOFF-06
test("recovery mode lifts once the underlying rows are independently resolved to a terminal state", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "receiving.db");
    await seedChannel(client, "chan-1");
    await client.execute({
      sql: "INSERT INTO batches (id, channel_id, status) VALUES (?, ?, ?)",
      args: ["batch-1", "chan-1", "RUNNING"],
    });
    await seedLedgerRow(client, "row-unknown", "batch-1", "UNKNOWN");

    assert.equal(await isDeviceInRecoveryMode(client), true);

    // Simulate Phase 5's own existing reconciliation resolving the row to a terminal state --
    // this test does it directly at the data level (not via any symbol this task's modules
    // reference, per decision 3/INV-CP.4).
    await client.execute({
      sql: "UPDATE batch_ledger_rows SET status = 'FAILED' WHERE id = 'row-unknown'",
      args: [],
    });

    assert.equal(await isDeviceInRecoveryMode(client), false);
    await assert.doesNotReject(() => assertDeviceAvailableForMutation(client));

    client.close();
  }));

// AC-HANDOFF-07
test("audit trail and durable intent records survive import unmodified", () =>
  withTempDir(async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "chan-1");
    await source.execute({
      sql: "INSERT INTO batches (id, channel_id, status) VALUES (?, ?, ?)",
      args: ["batch-1", "chan-1", "COMPLETED"],
    });
    await seedLedgerRow(source, "row-1", "batch-1", "SUCCESS");
    await source.execute({
      sql: "INSERT INTO audit_events (batch_id, ledger_row_id, video_id, event_type, detail_json) VALUES (?, ?, ?, ?, ?)",
      args: ["batch-1", "row-1", "video-row-1", "RESULT", "{}"],
    });

    const exportResult = await exportHandoff({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });

    const receiving = await makeClient(dir, "receiving.db");
    await mkdir(path.join(dir, "backups"), { recursive: true });
    await mkdir(path.join(dir, "work"), { recursive: true });
    await importHandoff({
      liveClient: receiving,
      snapshotDir: path.join(dir, "snapshots", exportResult.manifest.snapshotId),
      migrationBackupsDir: path.join(dir, "backups"),
      workingDir: path.join(dir, "work"),
    });

    const events = await receiving.execute("SELECT event_type, video_id FROM audit_events");
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].event_type, "RESULT");

    source.close();
    receiving.close();
  }));

// AC-SNAP-07 via the orchestrator
test("importHandoff is a safe no-op for a duplicate-of-current snapshot", () =>
  withTempDir(async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "chan-1");
    const exportResult = await exportHandoff({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });

    const receiving = await makeClient(dir, "receiving.db");
    await mkdir(path.join(dir, "backups"), { recursive: true });
    await mkdir(path.join(dir, "work"), { recursive: true });

    const snapshotDir = path.join(dir, "snapshots", exportResult.manifest.snapshotId);
    const first = await importHandoff({
      liveClient: receiving,
      snapshotDir,
      migrationBackupsDir: path.join(dir, "backups"),
      workingDir: path.join(dir, "work"),
    });
    assert.equal(first.status, "activated_normal");

    const second = await importHandoff({
      liveClient: receiving,
      snapshotDir,
      migrationBackupsDir: path.join(dir, "backups"),
      workingDir: path.join(dir, "work"),
    });
    assert.equal(second.status, "duplicate_noop");

    const channels = await receiving.execute("SELECT id FROM channels");
    assert.equal(channels.rows.length, 1, "no duplicate rows from a repeated import");

    source.close();
    receiving.close();
  }));

test("assertDeviceAvailableForMutation rejects while an operation lock is held", () =>
  withTempDir(async (dir) => {
    const client = await makeClient(dir, "device.db");
    const { acquireOperationLock } = await import("@/lib/operation-lock");
    await acquireOperationLock(client, "export");

    await assert.rejects(
      () => assertDeviceAvailableForMutation(client),
      (error: unknown) => error instanceof OperationLockError
    );

    client.close();
  }));

test("importHandoff refuses a snapshot from a newer, unsupported schema version before touching the live DB", () =>
  withTempDir(async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "chan-1");
    // Force schema_meta to report a future version at export time.
    await source.execute({
      sql: "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
      args: ["999999"],
    });
    const exportResult = await exportHandoff({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 999999,
    });

    const receiving = await makeClient(dir, "receiving.db");
    await seedChannel(receiving, "existing-chan");
    await mkdir(path.join(dir, "backups"), { recursive: true });
    await mkdir(path.join(dir, "work"), { recursive: true });

    await assert.rejects(() =>
      importHandoff({
        liveClient: receiving,
        snapshotDir: path.join(dir, "snapshots", exportResult.manifest.snapshotId),
        migrationBackupsDir: path.join(dir, "backups"),
        workingDir: path.join(dir, "work"),
      })
    );

    // Live DB must remain exactly as it was -- the reject happens before any ATTACH/merge.
    const channels = await receiving.execute("SELECT id FROM channels");
    assert.deepEqual(channels.rows.map((r) => r.id), ["existing-chan"]);

    source.close();
    receiving.close();
  }));
