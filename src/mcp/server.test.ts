import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DomainError } from "@/lib/video-metadata/contracts";
import type { VideoMetadataCore } from "@/lib/video-metadata";
import type { PlaylistManagementCore } from "@/lib/playlist-management";
import type { ChangeSetCore } from "@/lib/changesets";
import type { BatchCore } from "@/lib/batches";
import type { ChannelSyncCore } from "@/lib/channel-sync";
import type { ChannelAccessCore } from "@/lib/channel-access";
import type { AnalyticsCore } from "@/lib/analytics";
import type { AiLocalizationCore } from "@/lib/ai-localization";
import type { AgentOperationsCore } from "@/lib/agent-operations";
import { rawSqlClient } from "@/lib/db";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";
import { createMcpServer, createMcpToolHandlers } from "./server";

function makeCoreStub(): Pick<
  VideoMetadataCore & PlaylistManagementCore,
  | "listVideos"
  | "getTranscript"
  | "previewMetadata"
  | "applyMetadata"
  | "listPlaylists"
  | "createPlaylist"
  | "updatePlaylist"
  | "deletePlaylist"
  | "addVideosToPlaylist"
  | "removeVideosFromPlaylist"
> {
  return {
    listVideos: async (input: unknown) => {
      void input;
      return { videos: [] };
    },
    getTranscript: async (input: unknown) => {
      void input;
      return { transcript: { status: "available" as const, text: "Transcript" } };
    },
    previewMetadata: async (input: unknown) => {
      void input;
      return {
        video: { videoId: "v1", title: "Video", description: "Desc", publishedAt: "2024-01-01" },
        transcript: { status: "available" as const, text: "Transcript" },
        draft: {
          finalTitle: "Final",
          description: "Description",
          promptVersion: "video-metadata-v1",
        },
      };
    },
    applyMetadata: async (input: unknown) => {
      void input;
      return {
        dryRun: true,
        videoId: "v1",
        targetLanguage: "es",
        languageSource: "defaultLanguage" as const,
        snippet: {
          before: { title: "Before", description: "Before desc", categoryId: "22" },
          proposed: { title: "After", description: "After desc", categoryId: "22" },
        },
        localizations: {
          before: {
            es: { title: "Antes", description: "Antes desc" },
            en: { title: "Before EN", description: "Before desc EN" },
          },
          proposed: {
            es: { title: "After", description: "After desc" },
            en: { title: "Before EN", description: "Before desc EN" },
          },
          affected: [
            {
              locale: "es",
              before: { title: "Antes", description: "Antes desc" },
              proposed: { title: "After", description: "After desc" },
              source: "defaultLanguage" as const,
            },
          ],
        },
      };
    },
    listPlaylists: async () => ({
      playlists: [
        {
          id: "p1",
          title: "Playlist 1",
          description: "Playlist description",
          privacyStatus: "private" as const,
        },
      ],
    }),
    createPlaylist: async (input: unknown) => {
      void input;
      return {
        playlist: {
          id: "p1",
          title: "Playlist 1",
          description: "Playlist description",
          privacyStatus: "private" as const,
        },
      };
    },
    updatePlaylist: async () => ({
      playlist: {
        id: "p1",
        title: "Playlist 1",
        description: "Playlist description",
        privacyStatus: "private" as const,
      },
    }),
    deletePlaylist: async () => ({ deleted: true, playlistId: "p1" }),
    addVideosToPlaylist: async () => ({
      playlistId: "p1",
      attempted: 2,
      added: 1,
      failures: [{ videoId: "v2", reason: "already-present" as const }],
    }),
    removeVideosFromPlaylist: async () => ({
      playlistId: "p1",
      requested: 2,
      removed: 1,
      failures: [{ videoId: "v2", reason: "not-found-in-playlist" as const }],
    }),
  };
}

function makeAuthStub() {
  return {
    whoami: async () => ({
      userId: "active-user",
      email: "active-user@example.com",
      name: null,
      tokenExpiry: null,
      hasRefreshToken: true,
      isActive: true,
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      requiresReauth: true,
      knownChannels: [
        {
          id: "UC_ACTIVE",
          title: "Active channel",
          source: "active",
          isActive: true,
          isSelected: false,
        },
        {
          id: "UC_SELECTED",
          title: null,
          source: "selected",
          isActive: false,
          isSelected: true,
        },
      ],
      writeChannel: {
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
        selectedChannelId: "UC_SELECTED",
        expectedChannelId: "UC_SELECTED",
        source: "stored",
        knownChannels: [
          {
            id: "UC_ACTIVE",
            title: "Active channel",
            source: "active",
            isActive: true,
            isSelected: false,
          },
          {
            id: "UC_SELECTED",
            title: null,
            source: "selected",
            isActive: false,
            isSelected: true,
          },
        ],
        alignment: {
          status: "mismatch",
          requiresReauth: true,
          message: "Selected expected channel does not match the active OAuth channel.",
          recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
        },
        requiresReauth: true,
      },
      effectiveCredentialRef: { userId: "active-user" },
    }),
    selectUser: async ({ userId }: { userId: string }) => ({
      activeUser: {
        userId,
        email: `${userId}@example.com`,
        name: null,
        tokenExpiry: null,
        hasRefreshToken: true,
        isActive: true,
      },
      previousActiveUserId: "active-user",
      changed: userId !== "active-user",
      effectiveCredentialRef: { userId },
      writeChannel: {
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
        selectedChannelId: "UC_SELECTED",
        expectedChannelId: "UC_SELECTED",
        source: "stored",
        knownChannels: [],
        alignment: {
          status: "mismatch",
          requiresReauth: true,
          message: "Selected expected channel does not match the active OAuth channel.",
          recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
        },
        requiresReauth: true,
      },
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      requiresReauth: true,
      affectsRemoteOAuth: false as const,
    }),
    listKnownWriteChannels: async () => ({
      knownChannels: [
        {
          id: "UC_ACTIVE",
          title: "Active channel",
          source: "active",
          isActive: true,
          isSelected: false,
        },
        {
          id: "UC_SELECTED",
          title: null,
          source: "selected",
          isActive: false,
          isSelected: true,
        },
      ],
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      expectedChannelId: "UC_SELECTED",
      source: "stored",
      requiresReauth: true,
    }),
    selectWriteChannel: async ({ channelId }: { channelId: string }) => ({
      selectedChannelId: channelId,
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      expectedChannelId: channelId,
      source: "stored",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      knownChannels: [],
      requiresReauth: true,
      message: "Selected expected channel does not match the active OAuth channel.",
      recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
    }),
    resolveEffectiveCredentialRef: async ({ explicit }: { explicit?: unknown }) =>
      (explicit as { userId: string } | undefined) ?? { userId: "active-user" },
  };
}

function makeApplyPayload(dryRun: boolean) {
  return {
    dryRun,
    videoId: "v1",
    targetLanguage: "es",
    languageSource: "defaultLanguage" as const,
    snippet: {
      before: { title: "Before", description: "Before desc", categoryId: "22" },
      proposed: { title: "After", description: "After desc", categoryId: "22" },
    },
    localizations: {
      before: {
        es: { title: "Antes", description: "Antes desc" },
      },
      proposed: {
        es: { title: "After", description: "After desc" },
      },
      affected: [
        {
          locale: "es",
          before: { title: "Antes", description: "Antes desc" },
          proposed: { title: "After", description: "After desc" },
          source: "defaultLanguage" as const,
        },
      ],
    },
  };
}

test("MCP whoami returns active local user", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.whoami();

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { userId: string; email: string };
  assert.equal(payload.userId, "active-user");
  assert.equal(payload.email, "active-user@example.com");
});

test("MCP server registers auth_user_select tool", () => {
  const server = createMcpServer(makeCoreStub(), { connectionEnabled: true });
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;

  assert.equal(Boolean(tools?.auth_user_select), true);
});

// "MCP connection" gate (owner instruction, 2026-09-21, renamed and inverted from the earlier
// "MCP restricted mode"): a single boolean now decides whether ANY tool is registered at all,
// not a per-tool exclusion list. Default (no option passed) must be fully disconnected -- zero
// tools, not even read-only ones.

function registeredToolNames(server: ReturnType<typeof createMcpServer>): string[] {
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  return Object.keys(tools ?? {});
}

test("MCP server (default, no option passed) registers zero tools", () => {
  const names = registeredToolNames(createMcpServer(makeCoreStub()));
  assert.deepEqual(names, []);
});

test("MCP server (connectionEnabled: false) registers zero tools, including every read-only one", () => {
  const names = registeredToolNames(createMcpServer(makeCoreStub(), { connectionEnabled: false }));

  for (const tool of [
    "whoami",
    "list",
    "transcript",
    "preview",
    "playlist_list",
    "changeset_list",
    "changeset_get",
    "batch_list",
    "batch_get",
    "channel_sync",
    "channel_list",
    "channel_video_list",
    "analytics_list",
    "analytics_overview",
    "analytics_data_quality",
    "apply",
    "playlist_create",
    "write_channel_select",
    "auth_user_select",
  ]) {
    assert.equal(names.includes(tool), false, `expected ${tool} to be omitted while disconnected`);
  }
});

test("MCP server (connectionEnabled: true) registers every tool, including write/identity-switching ones", () => {
  const names = registeredToolNames(createMcpServer(makeCoreStub(), { connectionEnabled: true }));

  for (const tool of [
    "whoami",
    "list",
    "transcript",
    "preview",
    "playlist_list",
    "changeset_list",
    "changeset_get",
    "localization_import_preview",
    "changeset_create_from_import",
    "batch_list",
    "batch_get",
    "channel_sync",
    "channel_list",
    "channel_video_list",
    "analytics_list",
    "analytics_overview",
    "analytics_data_quality",
    "apply",
    "playlist_create",
    "playlist_update",
    "playlist_delete",
    "playlist_add_videos",
    "playlist_remove_videos",
    "write_channel_select",
    "auth_user_select",
    "write_context",
  ]) {
    assert.equal(names.includes(tool), true, `expected ${tool} to be registered once connected`);
  }
});

// Mechanical enforcement of "один шлюз" for the MCP connection gate (owner instruction,
// 2026-09-21): the local `registerTool` wrapper (which checks `connectionEnabled`) must be the
// ONLY call site that ever calls the SDK's real `server.registerTool`. A future tool added via
// `server.registerTool(...)` directly, bypassing the wrapper, would silently escape the gate --
// this test fails the build the moment that happens, mirroring
// `src/lib/youtube-write-gateway/gateway-inventory.test.ts`'s same "enforced by a test, not by
// convention" principle for the write funnel.
test("MCP connection gate inventory: server.registerTool is called from exactly one place in this file (the local registerTool wrapper)", async () => {
  const thisFile = fileURLToPath(import.meta.url);
  const serverFile = path.join(path.dirname(thisFile), "server.ts");
  const content = await readFile(serverFile, "utf8");

  const matches = content.match(/server\.registerTool\(/g) ?? [];
  assert.equal(
    matches.length,
    1,
    `expected exactly one "server.registerTool(" call site in src/mcp/server.ts (inside the ` +
      `local registerTool wrapper), found ${matches.length} -- a second call site would bypass ` +
      `the connectionEnabled gate entirely`
  );
});

// Mechanical check that `createMcpToolHandlers` (the raw handlers, unprotected by the
// connection gate -- only `registerTool`'s SDK call is gated) is never imported anywhere except
// this file and its own test, so no other surface can invoke a tool's logic while bypassing MCP
// tool registration entirely.
test("MCP connection gate inventory: createMcpToolHandlers is imported nowhere outside src/mcp/server.ts and its own test", async () => {
  const thisFile = fileURLToPath(import.meta.url);
  const mcpDir = path.dirname(thisFile);
  const repoRoot = path.resolve(mcpDir, "..", "..");
  const srcDir = path.join(repoRoot, "src");

  async function listTsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules") continue;
      if (entry.isDirectory()) files.push(...(await listTsFiles(full)));
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
    return files;
  }

  const allowed = new Set([
    path.join(mcpDir, "server.ts"),
    path.join(mcpDir, "server.test.ts"),
    path.join(mcpDir, "server.recovery-gate.test.ts"),
  ]);
  const offenders: string[] = [];

  for (const file of await listTsFiles(srcDir)) {
    if (allowed.has(file)) continue;
    const content = await readFile(file, "utf8");
    if (/\bcreateMcpToolHandlers\s*\(/.test(content)) {
      offenders.push(path.relative(repoRoot, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `createMcpToolHandlers is called outside src/mcp/server.ts, bypassing the connection gate ` +
      `entirely: ${offenders.join(", ")}`
  );
});

test("MCP write_context returns active write-channel contract", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.writeContext();

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as {
    activeWriteChannel: { id: string };
    selectedChannelId: string;
    effectiveCredentialRef: { userId: string };
  };

  assert.equal(payload.activeWriteChannel.id, "UC_ACTIVE");
  assert.equal(payload.selectedChannelId, "UC_SELECTED");
  assert.deepEqual(payload.effectiveCredentialRef, { userId: "active-user" });
});

test("MCP write_channel_list returns minimal-safe known channel list", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.writeChannelList({});

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as {
    knownChannels: Array<{ id: string; source: string }>;
    alignment: { status: string; requiresReauth: boolean };
  };
  assert.equal(payload.knownChannels.length, 2);
  assert.equal(payload.alignment.status, "mismatch");
  assert.equal(payload.alignment.requiresReauth, true);
});

test("MCP write_channel_select returns mismatch contract without implying OAuth switch", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.writeChannelSelect({
    channelId: "UC1111111111111111111111",
  });

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as {
    selectedChannelId: string;
    alignment: { status: string; requiresReauth: boolean };
    message: string;
  };
  assert.equal(payload.selectedChannelId, "UC1111111111111111111111");
  assert.equal(payload.alignment.status, "mismatch");
  assert.equal(payload.alignment.requiresReauth, true);
  assert.match(payload.message, /does not match the active OAuth channel/i);
});

test("MCP write_channel_select rejects invalid payload before persistence", async () => {
  let selectCalled = false;
  const auth = makeAuthStub();
  auth.selectWriteChannel = async () => {
    selectCalled = true;
    throw new Error("should not be called");
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), auth);
  const result = await handlers.writeChannelSelect({ channelId: "" });

  assert.equal(result.isError, true);
  assert.equal(selectCalled, false);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP auth_user_select switches local active identity only", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());
  const result = await handlers.authUserSelect({ userId: "user-b" });

  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as {
    activeUser: { userId: string };
    previousActiveUserId: string;
    affectsRemoteOAuth: boolean;
  };
  assert.equal(payload.activeUser.userId, "user-b");
  assert.equal(payload.previousActiveUserId, "active-user");
  assert.equal(payload.affectsRemoteOAuth, false);
});

test("MCP auth_user_select rejects invalid payload before persistence", async () => {
  let selectCalled = false;
  const auth = makeAuthStub();
  auth.selectUser = async () => {
    selectCalled = true;
    throw new Error("should not be called");
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), auth);
  const result = await handlers.authUserSelect({ userId: "" });

  assert.equal(result.isError, true);
  assert.equal(selectCalled, false);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP auth_user_select returns AUTH_USER_NOT_FOUND as structured error", async () => {
  const auth = makeAuthStub();
  auth.selectUser = async () => {
    throw new DomainError({
      code: "AUTH_USER_NOT_FOUND",
      message: "Requested auth user does not exist in local storage",
      details: { userId: "missing-user", affectsRemoteOAuth: false },
    });
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), auth);
  const result = await handlers.authUserSelect({ userId: "missing-user" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "AUTH_USER_NOT_FOUND");
  assert.deepEqual(payload.error.details, {
    userId: "missing-user",
    affectsRemoteOAuth: false,
  });
});

test("MCP preview tool returns finalTitle and description for valid input", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());

  const result = await handlers.preview({
    credentialRef: { userId: "user-1" },
    videoId: "v1",
    editorialPrompt: "Improve title",
  });

  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as {
    draft: { finalTitle: string; description: string };
  };
  assert.equal(structured.draft.finalTitle, "Final");
  assert.equal(structured.draft.description, "Description");
});

test("MCP handlers reject invalid input with structured validation error", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());

  const result = await handlers.preview({
    credentialRef: { userId: "user-1" },
    videoId: "v1",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "validation_failed");
  assert.equal(Array.isArray(payload.error.details), true);
});

test("MCP apply tool supports dry-run review without mutation", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.applyMetadata = async (input: unknown) => {
    capturedInput = input;
    return {
      dryRun: true,
      videoId: "v1",
      targetLanguage: "es",
      languageSource: "defaultLanguage" as const,
      snippet: {
        before: { title: "Before", description: "Before desc", categoryId: "22" },
        proposed: { title: "After", description: "After desc", categoryId: "22" },
      },
      localizations: {
        before: {
          es: { title: "Antes", description: "Antes desc" },
        },
        proposed: {
          es: { title: "After", description: "After desc" },
        },
        affected: [
          {
            locale: "es",
            before: { title: "Antes", description: "Antes desc" },
            proposed: { title: "After", description: "After desc" },
            source: "defaultLanguage" as const,
          },
        ],
      },
    };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    credentialRef: { userId: "user-1" },
    videoId: "v1",
    finalTitle: "After",
    description: "After desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "user-1" },
    videoId: "v1",
    finalTitle: "After",
    description: "After desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });

  const payload = result.structuredContent as {
    dryRun: boolean;
    targetLanguage: string;
    localizations: { affected: Array<{ locale: string }> };
  };
  assert.equal(payload.dryRun, true);
  assert.equal(payload.targetLanguage, "es");
  assert.equal(payload.localizations.affected[0]?.locale, "es");
});

test("MCP apply keeps structuredContent parity between dryRun and apply", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async (input: unknown) => {
    const request = input as { dryRun?: boolean };
    return makeApplyPayload(request.dryRun === true);
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());

  const dryRunResult = await handlers.apply({
    videoId: "v1",
    finalTitle: "After",
    description: "After desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });

  const applyResult = await handlers.apply({
    videoId: "v1",
    finalTitle: "After",
    description: "After desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: false,
  });

  assert.equal(dryRunResult.isError, undefined);
  assert.equal(applyResult.isError, undefined);

  const dryRunPayload = {
    ...(dryRunResult.structuredContent as Record<string, unknown>),
  };
  const applyPayload = {
    ...(applyResult.structuredContent as Record<string, unknown>),
  };

  assert.equal(dryRunPayload.dryRun, true);
  assert.equal(applyPayload.dryRun, false);
  delete dryRunPayload.dryRun;
  delete applyPayload.dryRun;
  assert.deepEqual(dryRunPayload, applyPayload);
});

test("MCP transcript keeps structuredContent and text payload aligned with diagnostics", async () => {
  const core = makeCoreStub();
  core.getTranscript = async () => ({
    transcript: {
      status: "unavailable",
      reason: "captions-not-downloadable",
      diagnostic: {
        stage: "captions-download",
        httpStatus: 403,
        apiReason: "forbidden",
        retriable: false,
      },
    },
  });

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.transcript({ videoId: "v1" });

  assert.equal(result.isError, undefined);
  const payloadFromText = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(result.structuredContent, payloadFromText);
  assert.deepEqual(payloadFromText.transcript, {
    status: "unavailable",
    reason: "captions-not-downloadable",
    diagnostic: {
      stage: "captions-download",
      httpStatus: 403,
      apiReason: "forbidden",
      retriable: false,
    },
  });
});

test("MCP list uses active auth context when credentialRef is omitted", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.listVideos = async (input: unknown) => {
    capturedInput = input;
    return { videos: [] };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.list({ maxResults: 5 });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
    maxResults: 5,
  });
});

test("MCP list forwards explicit channelId for multi-account setups", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.listVideos = async (input: unknown) => {
    capturedInput = input;
    return { videos: [] };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  await handlers.list({ channelId: "IscmdXDtypp2zTzEEYxJwg", maxResults: 5 });

  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
    channelId: "IscmdXDtypp2zTzEEYxJwg",
    maxResults: 5,
  });
});

test("MCP keeps explicit credentialRef precedence over active user", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.listVideos = async (input: unknown) => {
    capturedInput = input;
    return { videos: [] };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  await handlers.list({ credentialRef: { userId: "explicit-user" } });

  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "explicit-user" },
  });
});

test("MCP returns AUTH_USER_NOT_FOUND as structured error", async () => {
  const auth = {
    whoami: async () => ({
      userId: "active-user",
      email: "active-user@example.com",
      name: null,
      tokenExpiry: null,
      hasRefreshToken: true,
      isActive: true,
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      requiresReauth: true,
      knownChannels: [],
      writeChannel: {
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
        selectedChannelId: "UC_SELECTED",
        expectedChannelId: "UC_SELECTED",
        source: "stored",
        knownChannels: [],
        alignment: {
          status: "mismatch",
          requiresReauth: true,
          message: "Selected expected channel does not match the active OAuth channel.",
          recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
        },
        requiresReauth: true,
      },
      effectiveCredentialRef: { userId: "active-user" },
    }),
    listKnownWriteChannels: async () => ({
      knownChannels: [],
      alignment: {
        status: "unresolved",
        requiresReauth: false,
        message: "No expected write channel is configured yet.",
        recommendedAction: "Select the expected channel before running sensitive write operations.",
      },
      activeWriteChannel: null,
      selectedChannelId: null,
      expectedChannelId: null,
      source: "missing",
      requiresReauth: false,
    }),
    selectWriteChannel: async () => ({
      selectedChannelId: "UC1111111111111111111111",
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      expectedChannelId: "UC1111111111111111111111",
      source: "stored",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      knownChannels: [],
      requiresReauth: true,
      message: "Selected expected channel does not match the active OAuth channel.",
      recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
    }),
    selectUser: async () => ({
      activeUser: {
        userId: "active-user",
        email: "active-user@example.com",
        name: null,
        tokenExpiry: null,
        hasRefreshToken: true,
        isActive: true,
      },
      previousActiveUserId: "active-user",
      changed: false,
      effectiveCredentialRef: { userId: "active-user" },
      writeChannel: {
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
        selectedChannelId: "UC_SELECTED",
        expectedChannelId: "UC_SELECTED",
        source: "stored",
        knownChannels: [],
        alignment: {
          status: "mismatch",
          requiresReauth: true,
          message: "Selected expected channel does not match the active OAuth channel.",
          recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
        },
        requiresReauth: true,
      },
      activeWriteChannel: { id: "UC_ACTIVE", title: "Active channel" },
      selectedChannelId: "UC_SELECTED",
      alignment: {
        status: "mismatch",
        requiresReauth: true,
        message: "Selected expected channel does not match the active OAuth channel.",
        recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
      },
      requiresReauth: true,
      affectsRemoteOAuth: false as const,
    }),
    resolveEffectiveCredentialRef: async () => {
      throw new DomainError({
        code: "AUTH_USER_NOT_FOUND",
        message: "Active auth user does not exist",
      });
    },
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), auth);
  const result = await handlers.list({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "AUTH_USER_NOT_FOUND");
});

test("MCP returns AUTH_SCOPE_INSUFFICIENT as structured error", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async () => {
    throw new DomainError({
      code: "AUTH_SCOPE_INSUFFICIENT",
      message: "Credentials are missing required OAuth scopes",
      details: { missingScopes: ["https://www.googleapis.com/auth/youtube"] },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    videoId: "v1",
    finalTitle: "New",
    description: "New desc",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "AUTH_SCOPE_INSUFFICIENT");
});

test("MCP playlist_list uses active auth context when credentialRef is omitted", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.listPlaylists = async (input: unknown) => {
    capturedInput = input;
    return { playlists: [] };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistList({});

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
  });
});

test("MCP playlist_create keeps explicit credentialRef precedence", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.createPlaylist = async (input: unknown) => {
    capturedInput = input;
    return {
      playlist: {
        id: "p-created",
        title: "My Playlist",
        description: "Roadtrip videos",
        privacyStatus: "private" as const,
      },
    };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistCreate({
    credentialRef: { userId: "explicit-user" },
    title: "My Playlist",
    description: "Roadtrip videos",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "explicit-user" },
    title: "My Playlist",
    description: "Roadtrip videos",
    expectedChannelId: "UC_ACTIVE",
    privacyStatus: "private",
  });

  const payload = result.structuredContent as {
    playlist: { id: string; title: string; description: string; privacyStatus: string };
  };
  assert.equal(payload.playlist.id, "p-created");
  assert.equal(payload.playlist.title, "My Playlist");
  assert.equal(payload.playlist.description, "Roadtrip videos");
  assert.equal(payload.playlist.privacyStatus, "private");
});

test("MCP playlist_update enforces patch schema and forwards payload", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.updatePlaylist = async (input: unknown) => {
    capturedInput = input;
    return {
      playlist: {
        id: "p-updated",
        title: "Updated",
        description: "Updated description",
        privacyStatus: "public" as const,
      },
    };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistUpdate({
    playlistId: "p-updated",
    expectedChannelId: "UC_ACTIVE",
    description: "Updated description",
    privacyStatus: "public",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
    playlistId: "p-updated",
    expectedChannelId: "UC_ACTIVE",
    description: "Updated description",
    privacyStatus: "public",
  });
  assert.deepEqual(result.structuredContent, {
    playlist: {
      id: "p-updated",
      title: "Updated",
      description: "Updated description",
      privacyStatus: "public",
    },
  });
});

test("MCP playlist_delete enforces schema and forwards expectedChannelId", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.deletePlaylist = async (input: unknown) => {
    capturedInput = input;
    return { deleted: true, playlistId: "p-delete" };
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistDelete({
    playlistId: "p-delete",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
    playlistId: "p-delete",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.deepEqual(result.structuredContent, {
    deleted: true,
    playlistId: "p-delete",
  });
});

test("MCP playlist_* tools reject invalid input with structured validation errors", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());

  const invalidCalls = [
    {
      toolName: "playlist_list",
      invoke: () => handlers.playlistList({ maxResults: 0 }),
    },
    {
      toolName: "playlist_create",
      invoke: () => handlers.playlistCreate({ title: "" }),
    },
    {
      toolName: "playlist_add_videos",
      invoke: () => handlers.playlistAddVideos({ playlistId: "p1", videoIds: [] }),
    },
    {
      toolName: "playlist_remove_videos",
      invoke: () => handlers.playlistRemoveVideos({ playlistId: "p1", videoIds: [] }),
    },
    {
      toolName: "playlist_delete",
      invoke: () => handlers.playlistDelete({ playlistId: "p1" }),
    },
    {
      toolName: "playlist_update",
      invoke: () => handlers.playlistUpdate({ playlistId: "p1", expectedChannelId: "UC_ACTIVE" }),
    },
  ];

  for (const invalidCall of invalidCalls) {
    const result = await invalidCall.invoke();
    assert.equal(result.isError, true, `${invalidCall.toolName} should return error`);

    const payload = JSON.parse(result.content[0]?.text ?? "{}");
    assert.equal(payload.ok, false, `${invalidCall.toolName} should return ok=false`);
    assert.equal(
      payload.error.code,
      "validation_failed",
      `${invalidCall.toolName} should return validation_failed`
    );
    assert.equal(
      Array.isArray(payload.error.details),
      true,
      `${invalidCall.toolName} should include validation details`
    );
  }
});

test("MCP playlist add/remove tools return stable partial contracts", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub());

  const addResult = await handlers.playlistAddVideos({
    playlistId: "p1",
    videoIds: ["v1", "v2"],
  });
  const removeResult = await handlers.playlistRemoveVideos({
    playlistId: "p1",
    videoIds: ["v1", "v2"],
  });

  assert.equal(addResult.isError, undefined);
  assert.equal(removeResult.isError, undefined);

  assert.deepEqual(addResult.structuredContent, {
    playlistId: "p1",
    attempted: 2,
    added: 1,
    failures: [{ videoId: "v2", reason: "already-present" }],
  });

  assert.deepEqual(removeResult.structuredContent, {
    playlistId: "p1",
    requested: 2,
    removed: 1,
    failures: [{ videoId: "v2", reason: "not-found-in-playlist" }],
  });
});

test("MCP apply returns target-language resolution errors as structured domain errors", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async () => {
    throw new DomainError({
      code: "target_language_unresolvable",
      message:
        "Cannot resolve target language. Set snippet.defaultLanguage on the video or leave exactly one localization.",
      details: { localizationLocales: ["es", "en"] },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    videoId: "v1",
    finalTitle: "Nuevo",
    description: "Nueva descripción",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "target_language_unresolvable");
});

test("MCP apply returns guardrail mismatch details in structured error", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "expectedChannelId does not match the active write channel",
      details: {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    videoId: "v1",
    finalTitle: "Nuevo",
    description: "Nueva descripción",
    expectedChannelId: "UC_EXPECTED",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("MCP apply returns unresolved guardrail details in structured error", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_UNRESOLVED",
      message: "Cannot resolve active write channel for the current OAuth session",
      details: {
        expectedChannelId: "UC_EXPECTED",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.apply({
    videoId: "v1",
    finalTitle: "Nuevo",
    description: "Nueva descripción",
    expectedChannelId: "UC_EXPECTED",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_UNRESOLVED");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_EXPECTED",
  });
});

test("MCP playlist_create fails closed on guardrail mismatch with stable details", async () => {
  const core = makeCoreStub();
  core.createPlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "expectedChannelId does not match the active write channel",
      details: {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistCreate({
    title: "Roadtrip",
    expectedChannelId: "UC_EXPECTED",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("MCP playlist_update fails closed on guardrail mismatch with stable details", async () => {
  const core = makeCoreStub();
  core.updatePlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "expectedChannelId does not match the active write channel",
      details: {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistUpdate({
    playlistId: "p-update",
    expectedChannelId: "UC_EXPECTED",
    title: "Updated",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("MCP playlist_update fails closed on invalid ownership with structured error details", async () => {
  const core = makeCoreStub();
  core.updatePlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_MISMATCH",
      message: "Playlist does not belong to the active write channel",
      details: {
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannelId: "UC_OTHER",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistUpdate({
    playlistId: "p-update",
    expectedChannelId: "UC_ACTIVE",
    description: "Updated description",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.match(payload.error.message, /does not belong to the active write channel/);
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_ACTIVE",
    activeWriteChannelId: "UC_OTHER",
  });
});

test("MCP playlist_delete fails closed on unresolved channel with stable details", async () => {
  const core = makeCoreStub();
  core.deletePlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_UNRESOLVED",
      message: "Cannot resolve active write channel for the current OAuth session",
      details: {
        expectedChannelId: "UC_ACTIVE",
      },
    });
  };

  const handlers = createMcpToolHandlers(core, makeAuthStub());
  const result = await handlers.playlistDelete({
    playlistId: "p-delete",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "WRITE_CHANNEL_UNRESOLVED");
  assert.deepEqual(payload.error.details, {
    expectedChannelId: "UC_ACTIVE",
  });
});

// Phase 7 slice 1 (docs/roadmap/plans/PHASE_7_PLAN.md): changeset_list, changeset_get,
// localization_import_preview, batch_list, batch_get. All five are read/propose-only --
// no test here needs device-lock setup, since none of them are wrapped by
// wrapMcpHandlersWithMutationGate's assertMcpDeviceAvailable() gate.

function makeChangeSet(overrides: Partial<import("@/lib/changesets/contracts").ChangeSet> = {}) {
  return {
    id: "cs-1",
    channelId: "UC_1",
    source: "xlsx_import" as const,
    status: "in_review" as const,
    importedFilename: "export.xlsx",
    schemaVersion: "1",
    exportedAt: "2026-09-01T00:00:00.000Z",
    hasInvalid: false,
    hasConflicts: false,
    totalChanges: 1,
    pendingCount: 1,
    approvedCount: 0,
    rejectedCount: 0,
    conflictCount: 0,
    invalidCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeChange(overrides: Partial<import("@/lib/changesets/contracts").Change> = {}) {
  return {
    id: "chg-1",
    changeSetId: "cs-1",
    videoId: "v1",
    language: "es",
    field: "title" as const,
    baselineValue: "Before",
    proposedValue: "After",
    changeType: "modify" as const,
    validationStatus: "valid" as const,
    validationError: null,
    conflictStatus: "none" as const,
    approvalStatus: "pending" as const,
    approvedValue: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBatch(overrides: Partial<import("@/lib/batches/contracts").Batch> = {}) {
  return {
    id: "batch-1",
    channelId: "UC_1",
    status: "PENDING" as const,
    concurrency: 1,
    dryRun: true,
    runId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeLedgerRow(overrides: Partial<import("@/lib/batches/contracts").LedgerRow> = {}) {
  return {
    id: "row-1",
    batchId: "batch-1",
    videoId: "v1",
    changeIds: ["chg-1"],
    status: "PENDING" as const,
    error: null,
    verificationResult: null,
    activeAttemptId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeOperationsCoreStub(): Pick<
  ChangeSetCore,
  "listChangeSets" | "getChangeSet" | "previewImport" | "createChangeSetFromImport"
> &
  Pick<BatchCore, "listBatchesByChannel" | "requireBatchForChannel" | "listLedgerRows"> {
  return {
    listChangeSets: async () => [makeChangeSet()],
    getChangeSet: async () => ({
      changeSet: makeChangeSet(),
      changes: [makeChange()],
      pagination: { page: 1, pageSize: 50, total: 1 },
    }),
    createChangeSetFromImport: async () => ({
      changeSet: makeChangeSet(),
      summary: {
        videosFound: 1,
        localizationRows: 1,
        validChanges: 1,
        unchangedValues: 0,
        invalidRows: 0,
        conflicts: 0,
      },
      errors: [],
      totalErrors: 0,
    }),
    previewImport: async () => ({
      summary: {
        videosFound: 1,
        localizationRows: 1,
        validChanges: 1,
        unchangedValues: 0,
        invalidRows: 0,
        conflicts: 0,
      },
      errors: [],
      totalErrors: 0,
    }),
    listBatchesByChannel: async () => [makeBatch()],
    requireBatchForChannel: async () => makeBatch(),
    listLedgerRows: async () => [makeLedgerRow()],
  };
}

// Permissive by default -- these existing tests exercise pre-existing behaviors
// (validation, DomainError propagation, requireBatchForChannel ownership) unrelated to the
// active-channel read-scoping check itself (RISK-02, docs/decisions/0004). Dedicated
// CHANNEL_NOT_ACTIVE tests below use a restrictive stub instead.
function makeChannelAccessCoreStub(): Pick<
  ChannelAccessCore,
  "assertActiveChannel" | "getActiveChannelId" | "filterToActiveChannel" | "activateChannel"
> {
  return {
    assertActiveChannel: async (args: { channelId: string }) => args.channelId,
    getActiveChannelId: async () => "UC_1",
    filterToActiveChannel: (items) => [...items],
    activateChannel: async () => undefined,
  };
}

test("MCP changeset_list returns change sets for a channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.changesetList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.changeSets.length, 1);
  assert.equal(payload.changeSets[0].id, "cs-1");
});

test("MCP changeset_list rejects a missing channelId before calling the core", async () => {
  let called = false;
  const operationsCore = makeOperationsCoreStub();
  operationsCore.listChangeSets = async () => {
    called = true;
    return [];
  };

  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), operationsCore);
  const result = await handlers.changesetList({});

  assert.equal(result.isError, true);
  assert.equal(called, false);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP changeset_get returns a change set with its changes", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.changesetGet({ channelId: "UC_1", changeSetId: "cs-1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.changeSet.id, "cs-1");
  assert.equal(payload.changes.length, 1);
});

test("MCP changeset_get propagates a not_found DomainError unchanged", async () => {
  const operationsCore = makeOperationsCoreStub();
  operationsCore.getChangeSet = async () => {
    throw new DomainError({
      code: "not_found",
      message: "Change Set not found for this channel",
      details: { changeSetId: "missing" },
    });
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.changesetGet({ channelId: "UC_1", changeSetId: "missing" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "not_found");
  assert.deepEqual(payload.error.details, { changeSetId: "missing" });
});

test("MCP localization_import_preview decodes base64 and forwards the exact bytes to previewImport", async () => {
  const original = "title,description\nHello,World\n";
  const fileBase64 = Buffer.from(original, "utf8").toString("base64");

  const captured: { buffer?: Buffer } = {};
  const operationsCore = makeOperationsCoreStub();
  operationsCore.previewImport = async (input: unknown) => {
    captured.buffer = (input as { buffer: Buffer }).buffer;
    return {
      summary: { videosFound: 0, localizationRows: 0, validChanges: 0, unchangedValues: 0, invalidRows: 0, conflicts: 0 },
      errors: [],
      totalErrors: 0,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.localizationImportPreview({
    channelId: "UC_1",
    filename: "export.xlsx",
    fileBase64,
  });

  assert.equal(result.isError, undefined);
  assert.ok(captured.buffer);
  assert.equal(captured.buffer?.toString("utf8"), original);
});

test("MCP localization_import_preview rejects input missing fileBase64", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), makeOperationsCoreStub());
  const result = await handlers.localizationImportPreview({
    channelId: "UC_1",
    filename: "export.xlsx",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP batch_list returns batches for a channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.batchList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.batches.length, 1);
  assert.equal(payload.batches[0].id, "batch-1");
});

test("MCP batch_get verifies channel ownership via requireBatchForChannel, not a bare getBatch", async () => {
  const seenArgs: unknown[] = [];
  const operationsCore = makeOperationsCoreStub();
  operationsCore.requireBatchForChannel = async (channelId: string, batchId: string) => {
    seenArgs.push([channelId, batchId]);
    return makeBatch();
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.batchGet({ channelId: "UC_1", batchId: "batch-1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(seenArgs, [["UC_1", "batch-1"]]);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.batch.id, "batch-1");
  assert.equal(payload.ledgerRows.length, 1);
});

test("MCP batch_get fails closed when the batch does not belong to the given channel", async () => {
  const operationsCore = makeOperationsCoreStub();
  operationsCore.requireBatchForChannel = async () => {
    throw new DomainError({
      code: "not_found",
      message: "Batch does not belong to this channel",
      details: { batchId: "batch-1" },
    });
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.batchGet({ channelId: "UC_OTHER", batchId: "batch-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "not_found");
});

// Owner's requirement (2026-09-20, docs/decisions/0004): every channel-scoped read must be
// rejected when the requested channelId is not this session's active channel.
function makeInactiveChannelAccessCoreStub(): Pick<
  ChannelAccessCore,
  "assertActiveChannel" | "getActiveChannelId" | "filterToActiveChannel" | "activateChannel"
> {
  return {
    assertActiveChannel: async (args: { channelId: string }) => {
      throw new DomainError({
        code: "CHANNEL_NOT_ACTIVE",
        message: "The requested channel is not this session's currently active channel.",
        details: { channelId: args.channelId, activeChannelId: null },
      });
    },
    getActiveChannelId: async () => null,
    filterToActiveChannel: () => [],
    activateChannel: async () => undefined,
  };
}

test("MCP changeset_list rejects a channelId that is not the caller's active channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeInactiveChannelAccessCoreStub()
  );
  const result = await handlers.changesetList({ channelId: "UC_1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP batch_get rejects a channelId that is not the caller's active channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeInactiveChannelAccessCoreStub()
  );
  const result = await handlers.batchGet({ channelId: "UC_1", batchId: "batch-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

// BL-008 (docs/roadmap/BACKLOG.md): channel_sync, channel_list, channel_video_list.
// channel_sync writes to the local channels/videos tables, so -- unlike the Phase 7
// slice 1 tools above -- it IS wrapped by the device-availability mutation gate;
// channel_list/channel_video_list are pure reads and are not.

function makeSyncedChannel(overrides: Record<string, unknown> = {}) {
  return {
    channelId: "UC_1",
    title: "Channel 1",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_1",
    connectedUserId: "active-user",
    connectedAt: "2026-09-01T00:00:00.000Z",
    lastSyncedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeChannelSyncCoreStub(): Pick<
  ChannelSyncCore,
  "syncChannel" | "listChannels" | "listSyncedVideos"
> {
  return {
    syncChannel: async () => ({
      channel: makeSyncedChannel(),
      videoCount: 1,
      syncedAt: "2026-09-01T00:00:00.000Z",
    }),
    listChannels: async () => ({ channels: [makeSyncedChannel()] }),
    listSyncedVideos: async () => ({ channelId: "UC_1", videos: [] }),
  };
}

test("MCP channel_sync forwards the resolved credentialRef and channelId", async () => {
  const seenArgs: unknown[] = [];
  const channelSyncCore = makeChannelSyncCoreStub();
  channelSyncCore.syncChannel = async (input: unknown) => {
    seenArgs.push(input);
    return { channel: makeSyncedChannel(), videoCount: 1, syncedAt: "2026-09-01T00:00:00.000Z" };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    { ...makeOperationsCoreStub() },
    channelSyncCore
  );
  const result = await handlers.channelSync({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(seenArgs, [{ channelId: "UC_1", credentialRef: { userId: "active-user" } }]);
});

test("MCP channel_list returns locally synchronized channels", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    makeChannelSyncCoreStub()
  );
  const result = await handlers.channelList({});

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.channels.length, 1);
  assert.equal(payload.channels[0].channelId, "UC_1");
});

test("MCP channel_video_list returns synced videos for a channel", async () => {
  const channelSyncCore = makeChannelSyncCoreStub();
  channelSyncCore.listSyncedVideos = async () => ({
    channelId: "UC_1",
    videos: [
      {
        videoId: "v1",
        channelId: "UC_1",
        title: "Video 1",
        description: "Desc",
        publishedAt: "2026-09-01T00:00:00.000Z",
        privacyStatus: "private",
        defaultLanguage: null,
        defaultAudioLanguage: null,
        thumbnails: {},
        existingLocalizations: {},
        existingLocalizationLanguages: [],
        lastSyncedAt: "2026-09-01T00:00:00.000Z",
        etag: null,
        viewCount: null,
        commentCount: null,
        likeCount: null,
      },
    ],
  });

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    channelSyncCore
  );
  const result = await handlers.channelVideoList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.videos.length, 1);
  assert.equal(payload.videos[0].videoId, "v1");
});

test("MCP channel_video_list rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    makeChannelSyncCoreStub()
  );
  const result = await handlers.channelVideoList({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP channel_sync is rejected while the operation lock is held; channel_list is not", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      makeChannelSyncCoreStub()
    );

    const syncResult = await handlers.channelSync({});
    assert.equal(syncResult.isError, true);
    const syncBody = JSON.parse(syncResult.content[0]?.text ?? "{}");
    assert.equal(syncBody.error.code, "operation_lock_held");

    const listResult = await handlers.channelList({});
    assert.notEqual(listResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Correction to an earlier (wrong) answer given to the project owner: creating a Change
// Set from an import is local-only persistence, the same risk tier as
// localization_import_preview, NOT blocked by Gate B (which only concerns real YouTube
// writes). It DOES mutate local state, though, so it is gated like channel_sync --
// unlike localization_import_preview, which is not.

test("MCP changeset_create_from_import decodes base64 and persists via createChangeSetFromImport", async () => {
  const original = "title,description\nHello,World\n";
  const fileBase64 = Buffer.from(original, "utf8").toString("base64");

  const captured: { buffer?: Buffer } = {};
  const operationsCore = makeOperationsCoreStub();
  operationsCore.createChangeSetFromImport = async (input: unknown) => {
    captured.buffer = (input as { buffer: Buffer }).buffer;
    return {
      changeSet: makeChangeSet(),
      summary: { videosFound: 1, localizationRows: 1, validChanges: 1, unchangedValues: 0, invalidRows: 0, conflicts: 0 },
      errors: [],
      totalErrors: 0,
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    operationsCore,
    undefined,
    makeChannelAccessCoreStub()
  );
  const result = await handlers.changesetCreateFromImport({
    channelId: "UC_1",
    filename: "export.xlsx",
    fileBase64,
  });

  assert.equal(result.isError, undefined);
  assert.equal(captured.buffer?.toString("utf8"), original);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.changeSet.id, "cs-1");
});

test("MCP changeset_create_from_import is rejected while the operation lock is held; changeset_list is not", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub()
    );

    const createResult = await handlers.changesetCreateFromImport({
      channelId: "UC_1",
      filename: "export.xlsx",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    assert.equal(createResult.isError, true);
    const createBody = JSON.parse(createResult.content[0]?.text ?? "{}");
    assert.equal(createBody.error.code, "operation_lock_held");

    const listResult = await handlers.changesetList({ channelId: "UC_1" });
    assert.notEqual(listResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 8 follow-up (docs/roadmap/BACKLOG.md, "machine-readable analytics for operational agents
// to consume") -- analytics_list/analytics_overview. Both are pure reads (analytics_list local,
// analytics_overview a live Analytics API call), so neither is wrapped by the device-availability
// mutation gate, mirroring channel_list/channel_video_list above.

function makeWeeklyReportSummaryFixture() {
  return {
    channelId: "UC_1",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    status: "final",
    generatedAt: "2026-09-21T12:05:00.000Z",
    report: {
      reportFormatVersion: 1,
      channelId: "UC_1",
      weekStartDate: "2026-09-14",
      weekEndDate: "2026-09-20",
      generatedAt: "2026-09-21T12:05:00.000Z",
      status: "final" as const,
      source: "local video_metrics_daily rows for currently-synced videos -- no live YouTube API call" as const,
      metricDefinitions: { views: "Sum of views." },
      syncedVideoTotals: { views: 100, estimatedMinutesWatched: 200, subscribersGained: 3, subscribersLost: 1 },
      previousWeekTotals: { views: 50, estimatedMinutesWatched: 100, subscribersGained: 1, subscribersLost: 0 },
      percentChange: { views: 100, estimatedMinutesWatched: 100, subscribersGained: 200, subscribersLost: null },
      currentWeekDataQuality: { coveredDates: ["2026-09-14"], uncoveredDates: [], tooRecentDates: [], videosWithSkips: [] },
      previousWeekDataQuality: { coveredDates: ["2026-09-07"], uncoveredDates: [], tooRecentDates: [], videosWithSkips: [] },
      topContent: [{ videoId: "v1", title: "Video 1", views: 100 }],
    },
  };
}

function makeAnalyticsCoreStub(): Pick<
  AnalyticsCore,
  | "listMetrics"
  | "getChannelOverview"
  | "getDataQualityReport"
  | "getComparableAgeComparison"
  | "listWeeklyReports"
  | "getWeeklyReport"
> {
  return {
    listMetrics: async () => ({
      channelId: "UC_1",
      rows: [{ videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 100 }],
    }),
    getChannelOverview: async () => ({
      channelId: "UC_1",
      startDate: "2026-08-26",
      endDate: "2026-09-22",
      previousStartDate: "2026-07-29",
      previousEndDate: "2026-08-25",
      daily: [{ date: "2026-08-26", views: 10, estimatedMinutesWatched: 20, subscribersGained: 1, subscribersLost: 0 }],
      currentTotals: { views: 10, estimatedMinutesWatched: 20, subscribersGained: 1, subscribersLost: 0 },
      previousTotals: { views: 5, estimatedMinutesWatched: 10, subscribersGained: 0, subscribersLost: 0 },
    }),
    getDataQualityReport: async () => ({
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      coveredDates: ["2026-09-01", "2026-09-02"],
      uncoveredDates: ["2026-09-03", "2026-09-04", "2026-09-05"],
      tooRecentDates: [],
      videosWithSkips: [{ videoId: "v1", skipCount: 1, lastSkippedAt: "2026-09-05T00:00:00.000Z" }],
    }),
    getComparableAgeComparison: async () => ({
      channelId: "UC_1",
      metricName: "views",
      maxDays: 30,
      videos: [
        {
          videoId: "v1",
          title: "Video 1",
          publishedAt: "2026-09-01T00:00:00.000Z",
          publishDatePacific: "2026-08-31",
          points: [{ dayOffset: 0, value: 10 }],
          cumulativePoints: [{ dayOffset: 0, cumulativeValue: 10 }],
        },
      ],
    }),
    listWeeklyReports: async () => ({ channelId: "UC_1", reports: [makeWeeklyReportSummaryFixture()] }),
    getWeeklyReport: async () => ({ channelId: "UC_1", report: makeWeeklyReportSummaryFixture() }),
  };
}

test("MCP analytics_list forwards the resolved credentialRef and returns locally-collected rows", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.listMetrics = async (input: unknown) => {
    seenArgs.push(input);
    return { channelId: "UC_1", rows: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  const result = await handlers.analyticsList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(seenArgs, [{ channelId: "UC_1", credentialRef: { userId: "active-user" } }]);
});

test("MCP analytics_list forwards optional startDate/endDate/videoId/metricNames filters unchanged", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.listMetrics = async (input: unknown) => {
    seenArgs.push(input);
    return { channelId: "UC_1", rows: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsList({
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-20",
    videoId: "v1",
    metricNames: ["views"],
  });

  assert.deepEqual(seenArgs, [
    {
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-20",
      videoId: "v1",
      metricNames: ["views"],
      credentialRef: { userId: "active-user" },
    },
  ]);
});

test("MCP analytics_list rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsList({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_overview returns channel-level cards/chart data for a date range", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsOverview({
    channelId: "UC_1",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.currentTotals.views, 10);
  assert.equal(payload.previousStartDate, "2026-07-29");
});

test("MCP analytics_overview forwards the resolved credentialRef when omitted", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getChannelOverview = async (input: unknown) => {
    seenArgs.push(input);
    return {
      channelId: "UC_1",
      startDate: "2026-08-26",
      endDate: "2026-09-22",
      previousStartDate: "2026-07-29",
      previousEndDate: "2026-08-25",
      daily: [],
      currentTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
      previousTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsOverview({ channelId: "UC_1", startDate: "2026-08-26", endDate: "2026-09-22" });

  assert.deepEqual(seenArgs, [
    {
      channelId: "UC_1",
      startDate: "2026-08-26",
      endDate: "2026-09-22",
      credentialRef: { userId: "active-user" },
    },
  ]);
});

test("MCP analytics_overview propagates a validation_failed DomainError unchanged (e.g. an inverted date range)", async () => {
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getChannelOverview = async () => {
    throw new DomainError({ code: "validation_failed", message: "period: endDate is before startDate" });
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  const result = await handlers.analyticsOverview({
    channelId: "UC_1",
    startDate: "2026-09-22",
    endDate: "2026-08-26",
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_list/analytics_overview are never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      makeAnalyticsCoreStub()
    );

    const listResult = await handlers.analyticsList({ channelId: "UC_1" });
    assert.notEqual(listResult.isError, true);

    const overviewResult = await handlers.analyticsOverview({
      channelId: "UC_1",
      startDate: "2026-08-26",
      endDate: "2026-09-22",
    });
    assert.notEqual(overviewResult.isError, true);

    const dataQualityResult = await handlers.analyticsDataQuality({
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
    });
    assert.notEqual(dataQualityResult.isError, true);

    const comparableAgeResult = await handlers.analyticsComparableAge({
      channelId: "UC_1",
      videoIds: ["v1", "v2"],
    });
    assert.notEqual(comparableAgeResult.isError, true);

    const weeklyReportsListResult = await handlers.analyticsWeeklyReportsList({ channelId: "UC_1" });
    assert.notEqual(weeklyReportsListResult.isError, true);

    const weeklyReportGetResult = await handlers.analyticsWeeklyReportGet({
      channelId: "UC_1",
      weekStartDate: "2026-09-14",
    });
    assert.notEqual(weeklyReportGetResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP analytics_data_quality returns coverage/skip diagnostics for a date range", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsDataQuality({
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.deepEqual(payload.coveredDates, ["2026-09-01", "2026-09-02"]);
  assert.deepEqual(payload.videosWithSkips, [{ videoId: "v1", skipCount: 1, lastSkippedAt: "2026-09-05T00:00:00.000Z" }]);
});

test("MCP analytics_data_quality forwards the resolved credentialRef when omitted", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getDataQualityReport = async (input: unknown) => {
    seenArgs.push(input);
    return {
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      coveredDates: [],
      uncoveredDates: [],
      tooRecentDates: [],
      videosWithSkips: [],
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsDataQuality({ channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-05" });

  assert.deepEqual(seenArgs, [
    {
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      credentialRef: { userId: "active-user" },
    },
  ]);
});

test("MCP analytics_data_quality rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsDataQuality({ startDate: "2026-09-01", endDate: "2026-09-05" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_comparable_age returns per-video day-since-publish series for a channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsComparableAge({ channelId: "UC_1", videoIds: ["v1", "v2"] });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.metricName, "views");
  assert.deepEqual(payload.videos[0].points, [{ dayOffset: 0, value: 10 }]);
});

test("MCP analytics_comparable_age forwards the resolved credentialRef when omitted", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getComparableAgeComparison = async (input: unknown) => {
    seenArgs.push(input);
    return { channelId: "UC_1", metricName: "views", maxDays: 30, videos: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsComparableAge({ channelId: "UC_1", videoIds: ["v1", "v2"] });

  assert.deepEqual(seenArgs, [
    {
      channelId: "UC_1",
      videoIds: ["v1", "v2"],
      metricName: "views",
      maxDays: 30,
      credentialRef: { userId: "active-user" },
    },
  ]);
});

test("MCP analytics_comparable_age rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsComparableAge({ videoIds: ["v1", "v2"] });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_comparable_age rejects fewer than 2 videoIds", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsComparableAge({ channelId: "UC_1", videoIds: ["v1"] });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_weekly_reports_list returns stored snapshot summaries for a channel", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsWeeklyReportsList({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.reports[0].weekStartDate, "2026-09-14");
  assert.equal(payload.reports[0].status, "final");
});

test("MCP analytics_weekly_reports_list forwards the resolved credentialRef when omitted", async () => {
  const seenArgs: unknown[] = [];
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.listWeeklyReports = async (input: unknown) => {
    seenArgs.push(input);
    return { channelId: "UC_1", reports: [] };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  await handlers.analyticsWeeklyReportsList({ channelId: "UC_1" });

  assert.deepEqual(seenArgs, [{ channelId: "UC_1", credentialRef: { userId: "active-user" } }]);
});

test("MCP analytics_weekly_reports_list rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsWeeklyReportsList({});

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP analytics_weekly_report_get returns null report when none exists for the requested week", async () => {
  const analyticsCore = makeAnalyticsCoreStub();
  analyticsCore.getWeeklyReport = async () => ({ channelId: "UC_1", report: null });

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    analyticsCore
  );
  const result = await handlers.analyticsWeeklyReportGet({ channelId: "UC_1", weekStartDate: "2026-09-14" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.report, null);
});

test("MCP analytics_weekly_report_get rejects a missing weekStartDate", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    makeAnalyticsCoreStub()
  );
  const result = await handlers.analyticsWeeklyReportGet({ channelId: "UC_1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

function makeAiLocalizationCoreStub(): Pick<AiLocalizationCore, "generateProposals" | "createChangeSetFromGeneration"> {
  return {
    generateProposals: async () => ({
      results: [
        {
          videoId: "v1",
          language: "es",
          providerError: null,
          fields: [
            {
              videoId: "v1",
              language: "es",
              field: "title",
              baselineValue: "Old title",
              proposedValue: "Nuevo titulo",
              changeType: "modify",
              validationStatus: "valid",
              validationError: null,
            },
          ],
          usage: null,
        },
      ],
      errors: [],
      summary: {
        targetsRequested: 1,
        targetsGenerated: 1,
        targetsFailed: 0,
        validProposals: 1,
        invalidProposals: 0,
        unchangedProposals: 0,
      },
      generationContext: { profileVersion: null, effectiveContext: null },
    }),
    createChangeSetFromGeneration: async () => makeChangeSet({ source: "ai_localization" }),
  };
}

test("MCP ai_localization_generate forwards input and checks active-channel access", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    makeAiLocalizationCoreStub()
  );
  const result = await handlers.aiLocalizationGenerate({
    channelId: "UC_1",
    videoIds: ["v1"],
    targetLanguages: ["es"],
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.results[0].videoId, "v1");
  assert.equal(payload.summary.validProposals, 1);
});

test("MCP ai_localization_generate rejects a channelId that is not the caller's active channel", async () => {
  const restrictiveChannelAccess: Pick<
    ChannelAccessCore,
    "assertActiveChannel" | "getActiveChannelId" | "filterToActiveChannel" | "activateChannel"
  > = {
    async assertActiveChannel() {
      throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
    },
    async getActiveChannelId() {
      return null;
    },
    filterToActiveChannel(items) {
      return [...items];
    },
    async activateChannel() {},
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    restrictiveChannelAccess,
    undefined,
    makeAiLocalizationCoreStub()
  );
  const result = await handlers.aiLocalizationGenerate({
    channelId: "UC_OTHER",
    videoIds: ["v1"],
    targetLanguages: ["es"],
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP ai_localization_generate rejects a missing channelId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    makeAiLocalizationCoreStub()
  );
  const result = await handlers.aiLocalizationGenerate({ videoIds: ["v1"], targetLanguages: ["es"] });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP ai_localization_create_change_set persists via createChangeSetFromGeneration, source ai_localization", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    makeAiLocalizationCoreStub()
  );
  const result = await handlers.aiLocalizationCreateChangeSet({
    channelId: "UC_1",
    proposals: [{ videoId: "v1", language: "es", title: "Nuevo titulo" }],
  });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.source, "ai_localization");
});

test("MCP ai_localization_create_change_set is rejected while the operation lock is held; ai_localization_generate is not", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      makeAiLocalizationCoreStub()
    );

    const generateResult = await handlers.aiLocalizationGenerate({
      channelId: "UC_1",
      videoIds: ["v1"],
      targetLanguages: ["es"],
    });
    assert.equal(generateResult.isError, undefined);

    const createResult = await handlers.aiLocalizationCreateChangeSet({
      channelId: "UC_1",
      proposals: [{ videoId: "v1", language: "es", title: "Nuevo titulo" }],
    });
    assert.equal(createResult.isError, true);
    const payload = JSON.parse(createResult.content[0]?.text ?? "{}");
    assert.equal(payload.error.code, "operation_lock_held");
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP ai_localization_create_change_set rejects an empty proposals array", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    makeAiLocalizationCoreStub()
  );
  const result = await handlers.aiLocalizationCreateChangeSet({ channelId: "UC_1", proposals: [] });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_get_capabilities returns version/capabilities/permission-model with no channel scoping required", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined
  );
  const result = await handlers.agentGetCapabilities({});

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.agentApiVersion, "0.3.0");
  assert.deepEqual(payload.grantedPermissions, ["READ", "DRAFT"]);
  assert.ok(payload.capabilities.some((c: { id: string }) => c.id === "system.get_capabilities"));
});

test("MCP agent_get_capabilities rejects an unexpected input field", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined
  );
  const result = await handlers.agentGetCapabilities({ unexpected: true });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_get_capabilities is never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined
    );
    const result = await handlers.agentGetCapabilities({});
    assert.notEqual(result.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

function makeAgentOperationsCoreStub(): Pick<
  AgentOperationsCore,
  "getSystemCapabilities" | "getChannelContext" | "getVideoContext" | "queryChannelAnalytics" | "queryVideoAnalytics"
> {
  return {
    getSystemCapabilities: async () => ({
      productVersion: "9.9.9",
      agentApiVersion: "0.1.0",
      capabilities: [],
      dataDomains: [],
      actionClasses: ["READ", "DRAFT", "APPROVE", "EXECUTE"],
      grantedPermissions: ["READ", "DRAFT"],
      plannedFutureCapabilities: ["query_market_intelligence", "query_competitors", "create_experiment_proposal"],
      schemaVersions: { app: 14 },
    }),
    getChannelContext: async () => ({
      channelId: "UC_1",
      title: "Test Channel",
      lastSyncedAt: "2026-09-20T00:00:00.000Z",
      syncedVideoCount: 5,
      editorialProfile: null,
      trackedLanguages: ["es"],
    }),
    getVideoContext: async () => ({
      videoId: "v1",
      channelId: "UC_1",
      includedSections: ["metadata", "localizations"],
      metadata: {
        videoId: "v1",
        channelId: "UC_1",
        title: "Title",
        description: "Description",
        publishedAt: "2026-09-01T00:00:00Z",
        privacyStatus: "public",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
        lastSyncedAt: "2026-09-20T00:00:00.000Z",
      },
      localizations: [],
    }),
    queryChannelAnalytics: async () => ({
      channelId: "UC_1",
      period: { startDate: "2026-09-01", endDate: "2026-09-07", previousStartDate: "2026-08-25", previousEndDate: "2026-08-31" },
      metricDefinitions: [{ name: "views", description: "Number of times the video was viewed.", unit: "count" }],
      freshness: { source: "live_youtube_analytics_api", asOf: "2026-09-24T12:00:00.000Z", note: "..." },
      daily: [],
      currentTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
      previousTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
    }),
    queryVideoAnalytics: async () => ({
      channelId: "UC_1",
      period: { startDate: null, endDate: null },
      filters: { videoId: null, metricNames: null },
      metricDefinitions: [{ name: "views", description: "Number of times the video was viewed.", unit: "count" }],
      freshness: { source: "local_collected_data", asOf: "2026-09-24T12:00:00.000Z", note: "..." },
      rows: [],
    }),
  };
}

test("MCP agent_get_channel_context forwards input and checks active-channel access", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    makeAgentOperationsCoreStub()
  );
  const result = await handlers.agentGetChannelContext({ channelId: "UC_1" });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.channelId, "UC_1");
  assert.equal(payload.syncedVideoCount, 5);
});

function makeRestrictiveChannelAccessStub() {
  return {
    async assertActiveChannel() {
      throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
    },
    async getActiveChannelId() {
      return null;
    },
    filterToActiveChannel<T>(items: readonly T[]) {
      return [...items];
    },
    async activateChannel() {},
  };
}

test("MCP agent_get_channel_context rejects a channelId that is not the caller's active channel", async () => {
  // Uses a "must not be called" stub, not the ordinary makeAgentOperationsCoreStub(), so this
  // test proves the service is genuinely never reached on a channel-scoping failure -- not just
  // that the tool call ends in an error (found by independent review, 2026-09-24).
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    "getSystemCapabilities" | "getChannelContext" | "getVideoContext" | "queryChannelAnalytics" | "queryVideoAnalytics"
  > = {
    ...makeAgentOperationsCoreStub(),
    getChannelContext: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetChannelContext({ channelId: "UC_OTHER" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_get_video_context forwards input including optional `include`, checks active-channel access", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.getVideoContext = async (input: unknown) => {
    captured = input;
    return {
      videoId: "v1",
      channelId: "UC_1",
      includedSections: ["metadata"],
      metadata: {
        videoId: "v1",
        channelId: "UC_1",
        title: "Title",
        description: "Description",
        publishedAt: "2026-09-01T00:00:00Z",
        privacyStatus: "public",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
        lastSyncedAt: "2026-09-20T00:00:00.000Z",
      },
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  await handlers.agentGetVideoContext({ channelId: "UC_1", videoId: "v1", include: ["metadata"] });

  assert.deepEqual(captured, { channelId: "UC_1", videoId: "v1", include: ["metadata"] });
});

test("MCP agent_get_video_context rejects a channelId that is not the caller's active channel", async () => {
  const agentOperationsCore: Pick<
    AgentOperationsCore,
    "getSystemCapabilities" | "getChannelContext" | "getVideoContext" | "queryChannelAnalytics" | "queryVideoAnalytics"
  > = {
    ...makeAgentOperationsCoreStub(),
    getVideoContext: async () => {
      throw new Error("must not be called");
    },
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeRestrictiveChannelAccessStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentGetVideoContext({ channelId: "UC_OTHER", videoId: "v1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "CHANNEL_NOT_ACTIVE");
});

test("MCP agent_get_video_context rejects a missing videoId", async () => {
  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    makeAgentOperationsCoreStub()
  );
  const result = await handlers.agentGetVideoContext({ channelId: "UC_1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "validation_failed");
});

test("MCP agent_get_channel_context/agent_get_video_context are never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const channelResult = await handlers.agentGetChannelContext({ channelId: "UC_1" });
    assert.notEqual(channelResult.isError, true);
    const videoResult = await handlers.agentGetVideoContext({ channelId: "UC_1", videoId: "v1" });
    assert.notEqual(videoResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("MCP agent_query_channel_analytics forwards the resolved credentialRef and the caller's own input unchanged into queryChannelAnalytics", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.queryChannelAnalytics = async (input: unknown) => {
    captured = input;
    return {
      channelId: "UC_1",
      period: { startDate: "2026-09-01", endDate: "2026-09-07", previousStartDate: "2026-08-25", previousEndDate: "2026-08-31" },
      metricDefinitions: [],
      freshness: { source: "live_youtube_analytics_api", asOf: "2026-09-24T12:00:00.000Z", note: "..." },
      daily: [],
      currentTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
      previousTotals: { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 },
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentQueryChannelAnalytics({ channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-07" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, {
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    credentialRef: { userId: "active-user" },
  });
});

test("MCP agent_query_video_analytics forwards the resolved credentialRef and optional filters unchanged into queryVideoAnalytics", async () => {
  const agentOperationsCore = makeAgentOperationsCoreStub();
  let captured: unknown;
  agentOperationsCore.queryVideoAnalytics = async (input: unknown) => {
    captured = input;
    return {
      channelId: "UC_1",
      period: { startDate: null, endDate: null },
      filters: { videoId: "v1", metricNames: ["views"] },
      metricDefinitions: [],
      freshness: { source: "local_collected_data", asOf: "2026-09-24T12:00:00.000Z", note: "..." },
      rows: [],
    };
  };

  const handlers = createMcpToolHandlers(
    makeCoreStub(),
    makeAuthStub(),
    makeOperationsCoreStub(),
    undefined,
    makeChannelAccessCoreStub(),
    undefined,
    undefined,
    agentOperationsCore
  );
  const result = await handlers.agentQueryVideoAnalytics({ channelId: "UC_1", videoId: "v1", metricNames: ["views"] });

  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, {
    channelId: "UC_1",
    videoId: "v1",
    metricNames: ["views"],
    credentialRef: { userId: "active-user" },
  });
});

test("MCP agent_query_channel_analytics/agent_query_video_analytics are never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const handlers = createMcpToolHandlers(
      makeCoreStub(),
      makeAuthStub(),
      makeOperationsCoreStub(),
      undefined,
      makeChannelAccessCoreStub(),
      undefined,
      undefined,
      makeAgentOperationsCoreStub()
    );
    const channelResult = await handlers.agentQueryChannelAnalytics({ channelId: "UC_1", startDate: "2026-09-01", endDate: "2026-09-07" });
    assert.notEqual(channelResult.isError, true);
    const videoResult = await handlers.agentQueryVideoAnalytics({ channelId: "UC_1" });
    assert.notEqual(videoResult.isError, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});
