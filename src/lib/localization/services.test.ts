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
  const trackedLanguagesByChannel = new Map<string, string[]>();

  const services = createLocalizationServices({
    channelStore: {
      getChannel: async (channelId) => (channelId === channel.channelId ? channel : null),
      listVideosByChannel: async (channelId) =>
        channelId === channel.channelId ? videos : [],
      getTargetLanguages: async (channelId) => trackedLanguagesByChannel.get(channelId) ?? [],
      setTargetLanguages: async (channelId, languages) => {
        trackedLanguagesByChannel.set(channelId, languages);
      },
    },
    xlsxBuilder: {
      buildWorkbook: async (args) => {
        buildWorkbookCalls.push(args);
        return { buffer: Buffer.from("fake-xlsx"), rowCount: args.videos.length };
      },
    },
  });

  return { services, buildWorkbookCalls, trackedLanguagesByChannel };
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

// ---------------------------------------------------------------------------
// Tracked languages (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md §7.2/E5, owner instruction
// 2026-09-21). Acceptance fixed before implementation: a tracked language appears as a column
// even with zero real translations (the whole point -- solving the chicken-and-egg gap where a
// language can't be proposed for translation until it already has one); untracking a language
// that still has real data must NOT hide it, since `languages` is a union of tracked and real.
// ---------------------------------------------------------------------------

test("addTrackedLanguage: a language with zero real translations appears in both languages and trackedLanguages", async () => {
  const { services } = createFixture([makeVideo({ existingLocalizations: {} })]);

  const result = await services.addTrackedLanguage({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
    language: "fr",
  });
  assert.deepEqual(result.trackedLanguages, ["fr"]);

  const overview = await services.getLocalizationOverview({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
  });
  assert.deepEqual(overview.languages, ["fr"]);
  assert.deepEqual(overview.trackedLanguages, ["fr"]);
  // Zero real translations -- every video is "missing" this tracked language, never silently
  // marked complete or present just because it's tracked.
  assert.deepEqual(overview.videos[0]?.missingLanguages, ["fr"]);
  assert.deepEqual(overview.videos[0]?.presentLanguages, []);
});

test("addTrackedLanguage: adding an already-tracked language is idempotent, not duplicated", async () => {
  const { services } = createFixture([makeVideo()]);
  await services.addTrackedLanguage({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST", language: "fr" });
  const result = await services.addTrackedLanguage({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
    language: "fr",
  });
  assert.deepEqual(result.trackedLanguages, ["fr"]);
});

test("addTrackedLanguage: rejects a malformed language code", async () => {
  const { services } = createFixture([makeVideo()]);
  await assert.rejects(
    () =>
      services.addTrackedLanguage({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST", language: "!!!" }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      return true;
    }
  );
});

test("removeTrackedLanguage: untracking a language with zero real translations removes its column entirely", async () => {
  const { services } = createFixture([makeVideo({ existingLocalizations: {} })]);
  await services.addTrackedLanguage({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST", language: "fr" });

  const result = await services.removeTrackedLanguage({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
    language: "fr",
  });
  assert.deepEqual(result.trackedLanguages, []);

  const overview = await services.getLocalizationOverview({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
  });
  assert.deepEqual(overview.languages, []);
});

test("removeTrackedLanguage: untracking a language that still has a real translation on a video does NOT hide its column", async () => {
  const { services } = createFixture([
    makeVideo({ existingLocalizations: { fr: { title: "FR", description: "FR desc" } } }),
  ]);
  await services.addTrackedLanguage({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST", language: "fr" });

  await services.removeTrackedLanguage({ credentialRef: { userId: "user-1" }, channelId: "UC_TEST", language: "fr" });

  const overview = await services.getLocalizationOverview({
    credentialRef: { userId: "user-1" },
    channelId: "UC_TEST",
  });
  // "fr" is gone from trackedLanguages but stays in the rendered `languages` union because real
  // data for it still exists -- untracking is a display preference, never a deletion.
  assert.deepEqual(overview.trackedLanguages, []);
  assert.deepEqual(overview.languages, ["fr"]);
  assert.deepEqual(overview.videos[0]?.presentLanguages, ["fr"]);
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
