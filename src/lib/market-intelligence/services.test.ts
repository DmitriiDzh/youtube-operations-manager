// ---------------------------------------------------------------------------
// Acceptance criteria derived from docs/roadmap/plans/PHASE_9_PLAN.md §7, written from the
// requirement before this file's own implementation was read line-by-line (AGENTS.md §L):
//
// AC-MI-01: an empty `reason` is rejected before it ever reaches storage.
// AC-MI-02: a `research_evidence` row always has a non-empty `source`/`observation`; missing
//           either is rejected before storage.
// AC-MI-03: `createdVia` cannot be supplied by the caller's own input -- it is SERVER-STAMPED via
//           a separate `callOrigin` parameter (mirrors `content-proposals`' `createContentProposal`
//           convention); an input payload that tries to smuggle it in through the public schema
//           is rejected outright (the schema is `.strict()`, no such field exists on it).
// AC-MI-04: adding a channel already on the watchlist is rejected
//           (RESEARCH_CHANNEL_ALREADY_WATCHED), never silently creating a second row or silently
//           overwriting the existing reason.
// AC-MI-05: recording evidence against a channel that isn't on the watchlist is rejected
//           (RESEARCH_CHANNEL_NOT_AVAILABLE).
// AC-MI-06: `channelId` must be a canonical YouTube channel id (`UC` + 22 chars) -- a bare
//           handle/URL/malformed id is rejected before storage (plan §8: handle resolution is a
//           later slice, never accepted as the primary key in this one).
// AC-MI-07: successful add/list/record/list-evidence round trips return the expected shape.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { BREAKOUT_MIN_BASELINE_SAMPLE_SIZE } from "./historical-intelligence";
import {
  CHANNEL_BASELINE_DAY_OFFSET,
  CHANNEL_VELOCITY_WINDOW_DAYS,
  RECENT_VIDEO_WINDOW_DAYS,
  createMarketIntelligenceServices,
  describePublicChannelSnapshot,
} from "./services";
import {
  DomainError,
  isDomainError,
  type DiscoveryCandidateStatus,
  type PublicChannelSearchResult,
  type PublicChannelStats,
  type PublicVideoSearchResult,
  type PublicChannelSnapshot,
  type PublicVideoSnapshot,
  type ResolvedCredentials,
  type TopicAssignmentSubjectType,
  type TrendCandidateStatus,
  type TrendEvidenceType,
} from "./contracts";

const VALID_CHANNEL_ID = "UC1234567890123456789012"; // "UC" + 22 chars, matches the schema regex
const OTHER_VALID_CHANNEL_ID = "UCabcdefghijklmnopqrstuv";
const THIRD_VALID_CHANNEL_ID = "UCzyxwvutsrqponmlkjihgfe";

type Row = {
  id: string;
  handleOrUrl: string | null;
  reason: string;
  createdVia: string;
  addedAt: Date;
  lastAutoCollectedAt: Date | null;
  collectionClaimedAt: Date | null;
  maxVideosPerChannel?: number | null;
  publishedAfter?: string | null;
  videosComplete?: number | null;
  videosCompleteReason?: string | null;
  videosNextPageToken?: string | null;
  videosCapAtRun?: number | null;
  videosPublishedAfterAtRun?: string | null;
};

type CollectionRunRow = {
  researchChannelId: string;
  status: "success" | "skipped_quota_limited" | "failed";
  unitsSpent: number;
  videosRequested: number | null;
  videosReturned: number | null;
  errorMessage: string | null;
  feedFallback?: boolean;
  ranAt: Date;
};

type DiscoveryCandidateRow = {
  id: string;
  title: string;
  status: DiscoveryCandidateStatus;
  discoverySource: string;
  discoveryQuery: string;
  reasonDiscovered: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdVia: string;
};

type DiscoveryRunRow = {
  query: string;
  status: "success" | "failed";
  unitsSpent: number;
  candidatesFound: number | null;
  candidatesNew: number | null;
  errorMessage: string | null;
  ranAt: Date;
};

type TopicRow = {
  id: string;
  name: string;
  createdVia: string;
  createdAt: Date;
};

type TopicAssignmentRow = {
  id: string;
  topicId: string;
  subjectType: TopicAssignmentSubjectType;
  subjectId: string;
  source: "manual" | "ai_assisted";
  createdVia: string;
  assignedAt: Date;
};

type EvidenceRow = {
  id: string;
  researchChannelId: string;
  observation: string;
  source: string;
  confidence: string | null;
  createdVia: string;
  collectedAt: Date;
};

type TrendCandidateRow = {
  id: string;
  title: string;
  description: string | null;
  topicId: string | null;
  status: TrendCandidateStatus;
  firstObservedAt: Date;
  lastObservedAt: Date;
  createdVia: string;
};

type TrendEvidenceRow = {
  id: string;
  trendCandidateId: string;
  evidenceType: TrendEvidenceType;
  referenceId: string | null;
  description: string;
  createdVia: string;
  recordedAt: Date;
};

type MarketResearchRequestRow = {
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

type CollectionRequestRow = {
  id: string;
  channelIdsJson: string;
  reason: string;
  status: "pending" | "approved" | "running" | "done" | "rejected" | "failed";
  estimateJson: string;
  createdVia: string;
  agentApiVersion: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  resultJson: string | null;
  unitsSpentTotal: number | null;
  error: string | null;
};

type ChannelSnapshotRow = {
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

type VideoSnapshotRow = {
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

function createFakeStore() {
  const channels = new Map<string, Row>();
  const evidence: EvidenceRow[] = [];
  const channelSnapshots: ChannelSnapshotRow[] = [];
  const videoSnapshots: VideoSnapshotRow[] = [];
  const collectionRuns: CollectionRunRow[] = [];
  const discoveryCandidates = new Map<string, DiscoveryCandidateRow>();
  const discoveryRuns: DiscoveryRunRow[] = [];
  const topics = new Map<string, TopicRow>();
  const topicAssignments: TopicAssignmentRow[] = [];
  const trendCandidates = new Map<string, TrendCandidateRow>();
  const trendEvidence: TrendEvidenceRow[] = [];
  const marketResearchRequests = new Map<string, MarketResearchRequestRow>();
  const collectionRequests = new Map<string, CollectionRequestRow>();
  let quotaBudget: number | null = null;
  let depthDefaults: { maxVideosPerChannel: number | null; publishedAfter: string | null } = { maxVideosPerChannel: null, publishedAfter: null };
  let nextId = 1;
  let failNextSuccessRunInsert = false;
  let failVideoSnapshotInsertAfter: number | null = null;
  let videoSnapshotInsertCount = 0;
  let failNextMark = false;
  let failNextFailedRunInsert = false;
  let failInsertMarketDiscoveryCandidateFor: string | null = null;
  let failNextGetResearchChannelByIdFor: string | null = null;
  let throwNextGetResearchChannelByIdFor: string | null = null;

  return {
    channels,
    evidence,
    channelSnapshots,
    videoSnapshots,
    collectionRuns,
    discoveryCandidates,
    topics,
    topicAssignments,
    trendCandidates,
    trendEvidence,
    marketResearchRequests,
    collectionRequests,
    discoveryRuns,
    setQuotaBudget(units: number | null) {
      quotaBudget = units;
    },
    // Test-only fault injection for AC-9B-14/15 below -- simulates a write throwing partway
    // through a real collection attempt, since a fake in-memory store otherwise never fails.
    failNextSuccessRunInsertOnce() {
      failNextSuccessRunInsert = true;
    },
    failVideoSnapshotInsertAfterNth(n: number) {
      failVideoSnapshotInsertAfter = n;
    },
    failNextFailedRunInsertOnce() {
      failNextFailedRunInsert = true;
    },
    failNextMarkOnce() {
      failNextMark = true;
    },
    failInsertMarketDiscoveryCandidateForChannel(channelId: string) {
      failInsertMarketDiscoveryCandidateFor = channelId;
    },
    // AC-9HB-11: simulates a channel removed between listWatchlist()'s own snapshot and a later
    // per-channel lookup for it (a real concurrent-removal race, not a store bug) -- returns `null`
    // exactly once for this channelId's NEXT getResearchChannelById call, without touching the
    // underlying Map (so listResearchChannels' own already-taken snapshot is unaffected, matching
    // what actually happens in a real request).
    failNextGetResearchChannelByIdOnce(channelId: string) {
      failNextGetResearchChannelByIdFor = channelId;
    },
    // AC-9HB-11b: a genuine, unrelated failure (e.g. a real DB error) from inside the per-channel
    // fetch -- unlike failNextGetResearchChannelByIdOnce above, this must NOT be swallowed by
    // getMarketOverview's own narrow catch (which only skips RESEARCH_CHANNEL_NOT_AVAILABLE).
    throwNextGetResearchChannelByIdOnce(channelId: string) {
      throwNextGetResearchChannelByIdFor = channelId;
    },
    idGenerator: () => `evidence-${nextId++}`,
    async insertResearchChannel(input: { id: string; handleOrUrl?: string | null; reason: string; createdVia: string }) {
      channels.set(input.id, {
        id: input.id,
        handleOrUrl: input.handleOrUrl ?? null,
        reason: input.reason,
        createdVia: input.createdVia,
        addedAt: new Date(),
        lastAutoCollectedAt: null,
        collectionClaimedAt: null,
      });
    },
    async listResearchChannels() {
      return [...channels.values()];
    },
    async getResearchChannelById(id: string) {
      if (throwNextGetResearchChannelByIdFor === id) {
        throwNextGetResearchChannelByIdFor = null;
        throw new Error("simulated getResearchChannelById failure");
      }
      if (failNextGetResearchChannelByIdFor === id) {
        failNextGetResearchChannelByIdFor = null;
        return null;
      }
      return channels.get(id) ?? null;
    },
    async deleteResearchChannel(id: string) {
      channels.delete(id);
      for (let i = evidence.length - 1; i >= 0; i--) {
        if (evidence[i].researchChannelId === id) evidence.splice(i, 1);
      }
    },
    async insertResearchEvidence(input: {
      id: string;
      researchChannelId: string;
      observation: string;
      source: string;
      confidence?: string | null;
      createdVia: string;
    }) {
      evidence.push({
        id: input.id,
        researchChannelId: input.researchChannelId,
        observation: input.observation,
        source: input.source,
        confidence: input.confidence ?? null,
        createdVia: input.createdVia,
        collectedAt: new Date(),
      });
    },
    async listResearchEvidenceByChannel(researchChannelId: string) {
      return evidence.filter((row) => row.researchChannelId === researchChannelId);
    },
    async insertMarketChannelSnapshot(input: {
      id: string;
      researchChannelId: string;
      subscriberCount?: number | null;
      viewCount?: number | null;
      videoCount?: number | null;
      hiddenSubscriberCount?: boolean;
      source: string;
      createdVia: string;
    }) {
      channelSnapshots.push({
        id: input.id,
        researchChannelId: input.researchChannelId,
        observedAt: new Date(),
        subscriberCount: input.subscriberCount ?? null,
        viewCount: input.viewCount ?? null,
        videoCount: input.videoCount ?? null,
        hiddenSubscriberCount: input.hiddenSubscriberCount ?? false,
        source: input.source,
        createdVia: input.createdVia,
      });
    },
    async listMarketChannelSnapshotsByChannel(researchChannelId: string) {
      return channelSnapshots.filter((row) => row.researchChannelId === researchChannelId);
    },
    async insertMarketVideoSnapshot(input: {
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
    }) {
      videoSnapshotInsertCount += 1;
      if (failVideoSnapshotInsertAfter !== null && videoSnapshotInsertCount > failVideoSnapshotInsertAfter) {
        throw new Error("simulated insertMarketVideoSnapshot failure");
      }
      videoSnapshots.push({
        id: input.id,
        researchChannelId: input.researchChannelId,
        videoId: input.videoId,
        observedAt: new Date(),
        viewCount: input.viewCount ?? null,
        likeCount: input.likeCount ?? null,
        commentCount: input.commentCount ?? null,
        publishedAt: input.publishedAt ?? null,
        title: input.title ?? null,
        durationSeconds: input.durationSeconds ?? null,
        liveBroadcastContent: input.liveBroadcastContent ?? null,
        source: input.source,
        createdVia: input.createdVia,
      });
    },
    async listMarketVideoSnapshotsByChannel(researchChannelId: string) {
      // Sorted ascending by observedAt, mirroring db.ts's own real ORDER BY -- found necessary by
      // independent code review: AC-9H-09's "last element is latest" assertion only proved anything
      // once this fake stopped relying on the fixture happening to push rows in chronological order.
      return videoSnapshots
        .filter((row) => row.researchChannelId === researchChannelId)
        .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    },
    // Phase 9 slice 9B -- mirrors db.ts's own atomic-claim semantics closely enough for a
    // single-threaded test (the real atomicity is proven against the actual SQLite driver in
    // db.test.ts, AGENTS.md §L -- a fake in-memory store can only prove the fake is
    // self-consistent, never that a real concurrent UPDATE is genuinely a compare-and-swap).
    async getMarketIntelligenceDailyQuotaBudgetUnits() {
      return quotaBudget;
    },
    async setMarketIntelligenceDailyQuotaBudgetUnits(units: number | null) {
      quotaBudget = units;
    },
    // Operator request 2026-10-04 -- collection depth.
    async getMarketIntelligenceCollectionDepthDefaults() {
      return { ...depthDefaults };
    },
    async setMarketIntelligenceCollectionDepthDefaults(input: { maxVideosPerChannel: number | null; publishedAfter: string | null }) {
      depthDefaults = { ...input };
    },
    async setResearchChannelCollectionDepth(
      researchChannelId: string,
      input: { maxVideosPerChannel: number | null; publishedAfter: string | null }
    ) {
      const row = channels.get(researchChannelId);
      if (row) {
        row.maxVideosPerChannel = input.maxVideosPerChannel;
        row.publishedAfter = input.publishedAfter;
      }
    },
    async saveResearchChannelCollectionProgress(
      researchChannelId: string,
      input: {
        complete: boolean;
        completeReason: "exhausted" | "cap" | "date" | null;
        nextPageToken: string | null;
        capAtRun: number;
        publishedAfterAtRun: string | null;
      }
    ) {
      const row = channels.get(researchChannelId);
      if (row) {
        row.videosComplete = input.complete ? 1 : 0;
        row.videosCompleteReason = input.completeReason;
        row.videosNextPageToken = input.nextPageToken;
        row.videosCapAtRun = input.capAtRun;
        row.videosPublishedAfterAtRun = input.publishedAfterAtRun;
      }
    },
    // Sums BOTH tables -- mirrors db.ts's own real implementation exactly (one shared budget
    // across collection and discovery, not two independent ones).
    // Phase 13 slice 13.4: the shared 10k pool counts collection runs only; searches have their own
    // bucket and are counted below.
    async getMarketIntelligenceUnitsSpentSince(since: Date) {
      return (
        collectionRuns.filter((row) => row.ranAt.getTime() >= since.getTime()).reduce((sum, row) => sum + row.unitsSpent, 0) +
        // BL-145: a search's pool units count too (db.ts sums market_discovery_runs.pool_units_spent).
        discoveryRuns.filter((row) => row.ranAt.getTime() >= since.getTime()).reduce((sum, row) => sum + ((row as { poolUnitsSpent?: number | null }).poolUnitsSpent ?? 0), 0)
      );
    },
    async countMarketDiscoverySearchesSince(since: Date) {
      return discoveryRuns.filter((row) => row.ranAt.getTime() >= since.getTime()).length;
    },
    async claimStaleResearchChannelsForCollection(args: {
      now: Date;
      staleCutoff: Date;
      claimExpiryCutoff: Date;
      excludeResearchChannelIds: string[];
      onlyResearchChannelIds?: string[];
    }) {
      const claimed: string[] = [];
      for (const [id, row] of channels) {
        if (args.onlyResearchChannelIds && !args.onlyResearchChannelIds.includes(id)) continue;
        const isStale = row.lastAutoCollectedAt === null || row.lastAutoCollectedAt.getTime() < args.staleCutoff.getTime();
        const isUnclaimed =
          row.collectionClaimedAt === null || row.collectionClaimedAt.getTime() < args.claimExpiryCutoff.getTime();
        if (isStale && isUnclaimed && !args.excludeResearchChannelIds.includes(id)) {
          row.collectionClaimedAt = args.now;
          claimed.push(id);
        }
      }
      return claimed;
    },
    async renewResearchChannelCollectionClaims(ids: string[], expectedClaimedAt: Date, newClaimedAt: Date) {
      const renewed: string[] = [];
      for (const id of ids) {
        const row = channels.get(id);
        if (row?.collectionClaimedAt && row.collectionClaimedAt.getTime() === expectedClaimedAt.getTime()) {
          row.collectionClaimedAt = newClaimedAt;
          renewed.push(id);
        }
      }
      return renewed;
    },
    async releaseResearchChannelCollectionClaim(researchChannelId: string) {
      const row = channels.get(researchChannelId);
      if (row) row.collectionClaimedAt = null;
    },
    async listRecentlyFailedResearchChannelIds(since: Date) {
      const ids = new Set<string>();
      for (const row of collectionRuns) {
        if (row.status === "failed" && row.ranAt.getTime() >= since.getTime()) ids.add(row.researchChannelId);
      }
      return [...ids];
    },
    async markResearchChannelAutoCollected(researchChannelId: string, at: Date) {
      if (failNextMark) {
        failNextMark = false;
        throw new Error("simulated markResearchChannelAutoCollected failure");
      }
      const row = channels.get(researchChannelId);
      if (row) row.lastAutoCollectedAt = at;
    },
    async insertMarketIntelligenceCollectionRun(input: {
      researchChannelId: string;
      status: "success" | "skipped_quota_limited" | "failed";
      unitsSpent: number;
      videosRequested?: number | null;
      videosReturned?: number | null;
      errorMessage?: string | null;
      feedFallback?: boolean;
      ranAt?: Date;
    }) {
      if (failNextFailedRunInsert && input.status === "failed") {
        failNextFailedRunInsert = false;
        throw new Error("simulated failed-run insert failure");
      }
      if (failNextSuccessRunInsert && input.status === "success") {
        failNextSuccessRunInsert = false;
        throw new Error("simulated insertMarketIntelligenceCollectionRun failure");
      }
      collectionRuns.push({
        researchChannelId: input.researchChannelId,
        status: input.status,
        unitsSpent: input.unitsSpent,
        videosRequested: input.videosRequested ?? null,
        videosReturned: input.videosReturned ?? null,
        errorMessage: input.errorMessage ?? null,
        feedFallback: input.feedFallback ?? false,
        ranAt: input.ranAt ?? new Date(),
      });
    },
    // Phase 9 slice 9G, part A -- the most recent run for one channel, by ranAt desc.
    async getLatestMarketIntelligenceCollectionRunForChannel(researchChannelId: string) {
      const runsForChannel = collectionRuns
        .filter((row) => row.researchChannelId === researchChannelId)
        .sort((a, b) => b.ranAt.getTime() - a.ranAt.getTime());
      return runsForChannel[0] ?? null;
    },
    async hasSuccessfulMarketIntelligenceCollectionRun(researchChannelId: string) {
      return collectionRuns.some((row) => row.researchChannelId === researchChannelId && row.status === "success");
    },
    // Phase 9 slice 9C.
    async getMarketDiscoveryCandidateById(channelId: string) {
      return discoveryCandidates.get(channelId) ?? null;
    },
    async listMarketDiscoveryCandidates() {
      return [...discoveryCandidates.values()].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    },
    async insertMarketDiscoveryCandidate(input: {
      id: string;
      title: string;
      discoverySource: string;
      discoveryQuery: string;
      reasonDiscovered?: string | null;
      createdVia: string;
      seenAt: Date;
    }) {
      if (failInsertMarketDiscoveryCandidateFor === input.id) {
        throw new Error("simulated insertMarketDiscoveryCandidate failure");
      }
      // Mirrors db.ts: the search's own clock time, not this call's wall clock (BL-156).
      const now = input.seenAt;
      discoveryCandidates.set(input.id, {
        id: input.id,
        title: input.title,
        status: "new",
        discoverySource: input.discoverySource,
        discoveryQuery: input.discoveryQuery,
        reasonDiscovered: input.reasonDiscovered ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        createdVia: input.createdVia,
      });
    },
    async touchMarketDiscoveryCandidateLastSeen(channelId: string, at: Date, title: string, reasonDiscovered: string | null) {
      const row = discoveryCandidates.get(channelId);
      if (row) {
        row.lastSeenAt = at;
        row.title = title;
        row.reasonDiscovered = reasonDiscovered;
        // Mirrors db.ts: a refresh drops the older counts and match (BL-145 review).
        Object.assign(row, {
          subscriberCount: null,
          hiddenSubscriberCount: null,
          videoCount: null,
          viewCount: null,
          channelPublishedAt: null,
          statsObservedAt: null,
          matchQuery: null,
          matchVideoCount: null,
          matchViewCount: null,
        });
      }
    },
    async setMarketDiscoveryCandidateStats(
      channelId: string,
      stats: { subscriberCount: number | null; hiddenSubscriberCount: boolean; videoCount: number | null; viewCount: number | null; channelPublishedAt: string | null; observedAt: Date }
    ) {
      const row = discoveryCandidates.get(channelId) as Record<string, unknown> | undefined;
      if (row) Object.assign(row, { ...stats, statsObservedAt: stats.observedAt, observedAt: undefined });
    },
    async setMarketDiscoveryCandidateMatch(channelId: string, match: { query: string; videoCount: number; viewCount: number | null }) {
      const row = discoveryCandidates.get(channelId) as Record<string, unknown> | undefined;
      if (row) Object.assign(row, { matchQuery: match.query, matchVideoCount: match.videoCount, matchViewCount: match.viewCount });
    },
    async setMarketDiscoveryCandidateStatus(channelId: string, status: DiscoveryCandidateStatus) {
      const row = discoveryCandidates.get(channelId);
      if (row) row.status = status;
    },
    async insertMarketDiscoveryRun(input: {
      query: string;
      status: "success" | "failed";
      unitsSpent: number;
      candidatesFound?: number | null;
      candidatesNew?: number | null;
      errorMessage?: string | null;
      ranAt?: Date;
      poolUnitsSpent?: number | null;
    }) {
      discoveryRuns.push({
        query: input.query,
        status: input.status,
        unitsSpent: input.unitsSpent,
        ...(input.poolUnitsSpent !== undefined ? { poolUnitsSpent: input.poolUnitsSpent } : {}),
        candidatesFound: input.candidatesFound ?? null,
        candidatesNew: input.candidatesNew ?? null,
        errorMessage: input.errorMessage ?? null,
        ranAt: input.ranAt ?? new Date(),
      });
    },
    // Phase 9 slice 9E -- topic model, part A.
    async listMarketTopics() {
      return [...topics.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async getMarketTopicById(topicId: string) {
      return topics.get(topicId) ?? null;
    },
    async insertMarketTopic(input: { id: string; name: string; createdVia: string }) {
      topics.set(input.id, { id: input.id, name: input.name, createdVia: input.createdVia, createdAt: new Date() });
    },
    async deleteMarketTopic(topicId: string) {
      topics.delete(topicId);
      for (let i = topicAssignments.length - 1; i >= 0; i--) {
        if (topicAssignments[i].topicId === topicId) topicAssignments.splice(i, 1);
      }
    },
    async listAssignmentsForTopic(topicId: string) {
      return topicAssignments.filter((row) => row.topicId === topicId);
    },
    async listTopicsForSubject(subjectType: TopicAssignmentSubjectType, subjectId: string) {
      return topicAssignments.filter((row) => row.subjectType === subjectType && row.subjectId === subjectId);
    },
    async listMarketTopicAssignmentsBySubjectType(subjectType: TopicAssignmentSubjectType) {
      return topicAssignments.filter((row) => row.subjectType === subjectType);
    },
    async getTopicAssignment(topicId: string, subjectType: TopicAssignmentSubjectType, subjectId: string) {
      return (
        topicAssignments.find((row) => row.topicId === topicId && row.subjectType === subjectType && row.subjectId === subjectId) ?? null
      );
    },
    async insertMarketTopicAssignment(input: {
      id: string;
      topicId: string;
      subjectType: TopicAssignmentSubjectType;
      subjectId: string;
      source: "manual" | "ai_assisted";
      createdVia: string;
    }) {
      topicAssignments.push({
        id: input.id,
        topicId: input.topicId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        source: input.source,
        createdVia: input.createdVia,
        assignedAt: new Date(),
      });
    },
    async deleteMarketTopicAssignment(assignmentId: string) {
      const index = topicAssignments.findIndex((row) => row.id === assignmentId);
      if (index >= 0) topicAssignments.splice(index, 1);
    },
    // Phase 9 slice 9E -- trend candidates, part B.
    async listMarketTrendCandidates() {
      return [...trendCandidates.values()].sort((a, b) => a.firstObservedAt.getTime() - b.firstObservedAt.getTime());
    },
    async getMarketTrendCandidateById(trendCandidateId: string) {
      return trendCandidates.get(trendCandidateId) ?? null;
    },
    // Atomic (single-transaction, in the real db.ts) forms -- the fake store has no partial-write
    // failure mode of its own to simulate, but implements the same combined effect so
    // services.test.ts's own tests exercise the exact call shape `services.ts` now uses. Real
    // atomicity against libsql is proven in `db.test.ts`, not here.
    async insertMarketTrendCandidateWithInitialEvidence(
      candidate: { id: string; title: string; description?: string | null; topicId?: string | null; createdVia: string; at?: Date },
      initialEvidence: { id: string; evidenceType: TrendEvidenceType; referenceId?: string | null; description: string; createdVia: string }
    ) {
      const now = candidate.at ?? new Date();
      trendCandidates.set(candidate.id, {
        id: candidate.id,
        title: candidate.title,
        description: candidate.description ?? null,
        topicId: candidate.topicId ?? null,
        status: "emerging",
        firstObservedAt: now,
        lastObservedAt: now,
        createdVia: candidate.createdVia,
      });
      trendEvidence.push({
        id: initialEvidence.id,
        trendCandidateId: candidate.id,
        evidenceType: initialEvidence.evidenceType,
        referenceId: initialEvidence.referenceId ?? null,
        description: initialEvidence.description,
        createdVia: initialEvidence.createdVia,
        recordedAt: now,
      });
    },
    async updateMarketTrendCandidateStatusWithEvidence(
      trendCandidateId: string,
      status: TrendCandidateStatus,
      at: Date,
      evidence: { id: string; description: string; createdVia: string }
    ) {
      const row = trendCandidates.get(trendCandidateId);
      if (row) {
        row.status = status;
        row.lastObservedAt = at;
      }
      trendEvidence.push({
        id: evidence.id,
        trendCandidateId,
        evidenceType: "signal",
        referenceId: null,
        description: evidence.description,
        createdVia: evidence.createdVia,
        recordedAt: at,
      });
    },
    async touchMarketTrendCandidateLastObservedAt(trendCandidateId: string, at: Date) {
      const row = trendCandidates.get(trendCandidateId);
      if (row) row.lastObservedAt = at;
    },
    async listTrendEvidence(trendCandidateId: string) {
      return trendEvidence.filter((row) => row.trendCandidateId === trendCandidateId);
    },
    async insertMarketTrendEvidence(input: {
      id: string;
      trendCandidateId: string;
      evidenceType: TrendEvidenceType;
      referenceId?: string | null;
      description: string;
      createdVia: string;
    }) {
      trendEvidence.push({
        id: input.id,
        trendCandidateId: input.trendCandidateId,
        evidenceType: input.evidenceType,
        referenceId: input.referenceId ?? null,
        description: input.description,
        createdVia: input.createdVia,
        recordedAt: new Date(),
      });
    },
    // Phase 9 slice 9G, part B.
    async insertMarketResearchRequest(input: {
      id: string;
      query: string;
      rationale: string;
      monitorDurationDays?: number | null;
      createdVia: string;
      agentApiVersion?: string | null;
      at?: Date;
    }) {
      marketResearchRequests.set(input.id, {
        id: input.id,
        query: input.query,
        rationale: input.rationale,
        monitorDurationDays: input.monitorDurationDays ?? null,
        status: "pending",
        createdVia: input.createdVia,
        agentApiVersion: input.agentApiVersion ?? null,
        createdAt: input.at ?? new Date(),
        resolvedAt: null,
        resolvedReason: null,
        candidatesFound: null,
        candidatesNew: null,
        executionError: null,
      });
    },
    async getMarketResearchRequestById(id: string) {
      return marketResearchRequests.get(id) ?? null;
    },
    async listMarketResearchRequests() {
      return [...marketResearchRequests.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    // Mirrors the real db.ts function's atomic `WHERE status='pending'` guard -- this fake store
    // has no real concurrency of its own, but must still refuse a second transition once a row is
    // no longer pending, so tests exercising the race's OUTCOME (not its true atomicity, which is
    // proven separately against real libsql in db.test.ts) behave correctly.
    async approveMarketResearchRequestIfPending(id: string, at: Date) {
      const row = marketResearchRequests.get(id);
      if (!row || row.status !== "pending") return null;
      row.status = "approved";
      row.resolvedAt = at;
      return row;
    },
    async rejectMarketResearchRequestIfPending(id: string, reason: string, at: Date) {
      const row = marketResearchRequests.get(id);
      if (!row || row.status !== "pending") return null;
      row.status = "rejected";
      row.resolvedAt = at;
      row.resolvedReason = reason;
      return row;
    },
    // Mirrors the real db.ts function's own `WHERE status='approved'` guard -- found by
    // independent review: without it, this function could move a request straight from "pending"
    // to "executed"/"execution_failed", completely bypassing the approval gate.
    async recordMarketResearchRequestExecutionOutcome(
      id: string,
      outcome:
        | { status: "executed"; candidatesFound: number; candidatesNew: number }
        | { status: "execution_failed"; executionError: string }
    ) {
      const row = marketResearchRequests.get(id);
      if (!row || row.status !== "approved") return null;
      if (outcome.status === "executed") {
        row.status = "executed";
        row.candidatesFound = outcome.candidatesFound;
        row.candidatesNew = outcome.candidatesNew;
      } else {
        row.status = "execution_failed";
        row.executionError = outcome.executionError;
      }
      return row;
    },
    // Agent-created collection requests -- the same atomic WHERE-status guards as db.ts (real atomicity is proven in db.test.ts).
    async insertMarketCollectionRequest(input: {
      id: string;
      channelIdsJson: string;
      reason: string;
      estimateJson: string;
      createdVia: string;
      agentApiVersion?: string | null;
      at?: Date;
    }) {
      collectionRequests.set(input.id, {
        id: input.id,
        channelIdsJson: input.channelIdsJson,
        reason: input.reason,
        status: "pending",
        estimateJson: input.estimateJson,
        createdVia: input.createdVia,
        agentApiVersion: input.agentApiVersion ?? null,
        createdAt: input.at ?? new Date(),
        approvedAt: null,
        approvedByUserId: null,
        resolvedAt: null,
        resolvedReason: null,
        resultJson: null,
        unitsSpentTotal: null,
        error: null,
      });
    },
    async getMarketCollectionRequestById(id: string) {
      return collectionRequests.get(id) ?? null;
    },
    async listMarketCollectionRequests() {
      return [...collectionRequests.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async findOpenMarketCollectionRequestForChannel(channelId: string) {
      for (const row of collectionRequests.values()) {
        if (["pending", "approved", "running"].includes(row.status) && (JSON.parse(row.channelIdsJson) as string[]).includes(channelId)) return row;
      }
      return null;
    },
    async approveMarketCollectionRequestIfPending(id: string, approvedByUserId: string | null, at: Date) {
      const row = collectionRequests.get(id);
      if (!row || row.status !== "pending") return null;
      row.status = "approved";
      row.approvedAt = at;
      row.approvedByUserId = approvedByUserId;
      return row;
    },
    async startMarketCollectionRequestIfApproved(id: string) {
      const row = collectionRequests.get(id);
      if (!row || row.status !== "approved") return null;
      row.status = "running";
      return row;
    },
    async rejectMarketCollectionRequestIfPending(id: string, reason: string, at: Date) {
      const row = collectionRequests.get(id);
      if (!row || row.status !== "pending") return null;
      row.status = "rejected";
      row.resolvedAt = at;
      row.resolvedReason = reason;
      return row;
    },
    async finishMarketCollectionRequestIfRunning(
      id: string,
      outcome:
        | { status: "done"; resultJson: string; unitsSpentTotal: number }
        | { status: "failed"; resultJson: string | null; unitsSpentTotal: number; error: string },
      at: Date
    ) {
      const row = collectionRequests.get(id);
      if (!row || row.status !== "running") return null;
      row.status = outcome.status;
      row.resolvedAt = at;
      row.resultJson = outcome.resultJson;
      row.unitsSpentTotal = outcome.unitsSpentTotal;
      if (outcome.status === "failed") row.error = outcome.error;
      return row;
    },
    async failInterruptedMarketCollectionRequests(approvedBefore: Date, at: Date) {
      let n = 0;
      for (const row of collectionRequests.values()) {
        if ((row.status === "approved" || row.status === "running") && row.approvedAt && row.approvedAt.getTime() < approvedBefore.getTime()) {
          row.status = "failed";
          row.resolvedAt = at;
          row.error = "interrupted";
          n += 1;
        }
      }
      return n;
    },
  };
}

function createFixture(overrides?: {
  publicSnapshot?: PublicChannelSnapshot | null;
  resolveError?: Error;
  now?: Date;
  getPublicChannelSnapshotImpl?: (args: {
    credentials: ResolvedCredentials;
    channelId: string;
  }) => Promise<PublicChannelSnapshot | null>;
  uploadsPlaylistVideoIds?: string[];
  publicVideoSnapshots?: PublicVideoSnapshot[];
  searchResults?: PublicChannelSearchResult[];
  /** BL-145: what the genre search (music videos) returns. */
  musicVideos?: PublicVideoSearchResult[];
  /** BL-145: what channels.list returns for the found channels; a function lets a test fail it. */
  channelStats?: PublicChannelStats[] | (() => Promise<PublicChannelStats[]>);
  searchImpl?: (args: { credentials: ResolvedCredentials; query: string }) => Promise<PublicChannelSearchResult[]>;
  dataApiReadsDisabled?: boolean;
  /** Phase 13 slices 13.5/13.6. Unset = the RSS feed / batchGetStats are unavailable (they throw), so
   * every pre-Phase-13 test exercises the original quota-spending path as the fallback. */
  feedVideos?: { videoId: string; title: string; publishedAt: string | null }[];
  batchStats?: PublicVideoSnapshot[];
  playlistFails?: boolean;
  playlistTitles?: Record<string, string>;
  /** Operator request 2026-10-04: a paged uploads playlist (page N has token `page-N`; the first page has none). Overrides `uploadsPlaylistVideoIds`. */
  playlistPages?: string[][];
  playlistPublishedAt?: Record<string, string>;
  /** Calls with these page tokens throw (a rejected/expired cursor). */
  rejectedPageTokens?: string[];
  /** "batch": videos.batchGetStats answers for any requested ids; "list": batch throws and videos.list answers for any ids. */
  autoStats?: "batch" | "list";
  /** FO-REQ-0015 item 4: makes the details read (videos.list after a successful batch) fail, or answer with given details. */
  detailsError?: () => Error | null;
  detailsFor?: (videoId: string) => { durationSeconds: number | null; liveBroadcastContent: string | null };
}) {
  const store = createFakeStore();
  const feedCalls: unknown[] = [];
  const batchStatsCalls: unknown[] = [];
  const musicChartCalls: unknown[] = [];
  const resolveCalls: unknown[] = [];
  const snapshotCalls: unknown[] = [];
  const playlistCalls: unknown[] = [];
  const videoSnapshotCalls: unknown[] = [];
  const searchCalls: unknown[] = [];
  const channelStatsCalls: Array<{ channelIds: string[] }> = [];
  const musicVideoSearchCalls: Array<{ query: string; publishedAfter: string | null }> = [];
  const assertReadsAvailableCalls: undefined[] = [];
  let currentNow = overrides?.now ?? new Date();
  let currentPlaylistPages = overrides?.playlistPages;
  let currentRejectedTokens = overrides?.rejectedPageTokens;
  const services = createMarketIntelligenceServices({
    ...store,
    clock: { now: () => currentNow },
    authResolver: {
      async resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }) {
        resolveCalls.push(args);
        if (overrides?.resolveError) throw overrides.resolveError;
        return { accessToken: "fake-access-token", refreshToken: "fake-refresh-token" } as ResolvedCredentials;
      },
    },
    youtubeApi: {
      async getPublicChannelSnapshot(args: { credentials: ResolvedCredentials; channelId: string }) {
        snapshotCalls.push(args);
        if (overrides?.getPublicChannelSnapshotImpl) return overrides.getPublicChannelSnapshotImpl(args);
        return overrides?.publicSnapshot !== undefined
          ? overrides.publicSnapshot
          : {
              channelId: args.channelId,
              title: "Fetched Channel",
              subscriberCount: 100,
              hiddenSubscriberCount: false,
              viewCount: 200,
              videoCount: 3,
              uploadsPlaylistId: null,
            };
      },
      async listUploadsPlaylistPage(args: { credentials: ResolvedCredentials; uploadsPlaylistId: string; pageToken?: string }) {
        playlistCalls.push(args);
        if (overrides?.playlistFails) throw new Error("playlistItems failed (test)");
        if (args.pageToken && currentRejectedTokens?.includes(args.pageToken)) throw new Error("invalid pageToken (test)");
        const pages = currentPlaylistPages ?? [overrides?.uploadsPlaylistVideoIds ?? []];
        const index = args.pageToken ? Number(args.pageToken.replace("page-", "")) - 1 : 0;
        const ids = pages[index];
        if (!ids) throw new Error("no such page (test)");
        return {
          items: ids.map((videoId) => ({
            videoId,
            title: overrides?.playlistTitles?.[videoId] ?? "",
            publishedAt: overrides?.playlistPublishedAt?.[videoId] ?? null,
          })),
          nextPageToken: index + 1 < pages.length ? `page-${index + 2}` : null,
        };
      },
      async getPublicVideoSnapshots(args: { credentials: ResolvedCredentials; videoIds: string[] }) {
        videoSnapshotCalls.push(args);
        if (overrides?.autoStats === "list") {
          return args.videoIds.map((videoId) => ({ videoId, title: "", publishedAt: null, viewCount: 1, likeCount: 1, commentCount: 1 }));
        }
        // FO-REQ-0015 item 4: with batchGetStats answering, videos.list is the details read. Like the real videos.list
        // (part snippet,contentDetails,statistics), it answers for every requested public video with its duration and live
        // status -- what batchGetStats does not return.
        if (overrides?.autoStats === "batch") {
          const failure = overrides.detailsError?.();
          if (failure) throw failure;
          return args.videoIds.map((videoId) => ({
            videoId,
            title: "",
            publishedAt: null,
            viewCount: 1,
            likeCount: 1,
            commentCount: 1,
            ...(overrides.detailsFor ? overrides.detailsFor(videoId) : { durationSeconds: 600, liveBroadcastContent: "none" }),
          }));
        }
        return overrides?.publicVideoSnapshots ?? [];
      },
      async getMostPopularMusicVideos(args: { credentials: ResolvedCredentials; regionCode: string }) {
        musicChartCalls.push(args);
        return [
          { rank: 1, videoId: "m1", title: "Song", channelId: "UCx", channelTitle: "Artist", viewCount: 5, publishedAt: null },
        ];
      },
      async listChannelFeedVideoIds(args: { channelId: string }) {
        feedCalls.push(args);
        if (!overrides?.feedVideos) throw new Error("RSS feed unavailable (test default)");
        return overrides.feedVideos;
      },
      async getPublicVideoStatsBatch(args: { credentials: ResolvedCredentials; videoIds: string[] }) {
        batchStatsCalls.push(args);
        if (overrides?.autoStats === "batch") {
          return args.videoIds.map((videoId) => ({ videoId, title: "", publishedAt: null, viewCount: 1, likeCount: 1, commentCount: 1 }));
        }
        if (overrides?.autoStats === "list") throw new Error("batchGetStats unavailable (test)");
        if (!overrides?.batchStats) throw new Error("batchGetStats unavailable (test default)");
        return overrides.batchStats;
      },
      async searchPublicMusicVideos(args: { credentials: ResolvedCredentials; query: string; publishedAfter: string | null }) {
        musicVideoSearchCalls.push({ query: args.query, publishedAfter: args.publishedAfter });
        return overrides?.musicVideos ?? [];
      },
      async getPublicChannelStats(args: { credentials: ResolvedCredentials; channelIds: string[] }) {
        channelStatsCalls.push({ channelIds: args.channelIds });
        const configured = overrides?.channelStats;
        return typeof configured === "function" ? configured() : (configured ?? []);
      },
      async searchPublicChannels(args: { credentials: ResolvedCredentials; query: string }) {
        searchCalls.push(args);
        if (overrides?.searchImpl) return overrides.searchImpl(args);
        return overrides?.searchResults ?? [];
      },
      async assertReadsAvailable() {
        assertReadsAvailableCalls.push(undefined);
        if (overrides?.dataApiReadsDisabled) {
          throw new DomainError({ code: "data_api_reads_disabled", message: "YouTube Data API v3 reads are disabled" });
        }
      },
    },
  });
  return {
    store,
    services,
    resolveCalls,
    snapshotCalls,
    playlistCalls,
    videoSnapshotCalls,
    searchCalls,
    channelStatsCalls,
    musicVideoSearchCalls,
    assertReadsAvailableCalls,
    feedCalls,
    batchStatsCalls,
    musicChartCalls,
    setNow(date: Date) {
      currentNow = date;
    },
    currentNow() {
      return currentNow;
    },
    setPlaylistPages(pages: string[][]) {
      currentPlaylistPages = pages;
    },
    setRejectedPageTokens(tokens: string[]) {
      currentRejectedTokens = tokens;
    },
  };
}

test("AC-MI-01: addToWatchlist rejects an empty reason before storage", async () => {
  const { store, services } = createFixture();

  await assert.rejects(
    () => services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "" }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(store.channels.size, 0);
});

test("AC-MI-02: recordEvidence rejects a missing observation/source before storage", async () => {
  const { store, services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Competitor in the same niche" }, { createdVia: "web_ui" });

  await assert.rejects(
    () =>
      services.recordEvidence(
        { researchChannelId: VALID_CHANNEL_ID, observation: "", source: "manual observation" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  await assert.rejects(
    () =>
      services.recordEvidence(
        { researchChannelId: VALID_CHANNEL_ID, observation: "Had 10k subscribers", source: "" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(store.evidence.length, 0);
});

test("AC-MI-03: createdVia cannot be smuggled in through the public input -- it is server-stamped only", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () =>
      services.addToWatchlist(
        { channelId: VALID_CHANNEL_ID, reason: "Test", createdVia: "mcp" } as unknown,
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );

  // The one legitimate way createdVia is set: the second, separate callOrigin parameter.
  const created = await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Test" }, { createdVia: "cli" });
  assert.equal(created.channelId, VALID_CHANNEL_ID);
});

test("AC-MI-04: adding a channel already on the watchlist is rejected, never silently duplicated or overwritten", async () => {
  const { store, services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Original reason" }, { createdVia: "web_ui" });

  await assert.rejects(
    () => services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Different reason" }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_ALREADY_WATCHED"
  );

  assert.equal(store.channels.size, 1);
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.reason, "Original reason");
});

test("AC-MI-05: recording evidence against a channel not on the watchlist is rejected", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () =>
      services.recordEvidence(
        { researchChannelId: VALID_CHANNEL_ID, observation: "Had 10k subscribers", source: "manual observation" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

test("AC-MI-06: channelId must be a canonical YouTube channel id, not a bare handle/URL", async () => {
  const { services } = createFixture();

  for (const badId of ["@somehandle", "https://youtube.com/@somehandle", "not-a-channel-id", ""]) {
    await assert.rejects(
      () => services.addToWatchlist({ channelId: badId, reason: "Test" }, { createdVia: "web_ui" }),
      (error: unknown) => isDomainError(error) && error.code === "validation_failed"
    );
  }
});

test("AC-MI-07: add/list/record/list-evidence round trips return the expected shape", async () => {
  const { services } = createFixture();

  const added = await services.addToWatchlist(
    { channelId: VALID_CHANNEL_ID, handleOrUrl: "@example", reason: "Fast-growing in the same niche" },
    { createdVia: "web_ui" }
  );
  // BL-163 (FO-REQ-0014 §A): every entry now carries its activity -- a new entry has no known upload and is not paused.
  assert.deepEqual(added, {
    channelId: VALID_CHANNEL_ID,
    handleOrUrl: "@example",
    reason: "Fast-growing in the same niche",
    addedAt: added.addedAt,
    latestUploadPublishedAt: null,
    inactive: false,
    pausedAt: null,
    pausedReason: null,
  });

  const list = await services.listWatchlist();
  assert.equal(list.channels.length, 1);
  assert.equal(list.channels[0].channelId, VALID_CHANNEL_ID);

  const fetched = await services.getWatchlistEntry({ channelId: VALID_CHANNEL_ID });
  assert.deepEqual(fetched, added);

  const evidence = await services.recordEvidence(
    { researchChannelId: VALID_CHANNEL_ID, observation: "Published 3 videos this week", source: "manual observation", confidence: "high" },
    { createdVia: "web_ui" }
  );
  assert.equal(evidence.researchChannelId, VALID_CHANNEL_ID);
  assert.equal(evidence.confidence, "high");

  const evidenceList = await services.listEvidence({ researchChannelId: VALID_CHANNEL_ID });
  assert.equal(evidenceList.evidence.length, 1);
  assert.deepEqual(evidenceList.evidence[0], evidence);
});

test("AC-MI-08: getWatchlistEntry/listEvidence for an unknown channel report RESEARCH_CHANNEL_NOT_AVAILABLE", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.getWatchlistEntry({ channelId: OTHER_VALID_CHANNEL_ID }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  await assert.rejects(
    () => services.listEvidence({ researchChannelId: OTHER_VALID_CHANNEL_ID }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

// ---------------------------------------------------------------------------
// Phase 9 slice 3 -- fetchPublicSnapshot (docs/roadmap/plans/PHASE_9_PLAN.md §6/§7).
// ---------------------------------------------------------------------------

test("AC-MI-09: fetchPublicSnapshot rejects a channel that is not on the watchlist, without resolving credentials", async () => {
  const { services, resolveCalls } = createFixture();

  await assert.rejects(
    () =>
      services.fetchPublicSnapshot(
        { researchChannelId: OTHER_VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  assert.equal(resolveCalls.length, 0, "must never resolve credentials for a channel that isn't watchlisted");
});

test("AC-MI-10: fetchPublicSnapshot resolves credentials with YOUTUBE_READ_SCOPE, fetches by researchChannelId, and records a 'high'-confidence evidence row stamped from callOrigin", async () => {
  const { store, services, resolveCalls, snapshotCalls } = createFixture({
    publicSnapshot: {
      channelId: VALID_CHANNEL_ID,
      title: "Competitor",
      subscriberCount: 5000,
      hiddenSubscriberCount: false,
      viewCount: 90000,
      videoCount: 12,
      uploadsPlaylistId: null,
    },
  });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Competitor" }, { createdVia: "web_ui" });

  const evidence = await services.fetchPublicSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
    { createdVia: "web_ui" }
  );

  assert.deepEqual(resolveCalls, [{ credentialRef: { userId: "u1" }, requiredScopes: ["https://www.googleapis.com/auth/youtube.readonly"] }]);
  assert.deepEqual(snapshotCalls, [{ credentials: { accessToken: "fake-access-token", refreshToken: "fake-refresh-token" }, channelId: VALID_CHANNEL_ID }]);
  assert.equal(evidence.source, "youtube.channels.list");
  assert.equal(evidence.confidence, "high");
  assert.equal(
    evidence.observation,
    'Public snapshot for "Competitor": ~5000 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), 90000 total views, 12 videos'
  );
  assert.equal(store.evidence.length, 1);
  assert.equal(store.evidence[0].createdVia, "web_ui");
});

test("AC-MI-11: fetchPublicSnapshot rejects when YouTube reports no public channel for this id, and records nothing", async () => {
  const { store, services } = createFixture({ publicSnapshot: null });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Competitor" }, { createdVia: "web_ui" });

  await assert.rejects(
    () =>
      services.fetchPublicSnapshot(
        { researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  assert.equal(store.evidence.length, 0);
});

// AC-MI-12: describePublicChannelSnapshot's wording, derived independently from YOUTUBE's own
// documented "hiddenSubscriberCount"/field-omission semantics -- never a fabricated 0 or a silent
// omission for a value YouTube did not actually report.
test("AC-MI-12: describePublicChannelSnapshot reports the title and every field, describes a null field honestly instead of fabricating a number, and flags subscriberCount as YouTube's own rounded approximation (real API docs: 'rounded to three significant figures')", () => {
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "x",
      subscriberCount: 12300,
      hiddenSubscriberCount: false,
      viewCount: 456000,
      videoCount: 42,
      uploadsPlaylistId: null,
    }),
    'Public snapshot for "x": ~12300 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), 456000 total views, 42 videos'
  );
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "x",
      subscriberCount: null,
      hiddenSubscriberCount: true,
      viewCount: 456000,
      videoCount: 42,
      uploadsPlaylistId: null,
    }),
    'Public snapshot for "x": subscriber count hidden, 456000 total views, 42 videos'
  );
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "x",
      subscriberCount: 0,
      hiddenSubscriberCount: false,
      viewCount: null,
      videoCount: null,
      uploadsPlaylistId: null,
    }),
    'Public snapshot for "x": ~0 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), view count unavailable, video count unavailable'
  );
});

// Phase 9 slice 9A -- proves the fix for the exact ambiguity independent review found: a null
// subscriberCount for a reason OTHER than YouTube hiding it (a genuinely absent/unparseable stat)
// must never be described as "hidden" (a specific, different, real fact).
test("AC-MI-12c: describePublicChannelSnapshot describes a null subscriberCount as 'unavailable', not 'hidden', when hiddenSubscriberCount is false", () => {
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "x",
      subscriberCount: null,
      hiddenSubscriberCount: false,
      viewCount: 456000,
      videoCount: 42,
      uploadsPlaylistId: null,
    }),
    'Public snapshot for "x": subscriber count unavailable, 456000 total views, 42 videos'
  );
});

// Found by independent review, round 2 (2026-09-26): an empty title (YouTube's own response
// omitted snippet.title -- the read gateway's `??` default is "") must never render as a
// confusing `for ""` with nothing identifying the channel.
test("AC-MI-12b: describePublicChannelSnapshot falls back to the channel id when title is empty", () => {
  assert.equal(
    describePublicChannelSnapshot({
      channelId: VALID_CHANNEL_ID,
      title: "",
      subscriberCount: 100,
      hiddenSubscriberCount: false,
      viewCount: 200,
      videoCount: 3,
      uploadsPlaylistId: null,
    }),
    `Public snapshot for "${VALID_CHANNEL_ID}": ~100 subscribers (YouTube reports this rounded to 3 significant figures, not an exact count), 200 total views, 3 videos`
  );
});

// ---------------------------------------------------------------------------
// removeFromWatchlist -- added by independent review, 2026-09-26 (docs/roadmap/plans/PHASE_9_PLAN.md).
// ---------------------------------------------------------------------------

test("AC-MI-13: removeFromWatchlist deletes the channel and every evidence row recorded against it", async () => {
  const { store, services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Test" }, { createdVia: "web_ui" });
  await services.recordEvidence(
    { researchChannelId: VALID_CHANNEL_ID, observation: "Something", source: "manual observation" },
    { createdVia: "web_ui" }
  );
  assert.equal(store.channels.size, 1);
  assert.equal(store.evidence.length, 1);

  await services.removeFromWatchlist({ channelId: VALID_CHANNEL_ID });

  assert.equal(store.channels.size, 0);
  assert.equal(store.evidence.length, 0);
  await assert.rejects(
    () => services.getWatchlistEntry({ channelId: VALID_CHANNEL_ID }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

test("AC-MI-14: removeFromWatchlist is a silent no-op for a channel that was never on the watchlist (idempotent, mirrors localization's removeTrackedLanguage convention)", async () => {
  const { store, services } = createFixture();
  await services.removeFromWatchlist({ channelId: OTHER_VALID_CHANNEL_ID });
  assert.equal(store.channels.size, 0);
});

test("AC-MI-15: after removal, the same channel id can be added back (never blocked by a stale duplicate check)", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "First" }, { createdVia: "web_ui" });
  await services.removeFromWatchlist({ channelId: VALID_CHANNEL_ID });

  const readded = await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Second" }, { createdVia: "web_ui" });
  assert.equal(readded.reason, "Second");
});

// ---------------------------------------------------------------------------
// Phase 9 slice 4 -- getWatchlistEntryContext (docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md §7).
// Added so MCP's query_market_intelligence and CLI's `agent market-intelligence` share one
// implementation of the "channel + its full evidence history" join, instead of each
// independently re-orchestrating getWatchlistEntry+listEvidence (found by independent review --
// the two call sites had already started to drift cosmetically).
// ---------------------------------------------------------------------------

test("AC-MI-16: getWatchlistEntryContext rejects a channel not on the watchlist with RESEARCH_CHANNEL_NOT_AVAILABLE and a stable details.channelId shape", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.getWatchlistEntryContext({ channelId: OTHER_VALID_CHANNEL_ID }),
    (error: unknown) =>
      isDomainError(error) &&
      error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE" &&
      // Pins the exact `details` shape -- independent review (round 2, 2026-09-26) found an
      // earlier version of this function delegated to getWatchlistEntry/listEvidence
      // concurrently, whose two RESEARCH_CHANNEL_NOT_AVAILABLE errors carried different
      // `details` key names (`channelId` vs `researchChannelId`), making the response
      // non-deterministic depending on which one settled first.
      JSON.stringify(error.details) === JSON.stringify({ channelId: OTHER_VALID_CHANNEL_ID })
  );
});

test("AC-MI-17: getWatchlistEntryContext returns the channel's own record with an empty evidence array when none has been recorded yet", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });

  assert.equal(result.channel.channelId, VALID_CHANNEL_ID);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.neverObserved, true, "a channel with zero channel snapshots must report neverObserved:true");
  assert.deepEqual(result.dataQualityFlags, [], "never-observed is its own signal, not folded into dataQualityFlags");
});

// Found by independent review (2026-09-29): assessObservationFreshness/assessSnapshotCompleteness
// both deliberately leave "never observed at all" to their caller (see their own doc comments) --
// this is the direct test of that caller-side check, not just an indirect one via getMarketOverview
// (which had reinvented this same check independently before this fix removed the duplication).
test("AC-MI-17b: getWatchlistEntryContext reports neverObserved:false once a channel snapshot exists", async () => {
  const { services } = createFixture({ publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });
  await services.captureChannelSnapshot({ researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });

  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });

  assert.equal(result.neverObserved, false);
});

test("AC-MI-18: getWatchlistEntryContext returns every recorded evidence row for 2+ rows, in insertion order", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });
  await services.recordEvidence(
    { researchChannelId: VALID_CHANNEL_ID, observation: "First observation", source: "manual observation" },
    { createdVia: "web_ui" }
  );
  await services.recordEvidence(
    { researchChannelId: VALID_CHANNEL_ID, observation: "Second observation", source: "manual observation" },
    { createdVia: "web_ui" }
  );

  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });

  assert.equal(result.channel.channelId, VALID_CHANNEL_ID);
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(
    result.evidence.map((e) => e.observation),
    ["First observation", "Second observation"]
  );
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9G, part A -- getWatchlistEntryContext's extension with channel/video snapshots,
// topic assignments, and derived dataQualityFlags (docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md §6).
// ---------------------------------------------------------------------------

test("AC-9G-01: a fresh channel snapshot with hiddenSubscriberCount:true and no collection run produces exactly ['hidden_subscriber_count']", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.channelSnapshots.push({
    id: "snap-1",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: now,
    subscriberCount: null,
    viewCount: 100,
    videoCount: 3,
    hiddenSubscriberCount: true,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });

  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.deepEqual(result.dataQualityFlags, ["hidden_subscriber_count"]);
});

test("AC-9G-02: a channel snapshot older than the staleness window produces 'stale_observation'; a fresh one does not", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const staleWindowMs = 24 * 60 * 60 * 1000;
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  store.channelSnapshots.push({
    id: "snap-stale",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: new Date(now.getTime() - staleWindowMs - 1000),
    subscriberCount: 10,
    viewCount: 100,
    videoCount: 3,
    hiddenSubscriberCount: false,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });
  const staleResult = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.ok(staleResult.dataQualityFlags.includes("stale_observation"));

  store.channelSnapshots.length = 0;
  store.channelSnapshots.push({
    id: "snap-fresh",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: new Date(now.getTime() - 1000),
    subscriberCount: 10,
    viewCount: 100,
    videoCount: 3,
    hiddenSubscriberCount: false,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });
  const freshResult = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.ok(!freshResult.dataQualityFlags.includes("stale_observation"));
});

test("AC-9G-03: a channel with zero snapshots and zero collection runs returns an empty dataQualityFlags, never a fabricated 'no data' flag", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.deepEqual(result.dataQualityFlags, []);
});

test("AC-9G-04: the channel's most recent collection run drives missing_snapshot/quota_limited, both able to appear together", async () => {
  const { services, store } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "skipped_quota_limited",
    unitsSpent: 1,
    videosRequested: 5,
    videosReturned: 3,
    errorMessage: null,
    ranAt: new Date(),
  });

  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.ok(result.dataQualityFlags.includes("missing_snapshot"));
  assert.ok(result.dataQualityFlags.includes("quota_limited"));
});

test("operator request 2026-10-04: uniqueVideoCount counts distinct videoId among the snapshot rows (3 rows of 2 videos -> 2); none -> 0 and latestVideoSnapshotAt null", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  const empty = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.equal(empty.uniqueVideoCount, 0);
  assert.equal(empty.latestVideoSnapshotAt, null);

  for (const videoId of ["dQw4w9WgXcQ", "dQw4w9WgXcQ", "9bZkp7q19f0"]) {
    await services.recordVideoSnapshot({ researchChannelId: VALID_CHANNEL_ID, videoId, viewCount: 10, source: "manual observation" }, { createdVia: "web_ui" });
  }
  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.equal(result.videoSnapshots.length, 3);
  assert.equal(result.uniqueVideoCount, 2);
  assert.equal(result.latestVideoSnapshotAt, result.videoSnapshots.map((v) => v.observedAt).sort().at(-1));
});

test("AC-9G-05: channelSnapshots/videoSnapshots/topicAssignments in the context round-trip exactly what the independent list actions return", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.recordChannelSnapshot({ researchChannelId: VALID_CHANNEL_ID, subscriberCount: 100, source: "manual observation" }, { createdVia: "web_ui" });
  await services.recordVideoSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, videoId: "dQw4w9WgXcQ", viewCount: 10, source: "manual observation" },
    { createdVia: "web_ui" }
  );
  const topic = await services.createTopic({ name: "Some Topic" }, { createdVia: "web_ui" });
  await services.assignTopic({ topicId: topic.topicId, subjectType: "channel", subjectId: VALID_CHANNEL_ID }, { createdVia: "web_ui" });

  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  const independentChannelSnapshots = await services.listChannelSnapshots({ researchChannelId: VALID_CHANNEL_ID });
  const independentVideoSnapshots = await services.listVideoSnapshots({ researchChannelId: VALID_CHANNEL_ID });
  const independentTopicAssignments = await services.listAssignmentsForSubject({ subjectType: "channel", subjectId: VALID_CHANNEL_ID });

  assert.deepEqual(result.channelSnapshots, independentChannelSnapshots.snapshots);
  assert.deepEqual(result.videoSnapshots, independentVideoSnapshots.snapshots);
  assert.deepEqual(result.topicAssignments, independentTopicAssignments.assignments);
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9H, part A (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md) -- Channels
// intelligence view. getChannelIntelligenceSummary/getChannelVideoSnapshotHistory.
// ---------------------------------------------------------------------------

test("AC-9H-01: getChannelIntelligenceSummary never returns videoSnapshots -- an unbounded, append-only series must not ship over the network in full (plan §4)", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.getChannelIntelligenceSummary({ channelId: VALID_CHANNEL_ID });
  assert.equal("videoSnapshots" in result, false);
});

test("AC-9H-01b: getChannelIntelligenceSummary's own methodology field matches the module's exported constants -- the UI reads this instead of a hardcoded client-side copy that could drift", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.getChannelIntelligenceSummary({ channelId: VALID_CHANNEL_ID });
  assert.deepEqual(result.methodology, {
    channelVelocityWindowDays: CHANNEL_VELOCITY_WINDOW_DAYS,
    recentVideoWindowDays: RECENT_VIDEO_WINDOW_DAYS,
    channelBaselineDayOffset: CHANNEL_BASELINE_DAY_OFFSET,
    breakoutMinBaselineSampleSize: BREAKOUT_MIN_BASELINE_SAMPLE_SIZE,
    breakoutBaselineToleranceDays: 1.75,
  });
});

test("AC-9H-07: zero videos with a publishedAt produces an empty recentBreakoutVideos, no crash", async () => {
  const { services, store } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.videoSnapshots.push({
    id: "s-no-published-at",
    researchChannelId: VALID_CHANNEL_ID,
    videoId: "vNoPublished000000000A",
    observedAt: new Date(),
    viewCount: 500,
    likeCount: null,
    commentCount: null,
    publishedAt: null,
    title: null,
    source: "youtube.videos.list",
    createdVia: "web_ui",
  });

  const result = await services.getChannelIntelligenceSummary({ channelId: VALID_CHANNEL_ID });
  assert.deepEqual(result.recentBreakoutVideos, []);
});

test("AC-9H-08: getChannelIntelligenceSummary on a channel not on the watchlist propagates RESEARCH_CHANNEL_NOT_AVAILABLE, matching getWatchlistEntryContext's own existing behavior", async () => {
  const { services } = createFixture();
  await assert.rejects(
    () => services.getChannelIntelligenceSummary({ channelId: OTHER_VALID_CHANNEL_ID }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

test("AC-9H-09: latestSnapshotPerVideo holds exactly one row per distinct videoId -- the LATER snapshot's own values, not the earlier one's", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  // Pushed LATE-then-EARLY (reverse of chronological order) -- found necessary by independent code
  // review: pushing in chronological order let this test pass merely because the fake store
  // returned insertion order, never actually exercising the "sort by observedAt, take the last"
  // logic the production code's own comment relies on.
  store.videoSnapshots.push(
    {
      id: "s-late",
      researchChannelId: VALID_CHANNEL_ID,
      videoId: "vRepeated0000000000000A",
      observedAt: now,
      viewCount: 500,
      likeCount: 20,
      commentCount: 4,
      publishedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
      title: null,
      source: "youtube.videos.list",
      createdVia: "web_ui",
    },
    {
      id: "s-early",
      researchChannelId: VALID_CHANNEL_ID,
      videoId: "vRepeated0000000000000A",
      observedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      viewCount: 100,
      likeCount: 5,
      commentCount: 1,
      publishedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
      title: null,
      source: "youtube.videos.list",
      createdVia: "web_ui",
    }
  );

  const result = await services.getChannelIntelligenceSummary({ channelId: VALID_CHANNEL_ID });
  assert.equal(result.latestSnapshotPerVideo.length, 1);
  assert.equal(result.latestSnapshotPerVideo[0].viewCount, 500);
  assert.equal(result.latestSnapshotPerVideo[0].likeCount, 20);
});

test("AC-9H-10: getChannelVideoSnapshotHistory returns only the requested video's own rows", async () => {
  const { services, store } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.videoSnapshots.push(
    {
      id: "s-1",
      researchChannelId: VALID_CHANNEL_ID,
      videoId: "vTargetVideo0000000000A",
      observedAt: new Date(),
      viewCount: 10,
      likeCount: null,
      commentCount: null,
      publishedAt: null,
      title: null,
      source: "youtube.videos.list",
      createdVia: "web_ui",
    },
    {
      id: "s-2",
      researchChannelId: VALID_CHANNEL_ID,
      videoId: "vOtherVideo00000000000B",
      observedAt: new Date(),
      viewCount: 20,
      likeCount: null,
      commentCount: null,
      publishedAt: null,
      title: null,
      source: "youtube.videos.list",
      createdVia: "web_ui",
    }
  );

  const result = await services.getChannelVideoSnapshotHistory({ channelId: VALID_CHANNEL_ID, videoId: "vTargetVideo0000000000A" });
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0].videoId, "vTargetVideo0000000000A");
});

test("AC-9H-11: getChannelVideoSnapshotHistory on a channel not on the watchlist propagates RESEARCH_CHANNEL_NOT_AVAILABLE", async () => {
  const { services } = createFixture();
  await assert.rejects(
    () => services.getChannelVideoSnapshotHistory({ channelId: OTHER_VALID_CHANNEL_ID, videoId: "vAnyVideo000000000000A" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9H, part A -- Trends panel gap-closing.
// listTrendCandidatesWithFreshness/getTrendEvidenceSummary.
// ---------------------------------------------------------------------------

test("AC-9H-12: listTrendCandidatesWithFreshness reports 'fresh' at exactly TREND_EVIDENCE_FRESH_WINDOW_DAYS minus 1ms, and 'needs_attention' at exactly TREND_EVIDENCE_FRESH_WINDOW_DAYS -- a real boundary, not merely two far-apart instants", async () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const { services, setNow } = createFixture({ now: createdAt });
  const created = await services.createTrendCandidate(
    { title: "Jazz revival", initialEvidence: { evidenceType: "signal", description: "seen it" } },
    { createdVia: "web_ui" }
  );
  const windowMs = 30 * 24 * 60 * 60 * 1000; // TREND_EVIDENCE_FRESH_WINDOW_DAYS

  setNow(new Date(createdAt.getTime() + windowMs - 1));
  const justInside = await services.listTrendCandidatesWithFreshness();
  assert.equal(justInside.trendCandidates.find((c) => c.trendCandidateId === created.trendCandidateId)?.freshness, "fresh");

  setNow(new Date(createdAt.getTime() + windowMs));
  const exactlyAtWindow = await services.listTrendCandidatesWithFreshness();
  assert.equal(exactlyAtWindow.trendCandidates.find((c) => c.trendCandidateId === created.trendCandidateId)?.freshness, "needs_attention");
});

test("AC-9H-13: listTrendCandidatesWithFreshness never changes listTrendCandidates's own existing MCP/CLI-facing output", async () => {
  const { services } = createFixture();
  await services.createTrendCandidate(
    { title: "Jazz revival", initialEvidence: { evidenceType: "signal", description: "seen it" } },
    { createdVia: "web_ui" }
  );

  const plain = await services.listTrendCandidates();
  const withFreshness = await services.listTrendCandidatesWithFreshness();
  const plainAgain = await services.listTrendCandidates();
  assert.deepEqual(plain, plainAgain);
  assert.equal("freshness" in withFreshness.trendCandidates[0], true);
  assert.equal("freshness" in plain.trendCandidates[0], false);
});

test("AC-9H-14: getTrendEvidenceSummary's independentChannelCount deduplicates by referenceId, and its evidence is newest-first while listTrendEvidence's own order stays ascending", async () => {
  const { services } = createFixture();
  const created = await services.createTrendCandidate(
    { title: "Jazz revival", initialEvidence: { evidenceType: "signal", description: "first" } },
    { createdVia: "web_ui" }
  );
  await services.recordTrendEvidence(
    { trendCandidateId: created.trendCandidateId, evidenceType: "supporting_channel", referenceId: "UC1111111111111111111111", description: "second" },
    { createdVia: "web_ui" }
  );
  await services.recordTrendEvidence(
    { trendCandidateId: created.trendCandidateId, evidenceType: "supporting_channel", referenceId: "UC1111111111111111111111", description: "third, same channel again" },
    { createdVia: "web_ui" }
  );
  await services.recordTrendEvidence(
    { trendCandidateId: created.trendCandidateId, evidenceType: "supporting_channel", referenceId: "UC2222222222222222222222", description: "fourth, a different channel" },
    { createdVia: "web_ui" }
  );

  const summary = await services.getTrendEvidenceSummary({ trendCandidateId: created.trendCandidateId });
  assert.equal(summary.independentChannelCount, 2, "2 distinct referenceIds among supporting_channel rows, despite 3 such rows");
  assert.equal(summary.evidence[0].description, "fourth, a different channel", "newest-first");
  assert.equal(summary.evidence[summary.evidence.length - 1].description, "first");

  const plain = await services.getTrendEvidence({ trendCandidateId: created.trendCandidateId });
  assert.equal(plain.evidence[0].description, "first", "listTrendEvidence's own ascending order is unchanged");
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9H, part B (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_B_PLAN.md) -- Market Overview.
// getMarketOverview aggregates across the whole watchlist over 9C/9H-A/9G-a building blocks.
// ---------------------------------------------------------------------------

test("AC-9HB-01: an empty watchlist gives watchlistCount 0 and empty breakoutVideos/emergingChannels/collectionWarnings, with zero per-channel calls", async () => {
  const { services } = createFixture();
  const result = await services.getMarketOverview();
  assert.equal(result.watchlistCount, 0);
  assert.deepEqual(result.breakoutVideos, []);
  assert.deepEqual(result.emergingChannels, []);
  assert.deepEqual(result.collectionWarnings, []);
});

test("AC-9HB-02: newDiscoveries does not depend on the watchlist -- a 'new' candidate shows even with an empty watchlist", async () => {
  const { services, store } = createFixture();
  store.discoveryCandidates.set(VALID_CHANNEL_ID, {
    id: VALID_CHANNEL_ID,
    title: "Independent Channel",
    status: "new",
    discoverySource: "youtube.search.list",
    discoveryQuery: "jazz",
    reasonDiscovered: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdVia: "web_ui",
  });

  const result = await services.getMarketOverview();
  assert.equal(result.watchlistCount, 0);
  assert.equal(result.newDiscoveries.length, 1);
  assert.equal(result.newDiscoveries[0].channelId, VALID_CHANNEL_ID);
});

test("AC-9HB-03: newDiscoveries contains exactly the 'new'-status candidate, not watching/promoted/ignored/archived ones", async () => {
  const { services, store } = createFixture();
  const statuses: DiscoveryCandidateStatus[] = ["new", "watching", "promoted", "ignored", "archived"];
  for (const [i, status] of statuses.entries()) {
    const id = i === 0 ? VALID_CHANNEL_ID : `UC${String(i).padStart(2, "0")}000000000000000000`;
    store.discoveryCandidates.set(id, {
      id,
      title: `Channel ${status}`,
      status,
      discoverySource: "youtube.search.list",
      discoveryQuery: "jazz",
      reasonDiscovered: null,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      createdVia: "web_ui",
    });
  }

  const result = await services.getMarketOverview();
  assert.equal(result.newDiscoveries.length, 1);
  assert.equal(result.newDiscoveries[0].status, "new");
});

test("AC-9HB-06: trendCandidates is byte-for-byte identical to a direct listTrendCandidatesWithFreshness() call", async () => {
  const { services } = createFixture();
  await services.createTrendCandidate(
    { title: "Jazz revival", initialEvidence: { evidenceType: "signal", description: "seen it" } },
    { createdVia: "web_ui" }
  );

  const result = await services.getMarketOverview();
  const direct = await services.listTrendCandidatesWithFreshness();
  assert.deepEqual(result.trendCandidates, direct.trendCandidates);
});

test("AC-9HB-07: a channel whose latest collection run 'failed' appears in collectionWarnings with latestRunStatus 'failed', even with a fresh channel snapshot (inside the 24h window)", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.channelSnapshots.push({
    id: "snap-fresh",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: now,
    subscriberCount: 100,
    viewCount: 1000,
    videoCount: 5,
    hiddenSubscriberCount: false,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "failed",
    unitsSpent: 1,
    videosRequested: null,
    videosReturned: null,
    errorMessage: "simulated failure",
    ranAt: now,
  });

  const result = await services.getMarketOverview();
  assert.equal(result.collectionWarnings.length, 1);
  assert.equal(result.collectionWarnings[0].channelId, VALID_CHANNEL_ID);
  assert.equal(result.collectionWarnings[0].latestRunStatus, "failed");
  assert.equal(result.collectionWarnings[0].neverObserved, false);
  assert.deepEqual(result.collectionWarnings[0].dataQualityFlags, []);
});

test("AC-9HB-08: a channel with a fresh snapshot, a 'success' run, and no other quality flag does not appear in collectionWarnings", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.channelSnapshots.push({
    id: "snap-fresh",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: now,
    subscriberCount: 100,
    viewCount: 1000,
    videoCount: 5,
    hiddenSubscriberCount: false,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "success",
    unitsSpent: 1,
    videosRequested: 3,
    videosReturned: 3,
    errorMessage: null,
    ranAt: now,
  });

  const result = await services.getMarketOverview();
  assert.deepEqual(result.collectionWarnings, []);
});

test("AC-9HB-09: a channel whose ONLY dataQualityFlags entry is hidden_subscriber_count does not appear in collectionWarnings (plan §3a narrowing)", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.channelSnapshots.push({
    id: "snap-fresh",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: now,
    subscriberCount: null,
    viewCount: 1000,
    videoCount: 5,
    hiddenSubscriberCount: true,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "success",
    unitsSpent: 1,
    videosRequested: 3,
    videosReturned: 3,
    errorMessage: null,
    ranAt: now,
  });

  const result = await services.getMarketOverview();
  assert.deepEqual(result.collectionWarnings, []);
});

test("AC-9HB-10: a never-collected channel (zero snapshots, zero runs) appears with neverObserved:true, latestRunStatus:null -- never a silent all-clear (plan §3b)", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.getMarketOverview();
  assert.equal(result.collectionWarnings.length, 1);
  assert.equal(result.collectionWarnings[0].channelId, VALID_CHANNEL_ID);
  assert.equal(result.collectionWarnings[0].neverObserved, true);
  assert.equal(result.collectionWarnings[0].latestRunStatus, null);
});

test("AC-9HB-11: a channel removed mid-request (present in listWatchlist, gone by its own summary fetch) is skipped, not a 500 -- a different, unrelated error still propagates", async () => {
  const { services, store } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  // Simulate the race: the channel is still in listWatchlist's own result (already captured before
  // this happens in a real request), but gone by the time getChannelIntelligenceSummary looks it up.
  store.failNextGetResearchChannelByIdOnce(VALID_CHANNEL_ID);

  const result = await services.getMarketOverview();
  assert.equal(result.watchlistCount, 2, "listWatchlist's own count is unaffected -- the race is in the per-channel fetch, not here");
  assert.equal(result.collectionWarnings.some((w) => w.channelId === VALID_CHANNEL_ID), false, "the removed channel must be skipped");
  const other = result.collectionWarnings.find((w) => w.channelId === OTHER_VALID_CHANNEL_ID);
  assert.ok(other, "the OTHER channel must still be processed normally (never-collected, so it gets its own row)");
  assert.equal(other!.neverObserved, true);
});

test("AC-9HB-11b: a genuine, unrelated error from inside the per-channel fetch is NOT swallowed -- only RESEARCH_CHANNEL_NOT_AVAILABLE is caught", async () => {
  const { services, store } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.throwNextGetResearchChannelByIdOnce(VALID_CHANNEL_ID);

  await assert.rejects(
    () => services.getMarketOverview(),
    (error: unknown) => error instanceof Error && error.message === "simulated getResearchChannelById failure"
  );
});

test("AC-9HB-12: a channel with a stale (25h-old) snapshot AND hidden_subscriber_count appears with ONLY 'stale_observation' -- the narrowed filter keeps stale, strips hidden, in the same row", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.channelSnapshots.push({
    id: "snap-stale",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000), // 25h ago, past MARKET_INTELLIGENCE_STALE_WINDOW_MS (24h)
    subscriberCount: null,
    viewCount: 1000,
    videoCount: 5,
    hiddenSubscriberCount: true,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "success",
    unitsSpent: 1,
    videosRequested: 3,
    videosReturned: 3,
    errorMessage: null,
    ranAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
  });

  const result = await services.getMarketOverview();
  assert.equal(result.collectionWarnings.length, 1);
  assert.deepEqual(result.collectionWarnings[0].dataQualityFlags, ["stale_observation"]);
  assert.equal(result.collectionWarnings[0].neverObserved, false);
});

test("AC-9HB-13: a channel with a fresh snapshot but a 'skipped_quota_limited' latest run appears with 'quota_limited'", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.channelSnapshots.push({
    id: "snap-fresh",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: now,
    subscriberCount: 100,
    viewCount: 1000,
    videoCount: 5,
    hiddenSubscriberCount: false,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "skipped_quota_limited",
    unitsSpent: 0,
    videosRequested: null,
    videosReturned: null,
    errorMessage: null,
    ranAt: now,
  });

  const result = await services.getMarketOverview();
  assert.equal(result.collectionWarnings.length, 1);
  assert.deepEqual(result.collectionWarnings[0].dataQualityFlags, ["quota_limited"]);
  assert.equal(result.collectionWarnings[0].latestRunStatus, "skipped_quota_limited");
});

test("AC-9HB-14: a channel with a fresh snapshot but an incomplete latest run (videosReturned < videosRequested) appears with 'missing_snapshot'", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.channelSnapshots.push({
    id: "snap-fresh",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: now,
    subscriberCount: 100,
    viewCount: 1000,
    videoCount: 5,
    hiddenSubscriberCount: false,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "success",
    unitsSpent: 3,
    videosRequested: 5,
    videosReturned: 3,
    errorMessage: null,
    ranAt: now,
  });

  const result = await services.getMarketOverview();
  assert.equal(result.collectionWarnings.length, 1);
  assert.deepEqual(result.collectionWarnings[0].dataQualityFlags, ["missing_snapshot"]);
});

function pushVideoSnapshotForChannel(
  store: ReturnType<typeof createFakeStore>,
  channelId: string,
  now: Date,
  args: { id: string; videoId: string; viewCount: number }
) {
  store.videoSnapshots.push({
    id: args.id,
    researchChannelId: channelId,
    videoId: args.videoId,
    observedAt: now,
    viewCount: args.viewCount,
    likeCount: null,
    commentCount: null,
    publishedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    title: null,
    source: "youtube.videos.list",
    createdVia: "web_ui",
  });
}

// ---------------------------------------------------------------------------
// Phase 9 slice 9H, part C (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_C_PLAN.md) -- Videos tab.
// ---------------------------------------------------------------------------

test("AC-9HC-01: runCollectionIfStale captures title from getPublicVideoSnapshots, normalizing an empty-string title to null (never a different-looking 'known empty' title)", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1", "v2"],
    publicVideoSnapshots: [
      { videoId: "v1", title: "Real Title", publishedAt: null, viewCount: 10, likeCount: null, commentCount: null },
      { videoId: "v2", title: "", publishedAt: null, viewCount: 20, likeCount: null, commentCount: null },
    ],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });

  const byVideoId = new Map(store.videoSnapshots.map((s) => [s.videoId, s]));
  assert.equal(byVideoId.get("v1")?.title, "Real Title");
  assert.equal(
    byVideoId.get("v2")?.title,
    null,
    "an empty-string title from the API must be normalized to null, never stored as a different-looking 'known empty' title"
  );
});

test("AC-9HC-02: getMarketVideosOverview with an empty watchlist returns videos: []", async () => {
  const { services } = createFixture();
  const result = await services.getMarketVideosOverview();
  assert.deepEqual(result.videos, []);
});

test("AC-9HC-02b: methodology reports the real, checked constants (found necessary by advisor review -- the UI must never hardcode a second copy)", async () => {
  const { services } = createFixture();
  const result = await services.getMarketVideosOverview();
  assert.deepEqual(result.methodology, { velocityWindowDays: 7, recentVideoWindowDays: 180, baselineDayOffset: 7 });
});

test("AC-9HC-05: a video older than RECENT_VIDEO_WINDOW_DAYS gets breakout: null (excluded entirely, never a fabricated non-breakout verdict); a video with no publishedAt also gets breakout: null", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.videoSnapshots.push(
    {
      id: "s-old",
      researchChannelId: VALID_CHANNEL_ID,
      videoId: "vOld00000000000000000A",
      observedAt: now,
      viewCount: 500,
      likeCount: null,
      commentCount: null,
      publishedAt: new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000),
      title: "Old video",
      source: "youtube.videos.list",
      createdVia: "web_ui",
    },
    {
      id: "s-no-published-at",
      researchChannelId: VALID_CHANNEL_ID,
      videoId: "vNoPub0000000000000000A",
      observedAt: now,
      viewCount: 10,
      likeCount: null,
      commentCount: null,
      publishedAt: null,
      title: "No publish date",
      source: "youtube.videos.list",
      createdVia: "web_ui",
    }
  );

  const result = await services.getMarketVideosOverview();
  const old = result.videos.find((v) => v.videoId === "vOld00000000000000000A")!;
  const noPub = result.videos.find((v) => v.videoId === "vNoPub0000000000000000A")!;
  assert.equal(old.breakout, null);
  assert.equal(noPub.breakout, null);
});

test("AC-9HC-06: topic resolution -- a video's topic assignments resolve to real names via listTopics(), sorted by name ascending; a video with zero assignments gets topics: []", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.videoSnapshots.push(
    {
      id: "s-tagged",
      researchChannelId: VALID_CHANNEL_ID,
      videoId: "vTagged0001", // exactly 11 chars -- a real assignTopic() call validates this as a YouTube video id
      observedAt: now,
      viewCount: 10,
      likeCount: null,
      commentCount: null,
      publishedAt: null,
      title: "Tagged video",
      source: "youtube.videos.list",
      createdVia: "web_ui",
    },
    {
      id: "s-untagged",
      researchChannelId: VALID_CHANNEL_ID,
      videoId: "vUntagged01",
      observedAt: now,
      viewCount: 20,
      likeCount: null,
      commentCount: null,
      publishedAt: null,
      title: "Untagged video",
      source: "youtube.videos.list",
      createdVia: "web_ui",
    }
  );
  const jazz = await services.createTopic({ name: "Jazz" }, { createdVia: "web_ui" });
  const ambient = await services.createTopic({ name: "Ambient" }, { createdVia: "web_ui" });
  await services.assignTopic({ topicId: jazz.topicId, subjectType: "video", subjectId: "vTagged0001" }, { createdVia: "web_ui" });
  await services.assignTopic({ topicId: ambient.topicId, subjectType: "video", subjectId: "vTagged0001" }, { createdVia: "web_ui" });

  const result = await services.getMarketVideosOverview();
  const tagged = result.videos.find((v) => v.videoId === "vTagged0001")!;
  const untagged = result.videos.find((v) => v.videoId === "vUntagged01")!;
  assert.deepEqual(
    tagged.topics.map((t) => t.name),
    ["Ambient", "Jazz"],
    "sorted by name ascending, not assignment order"
  );
  assert.deepEqual(untagged.topics, []);
});

test("AC-9HC-07: a channel removed mid-request (present in listWatchlist, gone by its own context fetch) is skipped, not a 500 -- a different, unrelated error still propagates", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  pushVideoSnapshotForChannel(store, OTHER_VALID_CHANNEL_ID, now, { id: "s-other", videoId: "vOther0000000000000000A", viewCount: 10 });

  store.failNextGetResearchChannelByIdOnce(VALID_CHANNEL_ID);

  const result = await services.getMarketVideosOverview();
  assert.equal(result.videos.length, 1, "the removed channel's videos must be skipped, but the other channel's own video must still appear");
  assert.equal(result.videos[0].channelId, OTHER_VALID_CHANNEL_ID);
});

test("AC-9HC-07b: a genuine, unrelated error from inside the per-channel fetch is NOT swallowed -- only RESEARCH_CHANNEL_NOT_AVAILABLE is caught", async () => {
  const { services, store } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.throwNextGetResearchChannelByIdOnce(VALID_CHANNEL_ID);

  await assert.rejects(
    () => services.getMarketVideosOverview(),
    (error: unknown) => error instanceof Error && error.message === "simulated getResearchChannelById failure"
  );
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9A -- service-layer acceptance criteria from
// docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md §5 (derived-metrics.test.ts covers the pure
// delta/velocity functions themselves; these tests cover the service layer that stores and
// retrieves the raw rows those functions consume).
// ---------------------------------------------------------------------------

test("AC-9A-06: recordChannelSnapshot rejects a channel not on the watchlist, before any insert", async () => {
  const { store, services } = createFixture();

  await assert.rejects(
    () =>
      services.recordChannelSnapshot(
        { researchChannelId: OTHER_VALID_CHANNEL_ID, subscriberCount: 100, source: "manual observation" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  assert.equal(store.channelSnapshots.length, 0);
});

test("AC-9A-07: recordChannelSnapshot/listChannelSnapshots never coerce an omitted numeric field to 0", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  const recorded = await services.recordChannelSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, viewCount: 5000, source: "manual observation" },
    { createdVia: "web_ui" }
  );
  assert.equal(recorded.subscriberCount, null, "an omitted field must be null, never a fabricated 0");
  assert.equal(recorded.videoCount, null);
  assert.equal(recorded.viewCount, 5000);
  assert.equal(recorded.hiddenSubscriberCount, false, "default must be false when not specified");

  const list = await services.listChannelSnapshots({ researchChannelId: VALID_CHANNEL_ID });
  assert.equal(list.snapshots.length, 1);
  assert.equal(list.snapshots[0].subscriberCount, null);
});

test("AC-9A-08: recordVideoSnapshot rejects a channel not on the watchlist; listVideoSnapshots never fabricates an omitted field", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () =>
      services.recordVideoSnapshot(
        { researchChannelId: OTHER_VALID_CHANNEL_ID, videoId: "v1", source: "manual observation" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );

  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });
  const recorded = await services.recordVideoSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, videoId: "v1", viewCount: 200, source: "manual observation" },
    { createdVia: "web_ui" }
  );
  assert.equal(recorded.likeCount, null);
  assert.equal(recorded.commentCount, null);
  assert.equal(recorded.publishedAt, null);

  const list = await services.listVideoSnapshots({ researchChannelId: VALID_CHANNEL_ID });
  assert.equal(list.snapshots.length, 1);
  assert.equal(list.snapshots[0].videoId, "v1");
});

test("AC-9A-09: captureChannelSnapshot stores hiddenSubscriberCount:true and subscriberCount:null together when YouTube hides the count", async () => {
  const { services } = createFixture({
    publicSnapshot: {
      channelId: VALID_CHANNEL_ID,
      title: "Example",
      subscriberCount: null,
      hiddenSubscriberCount: true,
      viewCount: 9000,
      videoCount: 12,
      uploadsPlaylistId: null,
    },
  });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  const result = await services.captureChannelSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
    { createdVia: "web_ui" }
  );

  assert.equal(result.subscriberCount, null);
  assert.equal(result.hiddenSubscriberCount, true);
  assert.equal(result.viewCount, 9000);
  assert.equal(result.videoCount, 12);
  assert.equal(result.source, "youtube.channels.list");
});

// Found by independent review, 2026-09-26: an earlier version inferred hiddenSubscriberCount from
// `subscriberCount === null` alone, which would have mislabeled THIS exact case (null for a
// different, unrelated reason) as "hidden." Proves the fix uses the real gateway-reported flag.
test("AC-9A-09b: captureChannelSnapshot stores hiddenSubscriberCount:false when subscriberCount is null for a reason other than YouTube hiding it", async () => {
  const { services } = createFixture({
    publicSnapshot: {
      channelId: VALID_CHANNEL_ID,
      title: "Example",
      subscriberCount: null,
      hiddenSubscriberCount: false,
      viewCount: 9000,
      videoCount: 12,
      uploadsPlaylistId: null,
    },
  });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  const result = await services.captureChannelSnapshot(
    { researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } },
    { createdVia: "web_ui" }
  );

  assert.equal(result.subscriberCount, null);
  assert.equal(result.hiddenSubscriberCount, false, "must not fabricate 'hidden' for an unrelated null reason");
});

test("AC-9A-10: captureChannelSnapshot never touches research_evidence -- fetchPublicSnapshot's own rows stay unaffected", async () => {
  const { store, services } = createFixture({
    publicSnapshot: {
      channelId: VALID_CHANNEL_ID,
      title: "Example",
      subscriberCount: 100,
      hiddenSubscriberCount: false,
      viewCount: 9000,
      videoCount: 12,
      uploadsPlaylistId: null,
    },
  });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });

  await services.fetchPublicSnapshot({ researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal(store.evidence.length, 1, "fetchPublicSnapshot's own free-text evidence row must exist as before");

  await services.captureChannelSnapshot({ researchChannelId: VALID_CHANNEL_ID, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });

  assert.equal(store.evidence.length, 1, "captureChannelSnapshot must never write to research_evidence");
  assert.equal(store.channelSnapshots.length, 1, "captureChannelSnapshot writes exactly its own structured row");
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md §9) -- acceptance criteria for
// runCollectionIfStale, drafted from the plan's own §9 before this file's own implementation was
// read line-by-line (AGENTS.md §L).
// ---------------------------------------------------------------------------

const FULL_SNAPSHOT_WITH_VIDEO: PublicChannelSnapshot = {
  channelId: VALID_CHANNEL_ID,
  title: "Competitor",
  subscriberCount: 1000,
  hiddenSubscriberCount: false,
  viewCount: 50000,
  videoCount: 10,
  uploadsPlaylistId: "UU_TEST_UPLOADS",
};

test("AC-9B-01: a never-collected channel is stale; a successful run sets last_auto_collected_at, and a second run within 24h does not re-process it", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, setNow } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: "2026-01-01T00:00:00.000Z", viewCount: 10, likeCount: 1, commentCount: 0 }],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const first = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(first, { attempted: 1, succeeded: 1, failed: 0, quotaLimited: 0, unitsSpent: 3 });
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt?.getTime(), now.getTime());

  setNow(new Date(now.getTime() + 23 * 60 * 60 * 1000));
  const second = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(second, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 }, "a channel collected less than 24h ago must not be re-processed");
});

test("AC-9B-02: with budget 0/unset, runCollectionIfStale makes zero real calls and marks nothing", async () => {
  const { store, services, snapshotCalls } = createFixture({ publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const unsetResult = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(unsetResult, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 });

  store.setQuotaBudget(0);
  const zeroResult = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(zeroResult, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 });

  assert.equal(snapshotCalls.length, 0, "must never call getPublicChannelSnapshot when the budget is unset or zero");
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt, null);
});

test("AC-9B-03: given a budget covering exactly one channel's 3-call cost and two stale channels, the run processes the first and records skipped_quota_limited for the second, leaving it stale", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 10, likeCount: null, commentCount: null }],
  });
  store.setQuotaBudget(3);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 2, succeeded: 1, failed: 0, quotaLimited: 1, unitsSpent: 3 });

  const succeededRuns = store.collectionRuns.filter((r) => r.status === "success");
  const skippedRuns = store.collectionRuns.filter((r) => r.status === "skipped_quota_limited");
  assert.equal(succeededRuns.length, 1);
  assert.equal(succeededRuns[0].unitsSpent, 3);
  assert.equal(skippedRuns.length, 1);
  assert.equal(skippedRuns[0].unitsSpent, 0, "a channel never even attempted must show 0 spent, not a fabricated number");

  const succeededChannelId = succeededRuns[0].researchChannelId;
  const skippedChannelId = skippedRuns[0].researchChannelId;
  assert.notEqual(succeededChannelId, skippedChannelId);
  assert.ok(store.channels.get(succeededChannelId)?.lastAutoCollectedAt, "the processed channel must be marked collected");
  assert.equal(store.channels.get(skippedChannelId)?.lastAutoCollectedAt, null, "the skipped channel must stay stale for next time");
  assert.equal(store.channels.get(skippedChannelId)?.collectionClaimedAt, null, "the skipped channel's claim must be released, never left stuck");
});

// Found by independent review (2026-09-29): only the ONE channel that tripped the budget check
// got a skipped_quota_limited row -- every channel claimed AFTER it in the same run was silently
// released with no row and no counter, so quotaLimited/attempted under-reported how many channels
// the cycle actually touched.
test("AC-9B-03b: a budget covering only the first of three stale channels records skipped_quota_limited for BOTH remaining channels, not just the one that tripped the check", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 10, likeCount: null, commentCount: null }],
  });
  store.setQuotaBudget(3);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: THIRD_VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 3, succeeded: 1, failed: 0, quotaLimited: 2, unitsSpent: 3 });

  const skippedRuns = store.collectionRuns.filter((r) => r.status === "skipped_quota_limited");
  assert.equal(skippedRuns.length, 2, "both channels claimed after the budget ran out must each get their own row, not just the first");
  assert.ok(skippedRuns.every((r) => r.unitsSpent === 0));
  const skippedChannelIds = new Set(skippedRuns.map((r) => r.researchChannelId));
  assert.equal(skippedChannelIds.size, 2, "the two skipped rows must be for two distinct channels");
  for (const channelId of skippedChannelIds) {
    assert.equal(store.channels.get(channelId)?.collectionClaimedAt, null, "every skipped channel's claim must be released, never left stuck");
  }
});

test("AC-9B-04: a video id present in the enumeration but absent from videos.list is reflected as videosReturned < videosRequested, never assumed deleted", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1", "v2_missing"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 10, likeCount: null, commentCount: null }],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });

  const [run] = store.collectionRuns;
  assert.equal(run.status, "success");
  assert.equal(run.videosRequested, 2);
  assert.equal(run.videosReturned, 1, "the gap must be reported honestly, never silently corrected or assumed deleted");
  assert.equal(store.videoSnapshots.length, 1, "only the video YouTube actually returned gets a stored snapshot");
});

test("AC-9B-05: a channel already claimed by a concurrent run in progress is excluded from this run's claim entirely", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, snapshotCalls } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  // Simulates a concurrent second dashboard tab's run claiming this channel moments ago, still in progress.
  store.channels.get(VALID_CHANNEL_ID)!.collectionClaimedAt = new Date(now.getTime() - 60 * 1000);

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 });
  assert.equal(snapshotCalls.length, 0, "an already-claimed channel must never receive a second concurrent attempt");
});

// Rewritten (independent/advisor review, before merge): the original version of this test asserted
// that a budget covering only the channel-snapshot call still yields a "success" -- but the plan
// itself (PHASE_9_SLICE_9B_PLAN.md §2/§4) requires a budget-limited channel to stay stale and be
// recorded skipped_quota_limited, never a partial success. Budget is now checked against the FULL
// worst-case per-channel cost (3) before a channel is ever started, precisely to make this case
// impossible -- this test now asserts THAT invariant instead of the old (incorrect) expectation.
test("AC-9B-06: a budget below the full per-channel worst-case cost (3) never starts a channel at all -- no partial success, per plan §2/§4", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, snapshotCalls } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(1);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 1, succeeded: 0, failed: 0, quotaLimited: 1, unitsSpent: 0 });
  assert.equal(snapshotCalls.length, 0, "must never issue even the first call for a channel it can't afford to fully process");

  const [run] = store.collectionRuns;
  assert.equal(run.status, "skipped_quota_limited");
  assert.equal(run.unitsSpent, 0, "nothing was attempted -- must never fabricate a partial spend");
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt, null, "must stay stale for the next trigger");
});

test("AC-9B-07: a channel whose most recent run failed within the last 24h is excluded from this run's claim (retry backoff)", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, snapshotCalls } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "failed",
    unitsSpent: 1,
    videosRequested: null,
    videosReturned: null,
    errorMessage: "boom",
    ranAt: new Date(now.getTime() - 60 * 60 * 1000),
  });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 });
  assert.equal(snapshotCalls.length, 0, "a recently-failed channel must not be retried on every single run");
});

test("AC-9B-08: a channel YouTube reports no public channel for is recorded as failed, without aborting other stale channels in the same run", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    getPublicChannelSnapshotImpl: async (args) => (args.channelId === VALID_CHANNEL_ID ? null : FULL_SNAPSHOT_WITH_VIDEO),
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 10, likeCount: null, commentCount: null }],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 2, succeeded: 1, failed: 1, quotaLimited: 0, unitsSpent: 4 });

  const failedRun = store.collectionRuns.find((r) => r.status === "failed");
  assert.ok(failedRun?.errorMessage, "a failure must record a real, non-empty error message");
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt, null);
  assert.ok(store.channels.get(OTHER_VALID_CHANNEL_ID)?.lastAutoCollectedAt, "one channel's failure must never abort the rest of the run");
});

test("AC-9B-09: a credential/scope resolution failure propagates, and claims no channel (no channel is left stuck mid-attempt)", async () => {
  const { store, services } = createFixture({ resolveError: new Error("insufficient scope") });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  await assert.rejects(() => services.runCollectionIfStale({ credentialRef: { userId: "u1" } }), /insufficient scope/);
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.collectionClaimedAt, null, "a credential failure must happen before any claim is taken");
  assert.equal(store.collectionRuns.length, 0);
});

// Found necessary by the write-path-inventory guard (PHASE9-INV-02): a generic settings route
// must never import getMarketIntelligenceDailyQuotaBudgetUnits/setMarketIntelligenceDailyQuotaBudgetUnits
// from db.ts directly -- these two thin passthroughs are what it calls instead.
test("AC-9B-10: getDailyQuotaBudgetUnits/setDailyQuotaBudgetUnits round-trip through the injected store, defaulting to null", async () => {
  const { store, services } = createFixture();
  assert.equal(await services.getDailyQuotaBudgetUnits(), null);

  await services.setDailyQuotaBudgetUnits(25);
  assert.equal(await services.getDailyQuotaBudgetUnits(), 25);
  assert.equal(store.channels.size, 0, "must never touch any watchlist state -- a pure setting passthrough");

  await services.setDailyQuotaBudgetUnits(null);
  assert.equal(await services.getDailyQuotaBudgetUnits(), null);
});

test("AC-9B-11: a budget of 2 (still short of the full 3-unit worst case) also never starts a channel", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, snapshotCalls } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(2);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 1, succeeded: 0, failed: 0, quotaLimited: 1, unitsSpent: 0 });
  assert.equal(snapshotCalls.length, 0);
  assert.equal(store.collectionRuns[0]?.videosRequested, null, "never attempted -- must never invent a requested/returned gap for a step that never ran");
  assert.equal(store.collectionRuns[0]?.videosReturned, null);
});

test("AC-9B-12: a channel whose uploads playlist genuinely has zero videos gets videosReturned:0 (a known fact), distinct from a channel with no uploads playlist at all (stays null)", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    publicSnapshot: { ...FULL_SNAPSHOT_WITH_VIDEO, channelId: VALID_CHANNEL_ID },
    uploadsPlaylistVideoIds: [],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });

  const [run] = store.collectionRuns;
  assert.equal(run.status, "success");
  assert.equal(run.videosRequested, 0, "the playlist WAS enumerated -- a real, known zero, not an unattempted step");
  assert.equal(run.videosReturned, 0);
  assert.equal(run.unitsSpent, 2, "channels.list + playlistItems.list only -- videos.list is never called for zero ids");
});

test("AC-9B-13: remaining budget is recomputed from the ledger after the claim, catching spend a concurrent run already recorded before this run's own pre-check ran", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, snapshotCalls } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(3);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  // Simulates a concurrent run that already spent the whole budget and recorded it in the ledger
  // AFTER this run's own initial (now stale) pre-check would have read `spentToday` as 0.
  store.collectionRuns.push({
    researchChannelId: OTHER_VALID_CHANNEL_ID,
    status: "success",
    unitsSpent: 3,
    videosRequested: null,
    videosReturned: null,
    errorMessage: null,
    ranAt: now,
  });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 });
  assert.equal(snapshotCalls.length, 0);
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.collectionClaimedAt, null, "the claim must be released, never left stuck, when the post-claim recheck finds no budget left");
});

// Found by independent review, before merge: an earlier version marked the channel BEFORE writing
// its own success audit row -- if that write then threw, the channel ended up marked "fresh"
// (skipped for 24h) while its own audit trail said nothing about the attempt at all, contradicting
// this module's own "marked ONLY on full success" invariant.
test("AC-9B-14: if the success audit-row write itself fails, the channel is recorded failed and stays stale (never marked fresh with no successful audit trail)", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.failNextSuccessRunInsertOnce();

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  // FULL_SNAPSHOT_WITH_VIDEO has an uploadsPlaylistId, so playlistItems.list is still called (2
  // units: channels.list + playlistItems.list) even though the default fixture returns 0 video ids.
  assert.deepEqual(result, { attempted: 1, succeeded: 0, failed: 1, quotaLimited: 0, unitsSpent: 2 });
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt, null, "must never be marked fresh without a corresponding successful audit row");
  assert.equal(store.collectionRuns[0]?.status, "failed");
});

// Found by independent review, before merge: an earlier version set videosReturned from the raw API
// response length BEFORE the per-video insert loop ran, so a mid-loop insert failure left the audit
// row overstating what was actually persisted to market_video_snapshots.
test("AC-9B-15: videosReturned counts only videos actually persisted, never the raw API response length, when an insert fails partway through", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1", "v2", "v3"],
    publicVideoSnapshots: [
      { videoId: "v1", title: "V1", publishedAt: null, viewCount: 1, likeCount: null, commentCount: null },
      { videoId: "v2", title: "V2", publishedAt: null, viewCount: 2, likeCount: null, commentCount: null },
      { videoId: "v3", title: "V3", publishedAt: null, viewCount: 3, likeCount: null, commentCount: null },
    ],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.failVideoSnapshotInsertAfterNth(2);

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 1, succeeded: 0, failed: 1, quotaLimited: 0, unitsSpent: 3 });
  assert.equal(store.videoSnapshots.length, 2, "the 2 videos that DID insert successfully before the failure must be persisted");

  const [run] = store.collectionRuns;
  assert.equal(run.status, "failed");
  assert.equal(run.videosRequested, 3);
  assert.equal(run.videosReturned, 2, "must report exactly what was actually persisted (2), never the raw API response length (3)");
});

// Found by a second round of independent review, right after AC-9B-14's own fix landed: writing
// the success row BEFORE the mark closed the original gap, but introduced a NEW one -- if the mark
// itself throws (after the success row already landed), the catch block wrote a SECOND row with
// status:"failed" and the identical unitsSpent, double-counting real spend in the quota ledger and
// wrongly placing an actually-successful channel into the 24h failure-retry backoff.
test("AC-9B-16: if only the mark (not the audit row) fails, exactly one row is written, spend is counted once, and the channel is never placed in the failure backoff", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const { store, services } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.failNextMarkOnce();

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(result, { attempted: 1, succeeded: 1, failed: 0, quotaLimited: 0, unitsSpent: 2 });
  assert.equal(store.collectionRuns.length, 1, "exactly one row -- never a second, double-counting row for the same attempt");
  assert.equal(store.collectionRuns[0]?.status, "success");
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt, null, "the mark itself never landed -- the channel stays stale for a free retry next run");

  const recentlyFailed = await store.listRecentlyFailedResearchChannelIds(since);
  assert.deepEqual(recentlyFailed, [], "an attempt that genuinely succeeded must never be placed in the failure backoff");
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md §9) -- acceptance criteria for
// discoverChannels/listDiscoveryCandidates/updateDiscoveryCandidateStatus/promoteDiscoveryCandidate,
// drafted from the plan's own §9 before this file's own implementation was read line-by-line
// (AGENTS.md §L).
// ---------------------------------------------------------------------------

// REVISED by BL-145 (P2, owner decision, Telegram 2026-10-07 msgs 1904/1905): a search never spends the daily UNIT
// budget (it has its own bucket since 2026-06-01, see AC-9C-02), so "no unit budget set" (automatic collection off)
// must no longer block a manual search. The old expectation refused it, which the owner decided is wrong.
test("AC-9C-01 (BL-145): with the unit budget unset, a search still runs -- it uses only the 100-searches bucket", async () => {
  const { store, services, searchCalls } = createFixture();

  const result = await services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal(searchCalls.length, 1);
  assert.equal(store.discoveryRuns.length, 1);
  assert.equal(store.discoveryRuns[0].unitsSpent, 1);
  assert.equal(result.candidatesFound, 0);
});

test("BL-145 (P6): the query is trimmed before the search, and a blank query is refused before any call", async () => {
  const { services, searchCalls } = createFixture();
  await services.discoverChannels({ query: "  cooking  ", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal((searchCalls[0] as { query: string }).query, "cooking");
  await assert.rejects(
    () => services.discoverChannels({ query: "   ", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(searchCalls.length, 1);
});

// Phase 13 slice 13.4 -- REVISED: since 2026-06-01 `search.list` has its own quota bucket of 100 calls
// per day at 1 unit each (official quota page / revision history), no longer 100 units of the shared
// pool. The old expectation (100 units, shared with collection) encoded a quota model YouTube dropped.
test("AC-9C-02 (13.4): with 100 searches already made today, discoverChannels throws MARKET_INTELLIGENCE_QUOTA_EXCEEDED before any real call -- collection spend does not matter", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, searchCalls } = createFixture({ now });
  store.setQuotaBudget(150);
  for (let i = 0; i < 100; i++) {
    store.discoveryRuns.push({ query: `q${i}`, status: "success", unitsSpent: 1, candidatesFound: 0, candidatesNew: 0, errorMessage: null, ranAt: now });
  }
  await assert.rejects(
    () => services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }),
    (error: unknown) => {
      if (!isDomainError(error) || error.code !== "MARKET_INTELLIGENCE_QUOTA_EXCEEDED") return false;
      assert.deepEqual(error.details, { remaining: 0, required: 1 });
      return true;
    }
  );
  assert.equal(searchCalls.length, 0);
});

test("13.4: a 99th search today still runs, even when the collection has spent the whole unit budget", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, searchCalls } = createFixture({ now });
  store.setQuotaBudget(10);
  store.collectionRuns.push({ researchChannelId: VALID_CHANNEL_ID, status: "success", unitsSpent: 10, videosRequested: null, videosReturned: null, errorMessage: null, ranAt: now });
  for (let i = 0; i < 98; i++) {
    store.discoveryRuns.push({ query: `q${i}`, status: "success", unitsSpent: 1, candidatesFound: 0, candidatesNew: 0, errorMessage: null, ranAt: now });
  }
  await services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal(searchCalls.length, 1);
  assert.equal(store.discoveryRuns.at(-1)?.unitsSpent, 1);
});

test("13.4: searches made before midnight Pacific time do not count against today's limit", async () => {
  // 2026-09-27T12:00Z is 05:00 PDT; the quota day began at 2026-09-27T07:00Z.
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, searchCalls } = createFixture({ now });
  store.setQuotaBudget(150);
  for (let i = 0; i < 100; i++) {
    store.discoveryRuns.push({ query: `q${i}`, status: "success", unitsSpent: 1, candidatesFound: 0, candidatesNew: 0, errorMessage: null, ranAt: new Date("2026-09-27T06:59:00.000Z") });
  }
  await services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal(searchCalls.length, 1);
});
test("AC-9C-03/04/05: a result already watchlisted is skipped; a result matching an existing candidate only touches lastSeenAt (never resets status); a genuinely new result is inserted as status:new", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({
    now,
    searchResults: [
      { channelId: VALID_CHANNEL_ID, title: "Already Watchlisted", description: null },
      { channelId: OTHER_VALID_CHANNEL_ID, title: "Existing Candidate", description: "desc" },
      { channelId: "UC_BRAND_NEW00000000000", title: "Brand New", description: "new one" },
    ],
  });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  store.discoveryCandidates.set(OTHER_VALID_CHANNEL_ID, {
    id: OTHER_VALID_CHANNEL_ID,
    title: "Existing Candidate (old title)",
    status: "ignored",
    discoverySource: "youtube.search.list",
    discoveryQuery: "old query",
    reasonDiscovered: null,
    firstSeenAt: new Date("2026-09-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-09-01T00:00:00.000Z"),
    createdVia: "web_ui",
  });

  const result = await services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  // BL-145 (P4): plus the candidates this search created or found again -- the existing one and the new one, in result
  // order; never the already-watchlisted channel.
  assert.deepEqual(result, { candidatesFound: 3, candidatesNew: 1, candidateIds: [OTHER_VALID_CHANNEL_ID, "UC_BRAND_NEW00000000000"] });

  assert.equal(store.discoveryCandidates.has(VALID_CHANNEL_ID), false, "a result already on the watchlist must never become a candidate");

  const existing = store.discoveryCandidates.get(OTHER_VALID_CHANNEL_ID);
  assert.equal(existing?.status, "ignored", "rediscovery must never reset an operator-set status");
  // REVISED in Phase 13 (review round 1): the title is YouTube API data about another channel. Bumping
  // `lastSeenAt` restarts its 30-day retention clock (III.E.4.d "delete or refresh"), so the title must
  // be refreshed with it -- the old "never overwrite the title" rule kept a stale API title forever.
  // The operator's own decision (status, asserted above) is still never touched.
  assert.equal(existing?.title, "Existing Candidate", "rediscovery refreshes the API-sourced title along with its clock");
  assert.equal(existing?.lastSeenAt.getTime(), now.getTime());

  const brandNew = store.discoveryCandidates.get("UC_BRAND_NEW00000000000");
  assert.equal(brandNew?.status, "new");
  assert.equal(brandNew?.reasonDiscovered, "new one");

  assert.equal(store.discoveryCandidates.size, 2, "exactly the existing candidate plus the one genuinely new one -- never a third for the already-watchlisted result");
});

test("AC-9C-06: updateDiscoveryCandidateStatus rejects a target of promoted, and rejects any status change on an already-promoted candidate", async () => {
  const { store, services } = createFixture();
  store.discoveryCandidates.set("UC_PROMOTED00000000000", {
    id: "UC_PROMOTED00000000000",
    title: "Promoted",
    status: "promoted",
    discoverySource: "youtube.search.list",
    discoveryQuery: "q",
    reasonDiscovered: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdVia: "web_ui",
  });
  store.discoveryCandidates.set("UC_NOT_PROMOTED0000000", {
    id: "UC_NOT_PROMOTED0000000",
    title: "Watching",
    status: "watching",
    discoverySource: "youtube.search.list",
    discoveryQuery: "q",
    reasonDiscovered: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdVia: "web_ui",
  });

  // Schema itself rejects "promoted" as a target status.
  await assert.rejects(
    () => services.updateDiscoveryCandidateStatus({ channelId: "UC_NOT_PROMOTED0000000", status: "promoted" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );

  await assert.rejects(
    () => services.updateDiscoveryCandidateStatus({ channelId: "UC_PROMOTED00000000000", status: "watching" }),
    (error: unknown) => isDomainError(error) && error.code === "DISCOVERY_CANDIDATE_ALREADY_PROMOTED"
  );
});

test("AC-9C-07: promoteDiscoveryCandidate creates exactly one research_channels row (never a duplicate if already watchlisted) and sets the candidate's status to promoted", async () => {
  const { store, services } = createFixture();
  store.discoveryCandidates.set("UC_TO_PROMOTE000000000", {
    id: "UC_TO_PROMOTE000000000",
    title: "To Promote",
    status: "watching",
    discoverySource: "youtube.search.list",
    discoveryQuery: "q",
    reasonDiscovered: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdVia: "web_ui",
  });

  const result = await services.promoteDiscoveryCandidate(
    { channelId: "UC_TO_PROMOTE000000000", reason: "Promoted from discovery" },
    { createdVia: "web_ui" }
  );
  assert.equal(result.channel.channelId, "UC_TO_PROMOTE000000000");
  assert.equal(result.candidate.status, "promoted");
  assert.equal(store.channels.size, 1);

  // Idempotent: promoting again (e.g. a retry) never creates a duplicate watchlist row.
  await assert.rejects(
    () => services.promoteDiscoveryCandidate({ channelId: "UC_TO_PROMOTE000000000", reason: "again" }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "DISCOVERY_CANDIDATE_ALREADY_PROMOTED"
  );
  assert.equal(store.channels.size, 1, "must never create a second watchlist row");
});

test("AC-9C-07b: promoteDiscoveryCandidate is idempotent when the channel is already watchlisted by some other path", async () => {
  const { store, services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "added separately" }, { createdVia: "web_ui" });
  store.discoveryCandidates.set(VALID_CHANNEL_ID, {
    id: VALID_CHANNEL_ID,
    title: "Already Watchlisted Elsewhere",
    status: "new",
    discoverySource: "youtube.search.list",
    discoveryQuery: "q",
    reasonDiscovered: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdVia: "web_ui",
  });

  const result = await services.promoteDiscoveryCandidate({ channelId: VALID_CHANNEL_ID, reason: "promote" }, { createdVia: "web_ui" });
  assert.equal(result.channel.reason, "added separately", "must never overwrite the existing watchlist row's own reason");
  assert.equal(result.candidate.status, "promoted");
  assert.equal(store.channels.size, 1);
});

test("AC-9C-08 (13.4): a search.list call that throws still records its own real spend (1 unit of the search bucket) on the run log", async () => {
  const { store, services } = createFixture({
    searchImpl: async () => {
      throw new Error("simulated search.list failure");
    },
  });
  store.setQuotaBudget(1000);

  await assert.rejects(() => services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }));

  assert.equal(store.discoveryRuns.length, 1);
  assert.equal(store.discoveryRuns[0]?.status, "failed");
  assert.equal(store.discoveryRuns[0]?.unitsSpent, 1, "a thrown request must still record its own real, non-zero spend");
});

// Phase 13 slice 13.4 -- REVISED: since 2026-06-01 `search.list` has its own quota bucket of 100 calls
// per day at 1 unit each (official quota page / revision history), no longer 100 units of the shared
// pool. The old expectation (100 units, shared with collection) encoded a quota model YouTube dropped.
test("AC-9C-09 (13.4): the shared unit budget counts collection only -- a search is not refused because collection spent units", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, searchCalls } = createFixture({ now });
  store.setQuotaBudget(100);
  store.collectionRuns.push({ researchChannelId: VALID_CHANNEL_ID, status: "success", unitsSpent: 100, videosRequested: null, videosReturned: null, errorMessage: null, ranAt: now });
  await services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal(searchCalls.length, 1);
});

test("AC-9C-10 (13.4): a throw from the dedup loop (after search.list itself succeeded) still records the search's spend, with whatever partial candidate counts were actually reached", async () => {
  const { store, services } = createFixture({
    searchResults: [
      { channelId: "UC_FIRST00000000000000", title: "First", description: null },
      { channelId: "UC_SECOND000000000000", title: "Second", description: null },
      { channelId: "UC_THIRD0000000000000", title: "Third", description: null },
    ],
  });
  store.setQuotaBudget(1000);
  store.failInsertMarketDiscoveryCandidateForChannel("UC_SECOND000000000000");

  await assert.rejects(() => services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }));

  assert.equal(store.discoveryRuns.length, 1);
  const [run] = store.discoveryRuns;
  assert.equal(run.status, "failed");
  assert.equal(run.unitsSpent, 1, "the search.list call itself succeeded and really cost 1 unit of the search bucket -- must never be lost");
  assert.equal(run.candidatesFound, 3);
  assert.equal(run.candidatesNew, 1, "only the first candidate was actually inserted before the second one threw");
  assert.equal(store.discoveryCandidates.has("UC_FIRST00000000000000"), true);
  assert.equal(store.discoveryCandidates.has("UC_THIRD0000000000000"), false, "the loop must stop at the throw, never skip ahead");
});

// Found by independent review: a disabled "Data API reads" toggle is a purely local, no-network
// condition -- charging the call's own cost for it (as a generic per-call catch would) is dishonest,
// since no real YouTube quota was ever spent.
test("AC-9C-11: discoverChannels checks Data API reads availability BEFORE spending any budget, and records no run at all when reads are disabled", async () => {
  const { store, services, searchCalls } = createFixture({ dataApiReadsDisabled: true });
  store.setQuotaBudget(1000);

  await assert.rejects(
    () => services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "data_api_reads_disabled"
  );
  assert.equal(searchCalls.length, 0, "must never reach the real search.list call");
  assert.equal(store.discoveryRuns.length, 0, "no run row -- nothing was ever attempted, let alone charged");
});

test("AC-9B-17: runCollectionIfStale checks Data API reads availability BEFORE claiming any channel, and charges nothing when reads are disabled", async () => {
  const { store, services, snapshotCalls } = createFixture({ dataApiReadsDisabled: true, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  await assert.rejects(
    () => services.runCollectionIfStale({ credentialRef: { userId: "u1" } }),
    (error: unknown) => isDomainError(error) && error.code === "data_api_reads_disabled"
  );
  assert.equal(snapshotCalls.length, 0);
  assert.equal(store.collectionRuns.length, 0);
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.collectionClaimedAt, null, "no channel was ever claimed");
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9E, part A (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md §5) -- acceptance criteria
// for createTopic/listTopics/deleteTopic/assignTopic/removeTopicAssignment/listAssignmentsForTopic/
// listTopicsForSubject, drafted from the plan's own §5 before this file's own implementation was
// read line-by-line (AGENTS.md §L).
// ---------------------------------------------------------------------------

test("AC-9E-01: createTopic rejects a duplicate name using a normalized (trimmed/whitespace-collapsed/case-insensitive) comparison", async () => {
  const { store, services } = createFixture();
  await services.createTopic({ name: "Night Jazz Bar" }, { createdVia: "web_ui" });

  await assert.rejects(
    () => services.createTopic({ name: "  night   jazz bar  " }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "TOPIC_ALREADY_EXISTS"
  );
  assert.equal(store.topics.size, 1, "must never create a second row for a normalized-duplicate name");
});

test("AC-9E-01b: createTopic normalizes whitespace in the stored name, but preserves the operator's own casing", async () => {
  const { services } = createFixture();
  const topic = await services.createTopic({ name: "  Retro   Cocktail  Lounge  " }, { createdVia: "web_ui" });
  assert.equal(topic.name, "Retro Cocktail Lounge");
});

test("AC-9E-02: assignTopic rejects an unknown topicId before storage", async () => {
  const { store, services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  await assert.rejects(
    () => services.assignTopic({ topicId: "nonexistent-topic", subjectType: "channel", subjectId: VALID_CHANNEL_ID }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "TOPIC_NOT_FOUND"
  );
  assert.equal(store.topicAssignments.length, 0);
});

test("AC-9E-02b: assignTopic rejects a channel subject not on the watchlist, and rejects a malformed video subject id at the schema layer", async () => {
  const { store, services } = createFixture();
  const topic = await services.createTopic({ name: "Some Topic" }, { createdVia: "web_ui" });

  await assert.rejects(
    () => services.assignTopic({ topicId: topic.topicId, subjectType: "channel", subjectId: VALID_CHANNEL_ID }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );

  await assert.rejects(
    () => services.assignTopic({ topicId: topic.topicId, subjectType: "video", subjectId: "not-11-chars" }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(store.topicAssignments.length, 0);
});

test("AC-9E-03: assignTopic rejects an exact-duplicate (topic, subject) pair before insert, and accepts the same subject under a different topic", async () => {
  const { store, services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  const topicA = await services.createTopic({ name: "Topic A" }, { createdVia: "web_ui" });
  const topicB = await services.createTopic({ name: "Topic B" }, { createdVia: "web_ui" });

  await services.assignTopic({ topicId: topicA.topicId, subjectType: "channel", subjectId: VALID_CHANNEL_ID }, { createdVia: "web_ui" });

  await assert.rejects(
    () => services.assignTopic({ topicId: topicA.topicId, subjectType: "channel", subjectId: VALID_CHANNEL_ID }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "TOPIC_ASSIGNMENT_ALREADY_EXISTS"
  );

  // The same channel under a DIFFERENT topic is a genuinely new, distinct assignment.
  await services.assignTopic({ topicId: topicB.topicId, subjectType: "channel", subjectId: VALID_CHANNEL_ID }, { createdVia: "web_ui" });
  assert.equal(store.topicAssignments.length, 2);
});

test("AC-9E-04: a valid video-format subject id is accepted without an existence check (market_video_snapshots has no canonical single row per video)", async () => {
  const { services } = createFixture();
  const topic = await services.createTopic({ name: "Some Topic" }, { createdVia: "web_ui" });
  const assignment = await services.assignTopic(
    { topicId: topic.topicId, subjectType: "video", subjectId: "dQw4w9WgXcQ" },
    { createdVia: "web_ui" }
  );
  assert.equal(assignment.subjectType, "video");
  assert.equal(assignment.subjectId, "dQw4w9WgXcQ");
  assert.equal(assignment.source, "manual");
});

test("AC-9E-05: listAssignmentsForTopic/listTopicsForSubject return exactly the matching rows; removeTopicAssignment removes exactly one", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  const topic = await services.createTopic({ name: "Some Topic" }, { createdVia: "web_ui" });
  const assignment = await services.assignTopic(
    { topicId: topic.topicId, subjectType: "channel", subjectId: VALID_CHANNEL_ID },
    { createdVia: "web_ui" }
  );

  const forTopic = await services.listTopicAssignments({ topicId: topic.topicId });
  assert.equal(forTopic.assignments.length, 1);

  const forSubject = await services.listAssignmentsForSubject({ subjectType: "channel", subjectId: VALID_CHANNEL_ID });
  assert.equal(forSubject.assignments.length, 1);

  await services.removeTopicAssignment({ assignmentId: assignment.assignmentId });
  assert.deepEqual((await services.listTopicAssignments({ topicId: topic.topicId })).assignments, []);
});

test("AC-9E-06: deleteTopic is a silent no-op for an already-absent topic (idempotent, mirrors removeFromWatchlist's own convention)", async () => {
  const { services } = createFixture();
  await services.deleteTopic({ topicId: "nonexistent-topic" });
});

test("AC-9E-07: listAssignmentsForTopic rejects an unknown topicId with TOPIC_NOT_FOUND", async () => {
  const { services } = createFixture();
  await assert.rejects(
    () => services.listTopicAssignments({ topicId: "nonexistent-topic" }),
    (error: unknown) => isDomainError(error) && error.code === "TOPIC_NOT_FOUND"
  );
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9E, part B -- trend candidates (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md §14,
// "do not allow lifecycle labels to exist without supporting observable rules or evidence").
// Acceptance criteria derived from the plan and from advisor's design corrections (recorded in the
// plan doc) BEFORE this file's own service-layer implementation was written:
//
// AC-9E-08: createTrendCandidate rejects an input with no initialEvidence (schema-level -- there is
//           no code path that creates a trend candidate with zero evidence rows).
// AC-9E-09: createTrendCandidate rejects supporting_channel/supporting_video evidence with no
//           referenceId, but accepts a bare "signal" with no referenceId.
// AC-9E-10: createTrendCandidate rejects an unknown topicId with TOPIC_NOT_FOUND.
// AC-9E-11: a successful create always starts at status "emerging", writes exactly one evidence
//           row, and moves lastObservedAt off its raw insert-time default.
// AC-9E-12: updateTrendCandidateStatus rejects a missing/empty reason before storage (schema).
// AC-9E-13: updateTrendCandidateStatus rejects an unknown trendCandidateId with
//           TREND_CANDIDATE_NOT_FOUND.
// AC-9E-14: a successful status update writes a new "signal" evidence row embedding the reason,
//           changes status, and bumps lastObservedAt -- status can never move without a
//           corresponding evidence trail.
// AC-9E-15: recordTrendEvidence rejects an unknown trendCandidateId with TREND_CANDIDATE_NOT_FOUND,
//           and a successful call never changes status while still bumping lastObservedAt.
// AC-9E-16: listTrendCandidates/listTrendEvidence round-trip; listTrendEvidence rejects an unknown
//           trendCandidateId with TREND_CANDIDATE_NOT_FOUND.
// ---------------------------------------------------------------------------

test("AC-9E-08: createTrendCandidate rejects an input with no initialEvidence", async () => {
  const { store, services } = createFixture();

  await assert.rejects(
    () => services.createTrendCandidate({ title: "AI cover songs" }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(store.trendCandidates.size, 0);
});

test("AC-9E-09: createTrendCandidate rejects supporting_channel/supporting_video evidence with no referenceId, but accepts a bare signal with no referenceId", async () => {
  const { store, services } = createFixture();

  await assert.rejects(
    () =>
      services.createTrendCandidate(
        { title: "AI cover songs", initialEvidence: { evidenceType: "supporting_channel", description: "Seen on a competitor" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  await assert.rejects(
    () =>
      services.createTrendCandidate(
        { title: "AI cover songs", initialEvidence: { evidenceType: "supporting_video", description: "One viral video" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(store.trendCandidates.size, 0);

  const created = await services.createTrendCandidate(
    { title: "AI cover songs", initialEvidence: { evidenceType: "signal", description: "Noticed rising search volume" } },
    { createdVia: "web_ui" }
  );
  assert.equal(created.title, "AI cover songs");
});

// AGENTS.md §F: "never identify YouTube videos by title when a canonical video ID is available" --
// found by independent review, before this reached the code-review pass: an earlier version of
// this schema accepted ANY non-empty string as referenceId, which let a free-typed video/channel
// TITLE be smuggled in as "the reference" for supporting_video/supporting_channel evidence.
test("AC-9E-09b: createTrendCandidate rejects a non-id string (e.g. a title) as referenceId for supporting_channel/supporting_video, but accepts a real id", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () =>
      services.createTrendCandidate(
        {
          title: "AI cover songs",
          initialEvidence: { evidenceType: "supporting_video", referenceId: "My Viral Video Title", description: "x" },
        },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  await assert.rejects(
    () =>
      services.createTrendCandidate(
        {
          title: "AI cover songs",
          initialEvidence: { evidenceType: "supporting_channel", referenceId: "Some Competitor Channel", description: "x" },
        },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );

  const created = await services.createTrendCandidate(
    {
      title: "AI cover songs",
      initialEvidence: { evidenceType: "supporting_channel", referenceId: OTHER_VALID_CHANNEL_ID, description: "x" },
    },
    { createdVia: "web_ui" }
  );
  assert.equal(created.title, "AI cover songs");
});

test("AC-9E-10: createTrendCandidate rejects an unknown topicId with TOPIC_NOT_FOUND", async () => {
  const { store, services } = createFixture();

  await assert.rejects(
    () =>
      services.createTrendCandidate(
        { title: "AI cover songs", topicId: "nonexistent-topic", initialEvidence: { evidenceType: "signal", description: "x" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "TOPIC_NOT_FOUND"
  );
  assert.equal(store.trendCandidates.size, 0);
});

test("AC-9E-11: a successful create starts at status 'emerging', writes exactly one evidence row, and moves lastObservedAt off its raw insert-time default", async () => {
  const { store, services } = createFixture({ now: new Date("2026-01-01T00:00:00.000Z") });

  const created = await services.createTrendCandidate(
    { title: "AI cover songs", description: "Short-form covers using AI voice cloning", initialEvidence: { evidenceType: "signal", description: "Rising search volume" } },
    { createdVia: "web_ui" }
  );

  assert.equal(created.status, "emerging");
  assert.equal(created.description, "Short-form covers using AI voice cloning");
  assert.equal(created.topicId, null);
  assert.equal(store.trendEvidence.length, 1);
  assert.equal(store.trendEvidence[0].trendCandidateId, created.trendCandidateId);
  assert.equal(store.trendEvidence[0].description, "Rising search volume");
  // Hand-derived expected value (AGENTS.md §L) -- the fixture's fake clock is pinned to this exact
  // instant, distinct from the fake store's own wall-clock insert default, so this proves
  // lastObservedAt was actually set from the evidence write's `deps.clock.now()`, not merely
  // read back unchanged from whatever the row already held.
  assert.equal(created.lastObservedAt, "2026-01-01T00:00:00.000Z");
});

test("AC-9E-12: updateTrendCandidateStatus rejects a missing/empty reason before storage", async () => {
  const { services } = createFixture();
  const created = await services.createTrendCandidate(
    { title: "AI cover songs", initialEvidence: { evidenceType: "signal", description: "x" } },
    { createdVia: "web_ui" }
  );

  await assert.rejects(
    () => services.updateTrendCandidateStatus({ trendCandidateId: created.trendCandidateId, status: "growing" }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  await assert.rejects(
    () =>
      services.updateTrendCandidateStatus(
        { trendCandidateId: created.trendCandidateId, status: "growing", reason: "" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
});

test("AC-9E-13: updateTrendCandidateStatus rejects an unknown trendCandidateId with TREND_CANDIDATE_NOT_FOUND", async () => {
  const { services } = createFixture();
  await assert.rejects(
    () =>
      services.updateTrendCandidateStatus(
        { trendCandidateId: "nonexistent-trend", status: "growing", reason: "Picking up" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "TREND_CANDIDATE_NOT_FOUND"
  );
});

test("AC-9E-14: a successful status update writes a signal evidence row embedding the reason, changes status, and bumps lastObservedAt", async () => {
  const { store, services, setNow } = createFixture({ now: new Date("2026-01-01T00:00:00.000Z") });
  const created = await services.createTrendCandidate(
    { title: "AI cover songs", initialEvidence: { evidenceType: "signal", description: "Rising search volume" } },
    { createdVia: "web_ui" }
  );
  assert.equal(created.lastObservedAt, "2026-01-01T00:00:00.000Z");
  setNow(new Date("2026-01-02T00:00:00.000Z"));

  const updated = await services.updateTrendCandidateStatus(
    { trendCandidateId: created.trendCandidateId, status: "growing", reason: "Three more channels covering it this week" },
    { createdVia: "web_ui" }
  );

  assert.equal(updated.status, "growing");
  // Hand-derived (AGENTS.md §L): the clock moved to exactly this instant between the two calls.
  assert.equal(updated.lastObservedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(store.trendEvidence.length, 2);
  const signalRow = store.trendEvidence[1];
  assert.equal(signalRow.evidenceType, "signal");
  assert.match(signalRow.description, /Three more channels covering it this week/);
  assert.match(signalRow.description, /growing/);
});

test("AC-9E-15: recordTrendEvidence rejects an unknown trendCandidateId with TREND_CANDIDATE_NOT_FOUND, and a successful call never changes status while still bumping lastObservedAt", async () => {
  const { store, services, setNow } = createFixture({ now: new Date("2026-01-01T00:00:00.000Z") });

  await assert.rejects(
    () =>
      services.recordTrendEvidence(
        { trendCandidateId: "nonexistent-trend", evidenceType: "signal", description: "x" },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "TREND_CANDIDATE_NOT_FOUND"
  );

  const created = await services.createTrendCandidate(
    { title: "AI cover songs", initialEvidence: { evidenceType: "signal", description: "Rising search volume" } },
    { createdVia: "web_ui" }
  );
  assert.equal(created.lastObservedAt, "2026-01-01T00:00:00.000Z");
  setNow(new Date("2026-01-02T00:00:00.000Z"));

  const evidence = await services.recordTrendEvidence(
    { trendCandidateId: created.trendCandidateId, evidenceType: "supporting_video", referenceId: "dQw4w9WgXcQ", description: "Another example" },
    { createdVia: "web_ui" }
  );

  assert.equal(evidence.evidenceType, "supporting_video");
  assert.equal(evidence.referenceId, "dQw4w9WgXcQ");
  assert.equal(store.trendCandidates.get(created.trendCandidateId)!.status, "emerging");
  // Hand-derived (AGENTS.md §L): the clock moved to exactly this instant before recordTrendEvidence.
  assert.equal(store.trendCandidates.get(created.trendCandidateId)!.lastObservedAt.toISOString(), "2026-01-02T00:00:00.000Z");
});

test("AC-9E-16: listTrendCandidates/listTrendEvidence round-trip; listTrendEvidence rejects an unknown trendCandidateId with TREND_CANDIDATE_NOT_FOUND", async () => {
  const { services } = createFixture();
  const created = await services.createTrendCandidate(
    { title: "AI cover songs", initialEvidence: { evidenceType: "signal", description: "Rising search volume" } },
    { createdVia: "web_ui" }
  );
  await services.recordTrendEvidence(
    { trendCandidateId: created.trendCandidateId, evidenceType: "signal", description: "Another data point" },
    { createdVia: "web_ui" }
  );

  const list = await services.listTrendCandidates();
  assert.equal(list.trendCandidates.length, 1);
  assert.equal(list.trendCandidates[0].trendCandidateId, created.trendCandidateId);

  const evidenceList = await services.getTrendEvidence({ trendCandidateId: created.trendCandidateId });
  assert.equal(evidenceList.evidence.length, 2);

  await assert.rejects(
    () => services.getTrendEvidence({ trendCandidateId: "nonexistent-trend" }),
    (error: unknown) => isDomainError(error) && error.code === "TREND_CANDIDATE_NOT_FOUND"
  );
});

// ---------------------------------------------------------------------------
// Phase 9 slice 9G, part B -- agent-created research requests, approval integrity
// (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md §8). Acceptance criteria drafted before
// implementation, per AGENTS.md §L.
// ---------------------------------------------------------------------------

test("AC-9G-B-01: createMarketResearchRequest rejects an empty query/rationale before storage", async () => {
  const { store, services } = createFixture();

  await assert.rejects(
    () => services.createMarketResearchRequest({ query: "", rationale: "worth watching" }, { createdVia: "mcp" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  await assert.rejects(
    () => services.createMarketResearchRequest({ query: "night jazz", rationale: "" }, { createdVia: "mcp" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(store.marketResearchRequests.size, 0);
});

test("AC-9G-B-02: createdVia cannot be smuggled in through the public input -- server-stamped only", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () =>
      services.createMarketResearchRequest(
        { query: "night jazz", rationale: "worth watching", createdVia: "mcp" } as unknown,
        { createdVia: "cli" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );

  const created = await services.createMarketResearchRequest(
    { query: "night jazz", rationale: "worth watching" },
    { createdVia: "cli", agentApiVersion: "1.2.3" }
  );
  assert.equal(created.createdVia, "cli");
  assert.equal(created.agentApiVersion, "1.2.3");
});

test("AC-9G-B-02b: createMarketResearchRequest stamps createdAt from the injected clock, not real wall-clock time (found by independent code review -- a mocked clock could otherwise leave resolvedAt earlier than createdAt)", async () => {
  const frozenNow = new Date("2026-01-01T00:00:00.000Z");
  const { services } = createFixture({ now: frozenNow });

  const created = await services.createMarketResearchRequest(
    { query: "night jazz", rationale: "worth watching" },
    { createdVia: "mcp" }
  );

  assert.equal(created.createdAt, frozenNow.toISOString());
});

test("AC-9G-B-03: createMarketResearchRequest makes zero YouTube calls and writes zero quota-ledger rows", async () => {
  const { store, services, resolveCalls, searchCalls } = createFixture();

  await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });

  assert.equal(resolveCalls.length, 0);
  assert.equal(searchCalls.length, 0);
  assert.equal(store.discoveryRuns.length, 0);
  assert.equal(store.collectionRuns.length, 0);
});

test("AC-9G-B-04: a new request always starts status 'pending'", async () => {
  const { services } = createFixture();
  const created = await services.createMarketResearchRequest(
    { query: "night jazz", rationale: "worth watching", monitorDurationDays: 30 },
    { createdVia: "mcp" }
  );
  assert.equal(created.status, "pending");
  assert.equal(created.monitorDurationDays, 30);
  assert.equal(created.resolvedAt, null);
});

test("AC-9G-B-05: approve/reject on an unknown id throws RESEARCH_REQUEST_NOT_FOUND; on an already-resolved id throws RESEARCH_REQUEST_NOT_PENDING", async () => {
  const { store, services } = createFixture();
  store.setQuotaBudget(1000);

  await assert.rejects(
    () => services.approveMarketResearchRequest({ requestId: "nonexistent", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_REQUEST_NOT_FOUND"
  );
  await assert.rejects(
    () => services.rejectMarketResearchRequest({ requestId: "nonexistent", reason: "not relevant" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_REQUEST_NOT_FOUND"
  );

  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });
  await services.rejectMarketResearchRequest({ requestId: created.requestId, reason: "not relevant" });

  await assert.rejects(
    () =>
      services.approveMarketResearchRequest(
        { requestId: created.requestId, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_REQUEST_NOT_PENDING"
  );
  await assert.rejects(
    () => services.rejectMarketResearchRequest({ requestId: created.requestId, reason: "again" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_REQUEST_NOT_PENDING"
  );
});

// REVISED by BL-145 (P2, owner 2026-10-07): an unset unit budget no longer blocks a search, so it is no longer one of
// the preconditions here; the exhausted search bucket and disabled reads still are.
test("AC-9G-B-05b: an exhausted search bucket, or disabled Data API reads, leaves the request 'pending' -- never permanently burned into execution_failed", async () => {
  const { store, services } = createFixture();
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });

  // Today's search bucket is exhausted (13.4: 100 searches per quota day).
  store.setQuotaBudget(50);
  for (let i = 0; i < 100; i++) {
    store.discoveryRuns.push({ query: `q${i}`, status: "success", unitsSpent: 1, candidatesFound: 0, candidatesNew: 0, errorMessage: null, ranAt: new Date() });
  }
  await assert.rejects(
    () =>
      services.approveMarketResearchRequest(
        { requestId: created.requestId, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "MARKET_INTELLIGENCE_QUOTA_EXCEEDED"
  );
  assert.equal(store.marketResearchRequests.get(created.requestId)?.status, "pending");

  // Budget sufficient, but Data API reads disabled -- a separate fixture, since this override is
  // fixed at fixture creation (AGENTS.md §L: the test must actually exercise the third case its own
  // title claims, not just assert on the first two).
  const readsDisabledFixture = createFixture({ dataApiReadsDisabled: true });
  readsDisabledFixture.store.setQuotaBudget(1000);
  const secondRequest = await readsDisabledFixture.services.createMarketResearchRequest(
    { query: "night jazz", rationale: "worth watching" },
    { createdVia: "mcp" }
  );
  await assert.rejects(
    () =>
      readsDisabledFixture.services.approveMarketResearchRequest(
        { requestId: secondRequest.requestId, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "data_api_reads_disabled"
  );
  assert.equal(readsDisabledFixture.store.marketResearchRequests.get(secondRequest.requestId)?.status, "pending");
});

// Found by independent review (2026-09-29): approveMarketResearchRequest used to run the budget/
// credential precondition checks BEFORE checking whether the request was even still pending, so an
// already-resolved request with no quota budget set failed with MARKET_INTELLIGENCE_QUOTA_DISABLED
// instead of the true reason, RESEARCH_REQUEST_NOT_PENDING -- misdescribing an already-resolved
// request as blocked by quota to whatever MCP/API/UI consumer branches on the error code.
test("AC-9G-B-05d: approving an already-resolved request reports RESEARCH_REQUEST_NOT_PENDING even with no quota budget set, never MARKET_INTELLIGENCE_QUOTA_DISABLED", async () => {
  const { store, services } = createFixture();
  store.setQuotaBudget(1000);
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });
  await services.rejectMarketResearchRequest({ requestId: created.requestId, reason: "not relevant" });

  // Budget removed AFTER resolving the request -- if the NOT_PENDING check ran after the budget
  // check (the bug), this would surface MARKET_INTELLIGENCE_QUOTA_DISABLED instead.
  store.setQuotaBudget(null);
  await assert.rejects(
    () =>
      services.approveMarketResearchRequest(
        { requestId: created.requestId, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_REQUEST_NOT_PENDING"
  );
});

test("AC-9G-B-05c: a credential resolution failure (e.g. expired token) leaves the request 'pending', never execution_failed", async () => {
  const { store, services } = createFixture({ resolveError: new Error("insufficient scope") });
  store.setQuotaBudget(1000);
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });

  await assert.rejects(
    () =>
      services.approveMarketResearchRequest(
        { requestId: created.requestId, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    /insufficient scope/
  );
  assert.equal(store.marketResearchRequests.get(created.requestId)?.status, "pending");
});

test("AC-9G-B-06: two approvals for the same request -- the second observes it already resolved and never triggers a second discoverChannels call", async () => {
  const { store, services, searchCalls } = createFixture({ searchResults: [] });
  store.setQuotaBudget(1000);
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });

  await services.approveMarketResearchRequest({ requestId: created.requestId, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal(searchCalls.length, 1);

  await assert.rejects(
    () =>
      services.approveMarketResearchRequest(
        { requestId: created.requestId, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_REQUEST_NOT_PENDING"
  );
  assert.equal(searchCalls.length, 1, "the second approval must never trigger a second real search.list call");
});

test("AC-9G-B-07: a successful approval calls discoverChannels with the request's own query, sets status 'executed' with candidatesFound/candidatesNew", async () => {
  const { store, services, searchCalls } = createFixture({
    searchResults: [
      { channelId: "UC_DISCOVERED00000000000", title: "Discovered Channel", description: null },
    ],
  });
  store.setQuotaBudget(1000);
  const created = await services.createMarketResearchRequest({ query: "night jazz bar", rationale: "worth watching" }, { createdVia: "mcp" });

  const approved = await services.approveMarketResearchRequest(
    { requestId: created.requestId, credentialRef: { userId: "u1" } },
    { createdVia: "web_ui" }
  );

  assert.equal(approved.status, "executed");
  assert.equal(approved.candidatesFound, 1);
  assert.equal(approved.candidatesNew, 1);
  assert.deepEqual(
    searchCalls.map((c) => (c as { query: string }).query),
    ["night jazz bar"]
  );
  assert.equal(store.discoveryRuns.length, 1, "must reuse discoverChannels's own existing quota ledger, never a second parallel one");
});

test("AC-9G-B-07b: if the row is no longer 'approved' by the time discovery succeeds (e.g. an external actor moved it away mid-flight), approveMarketResearchRequest rejects with RESEARCH_REQUEST_NOT_PENDING instead of silently returning success (found by independent code review: this guard's own throw was previously swallowed by an enclosing try/catch)", async () => {
  let requestId = "";
  const { store, services } = createFixture({
    searchImpl: async () => {
      // Simulates a real-world race: something else (a concurrent reject, a reconciliation pass)
      // moves the row away from "approved" while discovery is still in flight, strictly BEFORE
      // recordMarketResearchRequestExecutionOutcome's own guarded write runs.
      const row = store.marketResearchRequests.get(requestId)!;
      store.marketResearchRequests.set(requestId, { ...row, status: "rejected" });
      return [{ channelId: "UC_DISCOVERED00000000000", title: "Discovered Channel", description: null }];
    },
  });
  store.setQuotaBudget(1000);
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });
  requestId = created.requestId;

  await assert.rejects(
    () => services.approveMarketResearchRequest({ requestId, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_REQUEST_NOT_PENDING"
  );
  assert.equal(store.marketResearchRequests.get(requestId)?.status, "rejected", "the row must be left exactly as the external actor set it, never overwritten with 'executed'");
});

test("AC-9G-B-08: a discoverChannels failure after the atomic transition sets status 'execution_failed' with executionError, never reverting the approval", async () => {
  const { store, services } = createFixture({
    searchImpl: async () => {
      throw new Error("simulated search.list failure");
    },
  });
  store.setQuotaBudget(1000);
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });

  const result = await services.approveMarketResearchRequest(
    { requestId: created.requestId, credentialRef: { userId: "u1" } },
    { createdVia: "web_ui" }
  );

  assert.equal(result.status, "execution_failed");
  assert.match(result.executionError ?? "", /simulated search\.list failure/);
  assert.notEqual(store.marketResearchRequests.get(created.requestId)?.resolvedAt, null, "the approval itself must not be undone by a downstream execution failure");
});

test("AC-9G-B-08b: if the row is no longer 'approved' by the time a FAILED discovery's own outcome is recorded, approveMarketResearchRequest rejects with RESEARCH_REQUEST_NOT_PENDING instead of silently returning the row's current (unrelated) state (found by independent code review: the catch branch's own guarded write result was discarded exactly like the success path's was)", async () => {
  let requestId = "";
  const { store, services } = createFixture({
    searchImpl: async () => {
      const row = store.marketResearchRequests.get(requestId)!;
      store.marketResearchRequests.set(requestId, { ...row, status: "rejected" });
      throw new Error("simulated search.list failure");
    },
  });
  store.setQuotaBudget(1000);
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });
  requestId = created.requestId;

  await assert.rejects(
    () => services.approveMarketResearchRequest({ requestId, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_REQUEST_NOT_PENDING"
  );
  assert.equal(store.marketResearchRequests.get(requestId)?.status, "rejected", "the row must be left exactly as the external actor set it, never overwritten with 'execution_failed'");
});

test("AC-9G-B-09: rejectMarketResearchRequest requires a non-empty reason and transitions pending -> rejected", async () => {
  const { services } = createFixture();
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });

  await assert.rejects(
    () => services.rejectMarketResearchRequest({ requestId: created.requestId, reason: "" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );

  const rejected = await services.rejectMarketResearchRequest({ requestId: created.requestId, reason: "not aligned with current strategy" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.resolvedReason, "not aligned with current strategy");
});

test("listMarketResearchRequests/getMarketResearchRequest round-trip; getMarketResearchRequest rejects an unknown id with RESEARCH_REQUEST_NOT_FOUND", async () => {
  const { services } = createFixture();
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });

  const list = await services.listResearchRequests();
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].requestId, created.requestId);

  const fetched = await services.getMarketResearchRequest({ requestId: created.requestId });
  assert.deepEqual(fetched, created);

  await assert.rejects(
    () => services.getMarketResearchRequest({ requestId: "nonexistent" }),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_REQUEST_NOT_FOUND"
  );
});

function pushDay7VideoSnapshot(
  store: ReturnType<typeof createFakeStore>,
  now: Date,
  args: { id: string; videoId: string; viewCount: number }
) {
  const publishedAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  store.videoSnapshots.push({
    id: args.id,
    researchChannelId: VALID_CHANNEL_ID,
    videoId: args.videoId,
    observedAt: now,
    viewCount: args.viewCount,
    likeCount: null,
    commentCount: null,
    publishedAt,
    title: null,
    source: "youtube.videos.list",
    createdVia: "web_ui",
  });
}

// ---------------------------------------------------------------------------
// Phase 13 slice 13.3 (docs/roadmap/plans/PHASE_13_PLAN.md, owner decision D1 = a, msg 1129) --
// REPLACES AC-9H-02..06b, AC-9HB-04/05 and AC-9HC-03/04. Those asserted velocity, breakout and
// emerging-channel values computed from watchlist channels' snapshots. The requirement changed:
// YouTube API Developer Policies III.E.4.h forbid "new or derived data or metrics" from API Data,
// and every watchlist channel is someone else's (Non-Authorized) data. The pure math is still
// covered by derived-metrics.test.ts / historical-intelligence.test.ts for our own channels.
// ---------------------------------------------------------------------------

test("13.3: the channel summary returns raw snapshots but no velocity/breakout/emerging values, with the policy reason", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  for (const [id, ageDays, subs] of [["snap-early", 8, 100], ["snap-late", 0, 180]] as const) {
    store.channelSnapshots.push({
      id,
      researchChannelId: VALID_CHANNEL_ID,
      observedAt: new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000),
      subscriberCount: subs,
      viewCount: 1000,
      videoCount: 5,
      hiddenSubscriberCount: false,
      source: "youtube.channels.list",
      createdVia: "web_ui",
    });
  }
  pushDay7VideoSnapshot(store, now, { id: "s-a", videoId: "vA00000000000000000000A", viewCount: 10 });
  pushDay7VideoSnapshot(store, now, { id: "s-b", videoId: "vB00000000000000000000B", viewCount: 20 });
  pushDay7VideoSnapshot(store, now, { id: "s-c", videoId: "vC00000000000000000000C", viewCount: 30 });
  pushDay7VideoSnapshot(store, now, { id: "s-d", videoId: "vD00000000000000000000D", viewCount: 65 });

  const result = await services.getChannelIntelligenceSummary({ channelId: VALID_CHANNEL_ID });
  assert.deepEqual(result.subscriberVelocity, { value: null, basis: "withheld_by_policy" });
  assert.deepEqual(result.uploadCadence, { value: null, basis: "withheld_by_policy" });
  assert.deepEqual(result.recentBreakoutVideos, []);
  assert.equal(result.emergingChannel.isEmerging, false);
  assert.match(result.emergingChannel.reasons.join(" "), /III\.E\.4\.h/);
  // The raw observations themselves are still shown (with their time, III.E.4.f).
  assert.equal(result.channelSnapshots.length, 2);
  assert.equal(result.latestSnapshotPerVideo.length, 4);
});

test("13.3: the market videos overview shows each video's latest raw count but no velocity or breakout", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  for (const [id, ageDays, views] of [["s-day0", 5, 100], ["s-day5", 0, 150]] as const) {
    store.videoSnapshots.push({
      id,
      researchChannelId: VALID_CHANNEL_ID,
      videoId: "vVelocity000000000000A",
      observedAt: new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000),
      viewCount: views,
      likeCount: null,
      commentCount: null,
      publishedAt: null,
      title: "Velocity Test",
      source: "youtube.videos.list",
      createdVia: "web_ui",
    });
  }
  const result = await services.getMarketVideosOverview();
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].viewCount, 150);
  assert.deepEqual(result.videos[0].velocity, { value: null, basis: "withheld_by_policy" });
  assert.equal(result.videos[0].breakout, null);
});

test("13.3: the market overview lists no breakout videos and no emerging channels derived from other channels' data", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  for (const [id, views] of [["s-a", 10], ["s-b", 10], ["s-c", 10], ["s-d", 10], ["s-e", 100], ["s-f", 100]] as const) {
    pushDay7VideoSnapshot(store, now, { id, videoId: `v${id}`.padEnd(23, "0"), viewCount: views });
  }
  const result = await services.getMarketOverview();
  assert.deepEqual(result.breakoutVideos, []);
  assert.deepEqual(result.emergingChannels, []);
});

// ---------------------------------------------------------------------------
// Phase 13 slices 13.5/13.6, as revised by review round 1: uploads list (with titles and publish
// times) from the uploads playlist (1 unit, up to 50 -- full coverage), statistics from
// videos.batchGetStats (own bucket). RSS (newest ~15, no quota) only when the playlist call fails;
// videos.list only when batchGetStats fails. A channel normally costs 2 pool units, worst case 3.
// ---------------------------------------------------------------------------

test("13.6: playlist + batchGetStats + one videos.list for v1's details: 3 pool units; title/publish time from the playlist and batchGetStats", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, videoSnapshotCalls, feedCalls, batchStatsCalls } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    playlistTitles: { v1: "From playlist" },
    batchStats: [{ videoId: "v1", title: "", publishedAt: "2026-09-20T00:00:00.000Z", viewCount: 10, likeCount: 2, commentCount: 1 }],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  // FO-REQ-0015 item 4: +1 videos.list for the page's video lacking details (v1): channels.list 1 + playlist 1 + details 1 = 3.
  // This fixture's videos.list returns nothing for v1, so the batch row is kept as it was.
  assert.deepEqual(result, { attempted: 1, succeeded: 1, failed: 0, quotaLimited: 0, unitsSpent: 3 });
  assert.equal(batchStatsCalls.length, 1);
  assert.deepEqual(videoSnapshotCalls.map((c) => (c as { videoIds: string[] }).videoIds), [["v1"]]);
  assert.equal(feedCalls.length, 0, "RSS is only a fallback");
  const [snap] = store.videoSnapshots;
  assert.equal(snap.viewCount, 10);
  assert.equal(snap.title, "From playlist", "batchGetStats returns no title (documented shape) -- it comes from the playlist");
  assert.equal(snap.publishedAt?.toISOString(), "2026-09-20T00:00:00.000Z");
  assert.equal(snap.source, "youtube.videos.batchGetStats");
});

test("operator request 2026-10-04: collection stores the raw duration (batchGetStats) and leaves live state NULL there; the videos.list fallback stores both; absent -> NULL, never 0", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const viaBatch = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1", "v2"],
    batchStats: [
      { videoId: "v1", title: "", publishedAt: null, viewCount: 1, likeCount: null, commentCount: null, durationSeconds: 7200 },
      { videoId: "v2", title: "", publishedAt: null, viewCount: 1, likeCount: null, commentCount: null },
    ],
  });
  viaBatch.store.setQuotaBudget(100);
  await viaBatch.services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await viaBatch.services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(viaBatch.store.videoSnapshots.map((v) => [v.videoId, v.durationSeconds, v.liveBroadcastContent]), [["v1", 7200, null], ["v2", null, null]]);

  const viaList = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 7, likeCount: null, commentCount: null, durationSeconds: 59, liveBroadcastContent: "none" }],
  });
  viaList.store.setQuotaBudget(100);
  await viaList.services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await viaList.services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(viaList.store.videoSnapshots.map((v) => [v.durationSeconds, v.liveBroadcastContent]), [[59, "none"]]);
  const context = await viaList.services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.equal(context.videoSnapshots[0].durationSeconds, 59);
  assert.equal(context.videoSnapshots[0].liveBroadcastContent, "none");
});

test("13.6: if batchGetStats fails, statistics come from videos.list (1 more unit) -- nothing is lost", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, videoSnapshotCalls } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 7, likeCount: null, commentCount: null }],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.equal(result.unitsSpent, 3);
  assert.equal(videoSnapshotCalls.length, 1);
  assert.equal(store.videoSnapshots[0].source, "youtube.videos.list");
  assert.equal(store.videoSnapshots[0].title, "V1");
});

test("13.5: if the uploads playlist call fails, the RSS feed (no quota) still supplies the newest uploads with titles", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services, feedCalls } = createFixture({
    now,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistFails: true,
    feedVideos: [{ videoId: "v1", title: "From feed", publishedAt: "2026-09-21T00:00:00.000Z" }],
    batchStats: [{ videoId: "v1", title: "", publishedAt: null, viewCount: 4, likeCount: null, commentCount: null }],
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.equal(result.succeeded, 1);
  // FO-REQ-0015 item 4: +1 videos.list for v1's details (this fixture's videos.list returns nothing, so the feed title stays).
  assert.equal(result.unitsSpent, 3, "channels.list + the failed playlist call (charged) + v1's details read; RSS and batchGetStats are free of the pool");
  assert.equal(feedCalls.length, 1);
  assert.equal(store.videoSnapshots[0].title, "From feed");
  assert.equal(store.videoSnapshots[0].publishedAt?.toISOString(), "2026-09-21T00:00:00.000Z");
});

// Phase 13 slice 13.9 -- current-only Music chart (1 unit), cached in memory, never persisted.
test("13.9: the Music chart is fetched once per region per 30 minutes and never written to the database", async () => {
  const now = new Date("2026-10-01T12:00:00.000Z");
  const { services, musicChartCalls, setNow, store } = createFixture({ now });
  const first = await services.getMusicChart({ regionCode: "us", credentialRef: { userId: "u1" } });
  assert.equal(first.regionCode, "US");
  assert.equal(first.entries[0].title, "Song");
  await services.getMusicChart({ regionCode: "US", credentialRef: { userId: "u1" } });
  assert.equal(musicChartCalls.length, 1, "second view within 30 minutes is served from memory");
  setNow(new Date(now.getTime() + 31 * 60 * 1000));
  await services.getMusicChart({ regionCode: "US", credentialRef: { userId: "u1" } });
  assert.equal(musicChartCalls.length, 2);
  assert.equal(store.videoSnapshots.length, 0);
  assert.equal(store.channelSnapshots.length, 0);
});

test("13.9: an invalid region code is refused before any call", async () => {
  const { services, musicChartCalls } = createFixture();
  await assert.rejects(() => services.getMusicChart({ regionCode: "USA", credentialRef: { userId: "u1" } }));
  assert.equal(musicChartCalls.length, 0);
});

test("13.5 (review round 2): if both the playlist call and the RSS fallback fail, the channel's collection FAILS -- never a silent success", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { store, services } = createFixture({ now, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistFails: true });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  const result = await services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
  assert.equal(store.collectionRuns.at(-1)?.status, "failed");
  assert.equal(store.channels.get(VALID_CHANNEL_ID)?.lastAutoCollectedAt, null, "a failed channel is not marked fresh");
});

// Phase 13 (review round 6): III.E.4.d, owner D1 = (a) and msg 1139 -- a candidate's search.list
// title/reason are never served past 30 days since it was last seen, even before the purge ran.
test("P13: discovery candidates past 30 days -- an undecided one is hidden, a decided one keeps only id and status", async () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const { services, store } = createFixture({ now });
  const day = 24 * 60 * 60 * 1000;
  const put = (id: string, status: DiscoveryCandidateStatus, ageDays: number) =>
    store.discoveryCandidates.set(id, {
      id,
      title: `Title ${id}`,
      status,
      discoverySource: "youtube.search.list",
      discoveryQuery: "jazz",
      reasonDiscovered: `reason ${id}`,
      firstSeenAt: new Date(now.getTime() - ageDays * day),
      lastSeenAt: new Date(now.getTime() - ageDays * day),
      createdVia: "web_ui",
    });
  put("UCnewexpired0000000000000", "new", 31);
  put("UCnewfresh000000000000000", "new", 29);
  put("UCignoredexpired000000000", "ignored", 31);

  const { candidates } = await services.listDiscoveryCandidates();
  const byId = new Map(candidates.map((c) => [c.channelId, c]));
  assert.equal(byId.has("UCnewexpired0000000000000"), false);
  assert.equal(byId.get("UCnewfresh000000000000000")?.title, "Title UCnewfresh000000000000000");
  const decided = byId.get("UCignoredexpired000000000");
  assert.deepEqual([decided?.status, decided?.title, decided?.reasonDiscovered], ["ignored", "", null]);
  const overview = await services.getMarketOverview();
  assert.deepEqual(overview.newDiscoveries.map((c) => c.channelId), ["UCnewfresh000000000000000"]);
});

// Review round 8: the chart's unledgered cost is bounded only if the server itself enforces the list.
test("13.9: a well-formed region code outside the fixed list is refused before any call", async () => {
  const { services, musicChartCalls } = createFixture();
  await assert.rejects(
    services.getMusicChart({ regionCode: "ZZ", credentialRef: { userId: "u1" } }),
    (error: unknown) => (error as { code?: string }).code === "validation_failed"
  );
  assert.equal(musicChartCalls.length, 0);
});

// Phase 13 (review round 9): neverObserved means "never observed at all" (AC-MI-17). A channel whose
// API snapshots expired after 30 days (III.E.4.d) was observed -- it must not read as never collected.
test("P13: a channel collected successfully long ago, whose snapshots have expired, is not neverObserved", async () => {
  const { services, store } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "success",
    unitsSpent: 2,
    videosRequested: 10,
    videosReturned: 10,
    errorMessage: null,
    ranAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
  });
  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.deepEqual(result.channelSnapshots, []);
  assert.equal(result.neverObserved, false);
  // Review round 11: collected once, since expired -- stale, never a healthy-looking empty channel.
  assert.deepEqual(result.dataQualityFlags, ["stale_observation"]);
});

test("P13: a channel whose only collection runs failed is still neverObserved", async () => {
  const { services, store } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });
  store.collectionRuns.push({
    researchChannelId: VALID_CHANNEL_ID,
    status: "failed",
    unitsSpent: 1,
    videosRequested: null,
    videosReturned: null,
    errorMessage: "boom",
    ranAt: new Date(),
  });
  const result = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.equal(result.neverObserved, true);
});

// Review round 10: the strings collection stamps itself mark a row as API data (purged after 30 days,
// hidden, redacted for AI) -- an operator-typed entry must never carry one.
test("P13: manual evidence/snapshot entries refuse a source reserved for API-collected data", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "Worth watching" }, { createdVia: "web_ui" });
  const refused = (error: unknown) => (error as { code?: string }).code === "validation_failed";
  for (const source of ["youtube.channels.list", "youtube.videos.list", " youtube.videos.batchGetStats "]) {
    await assert.rejects(
      services.recordEvidence({ researchChannelId: VALID_CHANNEL_ID, observation: "n", source }, { createdVia: "web_ui" }),
      refused
    );
    await assert.rejects(
      services.recordChannelSnapshot(
        { researchChannelId: VALID_CHANNEL_ID, observedAt: "2026-09-30T00:00:00.000Z", subscriberCount: 5, source },
        { createdVia: "web_ui" }
      ),
      refused
    );
    await assert.rejects(
      services.recordVideoSnapshot(
        { researchChannelId: VALID_CHANNEL_ID, videoId: "abcdefghijk", observedAt: "2026-09-30T00:00:00.000Z", viewCount: 5, source },
        { createdVia: "web_ui" }
      ),
      refused
    );
  }
  // An ordinary free-text source is still accepted.
  await services.recordEvidence({ researchChannelId: VALID_CHANNEL_ID, observation: "n", source: "manual observation" }, { createdVia: "web_ui" });
});

// ---------------------------------------------------------------------------
// Operator request 2026-10-04 -- paged collection deeper than 50 videos. Acceptance criteria, derived from the request (not from the
// implementation); every number below was worked out by hand:
//  * cost of a collection = 1 channels.list + 1 per playlist page [+1 per page whose batch stats failed -> videos.list];
//  * first collection follows nextPageToken until the cap (distinct videos stored) or the publishedAfter date;
//  * a later collection stops at the first page holding only stored videos, or at the cap;
//  * a budget that cannot cover the whole backfill ends it early with a saved cursor; the next stale run resumes there.
// ---------------------------------------------------------------------------

const RUN_INPUT = { credentialRef: { userId: "u1" } };
const T0 = new Date("2026-10-04T12:00:00.000Z");
const DAY_MS = 25 * 60 * 60 * 1000;

function ids(prefix: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${prefix}${i}`);
  return out;
}
const PAGE_A = ids("a", 1, 50);
const PAGE_B = ids("b", 1, 50);
const PAGE_C = ids("c", 1, 50);
const PAGE_D = ids("d", 1, 50);

function distinctStored(store: { videoSnapshots: { videoId: string }[] }): number {
  return new Set(store.videoSnapshots.map((row) => row.videoId)).size;
}

test("depth: cap 120 over a 3-page playlist fetches 3 pages, stores exactly 120 distinct videos (50+50+20), costs 1 + 3 pages + 3 details reads = 7 units, stats via batch (0 pool units)", async () => {
  const { store, services, playlistCalls, batchStatsCalls, videoSnapshotCalls } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A, PAGE_B, PAGE_C],
    autoStats: "batch",
  });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 120, publishedAfter: null });

  const result = await services.runCollectionIfStale(RUN_INPUT);

  // FO-REQ-0015 item 4: +1 videos.list per page with videos lacking details -- all 120 are new: 1 + 3 + 3 = 7.
  assert.deepEqual(result, { attempted: 1, succeeded: 1, failed: 0, quotaLimited: 0, unitsSpent: 7 });
  assert.equal(playlistCalls.length, 3);
  assert.equal(distinctStored(store), 120);
  assert.deepEqual(batchStatsCalls.map((c) => (c as { videoIds: string[] }).videoIds.length), [50, 50, 20]);
  assert.deepEqual(videoSnapshotCalls.map((c) => (c as { videoIds: string[] }).videoIds.length), [50, 50, 20], "one details read per page, for its new videos");
  const row = store.channels.get(VALID_CHANNEL_ID)!;
  assert.deepEqual(
    [row.videosComplete, row.videosCompleteReason, row.videosNextPageToken, row.videosCapAtRun, row.videosPublishedAfterAtRun],
    [1, "cap", null, 120, null]
  );
  assert.equal(store.collectionRuns[0].unitsSpent, 7);
  assert.equal(store.collectionRuns[0].videosRequested, 120);
  assert.equal(store.collectionRuns[0].videosReturned, 120);
});

test("depth: the cap decides how many pages are read -- cap 100 over the same playlist stops after page 2 (1 + 2 pages + 2 details reads = 5 units)", async () => {
  const { store, services, playlistCalls } = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A, PAGE_B, PAGE_C], autoStats: "batch" });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 100, publishedAfter: null });
  const result = await services.runCollectionIfStale(RUN_INPUT);
  // FO-REQ-0015 item 4: +1 videos.list per page with videos lacking details (both pages are new): 1 + 2 + 2 = 5.
  assert.equal(result.unitsSpent, 5);
  assert.equal(playlistCalls.length, 2);
  assert.equal(distinctStored(store), 100);
});

test("depth: steady state -- a second run when page 1 holds only stored videos reads exactly 1 page (2 units)", async () => {
  const { store, services, playlistCalls, setNow } = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A, PAGE_B, PAGE_C], autoStats: "batch" });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 120, publishedAfter: null });
  await services.runCollectionIfStale(RUN_INPUT);
  playlistCalls.length = 0;

  setNow(new Date(T0.getTime() + DAY_MS));
  const second = await services.runCollectionIfStale(RUN_INPUT);

  assert.equal(second.unitsSpent, 2);
  assert.equal(playlistCalls.length, 1);
  assert.equal(distinctStored(store), 120, "nothing new was stored");
  assert.equal(store.videoSnapshots.length, 170, "page 1's 50 videos were re-observed (append-only), as before this feature");
});

test("depth: steady state -- page 1 with 5 new videos reads page 2 too; page 2 holds only stored videos, so paging stops there (2 pages + 1 details read for the 5 new videos = 4 units)", async () => {
  const { store, services, playlistCalls, batchStatsCalls, videoSnapshotCalls, setNow, setPlaylistPages } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A, PAGE_B],
    autoStats: "batch",
  });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 120, publishedAfter: null });
  const first = await services.runCollectionIfStale(RUN_INPUT);
  // FO-REQ-0015 item 4: +1 videos.list per page with videos lacking details: 1 + 2 pages + 2 details reads = 5.
  assert.equal(first.unitsSpent, 5, "100 videos: 2 pages, the playlist ends -> exhausted");
  assert.equal(store.channels.get(VALID_CHANNEL_ID)!.videosCompleteReason, "exhausted");

  // 5 uploads since: page 1 = 5 new + a1..a45; page 2 = a46..a50 + b1..b45; page 3 = b46..b50 (never needed).
  setPlaylistPages([[...ids("n", 1, 5), ...ids("a", 1, 45)], [...ids("a", 46, 50), ...ids("b", 1, 45)], ids("b", 46, 50)]);
  playlistCalls.length = 0;
  batchStatsCalls.length = 0;
  videoSnapshotCalls.length = 0;
  setNow(new Date(T0.getTime() + DAY_MS));
  const second = await services.runCollectionIfStale(RUN_INPUT);

  // FO-REQ-0015 item 4: a1..a45 were detailed in the first run (fresh), so only n1..n5 get a details read: 1 + 2 pages + 1 = 4.
  assert.equal(second.unitsSpent, 4);
  assert.deepEqual(videoSnapshotCalls.map((c) => (c as { videoIds: string[] }).videoIds), [ids("n", 1, 5)]);
  assert.equal(playlistCalls.length, 2);
  assert.equal(distinctStored(store), 105);
  assert.equal(batchStatsCalls.length, 1, "the all-stored page that ends the walk gets no statistics call");
  assert.equal((batchStatsCalls[0] as { videoIds: string[] }).videoIds.length, 50);
});

test("depth: with the default depth (nothing set) one page is read as before, even when a new upload appears -- 1 page + its details read = 3 units, state complete at the cap of 50", async () => {
  const { store, services, playlistCalls, setNow, setPlaylistPages } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A, PAGE_B, PAGE_C],
    autoStats: "batch",
  });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  const first = await services.runCollectionIfStale(RUN_INPUT);
  // FO-REQ-0015 item 4: +1 videos.list for page 1's 50 new videos: 1 + 1 + 1 = 3.
  assert.equal(first.unitsSpent, 3);
  assert.equal(playlistCalls.length, 1);
  const row = store.channels.get(VALID_CHANNEL_ID)!;
  assert.deepEqual([row.videosComplete, row.videosCompleteReason, row.videosCapAtRun], [1, "cap", 50]);

  setPlaylistPages([["new1", ...ids("a", 1, 49)], [...ids("a", 50, 50), ...ids("b", 1, 49)]]);
  playlistCalls.length = 0;
  setNow(new Date(T0.getTime() + DAY_MS));
  const second = await services.runCollectionIfStale(RUN_INPUT);
  // FO-REQ-0015 item 4: +1 videos.list for new1's details (a1..a49 are fresh): 1 + 1 + 1 = 3.
  assert.equal(second.unitsSpent, 3, "the stored count (50) already reaches the cap of 50, so page 2 is not read");
  assert.equal(playlistCalls.length, 1);
  assert.equal(distinctStored(store), 51, "the new upload itself is still captured");
});

test("depth: a budget too small for the whole backfill stops early with a saved cursor; the next stale run resumes from it and finishes", async () => {
  const { store, services, playlistCalls, setNow } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A, PAGE_B, PAGE_C, PAGE_D],
    autoStats: "batch",
  });
  // FO-REQ-0015 item 4: each page with new videos also spends its details read (the unit the budget reserves per page), so the
  // budget is 6 (was 5) to keep "the next run finishes" true.
  store.setQuotaBudget(6);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 200, publishedAfter: null });

  // Budget 6: channels.list (5 left), page 1 (4), its details (3); page 2 needs 2 spare (3-2>=0) -> page 2 (2), details (1);
  // page 3 needs 2 > 1: stop. 5 units, 100 stored, cursor page-3.
  const first = await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(first.unitsSpent, 5);
  assert.equal(first.succeeded, 1);
  assert.equal(playlistCalls.length, 2);
  assert.equal(distinctStored(store), 100);
  const afterFirst = store.channels.get(VALID_CHANNEL_ID)!;
  assert.deepEqual([afterFirst.videosComplete, afterFirst.videosNextPageToken], [0, "page-3"]);
  assert.notEqual(afterFirst.lastAutoCollectedAt, null, "a budget-limited backfill is a recorded success; the next stale run (24h) resumes it");

  playlistCalls.length = 0;
  setNow(new Date(T0.getTime() + DAY_MS));
  const second = await services.runCollectionIfStale(RUN_INPUT);
  // A new day, 6 again: channels.list (5), page 1 refresh (4, its details are fresh: no read), the cursor page 3 (3) + details (2),
  // page 4 (2-2>=0: 1) + details (0) = 6 units; 100 + 50 + 50 = 200 = the cap.
  assert.equal(second.unitsSpent, 6);
  assert.deepEqual(playlistCalls.map((c) => (c as { pageToken?: string }).pageToken ?? null), [null, "page-3", "page-4"]);
  assert.equal(distinctStored(store), 200);
  const done = store.channels.get(VALID_CHANNEL_ID)!;
  assert.deepEqual([done.videosComplete, done.videosCompleteReason, done.videosNextPageToken, done.videosCapAtRun], [1, "cap", null, 200]);
});

test("depth: a rejected cursor restarts from page 1's own next page -- stored pages are walked without new snapshots, page 1 is still refreshed", async () => {
  const { store, services, setNow, setRejectedPageTokens } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A, PAGE_B, PAGE_C, PAGE_D],
    autoStats: "batch",
  });
  // FO-REQ-0015 item 4 (each new page also spends its details read): budget 7 = channels.list (6), page 1 (5) + details (4),
  // page 2 (4-2>=0: 3) + details (2), page 3 (2-2>=0: 1) + details (0); page 4 is not affordable. 150 stored, cursor page-4 -- the
  // same state as before the change, so the rejected cursor (page-4) and the restart's cursor (page-3) still differ (review).
  store.setQuotaBudget(7);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 200, publishedAfter: null });
  await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(store.videoSnapshots.length, 150);

  setRejectedPageTokens(["page-4"]);
  setNow(new Date(T0.getTime() + DAY_MS));
  store.setQuotaBudget(5);
  // channels.list (4 left), page 1 (3; details fresh, no read), cursor page-4 rejected but charged (2), restart: page 2 (1) = all stored
  // -> no snapshots, no details read; page 3 needs 2 > 1: stop, with page-3 as the cursor (never the rejected page-4).
  const second = await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(second.unitsSpent, 4);
  assert.equal(second.failed, 0);
  assert.equal(distinctStored(store), 150, "nothing new yet");
  assert.equal(store.videoSnapshots.length, 200, "only page 1's 50 videos were re-observed; the stored videos of page 2 were not duplicated");
  assert.equal(store.videoSnapshots.filter((row) => row.videoId.startsWith("b")).length, 50, "each b-video has exactly one snapshot");
  const row = store.channels.get(VALID_CHANNEL_ID)!;
  assert.deepEqual([row.videosComplete, row.videosNextPageToken], [0, "page-3"]);
});

test("depth: publishedAfter stops paging at the first older item; videos from that item on are not stored, a video exactly on the date is", async () => {
  const dates: Record<string, string> = {};
  for (const id of PAGE_A) dates[id] = "2026-04-01T00:00:00Z";
  for (const id of ids("b", 1, 29)) dates[id] = "2026-03-10T00:00:00Z";
  dates.b30 = "2026-03-01T00:00:00Z"; // exactly on the date: kept
  for (const id of ids("b", 31, 50)) dates[id] = "2026-02-01T00:00:00Z";
  const { store, services, playlistCalls } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A, PAGE_B, PAGE_C],
    playlistPublishedAt: dates,
    autoStats: "batch",
  });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 500, publishedAfter: "2026-03-01" });

  const result = await services.runCollectionIfStale(RUN_INPUT);

  // FO-REQ-0015 item 4: +1 videos.list per page with videos lacking details: 1 + 2 pages + 2 details reads = 5.
  assert.equal(result.unitsSpent, 5, "channels.list + pages 1 and 2 + their details reads; page 3 is never read");
  assert.equal(playlistCalls.length, 2);
  assert.equal(distinctStored(store), 80, "50 from page 1 + b1..b30");
  assert.equal(store.videoSnapshots.some((row) => row.videoId === "b31"), false);
  const row = store.channels.get(VALID_CHANNEL_ID)!;
  assert.deepEqual([row.videosComplete, row.videosCompleteReason, row.videosPublishedAfterAtRun], [1, "date", "2026-03-01"]);
});

test("depth: raising the cap after a collection that stopped on the cap makes the next stale run a backfill again (walks stored pages, stores only the new ones)", async () => {
  const { store, services, playlistCalls, batchStatsCalls, setNow } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A, PAGE_B, PAGE_C, PAGE_D],
    autoStats: "batch",
  });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 100, publishedAfter: null });
  await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(distinctStored(store), 100);
  assert.equal((await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID })).collectionProgress.complete, true);

  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 150, publishedAfter: null });
  assert.equal((await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID })).collectionProgress.complete, false, "the raised cap needs a new backfill");

  playlistCalls.length = 0;
  batchStatsCalls.length = 0;
  setNow(new Date(T0.getTime() + DAY_MS));
  const result = await services.runCollectionIfStale(RUN_INPUT);

  // channels.list + page 1 (refresh; its details are fresh, no read) + page 2 (stored, walked) + page 3 (50 new -> 150) + page 3's
  // details read (FO-REQ-0015 item 4) = 5 units.
  assert.equal(result.unitsSpent, 5);
  assert.equal(playlistCalls.length, 3);
  assert.deepEqual(batchStatsCalls.map((c) => (c as { videoIds: string[] }).videoIds.length), [50, 50]);
  assert.equal(distinctStored(store), 150);
  const row = store.channels.get(VALID_CHANNEL_ID)!;
  assert.deepEqual([row.videosComplete, row.videosCompleteReason, row.videosCapAtRun], [1, "cap", 150]);
});

test("depth: a lowered cap does not trigger a new backfill", async () => {
  const { store, services, playlistCalls, setNow } = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A, PAGE_B, PAGE_C], autoStats: "batch" });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 100, publishedAfter: null });
  await services.runCollectionIfStale(RUN_INPUT);
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 60, publishedAfter: null });
  assert.equal((await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID })).collectionProgress.complete, true);
  playlistCalls.length = 0;
  setNow(new Date(T0.getTime() + DAY_MS));
  const result = await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(result.unitsSpent, 2);
  assert.equal(playlistCalls.length, 1);
});

test("depth: each page whose batch stats fail costs one more unit (videos.list per page, never pooled) -- cap 100 = 1 + 2 + 2 = 5 units", async () => {
  const { store, services, videoSnapshotCalls } = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A, PAGE_B, PAGE_C], autoStats: "list" });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 100, publishedAfter: null });
  const result = await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(result.unitsSpent, 5);
  assert.deepEqual(videoSnapshotCalls.map((c) => (c as { videoIds: string[] }).videoIds.length), [50, 50], "one videos.list call per page, each <= 50 ids");
  assert.equal(store.collectionRuns[0].unitsSpent, 5, "the ledger row matches the spend");
});

test("depth: a failure on a later page records the run as failed with its real spend and keeps the cursor of the pages already stored", async () => {
  const { store, services, setRejectedPageTokens } = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A, PAGE_B], autoStats: "batch" });
  store.setQuotaBudget(1000);
  setRejectedPageTokens(["page-2"]);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 100, publishedAfter: null });

  const result = await services.runCollectionIfStale(RUN_INPUT);

  // FO-REQ-0015 item 4: page 1's 50 new videos get a details read: 1 + 1 + 1 + the failed page 2 call = 4.
  assert.deepEqual(result, { attempted: 1, succeeded: 0, failed: 1, quotaLimited: 0, unitsSpent: 4 });
  assert.equal(store.collectionRuns.length, 1);
  assert.equal(store.collectionRuns[0].status, "failed");
  assert.equal(store.collectionRuns[0].unitsSpent, 4, "channels.list + page 1 + its details read + the failed page 2 call");
  assert.equal(store.collectionRuns[0].videosReturned, 50);
  const row = store.channels.get(VALID_CHANNEL_ID)!;
  assert.deepEqual([row.videosComplete, row.videosNextPageToken], [0, "page-2"]);
  assert.equal(row.lastAutoCollectedAt, null, "a failed channel is not marked collected");
});

test("depth: a deep backfill does not starve the other watched channels -- the remaining budget keeps 3 units for each channel still waiting", async () => {
  const { store, services } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A, PAGE_B, PAGE_C, PAGE_D],
    autoStats: "batch",
    getPublicChannelSnapshotImpl: async (args) => ({ ...FULL_SNAPSHOT_WITH_VIDEO, channelId: args.channelId }),
  });
  store.setQuotaBudget(8);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  for (const channelId of [VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID]) {
    await services.setChannelCollectionDepth({ channelId, maxVideosPerChannel: 200, publishedAfter: null });
  }

  // FO-REQ-0015 item 4: each new page also spends the details read its reserved unit pays for.
  // Channel 1: channels.list (7 left), page 1 (6) + details (5); page 2 needs 5-2 >= 3 (one channel waits) -> 4, details 3;
  // page 3: 3-2 = 1 < 3 -> stop. 5 units, cursor page-3.
  // Channel 2: starts with 3 (>= 3, its minimum is kept): channels.list (2), page 1 (1) + details (0); page 2: 0-2 < 0 -> stop. 3 units.
  const result = await services.runCollectionIfStale(RUN_INPUT);

  assert.deepEqual(result, { attempted: 2, succeeded: 2, failed: 0, quotaLimited: 0, unitsSpent: 8 });
  assert.equal(store.channels.get(VALID_CHANNEL_ID)!.videosNextPageToken, "page-3");
  assert.equal(store.channels.get(OTHER_VALID_CHANNEL_ID)!.videosNextPageToken, "page-2");
});

test("depth: the RSS fallback marks the run (feed_fallback_used), changes no deep-collection state, and a normal run carries no such flag", async () => {
  const feed = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistFails: true,
    feedVideos: [{ videoId: "f1", title: "F", publishedAt: null }],
    autoStats: "batch",
  });
  feed.store.setQuotaBudget(100);
  await feed.services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await feed.services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 200, publishedAfter: null });
  await feed.services.runCollectionIfStale(RUN_INPUT);
  assert.equal(feed.store.collectionRuns[0].feedFallback, true);
  assert.equal(feed.store.channels.get(VALID_CHANNEL_ID)!.videosComplete ?? null, null, "the feed is no deep collection: state untouched");
  const flagged = await feed.services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  assert.ok(flagged.dataQualityFlags.includes("feed_fallback_used"));
  assert.ok((await feed.services.getMarketOverview()).collectionWarnings[0].dataQualityFlags.includes("feed_fallback_used"));

  const normal = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A], autoStats: "batch" });
  normal.store.setQuotaBudget(100);
  await normal.services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await normal.services.runCollectionIfStale(RUN_INPUT);
  assert.equal(normal.store.collectionRuns[0].feedFallback, false);
  assert.equal((await normal.services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID })).dataQualityFlags.includes("feed_fallback_used"), false);
});

test("depth: getWatchlistEntryContext reports the effective depth, stored count, completion and cost estimates", async () => {
  const { store, services } = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A, PAGE_B, PAGE_C], autoStats: "batch" });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });

  // Nothing collected, nothing set: 50 / no date; first collection = 1 + 1 page + its details read = 3 units (FO-REQ-0015 item 4),
  // worst case 1 + 2*1 = 3.
  assert.deepEqual((await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID })).collectionProgress, {
    maxVideosPerChannel: 50,
    maxVideosPerChannelOverride: null,
    publishedAfter: null,
    publishedAfterOverride: null,
    videosStored: 0,
    complete: false,
    completeReason: null,
    estimatedFirstCollectionUnits: 3,
    estimatedFirstCollectionWorstCaseUnits: 3,
  });

  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 120, publishedAfter: "2026-01-15" });
  await services.runCollectionIfStale(RUN_INPUT);
  // 120 videos = 3 pages: 1 + 3 + 3 details reads = 7 units (FO-REQ-0015 item 4), worst case 1 + 6 = 7.
  assert.deepEqual((await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID })).collectionProgress, {
    maxVideosPerChannel: 120,
    maxVideosPerChannelOverride: 120,
    publishedAfter: "2026-01-15",
    publishedAfterOverride: "2026-01-15",
    videosStored: 120,
    complete: true,
    completeReason: "cap",
    estimatedFirstCollectionUnits: 7,
    estimatedFirstCollectionWorstCaseUnits: 7,
  });
});

test("depth: the global default applies to a channel without an override; a channel override wins; clearing the override falls back", async () => {
  const { store, services, playlistCalls } = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A, PAGE_B, PAGE_C], autoStats: "batch" });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setCollectionDepthDefaults({ maxVideosPerChannel: 100, publishedAfter: null });
  assert.deepEqual(await services.getCollectionDepthDefaults(), {
    maxVideosPerChannel: 100,
    publishedAfter: null,
    effectiveMaxVideosPerChannel: 100,
    // 100 videos = 2 pages: 1 + 2 + 2 details reads = 5 (FO-REQ-0015 item 4); worst case 1 + 2*2 = 5.
    estimatedFirstCollectionUnits: 5,
    estimatedFirstCollectionWorstCaseUnits: 5,
  });

  await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(playlistCalls.length, 2, "global default 100 -> 2 pages");

  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 50, publishedAfter: null });
  assert.equal((await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID })).collectionProgress.maxVideosPerChannel, 50);
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: null, publishedAfter: null });
  assert.equal((await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID })).collectionProgress.maxVideosPerChannel, 100);
  await services.setCollectionDepthDefaults({ maxVideosPerChannel: null, publishedAfter: null });
  assert.equal((await services.getCollectionDepthDefaults()).effectiveMaxVideosPerChannel, 50, "unset = today's 50");
});

test("depth: settings validation -- integer 1..2000 and a real YYYY-MM-DD date; unknown channel refused", async () => {
  const { services } = createFixture();
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  for (const bad of [0, -5, 2001, 1.5]) {
    await assert.rejects(() => services.setCollectionDepthDefaults({ maxVideosPerChannel: bad, publishedAfter: null }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  }
  for (const badDate of ["2026-02-30", "2026/01/01", "01-02-2026", "2026-1-5", ""]) {
    await assert.rejects(() => services.setCollectionDepthDefaults({ maxVideosPerChannel: null, publishedAfter: badDate }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  }
  await services.setCollectionDepthDefaults({ maxVideosPerChannel: 1, publishedAfter: "2024-02-29" });
  await services.setCollectionDepthDefaults({ maxVideosPerChannel: 2000, publishedAfter: null });
  await assert.rejects(
    () => services.setChannelCollectionDepth({ channelId: OTHER_VALID_CHANNEL_ID, maxVideosPerChannel: 100, publishedAfter: null }),
    (e: unknown) => isDomainError(e) && e.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

test("depth: getChannelCollectionProgress matches the context's collectionProgress and refuses a channel that is not watched", async () => {
  const { store, services } = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A, PAGE_B], autoStats: "batch" });
  store.setQuotaBudget(1000);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 100, publishedAfter: null });
  await services.runCollectionIfStale(RUN_INPUT);
  const progress = await services.getChannelCollectionProgress({ channelId: VALID_CHANNEL_ID });
  assert.deepEqual(progress, (await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID })).collectionProgress);
  assert.equal(progress.videosStored, 100);
  await assert.rejects(
    () => services.getChannelCollectionProgress({ channelId: OTHER_VALID_CHANNEL_ID }),
    (e: unknown) => isDomainError(e) && e.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
});

// ---------------------------------------------------------------------------
// Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md; plan section 7 owner decisions). Expected
// numbers are derived by hand from the documented rules, not read back from the implementation:
//   * one channels.list (1) + one playlistItems.list per page (1 each); worst case adds one videos.list fallback per page;
//   * a backfill reads page 1 plus ceil((cap - stored) / 50) further pages (resuming from a cursor), or ceil(cap / 50) pages when it
//     must re-walk from page 1; steady state costs 2 (worst 3).
// ---------------------------------------------------------------------------

const CR_NOW = new Date("2026-09-27T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const CR_AGENT = { createdVia: "mcp" as const, agentApiVersion: "3.2.0" };

async function watchChannels(services: ReturnType<typeof createFixture>["services"], ...channelIds: string[]) {
  for (const channelId of channelIds) await services.addToWatchlist({ channelId, reason: "r" }, { createdVia: "web_ui" });
}

function seedStoredVideos(store: ReturnType<typeof createFixture>["store"], channelId: string, count: number) {
  for (let i = 1; i <= count; i++) {
    store.videoSnapshots.push({
      id: `seed-${channelId}-${i}`,
      researchChannelId: channelId,
      videoId: `seed${i}`,
      observedAt: new Date(CR_NOW.getTime() - HOUR_MS),
      viewCount: 1,
      likeCount: 1,
      commentCount: 1,
      publishedAt: null,
      title: null,
      source: "test",
      createdVia: "web_ui",
    });
  }
}

function runRequest(services: ReturnType<typeof createFixture>["services"], requestId: string) {
  return services.runApprovedCollectionRequest({ requestId, credentialRef: { userId: "u1" } });
}

test("collection request: estimate arithmetic per mode -- cap 300 never collected: pages 7 -> 15/15; cursor resume with 100 stored: 5 pages -> 11/11; raised cap with 100 stored and no cursor: 6 pages -> 13/13; steady state 2/5; totals 41/44; remaining 40 so it does not fit today", async () => {
  const { store, services } = createFixture({ now: CR_NOW });
  store.setQuotaBudget(40);
  await watchChannels(services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID, "UC0000000000000000000004");
  await services.setCollectionDepthDefaults({ maxVideosPerChannel: 300, publishedAfter: null });
  // FO-REQ-0015 item 4: a backfill page now reads its videos' details (videos.list) as well, so a backfill's expected units are
  // 1 + 2 per page -- the old worst case.
  // A: never collected, nothing stored. Backfill, no cursor: max(ceil(300/50)+1 = 7, ceil(300/50) = 6) = 7 pages -> 1+2*7 = 15 expected, 15 worst.
  // B: 100 stored, unfinished backfill with a cursor: ceil((300-100)/50)+1 = 5 pages -> 11 / 11.
  seedStoredVideos(store, OTHER_VALID_CHANNEL_ID, 100);
  Object.assign(store.channels.get(OTHER_VALID_CHANNEL_ID)!, { videosComplete: 0, videosNextPageToken: "tok", videosCapAtRun: 300 });
  // C: 100 stored, finished at cap 100, cap now 300, no cursor: max(ceil(200/50)+1 = 5, 6) = 6 pages -> 13 / 13.
  seedStoredVideos(store, THIRD_VALID_CHANNEL_ID, 100);
  Object.assign(store.channels.get(THIRD_VALID_CHANNEL_ID)!, { videosComplete: 1, videosCompleteReason: "cap", videosCapAtRun: 100 });
  // D: finished by reaching the end of the playlist -> incremental: expected 1+1 = 2; worst case 1 + 2 pages + 2 videos.list fallbacks = 5.
  // Totals: expected 15+11+13+2 = 41; worst 15+11+13+5 = 44.
  Object.assign(store.channels.get("UC0000000000000000000004")!, { videosComplete: 1, videosCompleteReason: "exhausted", videosCapAtRun: 300 });

  const result = await services.createCollectionRequest({ reason: "weekly check" }, CR_AGENT);

  assert.equal(result.created, true);
  const estimate = result.request!.estimate;
  assert.deepEqual(
    estimate.channels.map((c) => [c.channelId, c.mode, c.expectedUnits, c.worstCaseUnits]),
    [
      [VALID_CHANNEL_ID, "backfill", 15, 15],
      [OTHER_VALID_CHANNEL_ID, "backfill", 11, 11],
      [THIRD_VALID_CHANNEL_ID, "backfill", 13, 13],
      ["UC0000000000000000000004", "incremental", 2, 5],
    ]
  );
  assert.equal(estimate.totalExpectedUnits, 41);
  assert.equal(estimate.totalWorstCaseUnits, 44);
  assert.equal(estimate.dailyBudgetUnits, 40);
  assert.equal(estimate.unitsSpentToday, 0);
  assert.equal(estimate.remainingTodayUnits, 40);
  assert.equal(estimate.fitsToday, false, "worst case 44 exceeds the 40 left");
  assert.equal(result.request!.status, "pending");
  assert.equal(result.request!.reason, "weekly check");
  assert.equal(result.request!.createdVia, "mcp");
  assert.equal(result.request!.agentApiVersion, "3.2.0");
});

test("collection request: the default depth (cap 50) steady state is 2/5 and fits exactly when the worst case equals what is left; units already spent today reduce the remainder", async () => {
  const { store, services } = createFixture({ now: CR_NOW });
  await watchChannels(services, VALID_CHANNEL_ID);
  Object.assign(store.channels.get(VALID_CHANNEL_ID)!, { videosComplete: 1, videosCompleteReason: "exhausted", videosCapAtRun: 50 });
  store.collectionRuns.push({ researchChannelId: "UC_OTHER", status: "success", unitsSpent: 10, videosRequested: 0, videosReturned: 0, errorMessage: null, ranAt: CR_NOW });
  store.setQuotaBudget(15);
  const fits = await services.createCollectionRequest({}, CR_AGENT);
  assert.deepEqual(
    [fits.request!.estimate.totalExpectedUnits, fits.request!.estimate.totalWorstCaseUnits, fits.request!.estimate.unitsSpentToday, fits.request!.estimate.remainingTodayUnits, fits.request!.estimate.fitsToday],
    [2, 5, 10, 5, true],
    "15 budget - 10 spent = 5 left; worst case 5 fits exactly"
  );
  store.collectionRequests.clear();
  store.setQuotaBudget(14);
  const tight = await services.createCollectionRequest({}, CR_AGENT);
  assert.equal(tight.request!.estimate.remainingTodayUnits, 4);
  assert.equal(tight.request!.estimate.fitsToday, false, "an estimate above what is left is still created, flagged fitsToday=false");
  assert.equal(tight.created, true);
});

test("collection request: creating makes zero YouTube/credential calls and writes no quota-ledger rows; default channels = whole watchlist", async () => {
  const f = createFixture({ now: CR_NOW });
  f.store.setQuotaBudget(1000);
  await watchChannels(f.services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID);
  const result = await f.services.createCollectionRequest({}, CR_AGENT);
  assert.deepEqual(result.request!.channelIds, [VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID]);
  assert.equal(f.snapshotCalls.length + f.playlistCalls.length + f.videoSnapshotCalls.length + f.batchStatsCalls.length + f.feedCalls.length + f.searchCalls.length, 0);
  assert.equal(f.assertReadsAvailableCalls.length, 0);
  assert.equal(f.resolveCalls.length, 0);
  assert.equal(f.store.collectionRuns.length, 0);
});

test("collection request: at most one open request per channel -- an overlapping request only covers the free channel and reports the existing request id", async () => {
  const { store, services } = createFixture({ now: CR_NOW });
  store.setQuotaBudget(1000);
  await watchChannels(services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID);
  const first = await services.createCollectionRequest({ researchChannelIds: [VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID] }, CR_AGENT);
  const second = await services.createCollectionRequest({ researchChannelIds: [OTHER_VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID] }, CR_AGENT);
  assert.deepEqual(second.request!.channelIds, [THIRD_VALID_CHANNEL_ID]);
  assert.deepEqual(second.alreadyRequested, [{ channelId: OTHER_VALID_CHANNEL_ID, requestId: first.request!.requestId }]);
  const third = await services.createCollectionRequest({ researchChannelIds: [VALID_CHANNEL_ID] }, CR_AGENT);
  assert.equal(third.created, false);
  assert.equal(third.request, null);
  assert.deepEqual(third.alreadyRequested, [{ channelId: VALID_CHANNEL_ID, requestId: first.request!.requestId }]);
  assert.equal(store.collectionRequests.size, 2, "the refused request created no row");
});

test("collection request: a rejected request frees its channels for a new request", async () => {
  const { store, services } = createFixture({ now: CR_NOW });
  store.setQuotaBudget(1000);
  await watchChannels(services, VALID_CHANNEL_ID);
  const first = await services.createCollectionRequest({}, CR_AGENT);
  await services.rejectCollectionRequest({ requestId: first.request!.requestId, reason: "not now" });
  const again = await services.createCollectionRequest({}, CR_AGENT);
  assert.equal(again.created, true);
});

test("collection request: a channel collected 2h ago is not_needed (2 hours); one that failed 3h ago is not_needed (recent_failure, 3 hours); the free channel is requested; hours use one decimal", async () => {
  const { store, services } = createFixture({ now: CR_NOW });
  store.setQuotaBudget(1000);
  await watchChannels(services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID);
  store.channels.get(VALID_CHANNEL_ID)!.lastAutoCollectedAt = new Date(CR_NOW.getTime() - 2 * HOUR_MS);
  store.collectionRuns.push({
    researchChannelId: OTHER_VALID_CHANNEL_ID,
    status: "failed",
    unitsSpent: 1,
    videosRequested: null,
    videosReturned: null,
    errorMessage: "boom",
    ranAt: new Date(CR_NOW.getTime() - 3 * HOUR_MS),
  });
  const result = await services.createCollectionRequest({}, CR_AGENT);
  assert.deepEqual(result.notNeeded, [
    { channelId: VALID_CHANNEL_ID, reason: "collected_recently", hoursSince: 2 },
    { channelId: OTHER_VALID_CHANNEL_ID, reason: "recent_failure", hoursSince: 3 },
  ]);
  assert.deepEqual(result.request!.channelIds, [THIRD_VALID_CHANNEL_ID]);

  // 90 minutes -> 1.5 hours.
  store.collectionRequests.clear();
  store.channels.get(VALID_CHANNEL_ID)!.lastAutoCollectedAt = new Date(CR_NOW.getTime() - 90 * 60 * 1000);
  const again = await services.createCollectionRequest({ researchChannelIds: [VALID_CHANNEL_ID] }, CR_AGENT);
  assert.deepEqual(again.notNeeded, [{ channelId: VALID_CHANNEL_ID, reason: "collected_recently", hoursSince: 1.5 }]);
});

test("collection request: a channel collected 25h ago (outside the 24h window) is needed", async () => {
  const { store, services } = createFixture({ now: CR_NOW });
  store.setQuotaBudget(1000);
  await watchChannels(services, VALID_CHANNEL_ID);
  store.channels.get(VALID_CHANNEL_ID)!.lastAutoCollectedAt = new Date(CR_NOW.getTime() - 25 * HOUR_MS);
  const result = await services.createCollectionRequest({}, CR_AGENT);
  assert.equal(result.created, true);
  assert.deepEqual(result.notNeeded, []);
});

test("collection request: when nothing is needed the result is created:false with no record", async () => {
  const { store, services } = createFixture({ now: CR_NOW });
  store.setQuotaBudget(1000);
  await watchChannels(services, VALID_CHANNEL_ID);
  store.channels.get(VALID_CHANNEL_ID)!.lastAutoCollectedAt = new Date(CR_NOW.getTime() - HOUR_MS);
  const result = await services.createCollectionRequest({}, CR_AGENT);
  assert.equal(result.created, false);
  assert.equal(result.request, null);
  assert.equal(result.notNeeded.length, 1);
  assert.equal(store.collectionRequests.size, 0);
  const empty = createFixture({ now: CR_NOW });
  empty.store.setQuotaBudget(1000);
  const none = await empty.services.createCollectionRequest({}, CR_AGENT);
  assert.deepEqual([none.created, none.notNeeded, none.alreadyRequested], [false, [], []], "an empty watchlist is nothing to collect, not an error");
});

test("collection request: refused with MARKET_INTELLIGENCE_QUOTA_DISABLED while no daily budget is set; unknown channel, long reason and a force field are rejected; nothing is stored", async () => {
  const { store, services } = createFixture({ now: CR_NOW });
  await watchChannels(services, VALID_CHANNEL_ID);
  await assert.rejects(
    () => services.createCollectionRequest({}, CR_AGENT),
    (error: unknown) => isDomainError(error) && error.code === "MARKET_INTELLIGENCE_QUOTA_DISABLED"
  );
  store.setQuotaBudget(1000);
  await assert.rejects(
    () => services.createCollectionRequest({ researchChannelIds: [OTHER_VALID_CHANNEL_ID] }, CR_AGENT),
    (error: unknown) => isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  await assert.rejects(
    () => services.createCollectionRequest({ reason: "x".repeat(501) }, CR_AGENT),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  await assert.rejects(
    () => services.createCollectionRequest({ force: true }, CR_AGENT),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  await assert.rejects(
    () => services.createCollectionRequest({ researchChannelIds: [] }, CR_AGENT),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  const ok = await services.createCollectionRequest({ reason: "x".repeat(500) }, CR_AGENT);
  assert.equal(ok.created, true, "exactly 500 characters is allowed");
  assert.equal(store.collectionRequests.size, 1);
});

test("collection limits: budget, spent today, remaining, the next Pacific midnight, depth defaults and per-channel overrides", async () => {
  const { store, services } = createFixture({ now: CR_NOW });
  const unset = await services.getCollectionLimits();
  assert.equal(unset.dailyBudgetUnits, null);
  assert.equal(unset.remainingTodayUnits, null);
  store.setQuotaBudget(1000);
  await watchChannels(services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID);
  await services.setCollectionDepthDefaults({ maxVideosPerChannel: 300, publishedAfter: "2026-01-01" });
  await services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 100, publishedAfter: null });
  store.collectionRuns.push({ researchChannelId: VALID_CHANNEL_ID, status: "success", unitsSpent: 120, videosRequested: 0, videosReturned: 0, errorMessage: null, ranAt: CR_NOW });
  // Yesterday's spend (before 2026-09-27T07:00Z, the Pacific day start) is not counted.
  store.collectionRuns.push({ researchChannelId: VALID_CHANNEL_ID, status: "success", unitsSpent: 500, videosRequested: 0, videosReturned: 0, errorMessage: null, ranAt: new Date("2026-09-27T06:59:00.000Z") });
  const limits = await services.getCollectionLimits();
  assert.deepEqual(limits, {
    dailyBudgetUnits: 1000,
    unitsSpentToday: 120,
    remainingTodayUnits: 880,
    // 2026-09-27 12:00Z is in the Pacific day that began 2026-09-27 07:00Z (PDT, UTC-7); the next one begins 2026-09-28 07:00Z.
    quotaDayResetsAt: "2026-09-28T07:00:00.000Z",
    defaultMaxVideosPerChannel: 300,
    defaultPublishedAfter: "2026-01-01",
    staleWindowHours: 24,
    perChannelOverrides: [{ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 100, publishedAfter: null }],
  });
});

test("collection run: approving runs ONLY the request's channels (a third stale channel is untouched), records per-channel results and units, stamps the approver", async () => {
  const f = createFixture({
    now: CR_NOW,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: "2026-01-01T00:00:00.000Z", viewCount: 10, likeCount: 1, commentCount: 0 }],
  });
  f.store.setQuotaBudget(100);
  await watchChannels(f.services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID);
  const created = await f.services.createCollectionRequest({ researchChannelIds: [VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID] }, CR_AGENT);

  const done = await runRequest(f.services, created.request!.requestId);

  // Each channel: channels.list 1 + playlistItems.list 1 + videos.list fallback 1 = 3 units (as in AC-9B-01); two channels = 6.
  assert.equal(done.status, "done");
  assert.equal(done.unitsSpentTotal, 6);
  assert.deepEqual(
    done.result!.map((r) => [r.channelId, r.outcome, r.videosStored, r.unitsSpent]),
    [
      [VALID_CHANNEL_ID, "completed", 1, 3],
      [OTHER_VALID_CHANNEL_ID, "completed", 1, 3],
    ]
  );
  assert.ok(done.result!.every((r) => typeof r.newSnapshotsObservedAt === "string"), "new snapshots were observed for both");
  assert.deepEqual(
    f.snapshotCalls.map((c) => (c as { channelId: string }).channelId).sort(),
    [VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID].sort(),
    "the third stale channel must not be fetched"
  );
  assert.equal(f.store.channels.get(THIRD_VALID_CHANNEL_ID)!.lastAutoCollectedAt, null);
  assert.equal(f.store.collectionRuns.length, 2);
  assert.equal(f.store.collectionRequests.get(created.request!.requestId)!.approvedByUserId, "u1");
  assert.ok(done.approvedAt);
  assert.ok(done.resolvedAt);
});

test("collection run: the regular rules apply -- a channel collected after the request was created is skipped_not_stale, one that failed 3h ago is skipped_recent_failure; nothing is spent", async () => {
  const f = createFixture({ now: CR_NOW, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  f.store.setQuotaBudget(100);
  await watchChannels(f.services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID);
  const created = await f.services.createCollectionRequest({}, CR_AGENT);
  f.store.channels.get(VALID_CHANNEL_ID)!.lastAutoCollectedAt = new Date(CR_NOW.getTime() - 2 * HOUR_MS);
  f.store.collectionRuns.push({ researchChannelId: OTHER_VALID_CHANNEL_ID, status: "failed", unitsSpent: 1, videosRequested: null, videosReturned: null, errorMessage: "boom", ranAt: new Date(CR_NOW.getTime() - 3 * HOUR_MS) });

  const done = await runRequest(f.services, created.request!.requestId);

  assert.equal(done.status, "done");
  assert.deepEqual(
    done.result!.map((r) => [r.channelId, r.outcome, r.unitsSpent]),
    [
      [VALID_CHANNEL_ID, "skipped_not_stale", 0],
      [OTHER_VALID_CHANNEL_ID, "skipped_recent_failure", 0],
    ]
  );
  assert.equal(done.unitsSpentTotal, 0);
  assert.equal(f.snapshotCalls.length, 0, "no bypass: the stale window and the failure pause stay in force");
});

test("collection run: the daily budget gate -- budget 5 covers one channel (3 units) and the second is skipped_quota_limited with zero spend", async () => {
  const f = createFixture({
    now: CR_NOW,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    uploadsPlaylistVideoIds: ["v1"],
    publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 10, likeCount: null, commentCount: null }],
  });
  f.store.setQuotaBudget(5);
  await watchChannels(f.services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID);
  const created = await f.services.createCollectionRequest({}, CR_AGENT);
  const done = await runRequest(f.services, created.request!.requestId);
  // First channel needs 5 >= 3 and spends 3 (5 -> 2); the second needs 3 but only 2 remain.
  assert.deepEqual(
    done.result!.map((r) => [r.channelId, r.outcome, r.unitsSpent]),
    [
      [VALID_CHANNEL_ID, "completed", 3],
      [OTHER_VALID_CHANNEL_ID, "skipped_quota_limited", 0],
    ]
  );
  assert.equal(done.unitsSpentTotal, 3);
  assert.equal(done.status, "done");
});

test("collection run: a backfill the budget cannot finish is partial_budget (cursor kept), never reported as complete", async () => {
  const f = createFixture({ now: CR_NOW, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A, PAGE_B, PAGE_C], autoStats: "batch" });
  f.store.setQuotaBudget(3);
  await watchChannels(f.services, VALID_CHANNEL_ID);
  await f.services.setChannelCollectionDepth({ channelId: VALID_CHANNEL_ID, maxVideosPerChannel: 120, publishedAfter: null });
  const created = await f.services.createCollectionRequest({}, CR_AGENT);
  const done = await runRequest(f.services, created.request!.requestId);
  // Budget 3: channels.list 1 + page 1 (1) + page 1's details read (1, FO-REQ-0015 item 4) = 3 spent, 0 left; another page needs 2
  // -> stops with a saved cursor. 50 videos stored.
  assert.deepEqual(
    done.result!.map((r) => [r.outcome, r.videosStored, r.unitsSpent]),
    [["partial_budget", 50, 3]]
  );
  assert.equal(f.store.channels.get(VALID_CHANNEL_ID)!.videosNextPageToken, "page-2");
  assert.equal(done.unitsSpentTotal, 3);
});

test("collection run: a channel YouTube reports no data for fails; when every attempted channel failed the request is failed with the error and the per-channel result", async () => {
  const f = createFixture({ now: CR_NOW, getPublicChannelSnapshotImpl: async () => null });
  f.store.setQuotaBudget(100);
  await watchChannels(f.services, VALID_CHANNEL_ID);
  const created = await f.services.createCollectionRequest({}, CR_AGENT);
  const done = await runRequest(f.services, created.request!.requestId);
  assert.equal(done.status, "failed");
  assert.equal(done.error, "All 1 attempted channel(s) failed");
  assert.deepEqual(done.result!.map((r) => [r.outcome, r.videosStored, r.unitsSpent, r.newSnapshotsObservedAt]), [["failed", 0, 1, null]]);
  assert.equal(done.unitsSpentTotal, 1, "channels.list was charged before the call resolved");
});

test("collection run: preconditions that fail (budget unset, budget used up, Data API reads off, credentials) leave the request pending and make no YouTube call", async () => {
  const noBudget = createFixture({ now: CR_NOW });
  noBudget.store.setQuotaBudget(100);
  await watchChannels(noBudget.services, VALID_CHANNEL_ID);
  const created = await noBudget.services.createCollectionRequest({}, CR_AGENT);
  const id = created.request!.requestId;
  noBudget.store.setQuotaBudget(null);
  await assert.rejects(() => runRequest(noBudget.services, id), (e: unknown) => isDomainError(e) && e.code === "MARKET_INTELLIGENCE_QUOTA_DISABLED");
  noBudget.store.setQuotaBudget(10);
  noBudget.store.collectionRuns.push({ researchChannelId: "UC_X", status: "success", unitsSpent: 10, videosRequested: 0, videosReturned: 0, errorMessage: null, ranAt: CR_NOW });
  await assert.rejects(() => runRequest(noBudget.services, id), (e: unknown) => isDomainError(e) && e.code === "MARKET_INTELLIGENCE_QUOTA_EXCEEDED");
  assert.equal(noBudget.store.collectionRequests.get(id)!.status, "pending");
  assert.equal(noBudget.snapshotCalls.length, 0);

  const reads = createFixture({ now: CR_NOW, dataApiReadsDisabled: true });
  reads.store.setQuotaBudget(100);
  await watchChannels(reads.services, VALID_CHANNEL_ID);
  const readsReq = await reads.services.createCollectionRequest({}, CR_AGENT);
  await assert.rejects(() => runRequest(reads.services, readsReq.request!.requestId), (e: unknown) => isDomainError(e) && e.code === "data_api_reads_disabled");
  assert.equal(reads.store.collectionRequests.get(readsReq.request!.requestId)!.status, "pending");

  const creds = createFixture({ now: CR_NOW, resolveError: new Error("credentials expired") });
  creds.store.setQuotaBudget(100);
  await watchChannels(creds.services, VALID_CHANNEL_ID);
  const credsReq = await creds.services.createCollectionRequest({}, CR_AGENT);
  await assert.rejects(() => runRequest(creds.services, credsReq.request!.requestId), /credentials expired/);
  const row = creds.store.collectionRequests.get(credsReq.request!.requestId)!;
  assert.equal(row.status, "pending");
  assert.equal(row.approvedAt, null);
  assert.equal(creds.snapshotCalls.length, 0);
  assert.equal(creds.store.channels.get(VALID_CHANNEL_ID)!.collectionClaimedAt, null, "no channel was claimed");
});

test("collection run: two concurrent approvals of the same request -- exactly one runs (one set of YouTube calls), the other is COLLECTION_REQUEST_NOT_PENDING", async () => {
  const f = createFixture({ now: CR_NOW, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, uploadsPlaylistVideoIds: ["v1"], publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 1, likeCount: 1, commentCount: 1 }] });
  f.store.setQuotaBudget(100);
  await watchChannels(f.services, VALID_CHANNEL_ID);
  const created = await f.services.createCollectionRequest({}, CR_AGENT);
  const id = created.request!.requestId;
  const results = await Promise.allSettled([runRequest(f.services, id), runRequest(f.services, id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(isDomainError(rejected.reason) && rejected.reason.code === "COLLECTION_REQUEST_NOT_PENDING");
  assert.equal(f.snapshotCalls.length, 1, "the channel was fetched once, not twice");
  assert.equal(f.store.collectionRuns.length, 1);
});

test("collection run: only a pending request can be run; unknown id is COLLECTION_REQUEST_NOT_FOUND; a finished request cannot be run again", async () => {
  const f = createFixture({ now: CR_NOW, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, uploadsPlaylistVideoIds: ["v1"], publicVideoSnapshots: [{ videoId: "v1", title: "V1", publishedAt: null, viewCount: 1, likeCount: 1, commentCount: 1 }] });
  f.store.setQuotaBudget(100);
  await watchChannels(f.services, VALID_CHANNEL_ID);
  await assert.rejects(() => runRequest(f.services, "nope"), (e: unknown) => isDomainError(e) && e.code === "COLLECTION_REQUEST_NOT_FOUND");
  const created = await f.services.createCollectionRequest({}, CR_AGENT);
  await runRequest(f.services, created.request!.requestId);
  const calls = f.snapshotCalls.length;
  await assert.rejects(() => runRequest(f.services, created.request!.requestId), (e: unknown) => isDomainError(e) && e.code === "COLLECTION_REQUEST_NOT_PENDING");
  assert.equal(f.snapshotCalls.length, calls);
});

test("collection reject: records the human's reason, collects nothing, makes zero YouTube calls; a second reject and a later run are refused", async () => {
  const f = createFixture({ now: CR_NOW, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  f.store.setQuotaBudget(100);
  await watchChannels(f.services, VALID_CHANNEL_ID);
  const created = await f.services.createCollectionRequest({}, CR_AGENT);
  const rejected = await f.services.rejectCollectionRequest({ requestId: created.request!.requestId, reason: "too expensive" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.resolvedReason, "too expensive");
  assert.ok(rejected.resolvedAt);
  assert.equal(f.snapshotCalls.length + f.playlistCalls.length, 0);
  assert.equal(f.store.collectionRuns.length, 0);
  await assert.rejects(() => f.services.rejectCollectionRequest({ requestId: created.request!.requestId, reason: "again" }), (e: unknown) => isDomainError(e) && e.code === "COLLECTION_REQUEST_NOT_PENDING");
  await assert.rejects(() => runRequest(f.services, created.request!.requestId), (e: unknown) => isDomainError(e) && e.code === "COLLECTION_REQUEST_NOT_PENDING");
  await assert.rejects(() => f.services.rejectCollectionRequest({ requestId: created.request!.requestId, reason: "" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(() => f.services.rejectCollectionRequest({ requestId: "nope", reason: "x" }), (e: unknown) => isDomainError(e) && e.code === "COLLECTION_REQUEST_NOT_FOUND");
});

test("collection requests: list returns newest first; get by id returns the record or COLLECTION_REQUEST_NOT_FOUND", async () => {
  const f = createFixture({ now: CR_NOW });
  f.store.setQuotaBudget(1000);
  await watchChannels(f.services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID);
  const a = await f.services.createCollectionRequest({ researchChannelIds: [VALID_CHANNEL_ID] }, CR_AGENT);
  f.setNow(new Date(CR_NOW.getTime() + 1000));
  const b = await f.services.createCollectionRequest({ researchChannelIds: [OTHER_VALID_CHANNEL_ID] }, CR_AGENT);
  const list = await f.services.listCollectionRequests();
  assert.deepEqual(list.requests.map((r) => r.requestId), [b.request!.requestId, a.request!.requestId]);
  assert.equal((await f.services.getCollectionRequest({ requestId: a.request!.requestId })).channelIds[0], VALID_CHANNEL_ID);
  await assert.rejects(() => f.services.getCollectionRequest({ requestId: "nope" }), (e: unknown) => isDomainError(e) && e.code === "COLLECTION_REQUEST_NOT_FOUND");
});

test("collection requests: the boot sweep (no cutoff) fails EVERY approved/running request -- even one approved 5 minutes ago -- and leaves pending ones; an explicit cutoff still spares newer ones", async () => {
  const f = createFixture({ now: CR_NOW });
  f.store.setQuotaBudget(1000);
  await watchChannels(f.services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID);
  const old = await f.services.createCollectionRequest({ researchChannelIds: [VALID_CHANNEL_ID] }, CR_AGENT);
  const recent = await f.services.createCollectionRequest({ researchChannelIds: [OTHER_VALID_CHANNEL_ID] }, CR_AGENT);
  const pending = await f.services.createCollectionRequest({ researchChannelIds: [THIRD_VALID_CHANNEL_ID] }, CR_AGENT);
  const oldRow = f.store.collectionRequests.get(old.request!.requestId)!;
  oldRow.status = "running";
  oldRow.approvedAt = new Date(CR_NOW.getTime() - 31 * 60 * 1000);
  // Explicit cutoff 30 minutes back: only the 31-minute-old one is swept; the 5-minute-old one is spared.
  const recentApprovedAt = new Date(CR_NOW.getTime() - 5 * 60 * 1000);
  const recentRow = f.store.collectionRequests.get(recent.request!.requestId)!;
  recentRow.status = "running";
  recentRow.approvedAt = recentApprovedAt;

  assert.deepEqual(await f.services.sweepInterruptedCollectionRequests({ approvedBefore: new Date(CR_NOW.getTime() - 30 * 60 * 1000) }), { failed: 1 });
  assert.equal(oldRow.status, "failed");
  assert.equal(oldRow.error, "interrupted");
  assert.equal(recentRow.status, "running");
  // Boot: no cutoff -- the running request approved 5 minutes ago IS swept (no run can be alive at boot of the single server process).
  assert.deepEqual(await f.services.sweepInterruptedCollectionRequests(), { failed: 1 });
  assert.equal(recentRow.status, "failed");
  assert.equal(recentRow.error, "interrupted");
  assert.equal(f.store.collectionRequests.get(pending.request!.requestId)!.status, "pending");
  assert.equal((await f.services.createCollectionRequest({ researchChannelIds: [VALID_CHANNEL_ID] }, CR_AGENT)).created, true, "the swept request no longer blocks its channel");
});

test("runCollectionIfStale keeps its exact summary shape (no per-channel list leaks into the public result)", async () => {
  const f = createFixture({ now: CR_NOW, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO });
  f.store.setQuotaBudget(100);
  await watchChannels(f.services, VALID_CHANNEL_ID);
  const result = await f.services.runCollectionIfStale({ credentialRef: { userId: "u1" } });
  assert.deepEqual(Object.keys(result).sort(), ["attempted", "failed", "quotaLimited", "succeeded", "unitsSpent"]);
});

test("collection run: claims of not-yet-processed channels are renewed, so a claim attempt after the 15-minute expiry cannot take them mid-run", async () => {
  const f = createFixture({
    now: CR_NOW,
    getPublicChannelSnapshotImpl: async (args) => {
      if (args.channelId === OTHER_VALID_CHANNEL_ID) {
        // The run is now on its second channel and 20 minutes have passed since the claim (expiry is 15). Channel C is still waiting.
        let claimed: string[] = [];
        claimed = await f.store.claimStaleResearchChannelsForCollection({
          now: f.currentNow(),
          staleCutoff: new Date(f.currentNow().getTime() - 24 * HOUR_MS),
          claimExpiryCutoff: new Date(f.currentNow().getTime() - 15 * 60 * 1000),
          excludeResearchChannelIds: [],
          onlyResearchChannelIds: [THIRD_VALID_CHANNEL_ID],
        });
        concurrentClaim.push(...claimed);
      }
      f.setNow(new Date(f.currentNow().getTime() + 20 * 60 * 1000));
      return { channelId: args.channelId, title: "T", subscriberCount: 1, hiddenSubscriberCount: false, viewCount: 1, videoCount: 1, uploadsPlaylistId: null };
    },
    feedVideos: [],
  });
  const concurrentClaim: string[] = [];
  f.store.setQuotaBudget(100);
  await watchChannels(f.services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID);
  const created = await f.services.createCollectionRequest({}, CR_AGENT);
  await runRequest(f.services, created.request!.requestId);
  // Timeline: claim at T0. Before channel A: renew (claim = T0). A's call moves the clock to T0+20. Before channel B: renew (claim = T0+20).
  // B's call sees a clock of T0+20: C's claim is T0+20, the cutoff T0+5 -> not claimable. Without renewal C's claim would be T0 < T0+5 -> claimable.
  assert.deepEqual(concurrentClaim, []);
});

test("collection run: a throw mid-run records the units actually charged and the per-channel results gathered so far, and releases the remaining claims", async () => {
  const f = createFixture({
    now: CR_NOW,
    getPublicChannelSnapshotImpl: async (args) =>
      args.channelId === OTHER_VALID_CHANNEL_ID
        ? null
        : { channelId: args.channelId, title: "T", subscriberCount: 1, hiddenSubscriberCount: false, viewCount: 1, videoCount: 1, uploadsPlaylistId: null },
    feedVideos: [],
  });
  f.store.setQuotaBudget(100);
  await watchChannels(f.services, VALID_CHANNEL_ID, OTHER_VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID);
  const created = await f.services.createCollectionRequest({}, CR_AGENT);
  // Channel A succeeds via the RSS feed: channels.list 1 + playlist skipped (no uploads playlist) = 1 unit. Channel B: channels.list 1 unit, YouTube
  // reports nothing -> failed, and writing its failed ledger row throws, aborting the whole pass before channel C.
  f.store.failNextFailedRunInsertOnce();
  const done = await runRequest(f.services, created.request!.requestId);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /simulated failed-run insert failure/);
  assert.equal(done.unitsSpentTotal, 2, "1 unit for A + 1 unit charged for B before it failed");
  assert.deepEqual(
    done.result!.map((r) => [r.channelId, r.outcome, r.unitsSpent]),
    [
      [VALID_CHANNEL_ID, "completed", 1],
      [OTHER_VALID_CHANNEL_ID, "failed", 1],
    ]
  );
  assert.equal(f.store.channels.get(THIRD_VALID_CHANNEL_ID)!.collectionClaimedAt, null, "the unprocessed channel's claim was released");
});

// BL-140 R3 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.3, AC-R3-1): one row per watchlist channel for the
// Research → Channels table -- observed values with their dates, how many videos were observed, the latest collection
// run and a status. Expected rows are written by hand from the fixture; no derived metric is part of a row.
test("BL-140: getWatchlistTable gives each channel its latest observation, videos observed, latest run and status", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, handleOrUrl: "@current", reason: "current one" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "never collected" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: THIRD_VALID_CHANNEL_ID, reason: "failed one" }, { createdVia: "web_ui" });
  for (const [id, channelId] of [["snap-1", VALID_CHANNEL_ID], ["snap-3", THIRD_VALID_CHANNEL_ID]] as const) {
    store.channelSnapshots.push({
      id,
      researchChannelId: channelId,
      observedAt: now,
      subscriberCount: 1200,
      viewCount: 34000,
      videoCount: 40,
      hiddenSubscriberCount: false,
      source: "youtube.channels.list",
      createdVia: "web_ui",
    });
  }
  for (const videoId of ["vA00000000000000000000", "vB00000000000000000000"]) {
    store.videoSnapshots.push({
      id: `vs-${videoId}`,
      researchChannelId: VALID_CHANNEL_ID,
      videoId,
      observedAt: now,
      viewCount: 10,
      likeCount: null,
      commentCount: null,
      publishedAt: now,
      title: "t",
      source: "youtube.videos.list",
      createdVia: "web_ui",
    });
  }
  store.collectionRuns.push(
    { researchChannelId: VALID_CHANNEL_ID, status: "success", unitsSpent: 3, videosRequested: 2, videosReturned: 2, errorMessage: null, ranAt: now },
    { researchChannelId: THIRD_VALID_CHANNEL_ID, status: "failed", unitsSpent: 1, videosRequested: null, videosReturned: null, errorMessage: "x", ranAt: now }
  );

  const { channels } = await services.getWatchlistTable();
  const byId = new Map(channels.map((c) => [c.channelId, c]));

  const current = byId.get(VALID_CHANNEL_ID);
  assert.equal(current?.handleOrUrl, "@current");
  assert.equal(current?.reason, "current one");
  assert.deepEqual(current?.latestObservation, {
    observedAt: now.toISOString(),
    subscriberCount: 1200,
    hiddenSubscriberCount: false,
    viewCount: 34000,
    videoCount: 40,
  });
  assert.equal(current?.videosObserved, 2);
  assert.deepEqual(current?.latestRun, { status: "success", ranAt: now.toISOString() });
  assert.equal(current?.status, "current");

  const never = byId.get(OTHER_VALID_CHANNEL_ID);
  assert.equal(never?.latestObservation, null);
  assert.equal(never?.videosObserved, 0);
  assert.equal(never?.latestRun, null);
  assert.equal(never?.status, "never_collected");

  assert.equal(byId.get(THIRD_VALID_CHANNEL_ID)?.status, "failed");
  assert.equal(channels.length, 3);
});

// AC-R3-1: a channel whose latest observation is older than the 24-hour stale window, with a successful last run, is
// "attention" (stale), not "current" -- the same channel getMarketOverview counts as a collection warning.
test("BL-140: getWatchlistTable marks a channel with a stale observation as attention", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const threeDaysAgo = new Date("2026-09-24T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "stale one" }, { createdVia: "web_ui" });
  store.channelSnapshots.push({
    id: "snap-stale",
    researchChannelId: VALID_CHANNEL_ID,
    observedAt: threeDaysAgo,
    subscriberCount: null,
    viewCount: 5,
    videoCount: 1,
    hiddenSubscriberCount: true,
    source: "youtube.channels.list",
    createdVia: "web_ui",
  });
  store.collectionRuns.push({ researchChannelId: VALID_CHANNEL_ID, status: "success", unitsSpent: 1, videosRequested: 0, videosReturned: 0, errorMessage: null, ranAt: threeDaysAgo });

  const [row] = (await services.getWatchlistTable()).channels;
  assert.equal(row.status, "attention");
  assert.ok(row.dataQualityFlags.includes("stale_observation"));
  assert.deepEqual(row.latestObservation, { observedAt: threeDaysAgo.toISOString(), subscriberCount: null, hiddenSubscriberCount: true, viewCount: 5, videoCount: 1 });
  const overview = await services.getMarketOverview();
  assert.deepEqual(overview.collectionWarnings.map((w) => w.channelId), [VALID_CHANNEL_ID]);
});

// BL-140 review: the summary line's warning count, the Channels table's status and getMarketOverview's collection
// warnings come from one rule, so the "N channels need attention" link lands on exactly that many rows.
test("BL-140: summary counts, table statuses and overview warnings agree on which channels need attention", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "current" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "never" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: THIRD_VALID_CHANNEL_ID, reason: "failed" }, { createdVia: "web_ui" });
  for (const channelId of [VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID]) {
    store.channelSnapshots.push({
      id: `snap-${channelId}`,
      researchChannelId: channelId,
      observedAt: now,
      subscriberCount: 1,
      viewCount: 1,
      videoCount: 1,
      hiddenSubscriberCount: false,
      source: "youtube.channels.list",
      createdVia: "web_ui",
    });
  }
  store.collectionRuns.push(
    { researchChannelId: VALID_CHANNEL_ID, status: "success", unitsSpent: 1, videosRequested: 0, videosReturned: 0, errorMessage: null, ranAt: now },
    { researchChannelId: THIRD_VALID_CHANNEL_ID, status: "failed", unitsSpent: 1, videosRequested: null, videosReturned: null, errorMessage: "x", ranAt: now }
  );

  // By hand: the current channel is fine; the never-collected and the failed one need attention.
  const counts = await services.getResearchSummaryCounts();
  assert.deepEqual(counts, { watchlistCount: 3, warningCount: 2, newDiscoveryCount: 0 });
  const table = await services.getWatchlistTable();
  assert.deepEqual(table.channels.filter((c) => c.status !== "current").map((c) => c.channelId).sort(), [OTHER_VALID_CHANNEL_ID, THIRD_VALID_CHANNEL_ID].sort());
  const overview = await services.getMarketOverview();
  assert.equal(overview.collectionWarnings.length, counts.warningCount);
});

// BL-140 review: a channel drawer's recent videos read only that channel's series, not the whole watchlist's.
test("BL-140: getMarketVideosOverview({ channelId }) returns only that channel's videos and reads no other channel", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const { services, store } = createFixture({ now });
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "a" }, { createdVia: "web_ui" });
  await services.addToWatchlist({ channelId: OTHER_VALID_CHANNEL_ID, reason: "b" }, { createdVia: "web_ui" });
  for (const [videoId, channelId] of [["vA00000000000000000000", VALID_CHANNEL_ID], ["vB00000000000000000000", OTHER_VALID_CHANNEL_ID]] as const) {
    store.videoSnapshots.push({
      id: `vs-${videoId}`,
      researchChannelId: channelId,
      videoId,
      observedAt: now,
      viewCount: 5,
      likeCount: null,
      commentCount: null,
      publishedAt: now,
      title: videoId,
      source: "youtube.videos.list",
      createdVia: "web_ui",
    });
  }
  const narrowed = await services.getMarketVideosOverview({ channelId: OTHER_VALID_CHANNEL_ID });
  assert.deepEqual(narrowed.videos.map((v) => v.videoId), ["vB00000000000000000000"]);
  const all = await services.getMarketVideosOverview();
  assert.deepEqual(all.videos.map((v) => v.videoId).sort(), ["vA00000000000000000000", "vB00000000000000000000"]);
});


// BL-145 (P1, owner 2026-10-07): an agent's search request has the same 200-character limit as the search itself, so it
// can no longer be approved and then always fail.
test("BL-145 (P1): a research request query over 200 characters is refused at creation; 200 is accepted", async () => {
  const { services } = createFixture();
  await assert.rejects(
    () => services.createMarketResearchRequest({ query: "a".repeat(201), rationale: "r" }, { createdVia: "mcp" }),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  const ok = await services.createMarketResearchRequest({ query: "a".repeat(200), rationale: "r" }, { createdVia: "mcp" });
  assert.equal(ok.query.length, 200);
});

// BL-145 (owner, Telegram 2026-10-07, msg 1904 "1. Да"): each found channel shows its public counts, from one channels.list
// call for the whole search; observed values with their time, never served after 30 days. Expected values by hand.
test("BL-145: a search records each found channel's counts from one channels.list call and serves them with the candidate", async () => {
  const now = new Date("2026-10-07T01:00:00.000Z");
  const { services, channelStatsCalls } = createFixture({
    now,
    searchResults: [
      { channelId: "UC_A00000000000000000000", title: "A", description: null },
      { channelId: "UC_B00000000000000000000", title: "B", description: null },
    ],
    channelStats: [
      { channelId: "UC_A00000000000000000000", subscriberCount: 12300, hiddenSubscriberCount: false, videoCount: 42, viewCount: 456000, publishedAt: "2019-01-01T00:00:00Z" },
      { channelId: "UC_B00000000000000000000", subscriberCount: null, hiddenSubscriberCount: true, videoCount: 3, viewCount: 90, publishedAt: null },
    ],
  });
  await services.discoverChannels({ query: "bossa nova", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.deepEqual(channelStatsCalls, [{ channelIds: ["UC_A00000000000000000000", "UC_B00000000000000000000"] }]);
  const byId = new Map((await services.listDiscoveryCandidates()).candidates.map((c) => [c.channelId, c]));
  assert.deepEqual(byId.get("UC_A00000000000000000000")?.stats, {
    subscriberCount: 12300,
    hiddenSubscriberCount: false,
    videoCount: 42,
    viewCount: 456000,
    channelPublishedAt: "2019-01-01T00:00:00Z",
    observedAt: now.toISOString(),
  });
  assert.deepEqual(byId.get("UC_B00000000000000000000")?.stats, {
    subscriberCount: null,
    hiddenSubscriberCount: true,
    videoCount: 3,
    viewCount: 90,
    channelPublishedAt: null,
    observedAt: now.toISOString(),
  });
});

test("BL-145: when the counts lookup fails, the search still succeeds and the candidates simply have no counts", async () => {
  const { services, store } = createFixture({
    searchResults: [{ channelId: "UC_A00000000000000000000", title: "A", description: null }],
    channelStats: async () => {
      throw new Error("quota exceeded");
    },
  });
  const result = await services.discoverChannels({ query: "q", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal(result.candidatesNew, 1);
  assert.equal(store.discoveryRuns.at(-1)?.status, "success");
  assert.equal((await services.listDiscoveryCandidates()).candidates[0].stats, null);
});

test("BL-145: counts, like the title, are not served for a decided candidate last seen more than 30 days ago", async () => {
  const now = new Date("2026-10-07T00:00:00.000Z");
  const { services, store } = createFixture({ now });
  store.discoveryCandidates.set("UC_OLD0000000000000000000", {
    id: "UC_OLD0000000000000000000",
    title: "Old",
    status: "ignored",
    discoverySource: "youtube.search.list",
    discoveryQuery: "q",
    reasonDiscovered: "d",
    firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-08-01T00:00:00.000Z"),
    createdVia: "web_ui",
    subscriberCount: 5,
    hiddenSubscriberCount: false,
    videoCount: 1,
    viewCount: 1,
    channelPublishedAt: null,
    statsObservedAt: new Date("2026-08-01T00:00:00.000Z"),
  } as never);
  const old = (await services.listDiscoveryCandidates()).candidates.find((c) => c.channelId === "UC_OLD0000000000000000000");
  assert.deepEqual([old?.title, old?.stats], ["", null]);
});

// BL-145 (owner, Telegram 2026-10-07, msg 1904 "3. find by genre"): a genre search looks for music VIDEOS and groups them
// by channel. Fixture: 6 videos -- 3 from A, 1 from B, 2 from an auto-generated "- Topic" channel. Expected by hand.
const GENRE_VIDEOS = [
  { videoId: "a1", channelId: "UC_A00000000000000000000", channelTitle: "Bossa Cafe", title: "Bossa morning", publishedAt: "2026-09-01T00:00:00Z" },
  { videoId: "t1", channelId: "UC_T00000000000000000000", channelTitle: "Some Artist - Topic", title: "Track", publishedAt: null },
  { videoId: "b1", channelId: "UC_B00000000000000000000", channelTitle: "Jazz Room", title: "Night bossa", publishedAt: null },
  { videoId: "a2", channelId: "UC_A00000000000000000000", channelTitle: "Bossa Cafe", title: "Bossa evening", publishedAt: null },
  { videoId: "t2", channelId: "UC_T00000000000000000000", channelTitle: "Some Artist - Topic", title: "Track 2", publishedAt: null },
  { videoId: "a3", channelId: "UC_A00000000000000000000", channelTitle: "Bossa Cafe", title: "Bossa rain", publishedAt: null },
];
const snap = (videoId: string, viewCount: number) => ({ videoId, title: "", publishedAt: null, viewCount, likeCount: null, commentCount: null });

test("BL-145 genre: videos grouped by channel, most matches first, '- Topic' channels left out, match counts and views stored", async () => {
  const now = new Date("2026-10-07T00:00:00.000Z");
  const { services, store, musicVideoSearchCalls, channelStatsCalls } = createFixture({
    now,
    musicVideos: GENRE_VIDEOS,
    publicVideoSnapshots: [snap("a1", 100), snap("a2", 200), snap("a3", 300), snap("b1", 50)],
  });
  const result = await services.discoverChannelsByGenre({ query: "bossa nova cafe", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.deepEqual(result, {
    videosFound: 6,
    candidatesFound: 2,
    candidatesNew: 2,
    topicChannelsSkipped: 1,
    candidateIds: ["UC_A00000000000000000000", "UC_B00000000000000000000"],
  });
  assert.deepEqual(musicVideoSearchCalls, [{ query: "bossa nova cafe", publishedAfter: null }]);
  assert.deepEqual(channelStatsCalls, [{ channelIds: ["UC_A00000000000000000000", "UC_B00000000000000000000"] }]);
  const byId = new Map((await services.listDiscoveryCandidates()).candidates.map((c) => [c.channelId, c]));
  assert.deepEqual(byId.get("UC_A00000000000000000000")?.match, { query: "bossa nova cafe", videoCount: 3, viewCount: 600 });
  assert.deepEqual(byId.get("UC_B00000000000000000000")?.match, { query: "bossa nova cafe", videoCount: 1, viewCount: 50 });
  assert.equal(byId.get("UC_A00000000000000000000")?.reasonDiscovered, '3 matching videos: "Bossa morning", "Bossa evening", "Bossa rain"');
  assert.equal(byId.get("UC_A00000000000000000000")?.discoverySource, "youtube.search.list:music_videos");
  assert.equal(byId.has("UC_T00000000000000000000"), false);
  assert.deepEqual([store.discoveryRuns.at(-1)?.query, store.discoveryRuns.at(-1)?.status, store.discoveryRuns.at(-1)?.unitsSpent], ["bossa nova cafe [genre]", "success", 1]);
});

test("BL-145 genre: 'published within 90 days' asks only for videos after now minus 90 days; the run log says so", async () => {
  const now = new Date("2026-10-07T00:00:00.000Z");
  const { services, store, musicVideoSearchCalls } = createFixture({ now, musicVideos: [] });
  await services.discoverChannelsByGenre({ query: "lofi", publishedWithinDays: 90, credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.deepEqual(musicVideoSearchCalls, [{ query: "lofi", publishedAfter: "2026-07-09T00:00:00.000Z" }]);
  assert.equal(store.discoveryRuns.at(-1)?.query, "lofi [genre, 90 d]");
});

test("BL-145 genre: a channel already tracked is not a candidate; unknown views leave the match views empty, not 0", async () => {
  const { services } = createFixture({ musicVideos: GENRE_VIDEOS, publicVideoSnapshots: [snap("a1", 100)] });
  await services.addToWatchlist({ channelId: "UC_B00000000000000000000", reason: "r" }, { createdVia: "web_ui" });
  const result = await services.discoverChannelsByGenre({ query: "bossa", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.deepEqual([result.candidatesFound, result.candidatesNew, result.candidateIds], [2, 1, ["UC_A00000000000000000000"]]);
  const a = (await services.listDiscoveryCandidates()).candidates.find((c) => c.channelId === "UC_A00000000000000000000");
  assert.deepEqual(a?.match, { query: "bossa", videoCount: 3, viewCount: null });
});

test("BL-145 genre: the same preconditions as a name search -- no call once the 100 searches are used", async () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const { services, store, musicVideoSearchCalls } = createFixture({ now });
  for (let i = 0; i < 100; i++) store.discoveryRuns.push({ query: `q${i}`, status: "success", unitsSpent: 1, candidatesFound: 0, candidatesNew: 0, errorMessage: null, ranAt: now });
  await assert.rejects(
    () => services.discoverChannelsByGenre({ query: "lofi", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "MARKET_INTELLIGENCE_QUOTA_EXCEEDED"
  );
  assert.equal(musicVideoSearchCalls.length, 0);
});

// BL-145 review findings (expected values by hand).
test("BL-145 review: a re-found candidate never keeps older counts or match under the new date -- a failed lookup leaves them empty", async () => {
  const now = new Date("2026-10-07T00:00:00.000Z");
  const { services, store } = createFixture({
    now,
    searchResults: [{ channelId: "UC_A00000000000000000000", title: "A", description: null }],
    channelStats: async () => {
      throw new Error("lookup failed");
    },
  });
  store.discoveryCandidates.set("UC_A00000000000000000000", {
    id: "UC_A00000000000000000000",
    title: "A (old)",
    status: "new",
    discoverySource: "youtube.search.list:music_videos",
    discoveryQuery: "old",
    reasonDiscovered: null,
    firstSeenAt: new Date("2026-09-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-09-20T00:00:00.000Z"),
    createdVia: "web_ui",
    subscriberCount: 99,
    hiddenSubscriberCount: false,
    videoCount: 9,
    viewCount: 9,
    channelPublishedAt: null,
    statsObservedAt: new Date("2026-09-20T00:00:00.000Z"),
    matchQuery: "old",
    matchVideoCount: 5,
    matchViewCount: 500,
  } as never);
  await services.discoverChannels({ query: "q", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  const a = (await services.listDiscoveryCandidates()).candidates[0];
  assert.deepEqual([a.lastSeenAt, a.stats, a.match], [now.toISOString(), null, null]);
});

test("BL-145 review: a search's pool units are recorded and count in the Research budget; with no room left the lookups are skipped", async () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const tight = createFixture({ now, musicVideos: GENRE_VIDEOS, publicVideoSnapshots: [], channelStats: [] });
  tight.store.setQuotaBudget(1);
  await tight.services.discoverChannelsByGenre({ query: "bossa", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  // Budget 1: the video-views lookup (1 unit) fits, the channel counts (1 more) do not.
  assert.equal(tight.channelStatsCalls.length, 0);
  assert.equal((tight.store.discoveryRuns.at(-1) as { poolUnitsSpent?: number }).poolUnitsSpent, 1);

  const roomy = createFixture({ now, musicVideos: GENRE_VIDEOS, channelStats: [] });
  roomy.store.setQuotaBudget(100);
  await roomy.services.discoverChannelsByGenre({ query: "bossa", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.equal((roomy.store.discoveryRuns.at(-1) as { poolUnitsSpent?: number }).poolUnitsSpent, 2);
  assert.equal((await roomy.services.getCollectionLimits()).unitsSpentToday, 2, "the budget counts the search's 2 pool units");
});

test("BL-145 review: channels found in the same search are listed with the most matching videos first", async () => {
  const videos = [
    { videoId: "b1", channelId: "UC_B00000000000000000000", channelTitle: "B", title: "x", publishedAt: null },
    { videoId: "a1", channelId: "UC_A00000000000000000000", channelTitle: "A", title: "x", publishedAt: null },
    { videoId: "a2", channelId: "UC_A00000000000000000000", channelTitle: "A", title: "x", publishedAt: null },
  ];
  const { services } = createFixture({ musicVideos: videos });
  await services.discoverChannelsByGenre({ query: "q", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  assert.deepEqual((await services.listDiscoveryCandidates()).candidates.map((c) => c.channelId), ["UC_A00000000000000000000", "UC_B00000000000000000000"]);
});

// BL-156: the ordering above needs one search to stamp one lastSeenAt -- the search's own clock time, for new and
// re-found candidates alike (the comparator's "same search = same lastSeenAt" premise), never each insert's wall clock.
test("BL-156: every candidate one search inserts or re-finds is last seen at that search's clock time", async () => {
  const now = new Date("2026-10-07T00:00:00.000Z");
  const { services, store } = createFixture({
    now,
    musicVideos: [
      { videoId: "b1", channelId: "UC_B00000000000000000000", channelTitle: "B", title: "x", publishedAt: null },
      { videoId: "a1", channelId: "UC_A00000000000000000000", channelTitle: "A", title: "x", publishedAt: null },
    ],
  });
  store.discoveryCandidates.set("UC_A00000000000000000000", {
    id: "UC_A00000000000000000000",
    title: "A (old)",
    status: "new",
    discoverySource: "youtube.search.list:music_videos",
    discoveryQuery: "old",
    reasonDiscovered: null,
    firstSeenAt: new Date("2026-09-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-09-20T00:00:00.000Z"),
    createdVia: "web_ui",
  } as never);
  await services.discoverChannelsByGenre({ query: "q", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" });
  const b = store.discoveryCandidates.get("UC_B00000000000000000000");
  assert.deepEqual(
    [b?.firstSeenAt.toISOString(), b?.lastSeenAt.toISOString(), store.discoveryCandidates.get("UC_A00000000000000000000")?.lastSeenAt.toISOString()],
    ["2026-10-07T00:00:00.000Z", "2026-10-07T00:00:00.000Z", "2026-10-07T00:00:00.000Z"]
  );
});

// ---- FO-REQ-0015 item 4: the details read (review findings) -----------------------------------------------------------------------

test("details: the read stores videos.list rows (600 s, none) and agents see them, with each video's own thumbnail URL", async () => {
  const { store, services, setNow, videoSnapshotCalls } = createFixture({ now: T0, publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO, playlistPages: [PAGE_A], autoStats: "batch" });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(store.videoSnapshots.length, 50);
  assert.deepEqual([...new Set(store.videoSnapshots.map((row) => `${row.source}|${row.durationSeconds}|${row.liveBroadcastContent}`))], ["youtube.videos.list|600|none"]);
  // Next day: details are fresh, so page 1's refresh is batch-only (no details read) and those rows store no details of their own...
  setNow(new Date(T0.getTime() + DAY_MS));
  const callsBefore = videoSnapshotCalls.length;
  await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(videoSnapshotCalls.length, callsBefore, "no second details read within 20 days");
  const batchRows = store.videoSnapshots.filter((row) => row.source === "youtube.videos.batchGetStats");
  assert.equal(batchRows.length, 50);
  assert.ok(batchRows.every((row) => (row.durationSeconds ?? null) === null), "nothing copied into storage");
  // ...but every row an agent reads carries the video's known details and its thumbnail.
  const context = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  const a1 = context.videoSnapshots.filter((row) => row.videoId === "a1");
  assert.equal(a1.length, 2);
  assert.ok(a1.every((row) => row.durationSeconds === 600 && row.liveBroadcastContent === "none"));
  assert.equal(a1[0].thumbnailUrl, "https://i.ytimg.com/vi/a1/hqdefault.jpg");
});

test("details: a failed read keeps the batch rows (1 unit spent, the run still succeeds) and is tried again on the next run", async () => {
  let failing = true;
  const { store, services, setNow, videoSnapshotCalls } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A],
    autoStats: "batch",
    detailsError: () => (failing ? new Error("videos.list down (test)") : null),
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  // channels.list 1 + page 1 1 + the failed details read 1 = 3.
  const first = await services.runCollectionIfStale(RUN_INPUT);
  assert.deepEqual([first.succeeded, first.failed, first.unitsSpent], [1, 0, 3]);
  assert.ok(store.videoSnapshots.every((row) => row.source === "youtube.videos.batchGetStats"));
  failing = false;
  setNow(new Date(T0.getTime() + DAY_MS));
  const callsBefore = videoSnapshotCalls.length;
  await services.runCollectionIfStale(RUN_INPUT);
  assert.equal(videoSnapshotCalls.length, callsBefore + 1, "read again: no details were stored");
  assert.equal(store.videoSnapshots.filter((row) => row.source === "youtube.videos.list").length, 50);
});

test("details: an exhausted quota on the read ends the channel's collection as failed, never as a silent success", async () => {
  const { store, services } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [PAGE_A],
    autoStats: "batch",
    detailsError: () => new DomainError({ code: "youtube_quota_exceeded", message: "quota (test)" }),
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  const result = await services.runCollectionIfStale(RUN_INPUT);
  assert.deepEqual([result.succeeded, result.failed], [0, 1]);
});

test("details: a stream that is upcoming or live is read again on every run until it has its duration", async () => {
  let live: string = "upcoming";
  const { store, services, setNow, videoSnapshotCalls } = createFixture({
    now: T0,
    publicSnapshot: FULL_SNAPSHOT_WITH_VIDEO,
    playlistPages: [["s1"]],
    autoStats: "batch",
    detailsFor: () => (live === "none" ? { durationSeconds: 5400, liveBroadcastContent: "none" } : { durationSeconds: null, liveBroadcastContent: live }),
  });
  store.setQuotaBudget(100);
  await services.addToWatchlist({ channelId: VALID_CHANNEL_ID, reason: "r" }, { createdVia: "web_ui" });
  await services.runCollectionIfStale(RUN_INPUT); // upcoming
  live = "live";
  setNow(new Date(T0.getTime() + DAY_MS));
  await services.runCollectionIfStale(RUN_INPUT); // read again: live
  live = "none";
  setNow(new Date(T0.getTime() + 2 * DAY_MS));
  await services.runCollectionIfStale(RUN_INPUT); // read again: ended, 1 h 30 min
  setNow(new Date(T0.getTime() + 3 * DAY_MS));
  await services.runCollectionIfStale(RUN_INPUT); // settled: no read
  assert.equal(videoSnapshotCalls.length, 3);
  const context = await services.getWatchlistEntryContext({ channelId: VALID_CHANNEL_ID });
  // The fake store stamps rows with the wall clock (all within the same millisecond or two here), so "newest" is the last row read.
  const newest = context.videoSnapshots[context.videoSnapshots.length - 1];
  assert.equal(newest.source, "youtube.videos.batchGetStats");
  assert.deepEqual([newest.durationSeconds, newest.liveBroadcastContent], [5400, "none"]);
  assert.equal(store.videoSnapshots.length, 4);
});
