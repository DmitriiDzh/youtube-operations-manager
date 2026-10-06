/**
 * The Factory Operator's MCP server (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` §2.4, slice F3).
 *
 * A server of its own, NOT a subset of `createMcpServer` (`src/mcp/server.ts`): it registers exactly the
 * tools in `FACTORY_TOOL_NAMES`, read-only, and everything it can reach arrives through the injected
 * `FactoryToolDeps` -- this file imports no domain module, no YouTube gateway, no database and no
 * channel-scope state. `src/mcp/factory-server.test.ts` fails the suite if the registered tool names
 * differ from that list, if a channel tool name is registered here, if a factory tool name is
 * classified for channel sessions, or if this file imports anything outside its allowlist.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError } from "@/lib/shared-domain";

/**
 * The factory API's own version (independent of the channel agents' `AGENT_API_VERSION`). 1.1.0 (BL-132, ADR 0025): the
 * media tools below -- additive; the four 1.0.0 tools are unchanged.
 */
export const FACTORY_API_VERSION = "1.1.0";

/** The complete, explicit allowlist of tools. A new name must be added here deliberately, with its test. */
export const FACTORY_TOOL_NAMES = [
  "factory_get_capabilities",
  "factory_list_logical_paths",
  "factory_get_logical_path",
  "factory_list_channels",
  // BL-132 (docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md §2.6): models, storage and the template registry.
  "factory_media_storage_status",
  "factory_media_list_models",
  "factory_media_pull_model",
  "factory_media_get_pull",
  "factory_media_cancel_pull",
  "factory_media_delete_model",
  "factory_media_list_templates",
  "factory_media_sync_templates",
] as const;

/**
 * The tools that change something (owner decision D1: no second approval in the Web UI; each is audited with the actor
 * `factory` and passes the device mutation gate first). Everything else in the list is a read. No tool sets a logical
 * path, a workspace or a token, and none starts a session or a job (D4).
 */
export const FACTORY_WRITE_TOOL_NAMES = ["factory_media_pull_model", "factory_media_cancel_pull", "factory_media_delete_model", "factory_media_sync_templates"] as const;

export type FactoryChannelEntry = {
  channelId: string;
  title: string;
  /** This device's production-workspace path for the channel, or `configured:false`. */
  workspace: { configured: false } | { configured: true; path: string };
};

/** Everything the factory tools can reach. Wired in `src/app/api/mcp/factory/route.ts`. */
export type FactoryToolDeps = {
  readLogicalPath(input: unknown): Promise<{ name: string; path: string }>;
  listLogicalPaths(): Promise<
    Array<{ name: string; description: string; configured: false } | { name: string; description: string; configured: true; path: string }>
  >;
  listChannels(): Promise<FactoryChannelEntry[]>;
  /** Counts a real tool invocation for the Settings traffic stats (`mcp_tool_calls`). */
  recordOutcome(outcome: "allowed" | "blocked"): Promise<void>;
  /** BL-132: the media core's factory-facing actions (wired in the route; every write is recorded with actor `factory`). */
  media: {
    storageStatus(): Promise<Record<string, unknown>>;
    listModels(): Promise<Record<string, unknown>>;
    pullModel(input: { repoId: string; file: string; folder: string; revision?: string; sha256: string }): Promise<Record<string, unknown>>;
    getPull(input: { pullId?: string }): Promise<Record<string, unknown>>;
    cancelPull(input: { pullId: string }): Promise<Record<string, unknown>>;
    deleteModel(input: { key: string }): Promise<Record<string, unknown>>;
    listTemplates(): Promise<Record<string, unknown>>;
    syncTemplates(input: { dryRun: boolean }): Promise<Record<string, unknown>>;
  };
  /** The same local gate every mutating channel tool passes (operation lock, recovery mode); throws when not allowed. */
  assertMutationAllowed(): Promise<void>;
};

export type FactoryServerOptions = {
  /** The verified session of THIS request. Absent means "no valid token": ZERO tools are registered. */
  session?: { tokenId: string; reverify(): Promise<void> } | null;
  connectionEnabled?: boolean;
};

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function successResult(payload: Record<string, unknown>): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function errorResult(error: unknown): ToolResponse {
  const shape =
    error instanceof DomainError
      ? { code: error.code, message: error.message, details: error.details }
      : { code: "internal_error", message: "internal error" };
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: shape }) }], isError: true };
}

const emptyInput = z.object({}).strict();
const getLogicalPathInput = z.object({ name: z.string().min(1).max(64) }).strict();
// BL-132 inputs. The media core validates them again (repo id, folder, path safety); these keep the contract explicit.
const pullModelInput = z
  .object({
    repoId: z.string().min(3).max(200),
    file: z.string().min(1).max(500),
    folder: z.string().min(1).max(64),
    revision: z.string().min(1).max(200).optional(),
    /** Required here (owner decision D2): the request carries the expected hash. */
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex characters"),
  })
  .strict();
const pullIdInput = z.object({ pullId: z.string().min(1).max(64) }).strict();
const optionalPullIdInput = z.object({ pullId: z.string().min(1).max(64).optional() }).strict();
const modelKeyInput = z.object({ key: z.string().min(1).max(1000) }).strict();
const syncInput = z.object({ dryRun: z.boolean().optional() }).strict();

function parseInput<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new DomainError({
      code: "validation_failed",
      message: "Invalid MCP tool input",
      details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message, code: issue.code })),
    });
  }
  return parsed.data;
}

export function createFactoryMcpServer(deps: FactoryToolDeps, options: FactoryServerOptions = {}) {
  const connectionEnabled = options.connectionEnabled ?? true;
  const session = options.session ?? null;

  const server = new McpServer({ name: "youtube-operations-manager-factory", version: FACTORY_API_VERSION });

  function registerTool(
    name: (typeof FACTORY_TOOL_NAMES)[number],
    config: { description: string; inputSchema: z.ZodTypeAny },
    handler: (args: unknown) => Promise<ToolResponse>
  ) {
    if (!connectionEnabled || !session) return;
    const counted = async (args: unknown): Promise<ToolResponse> => {
      try {
        await session.reverify();
      } catch (error) {
        await deps.recordOutcome("blocked");
        // Only a real "token not accepted" is reported as an invalid token. A database failure while re-verifying must not
        // tell the role its (perfectly good) token was revoked (same rule as the endpoint's own 503).
        return errorResult(error instanceof DomainError && error.code === "AGENT_TOKEN_INVALID" ? error : new Error("token verification unavailable"));
      }
      await deps.recordOutcome("allowed");
      try {
        return await handler(args);
      } catch (error) {
        return errorResult(error);
      }
    };
    server.registerTool(name, config as never, counted as never);
  }

  registerTool(
    "factory_get_capabilities",
    {
      description:
        "Report this endpoint's factory API version, the tools actually callable by the Factory Operator role, the permissions this token holds (READ and WRITE) and which tools write. Call this first. A local read; no channel scoping, no YouTube call.",
      inputSchema: emptyInput,
    },
    async () =>
      successResult({
        role: "factory_operator",
        factoryApiVersion: FACTORY_API_VERSION,
        tools: [...FACTORY_TOOL_NAMES],
        permissions: ["READ", "WRITE"],
        writeTools: [...FACTORY_WRITE_TOOL_NAMES],
      })
  );

  registerTool(
    "factory_list_logical_paths",
    {
      description:
        "List every logical path defined in this app with THIS computer's value: { name, description, configured, path }. configured:false means no folder is set on this computer (never an empty path). Paths are text only: this app never opens or lists anything inside a folder. Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult({ paths: await deps.listLogicalPaths() })
  );

  registerTool(
    "factory_get_logical_path",
    {
      description:
        "Get one logical path's value on THIS computer by name. Fails with LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE when the path exists but no folder is set on this computer (never returns an empty path), and with LOGICAL_PATH_NOT_FOUND for an unknown name. Read-only: a path can only be set by the operator in the app's Settings.",
      inputSchema: getLogicalPathInput,
    },
    async (args) => {
      const parsed = getLogicalPathInput.safeParse(args);
      if (!parsed.success) {
        throw new DomainError({
          code: "validation_failed",
          message: "Invalid MCP tool input",
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message, code: issue.code })),
        });
      }
      return successResult(await deps.readLogicalPath(parsed.data));
    }
  );

  registerTool(
    "factory_list_channels",
    {
      description:
        "List the channels connected to this app: { channelId, title, workspace } where workspace is this computer's production-workspace folder path for the channel or { configured:false }. Contains no credentials, account identities, videos or analytics. Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult({ channels: await deps.listChannels() })
  );

  // -- BL-132: media models, storage and the template registry (FACTORY_MEDIA_CONTROL_PLAN.md §2.6) ------------------

  registerTool(
    "factory_media_storage_status",
    {
      description:
        "The RunPod network volume that holds the media models: { storage: { volumeId, dataCenterId, sizeGb, usedGb, freeGb, monthlyUsd } } as RunPod reports it (RunPod bills the rented size). Read-only; one RunPod API call.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.storageStatus())
  );

  registerTool(
    "factory_media_list_models",
    {
      description:
        "List the model files on the network volume: { models: [{ key, folder, name, bytes, lastModified, sha256, usedBy: [{ templateId, version, source }] }], registry, registryError }. sha256 is the hash verified by a pull on this computer (null if unknown). usedBy includes local (owner-imported) templates (source 'owner'). Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.listModels())
  );

  registerTool(
    "factory_media_pull_model",
    {
      description:
        "Put one model file from a PUBLIC Hugging Face repository on the network volume: { repoId, file, folder, revision?, sha256 }. sha256 is REQUIRED. Before any pod starts the file is checked on Hugging Face (exists, not gated, its declared SHA-256 equals yours, fits in the free space); then a small CPU pod downloads that exact commit, hashes it and moves it into models/<folder>/ only if the hash matches (otherwise nothing is left). Refused while GPU sessions use the volume (media_session_conflict) or another pull runs; an existing file is never overwritten. Returns { pull } with expectedBytes; track it with factory_media_get_pull. Costs a few cents of CPU time plus storage. Recorded as requested by the Factory Operator.",
      inputSchema: pullModelInput,
    },
    async (args) => {
      const input = parseInput(pullModelInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.pullModel(input));
    }
  );

  registerTool(
    "factory_media_get_pull",
    {
      description:
        "One model pull by pullId ({ pull }), or the recent pulls ({ pulls }) without it. A pull is running, done (sha256 verified), failed (with the reason, e.g. a hash mismatch) or timeout. Read-only.",
      inputSchema: optionalPullIdInput,
    },
    async (args) => successResult(await deps.media.getPull(parseInput(optionalPullIdInput, args)))
  );

  registerTool(
    "factory_media_cancel_pull",
    {
      description: "Cancel a running model pull: { pullId }. Its pod is terminated and nothing is left under models/. Recorded as done by the Factory Operator.",
      inputSchema: pullIdInput,
    },
    async (args) => {
      const input = parseInput(pullIdInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.cancelPull(input));
    }
  );

  registerTool(
    "factory_media_delete_model",
    {
      description:
        "Delete one model file from the network volume: { key } (a models/ key from factory_media_list_models). Refused with media_model_in_use while any template uses it (registry, installed or local), with media_template_registry_unavailable when the template registry cannot be read on this computer, and while sessions or a pull use the volume. There is no undo except pulling it again. Recorded as done by the Factory Operator.",
      inputSchema: modelKeyInput,
    },
    async (args) => {
      const input = parseInput(modelKeyInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.deleteModel(input));
    }
  );

  registerTool(
    "factory_media_list_templates",
    {
      description:
        "List this computer's media workflow templates: { templates: [{ templateId, version, source ('factory' from the registry, 'owner' = local), name, description, parameters, models, modelsMissing, updatedAt }], lastSync }. modelsMissing = declared models not on the volume (null when the volume could not be listed). Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.listTemplates())
  );

  registerTool(
    "factory_media_sync_templates",
    {
      description:
        "Sync this computer's factory templates from the template registry folder (logical path media_templates): { dryRun? }. Returns { result: { outcome, installed, updated, removed, unchanged, pending, invalid } }. A lower version, or the same version with other content, is refused; an unreadable index changes nothing; a listed file not there yet is pending; local templates are never touched. The app also checks the registry by itself every minute. Recorded as done by the Factory Operator.",
      inputSchema: syncInput,
    },
    async (args) => {
      const input = parseInput(syncInput, args);
      if (!input.dryRun) await deps.assertMutationAllowed();
      return successResult(await deps.media.syncTemplates({ dryRun: input.dryRun ?? false }));
    }
  );

  return server;
}
