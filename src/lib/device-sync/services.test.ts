import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { initializeDatabaseSchema, SCHEMA_CURRENT_VERSION } from "@/lib/db";
import { readLineageState } from "@/lib/snapshot";
import { withTempDir } from "@/test-support/temp-dir";
import { EMPTY_DEVICE_SYNC_STATUS, type DeviceSyncStatus, type SnapshotEntry } from "./contracts";
import { createDeviceSyncRunner, decideSyncAction, pruneAutoImportBackups, pruneOwnSnapshots } from "./services";

// Acceptance criteria: docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §5 (written before this code).

async function makeClient(dir: string, name: string): Promise<Client> {
  const client = createClient({ url: `file:${path.join(dir, name)}` });
  await initializeDatabaseSchema(client);
  return client;
}

async function addResearchChannel(client: Client, id: string) {
  await client.execute({
    sql: "INSERT INTO research_channels (id, reason, created_via) VALUES (?, ?, ?)",
    args: [id, "competitor " + id, "web_ui"],
  });
}

async function researchIds(client: Client): Promise<string[]> {
  const result = await client.execute("SELECT id FROM research_channels ORDER BY id");
  return result.rows.map((row) => String(row.id));
}

type Device = {
  client: Client;
  runner: ReturnType<typeof createDeviceSyncRunner>;
  status: () => DeviceSyncStatus;
  clock: { t: number };
  setEnabled: (v: boolean) => void;
};

async function makeDevice(root: string, name: string, opts: { folder?: string | null } = {}): Promise<Device> {
  const client = await makeClient(root, `${name}.db`);
  let status: DeviceSyncStatus = { ...EMPTY_DEVICE_SYNC_STATUS };
  let enabled = true;
  const clock = { t: Date.parse("2026-10-01T10:00:00Z") };
  const folder = opts.folder === undefined ? path.join(root, "sync") : opts.folder;
  // The configured sync folder exists (Syncthing created it); automatic sync never creates it.
  if (opts.folder === undefined && folder) await mkdir(folder, { recursive: true });
  const runner = createDeviceSyncRunner({
    client,
    currentSchemaVersion: SCHEMA_CURRENT_VERSION,
    resolveConfig: async () => ({ deviceId: `device-${name}`, folder }),
    migrationBackupsDir: path.join(root, `${name}-backups`),
    workingDir: path.join(root, `${name}-work`),
    isEnabled: async () => enabled,
    loadStatus: async () => status,
    saveStatus: async (s) => {
      status = s;
    },
    now: () => clock.t,
  });
  return { client, runner, status: () => status, clock, setEnabled: (v) => (enabled = v) };
}

/** Advances past the minimum export interval. */
function later(device: Device) {
  device.clock.t += 5 * 60_000;
}

// ---------------------------------------------------------------------------------------------
// Pure decision table (§3.2)
// ---------------------------------------------------------------------------------------------

function entry(id: string, parent: string | null, device: string, generation: number, ancestors: string[] | null = []): SnapshotEntry {
  return {
    snapshotId: id,
    parentSnapshotId: parent,
    sourceDeviceId: device,
    generation,
    schemaVersion: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    ancestors,
    supersedes: [],
  };
}

test("decide: clean + nothing newer -> idle; dirty + nothing newer -> export", () => {
  const base = { deviceId: "A", currentSchemaVersion: 1, local: { lastSnapshotId: "s1", ancestors: [] }, snapshots: [entry("s1", null, "A", 1)] };
  assert.equal(decideSyncAction({ ...base, localDirty: false }).kind, "idle");
  assert.equal(decideSyncAction({ ...base, localDirty: true }).kind, "export");
});

test("decide: clean + peer fast-forward -> import the newest tip, not an intermediate", () => {
  const d = decideSyncAction({
    deviceId: "A",
    currentSchemaVersion: 1,
    local: { lastSnapshotId: "s1", ancestors: [] },
    localDirty: false,
    snapshots: [entry("s1", null, "A", 1), entry("s2", "s1", "B", 2, ["s1"]), entry("s3", "s2", "B", 3, ["s2", "s1"])],
  });
  assert.equal(d.kind, "import");
  assert.equal(d.kind === "import" && d.snapshot.snapshotId, "s3");
});

test("AC-AS-01 (decision): dirty + peer fast-forward -> divergence, never import", () => {
  const d = decideSyncAction({
    deviceId: "A",
    currentSchemaVersion: 1,
    local: { lastSnapshotId: "s1", ancestors: [] },
    localDirty: true,
    snapshots: [entry("s1", null, "A", 1), entry("s2", "s1", "B", 2, ["s1"])],
  });
  assert.equal(d.kind, "divergence");
});

test("decide: clean + peer snapshot that does not continue local history -> divergence", () => {
  const d = decideSyncAction({
    deviceId: "A",
    currentSchemaVersion: 1,
    local: { lastSnapshotId: "a2", ancestors: ["s1"] },
    localDirty: false,
    snapshots: [entry("s1", null, "B", 1), entry("a2", "s1", "A", 2, ["s1"]), entry("b2", "s1", "B", 2, ["s1"])],
  });
  assert.equal(d.kind, "divergence");
});

test("decide: a peer snapshot already in local history is not 'newer' (legacy lineage via parent chain)", () => {
  // Legacy: no recorded ancestors at all; ancestry comes from walking parent pointers.
  const d = decideSyncAction({
    deviceId: "A",
    currentSchemaVersion: 1,
    local: { lastSnapshotId: "a3", ancestors: [] },
    localDirty: false,
    snapshots: [entry("b1", null, "B", 1, null), entry("a2", "b1", "A", 2, null), entry("a3", "a2", "A", 3, null)],
  });
  assert.equal(d.kind, "idle");
});

test("decide: an older-build catch-up step that needs a newer schema -> update_app, not a conflict", () => {
  const d = decideSyncAction({
    deviceId: "A",
    currentSchemaVersion: 1,
    local: { lastSnapshotId: "s1", ancestors: [] },
    localDirty: false,
    snapshots: [entry("s1", null, "A", 1), { ...entry("s2", "s1", "B", 2, null), schemaVersion: 5 }, entry("s3", "s2", "B", 3, null)],
  });
  assert.equal(d.kind, "update_app");
});

test("decide: a newer schema than this build -> update_app", () => {
  const newer = { ...entry("s2", "s1", "B", 2, ["s1"]), schemaVersion: 99 };
  const d = decideSyncAction({
    deviceId: "A",
    currentSchemaVersion: 1,
    local: { lastSnapshotId: "s1", ancestors: [] },
    localDirty: false,
    snapshots: [entry("s1", null, "A", 1), newer],
  });
  assert.equal(d.kind, "update_app");
});

// AC-AS-15
test("AC-AS-15: this device's own snapshots are never import candidates", () => {
  const d = decideSyncAction({
    deviceId: "A",
    currentSchemaVersion: 1,
    local: { lastSnapshotId: null, ancestors: [] },
    localDirty: false,
    snapshots: [entry("a1", null, "A", 1), entry("a2", "a1", "A", 2, ["a1"])],
  });
  assert.equal(d.kind, "idle");
});

// ---------------------------------------------------------------------------------------------
// Runner against real databases and a shared folder
// ---------------------------------------------------------------------------------------------

// AC-AS-04
test("AC-AS-04: a dirty device exports once; the next tick with no change exports nothing", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    assert.equal((await a.runner.tick()).state, "exported");
    const first = a.status().lastExportSnapshotId;
    later(a);
    const second = await a.runner.tick();
    assert.equal(second.state, "synced");
    assert.equal(second.lastExportSnapshotId, first);
    assert.equal((await readdir(path.join(root, "sync"))).length, 1);
    a.client.close();
  }));

test("AC-AS-04: exports are rate-limited to the minimum interval unless forced", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await addResearchChannel(a.client, "UC2");
    a.clock.t += 10_000;
    assert.equal((await a.runner.tick()).state, "waiting");
    assert.equal((await a.runner.tick({ force: true })).state, "exported");
    a.client.close();
  }));

// AC-AS-02
test("AC-AS-02: a clean device imports the other device's newer snapshot automatically", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    assert.equal((await b.runner.tick()).state, "imported");
    assert.deepEqual(await researchIds(b.client), ["UC1"]);

    await addResearchChannel(b.client, "UC2");
    later(b);
    assert.equal((await b.runner.tick()).state, "exported");
    assert.equal((await a.runner.tick()).state, "imported");
    assert.deepEqual(await researchIds(a.client), ["UC1", "UC2"]);
    // Clean afterwards: nothing more to do on either side.
    later(a);
    later(b);
    assert.equal((await a.runner.tick()).state, "synced");
    assert.equal((await b.runner.tick()).state, "synced");
    a.client.close();
    b.client.close();
  }));

// AC-AS-01
test("AC-AS-01: local unpublished changes are never overwritten by an automatic import", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick(); // b now at a's snapshot
    await addResearchChannel(b.client, "UC-b");
    later(b);
    await b.runner.tick(); // b publishes a direct child of a's head
    await addResearchChannel(a.client, "UC-a"); // meanwhile a changed locally

    const status = await a.runner.tick();
    assert.equal(status.state, "attention");
    assert.equal(status.notices[0]?.kind, "divergence");
    assert.deepEqual(await researchIds(a.client), ["UC-a", "UC1"]);
    a.client.close();
    b.client.close();
  }));

// AC-AS-11 / AC-AS-12 through the runner
test("AC-AS-11: 'keep mine' on A -> clean B fast-forwards to A's data automatically", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick();
    await addResearchChannel(b.client, "UC-b");
    later(b);
    await b.runner.tick();
    await addResearchChannel(a.client, "UC-a");
    const notice = (await a.runner.tick()).notices[0];
    assert.equal(notice?.kind, "divergence");

    await a.runner.keepMine(notice!.snapshotId!);
    later(a);
    assert.equal((await a.runner.tick()).state, "synced");
    assert.equal((await b.runner.tick()).state, "imported");
    assert.deepEqual(await researchIds(b.client), ["UC-a", "UC1"]);
    a.client.close();
    b.client.close();
  }));

test("AC-AS-12: 'take theirs' on A replaces A's data with B's, keeps a backup, and ends the divergence", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick();
    await addResearchChannel(b.client, "UC-b");
    later(b);
    await b.runner.tick();
    await addResearchChannel(a.client, "UC-a");
    const notice = (await a.runner.tick()).notices[0];

    await a.runner.takeTheirs(notice!.snapshotId!);
    assert.deepEqual(await researchIds(a.client), ["UC-b", "UC1"]);
    assert.ok((await readdir(path.join(root, "a-backups"))).some((n) => n.startsWith("pre-take-theirs-")));
    later(a);
    assert.equal((await a.runner.tick()).state, "synced");
    a.client.close();
    b.client.close();
  }));

test("AC-AS-12: 'take theirs' is refused in recovery mode and changes nothing", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(b.client, "UC-b");
    await b.runner.tick();
    const peer = (await readdir(path.join(root, "sync")))[0];
    await a.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    await a.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'COMPLETED')");
    await a.client.execute(
      "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES ('l1', 'b1', 'v', '[]', 'UNKNOWN')"
    );
    await assert.rejects(() => a.runner.takeTheirs(peer));
    assert.deepEqual(await researchIds(a.client), []);
    a.client.close();
    b.client.close();
  }));

test("keepMine / takeTheirs refuse an id that is not another device's snapshot in the folder", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    const own = a.status().lastExportSnapshotId!;
    await assert.rejects(() => a.runner.takeTheirs(own), /not in the sync folder/);
    await assert.rejects(() => a.runner.keepMine("0b7f2c4e-1d2a-4c3b-9e8f-0123456789ab"), /not in the sync folder/);
    a.client.close();
  }));

// AC-AS-08
test("AC-AS-08: toggle off or no folder -> a tick does nothing", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    a.setEnabled(false);
    assert.equal((await a.runner.tick()).state, "disabled");
    const n = await makeDevice(root, "n", { folder: null });
    await addResearchChannel(n.client, "UC1");
    assert.equal((await n.runner.tick()).state, "not_configured");
    await mkdir(path.join(root, "sync"), { recursive: true });
    assert.deepEqual(await readdir(path.join(root, "sync")), []);
    a.client.close();
    n.client.close();
  }));

// AC-AS-08, as revised by the cross-system audit (2026-10-01) and its review: a Batch prepared or
// running here (video_execution_locks), or any unfinished (`RUNNING`) batch in this computer's data,
// pauses automatic sync with a `batch_in_progress` notice -- never silently, never by publishing an
// executable copy. Recovery mode and a live operation lock still pause everything.
test("AC-AS-08: recovery mode or a live operation lock -> no import and no export", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    await a.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    await a.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'COMPLETED')");

    await a.client.execute({
      sql: "INSERT INTO app_operation_locks (id, operation_type, holder_pid, acquired_at) VALUES ('singleton', 'import', ?, '2026-10-01T00:00:00Z')",
      args: [process.pid],
    });
    assert.equal((await a.runner.tick()).state, "busy");
    await a.client.execute("DELETE FROM app_operation_locks");

    await a.client.execute(
      "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES ('l1', 'b1', 'v', '[]', 'APPLYING')"
    );
    const status = await a.runner.tick();
    assert.equal(status.state, "busy");
    assert.equal(status.notices[0]?.kind, "recovery_mode");
    assert.deepEqual(await readdir(path.join(root, "sync")), []);
    a.client.close();
  }));

// Revised after review of the audit fixes: exporting a prepared Batch would hand the other computer
// an executable copy (RUNNING + AWAITING_EXECUTION) without the per-video locks.
test("AC-AS-08: a Batch prepared on this computer pauses exports too, with a notice", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    await a.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    await a.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'RUNNING')");
    await a.client.execute(
      "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES ('l1', 'b1', 'v', '[]', 'AWAITING_EXECUTION')"
    );
    await a.client.execute("INSERT INTO video_execution_locks (video_id, batch_id, ledger_row_id) VALUES ('v', 'b1', 'l1')");
    const status = await a.runner.tick({ force: true });
    assert.equal(status.state, "busy");
    assert.equal(status.notices[0]?.kind, "batch_in_progress");
    assert.deepEqual(await readdir(path.join(root, "sync")), [], "nothing published while the Batch is prepared");
    // Finishing the Batch (locks released) resumes sync.
    await a.client.execute("DELETE FROM video_execution_locks");
    await a.client.execute("UPDATE batch_ledger_rows SET status = 'SUCCESS'");
    await a.client.execute("UPDATE batches SET status = 'COMPLETED'");
    assert.equal((await a.runner.tick({ force: true })).state, "exported");
    a.client.close();
  }));

test("AC-AS-08: a clean device with a prepared Batch never auto-imports; it says why", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(b.client, "UC-b");
    await b.runner.tick();
    // a: a batch prepared here (RUNNING + its lock), with a's lineage recording exactly this content
    // as clean -- the strongest case for an import: only the prepared Batch can stop it.
    await a.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    await a.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'RUNNING')");
    await a.client.execute(
      "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES ('l1', 'b1', 'v', '[]', 'AWAITING_EXECUTION')"
    );
    await a.client.execute("INSERT INTO video_execution_locks (video_id, batch_id, ledger_row_id) VALUES ('v', 'b1', 'l1')");
    const { computeContentFingerprint, writeLineageState } = await import("@/lib/snapshot");
    await writeLineageState(a.client, {
      lastSnapshotId: "0b7f2c4e-1d2a-4c3b-9e8f-0123456789ab",
      lastGeneration: 1,
      contentFingerprint: await computeContentFingerprint(a.client),
      ancestors: [],
    });
    const status = await a.runner.tick();
    assert.equal(status.state, "busy");
    assert.equal(status.notices[0]?.kind, "batch_in_progress");
    assert.deepEqual(await researchIds(a.client), []);
    a.client.close();
    b.client.close();
  }));

// Review of the audit fixes: `RUNNING` is set at claim time, seconds before Prepare takes the first
// per-video lock -- so a RUNNING batch WITHOUT locks may be a Prepare in progress. Never exported.
test("AC-AS-08: an unfinished (RUNNING) batch is never exported, even before any lock exists", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await a.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    await a.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'RUNNING')");
    const status = await a.runner.tick();
    assert.equal(status.state, "busy");
    assert.equal(status.notices[0]?.kind, "batch_in_progress");
    assert.deepEqual(await readdir(path.join(root, "sync")), []);
    await a.client.execute("UPDATE batches SET status = 'COMPLETED'");
    assert.equal((await a.runner.tick({ force: true })).state, "exported");
    a.client.close();
  }));

test("audit: a lock left by a dead export process is cleared by the next tick", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    await a.client.execute(
      "INSERT INTO app_operation_locks (id, operation_type, holder_pid, acquired_at) VALUES ('singleton', 'export', 2147483000, '2026-10-01T00:00:00Z')"
    );
    assert.equal((await a.runner.tick()).state, "exported");
    a.client.close();
  }));

// AC-AS-09
test("AC-AS-09: a snapshot still being transferred is silently retried, and only noticed after the grace period", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(b.client, "UC-b");
    await b.runner.tick();
    const id = (await readdir(path.join(root, "sync")))[0];
    // Simulate Syncthing not having delivered data.db yet.
    await rm(path.join(root, "sync", id, "data.db"));

    let status = await a.runner.tick();
    assert.equal(status.state, "waiting");
    assert.deepEqual(status.notices, []);
    assert.deepEqual(await researchIds(a.client), []);

    a.clock.t += 11 * 60_000;
    status = await a.runner.tick();
    assert.equal(status.notices[0]?.kind, "transfer_stuck");
    assert.deepEqual(await researchIds(a.client), []);
    a.client.close();
    b.client.close();
  }));

test("AC-AS-09: an unreadable manifest is pending, not an error", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const dir = path.join(root, "sync", "0b7f2c4e-1d2a-4c3b-9e8f-0123456789ab");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), "{ partial");
    const status = await a.runner.tick();
    assert.equal(status.state, "waiting");
    assert.deepEqual(status.notices, []);
    a.client.close();
  }));

// AC-AS-13
test("AC-AS-13: retention keeps this device's newest 5 and its head, never another device's", () =>
  withTempDir("device-sync-", async (root) => {
    const folder = path.join(root, "sync");
    const snapshots: SnapshotEntry[] = [];
    for (let g = 1; g <= 8; g++) {
      const id = `0000000${g}-0000-4000-8000-000000000000`;
      await mkdir(path.join(folder, id), { recursive: true });
      snapshots.push(entry(id, null, "A", g));
    }
    const peerId = "99999999-0000-4000-8000-000000000000";
    await mkdir(path.join(folder, peerId), { recursive: true });
    snapshots.push(entry(peerId, null, "B", 1));
    const head = snapshots[0].snapshotId; // an old one that is still the head

    const removed = await pruneOwnSnapshots({ folder, deviceId: "A", headSnapshotId: head, snapshots });
    const left = new Set(await readdir(folder));
    assert.equal(removed.length, 2);
    assert.ok(left.has(peerId));
    assert.ok(left.has(head));
    for (let g = 4; g <= 8; g++) assert.ok(left.has(`0000000${g}-0000-4000-8000-000000000000`));
  }));

test("AC-AS-13: backup retention prunes only automatic-import backups", () =>
  withTempDir("device-sync-", async (dir) => {
    const names = [
      ...Array.from({ length: 12 }, (_, i) => `pre-auto-import-${1000 + i}-abcdef01.db`),
      "pre-import-1-abcdef01.db",
      "pre-take-theirs-1-abcdef01.db",
    ];
    for (const name of names) await writeFile(path.join(dir, name), "");
    const removed = await pruneAutoImportBackups(dir);
    assert.deepEqual(removed.sort(), ["pre-auto-import-1000-abcdef01.db", "pre-auto-import-1001-abcdef01.db"]);
    const left = await readdir(dir);
    assert.ok(left.includes("pre-import-1-abcdef01.db"));
    assert.ok(left.includes("pre-take-theirs-1-abcdef01.db"));
  }));

test("an automatic import records the new head and leaves the device clean", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick();
    assert.equal((await readLineageState(b.client)).lastSnapshotId, a.status().lastExportSnapshotId);
    a.client.close();
    b.client.close();
  }));

test("exportOnly (idle-shutdown flush) exports pending changes but never imports", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(b.client, "UC-b");
    await b.runner.tick();
    await a.runner.tick({ force: true, exportOnly: true });
    assert.deepEqual(await researchIds(a.client), []);

    await addResearchChannel(b.client, "UC-b2");
    b.clock.t += 10_000; // inside the minimum interval: the flush is forced anyway
    assert.equal((await b.runner.tick({ force: true, exportOnly: true })).state, "exported");
    a.client.close();
    b.client.close();
  }));

// Found in the live two-server run: the computer that looked FIRST saw no conflict at all.
test("a divergence is visible on BOTH computers, and 'take theirs' on either one settles both", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick();
    await addResearchChannel(a.client, "UC-a");
    await addResearchChannel(b.client, "UC-b");
    later(a);
    later(b);
    assert.equal((await a.runner.tick()).state, "exported"); // a looks first: nothing newer yet
    const bStatus = await b.runner.tick(); // b sees a's snapshot while dirty -> conflict, publishes its own
    assert.equal(bStatus.notices[0]?.kind, "divergence");
    later(a);
    const aStatus = await a.runner.tick();
    assert.equal(aStatus.notices[0]?.kind, "divergence", "a must see the conflict too");
    assert.deepEqual(await researchIds(a.client), ["UC-a", "UC1"]);
    assert.deepEqual(await researchIds(b.client), ["UC-b", "UC1"]);

    // b resolves by taking a's data; a must then settle without another question.
    await b.runner.takeTheirs(bStatus.notices[0]!.snapshotId!);
    later(a);
    later(b);
    const aAfter = await a.runner.tick();
    assert.deepEqual(aAfter.notices, []);
    assert.deepEqual(await researchIds(a.client), ["UC-a", "UC1"]);
    assert.deepEqual(await researchIds(b.client), ["UC-a", "UC1"]);
    assert.equal((await b.runner.tick()).state, "synced");
    later(a);
    assert.equal((await a.runner.tick()).state, "synced");
    a.client.close();
    b.client.close();
  }));

test("'keep mine' on the computer that looked first settles both", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick();
    await addResearchChannel(a.client, "UC-a");
    await addResearchChannel(b.client, "UC-b");
    later(a);
    later(b);
    await a.runner.tick();
    await b.runner.tick();
    later(a);
    const aStatus = await a.runner.tick();
    await a.runner.keepMine(aStatus.notices[0]!.snapshotId!);
    later(b);
    assert.equal((await b.runner.tick()).state, "imported");
    assert.deepEqual(await researchIds(b.client), ["UC-a", "UC1"]);
    later(a);
    assert.equal((await a.runner.tick()).state, "synced");
    later(b);
    assert.equal((await b.runner.tick()).state, "synced");
    a.client.close();
    b.client.close();
  }));

// ---------------------------------------------------------------------------------------------
// Review round 1 findings (each test states the scenario the reviewer derived from the plan)
// ---------------------------------------------------------------------------------------------

// R1-1, as revised after review round 2: when one side resolves ("take theirs") and the other keeps
// working before it sees the resolution, the accepted behavior is FAIL-CLOSED -- a new conflict
// prompt, never a silent overwrite. Automatically converging this case would need content-identity
// tracking the round-2 review showed to be unsafe under concurrent resolutions; deferred (RISK-89).
test("R1-1: 'take theirs' on B while A keeps working -> a new prompt, never a silent overwrite", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick();
    await addResearchChannel(a.client, "UC-a");
    await addResearchChannel(b.client, "UC-b");
    later(a);
    later(b);
    await a.runner.tick();
    const bNotice = (await b.runner.tick()).notices[0];
    assert.equal(bNotice?.kind, "divergence");
    await b.runner.takeTheirs(bNotice!.snapshotId!);
    await addResearchChannel(a.client, "UC-a2"); // A keeps working before it sees B's marker

    for (let i = 0; i < 3; i++) {
      later(a);
      later(b);
      await a.runner.tick();
      await b.runner.tick();
    }
    const aIds = await researchIds(a.client);
    const bIds = await researchIds(b.client);
    assert.deepEqual(aIds, ["UC-a", "UC-a2", "UC1"], "A's newest work is never lost");
    const prompted = [a.status(), b.status()].some((st) => st.notices.some((n) => n.kind === "divergence"));
    assert.ok(prompted || JSON.stringify(aIds) === JSON.stringify(bIds), "either converged or a human is asked");
    a.client.close();
    b.client.close();
  }));

test("R1-2 (AC-AS-14): an older-build chain without lineage.json is caught up one direct child at a time", () => {
  const snapshots = [entry("s1", null, "A", 1), entry("s2", "s1", "B", 2, null), entry("s3", "s2", "B", 3, null)];
  const d = decideSyncAction({
    deviceId: "A",
    currentSchemaVersion: 1,
    local: { lastSnapshotId: "s1", ancestors: [] },
    localDirty: false,
    snapshots,
  });
  assert.equal(d.kind, "import");
  assert.equal(d.kind === "import" && d.snapshot.snapshotId, "s2");
  const next = decideSyncAction({
    deviceId: "A",
    currentSchemaVersion: 1,
    local: { lastSnapshotId: "s2", ancestors: [] },
    localDirty: false,
    snapshots,
  });
  assert.equal(next.kind === "import" && next.snapshot.snapshotId, "s3");
});

test("R1-3: 'keep mine' settles every conflicting tip at once, not only the one named", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    const c = await makeDevice(root, "c");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick();
    await c.runner.tick();
    await addResearchChannel(b.client, "UC-b");
    await addResearchChannel(c.client, "UC-c");
    later(b);
    later(c);
    await b.runner.tick();
    await c.runner.tick(); // c sees b's snapshot while dirty: conflict, publishes its own branch
    later(a);
    const aStatus = await a.runner.tick();
    assert.equal(aStatus.notices[0]?.kind, "divergence");
    await a.runner.keepMine(aStatus.notices[0]!.snapshotId!);
    later(a);
    assert.deepEqual((await a.runner.tick()).notices, []);
    for (const peer of [b, c]) {
      later(peer);
      await peer.runner.tick();
      assert.deepEqual(await researchIds(peer.client), ["UC1"]);
    }
    a.client.close();
    b.client.close();
    c.client.close();
  }));

test("R1-4: the idle-shutdown flush still publishes local changes while a conflict is open", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick();
    await addResearchChannel(a.client, "UC-a");
    await addResearchChannel(b.client, "UC-b");
    later(b);
    await b.runner.tick();
    const before = a.status().lastExportSnapshotId;
    const flushed = await a.runner.tick({ force: true, exportOnly: true });
    assert.equal(flushed.notices[0]?.kind, "divergence");
    assert.ok(flushed.lastExportSnapshotId && flushed.lastExportSnapshotId !== before, "the flush published a new snapshot");
    assert.deepEqual(await researchIds(a.client), ["UC-a", "UC1"]);
    a.client.close();
    b.client.close();
  }));

test("R1-5: overlapping actions on one runner run one after another", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    const [first, second] = await Promise.all([a.runner.tick({ force: true }), a.runner.tick({ force: true })]);
    assert.equal(first.state, "exported");
    assert.equal(second.state, "synced");
    assert.equal((await readdir(path.join(root, "sync"))).length, 1);
    a.client.close();
  }));

test("R2-4: a snapshot whose data needs a newer schema is tried once, then reported without retrying", () =>
  withTempDir("device-sync-", async (root) => {
    const { readFile, writeFile: write } = await import("node:fs/promises");
    const { sha256File } = await import("@/lib/snapshot");
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(b.client, "UC-b");
    await b.runner.tick();
    const id = (await readdir(path.join(root, "sync")))[0];
    const dir = path.join(root, "sync", id);
    // The manifest still claims a readable schema, but the data itself is from a newer build.
    const c = createClient({ url: `file:${path.join(dir, "data.db")}` });
    await c.execute("UPDATE schema_meta SET value = '9999' WHERE key = 'schema_version'");
    c.close();
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    const entry = manifest.files.find((f: { path: string }) => f.path === "data.db");
    Object.assign(entry, await sha256File(path.join(dir, "data.db")));
    await write(path.join(dir, "manifest.json"), JSON.stringify(manifest));

    const first = await a.runner.tick();
    assert.equal(first.notices[0]?.kind, "update_app");
    assert.deepEqual(first.unsupportedSnapshotIds, [id]);
    const backupsAfterFirst = await readdir(path.join(root, "a-backups")).catch(() => []);
    later(a);
    const second = await a.runner.tick();
    assert.equal(second.notices[0]?.kind, "update_app");
    assert.deepEqual(await readdir(path.join(root, "a-backups")).catch(() => []), backupsAfterFirst);
    assert.deepEqual(await researchIds(a.client), []);

    // Review round 3: after an app update, the remembered failure no longer applies -- tried again.
    let saved = a.status();
    const updated = createDeviceSyncRunner({
      client: a.client,
      currentSchemaVersion: SCHEMA_CURRENT_VERSION + 1,
      resolveConfig: async () => ({ deviceId: "device-a", folder: path.join(root, "sync") }),
      migrationBackupsDir: path.join(root, "a-backups"),
      workingDir: path.join(root, "a-work"),
      isEnabled: async () => true,
      loadStatus: async () => saved,
      saveStatus: async (s) => {
        saved = s;
      },
    });
    const retried = await updated.tick();
    assert.equal(retried.unsupportedForSchemaVersion, SCHEMA_CURRENT_VERSION + 1, "retried under the new build");
    a.client.close();
    b.client.close();
  }));

// Review round 4 (#2): the runner's OWN in-lock re-check (AC-AS-07), not a stub. A write that lands
// before the pre-import backup is in the backup, so only this re-check can stop the merge.
test("R4-2 (AC-AS-07): a local write landing after the decision stops the automatic import", () =>
  withTempDir("device-sync-", async (root) => {
    const b = await makeDevice(root, "b");
    await addResearchChannel(b.client, "UC-b");
    await b.runner.tick();

    const aClient = createClient({ url: `file:${path.join(root, "a.db")}` });
    await initializeDatabaseSchema(aClient);
    let injected = false;
    const racing = {
      execute: async (query: unknown) => {
        const sql = typeof query === "string" ? query : (query as { sql: string }).sql;
        if (!injected && /^VACUUM INTO/i.test(sql)) {
          injected = true;
          await addResearchChannel(aClient, "UC-local");
        }
        return aClient.execute(query as never);
      },
    };
    let status: DeviceSyncStatus = { ...EMPTY_DEVICE_SYNC_STATUS };
    const runner = createDeviceSyncRunner({
      client: racing as never,
      currentSchemaVersion: SCHEMA_CURRENT_VERSION,
      resolveConfig: async () => ({ deviceId: "device-a", folder: path.join(root, "sync") }),
      migrationBackupsDir: path.join(root, "a-backups"),
      workingDir: path.join(root, "a-work"),
      isEnabled: async () => true,
      loadStatus: async () => status,
      saveStatus: async (s) => {
        status = s;
      },
    });
    const result = await runner.tick();
    assert.equal(injected, true, "precondition: the write raced the import");
    assert.deepEqual(await researchIds(aClient), ["UC-local"], "the local write survives; nothing was replaced");
    assert.equal(result.notices[0]?.kind, "divergence");
    aClient.close();
    b.client.close();
  }));

test("R4-3 (AC-AS-09): a checksum mismatch (Syncthing mid-transfer) is silently retried, noticed only after the grace period", () =>
  withTempDir("device-sync-", async (root) => {
    const { appendFile } = await import("node:fs/promises");
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(b.client, "UC-b");
    await b.runner.tick();
    const id = (await readdir(path.join(root, "sync")))[0];
    await appendFile(path.join(root, "sync", id, "data.db"), Buffer.from("partial"));

    let status = await a.runner.tick();
    assert.equal(status.state, "waiting");
    assert.deepEqual(status.notices, []);
    assert.deepEqual(await researchIds(a.client), []);
    a.clock.t += 11 * 60_000;
    status = await a.runner.tick();
    assert.equal(status.notices[0]?.kind, "transfer_stuck");
    assert.deepEqual(await researchIds(a.client), []);
    a.client.close();
    b.client.close();
  }));

// Pre-merge check: the owner's sync folder lives on an external drive.
test("an unplugged drive: a tick never creates the sync folder and does nothing", () =>
  withTempDir("device-sync-", async (root) => {
    const missing = path.join(root, "Volumes", "Unplugged Drive", "Sync");
    const a = await makeDevice(root, "a", { folder: missing });
    await addResearchChannel(a.client, "UC1");
    const status = await a.runner.tick({ force: true });
    assert.equal(status.state, "folder_unreachable");
    assert.deepEqual(status.notices, []);
    await assert.rejects(() => readdir(path.join(root, "Volumes")));
    a.client.close();
  }));

test("R5 note: the in-lock re-check also stops an import on a device that already has a recorded fingerprint", () =>
  withTempDir("device-sync-", async (root) => {
    await mkdir(path.join(root, "sync"), { recursive: true });
    const aClient = createClient({ url: `file:${path.join(root, "a.db")}` });
    await initializeDatabaseSchema(aClient);
    let armed = false;
    let injected = false;
    const racing = {
      execute: async (query: unknown) => {
        const sql = typeof query === "string" ? query : (query as { sql: string }).sql;
        if (armed && !injected && /^VACUUM INTO/i.test(sql)) {
          injected = true;
          await addResearchChannel(aClient, "UC-local-late");
        }
        return aClient.execute(query as never);
      },
    };
    let status: DeviceSyncStatus = { ...EMPTY_DEVICE_SYNC_STATUS };
    const clock = { t: Date.parse("2026-10-01T10:00:00Z") };
    const a = createDeviceSyncRunner({
      client: racing as never,
      currentSchemaVersion: SCHEMA_CURRENT_VERSION,
      resolveConfig: async () => ({ deviceId: "device-a", folder: path.join(root, "sync") }),
      migrationBackupsDir: path.join(root, "a-backups"),
      workingDir: path.join(root, "a-work"),
      isEnabled: async () => true,
      loadStatus: async () => status,
      saveStatus: async (s) => {
        status = s;
      },
      now: () => clock.t,
    });
    await addResearchChannel(aClient, "UC1");
    assert.equal((await a.tick()).state, "exported"); // a now has a recorded fingerprint
    const b = await makeDevice(root, "b");
    await b.runner.tick(); // b imports a's snapshot
    await addResearchChannel(b.client, "UC-b");
    later(b);
    await b.runner.tick(); // b publishes a direct child

    armed = true;
    clock.t += 5 * 60_000;
    const result = await a.tick();
    assert.equal(injected, true, "precondition: the write raced the import");
    assert.deepEqual(await researchIds(aClient), ["UC-local-late", "UC1"]);
    assert.equal(result.notices[0]?.kind, "divergence");
    aClient.close();
    b.client.close();
  }));

test("round 6: with the drive gone, resolutions refuse with folder_unreachable and create nothing", () =>
  withTempDir("device-sync-", async (root) => {
    const missing = path.join(root, "Volumes", "Unplugged Drive", "Sync");
    const a = await makeDevice(root, "a", { folder: missing });
    const id = "0b7f2c4e-1d2a-4c3b-9e8f-0123456789ab";
    await assert.rejects(() => a.runner.keepMine(id), (e: unknown) => (e as { code?: string }).code === "device_sync_folder_unreachable");
    await assert.rejects(() => a.runner.takeTheirs(id), (e: unknown) => (e as { code?: string }).code === "device_sync_folder_unreachable");
    await assert.rejects(() => readdir(path.join(root, "Volumes")));
    a.client.close();
  }));

test("round 6: an automatic export into a folder that vanished fails instead of recreating it", () =>
  withTempDir("device-sync-", async (root) => {
    const { exportHandoff } = await import("@/lib/device-handoff");
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    const gone = path.join(root, "Volumes", "Ejected", "Sync");
    await assert.rejects(() =>
      exportHandoff({ client: a.client, snapshotsDir: gone, deviceId: "device-a", schemaVersion: SCHEMA_CURRENT_VERSION, createSnapshotsDir: false })
    );
    await assert.rejects(() => readdir(path.join(root, "Volumes")));
    a.client.close();
  }));

test("round 7: a drive ejected after the tick's first check -> folder_unreachable via the in-lock re-check", () =>
  withTempDir("device-sync-", async (root) => {
    const folder = path.join(root, "sync");
    await mkdir(folder, { recursive: true });
    const aClient = createClient({ url: `file:${path.join(root, "a.db")}` });
    await initializeDatabaseSchema(aClient);
    await addResearchChannel(aClient, "UC1");
    let ejected = false;
    const ejecting = {
      execute: async (query: unknown) => {
        const sql = typeof query === "string" ? query : (query as { sql: string }).sql;
        if (!ejected && /INSERT INTO app_operation_locks/i.test(sql)) {
          ejected = true;
          await rm(folder, { recursive: true, force: true });
        }
        return aClient.execute(query as never);
      },
    };
    let status: DeviceSyncStatus = { ...EMPTY_DEVICE_SYNC_STATUS };
    const runner = createDeviceSyncRunner({
      client: ejecting as never,
      currentSchemaVersion: SCHEMA_CURRENT_VERSION,
      resolveConfig: async () => ({ deviceId: "device-a", folder }),
      migrationBackupsDir: path.join(root, "a-backups"),
      workingDir: path.join(root, "a-work"),
      isEnabled: async () => true,
      loadStatus: async () => status,
      saveStatus: async (s) => {
        status = s;
      },
    });
    const result = await runner.tick({ force: true });
    assert.equal(ejected, true, "precondition: the folder vanished after the first check");
    assert.equal(result.state, "folder_unreachable");
    assert.deepEqual(result.notices, []);
    await assert.rejects(() => readdir(folder));
    aClient.close();
  }));

test("audit: an export whose copy catches a YouTube write mid-flight is not published", () =>
  withTempDir("device-sync-", async (root) => {
    const aClient = createClient({ url: `file:${path.join(root, "a.db")}` });
    await initializeDatabaseSchema(aClient);
    await mkdir(path.join(root, "sync"), { recursive: true });
    await aClient.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    // COMPLETED, so the injected APPLYING row is the ONLY reason to refuse (a RUNNING batch is refused
    // on its own since 71a35b6).
    await aClient.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'COMPLETED')");
    await aClient.execute(
      "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES ('l1', 'b1', 'v', '[]', 'PENDING')"
    );
    let injected = false;
    const midWrite = {
      execute: async (query: unknown) => {
        const sql = typeof query === "string" ? query : (query as { sql: string }).sql;
        if (!injected && /^VACUUM INTO/i.test(sql)) {
          injected = true;
          await aClient.execute("UPDATE batch_ledger_rows SET status = 'APPLYING' WHERE id = 'l1'");
        }
        return aClient.execute(query as never);
      },
    };
    let status: DeviceSyncStatus = { ...EMPTY_DEVICE_SYNC_STATUS };
    const runner = createDeviceSyncRunner({
      client: midWrite as never,
      currentSchemaVersion: SCHEMA_CURRENT_VERSION,
      resolveConfig: async () => ({ deviceId: "device-a", folder: path.join(root, "sync") }),
      migrationBackupsDir: path.join(root, "a-backups"),
      workingDir: path.join(root, "a-work"),
      isEnabled: async () => true,
      loadStatus: async () => status,
      saveStatus: async (s) => {
        status = s;
      },
    });
    const result = await runner.tick({ force: true });
    assert.equal(injected, true, "precondition: a row went APPLYING during the copy");
    assert.equal(result.state, "busy");
    assert.deepEqual((await readdir(path.join(root, "sync"))).filter((n) => !n.startsWith(".")), []);
    aClient.close();
  }));

test("final review: leftover locks of an ABORTED batch (pre-existing leak) do not pause sync", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    await a.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    await a.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'ABORTED')");
    await a.client.execute(
      "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES ('l1', 'b1', 'v', '[]', 'ABORTED_SYSTEMIC')"
    );
    await a.client.execute("INSERT INTO video_execution_locks (video_id, batch_id, ledger_row_id) VALUES ('v', 'b1', 'l1')");
    assert.equal((await a.runner.tick({ force: true })).state, "exported");
    a.client.close();
  }));

test("final review: the unfinished-Batch notice never advises executing it here", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await a.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    await a.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'RUNNING')");
    const status = await a.runner.tick({ force: true });
    assert.equal(status.notices[0]?.kind, "batch_in_progress");
    // The origin of a Batch cannot be told from transferred data: the notice never advises executing it.
    assert.match(status.notices[0]!.message, /started on another computer, finish it there/);
    assert.doesNotMatch(status.notices[0]!.message, /Execute/);
    a.client.close();
  }));

test("review: an identity-aborted batch (ABORTED, rows still AWAITING_EXECUTION) is never exported", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    await a.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    await a.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'ABORTED')");
    await a.client.execute(
      "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES ('l1', 'b1', 'v', '[]', 'AWAITING_EXECUTION')"
    );
    const status = await a.runner.tick({ force: true });
    assert.equal(status.state, "busy");
    assert.equal(status.notices[0]?.kind, "batch_in_progress");
    assert.deepEqual(await readdir(path.join(root, "sync")), []);
    a.client.close();
  }));

test("review: 'take theirs' is refused while a Batch is being claimed here (RUNNING, no lock yet)", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await a.runner.tick();
    await b.runner.tick();
    await addResearchChannel(a.client, "UC-a");
    await addResearchChannel(b.client, "UC-b");
    later(a);
    later(b);
    await a.runner.tick();
    const notice = (await b.runner.tick()).notices.find((n) => n.kind === "divergence");
    assert.ok(notice, "precondition: b sees the conflict");
    await b.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");
    await b.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'RUNNING')");
    await assert.rejects(() => b.runner.takeTheirs(notice!.snapshotId!), (e: unknown) => (e as { code?: string }).code === "device_sync_busy");
    assert.deepEqual(await researchIds(b.client), ["UC-b", "UC1"]);
    a.client.close();
    b.client.close();
  }));

// Phase 13 review round 1 (#2): the YouTube-API 30-day purge runs on every computer by the same
// rule, so it must not turn an in-sync device into one with "unpublished changes" (which would make
// the next snapshot from the other computer a divergence instead of an import).
async function purgeLikeProduction(client: Client, now: Date) {
  // The exact hooks `runApiDataRetention` uses in production (review round 2).
  const { purgeExpiredApiData, createSyncPreservingPurgeHooks } = await import("@/lib/youtube-data-policy");
  await purgeExpiredApiData(client, now, createSyncPreservingPurgeHooks(client));
}

async function addOldApiSnapshot(client: Client, id: string, observedAt: Date) {
  await client.execute({
    sql: "INSERT INTO market_channel_snapshots (id, research_channel_id, observed_at, hidden_subscriber_count, source, created_via) VALUES (?, 'UC1', ?, 0, 'youtube.channels.list', 'web_ui')",
    args: [id, Math.floor(observedAt.getTime() / 1000)],
  });
}

test("13.2 x device sync: an in-sync device stays clean after the purge and still imports the other computer's next snapshot", () =>
  withTempDir("device-sync-", async (root) => {
    const { hasUnpublishedLocalChanges } = await import("@/lib/snapshot");
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    await addResearchChannel(a.client, "UC1");
    await addOldApiSnapshot(a.client, "old-snap", new Date("2026-08-01T00:00:00Z"));
    await a.runner.tick();
    await b.runner.tick(); // b imports, including the soon-expired row
    assert.equal(await hasUnpublishedLocalChanges(b.client), false);

    await purgeLikeProduction(b.client, new Date("2026-10-01T12:00:00Z"));
    assert.equal(await hasUnpublishedLocalChanges(b.client), false, "the purge alone is not a local change");

    await addResearchChannel(a.client, "UC2");
    later(a);
    await a.runner.tick();
    later(b);
    assert.equal((await b.runner.tick()).state, "imported");
    assert.deepEqual(await researchIds(b.client), ["UC1", "UC2"]);
    a.client.close();
    b.client.close();
  }));

test("13.2 x device sync: a device with real unpublished changes stays dirty through the purge", () =>
  withTempDir("device-sync-", async (root) => {
    const { hasUnpublishedLocalChanges } = await import("@/lib/snapshot");
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    await addOldApiSnapshot(a.client, "old-snap", new Date("2026-08-01T00:00:00Z"));
    await a.runner.tick();
    await addResearchChannel(a.client, "UC-local");
    await purgeLikeProduction(a.client, new Date("2026-10-01T12:00:00Z"));
    assert.equal(await hasUnpublishedLocalChanges(a.client), true);
    a.client.close();
  }));

// Phase 13 (owner msg 1139): own snapshots older than 30 days leave the sync folder even within the
// keep count; the head and other devices' snapshots never do.
test("P13: own snapshots created before the cutoff are pruned, except the head", () =>
  withTempDir("device-sync-", async (root) => {
    const folder = path.join(root, "sync");
    const mk = async (id: string, device: string, generation: number, createdAt: string) => {
      await mkdir(path.join(folder, id), { recursive: true });
      return { ...entry(id, null, device, generation), createdAt };
    };
    const oldHead = await mk("00000001-0000-4000-8000-000000000000", "A", 1, "2026-08-01T00:00:00.000Z");
    const oldOwn = await mk("00000002-0000-4000-8000-000000000000", "A", 2, "2026-08-02T00:00:00.000Z");
    const freshOwn = await mk("00000003-0000-4000-8000-000000000000", "A", 3, "2026-09-25T00:00:00.000Z");
    const oldPeer = await mk("00000004-0000-4000-8000-000000000000", "B", 1, "2026-08-01T00:00:00.000Z");
    const removed = await pruneOwnSnapshots({
      folder,
      deviceId: "A",
      headSnapshotId: oldHead.snapshotId,
      snapshots: [oldHead, oldOwn, freshOwn, oldPeer],
      olderThan: new Date("2026-09-01T00:00:00.000Z"),
    });
    assert.deepEqual(removed, [oldOwn.snapshotId]);
    const left = new Set(await readdir(folder));
    for (const kept of [oldHead, freshOwn, oldPeer]) assert.ok(left.has(kept.snapshotId));
  }));
