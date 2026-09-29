// ---------------------------------------------------------------------------
// Acceptance criteria derived from docs/roadmap/plans/PHASE_9_SLICE_9I_PLAN.md §4, drafted before
// this file's own implementation was read line-by-line (AGENTS.md §L). Every expected value below
// is hand-computed from the requirement, never copied from running the implementation.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
  assessDiscoveryRunQuality,
  assessObservationFreshness,
  assessSnapshotCompleteness,
  detectDisappearedVideoIds,
  toAgeNormalizedBasisFlag,
  toHiddenSubscriberCountFlag,
} from "./data-quality";

const NOW = new Date("2026-01-02T00:00:00.000Z"); // exactly 24h after 2026-01-01T00:00:00.000Z
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

test("AC-9I-01: assessObservationFreshness is null just under the staleness boundary and 'stale_observation' at/after it", () => {
  const justUnderBoundary = new Date(NOW.getTime() - STALE_AFTER_MS + 1); // age = boundary - 1ms
  assert.equal(assessObservationFreshness(justUnderBoundary, NOW, STALE_AFTER_MS), null);

  const exactlyAtBoundary = new Date(NOW.getTime() - STALE_AFTER_MS); // age = boundary exactly
  assert.equal(assessObservationFreshness(exactlyAtBoundary, NOW, STALE_AFTER_MS), "stale_observation");

  const wellPastBoundary = new Date(NOW.getTime() - STALE_AFTER_MS - 1000);
  assert.equal(assessObservationFreshness(wellPastBoundary, NOW, STALE_AFTER_MS), "stale_observation");
});

test("AC-9I-02: assessObservationFreshness returns null (not a flag) for a null lastObservedAt", () => {
  assert.equal(assessObservationFreshness(null, NOW, STALE_AFTER_MS), null);
});

test("AC-9I-03: assessSnapshotCompleteness flags a shortfall, and returns null for a match or any null input", () => {
  assert.equal(assessSnapshotCompleteness(5, 3), "missing_snapshot");
  assert.equal(assessSnapshotCompleteness(5, 5), null);
  assert.equal(assessSnapshotCompleteness(null, null), null);
  assert.equal(assessSnapshotCompleteness(5, null), null);
  assert.equal(assessSnapshotCompleteness(null, 3), null);
});

test("AC-9I-04: assessDiscoveryRunQuality flags a failed run with real progress, never a clean failure or a success", () => {
  assert.equal(assessDiscoveryRunQuality({ status: "failed", candidatesFound: 2 }), "partial_discovery");
  assert.equal(assessDiscoveryRunQuality({ status: "failed", candidatesFound: 0 }), null);
  assert.equal(assessDiscoveryRunQuality({ status: "failed", candidatesFound: null }), null);
  assert.equal(assessDiscoveryRunQuality({ status: "success", candidatesFound: 10 }), null);
});

test("AC-9I-05: toHiddenSubscriberCountFlag maps true/false to the flag/null", () => {
  assert.equal(toHiddenSubscriberCountFlag(true), "hidden_subscriber_count");
  assert.equal(toHiddenSubscriberCountFlag(false), null);
});

test("AC-9I-06: toAgeNormalizedBasisFlag maps both non-observed bases to insufficient_history, and observed to null", () => {
  assert.equal(toAgeNormalizedBasisFlag("not_yet_reached"), "insufficient_history");
  assert.equal(toAgeNormalizedBasisFlag("insufficient_history"), "insufficient_history");
  assert.equal(toAgeNormalizedBasisFlag("observed"), null);
});

test("AC-9I-07: detectDisappearedVideoIds returns exactly the ids missing from the current list, including all-gone and all-new edge cases", () => {
  assert.deepEqual(detectDisappearedVideoIds(["a", "b", "c"], ["a", "c"]), ["b"]);
  assert.deepEqual(detectDisappearedVideoIds([], ["a"]), []);
  assert.deepEqual(detectDisappearedVideoIds(["a"], []), ["a"]);
  assert.deepEqual(detectDisappearedVideoIds(["a", "b"], ["a", "b"]), []);
});

test("AC-9I-08: every function returns a value from the DataQualityFlag union or null, never undefined", () => {
  const results = [
    assessObservationFreshness(null, NOW, STALE_AFTER_MS),
    assessObservationFreshness(NOW, NOW, STALE_AFTER_MS),
    assessSnapshotCompleteness(null, null),
    assessSnapshotCompleteness(1, 1),
    assessDiscoveryRunQuality({ status: "success", candidatesFound: 1 }),
    toHiddenSubscriberCountFlag(false),
    toAgeNormalizedBasisFlag("observed"),
  ];
  for (const result of results) {
    assert.notEqual(result, undefined);
  }
});
