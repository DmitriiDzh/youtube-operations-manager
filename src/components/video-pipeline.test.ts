import assert from "node:assert/strict";
import test from "node:test";
import { canLink, pipelinePhase } from "./video-pipeline";

// BL-221 (CONTENT_UX_PLAN.md stage B, acceptance 3): the board's columns, worked out from the plan's phase list.

const pub = { privacyStatus: "public", publishAt: null };
const scheduled = { privacyStatus: "private", publishAt: "2026-10-30T12:00:00Z" };

test("BL-221: a linked video decides by its YouTube access -- public is published, anything else (or not synced) is on YouTube", () => {
  assert.equal(pipelinePhase({ state: "published", youtubeVideoId: "abcdefghijk" }, pub), "published");
  assert.equal(pipelinePhase({ state: "published", youtubeVideoId: "abcdefghijk" }, scheduled), "youtube");
  assert.equal(pipelinePhase({ state: "published", youtubeVideoId: "abcdefghijk" }, { privacyStatus: "unlisted", publishAt: null }), "youtube");
  assert.equal(pipelinePhase({ state: "packaged", youtubeVideoId: "abcdefghijk" }, null), "youtube");
});

test("BL-221: without a linked video -- published (registry/old upload), package, video file, else preparation; cancelled is on no column", () => {
  assert.equal(pipelinePhase({ state: "published" }, null), "published");
  assert.equal(pipelinePhase({ state: "packaged", hasVideoFile: true }, null), "package");
  assert.equal(pipelinePhase({ state: "in_work", hasVideoFile: true }, null), "edit");
  assert.equal(pipelinePhase({ state: "in_work", hasVideoFile: false }, null), "prep");
  assert.equal(pipelinePhase({ state: "cancelled", hasVideoFile: true }, null), null);
});

test("BL-221: «Привязать к видео» is offered for a number with a folder and no video, never for a cancelled one", () => {
  assert.equal(canLink({ state: "in_work", folder: "04 Videos/10 October/1011 V52", youtubeVideoId: null }), true);
  assert.equal(canLink({ state: "in_work", folder: null, youtubeVideoId: null }), false);
  assert.equal(canLink({ state: "published", folder: "f", youtubeVideoId: "abcdefghijk" }), false);
  assert.equal(canLink({ state: "cancelled", folder: "f", youtubeVideoId: null }), false);
});
