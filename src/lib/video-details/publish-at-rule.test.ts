import assert from "node:assert/strict";
import test from "node:test";
import { publishAtWriteRefusal } from "./publish-at-rule";

// BL-182 stage 1 (PUBLISHING_PLAN.md §2 stage 1 item 5; owner msg 2707 "rescheduling while private: yes"). YouTube Data API videos
// reference: status.publishAt can be set only for a private video, which becomes public at that time; a past time publishes it at
// once. So: a scheduled video can get a new date while it is still private and its current date is still ahead, and only a future
// one; a public video, or one whose date has passed, is refused (the old AC-SVC-02 case stays refused).

const NOW = Date.parse("2026-10-13T12:00:00Z");

test("a scheduled, still-private video with its date ahead can be moved to another future date", () => {
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: "2026-10-14T12:00:00Z" }, { publishAt: "2026-10-16T12:00:00Z" }, NOW), null);
});

test("a video without a date is unaffected by this rule (the patch schema already requires private)", () => {
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: null }, { publishAt: "2026-10-16T12:00:00Z" }, NOW), null);
  assert.equal(publishAtWriteRefusal("v", { privacyStatus: "public", publishAt: null }, {}, NOW), null, "no publishAt in the patch");
});

test("refused: the current date has passed, the video is not private, or the new date is not ahead", () => {
  const passed = publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: "2026-10-13T11:59:00Z" }, { publishAt: "2026-10-16T12:00:00Z" }, NOW);
  assert.equal(passed?.code, "publish_at_already_published");
  const notPrivate = publishAtWriteRefusal("v", { privacyStatus: "unlisted", publishAt: "2026-10-14T12:00:00Z" }, { publishAt: "2026-10-16T12:00:00Z" }, NOW);
  assert.equal(notPrivate?.code, "publish_at_already_published");
  const pastNew = publishAtWriteRefusal("v", { privacyStatus: "private", publishAt: "2026-10-14T12:00:00Z" }, { publishAt: "2026-10-13T12:00:00Z" }, NOW);
  assert.equal(pastNew?.code, "validation_failed", "exactly now is not ahead");
});
