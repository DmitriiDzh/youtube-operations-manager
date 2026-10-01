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
};

type CollectionRunRow = {
  researchChannelId: string;
  status: "success" | "skipped_quota_limited" | "failed";
  unitsSpent: number;
  videosRequested: number | null;
  videosReturned: number | null;
  errorMessage: string | null;
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
  let quotaBudget: number | null = null;
  let nextId = 1;
  let failNextSuccessRunInsert = false;
  let failVideoSnapshotInsertAfter: number | null = null;
  let videoSnapshotInsertCount = 0;
  let failNextMark = false;
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
    // Sums BOTH tables -- mirrors db.ts's own real implementation exactly (one shared budget
    // across collection and discovery, not two independent ones).
    // Phase 13 slice 13.4: the shared 10k pool counts collection runs only; searches have their own
    // bucket and are counted below.
    async getMarketIntelligenceUnitsSpentSince(since: Date) {
      return collectionRuns.filter((row) => row.ranAt.getTime() >= since.getTime()).reduce((sum, row) => sum + row.unitsSpent, 0);
    },
    async countMarketDiscoverySearchesSince(since: Date) {
      return discoveryRuns.filter((row) => row.ranAt.getTime() >= since.getTime()).length;
    },
    async claimStaleResearchChannelsForCollection(args: {
      now: Date;
      staleCutoff: Date;
      claimExpiryCutoff: Date;
      excludeResearchChannelIds: string[];
    }) {
      const claimed: string[] = [];
      for (const [id, row] of channels) {
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
      ranAt?: Date;
    }) {
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
    }) {
      if (failInsertMarketDiscoveryCandidateFor === input.id) {
        throw new Error("simulated insertMarketDiscoveryCandidate failure");
      }
      const now = new Date();
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
      }
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
    }) {
      discoveryRuns.push({
        query: input.query,
        status: input.status,
        unitsSpent: input.unitsSpent,
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
  searchImpl?: (args: { credentials: ResolvedCredentials; query: string }) => Promise<PublicChannelSearchResult[]>;
  dataApiReadsDisabled?: boolean;
  /** Phase 13 slices 13.5/13.6. Unset = the RSS feed / batchGetStats are unavailable (they throw), so
   * every pre-Phase-13 test exercises the original quota-spending path as the fallback. */
  feedVideos?: { videoId: string; title: string; publishedAt: string | null }[];
  batchStats?: PublicVideoSnapshot[];
  playlistFails?: boolean;
  playlistTitles?: Record<string, string>;
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
  const assertReadsAvailableCalls: undefined[] = [];
  let currentNow = overrides?.now ?? new Date();
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
      async listUploadsPlaylistFirstPage(args: { credentials: ResolvedCredentials; uploadsPlaylistId: string }) {
        playlistCalls.push(args);
        if (overrides?.playlistFails) throw new Error("playlistItems failed (test)");
        return (overrides?.uploadsPlaylistVideoIds ?? []).map((videoId) => ({
          videoId,
          title: overrides?.playlistTitles?.[videoId] ?? "",
          publishedAt: null,
        }));
      },
      async getPublicVideoSnapshots(args: { credentials: ResolvedCredentials; videoIds: string[] }) {
        videoSnapshotCalls.push(args);
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
        if (!overrides?.batchStats) throw new Error("batchGetStats unavailable (test default)");
        return overrides.batchStats;
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
    assertReadsAvailableCalls,
    feedCalls,
    batchStatsCalls,
    musicChartCalls,
    setNow(date: Date) {
      currentNow = date;
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
  assert.deepEqual(added, {
    channelId: VALID_CHANNEL_ID,
    handleOrUrl: "@example",
    reason: "Fast-growing in the same niche",
    addedAt: added.addedAt,
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

test("AC-9C-01: with budget null/unset, discoverChannels makes zero real calls and throws MARKET_INTELLIGENCE_QUOTA_DISABLED", async () => {
  const { store, services, resolveCalls, searchCalls } = createFixture();

  await assert.rejects(
    () => services.discoverChannels({ query: "cooking", credentialRef: { userId: "u1" } }, { createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "MARKET_INTELLIGENCE_QUOTA_DISABLED"
  );
  assert.equal(resolveCalls.length, 0, "must never resolve credentials before the budget check");
  assert.equal(searchCalls.length, 0);
  assert.equal(store.discoveryRuns.length, 0);
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
  assert.deepEqual(result, { candidatesFound: 3, candidatesNew: 1 });

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

test("AC-9G-B-05b: a missing/exhausted budget, or disabled Data API reads, leaves the request 'pending' -- never permanently burned into execution_failed", async () => {
  const { store, services } = createFixture();
  const created = await services.createMarketResearchRequest({ query: "night jazz", rationale: "worth watching" }, { createdVia: "mcp" });

  // No budget set at all (default null).
  await assert.rejects(
    () =>
      services.approveMarketResearchRequest(
        { requestId: created.requestId, credentialRef: { userId: "u1" } },
        { createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "MARKET_INTELLIGENCE_QUOTA_DISABLED"
  );
  assert.equal(store.marketResearchRequests.get(created.requestId)?.status, "pending");

  // Budget set, but today's search bucket is exhausted (13.4: 100 searches per quota day).
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

test("13.6: playlist + batchGetStats: 2 pool units, no videos.list; title/publish time from the playlist and batchGetStats", async () => {
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
  assert.deepEqual(result, { attempted: 1, succeeded: 1, failed: 0, quotaLimited: 0, unitsSpent: 2 });
  assert.equal(batchStatsCalls.length, 1);
  assert.equal(videoSnapshotCalls.length, 0);
  assert.equal(feedCalls.length, 0, "RSS is only a fallback");
  const [snap] = store.videoSnapshots;
  assert.equal(snap.viewCount, 10);
  assert.equal(snap.title, "From playlist", "batchGetStats returns no title (documented shape) -- it comes from the playlist");
  assert.equal(snap.publishedAt?.toISOString(), "2026-09-20T00:00:00.000Z");
  assert.equal(snap.source, "youtube.videos.batchGetStats");
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
  assert.equal(result.unitsSpent, 2, "channels.list + the failed playlist call (charged); RSS and batchGetStats are free of the pool");
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
