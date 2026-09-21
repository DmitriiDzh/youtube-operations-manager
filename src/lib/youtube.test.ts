import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import {
  getChannelForSync,
  getVideoDetailsContext,
  getVideosMetadataContextBatch,
  listSupportedLanguages,
  listUploadsPlaylistVideoIds,
} from "./youtube";

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
