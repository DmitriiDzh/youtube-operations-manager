import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/video-metadata/contracts";
import type { VideoMetadataCore } from "@/lib/video-metadata";
import type { PlaylistManagementCore } from "@/lib/playlist-management";
import { runCliCommand } from "./video-metadata";

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
      return {
        videos: [
          { videoId: "v1", title: "Title", description: "Desc", publishedAt: "2024-01-01" },
        ],
      };
    },
    getTranscript: async (input: unknown) => {
      void input;
      return { transcript: { status: "available" as const, text: "Transcript" } };
    },
    previewMetadata: async (input: unknown) => {
      void input;
      return {
        video: { videoId: "v1", title: "Title", description: "Desc", publishedAt: "2024-01-01" },
        transcript: { status: "available" as const, text: "Transcript" },
        draft: { finalTitle: "New title", description: "New description", promptVersion: "v1" },
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
          before: { title: "Title", description: "Desc", categoryId: "22" },
          proposed: { title: "New title", description: "New description", categoryId: "22" },
        },
        localizations: {
          before: {
            es: { title: "Título", description: "Descripción" },
            en: { title: "Title EN", description: "Desc EN" },
          },
          proposed: {
            es: { title: "New title", description: "New description" },
            en: { title: "Title EN", description: "Desc EN" },
          },
          affected: [
            {
              locale: "es",
              before: { title: "Título", description: "Descripción" },
              proposed: { title: "New title", description: "New description" },
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
    createPlaylist: async () => ({
      playlist: {
        id: "p1",
        title: "Playlist 1",
        description: "Playlist description",
        privacyStatus: "private" as const,
      },
    }),
    updatePlaylist: async () => ({
      playlist: {
        id: "p1",
        title: "Playlist 1",
        description: "Playlist description",
        privacyStatus: "private" as const,
      },
    }),
    deletePlaylist: async () => ({
      deleted: true,
      playlistId: "p1",
    }),
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
    login: async () => ({ method: "loopback", user: { userId: "u1", email: "u1@example.com" } }),
    loginDevice: async () => ({ method: "device", user: { userId: "u1", email: "u1@example.com" } }),
    whoami: async () => ({
      userId: "u1",
      email: "u1@example.com",
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
      effectiveCredentialRef: { userId: "u1" },
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
      knownChannels: [
        {
          id: "UC_ACTIVE",
          title: "Active channel",
          source: "active",
          isActive: true,
          isSelected: false,
        },
        {
          id: channelId,
          title: null,
          source: "selected",
          isActive: false,
          isSelected: true,
        },
      ],
      requiresReauth: true,
      message: "Selected expected channel does not match the active OAuth channel.",
      recommendedAction: "Reauthenticate with the expected channel or select the active channel.",
    }),
    listUsers: async () => ({
      users: [
        {
          userId: "u1",
          email: "u1@example.com",
          name: null,
          tokenExpiry: null,
          hasRefreshToken: true,
          isActive: true,
        },
      ],
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
      previousActiveUserId: "u1",
      changed: userId !== "u1",
      effectiveCredentialRef: { userId },
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
        ],
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
    logout: async () => ({ loggedOut: true }),
    revoke: async ({ userId }: { userId?: string }) => ({
      revoked: true,
      userId: userId ?? "u1",
      clearedActive: true,
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
      before: { title: "Title", description: "Desc", categoryId: "22" },
      proposed: { title: "Draft", description: "Draft desc", categoryId: "22" },
    },
    localizations: {
      before: {
        es: { title: "Título", description: "Descripción" },
      },
      proposed: {
        es: { title: "Draft", description: "Draft desc" },
      },
      affected: [
        {
          locale: "es",
          before: { title: "Título", description: "Descripción" },
          proposed: { title: "Draft", description: "Draft desc" },
          source: "defaultLanguage" as const,
        },
      ],
    },
  };
}

test("CLI list command calls core listVideos and returns structured JSON", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  const stdout: string[] = [];
  const stderr: string[] = [];

  core.listVideos = async (input: unknown) => {
    capturedInput = input;
    return {
      videos: [
        { videoId: "v1", title: "Title", description: "Desc", publishedAt: "2024-01-01" },
      ],
    };
  };

  const exitCode = await runCliCommand({
    argv: ["list", "--userId", "user-1", "--maxResults", "5"],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.length, 0);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "user-1" },
    maxResults: 5,
  });

  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
  assert.equal(Array.isArray(envelope.data.videos), true);
  assert.equal(envelope.data.videos[0].videoId, "v1");
});

test("CLI list forwards explicit channelId when provided", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();

  core.listVideos = async (input: unknown) => {
    capturedInput = input;
    return { videos: [] };
  };

  const exitCode = await runCliCommand({
    argv: [
      "list",
      "--channelId",
      "IscmdXDtypp2zTzEEYxJwg",
      "--maxResults",
      "5",
    ],
    core,
    auth: makeAuthStub(),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "active-user" },
    channelId: "IscmdXDtypp2zTzEEYxJwg",
    maxResults: 5,
  });
});

test("CLI metadata commands fallback to active auth context when --userId is omitted", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  const stdout: string[] = [];

  core.listVideos = async (input: unknown) => {
    capturedInput = input;
    return { videos: [] };
  };

  const exitCode = await runCliCommand({
    argv: ["list"],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(capturedInput, { credentialRef: { userId: "active-user" }, maxResults: undefined });

  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
});

test("CLI returns validation error and non-zero exit for missing required flags", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCliCommand({
    argv: ["transcript", "--userId", "user-1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.length, 0);

  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /Missing required --videoId/);
});

test("CLI transcript keeps stable envelope and propagates diagnostic unchanged", async () => {
  const core = makeCoreStub();
  const stdout: string[] = [];

  core.getTranscript = async () => ({
    transcript: {
      status: "unavailable",
      reason: "rate-limited",
      diagnostic: {
        stage: "captions-list",
        httpStatus: 429,
        apiReason: "ratelimitexceeded",
        retriable: true,
      },
    },
  });

  const exitCode = await runCliCommand({
    argv: ["transcript", "--videoId", "v1"],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.transcript, {
    status: "unavailable",
    reason: "rate-limited",
    diagnostic: {
      stage: "captions-list",
      httpStatus: 429,
      apiReason: "ratelimitexceeded",
      retriable: true,
    },
  });
});

test("CLI apply dry-run forwards dryRun=true and returns proposal", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  const stdout: string[] = [];

  core.applyMetadata = async (input: unknown) => {
    capturedInput = input;
    return {
      dryRun: true,
      videoId: "v1",
      targetLanguage: "es",
      languageSource: "defaultLanguage" as const,
      snippet: {
        before: { title: "Title", description: "Desc", categoryId: "22" },
        proposed: { title: "Draft", description: "Draft desc", categoryId: "22" },
      },
      localizations: {
        before: {
          es: { title: "Título", description: "Descripción" },
        },
        proposed: {
          es: { title: "Draft", description: "Draft desc" },
        },
        affected: [
          {
            locale: "es",
            before: { title: "Título", description: "Descripción" },
            proposed: { title: "Draft", description: "Draft desc" },
            source: "defaultLanguage" as const,
          },
        ],
      },
    };
  };

  const exitCode = await runCliCommand({
    argv: [
      "apply",
      "--userId",
      "user-1",
      "--videoId",
      "v1",
      "--finalTitle",
      "Draft",
      "--description",
      "Draft desc",
      "--expectedChannelId",
      "UC_ACTIVE",
      "--dryRun",
    ],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(capturedInput, {
    credentialRef: { userId: "user-1" },
    videoId: "v1",
    finalTitle: "Draft",
    description: "Draft desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });

  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.dryRun, true);
  assert.equal(envelope.data.targetLanguage, "es");
  assert.equal(envelope.data.localizations.affected[0].locale, "es");
});

test("CLI apply keeps payload parity between dryRun and apply", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async (input: unknown) => {
    const request = input as { dryRun?: boolean };
    return makeApplyPayload(request.dryRun === true);
  };

  const dryRunStdout: string[] = [];
  const applyStdout: string[] = [];

  const dryRunExit = await runCliCommand({
    argv: [
      "apply",
      "--videoId",
      "v1",
      "--finalTitle",
      "Draft",
      "--description",
      "Draft desc",
      "--expectedChannelId",
      "UC_ACTIVE",
      "--dryRun",
    ],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => dryRunStdout.push(line),
  });

  const applyExit = await runCliCommand({
    argv: [
      "apply",
      "--videoId",
      "v1",
      "--finalTitle",
      "Draft",
      "--description",
      "Draft desc",
      "--expectedChannelId",
      "UC_ACTIVE",
    ],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => applyStdout.push(line),
  });

  assert.equal(dryRunExit, 0);
  assert.equal(applyExit, 0);

  const dryRunEnvelope = JSON.parse(dryRunStdout[0] ?? "{}");
  const applyEnvelope = JSON.parse(applyStdout[0] ?? "{}");

  assert.equal(dryRunEnvelope.ok, true);
  assert.equal(applyEnvelope.ok, true);
  assert.equal(dryRunEnvelope.data.dryRun, true);
  assert.equal(applyEnvelope.data.dryRun, false);

  const dryRunDataWithoutState = {
    ...(dryRunEnvelope.data as Record<string, unknown>),
  };
  const applyDataWithoutState = {
    ...(applyEnvelope.data as Record<string, unknown>),
  };
  delete dryRunDataWithoutState.dryRun;
  delete applyDataWithoutState.dryRun;
  assert.deepEqual(dryRunDataWithoutState, applyDataWithoutState);
});

test("CLI auth command login calls device flow with --device and stable envelope", async () => {
  const auth = makeAuthStub();
  let loginDeviceCalled = false;
  auth.loginDevice = async () => {
    loginDeviceCalled = true;
    return { method: "device", user: { userId: "u1", email: "u1@example.com" } };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["auth", "login", "--device"],
    core: makeCoreStub(),
    auth,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(loginDeviceCalled, true);

  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.method, "device");
});

test("CLI auth login default uses loopback flow and returns stable success envelope", async () => {
  const auth = makeAuthStub();
  let loginCalled = false;
  let loginDeviceCalled = false;

  auth.login = async () => {
    loginCalled = true;
    return { method: "loopback", user: { userId: "u1", email: "u1@example.com" } };
  };

  auth.loginDevice = async () => {
    loginDeviceCalled = true;
    return { method: "device", user: { userId: "u1", email: "u1@example.com" } };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["auth", "login"],
    core: makeCoreStub(),
    auth,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(loginCalled, true);
  assert.equal(loginDeviceCalled, false);

  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.method, "loopback");
  assert.equal(envelope.data.user.userId, "u1");
});

test("CLI auth supports whoami/list-users/logout/revoke with stable envelopes", async () => {
  const auth = makeAuthStub();
  const stdout: string[] = [];

  for (const argv of [
    ["auth", "whoami"],
    ["auth", "list-users"],
    ["auth", "logout"],
    ["auth", "revoke"],
  ]) {
    const exitCode = await runCliCommand({
      argv,
      core: makeCoreStub(),
      auth,
      writeStdout: (line) => stdout.push(line),
    });
    assert.equal(exitCode, 0);
  }

  for (const line of stdout) {
    const envelope = JSON.parse(line);
    assert.equal(envelope.ok, true);
  }
});

test("CLI auth list-channels returns minimal-safe known channel list", async () => {
  const stdout: string[] = [];

  const exitCode = await runCliCommand({
    argv: ["auth", "list-channels"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.knownChannels.length, 2);
  assert.equal(envelope.data.alignment.requiresReauth, true);
});

test("CLI auth select-channel persists expected channel and returns mismatch guidance", async () => {
  const stdout: string[] = [];

  const exitCode = await runCliCommand({
    argv: ["auth", "select-channel", "--channelId", "UC1111111111111111111111"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.selectedChannelId, "UC1111111111111111111111");
  assert.equal(envelope.data.alignment.status, "mismatch");
  assert.equal(envelope.data.alignment.requiresReauth, true);
  assert.match(envelope.data.message, /does not match the active OAuth channel/i);
});

test("CLI auth select-user switches local fallback identity only", async () => {
  const stdout: string[] = [];

  const exitCode = await runCliCommand({
    argv: ["auth", "select-user", "--userId", "u2"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.activeUser.userId, "u2");
  assert.equal(envelope.data.previousActiveUserId, "u1");
  assert.equal(envelope.data.affectsRemoteOAuth, false);
});

test("CLI auth select-user rejects missing --userId", async () => {
  const stderr: string[] = [];

  const exitCode = await runCliCommand({
    argv: ["auth", "select-user"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /Missing required --userId/);
});

test("CLI auth select-user surfaces AUTH_USER_NOT_FOUND with stable envelope", async () => {
  const stderr: string[] = [];
  const auth = makeAuthStub();
  auth.selectUser = async () => {
    throw new DomainError({
      code: "AUTH_USER_NOT_FOUND",
      message: "Requested auth user does not exist in local storage",
      details: { userId: "missing-user", affectsRemoteOAuth: false },
    });
  };

  const exitCode = await runCliCommand({
    argv: ["auth", "select-user", "--userId", "missing-user"],
    core: makeCoreStub(),
    auth,
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "AUTH_USER_NOT_FOUND");
  assert.deepEqual(envelope.error.details, {
    userId: "missing-user",
    affectsRemoteOAuth: false,
  });
});

test("CLI auth rejects unknown auth subcommand", async () => {
  const stderr: string[] = [];

  const exitCode = await runCliCommand({
    argv: ["auth", "invalid-command"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "validation_failed");
});

test("CLI auth login surfaces AUTH_CALLBACK_INVALID in error envelope", async () => {
  const auth = makeAuthStub();
  auth.login = async () => {
    throw new DomainError({
      code: "AUTH_CALLBACK_INVALID",
      message: "OAuth callback state validation failed",
      details: { reason: "invalid_state_or_code" },
    });
  };

  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["auth", "login"],
    core: makeCoreStub(),
    auth,
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "AUTH_CALLBACK_INVALID");
});

test("CLI auth returns AUTH_REFRESH_TOKEN_MISSING as stable JSON error envelope", async () => {
  const auth = makeAuthStub();
  auth.whoami = async () => {
    throw new DomainError({
      code: "AUTH_REFRESH_TOKEN_MISSING",
      message: "Stored credentials have expired and no refresh token is available",
      details: { userId: "u1" },
    });
  };

  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["auth", "whoami"],
    core: makeCoreStub(),
    auth,
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "AUTH_REFRESH_TOKEN_MISSING");
  assert.equal(envelope.error.message, "Stored credentials have expired and no refresh token is available");
  assert.deepEqual(envelope.error.details, { userId: "u1" });
});

test("CLI auth login --device emits pending verification details to stderr before final stdout", async () => {
  const auth = makeAuthStub();
  const stdout: string[] = [];
  const stderr: string[] = [];

  auth.loginDevice = async ({ onPending }: { onPending?: (data: unknown) => void } = {}) => {
    onPending?.({
      userCode: "USER-CODE",
      verificationUrl: "https://example.com/verify",
      verificationUrlComplete: null,
      deviceCode: "device-code",
      expiresIn: 300,
      interval: 5,
    });

    return { method: "device", user: { userId: "u1", email: "u1@example.com" } };
  };

  const exitCode = await runCliCommand({
    argv: ["auth", "login", "--device"],
    core: makeCoreStub(),
    auth,
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.length, 1);
  assert.equal(stderr.length, 1);

  const pendingEnvelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(pendingEnvelope.ok, true);
  assert.equal(pendingEnvelope.event, "auth_pending");
  assert.equal(pendingEnvelope.data.userCode, "USER-CODE");
  assert.equal(pendingEnvelope.data.verificationUrl, "https://example.com/verify");

  const successEnvelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(successEnvelope.ok, true);
  assert.equal(successEnvelope.data.method, "device");
});

test("CLI transcript/preview/apply fallback to active auth context when --userId is omitted", async () => {
  const auth = makeAuthStub();
  const core = makeCoreStub();

  const captured: Record<string, unknown> = {};

  core.getTranscript = async (input: unknown) => {
    captured.transcript = input;
    return { transcript: { status: "available" as const, text: "Transcript" } };
  };

  core.previewMetadata = async (input: unknown) => {
    captured.preview = input;
    return {
      video: { videoId: "v1", title: "Title", description: "Desc", publishedAt: "2024-01-01" },
      transcript: { status: "available" as const, text: "Transcript" },
      draft: { finalTitle: "New title", description: "New description", promptVersion: "v1" },
    };
  };

  core.applyMetadata = async (input: unknown) => {
    captured.apply = input;
    return {
      dryRun: true,
      videoId: "v1",
      targetLanguage: "es",
      languageSource: "defaultLanguage" as const,
      snippet: {
        before: { title: "Title", description: "Desc", categoryId: "22" },
        proposed: { title: "New title", description: "New description", categoryId: "22" },
      },
      localizations: {
        before: {
          es: { title: "Título", description: "Descripción" },
        },
        proposed: {
          es: { title: "New title", description: "New description" },
        },
        affected: [
          {
            locale: "es",
            before: { title: "Título", description: "Descripción" },
            proposed: { title: "New title", description: "New description" },
            source: "defaultLanguage" as const,
          },
        ],
      },
    };
  };

  for (const argv of [
    ["transcript", "--videoId", "v1"],
    ["preview", "--videoId", "v1", "--editorialPrompt", "rewrite"],
    [
      "apply",
      "--videoId",
      "v1",
      "--finalTitle",
      "Title",
      "--description",
      "Desc",
      "--expectedChannelId",
      "UC_ACTIVE",
      "--dryRun",
    ],
  ]) {
    const exitCode = await runCliCommand({
      argv,
      core,
      auth,
      writeStdout: () => {},
    });
    assert.equal(exitCode, 0);
  }

  assert.deepEqual(captured.transcript, {
    credentialRef: { userId: "active-user" },
    videoId: "v1",
  });

  assert.deepEqual(captured.preview, {
    credentialRef: { userId: "active-user" },
    videoId: "v1",
    editorialPrompt: "rewrite",
  });

  assert.deepEqual(captured.apply, {
    credentialRef: { userId: "active-user" },
    videoId: "v1",
    finalTitle: "Title",
    description: "Desc",
    expectedChannelId: "UC_ACTIVE",
    dryRun: true,
  });
});

test("CLI apply surfaces target-language resolution error as typed envelope", async () => {
  const core = makeCoreStub();
  core.applyMetadata = async () => {
    throw new DomainError({
      code: "target_language_unresolvable",
      message:
        "Cannot resolve target language. Set snippet.defaultLanguage on the video or leave exactly one localization.",
      details: {
        localizationLocales: ["es", "en"],
      },
    });
  };

  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: [
      "apply",
      "--videoId",
      "v1",
      "--finalTitle",
      "Nuevo",
      "--description",
      "Desc",
      "--expectedChannelId",
      "UC_ACTIVE",
      "--dryRun",
    ],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "target_language_unresolvable");
});

test("CLI apply returns guardrail mismatch details with non-zero exit", async () => {
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

  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: [
      "apply",
      "--videoId",
      "v1",
      "--finalTitle",
      "Nuevo",
      "--description",
      "Desc",
      "--expectedChannelId",
      "UC_EXPECTED",
    ],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(envelope.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("CLI apply returns unresolved guardrail details with non-zero exit", async () => {
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

  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: [
      "apply",
      "--videoId",
      "v1",
      "--finalTitle",
      "Nuevo",
      "--description",
      "Desc",
      "--expectedChannelId",
      "UC_EXPECTED",
    ],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "WRITE_CHANNEL_UNRESOLVED");
  assert.deepEqual(envelope.error.details, {
    expectedChannelId: "UC_EXPECTED",
  });
});

test("CLI playlist list/create commands use shared core and stable JSON envelope", async () => {
  let capturedListInput: unknown;
  let capturedCreateInput: unknown;
  const core = makeCoreStub();
  const stdout: string[] = [];

  core.listPlaylists = async (input: unknown) => {
    capturedListInput = input;
    return {
      playlists: [
        {
          id: "p1",
          title: "Playlist 1",
          description: "Roadtrip videos",
          privacyStatus: "unlisted" as const,
        },
      ],
    };
  };

  core.createPlaylist = async (input: unknown) => {
    capturedCreateInput = input;
    return {
      playlist: {
        id: "p2",
        title: "Roadtrip",
        description: "Summer",
        privacyStatus: "unlisted" as const,
      },
    };
  };

  const listExitCode = await runCliCommand({
    argv: ["playlist", "list", "--userId", "user-1"],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  const createExitCode = await runCliCommand({
    argv: [
      "playlist",
      "create",
      "--userId",
      "user-1",
      "--title",
      "Roadtrip",
      "--expectedChannelId",
      "UC_ACTIVE",
      "--description",
      "Summer",
      "--privacyStatus",
      "unlisted",
    ],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(listExitCode, 0);
  assert.equal(createExitCode, 0);

  assert.deepEqual(capturedListInput, {
    credentialRef: { userId: "user-1" },
  });

  assert.deepEqual(capturedCreateInput, {
    credentialRef: { userId: "user-1" },
    title: "Roadtrip",
    expectedChannelId: "UC_ACTIVE",
    description: "Summer",
    privacyStatus: "unlisted",
  });

  const listEnvelope = JSON.parse(stdout[0] ?? "{}");
  const createEnvelope = JSON.parse(stdout[1] ?? "{}");
  assert.equal(listEnvelope.ok, true);
  assert.equal(createEnvelope.ok, true);
  assert.equal(listEnvelope.data.playlists[0].id, "p1");
  assert.equal(listEnvelope.data.playlists[0].privacyStatus, "unlisted");
  assert.equal(createEnvelope.data.playlist.title, "Roadtrip");
  assert.equal(createEnvelope.data.playlist.description, "Summer");
});

test("CLI playlist update validates and forwards patch payload", async () => {
  const core = makeCoreStub();
  const stdout: string[] = [];
  let capturedUpdateInput: unknown;

  core.updatePlaylist = async (input: unknown) => {
    capturedUpdateInput = input;
    return {
      playlist: {
        id: "p1",
        title: "New title",
        description: "New description",
        privacyStatus: "public" as const,
      },
    };
  };

  const exitCode = await runCliCommand({
    argv: [
      "playlist",
      "update",
      "--playlistId",
      "p1",
      "--expectedChannelId",
      "UC_ACTIVE",
      "--title",
      "New title",
      "--privacyStatus",
      "public",
    ],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(capturedUpdateInput, {
    credentialRef: { userId: "active-user" },
    playlistId: "p1",
    expectedChannelId: "UC_ACTIVE",
    title: "New title",
    description: undefined,
    privacyStatus: "public",
  });

  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.playlist, {
    id: "p1",
    title: "New title",
    description: "New description",
    privacyStatus: "public",
  });
});

test("CLI playlist delete forwards expectedChannelId and returns stable envelope", async () => {
  const core = makeCoreStub();
  const stdout: string[] = [];
  let capturedDeleteInput: unknown;

  core.deletePlaylist = async (input: unknown) => {
    capturedDeleteInput = input;
    return { deleted: true, playlistId: "p-delete" };
  };

  const exitCode = await runCliCommand({
    argv: [
      "playlist",
      "delete",
      "--playlistId",
      "p-delete",
      "--expectedChannelId",
      "UC_ACTIVE",
    ],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(capturedDeleteInput, {
    credentialRef: { userId: "active-user" },
    playlistId: "p-delete",
    expectedChannelId: "UC_ACTIVE",
  });

  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.deepEqual(envelope, {
    ok: true,
    data: {
      deleted: true,
      playlistId: "p-delete",
    },
  });
});

test("CLI playlist create fails closed on guardrail mismatch with stable error details", async () => {
  const core = makeCoreStub();
  const stderr: string[] = [];

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

  const exitCode = await runCliCommand({
    argv: [
      "playlist",
      "create",
      "--title",
      "Roadtrip",
      "--expectedChannelId",
      "UC_EXPECTED",
    ],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(envelope.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("CLI playlist update fails closed on guardrail mismatch with stable error details", async () => {
  const core = makeCoreStub();
  const stderr: string[] = [];

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

  const exitCode = await runCliCommand({
    argv: [
      "playlist",
      "update",
      "--playlistId",
      "p-update",
      "--expectedChannelId",
      "UC_EXPECTED",
      "--title",
      "Updated",
    ],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(envelope.error.details, {
    expectedChannelId: "UC_EXPECTED",
    activeWriteChannelId: "UC_ACTIVE",
  });
});

test("CLI playlist update fails closed on invalid ownership with structured error details", async () => {
  const core = makeCoreStub();
  const stderr: string[] = [];

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

  const exitCode = await runCliCommand({
    argv: [
      "playlist",
      "update",
      "--playlistId",
      "p-update",
      "--expectedChannelId",
      "UC_ACTIVE",
      "--description",
      "Updated description",
    ],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "WRITE_CHANNEL_MISMATCH");
  assert.match(envelope.error.message, /does not belong to the active write channel/);
  assert.deepEqual(envelope.error.details, {
    expectedChannelId: "UC_ACTIVE",
    activeWriteChannelId: "UC_OTHER",
  });
});

test("CLI playlist delete fails closed on unresolved channel with stable error details", async () => {
  const core = makeCoreStub();
  const stderr: string[] = [];

  core.deletePlaylist = async () => {
    throw new DomainError({
      code: "WRITE_CHANNEL_UNRESOLVED",
      message: "Cannot resolve active write channel for the current OAuth session",
      details: {
        expectedChannelId: "UC_ACTIVE",
      },
    });
  };

  const exitCode = await runCliCommand({
    argv: [
      "playlist",
      "delete",
      "--playlistId",
      "p-delete",
      "--expectedChannelId",
      "UC_ACTIVE",
    ],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "WRITE_CHANNEL_UNRESOLVED");
  assert.deepEqual(envelope.error.details, {
    expectedChannelId: "UC_ACTIVE",
  });
});

test("CLI playlist add/remove commands return stable partial-result envelopes", async () => {
  const core = makeCoreStub();
  const stdout: string[] = [];

  const addExitCode = await runCliCommand({
    argv: ["playlist", "add", "--playlistId", "p1", "--videoIds", "v1,v2"],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  const removeExitCode = await runCliCommand({
    argv: ["playlist", "remove", "--playlistId", "p1", "--videoIds", "v1,v2"],
    core,
    auth: makeAuthStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(addExitCode, 0);
  assert.equal(removeExitCode, 0);

  const addEnvelope = JSON.parse(stdout[0] ?? "{}");
  const removeEnvelope = JSON.parse(stdout[1] ?? "{}");

  assert.deepEqual(addEnvelope, {
    ok: true,
    data: {
      playlistId: "p1",
      attempted: 2,
      added: 1,
      failures: [{ videoId: "v2", reason: "already-present" }],
    },
  });

  assert.deepEqual(removeEnvelope, {
    ok: true,
    data: {
      playlistId: "p1",
      requested: 2,
      removed: 1,
      failures: [{ videoId: "v2", reason: "not-found-in-playlist" }],
    },
  });
});

test("CLI playlist commands fail with non-zero exit on missing required flags", async () => {
  const stderr: string[] = [];

  const exitCode = await runCliCommand({
    argv: ["playlist", "add", "--playlistId", "p1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /Missing required --videoIds/);
});

test("CLI playlist update fails with actionable validation error for empty patch", async () => {
  const stderr: string[] = [];

  const exitCode = await runCliCommand({
    argv: [
      "playlist",
      "update",
      "--playlistId",
      "p1",
      "--expectedChannelId",
      "UC_ACTIVE",
    ],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /At least one mutable field is required/);
});

test("CLI playlist fails with typed auth error when no credential source is available", async () => {
  const stderr: string[] = [];

  const exitCode = await runCliCommand({
    argv: ["playlist", "list"],
    core: makeCoreStub(),
    auth: {
      ...makeAuthStub(),
      resolveEffectiveCredentialRef: async () => {
        throw new DomainError({
          code: "AUTH_USER_NOT_FOUND",
          message: "Active auth user does not exist",
        });
      },
    },
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "AUTH_USER_NOT_FOUND");
  assert.match(envelope.error.message, /Active auth user does not exist/);
});
