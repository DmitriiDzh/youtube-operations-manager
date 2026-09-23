import { z } from "zod";
import { parseWithSchema } from "@/lib/changesets/schemas";

export { parseWithSchema };

// No input parameters for this slice's one capability -- `.strict()` so a future accidental
// extra field is rejected loudly rather than silently ignored, matching every other input
// schema in this codebase.
export const getSystemCapabilitiesInputSchema = z.object({}).strict();

const permissionClassSchema = z.enum(["READ", "DRAFT", "APPROVE", "EXECUTE"]);

const agentCapabilityDescriptorSchema = z
  .object({
    id: z.string().min(1),
    domain: z.enum([
      "system",
      "channel_context",
      "video_context",
      "analytics",
      "asset_catalog",
      "localization_draft",
      "content_proposal",
    ]),
    permission: permissionClassSchema,
    description: z.string().min(1),
  })
  .strict();

export const systemCapabilitiesOutputSchema = z
  .object({
    productVersion: z.string().min(1),
    agentApiVersion: z.string().min(1),
    capabilities: z.array(agentCapabilityDescriptorSchema),
    dataDomains: z.array(z.enum(["channel_metadata", "video_metadata", "channel_analytics", "video_analytics"])),
    actionClasses: z.array(permissionClassSchema),
    grantedPermissions: z.array(permissionClassSchema),
    plannedFutureCapabilities: z.array(z.enum(["query_market_intelligence", "query_competitors", "create_experiment_proposal"])),
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
