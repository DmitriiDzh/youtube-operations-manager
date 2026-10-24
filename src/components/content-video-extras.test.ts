import assert from "node:assert/strict";
import test from "node:test";
import { combineExtras, NO_EXTRAS } from "./content-video-extras";
import { costUsd, costUsdPrecise } from "./video-cost-dialog";
import { formatDuration } from "./content-manager";

// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage A): what each «Видео» row shows from the four local reads; any read missing
// leaves its own columns empty and nothing else.

test("BL-221: Vn and its cost reach the video the number became; insights and languages are per video", () => {
  const extras = combineExtras({
    insights: {
      channelId: "UC1",
      videos: { vid_V62____: { kind: "video", views7d: 99, impressions7d: 1000, ctr7d: 0.052 }, live_______: { kind: "live", views7d: 12, impressions7d: null, ctr7d: null } },
      viewsThrough: "2026-10-21",
      reachThrough: "2026-10-22",
    },
    projects: { videos: [{ video: "V63", youtubeVideoId: null }, { video: "V62", youtubeVideoId: "vid_V62____" }, { video: "V61", youtubeVideoId: "vid_V61____" }] },
    costs: {
      videos: [
        { video: "V62", totals: { totalUsd: 1.7, runs: 12, estimated: true } },
        { video: "V61", totals: { totalUsd: 0, runs: 0, estimated: false } },
      ],
    },
    overview: { videos: [{ videoId: "vid_V62____", presentLanguages: ["de", "es", "fr", "it", "ja", "pt", "ru", "zh"], missingLanguages: ["ko"] }] },
  });
  assert.deepEqual(extras.get("vid_V62____"), {
    kind: "video",
    views7d: 99,
    impressions7d: 1000,
    ctr7d: 0.052,
    vn: "V62",
    costUsd: 1.7,
    costEstimated: true,
    languages: { present: 8, total: 9, missing: ["ko"] },
  });
  // A number without runs shows no cost (not $0.00).
  assert.deepEqual(extras.get("vid_V61____"), { ...NO_EXTRAS, vn: "V61" });
  assert.equal(extras.get("live_______")?.kind, "live");
});

test("BL-221: with every read failed, nothing is known", () => {
  assert.equal(combineExtras({ insights: null, projects: null, costs: null, overview: null }).size, 0);
});

test("BL-221: totals in cents (a positive amount under half a cent is «<$0.01»); a run's own share keeps up to 4 decimals", () => {
  assert.equal(costUsd(2.1288), "$2.13");
  assert.equal(costUsd(0), "$0.00");
  assert.equal(costUsd(0.004), "<$0.01");
  assert.equal(costUsd(0.005), "$0.01");
  assert.equal(costUsdPrecise(2.1288), "$2.1288");
  assert.equal(costUsdPrecise(0.0040), "$0.004");
  assert.equal(costUsdPrecise(1.5), "$1.50");
});

test("BL-221: a length reads as H:MM:SS from an hour on, M:SS below; unknown stays empty", () => {
  assert.equal(formatDuration(715), "11:55");
  assert.equal(formatDuration(10800), "3:00:00");
  assert.equal(formatDuration(39651), "11:00:51");
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(0), null);
});
