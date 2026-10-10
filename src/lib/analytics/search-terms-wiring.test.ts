import assert from "node:assert/strict";
import test from "node:test";
import { upsertChannel, upsertVideos } from "@/lib/db";
import { createSearchTermStoreAdapter } from "./adapters/store";
import { createAnalyticsCore } from "./index";

// BL-169: the real store adapter and core wiring on this test process's isolated database (BL-163's lesson: a service tested only with
// injected fakes can still be wired to nothing in the app).

test("search-term wiring: the adapter lists the videos and round-trips a video's terms, a channel week's terms and their states", async () => {
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
  await adapter.store.saveWeekTerms({
    channelId: "UC_ST",
    subject: "search-week:2026-09-28",
    weekStart: "2026-09-28",
    to: "2026-10-04",
    terms: [{ term: "japanese music", views: 5, estimatedMinutesWatched: 1 }],
    collectedOn: "2026-10-10",
    at,
  });
  assert.deepEqual(await adapter.store.listWeekTerms("UC_ST", "2026-09-28", "2026-09-28"), [
    { weekStart: "2026-09-28", term: "japanese music", views: 5, estimatedMinutesWatched: 1 },
  ]);
  assert.deepEqual(await adapter.store.listWeekTerms("UC_ST", "2026-09-21", "2026-09-21"), [], "only the weeks asked for");
  const states = (await adapter.store.listStates("UC_ST")).sort((a, b) => a.subject.localeCompare(b.subject));
  assert.deepEqual(
    states.map((state) => [state.subject, state.rangeStart, state.collectedThrough, state.collectedOn, state.collectedAt?.toISOString(), state.status, state.attempts]),
    [
      ["search-week:2026-09-28", "2026-09-28", "2026-10-04", "2026-10-10", at.toISOString(), "collected", 0],
      ["search:st1", "2026-09-01", "2026-10-09", "2026-10-10", at.toISOString(), "collected", 0],
    ]
  );
});

test("search-term wiring: the analytics core exposes the guarded collection and the read", () => {
  const core = createAnalyticsCore();
  assert.equal(typeof core.collectDueSearchTerms, "function");
  assert.equal(typeof core.listStoredSearchTerms, "function");
});
