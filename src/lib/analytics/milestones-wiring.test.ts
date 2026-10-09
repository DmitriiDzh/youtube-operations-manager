import assert from "node:assert/strict";
import test from "node:test";
import { upsertChannel, upsertVideos } from "@/lib/db";
import { createVideoMilestoneStoreAdapter } from "./adapters/store";
import { createAnalyticsCore } from "./index";

// BL-166: the real store adapter and core wiring on this test process's isolated database (BL-163's lesson: a service tested only
// with injected fakes can still be wired to nothing in the app).

test("milestone wiring: the adapter reads each video's publish time and length, and round-trips a milestone row", async () => {
  await upsertChannel({ channelId: "UC_MW", title: "Wiring", thumbnailUrl: null, uploadsPlaylistId: "UU_MW", connectedUserId: null });
  await upsertVideos(
    [
      {
        videoId: "mw1",
        channelId: "UC_MW",
        title: "T",
        description: "",
        publishedAt: "2026-09-01T17:00:00Z",
        privacyStatus: "public",
        defaultLanguage: null,
        defaultAudioLanguage: null,
        thumbnails: {},
        existingLocalizations: {},
        etag: null,
        durationSeconds: 7200,
      },
    ] as never,
    new Date("2026-10-09T10:00:00Z")
  );
  const adapter = createVideoMilestoneStoreAdapter();
  assert.deepEqual(await adapter.videoStore.listVideos("UC_MW"), [{ videoId: "mw1", publishedAt: "2026-09-01T17:00:00Z", durationSeconds: 7200 }]);
  await adapter.store.saveCollected({
    videoId: "mw1",
    milestoneDays: 7,
    channelId: "UC_MW",
    windowStart: "2026-09-01",
    windowEnd: "2026-09-07",
    views: 10,
    estimatedMinutesWatched: 20,
    averageViewDuration: 120,
    averageViewPercentage: 1.7,
    retentionJson: "[]",
    at: new Date("2026-10-09T10:00:00Z"),
  });
  const [row] = await adapter.store.list("UC_MW");
  assert.deepEqual([row.videoId, row.milestoneDays, row.status, row.attempts, row.views], ["mw1", 7, "collected", 1, 10]);
});

test("milestone wiring: the analytics core exposes the guarded collection and the read", () => {
  const core = createAnalyticsCore();
  assert.equal(typeof core.collectDueMilestones, "function");
  assert.equal(typeof core.listVideoMilestones, "function");
});
