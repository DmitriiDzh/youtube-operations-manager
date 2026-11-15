// BL-255 (ADR 0069 §3, AC-TH-04): the thumbnail writer refuses while this computer's upload of the video has not yet run its own
// thumbnail step -- the runner would put the package's file over the new one. Expected values from that rule: only an ACTIVE row
// (queued / uploading / processing / finishing / paused) of the same video id without `steps.thumbnail` is pending; a damaged
// steps_json is pending (fail closed); a done, failed or cancelled row never runs its steps again.
import assert from "node:assert/strict";
import test from "node:test";
import { thumbnailStepPendingIn } from "./index";

const V = "ZeRdh3bZlkg";
const row = (status: string, steps: string, videoId: string | null = V) => ({ status, videoId, stepsJson: steps }) as never;

test("AC-TH-04 an active row of the video without steps.thumbnail is pending, in every active status", () => {
  for (const status of ["queued", "uploading", "processing", "finishing", "paused"]) {
    assert.equal(thumbnailStepPendingIn([row(status, "{}")], V), true, status);
  }
});

test("AC-TH-04 steps.thumbnail set or failed is not pending", () => {
  assert.equal(thumbnailStepPendingIn([row("finishing", '{"thumbnail":"set"}')], V), false);
  assert.equal(thumbnailStepPendingIn([row("finishing", '{"thumbnail":"failed","playlist":"added"}')], V), false);
});

test("AC-TH-04 done, failed and cancelled rows are not pending, even without the step", () => {
  for (const status of ["done", "failed", "cancelled"]) assert.equal(thumbnailStepPendingIn([row(status, "{}")], V), false, status);
});

test("AC-TH-04 a damaged steps_json on an active row is pending (fail closed); another video's row is not", () => {
  assert.equal(thumbnailStepPendingIn([row("processing", "{not json")], V), true);
  assert.equal(thumbnailStepPendingIn([row("processing", "null")], V), true);
  assert.equal(thumbnailStepPendingIn([row("processing", "{}", "AAAAAAAAAAA")], V), false);
  assert.equal(thumbnailStepPendingIn([row("uploading", "{}", null)], V), false);
  assert.equal(thumbnailStepPendingIn([], V), false);
});
