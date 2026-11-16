import assert from "node:assert/strict";
import test from "node:test";
import { actionsOf, durationLabel, frameOf, mediaSrcOf, returnCommentReady } from "./package-reviews-model";

// BL-257 (PACKAGE_REVIEW_PLAN.md AC-PR-04/05/09/15; ADR 0070 §4, §6): the screen asks for the media by the manifest hash only; the
// owner may change his mind until the upload; approval needs the manifest's video checksum; a return needs a comment; a vertical
// video keeps its 9:16 frame.

test("media address: by manifest hash, never a path", () => {
  assert.equal(mediaSrcOf("/api/channels/UC_1/package-reviews", "a".repeat(64), "video"), `/api/channels/UC_1/package-reviews/video?manifest=${"a".repeat(64)}`);
  assert.equal(mediaSrcOf("/b", "f0", "thumbnail"), "/b/thumbnail?manifest=f0");
});

test("durations", () => {
  assert.deepEqual([durationLabel(58), durationLabel(754), durationLabel(3725), durationLabel(0)], ["0:58", "12:34", "1:02:05", "0:00"]);
});

// BL-265 (AC-MG-07): every package also offers «Комментарий к упаковке», uploaded ones included.
test("AC-PR-04/05, AC-MG-07: actions by state", () => {
  assert.deepEqual(actionsOf({ state: "pending", hasVideoSha256: true }), { approve: true, ret: true, comment: true });
  assert.deepEqual(actionsOf({ state: "pending", hasVideoSha256: false }), { approve: false, ret: true, comment: true });
  assert.deepEqual(actionsOf({ state: "approved", hasVideoSha256: true }), { approve: false, ret: true, comment: true });
  assert.deepEqual(actionsOf({ state: "returned", hasVideoSha256: true }), { approve: true, ret: false, comment: true });
  assert.deepEqual(actionsOf({ state: "uploaded", hasVideoSha256: true }), { approve: false, ret: false, comment: true });
  assert.deepEqual([returnCommentReady(""), returnCommentReady("  \n"), returnCommentReady(" x ")], [false, false, true]);
});

test("AC-PR-15: the frame follows the video's own size", () => {
  assert.deepEqual([frameOf(1080, 1920), frameOf(1920, 1080), frameOf(0, 0)], ["vertical", "horizontal", "horizontal"]);
});
