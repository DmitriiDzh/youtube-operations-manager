// ---------------------------------------------------------------------------
// Acceptance criteria derived from docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md §5, expected
// values computed by hand from the requirement before this file's own implementation was read
// line-by-line (AGENTS.md §L):
//
// AC-9A-01: computeSnapshotDelta returns per-field change (later - earlier); a field is null
//           whenever either side is null for it, independently of the other fields.
// AC-9A-02: computeSnapshotDelta can report a real negative change (a count genuinely decreased),
//           never clamped to non-negative.
// AC-9A-03: computeSnapshotVelocity given fewer than 2 snapshots returns insufficient_history for
//           every field, never a computed rate.
// AC-9A-04: computeSnapshotVelocity given a snapshot at or before the window's start reports
//           full_window and the correct per-day rate over the real span between the two chosen
//           snapshots.
// AC-9A-05: computeSnapshotVelocity given real history shorter than the requested window reports
//           partial_window, with the rate computed over the actually-available span only, never
//           extrapolated to the full requested window.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { computeSnapshotDelta, computeSnapshotVelocity, type SnapshotWithTime } from "./derived-metrics";

test("AC-9A-01: computeSnapshotDelta computes per-field change, null when either side is null for that field", () => {
  const earlier = { subscriberCount: 100, viewCount: 5000, videoCount: 10 };
  const later = { subscriberCount: 120, viewCount: 5500, videoCount: 11 };

  assert.deepEqual(computeSnapshotDelta(earlier, later), { subscriberCount: 20, viewCount: 500, videoCount: 1 });

  assert.deepEqual(
    computeSnapshotDelta(
      { subscriberCount: null, viewCount: 5000, videoCount: 10 },
      { subscriberCount: 120, viewCount: null, videoCount: 11 }
    ),
    { subscriberCount: null, viewCount: null, videoCount: 1 },
    "each field's nullability is independent of the others"
  );
});

test("AC-9A-02: computeSnapshotDelta reports a real negative change, never clamped to non-negative", () => {
  const earlier = { subscriberCount: 100, viewCount: 5000, videoCount: 10 };
  const later = { subscriberCount: 90, viewCount: 5500, videoCount: 10 };

  assert.deepEqual(computeSnapshotDelta(earlier, later), { subscriberCount: -10, viewCount: 500, videoCount: 0 });
});

test("AC-9A-03: computeSnapshotVelocity reports insufficient_history for 0 or 1 snapshots", () => {
  const now = new Date("2026-09-26T00:00:00.000Z");
  const one: SnapshotWithTime[] = [
    { observedAt: new Date("2026-09-20T00:00:00.000Z"), subscriberCount: 100, viewCount: 1000, videoCount: 5 },
  ];

  for (const snapshots of [[], one]) {
    const result = computeSnapshotVelocity(snapshots, 7, now);
    assert.equal(result.subscriberCount.basis, "insufficient_history");
    assert.equal(result.subscriberCount.value, null);
    assert.equal(result.viewCount.basis, "insufficient_history");
    assert.equal(result.videoCount.basis, "insufficient_history");
  }
});

test("AC-9A-04: computeSnapshotVelocity reports full_window and the correct per-day rate when a snapshot reaches back to the window's start", () => {
  const now = new Date("2026-09-26T00:00:00.000Z");
  // Cutoff = now - 7 days = 2026-09-19T00:00:00.000Z. The earlier snapshot (09-18) is at/before
  // the cutoff -> full_window. Span between the two chosen snapshots is exactly 7 days.
  const snapshots: SnapshotWithTime[] = [
    { observedAt: new Date("2026-09-18T00:00:00.000Z"), subscriberCount: 100, viewCount: 1000, videoCount: 5 },
    { observedAt: new Date("2026-09-25T00:00:00.000Z"), subscriberCount: 170, viewCount: 1700, videoCount: 6 },
  ];

  const result = computeSnapshotVelocity(snapshots, 7, now);

  assert.equal(result.subscriberCount.basis, "full_window");
  assert.equal(result.subscriberCount.value, 10); // (170-100)/7
  assert.equal(result.viewCount.basis, "full_window");
  assert.equal(result.viewCount.value, 100); // (1700-1000)/7
  assert.equal(result.videoCount.basis, "full_window");
  assert.ok(Math.abs(result.videoCount.value! - 1 / 7) < 1e-9); // (6-5)/7
});

test("AC-9A-05: computeSnapshotVelocity reports partial_window and computes the rate over the real span only, when history is shorter than the requested window", () => {
  const now = new Date("2026-09-26T00:00:00.000Z");
  // Requested window is 30 days (cutoff = 2026-08-27), but the earliest real snapshot is only
  // 6 days old (2026-09-20) -- no snapshot reaches the cutoff, so this must fall back to the
  // earliest available snapshot and report partial_window, computing the rate over the real
  // 5-day span between the two snapshots actually given (09-20 to 09-25), never extrapolated to
  // the full 30-day window.
  const snapshots: SnapshotWithTime[] = [
    { observedAt: new Date("2026-09-20T00:00:00.000Z"), subscriberCount: 100, viewCount: null, videoCount: 5 },
    { observedAt: new Date("2026-09-25T00:00:00.000Z"), subscriberCount: 150, viewCount: 2000, videoCount: 5 },
  ];

  const result = computeSnapshotVelocity(snapshots, 30, now);

  assert.equal(result.subscriberCount.basis, "partial_window");
  assert.equal(result.subscriberCount.value, 10); // (150-100)/5 real days
  assert.equal(result.viewCount.basis, "partial_window");
  assert.equal(result.viewCount.value, null, "a field null on either endpoint stays null, never fabricated");
  assert.equal(result.videoCount.value, 0);
});

// Updated 2026-09-26 by round 2 of independent review, against round 1's own fix for this exact
// scenario: round 1 correctly stopped this case from falsely reporting insufficient_history, but
// asserted the wrong basis ("full_window") for it -- round 2 found that `full_window` requires
// `latest` itself to be current relative to the window, which it is NOT here (latest is 60 days
// old against a 30-day window). The requirement itself did not change: "must produce a real,
// honestly-labeled rate, never insufficient_history" -- only which label is honest for this
// specific scenario did (`AGENTS.md` §L: a requirement-derived correction, not "the impl doesn't
// do this").
test("AC-9A-11: computeSnapshotVelocity computes a real rate from 2+ snapshots that are ALL older than the requested window, reporting stale_latest (never falsely insufficient_history or full_window)", () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const now = new Date("2026-09-26T00:00:00.000Z");
  const ninetyDaysAgo = new Date(now.getTime() - 90 * MS_PER_DAY);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * MS_PER_DAY);
  // Requested window is 30 days (cutoff = 30 days ago), but BOTH real snapshots (60 and 90 days
  // ago) are older than that -- including `latest` itself, so this is NOT a reliable "last 30
  // days" figure even though a real rate can still be computed over the true ~30-day span between
  // the two snapshots.
  const snapshots: SnapshotWithTime[] = [
    { observedAt: ninetyDaysAgo, subscriberCount: 100, viewCount: 1000, videoCount: 5 },
    { observedAt: sixtyDaysAgo, subscriberCount: 130, viewCount: 1300, videoCount: 6 },
  ];

  const result = computeSnapshotVelocity(snapshots, 30, now);

  assert.notEqual(result.subscriberCount.basis, "insufficient_history");
  assert.equal(result.subscriberCount.basis, "stale_latest");
  assert.equal(result.subscriberCount.value, 1); // (130-100)/30 real days
  assert.equal(result.viewCount.value, 10); // (1300-1000)/30
  assert.ok(Math.abs(result.videoCount.value! - 1 / 30) < 1e-9); // (6-5)/30
});

test("AC-9A-12: computeSnapshotVelocity ignores a candidate that ties latest's own (second-truncated) timestamp, using a genuinely earlier snapshot instead of falling back to insufficient_history", () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const now = new Date("2026-09-26T00:00:00.000Z");
  const ninetyDaysAgo = new Date(now.getTime() - 90 * MS_PER_DAY);
  const tiedInstant = new Date(now.getTime() - 60 * MS_PER_DAY);
  // Two snapshots share the EXACT same stored instant (the real-world cause: observedAt is
  // truncated to whole seconds by the DB column, so two captures within the same wall-clock
  // second collide) -- one of them becomes `latest` (array order decides which, both are
  // equally "latest" by timestamp). Round 2 of independent review found an earlier version
  // discarded ALL history in this case (spanMs === 0 against the tied candidate), even though the
  // genuinely distinct 90-day-old snapshot was perfectly usable.
  const snapshots: SnapshotWithTime[] = [
    { observedAt: ninetyDaysAgo, subscriberCount: 100, viewCount: 1000, videoCount: 5 },
    { observedAt: tiedInstant, subscriberCount: 130, viewCount: 1300, videoCount: 6 },
    { observedAt: tiedInstant, subscriberCount: 130, viewCount: 1300, videoCount: 6 },
  ];

  const result = computeSnapshotVelocity(snapshots, 7, now);

  assert.notEqual(result.subscriberCount.basis, "insufficient_history");
  assert.equal(result.subscriberCount.value, 1); // (130-100)/30 real days between the 90-day-old and the tied pair
});

test("computeSnapshotVelocity sorts out-of-order input snapshots by observedAt before choosing endpoints", () => {
  const now = new Date("2026-09-26T00:00:00.000Z");
  // Deliberately passed newest-first -- the function must not assume caller ordering.
  const snapshots: SnapshotWithTime[] = [
    { observedAt: new Date("2026-09-25T00:00:00.000Z"), subscriberCount: 170, viewCount: 1700, videoCount: 6 },
    { observedAt: new Date("2026-09-18T00:00:00.000Z"), subscriberCount: 100, viewCount: 1000, videoCount: 5 },
  ];

  const result = computeSnapshotVelocity(snapshots, 7, now);

  assert.equal(result.subscriberCount.basis, "full_window");
  assert.equal(result.subscriberCount.value, 10);
});
