import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSessionCost, type CostSplitJob } from "./cost-split";

// BL-194 stage 2 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 2, §4 criterion 3, ADR 0041). Expected values are worked out by
// hand from the plan: the session's charge is split across its jobs in proportion to their GPU seconds (pod start and idle time
// included in the shares), in 1/10000 USD, by largest remainder, so the jobs add up to the charge exactly.

const t = (seconds: number) => new Date(Date.UTC(2026, 9, 17, 10, 0, 0) + seconds * 1000);
const job = (id: string, over: Partial<CostSplitJob>): CostSplitJob => ({
  id,
  status: "done",
  createdAt: t(0),
  submittedAt: t(0),
  startedAt: null,
  gpuFinishedAt: null,
  finishedAt: null,
  ...over,
});

test("criterion 3: a $1.00 session with jobs of 60 and 30 GPU seconds gives $0.6667 and $0.3333, adding up to $1.00 exactly", () => {
  const split = splitSessionCost({
    chargeUsd: 1,
    costPerHr: null,
    jobs: [job("a", { startedAt: t(10), gpuFinishedAt: t(70), finishedAt: t(75) }), job("b", { startedAt: t(70), gpuFinishedAt: t(100), finishedAt: t(104) })],
  });
  assert.ok(split);
  const a = split.find((s) => s.id === "a")!;
  const b = split.find((s) => s.id === "b")!;
  assert.equal(a.allocatedUsd, 0.6667);
  assert.equal(b.allocatedUsd, 0.3333);
  assert.equal(a.gpuSeconds, 60);
  assert.equal(b.gpuSeconds, 30);
  assert.equal(a.basis, "measured");
  assert.equal(b.basis, "measured");
  assert.equal(Math.round((a.allocatedUsd + b.allocatedUsd) * 10000), 10000);
  // Without an hourly price the overhead part cannot be told apart.
  assert.equal(a.overheadUsd, null);
});

test("the overhead share is the job's part of the charge above its own GPU time at the hourly price", () => {
  // $3.60/h = $0.001 per second: 60 s cost $0.06 directly, 30 s $0.03; the rest of each share is start / idle time.
  const split = splitSessionCost({
    chargeUsd: 1,
    costPerHr: 3.6,
    jobs: [job("a", { startedAt: t(10), gpuFinishedAt: t(70) }), job("b", { startedAt: t(70), gpuFinishedAt: t(100) })],
  })!;
  assert.equal(split[0].overheadUsd, 0.6067);
  assert.equal(split[1].overheadUsd, 0.3033);
});

test("three equal jobs of a $1.00 session: 0.3334 + 0.3333 + 0.3333 (the remainder goes to the earliest job)", () => {
  const split = splitSessionCost({
    chargeUsd: 1,
    costPerHr: null,
    jobs: [job("a", { startedAt: t(0), gpuFinishedAt: t(10) }), job("b", { startedAt: t(10), gpuFinishedAt: t(20) }), job("c", { startedAt: t(20), gpuFinishedAt: t(30) })],
  })!;
  assert.deepEqual(
    split.map((s) => s.allocatedUsd),
    [0.3334, 0.3333, 0.3333]
  );
});

test("a missed start is estimated as the later of its submit and the previous job's finish on the pod, and marked estimated", () => {
  // Both submitted at 0; ComfyUI runs them one after the other. b's execution_start was missed: it started when a finished (60).
  const split = splitSessionCost({
    chargeUsd: 0.9,
    costPerHr: null,
    jobs: [job("a", { startedAt: t(0), gpuFinishedAt: t(60) }), job("b", { startedAt: null, gpuFinishedAt: t(90) })],
  })!;
  const b = split.find((s) => s.id === "b")!;
  assert.equal(b.gpuSeconds, 30);
  assert.equal(b.basis, "estimated");
  assert.equal(b.allocatedUsd, 0.3);
  assert.equal(split.find((s) => s.id === "a")!.allocatedUsd, 0.6);
});

test("a missed finish falls back to the job's own finish (output transfer included) and is marked estimated", () => {
  const split = splitSessionCost({ chargeUsd: 0.5, costPerHr: null, jobs: [job("a", { startedAt: t(0), gpuFinishedAt: null, finishedAt: t(40) })] })!;
  assert.equal(split[0].gpuSeconds, 40);
  assert.equal(split[0].basis, "estimated");
  assert.equal(split[0].allocatedUsd, 0.5);
});

test("old runs without any websocket time: sequential per pod from submitted/finished, every share an estimate", () => {
  const split = splitSessionCost({
    chargeUsd: 1.2,
    costPerHr: null,
    jobs: [job("a", { submittedAt: t(0), finishedAt: t(80) }), job("b", { submittedAt: t(5), finishedAt: t(120) })],
  })!;
  // a: 0..80 = 80 s; b: starts when a finished (80), ends 120 = 40 s. 1.2 * 80/120 = 0.8, 1.2 * 40/120 = 0.4.
  assert.deepEqual(
    split.map((s) => [s.id, s.gpuSeconds, s.allocatedUsd, s.basis]),
    [
      ["a", 80, 0.8, "estimated"],
      ["b", 40, 0.4, "estimated"],
    ]
  );
});

test("a job that never reached ComfyUI (cancelled in the queue) takes nothing; the others take the whole charge", () => {
  const split = splitSessionCost({
    chargeUsd: 1,
    costPerHr: null,
    jobs: [job("a", { startedAt: t(0), gpuFinishedAt: t(50) }), job("q", { status: "cancelled", submittedAt: null, finishedAt: t(60) })],
  })!;
  assert.equal(split.find((s) => s.id === "q")!.allocatedUsd, 0);
  assert.equal(split.find((s) => s.id === "a")!.allocatedUsd, 1);
});

test("jobs with no GPU time at all share the charge equally, marked estimated (the sum still equals the charge)", () => {
  const split = splitSessionCost({
    chargeUsd: 0.1,
    costPerHr: null,
    jobs: [job("a", { status: "failed", finishedAt: t(0) }), job("b", { status: "failed", finishedAt: t(0) }), job("c", { status: "failed", finishedAt: t(0) })],
  })!;
  assert.deepEqual(
    split.map((s) => s.allocatedUsd),
    [0.0334, 0.0333, 0.0333]
  );
  assert.ok(split.every((s) => s.basis === "estimated"));
});

test("a session with an unfinished job is not split yet", () => {
  assert.equal(splitSessionCost({ chargeUsd: 1, costPerHr: null, jobs: [job("a", { status: "generating", startedAt: t(0) })] }), null);
});

test("a session without jobs has nothing to split (it stays a session-level line)", () => {
  assert.deepEqual(splitSessionCost({ chargeUsd: 1, costPerHr: null, jobs: [] }), []);
});

test("splitEndedSessionCosts stores each job's share with the charge it was split from, and leaves a running session for later", async () => {
  const stored: Array<[string, unknown]> = [];
  const n = await (await import("./cost-split")).splitEndedSessionCosts({
    pending: async () => [
      { session: { id: "s1", usdCharged: 1, costPerHr: 3.6 }, jobs: [job("a", { startedAt: t(0), gpuFinishedAt: t(60) }), job("b", { startedAt: t(60), gpuFinishedAt: t(90) })] },
      { session: { id: "s2", usdCharged: 2, costPerHr: 3.6 }, jobs: [job("c", { status: "generating", startedAt: t(0) })] },
    ],
    store: async (id, share) => {
      stored.push([id, share]);
    },
  });
  assert.equal(n, 1);
  assert.deepEqual(stored, [
    ["a", { gpuSeconds: 60, allocatedUsd: 0.6667, overheadUsd: 0.6067, allocationBasis: "measured", allocationSessionUsd: 1 }],
    ["b", { gpuSeconds: 30, allocatedUsd: 0.3333, overheadUsd: 0.3033, allocationBasis: "measured", allocationSessionUsd: 1 }],
  ]);
});
