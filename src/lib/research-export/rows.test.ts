import assert from "node:assert/strict";
import test from "node:test";
import type { WatchlistContextForExport } from "./contracts";
import { buildChannelSnapshotRows, buildOwnVideoRows, buildVideoSnapshotRows, computeResearchFileExpiry } from "./rows";

// Fixture values and expected rows are written by hand (AGENTS.md §L); the 30-day arithmetic is done by hand: 2026-09-20 + 30 days = 2026-10-20.

const neiro: WatchlistContextForExport = {
  channel: { channelId: "UCneiro", handleOrUrl: "@TheNeiro" },
  evidenceCount: 3,
  channelSnapshots: [
    { observedAt: "2026-10-02T10:00:00.000Z", subscriberCount: 1200, viewCount: 90000, videoCount: 40, hiddenSubscriberCount: false, source: "youtube.channels.list" },
  ],
  videoSnapshots: [
    { videoId: "v1", observedAt: "2026-10-02T10:00:00.000Z", viewCount: 500, likeCount: 20, commentCount: 2, publishedAt: "2026-09-20T08:00:00.000Z", title: 'A, "B"', source: "youtube.videos.list" },
    { videoId: "v2", observedAt: "2026-10-02T10:00:00.000Z", viewCount: null, likeCount: null, commentCount: null, publishedAt: null, title: null, source: "youtube.videos.list" },
  ],
  dataQualityFlags: ["hidden_subscriber_count", "stale_observation"],
};
const noHandle: WatchlistContextForExport = {
  channel: { channelId: "UCnone", handleOrUrl: null },
  evidenceCount: 0,
  channelSnapshots: [],
  videoSnapshots: [],
  dataQualityFlags: [],
};

test("channel rows: one per snapshot, per-channel counts repeated, flags joined by ';'; a channel without snapshots adds no row", () => {
  assert.deepEqual(buildChannelSnapshotRows([neiro, noHandle]), [
    {
      channel: "@TheNeiro",
      channelId: "UCneiro",
      observedAt: "2026-10-02T10:00:00.000Z",
      subscriberCount: 1200,
      viewCount: 90000,
      videoCount: 40,
      hiddenSubscriberCount: false,
      videoSnapshotCount: 2,
      evidenceCount: 3,
      dataQualityFlags: "hidden_subscriber_count;stale_observation",
    },
  ]);
});

test("video rows: one per snapshot with null kept as null; the channel label falls back to the channel id", () => {
  const rows = buildVideoSnapshotRows([neiro, { ...noHandle, videoSnapshots: [{ ...neiro.videoSnapshots[0], videoId: "v9" }] }]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], {
    channel: "@TheNeiro",
    channelId: "UCneiro",
    videoId: "v2",
    publishedAt: null,
    observedAt: "2026-10-02T10:00:00.000Z",
    viewCount: null,
    likeCount: null,
    commentCount: null,
    title: null,
  });
  assert.equal(rows[2].channel, "UCnone");
  assert.equal(rows[2].videoId, "v9");
});

test("own channel rows: only public videos, published date normalised to ISO, observedAt = last sync, same keys as competitor rows", () => {
  const own = buildOwnVideoRows({ channelId: "UCown", title: "Rural Japan Music" }, [
    { videoId: "a", publishedAt: "2026-09-01T10:00:00Z", privacyStatus: "public", title: "Pub", viewCount: 10, likeCount: 1, commentCount: 0, lastSyncedAt: new Date("2026-10-03T12:00:00Z") },
    { videoId: "b", publishedAt: "2026-09-02T10:00:00Z", privacyStatus: "private", title: "Hidden", viewCount: 1, likeCount: 0, commentCount: 0, lastSyncedAt: new Date("2026-10-03T12:00:00Z") },
  ]);
  assert.deepEqual(own, [
    {
      channel: "Rural Japan Music",
      channelId: "UCown",
      videoId: "a",
      publishedAt: "2026-09-01T10:00:00.000Z",
      observedAt: "2026-10-03T12:00:00.000Z",
      viewCount: 10,
      likeCount: 1,
      commentCount: 0,
      title: "Pub",
    },
  ]);
  assert.deepEqual(Object.keys(own[0]), Object.keys(buildVideoSnapshotRows([neiro])[0]));
});

test("expiry = 30 days after the OLDEST API-sourced observation; operator-entered rows do not count; none -> null", () => {
  const old: WatchlistContextForExport = {
    ...neiro,
    channelSnapshots: [{ ...neiro.channelSnapshots[0], observedAt: "2026-09-20T00:00:00.000Z" }],
  };
  assert.equal(computeResearchFileExpiry([neiro, old], new Date("2026-10-04T00:00:00Z"))?.toISOString(), "2026-10-20T00:00:00.000Z");
  const manualOnly: WatchlistContextForExport = {
    ...neiro,
    channelSnapshots: [{ ...neiro.channelSnapshots[0], source: "operator entry" }],
    videoSnapshots: [{ ...neiro.videoSnapshots[0], source: "operator entry" }],
  };
  assert.equal(computeResearchFileExpiry([manualOnly], new Date("2026-10-04T00:00:00Z")), null);
  assert.equal(computeResearchFileExpiry([], new Date("2026-10-04T00:00:00Z")), null);
});

test("expiry fails closed: an API row with an unreadable observation time counts as observed at export time (2026-10-04 + 30 d = 2026-11-03)", () => {
  const broken: WatchlistContextForExport = { ...neiro, channelSnapshots: [{ ...neiro.channelSnapshots[0], observedAt: "not a date" }], videoSnapshots: [] };
  assert.equal(computeResearchFileExpiry([broken], new Date("2026-10-04T00:00:00Z"))?.toISOString(), "2026-11-03T00:00:00.000Z");
});
