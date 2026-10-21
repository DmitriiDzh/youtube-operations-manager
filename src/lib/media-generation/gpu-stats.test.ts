import assert from "node:assert/strict";
import test from "node:test";
import type { StoredSessionRow } from "./sessions";
import { isDomainError } from "./contracts";
import { withImpliedNone } from "./gpu-availability";
import { buildGpuAvailabilityStats, buildGpuWaitRecord, createGpuStatsServices, failureReasonOf, nearestRank, type GpuStatsStore } from "./gpu-stats";

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
    { gpuTypeId: FOUR, gpuFallbackIds: [FIVE] }
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
    { gpuTypeId: FOUR, gpuFallbackIds: [] }
  );
  assert.deepEqual(record.skipped, [{ gpuTypeId: FIVE, reason: "not offered in EU-RO-1 (the volume's datacenter)" }]);
  assert.deepEqual(record.candidates, [FIVE, FOUR]);
  assert.equal(record.outcome, "failed");
  assert.equal(record.failureReason, "media_no_capacity");
  assert.equal(record.waitMinutes, null, "a failure has no wait");
  assert.equal(record.gpuTypeId, null, "no GPU obtained");
  assert.equal(record.waitApproximate, true);
});

test("BL-206 review: a failure's reason is only a leading code before ':'; free text goes to 'other'", () => {
  assert.equal(failureReasonOf("media_no_capacity: RTX 4090: could not be placed"), "media_no_capacity");
  assert.equal(failureReasonOf("media_container_stuck: the container did not start within 3 min"), "media_container_stuck");
  assert.equal(failureReasonOf("pod creation failed (HTTP 500 Internal Server Error): upstream"), "other");
  assert.equal(failureReasonOf("no GPU candidate qualifies: X: not in RunPod's GPU catalog"), "other");
  assert.equal(failureReasonOf("capacity wait ended: settings changed"), "other");
  assert.equal(failureReasonOf("Media_no_capacity: x"), "other");
  assert.equal(failureReasonOf(null), "other");
});

test("BL-206 review: the candidate list is the start's own -- ordered, without repeats; the Settings' GPU repeated in its fallback list counts once", () => {
  const record = buildGpuWaitRecord(storedSession({ id: "s3" }), { gpuTypeId: FOUR, gpuFallbackIds: [FIVE, FOUR, FIVE] });
  assert.deepEqual(record.candidates, [FOUR, FIVE]);
  const planned = buildGpuWaitRecord(storedSession({ id: "s4", gpuPlanJson: JSON.stringify({ candidates: [FIVE, FIVE, FOUR], minVramGb: null, maxPricePerHr: null }) }), { gpuTypeId: FOUR, gpuFallbackIds: [] });
  assert.deepEqual(planned.candidates, [FIVE, FOUR]);
});

test("BL-206 review: an unreadable stored GPU plan gives that record null candidates; the stats call still answers", async () => {
  const broken = storedSession({ id: "bad", gpuPlanJson: "{not json", firstApprovedAt: new Date("2026-10-20T10:00:00Z"), readyAt: new Date("2026-10-20T10:05:00Z") });
  const wrongShape = storedSession({ id: "shape", gpuPlanJson: JSON.stringify({ candidates: "NVIDIA" }), firstApprovedAt: new Date("2026-10-20T10:00:00Z"), readyAt: new Date("2026-10-20T10:07:00Z") });
  assert.equal(buildGpuWaitRecord(broken, { gpuTypeId: FOUR, gpuFallbackIds: [] }).candidates, null);
  const out = await statsServices([broken, wrongShape, readyAfter("ok", 3)]).getGpuStats({ from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" });
  assert.equal(out.sessions.count, 3);
  assert.deepEqual(
    out.sessions.byCandidates.map((g) => [g.candidates, g.count, g.medianWaitMinutes]),
    [
      [null, 2, 5],
      [[FOUR, FIVE], 1, 3],
    ]
  );
});

// -- §2.C factory_media_get_gpu_stats: AC-GS-06 (wait statistics) and AC-GS-08 (refusals, no RunPod) ------------------------------

const EMPTY_CELLS = { snapshots: [], gpus: [], rows: [] };

function statsServices(sessions: StoredSessionRow[], calls: string[] = []) {
  const store: GpuStatsStore = {
    async availabilityCells() {
      calls.push("availabilityCells");
      return EMPTY_CELLS;
    },
    async sessionsFirstApprovedBetween() {
      calls.push("sessions");
      return sessions;
    },
  };
  // BL-208 (GPU_START_FIXES_PLAN.md §F): the Settings also give the default CUDA minimum of the availability read (always set there).
  return createGpuStatsServices({ store, candidateSettings: async () => ({ gpuTypeId: FOUR, gpuFallbackIds: [FIVE], minCudaVersion: "12.8" }), clock: { now: () => new Date("2026-10-21T12:00:00Z") } });
}

/** A ready session first approved at 2026-10-20 (Tuesday) 10:00 UTC that waited `minutes`. */
function readyAfter(id: string, minutes: number, gpuTypeId = FOUR): StoredSessionRow {
  const first = new Date("2026-10-20T10:00:00Z");
  return storedSession({ id, firstApprovedAt: first, approvedAt: first, readyAt: new Date(first.getTime() + minutes * 60_000), gpuTypeId, status: "done" });
}

test("AC-GS-06: waits 2, 4, 6, 8, 30 min and one media_no_capacity failure -> median 6, p90 30 (nearest rank), failureRate 1/6; the failure is not a wait", async () => {
  const failed = storedSession({ id: "f1", status: "failed", firstApprovedAt: new Date("2026-10-20T10:00:00Z"), error: "media_no_capacity: nobody could be placed in 30 min", gpuTypeId: FOUR });
  const sessions = [readyAfter("a", 2), readyAfter("b", 4), readyAfter("c", 6, FIVE), readyAfter("d", 8), readyAfter("e", 30), failed];
  const { sessions: stats } = await statsServices(sessions).getGpuStats({ from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" });
  assert.equal(stats.count, 6);
  assert.equal(stats.ready, 5);
  assert.equal(stats.failed, 1);
  assert.equal(stats.medianWaitMinutes, 6);
  assert.equal(stats.p90WaitMinutes, 30);
  assert.ok(stats.failureRate !== null && Math.abs(stats.failureRate - 1 / 6) < 0.0001, String(stats.failureRate));
  assert.deepEqual(stats.failures, { media_no_capacity: 1 });
  // All six tried the Settings' list; the GPUs obtained: the 4090 four times (2, 4, 8, 30 -> median 4 at k = ceil(0.5 × 4) = 2, p90 30 at k = 4), the 5090 once (6).
  assert.deepEqual(
    stats.byCandidates.map((g) => [g.candidates, g.count, g.ready, g.failed, g.medianWaitMinutes, g.p90WaitMinutes]),
    [[[FOUR, FIVE], 6, 5, 1, 6, 30]]
  );
  assert.deepEqual(stats.byGpu, [
    { gpuTypeId: FOUR, ready: 4, medianWaitMinutes: 4, p90WaitMinutes: 30 },
    { gpuTypeId: FIVE, ready: 1, medianWaitMinutes: 6, p90WaitMinutes: 6 },
  ]);
  assert.equal("list" in stats, false, "the list only with includeSessions");
});

test("AC-GS-06: nearest rank -- an even count takes the lower middle (2, 4, 6, 8 -> median 4); one value is every percentile; none is null", () => {
  assert.equal(nearestRank([8, 2, 6, 4], 50), 4);
  assert.equal(nearestRank([8, 2, 6, 4], 90), 8);
  assert.equal(nearestRank([5], 90), 5);
  assert.equal(nearestRank([], 50), null);
});

test("BL-206: includeSessions lists each session's wait record; hours/weekdays filter the sessions by their first approval", async () => {
  const saturday = storedSession({ id: "sat", firstApprovedAt: new Date("2026-10-24T13:00:00Z"), readyAt: new Date("2026-10-24T13:03:00Z"), status: "done" });
  const tuesday = readyAfter("tue", 3);
  const services = statsServices([saturday, tuesday]);
  const all = await services.getGpuStats({ from: "2026-10-19T00:00:00Z", to: "2026-10-26T00:00:00Z", includeSessions: true });
  assert.deepEqual(
    (all.sessions.list ?? []).map((r) => [r.sessionId, r.waitMinutes]),
    [
      ["sat", 3],
      ["tue", 3],
    ]
  );
  const weekdays = await services.getGpuStats({ from: "2026-10-19T00:00:00Z", to: "2026-10-26T00:00:00Z", weekdays: [1, 2, 3, 4, 5], includeSessions: true });
  assert.deepEqual((weekdays.sessions.list ?? []).map((r) => r.sessionId), ["tue"]);
  const morning = await services.getGpuStats({ from: "2026-10-19T00:00:00Z", to: "2026-10-26T00:00:00Z", hoursUtc: { from: 6, to: 12 } });
  assert.equal(morning.sessions.count, 1, "10:00 is inside 6-12, 13:00 is not");
});

test("AC-GS-08: from after to, or a window over 90 days, is refused with invalid_request before any read", async () => {
  const calls: string[] = [];
  const services = statsServices([], calls);
  for (const input of [
    { from: "2026-10-21T00:00:00Z", to: "2026-10-20T00:00:00Z" },
    { from: "2026-07-01T00:00:00Z", to: "2026-10-01T00:00:00Z" }, // 92 days
    { to: "2026-10-21T00:00:00Z", from: "2026-07-22T23:59:59Z" }, // 90 days and 1 s
    { hoursUtc: { from: 12, to: 12 } },
  ]) {
    await assert.rejects(services.getGpuStats(input), (e: unknown) => isDomainError(e) && e.code === "invalid_request", JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
  // Exactly 90 days is allowed; the default window is the last 7 days to now.
  const ninety = await services.getGpuStats({ from: "2026-07-23T00:00:00Z", to: "2026-10-21T00:00:00Z" });
  assert.equal(ninety.from, "2026-07-23T00:00:00.000Z");
  const defaults = await services.getGpuStats({});
  assert.deepEqual([defaults.from, defaults.to], ["2026-10-14T12:00:00.000Z", "2026-10-21T12:00:00.000Z"]);
  await assert.rejects(services.getGpuStats({ weekdays: [8] }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
});

test("AC-GS-08: the stats never reach RunPod -- no RunPod client among its dependencies, and no network call while it runs", async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    throw new Error("no network in this test");
  }) as typeof fetch;
  try {
    const out = await statsServices([readyAfter("a", 2)]).getGpuStats({ includeSessions: true, from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" });
    assert.equal(out.sessions.ready, 1);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetched, 0);
});

test("BL-206 review: a listing without a level (UNKNOWN) is neither in stock nor NONE -- 4 snapshots, LOW 1, UNKNOWN 1 -> inStock 1 (0.25), unknown 1, NONE 2", () => {
  const stats = buildGpuAvailabilityStats(
    {
      snapshots: [{ hour: 10, weekday: 2, count: 4 }],
      gpus: [{ gpuTypeId: "G", hour: 10, weekday: 2, count: 4 }],
      rows: [
        { gpuTypeId: "G", dataCenterId: "A", stock: "LOW", hour: 10, weekday: 2, count: 1 },
        { gpuTypeId: "G", dataCenterId: "A", stock: null, hour: 10, weekday: 2, count: 1 },
      ],
    },
    {}
  );
  const [entry] = stats.entries;
  assert.deepEqual([entry.snapshots, entry.inStock, entry.inStockShare, entry.unknown], [4, 1, 0.25, 1]);
  assert.deepEqual(entry.stock, { LOW: 1, UNKNOWN: 1, NONE: 2 });
  assert.deepEqual(entry.byHourUtc[10], { snapshots: 4, inStockShare: 0.25 });
  assert.deepEqual(entry.byWeekday[1], { snapshots: 4, inStockShare: 0.25 });
});

test("BL-206 review: the one NONE rule -- read 5, LOW 2, UNKNOWN 1, a stored NONE 1 -> NONE 2 (not 3); nothing left -> no NONE key", () => {
  assert.deepEqual(withImpliedNone({ LOW: 2, UNKNOWN: 1, NONE: 1 }, 5), { LOW: 2, UNKNOWN: 1, NONE: 2 });
  assert.deepEqual(withImpliedNone({ HIGH: 3 }, 3), { HIGH: 3 });
  assert.deepEqual(withImpliedNone({}, 2), { NONE: 2 });
});
