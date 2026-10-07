import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError, type PlanEvent, type PlanResultRow } from "./contracts";
import type { PlanJobRow, PlanSessionRow } from "./progress";
import { createGenerationPlanServices, type PlanStore, type StoredPlan } from "./services";

// BL-143 acceptance criteria AC-GP-01..07 (docs/roadmap/plans/GENERATION_PLANS_PLAN.md §4), written before the services.
// Expected values are stated from the plan's rules, not from running the code.

/** The row without the store's own bookkeeping keys. */
function without<T extends object, K extends string>(row: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...row } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

function memoryStore(seed: { jobs?: Array<PlanJobRow & { planId: string | null; channelId: string }>; sessions?: Array<PlanSessionRow & { planId: string }> } = {}) {
  const plans = new Map<string, StoredPlan>();
  const results = new Map<string, PlanResultRow & { planId: string }>();
  const events: Array<PlanEvent & { planId: string }> = [];
  const jobs = seed.jobs ?? [];
  const sessions = seed.sessions ?? [];
  const store: PlanStore = {
    async insertPlan(row) {
      if (plans.has(row.id)) return null;
      plans.set(row.id, structuredClone(row));
      return structuredClone(row);
    },
    getPlan: async (id) => (plans.has(id) ? structuredClone(plans.get(id)!) : null),
    listPlans: async (filter) => [...plans.values()].filter((p) => (!filter.status || p.status === filter.status) && (!filter.channelId || p.channelId === filter.channelId)).map((p) => structuredClone(p)),
    async updatePlan(id, expectedRevision, set) {
      const row = plans.get(id);
      if (!row || row.revision !== expectedRevision) return null;
      const next = { ...row, ...structuredClone(set), revision: expectedRevision + 1 } as StoredPlan;
      plans.set(id, next);
      return structuredClone(next);
    },
    async upsertResults(planId, rows) {
      for (const r of rows) results.set(`${planId}|${r.stageId}|${r.itemKey}|${r.attemptRef}`, { ...structuredClone(r), planId });
    },
    listResults: async (planId) => [...results.values()].filter((r) => r.planId === planId).map((r) => without(r, "planId")),
    async insertEvent(planId, event) {
      events.push({ ...event, planId });
    },
    listEvents: async (planId) => events.filter((e) => e.planId === planId).map((e) => without(e, "planId")),
    listJobs: async (planId) => jobs.filter((j) => j.planId === planId).map((j) => without(j, "planId", "channelId")),
    async linkJob(jobId, link) {
      const job = jobs.find((j) => j.id === jobId);
      if (!job || job.planId !== null || job.channelId !== link.channelId) return false;
      Object.assign(job, { planId: link.planId, stageId: link.stageId, itemKey: link.itemKey });
      return true;
    },
    listSessions: async (planId) => sessions.filter((s) => s.planId === planId).map((x) => without(x, "planId")),
  };
  return { store, plans, results, events, jobs };
}

const CHANNEL = "UC_plan_channel";
let clockMs = Date.parse("2026-10-07T10:00:00.000Z");

function setup(seed: Parameters<typeof memoryStore>[0] = {}) {
  const mem = memoryStore(seed);
  const services = createGenerationPlanServices({
    store: mem.store,
    channels: { isConnected: async (id) => id === CHANNEL },
    clock: { now: () => new Date((clockMs += 1000)) },
  });
  return { ...mem, services };
}

const STAGES = [
  { stageId: "generate", title: "Generate", kind: "in_app" as const },
  { stageId: "postprocess", title: "Post-process", kind: "external" as const },
  { stageId: "validate", title: "Validator", kind: "external" as const },
  { stageId: "owner_review", title: "Owner review", kind: "owner_review" as const },
];

const basePlan = () => ({
  planId: "R-0001-S1-music",
  title: "Stage 1 music",
  channelId: CHANNEL,
  budget: { usd: 2 },
  stages: STAGES,
  groups: [{ groupId: "C1", title: "Wave 1" }, { groupId: "C2", title: "Wave 2", dependsOn: "C1" }],
  items: [
    { itemKey: "C1/F1", groupId: "C1", templateId: "tpl-ace", targetCount: 2, params: { prompt: "koto, slow", duration: 120 }, seeds: [1001, 1002] },
    { itemKey: "C2/F1", groupId: "C2", templateId: "tpl-ace", targetCount: 2, mode: "until_accepted" as const, maxAttempts: 6 },
  ],
});

const refused = (code: string) => (e: unknown) => isDomainError(e) && e.code === code;

// -- AC-GP-01 -----------------------------------------------------------------------------------------------------------

test("AC-GP-01: create then get returns the stages, groups and items as given (defaults filled), with zero progress", async () => {
  const s = setup();
  const created = await s.services.createPlan(basePlan());
  const got = await s.services.getPlan({ planId: "R-0001-S1-music" });
  assert.deepEqual(got.plan.stages, STAGES);
  assert.deepEqual(got.plan.groups, [
    { groupId: "C1", title: "Wave 1", dependsOn: null, note: null },
    { groupId: "C2", title: "Wave 2", dependsOn: "C1", note: null },
  ]);
  assert.deepEqual(got.plan.items[0], { itemKey: "C1/F1", groupId: "C1", templateLabel: null, templateId: "tpl-ace", variant: null, targetCount: 2, mode: "fixed", maxAttempts: null, params: { prompt: "koto, slow", duration: 120 }, seeds: [1001, 1002] });
  assert.equal(got.plan.items[1].mode, "until_accepted");
  assert.equal(got.plan.status, "active");
  assert.equal(got.plan.owner, "factory");
  assert.deepEqual(got.plan.budget, { usd: 2, gpuMinutes: null });
  assert.equal(created.progress.stages[0].counts.planned, 4, "planned = the sum of the items' targets");
  assert.deepEqual(got.progress.items.map((i) => i.missing), [2, 2]);
  assert.deepEqual(got.events.map((e) => [e.kind, e.actor]), [["plan_created", "factory"]]);
});

test("AC-GP-01: a taken id, a bad id, an unknown channel, two in_app stages, an unknown group, a duplicate item are refused and nothing is stored", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  await assert.rejects(s.services.createPlan(basePlan()), refused("plan_invalid"));
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["bad id", { ...basePlan(), planId: "has space" }, "validation_failed"],
    ["one-char id", { ...basePlan(), planId: "R" }, "validation_failed"],
    ["unknown channel", { ...basePlan(), planId: "p2", channelId: "UC_other" }, "plan_invalid"],
    ["two in_app", { ...basePlan(), planId: "p3", stages: [...STAGES, { stageId: "gen2", title: "Gen 2", kind: "in_app" }] }, "plan_invalid"],
    ["two owner_review", { ...basePlan(), planId: "p4", stages: [...STAGES, { stageId: "review2", title: "R2", kind: "owner_review" }] }, "plan_invalid"],
    ["unknown group", { ...basePlan(), planId: "p5", items: [{ itemKey: "X/1", groupId: "nope", targetCount: 1 }] }, "plan_invalid"],
    ["duplicate item", { ...basePlan(), planId: "p6", items: [{ itemKey: "X/1", targetCount: 1 }, { itemKey: "X/1", targetCount: 2 }] }, "plan_invalid"],
    ["self dependency", { ...basePlan(), planId: "p7", groups: [{ groupId: "C1", dependsOn: "C1" }], items: [] }, "plan_invalid"],
    ["extra field", { ...basePlan(), planId: "p8", path: "/tmp" }, "validation_failed"],
  ];
  for (const [name, input, code] of cases) await assert.rejects(s.services.createPlan(input), refused(code), name);
  assert.deepEqual([...s.plans.keys()], ["R-0001-S1-music"], "nothing else stored");
});

// -- AC-GP-02 -----------------------------------------------------------------------------------------------------------

/** A file in the factory's `ytm-generation-plan/1` shape (FO-MSG-0008 attachment): free-text template labels, a `group`, job refs. */
function planFile(results: Array<{ stageId: string; itemKey: string; attemptRef: string; result: string; reportedBy?: string; note?: string }>) {
  return {
    format: "ytm-generation-plan/1",
    planId: "R-0001-S1-music",
    title: "Stage 1 music, waves C1-C2",
    channelId: CHANNEL,
    owner: "factory",
    budget: { usd: null, gpuMinutes: null },
    status: "active",
    stages: STAGES,
    items: [
      { itemKey: "C1/smoke", templateId: "tpl-a / tpl-b", targetCount: 2, mode: "fixed", group: "C1" },
      { itemKey: "C2/F7", templateId: "tpl-a", targetCount: 4, mode: "fixed", group: "C2" },
    ],
    results,
    spend: { usd: 1.59, gpuSeconds: null },
    updatedAt: "2026-10-07T09:10:00Z",
    note: "converted from the interim file",
  };
}

test("AC-GP-02: import keeps template labels and groups; counts per stage equal the file's results; a job ref of this channel is linked, others are imported rows", async () => {
  const job = (id: string, status: PlanJobRow["status"]) => ({ id, sessionId: "s1", stageId: null, itemKey: null, seed: null, status, error: null, createdAt: new Date("2026-10-06T20:00:00Z"), submittedAt: null, finishedAt: null, planId: null, channelId: CHANNEL });
  const s = setup({ jobs: [job("j1", "done"), job("j2", "done"), { ...job("j-other", "done"), channelId: "UC_x" }] });
  const results = [
    { stageId: "generate", itemKey: "C1/smoke", attemptRef: "job:j1", result: "done", reportedBy: "job" },
    { stageId: "generate", itemKey: "C1/smoke", attemptRef: "job:j2", result: "done", reportedBy: "job" },
    { stageId: "generate", itemKey: "C2/F7", attemptRef: "job:j-other", result: "done", reportedBy: "job" },
    { stageId: "generate", itemKey: "C2/F7", attemptRef: "job:gone", result: "done", reportedBy: "job" },
    { stageId: "validate", itemKey: "C1/smoke", attemptRef: "job:j1", result: "accepted", reportedBy: "factory" },
    { stageId: "validate", itemKey: "C1/smoke", attemptRef: "job:j2", result: "rejected", reportedBy: "factory" },
    { stageId: "owner_review", itemKey: "C1/smoke", attemptRef: "job:j1", result: "accepted", reportedBy: "factory", note: "relayed from chat" },
  ];
  const imported = await s.services.importPlan({ plan: planFile(results) });
  assert.equal(imported.linkedJobs, 2, "j1, j2 (this channel, in no plan); j-other is another channel's");
  assert.equal(imported.importedResults, 5);
  assert.deepEqual(imported.plan.items.map((i) => [i.itemKey, i.templateLabel, i.templateId, i.groupId]), [
    ["C1/smoke", "tpl-a / tpl-b", null, "C1"],
    ["C2/F7", "tpl-a", null, "C2"],
  ]);
  assert.deepEqual(imported.plan.groups.map((g) => g.groupId), ["C1", "C2"]);
  const counts = Object.fromEntries(imported.progress.stages.map((st) => [st.stageId, st.counts]));
  assert.equal(counts.generate.done, 4);
  assert.equal(counts.validate.accepted, 1);
  assert.equal(counts.validate.rejected, 1);
  assert.equal(counts.owner_review.accepted, 1);
  assert.equal(s.jobs.find((j) => j.id === "j1")?.planId, "R-0001-S1-music");
  assert.equal(s.jobs.find((j) => j.id === "j-other")?.planId, null);
  await assert.rejects(s.services.importPlan({ plan: planFile([]) }), refused("plan_invalid"), "the same planId twice");
});

test("AC-GP-02: an import naming an unknown stage or item, or not in the format, stores nothing", async () => {
  const s = setup();
  await assert.rejects(s.services.importPlan({ plan: planFile([{ stageId: "nope", itemKey: "C1/smoke", attemptRef: "x", result: "done" }]) }), refused("plan_invalid"));
  await assert.rejects(s.services.importPlan({ plan: planFile([{ stageId: "generate", itemKey: "Z/9", attemptRef: "x", result: "done" }]) }), refused("plan_invalid"));
  await assert.rejects(s.services.importPlan({ plan: { ...planFile([]), format: "something/2" } }), refused("validation_failed"));
  assert.equal(s.plans.size, 0);
});

// -- AC-GP-03 / 04 ------------------------------------------------------------------------------------------------------

const check = { id: "internal_gap_s", label: "Dropout", value: 0.95, unit: "s", threshold: 0.45, pass: false, severity: "fail" as const, atSeconds: [5.55, 6.5] as [number, number] };

test("AC-GP-03: a report is idempotent per (plan, stage, item, attempt) -- the repeat replaces it; pass and severity stay independent", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  const passingButFailClass = { id: "CE", value: 7.75, unit: "1-10", threshold: 7.33, pass: true, severity: "fail" as const };
  await s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:a1", result: "rejected", checks: [check, passingButFailClass], metrics: { lufs: -14.2, key: "D major" } }] });
  await s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:a1", result: "accepted", checks: [passingButFailClass] }] });
  const rows = [...s.results.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, "accepted");
  assert.equal(rows[0].reportedBy, "factory");
  assert.deepEqual(rows[0].checks.map((c) => [c.id, c.pass, c.severity]), [["CE", true, "fail"]]);
  assert.deepEqual(rows[0].metrics, {}, "the repeat replaced the whole row");
});

test("AC-GP-03: reports for an in_app stage, an unknown stage or item, or a closed plan are refused and nothing is stored", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  const row = { stageId: "validate", itemKey: "C1/F1", attemptRef: "job:a1", result: "accepted" };
  await assert.rejects(s.services.report({ planId: "R-0001-S1-music", rows: [row, { ...row, stageId: "generate" }] }), refused("plan_mismatch"), "in_app stage: the valid first row is not stored either");
  await assert.rejects(s.services.report({ planId: "R-0001-S1-music", rows: [{ ...row, stageId: "mixdown" }] }), refused("plan_mismatch"));
  await assert.rejects(s.services.report({ planId: "R-0001-S1-music", rows: [{ ...row, itemKey: "C9/F9" }] }), refused("plan_mismatch"));
  await assert.rejects(s.services.report({ planId: "unknown-plan", rows: [row] }), refused("plan_not_found"));
  assert.equal(s.results.size, 0);
  await s.services.closePlan({ planId: "R-0001-S1-music", status: "completed" });
  await assert.rejects(s.services.report({ planId: "R-0001-S1-music", rows: [row] }), refused("plan_closed"));
});

test("AC-GP-03: the bounds -- 201 rows, 51 checks, a 2001-character note, a 201-character detail -- are refused whole", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  const row = { stageId: "validate", itemKey: "C1/F1", attemptRef: "job:a1", result: "accepted" };
  const over: Array<[string, unknown[]]> = [
    ["201 rows", Array.from({ length: 201 }, (_, i) => ({ ...row, attemptRef: `job:${i}` }))],
    ["51 checks", [{ ...row, checks: Array.from({ length: 51 }, (_, i) => ({ ...check, id: `c${i}` })) }]],
    ["note", [{ ...row, note: "x".repeat(2001) }]],
    ["detail", [{ ...row, checks: [{ ...check, detail: "x".repeat(201) }] }]],
    ["rating 11", [{ ...row, stageId: "owner_review", rating: 11 }]],
    ["marker end before start", [{ ...row, markers: [{ start: 10, end: 5 }] }]],
  ];
  for (const [name, rows] of over) await assert.rejects(s.services.report({ planId: "R-0001-S1-music", rows }), refused("validation_failed"), name);
  // At the limit it is accepted.
  await s.services.report({ planId: "R-0001-S1-music", rows: Array.from({ length: 200 }, (_, i) => ({ ...row, attemptRef: `job:${i}`, note: "x".repeat(2000) })) });
  assert.equal(s.results.size, 200);
});

test("AC-GP-04: auditionFile must be relative to Sent to YTM -- absolute, '..', backslash, drive letter or empty segments are refused", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  const row = { stageId: "postprocess", itemKey: "C1/F1", attemptRef: "job:a1", result: "done" };
  for (const bad of ["/etc/passwd", "../x.mp3", "R-0001/../../x.mp3", "R-0001\\C1\\x.mp3", "C:/x.mp3", "R-0001//x.mp3", "./x.mp3"]) {
    await assert.rejects(s.services.report({ planId: "R-0001-S1-music", rows: [{ ...row, auditionFile: bad }] }), refused("validation_failed"), bad);
  }
  await s.services.report({ planId: "R-0001-S1-music", rows: [{ ...row, auditionFile: "R-0001/C1/final_01.mp3" }] });
  assert.equal([...s.results.values()][0].auditionFile, "R-0001/C1/final_01.mp3");
});

// -- AC-GP-05 / 06 / 07 -------------------------------------------------------------------------------------------------

test("AC-GP-05: close changes only the status (jobs untouched); every later write is refused with plan_closed", async () => {
  const job = { id: "j1", sessionId: "s1", stageId: "generate", itemKey: "C1/F1", seed: 1001, status: "generating" as const, error: null, createdAt: new Date("2026-10-07T09:00:00Z"), submittedAt: new Date("2026-10-07T09:00:00Z"), finishedAt: null, planId: "R-0001-S1-music", channelId: CHANNEL };
  const s = setup({ jobs: [job] });
  await s.services.createPlan(basePlan());
  const closed = await s.services.closePlan({ planId: "R-0001-S1-music", status: "cancelled", note: "stopped by the owner" });
  assert.equal(closed.plan.status, "cancelled");
  assert.ok(closed.plan.closedAt);
  assert.equal(s.jobs[0].status, "generating", "the running job is not touched");
  assert.equal(closed.progress.stages[0].counts.running, 1, "and still shows as running");
  await assert.rejects(s.services.updatePlan({ planId: "R-0001-S1-music", title: "x" }), refused("plan_closed"));
  await assert.rejects(s.services.closePlan({ planId: "R-0001-S1-music", status: "completed" }), refused("plan_closed"));
  await assert.rejects(s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }), refused("plan_closed"));
});

test("AC-GP-06: update cannot remove a stage or item with attempts/results; it can change targets and params, add stages, groups and items", async () => {
  const job = { id: "j1", sessionId: "s1", stageId: "generate", itemKey: "C1/F1", seed: 1001, status: "done" as const, error: null, createdAt: new Date("2026-10-07T09:00:00Z"), submittedAt: new Date("2026-10-07T09:00:00Z"), finishedAt: new Date("2026-10-07T09:05:00Z"), planId: "R-0001-S1-music", channelId: CHANNEL };
  const s = setup({ jobs: [job] });
  await s.services.createPlan(basePlan());
  await s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await assert.rejects(s.services.updatePlan({ planId: "R-0001-S1-music", removeItemKeys: ["C1/F1"] }), refused("plan_invalid"));
  await assert.rejects(s.services.updatePlan({ planId: "R-0001-S1-music", removeStageIds: ["validate"] }), refused("plan_invalid"));
  await assert.rejects(s.services.updatePlan({ planId: "R-0001-S1-music", removeStageIds: ["generate"] }), refused("plan_invalid"), "the in_app stage has a job");
  await assert.rejects(s.services.updatePlan({ planId: "R-0001-S1-music", removeGroupIds: ["C2"] }), refused("plan_invalid"), "C2 still has an item");
  const updated = await s.services.updatePlan({
    planId: "R-0001-S1-music",
    removeItemKeys: ["C2/F1"],
    removeStageIds: ["postprocess"],
    upsertItems: [{ itemKey: "C1/F1", groupId: "C1", templateId: "tpl-ace", targetCount: 5, params: { prompt: "koto, faster" }, seeds: [1001] }],
    upsertGroups: [{ groupId: "C3", title: "Wave 3", dependsOn: "C1" }],
    addStages: [{ stageId: "master", title: "Master", kind: "external" }],
    budget: { usd: 3 },
  });
  assert.deepEqual(updated.plan.items.map((i) => [i.itemKey, i.targetCount, i.params.prompt]), [["C1/F1", 5, "koto, faster"]]);
  assert.deepEqual(updated.plan.stages.map((st) => st.stageId), ["generate", "validate", "owner_review", "master"]);
  assert.deepEqual(updated.plan.groups.map((g) => g.groupId), ["C1", "C2", "C3"]);
  assert.equal(updated.plan.budget.usd, 3);
  assert.equal(updated.plan.revision, 2);
  await assert.rejects(s.services.updatePlan({ planId: "R-0001-S1-music", addStages: [{ stageId: "master", title: "again", kind: "external" }] }), refused("plan_invalid"));
});

test("AC-GP-07: todo lists items short of target, attempts waiting for the owner, and failed/interrupted attempts while the item is short", async () => {
  const at = new Date("2026-10-07T09:00:00Z");
  const j = (id: string, itemKey: string, status: PlanJobRow["status"], error: string | null = null) => ({ id, sessionId: "s1", stageId: "generate", itemKey, seed: null, status, error, createdAt: at, submittedAt: at, finishedAt: status === "done" || status === "failed" ? at : null, planId: "R-0001-S1-music", channelId: CHANNEL });
  const s = setup({
    jobs: [
      j("a1", "C1/F1", "done"),
      j("a2", "C1/F1", "failed", "interrupted by a server restart"),
      j("b1", "C2/F1", "done"),
      j("b2", "C2/F1", "done"),
      j("b3", "C2/F1", "failed", "ComfyUI error"),
    ],
  });
  await s.services.createPlan(basePlan());
  // C2/F1 (until_accepted, target 2): b1 passed the validator and waits for the owner; b2 was rejected by the validator.
  await s.services.report({
    planId: "R-0001-S1-music",
    rows: [
      { stageId: "validate", itemKey: "C2/F1", attemptRef: "job:b1", result: "accepted" },
      { stageId: "validate", itemKey: "C2/F1", attemptRef: "job:b2", result: "rejected" },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "job:a1", result: "accepted" },
    ],
  });
  await s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:a1", result: "accepted", rating: 7 });
  const todo = await s.services.todo({ planId: "R-0001-S1-music" });
  // C1/F1 fixed 2: a1 done, a2 interrupted -> 1 usable -> missing 1. C2/F1 until_accepted 2: 0 accepted, b1 pending -> missing 1.
  assert.deepEqual(todo.short, [
    { itemKey: "C1/F1", groupId: "C1", missing: 1, mode: "fixed" },
    { itemKey: "C2/F1", groupId: "C2", missing: 1, mode: "until_accepted" },
  ]);
  assert.deepEqual(todo.waitingReview, [{ itemKey: "C2/F1", attemptRef: "job:b1" }]);
  assert.deepEqual(todo.rerun, [
    { itemKey: "C1/F1", attemptRef: "job:a2", state: "interrupted" },
    { itemKey: "C2/F1", attemptRef: "job:b3", state: "failed" },
  ]);
});

// -- AC-GP-13 (service part) --------------------------------------------------------------------------------------------

test("AC-GP-13: the owner's verdict is stored with reportedBy owner, rating, reasons, markers and a note, and is an event the factory reads", async () => {
  const job = { id: "j1", sessionId: "s1", stageId: "generate", itemKey: "C1/F1", seed: 1001, status: "done" as const, error: null, createdAt: new Date("2026-10-07T09:00:00Z"), submittedAt: new Date("2026-10-07T09:00:00Z"), finishedAt: new Date("2026-10-07T09:05:00Z"), planId: "R-0001-S1-music", channelId: CHANNEL };
  const s = setup({ jobs: [job] });
  await s.services.createPlan(basePlan());
  const before = (await s.services.getPlan({ planId: "R-0001-S1-music" })).cursor;
  await s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", rating: 6, reasons: ["dropout / pause"], markers: [{ start: 111, end: 112.2 }], note: "pause 1:51" });
  const row = [...s.results.values()][0];
  assert.deepEqual([row.stageId, row.reportedBy, row.result, row.rating, row.reasons, row.markers, row.note], ["owner_review", "owner", "rejected", 6, ["dropout / pause"], [{ start: 111, end: 112.2, note: null }], "pause 1:51"]);
  const after = await s.services.getPlan({ planId: "R-0001-S1-music", since: before });
  assert.deepEqual(after.events.map((e) => [e.kind, e.actor, e.details.rating]), [["owner_verdict", "owner", 6]]);
  await assert.rejects(s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:nope", result: "accepted" }), refused("plan_mismatch"), "an attempt the plan does not have");
});

test("a re-run request and a group note are recorded for the factory; nothing is started", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  await s.services.requestRerun({ planId: "R-0001-S1-music", itemKey: "C1/F1", note: "start too sharp" });
  const withNote = await s.services.setGroupNote({ planId: "R-0001-S1-music", groupId: "C1", note: "all too thin" });
  assert.equal(withNote.plan.groups[0].note, "all too thin");
  const events = (await s.services.getPlan({ planId: "R-0001-S1-music" })).events.map((e) => e.kind);
  assert.deepEqual(events, ["plan_created", "rerun_requested", "group_note"]);
  await assert.rejects(s.services.requestRerun({ planId: "R-0001-S1-music", itemKey: "Z/9" }), refused("plan_mismatch"));
  await assert.rejects(s.services.setGroupNote({ planId: "R-0001-S1-music", groupId: "Z", note: "x" }), refused("plan_mismatch"));
});

// -- slice 2: running stages (AC-GP-08..12) -----------------------------------------------------------------------------

type FakeSession = { sessionId: string; status: string; channelId: string; requestedBy: string; planId: string | null };

/** A media port that behaves like the media core's contract: params checked against a template; created jobs become rows. */
function withMedia(seedSessions: FakeSession[], opts: { templates?: Record<string, string[]>; failCreateAfter?: number } = {}) {
  const s = setup();
  const sessions = new Map(seedSessions.map((x) => [x.sessionId, { ...x }]));
  const templates = opts.templates ?? { "tpl-ace": ["prompt", "duration", "seed"], "tpl-noseed": ["prompt"] };
  const createdJobs: Array<{ jobId: string; params: Record<string, unknown>; plan: unknown; sessionId: string }> = [];
  let n = 0;
  const services = createGenerationPlanServices({
    store: s.store,
    channels: { isConnected: async (id) => id === CHANNEL },
    clock: { now: () => new Date((clockMs += 1000)) },
    media: {
      getSession: async (id) => sessions.get(id) ?? null,
      async linkSession(id, planId) {
        const x = sessions.get(id);
        if (!x || (x.planId !== null && x.planId !== planId)) return false;
        x.planId = planId;
        return true;
      },
      async validateJobParams({ templateId, params }) {
        const names = templates[templateId];
        if (!names) throw Object.assign(new Error(`No workflow template ${templateId}`), { code: "media_template_not_found" });
        const unknown = Object.keys(params).filter((k) => !names.includes(k));
        if (unknown.length > 0) throw Object.assign(new Error(`unknown parameter "${unknown[0]}"`), { code: "validation_failed" });
        return { parameterNames: names };
      },
      async createJob(input) {
        if (opts.failCreateAfter !== undefined && createdJobs.length >= opts.failCreateAfter) throw Object.assign(new Error("ComfyUI unreachable"), { code: "comfyui_unreachable" });
        const jobId = `job-${++n}`;
        createdJobs.push({ jobId, params: input.params, plan: input.plan, sessionId: input.sessionId });
        s.jobs.push({ id: jobId, sessionId: input.sessionId, stageId: input.plan.stageId, itemKey: input.plan.itemKey, seed: input.plan.seed, status: "queued", error: null, createdAt: new Date(clockMs), submittedAt: null, finishedAt: null, planId: input.plan.planId, channelId: input.channelId });
        return { jobId };
      },
    },
  });
  return { ...s, services, sessions, createdJobs };
}

const running = (over: Partial<FakeSession> = {}): FakeSession => ({ sessionId: "s1", status: "running", channelId: CHANNEL, requestedBy: "factory", planId: null, ...over });

test("AC-GP-09: run_stage creates exactly the missing jobs -- fixed: one per unused seed; until_accepted: up to the target -- with params and the seed", async () => {
  const m = withMedia([running()]);
  await m.services.createPlan(basePlan());
  const result = await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" });
  // C1/F1 fixed, 2 seeds -> 2 jobs (seeds 1001, 1002); C2/F1 until_accepted target 2, no seeds -> 2 jobs, no seed.
  assert.deepEqual(result.created.map((c) => [c.itemKey, c.seed]), [["C1/F1", 1001], ["C1/F1", 1002], ["C2/F1", null], ["C2/F1", null]]);
  assert.equal(result.stoppedAt, null);
  assert.deepEqual(m.createdJobs[0].params, { prompt: "koto, slow", duration: 120, seed: 1001 });
  assert.deepEqual(m.createdJobs[0].plan, { planId: "R-0001-S1-music", stageId: "generate", itemKey: "C1/F1", seed: 1001 });
  assert.equal(m.sessions.get("s1")?.planId, "R-0001-S1-music", "the session is linked for its spend");
  // A second run creates nothing: every attempt is still open.
  assert.deepEqual((await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" })).created, []);
  // A failed fixed attempt frees its seed; an interrupted one too.
  m.jobs[0].status = "failed";
  m.jobs[0].error = "interrupted by a server restart";
  const again = await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1", groupId: "C1" });
  assert.deepEqual(again.created.map((c) => [c.itemKey, c.seed]), [["C1/F1", 1001]]);
});

test("AC-GP-09: until_accepted counts accepted and pending attempts and stops at maxAttempts", async () => {
  const m = withMedia([running()]);
  await m.services.createPlan({ ...basePlan(), items: [{ itemKey: "C2/F1", groupId: "C2", templateId: "tpl-noseed", targetCount: 2, mode: "until_accepted", maxAttempts: 3, params: { prompt: "x" } }] });
  await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" });
  assert.equal(m.createdJobs.length, 2);
  // Both generated; the validator rejects one -> 1 more is needed; the cap (3) allows exactly one.
  for (const j of m.jobs) j.status = "done";
  await m.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C2/F1", attemptRef: "job:job-1", result: "rejected" }] });
  assert.equal((await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" })).created.length, 1);
  m.jobs[2].status = "done";
  await m.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C2/F1", attemptRef: "job:job-3", result: "rejected" }] });
  assert.equal((await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" })).created.length, 0, "3 attempts = the cap");
});

test("AC-GP-10: run_stage is refused, creating no job, for a wrong session, channel, plan state, item, group, template or params", async () => {
  const sessions = [
    running(),
    running({ sessionId: "s-owner", requestedBy: "operator" }),
    running({ sessionId: "s-stopped", status: "done" }),
    running({ sessionId: "s-other-channel", channelId: "UC_other" }),
    running({ sessionId: "s-other-plan", planId: "another-plan" }),
  ];
  const m = withMedia(sessions);
  await m.services.createPlan(basePlan());
  const cases: Array<[string, Record<string, unknown>]> = [
    ["unknown session", { sessionId: "nope" }],
    ["owner's session", { sessionId: "s-owner" }],
    ["stopped session", { sessionId: "s-stopped" }],
    ["other channel", { sessionId: "s-other-channel" }],
    ["other plan's session", { sessionId: "s-other-plan" }],
    ["unknown item", { sessionId: "s1", itemKeys: ["C1/F1", "Z/9"] }],
    ["unknown group", { sessionId: "s1", groupId: "Z" }],
  ];
  for (const [name, extra] of cases) await assert.rejects(m.services.runStage({ planId: "R-0001-S1-music", ...extra }), refused("plan_mismatch"), name);
  // A template problem on the LAST item refuses the whole run, so the first item gets no job either.
  await m.services.updatePlan({ planId: "R-0001-S1-music", upsertItems: [{ itemKey: "C2/F1", groupId: "C2", templateId: "tpl-ace", targetCount: 1, params: { tempo: 90 } }] });
  await assert.rejects(m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" }), refused("plan_mismatch"), "unknown parameter");
  await m.services.updatePlan({ planId: "R-0001-S1-music", upsertItems: [{ itemKey: "C2/F1", groupId: "C2", templateId: null, targetCount: 1 }] });
  await assert.rejects(m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" }), refused("plan_mismatch"), "no template id");
  await m.services.updatePlan({ planId: "R-0001-S1-music", upsertItems: [{ itemKey: "C2/F1", groupId: "C2", templateId: "tpl-noseed", targetCount: 1, params: { prompt: "x" }, seeds: [5] }] });
  await assert.rejects(m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" }), refused("plan_mismatch"), "seeds for a template without a seed parameter");
  assert.equal(m.createdJobs.length, 0);
  await m.services.closePlan({ planId: "R-0001-S1-music", status: "completed" });
  await assert.rejects(m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" }), refused("plan_closed"));
  assert.equal(m.createdJobs.length, 0);
});

test("AC-GP-10: when creating a job fails after the checks, the jobs before it exist and stoppedAt says where", async () => {
  const m = withMedia([running()], { failCreateAfter: 1 });
  await m.services.createPlan(basePlan());
  const result = await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" });
  assert.deepEqual(result.created.map((c) => c.seed), [1001]);
  assert.deepEqual(result.stoppedAt, { itemKey: "C1/F1", seed: 1002, error: { code: "comfyui_unreachable", message: "ComfyUI unreachable" } });
});

test("AC-GP-08: a linked job's state is the attempt's state with no extra call -- queued, running, done, failed, interrupted", async () => {
  const m = withMedia([running()]);
  await m.services.createPlan(basePlan());
  await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1", groupId: "C1" });
  const counts = async () => (await m.services.getPlan({ planId: "R-0001-S1-music" })).progress.stages[0].counts;
  assert.equal((await counts()).queued, 2);
  m.jobs[0].status = "generating";
  m.jobs[1].status = "submitted";
  assert.deepEqual([(await counts()).running, (await counts()).queued], [1, 1]);
  m.jobs[0].status = "done";
  m.jobs[1].status = "failed";
  m.jobs[1].error = "interrupted by a server restart";
  const c = await counts();
  assert.deepEqual([c.done, c.interrupted, c.failed], [1, 1, 0]);
});

test("rerun creates one attempt with the next unused seed (or the given one) under the same checks", async () => {
  const m = withMedia([running(), running({ sessionId: "s-owner", requestedBy: "operator" })]);
  await m.services.createPlan(basePlan());
  await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1", groupId: "C1" });
  await m.services.updatePlan({ planId: "R-0001-S1-music", upsertItems: [{ itemKey: "C1/F1", groupId: "C1", templateId: "tpl-ace", targetCount: 2, params: { prompt: "koto, slow" }, seeds: [1001, 1002, 1003] }] });
  assert.deepEqual((await m.services.rerun({ planId: "R-0001-S1-music", sessionId: "s1", itemKey: "C1/F1" })).created.map((c) => c.seed), [1003]);
  assert.deepEqual((await m.services.rerun({ planId: "R-0001-S1-music", sessionId: "s1", itemKey: "C1/F1", seed: 42 })).created.map((c) => c.seed), [42]);
  await assert.rejects(m.services.rerun({ planId: "R-0001-S1-music", sessionId: "s-owner", itemKey: "C1/F1" }), refused("plan_mismatch"));
  await assert.rejects(m.services.rerun({ planId: "R-0001-S1-music", sessionId: "s1", itemKey: "Z/9" }), refused("plan_mismatch"));
});

test("AC-GP-12: clone_group copies the items as <newGroupId>/<rest>, patches params, copies no results, depends on the source", async () => {
  const m = withMedia([running()]);
  await m.services.createPlan(basePlan());
  await m.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:x", result: "accepted" }] });
  const cloned = await m.services.cloneGroup({ planId: "R-0001-S1-music", groupId: "C1", newGroupId: "C3", title: "Wave 3", paramsPatch: { prompt: "koto, soft start" }, seeds: [2001, 2002] });
  const copy = cloned.plan.items.find((i) => i.itemKey === "C3/F1");
  assert.deepEqual([copy?.groupId, copy?.params, copy?.seeds, copy?.targetCount], ["C3", { prompt: "koto, soft start", duration: 120 }, [2001, 2002], 2]);
  assert.deepEqual(cloned.plan.groups.at(-1), { groupId: "C3", title: "Wave 3", dependsOn: "C1", note: null });
  assert.equal(cloned.progress.items.find((i) => i.itemKey === "C3/F1")?.accepted, 0, "no results copied");
  await assert.rejects(m.services.cloneGroup({ planId: "R-0001-S1-music", groupId: "C1", newGroupId: "C3" }), refused("plan_invalid"), "the new group exists");
  await assert.rejects(m.services.cloneGroup({ planId: "R-0001-S1-music", groupId: "Z", newGroupId: "C4" }), refused("plan_mismatch"));
});

test("a hand-made job may name a plan attempt only for an active plan of its channel, an existing item and the in_app stage", async () => {
  const m = withMedia([running(), running({ sessionId: "s-other-plan", planId: "another-plan" })]);
  await m.services.createPlan(basePlan());
  assert.deepEqual(await m.services.checkJobLink({ planId: "R-0001-S1-music", itemKey: "C1/F1", seed: 7, sessionId: "s1", channelId: CHANNEL }), { planId: "R-0001-S1-music", stageId: "generate", itemKey: "C1/F1", seed: 7 });
  await assert.rejects(m.services.checkJobLink({ planId: "R-0001-S1-music", itemKey: "C1/F1", sessionId: "s1", channelId: "UC_other" }), refused("plan_mismatch"));
  await assert.rejects(m.services.checkJobLink({ planId: "R-0001-S1-music", itemKey: "Z/9", sessionId: "s1", channelId: CHANNEL }), refused("plan_mismatch"));
  await assert.rejects(m.services.checkJobLink({ planId: "R-0001-S1-music", stageId: "validate", itemKey: "C1/F1", sessionId: "s1", channelId: CHANNEL }), refused("plan_mismatch"));
  await assert.rejects(m.services.checkJobLink({ planId: "R-0001-S1-music", itemKey: "C1/F1", sessionId: "s-other-plan", channelId: CHANNEL }), refused("plan_mismatch"));
  await assert.rejects(m.services.checkSessionLink({ planId: "R-0001-S1-music", channelId: "UC_other" }), refused("plan_mismatch"));
  await m.services.checkSessionLink({ planId: "R-0001-S1-music", channelId: CHANNEL });
});
