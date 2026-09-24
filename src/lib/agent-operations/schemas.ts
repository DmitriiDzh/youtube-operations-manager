import { z } from "zod";
import { parseWithSchema } from "@/lib/changesets/schemas";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";
import {
  AGENT_CAPABILITY_DOMAINS,
  AGENT_DATA_DOMAINS,
  PERMISSION_CLASSES,
  PLANNED_FUTURE_CAPABILITIES,
} from "./contracts";
import {
  getAssetContextInputSchema as assetCatalogGetAssetContextInputSchema,
  getAssetContextOutputSchema as assetCatalogGetAssetContextOutputSchema,
  listAssetsInputSchema as assetCatalogListAssetsInputSchema,
  listAssetsOutputSchema as assetCatalogListAssetsOutputSchema,
} from "@/lib/asset-catalog/schemas";
import {
  getGenerationProvenanceInputSchema as aiLocalizationGetGenerationProvenanceInputSchema,
  storedGenerationProvenanceSchema,
} from "@/lib/ai-localization/schemas";
import {
  createContentProposalInputSchema as contentProposalCreateContentProposalInputSchema,
  createContentProposalOutputSchema as contentProposalCreateContentProposalOutputSchema,
  getContentProposalInputSchema as contentProposalGetContentProposalInputSchema,
  getContentProposalOutputSchema as contentProposalGetContentProposalOutputSchema,
  listContentProposalsInputSchema as contentProposalListContentProposalsInputSchema,
  listContentProposalsOutputSchema as contentProposalListContentProposalsOutputSchema,
} from "@/lib/content-proposals/schemas";

export { parseWithSchema };

// No input parameters for this slice's one capability -- `.strict()` so a future accidental
// extra field is rejected loudly rather than silently ignored, matching every other input
// schema in this codebase.
export const getSystemCapabilitiesInputSchema = z.object({}).strict();

// Derived from `./contracts`'s own const arrays (RISK-53, `docs/TECHNICAL_DEBT.md`) -- never a
// second, independently-maintained copy of the same literals (AGENTS.md §D). A hardcoded copy
// here previously drifted out of sync with `AgentDataDomain` when Phase 7 slice G added
// `content_proposal_metadata`, breaking every real (non-fixture) capability-discovery call.
const permissionClassSchema = z.enum(PERMISSION_CLASSES);

const agentCapabilityDescriptorSchema = z
  .object({
    id: z.string().min(1),
    domain: z.enum(AGENT_CAPABILITY_DOMAINS),
    permission: permissionClassSchema,
    description: z.string().min(1),
  })
  .strict();

export const systemCapabilitiesOutputSchema = z
  .object({
    productVersion: z.string().min(1),
    agentApiVersion: z.string().min(1),
    capabilities: z.array(agentCapabilityDescriptorSchema),
    dataDomains: z.array(z.enum(AGENT_DATA_DOMAINS)),
    actionClasses: z.array(permissionClassSchema),
    grantedPermissions: z.array(permissionClassSchema),
    plannedFutureCapabilities: z.array(z.enum(PLANNED_FUTURE_CAPABILITIES)),
    schemaVersions: z.object({ app: z.number().int().positive() }).strict(),
  })
  .strict();

export type GetSystemCapabilitiesInput = z.infer<typeof getSystemCapabilitiesInputSchema>;
export type SystemCapabilitiesOutput = z.infer<typeof systemCapabilitiesOutputSchema>;

// ---------------------------------------------------------------------------
// Slice B -- channel/video context. Deliberately NO `credentialRef` field, mirroring
// `changeset_list`/`ai_localization_generate`'s own established convention in this codebase --
// always resolved from the active local auth context at the MCP/CLI layer, never a caller-
// supplied override. `channelId` is REQUIRED on both (a deliberate, documented deviation from the
// owner spec's literal `get_video_context(videoId, options)` signature -- this codebase's
// existing, established rule (docs/decisions/0004-active-channel-read-scoping.md) is that every
// channel-scoped read must be checked against the caller's own active channel, which requires
// knowing the channel up front, not discovering it from the video after the fact).
// ---------------------------------------------------------------------------

export const getChannelContextInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

const agentEditorialProfileContextSchema = z
  .object({
    version: z.number().int().positive(),
    targetAudience: z.string().nullable(),
    toneNotes: z.string().nullable(),
    terminologyNotes: z.string().nullable(),
    titleConstraints: z.string().nullable(),
    descriptionConstraints: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();

export const channelContextOutputSchema = z
  .object({
    channelId: z.string().min(1),
    title: z.string(),
    lastSyncedAt: z.string().nullable(),
    syncedVideoCount: z.number().int().nonnegative(),
    editorialProfile: agentEditorialProfileContextSchema.nullable(),
    trackedLanguages: z.array(z.string()),
  })
  .strict();

const videoContextSectionSchema = z.enum(["metadata", "localizations"]);
const ALL_VIDEO_CONTEXT_SECTIONS = ["metadata", "localizations"] as const;

export const getVideoContextInputSchema = z
  .object({
    channelId: z.string().min(1),
    videoId: z.string().min(1),
    // Omitted = both sections (owner spec §8/§23: "Allow the caller to request context sections
    // instead of always returning everything" -- but a caller that doesn't ask for anything
    // specific should still get a useful default, not an empty response).
    include: z.array(videoContextSectionSchema).min(1).optional(),
  })
  .strict();

const agentLocalizationEntrySchema = z
  .object({
    language: z.string().min(1),
    title: z.string(),
    description: z.string(),
  })
  .strict();

const videoMetadataContextSchema = z
  .object({
    videoId: z.string().min(1),
    channelId: z.string().min(1),
    title: z.string(),
    description: z.string(),
    publishedAt: z.string(),
    privacyStatus: z.string(),
    defaultLanguage: z.string().nullable(),
    defaultAudioLanguage: z.string().nullable(),
    lastSyncedAt: z.string(),
  })
  .strict();

export const videoContextOutputSchema = z
  .object({
    videoId: z.string().min(1),
    channelId: z.string().min(1),
    includedSections: z.array(videoContextSectionSchema),
    metadata: videoMetadataContextSchema.optional(),
    localizations: z.array(agentLocalizationEntrySchema).optional(),
  })
  .strict();

export { ALL_VIDEO_CONTEXT_SECTIONS };
export type GetChannelContextInput = z.infer<typeof getChannelContextInputSchema>;
export type ChannelContextOutput = z.infer<typeof channelContextOutputSchema>;
export type GetVideoContextInput = z.infer<typeof getVideoContextInputSchema>;
export type VideoContextOutput = z.infer<typeof videoContextOutputSchema>;

// ---------------------------------------------------------------------------
// Slice C -- analytics interface (owner spec §9). UNLIKE slice B above, these two require a
// REAL, already-resolved `credentialRef` -- deliberately mirroring `src/lib/analytics/schemas.ts`'s
// own established convention (not the changeset/ai-localization one), because these functions
// forward their input, unmodified, straight into `analyticsCore.getChannelOverview`/`listMetrics`,
// which require exactly this shape and do their own internal `assertActiveChannel` check keyed
// off it (`docs/decisions/0004-active-channel-read-scoping.md`). `credentialRef` is REQUIRED here,
// not optional -- the CALLER (MCP/CLI) resolves the caller's effective credentialRef BEFORE
// calling this service, exactly like the pre-existing
// `analytics_list`/`analytics_overview` MCP handlers already do for `analyticsCore` itself (parse
// the caller's own input with `credentialRef` relaxed to optional via `.partial({credentialRef:
// true})`, resolve it, then call this service with the resolved value merged in). Exact
// date-format validation is deliberately NOT duplicated here either -- `analyticsCore`'s own
// schemas are the single source of truth for that; this module only checks presence/shape loosely
// before forwarding, exactly as thin as a wrapper should be.
// ---------------------------------------------------------------------------

export const queryChannelAnalyticsInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    startDate: z.string().min(1),
    endDate: z.string().min(1),
  })
  .strict();

const metricDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    unit: z.enum(["count", "minutes", "seconds", "ratio", "rate_percent"]),
  })
  .strict();

const analyticsFreshnessSchema = z
  .object({
    source: z.enum(["live_youtube_analytics_api", "local_collected_data"]),
    asOf: z.string(),
    note: z.string().min(1),
  })
  .strict();

const channelAnalyticsTotalsSchema = z
  .object({
    views: z.number(),
    estimatedMinutesWatched: z.number(),
    subscribersGained: z.number(),
    subscribersLost: z.number(),
  })
  .strict();

export const channelAnalyticsContextOutputSchema = z
  .object({
    channelId: z.string().min(1),
    period: z
      .object({
        startDate: z.string(),
        endDate: z.string(),
        previousStartDate: z.string(),
        previousEndDate: z.string(),
      })
      .strict(),
    filters: z.object({}).strict(),
    metricDefinitions: z.array(metricDefinitionSchema),
    freshness: analyticsFreshnessSchema,
    daily: z.array(
      z
        .object({
          date: z.string(),
          views: z.number(),
          estimatedMinutesWatched: z.number(),
          subscribersGained: z.number(),
          subscribersLost: z.number(),
        })
        .strict()
    ),
    currentTotals: channelAnalyticsTotalsSchema,
    previousTotals: channelAnalyticsTotalsSchema,
  })
  .strict();

export const queryVideoAnalyticsInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    startDate: z.string().min(1).optional(),
    endDate: z.string().min(1).optional(),
    videoId: z.string().min(1).optional(),
    metricNames: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const videoAnalyticsContextOutputSchema = z
  .object({
    channelId: z.string().min(1),
    period: z.object({ startDate: z.string().nullable(), endDate: z.string().nullable() }).strict(),
    filters: z
      .object({ videoId: z.string().nullable(), metricNames: z.array(z.string()).nullable() })
      .strict(),
    metricDefinitions: z.array(metricDefinitionSchema),
    freshness: analyticsFreshnessSchema,
    rows: z.array(
      z
        .object({
          videoId: z.string(),
          metricDate: z.string(),
          metricName: z.string(),
          metricValue: z.number(),
        })
        .strict()
    ),
  })
  .strict();

export type QueryChannelAnalyticsInput = z.infer<typeof queryChannelAnalyticsInputSchema>;
export type ChannelAnalyticsContextOutput = z.infer<typeof channelAnalyticsContextOutputSchema>;
export type QueryVideoAnalyticsInput = z.infer<typeof queryVideoAnalyticsInputSchema>;
export type VideoAnalyticsContextOutput = z.infer<typeof videoAnalyticsContextOutputSchema>;

// ---------------------------------------------------------------------------
// Slice D -- creative asset catalog (owner spec §15/§25). Same convention as slice B above: no
// `credentialRef`, no channel-scoping check here -- the MCP/CLI layer calls
// `channelAccessCore.assertActiveChannel` before invoking either function.
//
// Reused unchanged from `@/lib/asset-catalog/schemas` (AGENTS.md §D) -- this wrapper does no
// shape transformation of its own (unlike slice C's analytics envelope), so re-exporting the
// underlying module's own schemas directly is correct here, not a second, independently
// maintained copy that could drift from them.
// ---------------------------------------------------------------------------

export const listAssetsInputSchema = assetCatalogListAssetsInputSchema;
export const listAssetsOutputSchema = assetCatalogListAssetsOutputSchema;
export const getAssetContextInputSchema = assetCatalogGetAssetContextInputSchema;
export const getAssetContextOutputSchema = assetCatalogGetAssetContextOutputSchema;

export type ListAssetsInput = z.infer<typeof listAssetsInputSchema>;
export type ListAssetsOutput = z.infer<typeof listAssetsOutputSchema>;
export type GetAssetContextInput = z.infer<typeof getAssetContextInputSchema>;
export type GetAssetContextOutput = z.infer<typeof getAssetContextOutputSchema>;

// ---------------------------------------------------------------------------
// Slice E -- agent draft/proposal provenance (owner spec §22). Same slice-B convention as above
// (no `credentialRef`; MCP/CLI calls `channelAccessCore.assertActiveChannel` first). Reused
// unchanged from `@/lib/ai-localization/schemas` (AGENTS.md §D) -- no shape transformation of its
// own, so re-exported directly rather than duplicated.
// ---------------------------------------------------------------------------

export const getGenerationProvenanceInputSchema = aiLocalizationGetGenerationProvenanceInputSchema;
export const getGenerationProvenanceOutputSchema = storedGenerationProvenanceSchema.nullable();

export type GetGenerationProvenanceInput = z.infer<typeof getGenerationProvenanceInputSchema>;
export type GetGenerationProvenanceOutput = z.infer<typeof getGenerationProvenanceOutputSchema>;

// ---------------------------------------------------------------------------
// Slice G -- Content Proposal / external artifact registration (owner spec §18/§19/§20). Same
// slice-B convention as above (no `credentialRef`; MCP/CLI calls
// `channelAccessCore.assertActiveChannel` first). Reused unchanged from
// `@/lib/content-proposals/schemas` (AGENTS.md §D) -- no shape transformation of its own, so
// re-exported directly rather than duplicated.
// ---------------------------------------------------------------------------

export const createContentProposalInputSchema = contentProposalCreateContentProposalInputSchema;
export const createContentProposalOutputSchema = contentProposalCreateContentProposalOutputSchema;
export const getContentProposalInputSchema = contentProposalGetContentProposalInputSchema;
export const getContentProposalOutputSchema = contentProposalGetContentProposalOutputSchema;
export const listContentProposalsInputSchema = contentProposalListContentProposalsInputSchema;
export const listContentProposalsOutputSchema = contentProposalListContentProposalsOutputSchema;

export type CreateContentProposalInput = z.infer<typeof createContentProposalInputSchema>;
export type CreateContentProposalOutput = z.infer<typeof createContentProposalOutputSchema>;
export type GetContentProposalInput = z.infer<typeof getContentProposalInputSchema>;
export type GetContentProposalOutput = z.infer<typeof getContentProposalOutputSchema>;
export type ListContentProposalsInput = z.infer<typeof listContentProposalsInputSchema>;
export type ListContentProposalsOutput = z.infer<typeof listContentProposalsOutputSchema>;
