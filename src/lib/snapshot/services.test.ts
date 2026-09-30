import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
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
import { SnapshotError, SNAPSHOT_DEVICE_LOCAL_TABLES, SNAPSHOT_TRANSFERRED_TABLES } from "./contracts";
import { withTempDir } from "@/test-support/temp-dir";

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

async function seedBatch(client: Client, batchId: string, channelId: string, status = "RUNNING") {
  await client.execute({
    sql: "INSERT INTO batches (id, channel_id, status) VALUES (?, ?, ?)",
    args: [batchId, channelId, status],
  });
}

async function seedLedgerRow(client: Client, ledgerRowId: string, batchId: string, status = "PENDING") {
  await client.execute({
    sql: "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES (?, ?, ?, ?, ?)",
    args: [ledgerRowId, batchId, "video-1", "[]", status],
  });
}

async function seedUser(client: Client, userId: string, accessToken: string) {
  await client.execute({
    sql: "INSERT INTO users (id, email, access_token, refresh_token) VALUES (?, ?, ?, ?)",
    args: [userId, userId + "@example.com", accessToken, "refresh-" + accessToken],
  });
}

async function seedResearchChannel(client: Client, channelId: string) {
  await client.execute({
    sql: "INSERT INTO research_channels (id, reason, created_via) VALUES (?, ?, ?)",
    args: [channelId, "Competitor in the same niche", "web_ui"],
  });
}

async function seedMarketChannelSnapshot(client: Client, id: string, researchChannelId: string, subscriberCount: number) {
  await client.execute({
    sql: "INSERT INTO market_channel_snapshots (id, research_channel_id, subscriber_count, hidden_subscriber_count, source, created_via) VALUES (?, ?, ?, 0, 'manual observation', 'web_ui')",
    args: [id, researchChannelId, subscriberCount],
  });
}

// AC-CONN-02 (INV-CP.1/CP.2): secrets never survive export.
test("exportSnapshot: the published data.db contains zero users rows and zero token bytes", () =>
  withTempDir("snapshot-test-", async (dir) => {
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

// AC-CONN-01. `ai_connections` metadata itself was removed from the transferred-tables
// allowlist in M6 (2026-09-23, `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §2
// Category C) -- `src/lib/sync-gateway/ai-connections-catalog/` now propagates it continuously
// instead, so neither `ai_connections` nor `ai_connection_credentials` should exist at all in a
// scrubbed snapshot copy any more (same treatment as `users`, tested above).
test("exportSnapshot: the published data.db contains neither ai_connections nor ai_connection_credentials", () =>
  withTempDir("snapshot-test-", async (dir) => {
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
    for (const table of ["ai_connection_credentials", "ai_connections"]) {
      const result = await scrubbedClient.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        args: [table],
      });
      assert.equal(result.rows.length, 0, `${table} must not exist in the scrubbed copy`);
    }
    scrubbedClient.close();
    client.close();
  }));

// AC-SNAP-01
test("a snapshot is not visible under its final id until publish (staging is not listed)", () =>
  withTempDir("snapshot-test-", async (dir) => {
    const snapshotsDir = path.join(dir, "snapshots");
    const { dir: stagingDir } = await createStagingDir(snapshotsDir);
    await writeFile(path.join(stagingDir, "data.db"), "not a real db, doesn't matter for this check");
    // Deliberately never call publishSnapshot -- simulates a crash before the rename.

    const published = await listPublishedSnapshotIds(snapshotsDir);
    assert.deepEqual(published, []);
  }));

// AC-SNAP-02
test("exportSnapshot: manifest checksum matches the actual published (post-scrub) file", () =>
  withTempDir("snapshot-test-", async (dir) => {
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
  withTempDir("snapshot-test-", async (dir) => {
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
  withTempDir("snapshot-test-", async (dir) => {
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
  withTempDir("snapshot-test-", async (dir) => {
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
  withTempDir("snapshot-test-", async (dir) => {
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
  withTempDir("snapshot-test-", async (dir) => {
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
  withTempDir("snapshot-test-", async (dir) => {
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

// AC-SURVIVE-01 / AC-CONN-03 -- the full export -> verify -> migrate -> merge pipeline.
// `ai_connections`' own upsert-by-id special case was removed in M6 (2026-09-23) along with
// `ai_connections` itself from the transferred-tables allowlist -- `batches` is now the plain
// replace-style example table (M6 narrowed the allowlist to just `schema_meta` plus the four
// Category D write-pipeline tables, `docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md`).
test("applySnapshotToDatabase: replaces application-state tables while never touching users/credentials/ai_connections", () =>
  withTempDir("snapshot-test-", async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedUser(source, "source-user", "source-secret-token");
    // `channels` itself is no longer transferred (2026-09-22, both devices sync it independently
    // from the real YouTube API instead, `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md`
    // §2 Category A) -- seeded here only so `batches.channel_id`'s FK is satisfiable, exactly
    // as it would be in reality (both devices manage the same real channel, each having synced it
    // locally under the same id).
    await seedChannel(source, "chan-1");
    await seedBatch(source, "batch-1", "chan-1");
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
      args: ["conn-receiving-only", "Receiving Only", "mock", "model-1", "{}"],
    });
    await receiving.execute({
      sql: "INSERT INTO ai_connection_credentials (connection_id, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?)",
      args: ["conn-receiving-only", "local-ciphertext", "local-iv", "local-tag"],
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

    // batches replaced from snapshot -- the still-transferred, plain replace-style table.
    const batches = await receiving.execute("SELECT id FROM batches");
    assert.deepEqual(batches.rows.map((r) => r.id), ["batch-1"]);

    // ai_connections is no longer part of this mechanism at all -- the receiving device's own
    // connection and credential must survive completely untouched, and the source-only
    // connection must NOT have arrived.
    const connections = await receiving.execute("SELECT id, display_name FROM ai_connections ORDER BY id");
    assert.deepEqual(
      connections.rows.map((r) => r.id),
      ["conn-receiving-only"]
    );
    const cred = await receiving.execute({
      sql: "SELECT ciphertext FROM ai_connection_credentials WHERE connection_id = ?",
      args: ["conn-receiving-only"],
    });
    assert.equal(cred.rows.length, 1);
    assert.equal(cred.rows[0].ciphertext, "local-ciphertext");

    source.close();
    receiving.close();
  }));

// RISK-52 (docs/TECHNICAL_DEBT.md), owner decision docs/roadmap/plans/PHASE_9_PLAN.md §12 point 5
// ("Да, я бы объединял") -- Phase 9 market-intelligence tables must travel with device handoff,
// never silently stay device-local. Every Phase 9 slice from 9A onward added a new table without
// adding it to SNAPSHOT_TRANSFERRED_TABLES until this fix (found during 9H part A planning); this
// test proves the fix against the REAL applySnapshotToDatabase mechanism, not merely that the
// constant contains the right strings.
test("applySnapshotToDatabase: Phase 9 market-intelligence tables (research_channels and a child snapshot table) travel with the snapshot, replacing the receiving device's own", () =>
  withTempDir("snapshot-test-", async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedResearchChannel(source, "UCsource0000000000000001");
    await seedMarketChannelSnapshot(source, "snap-source-1", "UCsource0000000000000001", 1000);

    const manifest = await exportSnapshot({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);

    // Receiving device already has its own, different watchlist entry -- this must NOT survive
    // the import (the same "replace wholesale" semantics already established for `batches`).
    const receiving = await makeClient(dir, "receiving.db");
    await seedResearchChannel(receiving, "UCreceiving000000000001");

    const workingCopyPath = path.join(dir, "working-copy.db");
    await copyDatabaseConsistently(
      createClient({ url: `file:${path.join(snapshotDir, "data.db")}` }),
      workingCopyPath
    );
    await migrateStagedCopy(workingCopyPath);

    await applySnapshotToDatabase(receiving, workingCopyPath);

    const channels = await receiving.execute("SELECT id FROM research_channels");
    assert.deepEqual(
      channels.rows.map((r) => r.id),
      ["UCsource0000000000000001"],
      "the source device's own watchlist entry must arrive, and the receiving device's own prior entry must not survive"
    );

    const snapshots = await receiving.execute("SELECT id, research_channel_id, subscriber_count FROM market_channel_snapshots");
    assert.deepEqual(snapshots.rows, [{ id: "snap-source-1", research_channel_id: "UCsource0000000000000001", subscriber_count: 1000 }]);

    source.close();
    receiving.close();
  }));

// Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md §5a) -- added to
// SNAPSHOT_TRANSFERRED_TABLES from this module's own first commit, not a later fix pass. Proves
// the fix against the REAL applySnapshotToDatabase mechanism, including the FK chain
// hypotheses -> experiments -> experiment_outcomes (+ hypothesis_evidence, slice 3) surviving a
// real, receiving-device import.
test("applySnapshotToDatabase: Phase 10 decision-engine tables (hypotheses -> experiments -> experiment_outcomes, hypothesis_evidence) travel with the snapshot, replacing the receiving device's own -- including a channel-scoped hypothesis and a receiving device that already holds its own full chain (advisor review: `PRAGMA foreign_keys=OFF` for this whole transaction, RISK-33, makes `channel_id REFERENCES channels(id)` safe here even though the referenced channel only exists on the source device)", () =>
  withTempDir("snapshot-test-", async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "UCsourceonly000000000001");
    await source.execute({
      sql: "INSERT INTO hypotheses (id, channel_id, statement, evidence_notes, created_by, created_via) VALUES (?, ?, ?, ?, ?, ?)",
      args: ["hyp-source-1", "UCsourceonly000000000001", "Shorter titles improve CTR", "gut feeling", "owner", "web_ui"],
    });
    await source.execute({
      sql: "INSERT INTO experiments (id, hypothesis_id, treatment, control_baseline, success_criteria, stopping_criteria, responsible, status, created_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["exp-source-1", "hyp-source-1", "shorter titles", "current titles", "CTR +10%", "14 days", "owner", "running", "web_ui"],
    });
    await source.execute({
      sql: "INSERT INTO experiment_outcomes (id, experiment_id, recorded_by, outcome_data, criteria_met, created_via) VALUES (?, ?, ?, ?, ?, ?)",
      args: ["out-source-1", "exp-source-1", "owner", "CTR rose 12%", "met", "web_ui"],
    });
    // Phase 10 slice 3 -- hypothesis_evidence added to the same source-device chain, proving this
    // newer table travels too (RISK-52-avoidance, added from its own first commit).
    await source.execute({
      sql: "INSERT INTO hypothesis_evidence (id, hypothesis_id, source_type, reference_json, created_via) VALUES (?, ?, ?, ?, ?)",
      args: [
        "ev-source-1",
        "hyp-source-1",
        "phase9_trend_candidate",
        JSON.stringify({ sourceType: "phase9_trend_candidate", trendCandidateId: "trend-1" }),
        "web_ui",
      ],
    });

    const manifest = await exportSnapshot({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);

    // Receiving device already holds its OWN full chain (hypothesis -> experiment -> outcome),
    // not just a lone hypothesis -- covers the RISK-33 delete-ordering case for a table this
    // module itself introduces (a receiving device with existing child rows referencing an
    // existing parent row it's about to delete), not only the already-covered Phase 9 case.
    const receiving = await makeClient(dir, "receiving.db");
    await receiving.execute({
      sql: "INSERT INTO hypotheses (id, statement, evidence_notes, created_by, created_via) VALUES (?, ?, ?, ?, ?)",
      args: ["hyp-receiving-1", "receiving device's own hypothesis", "n/a", "owner", "web_ui"],
    });
    await receiving.execute({
      sql: "INSERT INTO experiments (id, hypothesis_id, treatment, control_baseline, success_criteria, stopping_criteria, responsible, status, created_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["exp-receiving-1", "hyp-receiving-1", "t", "c", "s", "s", "owner", "proposed", "web_ui"],
    });
    await receiving.execute({
      sql: "INSERT INTO experiment_outcomes (id, experiment_id, recorded_by, outcome_data, criteria_met, created_via) VALUES (?, ?, ?, ?, ?, ?)",
      args: ["out-receiving-1", "exp-receiving-1", "owner", "receiving device's own outcome", "met", "web_ui"],
    });
    await receiving.execute({
      sql: "INSERT INTO hypothesis_evidence (id, hypothesis_id, source_type, reference_json, created_via) VALUES (?, ?, ?, ?, ?)",
      args: [
        "ev-receiving-1",
        "hyp-receiving-1",
        "phase9_trend_candidate",
        JSON.stringify({ sourceType: "phase9_trend_candidate", trendCandidateId: "receiving-own-trend" }),
        "web_ui",
      ],
    });

    const workingCopyPath = path.join(dir, "working-copy.db");
    await copyDatabaseConsistently(
      createClient({ url: `file:${path.join(snapshotDir, "data.db")}` }),
      workingCopyPath
    );
    await migrateStagedCopy(workingCopyPath);

    await applySnapshotToDatabase(receiving, workingCopyPath);

    const hypotheses = await receiving.execute("SELECT id, channel_id FROM hypotheses");
    assert.deepEqual(
      hypotheses.rows,
      [{ id: "hyp-source-1", channel_id: "UCsourceonly000000000001" }],
      "the source device's own channel-scoped hypothesis must arrive (channel_id intact, even though that channel only exists on the source device), and the receiving device's own prior chain must not survive"
    );

    const experiments = await receiving.execute("SELECT id, hypothesis_id, status FROM experiments");
    assert.deepEqual(experiments.rows, [{ id: "exp-source-1", hypothesis_id: "hyp-source-1", status: "running" }]);

    const outcomes = await receiving.execute("SELECT id, experiment_id, criteria_met FROM experiment_outcomes");
    assert.deepEqual(outcomes.rows, [{ id: "out-source-1", experiment_id: "exp-source-1", criteria_met: "met" }]);

    const evidence = await receiving.execute("SELECT id, hypothesis_id, source_type FROM hypothesis_evidence");
    assert.deepEqual(
      evidence.rows,
      [{ id: "ev-source-1", hypothesis_id: "hyp-source-1", source_type: "phase9_trend_candidate" }],
      "the source device's own structured evidence must arrive, and the receiving device's own prior evidence row must not survive"
    );

    // `channels` itself is NOT in SNAPSHOT_TRANSFERRED_TABLES (only local-only records like
    // batches/audit/research data travel -- owned channels are expected to be re-derived via each
    // device's own channel_sync against the real YouTube account, not carried by snapshot). So the
    // receiving device's own `channels` table is untouched by this import -- confirmed empty here,
    // proving `PRAGMA foreign_keys=OFF` (RISK-33) is what let the hypothesis row above arrive with
    // a `channel_id` pointing at a channel this device doesn't locally have, without the import
    // itself failing. This is the same pre-existing tradeoff `batches.channel_id`/`change_sets.
    // channel_id` already have (both also FK-reference channels.id and already travel without
    // `channels` itself traveling) -- not a new gap this module introduces.
    const channels = await receiving.execute("SELECT id FROM channels");
    assert.deepEqual(channels.rows, []);

    source.close();
    receiving.close();
  }));

// RISK-33 (docs/TECHNICAL_DEBT.md): reproduces the real-world crash reported by a user importing
// into a device that had already synced its own data. `@libsql/client` defaults
// `PRAGMA foreign_keys=ON` for every connection (unlike stock better-sqlite3, which the rest of
// this codebase implicitly assumed FK enforcement matched) -- so `DELETE FROM "<table>"` fails
// immediately with SQLITE_CONSTRAINT the moment the receiving device still has a local child row
// referencing an existing parent row that hasn't been deleted yet. Every device that has ever
// synced at least one batch with ledger rows hits this on its very next import. Uses
// `batches`/`batch_ledger_rows` as the example pair (M6, 2026-09-23: `change_sets`/`changes`,
// this test's prior example, are no longer transferred at all either -- `docs/roadmap/plans/
// FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §2 Category B/C) -- `channels` is still seeded locally
// on both sides purely to satisfy `batches.channel_id`'s FK, exactly as it would in reality
// (both devices independently sync the same real channel).
test("applySnapshotToDatabase: succeeds when the receiving device already has local rows whose foreign keys point at tables being replaced (RISK-33)", () =>
  withTempDir("snapshot-test-", async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "chan-1");
    await seedBatch(source, "batch-new", "chan-1");
    await seedLedgerRow(source, "ledger-new", "batch-new");

    const manifest = await exportSnapshot({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);

    // Receiving device: already has its own previously-synced channel plus its own previous
    // batch/ledger row, exactly like a real returning device performing a routine (not
    // first-ever) import.
    const receiving = await makeClient(dir, "receiving.db");
    await seedChannel(receiving, "chan-1");
    await seedBatch(receiving, "batch-old", "chan-1");
    await seedLedgerRow(receiving, "ledger-old", "batch-old");

    const workingCopyPath = path.join(dir, "working-copy.db");
    await copyDatabaseConsistently(
      createClient({ url: `file:${path.join(snapshotDir, "data.db")}` }),
      workingCopyPath
    );
    await migrateStagedCopy(workingCopyPath);

    await applySnapshotToDatabase(receiving, workingCopyPath);

    const batches = await receiving.execute("SELECT id FROM batches");
    assert.deepEqual(batches.rows.map((r) => r.id), ["batch-new"]);
    const ledgerRows = await receiving.execute("SELECT id, batch_id FROM batch_ledger_rows");
    assert.deepEqual(ledgerRows.rows.map((r) => r.id), ["ledger-new"]);

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
// would get their columns silently swapped on import. This test manually reorders `batches`'
// physical columns on the source side (standing in for that real-world divergence) and asserts
// the merge still lands every value in the receiving device's correctly-named column. Uses
// `batches` rather than this test's original `channels` example (2026-09-22: `channels` is no
// longer transferred at all; M6, 2026-09-23: `change_sets`, the example used in between, isn't
// either -- `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §2) -- `channels` is
// still seeded locally on the source side purely to satisfy `batches.channel_id`'s FK at insert
// time (FK enforcement is OFF for the entire import itself, per this same file's RISK-33 fix, so
// the receiving side needs no matching local row).
test("applySnapshotToDatabase: merges by column name, not physical position (RISK-29)", () =>
  withTempDir("snapshot-test-", async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedChannel(source, "chan-1");
    await source.execute(`
      CREATE TABLE batches_reordered (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        concurrency INTEGER NOT NULL DEFAULT 1,
        dry_run INTEGER NOT NULL DEFAULT 1,
        run_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER,
        completed_at INTEGER
      )
    `);
    await source.execute({
      sql: "INSERT INTO batches_reordered (id, channel_id, status) VALUES (?, ?, ?)",
      args: ["batch-1", "chan-1", "RUNNING"],
    });
    await source.execute("DROP TABLE batches");
    await source.execute("ALTER TABLE batches_reordered RENAME TO batches");

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
      sql: "SELECT status, channel_id FROM batches WHERE id = ?",
      args: ["batch-1"],
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].status, "RUNNING");
    assert.equal(result.rows[0].channel_id, "chan-1");

    source.close();
    receiving.close();
  }));

test("scanForUnresolvedExecutionState finds APPLYING/UNKNOWN rows but not PENDING/SUCCESS", () =>
  withTempDir("snapshot-test-", async (dir) => {
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
  withTempDir("snapshot-test-", async (dir) => {
    const client = await makeClient(dir, "source.db");
    const state = await readLineageState(client);
    assert.deepEqual(state, { lastSnapshotId: null, lastGeneration: 0 });
    client.close();
  }));

test("exportSnapshot advances this device's own lineage state", () =>
  withTempDir("snapshot-test-", async (dir) => {
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

// Phase 11 (docs/roadmap/plans/PHASE_11_PLAN.md AC-P11-06) -- `channel_workspaces` is the opposite
// case from the Phase 9/10 tables above: a per-device local filesystem path must NEVER travel with a
// handoff. Proves it against the real export/apply mechanism: the source device's row does not
// arrive, and the receiving device's own row survives the import untouched.
test("applySnapshotToDatabase: Phase 11 channel_workspaces is device-local -- never exported, and the receiving device's own rows survive an import", () =>
  withTempDir("snapshot-test-", async (dir) => {
    assert.equal((SNAPSHOT_TRANSFERRED_TABLES as readonly string[]).includes("channel_workspaces"), false);
    assert.equal((SNAPSHOT_TRANSFERRED_TABLES as readonly string[]).includes("agent_channel_tokens"), false);
    // ...whereas the per-channel market assignments (Phase 12 slice 12.4) ARE business data and travel.
    assert.equal((SNAPSHOT_TRANSFERRED_TABLES as readonly string[]).includes("channel_record_assignments"), true);

    const source = await makeClient(dir, "source.db");
    await source.execute({
      sql: "INSERT INTO channel_workspaces (device_id, channel_id, path) VALUES (?, ?, ?)",
      args: ["device-a", "UCsource0000000000000001", "/Users/a/work/source"],
    });
    const manifest = await exportSnapshot({
      client: source,
      snapshotsDir: path.join(dir, "snapshots"),
      deviceId: "device-a",
      schemaVersion: 3,
    });
    const snapshotDir = path.join(dir, "snapshots", manifest.snapshotId);

    // The published copy itself must not contain the table (not merely "apply ignores it").
    const published = createClient({ url: `file:${path.join(snapshotDir, "data.db")}` });
    const tableRows = await published.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_workspaces'"
    );
    assert.equal(tableRows.rows.length, 0, "channel_workspaces must not exist in the published snapshot");
    published.close();

    const receiving = await makeClient(dir, "receiving.db");
    await receiving.execute({
      sql: "INSERT INTO channel_workspaces (device_id, channel_id, path) VALUES (?, ?, ?)",
      args: ["device-b", "UCreceiving000000000001", "/Users/b/work/receiving"],
    });

    const workingCopyPath = path.join(dir, "working-copy.db");
    await copyDatabaseConsistently(
      createClient({ url: `file:${path.join(snapshotDir, "data.db")}` }),
      workingCopyPath
    );
    await migrateStagedCopy(workingCopyPath);
    await applySnapshotToDatabase(receiving, workingCopyPath);

    const rows = await receiving.execute("SELECT device_id, channel_id, path FROM channel_workspaces");
    assert.deepEqual(rows.rows, [
      { device_id: "device-b", channel_id: "UCreceiving000000000001", path: "/Users/b/work/receiving" },
    ]);

    source.close();
    receiving.close();
  }));

// Architecture audit 2026-10-01 (M6): every table the schema creates is classified exactly once --
// transferred with a handoff, or deliberately device-local with a reason.
test("every schema table is classified as either transferred or device-local, never both, never neither", async () => {
  const source = await readFile(path.resolve(process.cwd(), "src/lib/db.ts"), "utf8");
  const created = new Set([...source.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1]));
  created.add("schema_meta");
  const transferred = new Set<string>(SNAPSHOT_TRANSFERRED_TABLES);
  const local = new Set(Object.keys(SNAPSHOT_DEVICE_LOCAL_TABLES));
  const unclassified = [...created].filter((t) => !transferred.has(t) && !local.has(t));
  const both = [...created].filter((t) => transferred.has(t) && local.has(t));
  const unknown = [...transferred, ...local].filter((t) => !created.has(t));
  assert.deepEqual({ unclassified, both, unknown }, { unclassified: [], both: [], unknown: [] });
});

// Review of the architecture-audit fixes (2026-10-01): a snapshot from an OLDER build whose scrub
// dropped a now-transferred table (video_edit_audit_events) must still import, leaving that table's
// receiving-device rows untouched -- never failing the whole import.
test("applySnapshotToDatabase: a transferred table missing from an older snapshot is left as-is, not an import failure", () =>
  withTempDir("snapshot-test-", async (dir) => {
    const source = await makeClient(dir, "source.db");
    await seedResearchChannel(source, "UCsource0000000000000001");
    const manifest = await exportSnapshot({ client: source, snapshotsDir: path.join(dir, "snapshots"), deviceId: "device-a", schemaVersion: 3 });
    const workingCopyPath = path.join(dir, "working-copy.db");
    await copyDatabaseConsistently(
      createClient({ url: `file:${path.join(dir, "snapshots", manifest.snapshotId, "data.db")}` }),
      workingCopyPath
    );
    await migrateStagedCopy(workingCopyPath);
    // Simulate the older build's scrub, which did not keep this table.
    const staged = createClient({ url: `file:${workingCopyPath}` });
    await staged.execute("DROP TABLE video_edit_audit_events");
    staged.close();

    const receiving = await makeClient(dir, "receiving.db");
    const columns = (await receiving.execute("PRAGMA table_info(video_edit_audit_events)")).rows.map((r) => String(r.name));
    assert.ok(columns.length > 0);
    await receiving.execute({
      sql: "INSERT INTO video_edit_audit_events (channel_id, video_id, event_type, detail_json) VALUES (?, ?, ?, ?)",
      args: ["UCreceiving000000000001", "v1", "APPLY", "{}"],
    });
    const before = (await receiving.execute("SELECT COUNT(*) AS n FROM video_edit_audit_events")).rows[0].n;
    assert.equal(before, 1);

    await applySnapshotToDatabase(receiving, workingCopyPath);

    const after = (await receiving.execute("SELECT COUNT(*) AS n FROM video_edit_audit_events")).rows[0].n;
    assert.equal(after, before);
    const channels = await receiving.execute("SELECT id FROM research_channels");
    assert.deepEqual(channels.rows.map((r) => r.id), ["UCsource0000000000000001"]);
    source.close();
    receiving.close();
  }));
