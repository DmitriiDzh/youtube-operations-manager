import assert from "node:assert/strict";
import test from "node:test";
import { upsertChannel, upsertVideos } from "@/lib/db";
import { createSearchTermStoreAdapter } from "./adapters/store";
import { createAnalyticsCore } from "./index";

// BL-169: the real store adapter and core wiring on this test process's isolated database (BL-163's lesson: a service tested only with
// injected fakes can still be wired to nothing in the app).

test("search-term wiring: the adapter lists the videos and round-trips a video's terms and its search: state", async () => {
  await upsertChannel({ channelId: "UC_ST", title: "Wiring", thumbnailUrl: null, uploadsPlaylistId: "UU_ST", connectedUserId: null });
  await upsertVideos(
    [
      {
        videoId: "st1",
        channelId: "UC_ST",
        title: "T",
        description: "",
        publishedAt: "2026-09-01T17:00:00Z",
        privacyStatus: "public",
        defaultLanguage: null,
        defaultAudioLanguage: null,
        thumbnails: {},
        existingLocalizations: {},
        etag: null,
      },
    ] as never,
    new Date("2026-10-09T10:00:00Z")
  );
  const adapter = createSearchTermStoreAdapter();
  assert.deepEqual(await adapter.videoStore.listVideos("UC_ST"), [
    { videoId: "st1", publishedAt: "2026-09-01T17:00:00Z", privacyStatus: "public", liveBroadcastContent: null },
  ]);
  const at = new Date("2026-10-10T18:00:00Z");
  await adapter.store.saveVideoTerms({
    channelId: "UC_ST",
    subject: "search:st1",
    videoId: "st1",
    rangeStart: "2026-09-01",
    to: "2026-10-09",
    terms: [{ term: "village in japan", views: 2, estimatedMinutesWatched: 0 }],
    collectedOn: "2026-10-10",
    at,
  });
  assert.deepEqual(await adapter.store.listVideoTerms("UC_ST", ["st1"]), [{ videoId: "st1", term: "village in japan", views: 2, estimatedMinutesWatched: 0 }]);
  assert.deepEqual(await adapter.store.listVideoTerms("UC_OTHER", ["st1"]), [], "always within the channel");
  const [state] = await adapter.store.listStates("UC_ST");
  assert.deepEqual(
    [state.subject, state.rangeStart, state.collectedThrough, state.collectedOn, state.collectedAt?.toISOString(), state.status, state.attempts],
    ["search:st1", "2026-09-01", "2026-10-09", "2026-10-10", at.toISOString(), "collected", 0]
  );
});

test("search-term wiring: the analytics core exposes the guarded collection and the read", () => {
  const core = createAnalyticsCore();
  assert.equal(typeof core.collectDueSearchTerms, "function");
  assert.equal(typeof core.listStoredSearchTerms, "function");
});
