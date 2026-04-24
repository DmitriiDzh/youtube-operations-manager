import assert from "node:assert/strict";
import test from "node:test";
import { getVideoMetadataErrorStatus } from "./error-status";

test("video metadata error status maps auth failures correctly", () => {
  assert.equal(getVideoMetadataErrorStatus("unauthorized"), 401);
  assert.equal(getVideoMetadataErrorStatus("AUTH_USER_NOT_FOUND"), 401);
  assert.equal(getVideoMetadataErrorStatus("AUTH_SCOPE_INSUFFICIENT"), 403);
});

test("video metadata error status maps validation and not found correctly", () => {
  assert.equal(getVideoMetadataErrorStatus("validation_failed"), 400);
  assert.equal(getVideoMetadataErrorStatus("not_found"), 404);
});

test("video metadata error status maps semantic and update issues to 422", () => {
  assert.equal(getVideoMetadataErrorStatus("target_language_unresolvable"), 422);
  assert.equal(getVideoMetadataErrorStatus("transcript_unavailable"), 422);
  assert.equal(getVideoMetadataErrorStatus("generation_failed"), 422);
  assert.equal(getVideoMetadataErrorStatus("update_failed"), 422);
});
