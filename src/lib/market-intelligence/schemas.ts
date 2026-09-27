import { z } from "zod";
import { createdViaSchema } from "@/lib/shared-provenance";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";
export { parseWithSchema, formatZodError } from "./contracts";

// Same pattern as `src/lib/cli-auth/schemas.ts`'s `selectWriteChannelInputSchema` -- duplicated
// rather than shared, per this codebase's own `parseWithSchema` precedent (`AGENTS.md` §D: a
// tiny validation helper is kept independent per module rather than introducing a dependency for
// one regex). A canonical `UC...` id is required here (never a bare handle) -- resolving a
// `@handle`/URL to a channel id is deferred to a later slice (`docs/roadmap/plans/PHASE_9_PLAN.md`
// §8); `handleOrUrl` below is informational only.
const youtubeChannelIdSchema = z
  .string()
  .min(1, "channelId is required")
  .regex(/^UC[a-zA-Z0-9_-]{22}$/, "channelId must be a valid YouTube channel id");

export const addToWatchlistInputSchema = z
  .object({
    channelId: youtubeChannelIdSchema,
    handleOrUrl: z.string().min(1).max(500).optional(),
    reason: z.string().min(1, "reason is required").max(2000),
  })
  .strict();

export const listWatchlistOutputSchema = z
  .object({
    channels: z.array(
      z
        .object({
          channelId: z.string().min(1),
          handleOrUrl: z.string().nullable(),
          reason: z.string(),
          addedAt: z.string(),
        })
        .strict()
    ),
  })
  .strict();

export const researchChannelSchema = z
  .object({
    channelId: z.string().min(1),
    handleOrUrl: z.string().nullable(),
    reason: z.string(),
    addedAt: z.string(),
  })
  .strict();

export const addToWatchlistOutputSchema = researchChannelSchema;

export const getWatchlistEntryInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

export const getWatchlistEntryOutputSchema = researchChannelSchema;

// Added by independent review (2026-09-26): the first version of this module had no way to
// correct or remove a watchlist entry once added.
export const removeFromWatchlistInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

export const recordEvidenceInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
    observation: z.string().min(1, "observation is required").max(2000),
    source: z.string().min(1, "source is required").max(500),
    confidence: z.string().min(1).max(200).optional(),
  })
  .strict();

export const researchEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    researchChannelId: z.string().min(1),
    observation: z.string(),
    source: z.string(),
    confidence: z.string().nullable(),
    collectedAt: z.string(),
  })
  .strict();

export const recordEvidenceOutputSchema = researchEvidenceSchema;

export const listEvidenceInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
  })
  .strict();

export const listEvidenceOutputSchema = z
  .object({
    evidence: z.array(researchEvidenceSchema),
  })
  .strict();

// Phase 9 slice 9G, part A (docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md) -- the shared
// DataQualityFlag vocabulary (9I), as a schema for validating this action's own derived output.
const dataQualityFlagSchema = z.enum([
  "insufficient_history",
  "missing_snapshot",
  "stale_observation",
  "video_no_longer_public",
  "hidden_subscriber_count",
  "partial_discovery",
  "quota_limited",
]);

// Phase 9 slice 3 -- the one action in this module that makes a real outbound YouTube API call.
export const fetchPublicSnapshotInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
    credentialRef: credentialRefSchema,
  })
  .strict();

export const fetchPublicSnapshotOutputSchema = researchEvidenceSchema;

// ---------------------------------------------------------------------------
// Phase 9 slice 9A (docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md) -- structured, append-only
// public observations. See contracts.ts's own doc comment for why these are never upserted.
// ---------------------------------------------------------------------------

// Never `.min(0)` alone -- `.int()` first rejects a fractional "count" outright, matching this
// codebase's existing "a count is always a non-negative integer" convention (e.g. analytics'
// own metric values).
const nonNegativeIntSchema = z.number().int().nonnegative();

export const marketChannelSnapshotSchema = z
  .object({
    snapshotId: z.string().min(1),
    researchChannelId: z.string().min(1),
    observedAt: z.string(),
    subscriberCount: z.number().int().nullable(),
    viewCount: z.number().int().nullable(),
    videoCount: z.number().int().nullable(),
    hiddenSubscriberCount: z.boolean(),
    source: z.string(),
  })
  .strict();

export const recordChannelSnapshotInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
    subscriberCount: nonNegativeIntSchema.optional(),
    viewCount: nonNegativeIntSchema.optional(),
    videoCount: nonNegativeIntSchema.optional(),
    hiddenSubscriberCount: z.boolean().optional(),
    source: z.string().min(1, "source is required").max(500),
  })
  .strict()
  // Found by independent review, 2026-09-26: without this, a manual entry could claim
  // `hiddenSubscriberCount: true` (a real, known fact) and a concrete `subscriberCount` (a real,
  // known number) at once -- self-contradictory, and uncorrectable once stored (this table is
  // append-only, `PHASE_9_SLICE_9A_PLAN.md` §2).
  .refine((input) => !(input.hiddenSubscriberCount === true && input.subscriberCount !== undefined), {
    message: "subscriberCount must not be provided when hiddenSubscriberCount is true",
    path: ["subscriberCount"],
  });

export const recordChannelSnapshotOutputSchema = marketChannelSnapshotSchema;

export const listChannelSnapshotsInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
  })
  .strict();

export const listChannelSnapshotsOutputSchema = z
  .object({
    snapshots: z.array(marketChannelSnapshotSchema),
  })
  .strict();

export const marketVideoSnapshotSchema = z
  .object({
    snapshotId: z.string().min(1),
    researchChannelId: z.string().min(1),
    videoId: z.string().min(1),
    observedAt: z.string(),
    viewCount: z.number().int().nullable(),
    likeCount: z.number().int().nullable(),
    commentCount: z.number().int().nullable(),
    publishedAt: z.string().nullable(),
    source: z.string(),
  })
  .strict();

export const recordVideoSnapshotInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
    videoId: z.string().min(1, "videoId is required"),
    viewCount: nonNegativeIntSchema.optional(),
    likeCount: nonNegativeIntSchema.optional(),
    commentCount: nonNegativeIntSchema.optional(),
    // `.datetime()` (this codebase's established convention for a trusted ISO timestamp, e.g.
    // snapshot/schemas.ts's own createdAt) -- found by independent review, 2026-09-26: a bare
    // `.string()` here let an unparseable value (e.g. "not-a-date") reach `new Date(...)` in
    // services.ts, producing an Invalid Date whose NaN epoch then crashed the libsql driver with
    // an opaque low-level exception instead of this module's normal clean validation_failed.
    publishedAt: z.string().datetime().optional(),
    source: z.string().min(1, "source is required").max(500),
  })
  .strict();

export const recordVideoSnapshotOutputSchema = marketVideoSnapshotSchema;

export const listVideoSnapshotsInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
  })
  .strict();

export const listVideoSnapshotsOutputSchema = z
  .object({
    snapshots: z.array(marketVideoSnapshotSchema),
  })
  .strict();

// The one action in this module's 9A slice that makes a real outbound YouTube API call --
// mirrors fetchPublicSnapshotInputSchema exactly (no `source` field: server-stamped at the call
// site, never caller-supplied, same as fetchPublicSnapshot's own "youtube.channels.list").
export const captureChannelSnapshotInputSchema = z
  .object({
    researchChannelId: z.string().min(1),
    credentialRef: credentialRefSchema,
  })
  .strict();

export const captureChannelSnapshotOutputSchema = marketChannelSnapshotSchema;

// ---------------------------------------------------------------------------
// Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md) -- repeatable refresh trigger.
// ---------------------------------------------------------------------------

// Same shape as fetchPublicSnapshotInputSchema/captureChannelSnapshotInputSchema's own
// credentialRef field -- this trigger is global (every stale watchlisted channel at once), not
// scoped to one researchChannelId, so that is its only input.
export const runCollectionIfStaleInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
  })
  .strict();

export const runCollectionIfStaleOutputSchema = z
  .object({
    attempted: nonNegativeIntSchema,
    succeeded: nonNegativeIntSchema,
    failed: nonNegativeIntSchema,
    quotaLimited: nonNegativeIntSchema,
    unitsSpent: nonNegativeIntSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md) -- search.list-based discovery.
// ---------------------------------------------------------------------------

export const discoverChannelsInputSchema = z
  .object({
    query: z.string().min(1, "query is required").max(200),
    credentialRef: credentialRefSchema,
  })
  .strict();

export const discoverChannelsOutputSchema = z
  .object({
    candidatesFound: nonNegativeIntSchema,
    candidatesNew: nonNegativeIntSchema,
  })
  .strict();

export const marketDiscoveryCandidateSchema = z
  .object({
    channelId: z.string().min(1),
    title: z.string(),
    status: z.enum(["new", "watching", "ignored", "archived", "promoted"]),
    discoverySource: z.string(),
    discoveryQuery: z.string(),
    reasonDiscovered: z.string().nullable(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
  })
  .strict();

export const listDiscoveryCandidatesOutputSchema = z
  .object({
    candidates: z.array(marketDiscoveryCandidateSchema),
  })
  .strict();

// "new" is never an accepted target (it's the initial state only) and "promoted" is never accepted
// here (it has a real side effect -- creating a watchlist entry -- and needs its own dedicated
// action/audit trail below, not a bare status flip).
export const updateDiscoveryCandidateStatusInputSchema = z
  .object({
    channelId: z.string().min(1),
    status: z.enum(["watching", "ignored", "archived"]),
  })
  .strict();

export const promoteDiscoveryCandidateInputSchema = z
  .object({
    channelId: z.string().min(1),
    reason: z.string().min(1, "reason is required").max(2000),
  })
  .strict();

export const promoteDiscoveryCandidateOutputSchema = z
  .object({
    channel: researchChannelSchema,
    candidate: marketDiscoveryCandidateSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- topic model, part A.
// ---------------------------------------------------------------------------

// A well-formed YouTube video id (11 chars) -- mirrors youtubeChannelIdSchema's own precedent of a
// locally-duplicated regex rather than a shared dependency for one pattern (AGENTS.md §D).
const youtubeVideoIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{11}$/, "subjectId must be a valid YouTube video id");

// Trims and collapses internal whitespace runs (owner spec §13: "normalized keywords") -- the
// service layer separately does a case-insensitive comparison against existing topic names before
// insert (this schema only normalizes whitespace, never casing, since casing is a display
// preference this module preserves as typed).
const topicNameSchema = z
  .string()
  .min(1, "name is required")
  .max(200)
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .refine((value) => value.length > 0, { message: "name is required" });

export const createTopicInputSchema = z.object({ name: topicNameSchema }).strict();

export const marketTopicSchema = z
  .object({
    topicId: z.string().min(1),
    name: z.string(),
    addedAt: z.string(),
  })
  .strict();

export const createTopicOutputSchema = marketTopicSchema;
export const listTopicsOutputSchema = z.object({ topics: z.array(marketTopicSchema) }).strict();
export const deleteTopicInputSchema = z.object({ topicId: z.string().min(1) }).strict();

export const marketTopicAssignmentSchema = z
  .object({
    assignmentId: z.string().min(1),
    topicId: z.string().min(1),
    subjectType: z.enum(["channel", "video"]),
    subjectId: z.string().min(1),
    source: z.enum(["manual", "ai_assisted"]),
    assignedAt: z.string(),
  })
  .strict();

// A discriminated union so `subjectId`'s own format is validated according to `subjectType` --
// a channel subject must be a canonical `UC...` id, a video subject an 11-char YouTube video id.
export const assignTopicInputSchema = z.discriminatedUnion("subjectType", [
  z.object({ topicId: z.string().min(1), subjectType: z.literal("channel"), subjectId: youtubeChannelIdSchema }).strict(),
  z.object({ topicId: z.string().min(1), subjectType: z.literal("video"), subjectId: youtubeVideoIdSchema }).strict(),
]);

export const assignTopicOutputSchema = marketTopicAssignmentSchema;
export const removeTopicAssignmentInputSchema = z.object({ assignmentId: z.string().min(1) }).strict();
export const listAssignmentsForTopicInputSchema = z.object({ topicId: z.string().min(1) }).strict();
export const listAssignmentsForTopicOutputSchema = z.object({ assignments: z.array(marketTopicAssignmentSchema) }).strict();

export const listTopicsForSubjectInputSchema = z.discriminatedUnion("subjectType", [
  z.object({ subjectType: z.literal("channel"), subjectId: youtubeChannelIdSchema }).strict(),
  z.object({ subjectType: z.literal("video"), subjectId: youtubeVideoIdSchema }).strict(),
]);
export const listTopicsForSubjectOutputSchema = z.object({ assignments: z.array(marketTopicAssignmentSchema) }).strict();

// Phase 9 slice 4's original shape was just `{ channel, evidence }`; extended in 9G, part A
// (docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md §2) with 9A/9E-part-A read surfaces and 9I's derived
// `dataQualityFlags` -- additive only, so any caller reading just the original two fields is
// unaffected. MCP's query_market_intelligence and CLI's `agent market-intelligence` both return
// this via getWatchlistEntryContext's single implementation.
export const getWatchlistEntryContextOutputSchema = z
  .object({
    channel: researchChannelSchema,
    evidence: z.array(researchEvidenceSchema),
    channelSnapshots: z.array(marketChannelSnapshotSchema),
    videoSnapshots: z.array(marketVideoSnapshotSchema),
    topicAssignments: z.array(marketTopicAssignmentSchema),
    dataQualityFlags: z.array(dataQualityFlagSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 9 slice 9H, part A (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md) -- Channels
// intelligence view. A UI-only wrapper around `getWatchlistEntryContext`, never a change to that
// function's own contract (§3 of that plan). Deliberately does NOT include `videoSnapshots` --
// see the plan's §4/§4a for why (an unbounded, append-only series that must not ship over the
// network in full) -- `latestSnapshotPerVideo` and the separate `getChannelVideoSnapshotHistory`
// action below are the bounded replacements.
// ---------------------------------------------------------------------------

const fieldVelocitySchema = z
  .object({
    value: z.number().nullable(),
    basis: z.enum(["insufficient_history", "stale_latest", "partial_window", "full_window"]),
  })
  .strict();

const breakoutAssessmentSchema = z
  .object({
    videoId: z.string().min(1),
    dayOffset: z.number().int(),
    videoViewCount: z.number().int().nullable(),
    channelBaselineMedianViewCount: z.number().nullable(),
    ratio: z.number().nullable(),
    isBreakout: z.boolean(),
    reason: z.string(),
  })
  .strict();

const emergingChannelAssessmentSchema = z
  .object({
    researchChannelId: z.string().min(1),
    recentBreakoutVideoCount: z.number().int(),
    subscriberVelocityPerDay: z.number().nullable(),
    isEmerging: z.boolean(),
    reasons: z.array(z.string()),
  })
  .strict();

const latestVideoSnapshotSchema = z
  .object({
    videoId: z.string().min(1),
    observedAt: z.string(),
    viewCount: z.number().int().nullable(),
    likeCount: z.number().int().nullable(),
    commentCount: z.number().int().nullable(),
    publishedAt: z.string().nullable(),
  })
  .strict();

export const getChannelIntelligenceSummaryInputSchema = z.object({ channelId: z.string().min(1) }).strict();

// Returned alongside the figures they produced, not just used internally -- a caller-chosen
// methodology that isn't shown to the reader is exactly the "opaque score" owner spec §11 forbids
// (plan §2). The Web UI reads these instead of hardcoding a client-side copy that could drift from
// services.ts's own exported constants.
const channelIntelligenceMethodologySchema = z
  .object({
    channelVelocityWindowDays: z.number().int().positive(),
    recentVideoWindowDays: z.number().int().positive(),
    channelBaselineDayOffset: z.number().int().positive(),
  })
  .strict();

export const getChannelIntelligenceSummaryOutputSchema = z
  .object({
    channel: researchChannelSchema,
    evidence: z.array(researchEvidenceSchema),
    channelSnapshots: z.array(marketChannelSnapshotSchema),
    topicAssignments: z.array(marketTopicAssignmentSchema),
    dataQualityFlags: z.array(dataQualityFlagSchema),
    subscriberVelocity: fieldVelocitySchema,
    uploadCadence: fieldVelocitySchema,
    recentBreakoutVideos: z.array(breakoutAssessmentSchema),
    emergingChannel: emergingChannelAssessmentSchema,
    latestSnapshotPerVideo: z.array(latestVideoSnapshotSchema),
    methodology: channelIntelligenceMethodologySchema,
  })
  .strict();

export const getChannelVideoSnapshotHistoryInputSchema = z
  .object({ channelId: z.string().min(1), videoId: z.string().min(1) })
  .strict();

export const getChannelVideoSnapshotHistoryOutputSchema = z
  .object({ snapshots: z.array(marketVideoSnapshotSchema) })
  .strict();

// ---------------------------------------------------------------------------
// Phase 9 slice 9E, part B (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- manual/structural trend
// candidates.
// ---------------------------------------------------------------------------

const trendCandidateStatusSchema = z.enum(["emerging", "growing", "established", "declining", "stale"]);
const trendEvidenceTypeSchema = z.enum(["supporting_channel", "supporting_video", "signal"]);

const trendEvidenceDescriptionSchema = z.string().min(1, "description is required").max(2000);

// Each evidence type carries a differently-shaped, actually-validated reference: `supporting_video`
// must be a real YouTube video id and `supporting_channel` a real YouTube channel id (AGENTS.md §F
// -- never identify a video/channel by a free-typed title/name when a canonical id format exists;
// an earlier version of this schema accepted any non-empty string here, which let a title be
// smuggled in as "the reference"). `signal` carries no reference at all -- a free-standing
// observation (e.g. "3 independent channels now show this pattern") with nothing single to cite.
const trendEvidenceContentSchema = z.discriminatedUnion("evidenceType", [
  z.object({ evidenceType: z.literal("signal"), description: trendEvidenceDescriptionSchema }).strict(),
  z
    .object({
      evidenceType: z.literal("supporting_channel"),
      referenceId: youtubeChannelIdSchema,
      description: trendEvidenceDescriptionSchema,
    })
    .strict(),
  z
    .object({
      evidenceType: z.literal("supporting_video"),
      referenceId: youtubeVideoIdSchema,
      description: trendEvidenceDescriptionSchema,
    })
    .strict(),
]);

export const marketTrendEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    trendCandidateId: z.string().min(1),
    evidenceType: trendEvidenceTypeSchema,
    referenceId: z.string().nullable(),
    description: z.string(),
    recordedAt: z.string(),
  })
  .strict();

// Owner spec §14: "do not allow lifecycle labels to exist without supporting observable rules or
// evidence" -- a trend candidate can never be created without its own first evidence item.
export const createTrendCandidateInputSchema = z
  .object({
    title: z.string().min(1, "title is required").max(500),
    description: z.string().max(2000).optional(),
    topicId: z.string().min(1).optional(),
    initialEvidence: trendEvidenceContentSchema,
  })
  .strict();

export const marketTrendCandidateSchema = z
  .object({
    trendCandidateId: z.string().min(1),
    title: z.string(),
    description: z.string().nullable(),
    topicId: z.string().nullable(),
    status: trendCandidateStatusSchema,
    firstObservedAt: z.string(),
    lastObservedAt: z.string(),
  })
  .strict();

export const createTrendCandidateOutputSchema = marketTrendCandidateSchema;
export const listTrendCandidatesOutputSchema = z.object({ trendCandidates: z.array(marketTrendCandidateSchema) }).strict();

// `reason` is required -- every status change is itself recorded as a `signal` evidence row in the
// same action (owner spec §14's own requirement, applied to lifecycle CHANGES too, not only to a
// candidate's initial creation).
export const updateTrendCandidateStatusInputSchema = z
  .object({
    trendCandidateId: z.string().min(1),
    status: trendCandidateStatusSchema,
    reason: z.string().min(1, "reason is required").max(2000),
  })
  .strict();

export const recordTrendEvidenceInputSchema = z.discriminatedUnion("evidenceType", [
  z.object({ trendCandidateId: z.string().min(1), evidenceType: z.literal("signal"), description: trendEvidenceDescriptionSchema }).strict(),
  z
    .object({
      trendCandidateId: z.string().min(1),
      evidenceType: z.literal("supporting_channel"),
      referenceId: youtubeChannelIdSchema,
      description: trendEvidenceDescriptionSchema,
    })
    .strict(),
  z
    .object({
      trendCandidateId: z.string().min(1),
      evidenceType: z.literal("supporting_video"),
      referenceId: youtubeVideoIdSchema,
      description: trendEvidenceDescriptionSchema,
    })
    .strict(),
]);

export const recordTrendEvidenceOutputSchema = marketTrendEvidenceSchema;
export const listTrendEvidenceInputSchema = z.object({ trendCandidateId: z.string().min(1) }).strict();
export const listTrendEvidenceOutputSchema = z.object({ evidence: z.array(marketTrendEvidenceSchema) }).strict();

// Phase 9 slice 9H, part A -- two UI-only wrappers closing owner spec §30's "Trends" gaps.
// `listTrendCandidatesWithFreshness` pairs each candidate with a NEW, trend-specific freshness
// label, kept OUT of `marketTrendCandidateSchema`/`listTrendCandidatesOutputSchema` itself since
// those are an existing MCP/CLI agent contract (`agent_list_market_records`) this part must not
// change (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md §6).
const trendFreshnessSchema = z.enum(["fresh", "needs_attention"]);

export const listTrendCandidatesWithFreshnessOutputSchema = z
  .object({
    trendCandidates: z.array(marketTrendCandidateSchema.extend({ freshness: trendFreshnessSchema }).strict()),
  })
  .strict();

// `getTrendEvidenceSummary` reuses `listTrendEvidenceInputSchema` (same one `trendCandidateId`
// field) -- newest-first evidence plus the independent-supporting-channel count, both computed
// server-side so they stay testable (this repo has no component-level tests, RISK-05).
export const getTrendEvidenceSummaryOutputSchema = z
  .object({
    evidence: z.array(marketTrendEvidenceSchema),
    independentChannelCount: z.number().int().nonnegative(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md) -- agent-created
// research requests with a human-only approval gate.
// ---------------------------------------------------------------------------

const marketResearchRequestStatusSchema = z.enum(["pending", "approved", "rejected", "executed", "execution_failed"]);

export const marketResearchRequestSchema = z
  .object({
    requestId: z.string().min(1),
    query: z.string(),
    rationale: z.string(),
    monitorDurationDays: z.number().nullable(),
    status: marketResearchRequestStatusSchema,
    createdVia: z.string(),
    agentApiVersion: z.string().nullable(),
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
    resolvedReason: z.string().nullable(),
    candidatesFound: z.number().nullable(),
    candidatesNew: z.number().nullable(),
    executionError: z.string().nullable(),
  })
  .strict();

// `monitorDurationDays` is metadata only (spec §29's own "Monitor for 30 days" example) -- stored
// and returned, never consulted by any code path that decides whether/when to run anything.
export const createMarketResearchRequestInputSchema = z
  .object({
    query: z.string().min(1, "query is required").max(500),
    rationale: z.string().min(1, "rationale is required").max(2000),
    monitorDurationDays: z.number().int().positive().max(3650).optional(),
  })
  .strict();

export const createMarketResearchRequestOutputSchema = marketResearchRequestSchema;
export const listMarketResearchRequestsOutputSchema = z.object({ requests: z.array(marketResearchRequestSchema) }).strict();
export const getMarketResearchRequestInputSchema = z.object({ requestId: z.string().min(1) }).strict();

export const approveMarketResearchRequestInputSchema = z
  .object({ requestId: z.string().min(1), credentialRef: credentialRefSchema })
  .strict();
export const approveMarketResearchRequestOutputSchema = marketResearchRequestSchema;

export const rejectMarketResearchRequestInputSchema = z
  .object({ requestId: z.string().min(1), reason: z.string().min(1, "reason is required").max(2000) })
  .strict();
export const rejectMarketResearchRequestOutputSchema = marketResearchRequestSchema;

// Re-exported so services.ts/adapters never need their own separate import of the shared
// provenance vocabulary's schema (AGENTS.md §M: market-intelligence is a caller of
// shared-provenance, not a second owner of it).
export { createdViaSchema };

export type AddToWatchlistInput = z.infer<typeof addToWatchlistInputSchema>;
export type GetWatchlistEntryInput = z.infer<typeof getWatchlistEntryInputSchema>;
export type RecordEvidenceInput = z.infer<typeof recordEvidenceInputSchema>;
export type ListEvidenceInput = z.infer<typeof listEvidenceInputSchema>;
export type RecordChannelSnapshotInput = z.infer<typeof recordChannelSnapshotInputSchema>;
export type ListChannelSnapshotsInput = z.infer<typeof listChannelSnapshotsInputSchema>;
export type RecordVideoSnapshotInput = z.infer<typeof recordVideoSnapshotInputSchema>;
export type ListVideoSnapshotsInput = z.infer<typeof listVideoSnapshotsInputSchema>;
export type CaptureChannelSnapshotInput = z.infer<typeof captureChannelSnapshotInputSchema>;
export type RunCollectionIfStaleInput = z.infer<typeof runCollectionIfStaleInputSchema>;
export type RunCollectionIfStaleOutput = z.infer<typeof runCollectionIfStaleOutputSchema>;
export type DiscoverChannelsInput = z.infer<typeof discoverChannelsInputSchema>;
export type UpdateDiscoveryCandidateStatusInput = z.infer<typeof updateDiscoveryCandidateStatusInputSchema>;
export type PromoteDiscoveryCandidateInput = z.infer<typeof promoteDiscoveryCandidateInputSchema>;
export type CreateTopicInput = z.infer<typeof createTopicInputSchema>;
export type AssignTopicInput = z.infer<typeof assignTopicInputSchema>;
export type ListTopicsForSubjectInput = z.infer<typeof listTopicsForSubjectInputSchema>;
export type CreateTrendCandidateInput = z.infer<typeof createTrendCandidateInputSchema>;
export type UpdateTrendCandidateStatusInput = z.infer<typeof updateTrendCandidateStatusInputSchema>;
export type RecordTrendEvidenceInput = z.infer<typeof recordTrendEvidenceInputSchema>;
export type CreateMarketResearchRequestInput = z.infer<typeof createMarketResearchRequestInputSchema>;
export type ApproveMarketResearchRequestInput = z.infer<typeof approveMarketResearchRequestInputSchema>;
export type RejectMarketResearchRequestInput = z.infer<typeof rejectMarketResearchRequestInputSchema>;
