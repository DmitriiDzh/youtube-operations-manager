import type { MusicChartEntry } from "@/lib/youtube-read-gateway";
import type { CredentialRef } from "@/lib/shared-domain";
import { SEARCH_LIST_DAILY_CALL_LIMIT, SEARCH_LIST_UNIT_COST, nextYoutubeQuotaReset, startOfYoutubeQuotaDay } from "@/lib/youtube-quota";
import { API_DATA_RETENTION_DAYS } from "@/lib/youtube-data-policy/contracts";
import { MUSIC_CHART_REGIONS } from "./contracts";
import {
  DEFAULT_MAX_VIDEOS_PER_CHANNEL,
  PLAYLIST_PAGE_SIZE,
  STEADY_STATE_WORST_CASE_UNITS,
  estimateCollectionUnits,
  needsBackfill,
  pagesForCap,
  resolveCollectionDepth,
  type CollectionCompleteReason,
  type CollectionProgress,
} from "./collection-depth";
import { YOUTUBE_READ_SCOPE } from "@/lib/auth";
import {
  assessObservationFreshness,
  assessSnapshotCompleteness,
  toHiddenSubscriberCountFlag,
} from "./data-quality";
import { type FieldVelocity } from "./derived-metrics";
import {
  BREAKOUT_MIN_BASELINE_SAMPLE_SIZE,
  ageNormalizedTolerance,
  type BreakoutAssessment,
  type EmergingChannelAssessment,
} from "./historical-intelligence";
import {
  DomainError,
  isDomainError,
  MARKET_INTELLIGENCE_STALE_WINDOW_MS,
  type CollectionChannelOutcome,
  type CollectionChannelResult,
  type CollectionEstimate,
  type CollectionLimits,
  type CollectionNotNeeded,
  type CreateCollectionRequestResult,
  type DataQualityFlag,
  type DiscoveryCandidateStatus,
  type MarketCollectionRequest,
  type MarketCollectionRequestStatus,
  type MarketChannelSnapshot,
  type MarketDiscoveryCandidate,
  type MarketResearchRequest,
  type MarketTopic,
  type MarketTopicAssignment,
  type MarketTrendCandidate,
  type MarketTrendEvidence,
  type MarketVideoSnapshot,
  type PublicChannelSearchResult,
  type PublicChannelStats,
  type PublicVideoSearchResult,
  type PublicChannelSnapshot,
  type PublicVideoSnapshot,
  type ResearchChannel,
  type ResearchEvidence,
  type ResolvedCredentials,
  type TopicAssignmentSubjectType,
  type TrendCandidateStatus,
  type TrendEvidenceType,
} from "./contracts";
import {
  addToWatchlistInputSchema,
  addToWatchlistOutputSchema,
  approveMarketResearchRequestInputSchema,
  approveMarketResearchRequestOutputSchema,
  assignTopicInputSchema,
  assignTopicOutputSchema,
  captureChannelSnapshotInputSchema,
  captureChannelSnapshotOutputSchema,
  createCollectionRequestInputSchema,
  createCollectionRequestOutputSchema,
  createMarketResearchRequestInputSchema,
  createMarketResearchRequestOutputSchema,
  createTopicInputSchema,
  createTopicOutputSchema,
  createTrendCandidateInputSchema,
  createTrendCandidateOutputSchema,
  deleteTopicInputSchema,
  discoverChannelsByGenreInputSchema,
  discoverChannelsByGenreOutputSchema,
  discoverChannelsInputSchema,
  discoverChannelsOutputSchema,
  fetchPublicSnapshotInputSchema,
  fetchPublicSnapshotOutputSchema,
  getChannelIntelligenceSummaryInputSchema,
  getChannelIntelligenceSummaryOutputSchema,
  getChannelVideoSnapshotHistoryInputSchema,
  getChannelVideoSnapshotHistoryOutputSchema,
  getMarketOverviewOutputSchema,
  getWatchlistTableOutputSchema,
  collectionLimitsSchema,
  collectionChannelResultSchema,
  getCollectionRequestInputSchema,
  getMarketResearchRequestInputSchema,
  getMarketVideosOverviewOutputSchema,
  listCollectionRequestsOutputSchema,
  marketCollectionRequestSchema,
  rejectCollectionRequestInputSchema,
  runApprovedCollectionRequestInputSchema,
  getTrendEvidenceSummaryOutputSchema,
  getWatchlistEntryContextOutputSchema,
  getWatchlistEntryInputSchema,
  getWatchlistEntryOutputSchema,
  listAssignmentsForTopicInputSchema,
  listAssignmentsForTopicOutputSchema,
  listChannelSnapshotsInputSchema,
  listChannelSnapshotsOutputSchema,
  listDiscoveryCandidatesOutputSchema,
  listEvidenceInputSchema,
  listEvidenceOutputSchema,
  listMarketResearchRequestsOutputSchema,
  listTopicsForSubjectInputSchema,
  listTopicsForSubjectOutputSchema,
  listTopicsOutputSchema,
  listTrendCandidatesOutputSchema,
  listTrendCandidatesWithFreshnessOutputSchema,
  listTrendEvidenceInputSchema,
  listTrendEvidenceOutputSchema,
  listVideoSnapshotsInputSchema,
  listVideoSnapshotsOutputSchema,
  listWatchlistOutputSchema,
  marketDiscoveryCandidateSchema,
  marketResearchRequestSchema,
  marketTrendCandidateSchema,
  parseWithSchema,
  promoteDiscoveryCandidateInputSchema,
  promoteDiscoveryCandidateOutputSchema,
  recordChannelSnapshotInputSchema,
  recordChannelSnapshotOutputSchema,
  recordEvidenceInputSchema,
  recordEvidenceOutputSchema,
  recordTrendEvidenceInputSchema,
  recordTrendEvidenceOutputSchema,
  recordVideoSnapshotInputSchema,
  recordVideoSnapshotOutputSchema,
  rejectMarketResearchRequestInputSchema,
  rejectMarketResearchRequestOutputSchema,
  removeFromWatchlistInputSchema,
  removeTopicAssignmentInputSchema,
  runCollectionIfStaleInputSchema,
  runCollectionIfStaleOutputSchema,
  setCollectionDepthDefaultsInputSchema,
  setResearchChannelCollectionDepthInputSchema,
  updateDiscoveryCandidateStatusInputSchema,
  updateTrendCandidateStatusInputSchema,
} from "./schemas";
import type { CreatedVia } from "@/lib/shared-provenance";

/**
 * Builds the human-readable `research_evidence.observation` text for a public-snapshot fetch
 * (Phase 9 slice 3). Exported for direct unit testing (`AGENTS.md` §L: the "never fabricate"
 * requirement applies to the wording itself, not only to the underlying numbers) -- a hidden or
 * missing field is described as such, never silently omitted or presented as zero.
 *
 * Includes `title` (found missing by independent review, 2026-09-26 -- the plan's own §4 in-scope
 * bullet promises "title... where cheaply available," but the first version of this function
 * fetched `title` into `PublicChannelSnapshot` and then silently discarded it, leaving an operator
 * who added a channel by bare `UC...` id with no human-readable name anywhere in the Research
 * tab). `subscriberCount` is explicitly flagged as YouTube's own rounded approximation (the real
 * YouTube Data API v3 docs for `channels.list` document `statistics.subscriberCount` as "rounded
 * to three significant figures," never exact) -- `viewCount`/`videoCount` are not rounded and are
 * stated plainly.
 */
export function describePublicChannelSnapshot(snapshot: PublicChannelSnapshot): string {
  // Uses the real `hiddenSubscriberCount` flag (added for slice 9A), not `subscriberCount ===
  // null` alone -- a null count can also mean "absent/unparseable," a genuinely different, unknown
  // gap this wording should not misdescribe as "hidden" (independent review, 2026-09-26).
  const subscribers =
    snapshot.subscriberCount !== null
      ? `~${snapshot.subscriberCount} subscribers (YouTube reports this rounded to 3 significant figures, not an exact count)`
      : snapshot.hiddenSubscriberCount
        ? "subscriber count hidden"
        : "subscriber count unavailable";
  const views = snapshot.viewCount !== null ? `${snapshot.viewCount} total views` : "view count unavailable";
  const videos = snapshot.videoCount !== null ? `${snapshot.videoCount} videos` : "video count unavailable";
  // Falls back to the channel id when YouTube's own response omits `snippet.title` (the read
  // gateway's own `??` default is `""`, never fabricated -- found by independent review, round 2,
  // 2026-09-26: an empty string interpolated directly here would have rendered a confusing
  // `for ""` with nothing identifying the channel at all).
  const title = snapshot.title || snapshot.channelId;
  return `Public snapshot for "${title}": ${subscribers}, ${views}, ${videos}`;
}

type StoredResearchChannelForService = {
  id: string;
  handleOrUrl: string | null;
  reason: string;
  createdVia: string;
  addedAt: Date;
  /** Set only on a channel's own full collection success (the stale-window clock); absent on rows from stores that do not expose it. */
  lastAutoCollectedAt?: Date | null;
  // Operator request 2026-10-04 (collection depth); absent/null = default depth, progress not yet known.
  maxVideosPerChannel?: number | null;
  publishedAfter?: string | null;
  videosComplete?: number | null;
  videosCompleteReason?: string | null;
  videosNextPageToken?: string | null;
  videosCapAtRun?: number | null;
  videosPublishedAfterAtRun?: string | null;
};

type StoredResearchEvidenceForService = {
  id: string;
  researchChannelId: string;
  observation: string;
  source: string;
  confidence: string | null;
  createdVia: string;
  collectedAt: Date;
};

type StoredMarketChannelSnapshotForService = {
  id: string;
  researchChannelId: string;
  observedAt: Date;
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
  hiddenSubscriberCount: boolean;
  source: string;
  createdVia: string;
};

type StoredMarketVideoSnapshotForService = {
  id: string;
  researchChannelId: string;
  videoId: string;
  observedAt: Date;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  publishedAt: Date | null;
  title: string | null;
  durationSeconds?: number | null;
  liveBroadcastContent?: string | null;
  source: string;
  createdVia: string;
};

// Phase 9 slice 9G, part A -- deliberately narrower than db.ts's own StoredMarketIntelligenceCollectionRun:
// only the fields assessSnapshotCompleteness/the quota_limited check actually need.
type StoredMarketIntelligenceCollectionRunForService = {
  status: "success" | "skipped_quota_limited" | "failed";
  ranAt?: Date;
  videosRequested: number | null;
  videosReturned: number | null;
  feedFallback?: boolean;
};

/** One channel's effective collection depth, progress and cost estimate (operator request 2026-10-04). */
function buildCollectionProgress(
  channelRow: StoredResearchChannelForService,
  defaults: { maxVideosPerChannel: number | null; publishedAfter: string | null },
  storedVideoIds: readonly string[]
): CollectionProgress {
  const depth = resolveCollectionDepth(channelRow, defaults);
  const estimate = estimateCollectionUnits(depth.maxVideosPerChannel);
  // "Complete" = a deep collection finished under the settings in force now; never-collected and unfinished are false.
  const complete = !needsBackfill(channelRow, depth, new Set(storedVideoIds).size);
  return {
    maxVideosPerChannel: depth.maxVideosPerChannel,
    maxVideosPerChannelOverride: channelRow.maxVideosPerChannel ?? null,
    publishedAfter: depth.publishedAfter,
    publishedAfterOverride: channelRow.publishedAfter ?? null,
    videosStored: new Set(storedVideoIds).size,
    complete,
    completeReason: complete ? ((channelRow.videosCompleteReason as CollectionCompleteReason | null | undefined) ?? null) : null,
    estimatedFirstCollectionUnits: estimate.firstCollection,
    estimatedFirstCollectionWorstCaseUnits: estimate.firstCollectionWorstCase,
  };
}

function toResearchChannel(row: StoredResearchChannelForService): ResearchChannel {
  return {
    channelId: row.id,
    handleOrUrl: row.handleOrUrl,
    reason: row.reason,
    addedAt: row.addedAt.toISOString(),
  };
}

function toResearchEvidence(row: StoredResearchEvidenceForService): ResearchEvidence {
  return {
    evidenceId: row.id,
    researchChannelId: row.researchChannelId,
    observation: row.observation,
    source: row.source,
    confidence: row.confidence,
    collectedAt: row.collectedAt.toISOString(),
  };
}

function toMarketChannelSnapshot(row: StoredMarketChannelSnapshotForService): MarketChannelSnapshot {
  return {
    snapshotId: row.id,
    researchChannelId: row.researchChannelId,
    observedAt: row.observedAt.toISOString(),
    subscriberCount: row.subscriberCount,
    viewCount: row.viewCount,
    videoCount: row.videoCount,
    hiddenSubscriberCount: row.hiddenSubscriberCount,
    source: row.source,
  };
}

function toMarketVideoSnapshot(row: StoredMarketVideoSnapshotForService): MarketVideoSnapshot {
  return {
    snapshotId: row.id,
    researchChannelId: row.researchChannelId,
    videoId: row.videoId,
    observedAt: row.observedAt.toISOString(),
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    title: row.title,
    durationSeconds: row.durationSeconds ?? null,
    liveBroadcastContent: row.liveBroadcastContent ?? null,
    source: row.source,
  };
}

type StoredMarketDiscoveryCandidateForService = {
  id: string;
  title: string;
  status: DiscoveryCandidateStatus;
  discoverySource: string;
  discoveryQuery: string;
  reasonDiscovered: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdVia: string;
  subscriberCount?: number | null;
  hiddenSubscriberCount?: boolean | null;
  videoCount?: number | null;
  viewCount?: number | null;
  channelPublishedAt?: string | null;
  statsObservedAt?: Date | null;
  matchQuery?: string | null;
  matchVideoCount?: number | null;
  matchViewCount?: number | null;
};

/** Phase 13 (review round 6): a candidate's title/reason come from `search.list` (another channel's
 * API data, III.E.4.d). Past 30 days since it was last seen they are never served, even before the
 * purge has run -- an undecided candidate is hidden, a decided one keeps only its id and decision
 * (owner msg 1139), the same rule the purge applies. */
function candidateExpired(row: StoredMarketDiscoveryCandidateForService, now: Date): boolean {
  return now.getTime() - row.lastSeenAt.getTime() > API_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

function toMarketDiscoveryCandidate(row: StoredMarketDiscoveryCandidateForService, now: Date): MarketDiscoveryCandidate {
  const expired = candidateExpired(row, now);
  return {
    channelId: row.id,
    title: expired ? "" : row.title,
    status: row.status,
    discoverySource: row.discoverySource,
    discoveryQuery: row.discoveryQuery,
    reasonDiscovered: expired ? null : row.reasonDiscovered,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    // BL-145: API data like the title -- never served past the 30 days.
    stats:
      expired || !row.statsObservedAt
        ? null
        : {
            subscriberCount: row.subscriberCount ?? null,
            hiddenSubscriberCount: row.hiddenSubscriberCount === true,
            videoCount: row.videoCount ?? null,
            viewCount: row.viewCount ?? null,
            channelPublishedAt: row.channelPublishedAt ?? null,
            observedAt: row.statsObservedAt.toISOString(),
          },
    match:
      expired || !row.matchQuery || row.matchVideoCount === null || row.matchVideoCount === undefined
        ? null
        : { query: row.matchQuery, videoCount: row.matchVideoCount, viewCount: row.matchViewCount ?? null },
  };
}

type StoredMarketTopicForService = {
  id: string;
  name: string;
  createdVia: string;
  createdAt: Date;
};

function toMarketTopic(row: StoredMarketTopicForService): MarketTopic {
  return { topicId: row.id, name: row.name, addedAt: row.createdAt.toISOString() };
}

type StoredMarketTopicAssignmentForService = {
  id: string;
  topicId: string;
  subjectType: TopicAssignmentSubjectType;
  subjectId: string;
  source: "manual" | "ai_assisted";
  createdVia: string;
  assignedAt: Date;
};

function toMarketTopicAssignment(row: StoredMarketTopicAssignmentForService): MarketTopicAssignment {
  return {
    assignmentId: row.id,
    topicId: row.topicId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    source: row.source,
    assignedAt: row.assignedAt.toISOString(),
  };
}

// Owner spec §13: "normalized keywords" -- trims, collapses internal whitespace, and lowercases
// for COMPARISON only (the schema layer already trims/collapses the value that gets stored; this
// additionally lowercases so "Night Jazz Bar" and "night jazz bar" are treated as the same topic,
// without forcing the STORED name itself to lose the operator's own preferred casing).
function normalizeTopicNameForComparison(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

type StoredMarketTrendCandidateForService = {
  id: string;
  title: string;
  description: string | null;
  topicId: string | null;
  status: TrendCandidateStatus;
  firstObservedAt: Date;
  lastObservedAt: Date;
  createdVia: string;
};

function toMarketTrendCandidate(row: StoredMarketTrendCandidateForService): MarketTrendCandidate {
  return {
    trendCandidateId: row.id,
    title: row.title,
    description: row.description,
    topicId: row.topicId,
    status: row.status,
    firstObservedAt: row.firstObservedAt.toISOString(),
    lastObservedAt: row.lastObservedAt.toISOString(),
  };
}

type StoredMarketTrendEvidenceForService = {
  id: string;
  trendCandidateId: string;
  evidenceType: TrendEvidenceType;
  referenceId: string | null;
  description: string;
  createdVia: string;
  recordedAt: Date;
};

function toMarketTrendEvidence(row: StoredMarketTrendEvidenceForService): MarketTrendEvidence {
  return {
    evidenceId: row.id,
    trendCandidateId: row.trendCandidateId,
    evidenceType: row.evidenceType,
    referenceId: row.referenceId,
    description: row.description,
    recordedAt: row.recordedAt.toISOString(),
  };
}

// Phase 9 slice 9G, part B.
type StoredMarketResearchRequestForService = {
  id: string;
  query: string;
  rationale: string;
  monitorDurationDays: number | null;
  status: "pending" | "approved" | "rejected" | "executed" | "execution_failed";
  createdVia: string;
  agentApiVersion: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  candidatesFound: number | null;
  candidatesNew: number | null;
  executionError: string | null;
};

function toMarketResearchRequest(row: StoredMarketResearchRequestForService): MarketResearchRequest {
  return {
    requestId: row.id,
    query: row.query,
    rationale: row.rationale,
    monitorDurationDays: row.monitorDurationDays,
    status: row.status,
    createdVia: row.createdVia,
    agentApiVersion: row.agentApiVersion,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedReason: row.resolvedReason,
    candidatesFound: row.candidatesFound,
    candidatesNew: row.candidatesNew,
    executionError: row.executionError,
  };
}

// Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md).
type StoredMarketCollectionRequestForService = {
  id: string;
  channelIdsJson: string;
  reason: string;
  status: MarketCollectionRequestStatus;
  estimateJson: string;
  createdVia: string;
  agentApiVersion: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  approvedByUserId?: string | null;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  resultJson: string | null;
  unitsSpentTotal: number | null;
  error: string | null;
};

function toMarketCollectionRequest(row: StoredMarketCollectionRequestForService): MarketCollectionRequest {
  return {
    requestId: row.id,
    channelIds: JSON.parse(row.channelIdsJson) as string[],
    reason: row.reason,
    status: row.status,
    estimate: JSON.parse(row.estimateJson) as CollectionEstimate,
    createdVia: row.createdVia,
    agentApiVersion: row.agentApiVersion,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedReason: row.resolvedReason,
    result: row.resultJson === null ? null : (JSON.parse(row.resultJson) as CollectionChannelResult[]),
    unitsSpentTotal: row.unitsSpentTotal,
    error: row.error,
  };
}

/** What a collection pass has gathered so far; the caller reads it when the pass throws (units actually charged, results so far). */
type CollectionRunSink = { channels: CollectionChannelResult[]; unitsSpent: number; claimed: string[] };
type CollectionPassResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  quotaLimited: number;
  unitsSpent: number;
  channels: CollectionChannelResult[];
};

function roundedHours(fromMs: number, toMs: number): number {
  return Math.round(((toMs - fromMs) / 3_600_000) * 10) / 10;
}

type ServiceDependencies = {
  idGenerator(): string;
  insertResearchChannel(input: {
    id: string;
    handleOrUrl?: string | null;
    reason: string;
    createdVia: string;
  }): Promise<void>;
  listResearchChannels(): Promise<StoredResearchChannelForService[]>;
  getResearchChannelById(id: string): Promise<StoredResearchChannelForService | null>;
  deleteResearchChannel(id: string): Promise<void>;
  insertResearchEvidence(input: {
    id: string;
    researchChannelId: string;
    observation: string;
    source: string;
    confidence?: string | null;
    createdVia: string;
  }): Promise<void>;
  listResearchEvidenceByChannel(researchChannelId: string): Promise<StoredResearchEvidenceForService[]>;
  authResolver: {
    resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials>;
  };
  youtubeApi: {
    getPublicChannelSnapshot(args: {
      credentials: ResolvedCredentials;
      channelId: string;
    }): Promise<PublicChannelSnapshot | null>;
    // Phase 9 slice 9B; Phase 13: with each item's title and publish time. Operator request 2026-10-04: one PAGE (<= 50 items, exactly
    // 1 unit) per call; `pageToken` omitted = the first page; `nextPageToken` null on the last page.
    listUploadsPlaylistPage(args: {
      credentials: ResolvedCredentials;
      uploadsPlaylistId: string;
      pageToken?: string;
    }): Promise<{ items: { videoId: string; title: string; publishedAt: string | null }[]; nextPageToken: string | null }>;
    getPublicVideoSnapshots(args: {
      credentials: ResolvedCredentials;
      videoIds: string[];
    }): Promise<PublicVideoSnapshot[]>;
    /** Phase 13 slice 13.9: YouTube's Trending Music chart for a region (1 unit). */
    getMostPopularMusicVideos(args: { credentials: ResolvedCredentials; regionCode: string }): Promise<MusicChartEntry[]>;
    // Phase 13 slices 13.5/13.6 -- the RSS feed is the zero-quota FALLBACK for the uploads list;
    // batchGetStats (own bucket) is the primary source of statistics, videos.list its fallback.
    /** The channel's RSS feed (newest ~15 uploads): no quota at all. */
    listChannelFeedVideoIds(args: { channelId: string }): Promise<{ videoId: string; title: string; publishedAt: string | null }[]>;
    /** `videos.batchGetStats`: 1 unit of its own bucket, not the shared pool. */
    getPublicVideoStatsBatch(args: { credentials: ResolvedCredentials; videoIds: string[] }): Promise<PublicVideoSnapshot[]>;
    // Phase 9 slice 9C.
    searchPublicChannels(args: {
      credentials: ResolvedCredentials;
      query: string;
    }): Promise<PublicChannelSearchResult[]>;
    /** BL-145: a search.list for music VIDEOS (1 call of the 100-searches bucket). */
    searchPublicMusicVideos(args: { credentials: ResolvedCredentials; query: string; publishedAfter: string | null }): Promise<PublicVideoSearchResult[]>;
    /** BL-145: `channels.list` counts of up to 50 channels per call, 1 pool unit each. */
    getPublicChannelStats(args: { credentials: ResolvedCredentials; channelIds: string[] }): Promise<PublicChannelStats[]>;
    // Found by independent review -- a cheap, upfront, local-only check called BEFORE any channel
    // is claimed or any budget spent, so a disabled toggle never gets mischarged as if it were a
    // real, failed network call.
    assertReadsAvailable(): Promise<void>;
  };
  // Phase 9 slice 9A (docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md).
  insertMarketChannelSnapshot(input: {
    id: string;
    researchChannelId: string;
    subscriberCount?: number | null;
    viewCount?: number | null;
    videoCount?: number | null;
    hiddenSubscriberCount?: boolean;
    source: string;
    createdVia: string;
  }): Promise<void>;
  listMarketChannelSnapshotsByChannel(researchChannelId: string): Promise<StoredMarketChannelSnapshotForService[]>;
  insertMarketVideoSnapshot(input: {
    id: string;
    researchChannelId: string;
    videoId: string;
    viewCount?: number | null;
    likeCount?: number | null;
    commentCount?: number | null;
    publishedAt?: Date | null;
    title?: string | null;
    durationSeconds?: number | null;
    liveBroadcastContent?: string | null;
    source: string;
    createdVia: string;
  }): Promise<void>;
  listMarketVideoSnapshotsByChannel(researchChannelId: string): Promise<StoredMarketVideoSnapshotForService[]>;
  // Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md).
  /** Injectable so staleness/budget-window tests never depend on the real wall clock (advisor
   * review, before implementation -- mirrors `analytics/services.ts`'s own identical pattern). */
  clock: { now(): Date };
  getMarketIntelligenceDailyQuotaBudgetUnits(): Promise<number | null>;
  setMarketIntelligenceDailyQuotaBudgetUnits(units: number | null): Promise<void>;
  // Operator request 2026-10-04 -- collection depth (global default, per-channel override, resume state).
  getMarketIntelligenceCollectionDepthDefaults(): Promise<{ maxVideosPerChannel: number | null; publishedAfter: string | null }>;
  setMarketIntelligenceCollectionDepthDefaults(input: { maxVideosPerChannel: number | null; publishedAfter: string | null }): Promise<void>;
  setResearchChannelCollectionDepth(
    researchChannelId: string,
    input: { maxVideosPerChannel: number | null; publishedAfter: string | null }
  ): Promise<void>;
  saveResearchChannelCollectionProgress(
    researchChannelId: string,
    input: {
      complete: boolean;
      completeReason: CollectionCompleteReason | null;
      nextPageToken: string | null;
      capAtRun: number;
      publishedAfterAtRun: string | null;
    }
  ): Promise<void>;
  getMarketIntelligenceUnitsSpentSince(since: Date): Promise<number>;
  /** Phase 13 slice 13.4: `search.list` calls since `since` (their own quota bucket). */
  countMarketDiscoverySearchesSince(since: Date): Promise<number>;
  // Phase 9 slice 9G, part A (docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md).
  getLatestMarketIntelligenceCollectionRunForChannel(
    researchChannelId: string
  ): Promise<StoredMarketIntelligenceCollectionRunForService | null>;
  /** Phase 13 (review round 9): any `success` collection run ever, for `neverObserved`. */
  hasSuccessfulMarketIntelligenceCollectionRun(researchChannelId: string): Promise<boolean>;
  claimStaleResearchChannelsForCollection(args: {
    now: Date;
    staleCutoff: Date;
    claimExpiryCutoff: Date;
    excludeResearchChannelIds: string[];
    /** Only these channels may be claimed (an approved collection request). */
    onlyResearchChannelIds?: string[];
  }): Promise<string[]>;
  releaseResearchChannelCollectionClaim(researchChannelId: string): Promise<void>;
  /** Moves the claim of the given channels from `expectedClaimedAt` to `newClaimedAt` where they still carry it; returns the renewed ids. */
  renewResearchChannelCollectionClaims(ids: string[], expectedClaimedAt: Date, newClaimedAt: Date): Promise<string[]>;
  listRecentlyFailedResearchChannelIds(since: Date): Promise<string[]>;
  markResearchChannelAutoCollected(researchChannelId: string, at: Date): Promise<void>;
  insertMarketIntelligenceCollectionRun(input: {
    researchChannelId: string;
    status: "success" | "skipped_quota_limited" | "failed";
    unitsSpent: number;
    videosRequested?: number | null;
    videosReturned?: number | null;
    errorMessage?: string | null;
    feedFallback?: boolean;
    ranAt?: Date;
  }): Promise<void>;
  // Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md).
  getMarketDiscoveryCandidateById(channelId: string): Promise<StoredMarketDiscoveryCandidateForService | null>;
  listMarketDiscoveryCandidates(): Promise<StoredMarketDiscoveryCandidateForService[]>;
  insertMarketDiscoveryCandidate(input: {
    id: string;
    title: string;
    discoverySource: string;
    discoveryQuery: string;
    reasonDiscovered?: string | null;
    createdVia: string;
  }): Promise<void>;
  touchMarketDiscoveryCandidateLastSeen(channelId: string, at: Date, title: string, reasonDiscovered: string | null): Promise<void>;
  /** BL-145: records what the latest genre search found of a candidate. */
  setMarketDiscoveryCandidateMatch(channelId: string, match: { query: string; videoCount: number; viewCount: number | null }): Promise<void>;
  /** BL-145: records a candidate's public counts as just observed. */
  setMarketDiscoveryCandidateStats(
    channelId: string,
    stats: { subscriberCount: number | null; hiddenSubscriberCount: boolean; videoCount: number | null; viewCount: number | null; channelPublishedAt: string | null; observedAt: Date }
  ): Promise<void>;
  setMarketDiscoveryCandidateStatus(channelId: string, status: DiscoveryCandidateStatus): Promise<void>;
  insertMarketDiscoveryRun(input: {
    query: string;
    status: "success" | "failed";
    unitsSpent: number;
    candidatesFound?: number | null;
    candidatesNew?: number | null;
    errorMessage?: string | null;
    ranAt?: Date;
  }): Promise<void>;
  // Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- topic model, part A.
  listMarketTopics(): Promise<StoredMarketTopicForService[]>;
  getMarketTopicById(topicId: string): Promise<StoredMarketTopicForService | null>;
  insertMarketTopic(input: { id: string; name: string; createdVia: string }): Promise<void>;
  deleteMarketTopic(topicId: string): Promise<void>;
  listAssignmentsForTopic(topicId: string): Promise<StoredMarketTopicAssignmentForService[]>;
  listTopicsForSubject(
    subjectType: TopicAssignmentSubjectType,
    subjectId: string
  ): Promise<StoredMarketTopicAssignmentForService[]>;
  // Phase 9 slice 9H part C -- bulk read across every subject of one type, for
  // getMarketVideosOverview's own aggregation (never one call per video).
  listMarketTopicAssignmentsBySubjectType(
    subjectType: TopicAssignmentSubjectType
  ): Promise<StoredMarketTopicAssignmentForService[]>;
  getTopicAssignment(
    topicId: string,
    subjectType: TopicAssignmentSubjectType,
    subjectId: string
  ): Promise<StoredMarketTopicAssignmentForService | null>;
  insertMarketTopicAssignment(input: {
    id: string;
    topicId: string;
    subjectType: TopicAssignmentSubjectType;
    subjectId: string;
    source: "manual" | "ai_assisted";
    createdVia: string;
  }): Promise<void>;
  deleteMarketTopicAssignment(assignmentId: string): Promise<void>;
  // Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- trend candidates, part B.
  // `insertMarketTrendCandidateWithInitialEvidence`/`updateMarketTrendCandidateStatusWithEvidence` are the
  // atomic (single-transaction) forms -- see their own doc comments in db.ts for why a
  // two-separate-writes shape was found unsafe by independent review (closes RISK-70 and its
  // status-change sibling).
  listMarketTrendCandidates(): Promise<StoredMarketTrendCandidateForService[]>;
  getMarketTrendCandidateById(trendCandidateId: string): Promise<StoredMarketTrendCandidateForService | null>;
  insertMarketTrendCandidateWithInitialEvidence(
    candidate: {
      id: string;
      title: string;
      description?: string | null;
      topicId?: string | null;
      createdVia: string;
      at?: Date;
    },
    initialEvidence: {
      id: string;
      evidenceType: TrendEvidenceType;
      referenceId?: string | null;
      description: string;
      createdVia: string;
    }
  ): Promise<void>;
  updateMarketTrendCandidateStatusWithEvidence(
    trendCandidateId: string,
    status: TrendCandidateStatus,
    at: Date,
    evidence: { id: string; description: string; createdVia: string }
  ): Promise<void>;
  touchMarketTrendCandidateLastObservedAt(trendCandidateId: string, at: Date): Promise<void>;
  listTrendEvidence(trendCandidateId: string): Promise<StoredMarketTrendEvidenceForService[]>;
  insertMarketTrendEvidence(input: {
    id: string;
    trendCandidateId: string;
    evidenceType: TrendEvidenceType;
    referenceId?: string | null;
    description: string;
    createdVia: string;
  }): Promise<void>;
  // Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md).
  insertMarketResearchRequest(input: {
    id: string;
    query: string;
    rationale: string;
    monitorDurationDays?: number | null;
    createdVia: string;
    agentApiVersion?: string | null;
    at?: Date;
  }): Promise<void>;
  getMarketResearchRequestById(id: string): Promise<StoredMarketResearchRequestForService | null>;
  listMarketResearchRequests(): Promise<StoredMarketResearchRequestForService[]>;
  approveMarketResearchRequestIfPending(id: string, at: Date): Promise<StoredMarketResearchRequestForService | null>;
  rejectMarketResearchRequestIfPending(
    id: string,
    reason: string,
    at: Date
  ): Promise<StoredMarketResearchRequestForService | null>;
  recordMarketResearchRequestExecutionOutcome(
    id: string,
    outcome:
      | { status: "executed"; candidatesFound: number; candidatesNew: number }
      | { status: "execution_failed"; executionError: string }
  ): Promise<StoredMarketResearchRequestForService | null>;
  // Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md).
  insertMarketCollectionRequest(input: {
    id: string;
    channelIdsJson: string;
    reason: string;
    estimateJson: string;
    createdVia: string;
    agentApiVersion?: string | null;
    at?: Date;
  }): Promise<void>;
  getMarketCollectionRequestById(id: string): Promise<StoredMarketCollectionRequestForService | null>;
  listMarketCollectionRequests(): Promise<StoredMarketCollectionRequestForService[]>;
  findOpenMarketCollectionRequestForChannel(channelId: string): Promise<StoredMarketCollectionRequestForService | null>;
  approveMarketCollectionRequestIfPending(
    id: string,
    approvedByUserId: string | null,
    at: Date
  ): Promise<StoredMarketCollectionRequestForService | null>;
  startMarketCollectionRequestIfApproved(id: string): Promise<StoredMarketCollectionRequestForService | null>;
  rejectMarketCollectionRequestIfPending(
    id: string,
    reason: string,
    at: Date
  ): Promise<StoredMarketCollectionRequestForService | null>;
  finishMarketCollectionRequestIfRunning(
    id: string,
    outcome:
      | { status: "done"; resultJson: string; unitsSpentTotal: number }
      | { status: "failed"; resultJson: string | null; unitsSpentTotal: number; error: string },
    at: Date
  ): Promise<StoredMarketCollectionRequestForService | null>;
  failInterruptedMarketCollectionRequests(approvedBefore: Date, at: Date): Promise<number>;
};

// Phase 9 slice 9H, part A (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md §2) -- named,
// caller-chosen constants for `getChannelIntelligenceSummary`. 9A's `computeSnapshotVelocity` and
// 9D's `computeAgeNormalizedViews`/`computeChannelVideoBaseline` deliberately leave these choices to
// the caller (owner spec §10: "the caller decides what counts as 'recent'") -- exported and shown in
// the UI next to their own figure, never used only internally, since an unstated methodology is
// exactly the "opaque score" spec §11 forbids for breakout detection.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const CHANNEL_VELOCITY_WINDOW_DAYS = 7;
export const CHANNEL_BASELINE_DAY_OFFSET = 7;
// 180, not a narrower window, specifically so a monthly-or-slower uploader still has a real chance
// at the 4 qualifying videos leave-one-out needs (see the plan's own §2 for the full reasoning,
// including the real limit this constant does NOT remove: a video's own day-7 point only exists if
// a collection run happened to land within ~1.75 days of it, and collection only ever runs from a
// dashboard page load).
export const RECENT_VIDEO_WINDOW_DAYS = 180;
// A trend's own `lastObservedAt` only moves when evidence is added (manually, or by a future
// structural detector) -- a human timescale, unlike 9I's `MARKET_INTELLIGENCE_STALE_WINDOW_MS` (24h,
// a collection-cadence concept this deliberately does NOT reuse -- see the plan's own §6 for why
// reusing it, and the word "stale" itself, was wrong: "stale" already names one of
// `TrendCandidateStatus`'s five lifecycle values, so a "growing" trend showing a "stale" freshness
// badge would visibly contradict itself). A named, adjustable starting point, not a claimed-correct
// number, exactly like `BREAKOUT_RATIO_THRESHOLD`'s own precedent.
export const TREND_EVIDENCE_FRESH_WINDOW_DAYS = 30;

/**
 * Phase 9 slice 9H part C -- extracted, verbatim in logic, from `getChannelIntelligenceSummary`'s
 * own original inline block (9H part A), so `getMarketVideosOverview` can reuse the identical
 * age-normalized, leave-one-out breakout methodology per video without a second, drifting copy of
 * it. Returns a verdict only for a video whose `publishedAt` is known AND within
 * `RECENT_VIDEO_WINDOW_DAYS` of `now` -- absent from the returned map for every other video (too
 * old, or no publish date on record at all), never a fabricated non-breakout entry for those.
 */
// ---------------------------------------------------------------------------
// Phase 13 slice 13.3 (docs/roadmap/plans/PHASE_13_PLAN.md, owner decision D1 = a, msg 1129): YouTube
// API Developer Policies III.E.4.h -- API Clients "must not ... access or use API Data to create new or
// derived data or metrics". Every watchlist channel is someone else's channel (Non-Authorized Data), so
// velocity, breakout and emerging-channel assessments built from their snapshots are WITHHELD: the
// fields stay in the response shape (agent contract), but carry no computed value and say why. The
// raw observations themselves (each with its time, III.E.4.f) are still returned, for at most 30 days
// (13.2). The pure functions in derived-metrics.ts/historical-intelligence.ts are kept for our own
// channels' (Authorized) data.
// ---------------------------------------------------------------------------
export const DERIVED_METRICS_POLICY_REASON =
  "Not computed: YouTube API Developer Policies III.E.4.h prohibit metrics derived from other channels' API data.";

const WITHHELD_FIELD_VELOCITY: FieldVelocity = { value: null, basis: "withheld_by_policy" };

function withheldEmergingChannel(researchChannelId: string): EmergingChannelAssessment {
  return {
    researchChannelId,
    recentBreakoutVideoCount: 0,
    subscriberVelocityPerDay: null,
    isEmerging: false,
    reasons: [DERIVED_METRICS_POLICY_REASON],
  };
}


// Phase 9 slice 9B -- real YouTube Data API v3 quota costs (`channels.list`/`playlistItems.list`/
// `videos.list` are each a flat 1 unit regardless of requested parts, per the API's own published
// quota table). Operator request 2026-10-04: one `channels.list`, then one `playlistItems.list` PER PAGE
// (`listUploadsPlaylistPage`, <= 50 items, exactly 1 unit each) and at most one `videos.list` fallback per
// page (stats are fetched page by page, never pooled across pages, so each batch stays <= 50 ids). The
// minimum a channel needs to start is still the 3-call worst case of ONE page.
const CHANNELS_LIST_UNIT_COST = 1;
const PLAYLIST_ITEMS_LIST_UNIT_COST = 1;
// This flat charge is only correct because `getPublicVideoSnapshots` is fed at most
// `YOUTUBE_VIDEOS_LIST_BATCH_SIZE` (50) ids -- itself only true because
// `listUploadsPlaylistPage` (the sole source of the ids passed here) caps its own
// page to that same limit and the loop below fetches stats once per page. If either constant ever changes independently of the
// other, this flat 1-unit charge would silently under-count a real `videos.list` call that had to
// batch into 2+ requests (found by independent review -- not currently reachable, since both call
// sites are fixed in this file, but the coupling itself is otherwise undocumented).
const VIDEOS_LIST_UNIT_COST = 1;
// A channel is only ever started once `remaining` can cover ALL 3 possible calls (found by
// independent review: an earlier version checked budget per-call instead, which let a channel that
// got cut short mid-way still be recorded "success" and marked collected -- directly contradicting
// this slice's own plan §2/§4 ("a channel skipped because the budget ran out must remain stale,"
// "records this channel's row as skipped_quota_limited"). Pre-committing the full worst case makes
// "attempted" and "fully processed" the same thing for every channel this run touches -- never a
// partial channel.
const PER_CHANNEL_WORST_CASE_UNIT_COST = CHANNELS_LIST_UNIT_COST + PLAYLIST_ITEMS_LIST_UNIT_COST + VIDEOS_LIST_UNIT_COST;

// Phase 13 slice 13.4: `search.list` now costs 1 unit of its OWN bucket (100 calls per quota day),
// not 100 units of the shared pool (official quota page, revision history 2026-06-01).

// A channel is stale after 24h with no successful collection -- deliberately a plain elapsed-time
// check, not Phase 8's own local-wall-clock-boundary rule (`AGENTS.md` §M: no cross-feature-module
// import of `analytics/staleness.ts` for a requirement this feature does not actually share).
// `MARKET_INTELLIGENCE_STALE_WINDOW_MS` itself now lives in `./contracts` (9I) so `data-quality.ts`
// can share the exact same threshold without importing this file.
// A claim older than this is treated as an abandoned (crashed) attempt and may be reclaimed --
// generous relative to a single channel's real work (a deep backfill is bounded by the daily budget,
// at most a few dozen sequential calls -- minutes, not the 15 allowed here).
const MARKET_INTELLIGENCE_CLAIM_EXPIRY_MS = 15 * 60 * 1000;

// Phase 13 slice 13.4: the YouTube quota day starts at midnight PACIFIC time, not UTC.
const startOfQuotaDay = startOfYoutubeQuotaDay;

/**
 * The upfront, zero-cost preconditions a real `search.list` call needs -- extracted so
 * `approveMarketResearchRequest` (Phase 9 slice 9G, part B) can run the SAME checks BEFORE its own
 * atomic `pending -> approved` transition, never duplicated inline. Found necessary by advisor
 * review, before implementation: without this, an approval whose search cannot run (no searches left
 * today, reads switched off) would fail AFTER the transition already happened, permanently landing the
 * request in `execution_failed` with no path back to `pending`. Throwing here, before any state
 * changes, leaves the caller's own state untouched on a precondition failure.
 */
async function assertDiscoveryPreconditions(deps: ServiceDependencies, now: Date): Promise<void> {
  // BL-145 (P2, owner 2026-10-07): a search no longer needs the daily UNIT budget to be set -- it never spends that
  // budget (searches have their own bucket of SEARCH_LIST_DAILY_CALL_LIMIT), and "automatic collection is off" must not
  // silently block a manual search. The search cap and the reads toggle below still apply.
  const searchesToday = await deps.countMarketDiscoverySearchesSince(startOfQuotaDay(now));
  const remaining = SEARCH_LIST_DAILY_CALL_LIMIT - searchesToday;
  if (remaining < 1) {
    throw new DomainError({
      code: "MARKET_INTELLIGENCE_QUOTA_EXCEEDED",
      message: `YouTube allows ${SEARCH_LIST_DAILY_CALL_LIMIT} searches per day; all are used. The limit resets at midnight Pacific time.`,
      details: { remaining: 0, required: 1 },
    });
  }

  // A disabled "Data API reads" toggle is a purely local, no-network condition -- checked
  // upfront, before spending any budget, so it can never be mischarged as a real, failed call.
  await deps.youtubeApi.assertReadsAvailable();
}

export const MUSIC_CHART_CACHE_MS = 30 * 60 * 1000;

/**
 * The data-quality flags that make a watchlist channel a collection warning (plan 9H part B §3a). `hidden_subscriber_count`
 * is a channel property, not a collection problem, so it is not one of them.
 */
export const COLLECTION_WARNING_FLAGS: ReadonlySet<DataQualityFlag> = new Set<DataQualityFlag>([
  "stale_observation",
  "quota_limited",
  "missing_snapshot",
  "feed_fallback_used",
]);

export type CollectionStatus = "current" | "attention" | "failed" | "never_collected";

/**
 * BL-140: one rule for "does this channel need attention", shared by getMarketOverview's collection warnings (the
 * summary line's count) and getWatchlistTable's status (the Channels filter that count links to), so the two can never
 * disagree. Anything but "current" is a warning.
 */
export function classifyCollectionStatus(input: {
  neverObserved: boolean;
  latestRunStatus: "success" | "skipped_quota_limited" | "failed" | null;
  dataQualityFlags: readonly DataQualityFlag[];
}): CollectionStatus {
  if (input.neverObserved) return "never_collected";
  if (input.latestRunStatus === "failed") return "failed";
  return input.dataQualityFlags.some((flag) => COLLECTION_WARNING_FLAGS.has(flag)) ? "attention" : "current";
}

export function createMarketIntelligenceServices(deps: ServiceDependencies) {
  // Per services instance (one per process in production); current-only, never persisted (13.9).
  const musicChartCache = new Map<string, { fetchedAt: Date; entries: MusicChartEntry[] }>();

  /**
   * The one collection pass: `runCollectionIfStale` (every stale channel, the automatic refresh) and `runApprovedCollectionRequest` (only
   * the channels of an approved request, `onlyIds`) both run THIS function -- same budget gate, same stale window, same failed-channel
   * pause, same claim/charge/ledger rules, no force and no bypass. Besides the summary it reports each channel's outcome; channels it
   * did not process are reported as skipped (not stale / failed within the pause / budget) so a caller never has to guess.
   */
  async function collectStaleChannels(
    parsedInput: { credentialRef: CredentialRef },
    onlyIds?: string[],
    sink: CollectionRunSink = { channels: [], unitsSpent: 0, claimed: [] }
  ): Promise<CollectionPassResult> {
    try {
      return await collectStaleChannelsInner(parsedInput, onlyIds, sink);
    } catch (error) {
      // A throw mid-run must not leave this run's remaining channels claimed until the claim expires.
      for (const id of sink.claimed) {
        try {
          await deps.releaseResearchChannelCollectionClaim(id);
        } catch {
          // Best effort; the claim expiry is the fallback.
        }
      }
      throw error;
    }
  }

  async function collectStaleChannelsInner(
    parsedInput: { credentialRef: CredentialRef },
    onlyIds: string[] | undefined,
    sink: CollectionRunSink
  ): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    quotaLimited: number;
    unitsSpent: number;
    channels: CollectionChannelResult[];
  }> {
    const zeroed = { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 };
    const results: CollectionChannelResult[] = sink.channels;
    let recentlyFailedIds: string[] = [];
    // Channels of the request this pass did not process get the reason they were passed over; a processed channel keeps its own result.
    const finish = (
      fallback: CollectionChannelOutcome,
      claimedButSkippedForBudget: string[] = [],
      summary: typeof zeroed = zeroed
    ) => {
      const done = new Map(results.map((r) => [r.channelId, r]));
      for (const id of claimedButSkippedForBudget) {
        if (!done.has(id)) {
          done.set(id, { channelId: id, outcome: "skipped_quota_limited", videosStored: 0, newSnapshotsObservedAt: null, unitsSpent: 0 });
        }
      }
      for (const id of onlyIds ?? []) {
        if (done.has(id)) continue;
        const outcome: CollectionChannelOutcome =
          fallback === "skipped_quota_limited" ? fallback : recentlyFailedIds.includes(id) ? "skipped_recent_failure" : fallback;
        done.set(id, { channelId: id, outcome, videosStored: 0, newSnapshotsObservedAt: null, unitsSpent: 0 });
      }
      const ordered = onlyIds ? onlyIds.map((id) => done.get(id)).filter((r): r is CollectionChannelResult => r !== undefined) : [...done.values()];
      return { ...summary, channels: ordered };
    };
    const latestChannelObservationIso = async (researchChannelId: string): Promise<string | null> => {
      try {
        const snapshots = await deps.listMarketChannelSnapshotsByChannel(researchChannelId);
        if (snapshots.length === 0) return null;
        return new Date(Math.max(...snapshots.map((row) => row.observedAt.getTime()))).toISOString();
      } catch {
        return null;
      }
    };

    const budget = await deps.getMarketIntelligenceDailyQuotaBudgetUnits();
    if (budget === null) {
      return finish("skipped_quota_limited");
    }

    const now = deps.clock.now();
    const spentToday = await deps.getMarketIntelligenceUnitsSpentSince(startOfQuotaDay(now));
    let remaining = budget - spentToday;
    if (remaining <= 0) {
      return finish("skipped_quota_limited");
    }

    // A disabled "Data API reads" toggle is a purely local, no-network condition -- checked
    // upfront, before any channel is claimed or any budget spent, so it can never be mischarged
    // as if it were a real, failed call (found by independent review: the per-call catch blocks
    // below charge the call's own cost unconditionally, which is correct for a genuine network
    // failure but wrong for a precondition that never reached YouTube at all).
    await deps.youtubeApi.assertReadsAvailable();

    // Credentials must resolve BEFORE any channel is claimed -- a scope/credential failure must
    // never leave a channel claimed with nothing actually attempted (advisor review).
    const credentials = await deps.authResolver.resolve({
      credentialRef: parsedInput.credentialRef,
      requiredScopes: [YOUTUBE_READ_SCOPE],
    });

    const staleCutoff = new Date(now.getTime() - MARKET_INTELLIGENCE_STALE_WINDOW_MS);
    const claimExpiryCutoff = new Date(now.getTime() - MARKET_INTELLIGENCE_CLAIM_EXPIRY_MS);
    recentlyFailedIds = await deps.listRecentlyFailedResearchChannelIds(staleCutoff);
    const claimedIds = await deps.claimStaleResearchChannelsForCollection({
      now,
      staleCutoff,
      claimExpiryCutoff,
      excludeResearchChannelIds: recentlyFailedIds,
      ...(onlyIds ? { onlyResearchChannelIds: onlyIds } : {}),
    });

    sink.claimed = [...claimedIds];
    if (claimedIds.length === 0) {
      return finish("skipped_not_stale");
    }

    // Recomputed AFTER the claim, from the ledger's own current state -- narrows (does not fully
    // eliminate -- see this function's own top-level doc comment) the race window a second
    // concurrent caller's own stale pre-claim `spentToday` read would otherwise leave open
    // (advisor review, before implementation).
    const spentAfterClaim = await deps.getMarketIntelligenceUnitsSpentSince(startOfQuotaDay(now));
    remaining = budget - spentAfterClaim;
    if (remaining <= 0) {
      for (const claimedId of claimedIds) {
        await deps.releaseResearchChannelCollectionClaim(claimedId);
      }
      return finish("skipped_not_stale", claimedIds);
    }

    const depthDefaults = await deps.getMarketIntelligenceCollectionDepthDefaults();
    let attempted = 0;
    let succeeded = 0;
    let failedCount = 0;
    let quotaLimited = 0;
    let unitsSpentTotal = 0;

    // The value this run last wrote into every still-unprocessed channel's claim (see the renewal below).
    let claimToken = now;

    for (let i = 0; i < claimedIds.length; i++) {
      const researchChannelId = claimedIds[i];

      // A long run (e.g. an approved request) can outlive the claim expiry; renew the claim of every channel not yet processed before
      // each channel, so a dashboard run cannot reclaim them mid-run. Only claims this run still holds are renewed; a channel whose
      // claim was lost is not processed (it belongs to someone else now).
      const nextToken = deps.clock.now();
      const renewed = await deps.renewResearchChannelCollectionClaims(claimedIds.slice(i), claimToken, nextToken);
      claimToken = nextToken;
      if (!renewed.includes(researchChannelId)) {
        sink.claimed = sink.claimed.filter((id) => id !== researchChannelId);
        results.push({ channelId: researchChannelId, outcome: "skipped_not_stale", videosStored: 0, newSnapshotsObservedAt: null, unitsSpent: 0 });
        continue;
      }

      // Checked against the full worst-case cost, not just the next call's cost -- a channel is
      // either fully processed or not started at all this run, never cut short partway (see
      // PER_CHANNEL_WORST_CASE_UNIT_COST's own doc comment).
      if (remaining < PER_CHANNEL_WORST_CASE_UNIT_COST) {
        // Every remaining claimed channel (not just this one) is recorded and released here, not
        // silently dropped -- found by independent review: releasing j>i's claims with no row and
        // no counter meant getWatchlistEntryContext's data-quality flag and getMarketOverview's
        // collectionWarnings both under-reported how many channels this cycle actually affected
        // (e.g. 1 warning shown instead of 7 for a 10-channel claim that ran out of budget at #4).
        for (let j = i; j < claimedIds.length; j++) {
          attempted += 1;
          quotaLimited += 1;
          await deps.insertMarketIntelligenceCollectionRun({
            researchChannelId: claimedIds[j],
            status: "skipped_quota_limited",
            unitsSpent: 0,
            ranAt: now,
          });
          await deps.releaseResearchChannelCollectionClaim(claimedIds[j]);
          results.push({ channelId: claimedIds[j], outcome: "skipped_quota_limited", videosStored: 0, newSnapshotsObservedAt: null, unitsSpent: 0 });
        }
        break;
      }

      attempted += 1;
      let unitsSpentThisChannel = 0;
      let videosRequested: number | null = null;
      let videosReturned: number | null = null;
      // True once the ~15-video RSS feed (not the uploads playlist) supplied this run's videos.
      let feedFallback = false;
      // Guards the catch block below against writing a SECOND collection-run row for the same
      // attempt (found by independent review: without this, a throw from
      // markResearchChannelAutoCollected -- AFTER the success row already landed -- fell into the
      // catch, which wrote a second "failed" row with the identical unitsSpent, double-counting
      // real spend in the quota ledger AND wrongly putting a channel that actually succeeded into
      // the 24h failure-retry backoff).
      let successRowWritten = false;
      let channelOutcome: CollectionChannelOutcome = "failed";
      // What to persist about the channel's deep-collection progress AFTER the success row (null = leave it untouched: an
      // incremental run, or the RSS fallback).
      let finalProgress: { complete: boolean; completeReason: CollectionCompleteReason | null; nextPageToken: string | null } | null = null;

      try {
        const channelRow = await deps.getResearchChannelById(researchChannelId);
        const depth = resolveCollectionDepth(channelRow ?? {}, depthDefaults);
        const cap = depth.maxVideosPerChannel;
        const afterMs = depth.publishedAfter === null ? null : Date.parse(`${depth.publishedAfter}T00:00:00Z`);
        // Backfill = walk deeper (first collection, unfinished, cap raised, date moved earlier); otherwise incremental = refresh
        // the newest page and read further only while pages still hold videos we have not stored.
        const storedAtStart = new Set((await deps.listMarketVideoSnapshotsByChannel(researchChannelId)).map((row) => row.videoId)).size;
        const backfill = channelRow ? needsBackfill(channelRow, depth, storedAtStart) : true;
        let resumeToken = backfill && channelRow?.videosComplete === 0 ? (channelRow.videosNextPageToken ?? null) : null;

        // Charged BEFORE the call resolves, not after -- YouTube's own quota accounting charges
        // a failed/invalid request too (its public quota docs), so a thrown error below must
        // never erase this channel's real spend down to a fabricated 0 (found by advisor review).
        unitsSpentThisChannel += CHANNELS_LIST_UNIT_COST;
        remaining -= CHANNELS_LIST_UNIT_COST;
        const snapshot = await deps.youtubeApi.getPublicChannelSnapshot({ credentials, channelId: researchChannelId });

        if (!snapshot) {
          throw new Error("YouTube reports no public channel for this id");
        }

        await deps.insertMarketChannelSnapshot({
          id: deps.idGenerator(),
          researchChannelId,
          subscriberCount: snapshot.subscriberCount,
          viewCount: snapshot.viewCount,
          videoCount: snapshot.videoCount,
          hiddenSubscriberCount: snapshot.hiddenSubscriberCount,
          source: "youtube.channels.list",
          createdVia: "web_ui",
        });

        // Phase 13 slices 13.5/13.6, as revised by review round 1: the uploads list (ids, titles,
        // publish times) comes from the uploads playlist -- 1 pool unit per page, up to 50 videos each;
        // the RSS feed (newest ~15, no quota) is its FALLBACK, so collection still finds uploads when
        // that call fails (e.g. the pool is exhausted). Statistics come from videos.batchGetStats (its
        // own bucket) with videos.list (1 pool unit) as the fallback, once per page.
        type ListedVideo = { videoId: string; title: string; publishedAt: string | null };
        type ListedPage = { items: ListedVideo[]; nextPageToken: string | null };
        let firstPage: ListedPage | null = null;
        let playlistError: unknown = null;
        if (snapshot.uploadsPlaylistId) {
          unitsSpentThisChannel += PLAYLIST_ITEMS_LIST_UNIT_COST;
          remaining -= PLAYLIST_ITEMS_LIST_UNIT_COST;
          try {
            firstPage = await deps.youtubeApi.listUploadsPlaylistPage({ credentials, uploadsPlaylistId: snapshot.uploadsPlaylistId });
          } catch (error) {
            playlistError = error;
          }
        }
        if (firstPage === null) {
          try {
            firstPage = { items: await deps.youtubeApi.listChannelFeedVideoIds({ channelId: researchChannelId }), nextPageToken: null };
            feedFallback = true;
          } catch (feedError) {
            // Review round 2: fail closed. When the playlist call failed and the RSS fallback failed
            // too, this channel's collection FAILED (recorded as such, retried on the failure
            // backoff) -- never a "success" with no video data. Without an uploads playlist at all,
            // the feed is the only source, so its failure is the failure.
            throw playlistError ?? feedError;
          }
        }

        const knownIds = new Set((await deps.listMarketVideoSnapshotsByChannel(researchChannelId)).map((row) => row.videoId));
        const knownAtStart = knownIds.size;
        const maxPages = pagesForCap(cap) + pagesForCap(knownAtStart) + 2;
        // A cursor on a playlist that now ends at page 1 is moot.
        if (firstPage.nextPageToken === null) resumeToken = null;
        const firstPageNext = firstPage.nextPageToken;

        videosRequested = 0;
        videosReturned = 0;

        // Processes one listed page completely (or throws): date filter, which items get statistics, the stats call(s), the inserts.
        // Returns what the stop rules need.
        const processPage = async (
          page: ListedPage,
          isFirstPage: boolean
        ): Promise<{ newOnPage: number; dateReached: boolean }> => {
          const considered = isFirstPage ? page.items.slice(0, cap) : page.items;
          const kept: ListedVideo[] = [];
          let dateReached = false;
          for (const item of considered) {
            if (afterMs !== null && item.publishedAt && Date.parse(item.publishedAt) < afterMs) {
              dateReached = true;
              break;
            }
            kept.push(item);
          }
          const newOnPage = kept.filter((item) => !knownIds.has(item.videoId)).length;

          // The first page is always refreshed in full (as before this feature); a deeper page only gets statistics for videos not
          // stored yet (a restart that walks already-stored pages must not re-snapshot them). Only a backfill stops at the cap.
          let toSnapshot: ListedVideo[];
          if (isFirstPage) {
            toSnapshot = kept;
          } else {
            toSnapshot = [];
            let count = knownIds.size;
            for (const item of kept) {
              if (knownIds.has(item.videoId)) continue;
              if (backfill && count >= cap) break;
              toSnapshot.push(item);
              count += 1;
            }
          }

          const metaById = new Map(toSnapshot.map((v) => [v.videoId, { title: v.title, publishedAt: v.publishedAt }]));
          const videoIds = toSnapshot.map((v) => v.videoId);
          videosRequested = (videosRequested ?? 0) + videoIds.length;
          if (videoIds.length > 0) {
            let videoSnapshots: PublicVideoSnapshot[];
            let statsSource = "youtube.videos.batchGetStats";
            try {
              videoSnapshots = await deps.youtubeApi.getPublicVideoStatsBatch({ credentials, videoIds });
            } catch {
              statsSource = "youtube.videos.list";
              unitsSpentThisChannel += VIDEOS_LIST_UNIT_COST;
              remaining -= VIDEOS_LIST_UNIT_COST;
              videoSnapshots = await deps.youtubeApi.getPublicVideoSnapshots({ credentials, videoIds });
            }

            // Counts only what was ACTUALLY persisted, not the raw API response length (found by
            // independent review: the previous version set videosReturned from the response
            // length before this loop ran, so a mid-loop insert failure left the audit row
            // overstating what genuinely landed in market_video_snapshots). videosReturned stays
            // accurate even if a later iteration throws, since it only counts completed inserts.
            for (const videoSnapshot of videoSnapshots) {
              const meta = metaById.get(videoSnapshot.videoId);
              const title = videoSnapshot.title.length > 0 ? videoSnapshot.title : (meta?.title ?? "");
              const publishedAt = videoSnapshot.publishedAt ?? meta?.publishedAt ?? null;
              await deps.insertMarketVideoSnapshot({
                id: deps.idGenerator(),
                researchChannelId,
                videoId: videoSnapshot.videoId,
                viewCount: videoSnapshot.viewCount,
                likeCount: videoSnapshot.likeCount,
                commentCount: videoSnapshot.commentCount,
                publishedAt: publishedAt ? new Date(publishedAt) : null,
                // Phase 9 slice 9H part C -- costs zero additional quota. Normalized to null (never
                // "") so a genuinely uncaptured title is never stored as a "known, empty" one.
                title: title.length > 0 ? title : null,
                // Operator request 2026-10-04: raw values only, null when the fetch did not return them (never 0).
                durationSeconds: videoSnapshot.durationSeconds ?? null,
                liveBroadcastContent: videoSnapshot.liveBroadcastContent ?? null,
                source: statsSource,
                createdVia: "web_ui",
              });
              knownIds.add(videoSnapshot.videoId);
              videosReturned = (videosReturned ?? 0) + 1;
            }
          }
          return { newOnPage, dateReached };
        };

        let current: ListedPage = firstPage;
        let isFirstPage = true;
        // Where the next unread page starts (a backfill resumes there); the cursor is kept while page 1 is only being refreshed.
        let pendingToken: string | null = resumeToken ?? firstPageNext;
        let jumpingFromCursor = resumeToken !== null;
        let pagesFetched = 1;

        for (;;) {
          const { newOnPage, dateReached } = await processPage(current, isFirstPage);
          isFirstPage = false;
          // The RSS fallback is a single page by construction: nothing to page and no state to remember.
          if (feedFallback) break;

          const reachedCap = knownIds.size >= cap;
          if (backfill) {
            // Stop rules, in this order: the cap, the date, the end of the playlist.
            if (reachedCap) {
              finalProgress = { complete: true, completeReason: "cap", nextPageToken: null };
              break;
            }
            if (dateReached) {
              finalProgress = { complete: true, completeReason: "date", nextPageToken: null };
              break;
            }
            if (pendingToken === null) {
              finalProgress = { complete: true, completeReason: "exhausted", nextPageToken: null };
              break;
            }
            // Progress survives a crash/failure on a later page: the cursor is saved once this page is fully stored.
            await deps.saveResearchChannelCollectionProgress(researchChannelId, {
              complete: false,
              completeReason: null,
              nextPageToken: pendingToken,
              capAtRun: cap,
              publishedAfterAtRun: depth.publishedAfter,
            });
          } else if (reachedCap || dateReached || pendingToken === null || newOnPage === 0) {
            // Incremental: the cap, the date, the end, or a page with nothing new ends it; its state is left as it was.
            break;
          }

          // One more page needs a `playlistItems.list` unit plus a possible `videos.list` fallback unit, and must leave the
          // 3-unit minimum for every channel still waiting in this run (a deep backfill must not starve the others).
          const channelsAfterThis = claimedIds.length - i - 1;
          const canAffordAnotherPage =
            pagesFetched < maxPages &&
            remaining - (PLAYLIST_ITEMS_LIST_UNIT_COST + VIDEOS_LIST_UNIT_COST) >= PER_CHANNEL_WORST_CASE_UNIT_COST * channelsAfterThis;
          if (!canAffordAnotherPage) {
            if (backfill) finalProgress = { complete: false, completeReason: null, nextPageToken: pendingToken };
            break;
          }

          unitsSpentThisChannel += PLAYLIST_ITEMS_LIST_UNIT_COST;
          remaining -= PLAYLIST_ITEMS_LIST_UNIT_COST;
          pagesFetched += 1;
          let next: ListedPage;
          try {
            next = await deps.youtubeApi.listUploadsPlaylistPage({
              credentials,
              uploadsPlaylistId: snapshot.uploadsPlaylistId as string,
              pageToken: pendingToken,
            });
          } catch (error) {
            if (!jumpingFromCursor) throw error;
            // The saved cursor was rejected (expired/invalid): continue from where page 1 leaves off instead, walking pages we
            // already stored (they get no new snapshots) until the unstored part begins. The failed call's unit is already charged.
            jumpingFromCursor = false;
            pendingToken = firstPageNext;
            if (pendingToken === null) {
              finalProgress = { complete: true, completeReason: "exhausted", nextPageToken: null };
              break;
            }
            // An empty stand-in page: nothing to process; the loop saves the new cursor and fetches from pendingToken.
            current = { items: [], nextPageToken: pendingToken };
            continue;
          }
          jumpingFromCursor = false;
          current = next;
          pendingToken = next.nextPageToken;
        }

        // The audit row is written BEFORE the mark, not after (found by independent review): if
        // this insert itself throws, the catch below correctly records "failed" and
        // last_auto_collected_at is never touched. The reverse order left a window where
        // markResearchChannelAutoCollected could succeed and this insert then fail -- the channel
        // would end up marked fresh (skipped for 24h) while its own audit trail said "failed",
        // directly contradicting this module's own "marked ONLY on full success" invariant. This
        // is not a full transaction (neither write shares one), so the MARK itself can still throw
        // AFTER this insert succeeds -- guarded by `successRowWritten` above, so that specific
        // case is treated as the real success it is (no second, double-counting audit row), with
        // the channel simply staying stale for a free retry next run, rather than being
        // misrecorded as a failure it never actually was.
        await deps.insertMarketIntelligenceCollectionRun({
          researchChannelId,
          status: "success",
          unitsSpent: unitsSpentThisChannel,
          videosRequested,
          videosReturned,
          feedFallback,
          ranAt: now,
        });
        successRowWritten = true;
        // The deep-collection state goes after the success row and before the mark: a throw here is still covered by
        // `successRowWritten` (the run is recorded as the success it was; the state is simply written again by the next run).
        if (finalProgress !== null) {
          await deps.saveResearchChannelCollectionProgress(researchChannelId, {
            ...finalProgress,
            capAtRun: cap,
            publishedAfterAtRun: depth.publishedAfter,
          });
        }
        await deps.markResearchChannelAutoCollected(researchChannelId, now);
        succeeded += 1;
        channelOutcome = finalProgress !== null && !finalProgress.complete ? "partial_budget" : "completed";
      } catch (error) {
        // If the success row already landed, this catch exists only because the MARK itself
        // threw afterward -- the attempt genuinely succeeded and already has its own audit row,
        // so a second "failed" row here would double-count unitsSpent in the ledger and wrongly
        // trigger the 24h failure backoff for a channel that didn't actually fail. The channel
        // simply stays stale (the mark never landed) and is retried, at no extra ledger cost, on
        // the next run.
        if (!successRowWritten) {
          await deps.insertMarketIntelligenceCollectionRun({
            researchChannelId,
            status: "failed",
            unitsSpent: unitsSpentThisChannel,
            // Preserves whatever was actually known before the failure (e.g. enumeration
            // finished but the stats fetch itself threw) instead of discarding it back to null
            // (found by advisor review).
            videosRequested,
            videosReturned,
            feedFallback,
            errorMessage: error instanceof Error ? error.message : String(error),
            ranAt: now,
          });
          failedCount += 1;
        } else {
          succeeded += 1;
          channelOutcome = finalProgress !== null && !finalProgress.complete ? "partial_budget" : "completed";
        }
      } finally {
        await deps.releaseResearchChannelCollectionClaim(researchChannelId);
        unitsSpentTotal += unitsSpentThisChannel;
        sink.unitsSpent = unitsSpentTotal;
        results.push({
          channelId: researchChannelId,
          outcome: channelOutcome,
          videosStored: channelOutcome === "failed" ? 0 : (videosReturned ?? 0),
          newSnapshotsObservedAt: channelOutcome === "failed" ? null : await latestChannelObservationIso(researchChannelId),
          unitsSpent: unitsSpentThisChannel,
        });
      }
    }

    return finish("skipped_not_stale", [], { attempted, succeeded, failed: failedCount, quotaLimited, unitsSpent: unitsSpentTotal });
  }

  // Captured in a local `const` (rather than returned directly) so `approveMarketResearchRequest`
  // (Phase 9 slice 9G, part B) can call `services.discoverChannels(...)` directly, reusing its
  // entire existing pipeline (precondition check, credential resolution, search/dedup/insert,
  // audit-row/partial-failure handling) rather than duplicating any of it -- valid because no
  // method here actually RUNS until after this function has already returned `services` in full.
  /**
   * The collection state of one watchlist channel: its latest channel snapshot, the data-quality flags and whether it
   * was ever observed. Reads no video snapshots, so it stays cheap enough for the polled Research summary (BL-140).
   * getWatchlistEntryContext uses it too, so the flags have one source.
   */
  /**
   * BL-145 (owner, Telegram 2026-10-07): the found channels' public counts (subscribers, videos, views, creation date)
   * from one channels.list call per 50 (1 pool unit each), so a result can be judged without opening YouTube. Best
   * effort: if it fails, the search still counts and the candidates simply show no counts.
   */
  async function recordCandidateCounts(credentials: ResolvedCredentials, candidateIds: string[], now: Date): Promise<void> {
    if (candidateIds.length === 0) return;
    try {
      const stats = await deps.youtubeApi.getPublicChannelStats({ credentials, channelIds: candidateIds });
      for (const st of stats) {
        await deps.setMarketDiscoveryCandidateStats(st.channelId, {
          subscriberCount: st.subscriberCount,
          hiddenSubscriberCount: st.hiddenSubscriberCount,
          videoCount: st.videoCount,
          viewCount: st.viewCount,
          channelPublishedAt: st.publishedAt,
          observedAt: now,
        });
      }
    } catch {
      // Counts stay unknown for this search's candidates.
    }
  }

  async function readCollectionState(channelId: string) {
    const channelSnapshotRows = await deps.listMarketChannelSnapshotsByChannel(channelId);
    const latestRun = await deps.getLatestMarketIntelligenceCollectionRunForChannel(channelId);
    // `listMarketChannelSnapshotsByChannel` orders ascending by observedAt (db.ts's own
    // contract) -- the last element is always the most recent.
    const latestChannelSnapshot = channelSnapshotRows[channelSnapshotRows.length - 1] as
      | StoredMarketChannelSnapshotForService
      | undefined;
    const dataQualityFlags: DataQualityFlag[] = [];
    // Phase 13 (review rounds 9/11): API snapshots expire after 30 days, so an empty visible series can
    // mean "collected long ago, since expired" rather than "never collected". The latter is
    // `neverObserved`; the former is stale by definition (the policy window is shorter than the stale window).
    const everCollectedSuccessfully =
      channelSnapshotRows.length === 0 && (await deps.hasSuccessfulMarketIntelligenceCollectionRun(channelId));
    const freshnessFlag = everCollectedSuccessfully
      ? "stale_observation"
      : assessObservationFreshness(latestChannelSnapshot?.observedAt ?? null, deps.clock.now());
    if (freshnessFlag) dataQualityFlags.push(freshnessFlag);
    if (latestChannelSnapshot) {
      const hiddenFlag = toHiddenSubscriberCountFlag(latestChannelSnapshot.hiddenSubscriberCount);
      if (hiddenFlag) dataQualityFlags.push(hiddenFlag);
    }
    if (latestRun) {
      const completenessFlag = assessSnapshotCompleteness(latestRun.videosRequested, latestRun.videosReturned);
      if (completenessFlag) dataQualityFlags.push(completenessFlag);
      if (latestRun.status === "skipped_quota_limited") dataQualityFlags.push("quota_limited");
      // Operator request 2026-10-04: the newest run got only the ~15-video RSS feed, not a normal page.
      if (latestRun.feedFallback) dataQualityFlags.push("feed_fallback_used");
    }
    return {
      channelSnapshotRows,
      latestChannelSnapshot,
      latestRun,
      dataQualityFlags,
      // Found by independent review (2026-09-29): `assessObservationFreshness`/`assessSnapshotCompleteness` both
      // deliberately leave "never observed at all" to their caller (see their own doc comments) -- this is that check.
      // Phase 13 (review round 9): API snapshots expire after 30 days (III.E.4.d), so an empty
      // visible series alone no longer means "never observed" -- a past successful collection does.
      neverObserved: channelSnapshotRows.length === 0 && !everCollectedSuccessfully,
    };
  }

  const services = {
    /**
     * Adds a channel the operator does not (necessarily) own to the research watchlist
     * (`docs/roadmap/plans/PHASE_9_PLAN.md` §5/§7). `callOrigin` is SERVER-STAMPED at the
     * API/MCP/CLI call site, never taken from the parsed input -- same attestation discipline as
     * `content-proposals`' `createContentProposal` (Phase 7 slice G, owner spec §22).
     *
     * Rejects a duplicate `channelId` with `RESEARCH_CHANNEL_ALREADY_WATCHED` rather than
     * silently creating a second row or silently overwriting the existing `reason` -- an
     * operator who wants to change the reason calls `removeFromWatchlist` (below) and re-adds the
     * entry explicitly (no in-place update/rename operation exists yet -- only add and remove).
     */
    async addToWatchlist(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<ResearchChannel> {
      const parsedInput = parseWithSchema(addToWatchlistInputSchema, input, "add to watchlist input");

      const existing = await deps.getResearchChannelById(parsedInput.channelId);
      if (existing) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_ALREADY_WATCHED",
          message: "This channel is already on the research watchlist",
          details: { channelId: parsedInput.channelId },
        });
      }

      await deps.insertResearchChannel({
        id: parsedInput.channelId,
        handleOrUrl: parsedInput.handleOrUrl ?? null,
        reason: parsedInput.reason,
        createdVia: callOrigin.createdVia,
      });

      // Guaranteed to exist -- this call itself just inserted it, under the same connection this
      // read uses.
      const row = (await deps.getResearchChannelById(parsedInput.channelId))!;

      return parseWithSchema(addToWatchlistOutputSchema, toResearchChannel(row), "add to watchlist output");
    },

    async listWatchlist(): Promise<{ channels: ResearchChannel[] }> {
      const rows = await deps.listResearchChannels();
      const output = { channels: rows.map(toResearchChannel) };
      return parseWithSchema(listWatchlistOutputSchema, output, "list watchlist output");
    },

    async getWatchlistEntry(input: unknown): Promise<ResearchChannel> {
      const parsedInput = parseWithSchema(getWatchlistEntryInputSchema, input, "get watchlist entry input");

      const row = await deps.getResearchChannelById(parsedInput.channelId);
      if (!row) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { channelId: parsedInput.channelId },
        });
      }

      return parseWithSchema(getWatchlistEntryOutputSchema, toResearchChannel(row), "get watchlist entry output");
    },

    /**
     * Removes a channel from the watchlist, along with every evidence row recorded against it
     * (added by independent review, 2026-09-26 -- the first version of this module had no way to
     * correct a mistyped `reason` or a wrong channel id, permanent for the life of the local
     * database). Idempotent-safe: removing an already-absent channel is a silent no-op, not an
     * error -- there is nothing destructive about a caller trying to remove something that is
     * already gone, and this matches this module's own `getResearchChannelById`-based existence
     * checks used elsewhere (never distinguishing "never existed" from "already removed").
     */
    async removeFromWatchlist(input: unknown): Promise<void> {
      const parsedInput = parseWithSchema(removeFromWatchlistInputSchema, input, "remove from watchlist input");
      await deps.deleteResearchChannel(parsedInput.channelId);
    },

    /**
     * Records one publicly-observable fact against an existing watchlist entry. Never a
     * private-analytics-shaped figure and never a profitability/ranking conclusion (plan §4/§7) --
     * enforcement of that is at the call site (e.g. slice 3's public-snapshot fetch action), this
     * function itself only persists whatever `observation`/`source` it is given.
     */
    async recordEvidence(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<ResearchEvidence> {
      const parsedInput = parseWithSchema(recordEvidenceInputSchema, input, "record evidence input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot record evidence for a channel that is not on the watchlist",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertResearchEvidence({
        id,
        researchChannelId: parsedInput.researchChannelId,
        observation: parsedInput.observation,
        source: parsedInput.source,
        confidence: parsedInput.confidence ?? null,
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listResearchEvidenceByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(recordEvidenceOutputSchema, toResearchEvidence(row), "record evidence output");
    },

    async listEvidence(input: unknown): Promise<{ evidence: ResearchEvidence[] }> {
      const parsedInput = parseWithSchema(listEvidenceInputSchema, input, "list evidence input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const rows = await deps.listResearchEvidenceByChannel(parsedInput.researchChannelId);
      const output = { evidence: rows.map(toResearchEvidence) };
      return parseWithSchema(listEvidenceOutputSchema, output, "list evidence output");
    },

    /**
     * Fetches a real, live public snapshot (subscriber/view/video counts) for a watchlisted
     * channel via `channels.list` and records it as a new evidence row (Phase 9 slice 3). The one
     * action in this module that makes a real outbound YouTube API call -- everything else here
     * is pure local storage. Never records a private-analytics-shaped figure and never a
     * conclusion (plan §4/§7) -- only the raw, sourced public numbers YouTube itself returns.
     */
    async fetchPublicSnapshot(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<ResearchEvidence> {
      const parsedInput = parseWithSchema(fetchPublicSnapshotInputSchema, input, "fetch public snapshot input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot fetch a public snapshot for a channel that is not on the watchlist",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const credentials = await deps.authResolver.resolve({
        credentialRef: parsedInput.credentialRef,
        requiredScopes: [YOUTUBE_READ_SCOPE],
      });

      const snapshot = await deps.youtubeApi.getPublicChannelSnapshot({
        credentials,
        channelId: parsedInput.researchChannelId,
      });

      if (!snapshot) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "YouTube reports no public channel for this id",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertResearchEvidence({
        id,
        researchChannelId: parsedInput.researchChannelId,
        observation: describePublicChannelSnapshot(snapshot),
        source: "youtube.channels.list",
        // "high", not "confirmed" -- found by independent review (2026-09-26): subscriberCount is
        // YouTube's own rounded approximation (see describePublicChannelSnapshot's own doc
        // comment), so labeling this evidence "confirmed" overstates its precision. This narrows
        // but does not fully close the overstatement (found by round 2 of the same review): a
        // fully-null snapshot (e.g. a hidden subscriber count with no other stats available)
        // still gets stamped "high" today, even though it described nothing concrete. Not fixed
        // here -- `docs/roadmap/plans/PHASE_9_PLAN.md` §8 already leaves the confidence
        // vocabulary itself as an open question for a future revisit, and this specific edge case
        // belongs to that same still-open decision, not to a silent partial fix here.
        confidence: "high",
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listResearchEvidenceByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(fetchPublicSnapshotOutputSchema, toResearchEvidence(row), "fetch public snapshot output");
    },

    /**
     * Single-channel deep dive: one watchlisted channel's own record plus its full evidence
     * history, by channelId. Added for Phase 9 slice 4
     * (`docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md`) so MCP (`query_market_intelligence`) and CLI
     * (`agent market-intelligence`) share one implementation of this two-call join, instead of
     * each independently re-orchestrating `getWatchlistEntry`/`listEvidence` (found by independent
     * review -- the two call sites had already started to drift cosmetically).
     *
     * Deliberately does NOT call `getWatchlistEntry`/`listEvidence` above -- an earlier version did
     * (concurrently, via `Promise.all`), but independent review (round 2) found the actual defect
     * was TWO INDEPENDENT existence checks (`deps.getResearchChannelById` called once inside each
     * sibling function), not the concurrency itself: that duplication wasted a round-trip and opened
     * a race window (a `removeFromWatchlist` landing between the two independent reads could make
     * one branch see the channel and the other not), and the two calls' own
     * `RESEARCH_CHANNEL_NOT_AVAILABLE` errors carried different `details` key names (`channelId` vs
     * `researchChannelId`), making the response shape depend on which one happened to reject first.
     * A single existence check below, feeding both branches, closes both gaps -- the two reads
     * below are sequential only because `listResearchEvidenceByChannel` has no reason to run at all
     * once the channel is already known not to exist, not because concurrency is unsafe per se.
     *
     * Extended in Phase 9 slice 9G, part A (`docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md` §2) with
     * `channelSnapshots`/`videoSnapshots`/`topicAssignments` (9A/9E's own read surfaces) and a
     * derived `dataQualityFlags` (9I's first real caller) -- additive to the original `{channel,
     * evidence}` shape, never removing or renaming either original field.
     */
    async getWatchlistEntryContext(input: unknown): Promise<{
      channel: ResearchChannel;
      evidence: ResearchEvidence[];
      channelSnapshots: MarketChannelSnapshot[];
      videoSnapshots: MarketVideoSnapshot[];
      topicAssignments: MarketTopicAssignment[];
      dataQualityFlags: DataQualityFlag[];
      neverObserved: boolean;
      uniqueVideoCount: number;
      latestVideoSnapshotAt: string | null;
      collectionProgress: CollectionProgress;
    }> {
      const parsedInput = parseWithSchema(getWatchlistEntryInputSchema, input, "get watchlist entry context input");

      const channelRow = await deps.getResearchChannelById(parsedInput.channelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { channelId: parsedInput.channelId },
        });
      }

      const evidenceRows = await deps.listResearchEvidenceByChannel(parsedInput.channelId);
      const videoSnapshotRows = await deps.listMarketVideoSnapshotsByChannel(parsedInput.channelId);
      const topicAssignmentRows = await deps.listTopicsForSubject("channel", parsedInput.channelId);
      const { channelSnapshotRows, dataQualityFlags, neverObserved } = await readCollectionState(parsedInput.channelId);

      const collectionProgress = buildCollectionProgress(
        channelRow,
        await deps.getMarketIntelligenceCollectionDepthDefaults(),
        videoSnapshotRows.map((row) => row.videoId)
      );

      return parseWithSchema(
        getWatchlistEntryContextOutputSchema,
        {
          channel: toResearchChannel(channelRow),
          evidence: evidenceRows.map(toResearchEvidence),
          channelSnapshots: channelSnapshotRows.map(toMarketChannelSnapshot),
          videoSnapshots: videoSnapshotRows.map(toMarketVideoSnapshot),
          topicAssignments: topicAssignmentRows.map(toMarketTopicAssignment),
          dataQualityFlags,
          collectionProgress,
          // readCollectionState holds the "never observed" rule (Phase 13: expired snapshots are not "never").
          neverObserved,
          uniqueVideoCount: new Set(videoSnapshotRows.map((row) => row.videoId)).size,
          latestVideoSnapshotAt: videoSnapshotRows.reduce<Date | null>((latest, row) => (latest === null || row.observedAt > latest ? row.observedAt : latest), null)?.toISOString() ?? null,
        },
        "get watchlist entry context output"
      );
    },

    /**
     * Phase 9 slice 9H, part A (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md) -- the first
     * real caller either `derived-metrics.ts` (9A) or `historical-intelligence.ts` (9D) has had
     * since they shipped. A UI-only wrapper around `getWatchlistEntryContext` (never a change to
     * that function's own MCP/CLI-facing contract, per this plan's own §3) that layers computed
     * subscriber velocity / upload cadence / per-video breakout assessment / emerging-channel
     * assessment on top -- all composition lives here, never in a route or a component (AGENTS.md
     * §M). Deliberately omits `videoSnapshots` from its own output (§4/§4a of the plan) -- an
     * unbounded, append-only series that must not ship over the network in full; the bounded
     * `latestSnapshotPerVideo` below, and the separate `getChannelVideoSnapshotHistory` action,
     * are its replacements for this action's own callers.
     */
    async getChannelIntelligenceSummary(input: unknown): Promise<{
      channel: ResearchChannel;
      evidence: ResearchEvidence[];
      channelSnapshots: MarketChannelSnapshot[];
      topicAssignments: MarketTopicAssignment[];
      dataQualityFlags: DataQualityFlag[];
      neverObserved: boolean;
      subscriberVelocity: FieldVelocity;
      uploadCadence: FieldVelocity;
      recentBreakoutVideos: BreakoutAssessment[];
      emergingChannel: EmergingChannelAssessment;
      latestSnapshotPerVideo: {
        videoId: string;
        observedAt: string;
        viewCount: number | null;
        likeCount: number | null;
        commentCount: number | null;
        publishedAt: string | null;
      }[];
      methodology: {
        channelVelocityWindowDays: number;
        recentVideoWindowDays: number;
        channelBaselineDayOffset: number;
        breakoutMinBaselineSampleSize: number;
        breakoutBaselineToleranceDays: number;
      };
    }> {
      const parsedInput = parseWithSchema(
        getChannelIntelligenceSummaryInputSchema,
        input,
        "get channel intelligence summary input"
      );
      const context = await services.getWatchlistEntryContext(parsedInput);

      // 13.3: no velocity from other channels' API data (III.E.4.h).
      const velocity = { subscriberCount: WITHHELD_FIELD_VELOCITY, viewCount: WITHHELD_FIELD_VELOCITY, videoCount: WITHHELD_FIELD_VELOCITY };

      const videoSnapshotsByVideoId = new Map<string, MarketVideoSnapshot[]>();
      for (const snapshot of context.videoSnapshots) {
        const existing = videoSnapshotsByVideoId.get(snapshot.videoId);
        if (existing) existing.push(snapshot);
        else videoSnapshotsByVideoId.set(snapshot.videoId, [snapshot]);
      }

      // `listMarketVideoSnapshotsByChannel` (the source of context.videoSnapshots) orders ascending
      // by observedAt -- the last element of each per-video group is always that video's latest.
      const latestSnapshotPerVideo = [...videoSnapshotsByVideoId.entries()].map(([videoId, snapshots]) => {
        const latest = snapshots[snapshots.length - 1];
        return {
          videoId,
          observedAt: latest.observedAt,
          viewCount: latest.viewCount,
          likeCount: latest.likeCount,
          commentCount: latest.commentCount,
          publishedAt: latest.publishedAt,
        };
      });

      // Phase 9 slice 9H part C -- extracted into computeRecentVideoBreakouts (a shared helper also
      // used by getMarketVideosOverview), verbatim in logic; a video absent from the returned map
      // (too old, or no publishedAt at all) is simply excluded from this array, exactly as before.
      // 13.3: breakouts and the emerging-channel assessment are metrics derived from other channels'
      // API data (III.E.4.h) -- withheld, with the reason.
      const recentBreakoutVideos: BreakoutAssessment[] = [];
      const emergingChannel = withheldEmergingChannel(context.channel.channelId);

      return parseWithSchema(
        getChannelIntelligenceSummaryOutputSchema,
        {
          channel: context.channel,
          evidence: context.evidence,
          channelSnapshots: context.channelSnapshots,
          topicAssignments: context.topicAssignments,
          dataQualityFlags: context.dataQualityFlags,
          neverObserved: context.neverObserved,
          subscriberVelocity: velocity.subscriberCount,
          uploadCadence: velocity.videoCount,
          recentBreakoutVideos,
          emergingChannel,
          latestSnapshotPerVideo,
          methodology: {
            channelVelocityWindowDays: CHANNEL_VELOCITY_WINDOW_DAYS,
            recentVideoWindowDays: RECENT_VIDEO_WINDOW_DAYS,
            channelBaselineDayOffset: CHANNEL_BASELINE_DAY_OFFSET,
            breakoutMinBaselineSampleSize: BREAKOUT_MIN_BASELINE_SAMPLE_SIZE,
            breakoutBaselineToleranceDays: ageNormalizedTolerance(CHANNEL_BASELINE_DAY_OFFSET),
          },
        },
        "get channel intelligence summary output"
      );
    },

    /**
     * Phase 9 slice 9H, part A -- one video's own snapshot series, bounded by filtering
     * server-side before returning (plan §4a/§4b). The underlying `listMarketVideoSnapshotsByChannel`
     * read is still unbounded at the query level (RISK-78, `docs/TECHNICAL_DEBT.md`) -- this action
     * bounds what actually reaches the network, not the database read itself.
     */
    async getChannelVideoSnapshotHistory(input: unknown): Promise<{ snapshots: MarketVideoSnapshot[] }> {
      const parsedInput = parseWithSchema(
        getChannelVideoSnapshotHistoryInputSchema,
        input,
        "get channel video snapshot history input"
      );

      const channelRow = await deps.getResearchChannelById(parsedInput.channelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { channelId: parsedInput.channelId },
        });
      }

      const rows = await deps.listMarketVideoSnapshotsByChannel(parsedInput.channelId);
      const filtered = rows.filter((row) => row.videoId === parsedInput.videoId);

      return parseWithSchema(
        getChannelVideoSnapshotHistoryOutputSchema,
        { snapshots: filtered.map(toMarketVideoSnapshot) },
        "get channel video snapshot history output"
      );
    },

    /**
     * BL-140 (review): the counts behind the Research summary line, which the dashboard polls. The same numbers
     * getMarketOverview gives (watchlist size, collection warnings, new discoveries) without its per-channel video reads
     * and derived assessments. A local read, no YouTube call.
     */
    async getResearchSummaryCounts(): Promise<{ watchlistCount: number; warningCount: number; newDiscoveryCount: number }> {
      const { channels } = await services.listWatchlist();
      let warningCount = 0;
      for (const channel of channels) {
        const state = await readCollectionState(channel.channelId);
        const status = classifyCollectionStatus({
          neverObserved: state.neverObserved,
          latestRunStatus: state.latestRun?.status ?? null,
          dataQualityFlags: state.dataQualityFlags,
        });
        if (status !== "current") warningCount += 1;
      }
      const { candidates } = await services.listDiscoveryCandidates();
      return { watchlistCount: channels.length, warningCount, newDiscoveryCount: candidates.filter((c) => c.status === "new").length };
    },

    /**
     * BL-140 R3 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.3): one row per watchlist channel for the
     * Research → Channels table. Only observed values with their observation time (Phase 13, III.E.4.f/h) plus
     * bookkeeping: how many videos were observed, the latest collection run, and a status read from the same data
     * quality flags getMarketOverview's collection warnings use. A local read, no YouTube call.
     */
    async getWatchlistTable(): Promise<{
      channels: {
        channelId: string;
        handleOrUrl: string | null;
        reason: string;
        addedAt: string;
        latestObservation: { observedAt: string; subscriberCount: number | null; hiddenSubscriberCount: boolean; viewCount: number | null; videoCount: number | null } | null;
        videosObserved: number;
        latestRun: { status: "success" | "skipped_quota_limited" | "failed"; ranAt: string | null } | null;
        dataQualityFlags: DataQualityFlag[];
        status: "current" | "attention" | "failed" | "never_collected";
      }[];
    }> {
      const { channels } = await services.listWatchlist();
      const rows = [];
      for (const channel of channels) {
        // No derived metric is computed here (unlike getChannelIntelligenceSummary), only the collection state and a
        // video count. These reads never throw for a channel removed after listWatchlist(); its row shows until the
        // next refresh.
        const state = await readCollectionState(channel.channelId);
        const videoSnapshotRows = await deps.listMarketVideoSnapshotsByChannel(channel.channelId);
        const latest = state.latestChannelSnapshot ? toMarketChannelSnapshot(state.latestChannelSnapshot) : null;
        const run = state.latestRun;
        rows.push({
          channelId: channel.channelId,
          handleOrUrl: channel.handleOrUrl,
          reason: channel.reason,
          addedAt: channel.addedAt,
          latestObservation: latest
            ? {
                observedAt: latest.observedAt,
                subscriberCount: latest.subscriberCount,
                hiddenSubscriberCount: latest.hiddenSubscriberCount,
                viewCount: latest.viewCount,
                videoCount: latest.videoCount,
              }
            : null,
          videosObserved: new Set(videoSnapshotRows.map((row) => row.videoId)).size,
          latestRun: run ? { status: run.status, ranAt: run.ranAt ? run.ranAt.toISOString() : null } : null,
          dataQualityFlags: state.dataQualityFlags,
          status: classifyCollectionStatus({
            neverObserved: state.neverObserved,
            latestRunStatus: run?.status ?? null,
            dataQualityFlags: state.dataQualityFlags,
          }),
        });
      }
      return parseWithSchema(getWatchlistTableOutputSchema, { channels: rows }, "get watchlist table output");
    },

    /**
     * Phase 9 slice 9H, part B (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_B_PLAN.md) -- Market
     * Overview, aggregating across the WHOLE watchlist. Reuses `getChannelIntelligenceSummary`
     * (part A) once per watchlisted channel -- no new per-channel computation, only aggregation/
     * filtering/sorting. UI-only, no MCP/CLI contract (mirrors part A's own §3 "compose, don't
     * extend" precedent -- no existing action's output schema changes).
     */
    async getMarketOverview(): Promise<{
      watchlistCount: number;
      newDiscoveries: MarketDiscoveryCandidate[];
      breakoutVideos: (BreakoutAssessment & { channelId: string })[];
      emergingChannels: EmergingChannelAssessment[];
      trendCandidates: (MarketTrendCandidate & { freshness: "fresh" | "needs_attention" })[];
      collectionWarnings: {
        channelId: string;
        dataQualityFlags: ("stale_observation" | "quota_limited" | "missing_snapshot" | "feed_fallback_used")[];
        latestRunStatus: "success" | "skipped_quota_limited" | "failed" | null;
        neverObserved: boolean;
      }[];
    }> {
      const { channels } = await services.listWatchlist();

      // Narrowed per plan §3a -- hidden_subscriber_count (a channel property, not a collection
      // problem) and every other value outside these three is deliberately excluded here.

      const breakoutVideos: (BreakoutAssessment & { channelId: string })[] = [];
      const emergingChannels: EmergingChannelAssessment[] = [];
      const collectionWarnings: {
        channelId: string;
        dataQualityFlags: ("stale_observation" | "quota_limited" | "missing_snapshot" | "feed_fallback_used")[];
        latestRunStatus: "success" | "skipped_quota_limited" | "failed" | null;
        neverObserved: boolean;
      }[] = [];

      for (const channel of channels) {
        let summary: Awaited<ReturnType<typeof services.getChannelIntelligenceSummary>>;
        try {
          summary = await services.getChannelIntelligenceSummary({ channelId: channel.channelId });
        } catch (error) {
          // A channel can be removed from the watchlist between the listWatchlist() call above and
          // this per-channel fetch (the Remove button is on this same Research tab) -- skip only
          // that one channel rather than 500ing the whole Overview over one already-stale row
          // (plan §4's own "per-channel race" finding). Any OTHER error (a genuine bug, a
          // different DomainError, a schema-validation failure) is rethrown unchanged -- a narrow,
          // code-checked catch, never the bare/broad catch pattern RISK-19/21/33 already removed
          // elsewhere in this codebase.
          if (isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE") continue;
          throw error;
        }

        for (const video of summary.recentBreakoutVideos) {
          if (video.isBreakout) breakoutVideos.push({ ...video, channelId: channel.channelId });
        }
        if (summary.emergingChannel.isEmerging) emergingChannels.push(summary.emergingChannel);

        const narrowedFlags = summary.dataQualityFlags.filter(
          (flag): flag is "stale_observation" | "quota_limited" | "missing_snapshot" | "feed_fallback_used" =>
            COLLECTION_WARNING_FLAGS.has(flag)
        );
        const latestRun = await deps.getLatestMarketIntelligenceCollectionRunForChannel(channel.channelId);
        // Read from the shared source (getWatchlistEntryContext, via getChannelIntelligenceSummary)
        // instead of re-deriving it here -- found by independent review, 2026-09-29: this line used
        // to independently recompute `channelSnapshots.length === 0` itself.
        // The same rule getWatchlistTable's status uses (BL-140), so the summary's count matches the Channels filter.
        if (
          classifyCollectionStatus({ neverObserved: summary.neverObserved, latestRunStatus: latestRun?.status ?? null, dataQualityFlags: narrowedFlags }) !==
          "current"
        ) {
          collectionWarnings.push({
            channelId: channel.channelId,
            dataQualityFlags: narrowedFlags,
            latestRunStatus: latestRun?.status ?? null,
            neverObserved: summary.neverObserved,
          });
        }
      }

      // Deterministic order (plan §4) so callers/tests never depend on `listWatchlist`'s own
      // incidental row order.
      breakoutVideos.sort((a, b) => {
        const ratioA = a.ratio ?? -Infinity;
        const ratioB = b.ratio ?? -Infinity;
        if (ratioA !== ratioB) return ratioB - ratioA;
        if (a.channelId !== b.channelId) return a.channelId.localeCompare(b.channelId);
        return a.videoId.localeCompare(b.videoId);
      });
      emergingChannels.sort((a, b) => a.researchChannelId.localeCompare(b.researchChannelId));
      collectionWarnings.sort((a, b) => a.channelId.localeCompare(b.channelId));

      // Neither depends on the watchlist at all (plan §4/§7 AC-1/AC-2) -- fetched unconditionally.
      const { candidates: allDiscoveryCandidates } = await services.listDiscoveryCandidates();
      const newDiscoveries = allDiscoveryCandidates.filter((c) => c.status === "new");
      const { trendCandidates } = await services.listTrendCandidatesWithFreshness();

      return parseWithSchema(
        getMarketOverviewOutputSchema,
        {
          watchlistCount: channels.length,
          newDiscoveries,
          breakoutVideos,
          emergingChannels,
          trendCandidates,
          collectionWarnings,
        },
        "get market overview output"
      );
    },

    /**
     * Phase 9 slice 9H, part C -- Videos tab, per-video aggregation across the WHOLE watchlist.
     * Deliberately calls `getWatchlistEntryContext` directly, not `getChannelIntelligenceSummary`
     * (unlike `getMarketOverview` above) -- that action deliberately does NOT return the full
     * `videoSnapshots` array (RISK-78), and this action genuinely needs each video's own full
     * snapshot series (for `velocity`), not just its already-summarized latest point.
     */
    /**
     * Phase 13 slice 13.9 -- YouTube's Trending Music chart for one region, as of now. Current-only:
     * held in memory for `MUSIC_CHART_CACHE_MS` (so repeated views cost nothing) and never written to
     * the database, so no retention applies (III.E.4.d) and nothing is derived from it (III.E.4.h).
     */
    async getMusicChart(input: { regionCode: string; credentialRef: unknown }): Promise<{
      regionCode: string;
      fetchedAt: string;
      entries: MusicChartEntry[];
    }> {
      const regionCode = String(input.regionCode ?? "").toUpperCase();
      if (!(MUSIC_CHART_REGIONS as readonly string[]).includes(regionCode)) {
        throw new DomainError({
          code: "validation_failed",
          message: `regionCode must be one of ${MUSIC_CHART_REGIONS.join(", ")}`,
          details: {},
        });
      }
      const now = deps.clock.now();
      const cached = musicChartCache.get(regionCode);
      if (cached && now.getTime() - cached.fetchedAt.getTime() < MUSIC_CHART_CACHE_MS) {
        return { regionCode, fetchedAt: cached.fetchedAt.toISOString(), entries: cached.entries };
      }
      await deps.youtubeApi.assertReadsAvailable();
      const credentials = await deps.authResolver.resolve({
        credentialRef: input.credentialRef,
        requiredScopes: [YOUTUBE_READ_SCOPE],
      });
      const entries = await deps.youtubeApi.getMostPopularMusicVideos({ credentials, regionCode });
      musicChartCache.set(regionCode, { fetchedAt: now, entries });
      return { regionCode, fetchedAt: now.toISOString(), entries };
    },

    /** Phase 13 slice 13.4: today's use of YouTube's separate search bucket (quota day = Pacific). */
    async getSearchUsage(): Promise<{ searchesUsedToday: number; dailyLimit: number; quotaDayStartedAt: string }> {
      const since = startOfQuotaDay(deps.clock.now());
      return {
        searchesUsedToday: await deps.countMarketDiscoverySearchesSince(since),
        dailyLimit: SEARCH_LIST_DAILY_CALL_LIMIT,
        quotaDayStartedAt: since.toISOString(),
      };
    },

    // BL-140 review: `channelId` narrows the read to one watchlist channel (a channel drawer's recent videos, or Videos
    // filtered to a channel), so it no longer loads every channel's video series to keep one channel's rows.
    async getMarketVideosOverview(options: { channelId?: string } = {}): Promise<{
      videos: {
        videoId: string;
        channelId: string;
        channelHandleOrUrl: string | null;
        title: string | null;
        publishedAt: string | null;
        viewCount: number | null;
        observedAt: string;
        velocity: FieldVelocity;
        breakout: BreakoutAssessment | null;
        topics: { topicId: string; name: string }[];
      }[];
      // Named constants driving `velocity`/`breakout` above, returned rather than hardcoded a
      // second time client-side where they could drift (found necessary by advisor review, same
      // discipline `getChannelIntelligenceSummary`'s own `methodology` field already established --
      // `docs/ARCHITECTURE.md` §18 names hardcoding these client-side as the exact anti-pattern).
      methodology: {
        velocityWindowDays: number;
        recentVideoWindowDays: number;
        baselineDayOffset: number;
      };
    }> {
      const { channels: watchlist } = await services.listWatchlist();
      const channels = options.channelId ? watchlist.filter((c) => c.channelId === options.channelId) : watchlist;

      const { topics } = await services.listTopics();
      const topicNameById = new Map(topics.map((t) => [t.topicId, t.name]));
      const videoTopicAssignments = await deps.listMarketTopicAssignmentsBySubjectType("video");
      const topicsByVideoId = new Map<string, { topicId: string; name: string }[]>();
      for (const assignment of videoTopicAssignments) {
        const entry = { topicId: assignment.topicId, name: topicNameById.get(assignment.topicId) ?? "" };
        const existing = topicsByVideoId.get(assignment.subjectId);
        if (existing) existing.push(entry);
        else topicsByVideoId.set(assignment.subjectId, [entry]);
      }

      const videos: {
        videoId: string;
        channelId: string;
        channelHandleOrUrl: string | null;
        title: string | null;
        publishedAt: string | null;
        viewCount: number | null;
        observedAt: string;
        velocity: FieldVelocity;
        breakout: BreakoutAssessment | null;
        topics: { topicId: string; name: string }[];
      }[] = [];

      for (const channel of channels) {
        let context: Awaited<ReturnType<typeof services.getWatchlistEntryContext>>;
        try {
          context = await services.getWatchlistEntryContext({ channelId: channel.channelId });
        } catch (error) {
          // Same narrow, code-checked per-channel race handling as getMarketOverview above -- a
          // channel removed from the watchlist between listWatchlist() and this fetch is skipped,
          // never a 500 over one already-stale row; any other error propagates unchanged.
          if (isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE") continue;
          throw error;
        }

        const videoSnapshotsByVideoId = new Map<string, MarketVideoSnapshot[]>();
        for (const snapshot of context.videoSnapshots) {
          const existing = videoSnapshotsByVideoId.get(snapshot.videoId);
          if (existing) existing.push(snapshot);
          else videoSnapshotsByVideoId.set(snapshot.videoId, [snapshot]);
        }

        // 13.3: no breakouts derived from other channels' API data (III.E.4.h).
        const breakoutsByVideoId = new Map<string, BreakoutAssessment>();

        for (const [videoId, snapshots] of videoSnapshotsByVideoId) {
          const latest = snapshots[snapshots.length - 1];
          // 13.3: no per-video velocity from other channels' API data (III.E.4.h).
          const velocity = { viewCount: WITHHELD_FIELD_VELOCITY };

          videos.push({
            videoId,
            channelId: channel.channelId,
            channelHandleOrUrl: context.channel.handleOrUrl,
            title: latest.title,
            publishedAt: latest.publishedAt,
            viewCount: latest.viewCount,
            observedAt: latest.observedAt,
            velocity: velocity.viewCount,
            breakout: breakoutsByVideoId.get(videoId) ?? null,
            topics: topicsByVideoId.get(videoId) ?? [],
          });
        }
      }

      // Deterministic order (plan §3): newest-published first, nulls last, then channelId/videoId.
      videos.sort((a, b) => {
        const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : -Infinity;
        const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : -Infinity;
        if (timeA !== timeB) return timeB - timeA;
        if (a.channelId !== b.channelId) return a.channelId.localeCompare(b.channelId);
        return a.videoId.localeCompare(b.videoId);
      });
      for (const video of videos) {
        video.topics.sort((a, b) => a.name.localeCompare(b.name) || a.topicId.localeCompare(b.topicId));
      }

      return parseWithSchema(
        getMarketVideosOverviewOutputSchema,
        {
          videos,
          methodology: {
            velocityWindowDays: CHANNEL_VELOCITY_WINDOW_DAYS,
            recentVideoWindowDays: RECENT_VIDEO_WINDOW_DAYS,
            baselineDayOffset: CHANNEL_BASELINE_DAY_OFFSET,
          },
        },
        "get market videos overview output"
      );
    },

    /**
     * Manual, structured entry against an existing watchlist entry (Phase 9 slice 9A). Mirrors
     * `recordEvidence`'s own discipline exactly: `researchChannelId` must already be on the
     * watchlist, and an omitted numeric field is stored as `null`, never coerced to `0`.
     */
    async recordChannelSnapshot(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketChannelSnapshot> {
      const parsedInput = parseWithSchema(recordChannelSnapshotInputSchema, input, "record channel snapshot input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot record a channel snapshot for a channel that is not on the watchlist",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertMarketChannelSnapshot({
        id,
        researchChannelId: parsedInput.researchChannelId,
        subscriberCount: parsedInput.subscriberCount ?? null,
        viewCount: parsedInput.viewCount ?? null,
        videoCount: parsedInput.videoCount ?? null,
        hiddenSubscriberCount: parsedInput.hiddenSubscriberCount ?? false,
        source: parsedInput.source,
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listMarketChannelSnapshotsByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(recordChannelSnapshotOutputSchema, toMarketChannelSnapshot(row), "record channel snapshot output");
    },

    async listChannelSnapshots(input: unknown): Promise<{ snapshots: MarketChannelSnapshot[] }> {
      const parsedInput = parseWithSchema(listChannelSnapshotsInputSchema, input, "list channel snapshots input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const rows = await deps.listMarketChannelSnapshotsByChannel(parsedInput.researchChannelId);
      const output = { snapshots: rows.map(toMarketChannelSnapshot) };
      return parseWithSchema(listChannelSnapshotsOutputSchema, output, "list channel snapshots output");
    },

    /**
     * Manual, structured entry for a video belonging to a watchlisted channel (Phase 9 slice 9A).
     * No automatic collection writes to this table yet -- real video-enumeration/collection is
     * 9B's own scope (`docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md` §1).
     */
    async recordVideoSnapshot(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketVideoSnapshot> {
      const parsedInput = parseWithSchema(recordVideoSnapshotInputSchema, input, "record video snapshot input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot record a video snapshot for a channel that is not on the watchlist",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertMarketVideoSnapshot({
        id,
        researchChannelId: parsedInput.researchChannelId,
        videoId: parsedInput.videoId,
        viewCount: parsedInput.viewCount ?? null,
        likeCount: parsedInput.likeCount ?? null,
        commentCount: parsedInput.commentCount ?? null,
        publishedAt: parsedInput.publishedAt ? new Date(parsedInput.publishedAt) : null,
        source: parsedInput.source,
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listMarketVideoSnapshotsByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(recordVideoSnapshotOutputSchema, toMarketVideoSnapshot(row), "record video snapshot output");
    },

    async listVideoSnapshots(input: unknown): Promise<{ snapshots: MarketVideoSnapshot[] }> {
      const parsedInput = parseWithSchema(listVideoSnapshotsInputSchema, input, "list video snapshots input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const rows = await deps.listMarketVideoSnapshotsByChannel(parsedInput.researchChannelId);
      const output = { snapshots: rows.map(toMarketVideoSnapshot) };
      return parseWithSchema(listVideoSnapshotsOutputSchema, output, "list video snapshots output");
    },

    /**
     * The one action in this slice that makes a real outbound YouTube API call (Phase 9 slice 9A)
     * -- reuses the identical `getPublicChannelSnapshot` read-gateway call `fetchPublicSnapshot`
     * (slice 3) already uses, per `docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md` §3's own design
     * decision. Deliberately does NOT touch `fetchPublicSnapshot`'s own existing behavior -- the
     * free-text `research_evidence` row it writes is completely unaffected; this is a pure
     * addition writing a separate, structured `market_channel_snapshots` row from the same live
     * response.
     */
    async captureChannelSnapshot(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketChannelSnapshot> {
      const parsedInput = parseWithSchema(captureChannelSnapshotInputSchema, input, "capture channel snapshot input");

      const channelRow = await deps.getResearchChannelById(parsedInput.researchChannelId);
      if (!channelRow) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "Cannot capture a channel snapshot for a channel that is not on the watchlist",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const credentials = await deps.authResolver.resolve({
        credentialRef: parsedInput.credentialRef,
        requiredScopes: [YOUTUBE_READ_SCOPE],
      });

      const snapshot = await deps.youtubeApi.getPublicChannelSnapshot({
        credentials,
        channelId: parsedInput.researchChannelId,
      });

      if (!snapshot) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "YouTube reports no public channel for this id",
          details: { researchChannelId: parsedInput.researchChannelId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertMarketChannelSnapshot({
        id,
        researchChannelId: parsedInput.researchChannelId,
        subscriberCount: snapshot.subscriberCount,
        viewCount: snapshot.viewCount,
        videoCount: snapshot.videoCount,
        // YouTube's own real flag, not re-guessed from `subscriberCount === null` -- that would
        // also misclassify a genuinely absent/unparseable count as "hidden" (found by independent
        // review, 2026-09-26; fixed at the root by widening `PublicChannelSnapshot` itself, both
        // here and in the read gateway, rather than re-guessing downstream).
        hiddenSubscriberCount: snapshot.hiddenSubscriberCount,
        source: "youtube.channels.list",
        createdVia: callOrigin.createdVia,
      });

      const rows = await deps.listMarketChannelSnapshotsByChannel(parsedInput.researchChannelId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;

      return parseWithSchema(captureChannelSnapshotOutputSchema, toMarketChannelSnapshot(row), "capture channel snapshot output");
    },

    /**
     * The operator-set daily unit budget (Phase 9 slice 9B, plan §4) -- `null`/unset means the
     * repeatable auto-refresh is off. Exposed here (a thin passthrough) rather than left as a
     * direct `db.ts` import inside `/api/settings/route.ts` (found by this module's own mechanical
     * `PHASE9-INV-02` inventory test, which is exactly the guard this indirection exists to
     * satisfy): a generic settings route reaching straight into a feature module's own db.ts
     * functions is the identical reach-around `AGENTS.md` §D/§M forbids for every other domain,
     * even though this particular setting is a plain number with no validation of its own to add.
     */
    async getDailyQuotaBudgetUnits(): Promise<number | null> {
      return deps.getMarketIntelligenceDailyQuotaBudgetUnits();
    },

    async setDailyQuotaBudgetUnits(units: number | null): Promise<void> {
      await deps.setMarketIntelligenceDailyQuotaBudgetUnits(units);
    },

    /**
     * Operator request 2026-10-04 -- the global default collection depth (a channel's own override wins). `null` = not set: 50
     * videos / no date, today's behaviour. Also reports the unit cost of a first collection at the effective depth.
     */
    async getCollectionDepthDefaults(): Promise<{
      maxVideosPerChannel: number | null;
      publishedAfter: string | null;
      effectiveMaxVideosPerChannel: number;
      estimatedFirstCollectionUnits: number;
      estimatedFirstCollectionWorstCaseUnits: number;
    }> {
      const defaults = await deps.getMarketIntelligenceCollectionDepthDefaults();
      const effective = resolveCollectionDepth({}, defaults);
      const estimate = estimateCollectionUnits(effective.maxVideosPerChannel);
      return {
        ...defaults,
        effectiveMaxVideosPerChannel: effective.maxVideosPerChannel,
        estimatedFirstCollectionUnits: estimate.firstCollection,
        estimatedFirstCollectionWorstCaseUnits: estimate.firstCollectionWorstCase,
      };
    },

    async setCollectionDepthDefaults(input: unknown): Promise<void> {
      const parsed = parseWithSchema(setCollectionDepthDefaultsInputSchema, input, "set collection depth defaults input");
      await deps.setMarketIntelligenceCollectionDepthDefaults(parsed);
    },

    /** One watchlist channel's effective depth, progress and cost estimate (what the watchlist UI shows). */
    async getChannelCollectionProgress(input: unknown): Promise<CollectionProgress> {
      const parsed = parseWithSchema(getWatchlistEntryInputSchema, input, "get channel collection progress input");
      const row = await deps.getResearchChannelById(parsed.channelId);
      if (!row) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { channelId: parsed.channelId },
        });
      }
      const videos = await deps.listMarketVideoSnapshotsByChannel(parsed.channelId);
      return buildCollectionProgress(row, await deps.getMarketIntelligenceCollectionDepthDefaults(), videos.map((v) => v.videoId));
    },

    /** The per-channel override of the depth settings (`null` = use the global default). */
    async setChannelCollectionDepth(input: unknown): Promise<void> {
      const parsed = parseWithSchema(setResearchChannelCollectionDepthInputSchema, input, "set channel collection depth input");
      const row = await deps.getResearchChannelById(parsed.channelId);
      if (!row) {
        throw new DomainError({
          code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
          message: "No watchlist entry for the requested channel",
          details: { channelId: parsed.channelId },
        });
      }
      await deps.setResearchChannelCollectionDepth(parsed.channelId, {
        maxVideosPerChannel: parsed.maxVideosPerChannel,
        publishedAfter: parsed.publishedAfter,
      });
    },

    /**
     * The repeatable, budget-aware auto-refresh trigger (Phase 9 slice 9B): every watchlisted
     * channel stale by more than 24h gets one attempt -- channel snapshot (± its uploads playlist
     * id, one `channels.list` call), up to 50 newest video snapshots (one `playlistItems.list` +
     * one `videos.list` call) -- gated by the operator's own daily unit budget
     * (`getMarketIntelligenceDailyQuotaBudgetUnits`; `null`/unset means auto-collection is off).
     *
     * Deliberately does NOT call the public `captureChannelSnapshot` above (advisor review, before
     * implementation): that action's own output schema strips `uploadsPlaylistId` (a field
     * `MarketChannelSnapshot`, the PERSISTED contract, has no reason to carry) and it would
     * re-resolve credentials once per channel instead of once for the whole run. This method calls
     * `deps.youtubeApi`/`deps.insertMarketChannelSnapshot` directly instead, on the one
     * already-resolved credential set.
     *
     * Concurrency: claims every eligible channel atomically in ONE call
     * (`claimStaleResearchChannelsForCollection`, a single `UPDATE ... WHERE ... RETURNING`) before
     * any real work starts -- a second concurrent call (e.g. two dashboard tabs) sees none of them
     * still claimable and does nothing, closing the race a per-channel-only claim would still leave
     * open against a run-scoped shared budget. Each claim is released the moment that channel's own
     * attempt reaches ANY terminal outcome, in a `finally`, so a crash mid-run leaves at most an
     * abandoned claim (self-healing after `MARKET_INTELLIGENCE_CLAIM_EXPIRY_MS`), never a
     * permanently stuck channel.
     *
     * Budget is checked against `PER_CHANNEL_WORST_CASE_UNIT_COST` (3) BEFORE a channel is even
     * started, not per individual call -- a channel is either fully processed this run or not
     * started at all, never cut short partway. **Correction (independent/advisor review): an
     * earlier version checked budget per-call instead**, which let a channel whose `channels.list`
     * and `playlistItems.list` succeeded but whose `videos.list` got cut short by budget still be
     * recorded `"success"` and marked collected -- directly contradicting this slice's own plan
     * (`PHASE_9_SLICE_9B_PLAN.md` §2/§4: a budget-limited channel must stay stale and be recorded
     * `skipped_quota_limited`). The moment `remaining` can no longer cover a FULL channel, that
     * channel's row is stamped `skipped_quota_limited` (`unitsSpent: 0` -- nothing was attempted),
     * every other still-claimed channel is released WITHOUT a row of its own (found by advisor
     * review: writing one identical row per remaining stale channel on every single dashboard
     * mount, once the budget is merely small, would spam the audit log for no new information
     * beyond "the budget ran out here"), and the whole run stops.
     *
     * Operator request 2026-10-04 (deeper collection): a channel's minimum is still that one-page worst case; beyond it, each
     * further playlist page needs 2 spare units (the page plus a possible `videos.list` fallback) AND must leave 3 units for every
     * channel still waiting in this run, so a deep backfill never starves the others. A page is fully processed (stats fetched, rows
     * inserted) or not started; when the budget ends a backfill the channel is recorded as a `success` with its cursor saved
     * (`videos_next_page_token`) and the next stale run resumes there.
     *
     * Each call's own cost is charged to `remaining`/`unitsSpentThisChannel` BEFORE that call
     * resolves, not after -- a thrown error (e.g. a transient network failure) must still be
     * recorded with its real spend (YouTube's own quota accounting charges a failed/invalid request
     * too), never silently erased back to a fabricated 0 (advisor review).
     *
     * A channel whose most recent run failed within the last 24h is excluded from this run's claim
     * entirely (`listRecentlyFailedResearchChannelIds`) -- without this, a permanently broken
     * channel (deleted, made private) would spend at least one real unit on every mount, forever.
     * `last_auto_collected_at` is set ONLY on a channel's own full success, never as a side effect
     * of the overall run -- a channel this run could not fully process stays stale for next time.
     *
     * **Known residual limitation, stated plainly rather than silently left implicit (advisor
     * review):** `remaining` is recomputed from the ledger once, right after this run's own claim
     * lands, narrowing but not eliminating the race between two concurrent callers (e.g. two
     * dashboard tabs opened within moments of each other) each starting from the same
     * not-yet-updated spend total. Two such runs could each independently decide they have enough
     * budget and both proceed, together spending up to about twice the remaining budget (since the
     * 2026-10-04 deeper collection a single channel may use most of `remaining`, so the overshoot is no
     * longer capped at `2 * PER_CHANNEL_WORST_CASE_UNIT_COST`; tracked in `docs/TECHNICAL_DEBT.md`
     * RISK-103). This is judged an acceptable, bounded overshoot for a same-machine, low-frequency trigger (never a
     * distributed system), not a gap silently left unrecognized -- the channel-level `collectionClaimedAt`
     * claim above still guarantees the two runs never spend budget on the SAME channel twice. The same
     * applies to a crash mid-backfill: the ledger row is written at the end of a channel, so up to about
     * 2 units per page already fetched may go unrecorded (same RISK-103).
     */
    async runCollectionIfStale(input: unknown): Promise<{
      attempted: number;
      succeeded: number;
      failed: number;
      quotaLimited: number;
      unitsSpent: number;
    }> {
      const parsedInput = parseWithSchema(runCollectionIfStaleInputSchema, input, "run collection if stale input");
      const { attempted, succeeded, failed, quotaLimited, unitsSpent } = await collectStaleChannels(parsedInput);
      return parseWithSchema(
        runCollectionIfStaleOutputSchema,
        { attempted, succeeded, failed, quotaLimited, unitsSpent },
        "run collection if stale output"
      );
    },

    /**
     * The one `search.list`-based discovery action (Phase 9 slice 9C) -- never automatic, only
     * ever called from an explicit operator UI action (owner decision 4). Since Phase 13 slice 13.4
     * `search.list` has its own bucket (100 calls a day at 1 unit), counted from `market_discovery_runs`
     * by `countMarketDiscoverySearchesSince` -- separate from collection's pool budget. `null`/unset budget refuses outright
     * (`MARKET_INTELLIGENCE_QUOTA_DISABLED`) rather than silently no-op'ing like 9B's own
     * background trigger does -- an operator who just clicked "Discover" needs to know why nothing
     * happened, not have it silently swallowed. Charged before the call resolves, same as every 9B
     * call (a thrown request still costs a real unit per YouTube's own quota accounting).
     *
     * A result already on the watchlist is never turned into a candidate; a result matching an
     * existing candidate only refreshes `lastSeenAt`/`title`/`reasonDiscovered`, never duplicates the row or resets an
     * operator-set `status`.
     *
     * **The search's spend is recorded on every exit path, not just when the `search.list` call
     * itself throws** (found by independent/advisor review: an earlier version only wrapped the
     * `search.list` call itself in try/catch -- a throw from the dedup loop afterward, e.g. a
     * `insertMarketDiscoveryCandidate` primary-key violation from an overlapping concurrent
     * request, propagated uncaught with NO run row written at all. YouTube had already counted the
     * search against its 100-searches-per-day bucket; the run log would have silently undercounted
     * it, letting later searches go past that cap).
     */
    async discoverChannels(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<{ candidatesFound: number; candidatesNew: number; candidateIds: string[] }> {
      const parsedInput = parseWithSchema(discoverChannelsInputSchema, input, "discover channels input");

      const now = deps.clock.now();
      await assertDiscoveryPreconditions(deps, now);

      const credentials = await deps.authResolver.resolve({
        credentialRef: parsedInput.credentialRef,
        requiredScopes: [YOUTUBE_READ_SCOPE],
      });

      // candidatesFound/candidatesNew are tracked outside the try so the catch below can record
      // whatever partial progress was actually made before a later throw, never fabricating a
      // count for work that never happened.
      let candidatesFound: number | null = null;
      let candidatesNewCount: number | null = null;
      // BL-145 (P4): every candidate this search created or found again, so an approved agent request can hand them
      // to the requesting channel.
      const candidateIds: string[] = [];

      try {
        const results = await deps.youtubeApi.searchPublicChannels({ credentials, query: parsedInput.query });
        candidatesFound = results.length;
        candidatesNewCount = 0;

        for (const result of results) {
          const alreadyWatchlisted = await deps.getResearchChannelById(result.channelId);
          if (alreadyWatchlisted) continue;

          const existingCandidate = await deps.getMarketDiscoveryCandidateById(result.channelId);
          if (existingCandidate) {
            await deps.touchMarketDiscoveryCandidateLastSeen(result.channelId, now, result.title, result.description);
            candidateIds.push(result.channelId);
            continue;
          }

          await deps.insertMarketDiscoveryCandidate({
            id: result.channelId,
            title: result.title,
            discoverySource: "youtube.search.list",
            discoveryQuery: parsedInput.query,
            reasonDiscovered: result.description,
            createdVia: callOrigin.createdVia,
          });
          candidatesNewCount += 1;
          candidateIds.push(result.channelId);
        }

        await recordCandidateCounts(credentials, candidateIds, now);

        await deps.insertMarketDiscoveryRun({
          query: parsedInput.query,
          status: "success",
          unitsSpent: SEARCH_LIST_UNIT_COST, // 1 unit of the search bucket
          candidatesFound,
          candidatesNew: candidatesNewCount,
          ranAt: now,
        });

        return parseWithSchema(
          discoverChannelsOutputSchema,
          { candidatesFound, candidatesNew: candidatesNewCount, candidateIds },
          "discover channels output"
        );
      } catch (error) {
        await deps.insertMarketDiscoveryRun({
          query: parsedInput.query,
          status: "failed",
          unitsSpent: SEARCH_LIST_UNIT_COST, // 1 unit of the search bucket
          candidatesFound,
          candidatesNew: candidatesNewCount,
          errorMessage: error instanceof Error ? error.message : String(error),
          ranAt: now,
        });
        throw error;
      }
    },

    /**
     * BL-145 (owner, Telegram 2026-10-07, msg 1904: "searching channel names is not effective; find by genre"): one
     * search.list for music VIDEOS matching the genre words (1 call of the 100-searches bucket), optionally only recent
     * ones, grouped by the channel that published them. Auto-generated "… - Topic" channels (YouTube's artist pages, no
     * API flag -- recognised by the title suffix) are left out. Each channel becomes (or refreshes) a candidate exactly
     * like a name search, plus `match`: how many of its videos matched and their total views (one videos.list call, 1
     * pool unit; best effort), then the same counts lookup (1 more pool unit). Same preconditions, same run log.
     */
    async discoverChannelsByGenre(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<{ videosFound: number; candidatesFound: number; candidatesNew: number; topicChannelsSkipped: number; candidateIds: string[] }> {
      const parsedInput = parseWithSchema(discoverChannelsByGenreInputSchema, input, "discover channels by genre input");
      const now = deps.clock.now();
      await assertDiscoveryPreconditions(deps, now);
      const credentials = await deps.authResolver.resolve({ credentialRef: parsedInput.credentialRef, requiredScopes: [YOUTUBE_READ_SCOPE] });
      const publishedAfter = parsedInput.publishedWithinDays ? new Date(now.getTime() - parsedInput.publishedWithinDays * 86_400_000).toISOString() : null;
      const runQuery = `${parsedInput.query} [genre${parsedInput.publishedWithinDays ? `, ${parsedInput.publishedWithinDays} d` : ""}]`;

      let candidatesFound: number | null = null;
      let candidatesNew: number | null = null;
      try {
        const videos = await deps.youtubeApi.searchPublicMusicVideos({ credentials, query: parsedInput.query, publishedAfter });
        const byChannel = new Map<string, { title: string; videoIds: string[]; titles: string[] }>();
        let topicChannelsSkipped = 0;
        const skippedTopic = new Set<string>();
        for (const v of videos) {
          if (/ - Topic$/.test(v.channelTitle)) {
            if (!skippedTopic.has(v.channelId)) topicChannelsSkipped += 1;
            skippedTopic.add(v.channelId);
            continue;
          }
          const entry = byChannel.get(v.channelId) ?? { title: v.channelTitle, videoIds: [], titles: [] };
          entry.videoIds.push(v.videoId);
          entry.titles.push(v.title);
          byChannel.set(v.channelId, entry);
        }

        // Views of the matching videos (observed now), for "N matching videos, X views on them". Best effort.
        const viewsByVideo = new Map<string, number | null>();
        const matchedVideoIds = [...byChannel.values()].flatMap((c) => c.videoIds);
        if (matchedVideoIds.length > 0) {
          try {
            for (const snap of await deps.youtubeApi.getPublicVideoSnapshots({ credentials, videoIds: matchedVideoIds })) viewsByVideo.set(snap.videoId, snap.viewCount);
          } catch {
            // Views stay unknown; the match count is still real.
          }
        }

        // Most matching videos first, so the list reads in order of relevance to the genre.
        const channels = [...byChannel.entries()].sort((a, b) => b[1].videoIds.length - a[1].videoIds.length);
        candidatesFound = channels.length;
        candidatesNew = 0;
        const candidateIds: string[] = [];
        for (const [channelId, c] of channels) {
          if (await deps.getResearchChannelById(channelId)) continue;
          const reason = `${c.videoIds.length} matching video${c.videoIds.length === 1 ? "" : "s"}: ${c.titles
            .slice(0, 3)
            .map((t) => `"${t}"`)
            .join(", ")}${c.titles.length > 3 ? ", …" : ""}`;
          if (await deps.getMarketDiscoveryCandidateById(channelId)) {
            await deps.touchMarketDiscoveryCandidateLastSeen(channelId, now, c.title, reason);
          } else {
            await deps.insertMarketDiscoveryCandidate({
              id: channelId,
              title: c.title,
              discoverySource: "youtube.search.list:music_videos",
              discoveryQuery: parsedInput.query,
              reasonDiscovered: reason,
              createdVia: callOrigin.createdVia,
            });
            candidatesNew += 1;
          }
          const views = c.videoIds.map((id) => viewsByVideo.get(id));
          const viewCount = views.every((v) => typeof v === "number") ? (views as number[]).reduce((a, b) => a + b, 0) : null;
          await deps.setMarketDiscoveryCandidateMatch(channelId, { query: parsedInput.query, videoCount: c.videoIds.length, viewCount });
          candidateIds.push(channelId);
        }

        await recordCandidateCounts(credentials, candidateIds, now);

        await deps.insertMarketDiscoveryRun({
          query: runQuery,
          status: "success",
          unitsSpent: SEARCH_LIST_UNIT_COST,
          candidatesFound,
          candidatesNew,
          ranAt: now,
        });
        return parseWithSchema(
          discoverChannelsByGenreOutputSchema,
          { videosFound: videos.length, candidatesFound, candidatesNew, topicChannelsSkipped, candidateIds },
          "discover channels by genre output"
        );
      } catch (error) {
        await deps.insertMarketDiscoveryRun({
          query: runQuery,
          status: "failed",
          unitsSpent: SEARCH_LIST_UNIT_COST,
          candidatesFound,
          candidatesNew,
          errorMessage: error instanceof Error ? error.message : String(error),
          ranAt: now,
        });
        throw error;
      }
    },

    async listDiscoveryCandidates(): Promise<{ candidates: MarketDiscoveryCandidate[] }> {
      const rows = await deps.listMarketDiscoveryCandidates();
      return parseWithSchema(
        listDiscoveryCandidatesOutputSchema,
        {
          candidates: rows
            .filter((row) => !(row.status === "new" && candidateExpired(row, deps.clock.now())))
            .map((row) => toMarketDiscoveryCandidate(row, deps.clock.now())),
        },
        "list discovery candidates output"
      );
    },

    /**
     * `status` is never `"new"` (the initial state only) or `"promoted"` (its own dedicated action
     * below, since promotion has a real side effect) -- enforced by the input schema's own enum,
     * not re-checked here. Rejects `DISCOVERY_CANDIDATE_ALREADY_PROMOTED` for a candidate already
     * promoted -- that record is a closed historical fact from that point on.
     */
    async updateDiscoveryCandidateStatus(input: unknown): Promise<MarketDiscoveryCandidate> {
      const parsedInput = parseWithSchema(
        updateDiscoveryCandidateStatusInputSchema,
        input,
        "update discovery candidate status input"
      );

      const existing = await deps.getMarketDiscoveryCandidateById(parsedInput.channelId);
      if (!existing) {
        throw new DomainError({
          code: "DISCOVERY_CANDIDATE_NOT_FOUND",
          message: "No discovery candidate for this channel id",
          details: { channelId: parsedInput.channelId },
        });
      }
      if (existing.status === "promoted") {
        throw new DomainError({
          code: "DISCOVERY_CANDIDATE_ALREADY_PROMOTED",
          message: "A promoted candidate's status cannot be changed here -- manage it via the watchlist instead",
          details: { channelId: parsedInput.channelId },
        });
      }

      await deps.setMarketDiscoveryCandidateStatus(parsedInput.channelId, parsedInput.status);
      const updated = (await deps.getMarketDiscoveryCandidateById(parsedInput.channelId))!;
      return parseWithSchema(marketDiscoveryCandidateSchema, toMarketDiscoveryCandidate(updated, deps.clock.now()), "update discovery candidate status output");
    },

    /**
     * Inserts a `research_channels` row directly via `deps.insertResearchChannel` (mirrors
     * `getWatchlistEntryContext`'s own established precedent of avoiding a redundant duplicate
     * existence-check rather than calling the public `addToWatchlist` action, which would repeat
     * this same existence check internally) UNLESS the channel is already watchlisted -- idempotent
     * in that case, since the desired end state already holds.
     */
    async promoteDiscoveryCandidate(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<{ channel: ResearchChannel; candidate: MarketDiscoveryCandidate }> {
      const parsedInput = parseWithSchema(promoteDiscoveryCandidateInputSchema, input, "promote discovery candidate input");

      const existing = await deps.getMarketDiscoveryCandidateById(parsedInput.channelId);
      if (!existing) {
        throw new DomainError({
          code: "DISCOVERY_CANDIDATE_NOT_FOUND",
          message: "No discovery candidate for this channel id",
          details: { channelId: parsedInput.channelId },
        });
      }
      if (existing.status === "promoted") {
        throw new DomainError({
          code: "DISCOVERY_CANDIDATE_ALREADY_PROMOTED",
          message: "This candidate has already been promoted",
          details: { channelId: parsedInput.channelId },
        });
      }

      const alreadyWatchlisted = await deps.getResearchChannelById(parsedInput.channelId);
      if (!alreadyWatchlisted) {
        await deps.insertResearchChannel({
          id: parsedInput.channelId,
          reason: parsedInput.reason,
          createdVia: callOrigin.createdVia,
        });
      }
      await deps.setMarketDiscoveryCandidateStatus(parsedInput.channelId, "promoted");

      const channelRow = (await deps.getResearchChannelById(parsedInput.channelId))!;
      const candidateRow = (await deps.getMarketDiscoveryCandidateById(parsedInput.channelId))!;
      return parseWithSchema(
        promoteDiscoveryCandidateOutputSchema,
        { channel: toResearchChannel(channelRow), candidate: toMarketDiscoveryCandidate(candidateRow, deps.clock.now()) },
        "promote discovery candidate output"
      );
    },

    /**
     * Owner spec §13 (topic model), part A -- manual/keyword-based tagging, explicitly exempt from
     * decision 3's AI-connection gating. Rejects a duplicate name using a NORMALIZED (trimmed,
     * whitespace-collapsed, lowercased) comparison against every existing topic -- never silently
     * creating a second row for "Night Jazz Bar" vs "night jazz bar" vs "Night  Jazz  Bar".
     */
    async createTopic(input: unknown, callOrigin: { createdVia: CreatedVia }): Promise<MarketTopic> {
      const parsedInput = parseWithSchema(createTopicInputSchema, input, "create topic input");

      const existingTopics = await deps.listMarketTopics();
      const normalizedNew = normalizeTopicNameForComparison(parsedInput.name);
      const duplicate = existingTopics.find((topic) => normalizeTopicNameForComparison(topic.name) === normalizedNew);
      if (duplicate) {
        throw new DomainError({
          code: "TOPIC_ALREADY_EXISTS",
          message: "A topic with this name already exists",
          details: { name: parsedInput.name, existingTopicId: duplicate.id },
        });
      }

      const id = deps.idGenerator();
      await deps.insertMarketTopic({ id, name: parsedInput.name, createdVia: callOrigin.createdVia });
      const row = (await deps.getMarketTopicById(id))!;
      return parseWithSchema(createTopicOutputSchema, toMarketTopic(row), "create topic output");
    },

    async listTopics(): Promise<{ topics: MarketTopic[] }> {
      const rows = await deps.listMarketTopics();
      return parseWithSchema(listTopicsOutputSchema, { topics: rows.map(toMarketTopic) }, "list topics output");
    },

    /**
     * Cascades its own assignments and detaches (never deletes) any trend candidate tagged with it
     * -- `deps.deleteMarketTopic`'s own doc comment in db.ts explains why. Idempotent-safe, matching
     * `removeFromWatchlist`'s own established convention in this module: removing an
     * already-absent topic is a silent no-op, not an error.
     */
    async deleteTopic(input: unknown): Promise<void> {
      const parsedInput = parseWithSchema(deleteTopicInputSchema, input, "delete topic input");
      await deps.deleteMarketTopic(parsedInput.topicId);
    },

    /**
     * A channel subject must already be on the watchlist (`RESEARCH_CHANNEL_NOT_AVAILABLE` if not)
     * -- a video subject's format is already validated by the schema's own discriminated union, and
     * has no existence check here (`market_video_snapshots` is an append-only series with no
     * canonical single row per video to check against, same reasoning as this table's own missing
     * FK). Rejects an exact-duplicate (topic, subject) pair before insert -- the real
     * `UNIQUE(topic_id, subject_type, subject_id)` index is a defense-in-depth backstop, not the
     * primary mechanism (advisor review: a raw constraint violation should never reach the caller
     * as an opaque error when a clean pre-check is this cheap).
     */
    async assignTopic(input: unknown, callOrigin: { createdVia: CreatedVia }): Promise<MarketTopicAssignment> {
      const parsedInput = parseWithSchema(assignTopicInputSchema, input, "assign topic input");

      const topic = await deps.getMarketTopicById(parsedInput.topicId);
      if (!topic) {
        throw new DomainError({
          code: "TOPIC_NOT_FOUND",
          message: "No topic with this id",
          details: { topicId: parsedInput.topicId },
        });
      }

      if (parsedInput.subjectType === "channel") {
        const channel = await deps.getResearchChannelById(parsedInput.subjectId);
        if (!channel) {
          throw new DomainError({
            code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
            message: "Cannot assign a topic to a channel that is not on the watchlist",
            details: { channelId: parsedInput.subjectId },
          });
        }
      }

      const existingAssignment = await deps.getTopicAssignment(
        parsedInput.topicId,
        parsedInput.subjectType,
        parsedInput.subjectId
      );
      if (existingAssignment) {
        throw new DomainError({
          code: "TOPIC_ASSIGNMENT_ALREADY_EXISTS",
          message: "This subject is already assigned to this topic",
          details: { topicId: parsedInput.topicId, subjectType: parsedInput.subjectType, subjectId: parsedInput.subjectId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertMarketTopicAssignment({
        id,
        topicId: parsedInput.topicId,
        subjectType: parsedInput.subjectType,
        subjectId: parsedInput.subjectId,
        source: "manual",
        createdVia: callOrigin.createdVia,
      });
      const row = (await deps.getTopicAssignment(parsedInput.topicId, parsedInput.subjectType, parsedInput.subjectId))!;
      return parseWithSchema(assignTopicOutputSchema, toMarketTopicAssignment(row), "assign topic output");
    },

    async removeTopicAssignment(input: unknown): Promise<void> {
      const parsedInput = parseWithSchema(removeTopicAssignmentInputSchema, input, "remove topic assignment input");
      await deps.deleteMarketTopicAssignment(parsedInput.assignmentId);
    },

    // Named `listTopicAssignments`, not `listAssignmentsForTopic`, so a caller of this exported
    // action never has to spell out the exact same substring as the db.ts symbol it wraps --
    // PHASE9-INV-02's own plain-substring scan cannot otherwise tell "calls the exported core" apart
    // from "imports the raw db.ts function directly" (found the hard way: this service action shared
    // its db.ts counterpart's exact name, which tripped that scanner once the scanner's own list was
    // widened to actually include it -- the same class of collision `listResearchRequests` was
    // already renamed to avoid). Mirrors this file's own established convention elsewhere.
    async listTopicAssignments(input: unknown): Promise<{ assignments: MarketTopicAssignment[] }> {
      const parsedInput = parseWithSchema(listAssignmentsForTopicInputSchema, input, "list assignments for topic input");
      const topic = await deps.getMarketTopicById(parsedInput.topicId);
      if (!topic) {
        throw new DomainError({
          code: "TOPIC_NOT_FOUND",
          message: "No topic with this id",
          details: { topicId: parsedInput.topicId },
        });
      }
      const rows = await deps.listAssignmentsForTopic(parsedInput.topicId);
      return parseWithSchema(
        listAssignmentsForTopicOutputSchema,
        { assignments: rows.map(toMarketTopicAssignment) },
        "list assignments for topic output"
      );
    },

    // Named `listAssignmentsForSubject`, not `listTopicsForSubject`, for the same reason
    // `listTopicAssignments`/`getTrendEvidence` were renamed just above -- this service action
    // otherwise shares its db.ts counterpart's exact name, which PHASE9-INV-02 must be able to flag
    // the moment any future external caller reaches it (found proactively, not from an actual
    // external caller today -- none exists yet, confirmed by grep -- but leaving the identical
    // landmine in place for whoever adds the next one is the same mistake already made twice).
    async listAssignmentsForSubject(input: unknown): Promise<{ assignments: MarketTopicAssignment[] }> {
      const parsedInput = parseWithSchema(listTopicsForSubjectInputSchema, input, "list topics for subject input");
      const rows = await deps.listTopicsForSubject(parsedInput.subjectType, parsedInput.subjectId);
      return parseWithSchema(
        listTopicsForSubjectOutputSchema,
        { assignments: rows.map(toMarketTopicAssignment) },
        "list topics for subject output"
      );
    },

    /**
     * Creates a new manually-declared trend candidate (Phase 9 slice 9E, part B; spec §14: "do not
     * allow lifecycle labels to exist without supporting observable rules or evidence"). Requires
     * at least one evidence item up front (enforced by `createTrendCandidateInputSchema`'s own
     * shape, not re-checked here) -- `insertMarketTrendCandidateWithInitialEvidence`'s own single
     * transaction (db.ts) guarantees there is no code path that creates a trend candidate with zero
     * evidence rows, even on a partial failure. Always starts at status "emerging" (that same
     * function's own db.ts contract, not overridable from this input).
     */
    async createTrendCandidate(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketTrendCandidate> {
      const parsedInput = parseWithSchema(createTrendCandidateInputSchema, input, "create trend candidate input");

      if (parsedInput.topicId) {
        const topic = await deps.getMarketTopicById(parsedInput.topicId);
        if (!topic) {
          throw new DomainError({
            code: "TOPIC_NOT_FOUND",
            message: "No topic with this id",
            details: { topicId: parsedInput.topicId },
          });
        }
      }

      const id = deps.idGenerator();
      // `at` stamps BOTH firstObservedAt/lastObservedAt from this one injected clock read (found
      // by independent code review: without it, this insert's own column default and the
      // touch-style calls elsewhere in this module read from two different clock sources -- real
      // wall-clock vs. the injected `deps.clock` -- which a test freezing the clock far from real
      // time would expose as two mismatched timestamps for what should be the same instant).
      const now = deps.clock.now();
      const initialEvidence = parsedInput.initialEvidence;
      // Single transaction (`insertMarketTrendCandidateWithInitialEvidence`) -- a two-separate-writes
      // version was found by independent review to let a throw between them leave a trend
      // candidate with zero evidence rows, the exact invariant spec §14 exists to prevent
      // (RISK-70).
      await deps.insertMarketTrendCandidateWithInitialEvidence(
        {
          id,
          title: parsedInput.title,
          description: parsedInput.description ?? null,
          topicId: parsedInput.topicId ?? null,
          createdVia: callOrigin.createdVia,
          at: now,
        },
        {
          id: deps.idGenerator(),
          evidenceType: initialEvidence.evidenceType,
          referenceId: initialEvidence.evidenceType === "signal" ? null : initialEvidence.referenceId,
          description: initialEvidence.description,
          createdVia: callOrigin.createdVia,
        }
      );

      const row = (await deps.getMarketTrendCandidateById(id))!;
      return parseWithSchema(createTrendCandidateOutputSchema, toMarketTrendCandidate(row), "create trend candidate output");
    },

    async listTrendCandidates(): Promise<{ trendCandidates: MarketTrendCandidate[] }> {
      const rows = await deps.listMarketTrendCandidates();
      return parseWithSchema(
        listTrendCandidatesOutputSchema,
        { trendCandidates: rows.map(toMarketTrendCandidate) },
        "list trend candidates output"
      );
    },

    /**
     * Phase 9 slice 9H, part A -- a UI-only wrapper pairing each candidate with a freshness label,
     * never merged into `listTrendCandidates`/`marketTrendCandidateSchema` themselves (those are an
     * existing `agent_list_market_records` MCP/CLI contract this part must not change -- plan §6).
     */
    async listTrendCandidatesWithFreshness(): Promise<{
      trendCandidates: (MarketTrendCandidate & { freshness: "fresh" | "needs_attention" })[];
    }> {
      const { trendCandidates } = await services.listTrendCandidates();
      const now = deps.clock.now();
      const withFreshness = trendCandidates.map((candidate) => {
        const ageMs = now.getTime() - new Date(candidate.lastObservedAt).getTime();
        const freshness: "fresh" | "needs_attention" =
          ageMs >= TREND_EVIDENCE_FRESH_WINDOW_DAYS * MS_PER_DAY ? "needs_attention" : "fresh";
        return { ...candidate, freshness };
      });
      return parseWithSchema(
        listTrendCandidatesWithFreshnessOutputSchema,
        { trendCandidates: withFreshness },
        "list trend candidates with freshness output"
      );
    },

    /**
     * Changes a trend candidate's lifecycle status. Requires a `reason` (schema-enforced), which is
     * written as a `signal`-type evidence row in this SAME action (advisor review, before
     * implementation: "every status change should require a reason, written as a signal evidence
     * row in the same action") -- a status can never move without a corresponding evidence trail
     * explaining why.
     */
    async updateTrendCandidateStatus(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketTrendCandidate> {
      const parsedInput = parseWithSchema(
        updateTrendCandidateStatusInputSchema,
        input,
        "update trend candidate status input"
      );

      const candidate = await deps.getMarketTrendCandidateById(parsedInput.trendCandidateId);
      if (!candidate) {
        throw new DomainError({
          code: "TREND_CANDIDATE_NOT_FOUND",
          message: "No trend candidate with this id",
          details: { trendCandidateId: parsedInput.trendCandidateId },
        });
      }

      // Single transaction (`updateMarketTrendCandidateStatusWithEvidence`) -- neither write-order of two
      // separate writes is safe: evidence-then-status can leave a false "status changed" narrative
      // if the status write then fails, and status-then-evidence can leave a real status change
      // with no evidence trail if the evidence write then fails, contradicting this table's own "a
      // status can never move without a corresponding evidence trail" invariant (found by
      // independent review). A transaction makes both failure modes moot.
      await deps.updateMarketTrendCandidateStatusWithEvidence(
        parsedInput.trendCandidateId,
        parsedInput.status,
        deps.clock.now(),
        {
          id: deps.idGenerator(),
          description: `Status changed to "${parsedInput.status}": ${parsedInput.reason}`,
          createdVia: callOrigin.createdVia,
        }
      );

      const row = (await deps.getMarketTrendCandidateById(parsedInput.trendCandidateId))!;
      return parseWithSchema(marketTrendCandidateSchema, toMarketTrendCandidate(row), "update trend candidate status output");
    },

    /**
     * Records an additional observation against an existing trend candidate without changing its
     * status (e.g. another supporting channel/video, or a plain signal note).
     */
    async recordTrendEvidence(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketTrendEvidence> {
      const parsedInput = parseWithSchema(recordTrendEvidenceInputSchema, input, "record trend evidence input");

      const candidate = await deps.getMarketTrendCandidateById(parsedInput.trendCandidateId);
      if (!candidate) {
        throw new DomainError({
          code: "TREND_CANDIDATE_NOT_FOUND",
          message: "No trend candidate with this id",
          details: { trendCandidateId: parsedInput.trendCandidateId },
        });
      }

      const id = deps.idGenerator();
      await deps.insertMarketTrendEvidence({
        id,
        trendCandidateId: parsedInput.trendCandidateId,
        evidenceType: parsedInput.evidenceType,
        referenceId: parsedInput.evidenceType === "signal" ? null : parsedInput.referenceId,
        description: parsedInput.description,
        createdVia: callOrigin.createdVia,
      });
      await deps.touchMarketTrendCandidateLastObservedAt(parsedInput.trendCandidateId, deps.clock.now());

      const rows = await deps.listTrendEvidence(parsedInput.trendCandidateId);
      // Guaranteed to exist -- this call itself just inserted it.
      const row = rows.find((candidate) => candidate.id === id)!;
      return parseWithSchema(recordTrendEvidenceOutputSchema, toMarketTrendEvidence(row), "record trend evidence output");
    },

    // Named `getTrendEvidence`, not `listTrendEvidence`, so a future external caller of this
    // exported action never has to spell out the exact same substring as the db.ts symbol it wraps
    // -- the same class of collision `listResearchRequests`/`listTopicAssignments` were already
    // renamed to avoid (found the hard way: this name tripped PHASE9-INV-02 once its own list was
    // widened to include it, even though the only current references were this file's own doc
    // comments describing it, not a real external call -- renamed proactively rather than leaving
    // the identical landmine for whoever adds the next one).
    async getTrendEvidence(input: unknown): Promise<{ evidence: MarketTrendEvidence[] }> {
      const parsedInput = parseWithSchema(listTrendEvidenceInputSchema, input, "list trend evidence input");

      const candidate = await deps.getMarketTrendCandidateById(parsedInput.trendCandidateId);
      if (!candidate) {
        throw new DomainError({
          code: "TREND_CANDIDATE_NOT_FOUND",
          message: "No trend candidate with this id",
          details: { trendCandidateId: parsedInput.trendCandidateId },
        });
      }

      const rows = await deps.listTrendEvidence(parsedInput.trendCandidateId);
      return parseWithSchema(
        listTrendEvidenceOutputSchema,
        { evidence: rows.map(toMarketTrendEvidence) },
        "list trend evidence output"
      );
    },

    /**
     * Phase 9 slice 9H, part A -- a UI-only wrapper around the sibling action just above closing
     * owner spec §30's "latest evidence"/"independent channels" gaps (plan §6). That sibling's own
     * ascending order is unchanged -- confirmed by grep to have no MCP/CLI caller today, so this
     * wrapper's own newest-first order is a new, separate contract, not a change to an existing one.
     * The independent-channel count is real deduplication logic (not a trivial filter), which is why
     * it lives here rather than in the component -- this repo has no component-level tests
     * (`docs/TECHNICAL_DEBT.md` RISK-05), so logic that needs a test must live in `services.ts`.
     */
    async getTrendEvidenceSummary(input: unknown): Promise<{
      evidence: MarketTrendEvidence[];
      independentChannelCount: number;
    }> {
      const { evidence } = await services.getTrendEvidence(input);
      const independentChannelCount = new Set(
        evidence
          .filter((e): e is MarketTrendEvidence & { referenceId: string } => e.evidenceType === "supporting_channel" && e.referenceId !== null)
          .map((e) => e.referenceId)
      ).size;

      return parseWithSchema(
        getTrendEvidenceSummaryOutputSchema,
        { evidence: [...evidence].reverse(), independentChannelCount },
        "get trend evidence summary output"
      );
    },

    /**
     * Phase 9 slice 9G, part B (owner spec §29) -- an agent-created DRAFT, never self-approving.
     * `createdVia`/`agentApiVersion` are SERVER-STAMPED (owner spec §22), mirrors
     * `content-proposals`' `createContentProposal` exactly. Always inserts `status: "pending"`.
     * Makes zero YouTube calls and writes zero quota-ledger rows -- this is pure local bookkeeping;
     * no quota is spent until a human approves via the Web UI. This action never calls, and has no
     * way to call, `approveMarketResearchRequest`/`rejectMarketResearchRequest` below -- no MCP tool
     * or CLI command anywhere in this codebase does either (verified mechanically, see this
     * module's own approval inventory test).
     */
    async createMarketResearchRequest(
      input: unknown,
      callOrigin: { createdVia: CreatedVia; agentApiVersion?: string | null }
    ): Promise<MarketResearchRequest> {
      const parsedInput = parseWithSchema(createMarketResearchRequestInputSchema, input, "create market research request input");

      const id = deps.idGenerator();
      await deps.insertMarketResearchRequest({
        id,
        query: parsedInput.query,
        rationale: parsedInput.rationale,
        monitorDurationDays: parsedInput.monitorDurationDays ?? null,
        createdVia: callOrigin.createdVia,
        agentApiVersion: callOrigin.agentApiVersion ?? null,
        at: deps.clock.now(),
      });

      const row = (await deps.getMarketResearchRequestById(id))!;
      return parseWithSchema(
        createMarketResearchRequestOutputSchema,
        toMarketResearchRequest(row),
        "create market research request output"
      );
    },

    // Named `listResearchRequests`, not `listMarketResearchRequests`, so a caller of this exported
    // action never has to spell out the exact same substring as the db.ts symbol it wraps --
    // PHASE9-INV-02's own plain-substring scan cannot otherwise tell "calls the exported core" apart
    // from "imports the raw db.ts function directly" (found the hard way: an earlier version of
    // this action shared its db.ts counterpart's exact name, which tripped that scanner from this
    // module's own Web UI route). Mirrors this file's own established convention elsewhere (e.g.
    // `listDiscoveryCandidates` here vs. `listMarketDiscoveryCandidates` in db.ts).
    async listResearchRequests(): Promise<{ requests: MarketResearchRequest[] }> {
      const rows = await deps.listMarketResearchRequests();
      return parseWithSchema(
        listMarketResearchRequestsOutputSchema,
        { requests: rows.map(toMarketResearchRequest) },
        "list market research requests output"
      );
    },

    async getMarketResearchRequest(input: unknown): Promise<MarketResearchRequest> {
      const parsedInput = parseWithSchema(getMarketResearchRequestInputSchema, input, "get market research request input");
      const row = await deps.getMarketResearchRequestById(parsedInput.requestId);
      if (!row) {
        throw new DomainError({
          code: "RESEARCH_REQUEST_NOT_FOUND",
          message: "No research request with this id",
          details: { requestId: parsedInput.requestId },
        });
      }
      return parseWithSchema(marketResearchRequestSchema, toMarketResearchRequest(row), "get market research request output");
    },

    /**
     * Web UI ONLY -- there is no MCP tool or CLI command anywhere that calls this action (verified
     * mechanically by this module's own approval inventory test). Sequence, corrected before
     * implementation (advisor review -- see this slice's own plan doc §4 for why the original
     * "transition first, run discovery second" order was wrong): (1) existence check via a plain
     * read: an unknown id fails fast, before any quota check runs; (2) the SAME upfront quota/reads
     * preconditions `discoverChannels` itself runs, so a missing/exhausted budget leaves this
     * request untouched (still `pending`), never permanently burned into a failure state by a
     * precondition that was never really about this one request; (3) one atomic conditional
     * transition (`pending -> approved`) -- a double-click or two-tab race can never approve (and
     * therefore never spend quota) twice; (4) only once that transition actually lands, the real
     * `discoverChannels` call, through its own existing budget/ledger/reads gate a second time
     * (cheap, intentional defense-in-depth against a race between step 2 and step 3); (5) the
     * outcome recorded back onto the row -- a downstream execution failure never un-approves the
     * request, since the approval itself already, genuinely happened.
     */
    async approveMarketResearchRequest(
      input: unknown,
      callOrigin: { createdVia: CreatedVia }
    ): Promise<MarketResearchRequest & { candidateIds?: string[] }> {
      const parsedInput = parseWithSchema(approveMarketResearchRequestInputSchema, input, "approve market research request input");

      const existing = await deps.getMarketResearchRequestById(parsedInput.requestId);
      if (!existing) {
        throw new DomainError({
          code: "RESEARCH_REQUEST_NOT_FOUND",
          message: "No research request with this id",
          details: { requestId: parsedInput.requestId },
        });
      }
      // Cheap, early, read-only diagnostic -- found by independent review: without this, an
      // already-resolved request with a missing/exhausted budget or a stale credential failed on
      // THAT precondition first, misreporting it as the reason approval couldn't proceed instead
      // of the real one. The atomic `approveMarketResearchRequestIfPending` call below remains the
      // actual source of truth for the real transition (this check has an inherent TOCTOU gap
      // against a concurrent change, same as any other pre-check in this function) -- this only
      // makes the common, non-racing case fail with the right error immediately.
      if (existing.status !== "pending") {
        throw new DomainError({
          code: "RESEARCH_REQUEST_NOT_PENDING",
          message: "This research request is no longer pending",
          details: { requestId: parsedInput.requestId },
        });
      }

      const now = deps.clock.now();
      await assertDiscoveryPreconditions(deps, now);
      // Resolved BEFORE the atomic transition too, not only inside `discoverChannels` below --
      // found by independent review: credential resolution spends no quota, so an expired refresh
      // token or a missing scope is exactly the same class of "precondition, not an execution
      // failure" as the budget/reads checks above. Without this, that failure would only surface
      // AFTER the transition, permanently landing the request in `execution_failed` instead of
      // leaving it `pending` for a retry once the credential issue is fixed.
      await deps.authResolver.resolve({ credentialRef: parsedInput.credentialRef, requiredScopes: [YOUTUBE_READ_SCOPE] });

      const approved = await deps.approveMarketResearchRequestIfPending(parsedInput.requestId, now);
      if (!approved) {
        throw new DomainError({
          code: "RESEARCH_REQUEST_NOT_PENDING",
          message: "This research request is no longer pending",
          details: { requestId: parsedInput.requestId },
        });
      }

      // Only the discovery call itself is inside this try/catch -- the "was the row still
      // 'approved' when we went to record its outcome" guard below must NOT be, since a `throw`
      // there would otherwise be immediately swallowed by this same catch (found by independent
      // code review: the guard fired but its result was discarded, and the function fell through
      // returning HTTP success as if approval had gone through normally).
      let discoveryResult: Awaited<ReturnType<typeof services.discoverChannels>>;
      try {
        // Reuses `discoverChannels`'s entire existing pipeline verbatim (its own upfront
        // precondition/credential checks run again here -- intentional, cheap defense-in-depth
        // against a race between this action's own pre-checks above and this exact call, per this
        // slice's own plan doc) -- never a second, parallel search/dedup/insert implementation.
        discoveryResult = await services.discoverChannels(
          { query: approved.query, credentialRef: parsedInput.credentialRef },
          callOrigin
        );
      } catch (error) {
        const failed = await deps.recordMarketResearchRequestExecutionOutcome(parsedInput.requestId, {
          status: "execution_failed",
          executionError: error instanceof Error ? error.message : String(error),
        });
        // Same discipline as the success path below, and the same reason: `null` here means the
        // row was no longer `"approved"` when we went to record discovery's own failure (e.g. a
        // concurrent reject already moved it) -- falling back to a plain read would silently
        // discard that fact and return whatever state the row is actually in as if this call had
        // succeeded (found by independent code review -- the identical swallowed-null shape as the
        // success path, just in this branch).
        if (!failed) {
          throw new DomainError({
            code: "RESEARCH_REQUEST_NOT_PENDING",
            message: "This research request was no longer 'approved' when its execution outcome was recorded",
            details: { requestId: parsedInput.requestId },
          });
        }
        return parseWithSchema(
          approveMarketResearchRequestOutputSchema,
          toMarketResearchRequest(failed),
          "approve market research request output"
        );
      }

      const executed = await deps.recordMarketResearchRequestExecutionOutcome(parsedInput.requestId, {
        status: "executed",
        candidatesFound: discoveryResult.candidatesFound,
        candidatesNew: discoveryResult.candidatesNew,
      });
      if (!executed) {
        throw new DomainError({
          code: "RESEARCH_REQUEST_NOT_PENDING",
          message: "This research request was no longer 'approved' when its execution outcome was recorded",
          details: { requestId: parsedInput.requestId },
        });
      }

      return parseWithSchema(
        approveMarketResearchRequestOutputSchema,
        // BL-145 (P4): the candidates the search produced, for the route to share with the requesting channel.
        { ...toMarketResearchRequest(executed), candidateIds: discoveryResult.candidateIds },
        "approve market research request output"
      );
    },

    async rejectMarketResearchRequest(input: unknown): Promise<MarketResearchRequest> {
      const parsedInput = parseWithSchema(rejectMarketResearchRequestInputSchema, input, "reject market research request input");

      const existing = await deps.getMarketResearchRequestById(parsedInput.requestId);
      if (!existing) {
        throw new DomainError({
          code: "RESEARCH_REQUEST_NOT_FOUND",
          message: "No research request with this id",
          details: { requestId: parsedInput.requestId },
        });
      }

      const rejected = await deps.rejectMarketResearchRequestIfPending(
        parsedInput.requestId,
        parsedInput.reason,
        deps.clock.now()
      );
      if (!rejected) {
        throw new DomainError({
          code: "RESEARCH_REQUEST_NOT_PENDING",
          message: "This research request is no longer pending",
          details: { requestId: parsedInput.requestId },
        });
      }

      return parseWithSchema(
        rejectMarketResearchRequestOutputSchema,
        toMarketResearchRequest(rejected),
        "reject market research request output"
      );
    },

    // ------------------------------------------------------------------------------------------
    // Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md).
    // ------------------------------------------------------------------------------------------

    /**
     * An agent-created (or operator-created) DRAFT asking for watchlist channels to be collected -- never self-approving. Makes ZERO
     * YouTube calls and writes no quota-ledger rows: the estimate is computed locally from the stored depth settings and stored video
     * counts. `channelIds` default to every watchlist channel (an agent-facing caller passes the already-confined list explicitly --
     * this module does not know about agent assignments, `AGENTS.md` §M). A channel is left out (and reported) when it was collected
     * inside the 24h stale window (`collected_recently`), failed inside the 24h pause (`recent_failure`), or already has an open
     * (pending/approved/running) request (`alreadyRequested`); when nothing is left, no record is created. No force flag exists.
     */
    async createCollectionRequest(
      input: unknown,
      callOrigin: { createdVia: CreatedVia; agentApiVersion?: string | null }
    ): Promise<CreateCollectionRequestResult> {
      const parsedInput = parseWithSchema(createCollectionRequestInputSchema, input, "create collection request input");

      const budget = await deps.getMarketIntelligenceDailyQuotaBudgetUnits();
      if (budget === null) {
        throw new DomainError({
          code: "MARKET_INTELLIGENCE_QUOTA_DISABLED",
          message: "Set a daily YouTube API unit budget in Settings before requesting a collection",
          details: {},
        });
      }

      const now = deps.clock.now();
      const watchlist = await deps.listResearchChannels();
      const byId = new Map(watchlist.map((row) => [row.id, row]));
      const requestedIds = parsedInput.researchChannelIds ? [...new Set(parsedInput.researchChannelIds)] : watchlist.map((row) => row.id);
      for (const id of requestedIds) {
        if (!byId.has(id)) {
          throw new DomainError({
            code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
            message: "No watchlist channel with this id",
            details: { channelId: id },
          });
        }
      }

      const staleCutoff = new Date(now.getTime() - MARKET_INTELLIGENCE_STALE_WINDOW_MS);
      const recentlyFailed = new Set(await deps.listRecentlyFailedResearchChannelIds(staleCutoff));
      const needed: string[] = [];
      const notNeeded: CollectionNotNeeded[] = [];
      const alreadyRequested: Array<{ channelId: string; requestId: string }> = [];
      for (const id of requestedIds) {
        const open = await deps.findOpenMarketCollectionRequestForChannel(id);
        if (open) {
          alreadyRequested.push({ channelId: id, requestId: open.id });
          continue;
        }
        const last = byId.get(id)?.lastAutoCollectedAt ?? null;
        if (last && last.getTime() >= staleCutoff.getTime()) {
          notNeeded.push({ channelId: id, reason: "collected_recently", hoursSince: roundedHours(last.getTime(), now.getTime()) });
          continue;
        }
        if (recentlyFailed.has(id)) {
          const latestRun = await deps.getLatestMarketIntelligenceCollectionRunForChannel(id);
          const failedAt = latestRun?.status === "failed" && latestRun.ranAt ? latestRun.ranAt : null;
          notNeeded.push({ channelId: id, reason: "recent_failure", hoursSince: failedAt ? roundedHours(failedAt.getTime(), now.getTime()) : 0 });
          continue;
        }
        needed.push(id);
      }

      if (needed.length === 0) {
        return parseWithSchema(
          createCollectionRequestOutputSchema,
          { created: false, request: null, notNeeded, alreadyRequested },
          "create collection request output"
        );
      }

      const depthDefaults = await deps.getMarketIntelligenceCollectionDepthDefaults();
      const channelEstimates: CollectionEstimate["channels"] = [];
      for (const id of needed) {
        const row = byId.get(id)!;
        const depth = resolveCollectionDepth(row, depthDefaults);
        const stored = new Set((await deps.listMarketVideoSnapshotsByChannel(id)).map((snapshot) => snapshot.videoId)).size;
        if (!needsBackfill(row, depth, stored)) {
          // Steady state: expected 1 channels.list + 1 playlist page = 2. Worst case: page 1 held new videos so page 2 is read too, and
          // each of the two pages falls back to one videos.list = 1 + 2 + 2 = 5 (STEADY_STATE_WORST_CASE_UNITS).
          channelEstimates.push({ channelId: id, mode: "incremental", expectedUnits: 2, worstCaseUnits: STEADY_STATE_WORST_CASE_UNITS });
          continue;
        }
        // A backfill reads page 1 (refresh) plus the pages for what is not stored yet. With no saved cursor it re-walks the stored pages
        // from page 1, so it is never cheaper than the cap's own page count. An upper bound -- a channel may have fewer videos than the cap.
        const resumesFromCursor = row.videosComplete === 0 && !!row.videosNextPageToken;
        const pages = Math.max(
          pagesForCap(Math.max(0, depth.maxVideosPerChannel - stored)) + 1,
          resumesFromCursor ? 0 : pagesForCap(depth.maxVideosPerChannel)
        );
        const units = estimateCollectionUnits(pages * PLAYLIST_PAGE_SIZE);
        channelEstimates.push({ channelId: id, mode: "backfill", expectedUnits: units.firstCollection, worstCaseUnits: units.firstCollectionWorstCase });
      }
      const spentToday = await deps.getMarketIntelligenceUnitsSpentSince(startOfQuotaDay(now));
      const remainingToday = Math.max(0, budget - spentToday);
      const totalWorstCaseUnits = channelEstimates.reduce((sum, e) => sum + e.worstCaseUnits, 0);
      const estimate: CollectionEstimate = {
        channels: channelEstimates,
        totalExpectedUnits: channelEstimates.reduce((sum, e) => sum + e.expectedUnits, 0),
        totalWorstCaseUnits,
        dailyBudgetUnits: budget,
        unitsSpentToday: spentToday,
        remainingTodayUnits: remainingToday,
        fitsToday: totalWorstCaseUnits <= remainingToday,
      };

      const id = deps.idGenerator();
      await deps.insertMarketCollectionRequest({
        id,
        channelIdsJson: JSON.stringify(needed),
        reason: parsedInput.reason?.trim() ?? "",
        estimateJson: JSON.stringify(estimate),
        createdVia: callOrigin.createdVia,
        agentApiVersion: callOrigin.agentApiVersion ?? null,
        at: now,
      });
      const row = (await deps.getMarketCollectionRequestById(id))!;
      return parseWithSchema(
        createCollectionRequestOutputSchema,
        { created: true, request: toMarketCollectionRequest(row), notNeeded, alreadyRequested },
        "create collection request output"
      );
    },

    /** The owner's own daily limits and what is left today (local read, no YouTube call). */
    async getCollectionLimits(): Promise<CollectionLimits> {
      const now = deps.clock.now();
      const budget = await deps.getMarketIntelligenceDailyQuotaBudgetUnits();
      const spentToday = await deps.getMarketIntelligenceUnitsSpentSince(startOfQuotaDay(now));
      const defaults = await deps.getMarketIntelligenceCollectionDepthDefaults();
      const watchlist = await deps.listResearchChannels();
      return parseWithSchema(
        collectionLimitsSchema,
        {
          dailyBudgetUnits: budget,
          unitsSpentToday: spentToday,
          remainingTodayUnits: budget === null ? null : Math.max(0, budget - spentToday),
          quotaDayResetsAt: nextYoutubeQuotaReset(now).toISOString(),
          defaultMaxVideosPerChannel: defaults.maxVideosPerChannel ?? DEFAULT_MAX_VIDEOS_PER_CHANNEL,
          defaultPublishedAfter: defaults.publishedAfter,
          staleWindowHours: MARKET_INTELLIGENCE_STALE_WINDOW_MS / 3_600_000,
          perChannelOverrides: watchlist
            .filter((row) => (row.maxVideosPerChannel ?? null) !== null || (row.publishedAfter ?? null) !== null)
            .map((row) => ({ channelId: row.id, maxVideosPerChannel: row.maxVideosPerChannel ?? null, publishedAfter: row.publishedAfter ?? null })),
        },
        "get collection limits output"
      );
    },

    async listCollectionRequests(): Promise<{ requests: MarketCollectionRequest[] }> {
      const rows = await deps.listMarketCollectionRequests();
      return parseWithSchema(
        listCollectionRequestsOutputSchema,
        { requests: rows.map(toMarketCollectionRequest) },
        "list collection requests output"
      );
    },

    async getCollectionRequest(input: unknown): Promise<MarketCollectionRequest> {
      const parsedInput = parseWithSchema(getCollectionRequestInputSchema, input, "get collection request input");
      const row = parsedInput.requestId ? await deps.getMarketCollectionRequestById(parsedInput.requestId) : null;
      if (!row) {
        throw new DomainError({
          code: "COLLECTION_REQUEST_NOT_FOUND",
          message: "No collection request with this id",
          details: { requestId: parsedInput.requestId ?? null },
        });
      }
      return parseWithSchema(marketCollectionRequestSchema, toMarketCollectionRequest(row), "get collection request output");
    },

    /**
     * Web UI ONLY -- no MCP tool or CLI command calls this (fenced by this module's approval inventory test). Order: (1) the request
     * must exist and be pending; (2) the zero-cost preconditions (budget set and not used up, Data API reads on, credentials resolve) run
     * BEFORE any transition, so a failure leaves the request pending; (3) atomic pending -> approved -> running (a double click or
     * two tabs can never both win); (4) the REGULAR collection (`collectStaleChannels`: same 24h stale window, same 24h failed-channel
     * pause, same daily budget) restricted to this request's channels -- never a forced run; (5) the per-channel outcome is recorded and
     * the request becomes done (or failed when the pass threw or every attempted channel failed). The caller waits for all of this.
     */
    async runApprovedCollectionRequest(input: unknown): Promise<MarketCollectionRequest> {
      const parsedInput = parseWithSchema(runApprovedCollectionRequestInputSchema, input, "run approved collection request input");
      const notFound = () =>
        new DomainError({
          code: "COLLECTION_REQUEST_NOT_FOUND",
          message: "No collection request with this id",
          details: { requestId: parsedInput.requestId },
        });
      const notPending = (message = "This collection request is no longer pending") =>
        new DomainError({ code: "COLLECTION_REQUEST_NOT_PENDING", message, details: { requestId: parsedInput.requestId } });

      const existing = await deps.getMarketCollectionRequestById(parsedInput.requestId);
      if (!existing) throw notFound();
      if (existing.status !== "pending") throw notPending();

      const now = deps.clock.now();
      const budget = await deps.getMarketIntelligenceDailyQuotaBudgetUnits();
      if (budget === null) {
        throw new DomainError({
          code: "MARKET_INTELLIGENCE_QUOTA_DISABLED",
          message: "Set a daily YouTube API unit budget in Settings before running a collection",
          details: {},
        });
      }
      const spentToday = await deps.getMarketIntelligenceUnitsSpentSince(startOfQuotaDay(now));
      if (budget - spentToday <= 0) {
        throw new DomainError({
          code: "MARKET_INTELLIGENCE_QUOTA_EXCEEDED",
          message: "The daily YouTube API unit budget is used up; it resets at midnight Pacific time. The request stays pending.",
          details: { remaining: 0 },
        });
      }
      await deps.youtubeApi.assertReadsAvailable();
      await deps.authResolver.resolve({ credentialRef: parsedInput.credentialRef, requiredScopes: [YOUTUBE_READ_SCOPE] });

      const credentialRef = parsedInput.credentialRef as CredentialRef;
      const approvedBy = "userId" in credentialRef ? credentialRef.userId : null;
      const approved = await deps.approveMarketCollectionRequestIfPending(parsedInput.requestId, approvedBy, now);
      if (!approved) throw notPending();
      const running = await deps.startMarketCollectionRequestIfApproved(parsedInput.requestId);
      if (!running) throw notPending("This collection request was no longer 'approved' when its run started");

      const channelIds = JSON.parse(running.channelIdsJson) as string[];
      let finished: StoredMarketCollectionRequestForService | null;
      const sink: CollectionRunSink = { channels: [], unitsSpent: 0, claimed: [] };
      try {
        const run = await collectStaleChannels({ credentialRef: parsedInput.credentialRef }, channelIds, sink);
        const resultJson = JSON.stringify(run.channels.map((c) => parseWithSchema(collectionChannelResultSchema, c, "collection channel result")));
        if (run.attempted > 0 && run.succeeded === 0 && run.failed === run.attempted) {
          finished = await deps.finishMarketCollectionRequestIfRunning(
            parsedInput.requestId,
            { status: "failed", resultJson, unitsSpentTotal: run.unitsSpent, error: `All ${run.failed} attempted channel(s) failed` },
            deps.clock.now()
          );
        } else {
          finished = await deps.finishMarketCollectionRequestIfRunning(
            parsedInput.requestId,
            { status: "done", resultJson, unitsSpentTotal: run.unitsSpent },
            deps.clock.now()
          );
        }
      } catch (error) {
        finished = await deps.finishMarketCollectionRequestIfRunning(
          parsedInput.requestId,
          {
            status: "failed",
            // What the run had charged and finished before it threw -- never a fabricated 0.
            resultJson: sink.channels.length > 0 ? JSON.stringify(sink.channels) : null,
            unitsSpentTotal: sink.unitsSpent,
            error: error instanceof Error ? error.message : String(error),
          },
          deps.clock.now()
        );
      }
      if (!finished) throw notPending("This collection request was no longer 'running' when its outcome was recorded");
      return parseWithSchema(marketCollectionRequestSchema, toMarketCollectionRequest(finished), "run approved collection request output");
    },

    /** Web UI ONLY. Rejects a pending request with the human's reason; collects nothing and makes no YouTube call. */
    async rejectCollectionRequest(input: unknown): Promise<MarketCollectionRequest> {
      const parsedInput = parseWithSchema(rejectCollectionRequestInputSchema, input, "reject collection request input");
      const existing = await deps.getMarketCollectionRequestById(parsedInput.requestId);
      if (!existing) {
        throw new DomainError({
          code: "COLLECTION_REQUEST_NOT_FOUND",
          message: "No collection request with this id",
          details: { requestId: parsedInput.requestId },
        });
      }
      const rejected = await deps.rejectMarketCollectionRequestIfPending(parsedInput.requestId, parsedInput.reason, deps.clock.now());
      if (!rejected) {
        throw new DomainError({
          code: "COLLECTION_REQUEST_NOT_PENDING",
          message: "This collection request is no longer pending",
          details: { requestId: parsedInput.requestId },
        });
      }
      return parseWithSchema(marketCollectionRequestSchema, toMarketCollectionRequest(rejected), "reject collection request output");
    },

    /**
     * Boot-time recovery (src/instrumentation.ts): every approved/running request approved before `approvedBefore` (default: now) is an
     * orphan of a dead process and becomes failed. At boot of the single server process no run can be alive, so boot passes no cutoff
     * (= now, no age threshold); the explicit argument only keeps the helper testable.
     */
    async sweepInterruptedCollectionRequests(input: { approvedBefore?: Date } = {}): Promise<{ failed: number }> {
      const now = deps.clock.now();
      const failed = await deps.failInterruptedMarketCollectionRequests(input.approvedBefore ?? now, now);
      return { failed };
    },
  };
  return services;
}

export type MarketIntelligenceServices = ReturnType<typeof createMarketIntelligenceServices>;
