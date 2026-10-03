import assert from "node:assert/strict";
import test from "node:test";
import { nextVideoHistoryThrough, perVideoQueryRange, planChannelCatchUp, planVideoHistoryCatchUp, resolveHistoryStart, videoPublishFloor } from "./catch-up";

// Expectations are worked out by hand from the requirement (the agent's retest: a video published before 2026-09-14 must return its day-0
// data; the query starts one day before publish, never after it), not from the implementation.

test("the publish floor is one day before the publish date (UTC), across a month boundary too", () => {
  assert.equal(videoPublishFloor("2026-08-14T13:00:22Z"), "2026-08-13");
  assert.equal(videoPublishFloor("2026-09-01T00:00:00Z"), "2026-08-31");
  assert.equal(videoPublishFloor("2026-01-01T05:00:00Z"), "2025-12-31");
});

test("perVideoQueryRange: never before the publish floor, never after the window end; a video that did not exist yet is null (not a skip)", () => {
  const window = { startDate: "2026-09-14", endDate: "2026-10-01" };
  assert.deepEqual(perVideoQueryRange({ publishedAt: "2026-08-14T13:00:22Z" }, window), { from: "2026-09-14", to: "2026-10-01" });
  assert.deepEqual(perVideoQueryRange({ publishedAt: "2026-09-20T10:00:00Z" }, window), { from: "2026-09-19", to: "2026-10-01" }, "day 0 is included");
  assert.deepEqual(perVideoQueryRange({ publishedAt: "2026-10-01T10:00:00Z" }, window), { from: "2026-09-30", to: "2026-10-01" });
  assert.deepEqual(perVideoQueryRange({ publishedAt: "2026-10-02T10:00:00Z" }, window), { from: "2026-10-01", to: "2026-10-01" }, "published the day after the window end: its floor is the end date, still queried");
  assert.equal(perVideoQueryRange({ publishedAt: "2026-10-03T10:00:00Z" }, window), null, "floor 2026-10-02 is after the window end");
});

test("nextVideoHistoryThrough: only a query that reaches the publish date, or extends an existing history without a hole, can claim history", () => {
  const published = "2026-09-10T08:00:00Z"; // floor 2026-09-09
  assert.equal(nextVideoHistoryThrough({ prior: null, publishedAt: published, query: { from: "2026-09-09", to: "2026-10-01" } }), "2026-10-01");
  assert.equal(nextVideoHistoryThrough({ prior: null, publishedAt: published, query: { from: "2026-08-01", to: "2026-10-01" } }), "2026-10-01", "a query that starts earlier than the floor reaches it too");
  assert.equal(nextVideoHistoryThrough({ prior: null, publishedAt: published, query: { from: "2026-09-24", to: "2026-10-01" } }), null, "a rolling window that misses the early days proves nothing");
  assert.equal(nextVideoHistoryThrough({ prior: "2026-09-20", publishedAt: published, query: { from: "2026-09-21", to: "2026-10-02" } }), "2026-10-02", "contiguous extension");
  assert.equal(nextVideoHistoryThrough({ prior: "2026-09-20", publishedAt: published, query: { from: "2026-09-22", to: "2026-10-02" } }), null, "a one-day hole (09-21) breaks contiguity");
  assert.equal(nextVideoHistoryThrough({ prior: "2026-10-05", publishedAt: published, query: { from: "2026-09-09", to: "2026-10-01" } }), "2026-10-05", "never moves history backwards");
});

test("planVideoHistoryCatchUp: asks each video for exactly what is missing before the rolling window", () => {
  const videos = [
    { videoId: "old", publishedAt: "2026-08-14T13:00:22Z" }, // floor 08-13
    { videoId: "partial", publishedAt: "2026-08-20T10:00:00Z" }, // history through 09-14
    { videoId: "done", publishedAt: "2026-08-22T10:00:00Z" }, // history through 09-25
    { videoId: "inside", publishedAt: "2026-09-27T10:00:00Z" }, // inside the rolling window (starts 09-26)
    { videoId: "nodate", publishedAt: "" },
  ];
  const plan = planVideoHistoryCatchUp({
    videos,
    historyThrough: new Map([
      ["partial", "2026-09-14"],
      ["done", "2026-09-25"],
    ]),
    rollingStart: "2026-09-26",
  });
  assert.deepEqual(plan, [
    { videoId: "old", from: "2026-08-13", to: "2026-09-25" },
    { videoId: "partial", from: "2026-09-15", to: "2026-09-25" },
  ]);
});

test("planChannelCatchUp: the span of uncovered channel-level dates before the rolling window; non-channel-level runs prove nothing", () => {
  const args = { historyStart: "2026-08-13", rollingStart: "2026-09-26" };
  assert.deepEqual(planChannelCatchUp({ ...args, runs: [] }), { startDate: "2026-08-13", endDate: "2026-09-25" });
  assert.deepEqual(
    planChannelCatchUp({ ...args, runs: [{ requestedStartDate: "2026-09-14", requestedEndDate: "2026-09-25", channelLevel: true }] }),
    { startDate: "2026-08-13", endDate: "2026-09-13" }
  );
  assert.deepEqual(
    planChannelCatchUp({ ...args, runs: [{ requestedStartDate: "2026-08-13", requestedEndDate: "2026-09-25", channelLevel: false }] }),
    { startDate: "2026-08-13", endDate: "2026-09-25" },
    "a run that did not collect channel totals does not cover them"
  );
  assert.equal(planChannelCatchUp({ ...args, runs: [{ requestedStartDate: "2026-08-01", requestedEndDate: "2026-09-25", channelLevel: true }] }), null);
  assert.equal(planChannelCatchUp({ historyStart: null, rollingStart: "2026-09-26", runs: [] }), null);
  assert.equal(planChannelCatchUp({ historyStart: "2026-09-26", rollingStart: "2026-09-26", runs: [] }), null, "history starts inside the rolling window: nothing before it");
});

test("resolveHistoryStart: the channel creation date wins, else the earliest video publish date, else unknown", () => {
  const videos = [{ publishedAt: "2026-08-20T10:00:00Z" }, { publishedAt: "2026-08-14T13:00:22Z" }];
  assert.equal(resolveHistoryStart({ channelStartDate: "2026-08-13", videos }), "2026-08-13");
  assert.equal(resolveHistoryStart({ channelStartDate: null, videos }), "2026-08-14");
  assert.equal(resolveHistoryStart({ channelStartDate: null, videos: [{ publishedAt: "" }] }), null);
  assert.equal(resolveHistoryStart({ channelStartDate: null, videos: [] }), null);
});
