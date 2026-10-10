import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import { getDataApiReadsEnabled, setDataApiReadsEnabled } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import {
  assertDataApiReadsAuthorized,
  createYoutubeClient,
  getChannelForSync,
  getPublicChannelSnapshot,
  getPublicChannelStats,
  searchPublicMusicVideos,
  getPublicVideoSnapshots,
  getVideoDetailsContext,
  getVideosMetadataContextBatch,
  listSupportedLanguages,
  listUploadsPlaylistFirstPage,
  listUploadsPlaylistPage,
  getPublicVideoStatsBatch,
  listUploadsPlaylistVideoIds,
  parseIso8601DurationToSeconds,
  searchPublicChannels,
  getVideoCommentCounts,
  listOwnVideoComments,
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
  searchList?: youtube_v3.Youtube["search"]["list"];
}): youtube_v3.Youtube {
  return {
    channels: { list: overrides.channelsList },
    playlistItems: { list: overrides.playlistItemsList },
    videos: { list: overrides.videosList, update: overrides.videosUpdate },
    i18nLanguages: { list: overrides.i18nLanguagesList },
    search: { list: overrides.searchList },
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
    publishedAt: null, // BL-118: the fixture's snippet has no publishedAt -> null, never invented
  });
  assert.deepEqual(receivedArgs, { part: ["snippet", "contentDetails"], mine: true });
});

test("BL-118: getChannelForSync passes the channel's YouTube creation time (snippet.publishedAt) through", async () => {
  const youtube = fakeYoutubeClient({
    channelsList: (async () => ({
      data: {
        items: [
          {
            id: "UC_MINE",
            snippet: { title: "My Channel", publishedAt: "2026-08-13T09:30:00Z", thumbnails: { default: { url: "https://example.com/t.jpg" } } },
            contentDetails: { relatedPlaylists: { uploads: "UU_MINE" } },
          },
        ],
      },
    })) as unknown as youtube_v3.Youtube["channels"]["list"],
  });
  assert.equal((await getChannelForSync(youtube))?.publishedAt, "2026-08-13T09:30:00Z");
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

  assert.deepEqual(receivedArgs, { part: ["snippet", "statistics", "contentDetails"], id: ["UC_COMPETITOR"] });
  assert.deepEqual(snapshot, {
    channelId: "UC_COMPETITOR",
    title: "Competitor Channel",
    subscriberCount: 12300,
    hiddenSubscriberCount: false,
    viewCount: 456000,
    videoCount: 42,
    uploadsPlaylistId: null,
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
  assert.equal(
    snapshot?.hiddenSubscriberCount,
    true,
    "the real flag must be exposed, not just inferred downstream from subscriberCount === null (Phase 9 slice 9A)"
  );
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
  assert.equal(snapshot?.hiddenSubscriberCount, false, "a real, non-hidden count must never be flagged as hidden");
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

// Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md) -- getPublicChannelSnapshot now
// also reads contentDetails.relatedPlaylists.uploads in the SAME channels.list call.
test("getPublicChannelSnapshot reads uploadsPlaylistId from contentDetails, and null when the channel has none", async () => {
  const youtube = fakeYoutubeClient({
    channelsList: (async () => ({
      data: {
        items: [
          {
            id: "UC_COMPETITOR",
            snippet: { title: "Competitor Channel" },
            statistics: { subscriberCount: "100", viewCount: "200", videoCount: "3", hiddenSubscriberCount: false },
            contentDetails: { relatedPlaylists: { uploads: "UU_COMPETITOR" } },
          },
        ],
      },
    })) as unknown as youtube_v3.Youtube["channels"]["list"],
  });

  const snapshot = await getPublicChannelSnapshot(youtube, "UC_COMPETITOR");

  assert.equal(snapshot?.uploadsPlaylistId, "UU_COMPETITOR");
});

// Phase 9 slice 9B -- listUploadsPlaylistFirstPage, exactly one playlistItems.list call.
test("listUploadsPlaylistFirstPage issues exactly one playlistItems.list call, even when a nextPageToken is present", async () => {
  let callCount = 0;
  const youtube = fakeYoutubeClient({
    playlistItemsList: (async () => {
      callCount += 1;
      return {
        data: {
          items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }],
          nextPageToken: "there-is-more-but-must-never-be-fetched",
        },
      };
    }) as unknown as youtube_v3.Youtube["playlistItems"]["list"],
  });

  const videoIds = (await listUploadsPlaylistFirstPage(youtube, "UU_TEST")).map((v) => v.videoId);

  assert.deepEqual(videoIds, ["v1", "v2"]);
  assert.equal(callCount, 1, "must never fetch a second page, regardless of nextPageToken -- its own real YouTube quota cost must stay exactly 1 unit");
});

test("listUploadsPlaylistFirstPage dedupes ids within the single page and returns an empty array for an empty playlist", async () => {
  const youtube = fakeYoutubeClient({
    playlistItemsList: (async () => ({
      data: { items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v1" } }] },
    })) as unknown as youtube_v3.Youtube["playlistItems"]["list"],
  });

  const videoIds = (await listUploadsPlaylistFirstPage(youtube, "UU_TEST")).map((v) => v.videoId);
  assert.deepEqual(videoIds, ["v1"]);

  const emptyYoutube = fakeYoutubeClient({
    playlistItemsList: (async () => ({ data: { items: [] } })) as unknown as youtube_v3.Youtube["playlistItems"]["list"],
  });
  assert.deepEqual(await listUploadsPlaylistFirstPage(emptyYoutube, "UU_EMPTY"), []);
});

// Operator request 2026-10-04 -- listUploadsPlaylistPage: one call per page, token passed through, next token returned.
test("listUploadsPlaylistPage sends the given pageToken (and none for the first page), makes one call, and returns nextPageToken", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const youtube = fakeYoutubeClient({
    playlistItemsList: (async (params: Record<string, unknown>) => {
      requests.push(params);
      return {
        data: {
          items: [{ snippet: { title: "T" }, contentDetails: { videoId: "v9", videoPublishedAt: "2026-01-02T00:00:00Z" } }],
          nextPageToken: params.pageToken ? undefined : "TOKEN_2",
        },
      };
    }) as unknown as youtube_v3.Youtube["playlistItems"]["list"],
  });

  const first = await listUploadsPlaylistPage(youtube, "UU_TEST");
  assert.deepEqual(first, { items: [{ videoId: "v9", title: "T", publishedAt: "2026-01-02T00:00:00Z" }], nextPageToken: "TOKEN_2" });
  assert.equal(requests.length, 1);
  assert.equal("pageToken" in requests[0], false);
  assert.equal(requests[0].maxResults, 50);

  const second = await listUploadsPlaylistPage(youtube, "UU_TEST", "TOKEN_2");
  assert.equal(second.nextPageToken, null, "the last page has no token");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].pageToken, "TOKEN_2");
});

// Phase 9 slice 9B -- getPublicVideoSnapshots, a lean public batch video-stats fetch.
test("getPublicVideoSnapshots returns an empty array without calling the API for an empty id list", async () => {
  let called = false;
  const youtube = fakeYoutubeClient({
    videosList: (async () => {
      called = true;
      return { data: { items: [] } };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const snapshots = await getPublicVideoSnapshots(youtube, []);

  assert.deepEqual(snapshots, []);
  assert.equal(called, false);
});

test("getPublicVideoSnapshots requests snippet+statistics, parses stats, and never fabricates a missing field", async () => {
  let receivedArgs: unknown;
  const youtube = fakeYoutubeClient({
    videosList: (async (args: unknown) => {
      receivedArgs = args;
      return {
        data: {
          items: [
            {
              id: "v1",
              snippet: { title: "Video One", publishedAt: "2026-01-01T00:00:00.000Z", liveBroadcastContent: "none" },
              statistics: { viewCount: "100", likeCount: "10", commentCount: "2" },
              contentDetails: { duration: "PT2M5S" },
            },
            {
              id: "v2",
              snippet: { title: "Video Two" },
              statistics: {},
            },
          ],
        },
      };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const snapshots = await getPublicVideoSnapshots(youtube, ["v1", "v2"]);

  assert.deepEqual(receivedArgs, { part: ["snippet", "statistics", "contentDetails"], id: ["v1", "v2"] });
  assert.deepEqual(snapshots, [
    { videoId: "v1", title: "Video One", publishedAt: "2026-01-01T00:00:00.000Z", viewCount: 100, likeCount: 10, commentCount: 2, durationSeconds: 125, liveBroadcastContent: "none" },
    { videoId: "v2", title: "Video Two", publishedAt: null, viewCount: null, likeCount: null, commentCount: null, durationSeconds: null, liveBroadcastContent: null },
  ]);
});

test("getPublicVideoSnapshots chunks requests into groups of at most 50 video ids", async () => {
  const requestedBatches: string[][] = [];
  const videoIds = Array.from({ length: 60 }, (_, i) => `v${i + 1}`);

  const youtube = fakeYoutubeClient({
    videosList: (async (args: { id?: string[] }) => {
      const batch = args.id ?? [];
      requestedBatches.push(batch);
      return { data: { items: batch.map((id) => ({ id, snippet: { title: id }, statistics: {} })) } };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const snapshots = await getPublicVideoSnapshots(youtube, videoIds);

  assert.equal(snapshots.length, 60);
  assert.equal(requestedBatches.length, 2);
  assert.equal(requestedBatches[0]?.length, 50);
  assert.equal(requestedBatches[1]?.length, 10);
});

test("getPublicVideoSnapshots omits a requested id absent from the response, never fabricating a placeholder", async () => {
  const youtube = fakeYoutubeClient({
    videosList: (async () => ({
      data: { items: [{ id: "v1", snippet: { title: "Video One" }, statistics: {} }] },
    })) as unknown as youtube_v3.Youtube["videos"]["list"],
  });

  const snapshots = await getPublicVideoSnapshots(youtube, ["v1", "v2_deleted"]);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.videoId, "v1");
});

// Phase 9 slice 9C -- searchPublicChannels, exactly one search.list call.
test("searchPublicChannels requests part=snippet, type=channel, and maps id.channelId/snippet fields", async () => {
  let receivedArgs: unknown;
  const youtube = fakeYoutubeClient({
    searchList: (async (args: unknown) => {
      receivedArgs = args;
      return {
        data: {
          items: [
            { id: { channelId: "UC_A" }, snippet: { title: "Channel A", description: "About A" } },
            { id: { channelId: "UC_B" }, snippet: { title: "Channel B" } },
          ],
        },
      };
    }) as unknown as youtube_v3.Youtube["search"]["list"],
  });

  const results = await searchPublicChannels(youtube, "cooking", 25);

  assert.deepEqual(receivedArgs, { part: ["snippet"], q: "cooking", type: ["channel"], maxResults: 25 });
  assert.deepEqual(results, [
    { channelId: "UC_A", title: "Channel A", description: "About A" },
    { channelId: "UC_B", title: "Channel B", description: null },
  ]);
});

test("searchPublicChannels omits a result missing its own channel id, never fabricating one", async () => {
  const youtube = fakeYoutubeClient({
    searchList: (async () => ({
      data: { items: [{ id: {}, snippet: { title: "No id" } }, { id: { channelId: "UC_OK" }, snippet: { title: "OK" } }] },
    })) as unknown as youtube_v3.Youtube["search"]["list"],
  });

  const results = await searchPublicChannels(youtube, "query");
  assert.deepEqual(results, [{ channelId: "UC_OK", title: "OK", description: null }]);
});

test("searchPublicChannels issues exactly one call, never paginates, even with a nextPageToken present", async () => {
  let callCount = 0;
  const youtube = fakeYoutubeClient({
    searchList: (async () => {
      callCount += 1;
      return { data: { items: [{ id: { channelId: "UC_A" }, snippet: { title: "A" } }], nextPageToken: "more" } };
    }) as unknown as youtube_v3.Youtube["search"]["list"],
  });

  await searchPublicChannels(youtube, "query");
  assert.equal(callCount, 1, "must never fetch a second page -- its real cost (100 units) must stay exactly and always 1 call");
});

// Phase 13 (review round 1): fields per the official references, not assumed shapes.
test("listUploadsPlaylistFirstPage returns each item's title (snippet.title) and publish time (contentDetails.videoPublishedAt)", async () => {
  const youtube = fakeYoutubeClient({
    playlistItemsList: (async () => ({
      data: { items: [{ snippet: { title: "Night Rain" }, contentDetails: { videoId: "v1", videoPublishedAt: "2026-09-01T10:00:00Z" } }] },
    })) as unknown as youtube_v3.Youtube["playlistItems"]["list"],
  });
  assert.deepEqual(await listUploadsPlaylistFirstPage(youtube, "UU_TEST"), [
    { videoId: "v1", title: "Night Rain", publishedAt: "2026-09-01T10:00:00Z" },
  ]);
});

test("getPublicVideoStatsBatch parses the documented batchGetStats response (snippet.publishTime only, no title)", async () => {
  let requested: { url: string; params: Record<string, string> } | null = null;
  const auth = {
    async request(opts: { url: string; params: Record<string, string> }) {
      requested = opts;
      return {
        data: {
          kind: "youtube#batchGetStatsResponse",
          items: [
            {
              kind: "youtube#videoStats",
              id: "v1",
              snippet: { publishTime: "2026-09-02T00:00:00Z" },
              statistics: { viewCount: "1234", likeCount: 5, commentCount: "6" },
              contentDetails: { duration: "PT3M", durationMillis: 180000 },
            },
          ],
          summary: { requestedVideoCount: 1, succeededVideoCount: 1, failedVideoCount: 0, failedVideoIds: [] },
        },
      };
    },
  };
  const youtube = { context: { _options: { auth } } } as unknown as youtube_v3.Youtube;
  const result = await getPublicVideoStatsBatch(youtube, ["v1"]);
  assert.deepEqual(result, [
    { videoId: "v1", title: "", publishedAt: "2026-09-02T00:00:00Z", viewCount: 1234, likeCount: 5, commentCount: 6, durationSeconds: 180 },
  ]);
  assert.equal(requested!.url, "https://www.googleapis.com/youtube/v3/videos:batchGetStats");
  assert.equal(requested!.params.part, "id,snippet,statistics,contentDetails");
});

test("getPublicVideoStatsBatch: duration falls back to durationMillis (rounded to seconds), and is null -- never 0 -- when neither is usable", async () => {
  const auth = {
    async request() {
      return {
        data: {
          items: [
            { id: "a", statistics: {}, contentDetails: { durationMillis: "90500" } },
            { id: "b", statistics: {}, contentDetails: {} },
            { id: "c", statistics: {}, contentDetails: { duration: "PT0S", durationMillis: 0 } },
            { id: "d", statistics: {} },
          ],
        },
      };
    },
  };
  const youtube = { context: { _options: { auth } } } as unknown as youtube_v3.Youtube;
  const result = await getPublicVideoStatsBatch(youtube, ["a", "b", "c", "d"]);
  assert.deepEqual(result.map((r) => r.durationSeconds), [91, null, null, null]);
});

// Progress callbacks (ADR 0015): optional, additive, never change what is requested or returned.
test("getVideosMetadataContextBatch reports (done, total) after each chunk of 50, ending at the total", async () => {
  const reports: Array<[number, number]> = [];
  const youtube = fakeYoutubeClient({
    videosList: (async (args: { id?: string[] }) => ({
      data: { items: (args.id ?? []).map((id) => ({ id, etag: id, snippet: { title: id, publishedAt: "2026-01-01T00:00:00.000Z" }, status: { privacyStatus: "public" } })) },
    })) as unknown as youtube_v3.Youtube["videos"]["list"],
  });
  const ids = Array.from({ length: 120 }, (_, i) => `v${i + 1}`);

  const results = await getVideosMetadataContextBatch(youtube, ids, { onProgress: (done, total) => reports.push([done, total]) });

  assert.equal(results.length, 120);
  assert.deepEqual(reports, [[50, 120], [100, 120], [120, 120]]);
});

test("getVideosMetadataContextBatch without a callback behaves exactly as before", async () => {
  const youtube = fakeYoutubeClient({
    videosList: (async (args: { id?: string[] }) => ({
      data: { items: (args.id ?? []).map((id) => ({ id, etag: id, snippet: { title: id, publishedAt: "2026-01-01T00:00:00.000Z" }, status: { privacyStatus: "public" } })) },
    })) as unknown as youtube_v3.Youtube["videos"]["list"],
  });
  assert.equal((await getVideosMetadataContextBatch(youtube, ["a", "b"])).length, 2);
});

test("listUploadsPlaylistVideoIds reports the running count of unique ids after each page", async () => {
  const pages = [
    { items: [{ contentDetails: { videoId: "a" } }, { contentDetails: { videoId: "b" } }], nextPageToken: "p2" },
    { items: [{ contentDetails: { videoId: "b" } }, { contentDetails: { videoId: "c" } }], nextPageToken: undefined },
  ];
  let call = 0;
  const youtube = fakeYoutubeClient({
    playlistItemsList: (async () => ({ data: pages[call++] })) as unknown as youtube_v3.Youtube["playlistItems"]["list"],
  });
  const found: number[] = [];

  const ids = await listUploadsPlaylistVideoIds(youtube, "UU1", { onPage: (n) => found.push(n) });

  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.deepEqual(found, [2, 3], "the duplicate b on page 2 is not counted twice");
});


// BL-145 (owner, Telegram 2026-10-07): the counts of the channels a search found, one channels.list call per 50 ids.
test("getPublicChannelStats asks for snippet+statistics of up to 50 ids per call, de-duplicated; a hidden count is null", async () => {
  const calls: Array<{ part: string[]; id: string[] }> = [];
  const youtube = fakeYoutubeClient({
    channelsList: (async (args: { part: string[]; id: string[] }) => {
      calls.push({ part: args.part, id: args.id });
      return {
        data: {
          items: args.id.map((id) =>
            id === "UC_HIDDEN"
              ? { id, snippet: { publishedAt: "2020-02-03T04:05:06Z" }, statistics: { subscriberCount: "0", viewCount: "10", videoCount: "2", hiddenSubscriberCount: true } }
              : { id, snippet: { publishedAt: "2019-01-01T00:00:00Z" }, statistics: { subscriberCount: "12300", viewCount: "456000", videoCount: "42", hiddenSubscriberCount: false } }
          ),
        },
      };
    }) as unknown as youtube_v3.Youtube["channels"]["list"],
  });

  const ids = [...Array.from({ length: 51 }, (_, i) => `UC_${i}`), "UC_0", "UC_HIDDEN"];
  const stats = await getPublicChannelStats(youtube, ids);
  // 52 distinct ids: one call of 50, one of 2.
  assert.deepEqual(calls.map((c) => [c.part, c.id.length]), [
    [["snippet", "statistics"], 50],
    [["snippet", "statistics"], 2],
  ]);
  assert.equal(stats.length, 52);
  assert.deepEqual(stats[0], { channelId: "UC_0", subscriberCount: 12300, hiddenSubscriberCount: false, videoCount: 42, viewCount: 456000, publishedAt: "2019-01-01T00:00:00Z" });
  assert.deepEqual(stats.find((x) => x.channelId === "UC_HIDDEN"), {
    channelId: "UC_HIDDEN",
    subscriberCount: null,
    hiddenSubscriberCount: true,
    videoCount: 2,
    viewCount: 10,
    publishedAt: "2020-02-03T04:05:06Z",
  });
});


// BL-145 (owner, msg 1904): the genre search asks for VIDEOS in the Music category, not channels.
test("searchPublicMusicVideos asks search.list for type=video in category 10 (Music), 50 results, with publishedAfter only when given", async () => {
  const calls: unknown[] = [];
  const youtube = fakeYoutubeClient({
    searchList: (async (args: unknown) => {
      calls.push(args);
      return {
        data: {
          items: [
            { id: { videoId: "v1" }, snippet: { channelId: "UC_A", channelTitle: "A", title: "Bossa 1", publishedAt: "2026-09-01T00:00:00Z" } },
            { id: { videoId: "v2" }, snippet: { channelTitle: "no channel id" } },
            { id: { channelId: "UC_X" }, snippet: { channelId: "UC_X" } },
          ],
        },
      };
    }) as unknown as youtube_v3.Youtube["search"]["list"],
  });
  const found = await searchPublicMusicVideos(youtube, { query: "bossa nova cafe" });
  await searchPublicMusicVideos(youtube, { query: "q", publishedAfter: "2026-07-01T00:00:00Z" });
  assert.deepEqual(calls, [
    { part: ["snippet"], q: "bossa nova cafe", type: ["video"], videoCategoryId: "10", maxResults: 50 },
    { part: ["snippet"], q: "q", type: ["video"], videoCategoryId: "10", maxResults: 50, publishedAfter: "2026-07-01T00:00:00Z" },
  ]);
  assert.deepEqual(found, [{ videoId: "v1", channelId: "UC_A", channelTitle: "A", title: "Bossa 1", publishedAt: "2026-09-01T00:00:00Z" }]);
});

// BL-171 (docs/roadmap/plans/VIDEO_COMMENTS_PLAN.md AC-VC-01/02/03): the comment reads, with the query and the stored shape stated by hand.
test("getVideoCommentCounts reads only the statistics part, 50 ids per call, and keeps a missing count null", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const ids = Array.from({ length: 51 }, (_, i) => `v${i}`);
  const youtube = fakeYoutubeClient({
    videosList: (async (args: Record<string, unknown>) => {
      calls.push(args);
      const batch = args.id as string[];
      return { data: { items: batch.map((id) => ({ id, statistics: id === "v0" ? { commentCount: "2" } : id === "v1" ? {} : { commentCount: "0" } })) } };
    }) as unknown as youtube_v3.Youtube["videos"]["list"],
  });
  const counts = await getVideoCommentCounts(youtube, ids);
  assert.deepEqual(calls.map((call) => [call.part, (call.id as string[]).length]), [
    [["statistics"], 50],
    [["statistics"], 1],
  ]);
  assert.deepEqual(counts.slice(0, 3), [
    { videoId: "v0", commentCount: 2 },
    { videoId: "v1", commentCount: null },
    { videoId: "v2", commentCount: 0 },
  ]);
});

test("listOwnVideoComments asks for the 100 newest threads as plain text and keeps no author data", async () => {
  let asked: Record<string, unknown> | undefined;
  const thread = (id: string, author: string, extra: Record<string, unknown> = {}) => ({
    id: `t-${id}`,
    snippet: {
      channelId: "UC_A",
      videoId: "a",
      totalReplyCount: 2,
      isPublic: true,
      topLevelComment: {
        id,
        snippet: {
          textDisplay: "Beautiful music!",
          textOriginal: "Beautiful music!",
          authorDisplayName: "Someone",
          authorProfileImageUrl: "https://example.com/p.jpg",
          authorChannelId: { value: author },
          likeCount: 3,
          publishedAt: "2026-09-27T19:16:28Z",
          updatedAt: "2026-09-28T08:00:00Z",
        },
      },
      ...extra,
    },
  });
  const youtube = {
    commentThreads: {
      list: async (args: Record<string, unknown>) => {
        asked = args;
        return { data: { items: [thread("c1", "UC_A"), thread("c2", "UC_someone"), thread("c3", "UC_x", { isPublic: false })] } };
      },
    },
  } as unknown as youtube_v3.Youtube;
  const comments = await listOwnVideoComments(youtube, "a", "UC_A");
  assert.deepEqual(asked, { part: ["snippet"], videoId: "a", maxResults: 100, order: "time", textFormat: "plainText" });
  assert.deepEqual(comments, [
    { commentId: "c1", text: "Beautiful music!", likeCount: 3, publishedAt: "2026-09-27T19:16:28Z", updatedAt: "2026-09-28T08:00:00Z", replyCount: 2, byChannelOwner: true },
    { commentId: "c2", text: "Beautiful music!", likeCount: 3, publishedAt: "2026-09-27T19:16:28Z", updatedAt: "2026-09-28T08:00:00Z", replyCount: 2, byChannelOwner: false },
  ]);
  assert.ok(!JSON.stringify(comments).includes("Someone") && !JSON.stringify(comments).includes("UC_someone"), "no author data");
});
