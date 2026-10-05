import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { aggregateCallsForExport, rowsToCalls, type LocalCall } from "./aggregate";
import { createQuotaLedgerSyncServices } from "./services";

const NOW = new Date("2026-10-03T18:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);
const call = (offset: number, over: Partial<LocalCall> = {}): LocalCall => ({
  occurredAt: T - offset,
  service: "data",
  method: "videos.update",
  units: 50,
  outcome: "ok",
  contextKind: "batch",
  contextId: "b1",
  contextLabel: "Batch b1",
  ...over,
});

test("aggregation: calls in the same minute, method, outcome and work collapse into ONE row with the right totals", () => {
  const minute = Math.floor(T / 60) * 60;
  const rows = aggregateCallsForExport([call(0, { occurredAt: minute }), call(0, { occurredAt: minute + 20 }), call(0, { occurredAt: minute + 59, units: null }), call(0, { occurredAt: minute + 60 })]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { t: minute, s: "data", m: "videos.update", o: "ok", u: 100, n: 3, k: 1, ck: "batch", ci: "b1", cl: "Batch b1" });
  assert.equal(rows[1].t, minute + 60);
});

test("aggregation keeps different methods, outcomes, services and works apart", () => {
  const minute = Math.floor(T / 60) * 60;
  const rows = aggregateCallsForExport([
    call(0, { occurredAt: minute, method: "videos.list", units: 1 }),
    call(0, { occurredAt: minute, outcome: "error", units: 1 }),
    call(0, { occurredAt: minute, service: "analytics", method: "reports.query", units: 1 }),
    call(0, { occurredAt: minute, contextId: "b2" }),
    call(0, { occurredAt: minute, contextKind: null, contextId: null, contextLabel: null }),
  ]);
  assert.equal(rows.length, 5);
});

test("rowsToCalls turns a bucket back into a weighted call marked as another device's", () => {
  const [one] = rowsToCalls([{ t: 120, s: "data", m: "videos.update", o: "ok", u: 150, n: 3, k: 0, ck: "batch", ci: "b9", cl: "Batch b9" }]);
  assert.deepEqual(one, { occurredAt: 120, method: "videos.update", units: 150, outcome: "ok", contextKind: "batch", contextId: "b9", contextLabel: "Batch b9", count: 3, unknownCount: 0, otherDevice: true });
});

async function withFolder(fn: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(path.join(tmpdir(), "quota-ledger-sync-"));
  try {
    await fn(folder);
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

function service(folder: string | null, deviceId: string, calls: LocalCall[]) {
  return createQuotaLedgerSyncServices({
    getConfig: async () => ({ deviceId, folder }),
    listLocalCalls: async () => calls,
    clock: { now: () => NOW },
  });
}

test("publish writes ONLY this device's file under <folder>/quota-ledger, atomically, and a second unchanged publish writes nothing", () =>
  withFolder(async (folder) => {
    const svc = service(folder, "dev-A", [call(10), call(70)]);
    assert.equal(await svc.publishLocal(), "published");
    const file = JSON.parse(await readFile(path.join(folder, "quota-ledger", "dev-A.json"), "utf8"));
    assert.equal(file.formatVersion, 1);
    assert.equal(file.deviceId, "dev-A");
    assert.equal(file.rows.reduce((sum: number, r: { n: number }) => sum + r.n, 0), 2);
    assert.equal(await svc.publishLocal(), "unchanged");
  }));

test("publish never creates the Syncthing folder: a missing folder or an unconfigured one is 'no_folder' and nothing is created", () =>
  withFolder(async (base) => {
    const missing = path.join(base, "unplugged-drive");
    assert.equal(await service(missing, "dev-A", [call(1)]).publishLocal(), "no_folder");
    assert.equal(await service(null, "dev-A", [call(1)]).publishLocal(), "no_folder");
    await assert.rejects(readFile(path.join(missing, "quota-ledger", "dev-A.json")));
  }));

test("a device id that could escape the folder is never used as a file name", () =>
  withFolder(async (folder) => {
    assert.equal(await service(folder, "../evil", [call(1)]).publishLocal(), "no_folder");
    assert.equal(await service(folder, "a/b", [call(1)]).publishLocal(), "no_folder");
  }));

test("readPeerCalls returns another device's rows for the asked service and window, and never this device's own file", () =>
  withFolder(async (folder) => {
    const peerRows = aggregateCallsForExport([call(100), call(100, { service: "analytics", method: "reports.query", units: 1 }), call(40 * 86400)]);
    await service(folder, "dev-B", []).publishLocal(); // folder exists
    await mkdir(path.join(folder, "quota-ledger"), { recursive: true });
    await writeFile(path.join(folder, "quota-ledger", "dev-B.json"), JSON.stringify({ formatVersion: 1, deviceId: "dev-B", writtenAt: NOW.toISOString(), rows: peerRows }));
    await service(folder, "dev-A", [call(5)]).publishLocal(); // own file

    const reader = service(folder, "dev-A", []);
    const data = await reader.readPeerCalls({ sinceSeconds: T - 86400, service: "data" });
    assert.equal(data.length, 1, "only the in-window data row of dev-B (not analytics, not the 40-day-old one, not dev-A's own)");
    assert.equal(data[0].otherDevice, true);
    assert.equal(data[0].units, 50);
    const analytics = await reader.readPeerCalls({ sinceSeconds: T - 86400, service: "analytics" });
    assert.equal(analytics.length, 1);
  }));

test("readPeerCalls ignores malformed, oversized-claim, wrong-device and non-json files without throwing", () =>
  withFolder(async (folder) => {
    const dir = path.join(folder, "quota-ledger");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "dev-bad.json"), "{not json");
    await writeFile(path.join(dir, "dev-wrong.json"), JSON.stringify({ formatVersion: 1, deviceId: "someone-else", writtenAt: "x", rows: aggregateCallsForExport([call(10)]) }));
    await writeFile(path.join(dir, "dev-future.json"), JSON.stringify({ formatVersion: 2, deviceId: "dev-future", writtenAt: "x", rows: [] }));
    await writeFile(path.join(dir, "notes.txt"), "hello");
    await writeFile(path.join(dir, "dev-ok.json"), JSON.stringify({ formatVersion: 1, deviceId: "dev-ok", writtenAt: "x", rows: aggregateCallsForExport([call(10)]) }));
    const calls = await service(folder, "dev-A", []).readPeerCalls({ sinceSeconds: 0, service: "data" });
    assert.equal(calls.length, 1, "only the well-formed file that names its own device counts");
  }));

test("readPeerCalls with no folder, or no quota-ledger directory yet, is simply empty", () =>
  withFolder(async (folder) => {
    assert.deepEqual(await service(null, "dev-A", []).readPeerCalls({ sinceSeconds: 0, service: "data" }), []);
    assert.deepEqual(await service(folder, "dev-A", []).readPeerCalls({ sinceSeconds: 0, service: "data" }), []);
  }));
