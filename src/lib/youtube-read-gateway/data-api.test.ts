import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import { getDataApiReadsEnabled, setDataApiReadsEnabled } from "@/lib/db";
import { DomainError } from "@/lib/video-metadata/contracts";
import {
  assertDataApiReadsAuthorized,
  createYoutubeClient,
  getChannelForSync,
  getPublicChannelSnapshot,
  getVideoDetailsContext,
  getVideosMetadataContextBatch,
  listSupportedLanguages,
  listUploadsPlaylistVideoIds,
  parseIso8601DurationToSeconds,
} from "./data-api";

// The "Data API reads" toggle (owner instruction, 2026-09-22): default-enabled, unlike Gate B's
// default-disabled Live Writes, so a fresh install never silently blocks reads.
test("assertDataApiReadsAuthorized / createYoutubeClient: default-enabled, throws data_api_reads_disabled when turned off", async () => {
  const alreadyEnabled = await getDataApiReadsEnabled();
  assert.equal(alreadyEnabled, true, "sanity check -- defaults to enabled, never reset on boot");

  await assertDataApiReadsAuthorized();
  await createYoutubeClient(undefined);

  await setDataApiReadsEnabled(false);
  try {
    await assert.rejects(
      () => assertDataApiReadsAuthorized(),
      (error: unknown) => error instanceof DomainError && error.code === "data_api_reads_disabled"
    );
    await assert.rejects(
      () => createYoutubeClient(undefined),
      (error: unknown) => error instanceof DomainError && error.code === "data_api_reads_disabled"
    );
  } finally {
    await setDataApiReadsEnabled(true);
  }
});

function fakeYoutubeClient(overrides: {
  channelsList?: youtube_v3.Youtube["channels"]["list"];
  playlistItemsList?: youtube_v3.Youtube["playlistItems"]["list"];
  videosList?: youtube_v3.Youtube["videos"]["list"];
  videosUpdate?: youtube_v3.Youtube["videos"]["update"];
  i18nLanguagesList?: youtube_v3.Youtube["i18nLanguages"]["list"];
}): youtube_v3.Youtube {
  return {
    channels: { list: overrides.channelsList },
    playlistItems: { list: overrides.playlistItemsList },
    videos: { list: overrides.videosList, update: overrides.videosUpdate },
    i18nLanguages: { list: overrides.i18nLanguagesList },
  } as unknown as youtube_v3.Youtube;
}

test("getVideosMetadataContextBatch chunks requests into groups of at most 50 video ids", async () => {
  const requestedBatches: string[][] = [];
  const videoIds = Array.from({ length: 120 }, (_, i) => `v${i + 1}`);

  const youtube = fakeYoutubeClient({
    videosList: (async (args: { id?: string[] }) => {
      const batch = args.id ?? [];
      requestedBatches.push(batch);
      return {
        data: {
          items: batch.map((id) => ({
            id,
            etag: `etag-${id}`,
            snippet: {
              title: `Title ${id}`,
              description: `Description ${id}`,
              publishedAt: "2026-01-01T00:00:00.000Z",
              defaultLanguage: "en",
              defaultAudioLanguage: "en",
              thumbnails: { default: { url: `https://example.com/${id}.jpg`, width: 120, height: 90 } },
            },
            status: { privacyStatus: "public" },
            localizations: { es: { title: `ES ${id}`, description: `ES desc ${id}` } },
          })),
        },
      };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const results = await getVideosMetadataContextBatch(youtube, videoIds);

  assert.equal(results.length, 120);
  assert.equal(requestedBatches.length, 3);
  assert.equal(requestedBatches[0]?.length, 50);
  assert.equal(requestedBatches[1]?.length, 50);
  assert.equal(requestedBatches[2]?.length, 20);

  const first = results[0];
  assert.equal(first?.videoId, "v1");
  assert.equal(first?.privacyStatus, "public");
  assert.equal(first?.defaultLanguage, "en");
  assert.deepEqual(first?.existingLocalizations, {
    es: { title: "ES v1", description: "ES desc v1" },
  });
  assert.deepEqual(first?.thumbnails.default, {
    url: "https://example.com/v1.jpg",
    width: 120,
    height: 90,
  });
});

// docs/roadmap/plans/STUDIO_PARITY_PLAN.md Slice S1: view/comment/like counts, requested via the
// videos.list `statistics` part. The real API returns these as decimal strings and omits a field
// entirely when unavailable (e.g. comments disabled) -- never a false "0" fact.
test("getVideosMetadataContextBatch parses statistics as numbers and requests the statistics part", async () => {
  let requestedParts: string[] | undefined;

  const youtube = fakeYoutubeClient({
    videosList: (async (args: { part?: string[] }) => {
      requestedParts = args.part;
      return {
        data: {
          items: [
            {
              id: "v1",
              etag: "etag-v1",
              snippet: { title: "T", description: "D", publishedAt: "2026-01-01T00:00:00.000Z" },
              status: { privacyStatus: "public" },
              statistics: { viewCount: "12345", commentCount: "42", likeCount: "99" },
            },
            {
              id: "v2",
              etag: "etag-v2",
              snippet: { title: "T2", description: "D2", publishedAt: "2026-01-01T00:00:00.000Z" },
              status: { privacyStatus: "public" },
              // Comments/likes disabled or hidden -- statistics present but fields absent.
              statistics: { viewCount: "7" },
            },
          ],
        },
      };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const results = await getVideosMetadataContextBatch(youtube, ["v1", "v2"]);

  assert.ok(requestedParts?.includes("statistics"));
  assert.deepEqual(
    { viewCount: results[0]?.viewCount, commentCount: results[0]?.commentCount, likeCount: results[0]?.likeCount },
    { viewCount: 12345, commentCount: 42, likeCount: 99 }
  );
  assert.deepEqual(
    { viewCount: results[1]?.viewCount, commentCount: results[1]?.commentCount, likeCount: results[1]?.likeCount },
    { viewCount: 7, commentCount: null, likeCount: null }
  );
});

// Phase 7 slice K (owner spec §10 -- AC-DUR-02/AC-DUR-03). Never invents a fact: unparseable or
// absent input is null; an all-zero duration ("P0D"/"PT0S", YouTube's placeholder for an
// in-progress live broadcast/premiere with no fixed length yet) is ALSO null, never a literal 0.
test("parseIso8601DurationToSeconds converts every plausible YouTube duration format to whole seconds", () => {
  assert.equal(parseIso8601DurationToSeconds("PT10M30S"), 630);
  assert.equal(parseIso8601DurationToSeconds("PT1H"), 3600);
  assert.equal(parseIso8601DurationToSeconds("P1DT2H3M4S"), 24 * 3600 + 2 * 3600 + 3 * 60 + 4);
  assert.equal(parseIso8601DurationToSeconds("PT45S"), 45);
  assert.equal(parseIso8601DurationToSeconds("P1D"), 24 * 3600);
});

test("parseIso8601DurationToSeconds returns null for an all-zero duration, never a literal 0", () => {
  assert.equal(parseIso8601DurationToSeconds("P0D"), null);
  assert.equal(parseIso8601DurationToSeconds("PT0S"), null);
});

test("parseIso8601DurationToSeconds returns null for missing or unparseable input, never a fabricated value", () => {
  assert.equal(parseIso8601DurationToSeconds(null), null);
  assert.equal(parseIso8601DurationToSeconds(undefined), null);
  assert.equal(parseIso8601DurationToSeconds(""), null);
  assert.equal(parseIso8601DurationToSeconds("not a duration"), null);
  assert.equal(parseIso8601DurationToSeconds("PT"), null);
  assert.equal(parseIso8601DurationToSeconds("P"), null);
});

test("getVideosMetadataContextBatch requests contentDetails and parses duration into whole seconds, never inventing a value for a missing one", async () => {
  let requestedParts: string[] | undefined;

  const youtube = fakeYoutubeClient({
    videosList: (async (args: { part?: string[] }) => {
      requestedParts = args.part;
      return {
        data: {
          items: [
            {
              id: "v1",
              etag: "etag-v1",
              snippet: { title: "T", description: "D", publishedAt: "2026-01-01T00:00:00.000Z" },
              status: { privacyStatus: "public" },
              contentDetails: { duration: "PT10M30S" },
            },
            {
              id: "v2",
              etag: "etag-v2",
              snippet: { title: "T2", description: "D2", publishedAt: "2026-01-01T00:00:00.000Z" },
              status: { privacyStatus: "public" },
              // No contentDetails at all -- e.g. an older cached response shape.
            },
          ],
        },
      };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const results = await getVideosMetadataContextBatch(youtube, ["v1", "v2"]);

  assert.ok(requestedParts?.includes("contentDetails"));
  assert.equal(results[0]?.durationSeconds, 630);
  assert.equal(results[1]?.durationSeconds, null);
});

// Owner instruction, 2026-09-26: Content tab's "Publish" column needs YouTube's own
// scheduled-publish time for a still-private video (`status.publishAt`), distinct from
// `snippet.publishedAt`. `status` was already a requested part (for `privacyStatus`), so this is
// a pure extraction change, not a new API request shape -- verified here by asserting the field
// is read correctly for a scheduled video, a public one (field absent), and one where `status` is
// missing entirely (e.g. an older cached response shape), never inventing a value.
test("getVideosMetadataContextBatch reads status.publishAt for a scheduled video, and null when absent", async () => {
  const youtube = fakeYoutubeClient({
    videosList: (async () => ({
      data: {
        items: [
          {
            id: "v1",
            etag: "etag-v1",
            snippet: { title: "T", description: "D", publishedAt: "2026-01-01T00:00:00.000Z" },
            status: { privacyStatus: "private", publishAt: "2026-10-15T09:00:00.000Z" },
          },
          {
            id: "v2",
            etag: "etag-v2",
            snippet: { title: "T2", description: "D2", publishedAt: "2026-01-01T00:00:00.000Z" },
            status: { privacyStatus: "public" },
          },
          {
            id: "v3",
            etag: "etag-v3",
            snippet: { title: "T3", description: "D3", publishedAt: "2026-01-01T00:00:00.000Z" },
            // No `status` at all.
          },
        ],
      },
    })) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const results = await getVideosMetadataContextBatch(youtube, ["v1", "v2", "v3"]);

  assert.equal(results[0]?.publishAt, "2026-10-15T09:00:00.000Z");
  assert.equal(results[1]?.publishAt, null);
  assert.equal(results[2]?.publishAt, null);
});

test("AC-QUOTA-01: the exact approved 75-video fixture issues 2 videos.list calls (chunks of 50 and 25), never 75", async () => {
  const requestedBatches: string[][] = [];
  const videoIds = Array.from({ length: 75 }, (_, i) => `v${i + 1}`);

  const youtube = fakeYoutubeClient({
    videosList: (async (args: { id?: string[] }) => {
      const batch = args.id ?? [];
      requestedBatches.push(batch);
      return { data: { items: [] } };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  await getVideosMetadataContextBatch(youtube, videoIds);

  assert.equal(requestedBatches.length, 2, "ceil(75/50) = 2 calls");
  assert.equal(requestedBatches[0]?.length, 50);
  assert.equal(requestedBatches[1]?.length, 25);
});

test("getVideosMetadataContextBatch returns an empty array without calling the API for an empty id list", async () => {
  let calls = 0;
  const youtube = fakeYoutubeClient({
    videosList: (async () => {
      calls += 1;
      return { data: { items: [] } };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const results = await getVideosMetadataContextBatch(youtube, []);

  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("listUploadsPlaylistVideoIds paginates through all pages and dedupes ids", async () => {
  const pages = [
    { items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }], nextPageToken: "page-2" },
    { items: [{ contentDetails: { videoId: "v2" } }, { contentDetails: { videoId: "v3" } }], nextPageToken: undefined },
  ];
  let call = 0;

  const youtube = fakeYoutubeClient({
    playlistItemsList: (async () => {
      const page = pages[call];
      call += 1;
      return { data: page };
    }) as unknown as youtube_v3.Youtube["playlistItems"]["list"],
  });

  const videoIds = await listUploadsPlaylistVideoIds(youtube, "UU_TEST");

  assert.deepEqual(videoIds, ["v1", "v2", "v3"]);
  assert.equal(call, 2);
});

test("getChannelForSync resolves the authenticated channel's own uploads playlist when no channelId is given", async () => {
  let receivedArgs: unknown;
  const youtube = fakeYoutubeClient({
    channelsList: (async (args: unknown) => {
      receivedArgs = args;
      return {
        data: {
          items: [
            {
              id: "UC_MINE",
              snippet: { title: "My Channel", thumbnails: { default: { url: "https://example.com/t.jpg" } } },
              contentDetails: { relatedPlaylists: { uploads: "UU_MINE" } },
            },
          ],
        },
      };
    }) as unknown as youtube_v3.Youtube["channels"]["list"],
  });

  const channel = await getChannelForSync(youtube);

  assert.deepEqual(channel, {
    channelId: "UC_MINE",
    title: "My Channel",
    thumbnailUrl: "https://example.com/t.jpg",
    uploadsPlaylistId: "UU_MINE",
  });
  assert.deepEqual(receivedArgs, { part: ["snippet", "contentDetails"], mine: true });
});

test("getChannelForSync returns null when the channel has no uploads playlist", async () => {
  const youtube = fakeYoutubeClient({
    channelsList: (async () => ({
      data: { items: [{ id: "UC_X", snippet: { title: "X" }, contentDetails: {} }] },
    })) as unknown as youtube_v3.Youtube["channels"]["list"],
  });

  const channel = await getChannelForSync(youtube, "UC_X");
  assert.equal(channel, null);
});

// The write primitive `applyVideoDetailsUpdate` and the `pickWritable*` whitelists (and their
// AC-DETAILS-01..04 acceptance tests) moved to `src/lib/youtube-write-gateway/index.test.ts`
// (2026-09-21 single-funnel refactor) -- this file keeps only the read-side
// `getVideoDetailsContext` tests below.

const BASE_VIDEO_ITEM = {
  etag: "etag-1",
  snippet: {
    title: "Original Title",
    description: "Original description",
    tags: ["a", "b"],
    categoryId: "22",
    defaultLanguage: "en",
  },
  status: {
    privacyStatus: "public",
    license: "youtube",
    embeddable: true,
    publicStatsViewable: true,
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: false,
  },
  recordingDetails: { recordingDate: null },
};

test("getVideoDetailsContext returns snippet/status/recordingDate but never localizations", async () => {
  const youtube = fakeYoutubeClient({
    videosList: (async (args: { part?: string[] }) => {
      assert.deepEqual(args.part, ["snippet", "status", "recordingDetails"]);
      return { data: { items: [BASE_VIDEO_ITEM] } };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const context = await getVideoDetailsContext(youtube, "v1");
  assert.ok(context);
  assert.equal(context!.etag, "etag-1");
  assert.equal(context!.snippet.title, "Original Title");
  assert.equal(context!.status.privacyStatus, "public");
  assert.equal(context!.recordingDate, null);
  assert.equal("localizations" in context!, false);
});

test("getVideoDetailsContext returns null when the video has no snippet/status", async () => {
  const youtube = fakeYoutubeClient({
    videosList: (async () => ({ data: { items: [] } })) as unknown as youtube_v3.Youtube["videos"]["list"],
  });
  const context = await getVideoDetailsContext(youtube, "missing");
  assert.equal(context, null);
});

test("listSupportedLanguages maps id/snippet.name and sorts by code, dropping items with no id", async () => {
  const youtube = fakeYoutubeClient({
    i18nLanguagesList: (async () => ({
      data: {
        items: [
          { id: "es", snippet: { name: "Spanish" } },
          { id: "en", snippet: { name: "English" } },
          { id: undefined, snippet: { name: "Should be dropped" } },
          { id: "en-US", snippet: { name: "English (United States)" } },
        ],
      },
    })) as unknown as youtube_v3.Youtube["i18nLanguages"]["list"],
  });

  const languages = await listSupportedLanguages(youtube);

  assert.deepEqual(languages, [
    { code: "en", name: "English" },
    { code: "en-US", name: "English (United States)" },
    { code: "es", name: "Spanish" },
  ]);
});

test("listSupportedLanguages falls back to the code as the name when snippet.name is missing", async () => {
  const youtube = fakeYoutubeClient({
    i18nLanguagesList: (async () => ({
      data: { items: [{ id: "xx" }] },
    })) as unknown as youtube_v3.Youtube["i18nLanguages"]["list"],
  });

  const languages = await listSupportedLanguages(youtube);

  assert.deepEqual(languages, [{ code: "xx", name: "xx" }]);
});

// Phase 9 slice 3 (docs/roadmap/plans/PHASE_9_PLAN.md §6/§7) -- getPublicChannelSnapshot.
test("getPublicChannelSnapshot requests exactly part=[snippet,statistics] and id=[channelId], never mine:true", async () => {
  let receivedArgs: unknown;
  const youtube = fakeYoutubeClient({
    channelsList: (async (args: unknown) => {
      receivedArgs = args;
      return {
        data: {
          items: [
            {
              id: "UC_COMPETITOR",
              snippet: { title: "Competitor Channel" },
              statistics: { subscriberCount: "12300", viewCount: "456000", videoCount: "42", hiddenSubscriberCount: false },
            },
          ],
        },
      };
    }) as unknown as youtube_v3.Youtube["channels"]["list"],
  });

  const snapshot = await getPublicChannelSnapshot(youtube, "UC_COMPETITOR");

  assert.deepEqual(receivedArgs, { part: ["snippet", "statistics"], id: ["UC_COMPETITOR"] });
  assert.deepEqual(snapshot, {
    channelId: "UC_COMPETITOR",
    title: "Competitor Channel",
    subscriberCount: 12300,
    viewCount: 456000,
    videoCount: 42,
  });
});

test("getPublicChannelSnapshot reports subscriberCount as null when hiddenSubscriberCount is true, never the raw '0' YouTube returns for a hidden count", async () => {
  const youtube = fakeYoutubeClient({
    channelsList: (async () => ({
      data: {
        items: [
          {
            id: "UC_HIDDEN",
            snippet: { title: "Hidden Subscriber Count Channel" },
            statistics: { subscriberCount: "0", viewCount: "1000", videoCount: "5", hiddenSubscriberCount: true },
          },
        ],
      },
    })) as unknown as youtube_v3.Youtube["channels"]["list"],
  });

  const snapshot = await getPublicChannelSnapshot(youtube, "UC_HIDDEN");

  assert.equal(snapshot?.subscriberCount, null);
  assert.equal(snapshot?.viewCount, 1000);
});

test("getPublicChannelSnapshot never fabricates a 0 for a statistics field the API omits entirely", async () => {
  const youtube = fakeYoutubeClient({
    channelsList: (async () => ({
      data: {
        items: [
          {
            id: "UC_PARTIAL",
            snippet: { title: "Partial Stats Channel" },
            statistics: { subscriberCount: "500" },
          },
        ],
      },
    })) as unknown as youtube_v3.Youtube["channels"]["list"],
  });

  const snapshot = await getPublicChannelSnapshot(youtube, "UC_PARTIAL");

  assert.equal(snapshot?.subscriberCount, 500);
  assert.equal(snapshot?.viewCount, null);
  assert.equal(snapshot?.videoCount, null);
});

test("getPublicChannelSnapshot returns null when no channel matches the given id", async () => {
  const youtube = fakeYoutubeClient({
    channelsList: (async () => ({ data: { items: [] } })) as unknown as youtube_v3.Youtube["channels"]["list"],
  });

  const snapshot = await getPublicChannelSnapshot(youtube, "UC_MISSING");

  assert.equal(snapshot, null);
});
