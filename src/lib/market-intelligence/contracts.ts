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
