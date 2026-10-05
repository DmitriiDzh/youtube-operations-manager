import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import {
  approveMarketCollectionRequestIfPending,
  renewResearchChannelCollectionClaims,
  failInterruptedMarketCollectionRequests,
  finishMarketCollectionRequestIfRunning,
  findOpenMarketCollectionRequestForChannel,
  getMarketCollectionRequestById,
  insertMarketCollectionRequest,
  rejectMarketCollectionRequestIfPending,
  startMarketCollectionRequestIfApproved,
  channels,
  clearStoredCloudConnection,
  contentProposalArtifacts,
  contentProposals,
  copyLegacyDatabaseInto,
  createIsolatedDb,
  getChannelWorkspacePath,
  deleteLogicalPathRow,
  findActiveFactoryAgentTokenByHash,
  listActiveFactoryAgentTokens,
  replaceFactoryAgentToken,
  revokeFactoryAgentTokens,
  getLogicalPathValue,
  insertLogicalPathRow,
  listLogicalPathRows,
  listLogicalPathValues,
  setLogicalPathValue,
  addChannelRecordAssignment,
  listChannelAssignedRecordIds,
  listRecordAssignmentsByKind,
  setRecordAssignmentChannels,
  findActiveAgentChannelTokenByHash,
  listActiveAgentChannelTokens,
  replaceAgentChannelToken,
  revokeAgentChannelTokens,
  listChannelWorkspacePaths,
  setChannelWorkspacePath,
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
  listResearchEvidenceByChannel,
  insertMarketVideoSnapshot,
  claimStaleResearchChannelsForCollection,
  releaseResearchChannelCollectionClaim,
  listRecentlyFailedResearchChannelIds,
  markResearchChannelAutoCollected,
  insertMarketIntelligenceCollectionRun,
  getMarketIntelligenceUnitsSpentSince,
  countMarketDiscoverySearchesSince,
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
  insertHypothesis,
  getHypothesisById,
  listHypotheses,
  insertExperiment,
  getExperimentById,
  listExperimentsByHypothesis,
  transitionExperimentStatusIfValid,
  setExperimentChangeSetIfEligible,
  claimExperimentForExecution,
  releaseExperimentExecutionClaim,
  finalizeExperimentExecution,
  insertExperimentOutcome,
  listExperimentOutcomesByExperiment,
  insertHypothesisEvidence,
  listHypothesisEvidenceByHypothesis,
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
// Phase 13 slices 13.5/13.8 add the RSS feed and Wikipedia read categories (seven in all).
test("getGatewayTrafficLast24h: every category reports a zeroed row before any call is recorded", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    const windows = await getGatewayTrafficLast24h(isolatedDb);

    assert.deepEqual(
      windows.map((w) => w.category).sort(),
      [
        "analytics_reads",
        "cloud_monitoring_reads",
        "data_api_reads",
        "live_writes",
        "mcp_tool_calls",
        "reporting_reads",
        "wikipedia_reads",
        "youtube_feed_reads",
      ]
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
    // Phase 9 slice 9H part C -- a later ADD-COLUMN migration (v28) must also survive the
    // pre-versioning re-apply path, same discipline as v19/v21/v24's own ADD-COLUMN assertions.
    const marketVideoSnapshotColumns = await client.execute("PRAGMA table_info(market_video_snapshots)");
    const marketVideoSnapshotColumnNames = marketVideoSnapshotColumns.rows.map((row) => row.name);
    assert.ok(
      marketVideoSnapshotColumnNames.includes("title"),
      "a later ADD-COLUMN migration (v28) must still apply correctly on the pre-versioning re-apply path"
    );
  }));

// Phase 9 slice 9H part C -- proves market_video_snapshots.title round-trips through the real
// Drizzle schema, and stays null when never provided (a pre-migration/omitted title, never
// fabricated as an empty string or guessed from another row).
test("market_video_snapshots.title round-trips through the real Drizzle schema, and stays null when never provided", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({
      id: "UC_RESEARCH_A",
      handleOrUrl: null,
      reason: "test",
      createdVia: "web_ui",
    });

    await isolatedDb.insert(marketVideoSnapshots).values({
      id: "snap-with-title",
      researchChannelId: "UC_RESEARCH_A",
      videoId: "v_with_title",
      title: "Real Title",
      source: "youtube.videos.list",
      createdVia: "web_ui",
    });
    await isolatedDb.insert(marketVideoSnapshots).values({
      id: "snap-without-title",
      researchChannelId: "UC_RESEARCH_A",
      videoId: "v_without_title",
      source: "youtube.videos.list",
      createdVia: "web_ui",
    });

    const rows = await isolatedDb.select().from(marketVideoSnapshots).where(eq(marketVideoSnapshots.researchChannelId, "UC_RESEARCH_A"));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get("snap-with-title")?.title, "Real Title");
    assert.equal(byId.get("snap-without-title")?.title, null);
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
    await touchMarketDiscoveryCandidateLastSeen("UC_CANDIDATE00000000000", laterSeenAt, "Fresh title", "Fresh description", isolatedDb);

    const afterRediscovery = await getMarketDiscoveryCandidateById("UC_CANDIDATE00000000000", isolatedDb);
    assert.equal(afterRediscovery?.status, "ignored", "rediscovery must never reset an operator-set status back to new");
    assert.equal(afterRediscovery?.lastSeenAt.getTime(), laterSeenAt.getTime());
    // Phase 13 (review round 1): restarting the 30-day clock must come with refreshed API data.
    assert.equal(afterRediscovery?.title, "Fresh title");
    assert.equal(afterRediscovery?.reasonDiscovered, "Fresh description", "the description (API data) is refreshed too");

    const allRows = await isolatedDb.select().from(marketDiscoveryCandidates);
    assert.equal(allRows.length, 1, "rediscovery must never insert a duplicate row for the same channel");

    const listed = await listMarketDiscoveryCandidates(isolatedDb);
    assert.equal(listed.length, 1);
  }));

// Phase 13 slice 13.4 -- REVISED: since 2026-06-01 `search.list` has its own quota bucket, so the shared
// unit budget sums collection runs only, and searches are counted separately (one row = one call).
test("getMarketIntelligenceUnitsSpentSince counts collection runs only; countMarketDiscoverySearchesSince counts searches", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({ id: "UC_SHARED_BUDGET000000", reason: "r", createdVia: "web_ui" });

    const now = new Date("2026-09-27T12:00:00.000Z");
    await insertMarketIntelligenceCollectionRun({ researchChannelId: "UC_SHARED_BUDGET000000", status: "success", unitsSpent: 3, ranAt: now }, isolatedDb);
    await insertMarketDiscoveryRun({ query: "cooking", status: "success", unitsSpent: 1, candidatesFound: 5, candidatesNew: 2, ranAt: now }, isolatedDb);
    await insertMarketDiscoveryRun({ query: "gaming", status: "failed", unitsSpent: 1, errorMessage: "boom", ranAt: now }, isolatedDb);

    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    assert.equal(await getMarketIntelligenceUnitsSpentSince(since, isolatedDb), 3);
    assert.equal(await countMarketDiscoverySearchesSince(since, isolatedDb), 2, "a failed search still used a call");

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

// Found by independent review (2026-09-29): a promoted discovery candidate's row was never
// cascade-deleted when its channel left the watchlist, leaving it permanently stuck at
// status:"promoted" with no path back (promoteDiscoveryCandidate refuses re-promotion,
// updateDiscoveryCandidateStatus refuses to touch an already-promoted row).
test("deleteResearchChannel cascade-deletes a promoted market_discovery_candidates row sharing the same id, but never a non-promoted one", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await isolatedDb.insert(researchChannels).values({ id: "UC_PROMOTED_CASCADE0000", reason: "r", createdVia: "web_ui" });
    await insertMarketDiscoveryCandidate(
      { id: "UC_PROMOTED_CASCADE0000", title: "Promoted Channel", discoverySource: "search", discoveryQuery: "q", createdVia: "web_ui" },
      isolatedDb
    );
    await setMarketDiscoveryCandidateStatus("UC_PROMOTED_CASCADE0000", "promoted", isolatedDb);
    // An unrelated candidate, never promoted, must survive an unrelated channel's deletion.
    await insertMarketDiscoveryCandidate(
      { id: "UC_UNRELATED_CANDIDATE0", title: "Still A Candidate", discoverySource: "search", discoveryQuery: "q", createdVia: "web_ui" },
      isolatedDb
    );

    await deleteResearchChannel("UC_PROMOTED_CASCADE0000", isolatedDb);

    const remaining = await isolatedDb.select().from(marketDiscoveryCandidates);
    assert.deepEqual(
      remaining.map((r) => r.id),
      ["UC_UNRELATED_CANDIDATE0"],
      "the promoted candidate sharing the deleted channel's id must be gone; an unrelated, non-promoted candidate must survive"
    );
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

// Found by independent review (2026-09-29): both functions accept an explicit `at` used to stamp
// the trend-candidate row's own timestamps, but the paired evidence-row insert in the same
// transaction previously left `recordedAt` to the column's real-wall-clock `$defaultFn` instead of
// also using `at` -- the same "two clock sources for one moment" bug class already fixed once for
// firstObservedAt/lastObservedAt (see this file's own comment on insertMarketTrendCandidate).
test("insertMarketTrendCandidateWithInitialEvidence/updateMarketTrendCandidateStatusWithEvidence: the evidence row's recordedAt uses the same injected `at`, never real wall-clock time", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const createdAt = new Date("2020-01-01T00:00:00.000Z"); // far from real "now" -- proves it's not $defaultFn

    await insertMarketTrendCandidateWithInitialEvidence(
      { id: "trend-clock", title: "Clock Test", createdVia: "web_ui", at: createdAt },
      { id: "evidence-clock-1", evidenceType: "supporting_channel", description: "d", createdVia: "web_ui" },
      isolatedDb
    );
    const [initialEvidence] = await listTrendEvidence("trend-clock", isolatedDb);
    assert.equal(
      initialEvidence.recordedAt.getTime(),
      createdAt.getTime(),
      "the initial evidence row's recordedAt must match the candidate's own injected `at`, not real wall-clock time"
    );

    const statusChangeAt = new Date("2021-06-15T00:00:00.000Z");
    await updateMarketTrendCandidateStatusWithEvidence(
      "trend-clock",
      "growing",
      statusChangeAt,
      { id: "evidence-clock-2", description: "d2", createdVia: "web_ui" },
      isolatedDb
    );
    const evidenceRows = await listTrendEvidence("trend-clock", isolatedDb);
    const statusChangeEvidence = evidenceRows.find((e) => e.id === "evidence-clock-2");
    assert.equal(
      statusChangeEvidence?.recordedAt.getTime(),
      statusChangeAt.getTime(),
      "the status-change evidence row's recordedAt must match the status change's own `at`, not real wall-clock time"
    );
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

test("insertMarketResearchRequest: an explicit `at` stamps createdAt instead of the column's real-wall-clock default (found by independent code review -- unlike insertMarketTrendCandidate, this had no injected-clock parameter at all)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const at = new Date("2020-01-01T00:00:00.000Z");

    await insertMarketResearchRequest(
      { id: "req-clock", query: "night jazz", rationale: "worth watching", createdVia: "mcp", at },
      isolatedDb
    );

    const row = await getMarketResearchRequestById("req-clock", isolatedDb);
    assert.equal(row?.createdAt.toISOString(), at.toISOString());
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

// ---------------------------------------------------------------------------
// Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md) -- hypotheses/experiments/
// experiment_outcomes persistence.
// ---------------------------------------------------------------------------

test("insertHypothesis/getHypothesisById/listHypotheses: round trip, including a channel-less (new-channel-concept) hypothesis", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);

    await insertHypothesis(
      { id: "hyp-1", channelId: null, statement: "Shorter titles improve CTR", evidenceNotes: "gut feeling for now", createdBy: "owner", createdVia: "web_ui" },
      isolatedDb
    );
    await insertHypothesis(
      { id: "hyp-2", channelId: null, statement: "New channel concept: lo-fi cooking", evidenceNotes: "n/a", createdBy: "owner", createdVia: "web_ui" },
      isolatedDb
    );

    const fetched = await getHypothesisById("hyp-1", isolatedDb);
    assert.equal(fetched?.statement, "Shorter titles improve CTR");
    assert.equal(fetched?.channelId, null);

    const all = await listHypotheses(isolatedDb);
    assert.equal(all.length, 2);
  }));

test("insertExperiment/getExperimentById/listExperimentsByHypothesis: round trip, defaults status to proposed", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertHypothesis({ id: "hyp-1", statement: "s", evidenceNotes: "e", createdBy: "owner", createdVia: "web_ui" }, isolatedDb);

    await insertExperiment(
      {
        id: "exp-1",
        hypothesisId: "hyp-1",
        treatment: "shorter titles",
        controlBaseline: "current titles",
        successCriteria: "CTR +10%",
        stoppingCriteria: "14 days or -20% CTR",
        responsible: "owner",
        createdVia: "web_ui",
      },
      isolatedDb
    );

    const fetched = await getExperimentById("exp-1", isolatedDb);
    assert.equal(fetched?.status, "proposed");
    assert.equal(fetched?.approvedBy, null);
    assert.equal(fetched?.approvedAt, null);

    const byHypothesis = await listExperimentsByHypothesis("hyp-1", isolatedDb);
    assert.equal(byHypothesis.length, 1);
  }));

test("insertHypothesis/insertExperiment: an explicit `at` stamps createdAt, not real wall-clock time (two clock sources bug class, already fixed once for Phase 9 trend evidence -- not repeating it here)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const at = new Date("2020-01-01T00:00:00.000Z");

    await insertHypothesis({ id: "hyp-1", statement: "s", evidenceNotes: "e", createdBy: "owner", createdVia: "web_ui", at }, isolatedDb);
    await insertExperiment(
      {
        id: "exp-1",
        hypothesisId: "hyp-1",
        treatment: "t",
        controlBaseline: "c",
        successCriteria: "s",
        stoppingCriteria: "s",
        responsible: "owner",
        createdVia: "web_ui",
        at,
      },
      isolatedDb
    );

    const hypothesis = await getHypothesisById("hyp-1", isolatedDb);
    const experiment = await getExperimentById("exp-1", isolatedDb);
    assert.equal(hypothesis?.createdAt.toISOString(), at.toISOString());
    assert.equal(experiment?.createdAt.toISOString(), at.toISOString());
  }));

test("insertExperimentOutcome/listExperimentOutcomesByExperiment: append-only -- multiple outcome rows for one experiment all survive", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertHypothesis({ id: "hyp-1", statement: "s", evidenceNotes: "e", createdBy: "owner", createdVia: "web_ui" }, isolatedDb);
    await insertExperiment(
      {
        id: "exp-1",
        hypothesisId: "hyp-1",
        treatment: "t",
        controlBaseline: "c",
        successCriteria: "s",
        stoppingCriteria: "s",
        responsible: "owner",
        createdVia: "web_ui",
      },
      isolatedDb
    );

    await insertExperimentOutcome(
      { id: "out-1", experimentId: "exp-1", recordedBy: "owner", createdVia: "web_ui", outcomeData: "interim: +3%", criteriaMet: "inconclusive" },
      isolatedDb
    );
    await insertExperimentOutcome(
      { id: "out-2", experimentId: "exp-1", recordedBy: "owner", createdVia: "web_ui", outcomeData: "final: +9%", criteriaMet: "met", lessonsLearned: "worked" },
      isolatedDb
    );

    const outcomes = await listExperimentOutcomesByExperiment("exp-1", isolatedDb);
    assert.equal(outcomes.length, 2);
  }));

test("insertHypothesisEvidence/listHypothesisEvidenceByHypothesis: round trip, append-only across source types", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertHypothesis({ id: "hyp-1", statement: "s", evidenceNotes: "e", createdBy: "owner", createdVia: "web_ui" }, isolatedDb);

    await insertHypothesisEvidence(
      {
        id: "ev-1",
        hypothesisId: "hyp-1",
        sourceType: "phase9_trend_candidate",
        referenceJson: JSON.stringify({ sourceType: "phase9_trend_candidate", trendCandidateId: "trend-1" }),
        createdVia: "web_ui",
      },
      isolatedDb
    );
    await insertHypothesisEvidence(
      {
        id: "ev-2",
        hypothesisId: "hyp-1",
        sourceType: "phase8_metric",
        referenceJson: JSON.stringify({
          sourceType: "phase8_metric",
          channelId: "UC1",
          videoId: "v1",
          metricDate: "2026-09-01",
          metricName: "views",
        }),
        note: "supports the hypothesis directly",
        createdVia: "web_ui",
      },
      isolatedDb
    );

    const rows = await listHypothesisEvidenceByHypothesis("hyp-1", isolatedDb);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.id === "ev-1" && r.sourceType === "phase9_trend_candidate"));
    const withNote = rows.find((r) => r.id === "ev-2");
    assert.equal(withNote?.note, "supports the hypothesis directly");
  }));

test("insertHypothesisEvidence: an explicit `at` stamps createdAt, not real wall-clock time (two clock sources bug class)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertHypothesis({ id: "hyp-1", statement: "s", evidenceNotes: "e", createdBy: "owner", createdVia: "web_ui" }, isolatedDb);
    const at = new Date("2026-01-01T00:00:00.000Z");

    await insertHypothesisEvidence(
      {
        id: "ev-1",
        hypothesisId: "hyp-1",
        sourceType: "phase9_trend_candidate",
        referenceJson: JSON.stringify({ sourceType: "phase9_trend_candidate", trendCandidateId: "trend-1" }),
        createdVia: "web_ui",
        at,
      },
      isolatedDb
    );

    const rows = await listHypothesisEvidenceByHypothesis("hyp-1", isolatedDb);
    assert.equal(rows[0]?.createdAt.toISOString(), at.toISOString());
  }));

// RISK-70's own lesson (a fake in-memory store proves nothing about real atomicity) -- forces two
// literally-concurrent calls against the real libsql driver, exactly like
// approveMarketResearchRequestIfPending's own race test.
test("transitionExperimentStatusIfValid: two literally-concurrent approve attempts for the same proposed row -- exactly one succeeds", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertHypothesis({ id: "hyp-1", statement: "s", evidenceNotes: "e", createdBy: "owner", createdVia: "web_ui" }, isolatedDb);
    await insertExperiment(
      {
        id: "exp-race",
        hypothesisId: "hyp-1",
        treatment: "t",
        controlBaseline: "c",
        successCriteria: "s",
        stoppingCriteria: "s",
        responsible: "owner",
        createdVia: "web_ui",
      },
      isolatedDb
    );

    const at = new Date("2026-09-29T12:00:00.000Z");
    const [first, second] = await Promise.all([
      transitionExperimentStatusIfValid("exp-race", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb),
      transitionExperimentStatusIfValid("exp-race", ["proposed"], "approved", "actor-b", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb),
    ]);

    const succeeded = [first, second].filter((row) => row !== null);
    const failed = [first, second].filter((row) => row === null);
    assert.equal(succeeded.length, 1, "exactly one of the two concurrent calls must succeed");
    assert.equal(failed.length, 1, "the other must observe the row already approved and return null");

    const finalRow = await getExperimentById("exp-race", isolatedDb);
    assert.equal(finalRow?.status, "approved");
    assert.equal(finalRow?.approvedBy, succeeded[0]?.approvedBy, "the final row's approvedBy must match only the winning call's actor");
  }));

test("transitionExperimentStatusIfValid: a call whose fromStatuses no longer matches the row's real status returns null and changes nothing", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertHypothesis({ id: "hyp-1", statement: "s", evidenceNotes: "e", createdBy: "owner", createdVia: "web_ui" }, isolatedDb);
    await insertExperiment(
      {
        id: "exp-1",
        hypothesisId: "hyp-1",
        treatment: "t",
        controlBaseline: "c",
        successCriteria: "s",
        stoppingCriteria: "s",
        responsible: "owner",
        createdVia: "web_ui",
      },
      isolatedDb
    );
    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);

    const result = await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-b", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);
    assert.equal(result, null);

    const row = await getExperimentById("exp-1", isolatedDb);
    assert.equal(row?.approvedBy, "actor-a");
  }));

// ---------------------------------------------------------------------------
// Phase 10 slice 5 (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md) -- execution of an approved,
// localization-type experiment. `claimExperimentForExecution`'s own real-DB concurrency test
// mirrors `transitionExperimentStatusIfValid`'s own above, and `claimStaleResearchChannelsForCollection`
// (Phase 9 slice 9B) -- the same claim-first shape, proven against a real DB, not a fake store.
//
// `FAR_PAST_CLAIM_CUTOFF`/`FAR_FUTURE_CLAIM_CUTOFF`: a claim-expiry cutoff in the far past never
// treats a just-taken claim as stale (used by every test that isn't specifically about expiry); a
// cutoff in the far future treats EVERY claim as already-expired (used to simulate "the claim is
// old enough to be reclaimed/bypassed").
// ---------------------------------------------------------------------------

const FAR_PAST_CLAIM_CUTOFF = new Date(0);
const FAR_FUTURE_CLAIM_CUTOFF = new Date("2999-01-01T00:00:00.000Z");

async function insertExperimentForExecutionTests(
  isolatedDb: AppDb,
  overrides: { hypothesisChannelId?: string | null; experimentId?: string } = {}
): Promise<void> {
  if (overrides.hypothesisChannelId) {
    await seedChannel(isolatedDb, overrides.hypothesisChannelId);
  }
  await insertHypothesis(
    { id: "hyp-1", channelId: overrides.hypothesisChannelId ?? null, statement: "s", evidenceNotes: "e", createdBy: "owner", createdVia: "web_ui" },
    isolatedDb
  );
  await insertExperiment(
    {
      id: overrides.experimentId ?? "exp-1",
      hypothesisId: "hyp-1",
      treatment: "t",
      controlBaseline: "c",
      successCriteria: "s",
      stoppingCriteria: "s",
      responsible: "owner",
      createdVia: "web_ui",
    },
    isolatedDb
  );
}

test("setExperimentChangeSetIfEligible: attaches when status is proposed/approved, returns null (no write) for running", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);

    const attached = await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.equal(attached?.changeSetId, "cs-1");

    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);
    const claimed = await claimExperimentForExecution("exp-1", "cs-1", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    await finalizeExperimentExecution("exp-1", "batch-1", claimed!.executionClaimedAt as Date, isolatedDb);

    const result = await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], null, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.equal(result, null, "a running experiment's changeSetId must be immutable via this function");
    const row = await getExperimentById("exp-1", isolatedDb);
    assert.equal(row?.changeSetId, "cs-1", "nothing was actually changed by the rejected call");
  }));

test("claimExperimentForExecution: two literally-concurrent claims for the same approved+change-set-attached row -- exactly one succeeds", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    const approveAt = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", approveAt, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);

    const claimAt = new Date("2026-09-29T12:00:01.000Z");
    const [first, second] = await Promise.all([
      claimExperimentForExecution("exp-1", "cs-1", claimAt, FAR_PAST_CLAIM_CUTOFF, isolatedDb),
      claimExperimentForExecution("exp-1", "cs-1", claimAt, FAR_PAST_CLAIM_CUTOFF, isolatedDb),
    ]);

    const succeeded = [first, second].filter((row) => row !== null);
    const failed = [first, second].filter((row) => row === null);
    assert.equal(succeeded.length, 1, "exactly one of the two concurrent claims must succeed");
    assert.equal(failed.length, 1, "the other must observe the claim already taken and return null");

    const row = await getExperimentById("exp-1", isolatedDb);
    assert.equal(row?.status, "approved", "the claim itself never touches status");
    assert.ok(row?.executionClaimedAt, "the claim column is set");
  }));

test("claimExperimentForExecution: refuses when changeSetId no longer matches (concurrent detach)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);

    const result = await claimExperimentForExecution("exp-1", "cs-DIFFERENT", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.equal(result, null);
  }));

test("claimExperimentForExecution: an expired (stale) claim can be reclaimed", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);

    const firstClaim = await claimExperimentForExecution("exp-1", "cs-1", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.ok(firstClaim, "first claim succeeds (simulates a crashed prior attempt -- claim taken, never released or finalized)");

    const blockedByFreshCutoff = await claimExperimentForExecution("exp-1", "cs-1", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.equal(blockedByFreshCutoff, null, "a cutoff that treats the claim as still fresh must block a second claim");

    const reclaimedViaExpiry = await claimExperimentForExecution("exp-1", "cs-1", at, FAR_FUTURE_CLAIM_CUTOFF, isolatedDb);
    assert.ok(reclaimedViaExpiry, "a cutoff that treats the claim as expired must allow reclaiming it -- a crash never permanently locks the row");
  }));

test("releaseExperimentExecutionClaim: a released claim can be re-claimed afterward", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);

    const firstClaim = await claimExperimentForExecution("exp-1", "cs-1", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.ok(firstClaim);
    const blockedWhileClaimed = await claimExperimentForExecution("exp-1", "cs-1", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.equal(blockedWhileClaimed, null);

    const released = await releaseExperimentExecutionClaim("exp-1", at, isolatedDb);
    assert.equal(released, true, "releasing the exact claim that was actually held must report success");
    const rowAfterRelease = await getExperimentById("exp-1", isolatedDb);
    assert.equal(rowAfterRelease?.executionClaimedAt, null);
    assert.equal(rowAfterRelease?.status, "approved", "release never touches status -- the experiment stays re-attemptable");

    const secondClaim = await claimExperimentForExecution("exp-1", "cs-1", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.ok(secondClaim, "a released claim can be re-claimed");
  }));

test("releaseExperimentExecutionClaim: a stale caller's release never clears a DIFFERENT, newer claim (independent review finding)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);

    // Caller A claims, then (simulated by the far-future cutoff below) stalls past expiry.
    const firstClaimAt = new Date("2026-09-29T12:00:00.000Z");
    const firstClaim = await claimExperimentForExecution("exp-1", "cs-1", firstClaimAt, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.ok(firstClaim);

    // Caller B legitimately reclaims once A's claim is treated as expired -- FAR_FUTURE_CLAIM_CUTOFF
    // makes any real timestamp count as stale, exactly like real wall-clock time passing far enough
    // would (storage truncates to whole seconds, so a same-second cutoff cannot be used here).
    const secondClaimAt = new Date("2026-09-29T12:20:00.000Z");
    const secondClaim = await claimExperimentForExecution("exp-1", "cs-1", secondClaimAt, FAR_FUTURE_CLAIM_CUTOFF, isolatedDb);
    assert.ok(secondClaim, "B must be able to reclaim once A's claim is stale");
    assert.equal(secondClaim.executionClaimedAt?.getTime(), secondClaimAt.getTime());

    // A's stalled cleanup finally runs, releasing what IT believes is its own claim (firstClaimAt)
    // -- this must be a no-op against B's fresh claim, never clearing it.
    const releasedByStaleA = await releaseExperimentExecutionClaim("exp-1", firstClaimAt, isolatedDb);
    assert.equal(releasedByStaleA, false, "a stale caller's release must report failure, not silently succeed");

    const rowAfterStaleRelease = await getExperimentById("exp-1", isolatedDb);
    assert.equal(
      rowAfterStaleRelease?.executionClaimedAt?.getTime(),
      secondClaimAt.getTime(),
      "B's own fresh claim must survive A's stale release attempt untouched"
    );

    // A third caller must NOT be able to claim while B's claim is still genuinely fresh.
    const thirdClaimBlocked = await claimExperimentForExecution("exp-1", "cs-1", new Date("2026-09-29T12:21:00.000Z"), FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.equal(thirdClaimBlocked, null, "B's still-fresh claim must keep a third caller out");
  }));

test("transitionExperimentStatusIfValid/setExperimentChangeSetIfEligible: refuse while a FRESH execution claim is held (Abandon/detach during the claim window)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);
    await claimExperimentForExecution("exp-1", "cs-1", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);

    // advisor() round 2: without this guard, Abandon could land here, then finalize would
    // resurrect the terminal state back to "running" -- both must be refused while claimed.
    const abandonAttempt = await transitionExperimentStatusIfValid("exp-1", ["approved"], "abandoned", null, at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);
    assert.equal(abandonAttempt, null, "Abandon must be refused while a fresh claim is held");
    const detachAttempt = await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], null, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    assert.equal(detachAttempt, null, "Detach must be refused while a fresh claim is held");

    const row = await getExperimentById("exp-1", isolatedDb);
    assert.equal(row?.status, "approved", "neither rejected call actually changed anything");
    assert.equal(row?.changeSetId, "cs-1");

    // The same calls succeed once the claim is old enough to count as expired/abandoned.
    const abandonAfterExpiry = await transitionExperimentStatusIfValid(
      "exp-1",
      ["approved"],
      "abandoned",
      null,
      at,
      FAR_FUTURE_CLAIM_CUTOFF,
      undefined,
      isolatedDb
    );
    assert.ok(abandonAfterExpiry, "an expired claim must not block a transition forever");
  }));

test("transitionExperimentStatusIfValid: requiredChangeSetId atomically re-verifies at write time, closing a concurrent-attach race (independent review finding)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);
    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);

    // The row genuinely has no Change Set attached yet (matches the read-time check a caller
    // would have just performed) -- but a Change Set gets attached AFTER that read, simulating
    // the exact race a concurrent setExperimentChangeSet call would create.
    const rowBeforeAttach = await getExperimentById("exp-1", isolatedDb);
    assert.equal(rowBeforeAttach?.changeSetId, null);
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);

    // A manual transition to "running" that trusts requiredChangeSetId: null (mirroring the
    // service layer's own read-time belief) must now be refused atomically at write time, not
    // silently succeed against the row's REAL, now-changed changeSetId.
    const raced = await transitionExperimentStatusIfValid("exp-1", ["approved"], "running", null, at, FAR_PAST_CLAIM_CUTOFF, null, isolatedDb);
    assert.equal(raced, null, "the write must refuse once a Change Set is really attached, regardless of what the caller read earlier");

    const row = await getExperimentById("exp-1", isolatedDb);
    assert.equal(row?.status, "approved", "status must NOT have advanced to running through the raced manual path");
    assert.equal(row?.changeSetId, "cs-1", "the concurrently-attached Change Set must survive untouched");

    // Sanity check: the same call succeeds when requiredChangeSetId genuinely matches reality.
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], null, FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    const legitimate = await transitionExperimentStatusIfValid("exp-1", ["approved"], "running", null, at, FAR_PAST_CLAIM_CUTOFF, null, isolatedDb);
    assert.ok(legitimate, "the same guard must not block a genuinely eligible manual transition");
    assert.equal(legitimate.status, "running");

    // Sanity check: omitting requiredChangeSetId (undefined) applies no such constraint at all --
    // every non-"running"-targeting transition in this codebase relies on this.
    const noConstraint = await transitionExperimentStatusIfValid("exp-1", ["running"], "concluded", null, at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);
    assert.ok(noConstraint, "omitting requiredChangeSetId must not add any changeSetId constraint");
  }));

test("finalizeExperimentExecution: sets status to running, records the real Batch id, and clears the claim so running->concluded still works", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);
    const claimed = await claimExperimentForExecution("exp-1", "cs-1", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);

    const finalized = await finalizeExperimentExecution("exp-1", "batch-1", claimed!.executionClaimedAt as Date, isolatedDb);
    assert.equal(finalized, true);
    const row = await getExperimentById("exp-1", isolatedDb);
    assert.equal(row?.status, "running");
    assert.equal(row?.executionBatchId, "batch-1");
    assert.equal(row?.executionClaimedAt, null, "the claim is cleared by finalize itself");

    // advisor() round 2: the claim guard on transitions must not then permanently block the
    // experiment's own normal running -> concluded/abandoned lifecycle.
    const concluded = await transitionExperimentStatusIfValid("exp-1", ["running"], "concluded", null, at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);
    assert.equal(concluded?.status, "concluded");
  }));

test("finalizeExperimentExecution: returns false (not an exception) when the guard doesn't match, and never touches the row", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertExperimentForExecutionTests(isolatedDb);
    await setExperimentChangeSetIfEligible("exp-1", ["proposed", "approved"], "cs-1", FAR_PAST_CLAIM_CUTOFF, isolatedDb);
    const at = new Date("2026-09-29T12:00:00.000Z");
    await transitionExperimentStatusIfValid("exp-1", ["proposed"], "approved", "actor-a", at, FAR_PAST_CLAIM_CUTOFF, undefined, isolatedDb);
    await claimExperimentForExecution("exp-1", "cs-1", at, FAR_PAST_CLAIM_CUTOFF, isolatedDb);

    // Wrong expectedClaimedAt -- simulates the claim having moved/cleared between claim and
    // finalize (should be impossible given the claim's own exclusivity, but the guard must still
    // report failure honestly rather than silently "succeeding").
    const finalized = await finalizeExperimentExecution("exp-1", "batch-wrong", new Date("2020-01-01T00:00:00.000Z"), isolatedDb);
    assert.equal(finalized, false);

    const row = await getExperimentById("exp-1", isolatedDb);
    assert.equal(row?.status, "approved", "the mismatched finalize call must not have changed anything");
    assert.equal(row?.executionBatchId, null);
    assert.ok(row?.executionClaimedAt, "the claim stays held -- a failed finalize self-heals via expiry, never silently releases");
  }));

// Phase 11 (docs/roadmap/plans/PHASE_11_PLAN.md AC-P11-05/AC-P11-06): channel_workspaces rows are
// scoped per (device, channel). A row stored under another deviceId is invisible to this device's
// get/list, and setting or clearing one channel never touches another channel's row.
test("channel_workspaces: per-device, per-channel isolation for get/list/set/clear", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    assert.equal(await tableExists(client, "channel_workspaces"), true);
    const isolatedDb = createIsolatedDb(client);

    await setChannelWorkspacePath("device-a", "UC_A", "/work/a", isolatedDb);
    await setChannelWorkspacePath("device-a", "UC_B", "/work/b", isolatedDb);
    await setChannelWorkspacePath("device-other", "UC_A", "/elsewhere/a", isolatedDb);

    assert.equal(await getChannelWorkspacePath("device-a", "UC_A", isolatedDb), "/work/a");
    assert.equal(await getChannelWorkspacePath("device-other", "UC_A", isolatedDb), "/elsewhere/a");
    assert.equal(await getChannelWorkspacePath("device-a", "UC_C", isolatedDb), null);
    assert.deepEqual(
      (await listChannelWorkspacePaths("device-a", isolatedDb)).map((r) => [r.channelId, r.path]).sort(),
      [["UC_A", "/work/a"], ["UC_B", "/work/b"]]
    );

    await setChannelWorkspacePath("device-a", "UC_A", "/work/a2", isolatedDb);
    assert.equal(await getChannelWorkspacePath("device-a", "UC_A", isolatedDb), "/work/a2");
    assert.equal(await getChannelWorkspacePath("device-a", "UC_B", isolatedDb), "/work/b");

    await setChannelWorkspacePath("device-a", "UC_A", null, isolatedDb);
    assert.equal(await getChannelWorkspacePath("device-a", "UC_A", isolatedDb), null);
    assert.equal(await getChannelWorkspacePath("device-a", "UC_B", isolatedDb), "/work/b");
    assert.equal(await getChannelWorkspacePath("device-other", "UC_A", isolatedDb), "/elsewhere/a");
  }));

// Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md AC-FO-01/AC-FO-03): the
// migration seeds exactly the two initial names (no values), a new path is just a row, and values
// are scoped per (device, name).
test("logical_paths: seeds exactly the two initial names without values; values are per device; new paths need no migration", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    assert.equal(await tableExists(client, "logical_paths"), true);
    assert.equal(await tableExists(client, "logical_path_values"), true);
    const isolatedDb = createIsolatedDb(client);

    assert.deepEqual(
      (await listLogicalPathRows(isolatedDb)).map((r) => [r.name, r.audience]),
      [
        ["developer_exchange", "factory_only"],
        ["factory_shared", "all_agents"],
      ]
    );
    assert.deepEqual(await listLogicalPathValues("device-a", isolatedDb), []);

    await setLogicalPathValue("device-a", "factory_shared", "C:\\Factory\\02 Shared Registry", isolatedDb);
    await setLogicalPathValue("device-other", "factory_shared", "/Users/x/Factory/02 Shared Registry", isolatedDb);
    assert.equal(await getLogicalPathValue("device-a", "factory_shared", isolatedDb), "C:\\Factory\\02 Shared Registry");
    assert.equal(await getLogicalPathValue("device-other", "factory_shared", isolatedDb), "/Users/x/Factory/02 Shared Registry");
    assert.equal(await getLogicalPathValue("device-a", "developer_exchange", isolatedDb), null);
    assert.equal(await getLogicalPathValue("device-third", "factory_shared", isolatedDb), null);

    await setLogicalPathValue("device-a", "factory_shared", "C:\\Factory\\Shared2", isolatedDb);
    assert.equal(await getLogicalPathValue("device-a", "factory_shared", isolatedDb), "C:\\Factory\\Shared2");
    assert.equal(await getLogicalPathValue("device-other", "factory_shared", isolatedDb), "/Users/x/Factory/02 Shared Registry");

    // A third path is only a row: no schema change, and a duplicate name writes nothing.
    assert.equal(await insertLogicalPathRow({ name: "script_library", audience: "all_agents", description: "" }, isolatedDb), true);
    assert.equal(await insertLogicalPathRow({ name: "script_library", audience: "factory_only", description: "x" }, isolatedDb), false);
    assert.equal((await listLogicalPathRows(isolatedDb)).find((r) => r.name === "script_library")?.audience, "all_agents");

    await setLogicalPathValue("device-a", "factory_shared", null, isolatedDb);
    assert.equal(await getLogicalPathValue("device-a", "factory_shared", isolatedDb), null);
    assert.equal(await getLogicalPathValue("device-other", "factory_shared", isolatedDb), "/Users/x/Factory/02 Shared Registry");

    // Deleting a definition removes its values for every device, and a missing name reports false.
    await setLogicalPathValue("device-a", "script_library", "/s", isolatedDb);
    assert.equal(await deleteLogicalPathRow("script_library", isolatedDb), true);
    assert.equal(await getLogicalPathValue("device-a", "script_library", isolatedDb), null);
    assert.equal(await deleteLogicalPathRow("script_library", isolatedDb), false);
  }));

// Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md AC-FO-10): at most one active
// factory token, replaced atomically; revoked tokens are never found by hash; it lives in its own table.
test("factory_agent_tokens: replace keeps one active token; revoke hides it; separate from channel tokens", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    assert.equal(await tableExists(client, "factory_agent_tokens"), true);
    const isolatedDb = createIsolatedDb(client);

    await replaceFactoryAgentToken({ id: "f1", tokenHash: "h1", label: null }, isolatedDb);
    await replaceFactoryAgentToken({ id: "f2", tokenHash: "h2", label: "fo" }, isolatedDb);
    assert.equal(await findActiveFactoryAgentTokenByHash("h1", isolatedDb), null);
    assert.equal((await findActiveFactoryAgentTokenByHash("h2", isolatedDb))?.id, "f2");
    assert.deepEqual((await listActiveFactoryAgentTokens(isolatedDb)).map((t) => t.id), ["f2"]);

    // A channel token with the same hash is a different table: it is never found as a factory token.
    await replaceAgentChannelToken({ id: "c1", channelId: "UC_A", userId: "u-a", tokenHash: "hc", label: null }, isolatedDb);
    assert.equal(await findActiveFactoryAgentTokenByHash("hc", isolatedDb), null);
    assert.equal(await findActiveAgentChannelTokenByHash("h2", isolatedDb), null);

    // The database itself refuses a second ACTIVE row (independent review): a racing second issue can never
    // leave two valid tokens; it fails closed. A revoked row does not count.
    await assert.rejects(
      client.execute("INSERT INTO factory_agent_tokens (id, token_hash) VALUES ('f-race', 'h-race')"),
      /UNIQUE|constraint/i
    );
    assert.equal(await findActiveFactoryAgentTokenByHash("h-race", isolatedDb), null);
    assert.equal((await listActiveFactoryAgentTokens(isolatedDb)).length, 1);

    assert.equal(await revokeFactoryAgentTokens(isolatedDb), 1);
    assert.equal(await revokeFactoryAgentTokens(isolatedDb), 0);
    await client.execute("INSERT INTO factory_agent_tokens (id, token_hash) VALUES ('f-after', 'h-after')");
    assert.equal(await findActiveFactoryAgentTokenByHash("h2", isolatedDb), null);
    assert.equal((await findActiveAgentChannelTokenByHash("hc", isolatedDb))?.id, "c1");
  }));

// Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md AC-P12-11): at most one active token per channel,
// replaced atomically; revoked tokens are never found by hash.
test("agent_channel_tokens: replace keeps one active token per channel; revoke hides it from lookup", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    assert.equal(await tableExists(client, "agent_channel_tokens"), true);
    const isolatedDb = createIsolatedDb(client);

    await replaceAgentChannelToken({ id: "t1", channelId: "UC_A", userId: "u-a", tokenHash: "h1", label: null }, isolatedDb);
    await replaceAgentChannelToken({ id: "t2", channelId: "UC_B", userId: "u-b", tokenHash: "h2", label: "b" }, isolatedDb);
    await replaceAgentChannelToken({ id: "t3", channelId: "UC_A", userId: "u-a", tokenHash: "h3", label: null }, isolatedDb);

    assert.equal(await findActiveAgentChannelTokenByHash("h1", isolatedDb), null);
    assert.equal((await findActiveAgentChannelTokenByHash("h3", isolatedDb))?.id, "t3");
    assert.deepEqual((await listActiveAgentChannelTokens(isolatedDb)).map((t) => t.id).sort(), ["t2", "t3"]);

    assert.equal(await revokeAgentChannelTokens("UC_A", isolatedDb), 1);
    assert.equal(await revokeAgentChannelTokens("UC_A", isolatedDb), 0);
    assert.equal(await findActiveAgentChannelTokenByHash("h3", isolatedDb), null);
    assert.equal((await findActiveAgentChannelTokenByHash("h2", isolatedDb))?.channelId, "UC_B");
  }));

// Phase 12 slice 12.4: channel_record_assignments -- set replaces a record's channel set atomically;
// add is idempotent; reads are per (channel, kind).
test("channel_record_assignments: set replaces, add is idempotent, reads scoped by channel and kind", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await setRecordAssignmentChannels("research_channel", "UCx", ["UC_A", "UC_B"], isolatedDb);
    await setRecordAssignmentChannels("topic", "t1", ["UC_A"], isolatedDb);
    await addChannelRecordAssignment("UC_A", "research_request", "r1", isolatedDb);
    await addChannelRecordAssignment("UC_A", "research_request", "r1", isolatedDb);

    assert.deepEqual((await listChannelAssignedRecordIds("UC_A", "research_channel", isolatedDb)).sort(), ["UCx"]);
    assert.deepEqual(await listChannelAssignedRecordIds("UC_B", "topic", isolatedDb), []);
    assert.deepEqual(await listChannelAssignedRecordIds("UC_A", "research_request", isolatedDb), ["r1"]);

    await setRecordAssignmentChannels("research_channel", "UCx", ["UC_B"], isolatedDb);
    assert.deepEqual(await listChannelAssignedRecordIds("UC_A", "research_channel", isolatedDb), []);
    assert.deepEqual(await listRecordAssignmentsByKind("research_channel", isolatedDb), [{ channelId: "UC_B", recordId: "UCx" }]);
  }));

// Phase 13 (review round 5): reads never return another channel's API-sourced rows older than 30 days,
// even before the purge has run; operator-entered rows are unaffected.
test("13.2: snapshot and evidence reads hide expired API-sourced rows but keep manual ones", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await client.execute("INSERT INTO research_channels (id, reason, created_via) VALUES ('UC_READ_FILTER00000000', 'r', 'web_ui')");
    const old = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60;
    const fresh = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
    await client.execute({
      sql: "INSERT INTO market_channel_snapshots (id, research_channel_id, observed_at, hidden_subscriber_count, source, created_via) VALUES ('old-api', 'UC_READ_FILTER00000000', ?, 0, 'youtube.channels.list', 'web_ui'), ('fresh-api', 'UC_READ_FILTER00000000', ?, 0, 'youtube.channels.list', 'web_ui'), ('old-manual', 'UC_READ_FILTER00000000', ?, 0, 'manual observation', 'web_ui')",
      args: [old, fresh, old],
    });
    await client.execute({
      sql: "INSERT INTO research_evidence (id, research_channel_id, observation, source, created_via, collected_at) VALUES ('ev-old-api', 'UC_READ_FILTER00000000', 'counts', 'youtube.channels.list', 'web_ui', ?), ('ev-old-manual', 'UC_READ_FILTER00000000', 'note', 'manual', 'web_ui', ?)",
      args: [old, old],
    });
    const snaps = (await listMarketChannelSnapshotsByChannel("UC_READ_FILTER00000000", isolatedDb)).map((s) => s.id).sort();
    assert.deepEqual(snaps, ["fresh-api", "old-manual"]);
    const evidence = (await listResearchEvidenceByChannel("UC_READ_FILTER00000000", isolatedDb)).map((e) => e.id);
    assert.deepEqual(evidence, ["ev-old-manual"]);
  }));

// ---------------------------------------------------------------------------
// Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md). Expected values are hand-derived from the
// documented lifecycle: pending -> approved -> running -> done|failed, pending -> rejected, nothing else.
// ---------------------------------------------------------------------------

const COLLECTION_REQUEST_BASE = { channelIdsJson: '["UC_A","UC_B"]', reason: "r", estimateJson: "{}", createdVia: "mcp" };

test("claimStaleResearchChannelsForCollection: onlyResearchChannelIds restricts the claim to those channels (an empty list claims nothing); the stale rule still applies", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const now = new Date("2026-09-27T12:00:00.000Z");
    await isolatedDb.insert(researchChannels).values([
      { id: "UC_ONE", reason: "r", createdVia: "web_ui" },
      { id: "UC_TWO", reason: "r", createdVia: "web_ui" },
      { id: "UC_FRESH", reason: "r", createdVia: "web_ui", lastAutoCollectedAt: new Date(now.getTime() - 60 * 60 * 1000) },
    ]);
    const args = {
      now,
      staleCutoff: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      claimExpiryCutoff: new Date(now.getTime() - 15 * 60 * 1000),
      excludeResearchChannelIds: [],
    };
    assert.deepEqual(await claimStaleResearchChannelsForCollection({ ...args, onlyResearchChannelIds: [] }, isolatedDb), []);
    assert.deepEqual(
      (await claimStaleResearchChannelsForCollection({ ...args, onlyResearchChannelIds: ["UC_ONE", "UC_FRESH"] }, isolatedDb)).sort(),
      ["UC_ONE"],
      "UC_FRESH was collected 1h ago, so even when listed it is not claimable; UC_TWO was not listed"
    );
  }));

test("market_collection_requests: insert starts pending; reject only from pending; a second reject returns null", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertMarketCollectionRequest({ id: "cr-1", ...COLLECTION_REQUEST_BASE }, isolatedDb);
    assert.equal((await getMarketCollectionRequestById("cr-1", isolatedDb))?.status, "pending");
    const at = new Date("2026-09-27T12:00:00.000Z");
    const rejected = await rejectMarketCollectionRequestIfPending("cr-1", "too expensive", at, isolatedDb);
    assert.equal(rejected?.status, "rejected");
    assert.equal(rejected?.resolvedReason, "too expensive");
    assert.equal(await rejectMarketCollectionRequestIfPending("cr-1", "again", at, isolatedDb), null);
    assert.equal(await approveMarketCollectionRequestIfPending("cr-1", "u1", at, isolatedDb), null, "a rejected request can never be approved");
  }));

test("market_collection_requests: two literally-concurrent approvals of one pending request -- exactly one wins", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertMarketCollectionRequest({ id: "cr-race", ...COLLECTION_REQUEST_BASE }, isolatedDb);
    const at = new Date("2026-09-27T12:00:00.000Z");
    const results = await Promise.all([
      approveMarketCollectionRequestIfPending("cr-race", "u1", at, isolatedDb),
      approveMarketCollectionRequestIfPending("cr-race", "u2", at, isolatedDb),
    ]);
    assert.equal(results.filter((r) => r !== null).length, 1);
    const row = await getMarketCollectionRequestById("cr-race", isolatedDb);
    assert.equal(row?.status, "approved");
    assert.equal(row?.approvedAt?.getTime(), at.getTime());
  }));

test("market_collection_requests: the lifecycle cannot skip a step (start needs approved, finish needs running, pending cannot jump to done)", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    await insertMarketCollectionRequest({ id: "cr-2", ...COLLECTION_REQUEST_BASE }, isolatedDb);
    const at = new Date("2026-09-27T12:00:00.000Z");
    assert.equal(await startMarketCollectionRequestIfApproved("cr-2", isolatedDb), null, "pending cannot start");
    assert.equal(
      await finishMarketCollectionRequestIfRunning("cr-2", { status: "done", resultJson: "[]", unitsSpentTotal: 0 }, at, isolatedDb),
      null,
      "pending cannot finish"
    );
    await approveMarketCollectionRequestIfPending("cr-2", "u1", at, isolatedDb);
    assert.equal(
      await finishMarketCollectionRequestIfRunning("cr-2", { status: "done", resultJson: "[]", unitsSpentTotal: 0 }, at, isolatedDb),
      null,
      "approved (not running) cannot finish"
    );
    assert.equal((await startMarketCollectionRequestIfApproved("cr-2", isolatedDb))?.status, "running");
    assert.equal(await startMarketCollectionRequestIfApproved("cr-2", isolatedDb), null, "a running request cannot start again");
    const done = await finishMarketCollectionRequestIfRunning(
      "cr-2",
      { status: "done", resultJson: '[{"channelId":"UC_A"}]', unitsSpentTotal: 7 },
      at,
      isolatedDb
    );
    assert.equal(done?.status, "done");
    assert.equal(done?.unitsSpentTotal, 7);
    assert.equal(done?.resultJson, '[{"channelId":"UC_A"}]');
    assert.equal(await rejectMarketCollectionRequestIfPending("cr-2", "x", at, isolatedDb), null);
  }));

test("findOpenMarketCollectionRequestForChannel: pending/approved/running count as open; done/rejected/failed do not; membership is exact", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const at = new Date("2026-09-27T12:00:00.000Z");
    await insertMarketCollectionRequest({ id: "cr-open", ...COLLECTION_REQUEST_BASE }, isolatedDb);
    assert.equal((await findOpenMarketCollectionRequestForChannel("UC_A", isolatedDb))?.id, "cr-open");
    assert.equal(await findOpenMarketCollectionRequestForChannel("UC_C", isolatedDb), null, "a channel not in the list has no open request");
    assert.equal(await findOpenMarketCollectionRequestForChannel("UC_", isolatedDb), null, "a prefix of an id is not membership");
    await approveMarketCollectionRequestIfPending("cr-open", null, at, isolatedDb);
    assert.equal((await findOpenMarketCollectionRequestForChannel("UC_B", isolatedDb))?.id, "cr-open");
    await startMarketCollectionRequestIfApproved("cr-open", isolatedDb);
    assert.equal((await findOpenMarketCollectionRequestForChannel("UC_B", isolatedDb))?.id, "cr-open");
    await finishMarketCollectionRequestIfRunning("cr-open", { status: "failed", resultJson: null, unitsSpentTotal: 0, error: "x" }, at, isolatedDb);
    assert.equal(await findOpenMarketCollectionRequestForChannel("UC_A", isolatedDb), null);
  }));

test("failInterruptedMarketCollectionRequests: approved/running requests approved before the cutoff become failed 'interrupted'; newer ones, pending ones and finished ones are untouched", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const now = new Date("2026-09-27T12:00:00.000Z");
    const old = new Date(now.getTime() - 40 * 60 * 1000);
    const recent = new Date(now.getTime() - 5 * 60 * 1000);
    for (const id of ["old-running", "old-approved", "recent-running", "old-pending", "old-done"]) {
      await insertMarketCollectionRequest({ id, ...COLLECTION_REQUEST_BASE }, isolatedDb);
    }
    await approveMarketCollectionRequestIfPending("old-running", null, old, isolatedDb);
    await startMarketCollectionRequestIfApproved("old-running", isolatedDb);
    await approveMarketCollectionRequestIfPending("old-approved", null, old, isolatedDb);
    await approveMarketCollectionRequestIfPending("recent-running", null, recent, isolatedDb);
    await startMarketCollectionRequestIfApproved("recent-running", isolatedDb);
    await approveMarketCollectionRequestIfPending("old-done", null, old, isolatedDb);
    await startMarketCollectionRequestIfApproved("old-done", isolatedDb);
    await finishMarketCollectionRequestIfRunning("old-done", { status: "done", resultJson: "[]", unitsSpentTotal: 0 }, old, isolatedDb);

    const cutoff = new Date(now.getTime() - 30 * 60 * 1000);
    assert.equal(await failInterruptedMarketCollectionRequests(cutoff, now, isolatedDb), 2);
    for (const id of ["old-running", "old-approved"]) {
      const row = await getMarketCollectionRequestById(id, isolatedDb);
      assert.equal(row?.status, "failed");
      assert.equal(row?.error, "interrupted");
    }
    assert.equal((await getMarketCollectionRequestById("recent-running", isolatedDb))?.status, "running");
    assert.equal((await getMarketCollectionRequestById("old-pending", isolatedDb))?.status, "pending");
    assert.equal((await getMarketCollectionRequestById("old-done", isolatedDb))?.status, "done");
  }));

test("renewResearchChannelCollectionClaims: renews only claims still carrying the expected value; a reclaimed or released channel is left alone", () =>
  withTempClient(async (client) => {
    await initializeDatabaseSchema(client);
    const isolatedDb = createIsolatedDb(client);
    const t0 = new Date("2026-09-27T12:00:00.000Z");
    const t1 = new Date("2026-09-27T12:20:00.000Z");
    const other = new Date("2026-09-27T12:10:00.000Z");
    await isolatedDb.insert(researchChannels).values([
      { id: "UC_MINE", reason: "r", createdVia: "web_ui", collectionClaimedAt: t0 },
      { id: "UC_TAKEN", reason: "r", createdVia: "web_ui", collectionClaimedAt: other },
      { id: "UC_FREE", reason: "r", createdVia: "web_ui" },
    ]);
    assert.deepEqual(await renewResearchChannelCollectionClaims([], t0, t1, isolatedDb), []);
    assert.deepEqual(await renewResearchChannelCollectionClaims(["UC_MINE", "UC_TAKEN", "UC_FREE"], t0, t1, isolatedDb), ["UC_MINE"]);
    const rows = await isolatedDb.select().from(researchChannels);
    const at = (id: string) => rows.find((r) => r.id === id)?.collectionClaimedAt?.getTime() ?? null;
    assert.equal(at("UC_MINE"), t1.getTime());
    assert.equal(at("UC_TAKEN"), other.getTime());
    assert.equal(at("UC_FREE"), null);
  }));
