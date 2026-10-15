import assert from "node:assert/strict";
import test from "node:test";
import { upsertChannel, upsertVideos } from "@/lib/db";
import { createSuggestedSourceStoreAdapter } from "./adapters/store";
import { createAnalyticsCore } from "./index";

// BL-191: the real store adapter and core wiring on this test process's isolated database (BL-163's lesson: a service tested only with
// injected fakes can still be wired to nothing in the app).

test("suggested-source wiring: the adapter round-trips a video's and a week's rows, finds our own videos, and keeps the titles", async () => {
  await upsertChannel({ channelId: "UC_SS", title: "Wiring SS", thumbnailUrl: null, uploadsPlaylistId: "UU_SS", connectedUserId: null });
  await upsertVideos(
    [
      {
        videoId: "ss1",
        channelId: "UC_SS",
        title: "Own video",
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
  const adapter = createSuggestedSourceStoreAdapter();
  const at = new Date("2026-10-10T18:00:00Z");
  await adapter.store.saveVideoRows({
    channelId: "UC_SS",
    subject: "suggested:ss1",
    videoId: "ss1",
    rangeStart: "2026-09-01",
    to: "2026-10-09",
    rows: [{ detail: "ext-a", views: 3, estimatedMinutesWatched: 2 }],
    collectedOn: "2026-10-10",
    at,
  });
  assert.deepEqual(await adapter.store.listVideoRows("UC_SS", ["ss1"]), [{ videoId: "ss1", detail: "ext-a", views: 3, estimatedMinutesWatched: 2 }]);
  assert.deepEqual(await adapter.store.listVideoRows("UC_OTHER", ["ss1"]), [], "always within the channel");
  await adapter.store.saveWeekRows({
    channelId: "UC_SS",
    subject: "suggested-week:2026-09-28",
    weekStart: "2026-09-28",
    to: "2026-10-04",
    rows: [{ detail: "ss1", views: 5, estimatedMinutesWatched: 1 }],
    collectedOn: "2026-10-10",
    at,
  });
  assert.deepEqual(await adapter.store.listWeekRows("UC_SS", "2026-09-28", "2026-09-28"), [{ weekStart: "2026-09-28", detail: "ss1", views: 5, estimatedMinutesWatched: 1 }]);
  assert.deepEqual(await adapter.titles.listStoredSourceIds("UC_SS"), ["ext-a", "ss1"]);
  assert.deepEqual(await adapter.ownVideos.findByIds(["ss1", "ext-a"]), [{ videoId: "ss1", title: "Own video", channelId: "UC_SS", channelTitle: "Wiring SS" }]);
  await adapter.titles.save([{ videoId: "ext-a", title: "A", channelId: "UC_A", channelTitle: "Channel A" }], at);
  assert.deepEqual(
    (await adapter.titles.listFresh(["ext-a"], new Date("2026-10-01T00:00:00Z"))).map((row) => [row.videoId, row.title, row.channelTitle]),
    [["ext-a", "A", "Channel A"]]
  );
  assert.deepEqual(await adapter.titles.listFresh(["ext-a"], new Date("2026-10-11T00:00:00Z")), [], "older than `since` is not returned");
  const states = (await adapter.store.listStates("UC_SS")).map((state) => [state.subject, state.status]).sort();
  assert.deepEqual(states, [
    ["suggested-week:2026-09-28", "collected"],
    ["suggested:ss1", "collected"],
  ]);
});

test("suggested-source wiring: the analytics core exposes the guarded collection and the read", () => {
  const core = createAnalyticsCore();
  assert.equal(typeof core.collectDueSuggestedSources, "function");
  assert.equal(typeof core.listStoredSuggestedSources, "function");
});
