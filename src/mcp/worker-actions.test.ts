import assert from "node:assert/strict";
import test from "node:test";
import { describeWorkerWrite, fromToolResult, serializeWorkerDetail } from "./worker-actions";

// WORKER_CAPABILITIES_PLAN.md AC-WK-06: which worker calls would really write to YouTube. Expected values from the plan.

test("apply writes only with an explicit dryRun false", () => {
  assert.equal(describeWorkerWrite("apply", { videoId: "v1" }), null);
  assert.equal(describeWorkerWrite("apply", { videoId: "v1", dryRun: true }), null);
  assert.deepEqual(describeWorkerWrite("apply", { videoId: "v1", dryRun: false }), { target: "v1", detail: { fields: ["title", "description"] } });
});

test("the four playlist writes always write; reads, playlist_delete and unknown tools never count", () => {
  assert.ok(describeWorkerWrite("playlist_create", { title: "T" }));
  assert.ok(describeWorkerWrite("playlist_update", { playlistId: "p", title: "T" }));
  assert.ok(describeWorkerWrite("playlist_add_videos", { playlistId: "p", videoIds: ["v"] }));
  assert.ok(describeWorkerWrite("playlist_remove_videos", { playlistId: "p", videoIds: ["v"] }));
  for (const tool of ["playlist_list", "preview", "list", "playlist_delete", "agent_list_worker_actions", "nope"]) {
    assert.equal(describeWorkerWrite(tool, {}), null, tool);
  }
});

test("a created playlist is private unless asked otherwise", () => {
  assert.deepEqual(describeWorkerWrite("playlist_create", { title: "T" })?.detail, { title: "T", privacyStatus: "private" });
});

test("the answer gives a created playlist's id and the failed videos of an add/remove", () => {
  assert.deepEqual(fromToolResult("playlist_create", { playlist: { id: "p-new" } }), { target: "p-new", failedVideos: null, previousPrivacyStatus: null, changed: null });
  assert.deepEqual(fromToolResult("playlist_add_videos", { failures: [{}, {}] }), { target: null, failedVideos: 2, previousPrivacyStatus: null, changed: null });
  assert.deepEqual(fromToolResult("playlist_update", { playlist: { id: "p" } }), { target: null, failedVideos: null, previousPrivacyStatus: null, changed: null });
  assert.deepEqual(fromToolResult("playlist_create", undefined), { target: null, failedVideos: null, previousPrivacyStatus: null, changed: null });
});

test("the detail column is bounded at 500 characters and empty fields give null", () => {
  assert.equal(serializeWorkerDetail({}), null);
  const long = serializeWorkerDetail({ videoIds: Array.from({ length: 200 }, (_, i) => `video-${i}`) });
  assert.equal(long?.length, 500);
  assert.ok(long?.endsWith("…"));
});

test("BL-216: agent_set_privacy writes only with dryRun false, and the answer gives the previous status", () => {
  assert.equal(describeWorkerWrite("agent_set_privacy", { target: "video", id: "v1", privacyStatus: "private" }), null);
  assert.deepEqual(describeWorkerWrite("agent_set_privacy", { target: "playlist", id: "PL1", privacyStatus: "unlisted", dryRun: false }), {
    target: "PL1",
    detail: { target: "playlist", privacyStatus: "unlisted" },
  });
  assert.deepEqual(fromToolResult("agent_set_privacy", { previousPrivacyStatus: "public", changed: true }), {
    target: null,
    failedVideos: null,
    previousPrivacyStatus: "public",
    changed: true,
  });
});
