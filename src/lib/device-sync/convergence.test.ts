import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { initializeDatabaseSchema, SCHEMA_CURRENT_VERSION } from "@/lib/db";
import { withTempDir } from "@/test-support/temp-dir";
import { EMPTY_DEVICE_SYNC_STATUS, type DeviceSyncStatus } from "./contracts";
import { createDeviceSyncRunner } from "./services";

// Review round 2: every earlier runner test shared ONE folder, so "propagation" was instant and no
// ordering race could ever show. Here each device has its own folder and a Syncthing-like
// `syncAll` copies new snapshot directories and applies deletions only when called -- so the
// resolution protocol is exercised under delayed delivery. The invariant (plan §1/§3.6, AGENTS.md
// "never overwrite silently"): after things settle, EITHER every device holds identical transferred
// content and shows nothing, OR at least one device asks a human. Never "synced" with different
// data. And no row a device ever created disappears without a backup that still holds it.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Device = {
  name: string;
  client: Client;
  folder: string;
  backups: string;
  runner: ReturnType<typeof createDeviceSyncRunner>;
  status: () => DeviceSyncStatus;
  clock: { t: number };
  created: string[];
};

async function makeDevice(root: string, name: string): Promise<Device> {
  const client = createClient({ url: `file:${path.join(root, `${name}.db`)}` });
  await initializeDatabaseSchema(client);
  const folder = path.join(root, `${name}-sync`);
  const backups = path.join(root, `${name}-backups`);
  await mkdir(folder, { recursive: true });
  let status: DeviceSyncStatus = { ...EMPTY_DEVICE_SYNC_STATUS };
  const clock = { t: Date.parse("2026-10-01T10:00:00Z") };
  const runner = createDeviceSyncRunner({
    client,
    currentSchemaVersion: SCHEMA_CURRENT_VERSION,
    resolveConfig: async () => ({ deviceId: `device-${name}`, folder }),
    migrationBackupsDir: backups,
    workingDir: path.join(root, `${name}-work`),
    isEnabled: async () => true,
    loadStatus: async () => status,
    saveStatus: async (next) => {
      status = next;
    },
    now: () => clock.t,
  });
  return { name, client, folder, backups, runner, status: () => status, clock, created: [] };
}

async function snapshotDirs(folder: string): Promise<Set<string>> {
  return new Set((await readdir(folder)).filter((n) => UUID_RE.test(n)));
}

/** Syncthing-like two-way sync of every pair: a directory present on one side only is copied,
 * unless both sides had it at the previous sync (then it was deleted and the deletion propagates). */
function makeNetwork(devices: Device[]) {
  const lastSeen = new Map<string, Set<string>>();
  async function syncPair(x: Device, y: Device) {
    const key = `${x.name}|${y.name}`;
    const seen = lastSeen.get(key) ?? new Set<string>();
    const inX = await snapshotDirs(x.folder);
    const inY = await snapshotDirs(y.folder);
    for (const id of new Set([...inX, ...inY])) {
      if (inX.has(id) && inY.has(id)) continue;
      const [has, lacks] = inX.has(id) ? [x, y] : [y, x];
      if (seen.has(id)) await rm(path.join(has.folder, id), { recursive: true, force: true });
      else await cp(path.join(has.folder, id), path.join(lacks.folder, id), { recursive: true });
    }
    lastSeen.set(key, await snapshotDirs(x.folder));
  }
  return async function syncAll() {
    for (let i = 0; i < devices.length; i++) for (let j = i + 1; j < devices.length; j++) await syncPair(devices[i], devices[j]);
  };
}

async function ids(client: Client): Promise<string[]> {
  return (await client.execute("SELECT id FROM research_channels ORDER BY id")).rows.map((r) => String(r.id));
}

async function create(device: Device, id: string) {
  await device.client.execute({
    sql: "INSERT INTO research_channels (id, reason, created_via) VALUES (?, 'r', 'web_ui')",
    args: [id],
  });
  device.created.push(id);
}

async function tick(device: Device) {
  device.clock.t += 5 * 60_000;
  return device.runner.tick();
}

function divergenceSnapshot(device: Device): string | null {
  return device.status().notices.find((n) => n.kind === "divergence")?.snapshotId ?? null;
}

/** `mustSucceed`: the first resolution of a conflict must work -- a refusal or error there is a
 * failure, never silently tolerated (review round 3: a swallowed error let the whole matrix pass
 * even with resolutions that did nothing). A second computer's resolution may be legitimately
 * refused once the conflict it names is no longer current. */
async function resolve(device: Device, action: "keep" | "take", snapshotId: string | null, mustSucceed: boolean) {
  if (!snapshotId) {
    assert.ok(!mustSucceed, `${device.name}: no conflict to resolve`);
    return;
  }
  try {
    if (action === "keep") await device.runner.keepMine(snapshotId);
    else await device.runner.takeTheirs(snapshotId);
  } catch (error) {
    if (mustSucceed) throw error;
    assert.match(String(error), /no longer the one in conflict|not in the sync folder/);
  }
}

async function backupIds(device: Device): Promise<Set<string>> {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = await readdir(device.backups);
  } catch {
    return out;
  }
  for (const name of names.filter((n) => n.endsWith(".db"))) {
    const c = createClient({ url: `file:${path.join(device.backups, name)}` });
    try {
      for (const id of await ids(c)) out.add(id);
    } catch {
      // not a DB with that table
    } finally {
      c.close();
    }
  }
  return out;
}

async function settleAndCheck(devices: Device[], syncAll: () => Promise<void>, label: string, mustConverge = false) {
  for (let round = 0; round < 6; round++) {
    await syncAll();
    for (const d of devices) await tick(d);
  }
  const contents = await Promise.all(devices.map((d) => ids(d.client)));
  const asking = devices.some((d) => d.status().notices.some((n) => n.kind === "divergence"));
  const identical = contents.every((c) => JSON.stringify(c) === JSON.stringify(contents[0]));
  if (mustConverge) {
    assert.ok(identical && !asking, `${label}: must converge without asking again, got ${devices.map((d, i) => `${d.name}=${contents[i].join(",")}`).join(" ")} asking=${asking}`);
  }
  assert.ok(
    asking || identical,
    `${label}: devices settled "synced" with different data: ${devices.map((d, i) => `${d.name}=${contents[i].join(",")}`).join(" ")}`
  );
  if (identical && !asking) {
    for (const d of devices) assert.deepEqual(d.status().notices, [], `${label}: ${d.name} has leftover notices`);
  }
  for (const [i, d] of devices.entries()) {
    const kept = new Set([...contents[i], ...(await backupIds(d))]);
    for (const id of d.created) assert.ok(kept.has(id), `${label}: ${d.name} lost ${id} with no backup holding it`);
  }
}

/** Common start: A and B share S1, then both change data and each has seen the other's snapshot. */
async function divergedPair(root: string) {
  const a = await makeDevice(root, "a");
  const b = await makeDevice(root, "b");
  const syncAll = makeNetwork([a, b]);
  await create(a, "UC1");
  await tick(a);
  await syncAll();
  await tick(b);
  await create(a, "UC-a");
  await create(b, "UC-b");
  await tick(a);
  await tick(b);
  await syncAll();
  await tick(a);
  await tick(b);
  return { a, b, syncAll };
}

type Action = "keep" | "take" | "none";
const MATRIX: Array<{ a: Action; b: Action; delayed: boolean; laterWork: boolean }> = [];
for (const a of ["keep", "take"] as const)
  for (const b of ["keep", "take", "none"] as const)
    for (const delayed of [false, true]) for (const laterWork of [false, true]) MATRIX.push({ a, b, delayed, laterWork });

for (const c of MATRIX) {
  const label = `A=${c.a} B=${c.b} ${c.delayed ? "simultaneous" : "sequential"}${c.laterWork ? " +B keeps working" : ""}`;
  test(`convergence: ${label}`, () =>
    withTempDir("device-sync-conv-", async (root) => {
      const { a, b, syncAll } = await divergedPair(root);
      assert.ok(divergenceSnapshot(a) && divergenceSnapshot(b), "precondition: both computers show the conflict");
      const bTarget = divergenceSnapshot(b);
      await resolve(a, c.a as "keep" | "take", divergenceSnapshot(a), true);
      if (c.b !== "none") {
        if (!c.delayed) {
          await syncAll();
          await tick(b);
        }
        await resolve(b, c.b, c.delayed ? bTarget : divergenceSnapshot(b), false);
      }
      if (c.laterWork) await create(b, "UC-b-later");
      // Only a SIMULTANEOUS second resolution, or B working before it saw A's resolution, is allowed
      // to end in a new prompt (RISK-89). Everything else must converge on its own (AC-AS-11/12).
      // (With B=none, B never looked before working, so "+B keeps working" is that accepted case.)
      const mustConverge = c.b === "none" ? !c.laterWork : !c.delayed;
      await settleAndCheck([a, b], syncAll, label, mustConverge);
      a.client.close();
      b.client.close();
    }));
}

test("convergence: a third, passive computer follows a 'keep mine' resolution", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    const c = await makeDevice(root, "c");
    const syncAll = makeNetwork([a, b, c]);
    await create(a, "UC1");
    await tick(a);
    await syncAll();
    await tick(b);
    await tick(c);
    await create(a, "UC-a");
    await create(b, "UC-b");
    await tick(a);
    await tick(b);
    await syncAll();
    await tick(a);
    await resolve(a, "keep", divergenceSnapshot(a), true);
    await settleAndCheck([a, b, c], syncAll, "three computers", true);
    assert.deepEqual(await ids(c.client), ["UC-a", "UC1"]);
    for (const d of [a, b, c]) d.client.close();
  }));

test("round 2 #3: the computer that loses a 'keep mine' keeps a never-pruned backup of its data", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b, syncAll } = await divergedPair(root);
    await resolve(a, "keep", divergenceSnapshot(a), true);
    await syncAll();
    await tick(b);
    assert.deepEqual(await ids(b.client), ["UC-a", "UC1"]);
    const names = await readdir(b.backups);
    assert.ok(names.some((n) => n.startsWith("pre-superseded-")), `expected a pre-superseded backup, got ${names.join(",")}`);
    a.client.close();
    b.client.close();
  }));

// ---------------------------------------------------------------------------------------------
// False divergences (owner request, Telegram 2026-10-06, msgs 1758/1764): two computers whose data
// ended up IDENTICAL after a fork (both ran the same automatic job, both applied the same app
// update) must not ask a human which of two equal copies to keep. Adopting the other computer's
// snapshot as the lineage head changes no row, so nothing can be lost. Different content must still
// ask, exactly as before (DEVICE_AUTO_SYNC_PLAN.md §3.6). Expected outcomes below are stated from
// that requirement, not read off the implementation (AGENTS.md §L).
// ---------------------------------------------------------------------------------------------

/** The same row on any computer: every column given, so no per-device default (time) differs. */
async function createSame(device: Device, id: string) {
  await device.client.execute({
    sql: "INSERT INTO research_channels (id, reason, created_via, added_at) VALUES (?, 'r', 'web_ui', 1790000000)",
    args: [id],
  });
  device.created.push(id);
}

/** A and B share S1, then BOTH make the identical change and each publishes it on its own branch. */
async function identicalFork(root: string) {
  const a = await makeDevice(root, "a");
  const b = await makeDevice(root, "b");
  const syncAll = makeNetwork([a, b]);
  await createSame(a, "UC1");
  await tick(a);
  await syncAll();
  await tick(b);
  await createSame(a, "UC-same");
  await createSame(b, "UC-same");
  await tick(a);
  await tick(b);
  return { a, b, syncAll };
}

test("AC-FD-01: a fork whose two sides hold identical data settles on both computers without asking or publishing", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b, syncAll } = await identicalFork(root);
    const before = new Set([...(await snapshotDirs(a.folder)), ...(await snapshotDirs(b.folder))]);
    assert.equal(before.size, 3, "precondition: S1 plus one branch per computer");
    await settleAndCheck([a, b], syncAll, "identical fork", true);
    const after = new Set([...(await snapshotDirs(a.folder)), ...(await snapshotDirs(b.folder))]);
    assert.deepEqual([...after].sort(), [...before].sort(), "settling an identical fork publishes nothing new");
    for (const d of [a, b]) assert.deepEqual(await ids(d.client), ["UC-same", "UC1"]);
    a.client.close();
    b.client.close();
  }));

test("AC-FD-02: after an identical fork settles, the next real change still fast-forwards both ways", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b, syncAll } = await identicalFork(root);
    await settleAndCheck([a, b], syncAll, "identical fork", true);
    await create(a, "UC-after");
    await settleAndCheck([a, b], syncAll, "change after settling", true);
    assert.deepEqual(await ids(b.client), ["UC-after", "UC-same", "UC1"]);
    await create(b, "UC-after-b");
    await settleAndCheck([a, b], syncAll, "change back the other way", true);
    assert.deepEqual(await ids(a.client), ["UC-after", "UC-after-b", "UC-same", "UC1"]);
    a.client.close();
    b.client.close();
  }));

test("AC-FD-03: a fork whose sides differ still asks a human, on both computers", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b } = await divergedPair(root);
    assert.ok(divergenceSnapshot(a), "A must ask");
    assert.ok(divergenceSnapshot(b), "B must ask");
    a.client.close();
    b.client.close();
  }));

test("AC-FD-04: an identical fork where one side changes again settles without asking: the other side takes the change", () =>
  withTempDir("device-sync-conv-", async (root) => {
    // Independent review, round 1 (#1): the first version asked B forever about A's branch -- whose
    // content equals B's own head -- and "take theirs" there deleted B's new row on both computers.
    // There is no conflict in this data: A's side holds nothing B does not have.
    const { a, b, syncAll } = await identicalFork(root);
    await create(b, "UC-b-extra");
    await settleAndCheck([a, b], syncAll, "identical fork, then B changed", true);
    for (const d of [a, b]) assert.deepEqual(await ids(d.client), ["UC-b-extra", "UC-same", "UC1"], d.name);
    a.client.close();
    b.client.close();
  }));

test("AC-FD-04: an identical fork where BOTH sides then change differently still asks", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b, syncAll } = await identicalFork(root);
    await create(a, "UC-a-extra");
    await create(b, "UC-b-extra");
    for (let round = 0; round < 4; round++) {
      await syncAll();
      await tick(a);
      await tick(b);
    }
    assert.ok(divergenceSnapshot(a) || divergenceSnapshot(b), "a real difference must reach a human");
    await settleAndCheck([a, b], syncAll, "identical fork, then both changed");
    a.client.close();
    b.client.close();
  }));

test("AC-FD-04b: after an identical fork settles, each computer's head is still its own snapshot (retention keeps it)", () =>
  withTempDir("device-sync-conv-", async (root) => {
    // Review round 1 (#3): retention protects only a device's own head; a head that is the OTHER
    // computer's snapshot left neither computer protecting the current data in the folder.
    const { a, b, syncAll } = await identicalFork(root);
    await settleAndCheck([a, b], syncAll, "identical fork", true);
    for (const d of [a, b]) {
      const head = String((await d.client.execute("SELECT last_snapshot_id FROM snapshot_lineage")).rows[0].last_snapshot_id);
      const manifest = JSON.parse(await readFile(path.join(d.folder, head, "manifest.json"), "utf8"));
      assert.equal(manifest.sourceDeviceId, `device-${d.name}`, `${d.name}'s head is its own snapshot`);
    }
    a.client.close();
    b.client.close();
  }));

test("AC-FD-04c: a third, clean computer that sees two identical branches settles without asking", () =>
  withTempDir("device-sync-conv-", async (root) => {
    // Review round 1 (#2).
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    const c = await makeDevice(root, "c");
    const syncAll = makeNetwork([a, b, c]);
    await createSame(a, "UC1");
    await tick(a);
    await syncAll();
    await tick(b);
    await tick(c);
    await createSame(a, "UC-same");
    await createSame(b, "UC-same");
    await tick(a);
    await tick(b);
    await settleAndCheck([a, b, c], syncAll, "three computers, identical fork", true);
    assert.deepEqual(await ids(c.client), ["UC-same", "UC1"]);
    for (const d of [a, b, c]) d.client.close();
  }));

test("AC-FD-04d: 'keep mine' on A and 'take theirs' on B at the same time leave the same data -> settles without asking again", () =>
  withTempDir("device-sync-conv-", async (root) => {
    // RISK-89 used to accept a re-prompt here; both resolutions picked A's data, so there is nothing to ask.
    const { a, b, syncAll } = await divergedPair(root);
    const aTarget = divergenceSnapshot(a);
    const bTarget = divergenceSnapshot(b);
    await resolve(a, "keep", aTarget, true);
    await resolve(b, "take", bTarget, true);
    await settleAndCheck([a, b], syncAll, "keep on A + take on B, simultaneous", true);
    for (const d of [a, b]) assert.deepEqual(await ids(d.client), ["UC-a", "UC1"], d.name);
    a.client.close();
    b.client.close();
  }));

test("AC-FD-05: settling an identical fork replaces nothing, so it takes no backup and imports nothing", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b, syncAll } = await identicalFork(root);
    const listBackups = async (d: Device) => {
      try {
        return (await readdir(d.backups)).filter((n) => n.endsWith(".db")).sort();
      } catch {
        return [];
      }
    };
    const before = await Promise.all([a, b].map(listBackups));
    const importsBefore = [a, b].map((d) => d.status().lastImportSnapshotId);
    await settleAndCheck([a, b], syncAll, "identical fork", true);
    assert.deepEqual(await Promise.all([a, b].map(listBackups)), before, "no new backup on either computer");
    assert.deepEqual([a, b].map((d) => d.status().lastImportSnapshotId), importsBefore, "no import ran");
    a.client.close();
    b.client.close();
  }));

test("AC-FD-11: 'sync before a background write' takes the other computer's fresh data first, then allows the write", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const a = await makeDevice(root, "a");
    const b = await makeDevice(root, "b");
    const syncAll = makeNetwork([a, b]);
    await create(a, "UC1");
    await tick(a);
    await syncAll();
    await tick(b);
    await create(a, "UC-fresh");
    await tick(a);
    await syncAll();
    b.clock.t += 5 * 60_000;
    const verdict = await b.runner.syncBeforeBackgroundWrite();
    assert.equal(verdict.allowed, true);
    assert.deepEqual(await ids(b.client), ["UC-fresh", "UC1"], "B holds A's data before writing anything");
    a.client.close();
    b.client.close();
  }));

test("AC-FD-11: with a real conflict open, 'sync before a background write' says wait", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b } = await divergedPair(root);
    b.clock.t += 5 * 60_000;
    const verdict = await b.runner.syncBeforeBackgroundWrite();
    assert.equal(verdict.allowed, false);
    a.client.close();
    b.client.close();
  }));

test("AC-FD-12: the divergence preview says, per section, what only this computer has, what only the other has, and what differs", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b, syncAll } = await divergedPair(root);
    // B also edits a row both computers share: the same id with different content is "changed".
    await b.client.execute("UPDATE research_channels SET reason = 'edited on b' WHERE id = 'UC1'");
    await tick(b);
    await syncAll();
    await tick(a);
    const target = divergenceSnapshot(a);
    assert.ok(target);
    const lineageBefore = (await a.client.execute("SELECT * FROM snapshot_lineage")).rows;
    const foldersBefore = [...(await snapshotDirs(a.folder))].sort();

    const preview = await a.runner.divergencePreview(target);
    assert.equal(preview.peer.snapshotId, target);
    assert.equal(preview.peer.sourceDeviceId, "device-b");
    assert.equal(preview.peerTips, 1);
    const research = preview.sections.find((s) => s.section === "Research");
    assert.deepEqual(
      { onlyHere: research?.onlyHere, onlyThere: research?.onlyThere, changed: research?.changed },
      { onlyHere: 1, onlyThere: 1, changed: 1 },
      "UC-a only here, UC-b only there, UC1 edited on b"
    );
    for (const section of ["Batches", "Audit", "Decisions"]) {
      const s = preview.sections.find((x) => x.section === section);
      assert.deepEqual({ onlyHere: s?.onlyHere, onlyThere: s?.onlyThere, changed: s?.changed }, { onlyHere: 0, onlyThere: 0, changed: 0 }, section);
    }
    assert.ok(preview.commonBase, "both histories start from S1, which is still in the folder");

    // Read-only: nothing published, lineage untouched.
    assert.deepEqual([...(await snapshotDirs(a.folder))].sort(), foldersBefore);
    assert.deepEqual((await a.client.execute("SELECT * FROM snapshot_lineage")).rows, lineageBefore);
    a.client.close();
    b.client.close();
  }));

test("AC-FD-12: the preview refuses a snapshot that is not a current conflict", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b } = await divergedPair(root);
    await assert.rejects(() => a.runner.divergencePreview("00000000-0000-4000-8000-000000000000"), /no longer the one in conflict|not in the sync folder/);
    a.client.close();
    b.client.close();
  }));

test("AC-FD-11: a skipped background write is recorded in the status (shown by the bell), and cleared once allowed", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b } = await divergedPair(root);
    b.clock.t += 5 * 60_000;
    assert.equal((await b.runner.syncBeforeBackgroundWrite()).allowed, false);
    assert.ok(b.status().backgroundWritesPausedReason, "the reason is visible");
    const solo = await makeDevice(root, "solo");
    await solo.runner.syncBeforeBackgroundWrite();
    assert.equal(solo.status().backgroundWritesPausedReason ?? null, null);
    for (const d of [a, b, solo]) d.client.close();
  }));
