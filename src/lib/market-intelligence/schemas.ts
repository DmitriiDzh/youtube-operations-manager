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

// Phase 9 slice 4 (docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md) -- the combined "channel + its
// full evidence history" shape MCP's query_market_intelligence and CLI's `agent
// market-intelligence` both return, via getWatchlistEntryContext's single implementation.
export const getWatchlistEntryContextOutputSchema = z
  .object({
    channel: researchChannelSchema,
    evidence: z.array(researchEvidenceSchema),
  })
  .strict();

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
