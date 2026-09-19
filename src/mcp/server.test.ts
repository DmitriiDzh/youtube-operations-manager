import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/video-metadata/contracts";
import type { VideoMetadataCore } from "@/lib/video-metadata";
import type { PlaylistManagementCore } from "@/lib/playlist-management";
import type { ChangeSetCore } from "@/lib/changesets";
import type { BatchCore } from "@/lib/batches";
import type { ChannelSyncCore } from "@/lib/channel-sync";
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
  const server = createMcpServer(makeCoreStub());
  const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;

  assert.equal(Boolean(tools?.auth_user_select), true);
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
  "listChangeSets" | "getChangeSet" | "previewImport"
> &
  Pick<BatchCore, "listBatchesByChannel" | "requireBatchForChannel" | "listLedgerRows"> {
  return {
    listChangeSets: async () => [makeChangeSet()],
    getChangeSet: async () => ({
      changeSet: makeChangeSet(),
      changes: [makeChange()],
      pagination: { page: 1, pageSize: 50, total: 1 },
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

test("MCP changeset_list returns change sets for a channel", async () => {
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), makeOperationsCoreStub());
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
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), makeOperationsCoreStub());
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

  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), operationsCore);
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

  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), operationsCore);
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
  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), makeOperationsCoreStub());
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

  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), operationsCore);
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

  const handlers = createMcpToolHandlers(makeCoreStub(), makeAuthStub(), operationsCore);
  const result = await handlers.batchGet({ channelId: "UC_OTHER", batchId: "batch-1" });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.error.code, "not_found");
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
