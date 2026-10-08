import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  advanceVideoHistory,
  createIsolatedDb,
  getLatestChannelMetricCollectedAt,
  initializeDatabaseSchema,
  listAnalyticsCollectionRunsByChannel,
  listChannelMetricsInRange,
  listVideoHistoryByChannel,
  recordAnalyticsCollectionRun,
  saveChannelDailyMetric,
} from "@/lib/db";

async function withDb(fn: (db: ReturnType<typeof createIsolatedDb>, client: ReturnType<typeof createLibsqlClient>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "analytics-bl118-store-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await fn(createIsolatedDb(client), client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("migrations v44/v45 create the BL-118 columns and tables (nullable, no defaults on the transferred channels table)", () =>
  withDb(async (_db, client) => {
    const channelCols = await client.execute("PRAGMA table_info(channels)");
    const published = channelCols.rows.find((r) => r.name === "published_at");
    assert.ok(published, "channels.published_at exists");
    assert.equal(published.notnull, 0, "nullable");
    assert.equal(published.dflt_value, null, "no default (RISK-89: a non-NULL default on a transferred table reads as a local change)");

    for (const table of ["channel_metrics_daily", "analytics_video_history"]) {
      const rows = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [table] });
      assert.equal(rows.rows.length, 1, table);
    }
    const runCols = await client.execute("PRAGMA table_info(analytics_collection_runs)");
    assert.ok(runCols.rows.some((r) => r.name === "channel_level"));
  }));

test("channel daily metrics: upsert replaces the same (channel, date, metric); the range read is inclusive and ordered", () =>
  withDb(async (db) => {
    await saveChannelDailyMetric({ channelId: "UC1", metricDate: "2026-09-01", metricName: "views", metricValue: 10 }, db);
    await saveChannelDailyMetric({ channelId: "UC1", metricDate: "2026-09-01", metricName: "views", metricValue: 15 }, db);
    await saveChannelDailyMetric({ channelId: "UC1", metricDate: "2026-09-03", metricName: "views", metricValue: 3 }, db);
    await saveChannelDailyMetric({ channelId: "UC1", metricDate: "2026-09-05", metricName: "views", metricValue: 5 }, db);
    await saveChannelDailyMetric({ channelId: "UC2", metricDate: "2026-09-03", metricName: "views", metricValue: 999 }, db);

    const rows = await listChannelMetricsInRange("UC1", { startDate: "2026-09-01", endDate: "2026-09-03" }, db);
    assert.deepEqual(rows.map((r) => [r.metricDate, r.metricValue]), [["2026-09-01", 15], ["2026-09-03", 3]]);
    assert.ok(await getLatestChannelMetricCollectedAt("UC1", db));
    assert.equal(await getLatestChannelMetricCollectedAt("UC_NONE", db), null);
  }));

test("video history only ever moves forward: a later query that ends earlier never shrinks it", () =>
  withDb(async (db) => {
    await advanceVideoHistory({ videoId: "v1", channelId: "UC1", historyThrough: "2026-09-13" }, db);
    await advanceVideoHistory({ videoId: "v1", channelId: "UC1", historyThrough: "2026-10-01" }, db);
    await advanceVideoHistory({ videoId: "v1", channelId: "UC1", historyThrough: "2026-09-20" }, db);
    await advanceVideoHistory({ videoId: "v2", channelId: "UC2", historyThrough: "2026-08-01" }, db);
    assert.deepEqual(await listVideoHistoryByChannel("UC1", db), [{ videoId: "v1", channelId: "UC1", historyThrough: "2026-10-01" }]);
  }));

test("a collection run records whether it also collected the channel totals; older rows read as false", () =>
  withDb(async (db, client) => {
    await recordAnalyticsCollectionRun({ channelId: "UC1", requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-02", videoCount: 2, upsertsIssued: 4, skippedVideoIds: [], channelLevel: true }, db);
    await recordAnalyticsCollectionRun({ channelId: "UC1", requestedStartDate: "2026-09-03", requestedEndDate: "2026-09-04", videoCount: 2, upsertsIssued: 4, skippedVideoIds: [] }, db);
    // a row written before v45 (column NULL) -- inserted raw, as the old code did
    await client.execute("INSERT INTO analytics_collection_runs (channel_id, requested_start_date, requested_end_date, video_count, upserts_issued, skipped_video_ids_json, ran_at) VALUES ('UC1','2026-08-01','2026-08-02',1,1,'[]',1)");
    const runs = await listAnalyticsCollectionRunsByChannel("UC1", db);
    assert.deepEqual(runs.map((r) => [r.requestedStartDate, r.channelLevel]).sort(), [["2026-08-01", false], ["2026-09-01", true], ["2026-09-03", false]]);
  }));
