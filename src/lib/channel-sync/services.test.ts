import assert from "node:assert/strict";
import test from "node:test";
import { createChannelAccessService } from "@/lib/channel-access";
import { DomainError } from "./contracts";
import { createChannelSyncServices, type StoredChannelRecord, type StoredVideoRecord } from "./services";

function createFakeChannelAccess() {
  const selections = new Map<string, string>();
  const service = createChannelAccessService({
    async getSelectedChannelId(userId: string) {
      return selections.get(userId) ?? null;
    },
    async setSelectedChannelId(userId: string, channelId: string) {
      selections.set(userId, channelId);
    },
  });
  return { ...service, selections };
}

function createFakeStore() {
  const channels = new Map<string, StoredChannelRecord>();
  const videos = new Map<string, StoredVideoRecord[]>();

  return {
    channels,
    videos,
    async upsertChannel(args: {
      channelId: string;
      title: string;
      thumbnailUrl: string | null;
      uploadsPlaylistId: string;
      connectedUserId: string | null;
    }) {
      const existing = channels.get(args.channelId);
      channels.set(args.channelId, {
        channelId: args.channelId,
        title: args.title,
        thumbnailUrl: args.thumbnailUrl,
        uploadsPlaylistId: args.uploadsPlaylistId,
        connectedUserId: args.connectedUserId,
        connectedAt: existing?.connectedAt ?? new Date("2026-01-01T00:00:00.000Z"),
        lastSyncedAt: existing?.lastSyncedAt ?? null,
      });
    },
    async markChannelSynced(channelId: string, syncedAt: Date) {
      const existing = channels.get(channelId);
      if (!existing) return;
      channels.set(channelId, { ...existing, lastSyncedAt: syncedAt });
    },
    async listChannels() {
      return [...channels.values()];
    },
    async getChannel(channelId: string) {
      return channels.get(channelId) ?? null;
    },
    async upsertVideos(
      entries: Array<{
        videoId: string;
        channelId: string;
        title: string;
        description: string;
        publishedAt: string;
        privacyStatus: string;
        defaultLanguage: string | null;
        defaultAudioLanguage: string | null;
        thumbnails: Record<string, { url: string; width: number | null; height: number | null }>;
        existingLocalizations: Record<string, { title: string; description: string }>;
        etag: string | null;
        viewCount: number | null;
        commentCount: number | null;
        likeCount: number | null;
      }>,
      syncedAt: Date
    ) {
      for (const entry of entries) {
        const current = videos.get(entry.channelId) ?? [];
        const withoutEntry = current.filter((v) => v.videoId !== entry.videoId);
        withoutEntry.push({ ...entry, lastSyncedAt: syncedAt });
        videos.set(entry.channelId, withoutEntry);
      }
    },
    async listVideosByChannel(channelId: string) {
      return videos.get(channelId) ?? [];
    },
  };
}

function createServicesFixture(
  overrides: Partial<{
    videoIds: string[];
    videoMetadataCalls: string[][];
  }> = {}
) {
  const store = createFakeStore();
  const channelAccess = createFakeChannelAccess();
  const videoMetadataCalls: string[][] = overrides.videoMetadataCalls ?? [];
  const videoIds = overrides.videoIds ?? Array.from({ length: 120 }, (_, i) => `v${i + 1}`);

  const services = createChannelSyncServices({
    authResolver: {
      resolve: async (args) => ({
        credentialRef: args.credentialRef as { userId: string },
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
        scopeSet: new Set(args.requiredScopes),
      }),
    },
    youtubeApi: {
      getChannelForSync: async ({ channelId }) => ({
        channelId: channelId ?? "UC_MINE",
        title: "Tropico Jazz",
        thumbnailUrl: "https://example.com/thumb.jpg",
        uploadsPlaylistId: "UU_MINE",
      }),
      listUploadsPlaylistVideoIds: async () => videoIds,
      getVideosMetadataBatch: async ({ videoIds: batch }) => {
        videoMetadataCalls.push(batch);
        return batch.map((videoId) => ({
          videoId,
          title: `Title ${videoId}`,
          description: `Description ${videoId}`,
          publishedAt: "2026-01-01T00:00:00.000Z",
          privacyStatus: "public",
          defaultLanguage: "en",
          defaultAudioLanguage: "en",
          thumbnails: { default: { url: `https://example.com/${videoId}.jpg`, width: 120, height: 90 } },
          existingLocalizations: { es: { title: `ES ${videoId}`, description: `ES desc ${videoId}` } },
          etag: `etag-${videoId}`,
          viewCount: 100,
          commentCount: 10,
          likeCount: 20,
        }));
      },
    },
    channelStore: store,
    logger: { info: () => undefined, error: () => undefined },
    channelAccess,
  });

  return { services, store, channelAccess, videoMetadataCalls };
}

test("syncChannel persists channel and videos and returns a stable summary", async () => {
  const { services, store } = createServicesFixture({ videoIds: ["v1", "v2"] });

  const result = await services.syncChannel({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
  });

  assert.equal(result.channel.channelId, "UC_TEST");
  assert.equal(result.channel.title, "Tropico Jazz");
  assert.equal(result.videoCount, 2);
  assert.equal(typeof result.syncedAt, "string");
  assert.ok(result.channel.lastSyncedAt);

  const storedVideos = await store.listVideosByChannel("UC_TEST");
  assert.equal(storedVideos.length, 2);
});

test("syncChannel delegates all enumerated video ids to the batch adapter in one logical call, never one call per video", async () => {
  const videoIds = Array.from({ length: 120 }, (_, i) => `v${i + 1}`);
  const { services, videoMetadataCalls } = createServicesFixture({ videoIds });

  const result = await services.syncChannel({
    credentialRef: { userId: "user-1" },
  });

  assert.equal(result.videoCount, 120);
  // The service hands the full enumerated id list to the adapter in a single call; chunking
  // into groups of <=50 ids per YouTube API request is the adapter's responsibility and is
  // covered directly against the real googleapis client shape in src/lib/youtube.test.ts.
  assert.equal(videoMetadataCalls.length, 1);
  assert.equal(videoMetadataCalls[0]?.length, 120);
});

test("syncChannel exposes existing localization languages per video", async () => {
  const { services } = createServicesFixture({ videoIds: ["v1"] });

  // No explicit channelId -- this is the "sync my own channel" path, which is what actually
  // makes the resulting channel the caller's active channel (see the CHANNEL_NOT_ACTIVE tests
  // below), so listSyncedVideos for it is allowed afterward.
  const synced = await services.syncChannel({ credentialRef: { userId: "user-1" } });

  const listed = await services.listSyncedVideos({
    credentialRef: { userId: "user-1" },
    channelId: synced.channel.channelId,
  });

  assert.equal(listed.videos.length, 1);
  assert.deepEqual(listed.videos[0]?.existingLocalizationLanguages, ["es"]);
  assert.deepEqual(listed.videos[0]?.existingLocalizations, {
    es: { title: "ES v1", description: "ES desc v1" },
  });
});

test("syncChannel re-sync replaces prior video rows for the same channel without duplication", async () => {
  const { services, store } = createServicesFixture({ videoIds: ["v1", "v2"] });

  await services.syncChannel({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST" });
  await services.syncChannel({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST" });

  const storedVideos = await store.listVideosByChannel("UC_TEST");
  assert.equal(storedVideos.length, 2);
});

test("syncChannel fails with not_found when the channel cannot be resolved", async () => {
  const { services } = createServicesFixture();
  const failingServices = createChannelSyncServices({
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
      getChannelForSync: async () => null,
      listUploadsPlaylistVideoIds: async () => [],
      getVideosMetadataBatch: async () => [],
    },
    channelStore: createFakeStore(),
    logger: { info: () => undefined, error: () => undefined },
    channelAccess: createFakeChannelAccess(),
  });

  await assert.rejects(
    () => failingServices.syncChannel({ credentialRef: { userId: "user-1" } }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "not_found");
      return true;
    }
  );

  void services;
});

test("syncChannel rejects invalid input before calling the YouTube adapter", async () => {
  const { services } = createServicesFixture();

  await assert.rejects(
    () => services.syncChannel({ credentialRef: {} }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      return true;
    }
  );
});

test("listChannels returns persisted channels", async () => {
  const { services } = createServicesFixture({ videoIds: [] });

  // Implicit ("my own channel") sync -- makes the resolved channel the caller's active channel.
  const synced = await services.syncChannel({ credentialRef: { userId: "user-1" } });
  const result = await services.listChannels({ credentialRef: { userId: "user-1" } });

  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0]?.channelId, synced.channel.channelId);
});

// Owner's requirement (2026-09-20): "любую информацию... исключительно по каналу что сейчас
// активен" -- reproduces the exact real-world report that prompted it (a device that had
// synced multiple different channels over time showed all of them in the Sync picker).
test("listChannels: a second, differently-synced channel does not leak into another user's list (RISK-02)", async () => {
  const { services } = createServicesFixture({ videoIds: [] });

  // Explicit channelId -- e.g. an earlier test session's channel, re-synced from the picker.
  await services.syncChannel({ credentialRef: { userId: "user-1" }, channelId: "UC_OTHER" });
  await services.syncChannel({ credentialRef: { userId: "user-2" } }); // user-2's own channel

  const result = await services.listChannels({ credentialRef: { userId: "user-2" } });

  assert.equal(result.channels.length, 1);
  assert.notEqual(result.channels[0]?.channelId, "UC_OTHER");
});

test("listChannels returns nothing for a session whose active channel was never resolved", async () => {
  const { services } = createServicesFixture({ videoIds: [] });

  await services.syncChannel({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST" }); // explicit -- not activated

  const result = await services.listChannels({ credentialRef: { userId: "user-1" } });

  assert.deepEqual(result.channels, []);
});

test("listSyncedVideos returns an empty list for the active channel that has never been synced (zero video rows)", async () => {
  const { services, channelAccess } = createServicesFixture({ videoIds: [] });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_NEVER_SYNCED" });

  const result = await services.listSyncedVideos({
    credentialRef: { userId: "user-1" },
    channelId: "UC_NEVER_SYNCED",
  });

  assert.deepEqual(result.videos, []);
  assert.equal(result.channelId, "UC_NEVER_SYNCED");
});

test("listSyncedVideos rejects a channelId that is not the caller's active channel (CHANNEL_NOT_ACTIVE)", async () => {
  const { services } = createServicesFixture({ videoIds: ["v1"] });
  await services.syncChannel({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST" }); // explicit -- not activated

  await assert.rejects(
    () =>
      services.listSyncedVideos({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST" }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "CHANNEL_NOT_ACTIVE");
      return true;
    }
  );
});

test("listSyncedVideos rejects any request with no resolvable caller identity", async () => {
  const { services } = createServicesFixture({ videoIds: ["v1"] });

  await assert.rejects(
    () =>
      services.listSyncedVideos({
        credentialRef: { accessToken: "tok" },
        channelId: "UC_TEST",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "CHANNEL_NOT_ACTIVE");
      return true;
    }
  );
});

test("syncChannel with an explicit channelId never changes the caller's active channel", async () => {
  const { services, channelAccess } = createServicesFixture({ videoIds: [] });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_MINE_ALREADY" });

  await services.syncChannel({ credentialRef: { userId: "user-1" }, channelId: "UC_SOMEONE_ELSE" });

  assert.equal(await channelAccess.getActiveChannelId("user-1"), "UC_MINE_ALREADY");
});
