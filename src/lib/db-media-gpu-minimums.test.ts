import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import { drizzle } from "drizzle-orm/libsql";
import {
  countMediaGpuAvailabilityCells,
  getLatestMediaGpuAvailabilityAt,
  initializeDatabaseSchema,
  insertMediaGpuAvailabilitySnapshot,
  listMediaGpuAvailabilityLog,
  listMediaGpuAvailabilityMinimums,
  SCHEMA_MIGRATIONS,
  summarizeMediaGpuAvailabilityLog,
  type AppDb,
} from "@/lib/db";
import { DEFAULT_MEDIA_SETTINGS } from "@/lib/media-generation/contracts";
import { createGpuAvailabilityLogServices } from "@/lib/media-generation/gpu-availability-log";
import { createGpuStatsServices } from "@/lib/media-generation/gpu-stats";

// BL-208 (docs/roadmap/plans/GPU_START_FIXES_PLAN.md §F, AC-SF-10/11; FO-MSG-0020), written before the code, on a real migrated
// database in a temp folder. Expected values are worked out by hand in the comments; nothing is read back from the code under test.

async function withDb(run: (database: AppDb, client: Client) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-media-gpu-minimums-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb, client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const row = (minCudaVersion: string, dataCenterId: string, stock: string | null) => ({ gpuTypeId: "X", dataCenterId, stock, pricePerHr: 0.69, minCudaVersion });
const at = (minutes: number) => new Date(Date.parse("2026-10-21T10:00:00Z") + minutes * 60_000);

function services(database: AppDb, settingsMin: "12.8" | null = "12.8") {
  const settings = { ...DEFAULT_MEDIA_SETTINGS, minCudaVersion: settingsMin };
  const log = createGpuAvailabilityLogServices({
    store: {
      latestAt: (min) => getLatestMediaGpuAvailabilityAt(database, min),
      insertSnapshot: (when, rows) => insertMediaGpuAvailabilitySnapshot(when, rows, database),
      list: (filter) => listMediaGpuAvailabilityLog(filter, database),
      summarize: (filter) => summarizeMediaGpuAvailabilityLog(filter, database),
      minimums: (range) => listMediaGpuAvailabilityMinimums(range, database),
    },
    base: {
      getGatewayEnabled: async () => false,
      getCredentialsStatus: async () => ({ configured: false, reason: "no_credentials" }),
      getSettings: async () => settings,
      resolveRunpodClient: async () => {
        throw new Error("no RunPod in this test");
      },
    },
    clock: { now: () => at(60) },
  });
  const stats = createGpuStatsServices({
    store: {
      availabilityCells: (filter) => countMediaGpuAvailabilityCells(filter, database),
      sessionsFirstApprovedBetween: async () => [],
      availabilityMinimums: (range) => listMediaGpuAvailabilityMinimums(range, database),
    },
    candidateSettings: async () => settings,
    clock: { now: () => at(60) },
  });
  return { log, stats };
}

/**
 * 4 ticks (10:00, :15, :30, :45), each with a 12.8 and a 13.0 snapshot of GPU X:
 *   12.8: overall HIGH, HIGH, LOW, LOW; datacenter A LOW only in the first tick (NONE implied in the other three).
 *   13.0: overall NONE ×4; datacenter A LOW in all four.
 * Under 12.8: 4 snapshots (not 8); X/* = { HIGH: 2, LOW: 2 }; X/A = { LOW: 1, NONE: 3 }.
 * Under 13.0: 4 snapshots; X/* = { NONE: 4 }; X/A = { LOW: 4 }.
 */
async function fourTicks(database: AppDb): Promise<void> {
  const overall128 = ["HIGH", "HIGH", "LOW", "LOW"];
  for (let tick = 0; tick < 4; tick++) {
    await insertMediaGpuAvailabilitySnapshot(at(tick * 15), [row("12.8", "*", overall128[tick]), ...(tick === 0 ? [row("12.8", "A", "LOW")] : [])], database);
    await insertMediaGpuAvailabilitySnapshot(at(tick * 15), [row("13.0", "*", "NONE"), row("13.0", "A", "LOW")], database);
  }
}

test("AC-SF-10: the summary over 4 ticks with both minimums counts 4 snapshots (not 8) under 12.8, the stock only from the 12.8 rows", () =>
  withDb(async (database) => {
    await fourTicks(database);
    const { log } = services(database);
    const under128 = await log.listGpuAvailabilityLog({ summary: true, minCudaVersion: "12.8" });
    assert.ok("summary" in under128);
    assert.equal(under128.minCudaVersion, "12.8");
    assert.deepEqual(under128.minCudaVersions, ["12.8", "13.0"]);
    assert.deepEqual(under128.summary, {
      snapshots: 4,
      firstAt: "2026-10-21T10:00:00.000Z",
      lastAt: "2026-10-21T10:45:00.000Z",
      entries: [
        { gpuTypeId: "X", dataCenterId: "*", snapshots: 4, stock: { HIGH: 2, LOW: 2 } },
        { gpuTypeId: "X", dataCenterId: "A", snapshots: 4, stock: { LOW: 1, NONE: 3 } },
      ],
    });
    const under130 = await log.listGpuAvailabilityLog({ summary: true, minCudaVersion: "13.0" });
    assert.ok("summary" in under130);
    assert.equal(under130.summary.snapshots, 4);
    assert.deepEqual(under130.summary.entries, [
      { gpuTypeId: "X", dataCenterId: "*", snapshots: 4, stock: { NONE: 4 } },
      { gpuTypeId: "X", dataCenterId: "A", snapshots: 4, stock: { LOW: 4 } },
    ]);
  }));

test("AC-SF-10: without the input the Settings minimum (12.8) is used and echoed; rows and lastSnapshotAt are of that minimum only", () =>
  withDb(async (database) => {
    await fourTicks(database);
    const { log } = services(database);
    const plain = await log.listGpuAvailabilityLog({ summary: true });
    assert.ok("summary" in plain);
    assert.equal(plain.minCudaVersion, "12.8");
    assert.equal(plain.summary.snapshots, 4);
    assert.deepEqual(plain.summary.entries.find((e) => e.dataCenterId === "A")?.stock, { LOW: 1, NONE: 3 });
    const rows = await log.listGpuAvailabilityLog({});
    assert.ok("rows" in rows);
    // 12.8: 4 overall rows + 1 datacenter row.
    assert.equal(rows.rows.length, 5);
    assert.ok(rows.rows.every((r) => r.minCudaVersion === "12.8"));
    assert.equal(rows.lastSnapshotAt, "2026-10-21T10:45:00.000Z");
  }));

test("AC-SF-10: factory_media_get_gpu_stats counts one minimum too -- 4 snapshots, X in A in stock 1 of 4 under 12.8 (default), 4 of 4 under 13.0", () =>
  withDb(async (database) => {
    await fourTicks(database);
    const { stats } = services(database);
    const window = { from: "2026-10-21T09:00:00Z", to: "2026-10-21T11:00:00Z", dataCenterIds: ["A"] };
    const byDefault = await stats.getGpuStats(window);
    assert.equal(byDefault.minCudaVersion, "12.8");
    assert.deepEqual(byDefault.minCudaVersions, ["12.8", "13.0"]);
    assert.equal(byDefault.snapshots, 4);
    const a = byDefault.availability.find((e) => e.gpuTypeId === "X" && e.dataCenterId === "A");
    assert.equal(a?.snapshots, 4);
    assert.equal(a?.inStock, 1);
    const under130 = await stats.getGpuStats({ ...window, minCudaVersion: "13.0" });
    assert.equal(under130.minCudaVersion, "13.0");
    assert.equal(under130.snapshots, 4);
    assert.equal(under130.availability.find((e) => e.gpuTypeId === "X" && e.dataCenterId === "A")?.inStock, 4);
  }));

test("AC-SF-11: v102 keeps the existing snapshot rows and their minimum (NULL -> ''); a second snapshot at the same at with another minimum is stored, a repeat is not", () =>
  withDb(async (database, client) => {
    // The table as v100 left it (primary key `at` alone, nullable minimum), with two old snapshots.
    await client.execute("DROP TABLE media_gpu_availability_snapshots");
    await client.execute("CREATE TABLE media_gpu_availability_snapshots (at INTEGER PRIMARY KEY, rows INTEGER NOT NULL, min_cuda_version TEXT)");
    const t1 = Math.floor(at(0).getTime() / 1000);
    const t2 = Math.floor(at(15).getTime() / 1000);
    await client.execute({ sql: "INSERT INTO media_gpu_availability_snapshots (at, rows, min_cuda_version) VALUES (?, 3, '12.8'), (?, 2, NULL)", args: [t1, t2] });
    const v102 = SCHEMA_MIGRATIONS.find((m) => m.version === 102);
    assert.ok(v102, "schema v102 exists");
    await v102.apply(client);
    await v102.apply(client); // a re-run changes nothing
    const kept = await client.execute("SELECT at, rows, min_cuda_version FROM media_gpu_availability_snapshots ORDER BY at, min_cuda_version");
    assert.deepEqual(
      kept.rows.map((r) => [Number(r.at), Number(r.rows), r.min_cuda_version]),
      [
        [t1, 3, "12.8"],
        [t2, 2, ""],
      ]
    );
    const pk = await client.execute("PRAGMA table_info(media_gpu_availability_snapshots)");
    assert.deepEqual(
      pk.rows.filter((c) => Number(c.pk) > 0).map((c) => String(c.name)),
      ["at", "min_cuda_version"]
    );
    // Same `at` as the old 12.8 snapshot, minimum 13.0: stored (with its log rows); the same again: nothing more.
    await insertMediaGpuAvailabilitySnapshot(at(0), [row("13.0", "*", "LOW")], database);
    await insertMediaGpuAvailabilitySnapshot(at(0), [row("13.0", "*", "HIGH")], database);
    await insertMediaGpuAvailabilitySnapshot(at(0), [row("12.8", "*", "HIGH")], database);
    const after = await client.execute("SELECT at, rows, min_cuda_version FROM media_gpu_availability_snapshots ORDER BY at, min_cuda_version");
    assert.deepEqual(
      after.rows.map((r) => [Number(r.at), Number(r.rows), r.min_cuda_version]),
      [
        [t1, 3, "12.8"],
        [t1, 1, "13.0"],
        [t2, 2, ""],
      ]
    );
    const logRows = await listMediaGpuAvailabilityLog({ limit: 10, minCudaVersion: "13.0" }, database);
    assert.deepEqual(logRows.map((r) => r.stock), ["LOW"], "the repeat stored no log row");
    assert.equal(((await getLatestMediaGpuAvailabilityAt(database, "")) ?? new Date(0)).getTime(), at(15).getTime());
  }));
