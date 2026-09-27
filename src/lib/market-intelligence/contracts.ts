import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  createIdGenerator,
  type DomainErrorCode,
  type DomainErrorShape,
  type ResolvedCredentials,
} from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape, ResolvedCredentials };
export { DomainError, isDomainError, parseWithSchema, formatZodError, createIdGenerator };

// ---------------------------------------------------------------------------
// Phase 9 slice 1 -- market-research watchlist (docs/roadmap/plans/PHASE_9_PLAN.md). Owns
// `research_channels`/`research_evidence`: manually-seeded public observations about a channel
// the operator does not (necessarily) own. Structurally separate from `channels`/`videos` --
// never joined, never a foreign key into either (AGENTS.md §F: owned-channel analytics and
// public market/competitor observations stay explicitly separate). Global, not scoped to any
// one owned channel.
// ---------------------------------------------------------------------------

export type ResearchChannel = {
  channelId: string;
  handleOrUrl: string | null;
  reason: string;
  addedAt: string;
};

export type ResearchEvidence = {
  evidenceId: string;
  researchChannelId: string;
  observation: string;
  source: string;
  confidence: string | null;
  collectedAt: string;
};

/**
 * Phase 9 slice 3 -- locally redefined with the same shape as
 * `youtube-read-gateway`'s own `PublicChannelSnapshot`, never imported from it directly (mirrors
 * `channel-sync/contracts.ts`'s own `ChannelForSync` -- AGENTS.md §D: each domain module stays
 * independent of another module's internal type, even the read gateway's).
 */
export type PublicChannelSnapshot = {
  channelId: string;
  title: string;
  subscriberCount: number | null;
  /** YouTube's own real flag -- added for Phase 9 slice 9A so `captureChannelSnapshot` never has
   * to re-guess "hidden" from `subscriberCount === null` (which is also `null` for an unrelated,
   * genuinely-unknown reason). See the read gateway's own `PublicChannelSnapshot` doc comment. */
  hiddenSubscriberCount: boolean;
  viewCount: number | null;
  videoCount: number | null;
  /** Added for Phase 9 slice 9B -- see the read gateway's own `PublicChannelSnapshot` doc comment. */
  uploadsPlaylistId: string | null;
};

/**
 * Phase 9 slice 9B -- locally redefined with the same shape as `youtube-read-gateway`'s own
 * `PublicVideoSnapshot`, never imported from it directly (same independence rationale as
 * `PublicChannelSnapshot` above).
 */
export type PublicVideoSnapshot = {
  videoId: string;
  title: string;
  publishedAt: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
};

// ---------------------------------------------------------------------------
// Phase 9 slice 9A (docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md) -- structured, append-only
// public observations. Never upserted by any natural key -- every real fetch is its own newly-
// inserted row (§2 of the slice plan explains why `video_metrics_daily`'s per-day-upsert pattern
// does not transfer here). `research_evidence` remains the free-text/qualitative log; these are
// the numeric counterpart, per PHASE_9_PLAN.md §13's entity-mapping table.
// ---------------------------------------------------------------------------

export type MarketChannelSnapshot = {
  snapshotId: string;
  researchChannelId: string;
  observedAt: string;
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
  hiddenSubscriberCount: boolean;
  source: string;
};

export type MarketVideoSnapshot = {
  snapshotId: string;
  researchChannelId: string;
  videoId: string;
  observedAt: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  publishedAt: string | null;
  source: string;
};

// ---------------------------------------------------------------------------
// Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md) -- search.list-based discovery.
// A LIFECYCLE entity, not an append-only observation like the two types above (see the doc comment
// on db.ts's own `marketDiscoveryCandidates` table for why).
// ---------------------------------------------------------------------------

export type DiscoveryCandidateStatus = "new" | "watching" | "ignored" | "archived" | "promoted";

export type MarketDiscoveryCandidate = {
  channelId: string;
  title: string;
  status: DiscoveryCandidateStatus;
  discoverySource: string;
  discoveryQuery: string;
  reasonDiscovered: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

/**
 * Phase 9 slice 9C -- locally redefined with the same shape as `youtube-read-gateway`'s own
 * `PublicChannelSearchResult`, never imported from it directly (same independence rationale as
 * `PublicChannelSnapshot`/`PublicVideoSnapshot` above).
 */
export type PublicChannelSearchResult = {
  channelId: string;
  title: string;
  description: string | null;
};

// ---------------------------------------------------------------------------
// Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- topic model and manual/
// structural trend candidates.
// ---------------------------------------------------------------------------

export type TopicAssignmentSubjectType = "channel" | "video";

export type MarketTopic = {
  topicId: string;
  name: string;
  addedAt: string;
};

export type MarketTopicAssignment = {
  assignmentId: string;
  topicId: string;
  subjectType: TopicAssignmentSubjectType;
  subjectId: string;
  source: "manual" | "ai_assisted";
  assignedAt: string;
};

export type TrendCandidateStatus = "emerging" | "growing" | "established" | "declining" | "stale";

export type MarketTrendCandidate = {
  trendCandidateId: string;
  title: string;
  description: string | null;
  topicId: string | null;
  status: TrendCandidateStatus;
  firstObservedAt: string;
  lastObservedAt: string;
};

export type TrendEvidenceType = "supporting_channel" | "supporting_video" | "signal";

/**
 * Purpose-built for trend candidates, NOT a reuse of `shared-provenance`'s `EvidenceReference` --
 * that shape is for citing an EXTERNAL url-based source, a mismatch for "this trend is supported by
 * these N of our own already-tracked channels/videos."
 */
export type MarketTrendEvidence = {
  evidenceId: string;
  trendCandidateId: string;
  evidenceType: TrendEvidenceType;
  referenceId: string | null;
  description: string;
  recordedAt: string;
};

// ---------------------------------------------------------------------------
// Phase 9 slice 9I (docs/roadmap/plans/PHASE_9_SLICE_9I_PLAN.md) -- shared data-quality vocabulary
// (owner spec §27). Lives in this leaf module (no internal imports of its own) so both
// `services.ts` and `data-quality.ts` can depend on it without either depending on the other --
// `data-quality.ts`'s functions are meant to eventually be called FROM `services.ts` (9H), so
// `services.ts` must never be something `data-quality.ts` itself imports from (AGENTS.md §D: one
// direction of dependency, never a cycle).
// ---------------------------------------------------------------------------

/**
 * Seven entries, not the spec's literal eight -- `deleted_video`/`private_video` are deliberately
 * collapsed into `video_no_longer_public`. See `PHASE_9_SLICE_9I_PLAN.md` §2 for the full
 * discrepancy report (AGENTS.md §A): the real YouTube Data API v3 cannot distinguish the two for a
 * non-owned channel's video, so auto-detecting a split this codebase's own research found the API
 * does not support would be dishonest, not a "more complete" implementation of the spec's list.
 */
export type DataQualityFlag =
  | "insufficient_history"
  | "missing_snapshot"
  | "stale_observation"
  | "video_no_longer_public"
  | "hidden_subscriber_count"
  | "partial_discovery"
  | "quota_limited";

/**
 * A channel/video observation older than this is `"stale_observation"` (9I) -- the SAME constant
 * `services.ts`'s own `runCollectionIfStale` (9B) uses to decide when a channel is due for
 * re-collection, imported by both from here rather than each defining its own copy (AGENTS.md §D:
 * one guardrail/threshold, not two that could silently drift apart).
 */
export const MARKET_INTELLIGENCE_STALE_WINDOW_MS = 24 * 60 * 60 * 1000;
