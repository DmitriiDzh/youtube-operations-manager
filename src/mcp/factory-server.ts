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
import { DomainError, isDomainError } from "@/lib/shared-domain";

/**
 * The factory API's own version (independent of the channel agents' `AGENT_API_VERSION`). 1.1.0 (BL-132, ADR 0025): the
 * media tools; 1.2.0 (BL-133, ADR 0026): GPU sessions within the owner's factory limits, jobs in them, the capacity log;
 * 1.3.0 (FO-REQ-0005): media refusals keep their codes (were `internal_error`), delete/adopt a local template, read the
 * factory settings, `targetName` on a pull -- and a pull now
 * lands under the file's base name by default (before: its repo path); files already on the volume stay where they are;
 * 1.5.0 (BL-143, ADR 0029): generation plans (`factory_plan_*`).
 */
export const FACTORY_API_VERSION = "1.5.0";

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
  // FO-REQ-0005: local templates the factory may remove or take over, and a read of the owner's factory settings.
  "factory_media_delete_template",
  "factory_media_adopt_template",
  "factory_media_get_settings",
  // BL-133 (docs/roadmap/plans/FACTORY_GPU_SESSIONS_PLAN.md §2.2/§2.5): sessions it starts itself, jobs in them, the capacity log.
  "factory_media_start_session",
  "factory_media_get_session",
  "factory_media_stop_session",
  "factory_media_create_job",
  "factory_media_get_job",
  "factory_media_cancel_job",
  "factory_media_capacity_log",
  // BL-143 (ADR 0029): generation plans.
  "factory_plan_create",
  "factory_plan_import",
  "factory_plan_update",
  "factory_plan_close",
  "factory_plan_get",
  "factory_plan_list",
  "factory_plan_todo",
  "factory_plan_report",
] as const;

/**
 * The tools that change something (owner decision D1: no second approval in the Web UI; each is audited with the actor
 * `factory` and passes the device mutation gate first). Everything else in the list is a read. No tool sets a logical
 * path, a workspace or a token. Since BL-133 (ADR 0026) the factory starts GPU sessions -- approved by itself ONLY within
 * the owner's factory limits, otherwise left pending for the owner -- and runs jobs in the sessions it started.
 */
export const FACTORY_WRITE_TOOL_NAMES = [
  "factory_media_pull_model",
  "factory_media_cancel_pull",
  "factory_media_delete_model",
  "factory_media_sync_templates",
  "factory_media_delete_template",
  "factory_media_adopt_template",
  "factory_media_start_session",
  "factory_media_stop_session",
  "factory_media_create_job",
  "factory_media_cancel_job",
  "factory_plan_create",
  "factory_plan_import",
  "factory_plan_update",
  "factory_plan_close",
  "factory_plan_report",
] as const;

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
    pullModel(input: { repoId: string; file: string; folder: string; revision?: string; sha256: string; targetName?: string }): Promise<Record<string, unknown>>;
    getPull(input: { pullId?: string }): Promise<Record<string, unknown>>;
    cancelPull(input: { pullId: string }): Promise<Record<string, unknown>>;
    deleteModel(input: { key: string }): Promise<Record<string, unknown>>;
    listTemplates(): Promise<Record<string, unknown>>;
    syncTemplates(input: { dryRun: boolean }): Promise<Record<string, unknown>>;
    // FO-REQ-0005.
    deleteTemplate(input: { templateId: string }): Promise<Record<string, unknown>>;
    adoptTemplate(input: { templateId: string; newTemplateId: string }): Promise<Record<string, unknown>>;
    getSettings(): Promise<Record<string, unknown>>;
    // BL-133.
    startSession(input: { channelId: string; maxMinutes?: number; maxUsd?: number; templateId?: string; gpu?: { candidates: string[]; minVramGb?: number | null; maxPricePerHr?: number | null }; releaseWhenDone?: boolean }): Promise<Record<string, unknown>>;
    getSession(input: { sessionId?: string }): Promise<Record<string, unknown>>;
    endSession(input: { sessionId: string }): Promise<Record<string, unknown>>;
    createJob(input: { sessionId: string; templateId: string; params: Record<string, string | number | boolean> }): Promise<Record<string, unknown>>;
    getJob(input: { jobId?: string; sessionId?: string }): Promise<Record<string, unknown>>;
    cancelJob(input: { jobId: string }): Promise<Record<string, unknown>>;
    capacityLog(input: { since?: string; gpuTypeId?: string; limit?: number }): Promise<Record<string, unknown>>;
  };
  /** BL-143 (ADR 0029): the generation plans core; it validates every input strictly itself. */
  plans: {
    create(input: unknown): Promise<Record<string, unknown>>;
    importPlan(input: unknown): Promise<Record<string, unknown>>;
    update(input: unknown): Promise<Record<string, unknown>>;
    close(input: unknown): Promise<Record<string, unknown>>;
    get(input: unknown): Promise<Record<string, unknown>>;
    list(input: unknown): Promise<Record<string, unknown>>;
    todo(input: unknown): Promise<Record<string, unknown>>;
    report(input: unknown): Promise<Record<string, unknown>>;
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

/**
 * FO-REQ-0005 item 1: the device mutation gate every write tool passes first throws `OperationLockError` /
 * `RecoveryModeError` -- deliberately not DomainErrors (`src/mcp/server.ts` maps the same two). This file may not import
 * them (§2.5(3) allowlist), so they are recognised by exactly their two documented codes on an `Error` -- never "any
 * object with a string code", which would also echo a raw driver error (SQLITE_BUSY) as if it were a stable code.
 */
const MUTATION_GATE_CODES = new Set(["operation_lock_held", "device_in_recovery_mode"]);

function mutationGateShape(error: unknown): { code: string; message: string; details: unknown } | null {
  if (!(error instanceof Error)) return null;
  const { code, details } = error as Error & { code?: unknown; details?: unknown };
  return typeof code === "string" && MUTATION_GATE_CODES.has(code) ? { code, message: error.message, details } : null;
}

function errorResult(error: unknown, toolName?: string): ToolResponse {
  // `isDomainError`, never `instanceof` (FO-REQ-0005 item 1, the real cause; same fix as 23cab7d for src/mcp/server.ts):
  // the media core lives on globalThis and is first built by the instrumentation bundle, so its errors are another
  // bundle's DomainError class -- `instanceof` failed and every media refusal came back as `internal_error`.
  const known = isDomainError(error) ? { code: error.code, message: error.message, details: error.details } : mutationGateShape(error);
  // An unexpected error is still reported to the role only as `internal_error`, but logged here so it can be diagnosed
  // (FO-REQ-0005: one such answer left no trace at all).
  if (!known) console.error(`[factory-mcp] ${toolName ?? "tool"} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  const shape = known ?? { code: "internal_error", message: "internal error" };
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
    /** FO-REQ-0005: the file name under models/<folder>/ (default: the base name of `file`). */
    targetName: z.string().min(1).max(200).optional(),
    /** Required here (owner decision D2): the request carries the expected hash. */
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex characters"),
  })
  .strict();
const pullIdInput = z.object({ pullId: z.string().min(1).max(64) }).strict();
const optionalPullIdInput = z.object({ pullId: z.string().min(1).max(64).optional() }).strict();
const modelKeyInput = z.object({ key: z.string().min(1).max(1000) }).strict();
const syncInput = z.object({ dryRun: z.boolean().optional() }).strict();
const templateIdInput = z.object({ templateId: z.string().min(1).max(64) }).strict();
const adoptTemplateInput = z.object({ templateId: z.string().min(1).max(64), newTemplateId: z.string().min(2).max(63) }).strict();
// BL-133 inputs (the media core validates again).
const gpuPlanInput = z
  .object({
    candidates: z.array(z.string().min(1).max(128)).min(1).max(10),
    minVramGb: z.number().int().min(1).max(1024).nullable().optional(),
    maxPricePerHr: z.number().gt(0).max(1000).nullable().optional(),
  })
  .strict();
const startSessionInput = z
  .object({
    channelId: z.string().min(1).max(64),
    maxMinutes: z.number().int().min(1).max(1440).optional(),
    maxUsd: z.number().gt(0).max(10_000).optional(),
    templateId: z.string().min(1).max(64).optional(),
    gpu: gpuPlanInput.optional(),
    releaseWhenDone: z.boolean().optional(),
  })
  .strict();
const sessionIdInput = z.object({ sessionId: z.string().min(1).max(64) }).strict();
const optionalSessionIdInput = z.object({ sessionId: z.string().min(1).max(64).optional() }).strict();
const createJobInput = z
  .object({
    sessionId: z.string().min(1).max(64),
    templateId: z.string().min(1).max(64),
    params: z.record(z.string().min(1).max(64), z.union([z.string().max(20_000), z.number(), z.boolean()])).default({}),
  })
  .strict();
const getJobInput = z.object({ jobId: z.string().min(1).max(64).optional(), sessionId: z.string().min(1).max(64).optional() }).strict();
const jobIdInput = z.object({ jobId: z.string().min(1).max(64) }).strict();
const capacityLogInput = z
  .object({ since: z.string().datetime().optional(), gpuTypeId: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(500).optional() })
  .strict();

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
        return errorResult(isDomainError(error) && error.code === "AGENT_TOKEN_INVALID" ? error : new Error("token verification unavailable"));
      }
      await deps.recordOutcome("allowed");
      try {
        return await handler(args);
      } catch (error) {
        return errorResult(error, name);
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
        "Put one model file from a PUBLIC Hugging Face repository on the network volume: { repoId, file, folder, revision?, sha256, targetName? }. sha256 is REQUIRED. The file lands at models/<folder>/<targetName>; targetName defaults to the base name of file (the repo's sub-folders are dropped: file 'split_files/vae/x.safetensors' with folder 'vae' -> models/vae/x.safetensors). Give targetName (one file name: letters, digits, '.', '_', '+', '-') when that key is taken, e.g. two repos' model.safetensors. Before any pod starts the file is checked on Hugging Face (exists, not gated, its declared SHA-256 equals yours, fits in the free space); then a small CPU pod downloads that exact commit, hashes it and moves it into place only if the hash matches (otherwise nothing is left). Refused while GPU sessions use the volume (media_session_conflict) or another pull runs; an existing file is never overwritten. Returns { pull } with expectedBytes; track it with factory_media_get_pull. Costs a few cents of CPU time plus storage. Recorded as requested by the Factory Operator.",
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
        "Sync this computer's factory templates from the template registry folder (logical path media_templates): { dryRun? }. Returns { result: { outcome, installed, updated, removed, unchanged, pending, invalid } }. A lower version, or the same version with other content, is refused; an unreadable index changes nothing; a listed file not there yet is pending; local templates are never touched, except one you adopted (factory_media_adopt_template), which is removed once its registry template is installed. The app also checks the registry by itself every minute. Recorded as done by the Factory Operator.",
      inputSchema: syncInput,
    },
    async (args) => {
      const input = parseInput(syncInput, args);
      if (!input.dryRun) await deps.assertMutationAllowed();
      return successResult(await deps.media.syncTemplates({ dryRun: input.dryRun ?? false }));
    }
  );

  // -- FO-REQ-0005: local (owner-imported) templates, and the owner's factory settings ----------------------------------

  registerTool(
    "factory_media_delete_template",
    {
      description:
        "Delete one LOCAL (owner-imported, source 'owner') workflow template from this computer: { templateId } -> { deleted: true }. Agree it with the owner in chat first; there is no second approval and no undo. A registry template (source 'factory') is refused (media_template_invalid): remove it from the registry index instead. Unknown id -> media_template_not_found. Its models are then no longer 'usedBy' it. Recorded as done by the Factory Operator (Web UI: Production → Models, recent actions).",
      inputSchema: templateIdInput,
    },
    async (args) => {
      const input = parseInput(templateIdInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.deleteTemplate(input));
    }
  );

  registerTool(
    "factory_media_adopt_template",
    {
      description:
        "Take a LOCAL template over into the template registry: { templateId (the local one), newTemplateId (registry id: 2-63 lower-case letters, digits, '-') } -> { localTemplateId, templateId, fileName, indexEntry, template, status }. Nothing is written to the registry by the app: write `template` exactly as <registry>/<fileName> (version 1; models declared from the graph's loader nodes, sha256 not set -- add it if you want it checked) and add indexEntry to index.json. status 'pending': the local copy stays (and keeps protecting its models) until a sync installs newTemplateId, then it is removed. status 'adopted': newTemplateId was already installed with the same graph and parameters, the local copy is removed now. The local copy is only ever removed when the installed registry template has the same graph and parameters; an id already installed with other content is refused (media_template_invalid), and a sync that finds other content under the id keeps the local copy and lists it under invalid. A template that would not pass the registry checks as it is (e.g. a free-text model parameter) is refused with media_template_invalid, details.problems and details.template. Calling it again returns the same file. Agree it with the owner first; recorded as done by the Factory Operator.",
      inputSchema: adoptTemplateInput,
    },
    async (args) => {
      const input = parseInput(adoptTemplateInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.adoptTemplate(input));
    }
  );

  registerTool(
    "factory_media_get_settings",
    {
      description:
        "Read the owner's factory settings (Production → Setup) without a session: { settings: { factorySessionsEnabled, limits: { maxUsdPerSession, maxMinutesPerSession, maxUsdPerDay, maxUsdPerMonth }, spentOrReservedUsd: { today, thisMonth } (your sessions' spend plus what open ones may still spend up to their caps -- what a start is checked against), device: { maxUsdPerDay, spentTodayUsd (this computer only; a start also counts other computers on the same RunPod account), maxConcurrentSessions, idleMinutes }, gpu: { gpuTypeId, fallbackIds, minVramGb, maxPricePerHr, onDemandPricePerHr, cloudType }, capacity: { retrySeconds, waitMinutes } } }. Days and months are this computer's local calendar. No secrets. Read-only, no RunPod call.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.getSettings())
  );

  // -- BL-133: GPU sessions within the owner's factory limits, jobs in them, the capacity log ---------------------------

  registerTool(
    "factory_media_start_session",
    {
      description:
        "Start a GPU session yourself: { channelId (the connected channel whose workspace receives the outputs), maxMinutes?, maxUsd? (both default to the owner's factory per-session limits), templateId? (use that registry template's GPU list) | gpu? { candidates: [GPU type ids in order], minVramGb?, maxPricePerHr? }, releaseWhenDone? }. Within ALL of the owner's factory limits (the switch, per session, the factory's day and month) and the device's own limits, it is approved by you and the pod starts at once -> { session, approved: true }. Otherwise it is created pending for the owner -> { session, approved: false, heldBy: which limit }. GPUs are tried in order in the volume's datacenter; if none can be placed the session waits as waiting_capacity (no pod, no cost) and is retried every 30 s until the owner's wait limit, then fails with media_no_capacity. Poll factory_media_get_session.",
      inputSchema: startSessionInput,
    },
    async (args) => {
      const input = parseInput(startSessionInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.startSession(input));
    }
  );

  registerTool(
    "factory_media_get_session",
    {
      description:
        "One of YOUR sessions by sessionId ({ session }: status pending|approved|waiting_capacity|starting|running|stopping|done|failed|rejected|interrupted, approvedBy, gpuTypeId it got, costPerHr, capacity { attempts, nextAttemptAt, waitUntil }, usdCharged, error), or your recent sessions ({ sessions }). Sessions you did not start are not visible. Read-only.",
      inputSchema: optionalSessionIdInput,
    },
    async (args) => successResult(await deps.media.getSession(parseInput(optionalSessionIdInput, args)))
  );

  registerTool(
    "factory_media_stop_session",
    {
      description: "End a session YOU started: { sessionId }. A pending one is withdrawn, a waiting one ends at no cost, a starting/running pod is terminated. Stop as soon as your jobs are done.",
      inputSchema: sessionIdInput,
    },
    async (args) => {
      const input = parseInput(sessionIdInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.endSession(input));
    }
  );

  registerTool(
    "factory_media_create_job",
    {
      description:
        "Submit a generation job to one of YOUR running sessions: { sessionId, templateId, params }. The same contract as the channel agents' agent_create_media_job (parameters validated first; image/audio/video inputs are paths relative to the session channel's 99 Data Exchange/Sent to YTM/; outputs and manifest.json land in that channel's From YTM/media/<jobId>/). Poll factory_media_get_job.",
      inputSchema: createJobInput,
    },
    async (args) => {
      const input = parseInput(createJobInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.createJob(input));
    }
  );

  registerTool(
    "factory_media_get_job",
    {
      description: "One job of YOUR sessions by jobId ({ job }), or the jobs of one of your sessions ({ jobs }, sessionId required then). Same job shape as the channel tools, including the live `progress` from ComfyUI while a job generates (BL-144). Read-only.",
      inputSchema: getJobInput,
    },
    async (args) => successResult(await deps.media.getJob(parseInput(getJobInput, args)))
  );

  registerTool(
    "factory_media_cancel_job",
    {
      description: "Cancel a queued or generating job of YOUR sessions: { jobId }. Never stops the session.",
      inputSchema: jobIdInput,
    },
    async (args) => {
      const input = parseInput(jobIdInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.cancelJob(input));
    }
  );

  registerTool(
    "factory_media_capacity_log",
    {
      description:
        "Every pod start attempt on this computer, newest first: { attempts: [{ at, sessionId, datacenterId, gpuTypeId, pricePerHr, result: placed|no_capacity|error, detail }] } -- { since? (ISO time), gpuTypeId?, limit? (default 100, max 500) }. Kept 90 days. Use it to judge whether a GPU is usually available. Read-only.",
      inputSchema: capacityLogInput,
    },
    async (args) => successResult(await deps.media.capacityLog(parseInput(capacityLogInput, args)))
  );

  // -- BL-143 (ADR 0029): generation plans. The plans core validates every field strictly (bounds, patterns); the schemas
  // here only name the top-level fields. Writes pass the device mutation gate and are recorded as done by the factory.

  const planWrite = (name: (typeof FACTORY_TOOL_NAMES)[number], description: string, schema: z.ZodTypeAny, call: (input: unknown) => Promise<Record<string, unknown>>) =>
    registerTool(name, { description, inputSchema: schema }, async (args) => {
      const input = parseInput(schema, args);
      await deps.assertMutationAllowed();
      return successResult(await call(input));
    });
  const planRead = (name: (typeof FACTORY_TOOL_NAMES)[number], description: string, schema: z.ZodTypeAny, call: (input: unknown) => Promise<Record<string, unknown>>) =>
    registerTool(name, { description, inputSchema: schema }, async (args) => successResult(await call(parseInput(schema, args))));

  const loose = z.array(z.object({}).passthrough());
  planWrite(
    "factory_plan_create",
    "Create a generation plan on this computer: { planId (2-80 letters, digits, '.', '_', '-'; yours, unique here), title, channelId (a connected channel; its workspace gets the outputs), budget?: { usd?, gpuMinutes? } (a warning only), note?, stages: [{ stageId, title, kind: in_app | external | owner_review }] (at most one in_app -- fed by the plan's jobs -- and one owner_review), groups?: [{ groupId, title?, dependsOn?, note? }] (waves), items?: [{ itemKey, groupId?, templateId?, templateLabel?, variant?, targetCount, mode?: fixed | until_accepted, maxAttempts?, params? (job params as in create_job), seeds? }] } -> { plan, progress }. Errors: plan_invalid (id taken, unknown channel, duplicate ids, unknown group), validation_failed.",
    z.object({ planId: z.string(), title: z.string(), channelId: z.string(), budget: z.object({}).passthrough().optional(), note: z.string().nullable().optional(), stages: loose, groups: loose.optional(), items: loose.optional() }).strict(),
    (input) => deps.plans.create(input)
  );
  planWrite(
    "factory_plan_import",
    "Import a plan file in the ytm-generation-plan/1 format: { plan: <the file's JSON object> } -> { plan, progress, linkedJobs, importedResults }. Item templateId strings are kept as labels (templateLabel). A generate result 'job:<id>' naming a job of this channel that is in no plan is linked to the plan (its live state then counts); other attempts are kept as imported rows. The planId must be new here.",
    z.object({ plan: z.object({}).passthrough() }).strict(),
    (input) => deps.plans.importPlan(input)
  );
  planWrite(
    "factory_plan_update",
    "Change an active plan: { planId, title?, note?, budget?, addStages?, upsertGroups? (an existing groupId is replaced), upsertItems? (an existing itemKey is replaced; its attempts stay), removeStageIds?, removeGroupIds?, removeItemKeys? } -> { plan, progress }. A stage or item with attempts or results cannot be removed; a group with items cannot be removed (plan_invalid).",
    z
      .object({
        planId: z.string(),
        title: z.string().optional(),
        note: z.string().nullable().optional(),
        budget: z.object({}).passthrough().optional(),
        addStages: loose.optional(),
        upsertGroups: loose.optional(),
        upsertItems: loose.optional(),
        removeStageIds: z.array(z.string()).optional(),
        removeGroupIds: z.array(z.string()).optional(),
        removeItemKeys: z.array(z.string()).optional(),
      })
      .strict(),
    (input) => deps.plans.update(input)
  );
  planWrite(
    "factory_plan_close",
    "Close a plan: { planId, status: completed | cancelled, note? } -> { plan, progress }. Only the status changes: running jobs, sessions and files are not touched (cancel jobs with factory_media_cancel_job). A closed plan refuses every change (plan_closed).",
    z.object({ planId: z.string(), status: z.string(), note: z.string().nullable().optional() }).strict(),
    (input) => deps.plans.close(input)
  );
  planRead(
    "factory_plan_get",
    "One plan with its derived progress and events: { planId, since? (ISO time: only events after it) } -> { plan, progress: { stages: [counts planned/queued/running/done/failed/interrupted/cancelled/accepted/rejected], groups, items (attempts, generated, accepted, rejected, open, waitingReview, missing), spend: { usd, gpuMinutes, sessions }, budget: { usd, usedShare, warnings: ['80'|'100'] }, eta: { seconds, gpuTypeId, samples } }, events: [{ at, kind, actor, details }], cursor }. Events: job_created/done/failed/interrupted/cancelled, session_started/ready/stopped (stopReason), result_reported, owner_verdict (rating, reasons, markers, note), group_note, rerun_requested, plan_*. Pass the returned cursor as since next time. In-app counts are read from the jobs themselves. Read-only.",
    z.object({ planId: z.string(), since: z.string().optional() }).strict(),
    (input) => deps.plans.get(input)
  );
  planRead(
    "factory_plan_list",
    "This computer's plans with their progress: { status?: active | completed | cancelled, channelId? } -> { plans: [{ plan, progress }] }. Read-only.",
    z.object({ status: z.string().optional(), channelId: z.string().optional() }).strict(),
    (input) => deps.plans.list(input)
  );
  planRead(
    "factory_plan_todo",
    "What is left in a plan: { planId } -> { short: [{ itemKey, groupId, missing, mode }] (attempts still needed), waitingReview: [{ itemKey, attemptRef }] (passed the stage before owner review, no verdict yet), rerun: [{ itemKey, attemptRef, state: failed | interrupted }] (only while the item is short) }. Read-only.",
    z.object({ planId: z.string() }).strict(),
    (input) => deps.plans.todo(input)
  );
  planWrite(
    "factory_plan_report",
    "Report results of external stages (post-process, validator) or a verdict you relay from chat, in bulk: { planId, rows: [{ stageId (not the in_app stage), itemKey, attemptRef ('job:<jobId>' of the generate job), result: done | failed | accepted | rejected, note? (<= 2000), auditionFile? (the file the owner should hear: a path relative to the channel workspace's '99 Data Exchange/Sent to YTM/'), checks?: [{ id, label?, value?, unit?, threshold?, pass, severity: info | warn | fail, atSeconds?: [start, end], detail? (<= 200) }] (<= 50), metrics? (<= 50 keys), rating? (1-10), reasons?, markers?: [{ start, end?, note? }] }] (<= 200 rows) } -> { stored }. One row per (plan, stage, item, attempt): a repeat replaces it. All rows are checked first; one bad row stores nothing (plan_mismatch / validation_failed). Recorded as reported by the factory.",
    z.object({ planId: z.string(), rows: loose }).strict(),
    (input) => deps.plans.report(input)
  );

  return server;
}
