import assert from "node:assert/strict";
import test from "node:test";
import { toWideMetricRows } from "./wide-rows";

// Expected output is written by hand from the layout rule in wide-rows.ts (AGENTS.md §L).

test("one row per video per day, a column per requested metric in the requested order, null where that metric has no row", () => {
  const wide = toWideMetricRows(
    [
      { videoId: "vB", metricDate: "2026-10-02", metricName: "views", metricValue: 7 },
      { videoId: "vA", metricDate: "2026-10-02", metricName: "likes", metricValue: 1 },
      { videoId: "vA", metricDate: "2026-10-01", metricName: "views", metricValue: 5 },
      { videoId: "vA", metricDate: "2026-10-01", metricName: "likes", metricValue: 2 },
      { videoId: "vA", metricDate: "2026-10-01", metricName: "shares", metricValue: 9 },
    ],
    ["views", "likes"]
  );
  assert.deepEqual(wide, [
    { videoId: "vA", metricDate: "2026-10-01", views: 5, likes: 2 },
    { videoId: "vA", metricDate: "2026-10-02", views: null, likes: 1 },
    { videoId: "vB", metricDate: "2026-10-02", views: 7, likes: null },
  ]);
  assert.deepEqual(Object.keys(wide[0]), ["videoId", "metricDate", "views", "likes"]);
});

test("no rows -> no wide rows; a zero value is kept as 0, never turned into null", () => {
  assert.deepEqual(toWideMetricRows([], ["views"]), []);
  assert.deepEqual(toWideMetricRows([{ videoId: "v", metricDate: "2026-10-01", metricName: "views", metricValue: 0 }], ["views"]), [
    { videoId: "v", metricDate: "2026-10-01", views: 0 },
  ]);
});
