import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "@/lib/video-metadata/contracts";
import type { VideoMetadataCore } from "@/lib/video-metadata";
import type { PlaylistManagementCore } from "@/lib/playlist-management";
import type { ChangeSetCore } from "@/lib/changesets";
import type { ChangeSet } from "@/lib/changesets/contracts";
import type { BatchCore } from "@/lib/batches";
import type { Batch } from "@/lib/batches/contracts";
import type { ChannelSyncCore } from "@/lib/channel-sync";
import type { ChannelAccessCore } from "@/lib/channel-access";
import type { AnalyticsCore } from "@/lib/analytics";
import type { AiLocalizationCore } from "@/lib/ai-localization";
import { rawSqlClient } from "@/lib/db";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";
import { runCliCommand, getCredentialRef } from "./video-metadata";

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

// Found by independent review (cycle 2): a valueless --channelId used to fall through the
// old inline coercion to "omitted", silently listing videos for the default/active channel
// instead of erroring on the operator's malformed flag.
test("CLI list rejects a --channelId flag with no value instead of silently listing the default channel", async () => {
  const stderr: string[] = [];
  const core = makeCoreStub();
  let called = false;
  core.listVideos = async () => {
    called = true;
    return { videos: [] };
  };

  const exitCode = await runCliCommand({
    argv: ["list", "--channelId", "--maxResults", "5"],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.match(JSON.parse(stderr[0] ?? "{}").error.message, /channelId/);
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

// Found by independent review (cycle 3): getCredentialRef feeds resolveEffectiveCredentialRef,
// the shared path for nearly every non-auth command -- a valueless --userId used to be
// indistinguishable from a truly OMITTED --userId, silently falling back to the active local
// user instead of erroring on the operator's typo. Unlike an omitted --userId (the test
// above), a PRESENT-but-valueless one must fail closed, not fall back.
test("CLI rejects a --userId flag with no value instead of silently falling back to the active user", async () => {
  const stderr: string[] = [];
  const core = makeCoreStub();
  let called = false;
  core.listVideos = async () => {
    called = true;
    return { videos: [] };
  };

  const exitCode = await runCliCommand({
    argv: ["list", "--userId", "--maxResults", "5"],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.match(JSON.parse(stderr[0] ?? "{}").error.message, /userId/);
});

// Found by independent review (cycle 4): the accessToken/refreshToken/scope/tokenExpiry
// branch of getCredentialRef had zero test coverage of any kind (not even a positive-path
// test), unlike the sibling userId branch -- a regression here (e.g. re-inlining a bare
// typeof check) would pass CI silently. These four tests close that gap directly against
// getCredentialRef, which is simpler and more precise than routing through a full CLI command.
test("getCredentialRef builds a full accessToken-based CredentialRef from string flags", () => {
  const result = getCredentialRef({
    accessToken: "tok123",
    refreshToken: "refresh123",
    scope: "scope123",
    tokenExpiry: "1700000000",
  });

  assert.deepEqual(result, {
    accessToken: "tok123",
    refreshToken: "refresh123",
    scope: "scope123",
    tokenExpiry: 1700000000,
  });
});

test("getCredentialRef rejects a valueless --accessToken instead of falling through to null", () => {
  assert.throws(() => getCredentialRef({ accessToken: true }), /accessToken requires a value/);
});

test("getCredentialRef rejects a valueless --tokenExpiry even when --accessToken is valid", () => {
  assert.throws(
    () => getCredentialRef({ accessToken: "tok123", tokenExpiry: true }),
    /tokenExpiry requires a value/
  );
});

test("getCredentialRef fails closed on a valueless --userId even when a valid --accessToken is also present", () => {
  // Pins the fail-closed ordering itself: --userId is checked first and, if malformed, must
  // throw rather than silently falling back to the also-present --accessToken -- the opposite
  // of the old behavior (silently ignore the broken --userId, authenticate via the token).
  assert.throws(
    () => getCredentialRef({ userId: true, accessToken: "tok123" }),
    /userId requires a value/
  );
});

test("CLI auth select-channel requires --channelId (missing entirely, not just a valueless flag)", async () => {
  const stderr: string[] = [];
  let called = false;
  const auth = { ...makeAuthStub(), selectWriteChannel: async () => { called = true; return {}; } };

  const exitCode = await runCliCommand({
    argv: ["auth", "select-channel"],
    core: makeCoreStub(),
    auth,
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.match(JSON.parse(stderr[0] ?? "{}").error.message, /Missing required --channelId/);
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

test("RISK-12 (2026-09-18): CLI apply omits dryRun from the request entirely when --dryRun is not passed, letting applyMetadataInputSchema's safe default (true) apply -- never sends an explicit dryRun: false", async () => {
  let capturedInput: unknown;
  const core = makeCoreStub();
  core.applyMetadata = async (input: unknown) => {
    capturedInput = input;
    return makeApplyPayload(false);
  };

  const exitCode = await runCliCommand({
    argv: ["apply", "--videoId", "v1", "--finalTitle", "Draft", "--description", "Draft desc", "--expectedChannelId", "UC_ACTIVE"],
    core,
    auth: makeAuthStub(),
    writeStdout: () => {},
  });

  assert.equal(exitCode, 0);
  assert.equal((capturedInput as { dryRun?: boolean }).dryRun, undefined, "dryRun must be omitted, not sent as an explicit false, when the flag is absent");
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

  // RISK-12 (2026-09-18): a live write now requires an explicit `--dryRun false` --
  // omitting the flag entirely means dry-run, not live (see resolveDryRunFlag).
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
      "--dryRun",
      "false",
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

// Found by independent review (cycle 2): `revoke.userId` used to fall through the old
// inline coercion, so a valueless --userId (e.g. a typo dropping its value) was silently
// treated as "omitted" -- auth.revoke() then falls back to the currently active user and
// revokes THEIR token instead of failing closed on the malformed flag.
test("CLI auth revoke rejects a --userId flag with no value instead of silently revoking the active user", async () => {
  const stderr: string[] = [];
  let called = false;
  const auth = { ...makeAuthStub(), revoke: async () => { called = true; return {}; } };

  const exitCode = await runCliCommand({
    argv: ["auth", "revoke", "--userId", "--foo"],
    core: makeCoreStub(),
    auth,
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.match(JSON.parse(stderr[0] ?? "{}").error.message, /userId/);
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

// Found by independent review (cycle 2): a valueless --title used to fall through the old
// inline coercion to undefined, which then fell through the "at least one mutable field"
// check because --description was also present -- silently sending a real playlist-update
// write with the title left unchanged instead of erroring on the operator's malformed flag.
test("CLI playlist update rejects a --title flag with no value instead of silently dropping the title change", async () => {
  const stderr: string[] = [];
  const core = makeCoreStub();
  let called = false;
  core.updatePlaylist = async () => {
    called = true;
    return { playlist: { id: "p1", title: "x", description: "x", privacyStatus: "private" as const } };
  };

  const exitCode = await runCliCommand({
    argv: [
      "playlist",
      "update",
      "--title",
      "--playlistId",
      "p1",
      "--expectedChannelId",
      "UC_ACTIVE",
      "--description",
      "new description",
    ],
    core,
    auth: makeAuthStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.match(JSON.parse(stderr[0] ?? "{}").error.message, /title/);
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

// CLI parity for the read/propose/create MCP tools (docs/roadmap/plans/PHASE_7_PLAN.md,
// docs/TECHNICAL_DEBT.md RISK-04) -- same core factories via new optional
// operationsCore/channelSyncCore params, mirroring src/mcp/server.ts's design exactly.

function makeChangeSetRecord(): ChangeSet {
  return {
    id: "cs-1",
    channelId: "UC_1",
    source: "xlsx_import",
    status: "in_review",
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
  };
}

function makeBatchRecord(): Batch {
  return {
    id: "batch-1",
    channelId: "UC_1",
    status: "PENDING",
    concurrency: 1,
    dryRun: true,
    runId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };
}

function makeOperationsCoreStub(): Pick<
  ChangeSetCore,
  "listChangeSets" | "getChangeSet" | "previewImport" | "createChangeSetFromImport"
> &
  Pick<BatchCore, "listBatchesByChannel" | "requireBatchForChannel" | "listLedgerRows"> {
  return {
    listChangeSets: async () => [makeChangeSetRecord()],
    getChangeSet: async () => ({
      changeSet: makeChangeSetRecord(),
      changes: [],
      pagination: { page: 1, pageSize: 50, total: 0 },
    }),
    previewImport: async () => ({
      summary: { videosFound: 1, localizationRows: 1, validChanges: 1, unchangedValues: 0, invalidRows: 0, conflicts: 0 },
      errors: [],
      totalErrors: 0,
    }),
    createChangeSetFromImport: async () => ({
      changeSet: makeChangeSetRecord(),
      summary: { videosFound: 1, localizationRows: 1, validChanges: 1, unchangedValues: 0, invalidRows: 0, conflicts: 0 },
      errors: [],
      totalErrors: 0,
    }),
    listBatchesByChannel: async () => [],
    requireBatchForChannel: async () => makeBatchRecord(),
    listLedgerRows: async () => [],
  };
}

// Permissive by default -- these existing tests exercise pre-existing behaviors unrelated to
// the active-channel read-scoping check itself (RISK-02, docs/decisions/0004). A dedicated
// CHANNEL_NOT_ACTIVE test below uses a restrictive stub instead.
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

function makeChannelSyncCoreStub(): Pick<
  ChannelSyncCore,
  "syncChannel" | "listChannels" | "listSyncedVideos"
> {
  const channel = {
    channelId: "UC_1",
    title: "Channel 1",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_1",
    connectedUserId: "u1",
    connectedAt: "2026-09-01T00:00:00.000Z",
    lastSyncedAt: "2026-09-01T00:00:00.000Z",
  };
  return {
    syncChannel: async () => ({ channel, videoCount: 1, syncedAt: "2026-09-01T00:00:00.000Z" }),
    listChannels: async () => ({ channels: [channel] }),
    listSyncedVideos: async () => ({ channelId: "UC_1", videos: [] }),
  };
}

test("CLI changeset list forwards channelId and returns structured JSON", async () => {
  const stdout: string[] = [];
  const operationsCore = makeOperationsCoreStub();
  let captured: unknown;
  operationsCore.listChangeSets = async (input: unknown) => {
    captured = input;
    return [makeChangeSetRecord()];
  };

  const exitCode = await runCliCommand({
    argv: ["changeset", "list", "--channelId", "UC_1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    operationsCore,
    channelAccessCore: makeChannelAccessCoreStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, { channelId: "UC_1" });
  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.data.changeSets[0].id, "cs-1");
});

test("CLI changeset get forwards optional filters", async () => {
  const stdout: string[] = [];
  const operationsCore = makeOperationsCoreStub();
  let captured: unknown;
  operationsCore.getChangeSet = async (input: unknown) => {
    captured = input;
    return { changeSet: makeChangeSetRecord(), changes: [], pagination: { page: 1, pageSize: 50, total: 0 } };
  };

  const exitCode = await runCliCommand({
    argv: ["changeset", "get", "--channelId", "UC_1", "--changeSetId", "cs-1", "--language", "es"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    operationsCore,
    channelAccessCore: makeChannelAccessCoreStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, {
    channelId: "UC_1",
    changeSetId: "cs-1",
    status: undefined,
    language: "es",
    videoId: undefined,
  });
});

test("CLI changeset preview and changeset import read --file from disk and forward its bytes; preview never persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-changeset-test-"));
  const filePath = join(dir, "export.xlsx");
  const content = "title,description\nHello,World\n";
  await writeFile(filePath, content, "utf8");

  try {
    const operationsCore = makeOperationsCoreStub();
    const capturedPreview: { buffer?: Buffer; filename?: string } = {};
    operationsCore.previewImport = async (input: unknown) => {
      const typed = input as { buffer: Buffer; filename: string };
      capturedPreview.buffer = typed.buffer;
      capturedPreview.filename = typed.filename;
      return {
        summary: { videosFound: 0, localizationRows: 0, validChanges: 0, unchangedValues: 0, invalidRows: 0, conflicts: 0 },
        errors: [],
        totalErrors: 0,
      };
    };
    let createCalled = false;
    operationsCore.createChangeSetFromImport = async () => {
      createCalled = true;
      return { changeSet: makeChangeSetRecord(), summary: { videosFound: 0, localizationRows: 0, validChanges: 0, unchangedValues: 0, invalidRows: 0, conflicts: 0 }, errors: [], totalErrors: 0 };
    };

    const previewStdout: string[] = [];
    const previewExit = await runCliCommand({
      argv: ["changeset", "preview", "--channelId", "UC_1", "--file", filePath],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      operationsCore,
      channelAccessCore: makeChannelAccessCoreStub(),
      writeStdout: (line) => previewStdout.push(line),
    });

    assert.equal(previewExit, 0);
    assert.equal(capturedPreview.buffer?.toString("utf8"), content);
    assert.equal(capturedPreview.filename, "export.xlsx");
    assert.equal(createCalled, false);

    const importStdout: string[] = [];
    const importExit = await runCliCommand({
      argv: ["changeset", "import", "--channelId", "UC_1", "--file", filePath],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      operationsCore,
      channelAccessCore: makeChannelAccessCoreStub(),
      writeStdout: (line) => importStdout.push(line),
    });

    assert.equal(importExit, 0);
    assert.equal(createCalled, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI changeset import fails cleanly when --file does not exist", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["changeset", "import", "--channelId", "UC_1", "--file", "/no/such/file.xlsx"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    operationsCore: makeOperationsCoreStub(),
    channelAccessCore: makeChannelAccessCoreStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /--file/);
});

test("CLI batch list and batch get use requireBatchForChannel, not a bare batchId lookup", async () => {
  const operationsCore = makeOperationsCoreStub();
  const seenArgs: unknown[] = [];
  operationsCore.requireBatchForChannel = async (channelId: string, batchId: string) => {
    seenArgs.push([channelId, batchId]);
    return makeBatchRecord();
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["batch", "get", "--channelId", "UC_1", "--batchId", "batch-1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    operationsCore,
    channelAccessCore: makeChannelAccessCoreStub(),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(seenArgs, [["UC_1", "batch-1"]]);
});

// Owner's requirement (2026-09-20, docs/decisions/0004): a channelId that is not this
// session's active channel must be rejected, for the CLI just like Web/MCP.
test("CLI changeset list rejects a channelId that is not the caller's active channel", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["changeset", "list", "--channelId", "UC_1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    operationsCore: makeOperationsCoreStub(),
    channelAccessCore: {
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
    },
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "CHANNEL_NOT_ACTIVE");
});

test("CLI channel sync forwards resolved credentialRef and optional channelId", async () => {
  const channelSyncCore = makeChannelSyncCoreStub();
  let captured: unknown;
  channelSyncCore.syncChannel = async (input: unknown) => {
    captured = input;
    return {
      channel: {
        channelId: "UC_1",
        title: "Channel 1",
        thumbnailUrl: null,
        uploadsPlaylistId: "UU_1",
        connectedUserId: "u1",
        connectedAt: "2026-09-01T00:00:00.000Z",
        lastSyncedAt: "2026-09-01T00:00:00.000Z",
      },
      videoCount: 1,
      syncedAt: "2026-09-01T00:00:00.000Z",
    };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["channel", "sync", "--channelId", "UC_1", "--userId", "u1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    channelSyncCore,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, { credentialRef: { userId: "u1" }, channelId: "UC_1" });
});

// Found by independent review: a valueless --channelId (e.g. a typo like
// `--channelId --userId u1`, where parseArgs reads the next token as its own flag rather
// than a value) used to be silently coerced to "channelId omitted" instead of raising an
// error -- syncing whatever channel resolves as default instead of failing closed on the
// operator's mistake.
test("CLI channel sync rejects a --channelId flag with no value instead of silently treating it as omitted", async () => {
  const channelSyncCore = makeChannelSyncCoreStub();
  let called = false;
  channelSyncCore.syncChannel = async () => {
    called = true;
    return { channel: null as never, videoCount: 0, syncedAt: "" };
  };

  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["channel", "sync", "--channelId", "--userId", "u1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    channelSyncCore,
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /channelId/);
});

test("CLI channel video-list requires channelId", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["channel", "video-list"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    channelSyncCore: makeChannelSyncCoreStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /channelId/);
});

// CLI parity for MCP's analytics_list/analytics_overview (docs/roadmap/BACKLOG.md,
// "machine-readable analytics for operational agents to consume").

function makeAnalyticsCliCoreStub(): Pick<
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
      daily: [],
      currentTotals: { views: 10, estimatedMinutesWatched: 20, subscribersGained: 1, subscribersLost: 0 },
      previousTotals: { views: 5, estimatedMinutesWatched: 10, subscribersGained: 0, subscribersLost: 0 },
    }),
    getDataQualityReport: async () => ({
      channelId: "UC_1",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      coveredDates: ["2026-09-01"],
      uncoveredDates: ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
      tooRecentDates: [],
      videosWithSkips: [],
    }),
    getComparableAgeComparison: async () => ({
      channelId: "UC_1",
      metricName: "views",
      maxDays: 30,
      videos: [],
    }),
    listWeeklyReports: async () => ({ channelId: "UC_1", reports: [] }),
    getWeeklyReport: async () => ({ channelId: "UC_1", report: null }),
  };
}

test("CLI analytics list forwards resolved credentialRef and optional filters", async () => {
  const analyticsCore = makeAnalyticsCliCoreStub();
  let captured: unknown;
  analyticsCore.listMetrics = async (input: unknown) => {
    captured = input;
    return { channelId: "UC_1", rows: [] };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: [
      "analytics",
      "list",
      "--channelId",
      "UC_1",
      "--userId",
      "u1",
      "--startDate",
      "2026-09-01",
      "--endDate",
      "2026-09-20",
      "--videoId",
      "v1",
      "--metricNames",
      "views,likes",
    ],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, {
    credentialRef: { userId: "u1" },
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-20",
    videoId: "v1",
    metricNames: ["views", "likes"],
  });
});

test("CLI analytics list requires channelId", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["analytics", "list"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore: makeAnalyticsCliCoreStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /channelId/);
});

test("CLI analytics overview forwards resolved credentialRef and requires startDate/endDate", async () => {
  const analyticsCore = makeAnalyticsCliCoreStub();
  let captured: unknown;
  analyticsCore.getChannelOverview = async (input: unknown) => {
    captured = input;
    return {
      channelId: "UC_1",
      startDate: "2026-08-26",
      endDate: "2026-09-22",
      previousStartDate: "2026-07-29",
      previousEndDate: "2026-08-25",
      daily: [],
      currentTotals: { views: 10, estimatedMinutesWatched: 20, subscribersGained: 1, subscribersLost: 0 },
      previousTotals: { views: 5, estimatedMinutesWatched: 10, subscribersGained: 0, subscribersLost: 0 },
    };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: [
      "analytics",
      "overview",
      "--channelId",
      "UC_1",
      "--userId",
      "u1",
      "--startDate",
      "2026-08-26",
      "--endDate",
      "2026-09-22",
    ],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, {
    credentialRef: { userId: "u1" },
    channelId: "UC_1",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
  });
});

test("CLI analytics overview requires startDate and endDate", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["analytics", "overview", "--channelId", "UC_1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore: makeAnalyticsCliCoreStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /startDate/);
});

test("CLI analytics list/overview are never blocked by the operation lock (read-only)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const stdout: string[] = [];
    const listExit = await runCliCommand({
      argv: ["analytics", "list", "--channelId", "UC_1", "--userId", "u1"],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      analyticsCore: makeAnalyticsCliCoreStub(),
      writeStdout: (line) => stdout.push(line),
    });
    assert.equal(listExit, 0);

    const overviewExit = await runCliCommand({
      argv: [
        "analytics",
        "overview",
        "--channelId",
        "UC_1",
        "--userId",
        "u1",
        "--startDate",
        "2026-08-26",
        "--endDate",
        "2026-09-22",
      ],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      analyticsCore: makeAnalyticsCliCoreStub(),
      writeStdout: (line) => stdout.push(line),
    });
    assert.equal(overviewExit, 0);

    const dataQualityExit = await runCliCommand({
      argv: [
        "analytics",
        "data-quality",
        "--channelId",
        "UC_1",
        "--userId",
        "u1",
        "--startDate",
        "2026-09-01",
        "--endDate",
        "2026-09-05",
      ],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      analyticsCore: makeAnalyticsCliCoreStub(),
      writeStdout: (line) => stdout.push(line),
    });
    assert.equal(dataQualityExit, 0);

    const comparableAgeExit = await runCliCommand({
      argv: ["analytics", "comparable-age", "--channelId", "UC_1", "--userId", "u1", "--videoIds", "v1,v2"],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      analyticsCore: makeAnalyticsCliCoreStub(),
      writeStdout: (line) => stdout.push(line),
    });
    assert.equal(comparableAgeExit, 0);

    const weeklyReportsExit = await runCliCommand({
      argv: ["analytics", "weekly-reports", "--channelId", "UC_1", "--userId", "u1"],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      analyticsCore: makeAnalyticsCliCoreStub(),
      writeStdout: (line) => stdout.push(line),
    });
    assert.equal(weeklyReportsExit, 0);

    const weeklyReportGetExit = await runCliCommand({
      argv: ["analytics", "weekly-report-get", "--channelId", "UC_1", "--userId", "u1", "--weekStartDate", "2026-09-14"],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      analyticsCore: makeAnalyticsCliCoreStub(),
      writeStdout: (line) => stdout.push(line),
    });
    assert.equal(weeklyReportGetExit, 0);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("CLI analytics data-quality forwards resolved credentialRef and requires startDate/endDate", async () => {
  const analyticsCore = makeAnalyticsCliCoreStub();
  let captured: unknown;
  analyticsCore.getDataQualityReport = async (input: unknown) => {
    captured = input;
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

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: [
      "analytics",
      "data-quality",
      "--channelId",
      "UC_1",
      "--userId",
      "u1",
      "--startDate",
      "2026-09-01",
      "--endDate",
      "2026-09-05",
    ],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, {
    credentialRef: { userId: "u1" },
    channelId: "UC_1",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
  });
});

test("CLI analytics data-quality requires startDate and endDate", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["analytics", "data-quality", "--channelId", "UC_1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore: makeAnalyticsCliCoreStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /startDate/);
});

test("CLI analytics comparable-age forwards resolved credentialRef, parsed --videoIds, and optional --metricName/--maxDays", async () => {
  const analyticsCore = makeAnalyticsCliCoreStub();
  let captured: unknown;
  analyticsCore.getComparableAgeComparison = async (input: unknown) => {
    captured = input;
    return { channelId: "UC_1", metricName: "likes", maxDays: 14, videos: [] };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: [
      "analytics",
      "comparable-age",
      "--channelId",
      "UC_1",
      "--userId",
      "u1",
      "--videoIds",
      "v1, v2 ,v3",
      "--metricName",
      "likes",
      "--maxDays",
      "14",
    ],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, {
    credentialRef: { userId: "u1" },
    channelId: "UC_1",
    videoIds: ["v1", "v2", "v3"],
    metricName: "likes",
    maxDays: 14,
  });
});

test("CLI analytics comparable-age requires --videoIds", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["analytics", "comparable-age", "--channelId", "UC_1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore: makeAnalyticsCliCoreStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /videoIds/);
});

test("CLI analytics weekly-reports forwards resolved credentialRef and channelId", async () => {
  const analyticsCore = makeAnalyticsCliCoreStub();
  let captured: unknown;
  analyticsCore.listWeeklyReports = async (input: unknown) => {
    captured = input;
    return { channelId: "UC_1", reports: [] };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["analytics", "weekly-reports", "--channelId", "UC_1", "--userId", "u1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, { credentialRef: { userId: "u1" }, channelId: "UC_1" });
});

test("CLI analytics weekly-report-get forwards resolved credentialRef and --weekStartDate", async () => {
  const analyticsCore = makeAnalyticsCliCoreStub();
  let captured: unknown;
  analyticsCore.getWeeklyReport = async (input: unknown) => {
    captured = input;
    return { channelId: "UC_1", report: null };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["analytics", "weekly-report-get", "--channelId", "UC_1", "--userId", "u1", "--weekStartDate", "2026-09-14"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, { credentialRef: { userId: "u1" }, channelId: "UC_1", weekStartDate: "2026-09-14" });
});

test("CLI analytics weekly-report-get requires --weekStartDate", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["analytics", "weekly-report-get", "--channelId", "UC_1"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    analyticsCore: makeAnalyticsCliCoreStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "validation_failed");
  assert.match(envelope.error.message, /weekStartDate/);
});

function makeAiLocalizationCliCoreStub(): Pick<AiLocalizationCore, "generateProposals" | "createChangeSetFromGeneration"> {
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
              field: "title" as const,
              baselineValue: "Old title",
              proposedValue: "Nuevo titulo",
              changeType: "modify" as const,
              validationStatus: "valid" as const,
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
    createChangeSetFromGeneration: async () => ({ ...makeChangeSetRecord(), source: "ai_localization" as const }),
  };
}

test("CLI ai-localization generate forwards channelId, parsed --videoIds/--targetLanguages, and optional provider flags", async () => {
  const aiLocalizationCore = makeAiLocalizationCliCoreStub();
  let captured: unknown;
  aiLocalizationCore.generateProposals = async (input: unknown) => {
    captured = input;
    return {
      results: [],
      errors: [],
      summary: { targetsRequested: 0, targetsGenerated: 0, targetsFailed: 0, validProposals: 0, invalidProposals: 0, unchangedProposals: 0 },
      generationContext: { profileVersion: null, effectiveContext: null },
    };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: [
      "ai-localization",
      "generate",
      "--channelId",
      "UC_1",
      "--userId",
      "u1",
      "--videoIds",
      "v1, v2",
      "--targetLanguages",
      "es, fr",
      "--connectionId",
      "conn-1",
    ],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    channelAccessCore: makeChannelAccessCoreStub(),
    aiLocalizationCore,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, {
    channelId: "UC_1",
    videoIds: ["v1", "v2"],
    targetLanguages: ["es", "fr"],
    providerName: undefined,
    connectionId: "conn-1",
  });
});

test("CLI ai-localization generate rejects a channelId that is not the caller's active channel", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["ai-localization", "generate", "--channelId", "UC_1", "--videoIds", "v1", "--targetLanguages", "es"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    channelAccessCore: {
      assertActiveChannel: async (args: { channelId: string }) => {
        throw new DomainError({
          code: "CHANNEL_NOT_ACTIVE",
          message: "not active",
          details: { channelId: args.channelId, activeChannelId: null },
        });
      },
      getActiveChannelId: async () => null,
      filterToActiveChannel: () => [],
      activateChannel: async () => undefined,
    },
    aiLocalizationCore: makeAiLocalizationCliCoreStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "CHANNEL_NOT_ACTIVE");
});

test("CLI ai-localization create-change-set parses --proposalsJson/--provenanceJson and persists via createChangeSetFromGeneration", async () => {
  const aiLocalizationCore = makeAiLocalizationCliCoreStub();
  let captured: unknown;
  aiLocalizationCore.createChangeSetFromGeneration = async (input: unknown) => {
    captured = input;
    return { ...makeChangeSetRecord(), source: "ai_localization" as const };
  };

  const stdout: string[] = [];
  const exitCode = await runCliCommand({
    argv: [
      "ai-localization",
      "create-change-set",
      "--channelId",
      "UC_1",
      "--userId",
      "u1",
      "--proposalsJson",
      JSON.stringify([{ videoId: "v1", language: "es", title: "Nuevo titulo" }]),
      "--provenanceJson",
      JSON.stringify({ profileVersion: 2, effectiveContext: null }),
    ],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    channelAccessCore: makeChannelAccessCoreStub(),
    aiLocalizationCore,
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, {
    channelId: "UC_1",
    proposals: [{ videoId: "v1", language: "es", title: "Nuevo titulo" }],
    provenance: { profileVersion: 2, effectiveContext: null },
  });
  const envelope = JSON.parse(stdout[0] ?? "{}");
  assert.equal(envelope.data.source, "ai_localization");
});

test("CLI ai-localization create-change-set rejects malformed --proposalsJson", async () => {
  const stderr: string[] = [];
  const exitCode = await runCliCommand({
    argv: ["ai-localization", "create-change-set", "--channelId", "UC_1", "--proposalsJson", "{not valid json"],
    core: makeCoreStub(),
    auth: makeAuthStub(),
    channelAccessCore: makeChannelAccessCoreStub(),
    aiLocalizationCore: makeAiLocalizationCliCoreStub(),
    writeStderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stderr[0] ?? "{}");
  assert.equal(envelope.error.code, "validation_failed");
});

test("CLI ai-localization generate is never blocked by the operation lock (read-only); create-change-set is blocked", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const generateExit = await runCliCommand({
      argv: ["ai-localization", "generate", "--channelId", "UC_1", "--userId", "u1", "--videoIds", "v1", "--targetLanguages", "es"],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      channelAccessCore: makeChannelAccessCoreStub(),
      aiLocalizationCore: makeAiLocalizationCliCoreStub(),
      writeStdout: () => {},
    });
    assert.equal(generateExit, 0);

    const stderr: string[] = [];
    const createExit = await runCliCommand({
      argv: [
        "ai-localization",
        "create-change-set",
        "--channelId",
        "UC_1",
        "--userId",
        "u1",
        "--proposalsJson",
        JSON.stringify([{ videoId: "v1", language: "es", title: "Nuevo titulo" }]),
      ],
      core: makeCoreStub(),
      auth: makeAuthStub(),
      channelAccessCore: makeChannelAccessCoreStub(),
      aiLocalizationCore: makeAiLocalizationCliCoreStub(),
      writeStderr: (line) => stderr.push(line),
    });
    assert.equal(createExit, 1);
    const envelope = JSON.parse(stderr[0] ?? "{}");
    assert.equal(envelope.error.code, "operation_lock_held");
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});
