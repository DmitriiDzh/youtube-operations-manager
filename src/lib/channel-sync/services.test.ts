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
  const upsertCalls: Array<{ channelId: string; connectedUserId?: string | null; publishedAt?: string | null }> = [];

  return {
    channels,
    videos,
    upsertCalls,
    async upsertChannel(args: {
      channelId: string;
      title: string;
      thumbnailUrl: string | null;
      uploadsPlaylistId: string;
      connectedUserId?: string | null;
    }) {
      const existing = channels.get(args.channelId);
      upsertCalls.push(args);
      channels.set(args.channelId, {
        channelId: args.channelId,
        title: args.title,
        thumbnailUrl: args.thumbnailUrl,
        uploadsPlaylistId: args.uploadsPlaylistId,
        // Mirrors db.ts upsertChannel's contract (architecture audit H3): absent owner = unchanged.
        connectedUserId: args.connectedUserId ?? existing?.connectedUserId ?? null,
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
        durationSeconds: number | null;
        publishAt: string | null;
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
    /** When true the fake adapter calls the optional progress callbacks the way the real one does. */
    adapterReportsProgress: boolean;
    /** BL-118: the channel's YouTube creation time as the adapter would return it. */
    channelPublishedAt: string | null;
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
        publishedAt: overrides.channelPublishedAt ?? null,
      }),
      listUploadsPlaylistVideoIds: async ({ onPage }) => {
        if (overrides.adapterReportsProgress) {
          onPage?.(Math.min(50, videoIds.length));
          onPage?.(videoIds.length);
        }
        return videoIds;
      },
      getVideosMetadataBatch: async ({ videoIds: batch, onProgress }) => {
        videoMetadataCalls.push(batch);
        if (overrides.adapterReportsProgress) {
          onProgress?.(Math.min(50, batch.length), batch.length);
          onProgress?.(batch.length, batch.length);
        }
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
          durationSeconds: 630,
          publishAt: null,
        }));
      },
    },
    channelStore: store,
    logger: { info: () => undefined, error: () => undefined },
    channelAccess,
  });

  return { services, store, channelAccess, videoMetadataCalls };
}

test("BL-118: syncChannel hands the channel's YouTube creation time to the store (the analytics channel start date)", async () => {
  const { services, store } = createServicesFixture({ channelPublishedAt: "2026-08-13T09:30:00Z" });
  await services.syncChannel({ credentialRef: { userId: "u1" } });
  assert.equal(store.upsertCalls.length, 1);
  assert.equal(store.upsertCalls[0].publishedAt, "2026-08-13T09:30:00Z");
});

test("BL-118: a channel whose creation time the API omitted is passed as null (the store then leaves a stored value untouched)", async () => {
  const { services, store } = createServicesFixture();
  await services.syncChannel({ credentialRef: { userId: "u1" } });
  assert.equal(store.upsertCalls[0].publishedAt, null);
});

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

// FO-REQ-0015 item 6: channel_video_list carries the stored length (630 s in this fixture) and YouTube's live status (none given here,
// so null -- unknown, never invented), and both can be asked for by name.
test("listSyncedVideos returns each video's stored duration and live status, also as requested fields", async () => {
  const { services } = createServicesFixture({ videoIds: ["v1"] });
  const synced = await services.syncChannel({ credentialRef: { userId: "user-1" } });
  const listed = await services.listSyncedVideos({ credentialRef: { userId: "user-1" }, channelId: synced.channel.channelId });
  assert.deepEqual([listed.videos[0]?.durationSeconds, listed.videos[0]?.liveBroadcastContent], [630, null]);
  const slim = await services.listSyncedVideos({ credentialRef: { userId: "user-1" }, channelId: synced.channel.channelId, fields: ["durationSeconds", "liveBroadcastContent"] });
  assert.deepEqual(slim.videos[0], { videoId: "v1", durationSeconds: 630, liveBroadcastContent: null });
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

// Architecture audit 2026-10-01 (H3, docs/roadmap/plans/HARDENING_AUDIT_2026-10_PLAN.md AC-H3-1..3):
// only the implicit "my channel" sync may record who owns a channel; an explicit-id sync or a
// credential without a user id must never re-own or disconnect it.
test("AC-H3: implicit sync records the owner; explicit-id and user-less syncs never touch it", async () => {
  const { services, store } = createServicesFixture({ videoIds: [] });

  await services.syncChannel({ credentialRef: { userId: "owner-user" } });
  assert.equal(store.channels.get("UC_MINE")?.connectedUserId, "owner-user");
  assert.equal(store.upsertCalls.at(-1)?.connectedUserId, "owner-user");

  await services.syncChannel({ credentialRef: { userId: "someone-else" }, channelId: "UC_MINE" });
  assert.equal(store.upsertCalls.at(-1)?.connectedUserId, undefined);
  assert.equal(store.channels.get("UC_MINE")?.connectedUserId, "owner-user");

  await services.syncChannel({ credentialRef: { accessToken: "ya29.raw" } });
  assert.equal(store.upsertCalls.at(-1)?.connectedUserId, undefined);
  assert.equal(store.channels.get("UC_MINE")?.connectedUserId, "owner-user");
});

// Progress (ADR 0015): the service reports stages and counts to an OPTIONAL reporter, never changes what
// it asks YouTube for (still ONE logical video-metadata call for all ids -- see the test above) and
// never changes its result.
test("syncChannel reports its stages and the video counts to a progress reporter", async () => {
  const { services } = createServicesFixture({ adapterReportsProgress: true, videoIds: Array.from({ length: 120 }, (_, i) => `v${i + 1}`) });
  const events: string[] = [];
  const progress = {
    stage: (text: string | null) => void events.push(`stage:${text}`),
    counts: (done: number, total: number) => void events.push(`counts:${done}/${total}`),
    isCancelRequested: () => false,
  };

  const result = await services.syncChannel({ credentialRef: { userId: "user-1" } }, { progress });

  assert.equal(result.videoCount, 120);
  assert.deepEqual(events.filter((e) => e.startsWith("stage:")).map((e) => e.replace(/\d+ found/, "N found")), [
    "stage:Resolving the channel on YouTube",
    "stage:Listing uploads",
    "stage:Listing uploads \u2014 N found",
    "stage:Listing uploads \u2014 N found",
    "stage:Reading video details",
    "stage:Saving videos locally",
  ]);
  // Counts: first the total becomes known (0/120), then the adapter's own reports, then done.
  assert.deepEqual(events.filter((e) => e.startsWith("counts:")), ["counts:0/120", "counts:50/120", "counts:120/120", "counts:120/120"]);
});

test("syncChannel without a reporter is unchanged", async () => {
  const { services, videoMetadataCalls } = createServicesFixture({ videoIds: ["v1", "v2"] });
  const result = await services.syncChannel({ credentialRef: { userId: "user-1" } });
  assert.equal(result.videoCount, 2);
  assert.equal(videoMetadataCalls.length, 1);
});

// Agent feedback (2026-10-04): channel_video_list needs field selection and paging.
test("listSyncedVideos with fields returns only those fields plus videoId, in the requested order, and pages with total/nextOffset", async () => {
  const { services, channelAccess } = createServicesFixture({ videoIds: ["v1", "v2", "v3"] });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_TEST" });
  await services.syncChannel({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST" });

  const first = await services.listSyncedVideos({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
    fields: ["title", "viewCount"],
    limit: 2,
  });
  assert.equal("videos" in first && first.videos.length, 2);
  assert.ok("total" in first);
  assert.equal(first.total, 3);
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual(Object.keys(first.videos[0]), ["videoId", "title", "viewCount"]);

  const second = await services.listSyncedVideos({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST", fields: ["title"], limit: 2, offset: 2 });
  assert.ok("total" in second);
  assert.equal(second.videos.length, 1);
  assert.equal(second.nextOffset, null);
  assert.notEqual(first.videos[0].videoId, second.videos[0].videoId);
});

test("listSyncedVideos with no fields/limit/offset still returns the full legacy shape (every field, no paging keys)", async () => {
  const { services, channelAccess } = createServicesFixture({ videoIds: ["v1"] });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_TEST" });
  await services.syncChannel({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST" });
  const result = await services.listSyncedVideos({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST" });
  assert.equal("total" in result, false);
  assert.ok("description" in result.videos[0] && "thumbnails" in result.videos[0]);
});

test("listSyncedVideos rejects an unknown field name and a limit above 500", async () => {
  const { services, channelAccess } = createServicesFixture({ videoIds: ["v1"] });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_TEST" });
  await services.syncChannel({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST" });
  for (const bad of [{ fields: ["nope"] }, { limit: 501 }, { limit: 0 }, { offset: -1 }]) {
    await assert.rejects(() => services.listSyncedVideos({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST", ...bad }));
  }
});
