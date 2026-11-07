import assert from "node:assert/strict";
import test from "node:test";
import { attachmentSrcOf, attachmentsReady, canApprove, clockOf, isImageMime, percentOf, pieceOffsetsOf, rangeOf, returnCommentReady, scenesOf, videoSrcOf, type ClipDto } from "./clip-reviews-model";

// BL-241 (CLIP_REVIEWS_PLAN.md item 5, ADR 0061 §6): the player plays the Producer's range (a media fragment), the row shows it on
// the clip's clock, and «Одобрить» needs a waiting clip whose file here is the submitted one.

const BASE = "/api/channels/UC1/clip-reviews";

test("BL-241: the player's address carries the range as a media fragment; none for the whole clip", () => {
  assert.equal(videoSrcOf(BASE, { clipId: "clip_1", startSec: null, endSec: null }), "/api/channels/UC1/clip-reviews/clip_1/video");
  assert.equal(videoSrcOf(BASE, { clipId: "clip_1", startSec: 5, endSec: 25 }), "/api/channels/UC1/clip-reviews/clip_1/video#t=5,25");
  assert.equal(videoSrcOf(BASE, { clipId: "clip_1", startSec: 12.5, endSec: null }), "/api/channels/UC1/clip-reviews/clip_1/video#t=12.5");
  assert.equal(videoSrcOf(BASE, { clipId: "clip_1", startSec: null, endSec: 40 }), "/api/channels/UC1/clip-reviews/clip_1/video#t=0,40");
});

test("BL-241: the range on the clip's clock; the whole clip has none", () => {
  assert.equal(clockOf(0), "0:00");
  assert.equal(clockOf(65.4), "1:05");
  assert.equal(clockOf(120), "2:00");
  assert.equal(rangeOf({ startSec: null, endSec: null, durationSeconds: 30 }), null);
  assert.deepEqual(rangeOf({ startSec: 5, endSec: 25, durationSeconds: 30 }), { from: "0:05", to: "0:25" });
  assert.deepEqual(rangeOf({ startSec: 70, endSec: null, durationSeconds: 95 }), { from: "1:10", to: "1:35" });
});

test("BL-241: approve needs pending + the submitted file here; a return needs a comment", () => {
  assert.equal(canApprove({ status: "pending", file: "ok" }), true);
  assert.equal(canApprove({ status: "pending", file: "missing" }), false);
  assert.equal(canApprove({ status: "pending", file: "changed" }), false);
  assert.equal(canApprove({ status: "approved", file: "ok" }), false);
  assert.equal(returnCommentReady("   "), false);
  assert.equal(returnCommentReady("darker, please"), true);
  assert.equal(returnCommentReady("x".repeat(2001)), false);
});

// BL-246 (CLIP_REVIEWS_PLAN.md items 10, 13, 16): the attachments' addresses, which ones show as pictures, the pieces a file is sent
// in (4 MiB apart), and when the decision may go (every file uploaded, none failed).

test("BL-246: an attachment's address names the clip, the decision and its place", () => {
  assert.equal(attachmentSrcOf(BASE, "clip_1", "cd_2", 3), "/api/channels/UC1/clip-reviews/clip_1/attachments/cd_2/3");
});

test("BL-246: png, jpeg, webp and gif are pictures; pdf, text and video are links", () => {
  for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) assert.equal(isImageMime(mime), true, mime);
  for (const mime of ["application/pdf", "text/plain", "text/markdown", "application/json", "video/mp4", "image/svg+xml"]) assert.equal(isImageMime(mime), false, mime);
});

test("BL-246: a file goes in pieces 4 MiB apart; 50 MiB is 13 pieces, the last one 2 MiB", () => {
  const MiB = 1024 * 1024;
  assert.deepEqual(pieceOffsetsOf(10, 4), [0, 4, 8]);
  assert.deepEqual(pieceOffsetsOf(8, 4), [0, 4]);
  assert.deepEqual(pieceOffsetsOf(0, 4), []);
  const offsets = pieceOffsetsOf(50 * MiB, 4 * MiB);
  assert.equal(offsets.length, 13);
  assert.equal(50 * MiB - offsets[12], 2 * MiB);
});

test("BL-246: the decision waits for every file; a failed one must be removed first", () => {
  assert.equal(attachmentsReady([]), true);
  assert.equal(attachmentsReady([{ state: "ready" }, { state: "ready" }]), true);
  assert.equal(attachmentsReady([{ state: "ready" }, { state: "uploading" }]), false);
  assert.equal(attachmentsReady([{ state: "failed" }]), false);
  assert.equal(percentOf(0, 10), 0);
  assert.equal(percentOf(4, 10), 40);
  assert.equal(percentOf(10, 10), 100);
});

// ---- BL-247 (CLIP_REVIEWS_PLAN.md AC-CR-29/30): versions of a scene, newest on top ----

function clipOf(clipId: string, sceneId: string, submittedAt: string, status: ClipDto["status"] = "pending"): ClipDto {
  return {
    clipId, channelId: "UC1", sceneId, clipPath: `${clipId}.mp4`, note: "n", startSec: null, endSec: null, durationSeconds: 30, sizeBytes: 1,
    submittedAt, device: null, status, comment: null, decidedAt: null, decidedOn: null, file: "ok", decisionId: null, attachments: [],
  };
}
const shape = (scenes: ReturnType<typeof scenesOf>) =>
  scenes.map((s) => ({ scene: s.sceneId, latest: [s.latest.clip.clipId, s.latest.version], earlier: s.earlier.map((v) => [v.clip.clipId, v.version]), waiting: s.waiting }));

test("AC-CR-29: one row per scene, latest version on it, earlier ones newest first, numbered from the first submitted", () => {
  const clips = [
    clipOf("A1", "a", "2026-11-07T10:00:00.000Z", "returned"),
    clipOf("B1", "b", "2026-11-07T10:01:00.000Z"),
    clipOf("A2", "a", "2026-11-07T10:02:00.000Z", "returned"),
    clipOf("A3", "a", "2026-11-07T10:03:00.000Z"),
  ];
  assert.deepEqual(shape(scenesOf(clips)), [
    { scene: "a", latest: ["A3", 3], earlier: [["A2", 2], ["A1", 1]], waiting: true },
    { scene: "b", latest: ["B1", 1], earlier: [], waiting: true },
  ]);
  // The same moment: numbered by clipId. Order of the input does not matter.
  const same = scenesOf([clipOf("x2", "s", "2026-11-07T10:00:00.000Z"), clipOf("x1", "s", "2026-11-07T10:00:00.000Z")]);
  assert.deepEqual(shape(same), [{ scene: "s", latest: ["x2", 2], earlier: [["x1", 1]], waiting: true }]);
  // Scene labels match exactly: `A` and `a` are two scenes.
  assert.equal(scenesOf([clipOf("u1", "A", "2026-11-07T10:00:00.000Z"), clipOf("u2", "a", "2026-11-07T10:01:00.000Z")]).length, 2);
  assert.deepEqual(scenesOf([]), []);
});

test("AC-CR-30: waiting scenes first, then the others, each with the newest latest version on top", () => {
  const clips = [
    clipOf("a1", "a", "2026-11-07T10:03:00.000Z"),
    clipOf("c1", "c", "2026-11-07T10:05:00.000Z", "approved"),
    clipOf("b1", "b", "2026-11-07T10:04:00.000Z"),
    clipOf("d1", "d", "2026-11-07T10:01:00.000Z", "returned"),
  ];
  assert.deepEqual(scenesOf(clips).map((s) => s.sceneId), ["b", "a", "c", "d"]);
  // The latest version decided, an earlier one still waiting: the scene waits.
  const mixed = scenesOf([clipOf("e1", "e", "2026-11-07T09:00:00.000Z"), clipOf("e2", "e", "2026-11-07T09:30:00.000Z", "approved"), clipOf("f1", "f", "2026-11-07T11:00:00.000Z", "approved")]);
  assert.deepEqual(shape(mixed).map((s) => [s.scene, s.waiting]), [["e", true], ["f", false]]);
});
