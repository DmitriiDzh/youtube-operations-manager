import assert from "node:assert/strict";
import test from "node:test";
import { publishAtWriteRefusal } from "./publish-at-rule";
import { missingWriteOnlyStatusFields } from "./read-back";

// BL-182 stage 1 (PUBLISHING_PLAN.md §2 stage 1 item 5; owner msg 2707 "rescheduling while private: yes"). YouTube Data API videos
// reference: status.publishAt can be set only for a private video, which becomes public at that time; a past time publishes it at
// once. So: a scheduled video can get a new date while it is still private and its current date is still ahead, and only a future
// one; a public video, or one whose date has passed, is refused (the old AC-SVC-02 case stays refused).

const NOW = Date.parse("2026-10-13T12:00:00Z");

test("a scheduled, still-private video with its date ahead can be moved to another future date", () => {
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: "2026-10-14T12:00:00Z" }, { publishAt: "2026-10-16T12:00:00Z" }, NOW), null);
});

test("a private video without a date can get a future one; a patch without publishAt is not this rule's business", () => {
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: null }, { publishAt: "2026-10-16T12:00:00Z" }, NOW), null);
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "public", publishAt: null }, {}, NOW), null, "no publishAt in the patch");
});

// Independent review S2 (2026-10-13): the rule applies to every publishAt write, a public video is refused even without a date (the
// patch would make it private again), and both times need a 15-minute margin -- inside it YouTube may publish the video between our
// read and the write, which would then take it back to private.
test("review S2: a public video is refused even without a date; an undated private video still needs a future time", () => {
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "public", publishAt: null }, { publishAt: "2026-10-16T12:00:00Z" }, NOW)?.code, "publish_at_already_published");
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: null }, { publishAt: "2026-10-12T12:00:00Z" }, NOW)?.code, "publish_at_too_soon");
});

test("review S2: the 15-minute margin -- a current time 14 minutes ahead is too close; a new time 15 minutes ahead is too close, 16 is fine", () => {
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: "2026-10-13T12:14:00Z" }, { publishAt: "2026-10-16T12:00:00Z" }, NOW)?.code, "publish_at_already_published");
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: null }, { publishAt: "2026-10-13T12:15:00Z" }, NOW)?.code, "publish_at_too_soon");
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: null }, { publishAt: "2026-10-13T12:16:00Z" }, NOW), null);
});

test("refused: the current date has passed, the video is not private, or the new date is not ahead", () => {
  const passed = publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: "2026-10-13T11:59:00Z" }, { publishAt: "2026-10-16T12:00:00Z" }, NOW);
  assert.equal(passed?.code, "publish_at_already_published");
  const notPrivate = publishAtWriteRefusal("v", { privacyStatus: "unlisted", publishAt: "2026-10-14T12:00:00Z" }, { publishAt: "2026-10-16T12:00:00Z" }, NOW);
  assert.equal(notPrivate?.code, "publish_at_already_published");
  const pastNew = publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: "2026-10-14T12:00:00Z" }, { publishAt: "2026-10-13T12:00:00Z" }, NOW);
  assert.equal(pastNew?.code, "publish_at_too_soon", "exactly now is not ahead");
});

// BL-182 review (G1: YouTube never returns "AI use" on read; videos.update replaces the status part it is sent): a status write must
// carry containsSyntheticMedia when the read could not supply it, or it is reset; a snippet-only write is not affected.
test("a status write without containsSyntheticMedia, when the read lacks it, is refused; with it, or snippet-only, it is fine", () => {
  assert.deepEqual(missingWriteOnlyStatusFields(true, { privacyStatus: "private" }, { publishAt: "x", privacyStatus: "private" }), ["containsSyntheticMedia"]);
  assert.deepEqual(missingWriteOnlyStatusFields(true, { containsSyntheticMedia: null }, { privacyStatus: "private", containsSyntheticMedia: true }), []);
  assert.deepEqual(missingWriteOnlyStatusFields(false, {}, { title: "x" }), []);
  assert.deepEqual(missingWriteOnlyStatusFields(true, { containsSyntheticMedia: true }, { license: "youtube" }), [], "a readable value is carried over");
});
