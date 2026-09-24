import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import {
  channels,
  clearStoredCloudConnection,
  contentProposals,
  copyLegacyDatabaseInto,
  createIsolatedDb,
  gatewayCallEvents,
  getAnalyticsReadsEnabled,
  getAnalyticsSyncSettings,
  getContentProposalById,
  getCreativeAssetById,
  getDataApiReadsEnabled,
  getGatewayTrafficLast24h,
  getStoredCloudConnection,
  getWeeklyReportByWeek,
  initializeDatabaseSchema,
  insertContentProposal,
  insertCreativeAsset,
  listAnalyticsCollectionRunsByChannel,
  listContentProposalsByChannel,
  listCreativeAssetsByChannel,
  listVideoMetricsByChannel,
  listVideoMetricsByVideo,
  listWeeklyReportsByChannel,
  getSyncFamilyStatuses,
  markAnalyticsAutoCollected,
  recordAnalyticsCollectionRun,
  recordGatewayCallOutcome,
  recordSyncFamilyResult,
  SCHEMA_BASELINE_VERSION,
  SCHEMA_CURRENT_VERSION,
  SCHEMA_MIGRATIONS,
  setAnalyticsReadsEnabled,
  setAnalyticsSyncSettings,
  setDataApiReadsEnabled,
  type AppDb,
  upsertStoredCloudConnection,
  upsertVideoMetric,
  upsertWeeklyReport,
  videos,
} from "./db";
import { readSchemaVersion } from "@/lib/schema-versioning";
import { SchemaVersionError } from "@/lib/schema-versioning/contracts";

async function withTempClient(fn: (client: Client, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-integration-test-"));
  const client = createClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await fn(client, dir);
  } finally {
    client.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [name],
  });
  return result.rows.length > 0;
}

// video_metrics_daily.videoId has a real FK on videos.id (Phase 8, PHASE_8_PLAN.md §5) -- a
// channel + video row must exist first, or the insert fails closed with a constraint error.
async function seedChannel(database: AppDb, channelId: string): Promise<void> {
  await database.insert(channels).values({
    id: channelId,
    title: "Test Channel",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_TEST",
    connectedUserId: null,
  });
}

async function seedVideo(database: AppDb, channelId: string, videoId: string): Promise<void> {
  await database.insert(videos).values({
    id: videoId,
    channelId,
    title: "Test Video",
    description: "",
    publishedAt: "2026-01-01T00:00:00Z",
    privacyStatus: "public",
    thumbnailsJson: "{}",
    localizationsJson: "{}",
  });
}

async function seedChannelAndVideo(database: AppDb, channelId: string, videoId: string): Promise<void> {
  await seedChannel(database, channelId);
  await seedVideo(database, channelId, videoId);
}

// AC-SCHEMA-01
test("initializeDatabaseSchema: a fresh database ends stamped at SCHEMA_CURRENT_VERSION with every table present", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    assert.equal(await readSchemaVersion(client), SCHEMA_CURRENT_VERSION);
    assert.equal(await tableExists(client, "users"), true);
    assert.equal(await tableExists(client, "app_operation_locks"), true);
    assert.equal(await tableExists(client, "video_metrics_daily"), true);
    assert.equal(await tableExists(client, "analytics_collection_runs"), true);
    assert.equal(await tableExists(client, "analytics_weekly_reports"), true);
    assert.equal(await tableExists(client, "creative_assets"), true);
    assert.equal(await tableExists(client, "content_proposals"), true);
  }));

// Phase 7 slice D (docs/AGENT_OPERATIONS_INTERFACE.md §4c).
test("creative_assets: inserts and lists by channel, filtered by videoId/assetType, enforcing the channel/video foreign keys", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannelAndVideo(isolatedDb, "UC_A", "vid1");

    await insertCreativeAsset(
      {
        id: "asset-1",
        channelId: "UC_A",
        assetType: "thumbnail",
        referenceKind: "local_path",
        referenceValue: "/tmp/does-not-matter.png",
        title: "Cover art v1",
        linkedVideoId: "vid1",
      },
      isolatedDb
    );
    await insertCreativeAsset(
      {
        id: "asset-2",
        channelId: "UC_A",
        assetType: "script",
        referenceKind: "url",
        referenceValue: "https://example.com/script.txt",
      },
      isolatedDb
    );

    const all = await listCreativeAssetsByChannel("UC_A", {}, isolatedDb);
    assert.equal(all.length, 2);

    const byVideo = await listCreativeAssetsByChannel("UC_A", { videoId: "vid1" }, isolatedDb);
    assert.deepEqual(byVideo.map((a) => a.id), ["asset-1"]);

    const byType = await listCreativeAssetsByChannel("UC_A", { assetType: "script" }, isolatedDb);
    assert.deepEqual(byType.map((a) => a.id), ["asset-2"]);

    const fetched = await getCreativeAssetById("asset-1", isolatedDb);
    assert.equal(fetched?.title, "Cover art v1");
    assert.equal(fetched?.description, null);

    // A channel that was never synced must fail the FK, not silently create an orphaned row.
    await assert.rejects(() =>
      insertCreativeAsset(
        {
          id: "asset-3",
          channelId: "UC_NEVER_SYNCED",
          assetType: "other",
          referenceKind: "external_artifact_id",
          referenceValue: "artifact-123",
        },
        isolatedDb
      )
    );
  }));

// Phase 7 slice G (docs/AGENT_OPERATIONS_INTERFACE.md §4f).
test("content_proposals: inserts and lists by channel, enforcing the channel foreign key", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannel(isolatedDb, "UC_A");

    await insertContentProposal(
      {
        id: "proposal-1",
        channelId: "UC_A",
        objective: "Grow subscribers",
        createdVia: "web_ui",
      },
      isolatedDb
    );
    await insertContentProposal(
      {
        id: "proposal-2",
        channelId: "UC_A",
        objective: "Increase watch time",
        createdVia: "mcp",
        agentApiVersion: "0.6.0",
      },
      isolatedDb
    );

    const all = await listContentProposalsByChannel("UC_A", isolatedDb);
    assert.deepEqual(all.map((p) => p.id).sort(), ["proposal-1", "proposal-2"]);

    const fetched = await getContentProposalById("proposal-2", isolatedDb);
    assert.equal(fetched?.objective, "Increase watch time");
    assert.equal(fetched?.createdVia, "mcp");
    assert.equal(fetched?.agentApiVersion, "0.6.0");

    // A channel that was never synced must fail the FK, not silently create an orphaned row.
    await assert.rejects(() =>
      insertContentProposal(
        {
          id: "proposal-3",
          channelId: "UC_NEVER_SYNCED",
          createdVia: "web_ui",
        },
        isolatedDb
      )
    );
  }));

// Regression: `listContentProposalsByChannel` claims "newest first" (docs/interfaces.md,
// agent-operations' own capability description) -- proven here with two rows whose `createdAt`
// genuinely differs (inserted directly via the Drizzle table, bypassing `insertContentProposal`'s
// own `$defaultFn(() => new Date())`, which cannot be overridden through that function's public
// signature). The row with the LATER `createdAt` is deliberately inserted FIRST (and given an id
// that sorts alphabetically/by-rowid BEFORE the other row) -- so this test can only pass if the
// query genuinely orders by `createdAt`, not by insertion order or id, which a weaker version of
// this test (inserting in chronological order) would not have discriminated. Same-second ties
// are a known, accepted limitation shared with every other `orderBy(desc(...createdAt))` list
// function in this file (creative_assets, batches, ai_connections) -- not a new gap introduced by
// this table.
test("content_proposals: listContentProposalsByChannel actually orders by createdAt, newest first", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannel(isolatedDb, "UC_A");

    await isolatedDb.insert(contentProposals).values({
      id: "a-proposal-inserted-first-but-newer",
      channelId: "UC_A",
      createdVia: "web_ui",
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    await isolatedDb.insert(contentProposals).values({
      id: "z-proposal-inserted-second-but-older",
      channelId: "UC_A",
      createdVia: "web_ui",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const all = await listContentProposalsByChannel("UC_A", isolatedDb);
    assert.deepEqual(all.map((p) => p.id), [
      "a-proposal-inserted-first-but-newer",
      "z-proposal-inserted-second-but-older",
    ]);
  }));

// Phase 8 follow-up, slice 2 (docs/roadmap/FUTURE_PHASES.md §4, data-quality diagnostics).
test("analytics_collection_runs: records a run and reads it back with skippedVideoIds decoded from JSON", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await recordAnalyticsCollectionRun(
      {
        channelId: "UC_A",
        requestedStartDate: "2026-09-01",
        requestedEndDate: "2026-09-07",
        videoCount: 3,
        upsertsIssued: 50,
        skippedVideoIds: ["v2"],
      },
      isolatedDb
    );

    const runs = await listAnalyticsCollectionRunsByChannel("UC_A", isolatedDb);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].channelId, "UC_A");
    assert.equal(runs[0].requestedStartDate, "2026-09-01");
    assert.equal(runs[0].requestedEndDate, "2026-09-07");
    assert.equal(runs[0].videoCount, 3);
    assert.equal(runs[0].upsertsIssued, 50);
    assert.deepEqual(runs[0].skippedVideoIds, ["v2"]);
    assert.ok(runs[0].ranAt instanceof Date);
  }));

test("analytics_collection_runs: a run with no skipped videos round-trips as an empty array, not null/undefined", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await recordAnalyticsCollectionRun(
      {
        channelId: "UC_A",
        requestedStartDate: "2026-09-01",
        requestedEndDate: "2026-09-01",
        videoCount: 1,
        upsertsIssued: 20,
        skippedVideoIds: [],
      },
      isolatedDb
    );

    const runs = await listAnalyticsCollectionRunsByChannel("UC_A", isolatedDb);
    assert.deepEqual(runs[0].skippedVideoIds, []);
  }));

test("analytics_collection_runs: listAnalyticsCollectionRunsByChannel never returns another channel's runs", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await recordAnalyticsCollectionRun(
      { channelId: "UC_A", requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-01", videoCount: 1, upsertsIssued: 1, skippedVideoIds: [] },
      isolatedDb
    );
    await recordAnalyticsCollectionRun(
      { channelId: "UC_B", requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-01", videoCount: 1, upsertsIssued: 1, skippedVideoIds: [] },
      isolatedDb
    );

    const runsA = await listAnalyticsCollectionRunsByChannel("UC_A", isolatedDb);
    assert.equal(runsA.length, 1);
    assert.ok(!runsA.some((r) => r.channelId === "UC_B"), "must never include a different channel's run");
  }));

test("analytics_collection_runs: multiple runs for the same channel all accumulate (append-only, never overwritten)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await recordAnalyticsCollectionRun(
      { channelId: "UC_A", requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-01", videoCount: 1, upsertsIssued: 1, skippedVideoIds: [] },
      isolatedDb
    );
    await recordAnalyticsCollectionRun(
      { channelId: "UC_A", requestedStartDate: "2026-09-02", requestedEndDate: "2026-09-02", videoCount: 1, upsertsIssued: 1, skippedVideoIds: [] },
      isolatedDb
    );

    const runs = await listAnalyticsCollectionRunsByChannel("UC_A", isolatedDb);
    assert.equal(runs.length, 2);
  }));

// Phase 8 follow-up, slice 4 (docs/roadmap/FUTURE_PHASES.md §4, weekly reports).
test("analytics_weekly_reports: upsertWeeklyReport writes a row, getWeeklyReportByWeek reads it back", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const generatedAt = new Date("2026-09-21T12:05:00Z");

    await upsertWeeklyReport(
      {
        channelId: "UC_A",
        weekStartDate: "2026-09-14",
        weekEndDate: "2026-09-20",
        status: "final",
        reportJson: JSON.stringify({ ok: true }),
      },
      generatedAt,
      isolatedDb
    );

    const report = await getWeeklyReportByWeek("UC_A", "2026-09-14", isolatedDb);
    assert.ok(report);
    assert.equal(report!.channelId, "UC_A");
    assert.equal(report!.weekStartDate, "2026-09-14");
    assert.equal(report!.weekEndDate, "2026-09-20");
    assert.equal(report!.status, "final");
    assert.equal(report!.reportJson, JSON.stringify({ ok: true }));
    assert.equal(report!.generatedAt.getTime(), generatedAt.getTime());
  }));

test("analytics_weekly_reports: getWeeklyReportByWeek returns null when no report exists for that channel/week", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    const report = await getWeeklyReportByWeek("UC_A", "2026-09-14", isolatedDb);
    assert.equal(report, null);
  }));

test("analytics_weekly_reports: upsertWeeklyReport for the same (channelId, weekStartDate) replaces the row, never duplicates it", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await upsertWeeklyReport(
      { channelId: "UC_A", weekStartDate: "2026-09-14", weekEndDate: "2026-09-20", status: "provisional", reportJson: "{}" },
      new Date("2026-09-21T12:05:00Z"),
      isolatedDb
    );
    await upsertWeeklyReport(
      { channelId: "UC_A", weekStartDate: "2026-09-14", weekEndDate: "2026-09-20", status: "final", reportJson: "{\"v\":2}" },
      new Date("2026-09-22T12:05:00Z"),
      isolatedDb
    );

    const reports = await listWeeklyReportsByChannel("UC_A", isolatedDb);
    assert.equal(reports.length, 1, "the second upsert must replace, not duplicate, the same week's row");
    assert.equal(reports[0].status, "final");
    assert.equal(reports[0].reportJson, "{\"v\":2}");
  }));

// Independent review, 2026-09-23: `runWeeklyReportIfDue`'s own read-then-write check is not
// atomic across two concurrent callers -- this DB-layer guard is what actually makes "a final
// report is never overwritten" true regardless of the caller's own timing.
test("analytics_weekly_reports: upsertWeeklyReport NEVER overwrites an existing 'final' row, even when called directly with a conflicting write", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await upsertWeeklyReport(
      { channelId: "UC_A", weekStartDate: "2026-09-14", weekEndDate: "2026-09-20", status: "final", reportJson: "{\"v\":1}" },
      new Date("2026-09-21T12:05:00Z"),
      isolatedDb
    );
    // Simulates a second, concurrent caller that read stale (pre-completion) data and is now
    // attempting to write a "provisional" row over the same week -- this must be a silent no-op.
    await upsertWeeklyReport(
      { channelId: "UC_A", weekStartDate: "2026-09-14", weekEndDate: "2026-09-20", status: "provisional", reportJson: "{\"v\":2}" },
      new Date("2026-09-21T12:06:00Z"),
      isolatedDb
    );

    const report = await getWeeklyReportByWeek("UC_A", "2026-09-14", isolatedDb);
    assert.equal(report!.status, "final", "an already-final row must never be regressed to provisional");
    assert.equal(report!.reportJson, "{\"v\":1}", "an already-final row's content must never change");
  }));

test("analytics_weekly_reports: listWeeklyReportsByChannel never returns another channel's reports, and orders newest week first", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await upsertWeeklyReport(
      { channelId: "UC_A", weekStartDate: "2026-09-07", weekEndDate: "2026-09-13", status: "final", reportJson: "{}" },
      new Date("2026-09-14T12:05:00Z"),
      isolatedDb
    );
    await upsertWeeklyReport(
      { channelId: "UC_A", weekStartDate: "2026-09-14", weekEndDate: "2026-09-20", status: "final", reportJson: "{}" },
      new Date("2026-09-21T12:05:00Z"),
      isolatedDb
    );
    await upsertWeeklyReport(
      { channelId: "UC_B", weekStartDate: "2026-09-14", weekEndDate: "2026-09-20", status: "final", reportJson: "{}" },
      new Date("2026-09-21T12:05:00Z"),
      isolatedDb
    );

    const reports = await listWeeklyReportsByChannel("UC_A", isolatedDb);
    assert.deepEqual(
      reports.map((r) => r.weekStartDate),
      ["2026-09-14", "2026-09-07"]
    );
    assert.ok(!reports.some((r) => r.channelId === "UC_B"), "must never include a different channel's report");
  }));

// Phase 8 (docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 2, §7 acceptance criteria).
test("video_metrics_daily: upserting the same (videoId, metricDate, metricName) updates the existing row instead of creating a duplicate", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannelAndVideo(isolatedDb, "UC_TEST", "vid1");

    await upsertVideoMetric(
      { channelId: "UC_TEST", videoId: "vid1", metricDate: "2026-09-20", metricName: "views", metricValue: 100 },
      isolatedDb
    );
    await upsertVideoMetric(
      { channelId: "UC_TEST", videoId: "vid1", metricDate: "2026-09-20", metricName: "views", metricValue: 150 },
      isolatedDb
    );

    const rows = await listVideoMetricsByVideo("vid1", isolatedDb);
    assert.equal(rows.length, 1, "re-collecting an already-collected date must update, not duplicate, the row");
    assert.equal(rows[0].metricValue, 150, "the later collection's value must win");
  }));

test("video_metrics_daily: distinct metric names for the same video/date coexist as separate rows", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannelAndVideo(isolatedDb, "UC_TEST", "vid1");

    await upsertVideoMetric(
      { channelId: "UC_TEST", videoId: "vid1", metricDate: "2026-09-20", metricName: "views", metricValue: 100 },
      isolatedDb
    );
    await upsertVideoMetric(
      { channelId: "UC_TEST", videoId: "vid1", metricDate: "2026-09-20", metricName: "watchTimeMinutes", metricValue: 42 },
      isolatedDb
    );

    const rows = await listVideoMetricsByVideo("vid1", isolatedDb);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.metricName, r.metricValue]).sort(),
      [["views", 100], ["watchTimeMinutes", 42]].sort()
    );
  }));

// Phase 8 (docs/roadmap/plans/PHASE_8_PLAN.md §10 item 2): metric_value is REAL, not INTEGER,
// specifically to hold fractional Analytics metrics (e.g. averageViewPercentage) exactly.
test("video_metrics_daily: a fractional metricValue round-trips exactly through REAL storage", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannelAndVideo(isolatedDb, "UC_TEST", "vid1");

    await upsertVideoMetric(
      { channelId: "UC_TEST", videoId: "vid1", metricDate: "2026-09-20", metricName: "averageViewPercentage", metricValue: 63.75 },
      isolatedDb
    );

    const rows = await listVideoMetricsByVideo("vid1", isolatedDb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metricValue, 63.75);
  }));

// Phase 8 (BL-058, docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 4): the Web UI's read-only display
// needs every metric row for a channel, across every video, in one query -- and only that
// channel's own rows, never another locally-known channel's (the same channel-scoping discipline
// AGENTS.md §F requires elsewhere).
test("video_metrics_daily: listVideoMetricsByChannel returns every video's rows for that channel, never another channel's", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannelAndVideo(isolatedDb, "UC_A", "vid1");
    await seedVideo(isolatedDb, "UC_A", "vid2");
    await seedChannelAndVideo(isolatedDb, "UC_B", "vid3");

    await upsertVideoMetric(
      { channelId: "UC_A", videoId: "vid1", metricDate: "2026-09-20", metricName: "views", metricValue: 100 },
      isolatedDb
    );
    await upsertVideoMetric(
      { channelId: "UC_A", videoId: "vid2", metricDate: "2026-09-20", metricName: "views", metricValue: 200 },
      isolatedDb
    );
    await upsertVideoMetric(
      { channelId: "UC_B", videoId: "vid3", metricDate: "2026-09-20", metricName: "views", metricValue: 300 },
      isolatedDb
    );

    const rows = await listVideoMetricsByChannel("UC_A", isolatedDb);
    assert.deepEqual(
      rows.map((r) => r.videoId).sort(),
      ["vid1", "vid2"]
    );
    assert.ok(!rows.some((r) => r.videoId === "vid3"), "must never include a different channel's video");
  }));

// Phase 8 (BL-059, docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-5): the per-channel timestamp
// the staleness check reads.
test("channels.analyticsLastAutoCollectedAt: starts NULL, and markAnalyticsAutoCollected sets it for exactly the given channel", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannel(isolatedDb, "UC_A");
    await seedChannel(isolatedDb, "UC_B");

    const [before] = await isolatedDb.select().from(channels).where(eq(channels.id, "UC_A"));
    assert.equal(before.analyticsLastAutoCollectedAt, null);

    const markedAt = new Date("2026-09-22T12:05:00.000Z");
    await markAnalyticsAutoCollected("UC_A", markedAt, isolatedDb);

    const [afterA] = await isolatedDb.select().from(channels).where(eq(channels.id, "UC_A"));
    const [afterB] = await isolatedDb.select().from(channels).where(eq(channels.id, "UC_B"));
    assert.equal(afterA.analyticsLastAutoCollectedAt?.getTime(), markedAt.getTime());
    assert.equal(afterB.analyticsLastAutoCollectedAt, null, "must never touch a different channel's row");
  }));

// Phase 8 (BL-059): the one piece of getAnalyticsSyncSettings with real, silently-regressable
// state -- detect the OS timezone once, persist it, and never re-detect on a later read (so a
// later owner override in Settings is never clobbered by a fresh OS read).
test("getAnalyticsSyncSettings: detects and persists the OS timezone once, never re-detects on a later read", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    const first = await getAnalyticsSyncSettings(isolatedDb);
    assert.equal(first.localTime, "12:05", "default local time before anything is saved");
    assert.equal(first.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);

    // Simulate the owner overriding the timezone in Settings after the first-read detection.
    await setAnalyticsSyncSettings({ timezone: "Europe/Moscow" }, isolatedDb);

    const second = await getAnalyticsSyncSettings(isolatedDb);
    assert.equal(second.timezone, "Europe/Moscow", "a later read must return the saved override, never re-detect the OS zone");
  }));

test("setAnalyticsSyncSettings: updates only the given field(s), never touches the other", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await setAnalyticsSyncSettings({ localTime: "09:30", timezone: "Asia/Tokyo" }, isolatedDb);
    await setAnalyticsSyncSettings({ localTime: "18:00" }, isolatedDb);

    const settings = await getAnalyticsSyncSettings(isolatedDb);
    assert.equal(settings.localTime, "18:00");
    assert.equal(settings.timezone, "Asia/Tokyo", "updating localTime alone must not touch timezone");
  }));

// The read-gateway toggles' one genuinely regressable bit (2026-09-22, owner instruction --
// "тумблеры... на каждый шлюз API чтения"): default to ENABLED when never set, the opposite
// inversion from getLiveWritesEnabled's default-false. Getting this backwards would silently
// disable every YouTube read on a fresh install.
test("getDataApiReadsEnabled/getAnalyticsReadsEnabled: default to true when never set", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    assert.equal(await getDataApiReadsEnabled(isolatedDb), true);
    assert.equal(await getAnalyticsReadsEnabled(isolatedDb), true);
  }));

test("setDataApiReadsEnabled/setAnalyticsReadsEnabled: an explicit false persists and is independent per category", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await setDataApiReadsEnabled(false, isolatedDb);

    assert.equal(await getDataApiReadsEnabled(isolatedDb), false);
    assert.equal(
      await getAnalyticsReadsEnabled(isolatedDb),
      true,
      "disabling Data API reads must not affect the independent Analytics reads toggle"
    );

    await setAnalyticsReadsEnabled(false, isolatedDb);
    assert.equal(await getAnalyticsReadsEnabled(isolatedDb), false);

    await setDataApiReadsEnabled(true, isolatedDb);
    assert.equal(await getDataApiReadsEnabled(isolatedDb), true, "re-enabling must persist too");
    assert.equal(
      await getAnalyticsReadsEnabled(isolatedDb),
      false,
      "re-enabling Data API reads must not affect the independent Analytics reads toggle"
    );
  }));

// Gateway traffic, rolling 24h window (2026-09-22, owner instruction, refined from an initial
// cumulative-counter design -- "Сколько было попыток пройти через шлюз за последние сутки...
// Сколько попыток... увенчались успехом"). AC: a never-exercised category still reports a real
// zeroed row (not absent), a category's counts are independent of the others, concurrent writes
// are never lost, and -- the core behavior a rolling window actually exists to provide -- an
// event outside the window is excluded from the count even though it is still in the table.
test("getGatewayTrafficLast24h: all five categories report a zeroed row before any call is recorded", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    const windows = await getGatewayTrafficLast24h(isolatedDb);

    assert.deepEqual(
      windows.map((w) => w.category).sort(),
      ["analytics_reads", "cloud_monitoring_reads", "data_api_reads", "live_writes", "mcp_tool_calls"]
    );
    for (const w of windows) {
      assert.equal(w.totalAttempts, 0);
      assert.equal(w.succeeded, 0);
    }
  }));

test("getGatewayTrafficLast24h: totalAttempts/succeeded accumulate independently per category", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await recordGatewayCallOutcome("data_api_reads", "allowed", isolatedDb);
    await recordGatewayCallOutcome("data_api_reads", "allowed", isolatedDb);
    await recordGatewayCallOutcome("data_api_reads", "blocked", isolatedDb);
    await recordGatewayCallOutcome("live_writes", "blocked", isolatedDb);

    const windows = await getGatewayTrafficLast24h(isolatedDb);
    const dataApiReads = windows.find((w) => w.category === "data_api_reads");
    const liveWrites = windows.find((w) => w.category === "live_writes");
    const analyticsReads = windows.find((w) => w.category === "analytics_reads");

    assert.equal(dataApiReads?.totalAttempts, 3);
    assert.equal(dataApiReads?.succeeded, 2);

    assert.equal(liveWrites?.totalAttempts, 1);
    assert.equal(liveWrites?.succeeded, 0);

    assert.equal(analyticsReads?.totalAttempts, 0, "categories never called stay at zero, unaffected by others");
    assert.equal(analyticsReads?.succeeded, 0);
  }));

test("getGatewayTrafficLast24h: an event older than the window is excluded, even though it is still stored", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const now = Math.floor(Date.now() / 1000);

    await isolatedDb.insert(gatewayCallEvents).values([
      { category: "data_api_reads", outcome: "allowed", occurredAt: now - 25 * 60 * 60 }, // 25h ago -- outside the 24h window
      { category: "data_api_reads", outcome: "allowed", occurredAt: now - 60 }, // 1 minute ago -- inside
    ]);

    const windows = await getGatewayTrafficLast24h(isolatedDb);
    const dataApiReads = windows.find((w) => w.category === "data_api_reads");

    assert.equal(dataApiReads?.totalAttempts, 1, "the 25h-old event must not be counted in the 24h window");
    assert.equal(dataApiReads?.succeeded, 1);
  }));

test("recordGatewayCallOutcome: concurrent writes are never lost", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await Promise.all(
      Array.from({ length: 20 }, () => recordGatewayCallOutcome("analytics_reads", "allowed", isolatedDb))
    );

    const windows = await getGatewayTrafficLast24h(isolatedDb);
    const analyticsReads = windows.find((w) => w.category === "analytics_reads");
    assert.equal(analyticsReads?.totalAttempts, 20);
    assert.equal(analyticsReads?.succeeded, 20);
  }));

test("recordGatewayCallOutcome: prunes events older than the retention window on every write", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const now = Math.floor(Date.now() / 1000);
    const eightDaysAgo = now - 8 * 24 * 60 * 60;

    await isolatedDb
      .insert(gatewayCallEvents)
      .values({ category: "live_writes", outcome: "blocked", occurredAt: eightDaysAgo });

    await recordGatewayCallOutcome("live_writes", "blocked", isolatedDb);

    const remaining = await isolatedDb.select().from(gatewayCallEvents);
    assert.equal(remaining.length, 1, "the 8-day-old row must be pruned; only the fresh insert remains");
    assert.ok(remaining[0].occurredAt > eightDaysAgo);
  }));

// sync_family_status (2026-09-23, Merge-tab redesign) -- persistent per-family last-sync outcome,
// upserted (one row per family), unlike gateway_call_events' own append-only rolling window above.
test("getSyncFamilyStatuses: all three families report a never-synced row before any cycle completes", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    const statuses = await getSyncFamilyStatuses(isolatedDb);

    assert.deepEqual(
      statuses.map((s) => s.family).sort(),
      ["ai_connections", "change_drafts", "editorial_profile"]
    );
    for (const s of statuses) {
      assert.equal(s.lastSyncedAt, null);
      assert.equal(s.lastSyncOk, null);
      assert.equal(s.lastError, null);
    }
  }));

test("recordSyncFamilyResult: a successful cycle records lastSyncOk true and clears any prior error", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await recordSyncFamilyResult("change_drafts", { ok: false, error: "sync folder unreachable" }, isolatedDb);
    await recordSyncFamilyResult("change_drafts", { ok: true, error: null }, isolatedDb);

    const statuses = await getSyncFamilyStatuses(isolatedDb);
    const changeDrafts = statuses.find((s) => s.family === "change_drafts");
    assert.equal(changeDrafts?.lastSyncOk, true);
    assert.equal(changeDrafts?.lastError, null);
    assert.ok(changeDrafts?.lastSyncedAt instanceof Date, "a successful cycle still records when it finished");
  }));

test("recordSyncFamilyResult: a failed cycle is distinguishable from never having synced -- lastSyncedAt is still set", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await recordSyncFamilyResult("editorial_profile", { ok: false, error: "bootstrap config unreadable" }, isolatedDb);

    const statuses = await getSyncFamilyStatuses(isolatedDb);
    const editorialProfile = statuses.find((s) => s.family === "editorial_profile");
    assert.equal(editorialProfile?.lastSyncOk, false);
    assert.equal(editorialProfile?.lastError, "bootstrap config unreadable");
    assert.ok(editorialProfile?.lastSyncedAt instanceof Date, "a failed attempt still finished at some point, distinct from never-synced (null)");
  }));

test("recordSyncFamilyResult: each family's status is independent of the others", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await recordSyncFamilyResult("ai_connections", { ok: true, error: null }, isolatedDb);

    const statuses = await getSyncFamilyStatuses(isolatedDb);
    const changeDrafts = statuses.find((s) => s.family === "change_drafts");
    const editorialProfile = statuses.find((s) => s.family === "editorial_profile");
    assert.equal(changeDrafts?.lastSyncedAt, null, "an unrelated family's write must not affect this one");
    assert.equal(editorialProfile?.lastSyncedAt, null);
  }));

test("video_metrics_daily: a videoId with no matching videos row is rejected by its foreign key", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await assert.rejects(
      () =>
        upsertVideoMetric(
          { channelId: "UC_TEST", videoId: "nonexistent", metricDate: "2026-09-20", metricName: "views", metricValue: 100 },
          isolatedDb
        ),
      // drizzle wraps the raw libsql error as `.cause` -- the FK failure text lives there,
      // not on the outer "Failed query: insert into ..." message (verified against the actual
      // rejection shape, not assumed).
      (error: unknown) =>
        error instanceof Error && /FOREIGN KEY constraint failed/.test(String(error.cause) + error.message),
      "must fail specifically on the videoId foreign key, not some unrelated error"
    );
  }));

// AC-SCHEMA-02
test("initializeDatabaseSchema: an existing pre-versioning database (baseline tables, no schema_meta) is stamped at the baseline version without altering existing data", () =>
  withTempClient(async (client) => {
    // Simulate a pre-this-task database: run only the baseline (no schema_meta yet). We do
    // this by calling initializeDatabaseSchema once (creates schema_meta as a side effect of
    // migrations), then manually drop schema_meta to simulate "legacy" and insert a row.
    await initializeDatabaseSchema(client);
    await client.execute("DROP TABLE schema_meta");
    await client.execute({
      sql: "INSERT INTO users (id, email) VALUES (?, ?)",
      args: ["legacy-user", "legacy@example.com"],
    });

    await initializeDatabaseSchema(client);

    const users = await client.execute("SELECT id, email FROM users WHERE id = 'legacy-user'");
    assert.equal(users.rows.length, 1, "pre-existing row must survive re-initialization untouched");
    assert.equal(await readSchemaVersion(client), SCHEMA_CURRENT_VERSION);
    assert.equal(
      await tableExists(client, "analytics_collection_runs"),
      true,
      "a later migration (v13) must still apply correctly on the pre-versioning re-apply path"
    );
    assert.equal(
      await tableExists(client, "analytics_weekly_reports"),
      true,
      "a later migration (v14) must still apply correctly on the pre-versioning re-apply path"
    );
  }));

// AC-SCHEMA-04
test("initializeDatabaseSchema: rejects a database reporting a version newer than SCHEMA_CURRENT_VERSION, before any mutation", () =>
  withTempClient(async (client) => {
    await client.execute("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await client.execute({
      sql: "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)",
      args: [String(SCHEMA_CURRENT_VERSION + 1000)],
    });

    const before = await client.execute("SELECT name FROM sqlite_master ORDER BY name");
    const beforeNames = before.rows.map((r) => r.name);

    await assert.rejects(
      () => initializeDatabaseSchema(client),
      (error: unknown) => error instanceof SchemaVersionError
    );

    const after = await client.execute("SELECT name FROM sqlite_master ORDER BY name");
    const afterNames = after.rows.map((r) => r.name);
    assert.deepEqual(afterNames, beforeNames, "rejected database must be byte-for-byte unchanged in shape");
  }));

// AC-SCHEMA-08
test("initializeDatabaseSchema: beforeMigrations hook fires with a real pre-migration backup opportunity before pending migrations run", () =>
  withTempClient(async (client, dir) => {
    // Force a scenario where at least one migration is pending: stamp the DB at the baseline
    // version only (simulating "already migrated once, one new migration shipped since").
    await client.execute("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await client.execute({
      sql: "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)",
      args: [String(SCHEMA_BASELINE_VERSION)],
    });
    // Baseline tables must exist too (initializeDatabaseSchema's own baseline block is
    // idempotent and would create them, but the hook fires before that point isn't relevant
    // here -- we only care that the hook fires exactly when migrations are pending).

    let hookCalled = false;
    let hookSawPendingMigrations: number[] = [];
    const backupPath = path.join(dir, "pre-migration-backup.db");

    await initializeDatabaseSchema(client, {
      beforeMigrations: async ({ fromVersion, pendingMigrations }) => {
        hookCalled = true;
        hookSawPendingMigrations = pendingMigrations.map((m) => m.version);
        assert.equal(fromVersion, SCHEMA_BASELINE_VERSION);
        // Real backup mechanism, same one db.ts's singleton boot uses.
        const { copyDatabaseConsistently } = await import("@/lib/db-backup");
        await copyDatabaseConsistently(client, backupPath);
      },
    });

    assert.equal(hookCalled, SCHEMA_MIGRATIONS.some((m) => m.version > SCHEMA_BASELINE_VERSION));
    if (hookCalled) {
      assert.deepEqual(
        hookSawPendingMigrations,
        SCHEMA_MIGRATIONS.filter((m) => m.version > SCHEMA_BASELINE_VERSION).map((m) => m.version)
      );
      const files = await readdir(dir);
      assert.ok(files.includes("pre-migration-backup.db"), "backup file must exist");
    }
  }));

// AC-SCHEMA-03
test("initializeDatabaseSchema: is idempotent -- re-running against an already-current database is a no-op on the version", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const first = await readSchemaVersion(client);
    await initializeDatabaseSchema(client);
    const second = await readSchemaVersion(client);
    assert.equal(first, second);
    assert.equal(second, SCHEMA_CURRENT_VERSION);
  }));

// AC-PATH-05: the previously entirely-untested legacy-migration core, found by independent
// review to be unreachable in a prior version of this file (a module-load-order bug meant
// existsSync(appPaths.dbPath) was always true by the time it was checked, silently skipping
// every legacy migration forever). This test exercises copyLegacyDatabaseInto directly,
// against real temp files, independent of the singleton/module-load wiring around it.
test("copyLegacyDatabaseInto: copies every table's schema and rows from the legacy file into an already-open destination connection", () =>
  withTempClient(async (destClient, dir) => {
    const legacyDbPath = path.join(dir, "legacy.db");
    const legacyClient = createClient({ url: `file:${legacyDbPath}` });
    try {
      await legacyClient.execute(
        "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)"
      );
      await legacyClient.execute({
        sql: "INSERT INTO users (id, email) VALUES (?, ?)",
        args: ["legacy-user", "legacy@example.com"],
      });
      await legacyClient.execute(
        "CREATE TABLE channels (id TEXT PRIMARY KEY, title TEXT NOT NULL)"
      );
      await legacyClient.execute({
        sql: "INSERT INTO channels (id, title) VALUES (?, ?)",
        args: ["chan-1", "Legacy Channel"],
      });
    } finally {
      legacyClient.close();
    }

    // Destination starts truly empty (no baseline schema yet) -- copyLegacyDatabaseInto must
    // recreate each table from the legacy file's own CREATE TABLE statement, not assume the
    // current baseline schema already exists.
    await copyLegacyDatabaseInto(destClient, legacyDbPath);

    const users = await destClient.execute("SELECT id, email FROM users");
    assert.deepEqual(users.rows, [{ id: "legacy-user", email: "legacy@example.com" }]);
    const channels = await destClient.execute("SELECT id, title FROM channels");
    assert.deepEqual(channels.rows, [{ id: "chan-1", title: "Legacy Channel" }]);

    // The legacy file itself must be untouched -- copyLegacyDatabaseInto never writes to it.
    const legacyRecheck = createClient({ url: `file:${legacyDbPath}` });
    const legacyUsersAfter = await legacyRecheck.execute("SELECT id, email FROM users");
    assert.deepEqual(legacyUsersAfter.rows, [{ id: "legacy-user", email: "legacy@example.com" }]);
    legacyRecheck.close();
  }));

// RISK-25 (docs/TECHNICAL_DEBT.md): a retry (e.g. after a previous boot's crashed migration
// attempt) must be safe to redo -- not fail on "table already exists" and not duplicate rows
// via a second INSERT into an already-populated table.
test("copyLegacyDatabaseInto: is idempotent -- calling it twice against the same destination never duplicates rows or fails", () =>
  withTempClient(async (destClient, dir) => {
    const legacyDbPath = path.join(dir, "legacy.db");
    const legacyClient = createClient({ url: `file:${legacyDbPath}` });
    try {
      await legacyClient.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)");
      await legacyClient.execute({
        sql: "INSERT INTO users (id, email) VALUES (?, ?)",
        args: ["legacy-user", "legacy@example.com"],
      });
    } finally {
      legacyClient.close();
    }

    await copyLegacyDatabaseInto(destClient, legacyDbPath);
    await copyLegacyDatabaseInto(destClient, legacyDbPath);

    const users = await destClient.execute("SELECT id, email FROM users");
    assert.deepEqual(users.rows, [{ id: "legacy-user", email: "legacy@example.com" }]);
  }));

// RISK-25: a failure partway through copying multiple tables must roll back completely --
// never leave the destination with some tables copied and others not (which previously
// permanently orphaned the rest of the operator's legacy data, since the retry gate saw the
// resulting file and concluded "already migrated").
test("copyLegacyDatabaseInto: a failure partway through rolls back every table, not just the one that failed", () =>
  withTempClient(async (destClient, dir) => {
    const legacyDbPath = path.join(dir, "legacy.db");
    const legacyClient = createClient({ url: `file:${legacyDbPath}` });
    try {
      await legacyClient.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)");
      await legacyClient.execute({
        sql: "INSERT INTO users (id, email) VALUES (?, ?)",
        args: ["legacy-user", "legacy@example.com"],
      });
      await legacyClient.execute("CREATE TABLE channels (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
      await legacyClient.execute({
        sql: "INSERT INTO channels (id, title) VALUES (?, ?)",
        args: ["chan-1", "Legacy Channel"],
      });
    } finally {
      legacyClient.close();
    }

    // A minimal fake wrapping the real client's `execute`, failing only on the INSERT for the
    // second table (`channels`) -- everything else (including COMMIT/ROLLBACK/DETACH) goes to
    // the real connection, so this exercises the real transaction boundary, not a mock of it.
    const flaky = {
      execute: (query: string | { sql: string; args?: unknown[] }) => {
        const sql = typeof query === "string" ? query : query.sql;
        if (sql.includes('INSERT INTO "channels"')) {
          throw new Error("simulated disk failure partway through the copy");
        }
        return destClient.execute(query as never);
      },
    } as unknown as Client;

    await assert.rejects(
      () => copyLegacyDatabaseInto(flaky, legacyDbPath),
      /simulated disk failure/
    );

    // Neither table survived -- not even `users`, whose own copy succeeded before `channels`
    // failed. A partial result here would be exactly the silent data loss RISK-25 describes.
    assert.equal(await tableExists(destClient, "users"), false);
    assert.equal(await tableExists(destClient, "channels"), false);
  }));

// cloud_connection (SCHEMA_MIGRATIONS version 11, docs/decisions/0008-cloud-connection.md): a
// true singleton row, keyed internally on a fixed id -- never exposed to callers, who only ever
// see "connected or not."
test("getStoredCloudConnection: returns null before anything is ever connected", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    assert.equal(await getStoredCloudConnection(isolatedDb), null);
  }));

test("upsertStoredCloudConnection then getStoredCloudConnection round-trips the stored fields", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await upsertStoredCloudConnection(
      { connectedEmail: "owner@example.com", scope: "https://www.googleapis.com/auth/cloud-platform", ciphertext: "c1", iv: "i1", authTag: "t1" },
      isolatedDb
    );

    const stored = await getStoredCloudConnection(isolatedDb);
    assert.equal(stored?.connectedEmail, "owner@example.com");
    assert.equal(stored?.scope, "https://www.googleapis.com/auth/cloud-platform");
    assert.equal(stored?.ciphertext, "c1");
    assert.ok(stored?.connectedAt instanceof Date);
  }));

test("upsertStoredCloudConnection called twice replaces the single row rather than inserting a second one", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await upsertStoredCloudConnection(
      { connectedEmail: "first@example.com", scope: "scope-a", ciphertext: "c1", iv: "i1", authTag: "t1" },
      isolatedDb
    );
    await upsertStoredCloudConnection(
      { connectedEmail: "second@example.com", scope: "scope-b", ciphertext: "c2", iv: "i2", authTag: "t2" },
      isolatedDb
    );

    const stored = await getStoredCloudConnection(isolatedDb);
    assert.equal(stored?.connectedEmail, "second@example.com");

    const rowCount = await client.execute("SELECT COUNT(*) as count FROM cloud_connection");
    assert.equal(rowCount.rows[0]?.count, 1);
  }));

test("clearStoredCloudConnection removes the row -- a later getStoredCloudConnection sees disconnected", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await upsertStoredCloudConnection(
      { connectedEmail: "owner@example.com", scope: "scope-a", ciphertext: "c1", iv: "i1", authTag: "t1" },
      isolatedDb
    );
    assert.ok(await getStoredCloudConnection(isolatedDb));

    await clearStoredCloudConnection(isolatedDb);
    assert.equal(await getStoredCloudConnection(isolatedDb), null);
  }));
