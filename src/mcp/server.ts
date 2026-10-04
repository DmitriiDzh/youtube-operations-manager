#!/usr/bin/env node

import { loadEnvConfig } from "@next/env";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createVideoMetadataCore } from "@/lib/video-metadata";
import { DomainError } from "@/lib/shared-domain";
import type { VideoMetadataCore } from "@/lib/video-metadata";
import { createCliAuthService, type CliAuthService } from "@/lib/cli-auth";
import { recordGatewayCallOutcome } from "@/lib/db";
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
import { getChangeSetInputSchema, listChangeSetsInputSchema } from "@/lib/changesets/schemas";
import { createBatchCore, type BatchCore } from "@/lib/batches";
import { createChannelSyncCore, type ChannelSyncCore } from "@/lib/channel-sync";
import { createChannelAccessCore, type ChannelAccessCore } from "@/lib/channel-access";
import {
  listChannelsInputSchema,
  listSyncedVideosInputSchema,
  syncChannelInputSchema,
} from "@/lib/channel-sync/schemas";
import { createAnalyticsCore, type AnalyticsCore } from "@/lib/analytics";
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
import { createReachReportsCore, type ReachReportsCore } from "@/lib/reach-reports";
import { getChannelReachInputObjectSchema } from "@/lib/reach-reports/schemas";
import { createMarketAssignmentCore, type MarketAssignmentCore } from "@/lib/market-assignments";
import { assertAgentSession } from "@/lib/agent-session";
import { MCP_TOOL_CLASSIFICATION } from "./tool-classification";
import {
  createChannelWorkspacesCore,
  getChannelWorkspaceInputSchema,
  type ChannelWorkspacesCore,
} from "@/lib/channel-workspaces";
import {
  createResearchExportCore,
  exportResearchDataInputSchema,
  listResearchOverviewInputSchema,
  type ResearchExportCore,
} from "@/lib/research-export";
import { createMarketResearchRequestInputSchema, getWatchlistEntryInputSchema } from "@/lib/market-intelligence/schemas";
import { createDecisionEngineCore, type DecisionEngineCore } from "@/lib/decision-engine";
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
  "listChangeSets" | "getChangeSet" | "previewImport" | "createChangeSetFromImport"
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
  agentGetCapabilities: (input: unknown) => Promise<ToolResponse>;
  agentGetChannelContext: (input: unknown) => Promise<ToolResponse>;
  agentGetVideoContext: (input: unknown) => Promise<ToolResponse>;
  agentQueryChannelAnalytics: (input: unknown) => Promise<ToolResponse>;
  agentQueryChannelReach: (input: unknown) => Promise<ToolResponse>;
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
  agentListHypotheses: (input: unknown) => Promise<ToolResponse>;
  agentGetHypothesisTrail: (input: unknown) => Promise<ToolResponse>;
  createExperimentProposal: (input: unknown) => Promise<ToolResponse>;
  agentGetChannelWorkspace: (input: unknown) => Promise<ToolResponse>;
  agentExportResearchData: (input: unknown) => Promise<ToolResponse>;
  queryMarketOverview: (input: unknown) => Promise<ToolResponse>;
};

function toolErrorResult(error: unknown) {
  if (error instanceof DomainError) {
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
  reachReportsCore: Pick<ReachReportsCore, "getChannelReach"> = createReachReportsCore(),
  // BL-118 -- the channel breakdown (traffic sources, devices, ...) the Content tab already computes; a LIVE Analytics API read.
  breakdownCore: Pick<AnalyticsCore, "getChannelBreakdown"> = createAnalyticsCore(),
  // Research export (ADR 0019) -- the Manager writes flat CSV/JSON files into the channel's workspace `99 Data Exchange/From YTM/` folder (fixed name, owner-approved exception).
  researchExportCore: Pick<ResearchExportCore, "exportResearchData" | "listResearchOverview"> = createResearchExportCore()
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
    // Research export -- writes files and a ledger row: gated.
    agentExportResearchData: async (input) => (await assertMcpDeviceAvailable()) ?? handlers.agentExportResearchData(input),
    // Pure local read -- ungated, like queryCompetitors.
    queryMarketOverview: handlers.queryMarketOverview,
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
  } = {}
) {
  const connectionEnabled = options.connectionEnabled ?? false;
  const agentSession = options.agentSession ?? null;

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
    if (!connectionEnabled || !agentSession) {
      return;
    }
    const toolClass = MCP_TOOL_CLASSIFICATION[name];
    if (!toolClass) {
      // AC-P12-08: a tool nobody classified must never be exposed silently.
      throw new Error(`MCP tool "${name}" is not classified in src/mcp/tool-classification.ts`);
    }
    if (toolClass !== "bound") {
      return;
    }
    // Counts real tool invocations for the Settings tab's traffic stats (owner instruction,
    // 2026-09-22). When MCP connection is off, this wrapper never even runs (registerTool
    // returns above), so there is no failed call to count there, only an absent tool -- but a
    // call rejected because its token was revoked IS a real, counted "blocked" attempt through this
    // gateway category, exactly like the other gateways record their own rejections. (BL-091's
    // per-capability zones were retired in Phase 12, owner decision D4 -- one agent owns all of
    // its channel's work; see docs/decisions/0011-retire-agent-capability-zones.md.)
    const countedHandler = (async (args: never) => {
      try {
        assertAgentSession(agentSession.tokenId);
        await agentSession.reverify();
      } catch (error) {
        await recordGatewayCallOutcome("mcp_tool_calls", "blocked");
        return toolErrorResult(error);
      }
      await recordGatewayCallOutcome("mcp_tool_calls", "allowed");
      return handler(args);
    }) as typeof handler;
    server.registerTool(name, config as never, countedHandler as never);
  }

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
        "Create a YouTube playlist. credentialRef is OPTIONAL and falls back to active local auth context.",
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
        "Update playlist metadata with strict patch validation and write-channel guardrails. credentialRef is OPTIONAL and falls back to active local auth context.",
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
        "List a synchronized channel's videos with their existing localization languages. Read-only. credentialRef is OPTIONAL and falls back to active local auth context. With no other input it returns every field of every video, which for a large channel is very big (descriptions, thumbnails, etags, localizations): pass `fields` (e.g. [\"title\",\"publishedAt\",\"viewCount\"]; videoId is always included) and/or `limit`/`offset` (limit max 500) to get a slim, paged answer {channelId, videos, total, offset, nextOffset} -- nextOffset is null on the last page.",
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
        "Data-quality diagnostics for a channel's collected Analytics data over a date range. `covered` means a completed collection run's window included the date (or a metric row exists) -- NOT that data is present: see `coveredWithoutData` (covered dates with no stored row: zero-activity days or data YouTube had not reported yet) and `provisionalDates` (covered dates inside the re-collection window, expected to be refreshed by the next automatic run). Dates before the channel was created (`channelStartDate`) are `notApplicableRange`, never uncovered; `coveredRanges`/`uncoveredRanges` give compact ranges, and missing history is back-filled automatically. Details: which dates were actually covered by a completed collection run (`collectMetrics`), which were requested but never collected, which are too recent for the Analytics API to have reported yet (its own 1-2 day lag), and which videos had a collection failure recorded against them. A local read only -- never a live YouTube call. Absence of a `video_metrics_daily` row for a date does NOT by itself mean data is missing (the API omits zero-activity days entirely) -- use this tool, not a raw scan of analytics_list's rows, to tell genuine gaps from real zero-activity days. credentialRef is OPTIONAL and falls back to active local auth context.",
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
    "agent_get_capabilities",
    {
      description:
        "Report this running instance's product version, Agent API version, the capabilities actually implemented and reachable right now, the data domains they cover, the full permission-class vocabulary (READ/DRAFT/APPROVE/EXECUTE), the permissions actually GRANTED to this caller today (currently always READ+DRAFT -- never APPROVE/EXECUTE, since no proposal an agent creates is ever auto-approved), the future capabilities named in the Agent Operations Interface design that are not implemented yet (so an unavailable-capability error can be told apart from a typo or a hallucinated tool name), and the local database schema version. Call this first, before assuming any other Agent Operations tool exists -- this list only ever contains what is actually callable in this instance. A local read only, no channel scoping (this is instance-level information), no YouTube call.",
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
        "Task-oriented, section-selectable context for one video: 'metadata' (title, description, publish date, privacy status, default language, last sync time) and/or 'localizations' (every existing per-language title/description already synced locally). Omit `include` to get both sections; pass e.g. `include: [\"metadata\"]` to fetch only what you need. Requires channelId to be the caller's currently-active channel, and videoId to actually belong to it. Reads only already-synced local data -- never a live YouTube call. Does not include analytics (see the separate analytics tools), comparable videos, experiment history, or creative assets -- those are separate, later capabilities, not yet implemented for some of them.",
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
        "Channel-level breakdown for a date range: `breakdown` is one of trafficSources (views by traffic source), deviceType (watch minutes by device), ageGender (viewer percentage), geography (views by country), subscribedStatus, contentFormat. Each row carries the raw API `dimensionValues`, a readable `label`, and its metrics. A LIVE YouTube Analytics API read (counts against that API's quota; 1-2 day lag) -- unlike agent_query_channel_analytics there is no locally stored copy. Requires channelId to be the caller's currently-active channel.",
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
        "Owner spec §16: joins the existing asset catalog (linkedVideoId -- an operator/agent-asserted 'this asset was used on this video' association, never verified against YouTube, no time range) against each linked video's own already-collected performance data. Always reports each video's LIFETIME totals (viewCount/likeCount/commentCount/durationSeconds, each independently null if never synced, plus lifetimeCountersAsOf -- when the channel sync last refreshed them, NOT when analytics were collected); an OPTIONAL age-aligned value (performanceMetric + a REQUIRED, caller-supplied performanceDayOffset -- never derived from wall-clock 'now', reusing the same shared age-alignment helper as agent_find_comparable_videos) is additionally computed only when both are given, and is honestly null (never excluded, never fabricated) for a video with real data at later days but no day-0 coverage. sort: 'lifetimeViewCount' ranks by a NON-age-fair total that structurally favors older videos -- never itself a 'performed better' signal. This is a JOIN, not a FILTER -- a null performance value is still a reportable row; only an asset's own broken link (unlinked, or its linkedVideoId not resolving to a video on the SAME channel -- one combined count) is excluded, counted in excludedForMissingLink. Does NOT support thumbnail-CTR/impressions-based questions (this application's own analytics collection never fetches YouTube's impressions/CTR metrics at all, never approximated via card/annotation click-through metrics), metadata/version linkage (no temporal precision on linkedVideoId), or experiment/outcome linkage (Phase 10, not built yet). Never reads Content Proposal reference associations -- a structurally different, draft/unactioned relationship. credentialRef is optional and, if omitted, resolved automatically to the caller's own active identity -- only actually used when performanceMetric is requested. limit is silently clamped, never rejected. Requires channelId to be the caller's currently-active channel.",
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

  registerTool(
    "query_market_overview",
    {
      description:
        "Compact bulk read of the research watchlist: several channels in ONE call, paged (limit default 50, max 200; offset; nextOffset is null on the last page). Per channel: channelId, handleOrUrl, its newest stored channel snapshot (observedAt, subscriberCount, viewCount, videoCount, hiddenSubscriberCount -- raw values as stored, null when none), channelSnapshotCount, videoSnapshotCount (stored snapshot ROWS: a video snapshotted in several runs counts several times), uniqueVideoCount (distinct videoId among them), latestVideoSnapshotAt (newest observedAt among them, null when none), evidenceCount and dataQualityFlags -- no evidence text and no snapshot lists (use query_market_intelligence for one channel's detail, or agent_export_research_data to get every row as files). Omit channelIds for every watchlist channel you may see; naming one you cannot see fails with RESEARCH_CHANNEL_NOT_AVAILABLE. Other channels' API-sourced snapshots are returned only for the last 30 days (YouTube API Developer Policies III.E.4.d). Nothing is computed from competitor statistics (no ranking, rate or median: III.E.4.h). A local read only, never a live YouTube call.",
      inputSchema: listResearchOverviewInputSchema,
    },
    (args) => handlers.queryMarketOverview(args)
  );

  registerTool(
    "agent_export_research_data",
    {
      description:
        "Write the research watchlist's snapshots (and our own channel's videos) as flat, script-ready files, so a script can read them instead of you retyping tool output. The Manager writes them into the fixed folder `99 Data Exchange/From YTM/` inside this channel's workspace folder (created on the first export; the Manager writes nowhere else in the workspace and never modifies or deletes anything it did not create there) (the same folder agent_get_channel_workspace returns) and chooses every file name; you choose neither. Returns, per file: dataset, format, absolute path, data-row count, bytes and expiresAt -- the data itself is NOT returned (open the files with your own tools or run a script on them). Files: `research_channel_snapshots` (channel, channelId, observedAt, subscriberCount, viewCount, videoCount, hiddenSubscriberCount, videoSnapshotCount, evidenceCount, dataQualityFlags, uniqueVideoCount, latestVideoSnapshotAt -- one row per stored channel snapshot; videoSnapshotCount is the number of stored video-snapshot ROWS of the channel, uniqueVideoCount the distinct videoId among them, latestVideoSnapshotAt their newest observedAt; videoCount is YouTube's own channel counter taken in a separate call from the video snapshots, so a small difference between it and uniqueVideoCount is expected -- the new columns are appended after the existing ones), `research_video_snapshots` (channel, channelId, videoId, publishedAt, observedAt, viewCount, likeCount, commentCount, title -- one row per stored video snapshot) and, with includeOwnChannel (default true), `own_video_snapshots` in exactly the same columns (our public videos, observedAt = last sync, so one method compares both). `channel` is the watchlist handle/URL (channel id when none). Row counts equal what query_market_intelligence returns for the same channels; omit researchChannelIds for every watchlist channel you may see. formats: `csv` (default; RFC 4180, a title that starts with = + - @ gets a leading apostrophe) and/or `json` (every value exactly as stored). RETENTION: other channels' API-sourced statistics may be kept at most 30 days (YouTube API policy III.E.4.d): research_* files carry expiresAt (30 days after the oldest observation inside) and the Manager deletes them itself then; treat any copy you make as short-lived. own_video_snapshots has no expiry. Errors: RESEARCH_EXPORT_WORKSPACE_NOT_CONFIGURED when the operator has not set a folder for this channel (only the operator can, in Settings -> Channels), RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE when the folder is not usable; nothing is written then. Requires channelId to be the caller's currently-active channel. Local only, never a live YouTube call.",
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
        "List every channel currently on the research watchlist (channelId, handleOrUrl, reason it was added, addedAt) -- no evidence attached, just the roster. A local read only, never a live YouTube call. Global data, not scoped to any owned channel -- these are channels the operator does not necessarily own (docs/roadmap/plans/PHASE_9_PLAN.md).",
      inputSchema: queryCompetitorsInputSchema,
    },
    (args) => handlers.queryCompetitors(args)
  );

  registerTool(
    "query_market_intelligence",
    {
      description:
        "Single-channel deep dive into the research watchlist: one watchlisted channel's own record (channelId, handleOrUrl, reason, addedAt), its evidence history (each row's observation, source, confidence, collectedAt), channel/video snapshots (9A) -- another channel's API-sourced snapshots/evidence only within the last 30 days (YouTube API Developer Policies III.E.4.d), operator-entered rows at any age, topic assignments (9E), and a derived dataQualityFlags array (9I -- e.g. stale_observation, missing_snapshot, quota_limited, hidden_subscriber_count; never a fabricated flag when there's simply no data yet). Fails with RESEARCH_CHANNEL_NOT_AVAILABLE if the given channelId is not on the watchlist. A local read only, never a live YouTube call. Every evidence row is a raw, sourced public observation -- never a ranking or profitability conclusion (docs/roadmap/plans/PHASE_9_PLAN.md §4/§7). `confidence` is free text, not a calibrated probability -- a row from the 'fetch public snapshot' action can read \"high\" even when every underlying count was hidden or absent (this vocabulary is a known, still-open design question, docs/roadmap/plans/PHASE_9_PLAN.md §8).",
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
        "Creates a structured research/discovery draft (query, rationale, optional monitorDurationDays -- stored as descriptive metadata only, never consulted by any scheduler, since none exists in this application). Always starts status:\"pending\". Makes zero YouTube calls and spends zero quota -- a human must separately approve it through the Web UI before the one real search.list run it can ever trigger actually happens (owner spec §29: \"this must not automatically create unlimited collection jobs\"). There is no MCP tool to approve or reject a request -- that is reachable ONLY through the Web UI (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md).",
      inputSchema: createMarketResearchRequestInputSchema,
    },
    (args) => handlers.agentCreateMarketResearchRequest(args)
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
    "agent_get_hypothesis_trail",
    {
      description:
        "One hypothesis plus every one of its experiments, each with its own recorded outcomes -- the full evidence -> hypothesis -> experiment -> outcome trail FUTURE_PHASES.md §6's own completion criterion describes, in one call. Fails with HYPOTHESIS_NOT_FOUND if the id is unknown, or the same channel-context error as any other channel-scoped read if the hypothesis belongs to a channel the caller isn't authorized for. Local read only, never a live YouTube call. Never includes a transition/approval action -- status changes and outcome recording remain Web-UI-only.",
      inputSchema: agentGetHypothesisTrailInputSchema,
    },
    (args) => handlers.agentGetHypothesisTrail(args)
  );

  registerTool(
    "create_experiment_proposal",
    {
      description:
        "Creates an experiment (treatment, control/baseline, success/stopping criteria, responsible party) against an ALREADY-EXISTING hypothesis, identified by hypothesisId. Always starts status:\"proposed\" -- there is no field or MCP tool that lets an agent set any other status; a human must separately move it to \"approved\" through the Web UI before it is considered authorized (FUTURE_PHASES.md §6: \"no consequential action executes merely because an AI agent proposed it\"). Creating a new hypothesis, recording an outcome, and any status transition are all deliberately NOT reachable through MCP/CLI -- Web-UI-only (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md).",
      inputSchema: createExperimentProposalInputSchema,
    },
    (args) => handlers.createExperimentProposal(args)
  );

  return server;
}
