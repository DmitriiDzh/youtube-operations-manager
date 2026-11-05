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

// BL-243 review round 8: the 24 h grace is measured by the latest completed removed check, not the mark's first time (values by hand).
test("removedMarkFreesSlot: a check 24 h after the upload frees; earlier holds; unknown upload frees; unknown check holds", async () => {
  const { REMOVED_MARK_GRACE_MS, removedMarkFreesSlot, uploadTimeOf } = await import("./index");
  const T0 = Date.parse("2026-11-03T08:00:00.000Z");
  assert.equal(REMOVED_MARK_GRACE_MS, 86_400_000);
  assert.equal(removedMarkFreesSlot({ uploadedAt: T0, checkedAt: "2026-11-03T10:00:00.000Z" }), false, "T0+2h");
  assert.equal(removedMarkFreesSlot({ uploadedAt: T0, checkedAt: "2026-11-04T07:59:59.999Z" }), false);
  assert.equal(removedMarkFreesSlot({ uploadedAt: T0, checkedAt: "2026-11-04T08:00:00.000Z" }), true, "exactly 24 h");
  assert.equal(removedMarkFreesSlot({ uploadedAt: T0, checkedAt: "2026-11-04T10:00:00.000Z" }), true, "T0+26h");
  assert.equal(removedMarkFreesSlot({ uploadedAt: null, checkedAt: "2026-11-03T10:00:00.000Z" }), true, "unknown upload time");
  assert.equal(removedMarkFreesSlot({ uploadedAt: T0, checkedAt: null }), false, "no check time");
  assert.equal(uploadTimeOf({ uploadedAt: "2026-11-03T08:00:00.000Z" }, null), T0);
  assert.equal(uploadTimeOf(null, { stepsJson: JSON.stringify({ uploadedAt: "2026-11-03T08:00:00.000Z" }) }), T0);
  assert.equal(uploadTimeOf({ uploadedAt: null }, { stepsJson: "{}" }), null);
});
