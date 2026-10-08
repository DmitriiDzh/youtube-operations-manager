import assert from "node:assert/strict";
import test from "node:test";
import { historyEntryOfVerdict, isDomainError, type PlanEvent, type PlanResultRow, type PlanVerdictHistoryRow } from "./contracts";
import type { PlanJobRow, PlanSessionRow } from "./progress";
import type { GenerationPlansReport, SharedClaim, SharedVerdict } from "@/lib/sync-gateway";
import { createGenerationPlanServices, sharedNotices, type PlanServiceDependencies, type PlanStore, type StoredPlan } from "./services";

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
  const peerVerdicts: SharedVerdict[] = [];
  const history: Array<PlanVerdictHistoryRow & { planId: string }> = [];
  const claims = new Map<string, SharedClaim>();
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
    listJobs: async (planId) => jobs.filter((j) => j.planId === planId).map((j) => without(j, "planId")),
    async linkJob(jobId, link) {
      const job = jobs.find((j) => j.id === jobId);
      if (!job || job.planId !== null || job.channelId !== link.channelId) return false;
      Object.assign(job, { planId: link.planId, stageId: link.stageId, itemKey: link.itemKey });
      return true;
    },
    listSessions: async (planId) => sessions.filter((s) => s.planId === planId).map((x) => without(x, "planId")),
    async insertPeerVerdict(v) {
      peerVerdicts.push(structuredClone(v));
    },
    listPeerVerdicts: async (sinceIso) => peerVerdicts.filter((v) => v.at >= sinceIso).map((v) => structuredClone(v)),
    async insertVerdictHistory(planId, row) {
      history.push({ ...structuredClone(row), planId });
    },
    // Oldest first by the time given (the store's order), then the order recorded.
    listVerdictHistory: async (planId) => history.filter((h) => h.planId === planId).map((h, i) => ({ h, i })).sort((a, b) => a.h.at.localeCompare(b.h.at) || a.i - b.i).map(({ h }) => without(h, "planId")),
    async upsertClaim(claim) {
      claims.set(claim.claimId, structuredClone(claim));
    },
    async deleteClaim(claimId) {
      claims.delete(claimId);
    },
    listClaims: async (at) => [...claims.values()].filter((c) => Date.parse(c.until) > at.getTime()).map((c) => structuredClone(c)),
  };
  return { store, plans, results, events, jobs, peerVerdicts, history, claims };
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
  // BL-153 (AC-RR-03, a changed contract): each waiting entry also says what the validator said.
  assert.deepEqual(todo.waitingReview, [{ itemKey: "C2/F1", attemptRef: "job:b1", validator: "passed" }]);
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
  // The cursor looks back a minute (events may repeat, re-review 1); the verdict is among the events after it.
  const after = await s.services.getPlan({ planId: "R-0001-S1-music", since: before });
  assert.deepEqual(after.events.filter((e) => e.kind === "owner_verdict").map((e) => [e.kind, e.actor, e.details.rating]), [["owner_verdict", "owner", 6]]);
  assert.equal(Date.parse(before) <= Date.parse(after.events.at(-1)!.at), true);
  await assert.rejects(s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:nope", result: "accepted" }), refused("plan_mismatch"), "an attempt the plan does not have");
});

test("a re-run request and a group note are recorded for the factory; nothing is started", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  await s.services.requestRerun({ planId: "R-0001-S1-music", itemKey: "C1/F1", note: "start too sharp" });
  const withNote = await s.services.setGroupNote({ planId: "R-0001-S1-music", groupId: "C1", note: "all too thin" });
  // Changed requirement (BL-157, SERVERS_MEDIA_PLAN.md AC-WV-04, FO-REQ-0009 §7.2): the owner's note is its own field,
  // `ownerNote`, so the factory's context in `note` is no longer overwritten by it.
  assert.equal(withNote.plan.groups[0].ownerNote, "all too thin");
  assert.equal(withNote.plan.groups[0].note, null);
  const events = (await s.services.getPlan({ planId: "R-0001-S1-music" })).events.map((e) => e.kind);
  assert.deepEqual(events, ["plan_created", "rerun_requested", "group_note"]);
  await assert.rejects(s.services.requestRerun({ planId: "R-0001-S1-music", itemKey: "Z/9" }), refused("plan_mismatch"));
  await assert.rejects(s.services.setGroupNote({ planId: "R-0001-S1-music", groupId: "Z", note: "x" }), refused("plan_mismatch"));
});

// -- slice 2: running stages (AC-GP-08..12) -----------------------------------------------------------------------------

type FakeSession = { sessionId: string; status: string; channelId: string; requestedBy: string; planId: string | null };

/** A media port that behaves like the media core's contract: params checked against a template; created jobs become rows. */
function withMedia(
  seedSessions: FakeSession[],
  opts: {
    templates?: Record<string, string[]>;
    failCreateAfter?: number;
    outputs?: Record<string, Array<{ kind: string; localPath: string | null; filename: string }>>;
    /** BL-157: the channels connected on this device (default: the plan's channel only). */
    connected?: string[];
    files?: PlanServiceDependencies["files"];
  } = {}
) {
  const s = setup();
  const sessions = new Map(seedSessions.map((x) => [x.sessionId, { ...x }]));
  const templates = opts.templates ?? { "tpl-ace": ["prompt", "duration", "seed"], "tpl-noseed": ["prompt"] };
  const createdJobs: Array<{ jobId: string; params: Record<string, unknown>; plan: unknown; sessionId: string }> = [];
  let n = 0;
  const services = createGenerationPlanServices({
    store: s.store,
    channels: { isConnected: async (id) => (opts.connected ?? [CHANNEL]).includes(id) },
    clock: { now: () => new Date((clockMs += 1000)) },
    ...(opts.files ? { files: opts.files } : {}),
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
      getJobOutputs: async (jobId) => opts.outputs?.[jobId] ?? [],
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

// -- slice 4: review queue and what to play (AC-GP-13/14, service part) ------------------------------------------------

test("the review queue lists attempts that passed the stage before review, waiting first, with the validator's rows and the verdict", async () => {
  const m = withMedia([running()]);
  await m.services.createPlan(basePlan());
  await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1", groupId: "C1" });
  for (const j of m.jobs) j.status = "done";
  await m.services.report({
    planId: "R-0001-S1-music",
    rows: [
      { stageId: "postprocess", itemKey: "C1/F1", attemptRef: "job:job-1", result: "done", auditionFile: "R-0001/C1/final-1.mp3" },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "job:job-1", result: "accepted", checks: [check], metrics: { lufs: -14 } },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "job:job-2", result: "accepted" },
    ],
  });
  await m.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:job-2", result: "accepted", rating: 8 });
  const queue = await m.services.reviewQueue({ planId: "R-0001-S1-music" });
  assert.deepEqual(queue.entries.map((e) => [e.attemptRef, e.verdict?.result ?? null]), [["job:job-1", null], ["job:job-2", "accepted"]]);
  const first = queue.entries[0];
  assert.deepEqual(first.stages.map((r) => r.stageId), ["postprocess", "validate"], "in stage order");
  assert.equal(first.seed, 1001);
  assert.deepEqual(first.params, { prompt: "koto, slow", duration: 120 });
  assert.equal(first.playable, true);
});

test("AC-GP-14 (service): the audition is the latest reported auditionFile, else the attempt's own job output; never another plan's or an unknown attempt", async () => {
  const m = withMedia([running()], { outputs: { "job-1": [{ kind: "audio", localPath: "/ws/99 Data Exchange/From YTM/media/job-1/a.mp3", filename: "a.mp3" }] } });
  await m.services.createPlan(basePlan());
  await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1", groupId: "C1" });
  assert.deepEqual(await m.services.resolveAudition({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:job-1" }), { channelId: CHANNEL, kind: "job", jobId: "job-1", localPath: "/ws/99 Data Exchange/From YTM/media/job-1/a.mp3" });
  await m.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "postprocess", itemKey: "C1/F1", attemptRef: "job:job-1", result: "done", auditionFile: "R-0001/C1/final-1.mp3" }] });
  assert.deepEqual(await m.services.resolveAudition({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:job-1" }), { channelId: CHANNEL, kind: "sent", relativePath: "R-0001/C1/final-1.mp3" });
  await assert.rejects(m.services.resolveAudition({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:job-2" }), refused("plan_mismatch"), "job-2 has no output on this device");
  await assert.rejects(m.services.resolveAudition({ planId: "R-0001-S1-music", itemKey: "C2/F1", attemptRef: "job:job-1" }), refused("plan_mismatch"), "job-1 is not C2/F1's attempt");
  await assert.rejects(m.services.resolveAudition({ planId: "other-plan", itemKey: "C1/F1", attemptRef: "job:job-1" }), refused("plan_not_found"));
});

// -- independent review fixes ---------------------------------------------------------------------------------------------

test("review A2: two concurrent run_stage calls (or a retry) create the missing jobs once, not twice", async () => {
  const m = withMedia([running()]);
  await m.services.createPlan(basePlan());
  const [a, b] = await Promise.all([m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" }), m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" })]);
  assert.equal(a.created.length + b.created.length, 4, "C1/F1: 2 seeds, C2/F1: target 2");
  assert.equal(m.createdJobs.length, 4);
});

test("review A2: a run that would create more than 200 jobs is refused whole", async () => {
  const m = withMedia([running()]);
  await m.services.createPlan({ ...basePlan(), items: [{ itemKey: "C1/F1", groupId: "C1", templateId: "tpl-noseed", targetCount: 201, params: { prompt: "x" } }] });
  await assert.rejects(m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" }), refused("plan_mismatch"));
  assert.equal(m.createdJobs.length, 0);
});

test("review A3: a relayed verdict cannot replace the owner's own verdict on the same attempt", async () => {
  const job = { id: "j1", sessionId: "s1", stageId: "generate", itemKey: "C1/F1", seed: 1001, status: "done" as const, error: null, createdAt: new Date("2026-10-07T09:00:00Z"), submittedAt: new Date("2026-10-07T09:00:00Z"), finishedAt: new Date("2026-10-07T09:05:00Z"), planId: "R-0001-S1-music", channelId: CHANNEL };
  const s = setup({ jobs: [job] });
  await s.services.createPlan(basePlan());
  await s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected" });
  await assert.rejects(s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "owner_review", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] }), refused("plan_mismatch"));
  assert.equal([...s.results.values()][0].result, "rejected");
  // A relayed verdict on an attempt the owner has not judged is fine.
  await s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "owner_review", itemKey: "C1/F1", attemptRef: "job:j2", result: "accepted" }] });
});

test("review B1/B2: an item with seeds is never run without one; rerun keeps maxAttempts and the seed rule", async () => {
  const m = withMedia([running()]);
  await m.services.createPlan({ ...basePlan(), items: [{ itemKey: "C2/F1", groupId: "C2", templateId: "tpl-ace", targetCount: 3, mode: "until_accepted", maxAttempts: 4, params: { prompt: "x" }, seeds: [1, 2] }] });
  const run = await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" });
  assert.deepEqual(run.created.map((c) => c.seed), [1, 2]);
  assert.deepEqual(run.skipped, [{ itemKey: "C2/F1", missing: 1, reason: "no unused seed left; add seeds with factory_plan_update" }]);
  await assert.rejects(m.services.rerun({ planId: "R-0001-S1-music", sessionId: "s1", itemKey: "C2/F1" }), refused("plan_mismatch"), "no unused seed");
  await m.services.rerun({ planId: "R-0001-S1-music", sessionId: "s1", itemKey: "C2/F1", seed: 3 });
  await m.services.rerun({ planId: "R-0001-S1-music", sessionId: "s1", itemKey: "C2/F1", seed: 4 });
  await assert.rejects(m.services.rerun({ planId: "R-0001-S1-music", sessionId: "s1", itemKey: "C2/F1", seed: 5 }), refused("plan_mismatch"), "4 attempts = maxAttempts");
});

test("re-review: the cursor of a complete page looks back 60 s, so an event stamped just before it was written is not passed", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  const page = await s.services.getPlan({ planId: "R-0001-S1-music" });
  assert.equal(page.more, false);
  const asked = Date.parse(page.events.at(-1)!.at);
  assert.ok(Date.parse(page.cursor) <= asked - 50_000, "the cursor is about a minute before the newest event");
});

// -- phase 2 (GENERATION_PLANS_PHASE_2_PLAN.md) --------------------------------------------------------------------------

test("AC-GP2-01: the shared view of this device's plans has no absolute path and no item params; plans closed over 30 days ago are left out", async () => {
  const m = withMedia([running()], { outputs: { "job-1": [{ kind: "audio", localPath: "/Volumes/SSD/ws/99 Data Exchange/From YTM/media/job-1/take 1.mp3", filename: "take 1.mp3" }] } });
  await m.services.createPlan(basePlan());
  await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1", groupId: "C1" });
  for (const j of m.jobs) j.status = "done";
  await m.services.report({ planId: "R-0001-S1-music", rows: ["job:job-1", "job:job-2"].map((attemptRef) => ({ stageId: "validate", itemKey: "C1/F1", attemptRef, result: "accepted" })) });
  await m.services.createPlan({ ...basePlan(), planId: "old-plan" });
  await m.services.closePlan({ planId: "old-plan", status: "completed" });
  // 31 days later the old plan is no longer shared.
  const shared = await m.services.buildSharedPlans();
  assert.deepEqual(shared.map((p) => p.planId).sort(), ["R-0001-S1-music", "old-plan"]);
  clockMs += 31 * 24 * 60 * 60_000;
  const later = await m.services.buildSharedPlans();
  assert.deepEqual(later.map((p) => p.planId), ["R-0001-S1-music"]);
  const plan = later[0];
  assert.equal(JSON.stringify(plan).includes("/Volumes/"), false, "no absolute path");
  assert.equal(plan.items.some((i) => "params" in i), false, "items carry no params");
  assert.deepEqual(plan.review.map((r) => [r.attemptRef, r.jobOutput]), [["job:job-1", "media/job-1/take 1.mp3"], ["job:job-2", null]]);
  const { generationPlansReportSchema } = await import("@/lib/sync-gateway");
  assert.equal(generationPlansReportSchema.safeParse({ format: "ytm-generation-plans", version: 1, deviceId: "mac", hostname: null, updatedAt: new Date(clockMs).toISOString(), plans: later, verdicts: [] }).success, true, "a valid report");
});

/** Two devices: "mac" owns the plan; "win" sees it through mac's report and sends verdicts back in its own. */
function twoDevices() {
  const reports: Record<string, GenerationPlansReport> = {};
  let ids = 0;
  const device = (deviceId: string, base: ReturnType<typeof withMedia> | ReturnType<typeof setup>) =>
    createGenerationPlanServices({
      store: base.store,
      channels: { isConnected: async (id) => id === CHANNEL },
      clock: { now: () => new Date((clockMs += 1000)) },
      generateId: () => `verdict-${++ids}`,
      deviceLabel: async () => (deviceId === "mac" ? "Mac" : "Windows PC"),
      peers: { ownDeviceId: async () => deviceId, listPeerReports: async () => Object.values(reports).filter((r) => r.deviceId !== deviceId) },
      media: { getSession: async () => null, linkSession: async () => true, validateJobParams: async () => ({ parameterNames: [] }), getJobOutputs: async () => [], createJob: async () => ({ jobId: "x" }) },
    });
  const macBase = setup({ jobs: [{ id: "j1", sessionId: "s1", stageId: "generate", itemKey: "C1/F1", seed: 1001, status: "done", error: null, createdAt: new Date("2026-10-07T09:00:00Z"), submittedAt: new Date("2026-10-07T09:00:00Z"), finishedAt: new Date("2026-10-07T09:05:00Z"), planId: "R-0001-S1-music", channelId: CHANNEL }] });
  const winBase = setup();
  const mac = device("mac", macBase);
  const win = device("win", winBase);
  const publish = async (deviceId: string, services: typeof mac) => {
    reports[deviceId] = { format: "ytm-generation-plans", version: 2, deviceId, hostname: deviceId === "mac" ? "Mac" : "Windows PC", updatedAt: new Date(clockMs).toISOString(), plans: await services.buildSharedPlans(), verdicts: await services.outgoingVerdicts(), claims: await services.ownClaims() };
  };
  return { mac, win, macBase, winBase, publish, reports };
}

test("AC-GP2-03/04: a verdict given on Windows for a Mac plan travels in Windows' report and the Mac applies it once, as the owner's", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await d.publish("mac", d.mac);
  const peerPlans = await d.win.peerPlans();
  assert.deepEqual(peerPlans.map((r) => [r.deviceId, r.hostname, r.stale, r.plans.map((p) => p.planId)]), [["mac", "Mac", false, ["R-0001-S1-music"]]]);
  const verdict = await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", rating: 4, reasons: ["thin / sparse"], note: "too thin" });
  assert.equal(verdict.verdictId, "verdict-1");
  await d.publish("win", d.win);
  assert.deepEqual(d.reports.win.verdicts.map((v) => [v.planId, v.result]), [["R-0001-S1-music", "rejected"]]);
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 1, skipped: 0 });
  const row = [...d.macBase.results.values()].find((r) => r.stageId === "owner_review")!;
  assert.deepEqual([row.reportedBy, row.result, row.rating, row.reasons, row.note], ["owner", "rejected", 4, ["thin / sparse"], "too thin (from Windows PC)"]);
  // Idempotent per verdictId (independent review): the same verdict again is passed over, nothing changes.
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 0, skipped: 0 }, "the same verdict again changes nothing");
  assert.equal(d.macBase.events.filter((e) => e.kind === "peer_verdict").length, 1);
});

test("AC-GP2-04: the Mac skips a peer verdict older than its own stored verdict, and ones for unknown attempts or closed plans", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await d.publish("mac", d.mac);
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected" });
  await d.publish("win", d.win);
  // The owner, on the Mac itself, decides later: that newer verdict stands.
  // Changed requirement (BL-157, SERVERS_MEDIA_PLAN.md AC-TC-04): a verdict on its way from Windows already counts, so the Mac
  // replaces it only when the owner confirmed (`replace`); the rule this test checks -- newest wins -- is unchanged.
  await d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", rating: 8, replace: true });
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 0, skipped: 1 });
  assert.equal([...d.macBase.results.values()].find((r) => r.stageId === "owner_review")?.result, "accepted");
  // Changed requirement (BL-157, AC-TC-05 "every verdict is kept"): the older Windows verdict does not replace the Mac's but
  // is kept in the history and handled once, so the next tick no longer weighs it (it was skipped again on every tick).
  assert.deepEqual((await d.macBase.store.listVerdictHistory("R-0001-S1-music")).map((h) => [h.device, h.result]), [["Windows PC", "rejected"], ["Mac", "accepted"]]);
  // A verdict for an attempt the Mac does not have, and one for a closed plan, are skipped.
  d.reports.win.verdicts.push({ ...d.reports.win.verdicts[0], verdictId: "forged-1", attemptRef: "job:nope", at: new Date(clockMs + 60_000).toISOString() });
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 0, skipped: 1 });
  await d.mac.closePlan({ planId: "R-0001-S1-music", status: "completed" });
  d.reports.win.verdicts[0] = { ...d.reports.win.verdicts[0], at: new Date(clockMs + 120_000).toISOString() };
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 0, skipped: 2 });
});

test("AC-GP2-03: a verdict on a peer plan is refused for an unknown device or plan, an attempt not in its report, or a plan closed there", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await d.publish("mac", d.mac);
  const base = { deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" };
  await assert.rejects(d.win.recordPeerVerdict({ ...base, deviceId: "linux" }), refused("plan_not_found"));
  await assert.rejects(d.win.recordPeerVerdict({ ...base, planId: "other-plan" }), refused("plan_not_found"));
  await assert.rejects(d.win.recordPeerVerdict({ ...base, attemptRef: "job:j9" }), refused("plan_mismatch"));
  await d.mac.closePlan({ planId: "R-0001-S1-music", status: "completed" });
  await d.publish("mac", d.mac);
  await assert.rejects(d.win.recordPeerVerdict(base), refused("plan_closed"));
  assert.equal(d.winBase.peerVerdicts.length, 0);
});

test("AC-GP2-05 (service): another device's attempt plays its latest reported auditionFile, else its job output; nothing else", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await d.publish("mac", d.mac);
  // The Mac's report had no output for j1 (no media port output here): nothing to play.
  await assert.rejects(d.win.resolvePeerAudition({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1" }), refused("plan_mismatch"));
  d.reports.mac.plans[0].review[0].jobOutput = "media/j1/take.mp3";
  assert.deepEqual(await d.win.resolvePeerAudition({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1" }), { channelId: CHANNEL, kind: "job", jobId: "j1", localPath: "media/j1/take.mp3" });
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "postprocess", itemKey: "C1/F1", attemptRef: "job:j1", result: "done", auditionFile: "R-0001/C1/final.mp3" }] });
  await d.publish("mac", d.mac);
  assert.deepEqual(await d.win.resolvePeerAudition({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1" }), { channelId: CHANNEL, kind: "sent", relativePath: "R-0001/C1/final.mp3" });
  await assert.rejects(d.win.resolvePeerAudition({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j2" }), refused("plan_mismatch"));
  await assert.rejects(d.win.resolvePeerAudition({ deviceId: "linux", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1" }), refused("plan_not_found"));
});

test("phase 2 review: a 2000-character peer note still gives a publishable report; verdicts for another device, from the future, or a fake sender are not applied", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await d.publish("mac", d.mac);
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", note: "n".repeat(2000) });
  await d.publish("win", d.win);
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 1, skipped: 0 });
  const stored = [...d.macBase.results.values()].find((r) => r.stageId === "owner_review")!;
  assert.ok(stored.note!.length <= 2000 && stored.note!.endsWith("(from Windows PC)"));
  const { generationPlansReportSchema } = await import("@/lib/sync-gateway");
  await d.publish("mac", d.mac);
  assert.equal(generationPlansReportSchema.safeParse(d.reports.mac).success, true, "the owning device's report stays valid");
  // Addressed to another device, or dated in the future: not applied.
  d.reports.win.verdicts.push({ ...d.reports.win.verdicts[0], verdictId: "for-linux", ownerDeviceId: "linux", at: new Date(clockMs + 1000).toISOString() });
  d.reports.win.verdicts.push({ ...d.reports.win.verdicts[0], verdictId: "future", result: "accepted", at: new Date(clockMs + 3_600_000).toISOString() });
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 0, skipped: 1 });
  assert.equal([...d.macBase.results.values()].find((r) => r.stageId === "owner_review")?.result, "rejected");
});

test("phase 2 review: a later verdict in the same second as the stored one is still applied (ids differ)", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await d.publish("mac", d.mac);
  const first = await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected" });
  await d.publish("win", d.win);
  d.reports.win.verdicts.push({ ...first, verdictId: "second-same-second", result: "accepted", at: new Date(Date.parse(first.at) + 300).toISOString() });
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 2, skipped: 0 });
  assert.equal([...d.macBase.results.values()].find((r) => r.stageId === "owner_review")?.result, "accepted", "applied oldest first, so the later one stands");
});

test("AC-GP3-02: the waiting count is this device's active plans plus other devices' active plans, minus verdicts already sent", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  // BL-153 (AC-RR-03, a changed contract): the summary also splits the count into passed and rejected.
  assert.deepEqual(await d.mac.summary(), { waitingReview: 1, waitingPassed: 1, waitingRejected: 0, local: 1, otherDevices: 0 });
  await d.publish("mac", d.mac);
  assert.deepEqual(await d.win.summary(), { waitingReview: 1, waitingPassed: 1, waitingRejected: 0, local: 0, otherDevices: 1 });
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" });
  assert.deepEqual(await d.win.summary(), { waitingReview: 0, waitingPassed: 0, waitingRejected: 0, local: 0, otherDevices: 0 }, "sent from here: no longer waiting");
});

// -- phase 3, A/B references (FO-MSG-0009, GENERATION_PLANS_PHASE_3_PLAN.md AC-GP3-07) ----------------------------------

test("AC-GP3-07: plan references are kept as given; a report may name only existing ones; a reference resolves to its Sent to YTM file", async () => {
  const s = setup();
  const ref = { id: "koto-01", label: "Koto-led, slow", file: "reference/koto-01.mp3", lufs: -13.2 };
  await s.services.createPlan({ ...basePlan(), references: [ref] });
  const got = await s.services.getPlan({ planId: "R-0001-S1-music" });
  assert.deepEqual(got.plan.references, [{ ...ref, lra: null, truePeak: null }]);
  await assert.rejects(s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:a", result: "accepted", referenceIds: ["piano-02"] }] }), refused("plan_mismatch"));
  await s.services.updatePlan({ planId: "R-0001-S1-music", upsertReferences: [{ id: "piano-02", label: "Felt piano", file: "reference/piano-02.mp3" }] });
  await s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:a", result: "accepted", referenceIds: ["piano-02"] }] });
  assert.deepEqual([...s.results.values()][0].referenceIds, ["piano-02"]);
  assert.deepEqual(await s.services.resolveReference({ planId: "R-0001-S1-music", id: "koto-01" }), { channelId: CHANNEL, kind: "sent", relativePath: "reference/koto-01.mp3" });
  await assert.rejects(s.services.resolveReference({ planId: "R-0001-S1-music", id: "nope" }), refused("plan_mismatch"));
  await assert.rejects(s.services.createPlan({ ...basePlan(), planId: "p2", references: [{ id: "x", label: "x", file: "../escape.mp3" }] }), refused("validation_failed"));
  await assert.rejects(s.services.createPlan({ ...basePlan(), planId: "p3", references: [ref, ref] }), refused("plan_invalid"), "duplicate id");
  await s.services.updatePlan({ planId: "R-0001-S1-music", removeReferenceIds: ["koto-01"] });
  assert.deepEqual((await s.services.getPlan({ planId: "R-0001-S1-music" })).plan.references?.map((r) => r.id), ["piano-02"]);
});

test("phase 3 review: references come in with an import, and more than 50 are refused (a report must stay valid)", async () => {
  const s = setup();
  const file = { ...planFile([]), references: [{ id: "koto-01", label: "Koto", file: "reference/koto-01.mp3", lufs: -13 }] };
  const imported = await s.services.importPlan({ plan: file });
  assert.deepEqual(imported.plan.references?.map((r) => r.id), ["koto-01"]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, label: `R${i}`, file: `reference/r${i}.mp3` }));
  await s.services.updatePlan({ planId: "R-0001-S1-music", upsertReferences: many });
  await assert.rejects(s.services.updatePlan({ planId: "R-0001-S1-music", upsertReferences: many.map((r) => ({ ...r, id: `x${r.id}` })) }), refused("plan_invalid"));
});

test("re-review: exactly 50 references are accepted; getPlan latest returns the newest events", async () => {
  const s = setup();
  const fifty = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, label: `R${i}`, file: `reference/r${i}.mp3` }));
  await s.services.createPlan({ ...basePlan(), references: fifty });
  for (let i = 0; i < 3; i++) await s.services.requestRerun({ planId: "R-0001-S1-music", itemKey: "C1/F1", note: `n${i}` });
  const latest = await s.services.getPlan({ planId: "R-0001-S1-music", latest: true });
  assert.equal(latest.plan.references?.length, 50);
  assert.equal(latest.events.at(-1)?.details.note, "n2", "the newest event is last");
});

// -- BL-153 (docs/roadmap/plans/REVIEW_REJECTED_PLAN.md, FO-REQ-0008): validator-rejected attempts in the owner's queue ------
// Written before the code, from the plan's acceptance criteria AC-RR-01..08.

const RR_PLAN = "R-0001-S1-music";
const rrJob = (id: string, itemKey: string) => ({ id, sessionId: "s1", stageId: "generate", itemKey, seed: null, status: "done" as const, error: null, createdAt: new Date("2026-10-08T09:00:00Z"), submittedAt: new Date("2026-10-08T09:00:00Z"), finishedAt: new Date("2026-10-08T09:05:00Z"), planId: RR_PLAN, channelId: CHANNEL });
const failCheck = (id: string, value: number, threshold: number) => ({ id, label: id, value, threshold, pass: false, severity: "fail" as const });
const warnCheck = (id: string, value: number, threshold: number) => ({ id, label: id, value, threshold, pass: false, severity: "warn" as const });

/** C1/F1 and C2/F1 attempts: p1 passed; r1 rejected with two failed checks (playable job); r2 rejected with one failed check
 * (playable by its audition file only -- an imported attempt); r3 rejected with no audio and no job; f1 failed at the validator. */
async function rrSetup(reviewRejected: boolean | undefined) {
  const s = setup({ jobs: [rrJob("p1", "C2/F1"), rrJob("r1", "C2/F1"), rrJob("f1", "C2/F1")] });
  await s.services.createPlan({ ...basePlan(), ...(reviewRejected === undefined ? {} : { reviewRejected }) });
  await s.services.report({
    planId: RR_PLAN,
    rows: [
      { stageId: "validate", itemKey: "C2/F1", attemptRef: "job:p1", result: "accepted", auditionFile: "R-0001/C2/p1.mp3" },
      { stageId: "validate", itemKey: "C2/F1", attemptRef: "job:r1", result: "rejected", auditionFile: "R-0001/C2/r1.mp3", checks: [failCheck("loop", 0.53, 0.36), failCheck("held", 0.86, 0.84), warnCheck("width", 1, 0.9)] },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:r2", result: "rejected", auditionFile: "R-0001/C1/r2.mp3", checks: [failCheck("loop", 0.4, 0.36)] },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:r3", result: "rejected", checks: [failCheck("loop", 0.9, 0.36)] },
      { stageId: "validate", itemKey: "C2/F1", attemptRef: "job:f1", result: "failed", auditionFile: "R-0001/C2/f1.mp3" },
    ],
  });
  return s;
}

test("AC-RR-02: without the option nothing changes -- only the passed attempt waits, even with rejects in the plan", async () => {
  for (const option of [undefined, false]) {
    const s = await rrSetup(option);
    const queue = await s.services.reviewQueue({ planId: RR_PLAN });
    assert.deepEqual(queue.entries.map((e) => e.attemptRef), ["job:p1"]);
    assert.deepEqual((await s.services.todo({ planId: RR_PLAN })).waitingReview, [{ itemKey: "C2/F1", attemptRef: "job:p1", validator: "passed" }]);
    const view = await s.services.getPlan({ planId: RR_PLAN });
    assert.equal(view.plan.reviewRejected ?? false, false);
    assert.deepEqual(view.progress.notices.filter((n) => n.kind === "review_waiting"), [{ kind: "review_waiting", count: 1, passed: 1, rejected: 0 }]);
  }
});

test("AC-RR-01/02/03/05: with the option, playable rejects wait too -- fewest failed checks first -- split counts everywhere", async () => {
  const s = await rrSetup(true);
  const view = await s.services.getPlan({ planId: RR_PLAN });
  assert.equal(view.plan.reviewRejected, true);
  const queue = await s.services.reviewQueue({ planId: RR_PLAN });
  // Waiting: the passed one, then rejects by failed `fail` checks (r2: 1, r1: 2). r3 (nothing to play) and f1 (failed) never wait.
  assert.deepEqual(queue.entries.map((e) => [e.attemptRef, e.validator]), [["job:p1", "passed"], ["ext:r2", "rejected"], ["job:r1", "rejected"]]);
  // todo keeps the passed ones in their order from before BL-153 (review round 1), then the rejects in the queue's order.
  assert.deepEqual((await s.services.todo({ planId: RR_PLAN })).waitingReview, [
    { itemKey: "C2/F1", attemptRef: "job:p1", validator: "passed" },
    { itemKey: "C1/F1", attemptRef: "ext:r2", validator: "rejected" },
    { itemKey: "C2/F1", attemptRef: "job:r1", validator: "rejected" },
  ]);
  assert.deepEqual(view.progress.notices.filter((n) => n.kind === "review_waiting"), [{ kind: "review_waiting", count: 3, passed: 1, rejected: 2 }]);
  assert.deepEqual(view.progress.items.map((i) => [i.itemKey, i.waitingReview]), [["C1/F1", 1], ["C2/F1", 2]]);
  const summary = await s.services.summary();
  assert.deepEqual([summary.waitingReview, summary.waitingPassed, summary.waitingRejected], [3, 1, 2]);
});

test("AC-RR-02: a reject still does not hold up generation -- until_accepted keeps asking for attempts", async () => {
  const s = await rrSetup(true);
  // C2/F1: until_accepted, target 2. p1 passed (pending the owner), r1 rejected (not pending), f1 failed -> missing 1, as without the option.
  const short = (await s.services.todo({ planId: RR_PLAN })).short.find((x) => x.itemKey === "C2/F1");
  assert.deepEqual(short, { itemKey: "C2/F1", groupId: "C2", missing: 1, mode: "until_accepted" });
});

test("AC-RR-04: the owner's accept of a reject counts toward the target and its event says overridesValidator; others do not", async () => {
  const s = await rrSetup(true);
  await s.services.recordOwnerVerdict({ planId: RR_PLAN, itemKey: "C2/F1", attemptRef: "job:r1", result: "accepted" });
  await s.services.recordOwnerVerdict({ planId: RR_PLAN, itemKey: "C2/F1", attemptRef: "job:p1", result: "accepted" });
  await s.services.recordOwnerVerdict({ planId: RR_PLAN, itemKey: "C1/F1", attemptRef: "ext:r2", result: "rejected" });
  const view = await s.services.getPlan({ planId: RR_PLAN });
  assert.equal(view.progress.items.find((i) => i.itemKey === "C2/F1")!.accepted, 2, "both owner accepts count, the overridden reject included");
  const verdicts = view.events.filter((e) => e.kind === "owner_verdict").map((e) => [e.details.attemptRef, e.details.overridesValidator ?? false]);
  assert.deepEqual(verdicts, [["job:r1", true], ["job:p1", false], ["ext:r2", false]]);
  // The validator's own row is kept unchanged.
  assert.equal(s.results.get(`${RR_PLAN}|validate|C2/F1|job:r1`)!.result, "rejected");
});

test("AC-RR-08: with the option, the plan is complete only once no reject waits either", async () => {
  const s = setup({ jobs: [rrJob("p1", "C1/F1"), rrJob("p2", "C1/F1"), rrJob("p3", "C2/F1"), rrJob("p4", "C2/F1"), rrJob("r1", "C2/F1")] });
  await s.services.createPlan({ ...basePlan(), reviewRejected: true });
  const accepted = ["p1", "p2", "p3", "p4"].map((id) => ({ stageId: "validate", itemKey: id === "p1" || id === "p2" ? "C1/F1" : "C2/F1", attemptRef: `job:${id}`, result: "accepted" as const }));
  await s.services.report({ planId: RR_PLAN, rows: [...accepted, { stageId: "validate", itemKey: "C2/F1", attemptRef: "job:r1", result: "rejected", auditionFile: "R-0001/C2/r1.mp3" }] });
  for (const a of accepted) await s.services.recordOwnerVerdict({ planId: RR_PLAN, itemKey: a.itemKey, attemptRef: a.attemptRef, result: "accepted" });
  const complete = async () => (await s.services.getPlan({ planId: RR_PLAN })).progress.notices.some((n) => n.kind === "plan_complete");
  assert.equal(await complete(), false, "the reject still waits for the owner");
  await s.services.recordOwnerVerdict({ planId: RR_PLAN, itemKey: "C2/F1", attemptRef: "job:r1", result: "rejected" });
  assert.equal(await complete(), true);
});

test("AC-RR-01: the factory switches the option with update (and import); the owner's switch is recorded as the owner's", async () => {
  const s = await rrSetup(undefined);
  await s.services.updatePlan({ planId: RR_PLAN, reviewRejected: true });
  assert.equal((await s.services.getPlan({ planId: RR_PLAN })).plan.reviewRejected, true);
  await s.services.updatePlan({ planId: RR_PLAN, reviewRejected: false }, "owner");
  const view = await s.services.getPlan({ planId: RR_PLAN });
  assert.equal(view.plan.reviewRejected, false);
  assert.deepEqual(view.events.filter((e) => e.kind === "plan_updated").map((e) => e.actor), ["factory", "owner"]);
  const imported = setup();
  await imported.services.importPlan({ plan: { format: "ytm-generation-plan/1", planId: "imp", title: "I", channelId: CHANNEL, reviewRejected: true, stages: STAGES, items: [{ itemKey: "A/1", targetCount: 1 }] } });
  assert.equal((await imported.services.getPlan({ planId: "imp" })).plan.reviewRejected, true);
});

test("AC-RR-03 across devices: a waiting reject of another device's plan counts as rejected here; the shared format is unchanged", async () => {
  const d = twoDevices();
  await d.mac.createPlan({ ...basePlan(), reviewRejected: true });
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", auditionFile: "R-0001/C1/j1.mp3" }] });
  await d.publish("mac", d.mac);
  // The shared entry carries no `validator` (devices on an older version read the report with a strict schema).
  const shared = d.reports.mac.plans[0].review[0] as Record<string, unknown>;
  assert.equal("validator" in shared, false);
  assert.deepEqual(await d.win.summary(), { waitingReview: 1, waitingPassed: 0, waitingRejected: 1, local: 0, otherDevices: 1 });
});

test("AC-RR-02 (review round 1): a reject is playable by an audition file reported at an earlier stage, as the screen plays it", async () => {
  const s = setup();
  await s.services.createPlan({ ...basePlan(), reviewRejected: true });
  await s.services.report({
    planId: RR_PLAN,
    rows: [
      { stageId: "postprocess", itemKey: "C1/F1", attemptRef: "ext:a", result: "done", auditionFile: "R-0001/C1/a.mp3" },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:a", result: "rejected" },
    ],
  });
  assert.deepEqual((await s.services.reviewQueue({ planId: RR_PLAN })).entries.map((e) => [e.attemptRef, e.validator, e.playable]), [["ext:a", "rejected", true]]);
});

test("review round 1: without the option the queue keeps its order from before BL-153 -- item key, then attempt", async () => {
  const s = setup({ jobs: [rrJob("b", "C2/F1"), rrJob("a", "C1/F1")] });
  await s.services.createPlan({ ...basePlan(), items: [...basePlan().items].reverse() });
  await s.services.report({ planId: RR_PLAN, rows: [{ stageId: "validate", itemKey: "C2/F1", attemptRef: "job:b", result: "accepted" }, { stageId: "validate", itemKey: "C1/F1", attemptRef: "job:a", result: "accepted" }] });
  assert.deepEqual((await s.services.reviewQueue({ planId: RR_PLAN })).entries.map((e) => e.itemKey), ["C1/F1", "C2/F1"]);
  assert.deepEqual((await s.services.todo({ planId: RR_PLAN })).waitingReview.map((w) => w.itemKey), ["C2/F1", "C1/F1"], "todo: in the order found, as before");
});

// FO-MSG-0010 note 1 (BL-154): an imported file's group titles (and dependsOn/note) are kept; a group named only by items
// keeps its id as its title, as before.
test("import keeps groups[].title (dependsOn, note) from the file -- by groupId or id; groups only named by items get their id", async () => {
  const s = setup();
  await s.services.importPlan({
    plan: {
      format: "ytm-generation-plan/1",
      planId: "imp-groups",
      title: "I",
      channelId: CHANNEL,
      stages: STAGES,
      groups: [{ groupId: "C9", title: "Wave C9 (XL sft)", note: "loud" }, { id: "C10B", title: "Wave C10B", dependsOn: "C9" }],
      items: [{ itemKey: "C9/A", group: "C9", targetCount: 1 }, { itemKey: "C10B/A", group: "C10B", targetCount: 1 }, { itemKey: "C11/A", group: "C11", targetCount: 1 }],
    },
  });
  const plan = (await s.services.getPlan({ planId: "imp-groups" })).plan;
  assert.deepEqual(plan.groups.map((g) => [g.groupId, g.title, g.dependsOn, g.note]), [
    ["C9", "Wave C9 (XL sft)", null, "loud"],
    ["C10B", "Wave C10B", "C9", null],
    ["C11", "C11", null, null],
  ]);
});

// -- BL-157 (SERVERS_MEDIA_PLAN.md §A, FO-REQ-0009 §4, FO-MSG-0011): moving a plan to another channel ----------------------
// Expected values are stated from AC-MV-01..06, not from running the code.

const TARGET = "UC_target_channel";
const TARGET_WS = "/ws/target";

/** A plan on CHANNEL with two reported audition files (one of them on two rows) and one reference: three distinct files. */
async function movablePlan(present: string[], over: { connected?: string[]; workspaces?: Record<string, string>; sessions?: FakeSession[] } = {}) {
  const checkedFiles: Array<[string, string]> = [];
  const m = withMedia(over.sessions ?? [running()], {
    connected: over.connected ?? [CHANNEL, TARGET],
    outputs: { "job-1": [{ kind: "audio", localPath: "/ws/plan/99 Data Exchange/From YTM/media/job-1/out.mp3", filename: "out.mp3" }] },
    files: {
      workspaceOf: async (channelId) => (over.workspaces ?? { [CHANNEL]: "/ws/plan", [TARGET]: TARGET_WS })[channelId] ?? null,
      async sentFileExists(workspace, relativePath) {
        checkedFiles.push([workspace, relativePath]);
        return present.includes(relativePath);
      },
    },
  });
  await m.services.createPlan({ ...basePlan(), references: [{ id: "ref-1", label: "Koto reference", file: "reference/koto-01.mp3" }] });
  await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1", groupId: "C1" });
  for (const j of m.jobs) j.status = "done";
  await m.services.report({
    planId: "R-0001-S1-music",
    rows: [
      { stageId: "postprocess", itemKey: "C1/F1", attemptRef: "job:job-1", result: "done", auditionFile: "R-0001-S1-music/C1/a.mp3" },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "job:job-1", result: "accepted", auditionFile: "R-0001-S1-music/C1/a.mp3" },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:b", result: "rejected", auditionFile: "R-0001-S1-music/C1/b.mp3" },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "job:job-2", result: "accepted" },
    ],
  });
  await m.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:job-1", result: "accepted", rating: 8 });
  return { ...m, checkedFiles };
}

const ALL_FILES = ["R-0001-S1-music/C1/a.mp3", "R-0001-S1-music/C1/b.mp3", "reference/koto-01.mp3"];

test("AC-MV-03: checkOnly checks every distinct auditionFile of every row and every reference in the TARGET channel's workspace, and changes nothing", async () => {
  const m = await movablePlan(["R-0001-S1-music/C1/a.mp3", "reference/koto-01.mp3"]);
  const eventsBefore = m.events.length;
  const answer = await m.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET, checkOnly: true });
  assert.deepEqual(answer, { planId: "R-0001-S1-music", from: CHANNEL, to: TARGET, checked: 3, missing: ["R-0001-S1-music/C1/b.mp3"], missingCount: 1, unfinishedJobs: 0, moved: false });
  assert.deepEqual(m.checkedFiles.map(([ws]) => ws), [TARGET_WS, TARGET_WS, TARGET_WS], "checked in the target's workspace only");
  assert.deepEqual(m.checkedFiles.map(([, file]) => file).sort(), ALL_FILES, "each distinct file once");
  assert.equal(m.plans.get("R-0001-S1-music")!.channelId, CHANNEL);
  assert.equal(m.events.length, eventsBefore, "no event");
});

test("AC-MV-03: a move with a missing file is refused with plan_invalid listing it, and nothing changes", async () => {
  const m = await movablePlan(["R-0001-S1-music/C1/a.mp3", "reference/koto-01.mp3"]);
  const revision = m.plans.get("R-0001-S1-music")!.revision;
  await assert.rejects(
    m.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET }),
    (e: unknown) => isDomainError(e) && e.code === "plan_invalid" && JSON.stringify((e.details as Record<string, unknown> | undefined)?.missing) === JSON.stringify(["R-0001-S1-music/C1/b.mp3"]) && (e.details as Record<string, unknown> | undefined)?.checked === 3 && (e.details as Record<string, unknown> | undefined)?.missingCount === 1
  );
  assert.equal(m.plans.get("R-0001-S1-music")!.channelId, CHANNEL);
  assert.equal(m.plans.get("R-0001-S1-music")!.revision, revision);
  assert.equal(m.events.some((e) => e.kind === "plan_moved"), false);
});

test("AC-MV-04: with every file in place the plan moves; results, verdicts, progress and spend are untouched; plan_moved { from, to, checked } is recorded", async () => {
  const m = await movablePlan(ALL_FILES);
  const before = await m.services.getPlan({ planId: "R-0001-S1-music" });
  const resultsBefore = structuredClone([...m.results.values()]);
  const answer = await m.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET });
  assert.deepEqual(answer, { planId: "R-0001-S1-music", from: CHANNEL, to: TARGET, checked: 3, missing: [], missingCount: 0, unfinishedJobs: 0, moved: true });
  const after = await m.services.getPlan({ planId: "R-0001-S1-music" });
  assert.equal(after.plan.channelId, TARGET);
  assert.deepEqual([...m.results.values()], resultsBefore, "result rows and the owner verdict unchanged");
  assert.deepEqual(after.progress.stages, before.progress.stages);
  assert.deepEqual(after.progress.items, before.progress.items);
  assert.deepEqual(after.progress.spend, before.progress.spend);
  const moved = m.events.filter((e) => e.kind === "plan_moved");
  assert.deepEqual(moved.map((e) => [e.actor, e.details]), [["factory", { from: CHANNEL, to: TARGET, checked: 3 }]]);
  assert.equal(m.jobs.every((j) => j.channelId === CHANNEL), true, "the jobs stay with the channel they ran on");
});

test("AC-MV-02: refused without a change -- closed plan, same channel, target not connected, target without a workspace, an unfinished job", async () => {
  const sameChannel = await movablePlan(ALL_FILES);
  await assert.rejects(sameChannel.services.movePlan({ planId: "R-0001-S1-music", channelId: CHANNEL }), refused("plan_invalid"), "same channel");
  await assert.rejects(sameChannel.services.movePlan({ planId: "nope-plan", channelId: TARGET }), refused("plan_not_found"));

  const notConnected = await movablePlan(ALL_FILES, { connected: [CHANNEL] });
  await assert.rejects(notConnected.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET }), refused("plan_invalid"), "target not connected");

  const noWorkspace = await movablePlan(ALL_FILES, { workspaces: { [CHANNEL]: "/ws/plan" } });
  await assert.rejects(noWorkspace.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET }), refused("plan_invalid"), "no workspace");

  const busy = await movablePlan(ALL_FILES);
  busy.jobs[0].status = "generating";
  const check = await busy.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET, checkOnly: true });
  assert.equal(check.unfinishedJobs, 1, "checkOnly still answers and reports the unfinished job");
  await assert.rejects(
    busy.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET }),
    (e: unknown) => isDomainError(e) && e.code === "plan_invalid" && (e.details as Record<string, unknown> | undefined)?.unfinishedJobs === 1,
    "an unfinished job"
  );

  const closed = await movablePlan(ALL_FILES);
  await closed.services.closePlan({ planId: "R-0001-S1-music", status: "completed" });
  await assert.rejects(closed.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET }), refused("plan_closed"), "closed plan");

  for (const m of [sameChannel, notConnected, noWorkspace, busy, closed]) {
    assert.equal(m.plans.get("R-0001-S1-music")!.channelId, CHANNEL);
    assert.equal(m.events.some((e) => e.kind === "plan_moved"), false);
  }
  await assert.rejects(sameChannel.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET, extra: 1 }), refused("validation_failed"), "unknown field");
});

test("AC-MV-05: after the move, auditionFiles and references resolve in the new channel; a job's own output in the channel the job ran on", async () => {
  const m = await movablePlan(ALL_FILES);
  await m.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET });
  assert.deepEqual(await m.services.resolveAudition({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "ext:b" }), { channelId: TARGET, kind: "sent", relativePath: "R-0001-S1-music/C1/b.mp3" });
  assert.deepEqual(await m.services.resolveReference({ planId: "R-0001-S1-music", id: "ref-1" }), { channelId: TARGET, kind: "sent", relativePath: "reference/koto-01.mp3" });
  // job-1's reported auditionFile (a job attempt) also resolves in the new channel: a reported file wins over the job output.
  assert.deepEqual(await m.services.resolveAudition({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:job-1" }), { channelId: TARGET, kind: "sent", relativePath: "R-0001-S1-music/C1/a.mp3" });
});

test("AC-MV-05: an attempt with no auditionFile plays its job's output from the channel the job ran on, after the move", async () => {
  const checked: string[] = [];
  const m = withMedia([running()], {
    connected: [CHANNEL, TARGET],
    outputs: { "job-2": [{ kind: "audio", localPath: "/ws/plan/99 Data Exchange/From YTM/media/job-2/out.mp3", filename: "out.mp3" }] },
    files: { workspaceOf: async (id) => (id === TARGET ? TARGET_WS : "/ws/plan"), sentFileExists: async (_ws, file) => (checked.push(file), true) },
  });
  await m.services.createPlan(basePlan());
  await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1", groupId: "C1" });
  for (const j of m.jobs) j.status = "done";
  await m.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET });
  assert.deepEqual(checked, [], "no auditionFile and no reference: nothing to check");
  assert.deepEqual(await m.services.resolveAudition({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:job-2" }), {
    channelId: CHANNEL,
    kind: "job",
    jobId: "job-2",
    localPath: "/ws/plan/99 Data Exchange/From YTM/media/job-2/out.mp3",
  });
});

test("AC-MV-06: after the move, runs and plan-linked sessions need the new channel; a session of the old channel is refused", async () => {
  const m = await movablePlan(ALL_FILES, { sessions: [running(), running({ sessionId: "s-new", channelId: TARGET })] });
  await m.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET });
  await assert.rejects(m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1", groupId: "C2" }), (e: unknown) => isDomainError(e), "the old channel's session");
  await assert.rejects(m.services.checkSessionLink({ planId: "R-0001-S1-music", channelId: CHANNEL }), refused("plan_mismatch"));
  await m.services.checkSessionLink({ planId: "R-0001-S1-music", channelId: TARGET });
  const run = await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s-new", groupId: "C2" });
  assert.ok(run.created.length > 0, "a session of the new channel runs the plan");
  assert.equal(m.jobs.filter((j) => j.sessionId === "s-new").every((j) => j.channelId === TARGET), true, "its jobs are of the new channel");
});

test("AC-MV-02: without the workspace port (a device that cannot check files) a move is refused", async () => {
  const m = withMedia([running()], { connected: [CHANNEL, TARGET] });
  await m.services.createPlan(basePlan());
  await assert.rejects(m.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET, checkOnly: true }), refused("plan_invalid"));
});

test("AC-RP-03: another device's job output plays from the channel the job ran on (jobChannelId), else -- a version 1 entry -- the plan's", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await d.publish("mac", d.mac);
  assert.equal(d.reports.mac.plans[0].review[0].jobChannelId, CHANNEL, "the report names the job's channel");
  // The plan moved to another channel on the Mac: its report names the new channel, the job stays with the old one.
  d.reports.mac.plans[0].channelId = "UC_target_channel";
  d.reports.mac.plans[0].review[0].jobOutput = "media/j1/take.mp3";
  assert.deepEqual(await d.win.resolvePeerAudition({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1" }), { channelId: CHANNEL, kind: "job", jobId: "j1", localPath: "media/j1/take.mp3" });
  delete d.reports.mac.plans[0].review[0].jobChannelId;
  assert.deepEqual(await d.win.resolvePeerAudition({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1" }), { channelId: "UC_target_channel", kind: "job", jobId: "j1", localPath: "media/j1/take.mp3" });
});

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-03, ADR 0004 (b)): the owner's routes show only the active channel's plans.
test("AC-SM-03: a plan is visible only to its own channel; another channel, no active channel or an unknown plan is plan_not_found", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  await s.services.assertPlanOfChannel("R-0001-S1-music", CHANNEL);
  await assert.rejects(s.services.assertPlanOfChannel("R-0001-S1-music", "UC_other"), refused("plan_not_found"));
  await assert.rejects(s.services.assertPlanOfChannel("R-0001-S1-music", null), refused("plan_not_found"));
  await assert.rejects(s.services.assertPlanOfChannel("nope-plan", CHANNEL), refused("plan_not_found"));
});

test("AC-SM-03: another device's plan is visible only to the channel its report names", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.publish("mac", d.mac);
  await d.win.assertPeerPlanOfChannel("mac", "R-0001-S1-music", CHANNEL);
  await assert.rejects(d.win.assertPeerPlanOfChannel("mac", "R-0001-S1-music", "UC_other"), refused("plan_not_found"));
  await assert.rejects(d.win.assertPeerPlanOfChannel("mac", "R-0001-S1-music", null), refused("plan_not_found"));
  await assert.rejects(d.win.assertPeerPlanOfChannel("linux", "R-0001-S1-music", CHANNEL), refused("plan_not_found"));
});

// BL-157 (SERVERS_MEDIA_PLAN.md AC-BL-01): the open Media work per connected channel -- the active channel's counts for its
// badge, every connected channel's counts, waves and notices for the switcher and the bell.
test("AC-BL-01: per-channel work -- the active channel's counts on top, every connected channel's rows, other devices' plans, unconnected channels left out", async () => {
  const d = twoDevices();
  // The Mac: R-0001 on CHANNEL with two tracks waiting in wave C1 (one passed, one rejected; the plan reviews rejects).
  await d.mac.createPlan({ ...basePlan(), reviewRejected: true });
  await d.mac.report({
    planId: "R-0001-S1-music",
    rows: [
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:r1", result: "rejected", auditionFile: "R-0001/C1/r1.mp3" },
    ],
  });
  // Windows owns a plan of another connected channel with one track waiting in no wave, and a plan of an unconnected one.
  await d.win.createPlan({ ...basePlan(), planId: "T-0001-jazz", title: "Tropico jazz", channelId: CHANNEL, groups: [], items: [{ itemKey: "J/1", targetCount: 1 }] });
  await d.win.report({ planId: "T-0001-jazz", rows: [{ stageId: "validate", itemKey: "J/1", attemptRef: "ext:t1", result: "accepted" }] });
  await d.publish("win", d.win);
  d.reports.win.plans[0].channelId = "UC_tropico";
  d.reports.win.plans.push({ ...structuredClone(d.reports.win.plans[0]), planId: "X-elsewhere", channelId: "UC_not_connected" });

  const summary = await d.mac.channelSummary({ activeChannelId: CHANNEL, connectedChannelIds: [CHANNEL, "UC_tropico"] });
  assert.deepEqual([summary.waitingReview, summary.waitingPassed, summary.waitingRejected], [2, 1, 1], "the active channel's counts");
  assert.deepEqual(summary.channels.map((c) => [c.channelId, c.waitingReview, c.waitingPassed, c.waitingRejected]), [
    [CHANNEL, 2, 1, 1],
    ["UC_tropico", 1, 1, 0],
  ]);
  const japan = summary.channels[0];
  assert.deepEqual(japan.plans, [{ planId: "R-0001-S1-music", title: "Stage 1 music", device: null, waiting: 2 }]);
  assert.deepEqual(japan.batches, [{ planId: "R-0001-S1-music", groupId: "C1", title: "Wave 1", waiting: 2 }]);
  const tropico = summary.channels[1];
  assert.deepEqual(tropico.plans, [{ planId: "T-0001-jazz", title: "Tropico jazz", device: { deviceId: "win", hostname: "Windows PC" }, waiting: 1 }]);
  assert.deepEqual(tropico.batches, [{ planId: "T-0001-jazz", groupId: null, title: "", waiting: 1 }], "a track in no wave");

  // A verdict sent from the Mac on the Windows plan no longer waits here.
  await d.mac.recordPeerVerdict({ deviceId: "win", planId: "T-0001-jazz", itemKey: "J/1", attemptRef: "ext:t1", result: "accepted" });
  const after = await d.mac.channelSummary({ activeChannelId: CHANNEL, connectedChannelIds: [CHANNEL, "UC_tropico"] });
  assert.deepEqual(after.channels[1].plans, []);
  assert.equal(after.channels[1].waitingReview, 0);

  // No active channel: zero on top, the rows are still there (fail-closed badge, the bell still sees the others).
  const none = await d.mac.channelSummary({ activeChannelId: null, connectedChannelIds: [CHANNEL] });
  assert.deepEqual([none.waitingReview, none.channels[0].waitingReview], [0, 2]);
});

test("AC-BL-01: notices other than review_waiting are listed per plan; another device's are taken from its report, well-formed known kinds only", async () => {
  const m = withMedia([running()]);
  await m.services.createPlan(basePlan());
  await m.services.runStage({ planId: "R-0001-S1-music", sessionId: "s1" });
  for (const j of m.jobs) j.status = "done";
  const summary = await m.services.channelSummary({ activeChannelId: null, connectedChannelIds: [CHANNEL] });
  // All four generate jobs done: the in-app stage reached its planned count.
  assert.deepEqual(summary.channels[0].notices, [{ planId: "R-0001-S1-music", planTitle: "Stage 1 music", device: null, notice: { kind: "stage_complete", stageId: "generate", title: "Generate" } }]);
  assert.deepEqual(
    sharedNotices({
      notices: [
        { kind: "stage_complete", stageId: "validate", title: "Validator" },
        { kind: "budget_80" },
        { kind: "attempts_exhausted", count: 3 },
        { kind: "review_waiting", count: 4, passed: 4, rejected: 0 },
        { kind: "stage_complete" },
        { kind: "made_up" },
        "text",
      ],
    }),
    [{ kind: "stage_complete", stageId: "validate", title: "Validator" }, { kind: "budget_80" }, { kind: "attempts_exhausted", count: 3 }]
  );
  assert.deepEqual(sharedNotices({}), []);
});

// BL-157 (SERVERS_MEDIA_PLAN.md AC-WV-04/05): the owner's wave note apart from the factory's, and "wave done".
test("AC-WV-04: the owner's note is ownerNote, the factory's is note; a factory upsert of the wave keeps the owner's note", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  await s.services.setGroupNote({ planId: "R-0001-S1-music", groupId: "C1", note: "all too thin" }, "owner");
  await s.services.setGroupNote({ planId: "R-0001-S1-music", groupId: "C1", note: "LM planner off" }, "factory");
  const updated = await s.services.updatePlan({ planId: "R-0001-S1-music", upsertGroups: [{ groupId: "C1", title: "Wave 1 (koto)" }] });
  // An upsert keeps what it does not name (the existing upsert rule): the factory's note stays, and so does the owner's.
  assert.deepEqual(updated.plan.groups[0], { groupId: "C1", title: "Wave 1 (koto)", dependsOn: null, note: "LM planner off", ownerNote: "all too thin" });
  const events = (await s.services.getPlan({ planId: "R-0001-S1-music" })).events.filter((e) => e.kind === "group_note");
  assert.deepEqual(events.map((e) => [e.actor, e.details]), [["owner", { groupId: "C1", note: "all too thin" }], ["factory", { groupId: "C1", note: "LM planner off" }]]);
});

test("AC-WV-05: the verdict that takes a wave's waiting count to zero records group_reviewed once, with the owner's counts and validator overrides", async () => {
  const s = setup();
  await s.services.createPlan({ ...basePlan(), reviewRejected: true });
  await s.services.report({
    planId: "R-0001-S1-music",
    rows: [
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:a", result: "accepted", auditionFile: "R-0001/C1/a.mp3" },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:b", result: "rejected", auditionFile: "R-0001/C1/b.mp3" },
      { stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:c", result: "rejected", auditionFile: "R-0001/C1/c.mp3" },
      { stageId: "validate", itemKey: "C2/F1", attemptRef: "ext:d", result: "accepted", auditionFile: "R-0001/C2/d.mp3" },
    ],
  });
  const reviewed = () => s.events.filter((e) => e.kind === "group_reviewed");
  await s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "ext:a", result: "accepted", rating: 8 });
  await s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "ext:b", result: "accepted", rating: 7 });
  assert.equal(reviewed().length, 0, "C1 still has one waiting");
  await s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "ext:c", result: "rejected", rating: 3 });
  assert.deepEqual(reviewed().map((e) => [e.actor, e.details]), [["owner", { groupId: "C1", accepted: 2, rejected: 1, overridesValidator: 1 }]]);
  // Changing a verdict in a finished wave (confirmed by the owner, AC-TC-04) does not finish it again.
  await s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "ext:c", result: "accepted", rating: 6, replace: true });
  assert.equal(reviewed().length, 1);
  // A new waiting attempt reopens the wave; finishing it again records it again.
  await s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:e", result: "accepted", auditionFile: "R-0001/C1/e.mp3" }] });
  await s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "ext:e", result: "rejected" });
  assert.deepEqual(reviewed().at(-1)?.details, { groupId: "C1", accepted: 3, rejected: 1, overridesValidator: 2 });
  assert.equal(reviewed().length, 2);
  assert.equal(reviewed().some((e) => e.details.groupId === "C2"), false, "C2 still waits");
});

test("AC-WV-05: a verdict from the other computer that finishes a wave records group_reviewed on the owning device", async () => {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await d.publish("mac", d.mac);
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", rating: 9 });
  await d.publish("win", d.win);
  await d.mac.applyPeerVerdicts();
  assert.deepEqual(d.macBase.events.filter((e) => e.kind === "group_reviewed").map((e) => e.details), [{ groupId: "C1", accepted: 1, rejected: 0, overridesValidator: 0 }]);
});

test("AC-WV-03: the review queue carries each wave's context", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  const queue = await s.services.reviewQueue({ planId: "R-0001-S1-music" });
  assert.deepEqual(queue.batches.map((b) => [b.groupId, b.title]), [["C1", "Wave 1"], ["C2", "Wave 2"]]);
});

// -- BL-157 (SERVERS_MEDIA_PLAN.md §F, FO-REQ-0009 §6): reviewing from two computers -------------------------------------
// Expected values are stated from AC-TC-01..06, not from running the code.

async function twoDevicesWithTrack() {
  const d = twoDevices();
  await d.mac.createPlan(basePlan());
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }] });
  await d.publish("mac", d.mac);
  return d;
}
const existingOf = (e: unknown) => (isDomainError(e) ? ((e.details as { existing?: Record<string, unknown> } | undefined)?.existing ?? null) : null);

test("AC-TC-04: a second verdict on the owning device is refused without replace (plan_verdict_exists, with what is there); with replace it stands", async () => {
  const d = await twoDevicesWithTrack();
  await d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", rating: 8 });
  let refusedWith: unknown = null;
  await assert.rejects(d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", rating: 3 }), (e: unknown) => ((refusedWith = e), refused("plan_verdict_exists")(e)));
  assert.deepEqual({ ...existingOf(refusedWith), at: undefined }, { result: "accepted", rating: 8, device: "Mac", at: undefined });
  await d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", rating: 3, replace: true });
  assert.equal([...d.macBase.results.values()].find((r) => r.stageId === "owner_review")?.result, "rejected");
});

test("AC-TC-04: on the other computer, a verdict the owning device shows -- or one already sent from here -- is replaced only with replace", async () => {
  const d = await twoDevicesWithTrack();
  // Sent from Windows, not applied yet: a second one from Windows asks first.
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", rating: 4 });
  let refusedWith: unknown = null;
  await assert.rejects(d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" }), (e: unknown) => ((refusedWith = e), refused("plan_verdict_exists")(e)));
  assert.deepEqual([existingOf(refusedWith)?.result, existingOf(refusedWith)?.device], ["rejected", "Windows PC"]);
  // Rated on the Mac (its report shows it): Windows asks first too, naming the Mac.
  const e = await twoDevicesWithTrack();
  await e.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", rating: 8 });
  await e.publish("mac", e.mac);
  await assert.rejects(e.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected" }), (x: unknown) => ((refusedWith = x), refused("plan_verdict_exists")(x)));
  assert.deepEqual([existingOf(refusedWith)?.result, existingOf(refusedWith)?.rating, existingOf(refusedWith)?.device], ["accepted", 8, "Mac"]);
  const verdict = await e.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", replace: true });
  assert.equal(verdict.result, "rejected");
});

test("AC-TC-03: on the owning device a verdict sent from the other computer counts as given at once ('being applied'), before its tick applies it", async () => {
  const d = await twoDevicesWithTrack();
  const waitingOnMac = async () => (await d.mac.reviewQueue({ planId: "R-0001-S1-music" })).entries.filter((x) => x.verdict === null).length;
  assert.equal(await waitingOnMac(), 1);
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", rating: 9, note: "lovely" });
  await d.publish("win", d.win);
  const [entry] = (await d.mac.reviewQueue({ planId: "R-0001-S1-music" })).entries;
  assert.deepEqual([entry.verdict?.result, entry.verdict?.rating, entry.pendingFrom], ["accepted", 9, "Windows PC"]);
  assert.equal((await d.mac.summary()).waitingReview, 0);
  assert.equal((await d.mac.channelSummary({ activeChannelId: CHANNEL, connectedChannelIds: [CHANNEL] })).waitingReview, 0);
  // Rating it on the Mac now asks first (it is already rated on Windows).
  await assert.rejects(d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected" }), (e: unknown) => refused("plan_verdict_exists")(e) && existingOf(e)?.device === "Windows PC");
  // Once applied, it is the stored verdict (no longer "being applied").
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 1, skipped: 0 });
  const [after] = (await d.mac.reviewQueue({ planId: "R-0001-S1-music" })).entries;
  assert.deepEqual([after.verdict?.result, after.pendingFrom], ["accepted", undefined]);
});

test("AC-TC-05: every verdict is kept with its device and time; the queue, the report and owner_verdict events show all of them", async () => {
  const d = await twoDevicesWithTrack();
  await d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", rating: 8, note: "nice" });
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", rating: 4, note: "thin", replace: true });
  await d.publish("win", d.win);
  await d.mac.applyPeerVerdicts();
  const [entry] = (await d.mac.reviewQueue({ planId: "R-0001-S1-music" })).entries;
  assert.equal(entry.verdict?.result, "rejected", "the newest is current");
  assert.deepEqual(entry.history?.map((h) => [h.device, h.result, h.rating, h.note]), [["Mac", "accepted", 8, "nice"], ["Windows PC", "rejected", 4, "thin"]], "the note as given (no 'from' suffix)");
  const events = (await d.mac.getPlan({ planId: "R-0001-S1-music" })).events.filter((e) => e.kind === "owner_verdict");
  assert.deepEqual(events.map((e) => [e.details.device, e.details.result, e.details.rating]), [["Mac", "accepted", 8], ["Windows PC", "rejected", 4]]);
  await d.publish("mac", d.mac);
  assert.deepEqual(d.reports.mac.plans[0].review[0].history?.map((h) => [h.device, h.result]), [["Mac", "accepted"], ["Windows PC", "rejected"]]);
});

test("AC-TC-05: a verdict from before the history existed still gives one owner_verdict event from its row", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  await s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:a", result: "accepted", auditionFile: "a.mp3" }] });
  // An owner row with no history row (stored by an older version).
  await s.store.upsertResults("R-0001-S1-music", [{ stageId: "owner_review", itemKey: "C1/F1", attemptRef: "ext:a", result: "accepted", reportedBy: "owner", note: null, rating: 7, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: "2026-10-07T09:00:00.000Z" }]);
  const events = (await s.services.getPlan({ planId: "R-0001-S1-music" })).events.filter((e) => e.kind === "owner_verdict");
  assert.deepEqual(events.map((e) => [e.details.result, e.details.rating, e.details.device]), [["accepted", 7, undefined]]);
});

test("AC-TC-01/02: a track claim reaches the owning device with the computer's name; it moves with the track, a heartbeat keeps its start, release or a verdict ends it", async () => {
  const d = await twoDevicesWithTrack();
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:b", result: "accepted", auditionFile: "b.mp3" }] });
  await d.publish("mac", d.mac);
  const claimsOnMac = async () => (await d.mac.reviewQueue({ planId: "R-0001-S1-music" })).claims;
  const first = await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:j1" });
  await d.publish("win", d.win);
  const [seen] = await claimsOnMac();
  assert.deepEqual([seen.scope, seen.itemKey, seen.attemptRef, seen.device], ["attempt", "C1/F1", "job:j1", "Windows PC"]);
  assert.equal(Date.parse(seen.until) - Date.parse(seen.since) <= 10 * 60_000 + 1000, true, "about 10 minutes");
  // Heartbeat on the same track: the start stays; moving to another track: one claim, a new start.
  await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:j1" });
  assert.equal((await d.win.ownClaims())[0].since, seen.since);
  const moved = await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "ext:b" });
  assert.equal(moved.claimId, first.claimId);
  assert.deepEqual((await d.win.ownClaims()).map((c) => c.attemptRef), ["ext:b"]);
  // A verdict on that track ends the claim; a release ends a claim too.
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "ext:b", result: "accepted" });
  assert.deepEqual(await d.win.ownClaims(), []);
  await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:j1" });
  await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:j1", release: true });
  assert.deepEqual(await d.win.ownClaims(), []);
  await d.publish("win", d.win);
  assert.deepEqual(await claimsOnMac(), [], "gone on the owning device with the next report");
});

test("AC-TC-02 / AC-WV-06: the owning device's own claims reach the other computer; a wave claim; expired, far-ahead or unknown claims are not shown", async () => {
  const d = await twoDevicesWithTrack();
  await d.mac.claimReview({ planId: "R-0001-S1-music", scope: "group", groupId: "C1" });
  await d.mac.claimReview({ planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:j1" });
  await d.publish("mac", d.mac);
  const onWin = (await d.win.claimsOn("mac", "R-0001-S1-music")).map((c) => [c.scope, c.groupId, c.attemptRef, c.device]);
  assert.deepEqual(onWin.sort(), [["attempt", null, "job:j1", "Mac"], ["group", "C1", null, "Mac"]].sort());
  // Expired (the report kept it, the clock moved on) and implausibly far ahead: not shown.
  const report = d.reports.mac;
  report.claims = [
    { ...report.claims![0], until: new Date(clockMs - 1000).toISOString() },
    { ...report.claims![1], until: new Date(clockMs + 60 * 60_000).toISOString() },
  ];
  assert.deepEqual(await d.win.claimsOn("mac", "R-0001-S1-music"), []);
  // Claims on what the plan does not have are refused.
  await assert.rejects(d.mac.claimReview({ planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:nope" }), refused("plan_mismatch"));
  await assert.rejects(d.mac.claimReview({ planId: "R-0001-S1-music", scope: "group", groupId: "C9" }), refused("plan_mismatch"));
  await assert.rejects(d.win.claimReview({ deviceId: "mac", planId: "nope-plan", scope: "group", groupId: "C1" }), refused("plan_not_found"));
  await assert.rejects(d.mac.claimReview({ planId: "R-0001-S1-music", scope: "group" }), refused("validation_failed"));
});

// Review round 1 fixes (BL-157): each test states the requirement it checks.
test("AC-TC-05: a verdict from the other computer that is OLDER than the stored one is kept in the history (not lost), handled once, and does not replace it", async () => {
  const d = await twoDevicesWithTrack();
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", rating: 3 });
  await d.publish("win", d.win);
  // The Mac owner rates it later, confirming the replacement of the one on its way.
  await d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", rating: 8, replace: true });
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 0, skipped: 1 });
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 0, skipped: 0 }, "handled once");
  const [entry] = (await d.mac.reviewQueue({ planId: "R-0001-S1-music" })).entries;
  assert.deepEqual([entry.verdict?.result, entry.verdict?.rating], ["accepted", 8], "the newer one stays current");
  assert.deepEqual(entry.history?.map((h) => [h.device, h.result, h.rating]), [["Windows PC", "rejected", 3], ["Mac", "accepted", 8]]);
  const events = (await d.mac.getPlan({ planId: "R-0001-S1-music" })).events.filter((e) => e.kind === "owner_verdict");
  assert.deepEqual(events.map((e) => e.details.device), ["Windows PC", "Mac"]);
});

test("AC-TC-01: giving up the previous track never drops the claim on the track now open", async () => {
  const d = await twoDevicesWithTrack();
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:b", result: "accepted", auditionFile: "b.mp3" }] });
  await d.publish("mac", d.mac);
  await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:j1" });
  // The screen moves on: the new claim lands first, then the old track's release arrives.
  await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "ext:b" });
  await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:j1", release: true });
  assert.deepEqual((await d.win.ownClaims()).map((c) => c.attemptRef), ["ext:b"]);
  await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "ext:b", release: true });
  assert.deepEqual(await d.win.ownClaims(), []);
});

test("AC-TC-03: on a closed plan nothing shows as 'being applied' (it would never be applied)", async () => {
  const d = await twoDevicesWithTrack();
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" });
  await d.publish("win", d.win);
  await d.mac.closePlan({ planId: "R-0001-S1-music", status: "completed" });
  const [entry] = (await d.mac.reviewQueue({ planId: "R-0001-S1-music" })).entries;
  assert.deepEqual([entry.verdict, entry.pendingFrom], [null, undefined]);
});

test("AC-MV-03: a plan changed while its files were checked is not moved (the move is asked again)", async () => {
  const checked: string[] = [];
  const m = withMedia([running()], {
    connected: [CHANNEL, TARGET],
    files: {
      workspaceOf: async (id) => (id === TARGET ? TARGET_WS : "/ws/plan"),
      // While the move checks its files, the factory adds a reference (another writer of the definition).
      async sentFileExists(_ws, file) {
        checked.push(file);
        if (checked.length === 1) {
          const plan = m.plans.get("R-0001-S1-music")!;
          m.plans.set("R-0001-S1-music", { ...plan, revision: plan.revision + 1, definition: { ...plan.definition, references: [...(plan.definition.references ?? []), { id: "late", label: "Late", file: "reference/late.mp3", lufs: null, lra: null, truePeak: null }] } });
        }
        return true;
      },
    },
  });
  await m.services.createPlan({ ...basePlan(), references: [{ id: "ref-1", label: "Koto", file: "reference/koto-01.mp3" }] });
  await assert.rejects(m.services.movePlan({ planId: "R-0001-S1-music", channelId: TARGET }), refused("plan_invalid"));
  assert.equal(m.plans.get("R-0001-S1-music")!.channelId, CHANNEL);
  assert.equal(m.events.some((e) => e.kind === "plan_moved"), false);
});

// Review round 2 fixes (BL-157).
test("AC-TC-05: a verdict stored before the history existed (v69) goes into the history first -- an older peer verdict or a replacement never hides it", async () => {
  const d = await twoDevicesWithTrack();
  // The Mac's verdict from an older version: an owner row with no history row.
  await d.macBase.store.upsertResults("R-0001-S1-music", [{ stageId: "owner_review", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", reportedBy: "owner", note: "warm", rating: 8, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: new Date(clockMs + 1000).toISOString() }]);
  // Windows had rated it earlier; its verdict arrives after the upgrade (older than the Mac's).
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", rating: 3 });
  await d.publish("win", d.win);
  d.reports.win.verdicts[0] = { ...d.reports.win.verdicts[0], at: new Date(clockMs - 60_000).toISOString() };
  await d.mac.applyPeerVerdicts();
  const [entry] = (await d.mac.reviewQueue({ planId: "R-0001-S1-music" })).entries;
  assert.deepEqual(entry.history?.map((h) => [h.device, h.result, h.rating, h.note]), [["Windows PC", "rejected", 3, null], ["Mac", "accepted", 8, "warm"]]);
  const events = (await d.mac.getPlan({ planId: "R-0001-S1-music" })).events.filter((e) => e.kind === "owner_verdict");
  assert.deepEqual(events.map((e) => [e.details.device, e.details.result]), [["Windows PC", "rejected"], ["Mac", "accepted"]], "the current verdict's event is still there");
  await assert.rejects(d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected" }), (e: unknown) => refused("plan_verdict_exists")(e) && existingOf(e)?.device === "Mac", "the current verdict is named by its own computer");
});

test("AC-TC-05: replacing a verdict stored before the history existed keeps it in the history, with the device its note names", async () => {
  const s = setup();
  await s.services.createPlan(basePlan());
  await s.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:a", result: "accepted", auditionFile: "a.mp3" }] });
  await s.store.upsertResults("R-0001-S1-music", [{ stageId: "owner_review", itemKey: "C1/F1", attemptRef: "ext:a", result: "rejected", reportedBy: "owner", note: "too thin (from Windows PC)", rating: 4, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: "2026-10-07T09:00:00.000Z" }]);
  // As every applied peer verdict did (round 3: the suffix names a device only when such an event proves it).
  await s.store.insertEvent("R-0001-S1-music", { at: "2026-10-07T09:00:01.000Z", kind: "peer_verdict", actor: "owner", details: { verdictId: "v-old", fromDevice: "Windows PC", itemKey: "C1/F1", result: "rejected" } });
  await s.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "ext:a", result: "accepted", rating: 9, replace: true });
  const history = await s.store.listVerdictHistory("R-0001-S1-music");
  // The old verdict names Windows in its note; the new one was given here (no device label wired: the device id).
  assert.deepEqual(history.map((h) => [h.device, h.result, h.note]), [["Windows PC", "rejected", "too thin"], ["this-device", "accepted", null]]);
});

test("AC-TC-01: a release and the next track's claim sent at the same time keep the claim on the new track", async () => {
  const d = await twoDevicesWithTrack();
  await d.mac.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:b", result: "accepted", auditionFile: "b.mp3" }] });
  await d.publish("mac", d.mac);
  await d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:j1" });
  await Promise.all([
    d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "ext:b" }),
    d.win.claimReview({ deviceId: "mac", planId: "R-0001-S1-music", scope: "attempt", itemKey: "C1/F1", attemptRef: "job:j1", release: true }),
  ]);
  assert.deepEqual((await d.win.ownClaims()).map((c) => c.attemptRef), ["ext:b"]);
});

test("AC-TC-01: a release needs no plan -- it works after the plan closed (only this device's own claim is removed)", async () => {
  const d = await twoDevicesWithTrack();
  await d.mac.claimReview({ planId: "R-0001-S1-music", scope: "group", groupId: "C1" });
  await d.mac.closePlan({ planId: "R-0001-S1-music", status: "completed" });
  await d.mac.claimReview({ planId: "R-0001-S1-music", scope: "group", groupId: "C1", release: true });
  assert.deepEqual(await d.mac.ownClaims(), []);
});

// Review round 3 fixes (BL-157).
test("AC-TC-05: two verdicts from the other computer on one attempt applied in the same tick give two history rows, not three", async () => {
  const d = await twoDevicesWithTrack();
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected", rating: 3 });
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", rating: 7, replace: true });
  await d.publish("win", d.win);
  assert.deepEqual(await d.mac.applyPeerVerdicts(), { applied: 2, skipped: 0 });
  const history = await d.macBase.store.listVerdictHistory("R-0001-S1-music");
  assert.deepEqual(history.map((h) => [h.device, h.result, h.rating]), [["Windows PC", "rejected", 3], ["Windows PC", "accepted", 7]]);
  assert.equal((await d.mac.getPlan({ planId: "R-0001-S1-music" })).events.filter((e) => e.kind === "owner_verdict").length, 2);
});

test("AC-TC-05: a note that only ends like '(from …)' is the owner's own words -- the seeded verdict is this computer's, the note kept whole", async () => {
  const long = `clipping (from ${"x".repeat(300)})`;
  for (const note of ["clipping (from 1:20)", long]) {
    const t = setup();
    await t.services.createPlan(basePlan());
    await t.services.report({ planId: "R-0001-S1-music", rows: [{ stageId: "validate", itemKey: "C1/F1", attemptRef: "ext:a", result: "accepted", auditionFile: "a.mp3" }] });
    await t.store.upsertResults("R-0001-S1-music", [{ stageId: "owner_review", itemKey: "C1/F1", attemptRef: "ext:a", result: "rejected", reportedBy: "owner", note, rating: 4, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: "2026-10-07T09:00:00.000Z" }]);
    await t.services.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "ext:a", result: "accepted", replace: true });
    const [seeded] = await t.store.listVerdictHistory("R-0001-S1-music");
    assert.deepEqual([seeded.device, seeded.note], ["this-device", note], note.slice(0, 30));
  }
});

// Review round 4 (BL-157, AC-TC-03): the owner's plan list and plan card count a verdict on its way from another device as
// given, like the queue and the badge; the factory's reads keep the plain progress.
test("AC-TC-03: the owner's plan list and plan card no longer count a track whose verdict is on its way from another device", async () => {
  const d = await twoDevicesWithTrack();
  const waitingOf = (v: { progress: { items: Array<{ itemKey: string; waitingReview: number }>; groups: Array<{ groupId: string; counts: { waitingReview: number } }>; notices: Array<{ kind: string }> } }) => [
    v.progress.items.find((i) => i.itemKey === "C1/F1")?.waitingReview,
    v.progress.groups.find((g) => g.groupId === "C1")?.counts.waitingReview,
    v.progress.notices.some((n) => n.kind === "review_waiting"),
  ];
  assert.deepEqual(waitingOf((await d.mac.listPlans({}, { ownerView: true }))[0]), [1, 1, true]);
  await d.win.recordPeerVerdict({ deviceId: "mac", planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted" });
  await d.publish("win", d.win);
  assert.deepEqual(waitingOf((await d.mac.listPlans({}, { ownerView: true }))[0]), [0, 0, false]);
  assert.deepEqual(waitingOf(await d.mac.getPlan({ planId: "R-0001-S1-music" }, { ownerView: true })), [0, 0, false]);
  assert.deepEqual(waitingOf((await d.mac.listPlans({}))[0]), [1, 1, true], "the factory's read is unchanged");
});

// Review round 5 (BL-157, AC-TC-04): "Already rated on <computer>" names the computer of the CURRENT verdict.
test("AC-TC-04: the current verdict's history row is the one of its second, result and rating -- not simply the newest", () => {
  // A peer verdict of the same second wins (AC-TC-06), so the newest row by time can be another verdict.
  const history = [
    { device: "Windows PC", result: "rejected", rating: 2, at: "2026-10-08T10:00:05.100Z" },
    { device: "Mac", result: "accepted", rating: 9, at: "2026-10-08T10:00:05.900Z" },
  ];
  assert.equal(historyEntryOfVerdict(history, { result: "rejected", rating: 2, at: "2026-10-08T10:00:05.000Z" })?.device, "Windows PC");
  assert.equal(historyEntryOfVerdict(history, { result: "accepted", rating: 9, at: "2026-10-08T10:00:05.900Z" })?.device, "Mac");
  assert.equal(historyEntryOfVerdict(history, { result: "accepted", rating: 4, at: "2026-10-08T11:00:00.000Z" })?.device, "Mac", "no match: the newest");
  assert.equal(historyEntryOfVerdict([], { result: "accepted", rating: 4, at: "2026-10-08T11:00:00.000Z" }), undefined);
});

test("AC-TC-04: a verdict from before the history (v69) is named the way the history will name it -- this computer, or a proven relay", async () => {
  const d = await twoDevicesWithTrack();
  const ownerRow = (note: string | null): PlanResultRow => ({ stageId: "owner_review", itemKey: "C1/F1", attemptRef: "job:j1", result: "accepted", reportedBy: "owner", note, rating: 8, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: "2026-10-07T09:00:00.000Z" });
  await d.macBase.store.upsertResults("R-0001-S1-music", [ownerRow("warm")]);
  await assert.rejects(d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected" }), (e: unknown) => refused("plan_verdict_exists")(e) && existingOf(e)?.device === "Mac");
  await d.macBase.store.upsertResults("R-0001-S1-music", [ownerRow("warm (from Windows PC)")]);
  await d.macBase.store.insertEvent("R-0001-S1-music", { at: "2026-10-07T09:00:01.000Z", kind: "peer_verdict", actor: "owner", details: { verdictId: "v-old", fromDevice: "Windows PC", itemKey: "C1/F1", result: "accepted" } });
  await assert.rejects(d.mac.recordOwnerVerdict({ planId: "R-0001-S1-music", itemKey: "C1/F1", attemptRef: "job:j1", result: "rejected" }), (e: unknown) => refused("plan_verdict_exists")(e) && existingOf(e)?.device === "Windows PC");
});
