import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { initializeDatabaseSchema } from "../db";
import { exportHandoff, importHandoff } from "./services";
import {
  hasUnpublishedLocalChanges,
  LINEAGE_FILE_NAME,
  listSnapshotIdsStrict,
  readLineageState,
  SnapshotError,
  writeLineageState,
  type SqlExecutor,
} from "@/lib/snapshot";
import { withTempDir } from "@/test-support/temp-dir";

// Acceptance criteria: docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §5 (written before this code).

async function makeClient(dir: string, name: string): Promise<Client> {
  const client = createClient({ url: `file:${path.join(dir, name)}` });
  await initializeDatabaseSchema(client);
  return client;
}

async function addResearchChannel(client: SqlExecutor, id: string) {
  await client.execute({
    sql: "INSERT INTO research_channels (id, reason, created_via) VALUES (?, ?, ?)",
    args: [id, "competitor " + id, "web_ui"],
  });
}

async function researchIds(client: Client): Promise<string[]> {
  const result = await client.execute("SELECT id FROM research_channels ORDER BY id");
  return result.rows.map((row) => String(row.id));
}

function dirs(root: string) {
  return {
    snapshotsDir: path.join(root, "sync"),
    backups: path.join(root, "backups"),
    work: path.join(root, "work"),
  };
}

async function exportFrom(client: Client, root: string, deviceId: string) {
  return (await exportHandoff({ client, snapshotsDir: dirs(root).snapshotsDir, deviceId, schemaVersion: 36 })).manifest;
}

async function importInto(client: Client, root: string, snapshotId: string, extra: Partial<Parameters<typeof importHandoff>[0]> = {}) {
  const d = dirs(root);
  await mkdir(d.backups, { recursive: true });
  await mkdir(d.work, { recursive: true });
  return importHandoff({
    liveClient: client,
    snapshotDir: path.join(d.snapshotsDir, snapshotId),
    migrationBackupsDir: d.backups,
    workingDir: d.work,
    ...extra,
  });
}

// AC-AS-06
test("AC-AS-06: no lineage -- clean only while every transferred table is empty", () =>
  withTempDir("auto-sync-", async (dir) => {
    const client = await makeClient(dir, "a.db");
    assert.equal(await hasUnpublishedLocalChanges(client), false);
    await addResearchChannel(client, "UC1");
    assert.equal(await hasUnpublishedLocalChanges(client), true);
    client.close();
  }));

test("AC-AS-06: a lineage with an unknown (NULL) fingerprint is dirty", () =>
  withTempDir("auto-sync-", async (dir) => {
    const client = await makeClient(dir, "a.db");
    await writeLineageState(client, { lastSnapshotId: "00000000-0000-4000-8000-000000000001", lastGeneration: 3 });
    assert.equal(await hasUnpublishedLocalChanges(client), true);
    client.close();
  }));

// AC-AS-04 (mechanism half): export makes the device clean; a later change makes it dirty again.
test("AC-AS-04: export records the fingerprint, so the device is clean until the next change", () =>
  withTempDir("auto-sync-", async (dir) => {
    const client = await makeClient(dir, "a.db");
    await addResearchChannel(client, "UC1");
    await exportFrom(client, dir, "device-a");
    assert.equal(await hasUnpublishedLocalChanges(client), false);
    await addResearchChannel(client, "UC2");
    assert.equal(await hasUnpublishedLocalChanges(client), true);
    client.close();
  }));

// AC-AS-05
test("AC-AS-05: a change that lands after the export's copy was taken still reads as unpublished", () =>
  withTempDir("auto-sync-", async (dir) => {
    const client = await makeClient(dir, "a.db");
    await addResearchChannel(client, "UC1");
    let injected = false;
    const racing: SqlExecutor = {
      execute: async (query: Parameters<SqlExecutor["execute"]>[0]) => {
        const result = await client.execute(query as never);
        const sql = typeof query === "string" ? query : (query as { sql: string }).sql;
        if (!injected && /^VACUUM INTO/i.test(sql)) {
          injected = true;
          await addResearchChannel(client, "UC-raced");
        }
        return result;
      },
    } as SqlExecutor;
    await exportHandoff({ client: racing, snapshotsDir: dirs(dir).snapshotsDir, deviceId: "device-a", schemaVersion: 36 });
    assert.equal(injected, true, "test precondition: the race was actually injected");
    assert.equal(await hasUnpublishedLocalChanges(client), true);
    client.close();
  }));

// AC-AS-02 / AC-AS-03 / AC-AS-14
test("AC-AS-03: a clean device several generations behind imports the newest descendant directly", () =>
  withTempDir("auto-sync-", async (dir) => {
    const a = await makeClient(dir, "a.db");
    const b = await makeClient(dir, "b.db");
    await addResearchChannel(a, "UC1");
    const s1 = await exportFrom(a, dir, "device-a");

    assert.equal((await importInto(b, dir, s1.snapshotId)).status, "activated_normal");
    await addResearchChannel(b, "UC2");
    const s2 = await exportFrom(b, dir, "device-b");
    await addResearchChannel(b, "UC3");
    const s3 = await exportFrom(b, dir, "device-b");
    assert.equal(s2.parentSnapshotId, s1.snapshotId);
    assert.equal(s3.parentSnapshotId, s2.snapshotId);

    // A is clean at S1; S3 is not its direct child, but its ancestry contains S1.
    assert.equal(await hasUnpublishedLocalChanges(a), false);
    const result = await importInto(a, dir, s3.snapshotId);
    assert.equal(result.status, "activated_normal");
    assert.deepEqual(await researchIds(a), ["UC1", "UC2", "UC3"]);
    const lineage = await readLineageState(a);
    assert.equal(lineage.lastSnapshotId, s3.snapshotId);
    assert.deepEqual(lineage.ancestors?.slice(0, 2), [s2.snapshotId, s1.snapshotId]);
    // AC-AS-02: after the import the device is clean.
    assert.equal(await hasUnpublishedLocalChanges(a), false);
    a.close();
    b.close();
  }));

test("AC-AS-14: a snapshot without lineage.json (older build) is accepted only as a direct child", () =>
  withTempDir("auto-sync-", async (dir) => {
    const a = await makeClient(dir, "a.db");
    const b = await makeClient(dir, "b.db");
    await addResearchChannel(a, "UC1");
    const s1 = await exportFrom(a, dir, "device-a");
    await importInto(b, dir, s1.snapshotId);
    await addResearchChannel(b, "UC2");
    await exportFrom(b, dir, "device-b");
    await addResearchChannel(b, "UC3");
    const s3 = await exportFrom(b, dir, "device-b");

    // Rewrite S3 as an older build would have produced it: no lineage file in the manifest.
    const s3Dir = path.join(dirs(dir).snapshotsDir, s3.snapshotId);
    const manifest = JSON.parse(await readFile(path.join(s3Dir, "manifest.json"), "utf8"));
    manifest.files = manifest.files.filter((f: { path: string }) => f.path !== LINEAGE_FILE_NAME);
    await writeFile(path.join(s3Dir, "manifest.json"), JSON.stringify(manifest));

    await assert.rejects(
      () => importInto(a, dir, s3.snapshotId),
      (error: unknown) => error instanceof SnapshotError && error.code === "snapshot_divergent_lineage"
    );
    assert.deepEqual(await researchIds(a), ["UC1"]);
    a.close();
    b.close();
  }));

// AC-AS-12 (mechanism)
test("AC-AS-12: 'take theirs' imports a divergent snapshot only with the explicit flag, after a backup", () =>
  withTempDir("auto-sync-", async (dir) => {
    const a = await makeClient(dir, "a.db");
    const b = await makeClient(dir, "b.db");
    await addResearchChannel(a, "UC1");
    const s1 = await exportFrom(a, dir, "device-a");
    await importInto(b, dir, s1.snapshotId);
    await addResearchChannel(a, "UC-a");
    await exportFrom(a, dir, "device-a"); // A moves on
    await addResearchChannel(b, "UC-b");
    const sb = await exportFrom(b, dir, "device-b"); // B diverges from S1

    await assert.rejects(
      () => importInto(a, dir, sb.snapshotId),
      (error: unknown) => error instanceof SnapshotError && error.code === "snapshot_divergent_lineage"
    );
    const result = await importInto(a, dir, sb.snapshotId, { acceptDivergentLineage: true });
    assert.equal(result.status, "activated_normal");
    assert.deepEqual(await researchIds(a), ["UC-b", "UC1"]);
    const { readdir } = await import("node:fs/promises");
    assert.ok((await readdir(dirs(dir).backups)).some((name) => name.startsWith("pre-import-")));
    assert.equal(await hasUnpublishedLocalChanges(a), false);
    a.close();
    b.close();
  }));

// AC-AS-11 (mechanism)
test("AC-AS-11: 'keep mine' publishes a snapshot the other device sees as a fast-forward", () =>
  withTempDir("auto-sync-", async (dir) => {
    const a = await makeClient(dir, "a.db");
    const b = await makeClient(dir, "b.db");
    await addResearchChannel(a, "UC1");
    const s1 = await exportFrom(a, dir, "device-a");
    await importInto(b, dir, s1.snapshotId);
    await addResearchChannel(a, "UC-a");
    await addResearchChannel(b, "UC-b");
    const sb = await exportFrom(b, dir, "device-b");

    // A resolves the divergence by keeping its own data, superseding B's tip.
    const kept = (
      await exportHandoff({
        client: a,
        snapshotsDir: dirs(dir).snapshotsDir,
        deviceId: "device-a",
        schemaVersion: 36,
        supersede: { snapshotId: sb.snapshotId, generation: sb.generation, ancestors: [s1.snapshotId] },
      })
    ).manifest;
    assert.equal(kept.parentSnapshotId, sb.snapshotId);
    assert.ok(kept.generation > sb.generation);

    // B is clean at its own export, so A's snapshot is a fast-forward for it.
    assert.equal(await hasUnpublishedLocalChanges(b), false);
    assert.equal((await importInto(b, dir, kept.snapshotId)).status, "activated_normal");
    assert.deepEqual(await researchIds(b), ["UC-a", "UC1"]);
    a.close();
    b.close();
  }));

// AC-AS-07 (mechanism)
test("AC-AS-07: assertStillSafe runs inside the lock before the merge; throwing leaves the live DB unchanged", () =>
  withTempDir("auto-sync-", async (dir) => {
    const a = await makeClient(dir, "a.db");
    const b = await makeClient(dir, "b.db");
    await addResearchChannel(b, "UC-b");
    const sb = await exportFrom(b, dir, "device-b");
    await assert.rejects(
      () =>
        importInto(a, dir, sb.snapshotId, {
          assertStillSafe: async () => {
            throw new Error("local changed");
          },
        }),
      /local changed/
    );
    assert.deepEqual(await researchIds(a), []);
    assert.equal((await readLineageState(a)).lastSnapshotId, null);
    a.close();
    b.close();
  }));

// AC-AS-10
test("AC-AS-10: only UUID-named directories are listed as snapshots", () =>
  withTempDir("auto-sync-", async (dir) => {
    const root = path.join(dir, "sync");
    for (const name of ["change-drafts", ".staging-x", ".stfolder", "editorial-profile", "0b7f2c4e-1d2a-4c3b-9e8f-0123456789ab"]) {
      await mkdir(path.join(root, name), { recursive: true });
    }
    assert.deepEqual(await listSnapshotIdsStrict(root), ["0b7f2c4e-1d2a-4c3b-9e8f-0123456789ab"]);
  }));

// Review round 2 (#2): the checks and the lineage write happen INSIDE the merge transaction.
test("R2-2: assertStillSafe runs while the merge holds the write lock (another connection cannot write)", () =>
  withTempDir("auto-sync-", async (dir) => {
    const a = await makeClient(dir, "a.db");
    const b = await makeClient(dir, "b.db");
    await addResearchChannel(b, "UC-b");
    const sb = await exportFrom(b, dir, "device-b");
    const other = createClient({ url: `file:${path.join(dir, "a.db")}` });
    await other.execute("PRAGMA busy_timeout = 0");
    let otherWrite: "ok" | "busy" | null = null;
    await importInto(a, dir, sb.snapshotId, {
      assertStillSafe: async () => {
        try {
          await addResearchChannel(other, "UC-raced");
          otherWrite = "ok";
        } catch (error) {
          otherWrite = /BUSY|locked/i.test(String(error)) ? "busy" : "ok";
        }
      },
    });
    assert.equal(otherWrite, "busy");
    // And the fingerprint was recorded for exactly the merged content: the device is clean.
    assert.equal(await hasUnpublishedLocalChanges(a), false);
    other.close();
    a.close();
    b.close();
  }));

test("R2-2: a write landing between the backup and the merge aborts the import; nothing is replaced", () =>
  withTempDir("auto-sync-", async (dir) => {
    const a = await makeClient(dir, "a.db");
    const b = await makeClient(dir, "b.db");
    await addResearchChannel(b, "UC-b");
    const sb = await exportFrom(b, dir, "device-b");
    let injected = false;
    const racing: SqlExecutor = {
      execute: async (query: Parameters<SqlExecutor["execute"]>[0]) => {
        const sql = typeof query === "string" ? query : (query as { sql: string }).sql;
        if (!injected && /ATTACH DATABASE \? AS staged/i.test(sql)) {
          injected = true;
          await addResearchChannel(a, "UC-raced");
        }
        return a.execute(query as never);
      },
    } as SqlExecutor;
    const d = dirs(dir);
    await mkdir(d.backups, { recursive: true });
    await mkdir(d.work, { recursive: true });
    await assert.rejects(
      () =>
        importHandoff({
          liveClient: racing,
          snapshotDir: path.join(d.snapshotsDir, sb.snapshotId),
          migrationBackupsDir: d.backups,
          workingDir: d.work,
        }),
      (error: unknown) => error instanceof SnapshotError && error.code === "snapshot_local_changed_during_import"
    );
    assert.equal(injected, true);
    assert.deepEqual(await researchIds(a), ["UC-raced"]);
    a.close();
    b.close();
  }));
