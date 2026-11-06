import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  createIsolatedDb,
  deleteAnalyticsFreshnessProbesBefore,
  initializeDatabaseSchema,
  listAnalyticsCollectionRunsByChannel,
  listAnalyticsFreshnessProbesByChannel,
  recordAnalyticsFreshnessProbe,
  SCHEMA_MIGRATIONS,
} from "@/lib/db";

// BL-245 (owner 2026-11-06): schema v119 adds `analytics_freshness_probes` -- one row per hourly probe of a channel (newest date
// the Analytics API returned, or a short error). Probes are NOT collection runs: they never appear in analytics_collection_runs.

async function withDb(run: (client: Client) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-freshness-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const probe = (channelId: string, at: string, newest: string | null, error: string | null = null) => ({
  channelId,
  probedAt: new Date(at),
  requestedStartDate: "2026-11-03",
  requestedEndDate: "2026-11-08",
  newestChannelDate: newest,
  error,
});

test("schema v119 exists and creates analytics_freshness_probes", async () => {
  assert.ok(SCHEMA_MIGRATIONS.find((m) => m.version === 119));
  await withDb(async (client) => {
    const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analytics_freshness_probes'");
    assert.equal(t.rows.length, 1);
  });
});

test("probes round-trip per channel, oldest first, and never show up as collection runs", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    await recordAnalyticsFreshnessProbe(probe("UC1", "2026-11-08T04:07:00Z", "2026-11-06"), database);
    await recordAnalyticsFreshnessProbe(probe("UC1", "2026-11-08T03:07:00Z", "2026-11-05"), database);
    await recordAnalyticsFreshnessProbe(probe("UC2", "2026-11-08T03:07:00Z", null, "User not authenticated"), database);
    const uc1 = await listAnalyticsFreshnessProbesByChannel("UC1", database);
    assert.deepEqual(
      uc1.map((p) => [p.probedAt.toISOString(), p.newestChannelDate, p.error]),
      [
        ["2026-11-08T03:07:00.000Z", "2026-11-05", null],
        ["2026-11-08T04:07:00.000Z", "2026-11-06", null],
      ]
    );
    assert.deepEqual(
      (await listAnalyticsFreshnessProbesByChannel("UC2", database)).map((p) => [p.newestChannelDate, p.error]),
      [[null, "User not authenticated"]]
    );
    assert.deepEqual(await listAnalyticsCollectionRunsByChannel("UC1", database), []);
  });
});

test("retention deletes only probes made before the cutoff", async () => {
  await withDb(async (client) => {
    const database = createIsolatedDb(client);
    await recordAnalyticsFreshnessProbe(probe("UC1", "2026-09-20T10:07:00Z", "2026-09-18"), database); // older than the cutoff
    await recordAnalyticsFreshnessProbe(probe("UC1", "2026-09-24T00:00:00Z", "2026-09-22"), database); // exactly at it: kept
    await recordAnalyticsFreshnessProbe(probe("UC1", "2026-11-08T04:07:00Z", "2026-11-06"), database);
    assert.equal(await deleteAnalyticsFreshnessProbesBefore(new Date("2026-09-24T00:00:00Z"), database), 1);
    assert.deepEqual(
      (await listAnalyticsFreshnessProbesByChannel("UC1", database)).map((p) => p.probedAt.toISOString()),
      ["2026-09-24T00:00:00.000Z", "2026-11-08T04:07:00.000Z"]
    );
  });
});
