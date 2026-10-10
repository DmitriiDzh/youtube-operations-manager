import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import { drizzle } from "drizzle-orm/libsql";
import {
  getLatestMediaGpuAvailabilityAt,
  initializeDatabaseSchema,
  insertMediaGpuAvailabilitySnapshot,
  listMediaGpuAvailabilityLog,
  summarizeMediaGpuAvailabilityLog,
  type AppDb,
} from "@/lib/db";
import { DEFAULT_MEDIA_SETTINGS, isDomainError } from "@/lib/media-generation/contracts";
import { createGpuAvailabilityLogServices } from "@/lib/media-generation/gpu-availability-log";

// BL-172 (docs/roadmap/plans/GPU_AVAILABILITY_PLAN.md §4, schema v81): AC-GA-06 (90-day retention on insert) and AC-GA-07 (filters,
// newest first, limit capped at 5,000; the summary counted over every matching row) through the real helpers on a migrated
// database. Expected values are the plan's, worked out by hand below.

const DAY = 24 * 60 * 60 * 1000;
const L40S = "NVIDIA L40S";
const RTX4090 = "NVIDIA GeForce RTX 4090";

async function withDb(run: (database: AppDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-media-gpu-availability-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function row(gpuTypeId: string, dataCenterId: string, stock: string | null) {
  return { gpuTypeId, dataCenterId, stock, pricePerHr: gpuTypeId === L40S ? 1.09 : 0.89, minCudaVersion: "12.8" };
}

/** The log services on this database, with no RunPod behind them (reads only). */
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
    clock: { now: () => new Date("2026-10-10T12:00:00Z") },
  });
}

test("AC-GA-06: a row older than 90 days is deleted on the next insert; one younger stays", () =>
  withDb(async (database) => {
    const now = new Date("2026-10-10T09:00:00Z");
    await insertMediaGpuAvailabilitySnapshot(new Date(now.getTime() - 91 * DAY), [row(L40S, "US-IL-1", "LOW")], database);
    await insertMediaGpuAvailabilitySnapshot(new Date(now.getTime() - 89 * DAY), [row(L40S, "US-IL-1", "NONE")], database);
    assert.equal((await listMediaGpuAvailabilityLog({ limit: 10 }, database)).length, 2, "nothing is pruned before a newer insert");
    await insertMediaGpuAvailabilitySnapshot(now, [row(L40S, "US-IL-1", "HIGH")], database);
    const left = await listMediaGpuAvailabilityLog({ limit: 10 }, database);
    assert.deepEqual(
      left.map((r) => [r.at.toISOString(), r.stock]),
      [
        [now.toISOString(), "HIGH"],
        [new Date(now.getTime() - 89 * DAY).toISOString(), "NONE"],
      ]
    );
    assert.equal((await getLatestMediaGpuAvailabilityAt(database))?.toISOString(), now.toISOString());
  }));

test("AC-GA-07: since/until (inclusive), gpuTypeId and dataCenterId filter; rows come newest first, the overall row before the datacenters", () =>
  withDb(async (database) => {
    const t1 = new Date("2026-10-10T00:00:00Z");
    const t2 = new Date("2026-10-10T03:00:00Z");
    const t3 = new Date("2026-10-10T06:00:00Z");
    for (const [at, il] of [
      [t1, "LOW"],
      [t2, "NONE"],
      [t3, "LOW"],
    ] as const) {
      await insertMediaGpuAvailabilitySnapshot(at, [row(L40S, "US-IL-1", il), row(L40S, "*", "HIGH"), row(RTX4090, "EU-RO-1", "MEDIUM"), row(RTX4090, "*", "HIGH")], database);
    }
    const log = logServices(database);

    const all = await log.listGpuAvailabilityLog({});
    assert.ok("rows" in all);
    assert.equal(all.rows.length, 12);
    assert.deepEqual(
      all.rows.slice(0, 4).map((r) => [r.at, r.gpuTypeId, r.dataCenterId, r.stock]),
      [
        [t3.toISOString(), RTX4090, "*", "HIGH"],
        [t3.toISOString(), RTX4090, "EU-RO-1", "MEDIUM"],
        [t3.toISOString(), L40S, "*", "HIGH"],
        [t3.toISOString(), L40S, "US-IL-1", "LOW"],
      ]
    );
    assert.deepEqual(all.rows[0], { at: t3.toISOString(), gpuTypeId: RTX4090, dataCenterId: "*", stock: "HIGH", pricePerHr: 0.89, minCudaVersion: "12.8" });
    assert.equal(all.lastSnapshotAt, t3.toISOString());
    assert.equal(all.intervalHours, 3);
    assert.equal(all.retentionDays, 90);

    const narrowed = await log.listGpuAvailabilityLog({ gpuTypeId: L40S, dataCenterId: "US-IL-1", since: t2.toISOString(), until: t3.toISOString() });
    assert.ok("rows" in narrowed);
    assert.deepEqual(
      narrowed.rows.map((r) => [r.at, r.stock]),
      [
        [t3.toISOString(), "LOW"],
        [t2.toISOString(), "NONE"],
      ]
    );
    const limited = await log.listGpuAvailabilityLog({ limit: 5 });
    assert.ok("rows" in limited);
    assert.equal(limited.rows.length, 5);
    await assert.rejects(log.listGpuAvailabilityLog({ limit: 5001 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  }));

test("AC-GA-07: summary -- three snapshots with L40S/US-IL-1 = LOW, NONE, LOW give { LOW: 2, NONE: 1 }; the range narrows the counts", () =>
  withDb(async (database) => {
    const t1 = new Date("2026-10-10T00:00:00Z");
    const t2 = new Date("2026-10-10T03:00:00Z");
    const t3 = new Date("2026-10-10T06:00:00Z");
    for (const [at, il] of [
      [t1, "LOW"],
      [t2, "NONE"],
      [t3, "LOW"],
    ] as const) {
      await insertMediaGpuAvailabilitySnapshot(at, [row(L40S, "US-IL-1", il), row(L40S, "*", "HIGH")], database);
    }
    const log = logServices(database);
    const whole = await log.listGpuAvailabilityLog({ summary: true, gpuTypeId: L40S });
    assert.ok("summary" in whole);
    assert.deepEqual(whole.summary, {
      snapshots: 3,
      firstAt: t1.toISOString(),
      lastAt: t3.toISOString(),
      entries: [
        { gpuTypeId: L40S, dataCenterId: "*", snapshots: 3, stock: { HIGH: 3 } },
        { gpuTypeId: L40S, dataCenterId: "US-IL-1", snapshots: 3, stock: { LOW: 2, NONE: 1 } },
      ],
    });
    const later = await log.listGpuAvailabilityLog({ summary: true, dataCenterId: "US-IL-1", since: t2.toISOString() });
    assert.ok("summary" in later);
    assert.deepEqual(later.summary.entries, [{ gpuTypeId: L40S, dataCenterId: "US-IL-1", snapshots: 2, stock: { NONE: 1, LOW: 1 } }]);
    assert.equal(later.summary.snapshots, 2);
    const empty = await log.listGpuAvailabilityLog({ summary: true, dataCenterId: "EU-CZ-1" });
    assert.ok("summary" in empty);
    assert.deepEqual(empty.summary, { snapshots: 0, firstAt: null, lastAt: null, entries: [] });
  }));

test("AC-GA-07: the summary counts every matching row, not a page of them -- a 1,250-row snapshot is stored whole (chunked), listed 1,000 by default and counted in full", () =>
  withDb(async (database) => {
    const at = new Date("2026-10-10T09:00:00Z");
    const rows = Array.from({ length: 1250 }, (_, i) => row(`GPU-${String(i).padStart(4, "0")}`, "EU-RO-1", i % 5 === 0 ? "NONE" : "LOW"));
    await insertMediaGpuAvailabilitySnapshot(at, rows, database);
    const log = logServices(database);
    const page = await log.listGpuAvailabilityLog({});
    assert.ok("rows" in page);
    assert.equal(page.rows.length, 1000, "the default limit");
    const summary = await log.listGpuAvailabilityLog({ summary: true });
    assert.ok("summary" in summary);
    assert.equal(summary.summary.entries.length, 1250);
    assert.equal(summary.summary.entries.filter((e) => e.stock.NONE === 1).length, 250);
    assert.equal(summary.summary.snapshots, 1);
  }));
