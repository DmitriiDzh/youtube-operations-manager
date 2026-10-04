import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_VIDEOS_PER_CHANNEL,
  estimateCollectionUnits,
  isValidIsoDate,
  isValidMaxVideosPerChannel,
  needsBackfill,
  resolveCollectionDepth,
} from "./collection-depth";

// Expected values are worked out by hand from the operator request (2026-10-04), not read from the implementation.

test("estimateCollectionUnits: 1 channels.list + one page per 50 videos; worst case adds one videos.list per page", () => {
  // [cap, first collection, worst case]
  const cases: Array<[number, number, number]> = [
    [1, 2, 3],
    [50, 2, 3],
    [51, 3, 5],
    [100, 3, 5],
    [120, 4, 7],
    [2000, 41, 81],
  ];
  for (const [cap, first, worst] of cases) {
    const estimate = estimateCollectionUnits(cap);
    assert.equal(estimate.firstCollection, first, `cap ${cap}`);
    assert.equal(estimate.firstCollectionWorstCase, worst, `cap ${cap}`);
  }
  assert.equal(estimateCollectionUnits(50).steadyState, "2-3");
});

test("isValidMaxVideosPerChannel: integers 1..2000 only", () => {
  for (const ok of [1, 50, 2000]) assert.equal(isValidMaxVideosPerChannel(ok), true);
  for (const bad of [0, -1, 2001, 1.5, Number.NaN]) assert.equal(isValidMaxVideosPerChannel(bad), false);
});

test("isValidIsoDate: a real calendar date written YYYY-MM-DD", () => {
  for (const ok of ["2026-10-04", "2024-02-29", "2000-01-01"]) assert.equal(isValidIsoDate(ok), true, ok);
  for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-1-1", "2026/10/04", "20261004", "2026-10-04T00:00:00Z", ""]) {
    assert.equal(isValidIsoDate(bad), false, bad);
  }
});

test("resolveCollectionDepth: channel override > global default > built-in 50 / no date", () => {
  assert.deepEqual(resolveCollectionDepth({}, { maxVideosPerChannel: null, publishedAfter: null }), { maxVideosPerChannel: DEFAULT_MAX_VIDEOS_PER_CHANNEL, publishedAfter: null });
  assert.deepEqual(resolveCollectionDepth({}, { maxVideosPerChannel: 200, publishedAfter: "2026-01-01" }), { maxVideosPerChannel: 200, publishedAfter: "2026-01-01" });
  assert.deepEqual(
    resolveCollectionDepth({ maxVideosPerChannel: 75, publishedAfter: "2025-06-01" }, { maxVideosPerChannel: 200, publishedAfter: "2026-01-01" }),
    { maxVideosPerChannel: 75, publishedAfter: "2025-06-01" }
  );
});

test("needsBackfill: unknown/unfinished always; finished only when a raised cap or an earlier date reaches past what it covered", () => {
  const depth = (max: number, date: string | null = null) => ({ maxVideosPerChannel: max, publishedAfter: date });
  assert.equal(needsBackfill({}, depth(50)), true, "state not yet known = first collection");
  assert.equal(needsBackfill({ videosComplete: null }, depth(50)), true);
  assert.equal(needsBackfill({ videosComplete: 0, videosNextPageToken: "t" }, depth(50)), true);

  const capDone = { videosComplete: 1, videosCompleteReason: "cap", videosCapAtRun: 120 };
  assert.equal(needsBackfill(capDone, depth(120)), false);
  assert.equal(needsBackfill(capDone, depth(121)), true);
  assert.equal(needsBackfill(capDone, depth(60)), false);

  const dateDone = { videosComplete: 1, videosCompleteReason: "date", videosPublishedAfterAtRun: "2026-03-01" };
  assert.equal(needsBackfill(dateDone, depth(50, "2026-03-01")), false);
  assert.equal(needsBackfill(dateDone, depth(50, "2026-04-01")), false, "a later date covers less");
  assert.equal(needsBackfill(dateDone, depth(50, "2026-02-01")), true, "an earlier date reaches further back");
  assert.equal(needsBackfill(dateDone, depth(50, null)), true, "removing the date reaches further back");

  const exhausted = { videosComplete: 1, videosCompleteReason: "exhausted", videosCapAtRun: 100 };
  assert.equal(needsBackfill(exhausted, depth(2000)), false, "the playlist has nothing deeper to give");
  assert.equal(needsBackfill(exhausted, depth(100, "2020-01-01")), false);
});

test("needsBackfill (review 2026-10-04): a finished 'cap' collection walks deeper again when retention has shrunk the readable stored count below 90% of the depth reached; unknown count never triggers", () => {
  const depth = (max: number) => ({ maxVideosPerChannel: max, publishedAfter: null });
  const done = { videosComplete: 1, videosCompleteReason: "cap", videosCapAtRun: 120 };
  assert.equal(needsBackfill(done, depth(120), 120), false);
  assert.equal(needsBackfill(done, depth(120), 108), false, "90% of 120 is 108: exactly at the line is still fine");
  assert.equal(needsBackfill(done, depth(120), 107), true);
  assert.equal(needsBackfill(done, depth(120), 50), true, "the 30-day expiry of deeper pages leaves about one page");
  assert.equal(needsBackfill(done, depth(60), 54), false, "a lowered cap lowers the target: 90% of min(60,120) = 54");
  assert.equal(needsBackfill(done, depth(60), 53), true);
  assert.equal(needsBackfill(done, depth(120)), false, "no count given: unchanged behaviour");
  assert.equal(needsBackfill({ videosComplete: 1, videosCompleteReason: "exhausted" }, depth(120), 5), false, "exhausted playlists have nothing deeper");
});
