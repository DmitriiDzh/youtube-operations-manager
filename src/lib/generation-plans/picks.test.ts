import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationPlansReport, SharedClaim, SharedGroupNote, SharedPickAction, SharedVerdict } from "@/lib/sync-gateway";
import { isDomainError, mediaKindOf, pickTargetOf, type PlanEvent, type PlanPickRecord, type PlanRecheck, type PlanResultRow, type PlanVerdictHistoryRow } from "./contracts";
import type { PlanJobRow } from "./progress";
import { createGenerationPlanServices, type PlanStore, type StoredPlan } from "./services";

// BL-175 acceptance criteria AC-VR-01..09 (docs/roadmap/plans/VISUAL_REVIEW_PLAN.md §3), written from the plan and FO-REQ-0018
// before the code was run. Every expected number is worked out by hand from the plan's rules (§2.2/§2.3), never copied from a run.

function memoryStore(jobs: Array<PlanJobRow & { planId: string | null }> = []) {
  const plans = new Map<string, StoredPlan>();
  const results = new Map<string, PlanResultRow & { planId: string }>();
  const events: Array<PlanEvent & { planId: string }> = [];
  const history: Array<PlanVerdictHistoryRow & { planId: string }> = [];
  const rechecks: Array<PlanRecheck & { planId: string }> = [];
  const picks: Array<PlanPickRecord & { planId: string }> = [];
  const peerVerdicts: SharedVerdict[] = [];
  const peerNotes: SharedGroupNote[] = [];
  const peerPicks: SharedPickAction[] = [];
  const claims = new Map<string, SharedClaim>();
  const strip = <T extends { planId: string | null }>(row: T): Omit<T, "planId"> => {
    const { planId: _p, ...rest } = structuredClone(row);
    void _p;
    return rest;
  };
  const store: PlanStore = {
    async insertPlan(row) {
      if (plans.has(row.id)) return null;
      plans.set(row.id, structuredClone(row));
      return structuredClone(row);
    },
    getPlan: async (id) => (plans.has(id) ? structuredClone(plans.get(id)!) : null),
    listPlans: async (filter) => [...plans.values()].filter((p) => !filter.status || p.status === filter.status).map((p) => structuredClone(p)),
    async updatePlan(id, expected, set) {
      const row = plans.get(id);
      if (!row || row.revision !== expected) return null;
      const next = { ...row, ...structuredClone(set), revision: expected + 1 } as StoredPlan;
      plans.set(id, next);
      return structuredClone(next);
    },
    async upsertResults(planId, rows) {
      for (const r of rows) results.set(`${planId}|${r.stageId}|${r.itemKey}|${r.attemptRef}`, { ...structuredClone(r), planId });
    },
    listResults: async (planId) => [...results.values()].filter((r) => r.planId === planId).map(strip),
    async insertEvent(planId, event) {
      events.push({ ...structuredClone(event), planId });
    },
    listEvents: async (planId) => events.filter((e) => e.planId === planId).map(strip),
    listJobs: async (planId) => jobs.filter((j) => j.planId === planId).map(strip),
    linkJob: async () => false,
    listSessions: async () => [],
    async insertPeerVerdict(v) {
      peerVerdicts.push(structuredClone(v));
    },
    listPeerVerdicts: async () => peerVerdicts.map((v) => structuredClone(v)),
    async insertPeerGroupNote(n) {
      peerNotes.push(structuredClone(n));
    },
    listPeerGroupNotes: async () => peerNotes.map((n) => structuredClone(n)),
    async insertVerdictHistory(planId, row) {
      history.push({ ...structuredClone(row), planId });
    },
    listVerdictHistory: async (planId) => history.filter((h) => h.planId === planId).map(strip),
    async insertRecheck(planId, r) {
      if (rechecks.some((x) => x.planId === planId && x.recheckId === r.recheckId)) return false;
      rechecks.push({ ...structuredClone(r), planId });
      return true;
    },
    listRechecks: async (planId) => rechecks.filter((r) => r.planId === planId).map(strip),
    async closeRecheck(planId, recheckId, set) {
      const r = rechecks.find((x) => x.planId === planId && x.recheckId === recheckId);
      if (!r || r.status !== "open") return false;
      Object.assign(r, { status: set.status, closedAt: set.closedAt, answer: set.answer ?? null, withdrawNote: set.withdrawNote ?? null, closeReason: set.closeReason ?? null });
      return true;
    },
    replaceRecheckAnswer: async () => false,
    async upsertClaim(c) {
      claims.set(c.claimId, structuredClone(c));
    },
    async deleteClaim(id) {
      claims.delete(id);
    },
    listClaims: async () => [...claims.values()],
    listPicks: async (planId) => picks.filter((r) => r.planId === planId).map(strip),
    async upsertPicks(planId, records) {
      for (const r of records) {
        const i = picks.findIndex((x) => x.planId === planId && x.itemKey === r.itemKey && x.kind === r.kind && (x.attemptRef ?? "") === (r.attemptRef ?? ""));
        if (i >= 0) picks.splice(i, 1);
        picks.push({ ...structuredClone(r), planId });
      }
    },
    async insertPeerPick(a) {
      peerPicks.push(structuredClone(a));
    },
    listPeerPicks: async () => peerPicks.map((a) => structuredClone(a)),
  };
  return { store, results, events, history, picks, peerPicks, peerVerdicts };
}

const CHANNEL = "UC_visual";
const PLAN = "H-0004-C";
let clockMs = Date.parse("2026-10-11T12:00:00.000Z");
const tick = (ms = 1000) => (clockMs += ms);

function setup(jobs: Array<PlanJobRow & { planId: string | null }> = [], opts: { peers?: () => GenerationPlansReport[]; deviceId?: string; label?: string } = {}) {
  const mem = memoryStore(jobs);
  let ids = 0;
  const services = createGenerationPlanServices({
    store: mem.store,
    channels: { isConnected: async (id) => id === CHANNEL },
    clock: { now: () => new Date(clockMs) },
    deviceLabel: async () => opts.label ?? "Mac",
    generateId: () => `id-${String(++ids).padStart(6, "0")}`,
    ...(opts.peers ? { peers: { ownDeviceId: async () => opts.deviceId ?? "mac-id", listPeerReports: async () => opts.peers!() } } : {}),
  });
  return { ...mem, services };
}

const refs = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `a${i + from}`);

/** A visual plan: an external `render` stage, then the owner's review; item I with `n` external attempts reported done with PNGs. */
async function visualPlan(item: { mode?: "fixed" | "until_accepted"; targetCount: number; pickTarget?: number }, n = 8) {
  const s = setup();
  await s.services.createPlan({
    planId: PLAN,
    title: "Plan C stills",
    channelId: CHANNEL,
    stages: [
      { stageId: "render", title: "Render", kind: "external" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
    ],
    groups: [{ groupId: "W1", title: "Stills" }],
    items: [{ itemKey: "W1/I", groupId: "W1", targetCount: item.targetCount, ...(item.mode ? { mode: item.mode } : {}), ...(item.pickTarget ? { pickTarget: item.pickTarget } : {}) }],
  });
  await s.services.report({ planId: PLAN, rows: refs(n).map((a) => ({ stageId: "render", itemKey: "W1/I", attemptRef: a, result: "done", auditionFile: `H-0004/planC/${a}.png` })) });
  return s;
}

const itemOf = async (s: ReturnType<typeof setup>) => (await s.services.getPlan({ planId: PLAN })).progress.items[0];
const kinds = (s: ReturnType<typeof setup>, ...list: string[]) => s.events.filter((e) => list.includes(e.kind)).map((e) => [e.kind, e.details]);

test("AC-VR-01: the media kind follows the file's extension (the player's list); anything else is null", () => {
  assert.equal(mediaKindOf("H-0004/a1.png"), "image");
  assert.equal(mediaKindOf("x/A.JPG"), "image");
  assert.equal(mediaKindOf("loop2/clip.mp4"), "video");
  assert.equal(mediaKindOf("c.webm"), "video");
  assert.equal(mediaKindOf("C14_V04.mp3"), "audio");
  assert.equal(mediaKindOf("notes.txt"), null);
  assert.equal(mediaKindOf(null), null);
});

test("AC-VR-01: an entry shows its reported file's kind; a job attempt shows its output's kind", async () => {
  const s = await visualPlan({ targetCount: 1 }, 2);
  const queue = await s.services.reviewQueue({ planId: PLAN });
  assert.deepEqual(queue.entries.map((e) => e.media), ["image", "image"]);
  const job = { id: "j1", sessionId: "s1", channelId: CHANNEL, stageId: "gen", itemKey: "M/1", seed: 1, status: "done" as const, error: null, createdAt: new Date(clockMs), submittedAt: null, finishedAt: new Date(clockMs), outputFile: "clip_00001.mp4", planId: "P-video" };
  const v = setup([job]);
  await v.services.createPlan({ planId: "P-video", title: "Loops", channelId: CHANNEL, stages: [{ stageId: "gen", title: "Gen", kind: "in_app" }, { stageId: "owner_review", title: "Review", kind: "owner_review" }], items: [{ itemKey: "M/1", targetCount: 1 }] });
  assert.deepEqual((await v.services.reviewQueue({ planId: "P-video" })).entries.map((e) => [e.attemptRef, e.media]), [["job:j1", "video"]]);
});

test("AC-VR-02: the pick target -- fixed 8 → 1, until_accepted 2 → 2, pickTarget 3 → 3; outside 1..targetCount is refused", async () => {
  assert.equal(pickTargetOf({ mode: "fixed", targetCount: 8 }), 1);
  assert.equal(pickTargetOf({ mode: "until_accepted", targetCount: 2 }), 2);
  assert.equal(pickTargetOf({ mode: "fixed", targetCount: 8, pickTarget: 3 }), 3);
  const s = setup();
  const base = { planId: "P2", title: "t", channelId: CHANNEL, stages: [{ stageId: "owner_review", title: "R", kind: "owner_review" }] };
  await assert.rejects(s.services.createPlan({ ...base, items: [{ itemKey: "I", targetCount: 2, pickTarget: 3 }] }), (e: unknown) => isDomainError(e) && e.code === "plan_invalid");
  await assert.rejects(s.services.createPlan({ ...base, items: [{ itemKey: "I", targetCount: 2, pickTarget: 0 }] }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  const ok = await s.services.createPlan({ ...base, items: [{ itemKey: "I", targetCount: 4, pickTarget: 2 }] });
  assert.equal(ok.progress.items[0].pickTarget, 2);
});

test("AC-VR-03: a fixed item with 8 external attempts -- one pick decides it: accepted 1, notChosen 7, nothing waits; group_reviewed once", async () => {
  const s = await visualPlan({ targetCount: 1 });
  const before = await itemOf(s);
  assert.deepEqual(
    [before.attempts, before.accepted, before.waitingReview, before.missing, before.pickTarget],
    [8, 0, 8, 0, 1],
    "external attempts count as attempts; 8 usable ≥ target 1"
  );
  tick();
  const answer = await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" });
  assert.equal(answer.outcome, "applied");
  const after = await itemOf(s);
  assert.deepEqual(
    { accepted: after.accepted, notChosen: after.notChosen, rejected: after.rejected, waitingReview: after.waitingReview, missing: after.missing, picks: after.picks.map((p) => p.attemptRef) },
    { accepted: 1, notChosen: 7, rejected: 0, waitingReview: 0, missing: 0, picks: ["a3"] }
  );
  assert.deepEqual((await s.services.todo({ planId: PLAN })).waitingReview, []);
  const plan = await s.services.getPlan({ planId: PLAN });
  assert.deepEqual(plan.progress.groups[0].counts.picked, 1);
  // The owner-review stage counts the pick as its acceptance (no row was written).
  assert.equal(plan.progress.stages.find((st) => st.stageId === "owner_review")?.counts.accepted, 1);
  assert.equal(s.results.size, 8, "a pick writes no result row");
  assert.equal(s.history.length, 0, "a pick is not a verdict: no verdict history");
  assert.deepEqual(kinds(s, "owner_pick", "group_reviewed"), [
    ["owner_pick", { itemKey: "W1/I", attemptRef: "a3", device: "Mac" }],
    ["group_reviewed", { groupId: "W1", accepted: 0, rejected: 0, overridesValidator: 0, picked: 1, noneFits: 0 }],
  ]);
  // The queue: a3 picked, the other seven not chosen -- none waits.
  const queue = (await s.services.reviewQueue({ planId: PLAN })).entries;
  assert.deepEqual(queue.filter((e) => e.picked).map((e) => [e.attemptRef, e.picked?.device]), [["a3", "Mac"]]);
  assert.equal(queue.filter((e) => e.notChosen).length, 7);
  assert.equal((await s.services.summary()).waitingReview, 0);
  // The same pick again changes nothing.
  tick();
  assert.equal((await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" })).outcome, "unchanged");
  assert.equal(s.events.filter((e) => e.kind === "group_reviewed").length, 1);
});

test("AC-VR-04: until_accepted with targetCount 2 -- one pick does not decide it: accepted 1, 7 still waiting, missing 0", async () => {
  const s = await visualPlan({ mode: "until_accepted", targetCount: 2 });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "pick" });
  const item = await itemOf(s);
  assert.deepEqual([item.accepted, item.waitingReview, item.notChosen, item.pending, item.missing], [1, 7, 0, 7, 0]);
  assert.equal(s.events.filter((e) => e.kind === "group_reviewed").length, 0);
});

test("AC-VR-05: with a target of 1 the pick moves; rejecting the picked attempt withdraws its pick; a rejected attempt cannot be picked", async () => {
  const s = await visualPlan({ targetCount: 1 });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a5", action: "pick", note: "очки на лице" });
  assert.deepEqual((await itemOf(s)).picks.map((p) => [p.attemptRef, p.note]), [["a5", "очки на лице"]]);
  assert.deepEqual(kinds(s, "owner_unpick"), [["owner_unpick", { itemKey: "W1/I", attemptRef: "a3", device: "Mac", reason: "moved" }]]);
  tick();
  await s.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a5", result: "rejected", reasons: ["extra object"] });
  const item = await itemOf(s);
  assert.deepEqual([item.picks.length, item.accepted, item.rejected, item.waitingReview, item.notChosen], [0, 0, 1, 7, 0], "undecided again: the other seven wait");
  assert.deepEqual(kinds(s, "owner_unpick").at(-1), ["owner_unpick", { itemKey: "W1/I", attemptRef: "a5", device: "Mac", reason: "rejected" }]);
  tick();
  await assert.rejects(
    s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a5", action: "pick" }),
    (e: unknown) => isDomainError(e) && e.code === "plan_mismatch" && (e.details as { reason?: string }).reason === "rejected"
  );
  await assert.rejects(
    s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "zz", action: "pick" }),
    (e: unknown) => isDomainError(e) && e.code === "plan_mismatch" && (e.details as { reason?: string }).reason === "unknown_attempt"
  );
  // Unpick: the pick is withdrawn, the attempts wait again.
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a2", action: "pick" });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a2", action: "unpick" });
  assert.deepEqual([(await itemOf(s)).picks.length, (await itemOf(s)).waitingReview], [0, 7]);
});

test("AC-VR-06: none fits covers the attempts there now -- nothing waits; a 9th attempt reported later waits; a pick clears it", async () => {
  const s = await visualPlan({ targetCount: 1 });
  await assert.rejects(s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", action: "none_fits" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed", "a note is required");
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", action: "none_fits", note: "лишний фонарь в руках у всех" });
  let item = await itemOf(s);
  assert.deepEqual([item.waitingReview, item.notChosen, item.accepted, item.noneFits?.attempts, item.noneFits?.note], [0, 8, 0, 8, "лишний фонарь в руках у всех"]);
  assert.deepEqual(kinds(s, "owner_none_fits"), [["owner_none_fits", { itemKey: "W1/I", device: "Mac", note: "лишний фонарь в руках у всех", attempts: 8 }]]);
  assert.equal((await s.services.getPlan({ planId: PLAN })).progress.groups[0].counts.noneFits, 1);
  tick();
  await s.services.report({ planId: PLAN, rows: [{ stageId: "render", itemKey: "W1/I", attemptRef: "a9", result: "done", auditionFile: "H-0004/planC/a9.png" }] });
  item = await itemOf(s);
  assert.deepEqual([item.attempts, item.waitingReview, item.notChosen], [9, 1, 8], "the new attempt waits");
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a9", action: "pick" });
  item = await itemOf(s);
  assert.deepEqual([item.noneFits, item.picks.map((p) => p.attemptRef), item.waitingReview, item.notChosen], [null, ["a9"], 0, 8]);
  assert.deepEqual(kinds(s, "owner_none_fits").at(-1), ["owner_none_fits", { itemKey: "W1/I", device: "Mac", cleared: true }]);
});

test("AC-VR-07: a music-shaped plan (only app jobs, no picks) gives exactly the numbers of the rules before BL-175", async () => {
  const job = (id: string, itemKey: string, status: PlanJobRow["status"], error: string | null = null) => ({
    id,
    sessionId: "s1",
    channelId: CHANNEL,
    stageId: "generate",
    itemKey,
    seed: Number(id.slice(1)),
    status,
    error,
    createdAt: new Date("2026-10-11T10:00:00Z"),
    submittedAt: null,
    finishedAt: status === "done" || status === "failed" ? new Date("2026-10-11T10:05:00Z") : null,
    outputFile: `${id}.mp3`,
    planId: "R-music",
  });
  const s = setup([job("j1", "I1", "done"), job("j2", "I1", "done"), job("j3", "I1", "failed", "boom"), job("j4", "I2", "done"), job("j5", "I2", "generating")]);
  await s.services.createPlan({
    planId: "R-music",
    title: "music",
    channelId: CHANNEL,
    stages: [
      { stageId: "generate", title: "Generate", kind: "in_app" },
      { stageId: "validate", title: "Validator", kind: "external" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
    ],
    groups: [{ groupId: "C1" }],
    items: [
      { itemKey: "I1", groupId: "C1", targetCount: 2 },
      { itemKey: "I2", groupId: "C1", targetCount: 1, mode: "until_accepted", maxAttempts: 3 },
    ],
  });
  await s.services.report({
    planId: "R-music",
    rows: [
      { stageId: "validate", itemKey: "I1", attemptRef: "job:j1", result: "accepted" },
      { stageId: "validate", itemKey: "I1", attemptRef: "job:j2", result: "rejected" },
      { stageId: "validate", itemKey: "I2", attemptRef: "job:j4", result: "accepted" },
    ],
  });
  await s.services.recordOwnerVerdict({ planId: "R-music", itemKey: "I1", attemptRef: "job:j1", result: "accepted", rating: 8 });
  const { progress } = await s.services.getPlan({ planId: "R-music" });
  const pick = (i: (typeof progress.items)[number]) => [i.attempts, i.generated, i.accepted, i.rejected, i.open, i.waitingReview, i.pending, i.missing, i.pickTarget, i.picks.length, i.noneFits, i.notChosen];
  // I1 (fixed, 2): j1 accepted by the owner, j2 rejected by the validator, j3 failed; 2 usable -> missing 0.
  // I2 (until_accepted, 1, max 3): j4 passed and waits, j5 running; 0 accepted + 2 pending -> missing min(0, 3-2) = 0.
  assert.deepEqual(progress.items.map(pick), [
    [3, 2, 1, 0, 0, 0, 0, 0, 1, 0, null, 0],
    [2, 1, 0, 0, 1, 1, 2, 0, 1, 0, null, 0],
  ]);
  assert.deepEqual(progress.stages.map((st) => [st.stageId, st.counts.planned, st.counts.running, st.counts.done, st.counts.failed, st.counts.accepted, st.counts.rejected]), [
    ["generate", 3, 1, 3, 1, 0, 0],
    ["validate", 3, 0, 0, 0, 2, 1],
    ["owner_review", 3, 0, 0, 0, 1, 0],
  ]);
  assert.deepEqual(progress.groups[0].counts, { items: 2, generated: 3, accepted: 1, rejected: 0, waitingReview: 1, missing: 0, rechecks: 0, picked: 0, noneFits: 0 });
  assert.deepEqual(progress.notices, [
    { kind: "stage_complete", stageId: "generate", title: "Generate" },
    { kind: "review_waiting", count: 1, passed: 1, rejected: 0 },
  ]);
  const todo = await s.services.todo({ planId: "R-music" });
  assert.deepEqual([todo.short, todo.waitingReview, todo.rerun], [[], [{ itemKey: "I2", attemptRef: "job:j4", validator: "passed" }], []]);
  const queue = (await s.services.reviewQueue({ planId: "R-music" })).entries;
  assert.deepEqual(queue.map((e) => [e.attemptRef, e.verdict?.result ?? null, e.media, "picked" in e, "notChosen" in e]), [
    ["job:j4", null, "audio", false, false],
    ["job:j1", "accepted", "audio", false, false],
  ]);
});

test("AC-VR-08: a pin with its note survives the verdict, its history, owner_verdict, the queue and a re-check's previous verdict; without one there is no region key", async () => {
  const s = await visualPlan({ targetCount: 1 }, 2);
  const region = { x: 0.25, y: 0.5, r: 0.1 };
  tick();
  await s.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", result: "rejected", reasons: ["extra object"], markers: [{ start: 0, end: null, note: "фонарь в руках", region }] });
  const marker = { start: 0, end: null, note: "фонарь в руках", region };
  assert.deepEqual([...s.results.values()].find((r) => r.attemptRef === "a1" && r.stageId === "owner_review")?.markers, [marker]);
  assert.deepEqual(s.history[0].markers, [marker]);
  const verdictEvent = (await s.services.getPlan({ planId: PLAN, latest: true })).events.find((e) => e.kind === "owner_verdict");
  assert.deepEqual(verdictEvent?.details.markers, [marker]);
  const entry = (await s.services.reviewQueue({ planId: PLAN })).entries.find((e) => e.attemptRef === "a1");
  assert.deepEqual(entry?.verdict?.markers, [marker]);
  tick();
  const { recheck } = await s.services.requestRecheck({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", recheckId: "q1", kind: "question", title: "фонарь", note: "это фонарь?", markers: [{ start: 0, region: { x: 0.3, y: 0.4, r: 0.05 } }] });
  assert.deepEqual(recheck.previousVerdict?.markers, [marker]);
  assert.deepEqual(recheck.markers, [{ start: 0, end: null, note: null, region: { x: 0.3, y: 0.4, r: 0.05 } }]);
  tick();
  await s.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a2", result: "accepted", markers: [{ start: 1.5, end: 2 }] });
  const plain = [...s.results.values()].find((r) => r.attemptRef === "a2" && r.stageId === "owner_review")?.markers[0];
  assert.deepEqual(plain, { start: 1.5, end: 2, note: null });
  assert.equal(Object.hasOwn(plain ?? {}, "region"), false);
  for (const bad of [{ x: 1.2, y: 0.5, r: 0.1 }, { x: 0.5, y: -0.1, r: 0.1 }, { x: 0.5, y: 0.5, r: 0 }]) {
    await assert.rejects(
      s.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a2", result: "accepted", replace: true, markers: [{ start: 0, region: bad }] }),
      (e: unknown) => isDomainError(e) && e.code === "validation_failed"
    );
  }
});

test("AC-VR-09: the plan's and a wave's own reason chips are stored and returned (the wave's win on screen); too many or too long is refused", async () => {
  const s = setup();
  const chips = ["лишний предмет", "лестница кривая"];
  await s.services.createPlan({
    planId: PLAN,
    title: "t",
    channelId: CHANNEL,
    stages: [{ stageId: "owner_review", title: "R", kind: "owner_review" }],
    groups: [{ groupId: "W1", reviewReasons: ["шов петли"] }, { groupId: "W2" }],
    items: [],
    reviewReasons: chips,
  });
  let reasons = (await s.services.reviewQueue({ planId: PLAN })).reviewReasons;
  assert.deepEqual([reasons.plan, { ...reasons.groups }], [chips, { W1: ["шов петли"] }]);
  await s.services.updatePlan({ planId: PLAN, upsertGroups: [{ groupId: "W2", reviewReasons: ["мерцание"] }, { groupId: "W1", reviewReasons: null }], reviewReasons: null });
  reasons = (await s.services.reviewQueue({ planId: PLAN })).reviewReasons;
  assert.deepEqual([reasons.plan, { ...reasons.groups }], [null, { W2: ["мерцание"] }]);
  const tooMany = Array.from({ length: 21 }, (_, i) => `r${i}`);
  await assert.rejects(s.services.updatePlan({ planId: PLAN, reviewReasons: tooMany }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(s.services.updatePlan({ planId: PLAN, reviewReasons: ["x".repeat(61)] }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(s.services.updatePlan({ planId: PLAN, reviewReasons: ["a", "a"] }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
});
