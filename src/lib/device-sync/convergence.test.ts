import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
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

async function resolve(device: Device, action: "keep" | "take", snapshotId: string | null) {
  if (!snapshotId) return;
  try {
    if (action === "keep") await device.runner.keepMine(snapshotId);
    else await device.runner.takeTheirs(snapshotId);
  } catch {
    // Refused (e.g. no longer the current conflict) -- a legitimate outcome, nothing changed.
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

async function settleAndCheck(devices: Device[], syncAll: () => Promise<void>, label: string) {
  for (let round = 0; round < 6; round++) {
    await syncAll();
    for (const d of devices) await tick(d);
  }
  const contents = await Promise.all(devices.map((d) => ids(d.client)));
  const asking = devices.some((d) => d.status().notices.some((n) => n.kind === "divergence"));
  const identical = contents.every((c) => JSON.stringify(c) === JSON.stringify(contents[0]));
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
      await resolve(a, c.a as "keep" | "take", divergenceSnapshot(a));
      if (c.b !== "none") {
        if (!c.delayed) {
          await syncAll();
          await tick(b);
        }
        await resolve(b, c.b, c.delayed ? bTarget : divergenceSnapshot(b));
      }
      if (c.laterWork) await create(b, "UC-b-later");
      await settleAndCheck([a, b], syncAll, label);
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
    await resolve(a, "keep", divergenceSnapshot(a));
    await settleAndCheck([a, b, c], syncAll, "three computers");
    assert.deepEqual(await ids(c.client), ["UC-a", "UC1"]);
    for (const d of [a, b, c]) d.client.close();
  }));

test("round 2 #3: the computer that loses a 'keep mine' keeps a never-pruned backup of its data", () =>
  withTempDir("device-sync-conv-", async (root) => {
    const { a, b, syncAll } = await divergedPair(root);
    await resolve(a, "keep", divergenceSnapshot(a));
    await syncAll();
    await tick(b);
    assert.deepEqual(await ids(b.client), ["UC-a", "UC1"]);
    const names = await readdir(b.backups);
    assert.ok(names.some((n) => n.startsWith("pre-superseded-")), `expected a pre-superseded backup, got ${names.join(",")}`);
    a.client.close();
    b.client.close();
  }));
