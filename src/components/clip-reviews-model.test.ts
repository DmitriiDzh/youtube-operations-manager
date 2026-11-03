import assert from "node:assert/strict";
import test from "node:test";
import { canApprove, clockOf, rangeOf, returnCommentReady, videoSrcOf } from "./clip-reviews-model";

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
