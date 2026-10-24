import assert from "node:assert/strict";
import test from "node:test";
import { buildVideoInsights, windowStart } from "./services";

// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage A, acceptance 1): the kind of each video from YouTube's
// `snippet.liveBroadcastContent` (`live` | `upcoming` | `none`, YouTube Data API videos resource) and the broadcasts the app ran;
// the 7 days end on the newest day of data (YouTube Analytics lags), CTR = clicks / impressions over that window. Expected
// values are worked out by hand below.

test("BL-221: the 7-day window ends on the newest day of data, inclusive", () => {
  assert.equal(windowStart("2026-10-22"), "2026-10-16");
  assert.equal(windowStart("2026-03-03"), "2026-02-25");
});

test("BL-221: a broadcast on air is live, one not started is a broadcast, a finished one the app ran is a recording; the rest are videos", () => {
  const result = buildVideoInsights({
    channelId: "UC1",
    videos: [
      { videoId: "onAirNow___", liveBroadcastContent: "live" },
      { videoId: "ytDefault__", liveBroadcastContent: "upcoming" },
      { videoId: "segment20Oc", liveBroadcastContent: "none" },
      { videoId: "regular____", liveBroadcastContent: "none" },
      { videoId: "unknown____", liveBroadcastContent: null },
    ],
    appBroadcastIds: ["onAirNow___", "segment20Oc", "notSynced__"],
    dailyViews: [],
    reach: [],
    viewsThrough: null,
    reachThrough: null,
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.videos).map(([id, v]) => [id, v.kind])),
    { onAirNow___: "live", ytDefault__: "broadcast", segment20Oc: "recording", regular____: "video", unknown____: "video" },
  );
  // No analytics at all: unknown, never 0.
  assert.deepEqual(result.videos.regular____, { kind: "video", views7d: null, impressions7d: null, ctr7d: null });
});

test("BL-221: views and CTR over the last 7 days of data only; a video without rows has 0 views but no CTR", () => {
  const result = buildVideoInsights({
    channelId: "UC1",
    videos: [
      { videoId: "a__________", liveBroadcastContent: "none" },
      { videoId: "b__________", liveBroadcastContent: "none" },
    ],
    appBroadcastIds: [],
    dailyViews: [
      { videoId: "a__________", date: "2026-10-15", views: 1000 }, // before the window (16..22)
      { videoId: "a__________", date: "2026-10-16", views: 10 },
      { videoId: "a__________", date: "2026-10-22", views: 5 },
    ],
    reach: [
      { videoId: "a__________", date: "2026-10-13", impressions: 900, ctr: 0.5 }, // before the window (14..20)
      { videoId: "a__________", date: "2026-10-14", impressions: 0, ctr: null },
      { videoId: "a__________", date: "2026-10-15", impressions: 100, ctr: 0.04 },
      { videoId: "a__________", date: "2026-10-20", impressions: 300, ctr: 0.08 },
      { videoId: "a__________", date: "2026-10-18", impressions: 50, ctr: null },
    ],
    viewsThrough: "2026-10-22",
    reachThrough: "2026-10-20",
  });
  // views: 10 + 5 = 15. impressions: 100 + 300 + 50 = 450; clicks 4 + 24 = 28 over the 400 rated impressions = 0.07.
  assert.equal(result.videos.a__________.views7d, 15);
  assert.equal(result.videos.a__________.impressions7d, 450);
  assert.ok(Math.abs((result.videos.a__________.ctr7d ?? 0) - 0.07) < 1e-12);
  assert.deepEqual(result.videos.b__________, { kind: "video", views7d: 0, impressions7d: null, ctr7d: null });
  assert.equal(result.viewsThrough, "2026-10-22");
  assert.equal(result.reachThrough, "2026-10-20");
});
