import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createLocalizationServices } from "./services";
import type { StoredChannelRecord, StoredVideoRecord } from "./contracts";

function makeChannel(overrides: Partial<StoredChannelRecord> = {}): StoredChannelRecord {
  return {
    channelId: "UC_TEST",
    title: "Tropico Jazz",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_TEST",
    connectedUserId: "user-1",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function makeVideo(overrides: Partial<StoredVideoRecord> = {}): StoredVideoRecord {
  return {
    videoId: "v1",
    channelId: "UC_TEST",
    title: "Video 1",
    description: "Description 1",
    publishedAt: "2026-01-01T00:00:00.000Z",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    thumbnails: { default: { url: "https://example.com/v1.jpg", width: 120, height: 90 } },
    existingLocalizations: {},
    etag: "etag-v1",
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function createFixture(videos: StoredVideoRecord[], channel = makeChannel()) {
  const buildWorkbookCalls: Array<{ channel: StoredChannelRecord; videos: StoredVideoRecord[] }> = [];

  const services = createLocalizationServices({
    channelStore: {
      getChannel: async (channelId) => (channelId === channel.channelId ? channel : null),
      listVideosByChannel: async (channelId) =>
        channelId === channel.channelId ? videos : [],
    },
    xlsxBuilder: {
      buildWorkbook: async (args) => {
        buildWorkbookCalls.push(args);
        return { buffer: Buffer.from("fake-xlsx"), rowCount: args.videos.length };
      },
    },
  });

  return { services, buildWorkbookCalls };
}

test("getLocalizationOverview reports missing languages relative to the channel-wide language union", async () => {
  const videos = [
    makeVideo({ videoId: "v1", existingLocalizations: { es: { title: "ES", description: "ES desc" } } }),
    makeVideo({
      videoId: "v2",
      existingLocalizations: {
        es: { title: "ES2", description: "ES2 desc" },
        de: { title: "DE2", description: "DE2 desc" },
      },
    }),
  ];
  const { services } = createFixture(videos);

  const overview = await services.getLocalizationOverview({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
  });

  assert.deepEqual(overview.languages, ["de", "es"]);
  assert.equal(overview.totalVideos, 2);

  const v1 = overview.videos.find((v) => v.videoId === "v1");
  assert.deepEqual(v1?.presentLanguages, ["es"]);
  assert.deepEqual(v1?.missingLanguages, ["de"]);
  assert.equal(v1?.status, "missing");

  const v2 = overview.videos.find((v) => v.videoId === "v2");
  assert.deepEqual(v2?.presentLanguages, ["de", "es"]);
  assert.deepEqual(v2?.missingLanguages, []);
  assert.equal(v2?.status, "complete");
});

test("getLocalizationOverview treats a video with zero channel-wide languages as missing, not complete", async () => {
  const { services } = createFixture([makeVideo({ existingLocalizations: {} })]);

  const overview = await services.getLocalizationOverview({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
  });

  assert.deepEqual(overview.languages, []);
  assert.equal(overview.videos[0]?.status, "missing");
});

test("getLocalizationOverview fails with not_found for an unsynchronized channel", async () => {
  const { services } = createFixture([]);

  await assert.rejects(
    () =>
      services.getLocalizationOverview({
        credentialRef: { userId: "user-1" },
        channelId: "UC_NEVER_SYNCED",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "not_found");
      return true;
    }
  );
});

test("getVideoLocalizationDetail returns sorted remote locales for a known video", async () => {
  const { services } = createFixture([
    makeVideo({
      existingLocalizations: {
        fr: { title: "FR", description: "FR desc" },
        de: { title: "DE", description: "DE desc" },
      },
    }),
  ]);

  const detail = await services.getVideoLocalizationDetail({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
    videoId: "v1",
  });

  assert.equal(detail.originalTitle, "Video 1");
  assert.deepEqual(
    detail.locales.map((l) => l.language),
    ["de", "fr"]
  );
});

test("getVideoLocalizationDetail fails with not_found for an unknown video id", async () => {
  const { services } = createFixture([makeVideo()]);

  await assert.rejects(
    () =>
      services.getVideoLocalizationDetail({
        credentialRef: { userId: "user-1" },
        channelId: "UC_TEST",
        videoId: "does-not-exist",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "not_found");
      return true;
    }
  );
});

test("exportLocalizations exports the entire channel when no videoIds are given", async () => {
  const videos = [makeVideo({ videoId: "v1" }), makeVideo({ videoId: "v2" })];
  const { services, buildWorkbookCalls } = createFixture(videos);

  const result = await services.exportLocalizations({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
  });

  assert.equal(result.videoCount, 2);
  assert.equal(result.filename, "localizations-UC_TEST.xlsx");
  assert.equal(buildWorkbookCalls[0]?.videos.length, 2);
});

test("exportLocalizations scopes the export to the requested video ids", async () => {
  const videos = [makeVideo({ videoId: "v1" }), makeVideo({ videoId: "v2" })];
  const { services, buildWorkbookCalls } = createFixture(videos);

  const result = await services.exportLocalizations({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
    videoIds: ["v2"],
  });

  assert.equal(result.videoCount, 1);
  assert.deepEqual(
    buildWorkbookCalls[0]?.videos.map((v) => v.videoId),
    ["v2"]
  );
});

test("exportLocalizations rejects video ids that do not belong to the channel", async () => {
  const { services } = createFixture([makeVideo({ videoId: "v1" })]);

  await assert.rejects(
    () =>
      services.exportLocalizations({
        credentialRef: { userId: "user-1" },
        channelId: "UC_TEST",
        videoIds: ["v1", "not-in-channel"],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      return true;
    }
  );
});
