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
  listProposalArtifactsInputSchema,
  listProposalArtifactsOutputSchema,
  operationsWorkspaceGetFileInputSchema,
  operationsWorkspaceGetFileOutputSchema,
  operationsWorkspaceListFilesInputSchema,
  operationsWorkspaceListFilesOutputSchema,
  findComparableVideosContextOutputSchema,
  findComparableVideosInputSchema,
  listAssetPerformanceContextOutputSchema,
  listAssetPerformanceInputSchema,
  parseWithSchema,
  queryChannelAnalyticsInputSchema,
  queryVideoAnalyticsInputSchema,
  registerExternalArtifactInputSchema,
  registerExternalArtifactOutputSchema,
  systemCapabilitiesOutputSchema,
  videoAnalyticsContextOutputSchema,
  videoContextOutputSchema,
} from "./schemas";
import { toWideMetricRows } from "./wide-rows";
import { ANALYTICS_METRIC_NAMES, CHANNEL_OVERVIEW_METRIC_NAMES } from "@/lib/analytics";
import type { CreativeAsset } from "@/lib/asset-catalog";
import type { StoredGenerationProvenance } from "@/lib/ai-localization/contracts";
import type { ContentProposal, ProposalArtifactLink } from "@/lib/content-proposals";
import type { CreatedVia } from "@/lib/shared-provenance";
import { bucketDailyRows, describePreviousPeriod } from "@/lib/analytics/granularity";
import type { OperationsWorkspaceFileResult, OperationsWorkspaceListResult } from "@/lib/operations-instructions";
import type { FindComparableVideosResult } from "@/lib/comparable-content";
import type { ListAssetPerformanceResult } from "@/lib/asset-performance";
import type { FindComparableVideosContext, ListAssetPerformanceContext } from "./schemas";

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
    mcpTools: ["agent_get_capabilities"],
    domain: "system",
    permission: "READ",
    description:
      "Report this instance's product/agent-API version, implemented capabilities, data domains, the permission model, and current local schema version.",
  },
  {
    id: "channel_context.get_channel_context",
    mcpTools: ["agent_get_channel_context"],
    domain: "channel_context",
    permission: "READ",
    description:
      "Read-only channel context: title, sync status, synced video count, editorial profile, and tracked languages. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "video_context.get_video_context",
    mcpTools: ["agent_get_video_context"],
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
    mcpTools: ["agent_get_generation_provenance"],
    domain: "localization_draft",
    permission: "READ",
    description:
      "Read back the provenance recorded for a localization Change Set at creation time (editorial-profile version, effective context, evidence, rationale, changeSetId/channelId, creation time). Every ai_localization Change Set now gets a provenance row unconditionally; `null` therefore means the Change Set itself never went through this path (an XLSX-import or deletion-source Change Set), or the changeSetId is nonexistent, or it belongs to another channel (none of these are distinguishable from each other). `profileVersion`/`effectiveContext`/`evidence`/`rationale` were supplied by the CALLER when creating the Change Set (not independently attested by this server) -- do not treat them as server-verified fact; each is `null` on the row itself when the caller supplied nothing. `createdVia`/`agentApiVersion` (owner spec §22) ARE server-stamped, never caller-supplied: `\"mcp\"` with the real agent API version for a Change Set created through this MCP surface, `\"cli\"`/null for the CLI, `\"web_ui\"`/null for the Web UI's own \"Generate with AI\", and null/null only for a row created before this field existed. Requires channelId to be the caller's currently-active channel and changeSetId to actually belong to it.",
  },
  {
    id: "analytics.query_channel_analytics",
    mcpTools: ["agent_query_channel_analytics", "analytics_overview"],
    domain: "analytics",
    permission: "READ",
    description:
      "Agent-oriented channel-level analytics for a date range (views, watch time, subscriber deltas), with explicit metric definitions and data freshness. Answers from the channel totals this app collects and stores locally when they cover the range (no live call, no quota; `freshness.source` says which), and falls back to a live YouTube Analytics API read otherwise; pass `refresh: true` to force the live read. `granularity` day (default) / week (Monday-Sunday) / month returns daily rows or summed buckets. `previousTotals` is null (not zero) when the comparison period ended before the channel was created (`previousPeriod` says why); `channelStartDate` is the channel's creation date. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "analytics.query_channel_breakdown",
    mcpTools: ["agent_query_channel_breakdown"],
    domain: "analytics",
    permission: "READ",
    description:
      "Channel-level breakdown for a date range: traffic sources, devices, age/gender, geography, subscribed status or content format (the same breakdown the Content tab shows), with raw API values and readable labels. A LIVE YouTube Analytics API read that counts against that API's quota (1 unit) -- there is no locally stored copy. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "analytics.query_channel_reach",
    mcpTools: ["agent_query_channel_reach"],
    domain: "analytics",
    permission: "READ",
    description:
      "Thumbnail impressions and click-through rate (CTR) per video per day for a date range, from YouTube's Reporting API Reach report that this app downloads and stores locally -- a LOCAL read, no live YouTube call. Neither metric is available from the Analytics API. Returns `state` (`no_job` / `waiting_for_first_report` / `ready`) so an empty result is never mistaken for zero, plus daily points, per-video totals and impressions-weighted totals; the first report file arrives up to 48 hours after the subscription is created, and data only exists from the day Google started producing files.",
  },
  {
    id: "analytics.query_video_analytics",
    mcpTools: ["agent_query_video_analytics", "analytics_list"],
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
    mcpTools: ["analytics_data_quality"],
    domain: "analytics",
    permission: "READ",
    description:
      "Which dates in a range were actually covered by a collection run vs. never collected vs. too recent, plus which videos had a recorded collection failure. Implemented as the pre-existing `analytics_data_quality` MCP tool/`analytics data-quality` CLI command (`src/lib/analytics/`), not a new function. Local read only. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "analytics.query_comparable_age_performance",
    mcpTools: ["analytics_comparable_age"],
    domain: "analytics",
    permission: "READ",
    description:
      "Compare 2-10 videos' already-collected metrics aligned by days-since-publish rather than calendar date. Implemented as the pre-existing `analytics_comparable_age` MCP tool/`analytics comparable-age` CLI command (`src/lib/analytics/`), not a new function. Local read only. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "analytics.query_weekly_reports",
    mcpTools: ["analytics_weekly_reports_list", "analytics_weekly_report_get"],
    domain: "analytics",
    permission: "READ",
    description:
      "List or fetch frozen, reproducible weekly (Mon-Sun) channel performance snapshots. Implemented as the pre-existing `analytics_weekly_reports_list`/`analytics_weekly_report_get` MCP tools/`analytics weekly-reports`/`weekly-report-get` CLI commands (`src/lib/analytics/`), not a new function. Local read only; no on-demand generation via this interface. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "asset_catalog.list_assets",
    mcpTools: ["agent_list_assets"],
    domain: "asset_catalog",
    permission: "READ",
    description:
      "List catalogued creative assets (thumbnails, source images, scripts, prompts, etc.) for a channel, optionally narrowed by linked videoId or assetType. Read-only over the local asset catalog -- never resolves referenceValue to an actual file. Requires channelId to be the caller's currently-active channel. Directly populated only by the operator-facing `asset register` CLI command (which also allows local_path); `content_proposal.register_external_artifact` adds an asset indirectly, tied to a Content Proposal, restricted to referenceKind url/external_artifact_id.",
  },
  {
    id: "asset_catalog.get_asset_context",
    mcpTools: ["agent_get_asset_context"],
    domain: "asset_catalog",
    permission: "READ",
    description:
      "Fetch one catalogued asset's full metadata record by assetId. Requires channelId to be the caller's currently-active channel and assetId to actually belong to it.",
  },
  {
    id: "content_proposal.create_content_proposal",
    mcpTools: ["agent_create_content_proposal"],
    domain: "content_proposal",
    permission: "DRAFT",
    description:
      "Create a structured Content Proposal (owner spec §18) -- objective, topic/concept, rationale, evidence, a bounded free-form `brief` (title/thumbnail/visual/audio direction, duration, publication hypothesis, localization strategy, experiment design, expected metrics, required production outputs), and references to already-synced videos/catalogued assets. Write-once: there is no update or approval workflow for this domain (a proposal is a DRAFT object, full stop -- inventing an approval state machine the owner spec never asked for would be scope creep). `referenceVideoIds`/`referenceAssetIds` are each validated to actually belong to the requesting channel. `createdVia`/`agentApiVersion` (owner spec §22) are SERVER-STAMPED, never caller-supplied. The application does not generate any of the proposed content itself -- Codex or external tools may produce it.",
  },
  {
    id: "content_proposal.get_content_proposal",
    mcpTools: ["agent_get_content_proposal"],
    domain: "content_proposal",
    permission: "READ",
    description:
      "Fetch one Content Proposal's full record by proposalId. Requires channelId to be the caller's currently-active channel and proposalId to actually belong to it -- otherwise fails with CONTENT_PROPOSAL_NOT_AVAILABLE, the same error for 'does not exist' and 'belongs to another channel'.",
  },
  {
    id: "content_proposal.list_content_proposals",
    mcpTools: ["agent_list_content_proposals"],
    domain: "content_proposal",
    permission: "READ",
    description:
      "List Content Proposals for a channel, newest first. Read-only over the local proposal record -- never resolves referenced videos/assets itself. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "content_proposal.register_external_artifact",
    mcpTools: ["agent_register_external_artifact"],
    domain: "content_proposal",
    permission: "DRAFT",
    description:
      "Register an externally-produced artifact (owner spec §19 -- a thumbnail, source image, audio file, rendered video, script, production manifest, etc. produced by Codex or an external tool) and link it back to the Content Proposal that requested it. Delegates the actual catalog entry to the same underlying mechanism as asset_catalog.list_assets/get_asset_context (no second, parallel asset store). referenceKind is restricted to \"url\"/\"external_artifact_id\" only -- never \"local_path\" (owner spec §17: an agent may only receive/register explicitly authorized assets, never self-authorize filesystem access). When referenceKind is \"url\", referenceValue must actually be an http(s) URL (structurally validated, not just labeled); \"external_artifact_id\" remains an intentionally opaque, unvalidated identifier this application never resolves. createdVia/agentApiVersion (owner spec §22) are SERVER-STAMPED, never caller-supplied. Requires channelId to be the caller's currently-active channel and proposalId to actually belong to it.",
  },
  {
    id: "content_proposal.list_proposal_artifacts",
    mcpTools: ["agent_list_proposal_artifacts"],
    domain: "content_proposal",
    permission: "READ",
    description:
      "List every artifact registered against a Content Proposal, newest first, each with its full catalogued asset record. Requires channelId to be the caller's currently-active channel and proposalId to actually belong to it.",
  },
  {
    id: "operations_workspace.list_files",
    mcpTools: ["agent_list_operations_files"],
    domain: "operations_workspace",
    permission: "READ",
    description:
      "List files/folders under the operator-configured operations-workspace directory (owner spec §3/§30) -- a folder OUTSIDE this repository holding Codex's own operating/editorial instructions, never generated or stored by this application itself (AGENTS.md §B). Returns { configured: false } if the operator has not set a path yet -- never a silently empty list. Only `.md`/`.txt`/`.json`/`.yaml`/`.yml` files are listed; dotfiles/dot-directories are always excluded. Bounded by a fixed depth/file-count cap, reporting `truncated: true` if either was hit. The path itself is set only through the Settings UI (`POST /api/settings`) -- no agent-callable way exists to set or change it (the same self-authorization concern owner spec §17 already raised for `local_path` asset registration).",
  },
  {
    id: "operations_workspace.get_file",
    mcpTools: ["agent_get_operations_file"],
    domain: "operations_workspace",
    permission: "READ",
    description:
      "Read one file's content from the operator-configured operations-workspace directory, by its path as returned from operations_workspace.list_files. Returns { configured: false } if no path is set. A path attempting to escape the configured directory (`..` segments, an absolute path, or a symlink resolving outside it) is rejected with the same OPERATIONS_FILE_NOT_AVAILABLE error as a genuinely nonexistent file -- never distinguishable, to avoid confirming what does or doesn't exist outside the workspace. Content is capped at 200,000 bytes per file, reporting `truncated: true` if the real file is larger.",
  },
  {
    id: "comparable_content.find_comparable_videos",
    mcpTools: ["agent_find_comparable_videos"],
    domain: "comparable_content",
    permission: "READ",
    description:
      "Owner spec §10: find already-synced videos on the same channel comparable to an anchor video, by publication proximity, duration proximity, and/or an age-aligned (days-since-publish, capped at 365) already-collected performance metric threshold. Local reads only -- never a live YouTube call; the performance-metric path reuses the same age-alignment logic as analytics.query_comparable_age_performance, never a second implementation. Does NOT support 'same content family', 'similar target audience', or 'similar metadata pattern' matching -- no data source for any of those exists in this application, and this capability never approximates them. Title similarity is reported only as `sharedTitleTokens`, a literal lowercase word-overlap set (after a tiny English stopword list) -- never framed as topic/semantic similarity, and never produced by an embedding model (owner spec §10 explicitly rules out embeddings for a first implementation). `credentialRef` is optional and, if omitted, resolved automatically to the caller's own active identity -- it is only actually used (for the local analytics read) when `performanceMetric` is requested. The response's `anchor` block and `performanceAlignment` report the exact reference point (video facts, and the metric name/day-offset every candidate was compared at) so results are interpretable without a second call. Videos missing the data a requested duration/performance filter needs are counted in `excludedForMissingData`, never silently coerced to a fabricated 0 or dropped without being counted. Requires channelId to be the caller's currently-active channel and anchorVideoId to actually belong to it.",
  },
  {
    id: "asset_performance.list_asset_performance",
    mcpTools: ["agent_list_asset_performance"],
    domain: "asset_performance",
    permission: "READ",
    description:
      "Owner spec §16: joins the existing asset catalog (`linkedVideoId` -- an operator/agent-asserted 'this asset was used on this video' association, never verified against YouTube and carrying no time range) against each linked video's own already-collected performance data. Always reports each video's LIFETIME totals (viewCount/likeCount/commentCount/durationSeconds, each independently null if never synced, plus `lifetimeCountersAsOf` -- when the channel sync last refreshed them, NOT when analytics were collected); an OPTIONAL age-aligned value (`performanceMetric` + a REQUIRED, caller-supplied `performanceDayOffset` -- never derived from wall-clock 'now', reusing the same shared age-alignment helper as comparable_content.find_comparable_videos, never a second implementation) is additionally computed only when both are given, and is honestly `null` (never excluded, never fabricated) for a video with real data at later days but no day-0 coverage -- a normal case for a video published before regular collection began. `sort: \"lifetimeViewCount\"` ranks by a NON-age-fair total that structurally favors older videos (more time to accumulate views) -- never itself a 'performed better' signal. This is a JOIN, not a FILTER -- a null performance value is still a reportable row, never grounds for exclusion; only an asset's own broken link (unlinked, or its linkedVideoId not resolving to a video on the SAME channel -- one combined count, since a channel-scoped read cannot further distinguish 'never synced' from 'on another channel') is excluded, counted in `excludedForMissingLink`, never silently dropped. Does NOT support thumbnail-CTR/impressions-based questions ('which thumbnails were used by high-CTR videos') -- this application's own analytics collection never fetches YouTube's impressions/CTR metrics at all, and this is never approximated via card/annotation click-through metrics (a different signal). Does NOT support metadata/version linkage (no temporal precision on `linkedVideoId`) or experiment/outcome linkage (Phase 10, not built yet). Never reads Content Proposal reference associations (`content_proposal_artifacts`) -- a structurally different, draft/unactioned relationship, never conflated with actual asset usage. `credentialRef` is optional and, if omitted, resolved automatically to the caller's own active identity -- only actually used when `performanceMetric` is requested. `limit` is silently clamped, never rejected. Requires channelId to be the caller's currently-active channel.",
  },
  // Phase 9 slice 4 (`docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md`) -- fulfils the two capability
  // names reserved in `PLANNED_FUTURE_CAPABILITIES` since Phase 7. Both registered directly as
  // `query_market_intelligence`/`query_competitors` MCP tools in `src/mcp/server.ts` calling
  // `createMarketIntelligenceCore()` (`src/lib/market-intelligence/`), NOT wrapped by a new
  // function in this module -- same "pre-existing tool, registered here for capability-discovery
  // completeness" pattern as `channel_context.list_channels`/`analytics.query_data_quality` above.
  // Neither is channel-scoped (research data is global, about channels the operator does not
  // necessarily own) -- no `channelId`/active-channel check applies, same as
  // `operations_workspace.list_files` above.
  {
    id: "market_intelligence.query_competitors",
    domain: "market_intelligence",
    permission: "READ",
    description:
      "List every channel currently on the research watchlist (id, handle/URL, reason it was added, when it was added) -- no evidence attached, just the roster. Implemented as the pre-existing `query_competitors` MCP tool/`agent competitors` CLI command (`src/lib/market-intelligence/`), not a new function. Local read only, never a live YouTube call. Global, not scoped to any owned channel -- this module's watchlist/evidence describe channels the operator does not necessarily own (AGENTS.md §F/`docs/roadmap/plans/PHASE_9_PLAN.md`). Phase 12 (channel-bound agent session): results are narrowed to records the operator assigned to the agent's own channel; a record not assigned to it behaves exactly like one that does not exist.",
  },
  {
    id: "market_intelligence.query_market_intelligence",
    domain: "market_intelligence",
    permission: "READ",
    description:
      "Single-channel deep dive into the research watchlist: one watchlisted channel's own record plus its evidence history, channel/video snapshots, topic assignments, and a derived dataQualityFlags array, by channelId. Another channel's YouTube-API-sourced snapshots and evidence are returned only for the last 30 days (YouTube API Developer Policies III.E.4.d); operator-entered rows at any age. Velocity, breakout and emerging-channel values for other channels are withheld (III.E.4.h). Fails with RESEARCH_CHANNEL_NOT_AVAILABLE if the given channelId is not on the watchlist. Implemented as the pre-existing `query_market_intelligence` MCP tool/`agent market-intelligence` CLI command (`src/lib/market-intelligence/`), not a new function. Local read only, never a live YouTube call. Global, not scoped to any owned channel -- see market_intelligence.query_competitors above for the same caveat. Every evidence row is a raw, sourced public observation -- never a ranking or profitability conclusion (`docs/roadmap/plans/PHASE_9_PLAN.md` §4/§7). `confidence` is free text, not a calibrated probability -- a row from the 'fetch public snapshot' action can read \"high\" even when every underlying count was hidden or absent (a known, still-open vocabulary question, `docs/roadmap/plans/PHASE_9_PLAN.md` §8). Phase 12 (channel-bound agent session): results are narrowed to records the operator assigned to the agent's own channel; a record not assigned to it behaves exactly like one that does not exist.",
  },
  {
    id: "market_intelligence.query_market_overview",
    mcpTools: ["query_market_overview"],
    domain: "market_intelligence",
    permission: "READ",
    description:
      "Compact bulk read of the research watchlist: several channels in one paged call, each with its newest raw channel snapshot and snapshot/evidence counts (no evidence text, no snapshot lists). Other channels' API-sourced snapshots only for the last 30 days (YouTube API policy III.E.4.d); nothing computed from competitor statistics (III.E.4.h). Implemented as the `query_market_overview` MCP tool (`src/lib/research-export/`). Local read only, never a live YouTube call.",
  },
  // Research export (ADR 0019): the Manager writes flat CSV/JSON files of watchlist snapshots (and our own channel's videos) into the
  // channel's workspace `99 Data Exchange/From YTM/` folder so a script can read them. DRAFT, not READ: it creates local files and a ledger row (never
  // anything on YouTube). The agent chooses neither folder nor file names.
  {
    id: "market_intelligence.export_research_data",
    mcpTools: ["agent_export_research_data"],
    domain: "market_intelligence",
    permission: "DRAFT",
    description:
      "Write the research watchlist's channel snapshots and video snapshots (and our own channel's public videos in the same columns) as CSV and/or JSON files into the fixed folder `99 Data Exchange/From YTM/` inside this channel's workspace folder, named by the Manager; returns only paths, row counts, sizes and expiry. Other channels' API-sourced data is kept at most 30 days (YouTube API policy III.E.4.d): research files carry `expiresAt` and the Manager deletes them itself. Fails with RESEARCH_EXPORT_WORKSPACE_NOT_CONFIGURED when the operator has not set a workspace folder for the channel. Implemented as the `agent_export_research_data` MCP tool (`src/lib/research-export/`). Requires channelId to be the caller's currently-active channel.",
  },
  // Phase 9 slice 9G, part A (docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md) -- one list tool with a
  // `kind` discriminator (owner spec §28: "prefer a small number of powerful composable MCP tools"),
  // rather than three separate tools for topics/trend candidates/discovery candidates.
  {
    id: "market_intelligence.agent_list_market_records",
    mcpTools: ["agent_list_market_records"],
    domain: "market_intelligence",
    permission: "READ",
    description:
      "One list read covering topics, trend candidates, or discovery candidates, selected by a `kind` input (\"topics\" | \"trend_candidates\" | \"discovery_candidates\"). Implemented as the `agent_list_market_records` MCP tool/`agent market-records --kind <kind>` CLI command (`src/lib/market-intelligence/`), a thin fan-out over the module's own already-existing `listTopics`/`listTrendCandidates`/`listDiscoveryCandidates`, not new service logic. Local read only, never a live YouTube call. Global, not scoped to any owned channel -- same caveat as market_intelligence.query_competitors above. Phase 12 (channel-bound agent session): results are narrowed to records the operator assigned to the agent's own channel; a record not assigned to it behaves exactly like one that does not exist.",
  },
  // Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md, owner spec §29)
  // -- this domain's first DRAFT-class capability. An agent may only CREATE a request; approving or
  // rejecting one is reachable ONLY through the Web UI, never through any MCP tool or CLI command
  // (verified mechanically by this module's own approval inventory test) -- the same
  // `changesets`-style approvalStatus precedent this codebase already established, applied here for
  // the first time to an agent-facing capability.
  {
    id: "market_intelligence.agent_create_market_research_request",
    mcpTools: ["agent_create_market_research_request"],
    domain: "market_intelligence",
    permission: "DRAFT",
    description:
      "Creates a structured research/discovery draft (query, rationale, optional monitorDurationDays -- stored as descriptive metadata only, never consulted by any scheduler, since none exists in this application). Always starts status:\"pending\". Makes zero YouTube calls and spends zero quota -- a human must separately approve it through the Web UI before the one real search.list run it can ever trigger actually happens (owner spec §29: \"this must not automatically create unlimited collection jobs\"). createdVia/agentApiVersion (owner spec §22) are SERVER-STAMPED, never caller-supplied. Implemented as the `agent_create_market_research_request` MCP tool/`agent create-research-request` CLI command (`src/lib/market-intelligence/`). Mutates local application state, so this tool is gated by the same device-availability/recovery-mode check as agent_create_content_proposal. Phase 12: a request created in a channel-bound agent session is owned by that agent's channel.",
  },
  // Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md). An agent may CREATE a request and READ its
  // progress and the limits; running (approving) or rejecting one is reachable ONLY through the Web UI (fenced by the approval inventory
  // test). Units are YouTube Data API quota units, never model tokens.
  {
    id: "market_intelligence.agent_create_collection_request",
    mcpTools: ["agent_create_collection_request"],
    domain: "market_intelligence",
    permission: "DRAFT",
    description:
      "Asks the human to collect fresh public snapshots of watchlist channels. Input { researchChannelIds?: string[] (default: every watchlist channel assigned to you), reason?: string (max 500, shown to the human verbatim) }; no force flag exists. Makes zero YouTube calls and spends nothing: it stores a pending request with a local estimate per channel ({ mode: backfill|incremental, expectedUnits, worstCaseUnits } -- UPPER BOUNDS in YouTube Data API quota units, not model tokens; an incremental refresh is about 2, at most 5), totals, dailyBudgetUnits, unitsSpentToday, remainingTodayUnits and fitsToday (worst-case total <= units left today; a request that does not fit is still created, and the collection stops at the daily budget and resumes from its saved cursor next day). The human approves or rejects it in the Research tab; you can neither approve nor run it. An approved request runs the REGULAR collection for its channels only (24 h stale window, 24 h pause after a failure, daily budget) -- it only removes the wait for a dashboard visit. Result { created, request, notNeeded, alreadyRequested }: notNeeded lists channels left out because they were collected successfully within 24 h (reason collected_recently) or failed within 24 h (recent_failure) with hoursSince; alreadyRequested lists channels that already have an open (pending/approved/running) request -- at most one open request per channel -- with that request's id; when nothing is left, created is false and no record exists. Read progress with agent_get_collection_request. A request can end `done` even when every channel was skipped_* (nothing collected: already fresh, in the failure pause, or no budget left) -- always read the per-channel `result` of agent_get_collection_request instead of assuming the data is fresh. alreadyRequested exposes a requestId only for a request assigned to you. Implemented as the `agent_create_collection_request` MCP tool/`agent create-collection-request` CLI command (`src/lib/market-intelligence/`). Mutates local application state, gated like agent_create_market_research_request. A request created in a channel-bound agent session is owned by that agent's channel.",
  },
  {
    id: "market_intelligence.agent_get_collection_request",
    mcpTools: ["agent_get_collection_request"],
    domain: "market_intelligence",
    permission: "READ",
    description:
      "One collection request by requestId, or (no requestId) the most recent ones you can see: status (pending|approved|running|done|rejected|failed), reason, the creation-time estimate, and after a run the per-channel result (outcome completed|partial_budget|failed|skipped_not_stale|skipped_recent_failure|skipped_quota_limited, videosStored, newSnapshotsObservedAt, unitsSpent in YouTube quota units) and unitsSpentTotal. A `done` request can have every channel skipped_* (nothing collected) -- check the per-channel results. partial_budget means the budget ran out mid-collection; the cursor is kept and the next regular collection continues. Local read only, never a live YouTube call. Implemented as the `agent_get_collection_request` MCP tool (`src/lib/market-intelligence/`). A request not assigned to your channel behaves like one that does not exist.",
  },
  {
    id: "market_intelligence.agent_get_collection_limits",
    mcpTools: ["agent_get_collection_limits"],
    domain: "market_intelligence",
    permission: "READ",
    description:
      "The owner's own collection limits and what is left today, in YouTube Data API quota units (not model tokens): dailyBudgetUnits (null = no budget set, so collection requests are refused), unitsSpentToday, remainingTodayUnits, quotaDayResetsAt (next Pacific midnight), the default collection depth (defaultMaxVideosPerChannel, defaultPublishedAfter), staleWindowHours (24), and the channels that override the depth. Local read only, never a live YouTube call. Implemented as the `agent_get_collection_limits` MCP tool/`agent collection-limits` CLI command (`src/lib/market-intelligence/`).",
  },
  // Phase 10 slice 2 (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md, FUTURE_PHASES.md §6) -- the
  // reserved `create_experiment_proposal` capability, now real. Channel-scoped where the
  // referenced hypothesis itself has a channelId, global (a "new channel concept" hypothesis) when
  // it doesn't -- decision-engine's own service layer enforces this internally, not this
  // registration layer.
  {
    id: "decision_engine.agent_list_hypotheses",
    mcpTools: ["agent_list_hypotheses"],
    domain: "decision_engine",
    permission: "READ",
    description:
      "Lists every hypothesis visible to the caller -- channel-scoped rows narrowed to the caller's own active channel, channel-less rows always included. Implemented as the `agent_list_hypotheses` MCP tool/`agent list-hypotheses` CLI command (`src/lib/decision-engine/`). Local read only.",
  },
  {
    id: "decision_engine.agent_get_hypothesis_trail",
    mcpTools: ["agent_get_hypothesis_trail"],
    domain: "decision_engine",
    permission: "READ",
    description:
      "One hypothesis plus every one of its experiments, each with its own recorded outcomes -- the evidence -> hypothesis -> experiment -> outcome trail FUTURE_PHASES.md §6's completion criterion describes, in one call. Implemented as the `agent_get_hypothesis_trail` MCP tool/`agent get-hypothesis-trail` CLI command. Local read only, fails with HYPOTHESIS_NOT_FOUND for an unknown id.",
  },
  {
    id: "decision_engine.create_experiment_proposal",
    domain: "decision_engine",
    permission: "DRAFT",
    description:
      "Creates an experiment (treatment, control/baseline, success/stopping criteria, responsible party) against an already-existing hypothesis. Always starts status:\"proposed\" -- no field or tool lets an agent set any other status; a human must separately approve it through the Web UI (FUTURE_PHASES.md §6: \"no consequential action executes merely because an AI agent proposed it\"). Creating a hypothesis, recording an outcome, and any status transition remain Web-UI-only. Implemented as the `create_experiment_proposal` MCP tool/`agent create-experiment-proposal` CLI command. Mutates local application state, gated the same way as market_intelligence.agent_create_market_research_request above.",
  },
  // Phase 11 (docs/roadmap/plans/PHASE_11_PLAN.md) -- registered directly as the
  // `agent_get_channel_workspace` MCP tool / `agent channel-workspace` CLI command calling
  // `createChannelWorkspacesCore()` (`src/lib/channel-workspaces/`), NOT wrapped by this module --
  // same "registered here for capability-discovery completeness" pattern as the
  // market_intelligence entries above.
  {
    id: "channel_workspace.get_channel_workspace",
    mcpTools: ["agent_get_channel_workspace"],
    domain: "channel_workspace",
    permission: "READ",
    description:
      "The local production-workspace folder path the operator set for a channel on THIS device (Settings -> Channels), returned as an absolute path string, or { configured: false } when none is set (never an empty-string path). Implemented as the `agent_get_channel_workspace` MCP tool / `agent channel-workspace` CLI command (`src/lib/channel-workspaces/`). This application never opens, lists, reads, writes, or re-validates anything inside the folder -- the string is returned exactly as stored, even if the folder has since been moved or deleted. Device-local: never synced or handed off, and a path set on another device is never returned. Read-only: no agent-callable way exists to set or clear it -- only the operator, through the Settings UI (`PUT /api/channel-workspaces`), the same self-authorization concern owner spec §17 raised for `local_path` asset registration. Requires channelId to be the caller's currently-active channel.",
  },
  // Phase 14 slice 5 (docs/roadmap/plans/PHASE_14_PLAN.md §2.7) -- remote media generation on RunPod/ComfyUI. An agent REQUESTS a
  // session and READS it; a human approves/starts/stops it in Settings → Media (Web-only, fenced by session-approval-inventory.test.ts).
  // Inside a running session the agent submits jobs freely; outputs land in the channel's workspace `99 Data Exchange/From YTM/media/`.
  {
    id: "media_generation.list_media_templates",
    mcpTools: ["agent_list_media_templates"],
    domain: "media_generation",
    permission: "READ",
    description:
      "The ComfyUI workflow templates the operator imported, with their declared parameters (the only values a job may set), output node ids and version. Templates are technical graphs; prompts and every creative choice are job parameters. Implemented as the `agent_list_media_templates` MCP tool (`src/lib/media-generation/`). Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "media_generation.request_media_session",
    mcpTools: ["agent_request_media_session"],
    domain: "media_generation",
    permission: "DRAFT",
    description:
      "Asks the human to start a generation session (one RunPod GPU pod running ComfyUI) with caps { maxMinutes?, maxUsd?, reason? }. Stores a PENDING session with a local estimate (saved GPU price x maxMinutes / 60, an upper bound) and fitsToday against the owner's daily USD cap; makes no RunPod call and spends nothing. The human approves or rejects it in Settings -> Media; the agent can neither approve, start nor stop it. At most one open session per device (media_session_conflict otherwise). Implemented as the `agent_request_media_session` MCP tool. Mutates local application state, gated like agent_create_collection_request.",
  },
  {
    id: "media_generation.get_media_session",
    mcpTools: ["agent_get_media_session"],
    domain: "media_generation",
    permission: "READ",
    description:
      "One session by id, or this channel's recent sessions: status, caps, estimate, the pod's real $/h, live secondsUsed/usdCharged, stop reason or error. `running` is the only state that accepts jobs. Never the proxy token. A session of another channel behaves like one that does not exist. Implemented as the `agent_get_media_session` MCP tool. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "media_generation.get_media_limits",
    mcpTools: ["agent_get_media_limits"],
    domain: "media_generation",
    permission: "READ",
    description:
      "The owner's media limits in USD (maxUsdPerDay, spentTodayUsd, remainingTodayUsd), defaultMaxMinutes, idleMinutes, whether Settings -> Media is complete (ready/missing), this channel's open session and deviceHasOpenSession. Local read only. Implemented as the `agent_get_media_limits` MCP tool. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "media_generation.create_media_job",
    mcpTools: ["agent_create_media_job"],
    domain: "media_generation",
    permission: "DRAFT",
    description:
      "Submits one generation job { sessionId, templateId, params } to a RUNNING session's ComfyUI. Parameters are validated against the template before anything is sent (media_job_params_invalid). Generation and transfer run in the background: when `done`, every output is an absolute path under <channel workspace>/99 Data Exchange/From YTM/media/<jobId>/ plus a registered asset with provenance, and the file is deleted from the server volume. Implemented as the `agent_create_media_job` MCP tool. Mutates local state and reaches ComfyUI, gated like agent_request_media_session. Requires channelId to be the caller's currently-active channel and the session to belong to it.",
  },
  {
    id: "media_generation.get_media_job",
    mcpTools: ["agent_get_media_job"],
    domain: "media_generation",
    permission: "READ",
    description:
      "One job by id, or this channel's recent jobs (optionally one session's): status (queued|submitted|generating|transferring|done|failed|cancelled), resolved params, promptId, outputs with localPath/bytes/sha256/assetId/note, assetIds, error. Local read only. A job of another channel behaves like one that does not exist. Implemented as the `agent_get_media_job` MCP tool. Requires channelId to be the caller's currently-active channel.",
  },
  {
    id: "media_generation.cancel_media_job",
    mcpTools: ["agent_cancel_media_job"],
    domain: "media_generation",
    permission: "DRAFT",
    description:
      "Cancels one of this channel's queued or generating jobs (best-effort interrupt of ComfyUI); a transferring or finished job is refused. Never stops the session. Implemented as the `agent_cancel_media_job` MCP tool; gated like agent_create_media_job. Requires channelId to be the caller's currently-active channel.",
  },
];

/** The literal capability inventory, for tests that tie it to the real MCP tool registry (BL-118 drift test). */
export function listAgentCapabilityDescriptors(): readonly AgentCapabilityDescriptor[] {
  return AGENT_CAPABILITIES;
}



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
  /** BL-118: when the channel was created on YouTube (RFC 3339); absent/null until a sync recorded it. */
  publishedAt?: string | null;
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
  /** Phase 12: true inside a channel-bound agent session (`src/lib/agent-session`). Optional. */
  isAgentSession?: () => boolean;
  getProductVersion(): string;
  getSchemaVersion(): number;
  // Slice B -- reused unchanged from `changesets`' own channel/video store adapter
  // (`createChannelVideoStoreAdapter`), the same local-sync mirror `ai-localization` already
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
    /** Phase 13 slice 13.7: the two compared periods straddle YouTube's 2026-08-27 view-counting change. */
    viewCountingChangeInComparison?: boolean;
    /** BL-118: where the figures came from, and when the stored rows were last collected (local source only). */
    source?: "live" | "local";
    collectedAt?: string | null;
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
  // Slice G2 -- delegates to `contentProposalCore`'s own `registerExternalArtifact`/
  // `listProposalArtifacts` unchanged (AGENTS.md §D).
  contentProposalRegisterExternalArtifact(
    input: unknown,
    callOrigin: { createdVia: CreatedVia; agentApiVersion?: string | null }
  ): Promise<ProposalArtifactLink>;
  contentProposalListProposalArtifacts(input: unknown): Promise<{ artifacts: ProposalArtifactLink[] }>;
  // Slice I -- delegates to `operationsInstructionsCore`'s own `listOperationsFiles`/
  // `getOperationsFile` unchanged (AGENTS.md §D). No credential/channel checking -- this
  // capability is not channel-scoped at all (one global, operator-configured workspace path).
  operationsWorkspaceListFiles(input: unknown): Promise<OperationsWorkspaceListResult>;
  operationsWorkspaceGetFile(input: unknown): Promise<OperationsWorkspaceFileResult>;
  // Slice K -- delegates to `comparableContentCore`'s own `findComparableVideos` unchanged
  // (AGENTS.md §D). No credential/channel checking of its own -- mirrors slice B's convention,
  // same as every delegate above; the MCP/CLI caller checks `assertActiveChannel` first.
  findComparableVideos(input: unknown): Promise<FindComparableVideosResult>;
  // Slice L -- delegates to `assetPerformanceCore`'s own `listAssetPerformance` unchanged
  // (AGENTS.md §D). Same non-channel-checking convention as `findComparableVideos` above.
  listAssetPerformance(input: unknown): Promise<ListAssetPerformanceResult>;
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
        // Phase 12 (owner decision D2): the global operations workspace is operator-only -- a
        // channel-bound agent session never lists capabilities it cannot call.
        capabilities: deps.isAgentSession?.()
          ? AGENT_CAPABILITIES.filter((capability) => capability.domain !== "operations_workspace")
          : AGENT_CAPABILITIES,
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
        channelStartDate: channel.publishedAt ? channel.publishedAt.slice(0, 10) : null,
        syncedVideoCount: videos.length,
        // Explicit projection: the stored profile also carries its own `channelId` (redundant
        // with this context's top-level one), which the strict output schema rejects.
        editorialProfile: profile
          ? {
              version: profile.version,
              targetAudience: profile.targetAudience,
              toneNotes: profile.toneNotes,
              terminologyNotes: profile.terminologyNotes,
              titleConstraints: profile.titleConstraints,
              descriptionConstraints: profile.descriptionConstraints,
              updatedAt: profile.updatedAt,
            }
          : null,
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
      const granularity = parsedInput.granularity ?? "day";

      // BL-118: answer from the locally stored channel totals when they cover the range (no live call, no quota); `refresh` forces a live read.
      const [overview, channel] = await Promise.all([
        deps.getChannelOverview({
          credentialRef: parsedInput.credentialRef,
          channelId: parsedInput.channelId,
          startDate: parsedInput.startDate,
          endDate: parsedInput.endDate,
          preferLocal: parsedInput.refresh !== true,
        }),
        deps.channelStore.getChannel(parsedInput.channelId),
      ]);
      const channelStartDate = channel?.publishedAt ? channel.publishedAt.slice(0, 10) : null;

      const { status: previousStatus, note: previousNote } = describePreviousPeriod({
        previousStartDate: overview.previousStartDate,
        previousEndDate: overview.previousEndDate,
        channelStartDate,
      });

      const local = overview.source === "local";
      // Days this recent were collected inside YouTube's reporting lag and are re-collected by every automatic run: provisional.
      const provisionalFromDate = new Date(deps.now().getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
      const output: ChannelAnalyticsContext = {
        channelId: overview.channelId,
        channelStartDate,
        granularity,
        buckets: granularity === "day" ? null : bucketDailyRows({ daily: overview.daily, granularity, startDate: overview.startDate, endDate: overview.endDate }),
        previousPeriod: { status: previousStatus, note: previousNote },
        period: {
          startDate: overview.startDate,
          endDate: overview.endDate,
          previousStartDate: overview.previousStartDate,
          previousEndDate: overview.previousEndDate,
        },
        filters: {},
        metricDefinitions: getMetricDefinitions(CHANNEL_OVERVIEW_METRIC_NAMES),
        freshness: local
          ? {
              source: "local_collected_data",
              asOf: overview.collectedAt ?? deps.now().toISOString(),
              note:
                `Read from the channel totals this app collected and stored locally (no live YouTube call, no quota); asOf is when they were last collected. YouTube itself reports this data with a 1-2 day lag, and days from ${provisionalFromDate} on are PROVISIONAL: the automatic collection re-collects them daily, so they may still change. Pass refresh=true for a live read.`,
            }
          : {
              source: "live_youtube_analytics_api",
              asOf: deps.now().toISOString(),
              note:
                "Fetched live from the YouTube Analytics API for this call -- YouTube itself typically reports this data with a 1-2 day lag behind real time (see docs/ARCHITECTURE.md §14.8). It counts against that API's quota.",
            },
        daily: granularity === "day" ? overview.daily : [],
        currentTotals: overview.currentTotals,
        previousTotals: previousStatus === "predates_channel" ? null : overview.previousTotals,
        viewCountingChangeInComparison: overview.viewCountingChangeInComparison ?? false,
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

      const { format, ...listInput } = parsedInput;
      const result = await deps.listMetrics(listInput);
      const metricNames = parsedInput.metricNames ?? ANALYTICS_METRIC_NAMES;

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
        rows: format === "wide" ? [] : result.rows,
        ...(format ? { format } : {}),
        ...(format === "wide" ? { wideRows: toWideMetricRows(result.rows, metricNames) } : {}),
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

    /** Slice G2, owner spec §19. See this capability's own description in `AGENT_CAPABILITIES`
     * above for what is and isn't validated/recorded. */
    async registerExternalArtifact(
      input: unknown,
      callOrigin: { createdVia: CreatedVia; agentApiVersion?: string | null }
    ): Promise<ProposalArtifactLink> {
      const parsedInput = parseWithSchema(registerExternalArtifactInputSchema, input, "register external artifact input");
      const result = await deps.contentProposalRegisterExternalArtifact(parsedInput, callOrigin);
      return parseWithSchema(registerExternalArtifactOutputSchema, result, "register external artifact output");
    },

    /** Slice G2. Same channel-scoping note as `listContentProposals` above. */
    async listProposalArtifacts(input: unknown): Promise<{ artifacts: ProposalArtifactLink[] }> {
      const parsedInput = parseWithSchema(listProposalArtifactsInputSchema, input, "list proposal artifacts input");
      const result = await deps.contentProposalListProposalArtifacts(parsedInput);
      return parseWithSchema(listProposalArtifactsOutputSchema, result, "list proposal artifacts output");
    },

    /** Slice I, owner spec §3/§30. Not channel-scoped -- one global, operator-configured
     * workspace path. See this capability's own description in `AGENT_CAPABILITIES` above. */
    async operationsWorkspaceListFiles(input: unknown): Promise<OperationsWorkspaceListResult> {
      const parsedInput = parseWithSchema(operationsWorkspaceListFilesInputSchema, input, "list operations workspace files input");
      const result = await deps.operationsWorkspaceListFiles(parsedInput);
      return parseWithSchema(operationsWorkspaceListFilesOutputSchema, result, "list operations workspace files output");
    },

    /** Slice I. Same non-channel-scoped note as `operationsWorkspaceListFiles` above. */
    async operationsWorkspaceGetFile(input: unknown): Promise<OperationsWorkspaceFileResult> {
      const parsedInput = parseWithSchema(operationsWorkspaceGetFileInputSchema, input, "get operations workspace file input");
      const result = await deps.operationsWorkspaceGetFile(parsedInput);
      return parseWithSchema(operationsWorkspaceGetFileOutputSchema, result, "get operations workspace file output");
    },

    /**
     * Slice K, owner spec §10. Channel-scoped -- the MCP/CLI caller checks
     * `assertActiveChannel` before this is ever invoked, same convention as slice B. Enriches the
     * raw comparable-content result with `metricDefinitions`/`freshness` -- same convention
     * `queryVideoAnalytics` above already applies over its own wrapped capability's raw result
     * (owner spec §9) -- `null` for both unless `performanceMetric` was actually requested.
     */
    async findComparableVideos(input: unknown): Promise<FindComparableVideosContext> {
      const parsedInput = parseWithSchema(findComparableVideosInputSchema, input, "find comparable videos input");
      const result = await deps.findComparableVideos(parsedInput);
      const output: FindComparableVideosContext = {
        ...result,
        metricDefinitions: result.performanceAlignment ? getMetricDefinitions([result.performanceAlignment.metricName]) : null,
        freshness: result.performanceAlignment
          ? {
              source: "local_collected_data",
              asOf: deps.now().toISOString(),
              note:
                "Reflects whatever was last collected locally (via 'Collect now' or daily auto-collection), not a live read. Call the existing analytics_data_quality tool for exact per-date coverage.",
            }
          : null,
      };
      return parseWithSchema(findComparableVideosContextOutputSchema, output, "find comparable videos output");
    },

    /**
     * Slice L, owner spec §16. Channel-scoped -- the MCP/CLI caller checks `assertActiveChannel`
     * before this is ever invoked, same convention as slice K. Enriches the raw asset-performance
     * result with `metricDefinitions`/`freshness` -- same convention `findComparableVideos`/
     * `queryVideoAnalytics` above already apply -- `null` for both unless `performanceMetric` was
     * actually requested.
     */
    async listAssetPerformance(input: unknown): Promise<ListAssetPerformanceContext> {
      const parsedInput = parseWithSchema(listAssetPerformanceInputSchema, input, "list asset performance input");
      const result = await deps.listAssetPerformance(parsedInput);
      const output: ListAssetPerformanceContext = {
        ...result,
        metricDefinitions: result.performanceAlignment ? getMetricDefinitions([result.performanceAlignment.metricName]) : null,
        freshness: result.performanceAlignment
          ? {
              source: "local_collected_data",
              asOf: deps.now().toISOString(),
              note:
                "Reflects whatever was last collected locally (via 'Collect now' or daily auto-collection), not a live read. Call the existing analytics_data_quality tool for exact per-date coverage.",
            }
          : null,
      };
      return parseWithSchema(listAssetPerformanceContextOutputSchema, output, "list asset performance output");
    },
  };
}

export type AgentOperationsServices = ReturnType<typeof createAgentOperationsServices>;
