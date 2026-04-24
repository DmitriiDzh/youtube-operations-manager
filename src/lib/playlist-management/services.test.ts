import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createPlaylistManagementServices } from "./services";

function createServicesFixture() {
  const authCalls: Array<{ credentialRef: unknown; requiredScopes: readonly string[] }> = [];

  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => {
        authCalls.push(args);
        return {
          credentialRef: args.credentialRef as { userId: string },
          accessToken: "access",
          refreshToken: "refresh",
          tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
          scopeSet: new Set(args.requiredScopes),
        };
      },
    },
    youtubeApi: {
      listPlaylists: async () => [
        { id: "p1", title: "Playlist 1", description: "Desc", privacyStatus: "private" },
      ],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async ({ playlistId }) => ({
        id: playlistId,
        title: "Playlist 1",
        description: "Desc",
        privacyStatus: "private",
        channelId: "UC_ACTIVE",
      }),
      updatePlaylist: async ({ playlistId, title, description, privacyStatus }) => ({
        id: playlistId,
        title,
        description,
        privacyStatus,
      }),
      getPlaylistForDelete: async ({ playlistId }) => ({
        id: playlistId,
        channelId: "UC_ACTIVE",
        title: "Playlist 1",
      }),
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () =>
        new Map<string, string[]>([
          ["v1", ["pi-1"]],
          ["v2", ["pi-2"]],
        ]),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active" },
        shouldPersistSelection: true,
        userId: "user-1",
      }),
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  return { services, authCalls };
}

test("listPlaylists resolves auth and returns stable output", async () => {
  const { services, authCalls } = createServicesFixture();

  const result = await services.listPlaylists({
    credentialRef: { userId: "user-1" },
  });

  assert.deepEqual(result, {
    playlists: [
      { id: "p1", title: "Playlist 1", description: "Desc", privacyStatus: "private" },
    ],
  });
  assert.equal(authCalls.length, 1);
});

test("createPlaylist maps unknown failures to update_failed", async () => {
  const { authCalls } = createServicesFixture();
  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => {
        authCalls.push(args);
        return {
          credentialRef: { userId: "user-1" },
          accessToken: "access",
          refreshToken: "refresh",
          tokenExpiry: undefined,
          scopeSet: new Set(args.requiredScopes),
        };
      },
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async () => {
        throw new Error("remote failure");
      },
      getPlaylistForUpdate: async () => null,
      updatePlaylist: async () => ({
        id: "p-updated",
        title: "Updated",
        description: "",
        privacyStatus: "private",
      }),
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active" },
        shouldPersistSelection: false,
        userId: null,
      }),
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      services.createPlaylist({
        credentialRef: { userId: "user-1" },
        title: "My playlist",
        expectedChannelId: "UC_ACTIVE",
      }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "update_failed" &&
      error.message === "remote failure"
  );
});

test("createPlaylist blocks mismatch guardrail and does not call remote create", async () => {
  let createCalls = 0;

  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async () => {
        createCalls += 1;
        return {
          id: "p-created",
          title: "Created",
          description: "",
          privacyStatus: "private",
        };
      },
      getPlaylistForUpdate: async () => null,
      updatePlaylist: async () => ({
        id: "p-updated",
        title: "Updated",
        description: "",
        privacyStatus: "private",
      }),
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => {
        throw new DomainError({
          code: "WRITE_CHANNEL_MISMATCH",
          message: "expectedChannelId does not match the active write channel",
          details: {
            expectedChannelId: "UC_EXPECTED",
            activeWriteChannelId: "UC_ACTIVE",
          },
        });
      },
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      services.createPlaylist({
        credentialRef: { userId: "user-1" },
        title: "My playlist",
        expectedChannelId: "UC_EXPECTED",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "WRITE_CHANNEL_MISMATCH");
      assert.deepEqual(error.details, {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
      });
      return true;
    }
  );

  assert.equal(createCalls, 0);
});

test("updatePlaylist applies validated patch, preserves non-patched fields and persists selected channel", async () => {
  const calls = { update: 0, persist: 0 };
  let capturedUpdateInput: unknown;

  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async ({ playlistId }) => ({
        id: playlistId,
        title: "Original title",
        description: "Original description",
        privacyStatus: "private",
        channelId: "UC_ACTIVE",
      }),
      updatePlaylist: async (input) => {
        calls.update += 1;
        capturedUpdateInput = input;
        return {
          id: input.playlistId,
          title: input.title,
          description: input.description,
          privacyStatus: input.privacyStatus,
        };
      },
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active" },
        shouldPersistSelection: true,
        userId: "user-1",
      }),
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => {
        calls.persist += 1;
      },
    },
  });

  const result = await services.updatePlaylist({
    credentialRef: { userId: "user-1" },
    playlistId: "playlist-1",
    expectedChannelId: "UC_ACTIVE",
    title: "Updated title",
  });

  assert.equal(calls.update, 1);
  assert.equal(calls.persist, 1);
  assert.deepEqual(capturedUpdateInput, {
    credentials: {
      credentialRef: { userId: "user-1" },
      accessToken: "access",
      refreshToken: "refresh",
      tokenExpiry: undefined,
      scopeSet: new Set(["https://www.googleapis.com/auth/youtube"]),
    },
    playlistId: "playlist-1",
    title: "Updated title",
    description: "Original description",
    privacyStatus: "private",
  });
  assert.deepEqual(result, {
    playlist: {
      id: "playlist-1",
      title: "Updated title",
      description: "Original description",
      privacyStatus: "private",
    },
  });
});

test("updatePlaylist blocks guardrail mismatch before ownership preflight and remote mutation", async () => {
  const calls = { preflight: 0, update: 0 };

  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async () => {
        calls.preflight += 1;
        return null;
      },
      updatePlaylist: async () => {
        calls.update += 1;
        return { id: "p-updated", title: "Updated", description: "", privacyStatus: "private" };
      },
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => {
        throw new DomainError({
          code: "WRITE_CHANNEL_MISMATCH",
          message: "expectedChannelId does not match the active write channel",
          details: {
            expectedChannelId: "UC_EXPECTED",
            activeWriteChannelId: "UC_ACTIVE",
          },
        });
      },
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      services.updatePlaylist({
        credentialRef: { userId: "user-1" },
        playlistId: "playlist-1",
        expectedChannelId: "UC_EXPECTED",
        title: "Updated",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "WRITE_CHANNEL_MISMATCH");
      assert.deepEqual(error.details, {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
      });
      return true;
    }
  );

  assert.deepEqual(calls, { preflight: 0, update: 0 });
});

test("updatePlaylist fails closed on unresolved write channel before ownership preflight", async () => {
  const calls = { preflight: 0, update: 0 };

  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async () => {
        calls.preflight += 1;
        return null;
      },
      updatePlaylist: async () => {
        calls.update += 1;
        return { id: "p-updated", title: "Updated", description: "", privacyStatus: "private" };
      },
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => {
        throw new DomainError({
          code: "WRITE_CHANNEL_UNRESOLVED",
          message: "Cannot resolve active write channel for the current OAuth session",
          details: { expectedChannelId: "UC_EXPECTED" },
        });
      },
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      services.updatePlaylist({
        credentialRef: { userId: "user-1" },
        playlistId: "playlist-1",
        expectedChannelId: "UC_EXPECTED",
        title: "Updated",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "WRITE_CHANNEL_UNRESOLVED"
  );

  assert.deepEqual(calls, { preflight: 0, update: 0 });
});

test("updatePlaylist fails closed when playlist ownership does not match active write channel", async () => {
  const calls = { update: 0 };

  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async ({ playlistId }) => ({
        id: playlistId,
        title: "Original",
        description: "Original",
        privacyStatus: "private",
        channelId: "UC_OTHER",
      }),
      updatePlaylist: async () => {
        calls.update += 1;
        return { id: "p-updated", title: "Updated", description: "", privacyStatus: "private" };
      },
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active" },
        shouldPersistSelection: false,
        userId: null,
      }),
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      services.updatePlaylist({
        credentialRef: { userId: "user-1" },
        playlistId: "playlist-1",
        expectedChannelId: "UC_ACTIVE",
        description: "Updated description",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "WRITE_CHANNEL_MISMATCH");
      assert.deepEqual(error.details, {
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannelId: "UC_OTHER",
      });
      return true;
    }
  );

  assert.equal(calls.update, 0);
});

test("addVideosToPlaylist returns stable partial result with per-item failures", async () => {
  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async () => null,
      updatePlaylist: async () => ({
        id: "p-updated",
        title: "Updated",
        description: "",
        privacyStatus: "private",
      }),
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async ({ videoId }) => {
        if (videoId === "v2") {
          throw {
            response: {
              status: 409,
              data: {
                error: {
                  errors: [{ reason: "duplicate" }],
                },
              },
            },
            message: "already in playlist",
          };
        }
      },
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active" },
        shouldPersistSelection: false,
        userId: null,
      }),
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  const result = await services.addVideosToPlaylist({
    credentialRef: { userId: "user-1" },
    playlistId: "playlist-1",
    videoIds: ["v1", "v2", "v3"],
  });

  assert.deepEqual(result, {
    playlistId: "playlist-1",
    attempted: 3,
    added: 2,
    failures: [
      {
        videoId: "v2",
        reason: "already-present",
      },
    ],
  });
});

test("removeVideosFromPlaylist preserves order and returns not-found failures", async () => {
  const deletedItemIds: string[] = [];
  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async () => null,
      updatePlaylist: async () => ({
        id: "p-updated",
        title: "Updated",
        description: "",
        privacyStatus: "private",
      }),
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () =>
        new Map<string, string[]>([
          ["v1", ["pi-1"]],
          ["v2", ["pi-2"]],
        ]),
      deletePlaylistItem: async ({ playlistItemId }) => {
        if (playlistItemId === "pi-2") {
          throw {
            response: { status: 403 },
            message: "forbidden",
          };
        }

        deletedItemIds.push(playlistItemId);
      },
    },
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active" },
        shouldPersistSelection: false,
        userId: null,
      }),
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  const result = await services.removeVideosFromPlaylist({
    credentialRef: { userId: "user-1" },
    playlistId: "playlist-1",
    videoIds: ["v1", "v2", "v3", "v1"],
  });

  assert.deepEqual(deletedItemIds, ["pi-1"]);
  assert.deepEqual(result, {
    playlistId: "playlist-1",
    requested: 4,
    removed: 1,
    failures: [
      { videoId: "v2", reason: "forbidden" },
      {
        videoId: "v3",
        reason: "not-found-in-playlist",
        message: "Video is not present in playlist",
      },
      {
        videoId: "v1",
        reason: "not-found-in-playlist",
        message: "Video is not present in playlist",
      },
    ],
  });
});

test("deletePlaylist enforces guardrail and deletes when channel matches", async () => {
  const calls = { delete: 0, persist: 0 };
  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async () => null,
      updatePlaylist: async () => ({
        id: "p-updated",
        title: "Updated",
        description: "",
        privacyStatus: "private",
      }),
      getPlaylistForDelete: async ({ playlistId }) => ({
        id: playlistId,
        channelId: "UC_ACTIVE",
        title: "To delete",
      }),
      deletePlaylist: async () => {
        calls.delete += 1;
      },
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active" },
        shouldPersistSelection: true,
        userId: "user-1",
      }),
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => {
        calls.persist += 1;
      },
    },
  });

  const result = await services.deletePlaylist({
    credentialRef: { userId: "user-1" },
    playlistId: "playlist-1",
    expectedChannelId: "UC_ACTIVE",
  });

  assert.deepEqual(result, { deleted: true, playlistId: "playlist-1" });
  assert.equal(calls.delete, 1);
  assert.equal(calls.persist, 1);
});

test("deletePlaylist fails closed when active channel and playlist owner mismatch", async () => {
  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async () => null,
      updatePlaylist: async () => ({
        id: "p-updated",
        title: "Updated",
        description: "",
        privacyStatus: "private",
      }),
      getPlaylistForDelete: async ({ playlistId }) => ({
        id: playlistId,
        channelId: "UC_OTHER",
        title: "To delete",
      }),
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        activeWriteChannel: { id: "UC_ACTIVE", title: "Active" },
        shouldPersistSelection: true,
        userId: "user-1",
      }),
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      services.deletePlaylist({
        credentialRef: { userId: "user-1" },
        playlistId: "playlist-1",
        expectedChannelId: "UC_ACTIVE",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "WRITE_CHANNEL_MISMATCH"
  );
});

test("deletePlaylist blocks unresolved guardrail and never reaches remote delete path", async () => {
  const calls = { preflight: 0, delete: 0 };

  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: undefined,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => ({
        id: "p-created",
        title,
        description: description ?? "",
        privacyStatus,
      }),
      getPlaylistForUpdate: async () => null,
      updatePlaylist: async () => ({
        id: "p-updated",
        title: "Updated",
        description: "",
        privacyStatus: "private",
      }),
      getPlaylistForDelete: async ({ playlistId }) => {
        calls.preflight += 1;
        return { id: playlistId, channelId: "UC_ACTIVE", title: "To delete" };
      },
      deletePlaylist: async () => {
        calls.delete += 1;
      },
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => {
        throw new DomainError({
          code: "WRITE_CHANNEL_UNRESOLVED",
          message: "Cannot resolve active write channel for the current OAuth session",
          details: { expectedChannelId: "UC_EXPECTED" },
        });
      },
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      services.deletePlaylist({
        credentialRef: { userId: "user-1" },
        playlistId: "playlist-1",
        expectedChannelId: "UC_EXPECTED",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "WRITE_CHANNEL_UNRESOLVED");
      assert.deepEqual(error.details, { expectedChannelId: "UC_EXPECTED" });
      return true;
    }
  );

  assert.deepEqual(calls, { preflight: 0, delete: 0 });
});
