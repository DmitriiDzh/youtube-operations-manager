import assert from "node:assert/strict";
import test from "node:test";
import { generationPlansReportSchema, type GenerationPlansReport, type SharedClaim, type SharedGroupNote, type SharedPickAction, type SharedVerdict } from "@/lib/sync-gateway";
import { isDomainError, mediaKindOf, pickTargetOf, type PlanEvent, type PlanPickRecord, type PlanRecheck, type PlanResultRow, type PlanVerdictHistoryRow } from "./contracts";
import { applyPickAction, pickFlagsOf, pickStateOf, withSentPicks } from "./picks";
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

function setup(jobs: Array<PlanJobRow & { planId: string | null }> = [], opts: { peers?: () => GenerationPlansReport[]; deviceId?: string; label?: string; files?: { workspaceOf(channelId: string): Promise<string | null>; sentFileExists(workspace: string, relativePath: string): Promise<boolean> } } = {}) {
  const mem = memoryStore(jobs);
  let ids = 0;
  const services = createGenerationPlanServices({
    store: mem.store,
    channels: { isConnected: async (id) => id === CHANNEL },
    clock: { now: () => new Date(clockMs) },
    deviceLabel: async () => opts.label ?? "Mac",
    generateId: () => `id-${String(++ids).padStart(6, "0")}`,
    ...(opts.peers ? { peers: { ownDeviceId: async () => opts.deviceId ?? "mac-id", listPeerReports: async () => opts.peers!() } } : {}),
    ...(opts.files ? { files: opts.files } : {}),
  });
  return { ...mem, services };
}

const refs = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `a${i + from}`);

/** A visual plan: an external `render` stage, then the owner's review; item I with `n` external attempts reported done with PNGs. */
async function visualPlan(item: { mode?: "fixed" | "until_accepted"; targetCount: number; pickTarget?: number }, n = 8, opts: Parameters<typeof setup>[1] = {}) {
  const s = setup([], opts);
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

// -- AC-VR-10/11 (two computers) ---------------------------------------------------------------------------------------------

/** A computer's plans report, validated as the other computer reads it. */
async function reportOf(s: ReturnType<typeof setup>, deviceId: string, hostname: string, version = 5): Promise<GenerationPlansReport> {
  return generationPlansReportSchema.parse({
    format: "ytm-generation-plans",
    version,
    deviceId,
    hostname,
    updatedAt: new Date(clockMs).toISOString(),
    plans: await s.services.buildSharedPlans(),
    verdicts: await s.services.outgoingVerdicts(),
    claims: [],
    groupNotes: await s.services.outgoingGroupNotes(),
    picks: await s.services.outgoingPicks(),
  });
}

/** The Mac owns the visual plan (8 attempts, target 1); Windows reads the Mac's report and the Mac reads Windows'. */
async function twoComputers(macVersion = 5) {
  let macReport: GenerationPlansReport | null = null;
  let winReport: GenerationPlansReport | null = null;
  const mac = await visualPlan({ targetCount: 1 }, 8, { deviceId: "mac-id", label: "MAC", peers: () => (winReport ? [winReport] : []) });
  const win = setup([], { deviceId: "win-id", label: "WIN", peers: () => (macReport ? [macReport] : []) });
  const sync = async () => {
    macReport = await reportOf(mac, "mac-id", "MAC", macVersion);
    winReport = await reportOf(win, "win-id", "WIN");
  };
  await sync();
  return { mac, win, sync, macPlan: () => macReport!.plans[0] };
}

test("AC-VR-10: a version 5 report with picks, none-fits, handled ids, pick targets, reason lists and pins parses; version 4 still parses; 6 is refused", async () => {
  const { mac, win, sync, macPlan } = await twoComputers();
  await mac.services.updatePlan({ planId: PLAN, reviewReasons: ["лишний предмет"], upsertGroups: [{ groupId: "W1", reviewReasons: ["лестница"] }] });
  tick();
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a2", action: "pick" });
  tick();
  await mac.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", result: "rejected", markers: [{ start: 0, note: "фонарь", region: { x: 0.5, y: 0.5, r: 0.2 } }] });
  await sync();
  const plan = macPlan();
  assert.deepEqual([plan.reviewReasons, plan.groups[0].reviewReasons, plan.items[0].pickTarget], [["лишний предмет"], ["лестница"], 1]);
  assert.deepEqual(plan.picks?.map((p) => [p.itemKey, p.attemptRef, p.device]), [["W1/I", "a2", "MAC"]]);
  assert.deepEqual(plan.noneFits, []);
  assert.deepEqual(plan.handledPicks, []);
  const a1 = plan.review.find((e) => e.attemptRef === "a1");
  assert.deepEqual(a1?.verdict?.markers, [{ start: 0, end: null, note: "фонарь", region: { x: 0.5, y: 0.5, r: 0.2 } }]);
  assert.equal(plan.review.find((e) => e.attemptRef === "a2")?.picked?.device, "MAC");
  assert.equal(plan.review.filter((e) => e.notChosen).length, 6, "8 attempts: a2 picked, a1 rated, 6 not chosen");
  assert.equal(Object.hasOwn(plan.review[0], "media"), false, "the reader derives media itself");
  const report = await reportOf(mac, "mac-id", "MAC");
  assert.equal(generationPlansReportSchema.safeParse({ ...report, version: 4 }).success, true);
  assert.equal(generationPlansReportSchema.safeParse({ ...report, version: 6 }).success, false);
  void win;
});

test("AC-VR-11: a pick given on Windows -- stored and carried there, counted on the Mac before its tick, applied once, then shown as applied", async () => {
  const { mac, win, sync, macPlan } = await twoComputers();
  tick();
  const sent = await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick", note: "стройная" });
  assert.deepEqual([sent.action, sent.ownerDeviceId, sent.attemptRef, sent.note], ["pick", "mac-id", "a3", "стройная"]);
  assert.equal((await win.services.outgoingPicks()).length, 1);
  // Windows: its own pick settles the item at once in its view and badge.
  const overlaid = withSentPicks(macPlan(), macPlan().review, await win.services.outgoingPicks(), "WIN");
  assert.deepEqual(overlaid.filter((e) => e.picked).map((e) => [e.attemptRef, e.pickSent]), [["a3", true]]);
  assert.equal(overlaid.filter((e) => e.notChosen).length, 7);
  assert.equal((await win.services.summary()).otherDevices, 0);
  await sync();
  // The Mac before its tick: the pick on its way already counts (queue, progress, badge).
  const queue = (await mac.services.reviewQueue({ planId: PLAN })).entries;
  assert.deepEqual(queue.filter((e) => e.picked).map((e) => [e.attemptRef, e.picked?.device]), [["a3", "WIN"]]);
  assert.equal((await mac.services.summary()).waitingReview, 0);
  const owner = (await mac.services.getPlan({ planId: PLAN }, { ownerView: true })).progress.items[0];
  assert.deepEqual([owner.accepted, owner.notChosen, owner.waitingReview], [1, 7, 0]);
  assert.equal((await mac.services.getPlan({ planId: PLAN })).progress.items[0].waitingReview, 8, "the factory's read stays the stored state until the tick");
  // The tick applies it once.
  assert.deepEqual(await mac.services.applyPeerPicks(), { applied: 1, skipped: 0 });
  assert.deepEqual(await mac.services.applyPeerPicks(), { applied: 0, skipped: 0 });
  assert.deepEqual(kinds(mac, "owner_pick", "peer_pick", "group_reviewed"), [
    ["owner_pick", { itemKey: "W1/I", attemptRef: "a3", device: "WIN", note: "стройная" }],
    ["peer_pick", { pickId: sent.pickId, fromDevice: "WIN", itemKey: "W1/I", attemptRef: "a3", action: "pick" }],
    ["group_reviewed", { groupId: "W1", accepted: 0, rejected: 0, overridesValidator: 0, picked: 1, noneFits: 0 }],
  ]);
  await sync();
  assert.deepEqual(macPlan().handledPicks, [sent.pickId]);
  const after = withSentPicks(macPlan(), macPlan().review, await win.services.outgoingPicks(), "WIN");
  assert.deepEqual(after.filter((e) => e.picked).map((e) => [e.attemptRef, e.picked?.device, e.pickSent ?? false]), [["a3", "WIN", false]], "applied there: no longer 'sent'");
});

test("AC-VR-11: an action older than the Mac's state is superseded; a pick on an attempt the Mac rejected never applies; both are weighed once", async () => {
  const { mac, win, sync } = await twoComputers();
  tick();
  const old = await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "pick" });
  tick();
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a5", action: "pick" });
  await sync();
  tick();
  assert.deepEqual(await mac.services.applyPeerPicks(), { applied: 0, skipped: 1 });
  assert.deepEqual((await itemOf(mac)).picks.map((p) => p.attemptRef), ["a5"], "the Mac's later pick stands");
  assert.deepEqual(kinds(mac, "peer_pick").at(-1), ["peer_pick", { pickId: old.pickId, fromDevice: "WIN", itemKey: "W1/I", attemptRef: "a1", action: "pick", superseded: true, reason: "picked_later" }]);
  // The Mac rejects a6; Windows (an older report) still picks it.
  tick();
  const late = await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a6", action: "pick" });
  tick();
  await mac.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a6", result: "rejected" });
  await sync();
  assert.deepEqual(await mac.services.applyPeerPicks(), { applied: 0, skipped: 1 });
  assert.deepEqual(kinds(mac, "peer_pick").at(-1)?.[1], { pickId: late.pickId, fromDevice: "WIN", itemKey: "W1/I", attemptRef: "a6", action: "pick", superseded: true, reason: "rejected" });
  assert.deepEqual((await itemOf(mac)).picks.map((p) => p.attemptRef), ["a5"]);
  assert.deepEqual(await mac.services.applyPeerPicks(), { applied: 0, skipped: 0 }, "each weighed once");
});

test("AC-VR-11: a rejection given on Windows withdraws the Mac's pick of that attempt; Windows cannot pick an attempt it rejected", async () => {
  const { mac, win, sync } = await twoComputers();
  tick();
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a4", action: "pick" });
  await sync();
  tick();
  await win.services.recordPeerVerdict({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a4", result: "rejected", replace: true, markers: [{ start: 0, note: "лестница", region: { x: 0.1, y: 0.9, r: 0.05 } }] });
  await assert.rejects(
    win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a4", action: "pick" }),
    (e: unknown) => isDomainError(e) && e.code === "plan_mismatch" && (e.details as { reason?: string }).reason === "rejected"
  );
  await sync();
  await mac.services.applyPeerVerdicts();
  const item = await itemOf(mac);
  assert.deepEqual([item.picks.length, item.rejected, item.waitingReview], [0, 1, 7]);
  assert.deepEqual(kinds(mac, "owner_unpick").at(-1), ["owner_unpick", { itemKey: "W1/I", attemptRef: "a4", device: "WIN", reason: "rejected" }]);
  // The pin of Windows' verdict reached the Mac's history unchanged.
  assert.deepEqual(mac.history.at(-1)?.markers, [{ start: 0, end: null, note: "лестница", region: { x: 0.1, y: 0.9, r: 0.05 } }]);
});

test("AC-VR-11: refused on Windows -- the Mac reads only version 4, an attempt not in its report, a closed plan; none fits travels too", async () => {
  const old = await twoComputers(4);
  await assert.rejects(
    old.win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "pick" }),
    (e: unknown) => isDomainError(e) && e.code === "plan_invalid" && (e.details as { reason?: string }).reason === "peer_update_required"
  );
  const { mac, win, sync } = await twoComputers();
  await assert.rejects(win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "zz", action: "pick" }), (e: unknown) => isDomainError(e) && e.code === "plan_mismatch");
  tick();
  await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", action: "none_fits", note: "все с фонарём" });
  await sync();
  assert.deepEqual(await mac.services.applyPeerPicks(), { applied: 1, skipped: 0 });
  const item = await itemOf(mac);
  assert.deepEqual([item.noneFits?.device, item.noneFits?.attempts, item.notChosen, item.waitingReview], ["WIN", 8, 8, 0]);
  await mac.services.closePlan({ planId: PLAN, status: "completed" });
  await sync();
  await assert.rejects(win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "pick" }), (e: unknown) => isDomainError(e) && e.code === "plan_closed");
});

// -- review round 1 (each a scenario the reviewers reproduced; expected values from the plan's rules) -------------------------

test("review round 1: a rejection the factory relays withdraws the pick -- never both picked and rejected", async () => {
  const s = await visualPlan({ targetCount: 1 });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" });
  tick();
  await s.services.report({ planId: PLAN, rows: [{ stageId: "owner_review", itemKey: "W1/I", attemptRef: "a3", result: "rejected", note: "relayed from Telegram" }] });
  const item = await itemOf(s);
  assert.deepEqual([item.picks.length, item.accepted, item.rejected, item.notChosen, item.waitingReview], [0, 0, 1, 0, 7]);
  assert.deepEqual(kinds(s, "owner_unpick").at(-1), ["owner_unpick", { itemKey: "W1/I", attemptRef: "a3", device: "factory", reason: "rejected" }]);
  const stage = (await s.services.getPlan({ planId: PLAN })).progress.stages.find((st) => st.stageId === "owner_review");
  assert.deepEqual([stage?.counts.accepted, stage?.counts.rejected], [0, 1]);
});

test("review round 1: only rows of external stages make an attempt -- a relayed verdict for an unknown ref changes no music number", async () => {
  const job = { id: "j1", sessionId: "s1", channelId: CHANNEL, stageId: "generate", itemKey: "I1", seed: 1, status: "done" as const, error: null, createdAt: new Date("2026-10-11T10:00:00Z"), submittedAt: null, finishedAt: new Date("2026-10-11T10:05:00Z"), outputFile: "j1.mp3", planId: "R-music" };
  const s = setup([job]);
  await s.services.createPlan({
    planId: "R-music",
    title: "music",
    channelId: CHANNEL,
    stages: [
      { stageId: "generate", title: "Generate", kind: "in_app" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
    ],
    items: [{ itemKey: "I1", targetCount: 2 }],
  });
  await s.services.report({ planId: "R-music", rows: [{ stageId: "owner_review", itemKey: "I1", attemptRef: "job:gone", result: "rejected" }] });
  const item = (await s.services.getPlan({ planId: "R-music" })).progress.items[0];
  // As before BL-175: one linked job, one more to generate.
  assert.deepEqual([item.attempts, item.missing], [1, 1]);
  assert.deepEqual((await s.services.todo({ planId: "R-music" })).short.map((x) => [x.itemKey, x.missing]), [["I1", 1]]);
});

test("review round 1: the owner withdraws a pick still on its way from Windows -- after the tick it stays withdrawn (newer wins)", async () => {
  const { mac, win, sync } = await twoComputers();
  tick();
  await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" });
  await sync();
  assert.equal((await mac.services.reviewQueue({ planId: PLAN })).entries.find((e) => e.attemptRef === "a3")?.picked?.device, "WIN", "shown as picked");
  tick();
  assert.equal((await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "unpick" })).outcome, "applied");
  // Review round 2 (§L: the requirement is "what the owner saw is what is stored"; round 1 only kept the pick out by superseding
  // it, which lost what the pending action itself moved -- see the next test): the owner's action weighs the pending pick first,
  // so it is applied, then withdrawn by the newer own action, and the tick finds nothing left to weigh.
  assert.deepEqual(await mac.services.applyPeerPicks(), { applied: 0, skipped: 0 });
  assert.deepEqual([(await itemOf(mac)).picks.length, (await itemOf(mac)).waitingReview], [0, 8]);
  assert.equal((kinds(mac, "peer_pick").at(-1)?.[1] as Record<string, unknown> | undefined)?.superseded, undefined);
  // The same for "none fits": withdrawn here before the tick, it stays withdrawn.
  tick();
  await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", action: "none_fits", note: "все мимо" });
  await sync();
  tick();
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", action: "clear_none_fits" });
  await mac.services.applyPeerPicks();
  assert.equal((await itemOf(mac)).noneFits, null);
});

test("review round 1: a none-fits from Windows covers only the attempts its owner saw -- a9 reported on the Mac meanwhile waits", async () => {
  const { mac, win, sync } = await twoComputers();
  tick();
  const sent = await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", action: "none_fits", note: "все с фонарём" });
  assert.deepEqual(sent.covered, refs(8));
  tick(60_000);
  await mac.services.report({ planId: PLAN, rows: [{ stageId: "render", itemKey: "W1/I", attemptRef: "a9", result: "done", auditionFile: "H-0004/planC/a9.png" }] });
  await sync();
  // Before the tick (the owner's view) and after it, a9 waits.
  assert.equal((await mac.services.reviewQueue({ planId: PLAN })).entries.find((e) => e.attemptRef === "a9")?.notChosen, undefined);
  await mac.services.applyPeerPicks();
  const item = await itemOf(mac);
  assert.deepEqual([item.noneFits?.attempts, item.notChosen, item.waitingReview], [8, 8, 1]);
  assert.deepEqual((await mac.services.todo({ planId: PLAN })).waitingReview.map((w) => w.attemptRef), ["a9"]);
});

// -- Review round 2 -------------------------------------------------------------------------------------------------------

test("review round 2: the Mac picked a1, Windows' pick of a3 is on its way, the owner picks a5 on the Mac -- only a5 stays picked, every move stored", async () => {
  const { mac, win, sync } = await twoComputers();
  tick();
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "pick" });
  await sync();
  tick();
  const sent = await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" });
  await sync();
  tick();
  const own = await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a5", action: "pick" });
  assert.deepEqual(own.picks.map((p) => [p.attemptRef, p.device]), [["a5", "MAC"]]);
  // Target 1: a3 moved a1 out (Windows' action, its own time), then a5 moved a3 out (the owner's, later).
  assert.deepEqual(kinds(mac, "owner_pick", "owner_unpick", "peer_pick").slice(1), [
    ["owner_unpick", { itemKey: "W1/I", attemptRef: "a1", device: "WIN", reason: "moved" }],
    ["owner_pick", { itemKey: "W1/I", attemptRef: "a3", device: "WIN" }],
    ["peer_pick", { pickId: sent.pickId, fromDevice: "WIN", itemKey: "W1/I", attemptRef: "a3", action: "pick" }],
    ["owner_unpick", { itemKey: "W1/I", attemptRef: "a3", device: "MAC", reason: "moved" }],
    ["owner_pick", { itemKey: "W1/I", attemptRef: "a5", device: "MAC" }],
  ]);
  assert.deepEqual(await mac.services.applyPeerPicks(), { applied: 0, skipped: 0 });
  const item = await itemOf(mac);
  assert.deepEqual([item.picks.map((p) => p.attemptRef), item.accepted, item.notChosen, item.waitingReview], [["a5"], 1, 7, 0]);
});

test("review round 2: nothing picked, Windows' pick of a3 on its way, the owner picks a5 -- the wave is recorded as reviewed once", async () => {
  const { mac, win, sync } = await twoComputers();
  tick();
  await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" });
  await sync();
  tick();
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a5", action: "pick" });
  await mac.services.applyPeerPicks();
  assert.deepEqual((await itemOf(mac)).picks.map((p) => p.attemptRef), ["a5"]);
  // 8 waiting -> 0 by Windows' pick (applied first); the owner's move keeps it at 0, so no second record.
  assert.deepEqual(kinds(mac, "group_reviewed"), [["group_reviewed", { groupId: "W1", accepted: 0, rejected: 0, overridesValidator: 0, picked: 1, noneFits: 0 }]]);
});

test("review round 2: a none-fits from Windows also covers the attempts already settled on the Mac that its report had cut", async () => {
  let macReport: GenerationPlansReport | null = null;
  let winReport: GenerationPlansReport | null = null;
  const mac = setup([], { deviceId: "mac-id", label: "MAC", peers: () => (winReport ? [winReport] : []) });
  const win = setup([], { deviceId: "win-id", label: "WIN", peers: () => (macReport ? [macReport] : []) });
  const sync = async () => {
    macReport = await reportOf(mac, "mac-id", "MAC");
    winReport = await reportOf(win, "win-id", "WIN");
  };
  await mac.services.createPlan({
    planId: PLAN,
    title: "big",
    channelId: CHANNEL,
    stages: [
      { stageId: "render", title: "Render", kind: "external" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
    ],
    groups: [{ groupId: "W1", title: "Stills" }],
    items: [
      { itemKey: "W1/A", groupId: "W1", targetCount: 1 },
      { itemKey: "W1/B", groupId: "W1", targetCount: 1 },
    ],
  });
  // A: 499 waiting attempts; B: 9, a3 picked -- the other 8 not chosen. The report keeps 500 entries, settled ones cut first.
  for (let i = 0; i < 499; i += 100) {
    const rows = Array.from({ length: Math.min(100, 499 - i) }, (_, j) => ({ stageId: "render", itemKey: "W1/A", attemptRef: `x${String(i + j).padStart(3, "0")}`, result: "done" as const, auditionFile: `A/x${i + j}.png` }));
    await mac.services.report({ planId: PLAN, rows });
  }
  await mac.services.report({ planId: PLAN, rows: refs(9).map((a) => ({ stageId: "render", itemKey: "W1/B", attemptRef: a, result: "done", auditionFile: `B/${a}.png` })) });
  tick();
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/B", attemptRef: "a3", action: "pick" });
  await sync();
  tick();
  const sent = await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/B", action: "none_fits", note: "все мимо" });
  assert.deepEqual(sent.covered, ["a1"], "only B/a1 made it into the 500 entries");
  await sync();
  await mac.services.applyPeerPicks();
  const b = (await mac.services.getPlan({ planId: PLAN })).progress.items.find((i) => i.itemKey === "W1/B");
  assert.deepEqual([b?.picks.length, b?.noneFits?.attempts, b?.notChosen, b?.waitingReview], [0, 9, 9, 0]);
});

for (const result of ["failed", "rejected"] as const) {
  test(`review round 2: a picked attempt the stage before the review re-reports ${result} loses its pick -- the item is open again`, async () => {
    const s = await visualPlan({ mode: "until_accepted", targetCount: 1 });
    tick();
    await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" });
    tick();
    await s.services.report({ planId: PLAN, rows: [{ stageId: "render", itemKey: "W1/I", attemptRef: "a3", result }] });
    assert.deepEqual(kinds(s, "owner_unpick").at(-1), ["owner_unpick", { itemKey: "W1/I", attemptRef: "a3", device: "factory", reason: "left_queue" }]);
    let item = await itemOf(s);
    // a3 is out; the other 7 wait again; 7 pending cover the one wanted, so nothing more is asked for.
    assert.deepEqual([item.picks.length, item.accepted, item.notChosen, item.waitingReview, item.missing], [0, 0, 0, 7, 0]);
    tick();
    await s.services.report({ planId: PLAN, rows: [{ stageId: "render", itemKey: "W1/I", attemptRef: "a9", result: "done", auditionFile: "H-0004/planC/a9.png" }] });
    assert.equal((await s.services.reviewQueue({ planId: PLAN })).entries.find((e) => e.attemptRef === "a9")?.notChosen, undefined);
    item = await itemOf(s);
    assert.equal(item.waitingReview, 8);
  });
}

test("review round 2: a ref only a relayed verdict names is no attempt -- it cannot be picked", async () => {
  const s = await visualPlan({ mode: "until_accepted", targetCount: 1 }, 3);
  await s.services.report({ planId: PLAN, rows: [{ stageId: "owner_review", itemKey: "W1/I", attemptRef: "ghost", result: "accepted" }] });
  tick();
  await assert.rejects(
    () => s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "ghost", action: "pick" }),
    (e: unknown) => isDomainError(e) && e.code === "plan_mismatch" && (e.details as Record<string, unknown>).reason === "unknown_attempt"
  );
  const item = await itemOf(s);
  assert.deepEqual([item.picks.length, item.notChosen, item.waitingReview], [0, 0, 3]);
});

test("review round 2: a pick on an attempt that is no longer pickable neither shows nor decides its item; the same none-fits again changes nothing", () => {
  const at = "2026-10-11T12:00:00.000Z";
  const records: PlanPickRecord[] = [{ itemKey: "I", kind: "pick", attemptRef: "a3", active: true, note: null, device: "MAC", at, covered: [] }];
  const items = [{ itemKey: "I", mode: "fixed" as const, targetCount: 1 }];
  const live = new Set(["I\u0000a1", "I\u0000a2"]);
  assert.deepEqual(pickFlagsOf(pickStateOf(records), items, live)("I", "a1", false), { picked: null, notChosen: false });
  assert.deepEqual(pickFlagsOf(pickStateOf(records), items)("I", "a1", false), { picked: null, notChosen: true }, "without the live set, as before");
  const none: PlanPickRecord = { itemKey: "I", kind: "none_fits", attemptRef: null, active: true, note: "мимо", device: "WIN", at, covered: ["a1", "a2"] };
  const again = applyPickAction({ itemKey: "I", attemptRef: null, action: "none_fits", note: "мимо", device: "WIN", at }, { records: [none], target: 1, queueRefs: ["a1", "a2"], rejected: new Set(), validatorRejected: new Set() });
  assert.deepEqual(again, { outcome: "unchanged" });
});

// -- Review round 3 -------------------------------------------------------------------------------------------------------

test("review round 3: Windows picks a3 and then rejects it; any pick action of the owner on the Mac before the tick never stores the a3 pick", async () => {
  const { mac, win, sync } = await twoComputers();
  tick();
  await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" });
  tick();
  await win.services.recordPeerVerdict({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a3", result: "rejected" });
  await sync();
  tick();
  // A no-op (a1 is not picked) -- it still weighs the pending pick first, with the rejection on its way counted (§2.2).
  const answer = await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "unpick" });
  assert.deepEqual([answer.outcome, answer.picks], ["unchanged", []]);
  assert.deepEqual(kinds(mac, "owner_pick", "group_reviewed"), []);
  assert.deepEqual((kinds(mac, "peer_pick").at(-1)?.[1] as Record<string, unknown>).reason, "rejected");
  await mac.services.applyPeerVerdicts();
  await mac.services.applyPeerPicks();
  const item = await itemOf(mac);
  // 8 attempts, a3 rejected: 7 wait, nothing picked, no wave recorded as reviewed.
  assert.deepEqual([item.picks.length, item.waitingReview, kinds(mac, "group_reviewed").length], [0, 7, 0]);
});

/** reviewRejected on: render passes a1..a4 and rejects a5 (playable), so the owner may pick a5 over the validator. */
async function overridePlan(pickTarget: number) {
  const s = setup();
  await s.services.createPlan({
    planId: PLAN,
    title: "override",
    channelId: CHANNEL,
    reviewRejected: true,
    stages: [
      { stageId: "render", title: "Render", kind: "external" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
      { stageId: "post", title: "Post", kind: "external" },
    ],
    groups: [{ groupId: "W1", title: "Stills" }],
    items: [
      { itemKey: "W1/I", groupId: "W1", targetCount: 2, pickTarget },
      { itemKey: "W1/J", groupId: "W1", targetCount: 1 },
    ],
  });
  await s.services.report({
    planId: PLAN,
    rows: [
      ...refs(4).map((a) => ({ stageId: "render", itemKey: "W1/I", attemptRef: a, result: "done" as const, auditionFile: `x/${a}.png` })),
      { stageId: "render", itemKey: "W1/I", attemptRef: "a5", result: "rejected" as const, auditionFile: "x/a5.png" },
      { stageId: "render", itemKey: "W1/J", attemptRef: "j1", result: "done" as const, auditionFile: "x/j1.png" },
    ],
  });
  return s;
}
const itemNamed = async (s: ReturnType<typeof setup>, itemKey: string) => (await s.services.getPlan({ planId: PLAN })).progress.items.find((i) => i.itemKey === itemKey);

test("review round 3: switching reviewRejected off takes a picked validator-rejected attempt out of the queue -- its pick is withdrawn right then, and only then", async () => {
  const s = await overridePlan(2);
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "pick" });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a5", action: "pick" });
  tick();
  await s.services.updatePlan({ planId: PLAN, reviewRejected: false });
  assert.deepEqual(kinds(s, "owner_unpick"), [["owner_unpick", { itemKey: "W1/I", attemptRef: "a5", device: "factory", reason: "left_queue" }]]);
  assert.deepEqual((await itemNamed(s, "W1/I"))?.picks.map((p) => p.attemptRef), ["a1"]);
  // One of two picked: a2 is the second -- a1 is not moved out by a pick nobody can see.
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a2", action: "pick" });
  assert.deepEqual((await itemNamed(s, "W1/I"))?.picks.map((p) => p.attemptRef), ["a1", "a2"]);
  // A report on another item, or rejected attempts shown again, brings nothing back and withdraws nothing more.
  tick();
  await s.services.report({ planId: PLAN, rows: [{ stageId: "render", itemKey: "W1/J", attemptRef: "j2", result: "done", auditionFile: "x/j2.png" }] });
  await s.services.updatePlan({ planId: PLAN, reviewRejected: true });
  assert.equal(kinds(s, "owner_unpick").length, 1);
  assert.deepEqual((await itemNamed(s, "W1/I"))?.picks.map((p) => p.attemptRef), ["a1", "a2"]);
});

test("review round 3: a picked attempt a stage after the review fails stays accepted -- the owner's pick, as for the app's own attempts", async () => {
  const s = await overridePlan(1);
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a2", action: "pick" });
  tick();
  await s.services.report({ planId: PLAN, rows: [{ stageId: "post", itemKey: "W1/I", attemptRef: "a2", result: "failed" }] });
  const item = await itemNamed(s, "W1/I");
  assert.deepEqual([item?.picks.map((p) => p.attemptRef), item?.accepted], [["a2"], 1]);
  assert.equal(kinds(s, "owner_unpick").length, 0);
});

test("review round 3: a none-fits from Windows never covers an attempt reported on the Mac after it was given, even on an item a Mac pick had decided", async () => {
  const { mac, win, sync } = await twoComputers();
  tick();
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "pick" });
  await sync();
  tick();
  await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", action: "none_fits", note: "все мимо" });
  tick(60_000);
  await mac.services.report({ planId: PLAN, rows: [{ stageId: "render", itemKey: "W1/I", attemptRef: "a9", result: "done", auditionFile: "H-0004/planC/a9.png" }] });
  await sync();
  // Before the tick, a9 is not chosen (a1 decides the item); the none-fits takes a1's pick away and covers a1..a8 only.
  await mac.services.applyPeerPicks();
  const item = await itemOf(mac);
  assert.deepEqual([item.picks.length, item.noneFits?.attempts, item.notChosen, item.waitingReview], [0, 8, 8, 1]);
  assert.deepEqual((await mac.services.todo({ planId: PLAN })).waitingReview.map((w) => w.attemptRef), ["a9"]);
});

test("review round 3: a fixed item's only attempt, external and picked, then failed by a stage after the review -- accepted, nothing more asked for", async () => {
  const s = setup();
  await s.services.createPlan({
    planId: PLAN,
    title: "one",
    channelId: CHANNEL,
    stages: [
      { stageId: "render", title: "Render", kind: "external" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
      { stageId: "post", title: "Post", kind: "external" },
    ],
    items: [{ itemKey: "K", targetCount: 1 }],
  });
  await s.services.report({ planId: PLAN, rows: [{ stageId: "render", itemKey: "K", attemptRef: "a1", result: "done", auditionFile: "x/a1.png" }] });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "K", attemptRef: "a1", action: "pick" });
  tick();
  await s.services.report({ planId: PLAN, rows: [{ stageId: "post", itemKey: "K", attemptRef: "a1", result: "failed" }] });
  const item = await itemNamed(s, "K");
  assert.deepEqual([item?.accepted, item?.missing], [1, 0]);
});

// -- Review round 4 -------------------------------------------------------------------------------------------------------

test("review round 4: a job of the app's own that was still generating when Windows said none fits, and finished after, waits", async () => {
  const at = (ms: number) => new Date(clockMs + ms);
  const job = (n: number, done: boolean) => ({ id: `j${n}`, sessionId: "s1", channelId: CHANNEL, stageId: "generate", itemKey: "I", seed: n, status: (done ? "done" : "generating") as PlanJobRow["status"], error: null, createdAt: at(-60_000), submittedAt: null, finishedAt: done ? at(-30_000) : null, outputFile: `j${n}.png`, planId: PLAN });
  const jobs = [job(1, true), job(2, true), job(3, true), job(4, false)];
  let macReport: GenerationPlansReport | null = null;
  let winReport: GenerationPlansReport | null = null;
  const mac = setup(jobs, { deviceId: "mac-id", label: "MAC", peers: () => (winReport ? [winReport] : []) });
  const win = setup([], { deviceId: "win-id", label: "WIN", peers: () => (macReport ? [macReport] : []) });
  const sync = async () => {
    macReport = await reportOf(mac, "mac-id", "MAC");
    winReport = await reportOf(win, "win-id", "WIN");
  };
  await mac.services.createPlan({
    planId: PLAN,
    title: "in-app stills",
    channelId: CHANNEL,
    stages: [
      { stageId: "generate", title: "Generate", kind: "in_app" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
    ],
    items: [{ itemKey: "I", targetCount: 1 }],
  });
  tick();
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "I", attemptRef: "job:j1", action: "pick" });
  await sync();
  tick();
  const sent = await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "I", action: "none_fits", note: "все мимо" });
  assert.deepEqual(sent.covered, ["job:j1", "job:j2", "job:j3"]);
  tick(60_000);
  Object.assign(jobs[3], { status: "done", finishedAt: new Date(clockMs) });
  await sync();
  await mac.services.applyPeerPicks();
  const item = (await mac.services.getPlan({ planId: PLAN })).progress.items[0];
  // j4 entered the queue after the none-fits: it waits; j1..j3 are covered (j1's pick withdrawn).
  assert.deepEqual([item.picks.length, item.noneFits?.attempts, item.notChosen, item.waitingReview], [0, 3, 3, 1]);
});

test("review round 4: a failed verdict relayed at the review stage withdraws the pick, as a rejected one does", async () => {
  const s = await visualPlan({ targetCount: 1 });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" });
  tick();
  await s.services.report({ planId: PLAN, rows: [{ stageId: "owner_review", itemKey: "W1/I", attemptRef: "a3", result: "failed" }] });
  assert.deepEqual(kinds(s, "owner_unpick").at(-1), ["owner_unpick", { itemKey: "W1/I", attemptRef: "a3", device: "factory", reason: "rejected" }]);
  const item = await itemOf(s);
  assert.deepEqual([item.picks.length, item.accepted, item.rejected], [0, 0, 1]);
});

// Review of round 4 (§L): the requirement became stricter -- a dead app attempt is no pick target at all (a pick on it decided the
// item while it never counted, so its replacement never reached the owner). The pick is refused; the numbers stay as stated.
test("review round 4: a pick never revives an attempt of the app's own whose job failed (accepted 0, one more to make)", async () => {
  const failed = { id: "j1", sessionId: "s1", channelId: CHANNEL, stageId: "generate", itemKey: "I", seed: 1, status: "failed" as const, error: "boom", createdAt: new Date(clockMs - 60_000), submittedAt: null, finishedAt: new Date(clockMs - 30_000), outputFile: null, planId: PLAN };
  const s = setup([failed]);
  await s.services.createPlan({
    planId: PLAN,
    title: "one job",
    channelId: CHANNEL,
    stages: [
      { stageId: "generate", title: "Generate", kind: "in_app" },
      { stageId: "check", title: "Check", kind: "external" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
    ],
    items: [{ itemKey: "I", targetCount: 1 }],
  });
  // The validator passed it anyway (a stale row): it is in the queue and can be picked.
  await s.services.report({ planId: PLAN, rows: [{ stageId: "check", itemKey: "I", attemptRef: "job:j1", result: "accepted" }] });
  tick();
  await assert.rejects(
    () => s.services.recordOwnerPick({ planId: PLAN, itemKey: "I", attemptRef: "job:j1", action: "pick" }),
    (e: unknown) => isDomainError(e) && (e.details as Record<string, unknown>).reason === "unknown_attempt"
  );
  const item = (await s.services.getPlan({ planId: PLAN })).progress.items[0];
  assert.deepEqual([item.accepted, item.missing], [0, 1]);
});

// -- BL-175 phase 3: AC-V3-03..05 (VISUAL_REVIEW_PLAN.md §8.3, worked out by hand) --------------------------------------------

const verdictEvents = async (s: ReturnType<typeof setup>) => (await s.services.getPlan({ planId: PLAN })).events.filter((e) => e.kind === "owner_verdict").map((e) => e.details);

test("AC-V3-03: a verdict's seconds are kept with it and shown in owner_verdict; without them, no field; out of range is refused", async () => {
  const s = await visualPlan({ targetCount: 1 });
  tick();
  await s.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", result: "rejected", reviewSeconds: 42 });
  tick();
  await s.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a2", result: "accepted" });
  const events = await verdictEvents(s);
  assert.deepEqual(events.map((d) => [d.attemptRef, d.reviewSeconds]), [["a1", 42], ["a2", undefined]]);
  for (const reviewSeconds of [-1, 86_401, 1.5]) {
    await assert.rejects(() => s.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a3", result: "accepted", reviewSeconds }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  }
});

test("AC-V3-04: a verdict and a pick given on Windows bring their seconds to the Mac", async () => {
  const { mac, win, sync } = await twoComputers();
  tick();
  await win.services.recordPeerVerdict({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a1", result: "rejected", reviewSeconds: 30 });
  tick();
  await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a2", action: "pick", reviewSeconds: 8 });
  await sync();
  await mac.services.applyPeerVerdicts();
  await mac.services.applyPeerPicks();
  assert.deepEqual((await verdictEvents(mac)).map((d) => [d.attemptRef, d.device, d.reviewSeconds]), [["a1", "WIN", 30]]);
  assert.deepEqual(kinds(mac, "owner_pick").map(([, d]) => [(d as Record<string, unknown>).attemptRef, (d as Record<string, unknown>).device, (d as Record<string, unknown>).reviewSeconds]), [["a2", "WIN", 8]]);
});

test("AC-V3-05: a pick, a none-fits and a re-check answer carry their seconds; what a pick moved does not", async () => {
  const s = await visualPlan({ targetCount: 1 });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "pick", reviewSeconds: 12 });
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a2", action: "pick", reviewSeconds: 5 });
  assert.deepEqual(kinds(s, "owner_pick", "owner_unpick").map(([k, d]) => [k, (d as Record<string, unknown>).attemptRef, (d as Record<string, unknown>).reviewSeconds]), [
    ["owner_pick", "a1", 12],
    ["owner_unpick", "a1", undefined],
    ["owner_pick", "a2", 5],
  ]);
  tick();
  await s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", action: "none_fits", note: "все мимо", reviewSeconds: 20 });
  assert.equal((kinds(s, "owner_none_fits").at(-1)?.[1] as Record<string, unknown>).reviewSeconds, 20);
  // A question re-check on a rated attempt, answered with 15 s.
  tick();
  await s.services.recordOwnerVerdict({ planId: PLAN, itemKey: "W1/I", attemptRef: "a4", result: "accepted" });
  tick();
  await s.services.requestRecheck({ planId: PLAN, itemKey: "W1/I", attemptRef: "a4", recheckId: "q1", kind: "question", title: "фонарь", note: "это фонарь?" });
  tick();
  await s.services.answerRecheck({ planId: PLAN, recheckId: "q1", result: "rejected", reviewSeconds: 15 });
  assert.equal((kinds(s, "recheck_answered").at(-1)?.[1] as Record<string, unknown>).reviewSeconds, 15);
  assert.deepEqual((await verdictEvents(s)).filter((d) => d.recheckId === "q1").map((d) => d.reviewSeconds), [15]);
});

test("AC-V3-02: a revision may name a Gemini output in place; a missing one is refused as file_missing, naming the Gemini folder", async () => {
  const { mkdir, mkdtemp, realpath, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const { createExchangeFs, resolveExchangeFile } = await import("@/lib/workspace-exchange");
  const { isPathInsideOrEqual } = await import("@/lib/local-path-validation");
  const { PLAN_JOB_OUTPUT_SUBDIRS } = await import("./contracts");
  const root = await realpath(await mkdtemp(pathMod.join(tmpdir(), "ytm-gemini-plan-")));
  try {
    const ws = pathMod.join(root, "ws");
    await mkdir(pathMod.join(ws, "99 Data Exchange", "Sent to YTM"), { recursive: true });
    await mkdir(pathMod.join(ws, "99 Data Exchange", "From YTM", "gemini", "gm_7"), { recursive: true });
    await writeFile(pathMod.join(ws, "99 Data Exchange", "From YTM", "gemini", "gm_7", "image-1.png"), "png");
    const files = {
      workspaceOf: async () => ws,
      sentFileExists: (workspace: string, relativePath: string) =>
        resolveExchangeFile({ workspace, relativePath, jobSubdirs: PLAN_JOB_OUTPUT_SUBDIRS, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true as const }), isPathInsideOrEqual, unavailable: (r) => new Error(r) }).then(
          () => true,
          () => false
        ),
    };
    const s = setup([], { files });
    await s.services.createPlan({
      planId: PLAN,
      title: "gemini",
      channelId: CHANNEL,
      stages: [
        { stageId: "render", title: "Render", kind: "external" },
        { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
      ],
      items: [{ itemKey: "I", targetCount: 1 }],
    });
    await s.services.report({ planId: PLAN, rows: [{ stageId: "render", itemKey: "I", attemptRef: "g1", result: "done", auditionFile: "From YTM/gemini/gm_7/image-1.png" }] });
    assert.equal((await s.services.reviewQueue({ planId: PLAN })).entries[0]?.media, "image");
    tick();
    await s.services.recordOwnerVerdict({ planId: PLAN, itemKey: "I", attemptRef: "g1", result: "rejected" });
    tick();
    const ok = await s.services.requestRecheck({ planId: PLAN, itemKey: "I", attemptRef: "g1", recheckId: "r1", kind: "revision", title: "фон", note: "убрал предмет", auditionFile: "From YTM/gemini/gm_7/image-1.png" });
    assert.equal(ok.recheck.status, "open");
    await s.services.withdrawRecheck({ planId: PLAN, recheckId: "r1" });
    await assert.rejects(
      () => s.services.requestRecheck({ planId: PLAN, itemKey: "I", attemptRef: "g1", recheckId: "r2", kind: "revision", title: "фон", note: "ещё раз", auditionFile: "From YTM/gemini/gm_7/missing.png" }),
      (e: unknown) => isDomainError(e) && (e.details as Record<string, unknown>).reason === "file_missing" && /Gemini job's folder/.test(e.message)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -- Review of round 4 (VISUAL_REVIEW_PLAN.md §5 round 4, §2.2; expected values worked out by hand) ---------------------------

test("review of round 4: an attempt a relayed failed verdict rejected cannot be picked again (never both accepted and rejected)", async () => {
  const s = await visualPlan({ targetCount: 1 });
  tick();
  await s.services.report({ planId: PLAN, rows: [{ stageId: "owner_review", itemKey: "W1/I", attemptRef: "a3", result: "failed" }] });
  tick();
  await assert.rejects(
    () => s.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a3", action: "pick" }),
    (e: unknown) => isDomainError(e) && e.code === "plan_mismatch" && (e.details as Record<string, unknown>).reason === "rejected"
  );
  const item = await itemOf(s);
  assert.deepEqual([item.picks.length, item.accepted, item.rejected], [0, 0, 1]);
});

for (const mode of ["fixed", "until_accepted"] as const) {
  test(`review of round 4 (${mode}): an app attempt whose job failed cannot be picked -- the replacement it asks for waits for the owner`, async () => {
    const job = (id: string, status: PlanJobRow["status"]) => ({ id, sessionId: "s1", channelId: CHANNEL, stageId: "generate", itemKey: "I", seed: Number(id.slice(1)), status, error: status === "failed" ? "boom" : null, createdAt: new Date(clockMs - 60_000), submittedAt: null, finishedAt: new Date(clockMs - 30_000), outputFile: `${id}.png`, planId: PLAN });
    const jobs: Array<PlanJobRow & { planId: string | null }> = [job("j1", "failed")];
    const s = setup(jobs);
    await s.services.createPlan({
      planId: PLAN,
      title: "dead",
      channelId: CHANNEL,
      stages: [
        { stageId: "generate", title: "Generate", kind: "in_app" },
        { stageId: "check", title: "Check", kind: "external" },
        { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
      ],
      items: [{ itemKey: "I", targetCount: 1, mode }],
    });
    // A stale "passed" row of the check on the failed job: it is in the queue, but it is dead.
    await s.services.report({ planId: PLAN, rows: [{ stageId: "check", itemKey: "I", attemptRef: "job:j1", result: "accepted" }] });
    tick();
    await assert.rejects(
      () => s.services.recordOwnerPick({ planId: PLAN, itemKey: "I", attemptRef: "job:j1", action: "pick" }),
      (e: unknown) => isDomainError(e) && (e.details as Record<string, unknown>).reason === "unknown_attempt"
    );
    let item = (await s.services.getPlan({ planId: PLAN })).progress.items[0];
    assert.deepEqual([item.accepted, item.missing], [0, 1]);
    // The factory makes the replacement: it waits (nothing decided the item).
    jobs.push(job("j2", "done"));
    await s.services.report({ planId: PLAN, rows: [{ stageId: "check", itemKey: "I", attemptRef: "job:j2", result: "accepted" }] });
    item = (await s.services.getPlan({ planId: PLAN })).progress.items[0];
    assert.equal(item.notChosen, 0);
    assert.ok((await s.services.todo({ planId: PLAN })).waitingReview.some((w) => w.attemptRef === "job:j2"), "the replacement waits for the owner");
  });
}

test("review of round 4: Windows picked a2 and rejected a1, the Mac picked a1 before that arrived -- the owner acting first stores what the tick would", async () => {
  const pair = async () => {
    let macReport: GenerationPlansReport | null = null;
    let winReport: GenerationPlansReport | null = null;
    const mac = setup([], { deviceId: "mac-id", label: "MAC", peers: () => (winReport ? [winReport] : []) });
    const win = setup([], { deviceId: "win-id", label: "WIN", peers: () => (macReport ? [macReport] : []) });
    await mac.services.createPlan({
      planId: PLAN,
      title: "x",
      channelId: CHANNEL,
      stages: [
        { stageId: "render", title: "Render", kind: "external" },
        { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
      ],
      groups: [{ groupId: "W1", title: "Stills" }],
      items: [
        { itemKey: "W1/I", groupId: "W1", targetCount: 1 },
        { itemKey: "W1/J", groupId: "W1", targetCount: 1 },
      ],
    });
    await mac.services.report({ planId: PLAN, rows: [...refs(3).map((a) => ({ stageId: "render", itemKey: "W1/I", attemptRef: a, result: "done" as const, auditionFile: `x/${a}.png` })), { stageId: "render", itemKey: "W1/J", attemptRef: "j1", result: "done" as const, auditionFile: "x/j1.png" }] });
    macReport = await reportOf(mac, "mac-id", "MAC");
    tick();
    await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a2", action: "pick" });
    tick();
    await win.services.recordPeerVerdict({ deviceId: "mac-id", planId: PLAN, itemKey: "W1/I", attemptRef: "a1", result: "rejected" });
    tick();
    await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/I", attemptRef: "a1", action: "pick" });
    tick();
    winReport = await reportOf(win, "win-id", "WIN");
    return mac;
  };
  const picksOfI = async (s: ReturnType<typeof setup>) => (await s.services.getPlan({ planId: PLAN })).progress.items.find((i) => i.itemKey === "W1/I")?.picks.map((p) => p.attemptRef);
  // The tick: a1's rejection first (its pick withdrawn), then Windows' pick of a2.
  const tickOnly = await pair();
  await tickOnly.services.applyPeerVerdicts();
  await tickOnly.services.applyPeerPicks();
  assert.deepEqual(await picksOfI(tickOnly), ["a2"]);
  // The owner acts on another item first: before the tick the screen shows a2 picked and a1 not; afterwards the same as the tick.
  const ownerFirst = await pair();
  const shown = (await ownerFirst.services.reviewQueue({ planId: PLAN })).entries.filter((e) => e.itemKey === "W1/I").map((e) => [e.attemptRef, Boolean(e.picked)]);
  assert.deepEqual(shown.sort(), [["a1", false], ["a2", true], ["a3", false]]);
  await ownerFirst.services.recordOwnerPick({ planId: PLAN, itemKey: "W1/J", attemptRef: "j1", action: "pick" });
  await ownerFirst.services.applyPeerVerdicts();
  await ownerFirst.services.applyPeerPicks();
  assert.deepEqual(await picksOfI(ownerFirst), ["a2"]);
});

test("review of round 4: a job that finished in the same second as a none-fits from Windows (the store keeps whole seconds) waits", async () => {
  // Align the clock to a whole second, then 0.3 s into it.
  clockMs = Math.ceil(clockMs / 1000) * 1000 + 300;
  const whole = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);
  const job = (n: number, done: boolean) => ({ id: `j${n}`, sessionId: "s1", channelId: CHANNEL, stageId: "generate", itemKey: "I", seed: n, status: (done ? "done" : "generating") as PlanJobRow["status"], error: null, createdAt: whole(clockMs - 60_000), submittedAt: null, finishedAt: done ? whole(clockMs - 30_000) : null, outputFile: `j${n}.png`, planId: PLAN });
  const jobs = [job(1, true), job(2, true), job(3, false)];
  let macReport: GenerationPlansReport | null = null;
  let winReport: GenerationPlansReport | null = null;
  const mac = setup(jobs, { deviceId: "mac-id", label: "MAC", peers: () => (winReport ? [winReport] : []) });
  const win = setup([], { deviceId: "win-id", label: "WIN", peers: () => (macReport ? [macReport] : []) });
  await mac.services.createPlan({ planId: PLAN, title: "s", channelId: CHANNEL, stages: [{ stageId: "generate", title: "Generate", kind: "in_app" }, { stageId: "owner_review", title: "Owner review", kind: "owner_review" }], items: [{ itemKey: "I", targetCount: 1 }] });
  await mac.services.recordOwnerPick({ planId: PLAN, itemKey: "I", attemptRef: "job:j1", action: "pick" });
  macReport = await reportOf(mac, "mac-id", "MAC");
  tick(1000); // x.300: Windows says none fits; j3 still generates
  await win.services.recordPeerPick({ deviceId: "mac-id", planId: PLAN, itemKey: "I", action: "none_fits", note: "мимо" });
  // j3 finishes 0.4 s later, in the same second; the store keeps the whole second.
  Object.assign(jobs[2], { status: "done", finishedAt: whole(clockMs + 400) });
  tick(60_000);
  winReport = await reportOf(win, "win-id", "WIN");
  await mac.services.applyPeerPicks();
  const item = (await mac.services.getPlan({ planId: PLAN })).progress.items[0];
  assert.deepEqual([item.noneFits?.attempts, item.notChosen, item.waitingReview], [2, 2, 1]);
});
