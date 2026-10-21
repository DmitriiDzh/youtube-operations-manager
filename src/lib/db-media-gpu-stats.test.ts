import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import { drizzle } from "drizzle-orm/libsql";
import {
  getLatestMediaGpuAvailabilityAt,
  initializeDatabaseSchema,
  insertMediaGpuAvailabilitySnapshot,
  listMediaGpuAvailabilityLog,
  SCHEMA_MIGRATIONS,
  summarizeMediaGpuAvailabilityLog,
  type AppDb,
} from "@/lib/db";
import { DEFAULT_MEDIA_SETTINGS } from "@/lib/media-generation/contracts";
import { createGpuAvailabilityLogServices } from "@/lib/media-generation/gpu-availability-log";

// BL-206 (FO-REQ-0033, docs/roadmap/plans/GPU_STATS_PLAN.md §3): AC-GS-03 (the list tool's summary over old snapshots with NONE stored
// and new ones with NONE implied) and AC-GS-09 (the v100 migration backfills the snapshots table) on a real migrated database. Every
// expected value is the plan's, worked out by hand in the comments; nothing is read back from the code under test.

const DAY = 24 * 60 * 60 * 1000;

async function withDb(run: (database: AppDb, client: Client) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-media-gpu-stats-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb, client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/** A pre-v100 snapshot: rows written straight into the log (NONE stored), no snapshots-table row -- as the v81 code left them. */
async function insertOldSnapshot(client: Client, at: string, rows: Array<[gpu: string, dc: string, stock: string | null]>): Promise<void> {
  for (const [gpu, dc, stock] of rows) {
    await client.execute({
      sql: "INSERT INTO media_gpu_availability_log (at, gpu_type_id, data_center_id, stock, price_per_hr, min_cuda_version) VALUES (?, ?, ?, ?, ?, ?)",
      args: [seconds(at), gpu, dc, stock, 0.89, "12.8"],
    });
  }
}

const row = (gpuTypeId: string, dataCenterId: string, stock: string | null) => ({ gpuTypeId, dataCenterId, stock, pricePerHr: 0.89, minCudaVersion: "12.8" });

async function rerunV100(client: Client): Promise<void> {
  const migration = SCHEMA_MIGRATIONS.find((m) => m.version === 100);
  assert.ok(migration, "schema v100 exists");
  await migration.apply(client);
}

function logServices(database: AppDb) {
  return createGpuAvailabilityLogServices({
    store: {
      latestAt: () => getLatestMediaGpuAvailabilityAt(database),
      insertSnapshot: (at, rows) => insertMediaGpuAvailabilitySnapshot(at, rows, database),
      list: (filter) => listMediaGpuAvailabilityLog(filter, database),
      summarize: (filter) => summarizeMediaGpuAvailabilityLog(filter, database),
    },
    base: {
      getGatewayEnabled: async () => false,
      getCredentialsStatus: async () => ({ configured: false, reason: "no_credentials" }),
      getSettings: async () => DEFAULT_MEDIA_SETTINGS,
      resolveRunpodClient: async () => {
        throw new Error("no RunPod in this test");
      },
    },
    clock: { now: () => new Date("2026-10-21T12:00:00Z") },
  });
}

test("AC-GS-09: v100 copies every distinct snapshot time of the log into the snapshots table with its row count, and re-running it changes nothing", () =>
  withDb(async (_database, client) => {
    // Two old snapshots: 3 rows and 2 rows (NONE stored).
    await insertOldSnapshot(client, "2026-10-20T09:00:00Z", [
      ["X", "*", "HIGH"],
      ["X", "A", "LOW"],
      ["X", "B", "NONE"],
    ]);
    await insertOldSnapshot(client, "2026-10-20T12:00:00Z", [
      ["X", "*", "HIGH"],
      ["X", "A", "NONE"],
    ]);
    await rerunV100(client);
    await rerunV100(client);
    const result = await client.execute("SELECT at, rows, min_cuda_version FROM media_gpu_availability_snapshots ORDER BY at");
    assert.deepEqual(
      result.rows.map((r) => [Number(r.at), Number(r.rows), r.min_cuda_version]),
      [
        [seconds("2026-10-20T09:00:00Z"), 3, "12.8"],
        [seconds("2026-10-20T12:00:00Z"), 2, "12.8"],
      ]
    );
  }));

test("AC-GS-03: the list tool's summary over 2 old snapshots (NONE stored) and 2 new ones (NONE implied), X in A LOW in one of each -> LOW 2, NONE 2 of 4", () =>
  withDb(async (database, client) => {
    await insertOldSnapshot(client, "2026-10-20T06:00:00Z", [
      ["X", "*", "HIGH"],
      ["X", "A", "LOW"],
    ]);
    await insertOldSnapshot(client, "2026-10-20T09:00:00Z", [
      ["X", "*", "HIGH"],
      ["X", "A", "NONE"],
    ]);
    await rerunV100(client); // the upgrade
    await insertMediaGpuAvailabilitySnapshot(new Date("2026-10-21T10:00:00Z"), [row("X", "*", "HIGH"), row("X", "A", "LOW")], database);
    await insertMediaGpuAvailabilitySnapshot(new Date("2026-10-21T10:15:00Z"), [row("X", "*", "HIGH")], database);

    const log = logServices(database);
    const whole = await log.listGpuAvailabilityLog({ summary: true });
    assert.ok("summary" in whole);
    assert.deepEqual(whole.summary, {
      snapshots: 4,
      firstAt: "2026-10-20T06:00:00.000Z",
      lastAt: "2026-10-21T10:15:00.000Z",
      entries: [
        { gpuTypeId: "X", dataCenterId: "*", snapshots: 4, stock: { HIGH: 4 } },
        { gpuTypeId: "X", dataCenterId: "A", snapshots: 4, stock: { LOW: 2, NONE: 2 } },
      ],
    });
    // The same with the datacenter filter (the GPU's snapshots still count as its denominator).
    const a = await log.listGpuAvailabilityLog({ summary: true, dataCenterId: "A" });
    assert.ok("summary" in a);
    assert.deepEqual(a.summary.entries, [{ gpuTypeId: "X", dataCenterId: "A", snapshots: 4, stock: { LOW: 2, NONE: 2 } }]);
    assert.equal((await getLatestMediaGpuAvailabilityAt(database))?.toISOString(), "2026-10-21T10:15:00.000Z");
  }));

test("BL-206: a new snapshot writes its snapshots-table row (rows = rows stored); the 90-day prune removes old snapshot rows too", () =>
  withDb(async (database, client) => {
    const now = new Date("2026-10-21T12:00:00Z");
    await insertMediaGpuAvailabilitySnapshot(new Date(now.getTime() - 91 * DAY), [row("X", "*", "LOW")], database);
    await insertMediaGpuAvailabilitySnapshot(new Date(now.getTime() - 89 * DAY), [row("X", "*", "LOW"), row("X", "A", "LOW")], database);
    await insertMediaGpuAvailabilitySnapshot(now, [row("X", "*", "NONE"), row("X", "A", "LOW"), row("X", "B", "HIGH")], database);
    const result = await client.execute("SELECT at, rows FROM media_gpu_availability_snapshots ORDER BY at");
    assert.deepEqual(
      result.rows.map((r) => [Number(r.at), Number(r.rows)]),
      [
        [Math.floor((now.getTime() - 89 * DAY) / 1000), 2],
        [Math.floor(now.getTime() / 1000), 3],
      ]
    );
  }));
