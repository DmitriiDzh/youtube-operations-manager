import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import {
  channels,
  clearStoredCloudConnection,
  contentProposalArtifacts,
  contentProposals,
  copyLegacyDatabaseInto,
  createIsolatedDb,
  gatewayCallEvents,
  getAnalyticsReadsEnabled,
  getAnalyticsSyncSettings,
  getContentProposalArtifactLinkById,
  getContentProposalById,
  getCreativeAssetById,
  getDataApiReadsEnabled,
  getGatewayTrafficLast24h,
  getStoredCloudConnection,
  getWeeklyReportByWeek,
  initializeDatabaseSchema,
  insertContentProposal,
  insertContentProposalArtifactLink,
  insertCreativeAsset,
  listAnalyticsCollectionRunsByChannel,
  listContentProposalArtifactLinksByProposal,
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
  researchChannels,
  researchEvidence,
  deleteResearchChannel,
  marketChannelSnapshots,
  marketVideoSnapshots,
  marketIntelligenceCollectionRuns,
  insertMarketChannelSnapshot,
  listMarketChannelSnapshotsByChannel,
  insertMarketVideoSnapshot,
  claimStaleResearchChannelsForCollection,
  releaseResearchChannelCollectionClaim,
  listRecentlyFailedResearchChannelIds,
  markResearchChannelAutoCollected,
  insertMarketIntelligenceCollectionRun,
  getMarketIntelligenceUnitsSpentSince,
  marketDiscoveryCandidates,
  marketDiscoveryRuns,
  getMarketDiscoveryCandidateById,
  listMarketDiscoveryCandidates,
  insertMarketDiscoveryCandidate,
  touchMarketDiscoveryCandidateLastSeen,
  setMarketDiscoveryCandidateStatus,
  insertMarketDiscoveryRun,
  marketTopicAssignments,
  listMarketTopics,
  getMarketTopicById,
  insertMarketTopic,
  deleteMarketTopic,
  listAssignmentsForTopic,
  listTopicsForSubject,
  insertMarketTopicAssignment,
  deleteMarketTopicAssignment,
  listMarketTrendCandidates,
  getMarketTrendCandidateById,
  insertMarketTrendCandidate,
  insertMarketTrendCandidateWithInitialEvidence,
  updateMarketTrendCandidateStatusWithEvidence,
  touchMarketTrendCandidateLastObservedAt,
  listTrendEvidence,
  insertMarketTrendEvidence,
  insertMarketResearchRequest,
  getMarketResearchRequestById,
  listMarketResearchRequests,
  approveMarketResearchRequestIfPending,
  rejectMarketResearchRequestIfPending,
  recordMarketResearchRequestExecutionOutcome,
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
    assert.equal(await tableExists(client, "content_proposal_artifacts"), true);
    assert.equal(await tableExists(client, "market_channel_snapshots"), true);
    assert.equal(await tableExists(client, "market_video_snapshots"), true);
    assert.equal(await tableExists(client, "market_intelligence_collection_runs"), true);
    assert.equal(await tableExists(client, "market_discovery_candidates"), true);
    assert.equal(await tableExists(client, "market_discovery_runs"), true);
    assert.equal(await tableExists(client, "market_topics"), true);
    assert.equal(await tableExists(client, "market_topic_assignments"), true);
    assert.equal(await tableExists(client, "market_trend_candidates"), true);
    assert.equal(await tableExists(client, "market_trend_evidence"), true);
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
// agent-operations' own capability description) -- proven here with three rows whose `createdAt`
// order is deliberately DECOUPLED from both insertion order (rowid) and id (a random UUID, not a
// hand-picked string this test could accidentally make sort the "right" way). With only two rows,
// a `createdAt`-DESC-correct expectation is mathematically indistinguishable from at least one of
// {rowid ascending, rowid descending, id ascending, id descending} -- a prior version of this test
// (independent review, two earlier rounds) kept accidentally coinciding with one of those wrong
// orderings while believing it had ruled all of them out. Three rows, with createdAt order equal
// to neither insertion order nor its reverse, closes that gap: inserted in order first/second/
// third, but createdAt-newest-to-oldest is second, first, third -- a sequence no rowid-based or
// id-based ordering can reproduce by coincidence. Same-second ties are a known, accepted
// limitation shared with every other `orderBy(desc(...createdAt))` list function in this file
// (creative_assets, batches, ai_connections) -- not a new gap introduced by this table.
test("content_proposals: listContentProposalsByChannel actually orders by createdAt, newest first", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannel(isolatedDb, "UC_A");

    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();

    // Insertion order: first, second, third (ascending rowid). createdAt order (newest to
    // oldest): second, first, third -- a permutation matching neither rowid ascending
    // ([first, second, third]) nor descending ([third, second, first]), and unrelated to the ids'
    // own (random) lexical order.
    await isolatedDb.insert(contentProposals).values({
      id: first,
      channelId: "UC_A",
      createdVia: "web_ui",
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    await isolatedDb.insert(contentProposals).values({
      id: second,
      channelId: "UC_A",
      createdVia: "web_ui",
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    await isolatedDb.insert(contentProposals).values({
      id: third,
      channelId: "UC_A",
      createdVia: "web_ui",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const all = await listContentProposalsByChannel("UC_A", isolatedDb);
    assert.deepEqual(all.map((p) => p.id), [second, first, third]);
  }));

// Phase 7 slice G2 (docs/AGENT_OPERATIONS_INTERFACE.md §4f, owner spec §19).
test("content_proposal_artifacts: inserts and lists by proposal, enforcing the proposal/asset foreign keys", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannel(isolatedDb, "UC_A");

    await insertContentProposal({ id: "proposal-1", channelId: "UC_A", createdVia: "web_ui" }, isolatedDb);
    await insertCreativeAsset(
      { id: "asset-1", channelId: "UC_A", assetType: "thumbnail", referenceKind: "url", referenceValue: "https://example.com/a.png" },
      isolatedDb
    );

    await insertContentProposalArtifactLink(
      { id: "link-1", proposalId: "proposal-1", assetId: "asset-1", createdVia: "mcp", agentApiVersion: "0.6.0" },
      isolatedDb
    );

    const links = await listContentProposalArtifactLinksByProposal("proposal-1", isolatedDb);
    assert.equal(links.length, 1);
    assert.equal(links[0].assetId, "asset-1");
    assert.equal(links[0].createdVia, "mcp");
    assert.equal(links[0].agentApiVersion, "0.6.0");

    const fetched = await getContentProposalArtifactLinkById("link-1", isolatedDb);
    assert.equal(fetched?.proposalId, "proposal-1");

    // A proposal that doesn't exist must fail the FK, not silently create an orphaned link.
    await assert.rejects(() =>
      insertContentProposalArtifactLink(
        { id: "link-2", proposalId: "proposal-never-created", assetId: "asset-1", createdVia: "web_ui" },
        isolatedDb
      )
    );

    // Same for an asset that doesn't exist.
    await assert.rejects(() =>
      insertContentProposalArtifactLink(
        { id: "link-3", proposalId: "proposal-1", assetId: "asset-never-created", createdVia: "web_ui" },
        isolatedDb
      )
    );
  }));

// Regression: `listContentProposalArtifactLinksByProposal` claims "newest first"
// (docs/interfaces.md, agent-operations' own capability description) -- same discrimination
// requirement, and same fix shape, as the `content_proposals` ordering test above (three rows,
// random-UUID ids, a createdAt permutation matching neither insertion order nor its reverse).
// With only one or two rows, a `createdAt`-DESC-correct expectation cannot be distinguished from
// rowid- or id-based ordering by coincidence.
test("content_proposal_artifacts: listContentProposalArtifactLinksByProposal actually orders by createdAt, newest first", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await seedChannel(isolatedDb, "UC_A");
    await insertContentProposal({ id: "proposal-1", channelId: "UC_A", createdVia: "web_ui" }, isolatedDb);

    const firstAsset = randomUUID();
    const secondAsset = randomUUID();
    const thirdAsset = randomUUID();
    for (const assetId of [firstAsset, secondAsset, thirdAsset]) {
      await insertCreativeAsset(
        { id: assetId, channelId: "UC_A", assetType: "thumbnail", referenceKind: "url", referenceValue: `https://example.com/${assetId}.png` },
        isolatedDb
      );
    }

    const firstLink = randomUUID();
    const secondLink = randomUUID();
    const thirdLink = randomUUID();

    // Insertion order: firstLink, secondLink, thirdLink (ascending rowid). createdAt order
    // (newest to oldest): secondLink, firstLink, thirdLink -- a permutation matching neither
    // rowid ascending nor descending, and unrelated to the ids' own (random) lexical order.
    await isolatedDb.insert(contentProposalArtifacts).values({
      id: firstLink,
      proposalId: "proposal-1",
      assetId: firstAsset,
      createdVia: "web_ui",
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    await isolatedDb.insert(contentProposalArtifacts).values({
      id: secondLink,
      proposalId: "proposal-1",
      assetId: secondAsset,
      createdVia: "web_ui",
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    await isolatedDb.insert(contentProposalArtifacts).values({
      id: thirdLink,
      proposalId: "proposal-1",
      assetId: thirdAsset,
      createdVia: "web_ui",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const links = await listContentProposalArtifactLinksByProposal("proposal-1", isolatedDb);
    assert.deepEqual(
      links.map((l) => l.id),
      [secondLink, firstLink, thirdLink]
    );
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
    // Phase 7 slice K, AC-DUR-05: a later ADD-COLUMN migration (v19, not just a CREATE TABLE
    // migration like v13/v14 above) must also survive the pre-versioning re-apply path -- this
    // is exactly the `isDuplicateColumnError`-tolerance scenario RISK-33 already documents for
    // v4's own view_count/comment_count/like_count columns.
    await client.execute(
      "INSERT INTO channels (id, title, uploads_playlist_id) VALUES ('UC_PREV', 'x', 'UU_PREV')"
    );
    // Owner instruction, 2026-09-26 (Content tab's "Publish" column) -- same ADD-COLUMN
    // re-apply scenario, two migrations later (v21, videos.publish_at), checked in the same
    // INSERT as v19's own duration_seconds column above.
    await client.execute(
      "INSERT INTO videos (id, channel_id, title, description, published_at, privacy_status, thumbnails_json, localizations_json, duration_seconds, publish_at) " +
        "VALUES ('v_prev', 'UC_PREV', 't', '', '2026-01-01T00:00:00Z', 'private', '{}', '{}', 630, '2026-10-15T09:00:00.000Z')"
    );
    const videoRow = await client.execute("SELECT duration_seconds, publish_at FROM videos WHERE id = 'v_prev'");
    assert.equal(
      videoRow.rows[0]?.duration_seconds,
      630,
      "a later migration (v19, ADD COLUMN) must still apply correctly on the pre-versioning re-apply path"
    );
    assert.equal(
      videoRow.rows[0]?.publish_at,
      "2026-10-15T09:00:00.000Z",
      "a later migration (v21, ADD COLUMN) must still apply correctly on the pre-versioning re-apply path"
    );
    // Phase 9 slice 1 -- a later CREATE-TABLE migration (v22) must also survive the
    // pre-versioning re-apply path, same as v13/v14's own assertions above.
    assert.equal(
      await tableExists(client, "research_channels"),
      true,
      "a later migration (v22) must still apply correctly on the pre-versioning re-apply path"
    );
    assert.equal(
      await tableExists(client, "research_evidence"),
      true,
      "a later migration (v22) must still apply correctly on the pre-versioning re-apply path"
    );
    // Phase 9 slice 9A -- a later CREATE-TABLE migration (v23) must also survive the
    // pre-versioning re-apply path, same as v22's own assertions above.
    assert.equal(
      await tableExists(client, "market_channel_snapshots"),
      true,
      "a later migration (v23) must still apply correctly on the pre-versioning re-apply path"
    );
    assert.equal(
      await tableExists(client, "market_video_snapshots"),
      true,
      "a later migration (v23) must still apply correctly on the pre-versioning re-apply path"
    );
    // Phase 9 slice 9B -- a later ALTER-TABLE + CREATE-TABLE migration (v24) must also survive the
    // pre-versioning re-apply path, same as v22/v23's own assertions above.
    assert.equal(
      await tableExists(client, "market_intelligence_collection_runs"),
      true,
      "a later migration (v24) must still apply correctly on the pre-versioning re-apply path"
    );
    const researchChannelColumns = await client.execute("PRAGMA table_info(research_channels)");
    const researchChannelColumnNames = researchChannelColumns.rows.map((row) => row.name);
    assert.ok(
      researchChannelColumnNames.includes("last_auto_collected_at"),
      "a later ALTER TABLE migration (v24) must still apply correctly on the pre-versioning re-apply path"
    );
    assert.ok(
      researchChannelColumnNames.includes("collection_claimed_at"),
      "a later ALTER TABLE migration (v24) must still apply correctly on the pre-versioning re-apply path"
    );
    // Phase 9 slice 9C -- a later CREATE-TABLE migration (v25) must also survive the
    // pre-versioning re-apply path, same as v22/v23/v24's own assertions above.
    assert.equal(
      await tableExists(client, "market_discovery_candidates"),
      true,
      "a later migration (v25) must still apply correctly on the pre-versioning re-apply path"
    );
    assert.equal(
      await tableExists(client, "market_discovery_runs"),
      true,
      "a later migration (v25) must still apply correctly on the pre-versioning re-apply path"
    );
    // Phase 9 slice 9E -- a later CREATE-TABLE migration (v26) must also survive the
    // pre-versioning re-apply path, same as v22/v23/v24/v25's own assertions above.
    for (const table of ["market_topics", "market_topic_assignments", "market_trend_candidates", "market_trend_evidence"]) {
      assert.equal(
        await tableExists(client, table),
        true,
        `a later migration (v26) must still apply correctly on the pre-versioning re-apply path (${table})`
      );
    }
  }));

// Phase 7 slice K (owner spec §10 -- AC-DUR-01). `upsertVideos`/`listStoredVideosByChannel`
// always use the module-level singleton `db`, not an injectable one (a pre-existing gap, not
// introduced by this slice, and out of this slice's own scope to retrofit) -- so this proves the
// same round trip directly against an isolated temp database via Drizzle, the same way this
// file's own `seedVideo` helper already does, confirming the schema column and its mapping
// (`mapStoredVideo`'s `durationSeconds: row.durationSeconds`) actually round-trip correctly.
test("videos.duration_seconds round-trips through the real Drizzle schema, and stays null when never provided (never a fabricated 0)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(channels).values({
      id: "UC_A",
      title: "Test Channel",
      thumbnailUrl: null,
      uploadsPlaylistId: "UU_TEST",
      connectedUserId: null,
    });

    await isolatedDb.insert(videos).values({
      id: "v_with_duration",
      channelId: "UC_A",
      title: "Title",
      description: "",
      publishedAt: "2026-01-01T00:00:00.000Z",
      privacyStatus: "public",
      thumbnailsJson: "{}",
      localizationsJson: "{}",
      durationSeconds: 630,
    });
    await isolatedDb.insert(videos).values({
      id: "v_without_duration",
      channelId: "UC_A",
      title: "Title",
      description: "",
      publishedAt: "2026-01-01T00:00:00.000Z",
      privacyStatus: "public",
      thumbnailsJson: "{}",
      localizationsJson: "{}",
    });

    const rows = await isolatedDb.select().from(videos).where(eq(videos.channelId, "UC_A"));
    const byId = new Map(rows.map((v) => [v.id, v]));
    assert.equal(byId.get("v_with_duration")?.durationSeconds, 630);
    assert.equal(byId.get("v_without_duration")?.durationSeconds, null);
  }));

// Proves the schema column and its mapping (`mapStoredVideo`'s `publishAt: row.publishAt`) round
// trip correctly, and that a video with no scheduled publish time stays `null` rather than being
// fabricated as an empty string or copied from `publishedAt`.
test("videos.publish_at round-trips through the real Drizzle schema, and stays null when never provided", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(channels).values({
      id: "UC_B",
      title: "Test Channel",
      thumbnailUrl: null,
      uploadsPlaylistId: "UU_TEST_B",
      connectedUserId: null,
    });

    await isolatedDb.insert(videos).values({
      id: "v_scheduled",
      channelId: "UC_B",
      title: "Title",
      description: "",
      publishedAt: "2026-01-01T00:00:00.000Z",
      privacyStatus: "private",
      thumbnailsJson: "{}",
      localizationsJson: "{}",
      publishAt: "2026-10-15T09:00:00.000Z",
    });
    await isolatedDb.insert(videos).values({
      id: "v_not_scheduled",
      channelId: "UC_B",
      title: "Title",
      description: "",
      publishedAt: "2026-01-01T00:00:00.000Z",
      privacyStatus: "public",
      thumbnailsJson: "{}",
      localizationsJson: "{}",
    });

    const rows = await isolatedDb.select().from(videos).where(eq(videos.channelId, "UC_B"));
    const byId = new Map(rows.map((v) => [v.id, v]));
    assert.equal(byId.get("v_scheduled")?.publishAt, "2026-10-15T09:00:00.000Z");
    assert.equal(byId.get("v_not_scheduled")?.publishAt, null);
  }));

// Phase 9 slice 1 -- proves research_channels/research_evidence round-trip through the real
// Drizzle schema, are never joined against channels/videos, and that a channel id here need not
// exist in the (owned-channel) `channels` table at all -- the entire point of this table. This
// test proves the DATA-LEVEL half of that separation (no row appears in `channels` for a
// research-only id); the STRUCTURAL half (no other module's code can even reference
// research_channels/research_evidence, by symbol or by raw SQL table name, including
// `channel-access`/`listStoredVideosByChannel`) is proven instead by
// `src/lib/market-intelligence/write-path-inventory.test.ts`'s PHASE9-INV-02 -- `channel-access`
// itself never reads channel/video content tables at all (it only compares a channelId against
// the session's active-channel selection), and `listStoredVideosByChannel` always uses the
// module-level singleton `db` (not injectable), so neither can be exercised against this file's
// own isolated temp database the way the Drizzle assertions below are.
test("research_channels/research_evidence round-trip through the real Drizzle schema, independent of channels/videos", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await isolatedDb.insert(researchChannels).values({
      id: "UC_NOT_OWNED_00000000000",
      handleOrUrl: "@competitor",
      reason: "Fast-growing in the same niche",
      createdVia: "web_ui",
    });

    await isolatedDb.insert(researchEvidence).values({
      id: "evidence-1",
      researchChannelId: "UC_NOT_OWNED_00000000000",
      observation: "Published 3 videos this week",
      source: "manual observation",
      confidence: "high",
      createdVia: "web_ui",
    });
    await isolatedDb.insert(researchEvidence).values({
      id: "evidence-2",
      researchChannelId: "UC_NOT_OWNED_00000000000",
      observation: "Subscriber count as of 2026-09-26",
      source: "youtube.channels.list",
      createdVia: "web_ui",
    });

    const channelRows = await isolatedDb.select().from(researchChannels);
    assert.equal(channelRows.length, 1);
    assert.equal(channelRows[0].reason, "Fast-growing in the same niche");

    const evidenceRows = await isolatedDb
      .select()
      .from(researchEvidence)
      .where(eq(researchEvidence.researchChannelId, "UC_NOT_OWNED_00000000000"));
    assert.equal(evidenceRows.length, 2);
    const bySource = new Map(evidenceRows.map((row) => [row.source, row]));
    assert.equal(bySource.get("manual observation")?.confidence, "high");
    assert.equal(
      bySource.get("youtube.channels.list")?.confidence,
      null,
      "confidence must stay null rather than a fabricated default when never provided"
    );

    // The owned-channel `channels` table has no row for this id at all -- proves this is not an
    // oversight, it is the whole point: research_channels never requires the channel to be owned.
    const ownedChannelRows = await isolatedDb.select().from(channels);
    assert.equal(ownedChannelRows.length, 0);
  }));

// Added by independent review (2026-09-26, Phase 9 slice 1 follow-up): deleteResearchChannel
// must delete evidence rows before the channel row (RISK-46's own FK-ordering lesson, found the
// hard way earlier in this same project) -- proven here against the real schema with
// foreign_keys=ON, not just asserted by a fake in-memory store in services.test.ts.
test("deleteResearchChannel removes the channel and every evidence row recorded against it, in one transaction", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await isolatedDb.insert(researchChannels).values({
      id: "UC_TO_DELETE_000000000",
      reason: "Temporary",
      createdVia: "web_ui",
    });
    await isolatedDb.insert(researchEvidence).values({
      id: "evidence-to-delete",
      researchChannelId: "UC_TO_DELETE_000000000",
      observation: "Will be deleted",
      source: "manual observation",
      createdVia: "web_ui",
    });

    await deleteResearchChannel("UC_TO_DELETE_000000000", isolatedDb);

    const channelRows = await isolatedDb.select().from(researchChannels);
    assert.equal(channelRows.length, 0);
    const evidenceRows = await isolatedDb.select().from(researchEvidence);
    assert.equal(evidenceRows.length, 0, "evidence must be deleted along with its channel, never left orphaned");
  }));

// Phase 9 slice 9A -- proves market_channel_snapshots/market_video_snapshots round-trip through
// the real Drizzle schema, are append-only (each insert is its own row, never upserted), and never
// fabricate a missing numeric field as 0. Structural isolation (no other module's code can
// reference these tables) is proven by write-path-inventory.test.ts's PHASE9-INV-02, same as
// research_channels/research_evidence above.
test("market_channel_snapshots/market_video_snapshots round-trip through the real Drizzle schema, append-only, never fabricating a missing numeric field", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await isolatedDb.insert(researchChannels).values({
      id: "UC_SNAPSHOT_TARGET_0000",
      reason: "Tracking growth",
      createdVia: "web_ui",
    });

    await insertMarketChannelSnapshot(
      {
        id: "snap-1",
        researchChannelId: "UC_SNAPSHOT_TARGET_0000",
        subscriberCount: 1000,
        viewCount: 50000,
        videoCount: 20,
        source: "youtube.channels.list",
        createdVia: "web_ui",
      },
      isolatedDb
    );
    // A second real observation of the SAME channel is its own new row, never an upsert -- proves
    // the append-only shape (PHASE_9_SLICE_9A_PLAN.md §2).
    await insertMarketChannelSnapshot(
      {
        id: "snap-2",
        researchChannelId: "UC_SNAPSHOT_TARGET_0000",
        subscriberCount: null,
        hiddenSubscriberCount: true,
        viewCount: 52000,
        videoCount: 21,
        source: "youtube.channels.list",
        createdVia: "web_ui",
      },
      isolatedDb
    );

    const channelSnapshots = await listMarketChannelSnapshotsByChannel("UC_SNAPSHOT_TARGET_0000", isolatedDb);
    assert.equal(channelSnapshots.length, 2, "each observation must be its own row, never upserted");
    assert.equal(channelSnapshots[0].id, "snap-1", "list must be oldest first");
    assert.equal(channelSnapshots[1].subscriberCount, null, "a hidden subscriber count must stay null, never a fabricated 0");
    assert.equal(channelSnapshots[1].hiddenSubscriberCount, true);
    assert.equal(channelSnapshots[0].hiddenSubscriberCount, false, "default must be false, not left undefined/null");

    await insertMarketVideoSnapshot(
      {
        id: "video-snap-1",
        researchChannelId: "UC_SNAPSHOT_TARGET_0000",
        videoId: "v_competitor_1",
        viewCount: 5000,
        source: "manual observation",
        createdVia: "web_ui",
      },
      isolatedDb
    );
    const videoSnapshotRows = await isolatedDb
      .select()
      .from(marketVideoSnapshots)
      .where(eq(marketVideoSnapshots.researchChannelId, "UC_SNAPSHOT_TARGET_0000"));
    assert.equal(videoSnapshotRows.length, 1);
    assert.equal(videoSnapshotRows[0].likeCount, null, "an omitted field must stay null, never a fabricated 0");
    assert.equal(videoSnapshotRows[0].publishedAt, null);
  }));

// Phase 9 slice 9A -- widens the existing deleteResearchChannel cascade-delete test above to cover
// the two new snapshot tables, which carry the identical FK onto researchChannels.id.
test("deleteResearchChannel also cascade-deletes market_channel_snapshots/market_video_snapshots for the same channel", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await isolatedDb.insert(researchChannels).values({
      id: "UC_TO_DELETE_SNAPSHOTS0",
      reason: "Temporary",
      createdVia: "web_ui",
    });
    await insertMarketChannelSnapshot(
      { id: "snap-to-delete", researchChannelId: "UC_TO_DELETE_SNAPSHOTS0", source: "manual observation", createdVia: "web_ui" },
      isolatedDb
    );
    await insertMarketVideoSnapshot(
      {
        id: "video-snap-to-delete",
        researchChannelId: "UC_TO_DELETE_SNAPSHOTS0",
        videoId: "v_x",
        source: "manual observation",
        createdVia: "web_ui",
      },
      isolatedDb
    );

    await deleteResearchChannel("UC_TO_DELETE_SNAPSHOTS0", isolatedDb);

    const channelSnapshotRows = await isolatedDb.select().from(marketChannelSnapshots);
    assert.equal(channelSnapshotRows.length, 0, "channel snapshots must be deleted along with their channel, never left orphaned");
    const videoSnapshotRows = await isolatedDb.select().from(marketVideoSnapshots);
    assert.equal(videoSnapshotRows.length, 0, "video snapshots must be deleted along with their channel, never left orphaned");
  }));

// Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md §9) -- proves the mark-then-run
// claim's own atomicity against the REAL SQLite driver, not a service-level fake (AGENTS.md §L: a
// fake in-memory store can only prove the fake is self-consistent, never that the underlying
// `UPDATE ... WHERE ... RETURNING` statement is genuinely a compare-and-swap).
test("claimStaleResearchChannelsForCollection: a second concurrent claim attempt gets nothing for a channel the first already claimed", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values([
      { id: "UC_STALE_NEVER_COLLECTED0", reason: "r", createdVia: "web_ui" },
      { id: "UC_STALE_ALREADY_CLAIMED0", reason: "r", createdVia: "web_ui" },
    ]);

    const now = new Date("2026-09-27T12:00:00.000Z");
    const staleCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const claimExpiryCutoff = new Date(now.getTime() - 15 * 60 * 1000);

    const firstClaim = await claimStaleResearchChannelsForCollection(
      { now, staleCutoff, claimExpiryCutoff, excludeResearchChannelIds: [] },
      isolatedDb
    );
    assert.deepEqual(
      [...firstClaim].sort(),
      ["UC_STALE_ALREADY_CLAIMED0", "UC_STALE_NEVER_COLLECTED0"],
      "both never-collected channels must be claimed by the first caller"
    );

    const secondClaim = await claimStaleResearchChannelsForCollection(
      { now, staleCutoff, claimExpiryCutoff, excludeResearchChannelIds: [] },
      isolatedDb
    );
    assert.deepEqual(secondClaim, [], "a second concurrent claim attempt must see both channels already claimed, and get nothing");

    await releaseResearchChannelCollectionClaim("UC_STALE_ALREADY_CLAIMED0", isolatedDb);
    const thirdClaim = await claimStaleResearchChannelsForCollection(
      { now, staleCutoff, claimExpiryCutoff, excludeResearchChannelIds: [] },
      isolatedDb
    );
    assert.deepEqual(
      thirdClaim,
      ["UC_STALE_ALREADY_CLAIMED0"],
      "releasing a claim must make that channel (and only that channel) claimable again"
    );
  }));

test("claimStaleResearchChannelsForCollection: a claim older than claimExpiryCutoff is treated as abandoned and can be reclaimed", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({ id: "UC_ABANDONED_CLAIM00000", reason: "r", createdVia: "web_ui" });

    const firstAttemptTime = new Date("2026-09-27T00:00:00.000Z");
    await claimStaleResearchChannelsForCollection(
      {
        now: firstAttemptTime,
        staleCutoff: new Date(firstAttemptTime.getTime() - 24 * 60 * 60 * 1000),
        claimExpiryCutoff: new Date(firstAttemptTime.getTime() - 15 * 60 * 1000),
        excludeResearchChannelIds: [],
      },
      isolatedDb
    );
    // Simulates a crashed process that claimed the channel and never released it -- the claim is
    // now 20 minutes old.
    const laterTime = new Date(firstAttemptTime.getTime() + 20 * 60 * 1000);
    const reclaim = await claimStaleResearchChannelsForCollection(
      {
        now: laterTime,
        staleCutoff: new Date(laterTime.getTime() - 24 * 60 * 60 * 1000),
        claimExpiryCutoff: new Date(laterTime.getTime() - 15 * 60 * 1000),
        excludeResearchChannelIds: [],
      },
      isolatedDb
    );
    assert.deepEqual(reclaim, ["UC_ABANDONED_CLAIM00000"], "a claim older than the expiry cutoff must be reclaimable, never stuck forever");
  }));

test("claimStaleResearchChannelsForCollection: excludeResearchChannelIds keeps a recently-failed channel out of the claimed set", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values([
      { id: "UC_RECENTLY_FAILED00000", reason: "r", createdVia: "web_ui" },
      { id: "UC_NEVER_FAILED0000000", reason: "r", createdVia: "web_ui" },
    ]);

    const now = new Date("2026-09-27T12:00:00.000Z");
    const claimed = await claimStaleResearchChannelsForCollection(
      {
        now,
        staleCutoff: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        claimExpiryCutoff: new Date(now.getTime() - 15 * 60 * 1000),
        excludeResearchChannelIds: ["UC_RECENTLY_FAILED00000"],
      },
      isolatedDb
    );
    assert.deepEqual(claimed, ["UC_NEVER_FAILED0000000"]);
  }));

test("listRecentlyFailedResearchChannelIds: returns only channels whose most recent run is a failure within the window, deduped", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values([
      { id: "UC_FAILED_TWICE0000000", reason: "r", createdVia: "web_ui" },
      { id: "UC_SUCCEEDED000000000", reason: "r", createdVia: "web_ui" },
      { id: "UC_FAILED_LONG_AGO0000", reason: "r", createdVia: "web_ui" },
    ]);

    const now = new Date("2026-09-27T12:00:00.000Z");
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    await insertMarketIntelligenceCollectionRun(
      { researchChannelId: "UC_FAILED_TWICE0000000", status: "failed", unitsSpent: 1, errorMessage: "boom" },
      isolatedDb
    );
    await isolatedDb
      .update(marketIntelligenceCollectionRuns)
      .set({ ranAt: now })
      .where(eq(marketIntelligenceCollectionRuns.researchChannelId, "UC_FAILED_TWICE0000000"));
    await insertMarketIntelligenceCollectionRun(
      { researchChannelId: "UC_FAILED_TWICE0000000", status: "failed", unitsSpent: 1, errorMessage: "boom again" },
      isolatedDb
    );
    await insertMarketIntelligenceCollectionRun(
      { researchChannelId: "UC_SUCCEEDED000000000", status: "success", unitsSpent: 3 },
      isolatedDb
    );
    await insertMarketIntelligenceCollectionRun(
      { researchChannelId: "UC_FAILED_LONG_AGO0000", status: "failed", unitsSpent: 1, errorMessage: "old failure" },
      isolatedDb
    );
    await isolatedDb
      .update(marketIntelligenceCollectionRuns)
      .set({ ranAt: new Date(since.getTime() - 60 * 60 * 1000) })
      .where(eq(marketIntelligenceCollectionRuns.researchChannelId, "UC_FAILED_LONG_AGO0000"));

    const recentlyFailed = await listRecentlyFailedResearchChannelIds(since, isolatedDb);
    assert.deepEqual(recentlyFailed, ["UC_FAILED_TWICE0000000"], "deduped to one entry, excludes success and excludes a failure outside the window");
  }));

test("markResearchChannelAutoCollected + getMarketIntelligenceUnitsSpentSince round-trip through the real Drizzle schema", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({ id: "UC_UNITS_SPENT00000000", reason: "r", createdVia: "web_ui" });

    const now = new Date("2026-09-27T12:00:00.000Z");
    await markResearchChannelAutoCollected("UC_UNITS_SPENT00000000", now, isolatedDb);
    const [channelRow] = await isolatedDb.select().from(researchChannels).where(eq(researchChannels.id, "UC_UNITS_SPENT00000000"));
    assert.equal(channelRow.lastAutoCollectedAt?.getTime(), now.getTime());

    await insertMarketIntelligenceCollectionRun(
      { researchChannelId: "UC_UNITS_SPENT00000000", status: "success", unitsSpent: 3, videosRequested: 10, videosReturned: 9 },
      isolatedDb
    );
    await insertMarketIntelligenceCollectionRun(
      { researchChannelId: "UC_UNITS_SPENT00000000", status: "skipped_quota_limited", unitsSpent: 1 },
      isolatedDb
    );

    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const totalSpent = await getMarketIntelligenceUnitsSpentSince(since, isolatedDb);
    assert.equal(totalSpent, 4, "sums units_spent across every status, including a partially-spent skipped_quota_limited row");

    const [runRow] = await isolatedDb
      .select()
      .from(marketIntelligenceCollectionRuns)
      .where(eq(marketIntelligenceCollectionRuns.status, "success"));
    assert.equal(runRow.videosRequested, 10, "videosRequested must round-trip, never fabricated");
    assert.equal(runRow.videosReturned, 9, "a gap between requested and returned must be preserved honestly, never silently corrected");
  }));

// Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md §9) -- market_discovery_candidates
// is a LIFECYCLE table (rediscovery touches lastSeenAt only, never duplicates or resets status),
// unlike the append-only snapshot tables above.
test("market_discovery_candidates round-trips through the real Drizzle schema; rediscovery touches lastSeenAt only, never duplicates or resets status", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await insertMarketDiscoveryCandidate(
      { id: "UC_CANDIDATE00000000000", title: "Discovered Channel", discoverySource: "youtube.search.list", discoveryQuery: "cooking", createdVia: "web_ui" },
      isolatedDb
    );
    const inserted = await getMarketDiscoveryCandidateById("UC_CANDIDATE00000000000", isolatedDb);
    assert.equal(inserted?.status, "new");
    assert.equal(inserted?.reasonDiscovered, null, "an omitted field must be null, never a fabricated empty string");

    await setMarketDiscoveryCandidateStatus("UC_CANDIDATE00000000000", "ignored", isolatedDb);
    // A fixed, whole-second timestamp -- integer-mode columns truncate sub-second precision, so a
    // Date.now()-derived value would flakily mismatch on round-trip depending on the current millisecond.
    const laterSeenAt = new Date("2026-09-28T00:00:00.000Z");
    await touchMarketDiscoveryCandidateLastSeen("UC_CANDIDATE00000000000", laterSeenAt, isolatedDb);

    const afterRediscovery = await getMarketDiscoveryCandidateById("UC_CANDIDATE00000000000", isolatedDb);
    assert.equal(afterRediscovery?.status, "ignored", "rediscovery must never reset an operator-set status back to new");
    assert.equal(afterRediscovery?.lastSeenAt.getTime(), laterSeenAt.getTime());

    const allRows = await isolatedDb.select().from(marketDiscoveryCandidates);
    assert.equal(allRows.length, 1, "rediscovery must never insert a duplicate row for the same channel");

    const listed = await listMarketDiscoveryCandidates(isolatedDb);
    assert.equal(listed.length, 1);
  }));

test("getMarketIntelligenceUnitsSpentSince sums market_intelligence_collection_runs AND market_discovery_runs -- one shared budget, not two independent ones", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({ id: "UC_SHARED_BUDGET000000", reason: "r", createdVia: "web_ui" });

    const now = new Date("2026-09-27T12:00:00.000Z");
    await insertMarketIntelligenceCollectionRun({ researchChannelId: "UC_SHARED_BUDGET000000", status: "success", unitsSpent: 3, ranAt: now }, isolatedDb);
    await insertMarketDiscoveryRun({ query: "cooking", status: "success", unitsSpent: 100, candidatesFound: 5, candidatesNew: 2, ranAt: now }, isolatedDb);
    await insertMarketDiscoveryRun({ query: "gaming", status: "failed", unitsSpent: 100, errorMessage: "boom", ranAt: now }, isolatedDb);

    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const totalSpent = await getMarketIntelligenceUnitsSpentSince(since, isolatedDb);
    assert.equal(totalSpent, 203, "must sum both tables (3 + 100 + 100), including a failed discovery run's own real spend");

    const [discoveryRunRow] = await isolatedDb.select().from(marketDiscoveryRuns).where(eq(marketDiscoveryRuns.status, "success"));
    assert.equal(discoveryRunRow.candidatesFound, 5, "candidatesFound must round-trip, never fabricated");
    assert.equal(discoveryRunRow.candidatesNew, 2);
  }));

// Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- topics/assignments round-trip.
test("market_topics/market_topic_assignments round-trip through the real Drizzle schema; the unique index rejects a duplicate (topic, subject) pair", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({ id: "UC_TOPIC_SUBJECT00000", reason: "r", createdVia: "web_ui" });

    await insertMarketTopic({ id: "topic-1", name: "Night Jazz Bar", createdVia: "web_ui" }, isolatedDb);
    const topic = await getMarketTopicById("topic-1", isolatedDb);
    assert.equal(topic?.name, "Night Jazz Bar");

    await insertMarketTopicAssignment(
      { id: "assign-1", topicId: "topic-1", subjectType: "channel", subjectId: "UC_TOPIC_SUBJECT00000", source: "manual", createdVia: "web_ui" },
      isolatedDb
    );
    const assignments = await listAssignmentsForTopic("topic-1", isolatedDb);
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].subjectType, "channel");

    const forSubject = await listTopicsForSubject("channel", "UC_TOPIC_SUBJECT00000", isolatedDb);
    assert.equal(forSubject.length, 1);

    await assert.rejects(
      () =>
        insertMarketTopicAssignment(
          { id: "assign-2", topicId: "topic-1", subjectType: "channel", subjectId: "UC_TOPIC_SUBJECT00000", source: "manual", createdVia: "web_ui" },
          isolatedDb
        ),
      "the real UNIQUE(topic_id, subject_type, subject_id) index must reject an exact-duplicate pair"
    );
  }));

test("deleteResearchChannel cascade-deletes channel-type market_topic_assignments for the same channel", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({ id: "UC_TOPIC_CASCADE00000", reason: "r", createdVia: "web_ui" });
    await insertMarketTopic({ id: "topic-1", name: "Some Topic", createdVia: "web_ui" }, isolatedDb);
    await insertMarketTopicAssignment(
      { id: "assign-1", topicId: "topic-1", subjectType: "channel", subjectId: "UC_TOPIC_CASCADE00000", source: "manual", createdVia: "web_ui" },
      isolatedDb
    );

    await deleteResearchChannel("UC_TOPIC_CASCADE00000", isolatedDb);

    const remaining = await isolatedDb.select().from(marketTopicAssignments);
    assert.equal(remaining.length, 0, "the channel-type assignment must be cascade-deleted, never orphaned");
    const topicStillExists = await getMarketTopicById("topic-1", isolatedDb);
    assert.ok(topicStillExists, "the topic itself must survive -- only the assignment is scoped to the deleted channel");
  }));

test("deleteMarketTopic cascades its own assignments and detaches (never deletes) trend candidates tagged with it", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({ id: "UC_TOPIC_DELETE000000", reason: "r", createdVia: "web_ui" });
    await insertMarketTopic({ id: "topic-1", name: "Some Topic", createdVia: "web_ui" }, isolatedDb);
    await insertMarketTopicAssignment(
      { id: "assign-1", topicId: "topic-1", subjectType: "channel", subjectId: "UC_TOPIC_DELETE000000", source: "manual", createdVia: "web_ui" },
      isolatedDb
    );
    await insertMarketTrendCandidate({ id: "trend-1", title: "A Trend", topicId: "topic-1", createdVia: "web_ui" }, isolatedDb);

    await deleteMarketTopic("topic-1", isolatedDb);

    const remainingAssignments = await isolatedDb.select().from(marketTopicAssignments);
    assert.equal(remainingAssignments.length, 0);
    const trend = await getMarketTrendCandidateById("trend-1", isolatedDb);
    assert.ok(trend, "the trend candidate itself must survive topic deletion");
    assert.equal(trend?.topicId, null, "its topicId must be detached (set null), never left dangling");
  }));

test("deleteMarketTopicAssignment removes exactly one assignment", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({ id: "UC_TOPIC_REMOVE000000", reason: "r", createdVia: "web_ui" });
    await insertMarketTopic({ id: "topic-1", name: "Some Topic", createdVia: "web_ui" }, isolatedDb);
    await insertMarketTopicAssignment(
      { id: "assign-1", topicId: "topic-1", subjectType: "channel", subjectId: "UC_TOPIC_REMOVE000000", source: "manual", createdVia: "web_ui" },
      isolatedDb
    );

    await deleteMarketTopicAssignment("assign-1", isolatedDb);
    assert.equal((await listAssignmentsForTopic("topic-1", isolatedDb)).length, 0);
    const topicStillExists = await getMarketTopicById("topic-1", isolatedDb);
    assert.ok(topicStillExists);
  }));

test("listMarketTopics orders by name; the real UNIQUE(name) index rejects an exact-duplicate topic name", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertMarketTopic({ id: "topic-b", name: "Beta", createdVia: "web_ui" }, isolatedDb);
    await insertMarketTopic({ id: "topic-a", name: "Alpha", createdVia: "web_ui" }, isolatedDb);

    const topics = await listMarketTopics(isolatedDb);
    assert.deepEqual(topics.map((t) => t.name), ["Alpha", "Beta"]);

    await assert.rejects(() => insertMarketTopic({ id: "topic-c", name: "Alpha", createdVia: "web_ui" }, isolatedDb));
  }));

// Phase 9 slice 9E -- trend candidates/evidence round-trip, through the real production entry
// points (`insertMarketTrendCandidateWithInitialEvidence`/`updateMarketTrendCandidateStatusWithEvidence`), not
// the lower-level single-table functions those wrap -- this proves the same schema/column
// round-trip AND that the real call path services.ts uses actually works end-to-end.
test("market_trend_candidates/market_trend_evidence round-trip through the real Drizzle schema; new candidates start as 'emerging'", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await insertMarketTrendCandidateWithInitialEvidence(
      { id: "trend-1", title: "Retro Cocktail Lounge", description: "desc", createdVia: "web_ui" },
      { id: "evidence-1", evidenceType: "supporting_channel", referenceId: "UC_SOME_CHANNEL0000000", description: "This channel shows the pattern", createdVia: "web_ui" },
      isolatedDb
    );
    const candidate = await getMarketTrendCandidateById("trend-1", isolatedDb);
    assert.equal(candidate?.status, "emerging", "every new trend candidate must start as 'emerging'");
    assert.equal(candidate?.topicId, null);

    const evidence = await listTrendEvidence("trend-1", isolatedDb);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].evidenceType, "supporting_channel");
    assert.equal(evidence[0].referenceId, "UC_SOME_CHANNEL0000000");

    const now = new Date("2026-09-27T12:00:00.000Z");
    await updateMarketTrendCandidateStatusWithEvidence(
      "trend-1",
      "growing",
      now,
      { id: "evidence-2", description: "Three more channels covering it this week", createdVia: "web_ui" },
      isolatedDb
    );
    const updated = await getMarketTrendCandidateById("trend-1", isolatedDb);
    assert.equal(updated?.status, "growing");
    assert.equal(updated?.lastObservedAt.getTime(), now.getTime());
    assert.equal((await listTrendEvidence("trend-1", isolatedDb)).length, 2, "the status change must also record its own evidence row");

    const laterAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await touchMarketTrendCandidateLastObservedAt("trend-1", laterAt, isolatedDb);
    const touched = await getMarketTrendCandidateById("trend-1", isolatedDb);
    assert.equal(touched?.status, "growing", "touching lastObservedAt alone must never change status");
    assert.equal(touched?.lastObservedAt.getTime(), laterAt.getTime());

    const list = await listMarketTrendCandidates(isolatedDb);
    assert.equal(list.length, 1);
  }));

// Found by independent review: two separate top-level writes (candidate insert, then evidence
// insert) let a throw between them leave a trend candidate with zero evidence rows -- the exact
// invariant spec §14 exists to prevent (docs/TECHNICAL_DEBT.md RISK-70). Proves the real fix
// (`database.transaction(...)`) actually rolls back against the real libsql driver, not just
// against a fake in-memory store that has no partial-write failure mode of its own.
test("insertMarketTrendCandidateWithInitialEvidence: a failure on the evidence write rolls back the candidate insert too (real transaction, not two independent writes)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    // Pre-seed an evidence row under a specific id, so the wrapper's own evidence insert collides
    // on a duplicate PRIMARY KEY -- forcing its SECOND statement to fail after its FIRST statement
    // (the candidate insert) already ran.
    await insertMarketTrendCandidate({ id: "trend-seed", title: "Seed", createdVia: "web_ui" }, isolatedDb);
    await insertMarketTrendEvidence(
      { id: "evidence-collision", trendCandidateId: "trend-seed", evidenceType: "signal", description: "seed", createdVia: "web_ui" },
      isolatedDb
    );

    await assert.rejects(() =>
      insertMarketTrendCandidateWithInitialEvidence(
        { id: "trend-2", title: "Should not persist", createdVia: "web_ui" },
        { id: "evidence-collision", evidenceType: "signal", description: "colliding id", createdVia: "web_ui" },
        isolatedDb
      )
    );

    const candidate = await getMarketTrendCandidateById("trend-2", isolatedDb);
    assert.equal(candidate, null, "the candidate insert must be rolled back when its own transaction's evidence write fails");
    const evidenceForFailedCandidate = await listTrendEvidence("trend-2", isolatedDb);
    assert.deepEqual(evidenceForFailedCandidate, []);
  }));

test("updateMarketTrendCandidateStatusWithEvidence: a failure on the evidence write rolls back the status change too (real transaction)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await insertMarketTrendCandidate({ id: "trend-3", title: "Original", createdVia: "web_ui" }, isolatedDb);
    await insertMarketTrendEvidence(
      { id: "evidence-collision-2", trendCandidateId: "trend-3", evidenceType: "signal", description: "seed", createdVia: "web_ui" },
      isolatedDb
    );
    const before = await getMarketTrendCandidateById("trend-3", isolatedDb);
    assert.equal(before?.status, "emerging");

    await assert.rejects(() =>
      updateMarketTrendCandidateStatusWithEvidence(
        "trend-3",
        "growing",
        new Date("2026-09-27T12:00:00.000Z"),
        { id: "evidence-collision-2", description: "colliding id", createdVia: "web_ui" },
        isolatedDb
      )
    );

    const after = await getMarketTrendCandidateById("trend-3", isolatedDb);
    assert.equal(after?.status, "emerging", "the status update must be rolled back when its own transaction's evidence write fails");
    const evidence = await listTrendEvidence("trend-3", isolatedDb);
    assert.equal(evidence.length, 1, "only the original seed evidence row must remain, never a duplicate or a partial write");
  }));

// ---------------------------------------------------------------------------
// Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md) -- agent-created
// research requests, approval integrity.
// ---------------------------------------------------------------------------

test("market_research_requests round-trip through the real Drizzle schema; new requests start as 'pending'", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await insertMarketResearchRequest(
      { id: "req-1", query: "night jazz bar", rationale: "worth watching", monitorDurationDays: 30, createdVia: "mcp", agentApiVersion: "0.13.0" },
      isolatedDb
    );
    const created = await getMarketResearchRequestById("req-1", isolatedDb);
    assert.equal(created?.status, "pending");
    assert.equal(created?.monitorDurationDays, 30);
    assert.equal(created?.agentApiVersion, "0.13.0");
    assert.equal(created?.resolvedAt, null);

    const list = await listMarketResearchRequests(isolatedDb);
    assert.equal(list.length, 1);
  }));

// AC-9G-B-06's own real proof -- RISK-70 already showed a fake in-memory store proves nothing
// about real atomicity. Forces two literally-concurrent calls (Promise.all, not two sequential
// awaits) against the real libsql driver, asserting exactly one lands.
test("approveMarketResearchRequestIfPending: two literally-concurrent calls for the same pending row -- exactly one succeeds, the other returns null", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertMarketResearchRequest(
      { id: "req-race", query: "night jazz", rationale: "worth watching", createdVia: "mcp" },
      isolatedDb
    );

    const at = new Date("2026-09-27T12:00:00.000Z");
    const [first, second] = await Promise.all([
      approveMarketResearchRequestIfPending("req-race", at, isolatedDb),
      approveMarketResearchRequestIfPending("req-race", at, isolatedDb),
    ]);

    const succeeded = [first, second].filter((row) => row !== null);
    const failed = [first, second].filter((row) => row === null);
    assert.equal(succeeded.length, 1, "exactly one of the two concurrent calls must succeed");
    assert.equal(failed.length, 1, "the other must observe the row already approved and return null");

    const finalRow = await getMarketResearchRequestById("req-race", isolatedDb);
    assert.equal(finalRow?.status, "approved");
  }));

test("rejectMarketResearchRequestIfPending: a second call after the row is already resolved returns null and changes nothing", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertMarketResearchRequest(
      { id: "req-2", query: "night jazz", rationale: "worth watching", createdVia: "mcp" },
      isolatedDb
    );

    const at = new Date("2026-09-27T12:00:00.000Z");
    const firstReject = await rejectMarketResearchRequestIfPending("req-2", "not aligned", at, isolatedDb);
    assert.ok(firstReject);
    assert.equal(firstReject?.status, "rejected");

    const secondReject = await rejectMarketResearchRequestIfPending("req-2", "different reason", at, isolatedDb);
    assert.equal(secondReject, null);

    const finalRow = await getMarketResearchRequestById("req-2", isolatedDb);
    assert.equal(finalRow?.resolvedReason, "not aligned", "the first reject's reason must survive, never overwritten by the rejected second call");
  }));

test("recordMarketResearchRequestExecutionOutcome writes executed/execution_failed outcomes onto the row", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertMarketResearchRequest(
      { id: "req-3", query: "night jazz", rationale: "worth watching", createdVia: "mcp" },
      isolatedDb
    );
    await approveMarketResearchRequestIfPending("req-3", new Date(), isolatedDb);

    await recordMarketResearchRequestExecutionOutcome("req-3", { status: "executed", candidatesFound: 5, candidatesNew: 2 }, isolatedDb);
    const executed = await getMarketResearchRequestById("req-3", isolatedDb);
    assert.equal(executed?.status, "executed");
    assert.equal(executed?.candidatesFound, 5);
    assert.equal(executed?.candidatesNew, 2);

    await insertMarketResearchRequest(
      { id: "req-4", query: "night jazz", rationale: "worth watching", createdVia: "mcp" },
      isolatedDb
    );
    await approveMarketResearchRequestIfPending("req-4", new Date(), isolatedDb);
    await recordMarketResearchRequestExecutionOutcome("req-4", { status: "execution_failed", executionError: "quota exceeded" }, isolatedDb);
    const failed = await getMarketResearchRequestById("req-4", isolatedDb);
    assert.equal(failed?.status, "execution_failed");
    assert.equal(failed?.executionError, "quota exceeded");
  }));

// Found by independent review: an earlier version of this function matched on `id` alone, which
// meant it could move a request straight from "pending" to "executed"/"execution_failed",
// completely bypassing the approval gate this slice exists to enforce.
test("recordMarketResearchRequestExecutionOutcome: a still-pending row (never approved) returns null and is left untouched", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertMarketResearchRequest(
      { id: "req-5", query: "night jazz", rationale: "worth watching", createdVia: "mcp" },
      isolatedDb
    );

    const result = await recordMarketResearchRequestExecutionOutcome(
      "req-5",
      { status: "executed", candidatesFound: 5, candidatesNew: 2 },
      isolatedDb
    );
    assert.equal(result, null);

    const row = await getMarketResearchRequestById("req-5", isolatedDb);
    assert.equal(row?.status, "pending", "a request that was never approved must never be moved to 'executed' by this function alone");
    assert.equal(row?.candidatesFound, null);
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
