import assert from "node:assert/strict";
import test from "node:test";
import type { SharedPlan } from "@/lib/sync-gateway";
import { peerPlanModel, sharedProgress, waveRows } from "./plan-card-model";

// BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.1, FO-REQ-0013): another device's plan shown with the same card -- from that device's
// report, where `progress` is a loose record an older build may have written with fewer fields.

const device = { deviceId: "win-1", hostname: "PC", updatedAt: "2026-10-09T10:00:00.000Z", stale: false };

/** A report's plan as a version 1 build wrote it: no `batches`, no review `history`, a `progress` without spend or eta. */
function v1Plan(over: Partial<SharedPlan> = {}): SharedPlan {
  return {
    planId: "R-0001",
    title: "Stage 1",
    channelId: "UC_x",
    owner: "factory",
    status: "active",
    budget: { usd: 5, gpuMinutes: null },
    note: null,
    createdAt: "2026-10-07T12:54:00.000Z",
    updatedAt: "2026-10-09T09:00:00.000Z",
    closedAt: null,
    stages: [{ stageId: "generate", title: "Generate", kind: "in_app" }],
    groups: [
      { groupId: "C1", title: "C1", dependsOn: null, note: null },
      { groupId: "C2", title: "C2 recipe", dependsOn: "C1", note: "factory context", ownerNote: "too thin" },
    ],
    items: [],
    references: [],
    itemParams: {},
    progress: {
      stages: [{ stageId: "generate", title: "Generate", kind: "in_app", counts: { planned: 10, done: 4 } }, { stageId: "bad", kind: "nonsense" }],
      groups: [{ groupId: "C2", title: "C2 recipe", counts: { items: 3, generated: 6, accepted: 1, waitingReview: 2 } }],
      notices: [{ kind: "budget_80" }, { kind: "review_waiting", count: 99 }],
    },
    events: [{ at: "2026-10-09T09:00:00.000Z", kind: "job_done", actor: "factory", details: { itemKey: "C2/V1" } }],
    review: [
      { itemKey: "C2/V1", groupId: "C2", attemptRef: "job:a", jobId: "a", seed: 1, stages: [], verdict: null, params: {}, playable: true, jobOutput: null, auditionFile: null },
      { itemKey: "C2/V1", groupId: "C2", attemptRef: "job:b", jobId: "b", seed: 2, stages: [], verdict: null, params: {}, playable: true, jobOutput: null, auditionFile: null },
      { itemKey: "C2/V2", groupId: "C2", attemptRef: "job:c", jobId: "c", seed: 3, stages: [], verdict: null, params: {}, playable: true, jobOutput: null, auditionFile: null },
    ],
    ...over,
  } as unknown as SharedPlan;
}

test("BL-162 §5.1: a missing or malformed progress field reads as empty or zero, never a crash", () => {
  const p = sharedProgress({ stages: "x", groups: [null, 3, { groupId: "C1" }], spend: { usd: "1" }, budget: { warnings: ["80", "90", 100] } });
  assert.deepEqual(p.stages, []);
  assert.deepEqual(p.groups, [{ groupId: "C1", title: "C1", counts: { items: 0, generated: 0, accepted: 0, rejected: 0, waitingReview: 0, missing: 0 } }]);
  assert.deepEqual(p.spend, { usd: 0, gpuMinutes: 0, sessions: [] });
  assert.deepEqual(p.budget, { usd: null, usedShare: null, warnings: ["80"] });
  assert.deepEqual(p.eta, { seconds: null, gpuTypeId: null, samples: 0 });
  assert.deepEqual(p.items, []);
  assert.deepEqual(sharedProgress({}).notices, []);
});

test("BL-162 AC-UX-14: another device's version 1 plan gives the card's model -- stages, waves, events, the device", () => {
  const m = peerPlanModel(v1Plan(), device, []);
  assert.equal(m.planId, "R-0001");
  assert.equal(m.device, device);
  assert.equal(m.reviewRejected, null, "not known on this computer");
  // The unknown stage kind is left out; the known one keeps its counts, the missing ones read 0.
  assert.deepEqual(
    m.progress.stages.map((s) => [s.stageId, s.counts.planned, s.counts.done, s.counts.accepted]),
    [["generate", 10, 4, 0]]
  );
  assert.deepEqual(m.groups[1], { groupId: "C2", title: "C2 recipe", dependsOn: "C1", note: "factory context", ownerNote: "too thin" });
  assert.equal(m.groups[0].ownerNote, null, "a version 1 group has no ownerNote");
  assert.equal(m.events.length, 1);
});

test("BL-162: the waiting count is the entries without a verdict, less the verdicts this computer already sent there", () => {
  const sent = [
    { ownerDeviceId: "win-1", planId: "R-0001", itemKey: "C2/V1", attemptRef: "job:a" },
    // Another device's or another plan's sent verdict does not count here.
    { ownerDeviceId: "mac", planId: "R-0001", itemKey: "C2/V1", attemptRef: "job:b" },
    { ownerDeviceId: "win-1", planId: "R-0002", itemKey: "C2/V2", attemptRef: "job:c" },
  ];
  const m = peerPlanModel(v1Plan(), device, sent);
  assert.equal(m.waiting, 2);
  // The report's own review_waiting notice is not taken; this computer's count is, with the budget notice kept.
  assert.deepEqual(m.progress.notices, [{ kind: "budget_80" }, { kind: "review_waiting", count: 2, passed: 2, rejected: 0 }]);
  assert.deepEqual(peerPlanModel(v1Plan({ review: [] }), device, []).progress.notices, [{ kind: "budget_80" }], "nothing waits: no review notice");
});

test("BL-162 AC-UX-10: waves newest first; shown are the waves with tracks waiting plus the newest, the rest folded", () => {
  const counts = (waitingReview: number) => ({ items: 1, generated: 1, accepted: 0, rejected: 0, waitingReview, missing: 0 });
  const model = {
    groups: ["C1", "C2", "C3", "C4"].map((groupId) => ({ groupId, title: groupId, dependsOn: null, note: null, ownerNote: null })),
    progress: { ...sharedProgress({}), groups: [{ groupId: "C1", title: "C1", counts: counts(0) }, { groupId: "C2", title: "C2", counts: counts(3) }, { groupId: "C4", title: "C4", counts: counts(0) }] },
  };
  // C4 is the newest (shown though nothing waits), C2 waits; C3 has no progress yet and C1 waits for nothing: folded.
  const folded = waveRows(model, false);
  assert.deepEqual(folded.shown.map((w) => w.groupId), ["C4", "C2"]);
  assert.equal(folded.folded, 2);
  assert.equal(folded.shown[0].counts?.waitingReview, 0);
  const all = waveRows(model, true);
  assert.deepEqual(all.shown.map((w) => w.groupId), ["C4", "C3", "C2", "C1"]);
  assert.equal(all.folded, 0);
  assert.equal(all.shown[1].counts, null, "a wave with no progress row yet");
  assert.deepEqual(waveRows({ groups: [], progress: sharedProgress({}) }, false), { shown: [], folded: 0 });
});
