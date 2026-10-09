import assert from "node:assert/strict";
import test from "node:test";
import { VIDEO_DETAILS_REFRESH_DAYS, videosWithFreshDetails, withKnownVideoDetails, youtubeThumbnailUrl } from "./services";

// FO-REQ-0015 item 4: a competitor video's duration and live status come only from a `videos.list` read (batchGetStats returns
// neither). Expected values worked out by hand from that rule.

const NOW = new Date("2026-10-09T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const row = (id: string, videoId: string, daysAgo: number, source: string, durationSeconds: number | null, liveBroadcastContent: string | null = null) => ({
  id,
  researchChannelId: "UCcomp",
  videoId,
  observedAt: new Date(NOW.getTime() - daysAgo * day),
  viewCount: 1,
  likeCount: null,
  commentCount: null,
  publishedAt: null,
  title: null,
  durationSeconds,
  liveBroadcastContent,
  source,
  createdVia: "web_ui",
});

test("a row without details shows its video's newest details row; rows with their own, and other videos, are unchanged", () => {
  const rows = [
    row("a1", "v1", 25, "youtube.videos.list", 3600, "none"),
    row("a2", "v1", 10, "youtube.videos.list", 3601, "none"),
    row("a3", "v1", 1, "youtube.videos.batchGetStats", null),
    row("b1", "v2", 1, "youtube.videos.batchGetStats", null),
  ];
  const out = withKnownVideoDetails(rows);
  assert.deepEqual(out.map((r) => [r.id, r.durationSeconds, r.liveBroadcastContent]), [
    ["a1", 3600, "none"],
    ["a2", 3601, "none"],
    ["a3", 3601, "none"], // the newest details row (10 days ago)
    ["b1", null, null], // nothing known
  ]);
  assert.equal(out[2].source, "youtube.videos.batchGetStats", "the row keeps its own source");
});

test("a batch row's own non-null value is not a details row (only videos.list counts) and is never overwritten", () => {
  const rows = [row("a1", "v1", 2, "youtube.videos.list", 100), row("a2", "v1", 1, "youtube.videos.batchGetStats", 99)];
  assert.deepEqual(withKnownVideoDetails(rows).map((r) => r.durationSeconds), [100, 99]);
  assert.deepEqual([...videosWithFreshDetails([rows[1]], NOW)], [], "a batch row does not make a video fresh");
});

test(`videos with a details read in the last ${VIDEO_DETAILS_REFRESH_DAYS} days need no new videos.list; older or none do`, () => {
  const rows = [
    row("a", "fresh", VIDEO_DETAILS_REFRESH_DAYS - 1, "youtube.videos.list", 60),
    row("b", "edge", VIDEO_DETAILS_REFRESH_DAYS, "youtube.videos.list", 60),
    row("c", "stale", VIDEO_DETAILS_REFRESH_DAYS + 1, "youtube.videos.list", 60),
    row("d", "nodetails", 1, "youtube.videos.list", null, null),
    row("e", "batch", 1, "youtube.videos.batchGetStats", null),
  ];
  assert.deepEqual([...videosWithFreshDetails(rows, NOW)].sort(), ["edge", "fresh"]);
});

test("FO-REQ-0015 item 6: a competitor video's thumbnail is YouTube's own URL for its id (nothing stored)", () => {
  assert.equal(youtubeThumbnailUrl("dQw4w9WgXcQ"), "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
});
