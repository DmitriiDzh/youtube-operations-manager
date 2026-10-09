import assert from "node:assert/strict";
import test from "node:test";
import { upsertChannel, upsertVideos } from "@/lib/db";
import { createBreakdownStoreAdapter } from "./adapters/store";
import { createAnalyticsCore } from "./index";

// BL-168 (review): the real store adapter and core wiring on this test process's isolated database, as for the milestones (BL-163's
// lesson: a service tested only with injected fakes can still be wired to nothing in the app).

test("breakdown wiring: the adapter reads each video's publish time and visibility, and round-trips a subject's rows and state", async () => {
  await upsertChannel({ channelId: "UC_BW", title: "Wiring", thumbnailUrl: null, uploadsPlaylistId: "UU_BW", connectedUserId: null });
  await upsertVideos(
    [
      {
        videoId: "bw1",
        channelId: "UC_BW",
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
  const adapter = createBreakdownStoreAdapter();
  assert.deepEqual(await adapter.videoStore.listVideos("UC_BW"), [
    { videoId: "bw1", publishedAt: "2026-09-01T17:00:00Z", privacyStatus: "public", liveBroadcastContent: null },
  ]);
  const at = new Date("2026-10-10T18:00:00Z");
  await adapter.store.saveCollected({
    channelId: "UC_BW",
    subject: "bw1",
    videoId: "bw1",
    rangeStart: "2026-09-01",
    from: "2026-09-01",
    to: "2026-10-09",
    fresh: true,
    rows: {
      traffic_source: [{ day: "2026-09-02", value: "YT_SEARCH", views: 3, estimatedMinutesWatched: 12 }],
      device_type: [{ day: "2026-09-02", value: "TV", views: 1, estimatedMinutesWatched: 9 }],
    },
    collectedOn: "2026-10-10",
    at,
  });
  assert.deepEqual(
    (await adapter.store.listRows("UC_BW", ["bw1"], "2026-09-01", "2026-10-09")).map((r) => [r.subject, r.breakdown, r.day, r.value, r.views]).sort(),
    [
      ["bw1", "device_type", "2026-09-02", "TV", 1],
      ["bw1", "traffic_source", "2026-09-02", "YT_SEARCH", 3],
    ]
  );
  const [state] = await adapter.store.listStates("UC_BW");
  assert.deepEqual(
    [state.subject, state.rangeStart, state.collectedThrough, state.collectedOn, state.collectedAt?.toISOString(), state.status, state.attempts],
    ["bw1", "2026-09-01", "2026-10-09", "2026-10-10", at.toISOString(), "collected", 0]
  );
});

test("breakdown wiring: the analytics core exposes the guarded collection and the read", () => {
  const core = createAnalyticsCore();
  assert.equal(typeof core.collectDueBreakdowns, "function");
  assert.equal(typeof core.listStoredBreakdowns, "function");
});
