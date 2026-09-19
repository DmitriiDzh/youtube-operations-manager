#!/usr/bin/env node

import { loadEnvConfig } from "@next/env";
import { fileURLToPath } from "node:url";
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
  namespace: "metadata" | "auth" | "playlist";
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
    | "revoke";
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [namespaceRaw, maybeCommandRaw, ...remaining] = argv;
  const isAuthNamespace = namespaceRaw === "auth";
  const isPlaylistNamespace = namespaceRaw === "playlist";
  const commandRaw =
    isAuthNamespace || isPlaylistNamespace ? maybeCommandRaw : namespaceRaw;
  const flagTokens =
    isAuthNamespace || isPlaylistNamespace
      ? remaining
      : [maybeCommandRaw, ...remaining].filter(Boolean);

  const validMetadataCommands = ["list", "transcript", "preview", "apply"];
  const validAuthCommands = ["login", "whoami", "list-channels", "select-channel", "list-users", "select-user", "logout", "revoke"];
  const validPlaylistCommands = ["list", "create", "update", "delete", "add", "remove"];
  const validCommands = isAuthNamespace
    ? validAuthCommands
    : isPlaylistNamespace
      ? validPlaylistCommands
      : validMetadataCommands;

  if (!commandRaw || !validCommands.includes(commandRaw)) {
    throw new DomainError({
      code: "validation_failed",
      message: isAuthNamespace
        ? "Auth command must be one of: login, whoami, list-channels, select-channel, list-users, select-user, logout, revoke"
        : isPlaylistNamespace
          ? "Playlist command must be one of: list, create, update, delete, add, remove"
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
    namespace: isAuthNamespace ? "auth" : isPlaylistNamespace ? "playlist" : "metadata",
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
  const userId = flags.userId;
  const accessToken = flags.accessToken;

  if (typeof userId === "string" && userId.length > 0) {
    return { userId };
  }

  if (typeof accessToken === "string" && accessToken.length > 0) {
    return {
      accessToken,
      refreshToken:
        typeof flags.refreshToken === "string" ? flags.refreshToken : undefined,
      scope: typeof flags.scope === "string" ? flags.scope : undefined,
      tokenExpiry:
        typeof flags.tokenExpiry === "string" ? Number(flags.tokenExpiry) : undefined,
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

export function requiredStringFlag(
  flags: Record<string, string | boolean>,
  key: string
): string {
  const value = flags[key];
  if (typeof value === "string" && value.length > 0) return value;

  throw new DomainError({
    code: "validation_failed",
    message: `Missing required --${key}`,
  });
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
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}): Promise<number> {
  const core = args.core ?? {
    ...createVideoMetadataCore(),
    ...createPlaylistManagementCore(),
  };
  const auth = args.auth ?? createCliAuthService();
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
        const channelId =
          typeof parsedArgs.flags.channelId === "string" ? parsedArgs.flags.channelId : "";
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

      const revokeUserId =
        typeof parsedArgs.flags.userId === "string" ? parsedArgs.flags.userId : undefined;
      const result = await auth.revoke({ userId: revokeUserId });
      writeStdout(serializeSuccess(result));
      return 0;
    }

    const explicitCredentialRef = getCredentialRef(parsedArgs.flags);
    const credentialRef = await auth.resolveEffectiveCredentialRef({
      explicit: explicitCredentialRef ?? undefined,
    });

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
          description:
            typeof parsedArgs.flags.description === "string"
              ? parsedArgs.flags.description
              : undefined,
          privacyStatus:
            typeof parsedArgs.flags.privacyStatus === "string"
              ? parsedArgs.flags.privacyStatus
              : undefined,
        });
        writeStdout(serializeSuccess(result));
        return 0;
      }

      if (parsedArgs.command === "update") {
        const title = typeof parsedArgs.flags.title === "string" ? parsedArgs.flags.title : undefined;
        const description =
          typeof parsedArgs.flags.description === "string"
            ? parsedArgs.flags.description
            : undefined;
        const privacyStatus =
          typeof parsedArgs.flags.privacyStatus === "string"
            ? parsedArgs.flags.privacyStatus
            : undefined;

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
      const maxResults =
        typeof parsedArgs.flags.maxResults === "string"
          ? Number(parsedArgs.flags.maxResults)
          : undefined;
      const channelId =
        typeof parsedArgs.flags.channelId === "string" ? parsedArgs.flags.channelId : undefined;

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
