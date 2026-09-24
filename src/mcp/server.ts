#!/usr/bin/env node

import { loadEnvConfig } from "@next/env";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createVideoMetadataCore } from "@/lib/video-metadata";
import { DomainError } from "@/lib/video-metadata/contracts";
import type { VideoMetadataCore } from "@/lib/video-metadata";
import { createCliAuthService, type CliAuthService } from "@/lib/cli-auth/service";
import { getMcpConnectionEnabled, recordGatewayCallOutcome } from "@/lib/db";
import type { CredentialRef } from "@/lib/video-metadata/contracts";
import { createPlaylistManagementCore, type PlaylistManagementCore } from "@/lib/playlist-management";
import { OperationLockError } from "@/lib/operation-lock";
import { RecoveryModeError } from "@/lib/device-handoff";
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
import { createAgentOperationsCore, type AgentOperationsCore } from "@/lib/agent-operations";
import {
  getAssetContextInputSchema,
  getChannelContextInputSchema,
  getSystemCapabilitiesInputSchema,
  getVideoContextInputSchema,
  listAssetsInputSchema,
  queryChannelAnalyticsInputSchema,
  queryVideoAnalyticsInputSchema,
} from "@/lib/agent-operations/schemas";
import {
  getChannelOverviewInputSchema,
  getComparableAgeComparisonInputSchema,
  getDataQualityReportInputSchema,
  getWeeklyReportInputSchema,
  listMetricsInputSchema,
  listWeeklyReportsInputSchema,
} from "@/lib/analytics/schemas";

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
type BatchCoreSubset = Pick<BatchCore, "listBatchesByChannel" | "requireBatchForChannel" | "listLedgerRows">;

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

// BL-075/BL-078 (docs/roadmap/BACKLOG.md): the same "generate proposals" -> "create Change Set"
// two-step workflow the Web UI's own ai-localization routes already expose, now reachable by an
// agent over MCP/CLI too -- no new validation, persistence, or approval logic; both handlers call
// exactly these two existing, already-tested service functions unchanged. Deliberately excludes
// `getEditorialProfile`/`saveEditorialProfile`/`getGenerationProvenance` (out of this slice's
// scope) and, like every other Change-Set-adjacent tool in this file, never exposes an
// approve/reject/apply path -- "AI may propose, human approves" (AGENTS.md §G) is untouched.
type AiLocalizationCoreSubset = Pick<AiLocalizationCore, "generateProposals" | "createChangeSetFromGeneration">;

// Phase 7 (Agent Operations Interface, docs/AGENT_OPERATIONS_INTERFACE.md) -- slices A + B + C + D.
type AgentOperationsCoreSubset = Pick<
  AgentOperationsCore,
  | "getSystemCapabilities"
  | "getChannelContext"
  | "getVideoContext"
  | "queryChannelAnalytics"
  | "queryVideoAnalytics"
  | "listAssets"
  | "getAssetContext"
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
  agentQueryVideoAnalytics: (input: unknown) => Promise<ToolResponse>;
  agentListAssets: (input: unknown) => Promise<ToolResponse>;
  agentGetAssetContext: (input: unknown) => Promise<ToolResponse>;
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
  agentOperationsCore: AgentOperationsCoreSubset = createAgentOperationsCore()
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
        // AGENTS.md §F: requireBatchForChannel verifies this batch actually belongs to
        // the named channel before returning anything -- same guardrail the Web UI's
        // own API route already applies for this exact read, reused rather than
        // reimplemented against a bare `getBatch(batchId)`.
        const batch = await operationsCore.requireBatchForChannel(
          parsedInput.data.channelId,
          parsedInput.data.batchId
        );
        const ledgerRows = await operationsCore.listLedgerRows(parsedInput.data.batchId);
        return toolSuccessResult({ batch, ledgerRows });
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
        const result = await aiLocalizationCore.createChangeSetFromGeneration(parsedInput.data);
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
    const { assertDeviceAvailableForMutation } = await import("@/lib/device-handoff");
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
    agentQueryVideoAnalytics: handlers.agentQueryVideoAnalytics,
    // Slice D -- pure local reads over the asset catalog, ungated.
    agentListAssets: handlers.agentListAssets,
    agentGetAssetContext: handlers.agentGetAssetContext,
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
  options: { connectionEnabled?: boolean } = {}
) {
  const connectionEnabled = options.connectionEnabled ?? false;

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
    if (!connectionEnabled) {
      return;
    }
    // Counts real tool invocations for the Settings tab's traffic stats (owner instruction,
    // 2026-09-22) -- there is no meaningful "blocked" count here, unlike the other three
    // gateways: when MCP connection is off, this wrapper never even runs (registerTool
    // returns above), so there is no failed call to count, only an absent tool.
    const countedHandler = (async (args: never) => {
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
        "Add one or more videos to a playlist and return stable partial results with attempted/added/failures.",
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
        "Remove one or more videos from a playlist and return stable partial results with requested/removed/failures.",
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
        "List a synchronized channel's videos with their existing localization languages. Read-only. credentialRef is OPTIONAL and falls back to active local auth context.",
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
        "Data-quality diagnostics for a channel's collected Analytics data over a date range: which dates were actually covered by a completed collection run (`collectMetrics`), which were requested but never collected, which are too recent for the Analytics API to have reported yet (its own 1-2 day lag), and which videos had a collection failure recorded against them. A local read only -- never a live YouTube call. Absence of a `video_metrics_daily` row for a date does NOT by itself mean data is missing (the API omits zero-activity days entirely) -- use this tool, not a raw scan of analytics_list's rows, to tell genuine gaps from real zero-activity days. credentialRef is OPTIONAL and falls back to active local auth context.",
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
        "Persist a reviewed (optionally edited) set of AI localization proposals as a new Change Set, source 'ai_localization' -- the exact same persistence path createChangeSetFromImport (XLSX) already uses, so approval, conflict revalidation, Batch creation, and the live-write barrier are completely unchanged. The resulting Change Set and every Change on it always start 'pending' -- there is no code path, here or anywhere else, that can mark an AI-authored proposal already-approved; a human must still approve it via the Web UI before it can ever be included in a Batch. Optionally echo back the generationContext a prior ai_localization_generate call returned as `provenance`, to have it durably recorded against the resulting Change Set. Mutates local application state (never YouTube directly), so this tool is gated by the same device-availability/recovery-mode check as changeset_create_from_import. No credentialRef parameter -- always uses the active local auth context.",
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
        "Agent-oriented channel-level analytics for a date range: daily views/watch-time/subscriber-delta rows plus current- and previous-period totals, with explicit metric definitions and a data-freshness note. Wraps the existing analytics_overview capability -- a LIVE YouTube Analytics API read that counts against that API's quota (YouTube itself typically reports this data with a 1-2 day lag). Requires channelId to be the caller's currently-active channel. Raw daily rows are FACT; totals are DERIVED (summed).",
      inputSchema: queryChannelAnalyticsInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.agentQueryChannelAnalytics(args)
  );

  registerTool(
    "agent_query_video_analytics",
    {
      description:
        "Agent-oriented per-video daily analytics rows already collected locally (raw, un-aggregated FACT rows -- compute any sum/average yourself), with explicit metric definitions and a freshness note pointing at analytics_data_quality for exact per-date coverage. Wraps the existing analytics_list capability -- a local read only, never a live YouTube call. Optional videoId/startDate/endDate/metricNames narrow the result; omitting metricNames describes every metric this instance actually collects (never an invented one). Requires channelId to be the caller's currently-active channel.",
      inputSchema: queryVideoAnalyticsInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.agentQueryVideoAnalytics(args)
  );

  registerTool(
    "agent_list_assets",
    {
      description:
        "List catalogued creative assets (thumbnails, source images, scripts, prompts, project files, etc.) for a channel, optionally narrowed by a linked videoId or assetType. Metadata only -- never returns/fetches the actual file behind referenceValue. Requires channelId to be the caller's currently-active channel. Populated only via the operator-facing 'asset register' CLI command; there is no agent-callable way to add an asset in this slice.",
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

  return server;
}

export async function startMcpServer() {
  // Read once, here, at process startup -- see getMcpConnectionEnabled's own doc comment in
  // src/lib/db.ts for the one known limitation: createMcpServer()'s tool registration is fixed
  // at construction time, so an already-running MCP connection keeps its existing tool set
  // until it reconnects; this is never hot-swapped mid-session.
  const connectionEnabled = await getMcpConnectionEnabled();
  const server = createMcpServer(undefined, { connectionEnabled });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  startMcpServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
