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
import {
  listChannelsInputSchema,
  listSyncedVideosInputSchema,
  syncChannelInputSchema,
} from "@/lib/channel-sync/schemas";

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
  channelSyncCore: ChannelSyncCoreSubset = createChannelSyncCore()
) {
  async function resolveCredentialRef(explicitCredentialRef: unknown) {
    return auth.resolveEffectiveCredentialRef({
      explicit: explicitCredentialRef as CredentialRef | undefined,
    });
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
  };
}

export function createMcpServer(
  core: VideoMetadataCoreSubset & PlaylistManagementCoreSubset = {
    ...createVideoMetadataCore(),
    ...createPlaylistManagementCore(),
  }
) {
  const server = new McpServer({
    name: "youtube-video-metadata",
    version: "0.1.0",
  });

  const handlers = createMcpToolHandlers(core);

  server.registerTool(
    "write_context",
    {
      description:
        "Read-only write context for current OAuth session, including activeWriteChannel, selectedChannelId and effectiveCredentialRef.",
      inputSchema: z.object({}).strict(),
    },
    () => handlers.writeContext()
  );

  server.registerTool(
    "write_channel_list",
    {
      description:
        "List the minimal-safe known write channels from local state (active OAuth + persisted selection).",
      inputSchema: writeChannelListInputSchema,
    },
    (args) => handlers.writeChannelList(args)
  );

  server.registerTool(
    "write_channel_select",
    {
      description:
        "Persist expected write channel selection and return alignment state. Does not switch active OAuth identity.",
      inputSchema: writeChannelSelectInputSchema,
    },
    (args) => handlers.writeChannelSelect(args)
  );

  server.registerTool(
    "whoami",
    {
      description:
        "Return the active local authenticated user for this MCP server. Use this when you need to confirm which YouTube account will be used before calling other tools.",
      inputSchema: z.object({}).strict(),
    },
    () => handlers.whoami()
  );

  server.registerTool(
    "auth_user_select",
    {
      description:
        "Switch local active user fallback. Does not login, reauth, or switch active OAuth channel.",
      inputSchema: authUserSelectInputSchema,
    },
    (args) => handlers.authUserSelect(args)
  );

  server.registerTool(
    "list",
    {
      description:
        "List channel videos using the shared core. credentialRef is OPTIONAL: if omitted, the server uses the active local auth context established via CLI auth login. channelId is OPTIONAL and recommended for multi-account / Brand Account setups to force a specific YouTube channel.",
      inputSchema: listInputSchema,
    },
    (args) => handlers.list(args)
  );

  server.registerTool(
    "transcript",
    {
      description:
        "Get transcript status and text for a video. credentialRef is OPTIONAL: if omitted, the server uses the active local auth context established via CLI auth login.",
      inputSchema: transcriptInputSchema,
    },
    (args) => handlers.transcript(args)
  );

  server.registerTool(
    "preview",
    {
      description:
        "Generate final title and description preview for a video. credentialRef is OPTIONAL: if omitted, the server uses the active local auth context established via CLI auth login.",
      inputSchema: previewInputSchema,
    },
    (args) => handlers.preview(args)
  );

  server.registerTool(
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

  server.registerTool(
    "playlist_list",
    {
      description:
        "List playlists for the authenticated YouTube account. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: playlistListInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistList(args)
  );

  server.registerTool(
    "playlist_create",
    {
      description:
        "Create a YouTube playlist. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: playlistCreateInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistCreate(args)
  );

  server.registerTool(
    "playlist_add_videos",
    {
      description:
        "Add one or more videos to a playlist and return stable partial results with attempted/added/failures.",
      inputSchema: playlistAddVideosInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistAddVideos(args)
  );

  server.registerTool(
    "playlist_delete",
    {
      description:
        "Delete a playlist after strict write-channel guardrail validation. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: playlistDeleteInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistDelete(args)
  );

  server.registerTool(
    "playlist_update",
    {
      description:
        "Update playlist metadata with strict patch validation and write-channel guardrails. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: playlistUpdateToolInputSchema,
    },
    (args) => handlers.playlistUpdate(args)
  );

  server.registerTool(
    "playlist_remove_videos",
    {
      description:
        "Remove one or more videos from a playlist and return stable partial results with requested/removed/failures.",
      inputSchema: playlistRemoveVideosInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.playlistRemoveVideos(args)
  );

  server.registerTool(
    "changeset_list",
    {
      description:
        "List Change Sets for a synchronized channel's local database. Read-only -- never writes to YouTube or mutates any change's approval status.",
      inputSchema: listChangeSetsInputSchema,
    },
    (args) => handlers.changesetList(args)
  );

  server.registerTool(
    "changeset_get",
    {
      description:
        "Get one Change Set and its changes, with optional status/language/videoId filters. Read-only.",
      inputSchema: getChangeSetInputSchema,
    },
    (args) => handlers.changesetGet(args)
  );

  server.registerTool(
    "localization_import_preview",
    {
      description:
        "Preview an XLSX localization workbook (base64-encoded) against a channel's synced videos -- returns a validation summary and per-row errors. Propose-adjacent: never persists a Change Set and never writes to YouTube.",
      inputSchema: localizationImportPreviewInputSchema,
    },
    (args) => handlers.localizationImportPreview(args)
  );

  server.registerTool(
    "changeset_create_from_import",
    {
      description:
        "Parse an XLSX localization workbook (base64-encoded) and persist a new Change Set from it -- the same local-only persistence the Web UI's POST .../localizations/import route performs. Never writes to YouTube; mutating locally, so it is gated exactly like channel_sync.",
      inputSchema: localizationImportPreviewInputSchema,
    },
    (args) => handlers.changesetCreateFromImport(args)
  );

  server.registerTool(
    "batch_list",
    {
      description:
        "List Batches for a channel (dry-run-only pipeline state). Read-only -- never executes or prepares a batch.",
      inputSchema: batchListInputSchema,
    },
    (args) => handlers.batchList(args)
  );

  server.registerTool(
    "batch_get",
    {
      description:
        "Get one Batch and its per-video ledger rows, after verifying the batch belongs to the given channel. Read-only.",
      inputSchema: batchGetInputSchema,
    },
    (args) => handlers.batchGet(args)
  );

  server.registerTool(
    "channel_sync",
    {
      description:
        "Synchronize a channel's videos into the local database (read from YouTube, write to local SQLite only -- never a YouTube write). channelId is OPTIONAL and defaults to the authenticated account's own channel. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: syncChannelInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.channelSync(args)
  );

  server.registerTool(
    "channel_list",
    {
      description: "List locally synchronized channels. Read-only. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: listChannelsInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.channelList(args)
  );

  server.registerTool(
    "channel_video_list",
    {
      description:
        "List a synchronized channel's videos with their existing localization languages. Read-only. credentialRef is OPTIONAL and falls back to active local auth context.",
      inputSchema: listSyncedVideosInputSchema.partial({ credentialRef: true }),
    },
    (args) => handlers.channelVideoList(args)
  );

  return server;
}

export async function startMcpServer() {
  const server = createMcpServer();
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
