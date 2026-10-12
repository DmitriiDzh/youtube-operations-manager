import assert from "node:assert/strict";
import test from "node:test";
import {
  canCopyIntoBuffer,
  checkPublicOnly,
  classifyRunEnd,
  locatePlayback,
  passLength,
  planBuffer,
} from "./rotation";

// Acceptance criteria from docs/roadmap/plans/LIVE_STREAMS_PLAN.md §4.1, fixed before the code. The expected values
// below are the plan's own hand-computed numbers, not output of the implementation.

const NOW = new Date("2026-10-12T12:00:00Z");

// --- Guard (§3.4, §4.1 "Guard") ------------------------------------------------------------------------------------

test("guard: public with no publishAt is allowed", () => {
  assert.deepEqual(checkPublicOnly({ privacyStatus: "public", publishAt: null }, NOW), { allowed: true });
});

test("guard: public with a past publishAt is allowed", () => {
  assert.deepEqual(checkPublicOnly({ privacyStatus: "public", publishAt: "2026-10-11T08:00:00Z" }, NOW), { allowed: true });
});

test("guard: private, unlisted, and public with a future publishAt are refused with the reason", () => {
  assert.deepEqual(checkPublicOnly({ privacyStatus: "private", publishAt: null }, NOW), { allowed: false, reason: "private" });
  assert.deepEqual(checkPublicOnly({ privacyStatus: "unlisted", publishAt: null }, NOW), { allowed: false, reason: "unlisted" });
  assert.deepEqual(checkPublicOnly({ privacyStatus: "public", publishAt: "2026-10-12T12:00:01Z" }, NOW), { allowed: false, reason: "scheduled" });
});

test("guard: a private video with a future publishAt (scheduled) is refused as scheduled; an unknown status is refused", () => {
  assert.deepEqual(checkPublicOnly({ privacyStatus: "private", publishAt: "2026-10-13T00:00:00Z" }, NOW), { allowed: false, reason: "scheduled" });
  assert.deepEqual(checkPublicOnly({ privacyStatus: null, publishAt: null }, NOW), { allowed: false, reason: "unknown" });
  assert.deepEqual(checkPublicOnly(null, NOW), { allowed: false, reason: "not_found" });
});

test("guard: an unparseable publishAt is not treated as past", () => {
  assert.deepEqual(checkPublicOnly({ privacyStatus: "public", publishAt: "not-a-date" }, NOW), { allowed: false, reason: "unknown" });
});

// --- Now playing (§4.1 "Now playing") ------------------------------------------------------------------------------

const ROTATION = [7288, 7211, 7224];

test("now playing: one pass of 7,288 / 7,211 / 7,224 s is 21,723 s", () => {
  assert.equal(passLength(ROTATION, 0, 0), 21723);
});

test("now playing: out_time 7,300 s is video 2 at 12 s", () => {
  assert.deepEqual(locatePlayback(ROTATION, { startIndex: 0, startOffset: 0 }, 7300), { index: 1, offset: 12, passEnded: false });
});

test("now playing: out_time 21,700 s is video 3 at 7,201 s", () => {
  assert.deepEqual(locatePlayback(ROTATION, { startIndex: 0, startOffset: 0 }, 21700), { index: 2, offset: 7201, passEnded: false });
});

test("now playing: resumed with inpoint 3,000 s on video 2, out_time 5,000 s is video 3 at 789 s", () => {
  assert.deepEqual(locatePlayback(ROTATION, { startIndex: 1, startOffset: 3000 }, 5000), { index: 2, offset: 789, passEnded: false });
});

test("now playing: out_time at or past the end of the pass reports the pass as ended", () => {
  assert.deepEqual(locatePlayback(ROTATION, { startIndex: 0, startOffset: 0 }, 21723), { index: 3, offset: 0, passEnded: true });
});

// --- Run end (§3.6 "An early end is never a pass end") -------------------------------------------------------------

test("run end: a run that reached its list's length is a pass end", () => {
  assert.equal(classifyRunEnd({ outTimeSeconds: 21722, expectedSeconds: 21723, toleranceSeconds: 3 }), "pass_end");
});

test("run end: a run that stopped short of its list (exit code 0 included) is an early end, never a pass end", () => {
  assert.equal(classifyRunEnd({ outTimeSeconds: 7290, expectedSeconds: 21723, toleranceSeconds: 3 }), "early_end");
  assert.equal(classifyRunEnd({ outTimeSeconds: 0, expectedSeconds: 21723, toleranceSeconds: 3 }), "early_end");
});

// --- Buffer (§4.1 "Buffer": rotation A, B, C, depth 2) -------------------------------------------------------------

test("buffer: while A plays, the buffer holds A and B", () => {
  assert.deepEqual(planBuffer({ order: ["A", "B", "C"], currentIndex: 0, nextPassFirst: "A", depth: 2, present: ["A"] }), {
    keep: ["A", "B"],
    copy: ["B"],
    remove: [],
  });
});

test("buffer: after the encoder moves to B, A is deleted and C is copied; B is never deleted while it plays", () => {
  const plan = planBuffer({ order: ["A", "B", "C"], currentIndex: 1, nextPassFirst: "A", depth: 2, present: ["A", "B"] });
  assert.deepEqual(plan, { keep: ["B", "C"], copy: ["C"], remove: ["A"] });
  assert.ok(!plan.remove.includes("B"));
});

test("buffer: on the last video of a pass, the next one is the first of the next pass", () => {
  assert.deepEqual(planBuffer({ order: ["A", "B", "C"], currentIndex: 2, nextPassFirst: "B", depth: 2, present: ["B", "C"] }), {
    keep: ["C", "B"],
    copy: [],
    remove: [],
  });
});

test("buffer: depth 3 keeps the current video and the next two", () => {
  assert.deepEqual(planBuffer({ order: ["A", "B", "C", "D"], currentIndex: 1, nextPassFirst: "A", depth: 3, present: ["A", "B"] }), {
    keep: ["B", "C", "D"],
    copy: ["C", "D"],
    remove: ["A"],
  });
});

test("buffer: a one-video rotation keeps that one video and never removes it", () => {
  assert.deepEqual(planBuffer({ order: ["A"], currentIndex: 0, nextPassFirst: "A", depth: 2, present: ["A"] }), {
    keep: ["A"],
    copy: [],
    remove: [],
  });
});

// --- Disk (§3.5 "Copying refuses a file that would leave under 5 GB") ----------------------------------------------

const GB = 1024 ** 3;

test("disk: a copy that would leave less than the refuse level free is not started", () => {
  assert.equal(canCopyIntoBuffer({ freeBytes: 6 * GB, fileBytes: GB + 1, refuseBelowBytes: 5 * GB }), false);
  assert.equal(canCopyIntoBuffer({ freeBytes: 2 * GB, fileBytes: GB, refuseBelowBytes: 5 * GB }), false);
});

test("disk: a copy that leaves exactly the refuse level, or more, may start", () => {
  assert.equal(canCopyIntoBuffer({ freeBytes: 6 * GB, fileBytes: GB, refuseBelowBytes: 5 * GB }), true);
  assert.equal(canCopyIntoBuffer({ freeBytes: 30 * GB, fileBytes: GB, refuseBelowBytes: 5 * GB }), true);
});
