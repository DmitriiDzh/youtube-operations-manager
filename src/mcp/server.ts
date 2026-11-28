#!/usr/bin/env node

import { createJobInputSchema, requestSessionInputSchema } from "@/lib/media-generation/schemas";
import { loadEnvConfig } from "@next/env";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createVideoMetadataCore } from "@/lib/video-metadata";
import { calendarDateSchema, DomainError, isDomainError } from "@/lib/shared-domain";
import type { VideoMetadataCore } from "@/lib/video-metadata";
import { createCliAuthService, type CliAuthService } from "@/lib/cli-auth";
import { getStoredVideo, insertWorkerActionLogEntry, listWorkerActionLogEntries, recordGatewayCallOutcome } from "@/lib/db";
import { describeWorkerWrite, describeWriteOutcome, serializeWorkerDetail } from "./worker-actions";
import { createWorkerPrivacyCore, setPrivacyInputSchema } from "@/lib/worker-privacy";
import { createRestartWhenIdleCore } from "@/lib/restart-when-idle";
import { createFactoryChannelDeps } from "./factory-channel-deps";
import { workerFactoryTools, type WorkerMediaDeps } from "./worker-factory-tools";
import type { CredentialRef } from "@/lib/shared-domain";
import { createPlaylistManagementCore, type PlaylistManagementCore } from "@/lib/playlist-management";
import { OperationLockError } from "@/lib/operation-lock";
import { RecoveryModeError } from "@/lib/device-mutation-gate";
import {
  playlistAddVideosInputSchema,
  playlistCreateInputSchema,
  playlistDeleteInputSchema,
  playlistListInputSchema,
  playlistRemoveVideosInputSchema,
} from "@/lib/playlist-management/schemas";
import { createChangeSetCore, type ChangeSetCore } from "@/lib/changesets";
import { getChangeSetInputSchema, listChangeSetsInputSchema, proposeLanguageMoveInputSchema } from "@/lib/changesets/schemas";
import { createBatchCore, type BatchCore } from "@/lib/batches";
import { createChannelSyncCore, type ChannelSyncCore } from "@/lib/channel-sync";
import { assertAgentScopeVideo, createChannelAccessCore, type ChannelAccessCore } from "@/lib/channel-access";
import {
  listChannelsInputSchema,
  listSyncedVideosInputSchema,
  syncChannelInputSchema,
} from "@/lib/channel-sync/schemas";
import { createAnalyticsCore, listStoredBreakdownsInputSchema, listStoredSearchTermsInputSchema, listStoredSuggestedSourcesInputSchema, listVideoMilestonesInputSchema, type AnalyticsCore } from "@/lib/analytics";
import { createAiLocalizationCore, type AiLocalizationCore } from "@/lib/ai-localization";
import {
  createChangeSetFromGenerationInputSchema,
  generateProposalsInputSchema,
} from "@/lib/ai-localization/schemas";
import { createAgentOperationsCore, type AgentOperationsCore, AGENT_API_VERSION } from "@/lib/agent-operations";
import {
  createContentProposalInputSchema,
  findComparableVideosInputSchema,
  findComparableVideosSdkInputSchema,
  getAssetContextInputSchema,
  getChannelContextInputSchema,
  getContentProposalInputSchema,
  getGenerationProvenanceInputSchema,
  getSystemCapabilitiesInputSchema,
  getVideoContextInputSchema,
  listAssetPerformanceInputSchema,
  listAssetPerformanceSdkInputSchema,
  listAssetsInputSchema,
  listContentProposalsInputSchema,
  listProposalArtifactsInputSchema,
  operationsWorkspaceGetFileInputSchema,
  operationsWorkspaceListFilesInputSchema,
  queryChannelAnalyticsInputSchema,
  queryVideoAnalyticsInputSchema,
  registerExternalArtifactInputSchema,
} from "@/lib/agent-operations/schemas";
import {
  getChannelBreakdownInputSchema,
  getChannelOverviewInputSchema,
  getComparableAgeComparisonInputSchema,
  getDataQualityReportInputSchema,
  getWeeklyReportInputSchema,
  listMetricsInputSchema,
  listWeeklyReportsInputSchema,
} from "@/lib/analytics/schemas";
import { labelAgeGender, labelContentFormat, labelCountry, labelDeviceType, labelSubscribedStatus, labelTrafficSource } from "@/lib/analytics/breakdown-labels";
import { createMarketIntelligenceCore, type MarketIntelligenceCore } from "@/lib/market-intelligence";
import { createMediaGenerationCore, type MediaGenerationCore } from "@/lib/media-generation";
import { createGenerationPlansCore, type GenerationPlan, type GenerationPlanServices } from "@/lib/generation-plans";
import { createReachReportsCore, type ReachReportsCore } from "@/lib/reach-reports";
import { getChannelReachInputObjectSchema, getReachStatusInputSchema, getReportingTrafficSourcesInputObjectSchema } from "@/lib/reach-reports/schemas";
import { createPublishingCalendarCore, type PublishingCalendarCore } from "@/lib/publishing";
import { dailyPublishingCoverage } from "@/composition/publishing-coverage";
import { getAgentPublishingCalendarInputSchema } from "@/lib/publishing/schemas";
import { createMarketAssignmentCore, type MarketAssignmentCore } from "@/lib/market-assignments";
import { assertAgentSession, getAgentSession, runInAgentSession } from "@/lib/agent-session";
import { MCP_TOOL_CLASSIFICATION } from "./tool-classification";
import {
  PRODUCER_API_VERSION,
  PRODUCER_CHANNEL_TOOLS,
  PRODUCER_DRAFT_CHANNEL_TOOLS,
  PRODUCER_DRAFT_TOOLS,
  PRODUCER_OWN_VIDEO_TOOLS,
  PRODUCER_PLAYLIST_CHANNEL_TOOLS,
  PRODUCER_PLAYLIST_WRITE_TOOLS,
  PRODUCER_RENAMED_CHANNEL_FIELD,
  PRODUCER_TOOL_NAMES,
  PRODUCER_UPLOAD_QUEUE_TOOLS,
  PRODUCER_CLIP_REVIEW_TOOLS,
  PRODUCER_IMAGE_REVIEW_TOOLS,
  PRODUCER_THUMBNAIL_TOOLS,
  PRODUCER_PLAN_TOOLS,
  PRODUCER_PLAN_MOVE_TOOLS,
  PRODUCER_METADATA_TOOLS,
  PRODUCER_CAPTIONS_TOOLS,
} from "./producer-tools";
import { listProducerProposalsInputSchema, markProposalsDoneInputSchema, submitProducerProposalInputSchema } from "@/lib/agent-proposals/schemas";
import {
  createChannelWorkspacesCore,
  getChannelWorkspaceInputSchema,
  type ChannelWorkspacesCore,
} from "@/lib/channel-workspaces";
import { createLogicalPathsCore, getLogicalPathInputSchema, type LogicalPathsCore } from "@/lib/logical-paths";
import {
  createResearchExportCore,
  exportResearchDataInputSchema,
  listResearchOverviewInputSchema,
  type ResearchExportCore,
} from "@/lib/research-export";
import {
  createCollectionRequestInputSchema,
  createMarketResearchRequestInputSchema,
  getCollectionRequestInputSchema,
  getWatchlistEntryInputSchema,
} from "@/lib/market-intelligence/schemas";
import { createDecisionEngineCore, type DecisionEngineCore } from "@/lib/decision-engine";
import { createExperimentResultsCore, getExperimentResultsInputSchema, type ExperimentResultsCore } from "@/lib/experiment-results";
import { createVideoCommentsCore, listStoredCommentsInputSchema, type VideoCommentsCore } from "@/lib/video-comments";
import {
  agentGetHypothesisTrailInputSchema,
  createExperimentProposalInputSchema,
} from "@/lib/decision-engine/schemas";

loadEnvConfig(process.cwd());

type VideoMetadataCoreSubset = Pick<
  VideoMetadataCore,
  "listVideos" | "getTranscript" | "previewMetadata" | "applyMetadata"
>;

type PlaylistManagementCoreSubset = Pick<
  PlaylistManagementCore,
  | "listPlaylists"
  | "createPlaylist"
  | "updatePlaylist"
  | "deletePlaylist"
  | "addVideosToPlaylist"
  | "removeVideosFromPlaylist"
>;

// Phase 7 slice 1 (docs/roadmap/plans/PHASE_7_PLAN.md): read/propose-only MCP tools for
// Change Sets and Batches, closing part of RISK-04. Deliberately excludes every
// apply-class/write-capable method on either core -- `src/lib/batches/write-path-inventory.test.ts`
// fails the build if any such symbol is ever referenced from this file.
type ChangeSetCoreSubset = Pick<
  ChangeSetCore,
  "listChangeSets" | "getChangeSet" | "previewImport" | "createChangeSetFromImport" | "proposeLanguageMove"
>;
type BatchCoreSubset = Pick<BatchCore, "listBatchesByChannel" | "getBatchWithLedgerRows">;

// BL-008 (docs/roadmap/BACKLOG.md): the remainder of RISK-04's MCP portion --
// channel_sync writes to the local channels/videos tables (via a real YouTube API read),
// so it IS gated by assertMcpDeviceAvailable below, unlike the read-only pair.
type ChannelSyncCoreSubset = Pick<ChannelSyncCore, "syncChannel" | "listChannels" | "listSyncedVideos">;

// Phase 8 follow-up (docs/roadmap/BACKLOG.md, "machine-readable analytics for operational agents
// to consume" -- docs/roadmap/FUTURE_PHASES.md §4 / docs/PROJECT_SPEC.md §33): read-only, exactly
// the same two operations the Web UI's own `.../analytics` and `.../analytics/overview` routes
// already call -- no new domain logic, no parallel implementation. Deliberately excludes
// `collectMetrics`/`runAutoCollectionIfStale`: those are local-persistence mutations that spend
// real Analytics API quota, not something an agent should be able to trigger freely (the Web UI's
// own "Collect now" button plus the once-a-day dashboard-mount auto-trigger remain the only ways
// to actually collect new data).
// Weekly reports (Phase 8 follow-up, slice 4): deliberately excludes `runWeeklyReportIfDue` --
// like `collectMetrics`, it's a local-persistence mutation triggered only by the Web UI's own
// dashboard-mount hook, never something an agent should be able to trigger freely. Agents get
// read-only `listWeeklyReports`/`getWeeklyReport` over whatever snapshot already exists.
type AnalyticsCoreSubset = Pick<
  AnalyticsCore,
  | "listMetrics"
  | "getChannelOverview"
  | "getDataQualityReport"
  | "getComparableAgeComparison"
  | "listWeeklyReports"
  | "getWeeklyReport"
  | "listVideoMilestones"
  | "listStoredBreakdowns"
  | "listStoredSearchTerms"
  | "listStoredSuggestedSources"
>;

// Phase 9 slice 4 (docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md): registered directly here, not
// through `agentOperationsCore` -- `query_market_intelligence`/`query_competitors` are plain
// (or single-merge) reads over the market-intelligence module's own watchlist/evidence storage
// with no agent-context reshaping needed, and keeping this dependency in the MCP/CLI interface
// layer (which already imports every domain module's own core factory directly) avoids adding
// `market-intelligence` as a hard dependency of `agent-operations`'s own service layer
// (`docs/roadmap/plans/PHASE_9_PLAN.md` §5's module-independence rule). Global data, never
// channel-scoped -- no `assertMcpDeviceAvailable` or active-channel check applies to either.
// Phase 9 slice 9G, part A widened this to add the three list actions `agent_list_market_records`
// fans out to -- same rationale as above, no new hard dependency on agent-operations. Part B added
// `createMarketResearchRequest` only -- deliberately never the two actions that move a research
// request out of "pending" (no MCP tool anywhere calls either, verified mechanically by this
// module's own approval inventory test).
type MarketIntelligenceCoreSubset = Pick<
  MarketIntelligenceCore,
  | "listWatchlist"
  | "getWatchlistEntryContext"
  | "listTopics"
  | "listTrendCandidates"
  | "listDiscoveryCandidates"
  | "createMarketResearchRequest"
  // Collection requests (ADR 0021): create + reads only. Running (approving) or rejecting one is Web-UI-only and is deliberately NOT in
  // this subset (fenced by the approval inventory test).
  | "createCollectionRequest"
  | "listCollectionRequests"
  | "getCollectionLimits"
>;

// Phase 10 slice 2 (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md): same "registered directly here,
// not through agentOperationsCore" reasoning as MarketIntelligenceCoreSubset above --
// decision-engine's own service layer already does its own channel-access assertion internally
// (see assertHypothesisAccessible in src/lib/decision-engine/services.ts), so no reshaping is
// needed here. The status-transition and outcome-recording actions are deliberately NOT in this
// subset -- no MCP tool or CLI command may reach either (approval/outcome-recording stay
// Web-UI-only), verified mechanically by this module's own agent-approval inventory test.
type DecisionEngineCoreSubset = Pick<DecisionEngineCore, "listHypotheses" | "getHypothesisTrail" | "createExperiment">;

const agentListHypothesesInputSchema = z.object({}).strict();
const agentGetCollectionLimitsInputSchema = z.object({}).strict();

// Phase 14 slice 5 (docs/roadmap/plans/PHASE_14_PLAN.md §2.7) -- remote media generation. Every tool
// takes the caller's channelId (asserted to be the active/bound channel, like agent_get_channel_workspace);
// a session or job of another channel behaves like one that does not exist. Approving/starting/stopping
// a session is Web-only and deliberately absent from this subset (fenced by session-approval-inventory.test.ts).
type MediaGenerationCoreSubset = Pick<
  MediaGenerationCore,
  "requestSession" | "getSession" | "listSessions" | "getLimits" | "listWorkflowTemplates" | "createJob" | "getJob" | "listJobs" | "cancelJob" | "releaseSession"
>;
const mediaChannelIdSchema = z.string().min(1).max(64);
// BL-143 phase 3 (AC-GP3-03): read-only generation plan tools, the session's active channel only.
const agentListGenerationPlansInputSchema = z.object({ channelId: mediaChannelIdSchema, status: z.enum(["active", "completed", "cancelled"]).optional() }).strict();
const agentGetGenerationPlanInputSchema = z.object({ channelId: mediaChannelIdSchema, planId: z.string().min(2).max(80), since: z.string().datetime().optional() }).strict();

/**
 * What a channel agent may see of a plan (AC-GP3-03): header, stages, groups, items WITHOUT job params, the derived progress
 * and, for one plan, its events WITHOUT error text (a job error can name local paths). Never review audio or file paths.
 */
function agentPlanView(view: { plan: GenerationPlan; progress: unknown }) {
  const { plan } = view;
  return {
    planId: plan.planId,
    title: plan.title,
    channelId: plan.channelId,
    status: plan.status,
    budget: plan.budget,
    note: plan.note,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    closedAt: plan.closedAt,
    stages: plan.stages,
    groups: plan.groups,
    items: plan.items.map((i) => ({ itemKey: i.itemKey, groupId: i.groupId, templateId: i.templateId, templateLabel: i.templateLabel, targetCount: i.targetCount, mode: i.mode, maxAttempts: i.maxAttempts })),
    progress: withoutStopReasons(view.progress),
  };
}

/**
 * Error texts at ANY depth (re-review: a stage run's `stoppedAt.error.message` carries ComfyUI/RunPod text and can name local
 * paths): every `error`, `message` and `stopReason` key is dropped for agents.
 */
function withoutErrorTexts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutErrorTexts);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== "error" && k !== "message" && k !== "stopReason").map(([k, v]) => [k, withoutErrorTexts(v)]));
}

/** The spend sessions without their stop reason (a failed start's reason carries RunPod error text). */
function withoutStopReasons(progress: unknown): unknown {
  if (!progress || typeof progress !== "object") return progress;
  const p = progress as { spend?: { sessions?: Array<Record<string, unknown>> } };
  if (!p.spend?.sessions) return progress;
  return { ...p, spend: { ...p.spend, sessions: p.spend.sessions.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "stopReason"))) } };
}
const agentListMediaTemplatesInputSchema = z.object({ channelId: mediaChannelIdSchema }).strict();
// Derived from the core's own schemas (review round 21): the bounds an agent sees are exactly the ones the core enforces;
// only the caller-identity field (`requestedBy`/`createdBy`) is the server's to set, never the agent's.
// BL-157 (review round 6): a session is linked to a generation plan only by the factory, checked by the plans module
// (ADR 0029 §6) -- never by a channel agent, so `planId` is not the agent's to set (as `plan` on a job, round 3).
// BL-159 (review): a session's own minimum host CUDA is the Factory Operator's, through factory_media_start_session -- not an
// agent's (the owner's Web UI does not show it, so an agent-raised floor would make the owner's approval wait unexplained).
const agentRequestMediaSessionInputSchema = requestSessionInputSchema.omit({ requestedBy: true, planId: true, minCudaVersion: true });
const agentGetMediaSessionInputSchema = z.object({ channelId: mediaChannelIdSchema, sessionId: z.string().min(1).max(64).optional() }).strict();
const agentGetMediaLimitsInputSchema = z.object({ channelId: mediaChannelIdSchema }).strict();
// BL-157 (review round 3): a job is linked to a generation plan only by the factory, checked by the plans module and under
// the plan's lock (ADR 0029 §4, ADR 0031) -- never by a channel agent, so `plan` is not the agent's to set.
const agentCreateMediaJobInputSchema = createJobInputSchema.omit({ createdBy: true, plan: true });
const agentGetMediaJobInputSchema = z
  .object({ channelId: mediaChannelIdSchema, jobId: z.string().min(1).max(64).optional(), sessionId: z.string().min(1).max(64).optional() })
  .strict();
const agentCancelMediaJobInputSchema = z.object({ channelId: mediaChannelIdSchema, jobId: z.string().min(1).max(64) }).strict();
// BL-135: the channel ends its own session (the only session action an agent has -- it only stops spending).
const agentReleaseMediaSessionInputSchema = z.object({ channelId: mediaChannelIdSchema, sessionId: z.string().min(1).max(64) }).strict();

// BL-075/BL-078 (docs/roadmap/BACKLOG.md): the same "generate proposals" -> "create Change Set"
// two-step workflow the Web UI's own ai-localization routes already expose, now reachable by an
// agent over MCP/CLI too -- no new validation, persistence, or approval logic; both handlers call
// exactly these two existing, already-tested service functions unchanged. Deliberately excludes
// `getEditorialProfile`/`saveEditorialProfile`/`getGenerationProvenance` (out of this slice's
// scope) and, like every other Change-Set-adjacent tool in this file, never exposes an
// approve/reject/apply path -- "AI may propose, human approves" (AGENTS.md §G) is untouched.
type AiLocalizationCoreSubset = Pick<AiLocalizationCore, "generateProposals" | "createChangeSetFromGeneration">;

// Phase 7 (Agent Operations Interface, docs/AGENT_OPERATIONS_INTERFACE.md) -- slices A-E.
type AgentOperationsCoreSubset = Pick<
  AgentOperationsCore,
  | "getSystemCapabilities"
  | "getChannelContext"
  | "getVideoContext"
  | "queryChannelAnalytics"
  | "queryVideoAnalytics"
  | "listAssets"
  | "getAssetContext"
  | "getGenerationProvenance"
  | "createContentProposal"
  | "getContentProposal"
  | "listContentProposals"
  | "registerExternalArtifact"
  | "listProposalArtifacts"
  | "operationsWorkspaceListFiles"
  | "operationsWorkspaceGetFile"
  | "findComparableVideos"
  | "listAssetPerformance"
>;

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type McpToolHandlers = {
  writeContext: () => Promise<ToolResponse>;
  writeChannelList: (input: unknown) => Promise<ToolResponse>;
  writeChannelSelect: (input: unknown) => Promise<ToolResponse>;
  whoami: () => Promise<ToolResponse>;
  authUserSelect: (input: unknown) => Promise<ToolResponse>;
  list: (input: unknown) => Promise<ToolResponse>;
  transcript: (input: unknown) => Promise<ToolResponse>;
  preview: (input: unknown) => Promise<ToolResponse>;
  apply: (input: unknown) => Promise<ToolResponse>;
  playlistList: (input: unknown) => Promise<ToolResponse>;
  playlistCreate: (input: unknown) => Promise<ToolResponse>;
  playlistDelete: (input: unknown) => Promise<ToolResponse>;
  playlistUpdate: (input: unknown) => Promise<ToolResponse>;
  playlistAddVideos: (input: unknown) => Promise<ToolResponse>;
  playlistRemoveVideos: (input: unknown) => Promise<ToolResponse>;
  changesetList: (input: unknown) => Promise<ToolResponse>;
  changesetGet: (input: unknown) => Promise<ToolResponse>;
  localizationImportPreview: (input: unknown) => Promise<ToolResponse>;
  changesetCreateFromImport: (input: unknown) => Promise<ToolResponse>;
  batchList: (input: unknown) => Promise<ToolResponse>;
  batchGet: (input: unknown) => Promise<ToolResponse>;
  channelSync: (input: unknown) => Promise<ToolResponse>;
  channelList: (input: unknown) => Promise<ToolResponse>;
  channelVideoList: (input: unknown) => Promise<ToolResponse>;
  analyticsList: (input: unknown) => Promise<ToolResponse>;
  analyticsOverview: (input: unknown) => Promise<ToolResponse>;
  analyticsDataQuality: (input: unknown) => Promise<ToolResponse>;
  analyticsComparableAge: (input: unknown) => Promise<ToolResponse>;
  analyticsWeeklyReportsList: (input: unknown) => Promise<ToolResponse>;
  analyticsWeeklyReportGet: (input: unknown) => Promise<ToolResponse>;
  aiLocalizationGenerate: (input: unknown) => Promise<ToolResponse>;
  aiLocalizationCreateChangeSet: (input: unknown) => Promise<ToolResponse>;
  agentLocalizationProposeLanguageMove: (input: unknown) => Promise<ToolResponse>;
  agentGetCapabilities: (input: unknown) => Promise<ToolResponse>;
  agentGetChannelContext: (input: unknown) => Promise<ToolResponse>;
  agentGetVideoContext: (input: unknown) => Promise<ToolResponse>;
  agentQueryChannelAnalytics: (input: unknown) => Promise<ToolResponse>;
  agentQueryChannelReach: (input: unknown) => Promise<ToolResponse>;
  agentGetReportingStatus: (input: unknown) => Promise<ToolResponse>;
  agentGetReportingTrafficSources: (input: unknown) => Promise<ToolResponse>;
  agentGetPublishingCalendar: (input: unknown) => Promise<ToolResponse>;
  agentGetVideoMilestones: (input: unknown) => Promise<ToolResponse>;
  agentGetStoredBreakdowns: (input: unknown) => Promise<ToolResponse>;
  agentGetStoredSearchTerms: (input: unknown) => Promise<ToolResponse>;
  agentGetStoredSuggestedSources: (input: unknown) => Promise<ToolResponse>;
  agentGetExperimentResults: (input: unknown) => Promise<ToolResponse>;
  agentGetVideoComments: (input: unknown) => Promise<ToolResponse>;
  agentQueryChannelBreakdown: (input: unknown) => Promise<ToolResponse>;
  agentQueryVideoAnalytics: (input: unknown) => Promise<ToolResponse>;
  agentListAssets: (input: unknown) => Promise<ToolResponse>;
  agentGetAssetContext: (input: unknown) => Promise<ToolResponse>;
  agentGetGenerationProvenance: (input: unknown) => Promise<ToolResponse>;
  agentCreateContentProposal: (input: unknown) => Promise<ToolResponse>;
  agentGetContentProposal: (input: unknown) => Promise<ToolResponse>;
  agentListContentProposals: (input: unknown) => Promise<ToolResponse>;
  agentRegisterExternalArtifact: (input: unknown) => Promise<ToolResponse>;
  agentListProposalArtifacts: (input: unknown) => Promise<ToolResponse>;
  agentListOperationsFiles: (input: unknown) => Promise<ToolResponse>;
  agentGetOperationsFile: (input: unknown) => Promise<ToolResponse>;
  agentFindComparableVideos: (input: unknown) => Promise<ToolResponse>;
  agentListAssetPerformance: (input: unknown) => Promise<ToolResponse>;
  queryCompetitors: (input: unknown) => Promise<ToolResponse>;
  queryMarketIntelligence: (input: unknown) => Promise<ToolResponse>;
  agentListMarketRecords: (input: unknown) => Promise<ToolResponse>;
  agentCreateMarketResearchRequest: (input: unknown) => Promise<ToolResponse>;
  agentCreateCollectionRequest: (input: unknown) => Promise<ToolResponse>;
  agentGetCollectionRequest: (input: unknown) => Promise<ToolResponse>;
  agentGetCollectionLimits: (input: unknown) => Promise<ToolResponse>;
  agentListHypotheses: (input: unknown) => Promise<ToolResponse>;
  agentGetHypothesisTrail: (input: unknown) => Promise<ToolResponse>;
  createExperimentProposal: (input: unknown) => Promise<ToolResponse>;
  agentGetChannelWorkspace: (input: unknown) => Promise<ToolResponse>;
  agentListLogicalPaths: (input: unknown) => Promise<ToolResponse>;
  agentGetLogicalPath: (input: unknown) => Promise<ToolResponse>;
  agentExportResearchData: (input: unknown) => Promise<ToolResponse>;
  queryMarketOverview: (input: unknown) => Promise<ToolResponse>;
  // Phase 14 slice 5 -- remote media generation.
  agentListMediaTemplates: (input: unknown) => Promise<ToolResponse>;
  agentRequestMediaSession: (input: unknown) => Promise<ToolResponse>;
  agentGetMediaSession: (input: unknown) => Promise<ToolResponse>;
  agentGetMediaLimits: (input: unknown) => Promise<ToolResponse>;
  agentCreateMediaJob: (input: unknown) => Promise<ToolResponse>;
  agentGetMediaJob: (input: unknown) => Promise<ToolResponse>;
  agentCancelMediaJob: (input: unknown) => Promise<ToolResponse>;
  agentReleaseMediaSession: (input: unknown) => Promise<ToolResponse>;
  agentListGenerationPlans: (input: unknown) => Promise<ToolResponse>;
  agentGetGenerationPlan: (input: unknown) => Promise<ToolResponse>;
};

function toolErrorResult(error: unknown) {
  // Structural check: the media core lives on globalThis and may throw another bundle's DomainError class (slice 6).
  if (isDomainError(error)) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          }),
        },
      ],
      isError: true,
    };
  }

  // OperationLockError / RecoveryModeError (src/lib/operation-lock, src/lib/device-handoff)
  // carry the same stable {code, message, details} shape without being a DomainError instance
  // (a deliberately separate error class, AGENTS.md §D). Checked by explicit `instanceof`
  // against exactly these two known classes -- NOT "any object with a string .code property",
  // which would also match a raw libsql driver error (e.g. SQLITE_BUSY) or a Node `fs` error
  // and echo its internal detail as if it were a stable, documented error code (found by
  // independent review).
  if (error instanceof OperationLockError || error instanceof RecoveryModeError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: { code: error.code, message: error.message, details: error.details },
          }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          error: {
            code: "internal_error",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        }),
      },
    ],
    isError: true,
  };
}

function toolSuccessResult(payload: Record<string, unknown>): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** BL-161: what the Producer endpoint gives the server (`src/app/api/mcp/producer/route.ts` wires the real ones). */
export type ProducerSession = {
  tokenId: string;
  reverify(): Promise<void>;
  /** The Google account the channel is connected under on THIS device, or null when it is not connected here. */
  resolveChannelUser(channelId: string): Promise<string | null>;
  /**
   * One call-log row. `target` / `details` (a JSON string, at most 500 characters) are set only for the Producer's playlist writes:
   * which playlist, what was sent, and the counts YouTube's answer gave (owner TG 4782 review).
   */
  recordCall(entry: {
    tool: string;
    channelId: string | null;
    outcome: "ok" | "error";
    errorCode: string | null;
    target?: string | null;
    details?: string | null;
  }): Promise<void>;
  listChannels(): Promise<Array<{ channelId: string; title: string; workspace: string | null }>>;
  portfolioOverview(input: { startDate: string; endDate: string }): Promise<Record<string, unknown>>;
  /** BL-166: every connected channel's uploads in the range with their day-7 / day-28 milestones and Reach (stored data only). */
  uploadMilestones(input: { startDate: string; endDate: string }): Promise<Record<string, unknown>>;
  /** BL-214: every connected channel's live-stream summary over the range (this computer's samples and pulls only). */
  liveAnalytics(input: { startDate: string; endDate: string }): Promise<Record<string, unknown>>;
  /** BL-163: the Producer's side of the proposal store -- submit, list its own, mark read. Approving is not here (Web UI only). */
  proposals: {
    submit(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    list(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    markDone(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  /**
   * BL-239 (ADR 0059): this computer's upload queue, as the Producer controls it (`src/lib/producer-mcp-endpoint/session-deps.ts`
   * wires the publishing module's queue control; nothing in src/mcp reaches it otherwise).
   */
  uploadQueue: {
    list(): Promise<Record<string, unknown>>;
    add(input: { channelId: string; video: string; manifestSha256?: string }): Promise<Record<string, unknown>>;
    move(input: { channelId: string; uploadId: string; position: number }): Promise<Record<string, unknown>>;
    cancel(input: { channelId: string; uploadId: string }): Promise<Record<string, unknown>>;
  };
  /**
   * BL-241 (ADR 0061): the Producer's side of the clips for review -- submit, withdraw, list, get (`session-deps.ts` wires the
   * clip-reviews module's Producer surface; the owner's decision is reachable only from the Web UI).
   */
  clipReviews: {
    submit(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    withdraw(input: { channelId: string; clipId: string }): Promise<Record<string, unknown>>;
    list(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    get(input: { channelId: string; clipId: string }): Promise<Record<string, unknown>>;
  };
  /**
   * BL-272 (ADR 0076): the Producer's side of the master still images for review -- submit, withdraw, list, get (`session-deps.ts`
   * wires the image-reviews module's Producer surface; the owner's three answers are reachable only from the Web UI).
   */
  imageReviews: {
    submit(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    withdraw(input: { channelId: string; imageId: string }): Promise<Record<string, unknown>>;
    list(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    get(input: { channelId: string; imageId: string }): Promise<Record<string, unknown>>;
  };
  /**
   * BL-255 (ADR 0069): replace a video's custom thumbnail through `src/lib/video-thumbnails/` (`session-deps.ts` wires it; nothing
   * else in src/mcp reaches the writer).
   */
  thumbnails: {
    replace(input: { channelId: string; videoId: string; path: string; dryRun?: boolean }): Promise<Record<string, unknown>>;
  };
  /**
   * BL-265 (ADR 0072 §5, §8; owner TG 4578/4581): fix an uploaded video's title / description / tags from its package's current
   * manifest through `src/lib/publishing/package-metadata.ts` (video-details' writer; `session-deps.ts` wires it; nothing else in
   * src/mcp reaches it). Refuses any conflict. `localizations: true` (owner TG 4839/4842, ADR 0072 amendment) fixes the package's
   * translations instead, through `src/lib/publishing/package-localizations.ts` (the shared video translations writer).
   */
  packageMetadata: {
    update(input: { channelId: string; video: string; dryRun?: boolean; expectedManifestSha256?: string; localizations?: boolean }): Promise<Record<string, unknown>>;
  };
  /**
   * BL-269 (ADR 0074 §8, §10; owner TG 4590/4592/4660): a release package's English captions onto its uploaded video through
   * `src/lib/publishing/package-captions.ts` → `src/lib/video-captions/` (`session-deps.ts` wires it; nothing else in src/mcp
   * reaches it). `overwrite` replaces the video's one English standard track.
   */
  captions: {
    add(input: { channelId: string; video: string; dryRun?: boolean; overwrite?: boolean; expectedManifestSha256?: string; expectedTrackId?: string | null }): Promise<Record<string, unknown>>;
  };
  /**
   * BL-267 (ADR 0073 §5, owner TG 4630/4636): the weekly plan's Producer surface (`session-deps.ts` wires the composition's): the
   * template read and proposal, plan reads, and the immediate move. No approve, veto or template decision.
   */
  plans: {
    templateGet(input: { channelId: string }): Promise<Record<string, unknown>>;
    templatePropose(input: { channelId: string; template: unknown }): Promise<Record<string, unknown>>;
    get(input: { channelId: string; weekStart: string }): Promise<Record<string, unknown>>;
    list(input: { channelId: string; limit?: number }): Promise<Record<string, unknown>>;
    move(input: { channelId: string; slotId: string; contentHash: string; toWeekStart: string; date: string; publishAt: string; dryRun?: boolean }): Promise<Record<string, unknown>>;
  };
  /**
   * BL-271 (WAIT_TOOLS_PLAN.md §3.2, ADR 0075): the wait core (`session-deps.ts` gets it from the route, composed in
   * `@/composition/wait-targets`). The Producer's tool lets through only `upload` and `restart`; its scope is null (every channel's
   * uploads, as producer_upload_queue_list shows them).
   */
  wait: {
    waitFor(input: unknown, scope: { channelId: string | null }): Promise<Record<string, unknown>>;
  };
  /**
   * Package playlists (owner TG 4858/4859): which playlists of its channel a video is in (`session-deps.ts` wires
   * `src/lib/video-playlist-membership/`); read-only, scoped to a channel connected here and a video of that channel.
   */
  videoPlaylists: {
    get(input: { channelId: string; videoId: string; refresh?: boolean }): Promise<Record<string, unknown>>;
  };
  /**
   * BL-279 (owner TG 4963/4964, ADR 0072 amendment 2): the category of the channel's package-uploaded videos set to its saved
   * publishing setting through `src/lib/publishing/package-category.ts` (video-details' writer; `session-deps.ts` wires it).
   */
  videoCategory: {
    fix(input: { channelId: string; dryRun?: boolean; videoIds?: string[]; expectedCategoryId?: string }): Promise<Record<string, unknown>>;
  };
  /** BL-279: the channel's videos' publishing fields on YouTube against its settings (`src/lib/publishing/video-publishing-check.ts`); read-only. */
  publishingCheck: {
    check(input: { channelId: string; videoIds?: string[]; captions?: boolean }): Promise<Record<string, unknown>>;
  };
};

/** A real calendar date as YYYY-MM-DD (`calendarDateSchema`, shared with the analytics module's tool inputs). */
const ISO_DATE = calendarDateSchema;

// BL-163 (FO-REQ-0014 §C): the proposal tools' inputs are the proposal service's own schemas (one definition, no drift); `payload`
// is checked per kind by the service.
export const producerProposeInputSchema = submitProducerProposalInputSchema;
export const producerListProposalsInputSchema = listProducerProposalsInputSchema;
export const producerMarkProposalsDoneInputSchema = markProposalsDoneInputSchema;

/** BL-166: the Producer's upload milestones -- the same date rules as the portfolio overview, at most 92 days (one answer lists every upload). */
export const producerUploadMilestonesInputSchema = z
  .object({ startDate: ISO_DATE, endDate: ISO_DATE })
  .strict()
  .refine((input) => input.startDate <= input.endDate, { message: "startDate must not be after endDate" })
  .refine((input) => Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`) <= 91 * 24 * 60 * 60_000, {
    message: "at most 92 days",
  });

export const producerPortfolioOverviewInputSchema = z
  .object({ startDate: ISO_DATE, endDate: ISO_DATE })
  .strict()
  .refine((input) => input.startDate <= input.endDate, { message: "startDate must not be after endDate" })
  .refine((input) => Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`) <= 365 * 24 * 60 * 60_000, {
    message: "at most 366 days",
  });

/**
 * BL-241 (ADR 0061): the Producer's clip review tools' inputs. Plain shapes here (the MCP layer lists them); the clip-reviews module
 * checks them again with its own schemas (trimming, control characters, the limits) and the rules beyond the shape.
 */
const producerClipChannelId = z.string().min(1).max(64).describe("The channel of the clip (one of producer_list_channels).");
const producerClipId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).describe("The clip's id (clipId from producer_clip_review_submit or _list).");
export const producerClipReviewSubmitInputSchema = z
  .object({
    channelId: producerClipChannelId,
    sceneId: z.string().min(1).max(80).describe("A short label of the scene, e.g. bar-night (1-80 characters); a reworked clip of the same scene uses the same label."),
    clipPath: z
      .string()
      .min(1)
      .max(500)
      .describe("The clip's file, relative to the channel's workspace folder, '/' between folders, e.g. '03 Images/Scenes/bar-night/preview_30s.mp4'."),
    note: z.string().min(1).max(2000).describe("What changed / what to look at (1-2000 characters)."),
    startSec: z.number().finite().min(0).optional().describe("Optional: where the owner's player starts, in seconds."),
    endSec: z.number().finite().min(0).optional().describe("Optional: where the owner's player stops, in seconds."),
    approvedImageId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/)
      .optional()
      .describe("Optional (1.28.0): the imageId of the approved master still (producer_image_review_*) this clip was made from -- an image of the same channel the owner approved, with or without a note."),
  })
  .strict();
export const producerClipReviewListInputSchema = z
  .object({
    channelId: producerClipChannelId,
    status: z.enum(["pending", "approved", "returned", "withdrawn"]).optional(),
    limit: z.number().int().min(1).max(200).optional().describe("At most this many clips (default 50)."),
  })
  .strict();
export const producerClipReviewOneInputSchema = z.object({ channelId: producerClipChannelId, clipId: producerClipId }).strict();

/**
 * BL-272 (ADR 0076): the Producer's image review tools' inputs. Plain shapes here (the MCP layer lists them); the image-reviews
 * module checks them again with its own schemas (trimming, control characters, the limits) and the rules beyond the shape.
 */
const producerImageChannelId = z.string().min(1).max(64).describe("The channel of the image (one of producer_list_channels).");
const producerImageId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).describe("The image's id (imageId from producer_image_review_submit or _list).");
const producerImageKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
export const producerImageReviewSubmitInputSchema = z
  .object({
    channelId: producerImageChannelId,
    sceneId: z.string().min(1).max(80).describe("The scene the image is the master still of, e.g. P46 (1-80 characters); a reworked image of the same scene uses the same label."),
    imagePath: z
      .string()
      .min(1)
      .max(500)
      .describe("The image file, relative to the channel's workspace folder, '/' between folders, e.g. '03 Images/Scenes/P46/master.png'. PNG or JPEG."),
    note: z.string().min(1).max(2000).optional().describe("Optional: what to look at (1-2000 characters)."),
    batchId: producerImageKey.optional().describe("Optional: submits sharing a batchId are one batch -- the owner sees them as one grid (at most 40 images per batch)."),
    requestId: producerImageKey.optional().describe("Optional idempotency key: a retry with the same requestId answers the stored image (replayed: true); the same requestId for a different request is refused."),
  })
  .strict();
export const producerImageReviewListInputSchema = z
  .object({
    channelId: producerImageChannelId,
    status: z.enum(["pending", "approved", "approved_with_note", "returned", "withdrawn"]).optional(),
    batchId: producerImageKey.optional().describe("Only this batch's images."),
    limit: z.number().int().min(1).max(200).optional().describe("At most this many images (default 50)."),
  })
  .strict();
export const producerImageReviewOneInputSchema = z.object({ channelId: producerImageChannelId, imageId: producerImageId }).strict();

/** BL-239 (ADR 0059): the Producer's upload queue tools' inputs. */
const producerQueueChannelId = z.string().min(1).max(64).describe("The channel of the upload (one of producer_list_channels).");
const producerQueueUploadId = z.string().min(1).max(64).describe("The upload's id (uploadId from producer_upload_queue_list).");
export const producerUploadQueueAddInputSchema = z
  .object({
    channelId: producerQueueChannelId,
    video: z.string().min(1).max(32).describe("The release's video code as in its package, e.g. V61 or S14 (a Short)."),
    manifestSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("Optional: the manifest's SHA-256 you mean; refused (upload_package_changed) when the package on disk is another version."),
  })
  .strict();
export const producerUploadQueueMoveInputSchema = z
  .object({ channelId: producerQueueChannelId, uploadId: producerQueueUploadId, position: z.number().int().min(1).describe("The new place, 1 = starts next; past the end = the end.") })
  .strict();
export const producerUploadQueueCancelInputSchema = z.object({ channelId: producerQueueChannelId, uploadId: producerQueueUploadId }).strict();
// BL-255 (ADR 0069): the thumbnail writer's input; every rule (path under 04 Videos/, image, size) is checked again by the module.
// BL-267 (ADR 0073 §5, plan §3.10): the Producer's weekly-plan tools.
export const producerTemplateGetInputSchema = z.object({ channelId: producerQueueChannelId }).strict();
export const producerTemplateProposeInputSchema = z.object({ channelId: producerQueueChannelId, template: z.record(z.string(), z.unknown()).describe("A week-template/1 object (format, channelId, horizonWeeks, displayTimeZone?, days).") }).strict();
export const producerPlanGetInputSchema = z.object({ channelId: producerQueueChannelId, weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
export const producerPlanListInputSchema = z.object({ channelId: producerQueueChannelId, limit: z.number().int().min(1).max(52).optional() }).strict();
export const producerPlanMoveInputSchema = z
  .object({
    channelId: producerQueueChannelId,
    slotId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/).describe("The slot's contentHash as producer_publishing_plan_get showed it."),
    toWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The target week's Monday."),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    publishAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe("Local wall time in the target plan's zone (the source plan's zone when the target week has no plan)."),
    dryRun: z.boolean().optional(),
  })
  .strict();

/** BL-279 (owner TG 4963/4964): `producer_video_category_fix`'s input -- no category of the caller's: only the channel's saved one is written. */
export const producerVideoCategoryFixInputSchema = z
  .object({
    channelId: producerQueueChannelId,
    dryRun: z.boolean().optional().describe("true: the list of the channel's package-uploaded videos with their category now and what would be written -- no backup and no write. Call it first."),
    videoIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{11}$/)).min(1).max(200).optional().describe("Optional (apply only): only these of the dry run's videos; each must be a video a release package of the channel uploaded."),
    expectedCategoryId: z.string().regex(/^\d{1,3}$/).optional().describe("Required to apply (not on dryRun): the dry run's targetCategoryId; refused (publishing_settings_changed) when the saved category changed since."),
  })
  .strict();

/** BL-279 (owner TG 4964): `producer_video_publishing_check`'s input. */
export const producerVideoPublishingCheckInputSchema = z
  .object({
    channelId: z.string().min(1).max(64).describe("The channel (one of producer_list_channels)."),
    videoIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{11}$/)).min(1).max(200).optional().describe("Optional: these videos; absent: every video a release package of the channel put on YouTube (at most 200)."),
    captions: z.boolean().optional().describe("true: also read each video's caption tracks (50 units a video; at most 50 videos per call)."),
  })
  .strict();

/** Package playlists (owner TG 4858/4859): `producer_video_playlists`' input. */
export const producerVideoPlaylistsInputSchema = z
  .object({
    channelId: z.string().min(1).max(64).describe("The video's channel (one of producer_list_channels)."),
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).describe("The YouTube video id."),
    refresh: z.boolean().optional().describe("true: read YouTube now instead of an answer kept up to 10 minutes."),
  })
  .strict();

export const producerVideoThumbnailReplaceInputSchema = z
  .object({
    channelId: producerQueueChannelId,
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).describe("The YouTube video id."),
    path: z.string().min(1).max(1000).describe("The image, relative to the channel's workspace, under 04 Videos/ (e.g. 04 Videos/11 November/1115 V91/Thumbnail_V91_logo.jpg)."),
    dryRun: z.boolean().optional().describe("true: every read and check, no backup and no write."),
  })
  .strict();

// BL-265 (ADR 0072 §5): the packaging fix's input -- the package's own values only (no text of the caller's is ever written).
export const producerVideoCaptionsAddInputSchema = z
  .object({
    channelId: producerQueueChannelId,
    video: z.string().min(1).max(32).describe("The release's video code as in its package, e.g. V27 (a long, horizontal video); its upload record names the video on YouTube."),
    dryRun: z.boolean().optional().describe("true: every read and check, the track an overwrite would replace and the units -- no download, backup or write. Call it first."),
    overwrite: z.boolean().optional().describe("true: replace the video's one English standard caption track (foreign or the app's own) with the package's captions (captions.update, ~800 units). Without it an existing English track refuses."),
    expectedManifestSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("Optional: the manifestSha256 your dry run showed; refused (package_metadata_manifest_changed) when the package was re-packaged since."),
    expectedTrackId: z.string().min(1).max(200).nullable().optional().describe("Optional: target.trackId your dry run showed (null: none, an insert); refused (captions_track_changed) when the video's tracks changed since."),
  })
  .strict();

export const producerVideoMetadataUpdateInputSchema = z
  .object({
    channelId: producerQueueChannelId,
    video: z.string().min(1).max(32).describe("The release's video code as in its package, e.g. V61 or S14 (a Short); its upload record names the video on YouTube."),
    dryRun: z.boolean().optional().describe("true: every read and check and the three-way diff, no backup and no write. Call it first."),
    expectedManifestSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("Optional: the manifestSha256 your dry run showed; refused (package_metadata_manifest_changed) when the package was re-packaged since."),
    localizations: z
      .boolean()
      .optional()
      .describe("1.31.0: true -- this call fixes the package's TRANSLATIONS (per-language title/description from its manifest's `localizations`) instead of the default-language title/description/tags; one YouTube write per call, so fix the texts and the translations in two calls."),
  })
  .strict();

/** The error code of a tool error answer, or null. */
function toolErrorCode(result: ToolResponse): string | null {
  try {
    const parsed = JSON.parse(result.content[0]?.text ?? "") as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}

/** Owner TG 4782 review: the counts a playlist add / remove answered with (attempted, added; requested, removed), for its log row. */
function playlistWriteCounts(result: ToolResponse): Record<string, number> {
  const answer = result.isError ? undefined : (result.structuredContent as Record<string, unknown> | undefined);
  const counts: Record<string, number> = {};
  for (const key of ["attempted", "added", "requested", "removed"]) {
    if (typeof answer?.[key] === "number") counts[key] = answer[key] as number;
  }
  return counts;
}

/** BL-161 (AC-PR-06): every Producer answer names the channel it is for, as `forChannelId` (a tool's own `channelId` may mean
 * another channel, e.g. a watchlist entry's). */
function withForChannel(result: ToolResponse, channelId: string): ToolResponse {
  if (result.structuredContent) {
    const payload = { ...result.structuredContent, forChannelId: channelId };
    return { ...result, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  }
  try {
    const parsed = JSON.parse(result.content[0]?.text ?? "") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...result, content: [{ type: "text", text: JSON.stringify({ ...(parsed as Record<string, unknown>), forChannelId: channelId }) }] };
    }
  } catch {
    // not JSON: left as it is
  }
  return result;
}

function mapValidationErrorResult(error: z.ZodError): ToolResponse {
  return toolErrorResult(
    new DomainError({
      code: "validation_failed",
      message: "Invalid MCP tool input",
      details: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    })
  );
}

export const credentialSchema = z.union([
  z.object({ userId: z.string().min(1) }).strict(),
  z
    .object({
      accessToken: z.string().min(1),
      refreshToken: z.string().optional(),
      tokenExpiry: z.number().int().positive().optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

export const listInputSchema = z
  .object({
    credentialRef: credentialSchema.optional(),
    channelId: z.string().min(1).optional(),
    maxResults: z.number().int().positive().max(50).optional(),
  })
  .strict();

export const transcriptInputSchema = z
  .object({
    credentialRef: credentialSchema.optional(),
    videoId: z.string().min(1),
  })
  .strict();

export const previewInputSchema = z
  .object({
    credentialRef: credentialSchema.optional(),
    videoId: z.string().min(1),
    editorialPrompt: z.string().min(1),
  })
  .strict();

/** BL-215: `agent_list_worker_actions`. */
const agentListWorkerActionsInputSchema = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict();
// BL-220 (RESTART_WHEN_IDLE_PLAN.md): the bounds (1-60 minutes, a 1-200 character reason) are the module's own (validation_failed).
const agentHoldRestartInputSchema = z.object({ minutes: z.number(), reason: z.string() }).strict();
const agentReleaseHoldInputSchema = z.object({ holdId: z.string() }).strict();
/** BL-220: a status poll is not counted as an MCP call, so polling it never keeps the restart's quiet window open. */
// BL-271 (ADR 0075): agent_wait neither (and producer_wait in the Producer's wrapper) -- a long or repeated wait never keeps it open.
const UNCOUNTED_CHANNEL_TOOLS: ReadonlySet<string> = new Set(["agent_restart_status", "agent_wait"]);
/** BL-271: the Producer's only call that is not counted as MCP activity (its call log still records it). */
const UNCOUNTED_PRODUCER_TOOLS: ReadonlySet<string> = new Set(["producer_wait"]);

export const applyInputSchema = z
  .object({
    credentialRef: credentialSchema.optional(),
    videoId: z.string().min(1),
    finalTitle: z.string().min(1),
    description: z.string().min(1),
    expectedChannelId: z.string().min(1),
    dryRun: z.boolean().optional(),
  })
  .strict();

export const writeChannelListInputSchema = z
  .object({
    credentialRef: credentialSchema.optional(),
  })
  .strict();

export const writeChannelSelectInputSchema = z
  .object({
    credentialRef: credentialSchema.optional(),
    channelId: z.string().min(1),
  })
  .strict();

export const authUserSelectInputSchema = z
  .object({
    userId: z.string().min(1),
  })
  .strict();

// Phase 7 slice 1: batches has no existing exported Zod schema for its read-only
// list/get operations (unlike changesets) -- `listBatchesByChannel`/`requireBatchForChannel`
// take plain typed args, validated by the Web UI's API route inline. These two schemas are
// the MCP-boundary equivalent of that same inline validation, not a new pattern.
export const batchListInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

export const batchGetInputSchema = z
  .object({
    channelId: z.string().min(1),
    batchId: z.string().min(1),
  })
  .strict();

// base64 length bound is a defensive pre-decode guard only -- `previewImport`'s own
// MAX_WORKBOOK_BYTES check (src/lib/changesets/import.ts) is the real enforcement. Base64
// inflates size by ~4/3, so this generously covers a 25MB workbook with room to spare.
export const localizationImportPreviewInputSchema = z
  .object({
    channelId: z.string().min(1),
    filename: z.string().min(1),
    fileBase64: z.string().min(1).max(34_000_000),
  })
  .strict();

const playlistUpdateToolInputSchema = z
  .object({
    credentialRef: credentialSchema.optional(),
    playlistId: z.string().min(1),
    expectedChannelId: z.string().min(1),
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    privacyStatus: z.enum(["private", "public", "unlisted"]).optional(),
  })
  .strict()
  .refine(
    (payload) =>
      payload.title !== undefined ||
      payload.description !== undefined ||
      payload.privacyStatus !== undefined,
    {
      message: "At least one mutable field is required: title, description or privacyStatus",
      path: ["title"],
    }
  );

// Phase 9 slice 4 -- `query_competitors` takes no parameters (a plain roster read); `.strict()` so
// an unexpected field is rejected loudly, matching every other input schema in this codebase.
const queryCompetitorsInputSchema = z.object({}).strict();

// Phase 9 slice 9G, part A -- one list tool with a `kind` discriminator, rather than three
// separate thin tools (owner spec §28: "prefer a small number of powerful composable MCP tools").
const agentListMarketRecordsInputSchema = z
  .object({ kind: z.enum(["topics", "trend_candidates", "discovery_candidates"]) })
  .strict();

export function createMcpToolHandlers(
  core: VideoMetadataCoreSubset & PlaylistManagementCoreSubset,
  auth: {
    resolveEffectiveCredentialRef: CliAuthService["resolveEffectiveCredentialRef"];
    whoami: () => Promise<unknown>;
    selectUser: (args: { userId: string }) => Promise<unknown>;
    listKnownWriteChannels: (args?: { credentialRef?: CredentialRef }) => Promise<unknown>;
    selectWriteChannel: (args: { channelId: string; credentialRef?: CredentialRef }) => Promise<unknown>;
  } = createCliAuthService(),
  // Separate parameter (not merged into `core`) so every existing call site -- callers
  // that only care about video-metadata/playlist tools -- is unaffected; only tests that
  // actually exercise changeset_*/batch_* need to pass a fake here.
  operationsCore: ChangeSetCoreSubset & BatchCoreSubset = {
    ...createChangeSetCore(),
    ...createBatchCore(),
  },
  channelSyncCore: ChannelSyncCoreSubset = createChannelSyncCore(),
  channelAccessCore: ChannelAccessCore = createChannelAccessCore(),
  analyticsCore: AnalyticsCoreSubset = createAnalyticsCore(),
  aiLocalizationCore: AiLocalizationCoreSubset = createAiLocalizationCore(),
  agentOperationsCore: AgentOperationsCoreSubset = createAgentOperationsCore(),
  marketIntelligenceCore: MarketIntelligenceCoreSubset = createMarketIntelligenceCore(),
  decisionEngineCore: DecisionEngineCoreSubset = createDecisionEngineCore(),
  // Phase 11 (docs/roadmap/plans/PHASE_11_PLAN.md) -- registered directly here, not through
  // `agentOperationsCore`, for the same module-independence reason as `marketIntelligenceCore`
  // above. Read-only subset on purpose: `setWorkspace` is operator-only (`/api/channel-workspaces`)
  // and is deliberately NOT reachable from any MCP tool (AC-P11-10).
  channelWorkspacesCore: Pick<ChannelWorkspacesCore, "getWorkspace"> = createChannelWorkspacesCore(),
  // Phase 12 slice 12.4 (owner decision D1) -- per-channel assignment of the global market records
  // above. Agent-confinement subset only; assigning is operator-only (Web UI).
  marketAssignmentCore: Pick<MarketAssignmentCore, "filterForAgent" | "assertAvailableToAgent" | "recordAgentOwnership"> = createMarketAssignmentCore(),
  // BL-114 (ADR 0014) -- thumbnail impressions/CTR from the Reporting API, registered directly here (not through
  // `agentOperationsCore`) so `agent-operations` and `analytics` gain no dependency on it (AGENTS.md §M). Read-only
  // subset: the sync that talks to Google is the app's own (dashboard/Sync now), never an agent tool.
  // `getReachStatus` (BL-181) is optional only so older test doubles that read Reach data still type-check; production passes the core.
  reachReportsCore: Pick<ReachReportsCore, "getChannelReach"> & Partial<Pick<ReachReportsCore, "getReachStatus" | "getReportingTrafficSources">> = createReachReportsCore(),
  // BL-118 -- the channel breakdown (traffic sources, devices, ...) the Content tab already computes; a LIVE Analytics API read.
  breakdownCore: Pick<AnalyticsCore, "getChannelBreakdown"> = createAnalyticsCore(),
  // Research export (ADR 0019) -- the Manager writes flat CSV/JSON files into the channel's workspace `99 Data Exchange/From YTM/` folder (fixed name, owner-approved exception).
  researchExportCore: Pick<ResearchExportCore, "exportResearchData" | "listResearchOverview"> = createResearchExportCore(),
  // Phase 14 slice 5 -- registered directly here (AGENTS.md §M: agent-operations gains no dependency on it). Request/read/job subset only:
  // approving, starting and stopping a session are Web-only (session-approval-inventory.test.ts).
  // The in-app MCP endpoint (ADR 0013) runs INSIDE the web process: the shared background core polls the agent's job at
  // once (and its first poll counts as session activity), exactly like a job from the Settings UI.
  mediaGenerationCore: MediaGenerationCoreSubset = createMediaGenerationCore(),
  // Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F4) -- the logical path registry, registered directly
  // here (not through `agentOperationsCore`, AGENTS.md §M). Read-only subset, fixed to the `channel` scope: a channel agent can only
  // ever see `all_agents` paths. Creating, changing or deleting a path is operator-only (`/api/logical-paths`).
  logicalPathsCore: Pick<LogicalPathsCore, "readPath" | "listReadable"> = createLogicalPathsCore(),
  // BL-143 phase 3 (ADR 0029) -- generation plans, registered directly here (AGENTS.md §M). Read-only subset: plans are created
  // and run by the Factory Operator; a channel agent only reads its own channel's.
  generationPlansCore: Pick<GenerationPlanServices, "listPlans" | "getPlan"> = createGenerationPlansCore(),
  // BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md) -- an experiment's videos by arm with their stored values; its own module composing
  // the decision engine with analytics and Reach (AGENTS.md §M). Read-only.
  experimentResultsCore: Pick<ExperimentResultsCore, "getExperimentResults"> = createExperimentResultsCore(),
  // BL-171 (docs/roadmap/plans/VIDEO_COMMENTS_PLAN.md) -- the stored comments of the channel's own videos; its own module. Read-only.
  videoCommentsCore: Pick<VideoCommentsCore, "listStoredComments"> = createVideoCommentsCore(),
  // BL-182 stage 1 (FO-REQ-0023 §4 C4) -- the publishing calendar, a local read; registered directly (AGENTS.md §M).
  publishingCalendarCore: Pick<PublishingCalendarCore, "getAgentCalendar"> = createPublishingCalendarCore({ dailyCoverage: dailyPublishingCoverage })
) {
  async function resolveCredentialRef(explicitCredentialRef: unknown) {
    return auth.resolveEffectiveCredentialRef({
      explicit: explicitCredentialRef as CredentialRef | undefined,
    });
  }

  function getCredentialUserId(credentialRef: CredentialRef): string | null {
    return "userId" in credentialRef ? credentialRef.userId : null;
  }

  const handlers: McpToolHandlers = {
    async writeContext(): Promise<ToolResponse> {
      try {
        const result = await auth.whoami();
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async writeChannelList(input: unknown): Promise<ToolResponse> {
      const parsedInput = writeChannelListInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const result = await auth.listKnownWriteChannels({
          credentialRef: parsedInput.data.credentialRef as CredentialRef | undefined,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async writeChannelSelect(input: unknown): Promise<ToolResponse> {
      const parsedInput = writeChannelSelectInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const result = await auth.selectWriteChannel({
          credentialRef: parsedInput.data.credentialRef as CredentialRef | undefined,
          channelId: parsedInput.data.channelId,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async whoami(): Promise<ToolResponse> {
      try {
        const result = await auth.whoami();
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async authUserSelect(input: unknown): Promise<ToolResponse> {
      const parsedInput = authUserSelectInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const result = await auth.selectUser({
          userId: parsedInput.data.userId,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        if (error instanceof DomainError && error.code === "AUTH_USER_NOT_FOUND") {
          return toolErrorResult(error);
        }

        return toolErrorResult(error);
      }
    },

    async list(input: unknown): Promise<ToolResponse> {
      const parsedInput = listInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.listVideos({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async transcript(input: unknown): Promise<ToolResponse> {
      const parsedInput = transcriptInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.getTranscript({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async preview(input: unknown): Promise<ToolResponse> {
      const parsedInput = previewInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.previewMetadata({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async apply(input: unknown): Promise<ToolResponse> {
      const parsedInput = applyInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.applyMetadata({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async playlistList(input: unknown): Promise<ToolResponse> {
      const parsedInput = playlistListInputSchema
        .partial({ credentialRef: true })
        .safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.listPlaylists({ credentialRef });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async playlistCreate(input: unknown): Promise<ToolResponse> {
      const parsedInput = playlistCreateInputSchema
        .partial({ credentialRef: true })
        .safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.createPlaylist({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async playlistDelete(input: unknown): Promise<ToolResponse> {
      const parsedInput = playlistDeleteInputSchema
        .partial({ credentialRef: true })
        .safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.deletePlaylist({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async playlistUpdate(input: unknown): Promise<ToolResponse> {
      const parsedInput = playlistUpdateToolInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.updatePlaylist({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async playlistAddVideos(input: unknown): Promise<ToolResponse> {
      const parsedInput = playlistAddVideosInputSchema
        .partial({ credentialRef: true })
        .safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.addVideosToPlaylist({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async playlistRemoveVideos(input: unknown): Promise<ToolResponse> {
      const parsedInput = playlistRemoveVideosInputSchema
        .partial({ credentialRef: true })
        .safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await core.removeVideosFromPlaylist({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async changesetList(input: unknown): Promise<ToolResponse> {
      const parsedInput = listChangeSetsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const changeSets = await operationsCore.listChangeSets(parsedInput.data);
        return toolSuccessResult({ changeSets });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async changesetGet(input: unknown): Promise<ToolResponse> {
      const parsedInput = getChangeSetInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await operationsCore.getChangeSet(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async localizationImportPreview(input: unknown): Promise<ToolResponse> {
      const parsedInput = localizationImportPreviewInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const buffer = Buffer.from(parsedInput.data.fileBase64, "base64");
        const result = await operationsCore.previewImport({
          channelId: parsedInput.data.channelId,
          filename: parsedInput.data.filename,
          buffer,
        });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    // Mutating (persists a new Change Set + Change rows) -- unlike localizationImportPreview
    // above, wrapped by the device-availability gate below, same treatment as channelSync.
    // Never reaches YouTube: createChangeSetFromImport is the exact same local-persistence
    // path the Web UI's POST .../localizations/import route already uses.
    async changesetCreateFromImport(input: unknown): Promise<ToolResponse> {
      const parsedInput = localizationImportPreviewInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const buffer = Buffer.from(parsedInput.data.fileBase64, "base64");
        const result = await operationsCore.createChangeSetFromImport({
          channelId: parsedInput.data.channelId,
          filename: parsedInput.data.filename,
          buffer,
        });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async batchList(input: unknown): Promise<ToolResponse> {
      const parsedInput = batchListInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const batches = await operationsCore.listBatchesByChannel(parsedInput.data.channelId);
        return toolSuccessResult({ batches });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async batchGet(input: unknown): Promise<ToolResponse> {
      const parsedInput = batchGetInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        // AGENTS.md §F: getBatchWithLedgerRows verifies this batch actually belongs to
        // the named channel before returning anything -- the same single read the Web UI's
        // own API route and the CLI use, never a bare `getBatch(batchId)`.
        const result = await operationsCore.getBatchWithLedgerRows(parsedInput.data.channelId, parsedInput.data.batchId);
        return toolSuccessResult(result);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async channelSync(input: unknown): Promise<ToolResponse> {
      const parsedInput = syncChannelInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await channelSyncCore.syncChannel({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async channelList(input: unknown): Promise<ToolResponse> {
      const parsedInput = listChannelsInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await channelSyncCore.listChannels({ credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async channelVideoList(input: unknown): Promise<ToolResponse> {
      const parsedInput = listSyncedVideosInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await channelSyncCore.listSyncedVideos({
          ...parsedInput.data,
          credentialRef,
        });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async analyticsList(input: unknown): Promise<ToolResponse> {
      const parsedInput = listMetricsInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.listMetrics({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async analyticsOverview(input: unknown): Promise<ToolResponse> {
      const parsedInput = getChannelOverviewInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.getChannelOverview({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async analyticsDataQuality(input: unknown): Promise<ToolResponse> {
      const parsedInput = getDataQualityReportInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.getDataQualityReport({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async analyticsComparableAge(input: unknown): Promise<ToolResponse> {
      const parsedInput = getComparableAgeComparisonInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.getComparableAgeComparison({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async analyticsWeeklyReportsList(input: unknown): Promise<ToolResponse> {
      const parsedInput = listWeeklyReportsInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.listWeeklyReports({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async analyticsWeeklyReportGet(input: unknown): Promise<ToolResponse> {
      const parsedInput = getWeeklyReportInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.getWeeklyReport({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-075/BL-078: "generate proposals" step of the AI Localization workflow. Persists
     * nothing (mirrors `localizationImportPreview`'s own "preview only" classification) --
     * the mock provider makes no network call at all, and a real-connection call
     * (`connectionId` set) is gated by the service's own internal `assertDeviceAvailable`
     * check (RISK-30, `docs/TECHNICAL_DEBT.md`), not by this wrapper.
     */
    async aiLocalizationGenerate(input: unknown): Promise<ToolResponse> {
      const parsedInput = generateProposalsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await aiLocalizationCore.generateProposals(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-075/BL-078: "create Change Set" step -- hands the (possibly human-edited) reviewed
     * proposals to the exact same `createChangeSetFromGeneration` the Web UI's own
     * `POST .../ai-localization/change-sets` route calls. A real local-persistence mutation
     * (a new Change Set, `source: "ai_localization"`), so this handler is gated by
     * `assertMcpDeviceAvailable` like `changesetCreateFromImport` above. Approval, conflict
     * revalidation, Batch creation, and the live-write barrier are all completely untouched --
     * the resulting Change Set starts `pending`, exactly like every other source.
     */
    async aiLocalizationCreateChangeSet(input: unknown): Promise<ToolResponse> {
      const parsedInput = createChangeSetFromGenerationInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        // Phase 7 slice F (owner spec §22): this is the one transport an agent-operations-
        // versioned surface actually mediates, so it is the only one that stamps a real
        // `agentApiVersion` alongside `createdVia: "mcp"`.
        const result = await aiLocalizationCore.createChangeSetFromGeneration(parsedInput.data, {
          createdVia: "mcp",
          agentApiVersion: AGENT_API_VERSION,
        });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-232 (PRD-REQ-0043): a channel agent prepares the move of a localization to another language code (zh-Hans -> zh-CN) as a
     * DRAFT Change Set -- the same `changesets.proposeLanguageMove` the owner's Languages-tab button uses. Local persistence only
     * (gated like `aiLocalizationCreateChangeSet`); every change starts pending, only the owner approves and sends it in the app.
     */
    async agentLocalizationProposeLanguageMove(input: unknown): Promise<ToolResponse> {
      const parsedInput = proposeLanguageMoveInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await operationsCore.proposeLanguageMove(parsedInput.data, { createdBy: "agent" });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Phase 7 (Agent Operations Interface) slice A. Pure local read -- no channel scoping (this
     * is instance-level, not channel-level, information), no YouTube call, no credentialRef.
     */
    async agentGetCapabilities(input: unknown): Promise<ToolResponse> {
      const parsedInput = getSystemCapabilitiesInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const result = await agentOperationsCore.getSystemCapabilities(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Phase 7 slice B. Channel-scoping is checked explicitly here, mirroring `ai_localization_*`'s
     * own pattern -- `agent-operations`' own service functions carry no `credentialRef` and do no
     * such check themselves (see that module's own `getChannelContext` doc comment).
     */
    async agentGetChannelContext(input: unknown): Promise<ToolResponse> {
      const parsedInput = getChannelContextInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.getChannelContext(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Phase 11 -- the per-channel production-workspace path this device's operator set in Settings.
     * Same active-channel scoping as `agentGetChannelContext` (resolve identity, then
     * `assertActiveChannel`, before the core is ever reached). Returns the stored string only --
     * the core never touches anything at or under the workspace path, never creates the device
     * identity (review round 1), and nothing here can set or clear the path.
     */
    /**
     * Factory Operator access, F4 -- the logical path registry, channel scope. Instance-wide data (not channel data), so no
     * `assertActiveChannel`: the bound token is what authorises the call, exactly like `agentGetCapabilities`. The core is
     * pinned to the `channel` scope HERE, never taken from input, so no argument can widen what an agent sees.
     */
    async agentListLogicalPaths(input: unknown): Promise<ToolResponse> {
      const parsedInput = z.object({}).strict().safeParse(input ?? {});
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }
      try {
        return toolSuccessResult({ paths: await logicalPathsCore.listReadable("channel") });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentGetLogicalPath(input: unknown): Promise<ToolResponse> {
      const parsedInput = getLogicalPathInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }
      try {
        return toolSuccessResult(await logicalPathsCore.readPath(parsedInput.data, "channel"));
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentGetChannelWorkspace(input: unknown): Promise<ToolResponse> {
      const parsedInput = getChannelWorkspaceInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await channelWorkspacesCore.getWorkspace(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    // -- Phase 14 slice 5: remote media generation (PHASE_14_PLAN.md §2.7) ---------------------------------------------------------
    // Every tool asserts the caller's channelId is the active/bound channel first; a session/job of another channel is reported as
    // not found, never disclosed. The agent can REQUEST a session and READ it; only a human approves/starts/stops it (Servers → Sessions).

    async agentListMediaTemplates(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentListMediaTemplatesInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        return toolSuccessResult({ templates: await mediaGenerationCore.listWorkflowTemplates() });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentRequestMediaSession(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentRequestMediaSessionInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        const session = await mediaGenerationCore.requestSession({ ...parsedInput.data, requestedBy: "agent" });
        return toolSuccessResult({ session });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentGetMediaSession(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentGetMediaSessionInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        if (parsedInput.data.sessionId) {
          const session = await mediaGenerationCore.getSession({ sessionId: parsedInput.data.sessionId });
          if (session.channelId !== parsedInput.data.channelId) {
            throw new DomainError({ code: "media_session_not_found", message: "No session with this id", details: { sessionId: parsedInput.data.sessionId } });
          }
          return toolSuccessResult({ session });
        }
        // The channel filter runs in the query (not over a capped page), so a channel's sessions never vanish behind another channel's.
        const sessions = await mediaGenerationCore.listSessions(20, parsedInput.data.channelId);
        return toolSuccessResult({ sessions });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentListGenerationPlans(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentListGenerationPlansInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        const views = await generationPlansCore.listPlans({ channelId: parsedInput.data.channelId, ...(parsedInput.data.status ? { status: parsedInput.data.status } : {}) });
        return toolSuccessResult({ plans: views.filter((v) => v.plan.channelId === parsedInput.data.channelId).map(agentPlanView) });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentGetGenerationPlan(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentGetGenerationPlanInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        const notFound = () => toolErrorResult(new DomainError({ code: "plan_not_found", message: `No generation plan ${parsedInput.data.planId} for this channel`, details: { planId: parsedInput.data.planId } }));
        let view;
        try {
          // Without `since`: the newest events (the latest verdicts); with it: the page after it, with `more` and `cursor`.
          view = await generationPlansCore.getPlan(parsedInput.data.since ? { planId: parsedInput.data.planId, since: parsedInput.data.since } : { planId: parsedInput.data.planId, latest: true });
        } catch (error) {
          if (isDomainError(error) && error.code === "plan_not_found") return notFound();
          throw error;
        }
        // Another channel's plan behaves like one that does not exist.
        if (view.plan.channelId !== parsedInput.data.channelId) return notFound();
        // Error texts (a job's error, a session's failure reason) can name local paths: left out for agents.
        // BL-157 (ADR 0004/0031, review round 8): a moved plan's event names both channels -- the other one is not this
        // agent's to see, so a move reaches it without the channel ids.
        const events = view.events.map((e) => {
          const details = withoutErrorTexts(e.details) as Record<string, unknown>;
          if (e.kind !== "plan_moved") return { ...e, details };
          const { from: _from, to: _to, ...rest } = details;
          void _from;
          void _to;
          return { ...e, details: rest };
        });
        return toolSuccessResult({ plan: agentPlanView(view), events, more: view.more, cursor: view.cursor });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentGetMediaLimits(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentGetMediaLimitsInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        const limits = await mediaGenerationCore.getLimits();
        // Agent API 3.4.0 (slice 6, concurrent sessions): only THIS channel's open sessions are disclosed; another channel's
        // count only in the device-wide numbers (activeSessionCount against maxConcurrentSessions, deviceHasOpenSession).
        const openSessions = limits.openSessions.filter((s) => s.channelId === parsedInput.data.channelId);
        return toolSuccessResult({ ...limits, openSessions, openSession: openSessions[0] ?? null, deviceHasOpenSession: limits.openSessions.length > 0 });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentCreateMediaJob(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentCreateMediaJobInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        const job = await mediaGenerationCore.createJob({ ...parsedInput.data, createdBy: "agent" });
        return toolSuccessResult({ job });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentGetMediaJob(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentGetMediaJobInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        if (parsedInput.data.jobId) {
          const job = await mediaGenerationCore.getJob({ jobId: parsedInput.data.jobId });
          if (job.channelId !== parsedInput.data.channelId) {
            throw new DomainError({ code: "media_job_not_found", message: "No job with this id", details: { jobId: parsedInput.data.jobId } });
          }
          return toolSuccessResult({ job });
        }
        const jobs = await mediaGenerationCore.listJobs({ channelId: parsedInput.data.channelId, ...(parsedInput.data.sessionId ? { sessionId: parsedInput.data.sessionId } : {}) });
        return toolSuccessResult({ jobs });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentCancelMediaJob(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentCancelMediaJobInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        const existing = await mediaGenerationCore.getJob({ jobId: parsedInput.data.jobId });
        if (existing.channelId !== parsedInput.data.channelId) {
          throw new DomainError({ code: "media_job_not_found", message: "No job with this id", details: { jobId: parsedInput.data.jobId } });
        }
        return toolSuccessResult({ job: await mediaGenerationCore.cancelJob({ jobId: parsedInput.data.jobId }) });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** BL-135 (ADR 0023 amendment 2): end this channel's own session -- withdraw a pending request or stop its pod. */
    async agentReleaseMediaSession(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentReleaseMediaSessionInputSchema.safeParse(input);
      if (!parsedInput.success) return mapValidationErrorResult(parsedInput.error);
      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({ userId: getCredentialUserId(credentialRef), channelId: parsedInput.data.channelId });
        return toolSuccessResult({ session: await mediaGenerationCore.releaseSession({ sessionId: parsedInput.data.sessionId, channelId: parsedInput.data.channelId }) });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Research export (ADR 0019). Active-channel scoped like `agentGetChannelWorkspace` (the files go into THAT channel's workspace folder, which
     * the operator set; the caller picks neither folder nor file names -- the input schema is strict). Writes local files, so it passes the
     * mutation gate below like the other local writes.
     */
    async agentExportResearchData(input: unknown): Promise<ToolResponse> {
      const parsedInput = exportResearchDataInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await researchExportCore.exportResearchData(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Compact bulk read of the watchlist (research export slice 2). Global data narrowed to the caller's assignments by the same
     * `filterForAgent`/`assertAvailableToAgent` the single-channel read uses (inside the core's deps); a local read, never a live YouTube
     * call, no active-channel check -- like `queryCompetitors`.
     */
    async queryMarketOverview(input: unknown): Promise<ToolResponse> {
      const parsedInput = listResearchOverviewInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }
      try {
        const result = await researchExportCore.listResearchOverview(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** Phase 7 slice B. Same explicit channel-scoping note as `agentGetChannelContext` above. */
    async agentGetVideoContext(input: unknown): Promise<ToolResponse> {
      const parsedInput = getVideoContextInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.getVideoContext(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Slice C, owner spec §9. UNLIKE `agentGetChannelContext`/`agentGetVideoContext` above, this
     * does NOT call `channelAccessCore.assertActiveChannel` itself -- it mirrors
     * `analyticsOverview`'s own pattern instead (`credentialRef` relaxed to optional for this
     * tool's own input parse, resolved once, then forwarded to `agentOperationsCore
     * .queryChannelAnalytics`, which forwards it unchanged into the REAL `analyticsCore
     * .getChannelOverview` -- that function already does the identical active-channel check
     * internally; a second check here would be redundant against the same fact, not a second
     * layer of safety).
     */
    async agentQueryChannelAnalytics(input: unknown): Promise<ToolResponse> {
      const parsedInput = queryChannelAnalyticsInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await agentOperationsCore.queryChannelAnalytics({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-114. A LOCAL read of Reach data the app already imported -- no Google call. Same shape as
     * `agentQueryChannelAnalytics`: `credentialRef` resolved once and forwarded; `getChannelReach` does the
     * active-channel check itself, before touching any data.
     */
    async agentQueryChannelReach(input: unknown): Promise<ToolResponse> {
      const parsedInput = getChannelReachInputObjectSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await reachReportsCore.getChannelReach({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-181 (FO-REQ-0020 §2.4) -- the Reporting jobs and files this app holds for the channel, with each file's lag. A LOCAL read, no
     * Google call; `getReachStatus` does the active-channel check itself.
     */
    async agentGetReportingStatus(input: unknown): Promise<ToolResponse> {
      const parsedInput = getReachStatusInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        if (!reachReportsCore.getReachStatus) throw new Error("The Reporting status read is not available in this server.");
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await reachReportsCore.getReachStatus({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-181 (owner msg 2702) -- the stored Reporting traffic-source rows of a range. A LOCAL read, no Google call; the core does the
     * active-channel check itself.
     */
    async agentGetReportingTrafficSources(input: unknown): Promise<ToolResponse> {
      const parsedInput = getReportingTrafficSourcesInputObjectSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        if (!reachReportsCore.getReportingTrafficSources) throw new Error("The Reporting traffic-source read is not available in this server.");
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await reachReportsCore.getReportingTrafficSources({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** BL-182 stage 1 -- the channel's publishing calendar from the local copy. A LOCAL read; the core checks the active channel. */
    async agentGetPublishingCalendar(input: unknown): Promise<ToolResponse> {
      const parsedInput = getAgentPublishingCalendarInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }
      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await publishingCalendarCore.getAgentCalendar({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-166 (docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md) -- the stored day-7 / day-28 milestones of the channel's videos. A LOCAL read,
     * no Google call; `listVideoMilestones` checks the active channel itself, and a video of another channel is simply not listed.
     */
    async agentGetVideoMilestones(input: unknown): Promise<ToolResponse> {
      const parsedInput = listVideoMilestonesInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.listVideoMilestones({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-168 (docs/roadmap/plans/VIDEO_BREAKDOWNS_PLAN.md) -- the stored traffic sources and devices per day of the channel or its videos.
     * A LOCAL read, no Google call; `listStoredBreakdowns` checks the active channel itself, and a video of another channel is not listed.
     */
    async agentGetStoredBreakdowns(input: unknown): Promise<ToolResponse> {
      const parsedInput = listStoredBreakdownsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.listStoredBreakdowns({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-171 (docs/roadmap/plans/VIDEO_COMMENTS_PLAN.md) -- the stored newest comments of the channel's own videos. A LOCAL read, no Google
     * call; `listStoredComments` checks the active channel itself, and a video of another channel is not listed.
     */
    async agentGetVideoComments(input: unknown): Promise<ToolResponse> {
      const parsedInput = listStoredCommentsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await videoCommentsCore.listStoredComments({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md) -- an experiment's videos by arm with their stored day-7 / day-28 values. A LOCAL
     * read, no Google call; every core it goes through checks the active channel itself.
     */
    async agentGetExperimentResults(input: unknown): Promise<ToolResponse> {
      const parsedInput = getExperimentResultsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await experimentResultsCore.getExperimentResults({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-169 (docs/roadmap/plans/VIDEO_SEARCH_TERMS_PLAN.md) -- the stored YouTube search terms of the channel's videos. A LOCAL read, no
     * Google call; `listStoredSearchTerms` checks the active channel itself, and a video of another channel is not listed.
     */
    async agentGetStoredSearchTerms(input: unknown): Promise<ToolResponse> {
      const parsedInput = listStoredSearchTermsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.listStoredSearchTerms({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-191 (docs/roadmap/plans/SUGGESTED_SOURCES_PLAN.md) -- the stored videos that suggested the channel's videos. A LOCAL read, no
     * Google call; `listStoredSuggestedSources` checks the active channel itself, and a video of another channel is not listed.
     */
    async agentGetStoredSuggestedSources(input: unknown): Promise<ToolResponse> {
      const parsedInput = listStoredSuggestedSourcesInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await analyticsCore.listStoredSuggestedSources({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * BL-118 -- traffic sources / devices / audience / geography / subscribed status / content format for a date range: the same
     * `getChannelBreakdown` the Content tab uses (a LIVE YouTube Analytics API read, 1 quota unit), with each raw API value also given a
     * readable label. Same forwarding pattern as `agentQueryChannelAnalytics`; the service checks the active channel itself.
     */
    async agentQueryChannelBreakdown(input: unknown): Promise<ToolResponse> {
      const parsedInput = getChannelBreakdownInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await breakdownCore.getChannelBreakdown({ ...parsedInput.data, credentialRef });
        const labelOf: Record<string, (values: string[]) => string> = {
          trafficSources: labelTrafficSource,
          deviceType: labelDeviceType,
          ageGender: labelAgeGender,
          geography: labelCountry,
          subscribedStatus: labelSubscribedStatus,
          contentFormat: labelContentFormat,
        };
        const label = labelOf[result.breakdown];
        return toolSuccessResult({
          channelId: result.channelId,
          breakdown: result.breakdown,
          startDate: result.startDate,
          endDate: result.endDate,
          rows: result.rows.map((row) => ({ ...row, label: label ? label(row.dimensionValues) : row.dimensionValues.join(" / ") })),
          freshness: {
            source: "live_youtube_analytics_api",
            note:
              "Fetched live from the YouTube Analytics API for this call (counts against that API's quota; YouTube typically reports it with a 1-2 day lag). `dimensionValues` are the raw API values, `label` a readable name for them.",
          },
        });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** Slice C, owner spec §9. Same forwarding pattern as `agentQueryChannelAnalytics` above. */
    async agentQueryVideoAnalytics(input: unknown): Promise<ToolResponse> {
      const parsedInput = queryVideoAnalyticsInputSchema.partial({ credentialRef: true }).safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(parsedInput.data.credentialRef);
        const result = await agentOperationsCore.queryVideoAnalytics({ ...parsedInput.data, credentialRef });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** Slice D. Same explicit channel-scoping pattern as `agentGetChannelContext`/
     * `agentGetVideoContext` -- the service function itself does no such check. */
    async agentListAssets(input: unknown): Promise<ToolResponse> {
      const parsedInput = listAssetsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.listAssets(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** Slice D. Same explicit channel-scoping note as `agentListAssets` above. */
    async agentGetAssetContext(input: unknown): Promise<ToolResponse> {
      const parsedInput = getAssetContextInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.getAssetContext(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** Slice E. Same explicit channel-scoping pattern as `agentGetAssetContext` above -- the
     * service function itself does no such check. */
    async agentGetGenerationProvenance(input: unknown): Promise<ToolResponse> {
      const parsedInput = getGenerationProvenanceInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.getGenerationProvenance(parsedInput.data);
        return toolSuccessResult({ provenance: result } as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Slice G (owner spec §18). Mutates local application state (a new proposal row, never a
     * Change Set) -- gated by the same device-availability/recovery-mode check as
     * `ai_localization_create_change_set`. Same explicit channel-scoping pattern as
     * `agentGetAssetContext` above -- the service function itself does no such check.
     */
    async agentCreateContentProposal(input: unknown): Promise<ToolResponse> {
      const parsedInput = createContentProposalInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        // Phase 7 slice G (owner spec §22): this is the one transport an agent-operations-
        // versioned surface actually mediates, so it is the only one that stamps a real
        // `agentApiVersion` alongside `createdVia: "mcp"`.
        const result = await agentOperationsCore.createContentProposal(parsedInput.data, {
          createdVia: "mcp",
          agentApiVersion: AGENT_API_VERSION,
        });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** Slice G. Same explicit channel-scoping note as `agentGetAssetContext` above. */
    async agentGetContentProposal(input: unknown): Promise<ToolResponse> {
      const parsedInput = getContentProposalInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.getContentProposal(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** Slice G. Same explicit channel-scoping note as `agentListAssets` above. */
    async agentListContentProposals(input: unknown): Promise<ToolResponse> {
      const parsedInput = listContentProposalsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.listContentProposals(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Slice G2 (owner spec §19). Mutates local application state (a new artifact-link row, and
     * -- via the underlying `asset-catalog.registerAsset` -- a new catalogued asset row) --
     * gated by the same device-availability/recovery-mode check as `agentCreateContentProposal`.
     * Same explicit channel-scoping pattern as `agentGetAssetContext` above.
     */
    async agentRegisterExternalArtifact(input: unknown): Promise<ToolResponse> {
      const parsedInput = registerExternalArtifactInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        // Phase 7 slice G2 (owner spec §22): same attestation discipline as
        // `agentCreateContentProposal` above.
        const result = await agentOperationsCore.registerExternalArtifact(parsedInput.data, {
          createdVia: "mcp",
          agentApiVersion: AGENT_API_VERSION,
        });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** Slice G2. Same explicit channel-scoping note as `agentListAssets` above. */
    async agentListProposalArtifacts(input: unknown): Promise<ToolResponse> {
      const parsedInput = listProposalArtifactsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.listProposalArtifacts(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Phase 7 slice I (owner spec §3/§30). No channel/credential resolution at all -- like
     * `agentGetCapabilities` above, this is instance-level (one global, operator-configured
     * workspace path), not channel-scoped.
     */
    async agentListOperationsFiles(input: unknown): Promise<ToolResponse> {
      const parsedInput = operationsWorkspaceListFilesInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const result = await agentOperationsCore.operationsWorkspaceListFiles(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** Slice I. Same non-channel-scoped note as `agentListOperationsFiles` above. */
    async agentGetOperationsFile(input: unknown): Promise<ToolResponse> {
      const parsedInput = operationsWorkspaceGetFileInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const result = await agentOperationsCore.operationsWorkspaceGetFile(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Phase 7 slice K (owner spec §10). Same explicit channel-scoping pattern as
     * `agentListAssets` above -- the service function itself does no such check.
     *
     * UNLIKE `agentListAssets`, this tool's own domain schema (`findComparableVideosInputSchema`)
     * requires `credentialRef` whenever `performanceMetric` is requested -- but the caller should
     * never have to pass one explicitly just to satisfy that refinement (every other
     * credential-bearing tool in this file, e.g. `agentQueryChannelAnalytics`, resolves a fallback
     * server-side). So `credentialRef` is resolved from the caller's own value if given, else the
     * local active identity, BEFORE schema validation -- injected into the object so the schema's
     * refine sees it regardless of whether the caller supplied one. The same resolved value is
     * then reused for `assertActiveChannel` and forwarded into the actual call, never resolved
     * twice with two different results.
     */
    async agentFindComparableVideos(input: unknown): Promise<ToolResponse> {
      try {
        const rawCredentialRef =
          typeof input === "object" && input !== null ? (input as { credentialRef?: unknown }).credentialRef : undefined;
        const credentialRef = await resolveCredentialRef(rawCredentialRef);
        const inputWithCredentialRef =
          typeof input === "object" && input !== null ? { ...(input as Record<string, unknown>), credentialRef } : input;

        const parsedInput = findComparableVideosInputSchema.safeParse(inputWithCredentialRef);
        if (!parsedInput.success) {
          return mapValidationErrorResult(parsedInput.error);
        }

        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.findComparableVideos(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Phase 7 slice L (owner spec §16). Same explicit channel-scoping and credentialRef
     * resolve-then-inject-then-validate pattern as `agentFindComparableVideos` above -- this
     * tool's own domain schema requires `credentialRef` whenever `performanceMetric` is set, so
     * it is resolved (caller-supplied, else the local active identity) and injected into the
     * input BEFORE schema validation, then reused for `assertActiveChannel`.
     */
    async agentListAssetPerformance(input: unknown): Promise<ToolResponse> {
      try {
        const rawCredentialRef =
          typeof input === "object" && input !== null ? (input as { credentialRef?: unknown }).credentialRef : undefined;
        const credentialRef = await resolveCredentialRef(rawCredentialRef);
        const inputWithCredentialRef =
          typeof input === "object" && input !== null ? { ...(input as Record<string, unknown>), credentialRef } : input;

        const parsedInput = listAssetPerformanceInputSchema.safeParse(inputWithCredentialRef);
        if (!parsedInput.success) {
          return mapValidationErrorResult(parsedInput.error);
        }

        await channelAccessCore.assertActiveChannel({
          userId: getCredentialUserId(credentialRef),
          channelId: parsedInput.data.channelId,
        });
        const result = await agentOperationsCore.listAssetPerformance(parsedInput.data);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    // Phase 9 slice 4 (docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md) -- calls
    // `marketIntelligenceCore` directly, not `agentOperationsCore` (see `MarketIntelligenceCoreSubset`'s
    // own doc comment above for why). Global data, never channel-scoped -- no
    // `assertActiveChannel`/`assertMcpDeviceAvailable` check, no `credentialRef` (neither call makes
    // a live YouTube request).
    async queryCompetitors(input: unknown): Promise<ToolResponse> {
      const parsedInput = queryCompetitorsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const result = await marketIntelligenceCore.listWatchlist();
        // Phase 12 (AC-P12-09): an agent sees only watchlist entries assigned to its channel.
        const channels = await marketAssignmentCore.filterForAgent("research_channel", result.channels, (c) => c.channelId);
        return toolSuccessResult({ ...result, channels } as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Single-channel deep dive: one watchlisted channel's own record plus its full evidence
     * history, via the market-intelligence module's own single `getWatchlistEntryContext` call
     * (one existence check feeding both the channel and evidence lookups -- an earlier version of
     * this handler called `getWatchlistEntry`/`listEvidence` separately, found by independent
     * review to double the existence check and risk a non-deterministic error shape). Fails with
     * `RESEARCH_CHANNEL_NOT_AVAILABLE` (`details: { channelId }`) if the given `channelId` is not
     * on the watchlist.
     */
    async queryMarketIntelligence(input: unknown): Promise<ToolResponse> {
      const parsedInput = getWatchlistEntryInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        // Phase 12 (AC-P12-09): not assigned to the agent's channel = same error as not watchlisted.
        await marketAssignmentCore.assertAvailableToAgent("research_channel", parsedInput.data.channelId);
        const result = await marketIntelligenceCore.getWatchlistEntryContext(parsedInput.data);
        // Nested data too (review round 1): only topic tags whose topic is assigned to the agent's channel.
        const topicAssignments = await marketAssignmentCore.filterForAgent("topic", result.topicAssignments, (a) => a.topicId);
        return toolSuccessResult({ ...result, topicAssignments } as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Phase 9 slice 9G, part A -- one list tool with a `kind` discriminator (owner spec §28:
     * "prefer a small number of powerful composable MCP tools over many thin wrappers") covering
     * topics/trend candidates/discovery candidates, rather than three separate tools. Pure fan-out
     * to the market-intelligence core's own already-existing `listTopics`/`listTrendCandidates`/
     * `listDiscoveryCandidates` -- no new service logic. Global data, never channel-scoped, same as
     * `queryCompetitors`/`queryMarketIntelligence` above.
     */
    async agentListMarketRecords(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentListMarketRecordsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        // Phase 12 (AC-P12-09): each kind narrowed to what is assigned to the agent's channel.
        if (parsedInput.data.kind === "topics") {
          const result = await marketIntelligenceCore.listTopics();
          const topics = await marketAssignmentCore.filterForAgent("topic", result.topics, (t) => t.topicId);
          return toolSuccessResult({ kind: "topics", ...result, topics });
        }
        if (parsedInput.data.kind === "trend_candidates") {
          const result = await marketIntelligenceCore.listTrendCandidates();
          const trendCandidates = await marketAssignmentCore.filterForAgent(
            "trend_candidate",
            result.trendCandidates,
            (t) => t.trendCandidateId
          );
          return toolSuccessResult({ kind: "trend_candidates", ...result, trendCandidates });
        }
        const result = await marketIntelligenceCore.listDiscoveryCandidates();
        const candidates = await marketAssignmentCore.filterForAgent("discovery_candidate", result.candidates, (c) => c.channelId);
        return toolSuccessResult({ kind: "discovery_candidates", ...result, candidates });
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Phase 9 slice 9G, part B (owner spec §29) -- an agent-created DRAFT, never self-approving.
     * `createdVia: "mcp"`/`agentApiVersion` are SERVER-STAMPED (owner spec §22), mirrors
     * `agentCreateContentProposal` above exactly. A real local-state mutation (writes a pending row
     * to local SQLite) even though it never touches YouTube, so this tool is gated by
     * `assertMcpDeviceAvailable` (via `wrapMcpHandlersWithMutationGate` below), same as
     * `agentCreateContentProposal`. Market data is not scoped to an owned channel; in an agent
     * session the created request is recorded as owned by the agent's channel (Phase 12).
     */
    async agentCreateMarketResearchRequest(input: unknown): Promise<ToolResponse> {
      const parsedInput = createMarketResearchRequestInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const result = await marketIntelligenceCore.createMarketResearchRequest(parsedInput.data, {
          createdVia: "mcp",
          agentApiVersion: AGENT_API_VERSION,
        });
        // Phase 12: a request an agent files is owned by its channel (operator sees all requests).
        await marketAssignmentCore.recordAgentOwnership("research_request", result.requestId);
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /**
     * Agent-created collection request (ADR 0021) -- a DRAFT, never self-approving; makes zero YouTube calls. Confinement: an explicit
     * `researchChannelIds` list must be assigned to the agent's channel (same error as a nonexistent one); with no list the default is
     * every watchlist channel assigned to it. `createdVia: "mcp"`/`agentApiVersion` are SERVER-STAMPED. The created request is recorded
     * as owned by the agent's channel. Mutates local state, so it is gated by `assertMcpDeviceAvailable` below.
     */
    async agentCreateCollectionRequest(input: unknown): Promise<ToolResponse> {
      const parsedInput = createCollectionRequestInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        let researchChannelIds = parsedInput.data.researchChannelIds;
        if (researchChannelIds) {
          for (const channelId of researchChannelIds) {
            await marketAssignmentCore.assertAvailableToAgent("research_channel", channelId);
          }
        } else {
          const watchlist = await marketIntelligenceCore.listWatchlist();
          researchChannelIds = (await marketAssignmentCore.filterForAgent("research_channel", watchlist.channels, (c) => c.channelId)).map(
            (c) => c.channelId
          );
          if (researchChannelIds.length === 0) {
            return toolSuccessResult({ created: false, request: null, notNeeded: [], alreadyRequested: [] });
          }
        }
        const result = await marketIntelligenceCore.createCollectionRequest(
          { ...parsedInput.data, researchChannelIds },
          { createdVia: "mcp", agentApiVersion: AGENT_API_VERSION }
        );
        if (result.request) await marketAssignmentCore.recordAgentOwnership("collection_request", result.request.requestId);
        // An existing request this agent does not own is not disclosed: channelId only, no requestId.
        const visibleIds = new Set(
          (await marketAssignmentCore.filterForAgent("collection_request", result.alreadyRequested, (a) => a.requestId)).map((a) => a.requestId)
        );
        const alreadyRequested = result.alreadyRequested.map((a) => (visibleIds.has(a.requestId) ? a : { channelId: a.channelId }));
        return toolSuccessResult({ ...result, alreadyRequested } as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    /** One collection request by id, or the most recent ones, narrowed to those assigned to the agent's channel (an unassigned id = not found). */
    async agentGetCollectionRequest(input: unknown): Promise<ToolResponse> {
      const parsedInput = getCollectionRequestInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const all = await marketIntelligenceCore.listCollectionRequests();
        const visible = await marketAssignmentCore.filterForAgent("collection_request", all.requests, (r) => r.requestId);
        if (parsedInput.data.requestId !== undefined) {
          const request = visible.find((r) => r.requestId === parsedInput.data.requestId);
          if (!request) {
            throw new DomainError({
              code: "COLLECTION_REQUEST_NOT_FOUND",
              message: "No collection request with this id",
              details: { requestId: parsedInput.data.requestId },
            });
          }
          return toolSuccessResult({ request } as unknown as Record<string, unknown>);
        }
        return toolSuccessResult({ requests: visible.slice(0, 20) } as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    async agentGetCollectionLimits(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentGetCollectionLimitsInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        return toolSuccessResult((await marketIntelligenceCore.getCollectionLimits()) as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    // Phase 10 slice 2 (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md) -- decision-engine's own
    // service layer already does channel-access assertion internally (assertHypothesisAccessible/
    // assertExperimentAccessible in services.ts), so this handler need not repeat it, unlike
    // changesetList/changesetGet above which call a core with no such internal check of its own.
    async agentListHypotheses(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentListHypothesesInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        const result = await decisionEngineCore.listHypotheses({ userId: getCredentialUserId(credentialRef) });
        return toolSuccessResult({ hypotheses: result } as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    // One combined "trail" read (owner spec §28: "prefer a small number of powerful composable
    // MCP tools over many thin wrappers") -- a hypothesis plus every one of its experiments, each
    // with its own outcomes, mirroring query_market_intelligence's single-deep-dive shape rather
    // than five separate list/get tools. `getHypothesisTrail` (services.ts) does the one access
    // check and the composition itself, shared with the CLI's own identical command (found by
    // advisor review: an earlier version composed this in both the MCP and CLI handlers
    // separately, real duplication of exactly the kind BL-104's own round-1 review already
    // flagged once for this project).
    async agentGetHypothesisTrail(input: unknown): Promise<ToolResponse> {
      const parsedInput = agentGetHypothesisTrailInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const credentialRef = await resolveCredentialRef(undefined);
        const result = await decisionEngineCore.getHypothesisTrail(parsedInput.data.hypothesisId, {
          userId: getCredentialUserId(credentialRef),
        });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },

    // The one reserved capability (`PLANNED_FUTURE_CAPABILITIES` -> real, this slice) -- an agent
    // may only create an experiment against an ALREADY-EXISTING, human-created hypothesis, and
    // the created row always starts at status "proposed" (insertExperiment accepts no caller-
    // supplied status at all -- structurally, not just conventionally, never anything an agent can
    // set to "approved"). Mutation-gated, like
    // agentCreateMarketResearchRequest above.
    async createExperimentProposal(input: unknown): Promise<ToolResponse> {
      const parsedInput = createExperimentProposalInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return mapValidationErrorResult(parsedInput.error);
      }

      try {
        const { hypothesisId, ...experimentInput } = parsedInput.data;
        const credentialRef = await resolveCredentialRef(undefined);
        const result = await decisionEngineCore.createExperiment(hypothesisId, experimentInput, {
          userId: getCredentialUserId(credentialRef),
          createdBy: "agent",
          createdVia: "mcp",
        });
        return toolSuccessResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  };

  return wrapMcpHandlersWithMutationGate(handlers);
}

/**
 * Decision 7 (docs/decisions/0002-additive-schema-versioning.md's companion plan): a single
 * choke point gating every locally-mutating or remote-mutating tool (per
 * docs/DEVELOPMENT_PLAYBOOK.md §6.7's three-way classification: writeChannelSelect,
 * authUserSelect, apply, playlistCreate/Update/Delete/AddVideos/RemoveVideos) behind the local
 * operation lock and the device-handoff recovery-mode check, before the real handler ever
 * runs. Read-only tools are untouched. Mirrors src/proxy.ts's and the CLI's
 * `runCliCommand`'s own gate (one implementation logic, three call sites, AGENTS.md §D).
 */
async function assertMcpDeviceAvailable(): Promise<ToolResponse | null> {
  try {
    const { rawSqlClient } = await import("@/lib/db");
    const { assertDeviceAvailableForMutation } = await import("@/lib/device-mutation-gate");
    await assertDeviceAvailableForMutation(rawSqlClient);
    return null;
  } catch (error) {
    return toolErrorResult(error);
  }
}

function wrapMcpHandlersWithMutationGate(handlers: McpToolHandlers): McpToolHandlers {
  // TypeScript cannot verify `wrapped[key] = wrap(handlers[key])` preserves each key's own
  // (varying: zero-arg vs. one-arg) signature through a generic loop -- built explicitly,
  // one line per key, instead, which keeps every handler's real type intact. The gating
  // *logic* itself (assertMcpDeviceAvailable, MCP_MUTATING_TOOL_KEYS) still lives in exactly
  // one place; only this wiring is per-key.
  return {
    writeContext: handlers.writeContext,
    writeChannelList: handlers.writeChannelList,
    writeChannelSelect: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.writeChannelSelect(input),
    whoami: handlers.whoami,
    authUserSelect: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.authUserSelect(input),
    list: handlers.list,
    transcript: handlers.transcript,
    preview: handlers.preview,
    apply: async (input) => (await assertMcpDeviceAvailable()) ?? handlers.apply(input),
    playlistList: handlers.playlistList,
    playlistCreate: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.playlistCreate(input),
    playlistDelete: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.playlistDelete(input),
    playlistUpdate: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.playlistUpdate(input),
    playlistAddVideos: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.playlistAddVideos(input),
    playlistRemoveVideos: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.playlistRemoveVideos(input),
    // Read/propose-only (Phase 7 slice 1) -- no mutation, so no device-availability gate,
    // exactly like list/transcript/preview/playlistList above.
    changesetList: handlers.changesetList,
    changesetGet: handlers.changesetGet,
    localizationImportPreview: handlers.localizationImportPreview,
    changesetCreateFromImport: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.changesetCreateFromImport(input),
    batchList: handlers.batchList,
    batchGet: handlers.batchGet,
    // channel_sync writes to the local channels/videos tables -- gated, like
    // writeChannelSelect/authUserSelect above. channel_list/channel_video_list are
    // pure local reads and stay ungated, like changeset_list/batch_list above.
    channelSync: async (input) => (await assertMcpDeviceAvailable()) ?? handlers.channelSync(input),
    channelList: handlers.channelList,
    channelVideoList: handlers.channelVideoList,
    // Neither mutates anything anywhere -- ungated. analyticsList is a local-only read;
    // analyticsOverview is a live Analytics API read, like playlistList's own live YouTube read
    // above (a live read is still "read-only" per docs/DEVELOPMENT_PLAYBOOK.md §6.7's
    // classification -- it's the absence of any mutation that matters, not where the data lives).
    analyticsList: handlers.analyticsList,
    analyticsOverview: handlers.analyticsOverview,
    // Pure local read over analytics_collection_runs -- same classification as analyticsList.
    analyticsDataQuality: handlers.analyticsDataQuality,
    // Pure local read over already-collected video_metrics_daily rows -- same classification.
    analyticsComparableAge: handlers.analyticsComparableAge,
    // Pure local reads over analytics_weekly_reports -- same classification. Note there is no
    // "generate" tool here: that stays Web-UI-triggered only (runWeeklyReportIfDue), like
    // collectMetrics/runAutoCollectionIfStale above.
    analyticsWeeklyReportsList: handlers.analyticsWeeklyReportsList,
    analyticsWeeklyReportGet: handlers.analyticsWeeklyReportGet,
    // Persists nothing (mock provider: no network call at all; a real connection is gated by
    // its own internal device-availability check, RISK-30) -- ungated, like
    // localizationImportPreview above.
    aiLocalizationGenerate: handlers.aiLocalizationGenerate,
    // A real local-persistence mutation (a new Change Set) -- gated, like
    // changesetCreateFromImport above.
    aiLocalizationCreateChangeSet: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.aiLocalizationCreateChangeSet(input),
    // BL-232: persists a draft Change Set locally -- gated like aiLocalizationCreateChangeSet.
    agentLocalizationProposeLanguageMove: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.agentLocalizationProposeLanguageMove(input),
    // Pure local read (instance metadata + a static capability list) -- ungated.
    agentGetCapabilities: handlers.agentGetCapabilities,
    // Pure local reads over the existing sync mirror -- ungated, same as changeset_list above.
    agentGetChannelContext: handlers.agentGetChannelContext,
    agentGetVideoContext: handlers.agentGetVideoContext,
    // Slice C -- `queryChannelAnalytics` is a live YouTube Analytics API read (like
    // `analyticsOverview`), `queryVideoAnalytics` a pure local read (like `analyticsList`); both
    // mutate no local state, so both are ungated, same classification as their wrapped tools.
    agentQueryChannelAnalytics: handlers.agentQueryChannelAnalytics,
    // BL-114 -- a pure local read, ungated.
    agentQueryChannelReach: handlers.agentQueryChannelReach,
    // BL-181 -- a pure local read, ungated.
    agentGetReportingStatus: handlers.agentGetReportingStatus,
    // BL-181 (owner msg 2702) -- a pure local read, ungated.
    agentGetReportingTrafficSources: handlers.agentGetReportingTrafficSources,
    // BL-182 -- a pure local read, ungated.
    agentGetPublishingCalendar: handlers.agentGetPublishingCalendar,
    // BL-166 -- a pure local read, ungated.
    agentGetVideoMilestones: handlers.agentGetVideoMilestones,
    // BL-168 -- a pure local read, ungated.
    agentGetStoredBreakdowns: handlers.agentGetStoredBreakdowns,
    // BL-169 -- a pure local read, ungated.
    agentGetStoredSearchTerms: handlers.agentGetStoredSearchTerms,
    // BL-191 -- a pure local read, ungated.
    agentGetStoredSuggestedSources: handlers.agentGetStoredSuggestedSources,
    // BL-170 -- a pure local read, ungated.
    agentGetExperimentResults: handlers.agentGetExperimentResults,
    // BL-171 -- a pure local read, ungated.
    agentGetVideoComments: handlers.agentGetVideoComments,
    // BL-118 -- a live Analytics read like agentQueryChannelAnalytics's `refresh`; mutates nothing, ungated.
    agentQueryChannelBreakdown: handlers.agentQueryChannelBreakdown,
    agentQueryVideoAnalytics: handlers.agentQueryVideoAnalytics,
    // Slice D -- pure local reads over the asset catalog, ungated.
    agentListAssets: handlers.agentListAssets,
    agentGetAssetContext: handlers.agentGetAssetContext,
    // Slice E -- a pure local read over an immutable, already-persisted provenance row; ungated.
    agentGetGenerationProvenance: handlers.agentGetGenerationProvenance,
    // Slice G -- `createContentProposal` is a real local-persistence mutation (a new proposal
    // row) -- gated, like `aiLocalizationCreateChangeSet` above. `getContentProposal`/
    // `listContentProposals` are pure local reads -- ungated, like `agentListAssets` above.
    agentCreateContentProposal: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.agentCreateContentProposal(input),
    agentGetContentProposal: handlers.agentGetContentProposal,
    agentListContentProposals: handlers.agentListContentProposals,
    // Slice G2 -- `registerExternalArtifact` mutates local state (a new artifact-link row, and
    // via `asset-catalog` a new catalogued asset row) -- gated, like `agentCreateContentProposal`
    // above. `listProposalArtifacts` is a pure local read -- ungated.
    agentRegisterExternalArtifact: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.agentRegisterExternalArtifact(input),
    agentListProposalArtifacts: handlers.agentListProposalArtifacts,
    // Slice I -- both are pure filesystem reads over the operator-configured workspace path,
    // never a mutation of any kind -- ungated, like `agentListAssets` above.
    agentListOperationsFiles: handlers.agentListOperationsFiles,
    agentGetOperationsFile: handlers.agentGetOperationsFile,
    // Slice K -- a pure local read (local sync mirror + local analytics rows, never a live
    // YouTube call) -- ungated, like `agentListAssets` above.
    agentFindComparableVideos: handlers.agentFindComparableVideos,
    // Slice L -- a pure local read (asset catalog + local sync mirror + local analytics rows,
    // never a live YouTube call) -- ungated, like `agentFindComparableVideos` above.
    agentListAssetPerformance: handlers.agentListAssetPerformance,
    // Phase 9 slice 4 -- pure local reads over the market-intelligence module's own watchlist/
    // evidence storage, never a live YouTube call, never a mutation -- ungated, same
    // classification as agentListAssets above.
    queryCompetitors: handlers.queryCompetitors,
    queryMarketIntelligence: handlers.queryMarketIntelligence,
    // Phase 9 slice 9G, part A -- pure fan-out over already-existing reads, same classification.
    agentListMarketRecords: handlers.agentListMarketRecords,
    // Phase 9 slice 9G, part B -- a real local-state mutation (a new pending request row) -- gated,
    // like `agentCreateContentProposal` above.
    agentCreateMarketResearchRequest: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.agentCreateMarketResearchRequest(input),
    // Collection requests (ADR 0021): create writes a local pending row -- gated; the two reads are pure local reads -- ungated.
    agentCreateCollectionRequest: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.agentCreateCollectionRequest(input),
    agentGetCollectionRequest: handlers.agentGetCollectionRequest,
    agentGetCollectionLimits: handlers.agentGetCollectionLimits,
    // Phase 10 slice 2 -- pure local reads over decision-engine's own hypothesis/experiment/
    // outcome storage, same classification as queryCompetitors/queryMarketIntelligence above.
    agentListHypotheses: handlers.agentListHypotheses,
    agentGetHypothesisTrail: handlers.agentGetHypothesisTrail,
    // A real local-state mutation (a new "proposed" experiment row) -- gated, like
    // agentCreateMarketResearchRequest above.
    createExperimentProposal: async (input) =>
      (await assertMcpDeviceAvailable()) ?? handlers.createExperimentProposal(input),
    // Phase 11 -- a pure local read of one stored string, never a mutation -- ungated, same
    // classification as agentGetChannelContext above.
    agentGetChannelWorkspace: handlers.agentGetChannelWorkspace,
    // Factory Operator access -- pure local reads of the registry, never a mutation -- ungated.
    agentListLogicalPaths: handlers.agentListLogicalPaths,
    agentGetLogicalPath: handlers.agentGetLogicalPath,
    // Research export -- writes files and a ledger row: gated.
    agentExportResearchData: async (input) => (await assertMcpDeviceAvailable()) ?? handlers.agentExportResearchData(input),
    // Pure local read -- ungated, like queryCompetitors.
    queryMarketOverview: handlers.queryMarketOverview,
    // Phase 14 slice 5 -- a session request and a job create/cancel write local rows (a job also reaches ComfyUI) -- gated like
    // agentCreateCollectionRequest; the template/session/limits/job reads are pure local reads -- ungated.
    agentListMediaTemplates: handlers.agentListMediaTemplates,
    agentRequestMediaSession: async (input) => (await assertMcpDeviceAvailable()) ?? handlers.agentRequestMediaSession(input),
    agentGetMediaSession: handlers.agentGetMediaSession,
    agentGetMediaLimits: handlers.agentGetMediaLimits,
    agentCreateMediaJob: async (input) => (await assertMcpDeviceAvailable()) ?? handlers.agentCreateMediaJob(input),
    agentGetMediaJob: handlers.agentGetMediaJob,
    agentCancelMediaJob: async (input) => (await assertMcpDeviceAvailable()) ?? handlers.agentCancelMediaJob(input),
    agentReleaseMediaSession: async (input) => (await assertMcpDeviceAvailable()) ?? handlers.agentReleaseMediaSession(input),
    // BL-143 phase 3 -- pure local reads, ungated like agentGetMediaJob.
    agentListGenerationPlans: handlers.agentListGenerationPlans,
    agentGetGenerationPlan: handlers.agentGetGenerationPlan,
  };
}

// "MCP connection" gate (owner instruction, 2026-09-21 -- renamed and inverted from the earlier
// "MCP restricted mode": *"По началу MCP / агент от всего отключен и получит доступ только если
// я зайду в настройки и переключу этот тумблер... Все взаимодействия MCP / агента должны идти
// через это переключение"*). This single boolean is now the ONE gate for every MCP tool, not a
// per-tool exclusion list: when disconnected, `createMcpServer` registers ZERO tools at all --
// not just the write/identity-switching ones, every read/propose/create tool too (`whoami`,
// `list`, `changeset_list`, `channel_sync`, etc.). A connecting client sees a server with no
// capabilities whatsoever until the project owner explicitly enables the connection in Settings.
// See `docs/decisions/0005-youtube-write-gateway.md`'s "single funnel" reasoning for the same
// design principle applied here: one shared boolean, checked from one place
// (`registerTool` below), rather than a per-tool allow/deny list that a future tool could be
// added to and forgotten.
export function createMcpServer(
  core: VideoMetadataCoreSubset & PlaylistManagementCoreSubset = {
    ...createVideoMetadataCore(),
    ...createPlaylistManagementCore(),
  },
  options: {
    connectionEnabled?: boolean;
    // The channel-bound agent session of THIS request (`src/lib/agent-mcp-endpoint` builds one server
    // per request, from a token it just verified). Absent means "no valid token": ZERO tools are
    // registered, on top of the unchanged connectionEnabled master switch. Before every tool call the
    // wrapper asserts that the ambient request scope (`src/lib/agent-session`) is exactly this
    // `tokenId` -- a lost async context would otherwise degrade into operator mode inside the web
    // process -- and `reverify` re-checks the token so a revocation lands even mid-request
    // (AC-P12-02). The scope itself is entered by the endpoint, not here, so tests can inject this.
    agentSession?: { tokenId: string; channelId: string; reverify(): Promise<void> } | null;
    // BL-161: the Producer (READ, plus its BL-163 proposal tools) of THIS request (`src/lib/producer-mcp-endpoint`, a producer token it just verified). The
    // server then registers only the Producer's closed list (`./producer-tools.ts`): each channel tool needs a `channelId` and
    // runs inside THAT channel's agent scope, entered here per call (never per request), so it sees exactly what the channel's
    // own agent sees through the same checks. Never together with `agentSession`.
    producerSession?: ProducerSession | null;
    /**
     * BL-218 (WORKER_CAPABILITIES_PLAN.md stage 4): the Factory Operator's media wiring, injected by the channel agents' route
     * (src/app/api/mcp/route.ts) -- nothing in src/mcp reaches the media core's session start/stop itself. With it, a channel
     * session's Operator-style session, job and plan-run tools work, pinned to its channel. Absent: those tools refuse.
     */
    workerMediaDeps?: (() => WorkerMediaDeps) | null;
  } = {}
) {
  const connectionEnabled = options.connectionEnabled ?? false;
  const agentSession = options.agentSession ?? null;
  const producerSession = options.producerSession ?? null;
  if (agentSession && producerSession) {
    throw new Error("an MCP server serves either a channel agent or the Producer, never both");
  }

  const server = new McpServer({
    name: "youtube-video-metadata",
    version: "0.1.0",
  });

  const handlers = createMcpToolHandlers(core);

  // `server.registerTool`'s real type is generic per call (each call site's own Zod schema
  // determines its handler's argument type); a thin conditional wrapper around it can't
  // preserve that per-call inference without also duplicating the SDK's own overloads, so
  // `config`/`handler` are intentionally untyped here -- every call site below still passes
  // a correctly-matched, individually-typed (schema, handler) pair, exactly as before this
  // wrapper existed. This function only decides whether to forward that pair at all.
  function registerTool(
    name: string,
    config: { description: string; inputSchema: z.ZodTypeAny },
    handler: (args: never) => Promise<ToolResponse> | ToolResponse | ReturnType<typeof handlers.whoami>
  ) {
    if (!connectionEnabled || (!agentSession && !producerSession)) {
      return;
    }
    const toolClass = MCP_TOOL_CLASSIFICATION[name];
    if (!toolClass) {
      // AC-P12-08: a tool nobody classified must never be exposed silently.
      throw new Error(`MCP tool "${name}" is not classified in src/mcp/tool-classification.ts`);
    }
    const registration = producerSession
      ? producerRegistration(producerSession, name, toolClass, config, handler)
      : agentSession && toolClass === "bound"
        ? { config, handler: channelAgentHandler(agentSession, name, handler) }
        : null;
    if (!registration) {
      return;
    }
    server.registerTool(name, registration.config as never, registration.handler as never);
  }

  function channelAgentHandler(
    session: { tokenId: string; channelId: string; reverify(): Promise<void> },
    name: string,
    handler: (args: never) => Promise<ToolResponse> | ToolResponse | ReturnType<typeof handlers.whoami>
  ) {
    // Counts real tool invocations for the Settings tab's traffic stats (owner instruction,
    // 2026-09-22). When MCP connection is off, this wrapper never even runs (registerTool
    // returns above), so there is no failed call to count there, only an absent tool -- but a
    // call rejected because its token was revoked IS a real, counted "blocked" attempt through this
    // gateway category, exactly like the other gateways record their own rejections. (BL-091's
    // per-capability zones were retired in Phase 12, owner decision D4 -- one agent owns all of
    // its channel's work; see docs/decisions/0011-retire-agent-capability-zones.md.)
    return (async (args: never) => {
      // BL-215 (ADR 0048, AC-WK-06/07): a call that would really write to YouTube leaves one worker-log row, refused or not (a
      // revoked token included). The row is written after the answer exists and never changes it -- the YouTube write may already
      // have happened. A call the SDK rejects on its input schema never reaches this wrapper and cannot write.
      const write = describeWorkerWrite(name, args);
      let result: ToolResponse;
      try {
        assertAgentSession(session.tokenId);
        await session.reverify();
      } catch (error) {
        await recordGatewayCallOutcome("mcp_tool_calls", "blocked");
        result = toolErrorResult(error);
        if (write) await logWorkerWrite(session, name, write, result);
        return result;
      }
      if (!UNCOUNTED_CHANNEL_TOOLS.has(name)) await recordGatewayCallOutcome("mcp_tool_calls", "allowed");
      if (!write) return handler(args);
      try {
        result = (await handler(args)) as ToolResponse;
      } catch (error) {
        result = toolErrorResult(error);
      }
      await logWorkerWrite(session, name, write, result);
      return result;
    }) as typeof handler;
  }

  async function logWorkerWrite(
    session: { tokenId: string; channelId: string },
    name: string,
    write: NonNullable<ReturnType<typeof describeWorkerWrite>>,
    result: ToolResponse
  ): Promise<void> {
    const outcome = describeWriteOutcome(name, write, result.structuredContent);
    await insertWorkerActionLogEntry({
      at: new Date(),
      channelId: session.channelId,
      tokenId: session.tokenId,
      tool: name,
      target: outcome.target,
      detail: serializeWorkerDetail(outcome.fields),
      outcome: result.isError ? "error" : "ok",
      errorCode: result.isError ? toolErrorCode(result) : null,
    }).catch((error: unknown) => {
      console.error(`[mcp] worker log row for ${name} not written: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // BL-161 (docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §3): the Producer's registration. Its own tools run as they are; a channel
  // tool from the closed list gets a required `channelId`, is refused for a channel not connected on this device, and runs
  // inside that channel's agent scope -- the same confinement as the channel's own agent, entered for this one call. Every call,
  // allowed or refused, goes to the Producer's call log, and every answer names the channel it is for (`forChannelId`).
  function producerRegistration(
    session: ProducerSession,
    name: string,
    toolClass: string,
    config: { description: string; inputSchema: z.ZodTypeAny },
    handler: (args: never) => Promise<ToolResponse> | ToolResponse | ReturnType<typeof handlers.whoami>
  ): { config: { description: string; inputSchema: z.ZodTypeAny }; handler: (args: never) => Promise<ToolResponse> } | null {
    // Owner TG 4782 review: a playlist write's row also says what it wrote -- the worker log's own description of the call (playlistId,
    // privacy, video ids) and the counts of the answer; refused calls keep their target. Every other call: tool, channel, outcome.
    const describesWrite = (PRODUCER_PLAYLIST_WRITE_TOOLS as readonly string[]).includes(name);
    const record = async (entry: { channelId: string | null; result: ToolResponse; args?: unknown }) => {
      const write = describesWrite ? describeWorkerWrite(name, entry.args) : null;
      const outcome = write ? describeWriteOutcome(name, write, entry.result.structuredContent) : null;
      await session
        .recordCall({
          tool: name,
          channelId: entry.channelId,
          outcome: entry.result.isError ? "error" : "ok",
          errorCode: entry.result.isError ? toolErrorCode(entry.result) : null,
          ...(outcome ? { target: outcome.target, details: serializeWorkerDetail({ ...playlistWriteCounts(entry.result), ...outcome.fields }) } : {}),
        })
        .catch(() => undefined);
    };
    if (toolClass === "producer-only") {
      const wrapped = async (args: never) => {
        // A producer tool that names one of our channels (BL-163's proposal tools) is logged under it, by the endpoint's own rule
        // (a string of at most 64 characters), so the endpoint matches the call to this entry; the answer names it too.
        const named = (args as { channelId?: unknown } | undefined)?.channelId;
        const channelId = typeof named === "string" && named.length <= 64 ? named : null;
        const finish = (result: ToolResponse) => (channelId ? withForChannel(result, channelId) : result);
        let result: ToolResponse;
        try {
          await session.reverify();
        } catch (error) {
          await recordGatewayCallOutcome("mcp_tool_calls", "blocked");
          result = toolErrorResult(error);
          await record({ channelId, result });
          return finish(result);
        }
        if (!UNCOUNTED_PRODUCER_TOOLS.has(name)) await recordGatewayCallOutcome("mcp_tool_calls", "allowed");
        try {
          result = await handler(args);
        } catch (error) {
          result = toolErrorResult(error);
        }
        await record({ channelId, result });
        return finish(result);
      };
      return { config, handler: wrapped };
    }
    if (toolClass !== "bound" || !(name in PRODUCER_CHANNEL_TOOLS || name in PRODUCER_DRAFT_CHANNEL_TOOLS || name in PRODUCER_PLAYLIST_CHANNEL_TOOLS)) {
      return null;
    }
    if (!(config.inputSchema instanceof z.ZodObject)) {
      throw new Error(`Producer tool "${name}" needs an object input schema`);
    }
    // Rebuilt from the shape as a strict object (review round 2: `.omit` throws on a refined schema, which would take every Producer
    // request down). A credentialRef is always refused inside an agent scope (AGENT_SESSION_CREDENTIAL_OVERRIDE): the Producer's schema
    // leaves it out, so it is refused at input instead of advertised as optional. The tool's own handler still validates its input.
    const { credentialRef: _credentialRef, ...shape } = (config.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    void _credentialRef;
    const renamed = PRODUCER_RENAMED_CHANNEL_FIELD[name];
    const ownsChannelId = "channelId" in shape && !renamed;
    const inputSchema = z
      .object({
        ...shape,
        ...(renamed ? { [renamed]: shape.channelId } : {}),
        channelId: z.string().min(1).max(64).describe("The channel this call is for (one of producer_list_channels)."),
      })
      .strict();
    const description =
      `Producer: runs for the channel named by \`channelId\` (one of producer_list_channels), exactly as that channel's own agent would call it` +
      (renamed ? `; the watchlist channel this tool's own text calls \`channelId\` is \`${renamed}\` here` : "") +
      `. ${config.description} -- On the Producer endpoint \`credentialRef\` is not accepted, whatever the text above says: the channel's own connected account is always used.`;
    const wrapped = async (args: Record<string, unknown>) => {
      const channelId = String(args.channelId);
      const refuse = async (error: unknown) => {
        await recordGatewayCallOutcome("mcp_tool_calls", "blocked");
        const result = toolErrorResult(error);
        await record({ channelId, result, args });
        return withForChannel(result, channelId);
      };
      let userId: string | null;
      try {
        await session.reverify();
        userId = await session.resolveChannelUser(channelId);
      } catch (error) {
        return refuse(error);
      }
      if (!userId) {
        return refuse(
          new DomainError({
            code: "CHANNEL_NOT_ACTIVE",
            message: "This channel is not connected on this computer -- producer_list_channels lists the channels you can read.",
            details: { channelId },
          })
        );
      }
      await recordGatewayCallOutcome("mcp_tool_calls", "allowed");
      const forwarded: Record<string, unknown> = { ...args };
      if (renamed) {
        forwarded.channelId = args[renamed];
        delete forwarded[renamed];
      } else if (!ownsChannelId) {
        delete forwarded.channelId;
      }
      let result: ToolResponse;
      try {
        result = (await runInAgentSession({ tokenId: session.tokenId, channelId, userId }, async () => {
          assertAgentSession(session.tokenId);
          // Owner msg 4782: the Producer adds only the named channel's own videos (its local synced list), before anything else runs.
          if (PRODUCER_OWN_VIDEO_TOOLS.includes(name) && Array.isArray(forwarded.videoIds)) {
            for (const videoId of forwarded.videoIds) await assertAgentScopeVideo(String(videoId), getStoredVideo);
          }
          return handler(forwarded as never);
        })) as ToolResponse;
      } catch (error) {
        result = toolErrorResult(error);
      }
      await record({ channelId, result, args });
      return withForChannel(result, channelId);
    };
    return { config: { description, inputSchema }, handler: wrapped as (args: never) => Promise<ToolResponse> };
  }

  registerTool(
    "producer_get_capabilities",
    {
      description:
        "The Producer role's own report: its API version, its permissions (READ; DRAFT for its proposals only; UPLOAD_QUEUE for this computer's upload queue) and the tools it can call. Every channel tool needs `channelId` -- one of producer_list_channels -- and answers with `forChannelId`. No tool here writes to YouTube or spends money by itself: the DRAFT tools (draftTools) store a proposal or mark one read, and a proposal changes nothing until the owner approves it in YT Manager; the UPLOAD_QUEUE tools (uploadQueueTools) list, order, cancel and add rows of this computer's upload queue -- the app's own uploader then uploads a queued row as private, with its identity check, and only while the owner's Live writes switch is on; a date comes only from a weekly-plan slot the owner approved. The clip review tools (clipReviewTools) submit a clip already in a channel's folder for the owner to watch, and read his answer: only the owner approves or returns a clip, in YT Manager. The image review tools (imageReviewTools, since 1.28.0) do the same for a scene's master still image: only the owner approves it, approves it with a note, or returns it. THUMBNAIL_WRITE (thumbnailTools, since 1.20.0): producer_video_thumbnail_replace writes a video's custom thumbnail on YouTube (owner's decision, any video of a connected channel), with backup, identity check, Live writes, read-back and audit. METADATA_WRITE (metadataTools, since 1.24.0): producer_video_metadata_update writes an uploaded video's title / description / tags from its package's current manifest -- or, with localizations: true (since 1.31.0), its translations -- refusing any conflict, with the same safety steps. Since 1.35.0 metadataTools also has producer_video_category_fix: the category of the channel's package-uploaded videos set to its saved publishing setting, with the same safety steps. PLAN_MOVE (planMoveTools, since 1.25.0): producer_publishing_plan_move_slot moves a weekly-plan slot anywhere at once and, for a video already dated, writes the new date on YouTube with the same safety steps. CAPTIONS_WRITE (captionsTools, since 1.26.0): producer_video_captions_add puts a package's English captions onto its uploaded video (overwrite: true replaces the video's one English standard track), with the same safety steps. PLAYLIST_WRITE (playlistTools / playlistWriteTools, since 1.29.0): the channel's own playlist tools -- playlist_list reads; playlist_create, playlist_update (title, description, privacy: public, unlisted or private), playlist_add_videos (only the channel's own synced videos) and playlist_remove_videos write to YouTube on that channel's playlists, with the write-channel guardrail (expectedChannelId = channelId), the playlist's owner check and Live writes; no playlist delete. These are the only YouTube writes a Producer tool makes itself; producer_week_template_propose is a DRAFT the owner decides.",
      inputSchema: z.object({}).strict(),
    },
    async () =>
      toolSuccessResult({
        role: "producer",
        producerApiVersion: PRODUCER_API_VERSION,
        permissions: ["READ", "DRAFT", "UPLOAD_QUEUE", "THUMBNAIL_WRITE", "METADATA_WRITE", "PLAN_MOVE", "CAPTIONS_WRITE", "PLAYLIST_WRITE"],
        channelRequired: true,
        tools: [...PRODUCER_TOOL_NAMES],
        draftTools: [...PRODUCER_DRAFT_TOOLS],
        uploadQueueTools: [...PRODUCER_UPLOAD_QUEUE_TOOLS],
        clipReviewTools: [...PRODUCER_CLIP_REVIEW_TOOLS],
        imageReviewTools: [...PRODUCER_IMAGE_REVIEW_TOOLS],
        thumbnailTools: [...PRODUCER_THUMBNAIL_TOOLS],
        metadataTools: [...PRODUCER_METADATA_TOOLS],
        captionsTools: [...PRODUCER_CAPTIONS_TOOLS],
        planTools: [...PRODUCER_PLAN_TOOLS],
        planMoveTools: [...PRODUCER_PLAN_MOVE_TOOLS],
        playlistTools: Object.keys(PRODUCER_PLAYLIST_CHANNEL_TOOLS),
        playlistWriteTools: [...PRODUCER_PLAYLIST_WRITE_TOOLS],
      })
  );

  registerTool(
    "producer_list_channels",
    {
      description:
        "Every channel connected on this computer (Settings → Channels), with its title and the production-workspace folder set for it on this computer (null when none is set). These are the channels the other Producer tools accept as `channelId`. A local read, no YouTube call.",
      inputSchema: z.object({}).strict(),
    },
    async () => toolSuccessResult({ channels: await producerSession!.listChannels() })
  );

  registerTool(
    "producer_portfolio_overview",
    {
      description:
        "One row per connected channel for the same date range, side by side: views, watch minutes, subscribers gained and lost (stored channel-level analytics, YouTube's own reporting days), impressions and impressions CTR (imported Reach reports), uploads published in the range (synced videos, by UTC date), and when each source was last refreshed. Local data only, never a live YouTube call: a figure with nothing stored behind it for the range is null, never zero (analytics with no stored day, Reach with no imported day in the range, uploads of a channel whose videos were never synced). Dates are YYYY-MM-DD, inclusive, at most 366 days.",
      inputSchema: producerPortfolioOverviewInputSchema,
    },
    async (args: z.infer<typeof producerPortfolioOverviewInputSchema>) => toolSuccessResult(await producerSession!.portfolioOverview(args))
  );

  registerTool(
    "producer_upload_milestones",
    {
      description:
        "For each connected channel, its public uploads published in the range (synced videos, by UTC date like producer_portfolio_overview; a private, scheduled or upcoming video is not listed), oldest first, each with its day-7 and day-28 milestones (BL-166): `windowStart`/`windowEnd` (YouTube Analytics' Pacific dates: publish date .. +6 / +27), `status` (collected | retry -- a query failed, tried again later | failed -- given up after 3 attempts | due -- waiting for its collection run | not_due -- the window or the 3-day reporting lag after it is not over), `collectedAt`, `totals` (views, estimatedMinutesWatched, averageViewDuration in seconds, averageViewPercentage, as YouTube returned them for the window; null unless collected) and `reach` over the same window from the imported Reach reports (`daysWithData`; `impressions` summed and `ctr` impressions-weighted, both null when no Reach day is stored in the window -- a window still open has only its days so far). `reachState` is the channel's Reach state (no_job, waiting_for_first_report, ready, or unavailable when it could not be read -- `reachError` then names why, e.g. CHANNEL_NOT_ACTIVE). `uploads` is null for a channel whose videos were never synced on this computer. No retention curves: agent_get_video_milestones with the channelId returns them. Local data only, never a live YouTube call; milestones are collected by the computer the channel is connected on. Dates are YYYY-MM-DD, inclusive, at most 92 days.",
      inputSchema: producerUploadMilestonesInputSchema,
    },
    async (args: z.infer<typeof producerUploadMilestonesInputSchema>) => toolSuccessResult(await producerSession!.uploadMilestones(args))
  );

  registerTool(
    "producer_live_analytics",
    {
      description:
        "BL-214: each connected channel's 24/7 live streams over UTC dates [startDate, endDate] (at most 92 days), from what the computer that runs the stream stored: its own checks of the broadcast (every 5 minutes, every minute after a start) and the YouTube Analytics it pulled for each ended broadcast. Per channel: `totals` and `days` (UTC) with samples, onAirMs (broadcast live), notLiveMs (stream on, broadcast not live), dataGaps (no check for over 10 minutes: not counted), viewerHours, averageViewers (time-weighted), peakViewers, interruptions (encoder runs that ended early and were restarted); `broadcasts` (a segment is its own broadcast) with the same figures, firstSampleAt/lastSampleAt, `youtube` (null until pulled: { status collected | failed | unavailable, final, collectedAt, concurrent { average, peak }, live { views, minutesWatched }, onDemand { views, minutesWatched } } -- pulled an hour after the broadcast ended and once more 4 days later) and `analyticsCollected` (true once that final pull is stored: deleting the recording loses nothing stored here). Unknown is null, never 0. A computer that runs no stream has no samples. Local data only, never a live YouTube call.",
      inputSchema: producerUploadMilestonesInputSchema,
    },
    async (args: z.infer<typeof producerUploadMilestonesInputSchema>) => toolSuccessResult(await producerSession!.liveAnalytics(args))
  );

  // BL-163 (FO-REQ-0014 §C, docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md §2.C): the Producer proposes, the owner decides in
  // the Web UI, the system applies. These tools reach only the proposal store's Producer side (`ProducerSession.proposals`).
  registerTool(
    "producer_propose",
    {
      description:
        "Propose ONE change to the research watchlist, the hypotheses or an experiment's videos of one of our channels. It changes nothing: the owner sees it in YT Manager (Research → Inbox, \"Agent proposals\") with your `text`, approves it in one click, or rejects it with a required comment. Read the outcome with producer_list_proposals. `channelId` = the channel of ours it is for (one of producer_list_channels); `text` (1-4000 characters after trimming) = what and why. The owner's card already shows the entry's current newest-upload date and pause next to your text, and your text is stored until 90 days after the decision, while other channels' YouTube data may be kept 30 days at most (YouTube API policy) -- so cite the entry, not its statistics. `kind` and its `payload` (strict): " +
        "watchlist.add {competitorChannelId: the competitor's UC... channel id (a handle or URL is not accepted -- no YouTube call is made), reason: why it is watched -- stored on the entry when the entry is new, handleOrUrl?: shown in the list, also only for a new entry} -- adds it to the watchlist if needed and makes this channel follow it; " +
        "watchlist.unfollow {researchChannelId} -- this channel stops following it, the entry stays for the others; " +
        "watchlist.pause / watchlist.resume {researchChannelId} -- stops / restarts its collection, for every channel; " +
        "watchlist.delete {researchChannelId} -- deletes it from the watchlist completely, with its stored history, for every channel; " +
        "hypothesis.add {statement, evidenceNotes} -- a new hypothesis of this channel, created as yours (createdBy producer, createdVia mcp) when approved; " +
        "experiment.link_video {experimentId (from agent_get_hypothesis_trail), videoId (a synced video of this channel, any visibility, so a planned upload too), arm: 1-32 letters, digits, spaces, _ or -, starting with a letter or digit, e.g. control, A, B} -- puts the video into that arm of the experiment, linked as yours (linkedVia producer_proposal) when approved; the experiment's hypothesis must be this channel's and the experiment proposed, approved or running; a video is in one arm of an experiment at most, and an experiment has 50 videos at most. " +
        "Every watchlist kind except add must name an entry this channel follows (query_competitors with this channelId). Refused at once: an entry the channel does not follow (RESEARCH_CHANNEL_NOT_AVAILABLE), a channel not connected here (CHANNEL_NOT_ACTIVE), a change that does not fit the current state, e.g. pausing a paused entry (AGENT_PROPOSAL_NOT_APPLICABLE), the same proposal already waiting (AGENT_PROPOSAL_DUPLICATE, details.proposalId and details.source -- pause, resume and delete: one per entry, whoever proposed it, the system's own deletion proposals for inactive entries included, which producer_list_proposals does not list; add and unfollow: per entry and channel), a payload that does not match its kind (validation_failed), for experiment.link_video also EXPERIMENT_NOT_FOUND (no such experiment of this channel), EXPERIMENT_ARM_VIDEO_NOT_FOUND, EXPERIMENT_ARMS_FROZEN (concluded or abandoned), EXPERIMENT_ARM_VIDEO_ALREADY_LINKED and EXPERIMENT_ARMS_FULL -- its AGENT_PROPOSAL_DUPLICATE is one pending proposal per video and experiment -- and while the app is paused for a device handoff or recovery (operation_lock_held / device_in_recovery_mode). Returns { proposal } (status pending) and forChannelId.",
      inputSchema: producerProposeInputSchema,
    },
    async (args: z.infer<typeof producerProposeInputSchema>) => toolSuccessResult({ proposal: await producerSession!.proposals.submit(args) })
  );

  registerTool(
    "producer_list_proposals",
    {
      description:
        "Your proposals, newest first (at most 500), with their status: pending (waiting for the owner), applied (approved and made), rejected (with the owner's `rejectComment` -- the reason, for you), failed (approved, but the change could not be made: `applyError`; never retried by itself). Optional filters: channelId (the answer then also carries forChannelId), status. Mark decided ones read with producer_mark_proposals_done: they leave the store at once and are not listed again; a decided proposal is also gone 90 days after the decision; a pending one never expires. A local read that changes nothing.",
      inputSchema: producerListProposalsInputSchema,
    },
    async (args: z.infer<typeof producerListProposalsInputSchema>) => toolSuccessResult(await producerSession!.proposals.list(args))
  );

  registerTool(
    "producer_mark_proposals_done",
    {
      description:
        "Mark decided proposals (applied, rejected or failed) as read: they leave the proposal store. A pending one is never marked (it stays for the owner). Returns `marked` and `notMarked` (pending, unknown, already gone, or not yours). Up to 100 ids per call. Refused while the app is paused for a device handoff or recovery (operation_lock_held / device_in_recovery_mode).",
      inputSchema: producerMarkProposalsDoneInputSchema,
    },
    async (args: z.infer<typeof producerMarkProposalsDoneInputSchema>) => toolSuccessResult(await producerSession!.proposals.markDone(args))
  );

  // BL-239 (docs/roadmap/plans/UPLOAD_QUEUE_CONTROL_PLAN.md, ADR 0059; owner msgs 3928/3930): this computer's upload queue. These
  // tools reach only the session's `uploadQueue` (the publishing module's queue control); channel workers and the factory get none.
  registerTool(
    "producer_upload_queue_list",
    {
      description:
        "This computer's upload queue -- ONE queue for every channel; one file is sent at a time. Returns `autoUploadSwitchOn` (the owner's automatic-upload switch here: producer_upload_queue_add works only while it is on), `inProgress` (rows being sent, processed by YouTube, finished, or paused: status uploading | processing | finishing | paused, with resumeStatus, pausedReason live_writes_off | quota_exceeded | upload_limit | auth, pausedUntil, progressPercent) and `queue` (the rows waiting, status queued, in the order they start: position 1 starts next). Every row: uploadId, channelId, channelTitle, video, title, sizeBytes, status, queuedBy (owner | automatic | producer), slotId (the weekly-plan slot, or null), publishAt (the date it will get, from an approved slot, or null) and publishAtSet (already on the video), createdAt; a queued row also bytesAhead (bytes still to send before it can start: the rest of the file being sent plus the queued rows before it). Also queuedCount and queuedBytes. No ETA (no upload speed is stored). Rows of other computers are not here. A local read, no YouTube call.",
      inputSchema: z.object({}).strict(),
    },
    async () => toolSuccessResult(await producerSession!.uploadQueue.list())
  );

  registerTool(
    "producer_upload_queue_add",
    {
      description:
        "Queue one ready release package of a channel for upload on THIS computer: it joins the end of the queue (move it with producer_upload_queue_move). Only where the owner's automatic-upload switch is on (upload_auto_switch_off otherwise: that computer uploads). The package must pass the automatic upload's own checks: ready (agent_get_publishing_calendar lists packages and their problems), its manifest has a top-level `sha256`, the video file has exactly the manifest's size and SHA-256 (hashed now: a large file takes a while), not queued or uploaded here or on another computer, its weekly-plan slot not vetoed; and the owner's approval rules: the day's 100-upload bucket and the quota (an unknown quota is never accepted for him), tags within 500 characters, publishing settings not in conflict between computers. The video is uploaded PRIVATE. Its date comes only from the weekly-plan slot it names when the owner APPROVED that slot more than 15 minutes ahead (since 1.16.0, in the channel's packaged approval stage: approved together with THIS package -- the same manifest SHA-256; a package changed since gets no date); otherwise none, and the plan sets it when the owner approves the slot -- you never give a date. One try per manifest version: a version that already had an upload row here (the owner's, automatic, failed, done, or cancelled by the owner) is refused (upload_already_tried) and stays the owner's; one you queued yourself and then cancelled can be added again, and so can a version the owner approved in package review whose rows here were all cancelled before that approval (1.22.0). Input: channelId, video (e.g. V61, or S14 for a Short: 1.23.0), optional manifestSha256 (the version you mean). Returns { upload: { uploadId, channelId, video, status queued, queuedBy producer, slotId, publishAt, position, queueLength } } and forChannelId. Errors: upload_auto_switch_off, publishing_settings_not_saved (1.35.0: the channel's publishing settings were never saved in YT Manager -- the owner saves them on Home first; nothing is queued), CHANNEL_NOT_ACTIVE (not connected here), package_no_workspace, package_workspace_unavailable, upload_package_not_ready (no such video number, or not ready: details.problems), upload_package_changed, validation_failed (two packages name the video: pass manifestSha256), upload_package_no_sha256, upload_already_queued, upload_slot_taken, upload_slot_vetoed, upload_already_tried, upload_video_mismatch (details.reason size | sha256 | unreadable), upload_daily_limit, quota_insufficient, quota_unknown, upload_tags_too_long, publishing_settings_changed, operation_lock_held / device_in_recovery_mode (the app is paused for a device handoff or recovery).",
      inputSchema: producerUploadQueueAddInputSchema,
    },
    async (args: z.infer<typeof producerUploadQueueAddInputSchema>) => toolSuccessResult(await producerSession!.uploadQueue.add(args))
  );

  registerTool(
    "producer_upload_queue_move",
    {
      description:
        "Move a waiting upload (status queued) of any channel to another place in this computer's shared queue: position 1 starts next, a position past the end puts it last; the other queued rows keep their order. It only changes which queued row starts next: the row being sent, processed or finished is never interrupted. (A row whose channel hit YouTube's upload limit, or that waits for a retry, is passed over until then.) Input: channelId (the row's channel), uploadId, position. Returns { uploadId, channelId, video, from, position, queueLength, moved } and forChannelId. Errors: upload_not_found (no such upload of that channel here), upload_not_movable (it is not queued any more), upload_queue_changed (a queued row started or was cancelled meanwhile: nothing moved, list and try again), operation_lock_held / device_in_recovery_mode.",
      inputSchema: producerUploadQueueMoveInputSchema,
    },
    async (args: z.infer<typeof producerUploadQueueMoveInputSchema>) => toolSuccessResult(await producerSession!.uploadQueue.move(args))
  );

  registerTool(
    "producer_upload_queue_cancel",
    {
      description:
        "Cancel an upload of any channel that has not reached YouTube, or stop one being sent (since 1.18.0). A waiting row (status queued) leaves the queue. A row being sent (status uploading), or paused while queued or sending, is stopped as long as its last chunk was never sent: sending stops (at most the chunk already on the wire finishes), no video is made, the resumable session is abandoned (it expires by itself; nothing else is called) -- a stopped row starts from the beginning if it is queued again. Once the last chunk went, YouTube may have made the video: such a row (and any row processing, finishing, done, failed or cancelled) is refused with upload_not_cancellable and runs to its end; the owner deletes the video in Studio if it is not wanted. A row you queued yourself can be added again with producer_upload_queue_add; a row the owner approved (or the automatic upload queued) that you cancel or stop stays the owner's to queue again. Input: channelId (the row's channel), uploadId. Returns { uploadId, channelId, video, status cancelled, previousStatus (queued | uploading | paused), storedBytes, totalBytes (the bytes YouTube had at the stop) } and forChannelId. Errors: upload_not_found (no such upload of that channel here), upload_not_cancellable (details.reason: final_chunk_sent -- the last chunk was already sent; video_exists; status -- not active; changed -- it changed meanwhile, list and try again), operation_lock_held / device_in_recovery_mode.",
      inputSchema: producerUploadQueueCancelInputSchema,
    },
    async (args: z.infer<typeof producerUploadQueueCancelInputSchema>) => toolSuccessResult(await producerSession!.uploadQueue.cancel(args))
  );

  // BL-255 (ADR 0069, owner msgs 4380/4383): replace an uploaded video's thumbnail -- the session's `thumbnails` only.
  registerTool(
    "producer_video_thumbnail_replace",
    {
      description:
        "Replace the custom thumbnail of a video already on YouTube (any video of a channel connected here: private, scheduled or public) with an image from the channel's workspace. Nothing else of the video changes: no title, privacy, date, plan slot, approval or package. Input: channelId, videoId, path (relative to the channel's workspace, under 04 Videos/, a .jpg/.jpeg/.png of at most 2 MB -- a JPEG or PNG by its first bytes), dryRun (optional). With dryRun: every read and check, no backup and no write. Otherwise: the current thumbnail is backed up, the channel identity is checked, the owner's Live writes switch must be on, thumbnails.set is called once (50 units; 52 with the two reads), then read back. Returns { channelId, videoId, path, dryRun, file { bytes, contentType, sha256 }, before / after { hasCustomThumbnail, privacyStatus, publishAt, url }, units, written, backupPath, verified (true when YouTube shows a custom thumbnail, privacy / publishAt are unchanged and the image it serves is no longer the backed-up one), verificationDetail, imageChanged (null when not compared) } and forChannelId. Errors: thumbnail_file_invalid (path or image not usable), video_not_in_channel (YouTube does not return the video for that channel), thumbnail_step_pending (this computer's upload of the video has not set its own thumbnail yet -- try after it finished), WRITE_CHANNEL_UNRESOLVED (channel not connected here), WRITE_CHANNEL_MISMATCH, live_writes_disabled, backup_item_failed, operation_lock_held / device_in_recovery_mode.",
      inputSchema: producerVideoThumbnailReplaceInputSchema,
    },
    async (args: z.infer<typeof producerVideoThumbnailReplaceInputSchema>) => toolSuccessResult(await producerSession!.thumbnails.replace(args))
  );

  // BL-267 (ADR 0073 §5, plan §3.10; owner TG 4630/4636): the weekly plan -- the session's `plans` only.
  registerTool(
    "producer_week_template_get",
    {
      description:
        "A channel's week template (1.25.0): { channelId } -> { template (the one in force, week-template/1: format, channelId, versionId, contentHash, horizonWeeks, displayTimeZone, days: { mon..sun: [{ kind: long | short, hours?, publishTimeUtc 'HH:MM' }] }) | null, proposal (your newest proposal the owner has not decided) | null, matchRules: { shortMaxSeconds: 180, hoursTolerance: 0.1, time: exact_minute_utc, position: first_created } }. Times and weekdays are UTC; displayTimeZone is for display only. A slot whose UTC weekday and exact minute match an entry, whose package fits its kind (short <= 180 s; long with hours within ±10 %), whose package is ready or uploaded and (on a channel whose owner reviews its packages) whose media the owner approved, gets its date from the template; two slots of one kind on one position: the first created takes it. Read-only.",
      inputSchema: producerTemplateGetInputSchema,
    },
    async (args: z.infer<typeof producerTemplateGetInputSchema>) => toolSuccessResult(await producerSession!.plans.templateGet(args))
  );

  registerTool(
    "producer_week_template_propose",
    {
      description:
        "Propose a week template for a channel (1.25.0, DRAFT): { channelId, template: week-template/1 { format: 'week-template/1', channelId (the same), horizonWeeks (1-8), displayTimeZone? (IANA), days: { mon..sun?: [{ kind: long | short, hours? (long only, 0.25-12 in steps of 0.25), publishTimeUtc ('HH:MM' UTC, minutes a multiple of 5) }] (at most 6 a day) } } } -> the same answer as producer_week_template_get, plus proposed (false: the same as in force or as your pending proposal -- nothing written). Nothing is dated by a proposal: only the owner accepts, edits or rejects it in YT Manager (Контент → План → Шаблон недели). Errors: validation_failed (details.refused: [{ field, reason: unknown_field | invalid | channel_mismatch | time_zone_invalid | hours_on_short | hours_invalid | time_invalid | too_many_entries | template_duplicate_entry | horizon_invalid }]), publishing_plan_channel_unavailable.",
      inputSchema: producerTemplateProposeInputSchema,
    },
    async (args: z.infer<typeof producerTemplateProposeInputSchema>) => toolSuccessResult(await producerSession!.plans.templatePropose(args))
  );

  registerTool(
    "producer_publishing_plan_get",
    {
      description:
        "One weekly publishing plan of a channel with every slot (1.25.0): { channelId, weekStart } -> { plan } as factory_publishing_plan_get: each slot carries contentHash (pass it to producer_publishing_plan_move_slot), dating { source: template | owner | null, state: dated | will_date | on_template_awaiting_package | awaiting_media_review | off_template | position_taken | foreign_date | vetoed | released, position?, heldBy? }, foreignPublishAt (a date YouTube carries that this computer did not set), movedFrom, youtubePublishAt, package, status. Read-only.",
      inputSchema: producerPlanGetInputSchema,
    },
    async (args: z.infer<typeof producerPlanGetInputSchema>) => toolSuccessResult(await producerSession!.plans.get(args))
  );

  registerTool(
    "producer_publishing_plan_list",
    {
      description: "A channel's weekly publishing plans, newest week first (1.25.0): { channelId, limit? (1-52, default 12) } -> { plans: [the plan's fields without slots] }. Read-only.",
      inputSchema: producerPlanListInputSchema,
    },
    async (args: z.infer<typeof producerPlanListInputSchema>) => toolSuccessResult(await producerSession!.plans.list(args))
  );

  registerTool(
    "producer_publishing_plan_move_slot",
    {
      description:
        "Move a slot of a channel's weekly plan to any day, time or week (1.25.0, PLAN_MOVE) -- on or off the template, keeping its slot id, the package that names it and its media review. Immediate: it does not wait for the owner. When the slot's video already has a date on YouTube, the new date is written at once (this computer's finished upload row of the video, the channel identity check, a backup, the owner's Live writes switch immediately before videos.update, a read-back, audited with actor producer); it may change a date set by hand in Studio. A move never gives a first date: an undated slot only changes position, and the template rule decides whether it gets one. A dated video moved off the template keeps its new date. Input: channelId, slotId, contentHash (as producer_publishing_plan_get showed it), toWeekStart (a Monday), date, publishAt (local wall time in the target plan's zone), dryRun? (true: every check and read, nothing written). Returns { plan (the target week, null on dryRun), moved, dryRun, from, to { weekStart, date, publishAt, publishAtUtc, timeZone }, youtube: { effect: moves | plan_only | none, previous, result?: verified, publishAt? }, displaces: [{ slotId, weekStart, publishAtUtc, video }] (template positions this move takes from other slots, which become position_taken; also on dryRun) } and forChannelId. The YouTube write comes first: a write not read back verified leaves the plan unchanged and is refused (publishing_plan_move_youtube_failed); moving to the same place retries a YouTube date that differs from the slot's time. Errors: publishing_plan_slot_not_found, publishing_plan_slot_vetoed, publishing_plan_slot_past, publishing_plan_changed (stale contentHash), publishing_plan_already_published (the video is public or unlisted), publishing_plan_slot_too_soon (the slot or its date within 15 minutes), publishing_plan_move_not_here (a dated video with no finished upload here: move it on the computer that uploaded it), publishing_plan_move_youtube_unavailable (Live writes or Data API reads off), publishing_plan_move_youtube_failed (the new date was not read back on YouTube; nothing changed), publishing_plan_move_upload_active (this computer still uploads the slot's video: move it once the upload is done), validation_failed (details.refused: toWeekStart / date / publishAt with week_start_not_monday | date_invalid | outside_week | publish_at_invalid | date_mismatch | in_past (less than 30 minutes ahead) | beyond_horizon (more than 52 weeks) | too_many_slots), publishing_plan_channel_unavailable.",
      inputSchema: producerPlanMoveInputSchema,
    },
    async (args: z.infer<typeof producerPlanMoveInputSchema>) => toolSuccessResult(await producerSession!.plans.move(args))
  );

  // BL-265 (ADR 0072 §5, §8; owner TG 4578/4581): fix an uploaded video's packaging from its package -- the session's `packageMetadata` only.
  registerTool(
    "producer_video_metadata_update",
    {
      description:
        "Fix the default-language title, description and tags of a video already on YouTube from its release package's CURRENT manifest (1.24.0) -- e.g. after the factory re-packaged it for a packaging test. Only those three fields, only the values the package states (never text of yours; a package without its own tags uses the channel's common tags, as the upload did), only the fields that differ; never translations (those only with localizations: true, below), privacy, date, category (producer_video_category_fix, from the channel's saved setting) or languages, and never automatically. Input: channelId, video (V61 or S14), dryRun (optional; call it first), expectedManifestSha256 (optional: the dry run's manifestSha256 -- refused with package_metadata_manifest_changed when the package was re-packaged since). Three-way check per field: YouTube now / what this video's upload sent (this computer's finished upload row, or the latest earlier fix here) / the package. A field equal on YouTube and in the package is not written; one YouTube still has as uploaded is written; one that differs from both (changed in Studio, or the upload ran on the other computer so what it sent is unknown here) is a conflict -- refused for you (package_metadata_conflict, details.conflicts): only the owner may overwrite it in YT Manager. dryRun returns { dryRun: true, video, videoId, manifestSha256, etag, baseline (upload_row | metadata_apply | unknown), fields: [{ field, youtube, uploaded, manifest, status: same | write | conflict }], changed, audioLanguageLeftOut, quotaUnits (54), thumbnail: { path, differs } | null } -- no backup and no write. Otherwise, with no conflict: the device gate, the channel identity check, a backup of the current snippet, the owner's Live writes switch immediately before videos.update (a full snippet read-merge-write: category and languages sent back exactly as read just before; an audio language read as zxx is left out), then a read-back of the written fields and of the untouched ones (category, languages, privacy, publishAt) and the localization languages; audited with source package_metadata, actor producer. Returns { dryRun: false, video, videoId, manifestSha256, changed, written, skippedConflicts, verified, backupPath, audioLanguageLeftOut } and forChannelId. A thumbnail that differs is replaced with producer_video_thumbnail_replace. TRANSLATIONS (1.31.0, owner TG 4839/4842): with localizations: true the call fixes instead the video's per-language titles/descriptions from the package's current manifest `localizations` (the set the upload's translations step sent; never text of yours; never the video's own default language, which is the title/description above; a language the video has and the package lacks is kept, never removed; nothing else changes). One YouTube write per call: run it without the flag for the texts and with it for the translations. Three-way check per language and field: YouTube now / what this computer's upload sent (its finished upload row when its translations step read back verified, or 'none sent' when the package had none then; or the latest earlier translations fix here) / the package -- same, write, or conflict (unknown, e.g. uploaded from the other computer, makes every difference a conflict). Any conflict refuses the whole call (package_localizations_conflict, details.conflicts [{ language, fields }]). dryRun returns { dryRun: true, kind: 'localizations', video, videoId, manifestSha256, etag, baseline (upload_row | localizations_apply | unknown), defaultLanguage, languages: [{ language, status, uploadedKnown, fields: [{ field, youtube, uploaded, package, status }] }], kept, ownLanguageSkipped, changed, quotaUnits (56) }. Otherwise: the same gates, then the shared translations writer (identity check, backup of the current translations, a recheck that the languages it writes still read as checked -- else video_details_conflict, nothing sent -- the owner's Live writes switch immediately before videos.update part=snippet,localizations with every other language kept and the snippet sent back as read, read-back of the written and the kept languages and the snippet) and a read-back of privacy and publishAt; audited with source package_localizations, actor producer. Returns { dryRun: false, kind: 'localizations', video, videoId, manifestSha256, changed, written, kept, verified }; a read-back that differs is update_failed (details.problem / details.changedUntouched). Errors: upload_package_not_ready (no package of that video here), package_metadata_manifest_changed, package_metadata_not_uploaded (not on YouTube yet: no upload record), package_metadata_invalid (the package's texts break YouTube's limits: details.problems), upload_steps_pending (this computer's upload of it has not finished its read-back), video_missing (not on YouTube any more), video_not_in_channel, package_metadata_conflict, video_details_conflict (the video changed while it was written: run again), CHANNEL_NOT_ACTIVE, WRITE_CHANNEL_MISMATCH, live_writes_disabled, update_failed (the read-back differs: details), operation_lock_held / device_in_recovery_mode.",
      inputSchema: producerVideoMetadataUpdateInputSchema,
    },
    async (args: z.infer<typeof producerVideoMetadataUpdateInputSchema>) => toolSuccessResult(await producerSession!.packageMetadata.update(args))
  );

  // BL-269 (ADR 0074 §8, §10; owner TG 4590/4592/4660): a package's English captions onto its uploaded video -- the session's `captions` only.
  registerTool(
    "producer_video_captions_add",
    {
      description:
        "Put a release package's English captions onto the video its upload record names (1.26.0, CAPTIONS_WRITE) -- e.g. V19, V27 and later WWE long videos uploaded before captions existed, or after the factory fixed the file. Only the captions the package's CURRENT manifest states (`captions`: one English .vtt/.srt inside its folder, its SHA-256), never a file of yours; only on a channel whose owner turned captions on and only on a horizontal long video (an S code or a vertical frame is refused). Input: channelId, video (V27), dryRun (optional; call it first), overwrite (optional), expectedManifestSha256 and expectedTrackId (optional: the dry run's manifestSha256 and target.trackId). Without overwrite: an English standard or forced track already on the video refuses -- captions_foreign_track (a track the app did not add) or captions_own_track_differs (the app's own, from another file); one the app added from this very file is already present (no write). With overwrite: true (owner's decision, TG 4660) the video's one English standard track -- foreign or the app's own -- is replaced with the package's file (captions.update keeps its id and name); refused when there is more than one English track (captions_track_ambiguous), the only one is forced (captions_track_forced) or a draft (captions_track_draft); no English track: a plain insert. ASR tracks are never touched; nothing is ever deleted. dryRun returns { dryRun: true, video, videoId, manifestSha256, mode (insert | update | none), target { trackId, language, name, trackKind, lastUpdated, ours } | null, englishTracks, units (51), writeUnits (550 insert / 800 overwrite) } -- no download, backup or write. Otherwise: the device gate, the quota guard, a backup (the track list and the file; an overwrite also downloads the replaced track's current text first -- if that fails nothing is written), the channel identity check, the owner's Live writes switch immediately before the one captions.insert / captions.update, then a read-back (the track serving, its language and name, an overwrite's lastUpdated advanced, every other track unchanged); audited with source video_captions, actor producer; the release's V<n>_youtube.json then lists the track as the app's own. Returns { mode, written, alreadyPresent, trackId, trackName, verified, verificationDetail, pending (YouTube still processing), backupPath, recorded, uploadStepsMarked, ... } and forChannelId. Errors: upload_package_not_ready, package_metadata_not_uploaded (no upload record yet: captions go up with the upload), package_metadata_manifest_changed, captions_not_in_package, captions_missing, captions_invalid (details.reason: channel_disabled, not_horizontal, orientation_unknown, count, language, name, size, sha256, format), captions_step_pending (this computer's upload of it is still running its steps), captions_upload_unfinished (the upload record is still the runner's first one -- that upload, maybe on the other computer, has not finished its steps), captions_foreign_track, captions_own_track_differs, captions_track_ambiguous, captions_track_forced, captions_track_draft, captions_track_changed, captions_scope_missing (the owner must reconnect the channel), video_not_in_channel, youtube_quota_exceeded, backup_item_failed, WRITE_CHANNEL_MISMATCH, live_writes_disabled, operation_lock_held / device_in_recovery_mode.",
      inputSchema: producerVideoCaptionsAddInputSchema,
    },
    async (args: z.infer<typeof producerVideoCaptionsAddInputSchema>) => toolSuccessResult(await producerSession!.captions.add(args))
  );

  // BL-241 (docs/roadmap/plans/CLIP_REVIEWS_PLAN.md, ADR 0061; owner msgs 4010/4011): clips for review. These tools reach only the
  // session's `clipReviews` (the clip-reviews module's Producer surface); the owner's approve / return is Web-UI-only.
  registerTool(
    "producer_clip_review_submit",
    {
      description:
        "Ask the owner to watch a short clip and approve it or send it back -- he answers in YT Manager (Контент → «Клипы»), not in Telegram. The clip must already be a file in the channel's own folder (the Factory Operator renders it there; you never write into a channel folder): `clipPath` relative to the channel's workspace folder, '/' between folders, no '..' and no absolute path, the file's real path inside the folder (a symlink out of it is refused), .mp4 or .webm, 5-300 s long by ffprobe (±0.5 s), any size. Optional `startSec` / `endSec`: the part to watch (0 <= startSec < endSec <= the clip's length). Its size and SHA-256 are stored: the owner approves exactly this file, so do not overwrite it while it waits (a changed file cannot be approved). Both computers see the clip (the channel folder syncs; a computer whose copy is missing says so). Returns { clip } with status pending and forChannelId; clip.source (1.36.0) is { clipId, file (the clipPath you gave), sha256 (of the bytes read now), submittedAt } -- record it with your piece so a worker can match the approved clip to its file by sha256. Errors: CHANNEL_NOT_ACTIVE (not connected here), clip_review_workspace_unavailable (no workspace folder here), clip_review_not_video, clip_review_file_unavailable (details.reason: not in the folder, outside it, not a regular file, a bad path), clip_review_probe_unavailable (the length cannot be measured here), clip_review_duration_out_of_range (details.durationSeconds), clip_review_duplicate (the same file already waits: details.clipId), clip_review_too_many_pending (50 per channel), validation_failed (a bad range or text), operation_lock_held / device_in_recovery_mode. Optional `approvedImageId` (1.28.0): the approved master still (producer_image_review_*) the clip was made from -- the owner sees that image next to the clip; the clip then carries `approvedImageId` in _get / _list. It must be an image of the same channel the owner approved (with or without a note): clip_review_image_not_found (no such image in this channel), clip_review_image_not_approved (details.status: pending, returned or withdrawn). Nothing reaches YouTube.",
      inputSchema: producerClipReviewSubmitInputSchema,
    },
    async (args: z.infer<typeof producerClipReviewSubmitInputSchema>) => toolSuccessResult(await producerSession!.clipReviews.submit(args))
  );

  registerTool(
    "producer_clip_review_list",
    {
      description:
        "One channel's clips for review and the owner's answers: pending first (oldest first), then the rest newest first; optional `status` filter and `limit` (default 50, at most 200). Each clip: clipId, channelId, sceneId, clipPath, note, startSec, endSec (null when not given), durationSeconds, sizeBytes, sha256, submittedAt, device (the computer it was submitted on), status (pending | approved | returned | withdrawn), comment (the owner's words: always on a return, optional on an approval; null otherwise), decidedAt, decidedOn (the computer the answer was given on), source (1.36.0: which file this clip is -- { clipId, file: the clipPath given at submit, sha256: the SHA-256 of the bytes read at submit, submittedAt }; file / sha256 are null only for a stored clip that lacks them; check a local file against sha256 before treating it as the approved clip), attachments (1.19.0: the files the owner attached to his answer, [] otherwise -- [{ path relative to the channel's workspace folder, e.g. '99 Data Exchange/From YTM/clip-reviews/<clipId>/<decisionId>/shot.png', name, mime, size, sha256 }]; the files reach a computer by Syncthing, so a fresh answer's files may still be on their way to the other one -- check size and sha256 before relying on one). Also `pending` (how many wait). Two computers' answers merge: the first answer the owner gave counts. A local read that changes nothing.",
      inputSchema: producerClipReviewListInputSchema,
    },
    async (args: z.infer<typeof producerClipReviewListInputSchema>) => toolSuccessResult(await producerSession!.clipReviews.list(args))
  );

  registerTool(
    "producer_clip_review_get",
    {
      description: "One clip for review by its clipId with the owner's answer: { clip } -- clipId, channelId, sceneId, clipPath, note, startSec, endSec (null when not given), durationSeconds, sizeBytes, sha256, submittedAt, device (the computer it was submitted on), status (pending | approved | returned | withdrawn), comment (the owner's words: always on a return, optional on an approval; null otherwise), decidedAt, decidedOn (the computer the answer was given on), source (1.36.0: which file this clip is -- { clipId, file: the clipPath given at submit, sha256: the SHA-256 of the bytes read at submit, submittedAt }; file / sha256 are null only for a stored clip that lacks them; check a local file against sha256 before treating it as the approved clip), attachments (1.19.0: the files the owner attached to his answer, [] otherwise -- [{ path relative to the channel's workspace folder, e.g. '99 Data Exchange/From YTM/clip-reviews/<clipId>/<decisionId>/shot.png', name, mime, size, sha256 }]; the files reach a computer by Syncthing, so a fresh answer's files may still be on their way to the other one -- check size and sha256 before relying on one). Errors: clip_review_not_found (no such clip in that channel), CHANNEL_NOT_ACTIVE.",
      inputSchema: producerClipReviewOneInputSchema,
    },
    async (args: z.infer<typeof producerClipReviewOneInputSchema>) => toolSuccessResult(await producerSession!.clipReviews.get(args))
  );

  registerTool(
    "producer_clip_review_withdraw",
    {
      description:
        "Take back a clip that still waits for the owner (status pending): it leaves his queue (status withdrawn). A clip he already answered is never withdrawn (clip_review_not_pending, details.status). Returns { clip } (with source, as in _get) and forChannelId. Errors: clip_review_not_found, clip_review_not_pending, CHANNEL_NOT_ACTIVE, operation_lock_held / device_in_recovery_mode.",
      inputSchema: producerClipReviewOneInputSchema,
    },
    async (args: z.infer<typeof producerClipReviewOneInputSchema>) => toolSuccessResult(await producerSession!.clipReviews.withdraw(args))
  );

  // BL-272 (ADR 0076; owner TG 2547 via the Producer): master still images for review. These tools reach only the session's
  // `imageReviews` (the image-reviews module's Producer surface); the owner's approve / approve with a note / return is Web-UI-only.
  const imageViewFields =
    "imageId, channelId, sceneId, imagePath, note ('' when none), batchId, requestId (null when not given), width, height, sizeBytes, sha256, submittedAt, device (the computer it was submitted on), status (pending | approved | approved_with_note | returned | withdrawn), comment (the owner's words: always on approved_with_note -- approved, but apply this note, e.g. 'убрать прохожего' -- and on returned; null otherwise), decidedAt, decidedOn (the computer the answer was given on)";
  registerTool(
    "producer_image_review_submit",
    {
      description:
        "Ask the owner to look at a scene's master still image (e.g. the 1920×1080 PNG a clip will be made from) and answer: approve, approve with a note, or return with a comment -- he answers in YT Manager (Медиа → «Кадры»), not in Telegram; each answer also lands in your Inbox as REVIEW-DECISION-image-<imageId>-<decisionId>.md. The image must already be a file in the channel's own folder (you never write into a channel folder): `imagePath` relative to the channel's workspace folder, '/' between folders, no '..' and no absolute path, the file's real path inside that channel's folder (a symlink out of it, or into another channel's folder, is refused), .png / .jpg / .jpeg whose header is that format, at most 50 MB. Its size and SHA-256 are stored: the owner approves exactly this file, so do not overwrite it while it waits (a changed file cannot be approved). Several submits with the same `batchId` are one batch, shown to the owner as one grid (at most 40 images per batch). `requestId` makes the submit idempotent: a retry with the same requestId answers the stored image with `replayed: true` (even after the file changed or the owner answered); the same requestId with a different request is refused. Returns { image, replayed } and forChannelId. Errors: CHANNEL_NOT_ACTIVE (not connected here), image_review_workspace_unavailable (no workspace folder here), image_review_not_image (not PNG/JPEG, header of another format, unreadable, too large, a side outside 16-16384 px), image_review_file_unavailable (details.reason: not in the folder, outside it, not a regular file, a bad path), image_review_duplicate (the same file already waits: details.imageId), image_review_too_many_pending (200 per channel), image_review_batch_full (40 per batch), image_review_request_conflict (details.imageId), validation_failed, operation_lock_held / device_in_recovery_mode. Nothing reaches YouTube.",
      inputSchema: producerImageReviewSubmitInputSchema,
    },
    async (args: z.infer<typeof producerImageReviewSubmitInputSchema>) => toolSuccessResult(await producerSession!.imageReviews.submit(args))
  );

  registerTool(
    "producer_image_review_list",
    {
      description: `One channel's master still images for review and the owner's answers: pending first (oldest first), then the rest newest first; optional \`status\` and \`batchId\` filters and \`limit\` (default 50, at most 200). Each image: ${imageViewFields}. Also \`pending\` (how many wait, within the batch when \`batchId\` is given). Two computers' answers merge: the first answer the owner gave counts. A local read that changes nothing.`,
      inputSchema: producerImageReviewListInputSchema,
    },
    async (args: z.infer<typeof producerImageReviewListInputSchema>) => toolSuccessResult(await producerSession!.imageReviews.list(args))
  );

  registerTool(
    "producer_image_review_get",
    {
      description: `One master still image for review by its imageId with the owner's answer: { image } -- ${imageViewFields}. Errors: image_review_not_found (no such image in that channel), CHANNEL_NOT_ACTIVE.`,
      inputSchema: producerImageReviewOneInputSchema,
    },
    async (args: z.infer<typeof producerImageReviewOneInputSchema>) => toolSuccessResult(await producerSession!.imageReviews.get(args))
  );

  registerTool(
    "producer_image_review_withdraw",
    {
      description:
        "Take back an image that still waits for the owner (status pending): it leaves his grid (status withdrawn). An image he already answered is never withdrawn (image_review_not_pending, details.status). Returns { image } and forChannelId. Errors: image_review_not_found, image_review_not_pending, CHANNEL_NOT_ACTIVE, operation_lock_held / device_in_recovery_mode.",
      inputSchema: producerImageReviewOneInputSchema,
    },
    async (args: z.infer<typeof producerImageReviewOneInputSchema>) => toolSuccessResult(await producerSession!.imageReviews.withdraw(args))
  );

  // BL-271 (WAIT_TOOLS_PLAN.md §3.2, ADR 0075; Q6): the Producer waits on an upload of this computer (any channel, as the queue list
  // shows them) or on a restart -- nothing else (invalid_request, refused here so the call log records it). A read: not counted as MCP
  // activity (UNCOUNTED_PRODUCER_TOOLS), no mutation gate.
  registerTool(
    "producer_wait",
    {
      description:
        "Wait until ONE upload of this computer, or a restart, is final -- without polling (Producer API 1.27.0): { target: upload | restart, id, channelId?, timeoutSeconds? (default 50, clamped to 1-240) } -> { target, id (the resolved id), final, outcome, status, snapshot, waitedSeconds, nextCallHint? } (and forChannelId when channelId is given). upload: id = uploadId (producer_upload_queue_list), or the video code (V61, S14) with channelId -- the newest upload row of that video here; still running while queued / uploading / processing / finishing, or paused for quota_exceeded / upload_limit (it resumes by itself); final: done (succeeded: every step after the upload -- translations, captions, thumbnail, read-back, date -- passed; partly_failed when done with snapshot.errorCode verify_mismatch / step_failed / publish_at_too_soon: the video is on YouTube but a step did not pass), failed, cancelled; it answers at once with final: false, outcome blocked, when the upload is paused for auth or live_writes_off (only the owner can fix that). restart: id = a restart request id, or current (the request open or restarting now); final: done (succeeded; snapshot.toVersion / toSchema), expired, cancelled; no_restart_request when nothing is open (details.serverStartedAt, details.lastRestart). It reads at once (already final: immediate answer), then every 10 s (restart 5 s), and answers ONCE: final, or timeoutSeconds passed (final: false, outcome still_running -- never an error), or early with final: false and outcome restarting / server_stopping. Act only on final: true. MCP clients kill a call after their own tool timeout (Claude Code: about 60 s unless the server entry sets a higher timeout), so keep timeoutSeconds under it; for a longer wait run the CLI as a background shell command: npm --prefix <app folder> run --silent wait -- upload <uploadId> (or restart current) with your Producer token in YTOM_TOKEN (or --token-env <VAR>) -- one JSON line when final; exit 0 succeeded, 1 failed / partly_failed / cancelled / expired, 2 otherwise. Any other target is invalid_request. Errors: not_found (no such upload or request here), invalid_request, target_unavailable, no_restart_request. Read-only and local: no YouTube call, no write; not counted as MCP activity for the restart's quiet window.",
      inputSchema: z
        .object({
          target: z.string().min(1).max(32),
          id: z.string().min(1).max(128),
          channelId: z.string().min(1).max(64).optional(),
          timeoutSeconds: z.number().optional(),
        })
        .strict(),
    },
    async (args: { target: string; id: string; channelId?: string; timeoutSeconds?: number }) => {
      if (args.target !== "upload" && args.target !== "restart") {
        throw new DomainError({ code: "invalid_request", message: "The Producer waits only on target upload or restart.", details: { field: "target" } });
      }
      return toolSuccessResult(await producerSession!.wait.waitFor(args, { channelId: null }));
    }
  );

  // Package playlists (owner TG 4858/4859): a video's playlists on its channel -- the session's `videoPlaylists` only (a read).
  registerTool(
    "producer_video_playlists",
    {
      description:
        "Which playlists of its channel a video is in (Producer API 1.33.0, read-only): { channelId, videoId, refresh? } -> { channelId, videoId, playlists: [{ id, title, privacyStatus }] (the channel's playlists that hold the video now), checkedPlaylists, truncated (more than 200 playlists: only the first 200 checked), readAt, cached (true: the answer kept from a read in the last 10 minutes, no YouTube call; a kept answer older than an upload playlist result of the video is not used; refresh: true reads now, at most once a minute per video -- sooner returns the kept answer with `note`), quotaUnits (Data API units this call spent: 1 identity check + the playlist list when not kept -- its channels.list 1 + 1 per 50 playlists -- + 1 per playlist checked; 0 when cached), uploads: [{ uploadId, video, status, finishedAt, settingsPlaylist (the channel's publishing playlist: added | already_there | none | failed; null before the step ran), playlists: [{ playlistId, source: settings | package, result: added | added_unverified (publishing playlist: YouTube accepted it, the read-back did not show it) | already_there | failed | adding | inserted | sent_unknown, reason? (not_found | other_channel | ownership_unchecked | ownership_unreadable | membership_unreadable | write_failed | read_back_missing | read_back_unreadable | unknown_outcome), at }] }] (this computer's uploads of the video and what their playlist step recorded -- local, 0 units) } and forChannelId. A release package (yt-release-package/2) may name `playlists` (0-10 playlist ids of its own channel): the upload adds the video to each besides the publishing playlist; a failed package playlist never holds back the date. Errors: CHANNEL_NOT_ACTIVE (not connected on this computer), video_not_in_channel (not a synced video of this channel nor one of its uploads here; checked before any YouTube call), WRITE_CHANNEL_MISMATCH / WRITE_CHANNEL_UNRESOLVED (the channel's sign-in is for another channel), validation_failed.",
      inputSchema: producerVideoPlaylistsInputSchema,
    },
    async (args: z.infer<typeof producerVideoPlaylistsInputSchema>) => toolSuccessResult(await producerSession!.videoPlaylists.get(args))
  );

  // BL-279 (owner TG 4963/4964, ADR 0072 amendment 2): the category of the channel's package-uploaded videos -- the session's `videoCategory` only.
  registerTool(
    "producer_video_category_fix",
    {
      description:
        "Set the YouTube category of a channel's videos that a release package put on YouTube (their upload record names the video) to the channel's SAVED publishing setting categoryId (Producer API 1.35.0, METADATA_WRITE) -- e.g. WWE videos uploaded as Music (10) before its settings were saved. Never a category of yours, never another field: title, description, tags, defaultLanguage and defaultAudioLanguage are sent back exactly as read just before (videos.update part=snippet), translations, privacy and the date are never touched, never automatically. Refused with publishing_settings_not_saved (details.field categoryId) when the channel's category itself was never saved (the built-in default is never pushed), and publishing_settings_changed when it differs between the computers (Merge) or changed since your dry run. Input: channelId, dryRun (call it first), videoIds (optional, apply only: some of the dry run's videos; a video no package of the channel uploaded -- or one the owner only linked to its release -- refuses the call: package_metadata_not_uploaded), expectedCategoryId (required to apply: the dry run's targetCategoryId; validation_failed without it). dryRun returns { dryRun: true, channelId, targetCategoryId, videos: [{ video, videoId, title, current, status: write | same | upload_pending | not_on_youtube | not_in_channel | audio_language_zxx (YouTube's audio language is zxx: skipped, never written) }], toWrite, quotaUnits } -- one videos.list per 50 videos, no backup and no write. Otherwise, one video at a time: the device gate, a fresh read (a video already in the saved category, or with the audio language zxx, is not written; the translation languages must read before the write or nothing is written), the channel identity check, a backup of the current snippet and status, the owner's Live writes switch immediately before videos.update, a read-back of the category and of every untouched field (title, description, tags, both languages, privacy, publishAt) and of the translation languages; audited with source package_category, actor producer. Quota at least 57 units a written video (dryRun's quotaUnits). Returns { dryRun: false, channelId, targetCategoryId, videos: [{ video, videoId, before, status: written | same | upload_pending | not_on_youtube | not_in_channel | audio_language_zxx | failed, backupPath?, maybeWritten?, error? }], written, verified, stoppedAt } and forChannelId; the first failure stops the run (stoppedAt); a refusal before the videos.update call on the first video (Live writes off, a wrong channel, the video changed) is the error itself, while any failure once that call was made -- whatever its code: a read-back that differs (update_failed), or a quota or reads-disabled error on the read-back -- is that video's result with maybeWritten: true and its backupPath (the new category may already be on YouTube: run the dry run again). Errors: publishing_settings_not_saved, publishing_settings_changed, package_metadata_not_uploaded, package_no_workspace, package_workspace_unavailable, CHANNEL_NOT_ACTIVE, WRITE_CHANNEL_MISMATCH, live_writes_disabled, video_details_conflict (the video changed while it was written: run again), update_failed (the read-back differs), operation_lock_held / device_in_recovery_mode, validation_failed.",
      inputSchema: producerVideoCategoryFixInputSchema,
    },
    async (args: z.infer<typeof producerVideoCategoryFixInputSchema>) => toolSuccessResult(await producerSession!.videoCategory.fix(args))
  );

  // BL-279 (owner TG 4964): the publishing fields of a channel's videos on YouTube against its settings -- the session's `publishingCheck` only (a read).
  registerTool(
    "producer_video_publishing_check",
    {
      description:
        "Read and check the publishing fields of a channel's videos as YouTube has them now (Producer API 1.35.0, read-only): { channelId, videoIds? (1-200; absent: every video a release package of the channel put on YouTube -- not one the owner only linked to its release --, at most 200), captions? (true: also each video's caption tracks -- captions.list, 50 units a video, at most 50 videos) } -> { channelId, settingsSaved (false: the channel's publishing settings were never saved -- uploads are refused until the owner saves them, and every expectation is a default), savedFields, conflictedFields, expected { categoryId, license, madeForKids, embeddable, containsSyntheticMedia, paidProductPlacement, captionsEnabled }, videos: [{ videoId, video (the package's code, null when no package here names it), found: true, title, privacyStatus, madeForKidsEffective (YouTube's own status.madeForKids), fields: [{ field: categoryId | license | madeForKids (status.selfDeclaredMadeForKids) | embeddable | containsSyntheticMedia | paidProductPlacement | defaultLanguage | defaultAudioLanguage | englishCaptions, youtube, expected, source: saved | default | package | unknown, status: match | mismatch | unreadable (YouTube did not return it, or captions not read) | unchecked (nothing to compare with) }], mismatches, captionTracks [{ language, trackKind, status, isDraft }] | null, captionsError? } | { videoId, video, found: false, reason: not_on_youtube | not_in_channel (no value of another channel's video is shown) }], mismatched, captionsChecked, quotaUnits } and forChannelId. The languages and a package's own containsSyntheticMedia are compared with the video's release package (what the upload sent); English captions are expected where the channel's captions switch is on and the package names a captions file (an ASR or draft track does not count). videos.list reads 50 ids per call (1 unit). Errors: CHANNEL_NOT_ACTIVE, package_no_workspace, package_workspace_unavailable, data_api_reads_disabled, validation_failed. A category mismatch is fixed with producer_video_category_fix.",
      inputSchema: producerVideoPublishingCheckInputSchema,
    },
    async (args: z.infer<typeof producerVideoPublishingCheckInputSchema>) => toolSuccessResult(await producerSession!.publishingCheck.check(args))
  );

  registerTool(
    "write_context",
    {
      description:
        "Read-only write context for current OAuth session, including activeWriteChannel, selectedChannelId and effectiveCredentialRef.",
      inputSchema: z.object({}).strict(),
    },
    () => handlers.writeContext()
  );

  registerTool(
    "write_channel_list",
    {
      description:
        "List the minimal-safe known write channels from local state (active OAuth + persisted selection).",
      inputSchema: writeChannelListInputSchema,
    },
    (args) => handlers.writeChannelList(args)
  );

  registerTool(
    "write_channel_select",
    {
      description:
        "Persist expected write channel selection and return alignment state. Does not switch active OAuth identity.",
      inputSchema: writeChannelSelectInputSchema,
    },
    (args) => handlers.writeChannelSelect(args)
  );

  registerTool(
    "whoami",
    {
      description:
        "Return the active local authenticated user for this MCP server. Use this when you need to confirm which YouTube account will be used before calling other tools.",
      inputSchema: z.object({}).strict(),
    },
    () => handlers.whoami()
  );

  registerTool(
    "auth_user_select",
    {
      description:
        "Switch local active user fallback. Does not login, reauth, or switch active OAuth channel.",
      inputSchema: authUserSelectInputSchema,
    },
    (args) => handlers.authUserSelect(args)
  );

  registerTool(
    "list",
    {
      description:
        "List channel videos using the shared core. credentialRef is OPTIONAL: if omitted, the server uses the active local auth context established via CLI auth login. channelId is OPTIONAL and recommended for multi-account / Brand Account setups to force a specific YouTube channel.",
      inputSchema: listInputSchema,
    },
    (args) => handlers.list(args)
  );

  registerTool(
    "transcript",
    {
      description:
        "Get transcript status and text for a video. credentialRef is OPTIONAL: if omitted, the server uses the active local auth context established via CLI auth login.",
      inputSchema: transcriptInputSchema,
    },
    (args) => handlers.transcript(args)
  );

  registerTool(
    "preview",
    {
      description:
        "Generate final title and description preview for a video. credentialRef is OPTIONAL: if omitted, the server uses the active local auth context established via CLI auth login.",
      inputSchema: previewInputSchema,
    },
    (args) => handlers.preview(args)
  );

  registerTool(
    "apply",
    {
      // RISK-12 fix (2026-09-18, breaking behavioral change): dryRun now defaults to
      // true if omitted -- previously it defaulted to a REAL write. Callers must pass
      // dryRun: false explicitly to perform a real YouTube write.
      description:
        "Apply metadata. dryRun defaults to true (a preview, no write) if omitted -- pass dryRun: false explicitly to perform a real YouTube write. credentialRef is OPTIONAL: if omitted, the server uses the active local auth context established via CLI auth login.",
      inputSchema: applyInputSchema,
    },
    (args) => handlers.apply(args)
  );

  registerTool(
    "playlist_list",
    {
      description:
        "List playlists for the authenticated YouTube account. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: playlistListInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistList(args)
  );

  registerTool(
    "playlist_create",
    {
      description:
        "Create a YouTube playlist (privacyStatus private by default; unlisted or public too -- a channel agent may create a public playlist since Agent API 4.27.0, owner msg 4782). In a channel session expectedChannelId, when given, must be the session's channel (WRITE_CHANNEL_MISMATCH). credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: playlistCreateInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistCreate(args)
  );

  registerTool(
    "playlist_add_videos",
    {
      description:
        "Add one or more videos to a playlist after strict write-channel guardrail validation (expectedChannelId is REQUIRED), returning stable partial results with attempted/added/failures.",
      inputSchema: playlistAddVideosInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistAddVideos(args)
  );

  registerTool(
    "playlist_delete",
    {
      description:
        "Delete a playlist after strict write-channel guardrail validation. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: playlistDeleteInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistDelete(args)
  );

  registerTool(
    "playlist_update",
    {
      description:
        "Update playlist metadata (title, description, privacyStatus private/unlisted/public) with strict patch validation and write-channel guardrails. A channel agent may make its channel's playlist public since Agent API 4.27.0 (owner msg 4782). In a channel session expectedChannelId must be the session's channel (WRITE_CHANNEL_MISMATCH, before any YouTube call). credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: playlistUpdateToolInputSchema,
    },
    (args) => handlers.playlistUpdate(args)
  );

  registerTool(
    "playlist_remove_videos",
    {
      description:
        "Remove one or more videos from a playlist after strict write-channel guardrail validation (expectedChannelId is REQUIRED), returning stable partial results with requested/removed/failures.",
      inputSchema: playlistRemoveVideosInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistRemoveVideos(args)
  );

  registerTool(
    "changeset_list",
    {
      description:
        "List Change Sets for a synchronized channel's local database. Read-only -- never writes to YouTube or mutates any change's approval status.",
      inputSchema: listChangeSetsInputSchema,
    },
    (args) => handlers.changesetList(args)
  );

  registerTool(
    "changeset_get",
    {
      description:
        "Get one Change Set and its changes, with optional status/language/videoId filters. Read-only.",
      inputSchema: getChangeSetInputSchema,
    },
    (args) => handlers.changesetGet(args)
  );

  registerTool(
    "localization_import_preview",
    {
      description:
        "Preview an XLSX localization workbook (base64-encoded) against a channel's synced videos -- returns a validation summary and per-row errors. Propose-adjacent: never persists a Change Set and never writes to YouTube.",
      inputSchema: localizationImportPreviewInputSchema,
    },
    (args) => handlers.localizationImportPreview(args)
  );

  registerTool(
    "changeset_create_from_import",
    {
      description:
        "Parse an XLSX localization workbook (base64-encoded) and persist a new Change Set from it -- the same local-only persistence the Web UI's POST .../localizations/import route performs. Never writes to YouTube; mutating locally, so it is gated exactly like channel_sync.",
      inputSchema: localizationImportPreviewInputSchema,
    },
    (args) => handlers.changesetCreateFromImport(args)
  );

  registerTool(
    "batch_list",
    {
      description:
        "List Batches for a channel (dry-run-only pipeline state). Read-only -- never executes or prepares a batch.",
      inputSchema: batchListInputSchema,
    },
    (args) => handlers.batchList(args)
  );

  registerTool(
    "batch_get",
    {
      description:
        "Get one Batch and its per-video ledger rows, after verifying the batch belongs to the given channel. Read-only.",
      inputSchema: batchGetInputSchema,
    },
    (args) => handlers.batchGet(args)
  );

  registerTool(
    "channel_sync",
    {
      description:
        "Synchronize a channel's videos into the local database (read from YouTube, write to local SQLite only -- never a YouTube write). channelId is OPTIONAL and defaults to the authenticated account's own channel. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: syncChannelInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.channelSync(args)
  );

  registerTool(
    "channel_list",
    {
      description: "List locally synchronized channels. Read-only. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: listChannelsInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.channelList(args)
  );

  registerTool(
    "channel_video_list",
    {
      description:
        "List a synchronized channel's videos with their existing localization languages. Read-only. credentialRef is OPTIONAL and falls back to active local auth context. With no other input it returns every field of every video, which for a large channel is very big (descriptions, thumbnails, etags, localizations): pass `fields` (e.g. [\"title\",\"publishedAt\",\"viewCount\",\"durationSeconds\"]; videoId is always included; `durationSeconds` and `liveBroadcastContent` -- none / live / upcoming -- are null when unknown, and `thumbnails` holds YouTube's own image URLs) and/or `limit`/`offset` (limit max 500) to get a slim, paged answer {channelId, videos, total, offset, nextOffset} -- nextOffset is null on the last page. Since 4.17.0 (Producer 1.17.0) `videoIds` (1-50 ids) lists only those videos of the channel, in the order asked (fields/limit/offset still apply; total counts the found ones), and adds `removed` [{ videoId, removedAt }] -- asked ids a complete sync found removed on YouTube (deleted; this copy hides them from every list) -- and `notFound` [videoId] -- asked ids this copy does not have for the channel (never synced here, uploaded after the last sync, or another channel's) -- and `checkedAt`: when a channel sync last COMPLETED the removed-on-YouTube check (ISO; null: never). Trust `removed` as of `checkedAt`, and never read notFound as 'does not exist'. Since 4.28.0 (Producer 1.30.0) every video carries `tags` (also selectable in `fields`): its YouTube tags (snippet.tags) as of the last channel_sync, in YouTube's order -- [] when the video has none, null when this copy has not read them yet (synced by an older build; the next channel_sync fills them). Tags changed on YouTube since lastSyncedAt show only after the next sync.",
      inputSchema: listSyncedVideosInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.channelVideoList(args)
  );

  registerTool(
    "analytics_list",
    {
      description:
        "List every YouTube Analytics metric row already collected locally for a channel (per video, per day, per metric name) -- a local read, never a live YouTube API call. Optional startDate/endDate/videoId/metricNames filters bound the response size; omitting all of them returns every collected row. credentialRef is OPTIONAL and falls back to active local auth context. Data reflects whatever the last manual/scheduled collection run fetched -- it is not necessarily current.",
      inputSchema: listMetricsInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.analyticsList(args)
  );

  registerTool(
    "analytics_overview",
    {
      description:
        "Live channel-level YouTube Analytics read (views, watch-time minutes, subscribers gained/lost) for a date range, plus the same totals for the immediately-preceding period of equal length. This is a real Analytics API call and counts against that quota, unlike analytics_list. The API's own daily rows typically lag `endDate` by 1-2 days, so totals reflect what has been processed as of the call, not necessarily what YouTube Studio's own dashboard already shows for the same nominal range. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: getChannelOverviewInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.analyticsOverview(args)
  );

  registerTool(
    "analytics_data_quality",
    {
      description:
        "Data-quality diagnostics for a channel's collected Analytics data over a date range. `covered` means a completed collection run's window included the date (or a metric row exists) -- NOT that data is present: see `coveredWithoutData` (covered dates with no stored row: zero-activity days or data YouTube had not reported yet) and `provisionalDates` (covered dates inside the re-collection window, expected to be refreshed by the next automatic run). Dates before the channel was created (`channelStartDate`) are `notApplicableRange`, never uncovered; `coveredRanges`/`uncoveredRanges` give compact ranges, and missing history is back-filled automatically. Details: which dates were actually covered by a completed collection run (`collectMetrics`), which were requested but never collected, which are too recent for the Analytics API to have reported yet (its own 1-2 day lag), and which videos had a collection failure recorded against them (`videosWithSkips`: `{ videoId, skipCount, lastSkippedAt, lastSkippedRange: { startDate, endDate } }` -- listed only when the LATEST run overlapping the range skipped the video; a skip is per video and run, never per day, so `lastSkippedRange` is that run's whole window). A local read only -- never a live YouTube call. Absence of a `video_metrics_daily` row for a date does NOT by itself mean data is missing (the API omits zero-activity days entirely) -- use this tool, not a raw scan of analytics_list's rows, to tell genuine gaps from real zero-activity days. credentialRef is OPTIONAL and falls back to active local auth context. `newestReturned` (BL-181): the newest video and channel dates the Analytics API has returned to this computer (the maximum over its collection runs) and when the newest video date first came back. `returnLag` (BL-181): per date of the range, newest first, the first run on this computer that asked for the date and got it back after an earlier run had asked and not got it (`videoFirstReturnedAt` / `channelFirstReturnedAt`), and the hours after the date's Pacific day ended (`videoLagHours` / `channelLagHours`) -- an upper bound, since it is when this app asked, not when Google published; a date without that proof is left out; since BL-245 the channel columns also count this computer's hourly freshness probe (one channel-level query at minute :07 UTC of every hour), so they are known to within an hour, while the video columns still come from the collection runs (once or twice a day); compare with agent_get_reporting_status for the Reporting API files.",
      inputSchema: getDataQualityReportInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.analyticsDataQuality(args)
  );

  registerTool(
    "analytics_comparable_age",
    {
      description:
        "Compare 2-10 videos (all belonging to the same channel) by days-since-publish rather than calendar date, using already-collected local Analytics data -- a local read, never a live YouTube call. Each video's own days-since-publish are computed from its Pacific-Time publish date (matching the Analytics API's own day-dimension convention). Returns raw per-day values (never zero-filled) plus a running cumulative total that stops at the first day with no collected data, rather than fabricating a value across a gap. Only additive metrics (e.g. views, likes, estimatedMinutesWatched) are accepted -- a ratio/average metric like averageViewDuration is rejected. Given the auto-collection window only covers the most recent ~7 calendar days per run, a video published more than about a week before regular collection started for this channel will typically have NO data at low day-offsets (day 0-7) -- this is a genuine data-coverage limitation, not a bug. Concretely: `cumulativePoints` will be empty for that video (it always starts from day 0, so any missing day 0 halts it before it starts), but `points` may still contain later, unrelated day-offsets the auto-collection window did happen to cover -- an empty `points` array is NOT implied by missing early-life data alone. Returns raw facts only -- no ranking, no 'outperforming' language, no headline verdict. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: getComparableAgeComparisonInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.analyticsComparableAge(args)
  );

  registerTool(
    "analytics_weekly_reports_list",
    {
      description:
        "List every stored weekly analytics report snapshot for a channel, newest week first. A local read only -- never a live YouTube call. Each report is a frozen Monday-Sunday snapshot computed entirely from already-collected local data (never re-queries YouTube), with `status: \"final\"` once every date in that week is actually covered by local data, or `status: \"provisional\"` if some data was still missing/too-recent when it was generated (a later dashboard load may replace a provisional report with a final one for the same week, but a final report is never changed). Snapshots are only generated by the Web UI's own dashboard-mount trigger, on a weekly cadence -- there is no tool here to generate one on demand. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: listWeeklyReportsInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.analyticsWeeklyReportsList(args)
  );

  registerTool(
    "analytics_weekly_report_get",
    {
      description:
        "Get one stored weekly analytics report snapshot by its week's Monday start date (YYYY-MM-DD). Returns `{ report: null }` if no snapshot exists yet for that week. A local read only -- never a live YouTube call. See `analytics_weekly_reports_list`'s own description for what `status` means and why there is no on-demand generate tool. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: getWeeklyReportInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.analyticsWeeklyReportGet(args)
  );

  registerTool(
    "ai_localization_generate",
    {
      description:
        "Generate AI localization proposals (title/description) for (videoId, targetLanguage) pairs on a channel, using the same provider/validation logic as the Web UI's 'Generate with AI' step. Persists nothing -- the caller (human or agent) reviews/edits the returned proposals, then calls ai_localization_create_change_set to persist the reviewed set. Omitting both providerName and connectionId uses the deterministic mock provider (no network call, no cost). Passing connectionId routes through a real, user-configured AI Connection and makes a genuine outbound network call to that provider -- this can incur real cost and is capped at 50 (video, language) targets per call, well below the plain schema limit. Requires channelId to be the caller's currently-active channel. No credentialRef parameter -- always uses the active local auth context, matching changeset_list/changeset_get's own convention in this server.",
      inputSchema: generateProposalsInputSchema,
    },
    (args) => handlers.aiLocalizationGenerate(args)
  );

  registerTool(
    "ai_localization_create_change_set",
    {
      description:
        "Persist a reviewed (optionally edited) set of AI localization proposals as a new Change Set, source 'ai_localization' -- the exact same persistence path createChangeSetFromImport (XLSX) already uses, so approval, conflict revalidation, Batch creation, and the live-write barrier are completely unchanged. The resulting Change Set and every Change on it always start 'pending' -- there is no code path, here or anywhere else, that can mark an AI-authored proposal already-approved; a human must still approve it via the Web UI before it can ever be included in a Batch. Optionally echo back the generationContext a prior ai_localization_generate call returned as `provenance`, to have it durably recorded against the resulting Change Set. Also optionally accepts `evidence` (an array of external-research/comparable-video citations -- url, retrievedAt, description, claimSupported, sourceType, optional excerpt) and `rationale` (free text), recorded once per Change Set, not per individual proposal; neither is independently verified by this server. Every call also has its calling transport (this MCP surface) and the current agent API version durably recorded against the resulting provenance record -- retrievable via agent_get_generation_provenance. Mutates local application state (never YouTube directly), so this tool is gated by the same device-availability/recovery-mode check as changeset_create_from_import. No credentialRef parameter -- always uses the active local auth context.",
      inputSchema: createChangeSetFromGenerationInputSchema,
    },
    (args) => handlers.aiLocalizationCreateChangeSet(args)
  );

  registerTool(
    "agent_localization_propose_language_move",
    {
      description:
        "Prepare, as a DRAFT Change Set for the owner, the move of an existing localization from one language code to another on this channel's videos (e.g. fromLanguage \"zh-Hans\" -> toLanguage \"zh-CN\"): per video one removal of fromLanguage plus one addition of toLanguage carrying exactly the same synced title and description (byte-for-byte, nothing is translated). videoIds omitted = every synced video of the channel that has fromLanguage. toLanguage must be a code from YouTube's supported list; the two codes must differ. Left out and listed: videos whose own language (or the channel's language baseline) is fromLanguage or toLanguage (skippedOwnLanguageVideoIds), videos whose fromLanguage title is empty (skippedEmptyTextVideoIds; an empty description is moved as \"\"), and -- with videoIds -- named videos that have no fromLanguage (notCarryingSourceVideoIds). A video that already has toLanguage keeps it unchanged and only loses fromLanguage (targetAlreadyPresent, with both texts); that removal is refused at write time if toLanguage holds no title any more. Returns { changeSet (null when nothing to do), fromLanguage, toLanguage, movedVideoIds, targetAlreadyPresent, skippedOwnLanguageVideoIds, skippedEmptyTextVideoIds, notCarryingSourceVideoIds }. Never writes to YouTube and never approves: every change starts pending; only the owner approves and sends it in the app (one videos.update per video, removal and addition always together). As for every Batch write, a video whose own language differs from the channel's language baseline is also aligned to the baseline in that same write (PROJECT_SPEC §14, FO-REQ-0022); changeset_get's languageAlignments lists such videos before approval. Reads the last synced copy -- run channel_sync first if YouTube changed since. Requires channelId to be the caller's own channel.",
      inputSchema: proposeLanguageMoveInputSchema,
    },
    (args) => handlers.agentLocalizationProposeLanguageMove(args)
  );

  registerTool(
    "agent_get_capabilities",
    {
      description:
        "Report this running instance's product version, Agent API version, the capabilities actually implemented and reachable right now, the data domains they cover, the full permission-class vocabulary (READ/DRAFT/APPROVE/EXECUTE), the permissions actually GRANTED to this caller (READ, DRAFT and EXECUTE -- EXECUTE for the real writes and paid runs of the youtube_writes / channel_production capabilities, ADR 0048; never APPROVE: no proposal an agent creates is ever auto-approved), the future capabilities named in the Agent Operations Interface design that are not implemented yet (so an unavailable-capability error can be told apart from a typo or a hallucinated tool name), and the local database schema version. Call this first, before assuming any other Agent Operations tool exists -- this list only ever contains what is actually callable in this instance. A local read only, no channel scoping (this is instance-level information), no YouTube call.",
      inputSchema: getSystemCapabilitiesInputSchema,
    },
    (args) => handlers.agentGetCapabilities(args)
  );

  registerTool(
    "agent_get_channel_context",
    {
      description:
        "Read-only channel context for an operational agent: channel title, last local sync time (null if never synced), synced video count, the channel's editorial profile (null if none was ever saved -- never a default/invented one), and its explicitly tracked languages. Requires channelId to be the caller's currently-active channel. Reads only already-synced local data -- never a live YouTube call.",
      inputSchema: getChannelContextInputSchema,
    },
    (args) => handlers.agentGetChannelContext(args)
  );

  registerTool(
    "agent_get_video_context",
    {
      description:
        "Task-oriented, section-selectable context for one video: 'metadata' (title, description, publish date, privacy status, default language, last sync time; since 4.28.0 also `tags` -- the video's YouTube tags as of the last channel_sync, [] when it has none, null when not read yet) and/or 'localizations' (every existing per-language title/description already synced locally). Omit `include` to get both sections; pass e.g. `include: [\"metadata\"]` to fetch only what you need. Requires channelId to be the caller's currently-active channel, and videoId to actually belong to it. Reads only already-synced local data -- never a live YouTube call. Does not include analytics (see the separate analytics tools), comparable videos, experiment history, or creative assets -- those are separate, later capabilities, not yet implemented for some of them.",
      inputSchema: getVideoContextInputSchema,
    },
    (args) => handlers.agentGetVideoContext(args)
  );

  registerTool(
    "agent_query_channel_analytics",
    {
      description:
        "Agent-oriented channel-level analytics for a date range: daily views/watch-time/subscriber-delta rows (or week/month summed buckets via `granularity`) plus current- and previous-period totals, with explicit metric definitions and a data-freshness note. Answers from the channel totals this app collects and stores locally when they cover the range (no live call, no quota; `freshness.source` says `local_collected_data` or `live_youtube_analytics_api`), otherwise a live YouTube Analytics API read (counts against that API's quota; 1-2 day lag); `refresh: true` forces the live read. `previousTotals` is null (not 0) when the comparison period ended before the channel was created (`previousPeriod.status` says why); `channelStartDate` is the channel's creation date. Requires channelId to be the caller's currently-active channel. Raw daily rows are FACT; totals are DERIVED (summed).",
      inputSchema: queryChannelAnalyticsInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.agentQueryChannelAnalytics(args)
  );

  registerTool(
    "agent_query_channel_breakdown",
    {
      description:
        "Channel-level breakdown for a date range: `breakdown` is one of trafficSources (views by traffic source), deviceType (watch minutes by device), ageGender (viewer percentage), geography (views by country), subscribedStatus, contentFormat. Each row carries the raw API `dimensionValues`, a readable `label`, and its metrics. trafficSources and deviceType are answered from the stored channel days (agent_list_stored_breakdowns' data) when they cover the whole period (the newest 2 days, which YouTube may not have returned yet, count as covered with what is stored); otherwise, and for the other four kinds, it is a LIVE YouTube Analytics API read (counts against that API's quota; 1-2 day lag). Requires channelId to be the caller's currently-active channel.",
      inputSchema: getChannelBreakdownInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.agentQueryChannelBreakdown(args)
  );

  registerTool(
    "agent_query_channel_reach",
    {
      description:
        "Thumbnail impressions and click-through rate (CTR) for a date range, from YouTube's Reporting API Reach report that this app downloads and stores locally -- a LOCAL read, no live YouTube call. These two metrics are NOT available from the Analytics API, so they are absent from agent_query_channel_analytics. `state` is explicit: `no_job` (the report subscription does not exist yet), `waiting_for_first_report` (it exists but YouTube has not delivered a file yet, up to ~48h -- this is NOT zero impressions), or `ready`. Days without data are absent, never zero-filled. `daily` and `videos` (top 50 by impressions, by canonical videoId) carry raw FACT values; `totals` are DERIVED and the CTR is impressions-weighted, never an average of per-row CTRs -- a CTR of null means the report left it empty. `coverage` shows which days have data. Optional `videoId` scopes daily/videos/totals to that one video (echoed back); optional `groupBy: video_day` also returns `videoDaily` -- the stored rows, one per video per day (videos in id order, days ascending, ctr null when the report left it empty), at most 5000 rows with `videoDailyTruncated` saying when there were more -- so per-video per-day CTR is ONE call, not one per day. `coverage` shows which days have data. Data is refreshed when the app's dashboard is opened, so check coverage.lastDate for freshness. Requires channelId to be the caller's currently-active channel.",
      inputSchema: getChannelReachInputObjectSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.agentQueryChannelReach(args)
  );

  registerTool(
    "agent_get_reporting_status",
    {
      description:
        "The YouTube Reporting API jobs and report files this app holds for the channel (BL-181): Reach (`channel_reach_basic_a1`) at the top level and, in `otherReports`, the basic user-activity (`channel_basic_a3`) and traffic-source (`channel_traffic_source_a3`) reports. Per type: `job` (id, Google's creation time), `lastAttempt` (time, outcome ok | partial | failed, error), `importedFiles`, `files` (newest period first, at most 90: Google's startTime/endTime/createTime, rowCount, status imported | superseded -- a reissue replaced it) with `lagHours` = createTime minus endTime, i.e. hours after the file's Pacific day ended, and `firstFileLag` -- per day (newest first) the first file Google created and its lag, leaving out days that ended before the job existed (Google makes those 30 history days right after a job is created). Compare with `returnLag` of analytics_data_quality for the Analytics API. Files are fetched when the app's dashboard is opened (at most every 6 hours per channel); each computer downloads the basic and traffic-source files itself. A LOCAL read, never a live YouTube call. Requires channelId to be the caller's currently-active channel.",
      inputSchema: getReachStatusInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.agentGetReportingStatus(args)
  );

  registerTool(
    "agent_get_reporting_traffic_sources",
    {
      description:
        "Views and watch time by traffic source per day, from the YouTube Reporting API report `channel_traffic_source_a3` that this app downloads and stores (BL-181) -- a LOCAL read, no live YouTube call. Often available a day earlier than the Analytics API (measure with agent_get_reporting_status). `state` is the traffic-source job's: `no_job`, `waiting_for_first_report` (NOT zero traffic) or `ready`. `daily`: per day and `trafficSourceType` (Google's numeric code; `label` is Google's name, null for a code this app does not know) the channel's videos summed, the channel-level and deleted-video remainder included -- views, engagedViews, watchTimeMinutes (minutes; null when no stored row carried the metric, never 0). `totals`: per code over the range, most views first. Days without a stored file are absent, never zero-filled. `files`: per day the Google file the rows come from (`createTime`) and `lagHours` after the day's Pacific end; a reissue replaces a day's rows. Optional `videoId` limits everything to that video; `groupBy: video_day` adds `videoDaily` (per video, day and code; at most 5000 rows, `videoDailyTruncated`). Each computer downloads these files itself when its dashboard is opened. Dates YYYY-MM-DD (Pacific days), at most 400 days. Requires channelId to be the caller's currently-active channel.",
      inputSchema: getReportingTrafficSourcesInputObjectSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.agentGetReportingTrafficSources(args)
  );

  registerTool(
    "agent_get_publishing_calendar",
    {
      description:
        "The channel's publishing calendar from this app's synced copy of its videos (BL-182) -- a LOCAL read, never a live YouTube call; publishing itself is the owner's, from the Web UI (no agent tool uploads or schedules). YouTube has no 'scheduled' status: a scheduled video is a private one with a future publishAt. `entries` (oldest first) are the videos dated inside `window` (the past 14 and the next 14 UTC days): kind published (public or unlisted, at its publish time), scheduled (private, publishAt ahead), published_pending (since 4.13.0: publishAt passed less than 24 h ago and this copy still shows it private -- YouTube published it, the next sync will show it) or overdue (publishAt passed 24 h ago or more but this copy still shows it not public); `unscheduled` are private uploads without a date. `coverage`: coveredThrough (the latest future publishAt, null when nothing is scheduled), scheduledCount, unscheduledCount, daysCovered (whole days from now), due (coverage ends within thresholdDays, 7 -- the owner's reminder). `gapDates` (since 4.13.0, BL-235): today and the next 13 days that are NOT covered -- dates in the channel's time zone (`gapDatesTimeZone`): a day is covered only when a release viewers see (public, scheduled, or published-pending: publishAt passed < 24 h ago and not synced yet; never unlisted or a live recording) is on it with every tracked translation; `missingTranslationDates` are those with a release that lacks translations (null, and UTC days without a published or scheduled video, if the coverage read failed). `coverage.due` (since 4.13.0): fewer than 7 covered days in a row; `coverage.coveredDaysInARow`. agent_publishing_coverage gives each day's details. `lastSyncedAt` is the copy's age: check it before trusting the calendar (the app refreshes on dashboard load). `packages` (since 3.17.0): the release packages (`04 Videos/**/V*_release.json`) in THIS computer's copy of the channel workspace -- status ok | no_workspace | unavailable; each item's `state`: not_ready (`problems` say why, e.g. thumbnail_missing, language_differs, same_title_on_channel, slot_taken, slot_duplicate; since 4.19.0 owner_review_pending -- the channel's owner reviews its final packages in the Web UI and has not approved this package's VIDEO yet (4.22.0: the approval covers the mp4 -- its sha256 + sizeBytes -- so a re-package of only the texts, thumbnail or translations stays approved; a new mp4 waits again) -- and owner_review_returned -- he returned the video, make a new one; no tool approves; 4.22.0: each package also has `warnings`, codes that never block, e.g. chapters_first_not_zero) | ready (nothing uploaded, no problem) | uploaded_private / scheduled / published (its `Vn_youtube.json` names a video this copy has on the channel: private without a future date / private with publishAt ahead / public or unlisted) | uploaded_unknown (the record names a video that is NOT in this copy yet -- e.g. uploaded after the last sync; not a confirmation it exists) | deleted_on_youtube (since 4.17.0: the copy has the video marked removed by a complete sync -- deleted on YouTube; problem video_deleted_on_youtube; it holds no plan slot and cannot be approved); `problems` (codes), `videoId` once uploaded, and since 4.17.0 `existsOnChannel` (true: in this copy and not removed as of `checkedAt`; false: removed on YouTube; null: unknown -- no upload record, not in the copy, or no removed check has completed yet), `checkedAt` (when a channel sync last COMPLETED its removed-on-YouTube check, ISO -- can be older than `lastSyncedAt`, which also moves on syncs that skip that check; null: never, and then no video is reported true) and `removedAt` (when the sync found it removed, else null). `missingOnChannel` (since 4.17.0): [{ video, videoId, removedAt }] -- the packages in state deleted_on_youtube ([] when packages are not ok); trust it as of the top-level `checkedAt` (since 4.17.0: when a channel sync last COMPLETED the removed-on-YouTube check, ISO, null: never -- can be older than `lastSyncedAt`). `uploads`: this computer's upload queue, newest first (status queued | uploading | processing | finishing | paused | done | failed | cancelled, with publishAt, videoId, pausedReason, errorCode; since 3.20.0 also `automatic` -- true when the owner's automatic-upload switch queued it: always private, never with a date --, `progressPercent` -- stored bytes / size as a whole percent, null when the size is unknown -- and `finishedAt`, when it ended, null while under way). Requires channelId to be the caller's currently-active channel.",
      inputSchema: getAgentPublishingCalendarInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.agentGetPublishingCalendar(args)
  );

  registerTool(
    "agent_get_video_milestones",
    {
      description:
        "The stored day-7 and day-28 milestones of the channel's own videos (BL-166). A milestone's window runs from the video's publish date (YouTube Analytics' Pacific date) to publish date + 6 (day 7) or + 27 (day 28), inclusive. YT Manager queries a window once it and YouTube's reporting lag are over (3 days after its last day), during the dashboard's Analytics collection, at most 25 per channel per run, oldest first: a longer backlog fills over several runs. Each milestone: `status` (collected | retry -- a query failed, it is tried again on a later run | failed -- given up after 3 attempts), `attempts`, `lastError`, `collectedAt`, `durationSeconds` (the video's stored length, null when unknown, so a point of the curve can be placed in time), `totals` (views, estimatedMinutesWatched, averageViewDuration in seconds, averageViewPercentage -- each as YouTube returned it for the window, null when it returned none) and `retention`: up to 100 points of the audience-retention curve (elapsedVideoTimeRatio 0.01 .. 1.00, with audienceWatchRatio and relativeRetentionPerformance), as returned -- [] when YouTube returned none (e.g. too few views) or the milestone is not collected. Only public videos have milestones (while a video is private or scheduled, its publishedAt is its upload time); a milestone not due yet, or due but not attempted yet, is not listed, nor one collected for a window the video no longer has (its publish date moved) until it is collected again. Optional `videoIds` (1-50) and `milestone` (7 or 28) narrow the answer; a videoId of another channel is simply not listed. A LOCAL read, never a live YouTube call; each computer collects the milestones of the channels connected on it. Nothing is computed from the curve (e.g. no 'retention at 30 s'). Requires channelId to be the caller's currently-active channel.",
      inputSchema: listVideoMilestonesInputSchema,
    },
    (args) => handlers.agentGetVideoMilestones(args)
  );

  registerTool(
    "agent_get_stored_breakdowns",
    {
      description:
        "Stored traffic sources and device types per day (BL-168): views and estimatedMinutesWatched per `insightTrafficSourceType` (e.g. SUBSCRIBER, RELATED_VIDEO, YT_SEARCH, YT_CHANNEL, YT_OTHER_PAGE, EXT_URL, PLAYLIST, NOTIFICATION, NO_LINK_OTHER) and per `deviceType` (e.g. DESKTOP, MOBILE, TV, TABLET), as YouTube Analytics returned them. Without `videoIds` the answer is the channel as a whole (`channel`); with `videoIds` (1-20) it is those videos (`videos`). YT Manager stores each public video's first 90 days (its Pacific publish date .. +89, see `window`) and the channel from 90 days before its first collection on, once a day during the dashboard's Analytics collection (yesterday is the latest day; each read starts 6 days before its first new day, since YouTube revises recent days; at most 100 subjects per channel per run, the channel first, then the least recently read videos, so a video left out is read on the next run). `coverage` (from, through, collectedAt) says which days are stored and when they were last read; null with `status: not_collected` when they never were. `status` is collected | retry (a query failed, tried again later; `lastError`) | failed (a video given up after 3 attempts; the channel is never given up). `groupBy: total` (default) sums each value over startDate..endDate within the coverage, most views first; `groupBy: day` lists the stored rows. A day with no row for a value had no views from it (or lies outside the coverage); a 0 can occur. The channel's sum across sources can differ slightly from its total views, as YouTube reports it. Each row has the raw API `value` and a readable `label`. A videoId of another channel, or of a private, scheduled or never-synced video, is not listed. A LOCAL read, never a live YouTube call (agent_query_channel_breakdown is the live one); each computer collects the channels connected on it. Dates are YYYY-MM-DD, inclusive, at most 92 days. Requires channelId to be the caller's currently-active channel.",
      inputSchema: listStoredBreakdownsInputSchema,
    },
    (args) => handlers.agentGetStoredBreakdowns(args)
  );

  registerTool(
    "agent_get_stored_search_terms",
    {
      description:
        "Stored YouTube search terms (BL-169): the terms viewers searched for before watching (YouTube Analytics `insightTrafficSourceDetail` of traffic source YT_SEARCH), top 25 by views, each with views and estimatedMinutesWatched as YouTube returned them, most views first. Two forms. (1) `videoIds` (1-20, no dates): `videos`, each with its terms over its first 90 days so far (`coverage.from` = its Pacific publish date .. `coverage.through`, see `window`); YT Manager reads a video once it has 7 days, then every 7 days while its 90 days run, and once more 7 days after they end, each read replacing its terms. (2) `startDate` + `endDate` (YYYY-MM-DD, at most 92 days, no videoIds) and optional `groupBy`: the channel's own terms per Monday-Sunday week (Pacific dates), for the complete weeks lying fully inside the range (`weeks`, oldest first, each with `status` and `collectedAt`); `groupBy: total` (default) adds `terms`, each term summed over the weeks that were read (a sum of weekly top-25 lists), `groupBy: week` gives each week its own `terms`. YT Manager reads the last 13 complete weeks: each once it is complete and once more 7 days after its Sunday; an older week never read stays `not_collected`. YouTube names a term for only a small part of the search views and the rest it does not return, so the terms' views add up to much less than the search views; the search total is the YT_SEARCH row of agent_get_stored_breakdowns. Per video there are often only a few terms; the channel weeks show more. `status` is collected | retry (a query failed, tried again later; `lastError`) | failed (given up after 3 attempts) | not_collected (`coverage` null for a video). Reads happen during the dashboard's Analytics collection, at most 100 queries per channel per run (the weeks first, then the least recently read videos). A videoId of another channel, or of a private, unlisted, scheduled or never-synced video, is not listed. A LOCAL read, never a live YouTube call; each computer collects the channels connected on it. Requires channelId to be the caller's currently-active channel.",
      inputSchema: listStoredSearchTermsInputSchema,
    },
    (args) => handlers.agentGetStoredSearchTerms(args)
  );

  registerTool(
    "agent_get_stored_suggested_sources",
    {
      description:
        "Stored \"Suggested videos\" sources (BL-191): which videos suggested the channel's videos (YouTube Analytics `insightTrafficSourceDetail` of traffic source RELATED_VIDEO), top 25 by views per query, each row `{ videoId, views, estimatedMinutesWatched, source, title, channelId, channelTitle }`, most views first. `source` is `ours` when the suggesting video is a synced video of any channel connected to YT Manager on this computer (its title and channel come from our own data), else `external`. An external video's title and channel are looked up after each collection and kept at most 30 days; without a fresh lookup (or for a video YouTube no longer returns) they are null while the row itself stays. THE LISTS ARE PARTIAL: YouTube returns only the top 25 suggesting videos per query, so the rows never add up to all suggested views; the suggested-views total is the RELATED_VIDEO row of agent_get_stored_breakdowns. Two forms, as agent_get_stored_search_terms. (1) `videoIds` (1-20, no dates): `videos`, each with its `sources` over its first 90 days so far (`coverage.from` = its Pacific publish date .. `coverage.through`, see `window`); YT Manager reads a video once it has 7 days, then every 7 days while its 90 days run, and once more 7 days after they end, each read replacing its rows. (2) `startDate` + `endDate` (YYYY-MM-DD, at most 92 days, no videoIds) and optional `groupBy`: the channel's suggesting videos per Monday-Sunday week (Pacific dates), for the complete weeks lying fully inside the range (`weeks`, oldest first, each with `status` and `collectedAt`); `groupBy: total` (default) adds `sources`, each video summed over the weeks that were read (a sum of weekly top-25 lists), `groupBy: week` gives each week its own `sources`. YT Manager reads the last 13 complete weeks: each once it is complete and once more 7 days after its Sunday; an older week never read stays `not_collected`. `status` is collected | retry (a query failed, tried again later; `lastError`) | failed (given up after 3 attempts) | not_collected (`coverage` null for a video). Reads happen during the dashboard's Analytics collection, at most 100 queries per channel per run (the weeks first, then the least recently read videos). A videoId of another channel, or of a private, unlisted, scheduled or never-synced video, is not listed. A LOCAL read, never a live YouTube call; each computer collects the channels connected on it. Requires channelId to be the caller's currently-active channel.",
      inputSchema: listStoredSuggestedSourcesInputSchema,
    },
    (args) => handlers.agentGetStoredSuggestedSources(args)
  );

  registerTool(
    "agent_query_video_analytics",
    {
      description:
        "Agent-oriented per-video daily analytics rows already collected locally (raw, un-aggregated FACT rows -- compute any sum/average yourself), with explicit metric definitions and a freshness note pointing at analytics_data_quality for exact per-date coverage. Wraps the existing analytics_list capability -- a local read only, never a live YouTube call. Optional videoId/startDate/endDate/metricNames narrow the result; omitting metricNames describes every metric this instance actually collects (never an invented one). Optional `format: wide` returns `wideRows` instead of `rows` (which is then empty): one row per video per day with a column per metric (null where that metric has no row that day) -- 6 metrics x 6 days is 6 rows, not 36. Requires channelId to be the caller's currently-active channel.",
      inputSchema: queryVideoAnalyticsInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.agentQueryVideoAnalytics(args)
  );

  registerTool(
    "agent_list_assets",
    {
      description:
        "List catalogued creative assets (thumbnails, source images, scripts, prompts, project files, etc.) for a channel, optionally narrowed by a linked videoId or assetType. Metadata only -- never returns/fetches the actual file behind referenceValue. Requires channelId to be the caller's currently-active channel. Directly populated only via the operator-facing 'asset register' CLI command (which also allows local_path); agent_register_external_artifact adds an asset indirectly, tied to a Content Proposal, restricted to referenceKind url/external_artifact_id.",
      inputSchema: listAssetsInputSchema,
    },
    (args) => handlers.agentListAssets(args)
  );

  registerTool(
    "agent_get_asset_context",
    {
      description:
        "Fetch one catalogued asset's full metadata record by assetId (type, reference kind/value, linked video, provenance, creation date). Requires channelId to be the caller's currently-active channel and assetId to actually belong to it -- otherwise fails with ASSET_NOT_AVAILABLE, the same error for 'does not exist' and 'belongs to another channel'.",
      inputSchema: getAssetContextInputSchema,
    },
    (args) => handlers.agentGetAssetContext(args)
  );

  registerTool(
    "agent_get_generation_provenance",
    {
      description:
        "Read back the provenance recorded for a localization Change Set at creation time -- editorial-profile version, effective context, evidence, rationale, changeSetId/channelId, and real creation timestamp. Returns { provenance: null } if the Change Set was created without one (e.g. XLSX import) -- never an error. profileVersion/effectiveContext/evidence/rationale were supplied by whoever created the Change Set, not independently verified by this server -- treat those as a claimed, not attested, fact. createdVia/agentApiVersion ARE server-stamped, never caller-supplied: 'mcp' with the real agent API version for a Change Set created through this MCP surface, 'cli'/null for the CLI, 'web_ui'/null for the Web UI's own 'Generate with AI', and null/null only for a row created before this field existed. Requires channelId to be the caller's currently-active channel; a changeSetId belonging to another channel returns the same null as a nonexistent one.",
      inputSchema: getGenerationProvenanceInputSchema,
    },
    (args) => handlers.agentGetGenerationProvenance(args)
  );

  registerTool(
    "agent_create_content_proposal",
    {
      description:
        "Create a structured Content Proposal (owner spec §18) -- optional objective, topicConcept, rationale, evidence (external-research/comparable-video citations: url, retrievedAt, description, claimSupported, sourceType, optional excerpt), a bounded free-form brief (proposedTitleDirection, thumbnailDirection, visualBrief, audioBrief, durationHint, publicationHypothesis, localizationStrategy, experimentDesign, expectedMetrics, requiredProductionOutputs), and referenceVideoIds/referenceAssetIds (each validated to actually belong to the requesting channel). Write-once -- there is no update or approval workflow for this domain; a proposal is a DRAFT object, full stop. createdVia/agentApiVersion (owner spec §22) are SERVER-STAMPED: 'mcp' with the real agent API version for a proposal created through this MCP surface, never caller-supplied. The application does not generate any of the proposed content itself. Requires channelId to be the caller's currently-active channel. Mutates local application state, so this tool is gated by the same device-availability/recovery-mode check as ai_localization_create_change_set.",
      inputSchema: createContentProposalInputSchema,
    },
    (args) => handlers.agentCreateContentProposal(args)
  );

  registerTool(
    "agent_get_content_proposal",
    {
      description:
        "Fetch one Content Proposal's full record by proposalId. Requires channelId to be the caller's currently-active channel and proposalId to actually belong to it -- otherwise fails with CONTENT_PROPOSAL_NOT_AVAILABLE, the same error for 'does not exist' and 'belongs to another channel'.",
      inputSchema: getContentProposalInputSchema,
    },
    (args) => handlers.agentGetContentProposal(args)
  );

  registerTool(
    "agent_list_content_proposals",
    {
      description:
        "List Content Proposals for a channel, newest first. Metadata only -- never resolves referenced videos/assets itself. Requires channelId to be the caller's currently-active channel.",
      inputSchema: listContentProposalsInputSchema,
    },
    (args) => handlers.agentListContentProposals(args)
  );

  registerTool(
    "agent_register_external_artifact",
    {
      description:
        "Register an externally-produced artifact (owner spec §19 -- a thumbnail, source image, audio file, rendered video, script, production manifest, etc. produced by Codex or an external tool) and link it back to the Content Proposal that requested it. channelId, proposalId, assetType, referenceKind, referenceValue are required; title/description/linkedVideoId/provenance optional. referenceKind is restricted to 'url'/'external_artifact_id' only -- never 'local_path' (owner spec §17: an agent may only receive/register explicitly authorized assets, never self-authorize filesystem access; local_path registration stays available only via the operator-facing 'asset register' CLI command). When referenceKind is 'url', referenceValue must actually be an http(s) URL (validated, not just labeled) -- a filesystem path or file:// URI is rejected. 'external_artifact_id' remains an intentionally opaque identifier with no structural validation beyond non-empty; this application never resolves it. createdVia/agentApiVersion (owner spec §22) are SERVER-STAMPED: 'mcp' with the real agent API version, never caller-supplied. Requires channelId to be the caller's currently-active channel and proposalId to actually belong to it. Mutates local application state, so this tool is gated by the same device-availability/recovery-mode check as agent_create_content_proposal.",
      inputSchema: registerExternalArtifactInputSchema,
    },
    (args) => handlers.agentRegisterExternalArtifact(args)
  );

  registerTool(
    "agent_list_proposal_artifacts",
    {
      description:
        "List every artifact registered against a Content Proposal, newest first, each with its full catalogued asset record. Requires channelId to be the caller's currently-active channel and proposalId to actually belong to it.",
      inputSchema: listProposalArtifactsInputSchema,
    },
    (args) => handlers.agentListProposalArtifacts(args)
  );

  registerTool(
    "agent_list_operations_files",
    {
      description:
        "List files/folders under the operator-configured operations-workspace directory (owner spec §3/§30) -- a folder OUTSIDE this repository holding Codex's own operating/editorial instructions, never generated or stored by this application itself. Returns { configured: false } if the operator has not set a path yet, never a silently empty list. Only .md/.txt/.json/.yaml/.yml files are listed; dotfiles/dot-directories are always excluded. Bounded by a fixed depth/file-count cap, reporting truncated: true if either was hit. Not channel-scoped -- one global path. The path itself can only be set through the Web UI's Settings tab, never through any MCP tool or CLI command.",
      inputSchema: operationsWorkspaceListFilesInputSchema,
    },
    (args) => handlers.agentListOperationsFiles(args)
  );

  registerTool(
    "agent_get_operations_file",
    {
      description:
        "Read one file's content from the operator-configured operations-workspace directory, by its path as returned from agent_list_operations_files. Returns { configured: false } if no path is set. A path attempting to escape the configured directory (.. segments, an absolute path, or a symlink resolving outside it) is rejected with the same OPERATIONS_FILE_NOT_AVAILABLE error as a genuinely nonexistent file -- never distinguishable. Content is capped at 200,000 bytes per file, reporting truncated: true if the real file is larger. Not channel-scoped.",
      inputSchema: operationsWorkspaceGetFileInputSchema,
    },
    (args) => handlers.agentGetOperationsFile(args)
  );

  registerTool(
    "agent_find_comparable_videos",
    {
      description:
        "Owner spec §10: find already-synced videos on the same channel comparable to an anchor video, by publication proximity, duration proximity, and/or an age-aligned (days-since-publish, capped at 365) already-collected performance metric threshold. Local reads only -- never a live YouTube call. Does NOT support 'same content family', 'similar target audience', or 'similar metadata pattern' matching -- no data source for any of those exists in this application. sharedTitleTokens is a literal lowercase word-overlap set, never topic/semantic similarity, never an embedding model. credentialRef is optional and, if omitted, resolved automatically to the caller's own active identity -- only actually used (for the local analytics read) when performanceMetric is requested. The response's anchor block and performanceAlignment report the exact reference point results were compared against. Videos missing data a requested duration/performance filter needs are counted in excludedForMissingData, never fabricated or silently dropped. Requires channelId to be the caller's currently-active channel and anchorVideoId to actually belong to it.",
      // SDK-facing schema deliberately relaxes the "performanceMetric requires credentialRef"
      // cross-field rule (same reasoning as agent_query_channel_analytics's own
      // .partial({credentialRef: true}) above) -- the handler resolves/injects credentialRef and
      // re-validates against the FULL findComparableVideosInputSchema before ever calling the
      // domain service, so this never weakens the actual rule, only defers it past the SDK's own
      // pre-handler validation.
      inputSchema: findComparableVideosSdkInputSchema,
    },
    (args) => handlers.agentFindComparableVideos(args)
  );

  registerTool(
    "agent_list_asset_performance",
    {
      description:
        "Owner spec §16: joins the existing asset catalog (linkedVideoId -- an operator/agent-asserted 'this asset was used on this video' association, never verified against YouTube, no time range) against each linked video's own already-collected performance data. Always reports each video's LIFETIME totals (viewCount/likeCount/commentCount/durationSeconds, each independently null if never synced, plus lifetimeCountersAsOf -- when the channel sync last refreshed them, NOT when analytics were collected); an OPTIONAL age-aligned value (performanceMetric + a REQUIRED, caller-supplied performanceDayOffset -- never derived from wall-clock 'now', reusing the same shared age-alignment helper as agent_find_comparable_videos) is additionally computed only when both are given, and is honestly null (never excluded, never fabricated) for a video with real data at later days but no day-0 coverage. sort: 'lifetimeViewCount' ranks by a NON-age-fair total that structurally favors older videos -- never itself a 'performed better' signal. This is a JOIN, not a FILTER -- a null performance value is still a reportable row; only an asset's own broken link (unlinked, or its linkedVideoId not resolving to a video on the SAME channel -- one combined count) is excluded, counted in excludedForMissingLink. Does NOT include thumbnail impressions/CTR -- read them with agent_query_channel_reach (per video and day with groupBy video_day; never approximated here via card/annotation click-through metrics) -- and does NOT support metadata/version linkage (no temporal precision on linkedVideoId) or experiment/outcome linkage (an experiment's videos by arm and their values: agent_get_experiment_results). Never reads Content Proposal reference associations -- a structurally different, draft/unactioned relationship. credentialRef is optional and, if omitted, resolved automatically to the caller's own active identity -- only actually used when performanceMetric is requested. limit is silently clamped, never rejected. Requires channelId to be the caller's currently-active channel.",
      // Same SDK-facing relaxed-schema pattern as agent_find_comparable_videos above.
      inputSchema: listAssetPerformanceSdkInputSchema,
    },
    (args) => handlers.agentListAssetPerformance(args)
  );

  // Phase 11 (docs/roadmap/plans/PHASE_11_PLAN.md) -- active-channel-scoped read, unlike the
  // global market-intelligence tools registered below.
  registerTool(
    "agent_get_channel_workspace",
    {
      description:
        "Phase 11: the local production-workspace folder path the operator set for this channel on THIS device (Settings -> Channels), as an absolute path string. Returns { configured: false } when none is set -- never an empty-string path. This application never opens, lists, reads, writes, or re-validates anything inside that folder; the path is returned exactly as stored, even if the folder has since been moved or deleted, so check it with your own filesystem tools. Device-local: a path set on another computer is never returned here. Read-only: no MCP tool or CLI command can set or clear it -- only the operator, through the Settings UI. Requires channelId to be the caller's currently-active channel.",
      inputSchema: getChannelWorkspaceInputSchema,
    },
    (args) => handlers.agentGetChannelWorkspace(args)
  );

  // Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F4) -- instance-wide registry reads, not channel-scoped.
  registerTool(
    "agent_list_logical_paths",
    {
      description:
        "List the logical paths every agent may read, with THIS computer's value: { name, description, configured, path }. configured:false means the operator has not set a folder for it on this computer (never an empty path). Paths the operator reserved for other roles are not listed. Device-local: a value set on another computer is never returned. This application never opens, lists or reads anything inside a path; check it with your own filesystem tools. Read-only: no MCP tool or CLI command can create, set or delete a path -- only the operator, in Settings.",
      inputSchema: z.object({}).strict(),
    },
    (args) => handlers.agentListLogicalPaths(args)
  );

  registerTool(
    "agent_get_logical_path",
    {
      description:
        "Get one logical path's value on THIS computer by its name (e.g. factory_shared), as an absolute path string. Fails with LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE when the operator has not set a folder for it on this computer (never returns an empty path), and with LOGICAL_PATH_NOT_FOUND for an unknown name or a name that is not available to agents (the two are indistinguishable). The string is returned exactly as stored, even if the folder has since been moved or deleted. Read-only.",
      inputSchema: getLogicalPathInputSchema,
    },
    (args) => handlers.agentGetLogicalPath(args)
  );

  registerTool(
    "query_market_overview",
    {
      description:
        "Compact bulk read of the research watchlist: several channels in ONE call, paged (limit default 50, max 200; offset; nextOffset is null on the last page). Per channel: channelId, handleOrUrl, its newest stored channel snapshot (observedAt, subscriberCount, viewCount, videoCount, hiddenSubscriberCount -- raw values as stored, null when none), channelSnapshotCount, videoSnapshotCount (stored snapshot ROWS: a video snapshotted in several runs counts several times), uniqueVideoCount (distinct videoId among them), latestVideoSnapshotAt (newest observedAt among them, null when none), evidenceCount, dataQualityFlags and `collection` (how deep this channel's uploads are collected: maxVideosPerChannel = the cap of distinct videos kept, publishedAfter = YYYY-MM-DD limit or null, videosStored = distinct videos stored now, complete = false while the first/deeper collection is still under way or has not run yet -- the Manager continues it on its own across days within the daily unit budget -- and true once it reached the cap, the date or the end of the channel's uploads, completeReason = cap | date | exhausted; videosStored below maxVideosPerChannel with complete true simply means the channel has fewer uploads or older snapshots aged out of the 30-day window; the operator sets the depth in Settings and on each watchlist entry, not you), plus the watchlist activity fields: latestUploadPublishedAt (the newest publishedAt among the channel's stored video snapshots, raw, null when none is stored -- it fades with the 30-day window once collection stops), inactive (true only when that date is known and older than the operator's 'inactive after N months' setting, default 6), pausedAt and pausedReason (inactive = paused automatically, owner = paused by the operator; a paused channel is not collected) -- no evidence text and no snapshot lists (use query_market_intelligence for one channel's detail, or agent_export_research_data to get every row as files). Omit channelIds for every watchlist channel you may see; naming one you cannot see fails with RESEARCH_CHANNEL_NOT_AVAILABLE. Other channels' API-sourced snapshots are returned only for the last 30 days (YouTube API Developer Policies III.E.4.d). Nothing is computed from competitor statistics (no ranking, rate or median: III.E.4.h). A local read only, never a live YouTube call.",
      inputSchema: listResearchOverviewInputSchema,
    },
    (args) => handlers.queryMarketOverview(args)
  );

  registerTool(
    "agent_export_research_data",
    {
      description:
        "Write the research watchlist's snapshots (and our own channel's videos) as flat, script-ready files, so a script can read them instead of you retyping tool output. The Manager writes them into the fixed folder `99 Data Exchange/From YTM/` inside this channel's workspace folder (created on the first export; the Manager writes nowhere else in the workspace and never modifies or deletes anything it did not create there) (the same folder agent_get_channel_workspace returns) and chooses every file name; you choose neither. Returns, per file: dataset, format, absolute path, data-row count, bytes and expiresAt -- the data itself is NOT returned (open the files with your own tools or run a script on them). Files: `research_channel_snapshots` (channel, channelId, observedAt, subscriberCount, viewCount, videoCount, hiddenSubscriberCount, videoSnapshotCount, evidenceCount, dataQualityFlags, uniqueVideoCount, latestVideoSnapshotAt -- one row per stored channel snapshot; videoSnapshotCount is the number of stored video-snapshot ROWS of the channel, uniqueVideoCount the distinct videoId among them, latestVideoSnapshotAt their newest observedAt; videoCount is YouTube's own channel counter taken in a separate call from the video snapshots, so a small difference between it and uniqueVideoCount is expected -- the new columns are appended after the existing ones), `research_video_snapshots` (channel, channelId, videoId, publishedAt, observedAt, viewCount, likeCount, commentCount, title, durationSeconds, liveBroadcastContent -- one row per stored video snapshot; the last two are appended after the existing columns: durationSeconds is the raw video length in seconds and liveBroadcastContent is YouTube's own value none/live/upcoming, both EMPTY when unknown -- snapshots taken before 2026-10-04 stay empty, liveBroadcastContent is only filled when the collection had to use the videos.list fallback, and the Manager derives no Shorts flag: use durationSeconds) and, with includeOwnChannel (default true), `own_video_snapshots` in exactly the same columns (our public videos, observedAt = last sync, so one method compares both). `channel` is the watchlist handle/URL (channel id when none). Row counts equal what query_market_intelligence returns for the same channels; omit researchChannelIds for every watchlist channel you may see. formats: `csv` (default; RFC 4180, a title that starts with = + - @ gets a leading apostrophe) and/or `json` (every value exactly as stored). RETENTION: other channels' API-sourced statistics may be kept at most 30 days (YouTube API policy III.E.4.d): research_* files carry expiresAt (30 days after the oldest observation inside) and the Manager deletes them itself then; treat any copy you make as short-lived. own_video_snapshots has no expiry. Errors: RESEARCH_EXPORT_WORKSPACE_NOT_CONFIGURED when the operator has not set a folder for this channel (only the operator can, in Settings -> Channels), RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE when the folder is not usable; nothing is written then. Requires channelId to be the caller's currently-active channel. Local only, never a live YouTube call.",
      inputSchema: exportResearchDataInputSchema,
    },
    (args) => handlers.agentExportResearchData(args)
  );

  // Phase 9 slice 4 (docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md) -- fulfils the two capability
  // names PLANNED_FUTURE_CAPABILITIES reserved since Phase 7 (src/lib/agent-operations/contracts.ts),
  // using these exact literal tool names rather than an `agent_`-prefixed pair. Both are pure local
  // reads over the market-intelligence module's own watchlist/evidence storage, never a live
  // YouTube call, never channel-scoped (this data is global, about channels the operator does not
  // necessarily own).
  registerTool(
    "query_competitors",
    {
      description:
        "List every channel currently on the research watchlist (channelId, handleOrUrl, reason it was added, addedAt, and the activity fields latestUploadPublishedAt / inactive / pausedAt / pausedReason with the same meaning as in query_market_overview) -- no evidence attached, just the roster. A local read only, never a live YouTube call. Global data, not scoped to any owned channel -- these are channels the operator does not necessarily own (docs/roadmap/plans/PHASE_9_PLAN.md).",
      inputSchema: queryCompetitorsInputSchema,
    },
    (args) => handlers.queryCompetitors(args)
  );

  registerTool(
    "query_market_intelligence",
    {
      description:
        "Single-channel deep dive into the research watchlist: one watchlisted channel's own record (channelId, handleOrUrl, reason, addedAt, and the activity fields latestUploadPublishedAt / inactive / pausedAt / pausedReason, as in query_market_overview), its evidence history (each row's observation, source, confidence, collectedAt), channel/video snapshots (9A; each video row has durationSeconds and liveBroadcastContent -- the video's newest values read within the last 30 days, null when none -- and thumbnailUrl, YouTube's own image URL) -- another channel's API-sourced snapshots/evidence only within the last 30 days (YouTube API Developer Policies III.E.4.d), operator-entered rows at any age, topic assignments (9E), and a derived dataQualityFlags array (9I -- e.g. stale_observation, missing_snapshot, quota_limited, hidden_subscriber_count, feed_fallback_used = the newest collection got only the ~15 newest uploads from the RSS feed because the uploads-playlist call failed, so the video list is shorter than normal; never a fabricated flag when there's simply no data yet) and collectionProgress (the channel's collection depth and progress: maxVideosPerChannel, publishedAfter, videosStored, complete, completeReason, same meaning as `collection` in query_market_overview). Fails with RESEARCH_CHANNEL_NOT_AVAILABLE if the given channelId is not on the watchlist. A local read only, never a live YouTube call. Every evidence row is a raw, sourced public observation -- never a ranking or profitability conclusion (docs/roadmap/plans/PHASE_9_PLAN.md §4/§7). `confidence` is free text, not a calibrated probability -- a row from the 'fetch public snapshot' action can read \"high\" even when every underlying count was hidden or absent (this vocabulary is a known, still-open design question, docs/roadmap/plans/PHASE_9_PLAN.md §8).",
      inputSchema: getWatchlistEntryInputSchema,
    },
    (args) => handlers.queryMarketIntelligence(args)
  );

  registerTool(
    "agent_list_market_records",
    {
      description:
        "One list tool covering topics/trend candidates/discovery candidates by a `kind` discriminator, rather than three separate tools (owner spec §28). `kind: \"topics\"` -> { kind, topics }; `kind: \"trend_candidates\"` -> { kind, trendCandidates }; `kind: \"discovery_candidates\"` -> { kind, candidates }. A local read only, never a live YouTube call. Global data, not scoped to any owned channel, same as query_competitors/query_market_intelligence (docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md).",
      inputSchema: agentListMarketRecordsInputSchema,
    },
    (args) => handlers.agentListMarketRecords(args)
  );

  registerTool(
    "agent_create_market_research_request",
    {
      description:
        "Creates a structured research/discovery draft (query, rationale, optional monitorDurationDays -- stored as descriptive metadata only, never consulted by any scheduler, since none exists in this application). Always starts status:\"pending\". Makes zero YouTube calls and spends zero quota -- a human must separately approve it through the Web UI before the one real search.list run it can ever trigger actually happens (owner spec §29: \"this must not automatically create unlimited collection jobs\"). There is no MCP tool to approve or reject a request -- that is reachable ONLY through the Web UI (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md). BL-145: query is 1-200 characters (the search's own limit; longer is refused here instead of failing after approval). When the human approves it, the channels the search finds are assigned to your channel, so agent_list_market_records { kind: \"discovery_candidates\" } shows them.",
      inputSchema: createMarketResearchRequestInputSchema,
    },
    (args) => handlers.agentCreateMarketResearchRequest(args)
  );

  registerTool(
    "agent_create_collection_request",
    {
      description:
        "Asks the human to collect fresh public snapshots of watchlist channels (ADR 0021). Input { researchChannelIds?: string[] (default: every watchlist channel assigned to you), reason?: string (max 500, shown to the human verbatim) }; there is no force flag. Makes zero YouTube calls and spends nothing: it stores a PENDING request with a local estimate per channel ({ mode: backfill|incremental, expectedUnits, worstCaseUnits }) -- UPPER BOUNDS in YouTube Data API quota units (not model tokens; an incremental refresh is about 2, at most 5), plus totals, dailyBudgetUnits, unitsSpentToday, remainingTodayUnits and fitsToday (worst-case total <= units left today; a request that does not fit is still created, and collection stops at the daily budget and resumes from its saved cursor next day). The human approves or rejects it in the Research tab; you can neither approve nor run it, and an approved request runs the REGULAR collection for its channels only (24 h stale window, 24 h pause after a failure, daily budget). Result { created, request, notNeeded, alreadyRequested }: notNeeded = channels left out because they were collected successfully within 24 h (collected_recently) or failed within 24 h (recent_failure), with hoursSince; alreadyRequested = channels that already have an open (pending/approved/running) request -- at most one open request per channel -- with that request's id; when nothing is left, created is false and no record exists. Fails with MARKET_INTELLIGENCE_QUOTA_DISABLED when the owner has not set a daily budget. Follow progress with agent_get_collection_request; A request can end `done` even when every channel was skipped_* (nothing collected: already fresh, in the failure pause, or no budget left) -- always read the per-channel `result` of agent_get_collection_request instead of assuming the data is fresh. alreadyRequested exposes a requestId only for a request assigned to you.  see the owner's limits with agent_get_collection_limits.",
      inputSchema: createCollectionRequestInputSchema,
    },
    (args) => handlers.agentCreateCollectionRequest(args)
  );

  registerTool(
    "agent_get_collection_request",
    {
      description:
        "One collection request by requestId, or (no requestId) the most recent ones assigned to you: status (pending|approved|running|done|rejected|failed), reason, the creation-time estimate, and after a run the per-channel result (outcome completed|partial_budget|failed|skipped_not_stale|skipped_recent_failure|skipped_quota_limited, videosStored, newSnapshotsObservedAt = when the new snapshot was observed, unitsSpent in YouTube quota units) and unitsSpentTotal. partial_budget = the budget ran out mid-collection; the cursor is kept and the next regular collection continues it. A rejected request carries the human's resolvedReason. A `done` request can have every channel skipped_* (nothing collected) -- check the per-channel results. Local read only, never a live YouTube call. An id not assigned to you behaves exactly like one that does not exist (COLLECTION_REQUEST_NOT_FOUND).",
      inputSchema: getCollectionRequestInputSchema,
    },
    (args) => handlers.agentGetCollectionRequest(args)
  );

  registerTool(
    "agent_get_collection_limits",
    {
      description:
        "The owner's own collection limits and what is left today, in YouTube Data API quota units (not model tokens): dailyBudgetUnits (null = no budget set, so agent_create_collection_request is refused), unitsSpentToday, remainingTodayUnits, quotaDayResetsAt (next Pacific midnight), the default collection depth (defaultMaxVideosPerChannel, defaultPublishedAfter), staleWindowHours (24) and perChannelOverrides. Local read only, never a live YouTube call. Use it to size a request before creating it.",
      inputSchema: agentGetCollectionLimitsInputSchema,
    },
    (args) => handlers.agentGetCollectionLimits(args)
  );

  registerTool(
    "agent_list_hypotheses",
    {
      description:
        "Lists every hypothesis visible to the caller (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md) -- channel-scoped rows narrowed to the caller's own active channel, channel-less 'new channel concept' rows always included. Local read only. Does not include each hypothesis's experiments -- use agent_get_hypothesis_trail for a single hypothesis's full evidence-to-outcome trail (owner spec §25: prefer a small number of composable tools).",
      inputSchema: agentListHypothesesInputSchema,
    },
    (args) => handlers.agentListHypotheses(args)
  );

  registerTool(
    "agent_get_video_comments",
    {
      description:
        "Stored comments of the channel's own videos (BL-171): for each of `videoIds` (1-20), the newest top-level comments YT Manager read (`limit` 1-100, default 20), newest first -- each { commentId, text (plain text, as YouTube returned it), likeCount, publishedAt, updatedAt, replyCount, byChannelOwner (the channel itself wrote it) }. No author name, photo or id is kept. Per video also `title`, `commentCountAtRead` (YouTube's comment count when it was read), `status` (collected | disabled -- comments are turned off on the video | retry -- a read failed, tried again later; `lastError` | failed -- given up after 3 attempts, read again only when its count changes | not_collected) and `readAt` (when the stored text was fetched). YT Manager reads comments once a day per channel during the dashboard's collection: it checks each non-private video's comment count (1 quota unit per 50 videos) and reads a video (1 unit, the 100 newest) when it has comments and its count changed, or once a week; replies themselves are not read. YouTube's API policy keeps this text at most 30 days: rows older than that are deleted, so a video read long ago can show `collected` with no comments until its next read. A videoId of another channel is not listed. A LOCAL read, never a live YouTube call; each computer collects the channels connected on it. Requires channelId to be the caller's currently-active channel.",
      inputSchema: listStoredCommentsInputSchema,
    },
    (args) => handlers.agentGetVideoComments(args)
  );

  registerTool(
    "agent_get_experiment_results",
    {
      description:
        "One experiment of the channel with its videos by arm and each video's own stored values (BL-170): `experiment` (status, treatment, controlBaseline, successCriteria, stoppingCriteria, plannedDuration) and `arms: [{ arm, videos }]` (`control` first). Each video: videoId, title, publishedAt, durationSeconds, linkedAt, linkedVia (web_ui = the owner, producer_proposal = an approved Producer proposal), `published` (false while private, unlisted or scheduled, or no longer synced: no milestones yet), `breakdownCoverage` (which days of traffic sources and devices are stored) and `milestones` for day 7 and day 28: windowStart/windowEnd (Pacific publish date .. +6 / +27), status (collected | retry | failed | due -- not collected yet though it could be | not_due -- its window and YouTube's 3-day lag are not over), `totals` (views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage as YouTube returned them; null unless collected), `reach` over the same window (impressions, impressions-weighted ctr, daysWithData; null values with 0 days -- when the top-level `reachError` is set, a window with 0 days may not have been read; `reachState` is the channel's Reach state) and `trafficSources` / `devices` summed over the window from the stored daily rows (only the stored days count -- see breakdownCoverage). Each video's own values only: YT Manager computes no per-arm average, sum or comparison. The retention curve is in agent_get_video_milestones and the search terms in agent_get_stored_search_terms (with the arm's videoIds). Links are made by the owner in Decisions or by an approved producer_propose experiment.link_video; agent_get_hypothesis_trail lists the experiments. Another channel's experiment is refused with CHANNEL_NOT_ACTIVE, an unknown one (or one without a channel) is EXPERIMENT_NOT_FOUND. A LOCAL read, never a live YouTube call; milestones and breakdowns are collected per computer. Requires channelId to be the caller's currently-active channel.",
      inputSchema: getExperimentResultsInputSchema,
    },
    (args) => handlers.agentGetExperimentResults(args)
  );

  registerTool(
    "agent_get_hypothesis_trail",
    {
      description:
        "One hypothesis plus every one of its experiments, each with its own recorded outcomes and its videos by arm (`arms: [{ arm, videos: [{ videoId, linkedAt, linkedBy, linkedVia }] }]`, `control` first; BL-170 -- agent_get_experiment_results gives their stored values) -- the full evidence -> hypothesis -> experiment -> outcome trail FUTURE_PHASES.md §6's own completion criterion describes, in one call. Fails with HYPOTHESIS_NOT_FOUND if the id is unknown, or the same channel-context error as any other channel-scoped read if the hypothesis belongs to a channel the caller isn't authorized for. Local read only, never a live YouTube call. Never includes a transition/approval action -- status changes and outcome recording remain Web-UI-only.",
      inputSchema: agentGetHypothesisTrailInputSchema,
    },
    (args) => handlers.agentGetHypothesisTrail(args)
  );

  // Phase 14 slice 5 (docs/roadmap/plans/PHASE_14_PLAN.md §2.7): remote media generation on RunPod/ComfyUI. The agent requests a
  // SESSION (one GPU pod with caps), a human approves it in Servers → Sessions, then the agent submits JOBS freely until the session is
  // stopped (idle / minutes / USD cap / human). No tool here can approve, start or stop a session.
  registerTool(
    "agent_list_media_templates",
    {
      description:
        "Phase 14: the ComfyUI workflow templates on this computer -- installed from the factory template registry (source 'factory', the same id and version on every computer) or imported by the operator (source 'owner') -- each with its declared parameters -- the only values a job may set: { name, type: string|text|number|integer|boolean|enum|image|audio|video, required, default, min, max, enum, description, accept, maxBytes } -- plus models (the model files it loads), outputNodeIds (the Save nodes whose files become the job's outputs) and version. An image/audio/video parameter is an INPUT FILE: its value is a path relative to your workspace's 99 Data Exchange/Sent to YTM/ (accept = allowed extensions, maxBytes = size limit, at most 500 MB). Templates are technical graphs; the prompt text and every creative choice are YOUR job parameters. Local read only. Requires channelId to be the caller's currently-active channel.",
      inputSchema: agentListMediaTemplatesInputSchema,
    },
    (args) => handlers.agentListMediaTemplates(args)
  );

  registerTool(
    "agent_request_media_session",
    {
      description:
        "Phase 14: asks the human to start a generation SESSION -- one RunPod GPU pod running ComfyUI -- with caps { maxMinutes? (default from Settings), maxUsd?, reason? (max 500, shown to the human), releaseWhenDone? (true = the pod is stopped by itself one minute after the session's last job finished; false = it stays up until the idle timeout or your release; omitted = the owner's setting in Servers -> Setup, on by default -- pass false when you submit a probe job first and the rest later) }. Creating the request costs nothing and makes no RunPod call: it stores a PENDING session with a local estimate (estimateUsd = the saved GPU price x maxMinutes / 60, an upper bound) and fitsToday against the owner's daily USD cap (a request that does not fit is still created and flagged). The human approves or rejects it in Servers -> Sessions; you can neither approve nor start it. Once status is `running`, submit jobs with agent_create_media_job; the pod is terminated automatically when idle (no job traffic for the owner's idle timeout), at maxMinutes, at maxUsd, or when the human stops it -- so submit jobs promptly and check agent_get_media_session before each one. When you are done, end the session yourself with agent_release_media_session (or request it with releaseWhenDone) instead of leaving it to the idle timeout. Several sessions may be requested and run at once (each its own pod on the shared model volume); how many may hold a pod at the same time is the owner's maxConcurrentSessions (agent_get_media_limits) -- an approve beyond it waits, the request stays pending. Errors: media_generation_not_configured (the operator has not finished Settings -> Cloud APIs / Servers -> Setup), media_settings_invalid (GPU price unknown). Requires channelId to be the caller's currently-active channel.",
      inputSchema: agentRequestMediaSessionInputSchema,
    },
    (args) => handlers.agentRequestMediaSession(args)
  );

  registerTool(
    "agent_get_media_session",
    {
      description:
        "Phase 14: one session by sessionId, or (no sessionId) this channel's recent sessions (latest 20). Fields: status (pending|approved|starting|running|stopping|done|failed|rejected|interrupted), requestedBy, maxMinutes, maxUsd, estimateUsd, fitsToday, costPerHr (the pod's real $/h once started), podId, startedAt/readyAt/stoppedAt, secondsUsed and usdCharged (live while running), stopReason, error, minCudaVersion / usedMinCudaVersion / hostCudaVersion (BL-159: the session's own minimum host CUDA, the minimum its last placement attempt used, and the pod's host CUDA; null = none / no filter or not attempted yet / not known yet). `running` is the only state in which jobs can be submitted. Local read only, never the proxy token. A session of another channel behaves like one that does not exist (media_session_not_found). Requires channelId to be the caller's currently-active channel.",
      inputSchema: agentGetMediaSessionInputSchema,
    },
    (args) => handlers.agentGetMediaSession(args)
  );

  registerTool(
    "agent_get_media_limits",
    {
      description:
        "Phase 14: the owner's media limits and what is left today, in USD: maxUsdPerDay, spentTodayUsd (this computer), remainingTodayUsd (against this computer's spend), accountSpentTodayUsd and otherDevicesSpentTodayUsd (3.19.0: today's spend on the whole RunPod account -- this computer plus the other computers on the same account, from their reports; the daily cap is checked against it when a session is approved), defaultMaxMinutes, idleMinutes (a running session with no job traffic for this long is terminated), watchIntervalSeconds, ready/missing (whether the operator finished Settings -> Cloud APIs / Servers -> Setup), openSessions (this channel's non-terminal sessions, oldest first), openSession (the first of them, kept for compatibility), maxConcurrentSessions (how many sessions may hold a pod at once on this device), activeSessionCount (how many do now, any channel) and deviceHasOpenSession (true when ANY channel has a non-terminal session; informational -- it no longer blocks a request). Local read only. Use it before agent_request_media_session. Requires channelId to be the caller's currently-active channel.",
      inputSchema: agentGetMediaLimitsInputSchema,
    },
    (args) => handlers.agentGetMediaLimits(args)
  );

  registerTool(
    "agent_create_media_job",
    {
      description:
        "Phase 14: submits one generation job to a RUNNING session's ComfyUI: { sessionId, templateId, params: { <parameter name>: value } }. Parameters are validated against the template's declared parameters BEFORE anything is sent (media_job_params_invalid lists every problem: unknown name, missing required, wrong type, out of bounds, not in enum, input path not relative or wrong extension); a missing optional parameter takes its default. An image/audio/video input parameter takes a path relative to your workspace's 99 Data Exchange/Sent to YTM/ (e.g. 'refs/frame.png'); the file is checked (inside that folder, a regular file, within maxBytes) and uploaded to the server for this job only before ComfyUI gets the prompt -- media_input_unavailable when it is missing, too large or cannot be uploaded; your file in Sent to YTM is never deleted, and the uploaded copy is removed from the server after the job ends. The Save nodes' filename_prefix is rewritten per job, so outputs always land under the job's own folder. A template that needs a newer host CUDA (its minCudaVersion) than the session's known host is refused with media_gpu_host_incompatible before anything is sent (BL-159). Returns the job (status `submitted`, promptId); generation and transfer continue in the background: poll agent_get_media_job until status is done|failed|cancelled. When `done`, outputs[].localPath are absolute paths under <channel workspace>/99 Data Exchange/From YTM/media/<jobId>/ (the same folder agent_get_channel_workspace returns) and assetIds are the catalog entries registered for them (agent_get_asset_context) with full provenance; the files are deleted from the server volume once pulled. Errors: media_session_invalid_state (session not running), media_template_not_found, comfyui_rejected (ComfyUI refused the prompt -- its node/input errors are in the message and on the failed job), comfyui_unavailable (the pod's ComfyUI could not be reached), media_workspace_unavailable (the operator has not set this channel's workspace folder, so outputs cannot be received). Every submit and poll counts as session activity (resets the idle timeout). Requires channelId to be the caller's currently-active channel and the session to belong to it.",
      inputSchema: agentCreateMediaJobInputSchema,
    },
    (args) => handlers.agentCreateMediaJob(args)
  );

  registerTool(
    "agent_get_media_job",
    {
      description:
        "Phase 14: one job by jobId, or (no jobId) this channel's recent jobs (optionally one session's with sessionId). Fields: status (queued|submitted|generating|transferring|done|failed|cancelled), templateId/templateVersion, params as resolved (defaults filled in), promptId, outputs [{ nodeId, kind: images|audio|gifs|..., filename, localPath (absolute, null until pulled), bytes, sha256, remoteDeleted, assetId, note (why a file was not pulled) }], assetIds, error (a failure reason, or notes for a done job with a skipped output), inputs [{ parameter, sourcePath (your path in Sent to YTM), remoteKey, bytes, sha256, uploadedAt, remoteDeleted }], timestamps. A final job's folder also holds manifest.json (written last). Local read only. A job of another channel behaves like one that does not exist (media_job_not_found). Requires channelId to be the caller's currently-active channel. BL-144: while this device watches a generating job, `progress` carries ComfyUI's own live state { state: connecting|waiting|running|finished|error|interrupted|unavailable, nodesTotal, nodesDone, nodesCached, currentNode { id, type }, step { value, max }, percent (from nodes and steps; 100 only on success; never estimated), startedAt, updatedAt, detail }; absent otherwise.",
      inputSchema: agentGetMediaJobInputSchema,
    },
    (args) => handlers.agentGetMediaJob(args)
  );

  registerTool(
    "agent_cancel_media_job",
    {
      description:
        "Phase 14: cancels one of this channel's queued or generating jobs (ComfyUI's current execution is interrupted on a best-effort basis); a job already transferring or finished is refused with media_job_invalid_state. Never stops the session itself. Requires channelId to be the caller's currently-active channel.",
      inputSchema: agentCancelMediaJobInputSchema,
    },
    (args) => handlers.agentCancelMediaJob(args)
  );

  registerTool(
    "agent_release_media_session",
    {
      description:
        "Ends one of THIS channel's generation sessions as soon as you are done with it, so the GPU stops billing: { sessionId }. A pending request is withdrawn; a starting or running session's pod is terminated (the same stop as the owner's, its jobs' delivered files stay); a session already stopping is returned as is. A session whose pod is still being created (approved) is refused with media_session_invalid_state -- try again in a moment. You cannot start, approve or resume a session. Instead of calling this, you can request the session with releaseWhenDone: true, and it is stopped by itself one minute after its last job finished. Requires channelId to be the caller's currently-active channel; another channel's session behaves like one that does not exist (media_session_not_found).",
      inputSchema: agentReleaseMediaSessionInputSchema,
    },
    (args) => handlers.agentReleaseMediaSession(args)
  );

  registerTool(
    "agent_list_generation_plans",
    {
      description:
        "BL-143: this channel's media generation plans (made and run by the Factory Operator), read-only: { status?: active|completed|cancelled } -> { plans: [{ planId, title, status, budget, note, stages, groups (waves, with the owner's notes), items (itemKey, groupId, templateId/templateLabel, targetCount, mode, maxAttempts; no job params), progress: { stages (counts), groups, items (attempts, generated, accepted, rejected, waitingReview, missing), spend, budget (warnings 80/100), eta, notices } }] }. Local read only. Requires channelId to be the caller's currently-active channel; other channels' plans are never listed.",
      inputSchema: agentListGenerationPlansInputSchema,
    },
    (args) => handlers.agentListGenerationPlans(args)
  );

  registerTool(
    "agent_get_generation_plan",
    {
      description:
        "BL-143: one of this channel's generation plans with its events, read-only: { planId, since? } -> { plan (as agent_list_generation_plans), events: [{ at, kind, actor, details }], more, cursor }. Without since: the newest 500 events; with since: the oldest page at or after it (call again with cursor while more). Job error texts and session stop reasons are left out. Use it to see what the owner accepted or rejected and why (owner_verdict: rating out of 10, reasons, markers, note). Local read only. A plan of another channel behaves like one that does not exist (plan_not_found). Requires channelId to be the caller's currently-active channel.",
      inputSchema: agentGetGenerationPlanInputSchema,
    },
    (args) => handlers.agentGetGenerationPlan(args)
  );

  registerTool(
    "create_experiment_proposal",
    {
      description:
        "Creates an experiment (treatment, control/baseline, success/stopping criteria, responsible party) against an ALREADY-EXISTING hypothesis, identified by hypothesisId. Always starts status:\"proposed\" -- there is no field or MCP tool that lets an agent set any other status; a human must separately move it to \"approved\" through the Web UI before it is considered authorized (FUTURE_PHASES.md §6: \"no consequential action executes merely because an AI agent proposed it\"). Creating a new hypothesis, recording an outcome, and any status transition are all deliberately NOT reachable through MCP/CLI -- Web-UI-only (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md). The Producer has this tool too (BL-170): the hypothesis must be the named channel's (a Producer proposes a new hypothesis with producer_propose hypothesis.add); the new experiment's videos are proposed for its arms with producer_propose experiment.link_video, and agent_get_experiment_results reads them.",
      inputSchema: createExperimentProposalInputSchema,
    },
    (args) => handlers.createExperimentProposal(args)
  );

  registerTool(
    "agent_set_privacy",
    {
      description:
        "BL-216 (ADR 0048): hide one of THIS channel's videos or playlists, or make a playlist public: { target: video|playlist, id, privacyStatus: private|unlisted|public, dryRun? } -> { target, id, dryRun, previousPrivacyStatus, privacyStatus, changed }. dryRun defaults to true (shows the change, writes nothing); pass dryRun:false to write. public only for a playlist (owner msg 4782, Agent API 4.27.0): a video is never made public by an agent (AGENT_PUBLIC_NOT_ALLOWED, before any read). Refused: a scheduled video (AGENT_SCHEDULE_OWNER_ONLY -- its date is the owner's), the channel's current live broadcast (AGENT_LIVE_BROADCAST_OWNER_ONLY; finished recordings are fine), a video not in this channel's synced list or a playlist not of this channel (not_found). A video is written through the app's video-details write (identity check, backup, Live writes, read-back), a playlist through the playlist write (Live writes); a target already at that status is not written (changed:false). About 51 quota units for a video, about 51 for a playlist. Logged in the worker log.",
      inputSchema: setPrivacyInputSchema,
    },
    async (args: z.infer<typeof setPrivacyInputSchema>) => {
      // A preview changes nothing: only a real write passes the device mutation gate.
      const gate = args.dryRun === false ? await assertMcpDeviceAvailable() : null;
      if (gate) return gate;
      try {
        return toolSuccessResult({ ...(await createWorkerPrivacyCore().setPrivacy(args)) });
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  // BL-217 (WORKER_CAPABILITIES_PLAN.md stage 3): the Factory Operator's channel tools, for this session's channel only -- the same
  // tools over channel-pinned deps (./worker-factory-tools.ts). Only in a channel session: the Producer's closed list has none of them.
  if (agentSession) {
    for (const tool of workerFactoryTools(
      createFactoryChannelDeps,
      agentSession.channelId,
      async () => {
        // The same device mutation gate as every other channel write (the factory write tools call it first).
        const { rawSqlClient } = await import("@/lib/db");
        const { assertDeviceAvailableForMutation } = await import("@/lib/device-mutation-gate");
        await assertDeviceAvailableForMutation(rawSqlClient);
      },
      options.workerMediaDeps ?? undefined
    )) {
      registerTool(tool.name, tool.contract, tool.handler as (args: never) => Promise<ToolResponse>);
    }
  }

  registerTool(
    "agent_list_worker_actions",
    {
      description:
        "BL-215 (ADR 0048): this channel's worker log on this computer, newest first: { limit? (1-100, default 50) } -> { actions: [{ at, tool, target, detail, outcome: ok|error, errorCode }] }. One row per call of a tool that really writes to YouTube (apply with dryRun:false, playlist_create/_update/_add_videos/_remove_videos), refused calls included; kept 90 days. The owner sees the same list in Settings → Channels. Local read only; only the bound channel's rows.",
      inputSchema: agentListWorkerActionsInputSchema,
    },
    async (args: z.infer<typeof agentListWorkerActionsInputSchema>) => {
      const session = getAgentSession();
      if (!session) return toolErrorResult(new DomainError({ code: "AGENT_SESSION_OPERATOR_ONLY", message: "only a channel agent has a worker log" }));
      const rows = await listWorkerActionLogEntries(session.channelId, args.limit ?? 50);
      return toolSuccessResult({
        actions: rows.map((row) => ({
          at: row.at.toISOString(),
          tool: row.tool,
          target: row.target,
          detail: row.detail,
          outcome: row.outcome,
          errorCode: row.errorCode,
        })),
      });
    }
  );

  // BL-220 (RESTART_WHEN_IDLE_PLAN.md, ADR 0049): restart when idle -- a worker's holds are `worker:<its channel>`, and it ends only
  // those (another's hold is not_found). Hold and release are local writes, logged in the worker log (./worker-actions.ts).
  const workerHoldOwner = () => {
    const session = getAgentSession();
    if (!session) throw new DomainError({ code: "AGENT_SESSION_OPERATOR_ONLY", message: "only a channel agent holds a restart" });
    return `worker:${session.channelId}` as const;
  };
  registerTool(
    "agent_restart_status",
    {
      description:
        "BL-220 (ADR 0049): restart when idle on this computer: {} -> { request (the open restart request, or null), waitingFor: [{ kind: media_session | media_job | gemini_job | elevenlabs_job (1.40.0) | upload | live_stream | operation_lock | operation | batch | hold | mcp_quiet | check_failed, count, ids, until }], holds: [{ holdId, heldBy (factory | owner | worker:<channelId>), reason, createdAt, until, active }], lastRestart, quietMinutes, serviceMode }. Once a request is open, the server restarts itself (the system service starts the new build) when waitingFor is empty. This call does not count as an MCP call for the quiet window. Local read only.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      try {
        return toolSuccessResult({ ...(await createRestartWhenIdleCore().status()) });
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );
  registerTool(
    "agent_hold_restart",
    {
      description:
        "BL-220 (ADR 0049): keep this computer's server from restarting while this channel's work must not be cut: { minutes (whole, 1-60), reason (1-200 characters) } -> { hold: { holdId, heldBy: worker:<this channel>, reason, createdAt, until, active } }. It ends by itself at `until`, or earlier with agent_release_hold; the owner can end it too. Only delays a restart, never starts one. Refusals: validation_failed. Local write; logged in the worker log.",
      inputSchema: agentHoldRestartInputSchema,
    },
    async (args: z.infer<typeof agentHoldRestartInputSchema>) => {
      const gate = await assertMcpDeviceAvailable();
      if (gate) return gate;
      try {
        return toolSuccessResult({ ...(await createRestartWhenIdleCore().hold({ heldBy: workerHoldOwner(), minutes: args.minutes, reason: args.reason })) });
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );
  registerTool(
    "agent_release_hold",
    {
      description:
        "BL-220 (ADR 0049): end one of this channel's own restart holds early: { holdId } -> { hold, released (false when it had already ended) }. A hold of another channel, the Operator or the owner is not_found. Local write; logged in the worker log.",
      inputSchema: agentReleaseHoldInputSchema,
    },
    async (args: z.infer<typeof agentReleaseHoldInputSchema>) => {
      const gate = await assertMcpDeviceAvailable();
      if (gate) return gate;
      try {
        return toolSuccessResult({ ...(await createRestartWhenIdleCore().releaseHold({ holdId: args.holdId, by: workerHoldOwner() })) });
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  return server;
}
