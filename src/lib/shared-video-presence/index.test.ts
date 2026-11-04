import assert from "node:assert/strict";
import test from "node:test";
import { existsOnChannelOf, isDeletedOnYoutube, VIDEO_DELETED_ON_YOUTUBE } from "./index";

// BL-243 (ADR 0063 §1): the shared rules. Check completed at 2026-11-04T08:00Z (values by hand).
const CHECK = "2026-11-04T08:00:00.000Z";

test("existsOnChannelOf: removed is false; listed and seen by the check is true; anything else is unknown", () => {
  assert.equal(existsOnChannelOf({ removed: true, listed: false, checkedAt: null }), false, "the mark is proof on its own");
  assert.equal(existsOnChannelOf({ removed: false, listed: true, publishedAt: "2026-11-01T00:00:00.000Z", checkedAt: CHECK }), true);
  assert.equal(existsOnChannelOf({ removed: false, listed: true, publishedAt: CHECK, checkedAt: CHECK }), true, "at the check's moment");
  // Published (or made public: YouTube then gives the publish time) after the check -> unknown until the next completed check.
  assert.equal(existsOnChannelOf({ removed: false, listed: true, publishedAt: "2026-11-04T09:00:00.000Z", checkedAt: CHECK }), null);
  assert.equal(existsOnChannelOf({ removed: false, listed: true, publishedAt: "2026-11-01T00:00:00.000Z", checkedAt: null }), null, "no check yet");
  assert.equal(existsOnChannelOf({ removed: false, listed: false, checkedAt: CHECK }), null, "not in the copy");
  assert.equal(existsOnChannelOf({ removed: false, listed: true, publishedAt: "soon", checkedAt: CHECK }), null);
});

test("isDeletedOnYoutube: only failed with the shared code", () => {
  assert.equal(VIDEO_DELETED_ON_YOUTUBE, "video_deleted_on_youtube");
  assert.equal(isDeletedOnYoutube({ status: "failed", code: "video_deleted_on_youtube" }), true);
  assert.equal(isDeletedOnYoutube({ status: "failed", code: "thumbnail_failed" }), false);
  assert.equal(isDeletedOnYoutube({ status: "packaged", code: "video_deleted_on_youtube" }), false);
  assert.equal(isDeletedOnYoutube(null), false);
});
