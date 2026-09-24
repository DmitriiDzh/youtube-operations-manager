import {
  AGENT_API_VERSION,
  AGENT_DATA_DOMAINS,
  DomainError,
  GRANTED_PERMISSIONS,
  PERMISSION_CLASSES,
  PLANNED_FUTURE_CAPABILITIES,
  type AgentCapabilityDescriptor,
  type ChannelAnalyticsContext,
  type ChannelContext,
  type MetricDefinition,
  type SystemCapabilities,
  type VideoAnalyticsContext,
  type VideoContext,
  type VideoContextSection,
} from "./contracts";
import {
  ALL_VIDEO_CONTEXT_SECTIONS,
  channelAnalyticsContextOutputSchema,
  channelContextOutputSchema,
  createContentProposalInputSchema,
  createContentProposalOutputSchema,
  getAssetContextInputSchema,
  getAssetContextOutputSchema,
  getChannelContextInputSchema,
  getContentProposalInputSchema,
  getContentProposalOutputSchema,
  getGenerationProvenanceInputSchema,
  getGenerationProvenanceOutputSchema,
  getSystemCapabilitiesInputSchema,
  getVideoContextInputSchema,
  listAssetsInputSchema,
  listAssetsOutputSchema,
  listContentProposalsInputSchema,
  listContentProposalsOutputSchema,
  parseWithSchema,
  queryChannelAnalyticsInputSchema,
  queryVideoAnalyticsInputSchema,
  systemCapabilitiesOutputSchema,
  videoAnalyticsContextOutputSchema,
  videoContextOutputSchema,
} from "./schemas";
import { ANALYTICS_METRIC_NAMES, CHANNEL_OVERVIEW_METRIC_NAMES } from "@/lib/analytics";
import type { CreativeAsset } from "@/lib/asset-catalog";
import type { StoredGenerationProvenance } from "@/lib/ai-localization/contracts";
import type { ContentProposal } from "@/lib/content-proposals";
import type { CreatedVia } from "@/lib/shared-provenance";

/**
 * One entry per capability actually implemented and reachable today -- either a new function this
 * module itself implements, or an already-existing, already-shipped tool from another module
 * (e.g. the `localization_draft.*`/`channel_context.list_channels`/etc. entries below, which
 * describe pre-existing `ai_localization_*`/`channel_*` tools, not new functions). A capability's
 * `domain` label groups it by subject matter for a caller scanning what's available; it does not
 * imply which slice of this phase "owns" or introduced the underlying tool.
 *
 * This is the literal, human-maintained inventory `get_capabilities` reports -- not derived from
 * `src/mcp/server.ts`'s tool registry, since not every capability necessarily has (or needs) an
 * MCP tool vs. an HTTP-only route.
 */
const AGENT_CAPABILITIES: AgentCapabilityDescriptor[] = [
  {
    id: "system.get_capabilities",
    domain: "system",
    permission: "READ",
    description:
      "Report this instance's product/agent-API version, implemented capabilities, data domains, the permission model, and current local schema version.",
  },
  {
    id: "channel_context.get_channel_context",
    domain: "channel_context",
    permission: "READ",
    description:
      "Read-only channel context: title, sync status, synced video count, editorial profile, and tracked languages. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "video_context.get_video_context",
    domain: "video_context",
    permission: "READ",
    description:
      "Task-oriented, section-selectable video context (metadata and/or existing localizations). Requires channelId to be the caller's currently-active channel.",
  },
  // Owner spec §28 ("Map tools to actual existing capabilities. Prefer fewer coherent tools over
  // dozens of thin wrappers"): these four are NOT new functions -- they are the already-
  // implemented, already-MCP/CLI-exposed `channel_list`/`channel_video_list`/
  // `ai_localization_generate`/`ai_localization_create_change_set` tools (`src/mcp/server.ts`),
  // registered here so `get_capabilities` actually reports what an agent can reach through this
  // application, not just what this module itself implements.
  {
    id: "channel_context.list_channels",
    domain: "channel_context",
    permission: "READ",
    description:
      "List every locally synchronized channel this identity has access to. Implemented as the pre-existing `channel_list` MCP tool/`channel list` CLI command (`src/lib/channel-sync/`), not a new function -- registered here for capability-discovery completeness.",
  },
  {
    id: "video_context.list_videos",
    domain: "video_context",
    permission: "READ",
    description:
      "List synchronized videos for a channel, with existing localization languages. Implemented as the pre-existing `channel_video_list` MCP tool/`channel video-list` CLI command (`src/lib/channel-sync/`), not a new function -- registered here for capability-discovery completeness.",
  },
  {
    id: "localization_draft.create_localization_proposals",
    domain: "localization_draft",
    permission: "DRAFT",
    description:
      "Generate candidate title/description proposals for one or more (video, target language) pairs. Persists nothing. Implemented as the pre-existing `ai_localization_generate` MCP tool/`ai-localization generate` CLI command (`src/lib/ai-localization/`), not a new function -- registered here for capability-discovery completeness.",
  },
  {
    id: "localization_draft.create_change_set_from_agent_proposals",
    domain: "localization_draft",
    permission: "DRAFT",
    description:
      "Persist a reviewed set of localization proposals as a new Change Set, every Change starting `approvalStatus: \"pending\"` -- no code path anywhere can mark an agent-authored proposal already-approved (AGENTS.md §G). Optionally accepts `evidence` (external research/comparable-video citations, owner spec §13) and `rationale` (owner spec §12), recorded once per Change Set (not per proposal) on its provenance record -- never independently verified by this server. Implemented as the pre-existing `ai_localization_create_change_set` MCP tool/`ai-localization create-change-set` CLI command (`src/lib/ai-localization/`), not a new function -- registered here for capability-discovery completeness.",
  },
  {
    id: "localization_draft.get_generation_provenance",
    domain: "localization_draft",
    permission: "READ",
    description:
      "Read back the provenance recorded for a localization Change Set at creation time (editorial-profile version, effective context, evidence, rationale, changeSetId/channelId, creation time). Every ai_localization Change Set now gets a provenance row unconditionally; `null` therefore means the Change Set itself never went through this path (an XLSX-import or deletion-source Change Set), or the changeSetId is nonexistent, or it belongs to another channel (none of these are distinguishable from each other). `profileVersion`/`effectiveContext`/`evidence`/`rationale` were supplied by the CALLER when creating the Change Set (not independently attested by this server) -- do not treat them as server-verified fact; each is `null` on the row itself when the caller supplied nothing. `createdVia`/`agentApiVersion` (owner spec §22) ARE server-stamped, never caller-supplied: `\"mcp\"` with the real agent API version for a Change Set created through this MCP surface, `\"cli\"`/null for the CLI, `\"web_ui\"`/null for the Web UI's own \"Generate with AI\", and null/null only for a row created before this field existed. Requires channelId to be the caller's currently-active channel and changeSetId to actually belong to it.",
  },
  {
    id: "analytics.query_channel_analytics",
    domain: "analytics",
    permission: "READ",
    description:
      "Agent-oriented channel-level analytics for a date range (views, watch time, subscriber deltas), with explicit metric definitions and data freshness. Wraps the existing `analytics_overview` capability (`src/lib/analytics/`) -- a LIVE YouTube Analytics API read that counts against that API's quota, unlike most other capabilities in this interface. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "analytics.query_video_analytics",
    domain: "analytics",
    permission: "READ",
    description:
      "Agent-oriented per-video daily analytics rows already collected locally, with explicit metric definitions and data freshness. Wraps the existing `analytics_list` capability (`src/lib/analytics/`) -- a local read only, never a live YouTube call. Requires channelId to be the caller's currently-active channel.",
  },
  // The remaining four analytics_* tools have no agent-operations-specific wrapper (their own
  // existing response shape already suffices for an agent caller) -- registered directly, not
  // wrapped, for the same capability-discovery-completeness reason as list_channels/list_videos
  // above.
  {
    id: "analytics.query_data_quality",
    domain: "analytics",
    permission: "READ",
    description:
      "Which dates in a range were actually covered by a collection run vs. never collected vs. too recent, plus which videos had a recorded collection failure. Implemented as the pre-existing `analytics_data_quality` MCP tool/`analytics data-quality` CLI command (`src/lib/analytics/`), not a new function. Local read only. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "analytics.query_comparable_age_performance",
    domain: "analytics",
    permission: "READ",
    description:
      "Compare 2-10 videos' already-collected metrics aligned by days-since-publish rather than calendar date. Implemented as the pre-existing `analytics_comparable_age` MCP tool/`analytics comparable-age` CLI command (`src/lib/analytics/`), not a new function. Local read only. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "analytics.query_weekly_reports",
    domain: "analytics",
    permission: "READ",
    description:
      "List or fetch frozen, reproducible weekly (Mon-Sun) channel performance snapshots. Implemented as the pre-existing `analytics_weekly_reports_list`/`analytics_weekly_report_get` MCP tools/`analytics weekly-reports`/`weekly-report-get` CLI commands (`src/lib/analytics/`), not a new function. Local read only; no on-demand generation via this interface. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "asset_catalog.list_assets",
    domain: "asset_catalog",
    permission: "READ",
    description:
      "List catalogued creative assets (thumbnails, source images, scripts, prompts, etc.) for a channel, optionally narrowed by linked videoId or assetType. Read-only over the local asset catalog -- never resolves referenceValue to an actual file. Requires channelId to be the caller's currently-active channel. Populated only by the operator-facing `asset register` CLI command, not by any agent capability in this slice.",
  },
  {
    id: "asset_catalog.get_asset_context",
    domain: "asset_catalog",
    permission: "READ",
    description:
      "Fetch one catalogued asset's full metadata record by assetId. Requires channelId to be the caller's currently-active channel and assetId to actually belong to it.",
  },
  {
    id: "content_proposal.create_content_proposal",
    domain: "content_proposal",
    permission: "DRAFT",
    description:
      "Create a structured Content Proposal (owner spec §18) -- objective, topic/concept, rationale, evidence, a bounded free-form `brief` (title/thumbnail/visual/audio direction, duration, publication hypothesis, localization strategy, experiment design, expected metrics, required production outputs), and references to already-synced videos/catalogued assets. Write-once: there is no update or approval workflow for this domain (a proposal is a DRAFT object, full stop -- inventing an approval state machine the owner spec never asked for would be scope creep). `referenceVideoIds`/`referenceAssetIds` are each validated to actually belong to the requesting channel. `createdVia`/`agentApiVersion` (owner spec §22) are SERVER-STAMPED, never caller-supplied. The application does not generate any of the proposed content itself -- Codex or external tools may produce it; a separate, not-yet-implemented capability will let externally-produced artifacts be registered back against a proposal (owner spec §19).",
  },
  {
    id: "content_proposal.get_content_proposal",
    domain: "content_proposal",
    permission: "READ",
    description:
      "Fetch one Content Proposal's full record by proposalId. Requires channelId to be the caller's currently-active channel and proposalId to actually belong to it -- otherwise fails with CONTENT_PROPOSAL_NOT_AVAILABLE, the same error for 'does not exist' and 'belongs to another channel'.",
  },
  {
    id: "content_proposal.list_content_proposals",
    domain: "content_proposal",
    permission: "READ",
    description:
      "List Content Proposals for a channel, newest first. Read-only over the local proposal record -- never resolves referenced videos/assets itself. Requires channelId to be the caller's currently-active channel.",
  },
];


/**
 * Owner spec §9: "The exact metrics must follow the ACTUAL data currently collected. Do not
 * invent unavailable metrics... Every result must include metric definitions." Covers exactly the
 * metric-name literals `src/lib/analytics/contracts.ts` already defines (`ANALYTICS_METRIC_NAMES`/
 * `CHANNEL_OVERVIEW_METRIC_NAMES`) -- never a name invented here. Descriptions are standard
 * YouTube Analytics API metric semantics (the same "captured, not independently re-verified"
 * discipline `ANALYTICS_METRIC_NAMES`'s own doc comment already applies to the metric names
 * themselves), not a claim about this specific channel's data.
 */
const METRIC_DEFINITIONS: Record<string, Omit<MetricDefinition, "name">> = {
  views: { description: "Number of times the video was viewed.", unit: "count" },
  redViews: { description: "Views by YouTube Premium (formerly \"Red\") members.", unit: "count" },
  engagedViews: { description: "Views YouTube counts as meaningfully engaged with, not just started.", unit: "count" },
  comments: { description: "Number of comments posted on the video.", unit: "count" },
  likes: { description: "Number of likes on the video.", unit: "count" },
  dislikes: { description: "Number of dislikes on the video.", unit: "count" },
  videosAddedToPlaylists: { description: "Number of times this video was added to any playlist.", unit: "count" },
  videosRemovedFromPlaylists: { description: "Number of times this video was removed from any playlist.", unit: "count" },
  shares: { description: "Number of times the video was shared.", unit: "count" },
  estimatedMinutesWatched: { description: "Estimated total watch time.", unit: "minutes" },
  estimatedRedMinutesWatched: { description: "Estimated watch time by YouTube Premium members.", unit: "minutes" },
  averageViewDuration: { description: "Average watch time per view.", unit: "seconds" },
  averageViewPercentage: { description: "Average percentage of the video's duration watched per view.", unit: "rate_percent" },
  subscribersGained: { description: "Number of subscribers gained, attributed to this video/channel.", unit: "count" },
  subscribersLost: { description: "Number of subscribers lost, attributed to this video/channel.", unit: "count" },
  annotationClickThroughRate: { description: "Click-through rate on annotations (legacy feature).", unit: "ratio" },
  annotationCloseRate: { description: "Close rate on annotations (legacy feature).", unit: "ratio" },
  annotationImpressions: { description: "Number of annotation impressions (legacy feature).", unit: "count" },
  annotationClickableImpressions: { description: "Number of clickable annotation impressions (legacy feature).", unit: "count" },
  annotationClosableImpressions: { description: "Number of closable annotation impressions (legacy feature).", unit: "count" },
  annotationClicks: { description: "Number of annotation clicks (legacy feature).", unit: "count" },
  annotationCloses: { description: "Number of annotation closes (legacy feature).", unit: "count" },
  cardClickRate: { description: "Click-through rate on cards.", unit: "ratio" },
  cardTeaserClickRate: { description: "Click-through rate on card teasers.", unit: "ratio" },
  cardImpressions: { description: "Number of card impressions.", unit: "count" },
  cardTeaserImpressions: { description: "Number of card teaser impressions.", unit: "count" },
  cardClicks: { description: "Number of card clicks.", unit: "count" },
  cardTeaserClicks: { description: "Number of card teaser clicks.", unit: "count" },
};

function getMetricDefinitions(names: readonly string[]): MetricDefinition[] {
  return names.map((name) => {
    const known = METRIC_DEFINITIONS[name];
    // A metric name the caller/analytics layer used but this lookup doesn't recognize is
    // reported honestly, never silently dropped or given a fabricated description (owner spec
    // §9: "Do not invent unavailable metrics" cuts both ways -- also don't invent a definition).
    return known
      ? { name, ...known }
      : { name, description: "No definition recorded for this metric name.", unit: "count" as const };
  });
}

type StoredChannelForContext = {
  channelId: string;
  title: string;
  lastSyncedAt: Date | null;
};

type StoredVideoForContext = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  existingLocalizations: Record<string, { title: string; description: string }>;
  lastSyncedAt: Date;
};

type StoredEditorialProfileForContext = {
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: string;
};

type ServiceDependencies = {
  getProductVersion(): string;
  getSchemaVersion(): number;
  // Slice B -- reused unchanged from `changesets`' own channel/video store adapter
  // (`createChangeSetChannelStoreAdapter`), the same local-sync mirror `ai-localization` already
  // reads (AGENTS.md §D: no parallel read path).
  channelStore: {
    getChannel(channelId: string): Promise<StoredChannelForContext | null>;
    listVideosByChannel(channelId: string): Promise<StoredVideoForContext[]>;
  };
  // Delegates to `ai-localization`'s own `getEditorialProfile` service function unchanged --
  // never a second read of `channel_editorial_profiles`.
  getEditorialProfile(channelId: string): Promise<StoredEditorialProfileForContext | null>;
  // Delegates to `src/lib/db.ts`'s `getChannelTargetLanguages` (the same function
  // `src/lib/localization/` itself reads) -- never a second parser of `target_languages_json`.
  getTrackedLanguages(channelId: string): Promise<string[]>;
  // Slice C -- delegates to `analyticsCore`'s own `getChannelOverview`/`listMetrics` unchanged
  // (AGENTS.md §D: no parallel analytics read path, no new YouTube call of this module's own).
  // Both take `input: unknown` and do their OWN internal validation/credential-resolution/
  // active-channel check, exactly as `src/lib/analytics/services.ts` already implements it --
  // this module forwards its own (already-schema-validated) input straight through, unmodified.
  getChannelOverview(input: unknown): Promise<{
    channelId: string;
    startDate: string;
    endDate: string;
    previousStartDate: string;
    previousEndDate: string;
    daily: Array<{ date: string; views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number }>;
    currentTotals: { views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number };
    previousTotals: { views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number };
  }>;
  listMetrics(input: unknown): Promise<{
    channelId: string;
    rows: Array<{ videoId: string; metricDate: string; metricName: string; metricValue: number }>;
  }>;
  /** Injected for deterministic tests, same convention `analyticsCore`'s own `clock` dependency
   * uses -- the only source of "now" this module's own freshness envelope ever reads. */
  now(): Date;
  // Slice D -- delegates to `assetCatalogCore`'s own `listAssets`/`getAssetContext` unchanged
  // (AGENTS.md §D). Neither does credential/channel checking of its own -- mirrors slice B's
  // convention (see `assetCatalogListAssets`/`assetCatalogGetAssetContext` below).
  assetCatalogListAssets(input: unknown): Promise<{ assets: CreativeAsset[] }>;
  assetCatalogGetAssetContext(input: unknown): Promise<CreativeAsset>;
  // Slice E -- delegates to `aiLocalizationCore`'s own already-existing `getGenerationProvenance`
  // unchanged (AGENTS.md §D). No credential/channel checking of its own -- mirrors slice B's
  // convention, same as the asset-catalog delegates above.
  aiLocalizationGetGenerationProvenance(input: unknown): Promise<StoredGenerationProvenance | null>;
  // Slice G -- delegates to `contentProposalCore`'s own `createContentProposal`/
  // `getContentProposal`/`listContentProposals` unchanged (AGENTS.md §D). No credential/channel
  // checking of its own -- mirrors slice B's convention, same as every delegate above.
  contentProposalCreateContentProposal(
    input: unknown,
    callOrigin: { createdVia: CreatedVia; agentApiVersion?: string | null }
  ): Promise<ContentProposal>;
  contentProposalGetContentProposal(input: unknown): Promise<ContentProposal>;
  contentProposalListContentProposals(input: unknown): Promise<{ proposals: ContentProposal[] }>;
};

export function createAgentOperationsServices(deps: ServiceDependencies) {
  return {
    /**
     * Owner spec §4's `get_system_capabilities()`. Pure with respect to this module's own state
     * (no I/O beyond the two injected lookups) -- always reflects exactly what is implemented in
     * THIS running instance, never a static aspirational list (owner spec §25: "Do not implement
     * empty fake tools merely to fill this list").
     */
    async getSystemCapabilities(input: unknown): Promise<SystemCapabilities> {
      parseWithSchema(getSystemCapabilitiesInputSchema, input, "get system capabilities input");

      const output: SystemCapabilities = {
        productVersion: deps.getProductVersion(),
        agentApiVersion: AGENT_API_VERSION,
        capabilities: AGENT_CAPABILITIES,
        dataDomains: [...AGENT_DATA_DOMAINS],
        actionClasses: PERMISSION_CLASSES,
        grantedPermissions: GRANTED_PERMISSIONS,
        plannedFutureCapabilities: PLANNED_FUTURE_CAPABILITIES,
        schemaVersions: {
          app: deps.getSchemaVersion(),
        },
      };

      return parseWithSchema(systemCapabilitiesOutputSchema, output, "get system capabilities output");
    },

    /**
     * Slice B, owner spec §7. Channel-scoping (verifying `channelId` is the caller's active
     * channel) is deliberately NOT done here -- this module's schemas carry no `credentialRef`,
     * mirroring `ai-localization`'s own convention, so the MCP/CLI callers do that check
     * themselves before ever calling this function (see `src/mcp/server.ts`'s
     * `agentGetChannelContext` handler for the actual `assertActiveChannel` call).
     */
    async getChannelContext(input: unknown): Promise<ChannelContext> {
      const parsedInput = parseWithSchema(getChannelContextInputSchema, input, "get channel context input");

      const channel = await deps.channelStore.getChannel(parsedInput.channelId);
      if (!channel) {
        throw new DomainError({
          code: "DATA_NOT_SYNCED",
          message: "Channel has not been synchronized yet",
          details: { channelId: parsedInput.channelId },
        });
      }

      const [videos, profile, trackedLanguages] = await Promise.all([
        deps.channelStore.listVideosByChannel(channel.channelId),
        deps.getEditorialProfile(channel.channelId),
        deps.getTrackedLanguages(channel.channelId),
      ]);

      const output: ChannelContext = {
        channelId: channel.channelId,
        title: channel.title,
        lastSyncedAt: channel.lastSyncedAt ? channel.lastSyncedAt.toISOString() : null,
        syncedVideoCount: videos.length,
        editorialProfile: profile,
        trackedLanguages,
      };

      return parseWithSchema(channelContextOutputSchema, output, "get channel context output");
    },

    /**
     * Slice B, owner spec §8. Same channel-scoping note as `getChannelContext` above -- enforced
     * by the caller (MCP/CLI), not here. `include` selects which sections are computed and
     * returned (owner spec §23: "Optimize for repeatable agent workflows and token efficiency");
     * omitted = every section this slice supports (`ALL_VIDEO_CONTEXT_SECTIONS`).
     */
    async getVideoContext(input: unknown): Promise<VideoContext> {
      const parsedInput = parseWithSchema(getVideoContextInputSchema, input, "get video context input");
      const sections: VideoContextSection[] = parsedInput.include ?? [...ALL_VIDEO_CONTEXT_SECTIONS];

      const videos = await deps.channelStore.listVideosByChannel(parsedInput.channelId);
      const video = videos.find((v) => v.videoId === parsedInput.videoId);
      if (!video) {
        throw new DomainError({
          code: "DATA_NOT_SYNCED",
          message: "video_id does not belong to this channel's synchronized data (wrong channel, or not synced)",
          details: { channelId: parsedInput.channelId, videoId: parsedInput.videoId },
        });
      }

      const output: VideoContext = {
        videoId: video.videoId,
        channelId: video.channelId,
        includedSections: sections,
      };

      if (sections.includes("metadata")) {
        output.metadata = {
          videoId: video.videoId,
          channelId: video.channelId,
          title: video.title,
          description: video.description,
          publishedAt: video.publishedAt,
          privacyStatus: video.privacyStatus,
          defaultLanguage: video.defaultLanguage,
          defaultAudioLanguage: video.defaultAudioLanguage,
          lastSyncedAt: video.lastSyncedAt.toISOString(),
        };
      }

      if (sections.includes("localizations")) {
        output.localizations = Object.entries(video.existingLocalizations).map(([language, value]) => ({
          language,
          title: value.title,
          description: value.description,
        }));
      }

      return parseWithSchema(videoContextOutputSchema, output, "get video context output");
    },

    /**
     * Slice C, owner spec §9. Thin wrapper over `analyticsCore.getChannelOverview` -- forwards
     * its own already-validated input unchanged (`credentialRef` REQUIRED here, not optional --
     * see `queryChannelAnalyticsInputSchema`'s own doc comment for why), so `analyticsCore`'s own
     * active-channel/credential/date-range validation is the single, authoritative check (no
     * second, redundant check here). A LIVE YouTube Analytics API read (counts against that API's
     * quota) -- see the `analytics.query_channel_analytics` capability description for this
     * caveat surfaced to the agent up front.
     */
    async queryChannelAnalytics(input: unknown): Promise<ChannelAnalyticsContext> {
      const parsedInput = parseWithSchema(queryChannelAnalyticsInputSchema, input, "query channel analytics input");

      const overview = await deps.getChannelOverview(parsedInput);

      const output: ChannelAnalyticsContext = {
        channelId: overview.channelId,
        period: {
          startDate: overview.startDate,
          endDate: overview.endDate,
          previousStartDate: overview.previousStartDate,
          previousEndDate: overview.previousEndDate,
        },
        filters: {},
        metricDefinitions: getMetricDefinitions(CHANNEL_OVERVIEW_METRIC_NAMES),
        freshness: {
          source: "live_youtube_analytics_api",
          asOf: deps.now().toISOString(),
          note:
            "Fetched live from the YouTube Analytics API for this call -- YouTube itself typically reports this data with a 1-2 day lag behind real time (see docs/ARCHITECTURE.md §14.8), so recent days may still be incomplete or absent. Call the existing analytics_data_quality tool for coverage of the equivalent local video-level data.",
        },
        daily: overview.daily,
        currentTotals: overview.currentTotals,
        previousTotals: overview.previousTotals,
      };

      return parseWithSchema(channelAnalyticsContextOutputSchema, output, "query channel analytics output");
    },

    /**
     * Slice C, owner spec §9. Thin wrapper over `analyticsCore.listMetrics` -- same forwarding
     * discipline as `queryChannelAnalytics` above. A local read only (never a live YouTube call);
     * `freshness.note` deliberately points at the existing `analytics_data_quality` capability for
     * exact per-date coverage rather than recomputing that same report inline on every call.
     */
    async queryVideoAnalytics(input: unknown): Promise<VideoAnalyticsContext> {
      const parsedInput = parseWithSchema(queryVideoAnalyticsInputSchema, input, "query video analytics input");

      const result = await deps.listMetrics(parsedInput);

      const output: VideoAnalyticsContext = {
        channelId: result.channelId,
        period: { startDate: parsedInput.startDate ?? null, endDate: parsedInput.endDate ?? null },
        filters: { videoId: parsedInput.videoId ?? null, metricNames: parsedInput.metricNames ?? null },
        metricDefinitions: getMetricDefinitions(parsedInput.metricNames ?? ANALYTICS_METRIC_NAMES),
        freshness: {
          source: "local_collected_data",
          asOf: deps.now().toISOString(),
          note:
            "Reflects whatever was last collected locally (via 'Collect now' or daily auto-collection), not a live read. Call the existing analytics_data_quality tool for exact per-date coverage of this range.",
        },
        rows: result.rows,
      };

      return parseWithSchema(videoAnalyticsContextOutputSchema, output, "query video analytics output");
    },

    /**
     * Slice D, owner spec §25's `list_assets`. Channel-scoping is deliberately NOT done here --
     * mirrors slice B's convention (`getChannelContext`/`getVideoContext`): the MCP/CLI caller
     * checks `channelAccessCore.assertActiveChannel` before calling this.
     */
    async listAssets(input: unknown): Promise<{ assets: CreativeAsset[] }> {
      const parsedInput = parseWithSchema(listAssetsInputSchema, input, "list assets input");
      const result = await deps.assetCatalogListAssets(parsedInput);
      return parseWithSchema(listAssetsOutputSchema, result, "list assets output");
    },

    /** Slice D, owner spec §25's `get_asset_context`. Same channel-scoping note as `listAssets`
     * above. */
    async getAssetContext(input: unknown): Promise<CreativeAsset> {
      const parsedInput = parseWithSchema(getAssetContextInputSchema, input, "get asset context input");
      const result = await deps.assetCatalogGetAssetContext(parsedInput);
      return parseWithSchema(getAssetContextOutputSchema, result, "get asset context output");
    },

    /**
     * Slice E, owner spec §22. Same channel-scoping note as `getAssetContext` above. Returns
     * `null` for a Change Set that has no recorded provenance (XLSX import, or one created before
     * this feature existed) -- never an error, and the same `null` for "doesn't exist" and
     * "belongs to another channel" (never distinguishable -- `aiLocalizationCore`'s own existing
     * behavior, unchanged here). The returned `profileVersion`/`effectiveContext` were supplied
     * by whichever caller created the Change Set, not independently attested by this server --
     * see this capability's own description in `AGENT_CAPABILITIES` above.
     */
    async getGenerationProvenance(input: unknown): Promise<StoredGenerationProvenance | null> {
      const parsedInput = parseWithSchema(getGenerationProvenanceInputSchema, input, "get generation provenance input");
      const result = await deps.aiLocalizationGetGenerationProvenance(parsedInput);
      return parseWithSchema(getGenerationProvenanceOutputSchema, result, "get generation provenance output");
    },

    /** Slice G, owner spec §18. See this capability's own description in `AGENT_CAPABILITIES`
     * above for what is and isn't validated/recorded. */
    async createContentProposal(
      input: unknown,
      callOrigin: { createdVia: CreatedVia; agentApiVersion?: string | null }
    ): Promise<ContentProposal> {
      const parsedInput = parseWithSchema(createContentProposalInputSchema, input, "create content proposal input");
      const result = await deps.contentProposalCreateContentProposal(parsedInput, callOrigin);
      return parseWithSchema(createContentProposalOutputSchema, result, "create content proposal output");
    },

    /** Slice G. Same channel-scoping note as `getAssetContext` above. */
    async getContentProposal(input: unknown): Promise<ContentProposal> {
      const parsedInput = parseWithSchema(getContentProposalInputSchema, input, "get content proposal input");
      const result = await deps.contentProposalGetContentProposal(parsedInput);
      return parseWithSchema(getContentProposalOutputSchema, result, "get content proposal output");
    },

    /** Slice G. Same channel-scoping note as `listAssets` above. */
    async listContentProposals(input: unknown): Promise<{ proposals: ContentProposal[] }> {
      const parsedInput = parseWithSchema(listContentProposalsInputSchema, input, "list content proposals input");
      const result = await deps.contentProposalListContentProposals(parsedInput);
      return parseWithSchema(listContentProposalsOutputSchema, result, "list content proposals output");
    },
  };
}

export type AgentOperationsServices = ReturnType<typeof createAgentOperationsServices>;
