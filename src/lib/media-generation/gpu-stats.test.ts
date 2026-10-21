import assert from "node:assert/strict";
import test from "node:test";
import type { StoredSessionRow } from "./sessions";
import { buildGpuWaitRecord, failureReasonOf } from "./gpu-stats";

// BL-206 (FO-REQ-0033, docs/roadmap/plans/GPU_STATS_PLAN.md §3). Expected values are the plan's acceptance criteria, worked out by
// hand: AC-GS-05 (approved 10:00, retried 10:20, ready 10:24 -> a 24-minute wait, not 4) and AC-GS-07 (the skipped candidates on
// the session's record).

const FOUR = "NVIDIA GeForce RTX 4090";
const FIVE = "NVIDIA GeForce RTX 5090";

function storedSession(over: Partial<StoredSessionRow> & Pick<StoredSessionRow, "id">): StoredSessionRow {
  return {
    channelId: "UC1",
    status: "done",
    requestedBy: "factory",
    reason: null,
    maxMinutes: 60,
    maxUsd: null,
    estimateUsd: 0.69,
    fitsToday: true,
    costPerHr: 0.69,
    gpuTypeId: FOUR,
    datacenterId: "EU-RO-1",
    podId: null,
    comfyUiProxyUrl: null,
    tokenCiphertext: null,
    tokenIv: null,
    tokenAuthTag: null,
    createdAt: new Date("2026-10-20T09:59:00Z"),
    approvedAt: null,
    approvedByUserId: null,
    startedAt: null,
    readyAt: null,
    lastActivityAt: null,
    stoppedAt: null,
    secondsUsed: null,
    usdCharged: null,
    stopReason: null,
    error: null,
    stoppingOutcome: null,
    lastSeenAliveAt: null,
    terminateSentAt: null,
    ...over,
  };
}

test("AC-GS-05: the wait is ready − first approval -- approved 10:00, retried 10:20 (approvedAt), ready 10:24 -> 24 minutes, not 4", () => {
  const record = buildGpuWaitRecord(
    storedSession({
      id: "s1",
      firstApprovedAt: new Date("2026-10-20T10:00:00Z"),
      approvedAt: new Date("2026-10-20T10:20:00Z"),
      readyAt: new Date("2026-10-20T10:24:00Z"),
      capacityAttempts: 3,
      usdCharged: 0.12,
    }),
    [FOUR, FIVE]
  );
  assert.equal(record.waitMinutes, 24);
  assert.equal(record.outcome, "ready");
  assert.equal(record.gpuTypeId, FOUR);
  assert.equal(record.firstApprovedAt, "2026-10-20T10:00:00.000Z");
  assert.equal(record.waitApproximate, false);
  assert.equal(record.capacityAttempts, 3);
  assert.deepEqual(record.candidates, [FOUR, FIVE], "no plan of its own: the Settings' list");
});

test("AC-GS-07: the skipped candidates are on the session's wait record; the session's own plan is its candidate list", () => {
  const record = buildGpuWaitRecord(
    storedSession({
      id: "s2",
      status: "failed",
      gpuPlanJson: JSON.stringify({ candidates: [FIVE, FOUR], minVramGb: null, maxPricePerHr: null }),
      firstApprovedAt: new Date("2026-10-20T10:00:00Z"),
      firstApprovedApproximate: true,
      gpuSkippedJson: JSON.stringify([{ gpuTypeId: FIVE, reason: "not offered in EU-RO-1 (the volume's datacenter)" }]),
      error: "media_no_capacity: nobody could be placed in 30 min",
    }),
    [FOUR]
  );
  assert.deepEqual(record.skipped, [{ gpuTypeId: FIVE, reason: "not offered in EU-RO-1 (the volume's datacenter)" }]);
  assert.deepEqual(record.candidates, [FIVE, FOUR]);
  assert.equal(record.outcome, "failed");
  assert.equal(record.failureReason, "media_no_capacity");
  assert.equal(record.waitMinutes, null, "a failure has no wait");
  assert.equal(record.gpuTypeId, null, "no GPU obtained");
  assert.equal(record.waitApproximate, true);
});

test("BL-206: a failure's reason is the code its error starts with, or its first words as a code; none -> unknown", () => {
  assert.equal(failureReasonOf("media_no_capacity: RTX 4090: could not be placed"), "media_no_capacity");
  assert.equal(failureReasonOf("no GPU candidate qualifies: X: not in RunPod's GPU catalog"), "no_gpu_candidate_qualifies");
  assert.equal(failureReasonOf("pod creation failed: HTTP 422"), "pod_creation_failed");
  assert.equal(failureReasonOf(null), "unknown");
});
