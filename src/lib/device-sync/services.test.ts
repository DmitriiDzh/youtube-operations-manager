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

test("AC-AS-08: a running batch, recovery mode, or a held operation lock -> no import and no export", () =>
  withTempDir("device-sync-", async (root) => {
    const a = await makeDevice(root, "a");
    await addResearchChannel(a.client, "UC1");
    await a.client.execute("INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('c', 't', 'u')");

    await a.client.execute("INSERT INTO batches (id, channel_id, status) VALUES ('b1', 'c', 'RUNNING')");
    assert.equal((await a.runner.tick()).state, "busy");
    await a.client.execute("UPDATE batches SET status = 'COMPLETED' WHERE id = 'b1'");

    await a.client.execute(
      "INSERT INTO app_operation_locks (id, operation_type, holder_pid, acquired_at) VALUES ('singleton', 'export', 1, '2026-10-01T00:00:00Z')"
    );
    assert.equal((await a.runner.tick()).state, "busy");
    await a.client.execute("DELETE FROM app_operation_locks");

    await a.client.execute(
      "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES ('l1', 'b1', 'v', '[]', 'APPLYING')"
    );
    const status = await a.runner.tick();
    assert.equal(status.state, "busy");
    assert.equal(status.notices[0]?.kind, "recovery_mode");

    const exists = await readdir(path.join(root, "sync")).catch(() => []);
    assert.deepEqual(exists, []);
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
