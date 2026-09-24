#!/usr/bin/env node

import { loadEnvConfig } from "@next/env";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { DeviceAuthorizationStart } from "@/lib/auth";
import { createVideoMetadataCore } from "@/lib/video-metadata";
import { DomainError } from "@/lib/video-metadata/contracts";
import type { VideoMetadataCore } from "@/lib/video-metadata";
import { createPlaylistManagementCore, type PlaylistManagementCore } from "@/lib/playlist-management";
import { createCliAuthService } from "@/lib/cli-auth/service";
import type { CredentialRef } from "@/lib/video-metadata/contracts";
import { rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation, RecoveryModeError } from "@/lib/device-handoff";
import { OperationLockError } from "@/lib/operation-lock";
import { createChangeSetCore, type ChangeSetCore } from "@/lib/changesets";
import { createBatchCore, type BatchCore } from "@/lib/batches";
import { createChannelSyncCore, type ChannelSyncCore } from "@/lib/channel-sync";
import { createChannelAccessCore, type ChannelAccessCore } from "@/lib/channel-access";
import { createAnalyticsCore, type AnalyticsCore } from "@/lib/analytics";
import { createAiLocalizationCore, type AiLocalizationCore } from "@/lib/ai-localization";
import { createAgentOperationsCore, type AgentOperationsCore } from "@/lib/agent-operations";

// CLI parity for the read/propose/create MCP tools (docs/roadmap/plans/PHASE_7_PLAN.md,
// docs/TECHNICAL_DEBT.md RISK-04) -- same core factories, same "smallest safe slice" as
// src/mcp/server.ts, never a parallel implementation (AGENTS.md §D).
type ChangesetCliCoreSubset = Pick<
  ChangeSetCore,
  "listChangeSets" | "getChangeSet" | "previewImport" | "createChangeSetFromImport"
>;
type BatchCliCoreSubset = Pick<BatchCore, "listBatchesByChannel" | "requireBatchForChannel" | "listLedgerRows">;
type ChannelSyncCliCoreSubset = Pick<ChannelSyncCore, "syncChannel" | "listChannels" | "listSyncedVideos">;
// CLI parity for the MCP analytics_list/analytics_overview tools (same "machine-readable
// analytics for operational agents" follow-up, docs/roadmap/BACKLOG.md).
type AnalyticsCliCoreSubset = Pick<
  AnalyticsCore,
  | "listMetrics"
  | "getChannelOverview"
  | "getDataQualityReport"
  | "getComparableAgeComparison"
  | "listWeeklyReports"
  | "getWeeklyReport"
>;
// CLI parity for the MCP ai_localization_generate/ai_localization_create_change_set tools
// (BL-075/BL-078, docs/roadmap/BACKLOG.md) -- same two existing service functions the Web UI's
// own ai-localization routes already call, never a parallel implementation.
type AiLocalizationCliCoreSubset = Pick<AiLocalizationCore, "generateProposals" | "createChangeSetFromGeneration">;
// Phase 7 (Agent Operations Interface) -- CLI parity for the MCP agent_get_capabilities tool.
type AgentOperationsCliCoreSubset = Pick<
  AgentOperationsCore,
  "getSystemCapabilities" | "getChannelContext" | "getVideoContext" | "queryChannelAnalytics" | "queryVideoAnalytics"
>;

loadEnvConfig(process.cwd());

type CliAuthAdapter = {
  login(args?: { timeoutMs?: number }): Promise<unknown>;
  loginDevice(args?: { onPending?: (data: DeviceAuthorizationStart) => void }): Promise<unknown>;
  whoami(): Promise<unknown>;
  listKnownWriteChannels(args?: { credentialRef?: CredentialRef }): Promise<unknown>;
  selectWriteChannel(args: { channelId: string; credentialRef?: CredentialRef }): Promise<unknown>;
  listUsers(): Promise<unknown>;
  selectUser(args: { userId: string }): Promise<unknown>;
  logout(): Promise<unknown>;
  revoke(args?: { userId?: string }): Promise<unknown>;
  resolveEffectiveCredentialRef(args: { explicit?: CredentialRef }): Promise<CredentialRef>;
};

export type ParsedArgs = {
  namespace: "metadata" | "auth" | "playlist" | "changeset" | "batch" | "channel" | "analytics" | "ai-localization" | "agent";
  command:
    | "list"
    | "transcript"
    | "preview"
    | "apply"
    | "create"
    | "update"
    | "delete"
    | "add"
    | "remove"
    | "login"
    | "whoami"
    | "list-channels"
    | "select-channel"
    | "list-users"
    | "select-user"
    | "logout"
    | "revoke"
    | "get"
    | "import"
    | "sync"
    | "video-list"
    | "overview"
    | "data-quality"
    | "comparable-age"
    | "weekly-reports"
    | "weekly-report-get"
    | "generate"
    | "create-change-set"
    | "capabilities"
    | "channel-context"
    | "video-context"
    | "channel-analytics"
    | "video-analytics";
  flags: Record<string, string | boolean>;
};

const EXPLICIT_NAMESPACES = ["auth", "playlist", "changeset", "batch", "channel", "analytics", "ai-localization", "agent"] as const;
type ExplicitNamespace = (typeof EXPLICIT_NAMESPACES)[number];

export function parseArgs(argv: string[]): ParsedArgs {
  const [namespaceRaw, maybeCommandRaw, ...remaining] = argv;
  const explicitNamespace = EXPLICIT_NAMESPACES.find((n) => n === namespaceRaw) as
    | ExplicitNamespace
    | undefined;
  const hasExplicitNamespace = explicitNamespace !== undefined;
  const commandRaw = hasExplicitNamespace ? maybeCommandRaw : namespaceRaw;
  const flagTokens = hasExplicitNamespace
    ? remaining
    : [maybeCommandRaw, ...remaining].filter(Boolean);

  const validCommandsByNamespace: Record<ExplicitNamespace, string[]> = {
    auth: ["login", "whoami", "list-channels", "select-channel", "list-users", "select-user", "logout", "revoke"],
    playlist: ["list", "create", "update", "delete", "add", "remove"],
    changeset: ["list", "get", "preview", "import"],
    batch: ["list", "get"],
    channel: ["sync", "list", "video-list"],
    analytics: ["list", "overview", "data-quality", "comparable-age", "weekly-reports", "weekly-report-get"],
    "ai-localization": ["generate", "create-change-set"],
    agent: ["capabilities", "channel-context", "video-context", "channel-analytics", "video-analytics"],
  };
  const validMetadataCommands = ["list", "transcript", "preview", "apply"];
  const validCommands = hasExplicitNamespace
    ? validCommandsByNamespace[explicitNamespace]
    : validMetadataCommands;

  if (!commandRaw || !validCommands.includes(commandRaw)) {
    throw new DomainError({
      code: "validation_failed",
      message: hasExplicitNamespace
        ? `${explicitNamespace} command must be one of: ${validCommands.join(", ")}`
        : "Command must be one of: list, transcript, preview, apply",
    });
  }

  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < flagTokens.length; i += 1) {
    const token = flagTokens[i];
    if (!token.startsWith("--")) {
      throw new DomainError({
        code: "validation_failed",
        message: `Invalid argument token: ${token}`,
      });
    }

    const key = token.slice(2);
    const nextValue = flagTokens[i + 1];

    if (!nextValue || nextValue.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = nextValue;
    i += 1;
  }

  return {
    namespace: explicitNamespace ?? "metadata",
    command: commandRaw as ParsedArgs["command"],
    flags,
  };
}

function parseVideoIdsFlag(flags: Record<string, string | boolean>) {
  const rawVideoIds = requiredStringFlag(flags, "videoIds");
  const ids = rawVideoIds
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new DomainError({
      code: "validation_failed",
      message: "Missing required --videoIds",
    });
  }

  return ids;
}

export function getCredentialRef(flags: Record<string, string | boolean>): CredentialRef | null {
  // Found by independent review (cycle 3): this function feeds resolveEffectiveCredentialRef,
  // the shared path for nearly every non-auth command -- a valueless --userId here used to
  // fall through to `null` exactly like a truly OMITTED --userId, silently resolving to
  // whatever user is currently active locally instead of erroring on the operator's typo.
  // optionalStringFlag distinguishes "absent" (null return, fallback is correct) from
  // "present but not a real string" (throws), which the earlier plain typeof check couldn't.
  const userId = optionalStringFlag(flags, "userId");
  if (userId !== undefined) {
    return { userId };
  }

  const accessToken = optionalStringFlag(flags, "accessToken");
  if (accessToken !== undefined) {
    const tokenExpiryFlag = optionalStringFlag(flags, "tokenExpiry");
    return {
      accessToken,
      refreshToken: optionalStringFlag(flags, "refreshToken"),
      scope: optionalStringFlag(flags, "scope"),
      tokenExpiry: tokenExpiryFlag === undefined ? undefined : Number(tokenExpiryFlag),
    };
  }

  return null;
}

/**
 * RISK-12 fix (2026-09-18): `--dryRun` used to be read as `flags.dryRun === true`,
 * which sent an EXPLICIT `dryRun: false` to `applyMetadata` whenever the flag was
 * simply omitted (the CLI's own default was live, independent of and unprotected by
 * `applyMetadataInputSchema`'s own default, since an explicit `false` always overrides
 * a schema default). Now: omitting `--dryRun` entirely omits the field from the
 * request, so the schema's own safe default (`true`, a preview) applies; `--dryRun`
 * alone means `true` (preview); `--dryRun false` is the only way to request a real
 * write, an explicit, deliberate flag value rather than an accidental default.
 */
export function resolveDryRunFlag(flags: Record<string, string | boolean>): boolean | undefined {
  const raw = flags.dryRun;
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  if (raw.toLowerCase() === "false") return false;
  return true;
}

async function readWorkbookFileFlag(
  flags: Record<string, string | boolean>
): Promise<{ filename: string; buffer: Buffer }> {
  const filePath = requiredStringFlag(flags, "file");
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    throw new DomainError({
      code: "validation_failed",
      message: `Could not read --file ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`,
    });
  }
  return { filename: basename(filePath), buffer };
}

// Shared core for requiredStringFlag/optionalStringFlag below: a flag that IS present must
// carry a real string value -- a present-but-valueless flag (parseArgs sets it to boolean
// `true` when no value token follows, e.g. a typo like `--channelId --userId u1`) is always a
// malformed input, never silently equivalent to "omitted". Whether *absence itself* is an
// error is the one thing that differs between the two exported functions below.
function readStringFlag(
  flags: Record<string, string | boolean>,
  key: string
): string | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;

  throw new DomainError({
    code: "validation_failed",
    message: `--${key} requires a value`,
  });
}

export function requiredStringFlag(
  flags: Record<string, string | boolean>,
  key: string
): string {
  const value = readStringFlag(flags, key);
  if (value !== undefined) return value;

  throw new DomainError({
    code: "validation_failed",
    message: `Missing required --${key}`,
  });
}

export function optionalStringFlag(
  flags: Record<string, string | boolean>,
  key: string
): string | undefined {
  return readStringFlag(flags, key);
}

// Read-only per docs/DEVELOPMENT_PLAYBOOK.md §6.7's three-way classification: returns data or
// switches which locally active identity/channel is used for future *read* resolution, but
// mutates no YouTube state and no local record other than "which existing option is active."
// `select-channel`/`select-user` are intentionally excluded (they persist a local-mutation
// side effect, matching §6.7's "a local-approval tool is a mutation" rule) -- and are gated,
// consistent with how the same two write_channel_select/auth_user_select MCP tools are
// classified as local-state mutations, not reads, in src/mcp/server.ts.
const READ_ONLY_CLI_COMMANDS: ReadonlySet<ParsedArgs["command"]> = new Set([
  "list",
  "transcript",
  "preview",
  "whoami",
  "list-channels",
  "list-users",
  // changeset get / batch get (read a single record); channel video-list (read synced
  // videos). "sync" and "import" are deliberately NOT here -- both mutate local state
  // (channels/videos, or changesets/changes respectively) and stay gated by the default
  // (anything not explicitly listed here or in AUTH_SESSION_EXEMPT_CLI_COMMANDS is gated).
  "get",
  "video-list",
  // analytics list (local read of already-collected rows) / analytics overview (a live
  // Analytics API read, but mutates nothing anywhere -- same read-only classification as
  // playlist_list's own live YouTube read in the MCP server) / analytics data-quality (local
  // read over analytics_collection_runs) / analytics comparable-age (local read over
  // video_metrics_daily, aligned by days-since-publish) / analytics weekly-reports,
  // weekly-report-get (local reads over analytics_weekly_reports -- generation stays
  // Web-UI-triggered only, no CLI/MCP command creates a snapshot).
  "overview",
  "data-quality",
  "comparable-age",
  "weekly-reports",
  "weekly-report-get",
  // ai-localization generate: persists nothing (mirrors "preview"'s own classification above --
  // the mock provider makes no network call at all; a real-connection call is gated by the
  // service's own internal device-availability check, RISK-30, not by this CLI gate).
  // "create-change-set" is deliberately NOT here -- it persists a new Change Set.
  "generate",
  // agent capabilities: a pure local read (instance metadata + a static capability list).
  // agent channel-context/video-context (slice B): both read only already-synced local data,
  // mutate nothing -- same classification as "get"/"video-list" above.
  "capabilities",
  "channel-context",
  "video-context",
  // agent channel-analytics: a live YouTube Analytics API read (like "analytics overview"), but
  // mutates no local state. agent video-analytics: a local read only (like "analytics list").
  // Neither persists anything -- same classification as their wrapped tools above.
  "channel-analytics",
  "video-analytics",
]);

// OAuth session establishment/removal -- mirrors src/proxy.ts's unconditional exemption of
// `/api/auth/**` (NextAuth's own route): decision 6 (docs/decisions/0002-...) keeps this
// device's own OAuth session independent of the handoff/recovery-mode gate. These DO mutate
// local state (the `users` row), so they are deliberately not on READ_ONLY_CLI_COMMANDS above --
// they are exempt from the gate for a different reason. Found by independent review that an
// earlier version of this file gated these while proxy.ts exempted the equivalent Web path,
// an undocumented, unintended divergence between interfaces for the identical operation.
const AUTH_SESSION_EXEMPT_CLI_COMMANDS: ReadonlySet<ParsedArgs["command"]> = new Set([
  "login",
  "logout",
  "revoke",
]);

function serializeSuccess(data: unknown) {
  return JSON.stringify({ ok: true, data });
}

function serializeEvent(event: string, data: unknown) {
  return JSON.stringify({ ok: true, event, data });
}

function serializeError(error: unknown) {
  if (error instanceof DomainError) {
    return JSON.stringify({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }

  // OperationLockError / RecoveryModeError (src/lib/operation-lock, src/lib/device-handoff)
  // carry the same stable {code, message, details} shape as DomainError without being an
  // instance of it (a different module's own error class, on purpose -- AGENTS.md §D, they
  // are not YouTube-write-safety domain errors). Checked by explicit `instanceof` against
  // exactly these two known classes -- NOT "any object with a string .code property", which
  // would also match a raw libsql driver error (e.g. SQLITE_BUSY) or a Node `fs` error (e.g.
  // ENOENT/EACCES with a real local file path in its message) and echo its internal detail as
  // if it were a stable, documented error code (found by independent review).
  if (error instanceof OperationLockError || error instanceof RecoveryModeError) {
    return JSON.stringify({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    });
  }

  return JSON.stringify({
    ok: false,
    error: {
      code: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error",
    },
  });
}

export async function runCliCommand(args: {
  argv: string[];
  core?: Pick<
    VideoMetadataCore & PlaylistManagementCore,
    "listVideos" | "getTranscript" | "previewMetadata" | "applyMetadata"
    | "listPlaylists"
    | "createPlaylist"
    | "updatePlaylist"
    | "deletePlaylist"
    | "addVideosToPlaylist"
    | "removeVideosFromPlaylist"
  >;
  auth?: CliAuthAdapter;
  operationsCore?: ChangesetCliCoreSubset & BatchCliCoreSubset;
  channelSyncCore?: ChannelSyncCliCoreSubset;
  channelAccessCore?: ChannelAccessCore;
  analyticsCore?: AnalyticsCliCoreSubset;
  aiLocalizationCore?: AiLocalizationCliCoreSubset;
  agentOperationsCore?: AgentOperationsCliCoreSubset;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}): Promise<number> {
  const core = args.core ?? {
    ...createVideoMetadataCore(),
    ...createPlaylistManagementCore(),
  };
  const auth = args.auth ?? createCliAuthService();
  const operationsCore = args.operationsCore ?? { ...createChangeSetCore(), ...createBatchCore() };
  const channelSyncCore = args.channelSyncCore ?? createChannelSyncCore();
  const channelAccessCore = args.channelAccessCore ?? createChannelAccessCore();
  const analyticsCore = args.analyticsCore ?? createAnalyticsCore();
  const aiLocalizationCore = args.aiLocalizationCore ?? createAiLocalizationCore();
  const agentOperationsCore = args.agentOperationsCore ?? createAgentOperationsCore();
  const writeStdout =
    args.writeStdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeStderr =
    args.writeStderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  try {
    const parsedArgs = parseArgs(args.argv);

    // Decision 7 (docs/decisions/0002-additive-schema-versioning.md's companion plan): a
    // single choke point, mirroring src/proxy.ts's and MCP's, gating every mutating command
    // (everything except the plainly read-only ones below) behind the local operation lock and
    // the device-handoff recovery-mode check -- never bypassable by calling the CLI directly.
    if (
      !READ_ONLY_CLI_COMMANDS.has(parsedArgs.command) &&
      !AUTH_SESSION_EXEMPT_CLI_COMMANDS.has(parsedArgs.command)
    ) {
      await assertDeviceAvailableForMutation(rawSqlClient);
    }

    if (parsedArgs.namespace === "auth") {
      if (parsedArgs.command === "login") {
        const result =
          parsedArgs.flags.device === true
            ? await auth.loginDevice({
                onPending: (data) => writeStderr(serializeEvent("auth_pending", data)),
              })
            : await auth.login();
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "whoami") {
        const result = await auth.whoami();
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "list-channels") {
        const credentialRef = getCredentialRef(parsedArgs.flags) ?? undefined;
        const result = await auth.listKnownWriteChannels({ credentialRef });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "select-channel") {
        const credentialRef = getCredentialRef(parsedArgs.flags) ?? undefined;
        const channelId = requiredStringFlag(parsedArgs.flags, "channelId");
        const result = await auth.selectWriteChannel({ channelId, credentialRef });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "list-users") {
        const result = await auth.listUsers();
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "select-user") {
        const result = await auth.selectUser({
          userId: requiredStringFlag(parsedArgs.flags, "userId"),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "logout") {
        const result = await auth.logout();
        writeStdout(serializeSuccess(result));
        return 0;
      }

      const result = await auth.revoke({ userId: optionalStringFlag(parsedArgs.flags, "userId") });
      writeStdout(serializeSuccess(result));
      return 0;
    }

    // changeset/batch operate on the local database only -- no YouTube credential needed,
    // so these two namespaces are dispatched before credentialRef resolution below. They
    // still resolve the local active-user identity (never a YouTube call) purely to check
    // it against the requested channelId -- see channelAccessCore.assertActiveChannel.
    if (parsedArgs.namespace === "changeset") {
      const channelId = requiredStringFlag(parsedArgs.flags, "channelId");
      const changesetCredentialRef = await auth.resolveEffectiveCredentialRef({
        explicit: getCredentialRef(parsedArgs.flags) ?? undefined,
      });
      await channelAccessCore.assertActiveChannel({
        userId: "userId" in changesetCredentialRef ? changesetCredentialRef.userId : null,
        channelId,
      });

      if (parsedArgs.command === "list") {
        const result = await operationsCore.listChangeSets({ channelId });
        // Wrapped as { changeSets: ... } to match the MCP changeset_list tool's shape
        // (src/mcp/server.ts) and this CLI's own "batch list" sibling below -- found by
        // independent review to have been left as the bare array, an undocumented
        // divergence from the MCP shape docs/interfaces.md itself claims is mirrored.
        writeStdout(serializeSuccess({ changeSets: result }));
        return 0;
      }

      if (parsedArgs.command === "get") {
        const result = await operationsCore.getChangeSet({
          channelId,
          changeSetId: requiredStringFlag(parsedArgs.flags, "changeSetId"),
          status: optionalStringFlag(parsedArgs.flags, "status"),
          language: optionalStringFlag(parsedArgs.flags, "language"),
          videoId: optionalStringFlag(parsedArgs.flags, "videoId"),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      const { filename, buffer } = await readWorkbookFileFlag(parsedArgs.flags);

      if (parsedArgs.command === "preview") {
        const result = await operationsCore.previewImport({ channelId, filename, buffer });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      // "import" -- persists a new Change Set. Never writes to YouTube; gated above like
      // playlist_create/apply (mutates the local database).
      const result = await operationsCore.createChangeSetFromImport({ channelId, filename, buffer });
      writeStdout(serializeSuccess(result));
      return 0;
    }

    if (parsedArgs.namespace === "batch") {
      const channelId = requiredStringFlag(parsedArgs.flags, "channelId");
      const batchCredentialRef = await auth.resolveEffectiveCredentialRef({
        explicit: getCredentialRef(parsedArgs.flags) ?? undefined,
      });
      await channelAccessCore.assertActiveChannel({
        userId: "userId" in batchCredentialRef ? batchCredentialRef.userId : null,
        channelId,
      });

      if (parsedArgs.command === "list") {
        const result = await operationsCore.listBatchesByChannel(channelId);
        writeStdout(serializeSuccess({ batches: result }));
        return 0;
      }

      // "get" -- requireBatchForChannel verifies this batch actually belongs to channelId
      // before returning anything (AGENTS.md §F), not a bare getBatch(batchId).
      const batchId = requiredStringFlag(parsedArgs.flags, "batchId");
      const batch = await operationsCore.requireBatchForChannel(channelId, batchId);
      const ledgerRows = await operationsCore.listLedgerRows(batchId);
      writeStdout(serializeSuccess({ batch, ledgerRows }));
      return 0;
    }

    // ai-localization, like changeset/batch above, has its own service functions that never
    // check active-channel scoping internally (the Web UI's own routes do it at the route
    // boundary instead) -- so this CLI namespace does it explicitly here too, same reasoning.
    if (parsedArgs.namespace === "ai-localization") {
      const channelId = requiredStringFlag(parsedArgs.flags, "channelId");
      const aiLocalizationCredentialRef = await auth.resolveEffectiveCredentialRef({
        explicit: getCredentialRef(parsedArgs.flags) ?? undefined,
      });
      await channelAccessCore.assertActiveChannel({
        userId: "userId" in aiLocalizationCredentialRef ? aiLocalizationCredentialRef.userId : null,
        channelId,
      });

      if (parsedArgs.command === "generate") {
        const videoIds = requiredStringFlag(parsedArgs.flags, "videoIds")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        const targetLanguages = requiredStringFlag(parsedArgs.flags, "targetLanguages")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        const result = await aiLocalizationCore.generateProposals({
          channelId,
          videoIds,
          targetLanguages,
          providerName: optionalStringFlag(parsedArgs.flags, "providerName"),
          connectionId: optionalStringFlag(parsedArgs.flags, "connectionId"),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      // "create-change-set" -- persists a new Change Set (source: "ai_localization"). Never
      // writes to YouTube; gated above like changeset import (mutates the local database).
      // --proposalsJson/--provenanceJson take a JSON-encoded value, the same shape
      // generateProposals's own response already returns for a caller to echo back --
      // there is no reasonable flat-flag equivalent for an array of {videoId, language,
      // title?, description?} objects.
      const proposalsJson = requiredStringFlag(parsedArgs.flags, "proposalsJson");
      const provenanceJsonFlag = optionalStringFlag(parsedArgs.flags, "provenanceJson");
      let proposals: unknown;
      let provenance: unknown;
      try {
        proposals = JSON.parse(proposalsJson);
        provenance = provenanceJsonFlag ? JSON.parse(provenanceJsonFlag) : undefined;
      } catch {
        throw new DomainError({
          code: "validation_failed",
          message: "--proposalsJson/--provenanceJson must each be valid JSON",
        });
      }
      const result = await aiLocalizationCore.createChangeSetFromGeneration({
        channelId,
        proposals,
        provenance,
      });
      writeStdout(serializeSuccess(result));
      return 0;
    }

    // Phase 7 (Agent Operations Interface). "capabilities" is instance-level information, no
    // channel/credential resolution needed at all. "channel-context"/"video-context" (slice B)
    // are channel-scoped reads whose service functions do no active-channel checking themselves
    // (same convention as ai-localization/changeset/batch above) -- so this CLI namespace
    // resolves the local active-user identity and checks it against the requested channelId
    // explicitly, mirroring the ai-localization dispatch block above, not the simpler
    // "capabilities" case.
    if (parsedArgs.namespace === "agent") {
      if (parsedArgs.command === "capabilities") {
        const result = await agentOperationsCore.getSystemCapabilities({});
        writeStdout(serializeSuccess(result));
        return 0;
      }

      // Slice C, owner spec §9. UNLIKE "channel-context"/"video-context" below, these two do NOT
      // call `channelAccessCore.assertActiveChannel` themselves -- mirroring the MCP
      // `agentQueryChannelAnalytics`/`agentQueryVideoAnalytics` handlers' own pattern (and the
      // pre-existing `analytics overview`/`analytics list` commands below), since
      // `agentOperationsCore.queryChannelAnalytics`/`queryVideoAnalytics` forward `credentialRef`
      // straight into the REAL `analyticsCore`, which already does that identical check
      // internally -- a second check here would be redundant against the same fact.
      if (parsedArgs.command === "channel-analytics") {
        const analyticsCredentialRef = await auth.resolveEffectiveCredentialRef({
          explicit: getCredentialRef(parsedArgs.flags) ?? undefined,
        });
        const result = await agentOperationsCore.queryChannelAnalytics({
          credentialRef: analyticsCredentialRef,
          channelId: requiredStringFlag(parsedArgs.flags, "channelId"),
          startDate: requiredStringFlag(parsedArgs.flags, "startDate"),
          endDate: requiredStringFlag(parsedArgs.flags, "endDate"),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "video-analytics") {
        const analyticsCredentialRef = await auth.resolveEffectiveCredentialRef({
          explicit: getCredentialRef(parsedArgs.flags) ?? undefined,
        });
        const metricNamesFlag = optionalStringFlag(parsedArgs.flags, "metricNames");
        const result = await agentOperationsCore.queryVideoAnalytics({
          credentialRef: analyticsCredentialRef,
          channelId: requiredStringFlag(parsedArgs.flags, "channelId"),
          startDate: optionalStringFlag(parsedArgs.flags, "startDate"),
          endDate: optionalStringFlag(parsedArgs.flags, "endDate"),
          videoId: optionalStringFlag(parsedArgs.flags, "videoId"),
          metricNames: metricNamesFlag
            ? metricNamesFlag.split(",").map((entry) => entry.trim()).filter(Boolean)
            : undefined,
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      const channelId = requiredStringFlag(parsedArgs.flags, "channelId");
      const agentCredentialRef = await auth.resolveEffectiveCredentialRef({
        explicit: getCredentialRef(parsedArgs.flags) ?? undefined,
      });
      await channelAccessCore.assertActiveChannel({
        userId: "userId" in agentCredentialRef ? agentCredentialRef.userId : null,
        channelId,
      });

      if (parsedArgs.command === "channel-context") {
        const result = await agentOperationsCore.getChannelContext({ channelId });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      // "video-context" -- --include takes a comma-separated subset of metadata,localizations
      // (same convention as --videoIds/--targetLanguages above); omitted means "both sections",
      // exactly as agentOperationsCore.getVideoContext's own default already handles.
      const videoId = requiredStringFlag(parsedArgs.flags, "videoId");
      const includeFlag = optionalStringFlag(parsedArgs.flags, "include");
      const include = includeFlag
        ? includeFlag.split(",").map((entry) => entry.trim()).filter(Boolean)
        : undefined;
      const result = await agentOperationsCore.getVideoContext({
        channelId,
        videoId,
        ...(include ? { include } : {}),
      });
      writeStdout(serializeSuccess(result));
      return 0;
    }

    const explicitCredentialRef = getCredentialRef(parsedArgs.flags);
    const credentialRef = await auth.resolveEffectiveCredentialRef({
      explicit: explicitCredentialRef ?? undefined,
    });

    if (parsedArgs.namespace === "channel") {
      if (parsedArgs.command === "sync") {
        const channelId = optionalStringFlag(parsedArgs.flags, "channelId");
        const result = await channelSyncCore.syncChannel({
          credentialRef,
          ...(channelId ? { channelId } : {}),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "list") {
        const result = await channelSyncCore.listChannels({ credentialRef });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      const result = await channelSyncCore.listSyncedVideos({
        credentialRef,
        channelId: requiredStringFlag(parsedArgs.flags, "channelId"),
      });
      writeStdout(serializeSuccess(result));
      return 0;
    }

    if (parsedArgs.namespace === "analytics") {
      const channelId = requiredStringFlag(parsedArgs.flags, "channelId");

      if (parsedArgs.command === "overview") {
        const result = await analyticsCore.getChannelOverview({
          credentialRef,
          channelId,
          startDate: requiredStringFlag(parsedArgs.flags, "startDate"),
          endDate: requiredStringFlag(parsedArgs.flags, "endDate"),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "data-quality") {
        const result = await analyticsCore.getDataQualityReport({
          credentialRef,
          channelId,
          startDate: requiredStringFlag(parsedArgs.flags, "startDate"),
          endDate: requiredStringFlag(parsedArgs.flags, "endDate"),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "comparable-age") {
        const metricName = optionalStringFlag(parsedArgs.flags, "metricName");
        const maxDaysFlag = optionalStringFlag(parsedArgs.flags, "maxDays");
        const result = await analyticsCore.getComparableAgeComparison({
          credentialRef,
          channelId,
          videoIds: parseVideoIdsFlag(parsedArgs.flags),
          metricName,
          maxDays: maxDaysFlag !== undefined ? Number(maxDaysFlag) : undefined,
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "weekly-reports") {
        const result = await analyticsCore.listWeeklyReports({ credentialRef, channelId });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "weekly-report-get") {
        const result = await analyticsCore.getWeeklyReport({
          credentialRef,
          channelId,
          weekStartDate: requiredStringFlag(parsedArgs.flags, "weekStartDate"),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      // "list" -- local read of already-collected rows, optional filters (mirrors
      // analytics_list's own optional filters in src/mcp/server.ts).
      const metricNamesFlag = optionalStringFlag(parsedArgs.flags, "metricNames");
      const result = await analyticsCore.listMetrics({
        credentialRef,
        channelId,
        startDate: optionalStringFlag(parsedArgs.flags, "startDate"),
        endDate: optionalStringFlag(parsedArgs.flags, "endDate"),
        videoId: optionalStringFlag(parsedArgs.flags, "videoId"),
        metricNames: metricNamesFlag
          ? metricNamesFlag.split(",").map((entry) => entry.trim()).filter(Boolean)
          : undefined,
      });
      writeStdout(serializeSuccess(result));
      return 0;
    }

    if (parsedArgs.namespace === "playlist") {
      if (parsedArgs.command === "list") {
        const result = await core.listPlaylists({ credentialRef });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "create") {
        const result = await core.createPlaylist({
          credentialRef,
          title: requiredStringFlag(parsedArgs.flags, "title"),
          expectedChannelId: requiredStringFlag(parsedArgs.flags, "expectedChannelId"),
          description: optionalStringFlag(parsedArgs.flags, "description"),
          privacyStatus: optionalStringFlag(parsedArgs.flags, "privacyStatus"),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "update") {
        const title = optionalStringFlag(parsedArgs.flags, "title");
        const description = optionalStringFlag(parsedArgs.flags, "description");
        const privacyStatus = optionalStringFlag(parsedArgs.flags, "privacyStatus");

        if (title === undefined && description === undefined && privacyStatus === undefined) {
          throw new DomainError({
            code: "validation_failed",
            message: "At least one mutable field is required: title, description or privacyStatus",
          });
        }

        const result = await core.updatePlaylist({
          credentialRef,
          playlistId: requiredStringFlag(parsedArgs.flags, "playlistId"),
          expectedChannelId: requiredStringFlag(parsedArgs.flags, "expectedChannelId"),
          title,
          description,
          privacyStatus,
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "delete") {
        const result = await core.deletePlaylist({
          credentialRef,
          playlistId: requiredStringFlag(parsedArgs.flags, "playlistId"),
          expectedChannelId: requiredStringFlag(parsedArgs.flags, "expectedChannelId"),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "add") {
        const result = await core.addVideosToPlaylist({
          credentialRef,
          playlistId: requiredStringFlag(parsedArgs.flags, "playlistId"),
          videoIds: parseVideoIdsFlag(parsedArgs.flags),
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      const result = await core.removeVideosFromPlaylist({
        credentialRef,
        playlistId: requiredStringFlag(parsedArgs.flags, "playlistId"),
        videoIds: parseVideoIdsFlag(parsedArgs.flags),
      });
      writeStdout(serializeSuccess(result));
      return 0;
    }

    if (parsedArgs.command === "list") {
      const maxResultsFlag = optionalStringFlag(parsedArgs.flags, "maxResults");
      const maxResults = maxResultsFlag === undefined ? undefined : Number(maxResultsFlag);
      const channelId = optionalStringFlag(parsedArgs.flags, "channelId");

      const result = await core.listVideos({
        credentialRef,
        ...(channelId ? { channelId } : {}),
        maxResults,
      });

      writeStdout(serializeSuccess(result));
      return 0;
    }

    if (parsedArgs.command === "transcript") {
      const result = await core.getTranscript({
        credentialRef,
        videoId: requiredStringFlag(parsedArgs.flags, "videoId"),
      });

      writeStdout(serializeSuccess(result));
      return 0;
    }

    if (parsedArgs.command === "preview") {
      const result = await core.previewMetadata({
        credentialRef,
        videoId: requiredStringFlag(parsedArgs.flags, "videoId"),
        editorialPrompt: requiredStringFlag(parsedArgs.flags, "editorialPrompt"),
      });

      writeStdout(serializeSuccess(result));
      return 0;
    }

    const dryRun = resolveDryRunFlag(parsedArgs.flags);
    const result = await core.applyMetadata({
      credentialRef,
      videoId: requiredStringFlag(parsedArgs.flags, "videoId"),
      finalTitle: requiredStringFlag(parsedArgs.flags, "finalTitle"),
      description: requiredStringFlag(parsedArgs.flags, "description"),
      expectedChannelId: requiredStringFlag(parsedArgs.flags, "expectedChannelId"),
      // Omitted entirely (not sent as `false`) when the flag itself was omitted, so
      // applyMetadataInputSchema's own safe default (true) applies -- see
      // resolveDryRunFlag's doc comment (RISK-12).
      ...(dryRun !== undefined ? { dryRun } : {}),
    });

    writeStdout(serializeSuccess(result));
    return 0;
  } catch (error) {
    writeStderr(serializeError(error));
    return 1;
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCliCommand({ argv: process.argv.slice(2) })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${serializeError(error)}\n`);
      process.exitCode = 1;
    });
}
