import assert from "node:assert/strict";
import test from "node:test";
import { generationPlansReportSchema, type GenerationPlansReport, type SharedClaim, type SharedGroupNote, type SharedVerdict } from "@/lib/sync-gateway";
import { historyEntryOfVerdict, isDomainError, type PlanEvent, type PlanRecheck, type PlanResultRow, type PlanVerdictHistoryRow } from "./contracts";
import type { PlanJobRow } from "./progress";
import { createGenerationPlanServices, type PlanStore, type StoredPlan } from "./services";

// BL-173 acceptance criteria AC-RC-01..11 (docs/roadmap/plans/PLAN_RECHECKS_PLAN.md §3), written from the plan and FO-REQ-0017
// before the services were run. Expected values are stated from those rules, not copied from a run.

function memoryStore(jobs: Array<PlanJobRow & { planId: string | null }>) {
  const plans = new Map<string, StoredPlan>();
  const results = new Map<string, PlanResultRow & { planId: string }>();
  const events: Array<PlanEvent & { planId: string }> = [];
  const peerVerdicts: SharedVerdict[] = [];
  const peerGroupNotes: SharedGroupNote[] = [];
  const history: Array<PlanVerdictHistoryRow & { planId: string }> = [];
  const claims = new Map<string, SharedClaim>();
  const rechecks: Array<PlanRecheck & { planId: string }> = [];
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
    listPeerVerdicts: async (sinceIso) => peerVerdicts.filter((v) => v.at >= sinceIso).map((v) => structuredClone(v)),
    async insertPeerGroupNote(n) {
      peerGroupNotes.push(structuredClone(n));
    },
    listPeerGroupNotes: async () => [],
    async insertVerdictHistory(planId, row) {
      history.push({ ...structuredClone(row), planId });
    },
    listVerdictHistory: async (planId) => history.filter((h) => h.planId === planId).map(strip),
    async upsertClaim(c) {
      claims.set(c.claimId, structuredClone(c));
    },
    async deleteClaim(id) {
      claims.delete(id);
    },
    listClaims: async (at) => [...claims.values()].filter((c) => Date.parse(c.until) > at.getTime()),
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
    async replaceRecheckAnswer(planId, recheckId, answer) {
      const r = rechecks.find((x) => x.planId === planId && x.recheckId === recheckId);
      if (!r || r.status !== "answered") return false;
      r.answer = structuredClone(answer);
      return true;
    },
  };
  return { store, results, events, history, rechecks, peerVerdicts };
}

const PLAN = "R-0001-S1-music";
const CH = "UC_japan";
const CH2 = "UC_tropico";
const V04 = { itemKey: "C14/V04", attemptRef: "job:8c4a4827" };
const V03 = { itemKey: "C14/V03", attemptRef: "job:22b11bf2" };
const C15 = { itemKey: "C15/V01", attemptRef: "job:c15aaaa1" };
const ORIGINAL = "R-0001-S1-music/C14/C14-XL_V04_s1811.mp3";
const REVISED = "R-0001-S1-music/C14/C14-XL_V04_s1811__r1.mp3";
const V03_FILE = "R-0001-S1-music/C14/C14-XL_V03_s1803.mp3";
let clockMs = Date.parse("2026-10-10T12:00:00.000Z");

function jobsOf(): Array<PlanJobRow & { planId: string | null }> {
  const job = (id: string, itemKey: string) => ({ id, planId: PLAN, sessionId: "s1", channelId: CH, stageId: "generate", itemKey, seed: 1, status: "done" as const, error: null, createdAt: new Date("2026-10-09T08:00:00Z"), submittedAt: null, finishedAt: new Date("2026-10-09T08:05:00Z") });
  return [job("8c4a4827", V04.itemKey), job("22b11bf2", V03.itemKey), job("c15aaaa1", C15.itemKey)];
}

/** One computer: its store, its services, the files its channel's Sent to YTM holds, and what the other computer reports. */
function computer(opts: { deviceId: string; label: string; files?: string[] }) {
  const mem = memoryStore(jobsOf());
  const files = new Set(opts.files ?? [ORIGINAL, REVISED, V03_FILE]);
  let peerReports: GenerationPlansReport[] = [];
  let ids = 0;
  const services = createGenerationPlanServices({
    store: mem.store,
    channels: { isConnected: async (id) => id === CH || id === CH2 },
    clock: { now: () => new Date((clockMs += 1000)) },
    deviceLabel: async () => opts.label,
    generateId: () => `${opts.deviceId}-id-${String(++ids).padStart(4, "0")}`,
    peers: { ownDeviceId: async () => opts.deviceId, listPeerReports: async () => peerReports },
    files: { workspaceOf: async (channelId) => `/ws/${channelId}`, sentFileExists: async (_ws, rel) => files.has(rel) },
  });
  return {
    ...mem,
    services,
    files,
    setPeerReports: (reports: GenerationPlansReport[]) => (peerReports = reports),
    /** This computer's plans report, validated as the other computer would read it. */
    async report(): Promise<GenerationPlansReport> {
      return generationPlansReportSchema.parse({
        format: "ytm-generation-plans",
        version: 4,
        deviceId: opts.deviceId,
        hostname: opts.label,
        updatedAt: new Date(clockMs).toISOString(),
        plans: await services.buildSharedPlans(),
        verdicts: await services.outgoingVerdicts(),
        claims: [],
        groupNotes: [],
      });
    },
  };
}

/** The Mac with plan R-0001-S1-music: V04 rejected by the owner, V03 accepted (8), C15/V01 not rated yet. */
async function rated() {
  const mac = computer({ deviceId: "mac-1", label: "MAC" });
  await mac.services.createPlan({
    planId: PLAN,
    title: "Stage 1 music",
    channelId: CH,
    stages: [
      { stageId: "generate", title: "Generate", kind: "in_app" },
      { stageId: "postprocess", title: "Post-process", kind: "external" },
      { stageId: "validate", title: "Validator", kind: "external" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
    ],
    groups: [{ groupId: "C14", title: "Wave C14" }, { groupId: "C15", title: "Wave C15" }],
    items: [V04, V03, C15].map((a) => ({ itemKey: a.itemKey, groupId: a.itemKey.split("/")[0], templateId: "tpl", targetCount: 1 })),
  });
  await mac.services.report({
    planId: PLAN,
    rows: [
      { stageId: "postprocess", ...V04, result: "done", auditionFile: ORIGINAL },
      { stageId: "validate", ...V04, result: "accepted", auditionFile: ORIGINAL, checks: [{ id: "harsh_db", pass: true, severity: "warn", value: 2.1 }] },
      { stageId: "postprocess", ...V03, result: "done", auditionFile: V03_FILE },
      { stageId: "validate", ...V03, result: "rejected", auditionFile: V03_FILE },
      { stageId: "postprocess", ...C15, result: "done" },
      { stageId: "validate", ...C15, result: "accepted" },
    ],
  });
  await mac.services.recordOwnerVerdict({ planId: PLAN, ...V04, result: "rejected", note: "the notes are too high" });
  await mac.services.recordOwnerVerdict({ planId: PLAN, ...V03, result: "accepted", rating: 8 });
  return mac;
}

const revision = (extra: Record<string, unknown> = {}) => ({
  planId: PLAN,
  ...V04,
  recheckId: "C14-XL_V04_s1811__r1",
  kind: "revision",
  title: "резкость",
  note: "+3-5 dB at 2-3 kHz and 6-10 kHz plus two steady tones; both bands brought back in line with the other V04 tracks",
  auditionFile: REVISED,
  checks: [{ id: "harsh_db", pass: true, severity: "warn", value: 0.4 }],
  metrics: { lufs: -16.2 },
  ...extra,
});
const question = (extra: Record<string, unknown> = {}) => ({ planId: PLAN, ...V03, recheckId: "C14-XL_V03_s1803__q1", kind: "question", title: "голос на 0:25", note: "Is there a voice at 0:25?", markers: [{ start: 25, end: 35 }], ...extra });
const refused = (code: string, reason?: string) => (e: unknown) => isDomainError(e) && e.code === code && (reason === undefined || (e.details as { reason?: unknown } | undefined)?.reason === reason);
const rowsOf = async (mac: Awaited<ReturnType<typeof rated>>, a: { itemKey: string; attemptRef: string }) => (await mac.store.listResults(PLAN)).filter((r) => r.itemKey === a.itemKey && r.attemptRef === a.attemptRef).sort((x, y) => x.stageId.localeCompare(y.stageId));
const kinds = async (mac: Awaited<ReturnType<typeof rated>>) => (await mac.services.getPlan({ planId: PLAN, latest: true })).events.map((e) => e.kind);

// -- AC-RC-01 ---------------------------------------------------------------------------------------------------------------

test("AC-RC-01: a revision on a rejected attempt is stored open with the verdict it was opened on; todo lists it; no row of the attempt changes", async () => {
  const mac = await rated();
  const before = await rowsOf(mac, V04);
  const historyBefore = await mac.store.listVerdictHistory(PLAN);
  const { recheck } = await mac.services.requestRecheck(revision());
  assert.equal(recheck.status, "open");
  assert.equal(recheck.auditionFile, REVISED);
  assert.deepEqual(
    { ...recheck.previousVerdict, at: undefined },
    { result: "rejected", rating: null, reasons: [], markers: [], note: "the notes are too high", device: "MAC", at: undefined }
  );
  assert.deepEqual(await rowsOf(mac, V04), before, "postprocess, validate and owner_review rows unchanged");
  assert.deepEqual(await mac.store.listVerdictHistory(PLAN), historyBefore);
  const todo = await mac.services.todo({ planId: PLAN });
  assert.deepEqual(todo.rechecks.map((r) => [r.recheckId, r.kind, r.itemKey, r.attemptRef]), [["C14-XL_V04_s1811__r1", "revision", V04.itemKey, V04.attemptRef]]);
  assert.deepEqual(todo.waitingReview.map((w) => w.itemKey), [C15.itemKey], "a re-check is not a waiting review");
  const requested = (await mac.services.getPlan({ planId: PLAN, latest: true })).events.filter((e) => e.kind === "recheck_requested");
  assert.deepEqual(requested.map((e) => [e.actor, e.details]), [["factory", { recheckId: "C14-XL_V04_s1811__r1", kind: "revision", itemKey: V04.itemKey, attemptRef: V04.attemptRef, title: "резкость" }]]);
});

// -- AC-RC-02 ---------------------------------------------------------------------------------------------------------------

test("AC-RC-02: every refusal of §2.2 with its code, and nothing stored", async () => {
  const mac = await rated();
  await assert.rejects(mac.services.requestRecheck(revision({ attemptRef: "job:unknown" })), refused("plan_mismatch"));
  await assert.rejects(mac.services.requestRecheck(question({ ...C15, recheckId: "c15-q1" })), refused("plan_mismatch", "not_rated"));
  await assert.rejects(mac.services.requestRecheck(revision({ auditionFile: undefined })), refused("plan_mismatch", "revision_without_file"));
  await assert.rejects(mac.services.requestRecheck(question({ auditionFile: V03_FILE })), refused("plan_mismatch", "question_with_file"));
  await assert.rejects(mac.services.requestRecheck(revision({ auditionFile: "R-0001-S1-music/C14/missing__r1.mp3" })), refused("plan_invalid", "file_missing"));
  mac.files.add("R-0001-S1-music/C14/notes__r1.txt");
  await assert.rejects(mac.services.requestRecheck(revision({ auditionFile: "R-0001-S1-music/C14/notes__r1.txt" })), refused("plan_invalid", "unsupported_type"));
  await assert.rejects(mac.services.requestRecheck(revision({ title: "x".repeat(61) })), refused("validation_failed"));
  await assert.rejects(mac.services.requestRecheck(revision({ note: "x".repeat(1001) })), refused("validation_failed"));
  assert.equal(mac.rechecks.length, 0, "nothing stored by a refusal");

  await mac.services.requestRecheck(revision());
  const events = (await kinds(mac)).length;
  const again = await mac.services.requestRecheck(revision());
  assert.equal(again.recheck.recheckId, "C14-XL_V04_s1811__r1", "the same id and content: the stored re-check");
  assert.equal((await kinds(mac)).length, events, "a retry records no second event");
  await assert.rejects(mac.services.requestRecheck(revision({ title: "другое" })), refused("plan_recheck_exists"));
  await assert.rejects(mac.services.requestRecheck(revision({ recheckId: "C14-XL_V04_s1811__r2" })), refused("plan_mismatch", "recheck_open"));
  assert.equal(mac.rechecks.length, 1);

  await mac.services.closePlan({ planId: PLAN, status: "completed" });
  await assert.rejects(mac.services.requestRecheck(question()), refused("plan_closed"));
});

test("AC-RC-02: a verdict sent from the other computer and not applied yet counts as a verdict -- the attempt can be re-checked", async () => {
  const mac = await rated();
  mac.setPeerReports([
    {
      format: "ytm-generation-plans",
      version: 4,
      deviceId: "win-1",
      hostname: "WIN",
      updatedAt: new Date(clockMs).toISOString(),
      plans: [],
      verdicts: [{ verdictId: "win-verdict-1", planId: PLAN, ownerDeviceId: "mac-1", ...C15, result: "accepted", rating: 6, reasons: [], markers: [], note: null, at: new Date(clockMs).toISOString() }],
      claims: [],
      groupNotes: [],
    },
  ]);
  const { recheck } = await mac.services.requestRecheck(question({ ...C15, recheckId: "c15-q1" }));
  assert.deepEqual([recheck.previousVerdict?.result, recheck.previousVerdict?.rating, recheck.previousVerdict?.device], ["accepted", 6, "WIN"]);
});

// -- AC-RC-03 ---------------------------------------------------------------------------------------------------------------

test("AC-RC-03: accepting a revision -- the row becomes accepted, the history keeps the old verdict and adds the new one with its id, the revised file is current", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(revision());
  const before = (await rowsOf(mac, V04)).filter((r) => r.stageId !== "owner_review");
  const acceptedBefore = (await mac.services.getPlan({ planId: PLAN })).progress.items.find((i) => i.itemKey === V04.itemKey)?.accepted;
  const groupEvents = (await kinds(mac)).filter((k) => k === "group_reviewed").length;
  const { recheck } = await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "accepted", rating: 8 });
  assert.equal(recheck.status, "answered");
  assert.deepEqual([recheck.answer?.result, recheck.answer?.kept, recheck.answer?.rating, recheck.answer?.device], ["accepted", false, 8, "MAC"]);
  const row = (await rowsOf(mac, V04)).find((r) => r.stageId === "owner_review");
  assert.deepEqual([row?.result, row?.reportedBy, row?.rating], ["accepted", "owner", 8]);
  assert.deepEqual((await rowsOf(mac, V04)).filter((r) => r.stageId !== "owner_review"), before, "the original's validate and postprocess rows unchanged");
  const history = (await mac.store.listVerdictHistory(PLAN)).filter((h) => h.itemKey === V04.itemKey);
  assert.deepEqual(
    history.map((h) => [h.result, h.rating, h.note, h.recheckId ?? null, h.kept ?? false]),
    [
      ["rejected", null, "the notes are too high", null, false],
      ["accepted", 8, null, "C14-XL_V04_s1811__r1", false],
    ]
  );
  const plan = await mac.services.getPlan({ planId: PLAN, latest: true });
  const verdicts = plan.events.filter((e) => e.kind === "owner_verdict" && e.details.itemKey === V04.itemKey);
  assert.deepEqual(verdicts.map((e) => [e.details.result, e.details.recheckId ?? null]), [["rejected", null], ["accepted", "C14-XL_V04_s1811__r1"]]);
  const answered = plan.events.filter((e) => e.kind === "recheck_answered");
  assert.deepEqual(answered.map((e) => [e.details.recheckId, e.details.kept, e.details.result, e.details.device]), [["C14-XL_V04_s1811__r1", false, "accepted", "MAC"]]);
  assert.equal(plan.events.filter((e) => e.kind === "group_reviewed").length, groupEvents, "no group_reviewed for a re-check");
  assert.equal(plan.progress.items.find((i) => i.itemKey === V04.itemKey)?.accepted, (acceptedBefore ?? 0) + 1);
  assert.deepEqual(await mac.services.resolveAudition({ planId: PLAN, ...V04 }), { channelId: CH, kind: "sent", relativePath: REVISED });
  assert.deepEqual(plan.progress.rechecks?.map((r) => [r.recheckId, r.status, r.currentFile]), [["C14-XL_V04_s1811__r1", "answered", REVISED]]);
});

test("AC-RC-03 / §2.8: a question on an attempt whose revision was accepted plays the revised file and shows that revision's row", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(revision());
  await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "accepted" });
  await mac.services.requestRecheck({ planId: PLAN, ...V04, recheckId: "C14-XL_V04_s1811__q1", kind: "question", title: "хвост", note: "Is the tail cut?", markers: [{ start: 150 }] });
  assert.deepEqual(await mac.services.resolveRecheckAudition({ planId: PLAN, recheckId: "C14-XL_V04_s1811__q1" }), { channelId: CH, kind: "sent", relativePath: REVISED });
  const { rechecks } = await mac.services.reviewQueue({ planId: PLAN });
  assert.deepEqual(rechecks.map((e) => [e.recheck.recheckId, e.stages.map((s) => s.stageId), e.verdict]), [["C14-XL_V04_s1811__q1", ["postprocess", "validate", "~recheck"], null]]);
  assert.equal(rechecks[0].stages[2].auditionFile, REVISED);
});

// -- AC-RC-04 / 05 -----------------------------------------------------------------------------------------------------------

test("AC-RC-04: a question kept with a note -- the row and counts stay, the history keeps the note as kept, no owner_verdict", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(question());
  assert.deepEqual(await mac.services.resolveRecheckAudition({ planId: PLAN, recheckId: "C14-XL_V03_s1803__q1" }), { channelId: CH, kind: "sent", relativePath: V03_FILE }, "a question plays the attempt's file");
  const row = (await rowsOf(mac, V03)).find((r) => r.stageId === "owner_review");
  const progress = (await mac.services.getPlan({ planId: PLAN })).progress;
  const verdictEvents = (await kinds(mac)).filter((k) => k === "owner_verdict").length;
  await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V03_s1803__q1", kept: true, note: "no voice heard" });
  assert.deepEqual((await rowsOf(mac, V03)).find((r) => r.stageId === "owner_review"), row, "the verdict stays as it was");
  const last = (await mac.store.listVerdictHistory(PLAN)).filter((h) => h.itemKey === V03.itemKey).at(-1);
  assert.deepEqual([last?.result, last?.rating, last?.note, last?.recheckId, last?.kept], ["accepted", null, "no voice heard", "C14-XL_V03_s1803__q1", true]);
  const plan = await mac.services.getPlan({ planId: PLAN, latest: true });
  assert.equal(plan.events.filter((e) => e.kind === "owner_verdict").length, verdictEvents, "a kept answer is not a verdict");
  assert.deepEqual(
    plan.events.filter((e) => e.kind === "recheck_answered").map((e) => e.details),
    [{ recheckId: "C14-XL_V03_s1803__q1", kind: "question", itemKey: V03.itemKey, attemptRef: V03.attemptRef, kept: true, result: "accepted", device: "MAC", note: "no voice heard" }]
  );
  assert.deepEqual(plan.progress.items, progress.items, "no count moves");
  assert.equal(plan.progress.rechecks?.[0].answer?.note, "no voice heard");
});

test("AC-RC-05: a question changed to rejected -- the row is replaced, the history keeps both, owner_verdict carries the re-check's id", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(question());
  await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V03_s1803__q1", result: "rejected", reasons: ["unwanted beat / drums"], note: "a voice at 0:26" });
  const row = (await rowsOf(mac, V03)).find((r) => r.stageId === "owner_review");
  assert.deepEqual([row?.result, row?.reasons, row?.note], ["rejected", ["unwanted beat / drums"], "a voice at 0:26"]);
  assert.deepEqual(
    (await mac.store.listVerdictHistory(PLAN)).filter((h) => h.itemKey === V03.itemKey).map((h) => [h.result, h.recheckId ?? null]),
    [["accepted", null], ["rejected", "C14-XL_V03_s1803__q1"]]
  );
  const verdicts = (await mac.services.getPlan({ planId: PLAN, latest: true })).events.filter((e) => e.kind === "owner_verdict" && e.details.itemKey === V03.itemKey);
  assert.deepEqual(verdicts.at(-1)?.details.recheckId, "C14-XL_V03_s1803__q1");
});

// -- AC-RC-06 / 07 -----------------------------------------------------------------------------------------------------------

test("AC-RC-06: an answered or withdrawn re-check refuses an answer; a revision refuses Keep; a verdict answer needs result", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(revision());
  await assert.rejects(mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", kept: true, note: "fine" }), refused("plan_mismatch", "revision_needs_verdict"));
  await assert.rejects(mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", rating: 7 }), refused("validation_failed"));
  await assert.rejects(mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", kept: true, result: "accepted" }), refused("validation_failed"));
  await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "rejected" });
  await assert.rejects(mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "accepted" }), refused("plan_recheck_closed"));
  await mac.services.requestRecheck(question());
  await mac.services.withdrawRecheck({ planId: PLAN, recheckId: "C14-XL_V03_s1803__q1" });
  await assert.rejects(mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V03_s1803__q1", kept: true }), refused("plan_recheck_closed"));
});

test("AC-RC-07: withdrawing takes the re-check out of todo and the queue, with an event; a second withdrawal is refused", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(question());
  assert.equal((await mac.services.reviewQueue({ planId: PLAN })).rechecks.length, 1);
  const { recheck } = await mac.services.withdrawRecheck({ planId: PLAN, recheckId: "C14-XL_V03_s1803__q1", note: "the detector was wrong" });
  assert.deepEqual([recheck.status, recheck.withdrawNote], ["withdrawn", "the detector was wrong"]);
  assert.deepEqual((await mac.services.todo({ planId: PLAN })).rechecks, []);
  assert.deepEqual((await mac.services.reviewQueue({ planId: PLAN })).rechecks, []);
  const withdrawn = (await mac.services.getPlan({ planId: PLAN, latest: true })).events.filter((e) => e.kind === "recheck_withdrawn");
  assert.deepEqual(withdrawn.map((e) => e.details), [{ recheckId: "C14-XL_V03_s1803__q1", itemKey: V03.itemKey, attemptRef: V03.attemptRef, note: "the detector was wrong" }]);
  await assert.rejects(mac.services.withdrawRecheck({ planId: PLAN, recheckId: "C14-XL_V03_s1803__q1" }), refused("plan_recheck_closed"));
});

// -- AC-RC-08 / 09 -----------------------------------------------------------------------------------------------------------

test("AC-RC-08: an open re-check counts per plan and per wave, never as waiting, in the notice or in the badge", async () => {
  const mac = await rated();
  const before = await mac.services.getPlan({ planId: PLAN });
  const summaryBefore = await mac.services.summary();
  await mac.services.requestRecheck(question());
  const after = await mac.services.getPlan({ planId: PLAN });
  assert.equal(after.progress.rechecksOpen, 1);
  assert.deepEqual(after.progress.groups.map((g) => [g.groupId, g.counts.rechecks, g.counts.waitingReview]), [["C14", 1, 0], ["C15", 0, 1]]);
  assert.deepEqual(after.progress.items.map((i) => i.waitingReview), before.progress.items.map((i) => i.waitingReview));
  assert.deepEqual(after.progress.notices, before.progress.notices);
  assert.deepEqual(await mac.services.summary(), summaryBefore);
  assert.equal((await mac.services.listPlans({}))[0].progress.rechecksOpen, 1, "the plan list counts it too");
});

test("AC-RC-09: a plan with an open re-check does not move; closing it withdraws the re-check with reason plan_closed", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(revision());
  await assert.rejects(mac.services.movePlan({ planId: PLAN, channelId: CH2 }), refused("plan_invalid", "recheck_open"));
  const check = await mac.services.movePlan({ planId: PLAN, channelId: CH2, checkOnly: true });
  assert.equal(check.checked, 3, "the revised file is checked with the plan's other files");
  await mac.services.closePlan({ planId: PLAN, status: "completed" });
  assert.deepEqual(mac.rechecks.map((r) => [r.status, r.closeReason]), [["withdrawn", "plan_closed"]]);
  const withdrawn = (await mac.services.getPlan({ planId: PLAN, latest: true })).events.filter((e) => e.kind === "recheck_withdrawn");
  assert.deepEqual(withdrawn.map((e) => e.details.reason), ["plan_closed"]);
});

// -- AC-RC-10 (two computers) ------------------------------------------------------------------------------------------------

test("AC-RC-10a: a version 4 report with re-checks, a current file and answers validates; version 5 is refused; version 3 still reads", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(revision());
  await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "accepted" });
  await mac.services.requestRecheck(question());
  const report = await mac.report();
  const plan = report.plans[0];
  assert.deepEqual(plan.rechecks?.map((r) => [r.recheckId, r.kind, r.markers]), [["C14-XL_V03_s1803__q1", "question", [{ start: 25, end: 35, note: null }]]], "only the open one");
  assert.equal(plan.review.find((e) => e.itemKey === V04.itemKey)?.currentFile, REVISED);
  assert.deepEqual(plan.review.find((e) => e.itemKey === V04.itemKey)?.history?.map((h) => h.recheckId ?? null), [null, "C14-XL_V04_s1811__r1"]);
  assert.equal(generationPlansReportSchema.safeParse({ ...report, version: 5 }).success, false);
  const v3 = { ...report, version: 3, plans: [{ ...plan, rechecks: undefined, review: plan.review.map((e) => ({ ...e, currentFile: undefined, history: e.history?.map((h) => ({ result: h.result, rating: h.rating, note: h.note, device: h.device, at: h.at })) })) }] };
  assert.equal(generationPlansReportSchema.safeParse(JSON.parse(JSON.stringify(v3))).success, true);
});

/** The Mac with open re-checks, and Windows reading the Mac's report. */
async function twoComputers() {
  const mac = await rated();
  await mac.services.requestRecheck(revision());
  await mac.services.requestRecheck(question());
  const win = computer({ deviceId: "win-1", label: "WIN" });
  win.setPeerReports([await mac.report()]);
  return { mac, win };
}

test("AC-RC-10b: answers given on Windows are carried with their re-check id and applied on the Mac exactly once", async () => {
  const { mac, win } = await twoComputers();
  const kept = await win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V03_s1803__q1", kept: true, note: "no voice heard" });
  assert.deepEqual([kept.recheckId, kept.kept, kept.itemKey, kept.attemptRef], ["C14-XL_V03_s1803__q1", true, V03.itemKey, V03.attemptRef]);
  await assert.rejects(win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V03_s1803__q1", result: "rejected" }), refused("plan_recheck_closed"));
  await assert.rejects(win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", kept: true }), refused("plan_mismatch", "revision_needs_verdict"));
  await win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "accepted", rating: 9 });
  assert.deepEqual((await win.services.outgoingVerdicts()).map((v) => v.recheckId), ["C14-XL_V03_s1803__q1", "C14-XL_V04_s1811__r1"]);

  const v03Row = (await rowsOf(mac, V03)).find((r) => r.stageId === "owner_review");
  mac.setPeerReports([await win.report()]);
  assert.deepEqual(await mac.services.applyPeerVerdicts(), { applied: 2, skipped: 0 });
  assert.deepEqual(mac.rechecks.map((r) => [r.recheckId, r.status, r.answer?.kept, r.answer?.device]), [
    ["C14-XL_V04_s1811__r1", "answered", false, "WIN"],
    ["C14-XL_V03_s1803__q1", "answered", true, "WIN"],
  ]);
  assert.deepEqual((await rowsOf(mac, V03)).find((r) => r.stageId === "owner_review"), v03Row, "a kept answer changes no row");
  const v04Row = (await rowsOf(mac, V04)).find((r) => r.stageId === "owner_review");
  assert.deepEqual([v04Row?.result, v04Row?.rating, v04Row?.note], ["accepted", 9, "(from WIN)"]);
  const lastV03 = (await mac.store.listVerdictHistory(PLAN)).filter((h) => h.itemKey === V03.itemKey).at(-1);
  assert.deepEqual([lastV03?.device, lastV03?.kept, lastV03?.note, lastV03?.recheckId], ["WIN", true, "no voice heard", "C14-XL_V03_s1803__q1"]);
  const history = (await mac.store.listVerdictHistory(PLAN)).length;
  assert.deepEqual(await mac.services.applyPeerVerdicts(), { applied: 0, skipped: 0 }, "a second tick changes nothing");
  assert.equal((await mac.store.listVerdictHistory(PLAN)).length, history);
});

test("AC-RC-10c: before the Mac applies a Windows answer, the Mac shows the re-check answered there and not open; it is no pending verdict of the track", async () => {
  const { mac, win } = await twoComputers();
  await win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V03_s1803__q1", result: "rejected" });
  mac.setPeerReports([await win.report()]);
  const queue = await mac.services.reviewQueue({ planId: PLAN });
  const entry = queue.rechecks.find((e) => e.recheck.recheckId === "C14-XL_V03_s1803__q1");
  assert.deepEqual([entry?.pendingFrom, entry?.verdict?.result], ["WIN", "rejected"]);
  assert.equal(queue.entries.find((e) => e.itemKey === V03.itemKey)?.pendingFrom, undefined, "the track itself shows no pending verdict");
  assert.equal((await mac.services.getPlan({ planId: PLAN }, { ownerView: true })).progress.rechecksOpen, 1, "only the revision is still open");
  await assert.rejects(mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V03_s1803__q1", kept: true }), refused("plan_recheck_closed"));
});

test("AC-RC-10d: a Windows answer to a re-check withdrawn meanwhile goes to the history with its id and changes no row", async () => {
  const { mac, win } = await twoComputers();
  await win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "accepted" });
  await mac.services.withdrawRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1" });
  const row = (await rowsOf(mac, V04)).find((r) => r.stageId === "owner_review");
  mac.setPeerReports([await win.report()]);
  await mac.services.applyPeerVerdicts();
  assert.deepEqual((await rowsOf(mac, V04)).find((r) => r.stageId === "owner_review"), row);
  assert.equal(mac.rechecks.find((r) => r.recheckId === "C14-XL_V04_s1811__r1")?.status, "withdrawn");
  const last = (await mac.store.listVerdictHistory(PLAN)).filter((h) => h.itemKey === V04.itemKey).at(-1);
  assert.deepEqual([last?.result, last?.device, last?.recheckId], ["accepted", "WIN", "C14-XL_V04_s1811__r1"]);
  const peerEvent = (await mac.services.getPlan({ planId: PLAN, latest: true })).events.find((e) => e.kind === "peer_verdict");
  assert.equal(peerEvent?.details.superseded, true);
});

// -- AC-RC-11 ----------------------------------------------------------------------------------------------------------------

test("AC-RC-11: the current verdict's history entry is never a kept answer", () => {
  const verdict = { result: "accepted", rating: 8, at: "2026-10-10T12:00:05.000Z" };
  const history = [
    { result: "accepted", rating: 8, at: "2026-10-10T12:00:05.000Z", device: "MAC" },
    { result: "accepted", rating: null, at: "2026-10-10T12:30:00.000Z", device: "WIN", kept: true },
  ];
  assert.equal(historyEntryOfVerdict(history, verdict)?.device, "MAC");
  assert.equal(historyEntryOfVerdict(history, { result: "accepted", rating: 8, at: "2026-10-10T13:00:00.000Z" })?.device, "MAC", "no exact match: the last verdict, not the kept note");
  assert.equal(historyEntryOfVerdict([history[1]], verdict), undefined);
});

// -- Review round 1 -----------------------------------------------------------------------------------------------------------

test("AC-RC-10e: two computers answer the same revision -- the newer verdict decides both the row and the current file, both stay in the history", async () => {
  // Rejected on the Mac, then accepted on Windows (later): the attempt is accepted and plays the revised file.
  {
    const { mac, win } = await twoComputers();
    await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "rejected" });
    await win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "accepted", rating: 9 });
    mac.setPeerReports([await win.report()]);
    await mac.services.applyPeerVerdicts();
    const row = (await rowsOf(mac, V04)).find((r) => r.stageId === "owner_review");
    assert.deepEqual([row?.result, row?.rating], ["accepted", 9]);
    assert.deepEqual(await mac.services.resolveAudition({ planId: PLAN, ...V04 }), { channelId: CH, kind: "sent", relativePath: REVISED });
    const view = (await mac.services.getPlan({ planId: PLAN })).progress.rechecks?.[0];
    assert.deepEqual([view?.answer?.result, view?.answer?.device, view?.currentFile], ["accepted", "WIN", REVISED]);
    assert.deepEqual(
      (await mac.store.listVerdictHistory(PLAN)).filter((h) => h.recheckId === "C14-XL_V04_s1811__r1").map((h) => [h.result, h.device]),
      [["rejected", "MAC"], ["accepted", "WIN"]]
    );
    const answered = (await mac.services.getPlan({ planId: PLAN, latest: true })).events.filter((e) => e.kind === "recheck_answered");
    assert.deepEqual(answered.map((e) => [e.details.result, e.details.replaced ?? false]), [["rejected", false], ["accepted", true]]);
  }
  // Accepted on the Mac, then rejected on Windows (later): the attempt is rejected and plays the original again.
  {
    const { mac, win } = await twoComputers();
    await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "accepted" });
    await win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "rejected" });
    mac.setPeerReports([await win.report()]);
    await mac.services.applyPeerVerdicts();
    assert.equal((await rowsOf(mac, V04)).find((r) => r.stageId === "owner_review")?.result, "rejected");
    assert.deepEqual(await mac.services.resolveAudition({ planId: PLAN, ...V04 }), { channelId: CH, kind: "sent", relativePath: ORIGINAL });
    assert.equal((await mac.services.getPlan({ planId: PLAN })).progress.rechecks?.[0].currentFile, ORIGINAL);
  }
});

test("review round 1: the attempt of an open re-check travels in the report even when 500 newer tracks wait, so Windows can play it", async () => {
  const mac = await rated();
  for (let batch = 0; batch < 3; batch++) {
    await mac.services.report({ planId: PLAN, rows: Array.from({ length: 170 }, (_, i) => ({ stageId: "validate", itemKey: C15.itemKey, attemptRef: `imp:${batch}-${i}`, result: "accepted" })) });
  }
  await mac.services.requestRecheck(question());
  const report = await mac.report();
  const review = report.plans[0].review;
  assert.equal(review.length, 500, "still within the report's bound");
  assert.ok(review.some((e) => e.itemKey === V03.itemKey && e.attemptRef === V03.attemptRef), "the re-checked attempt is there");
  const win = computer({ deviceId: "win-1", label: "WIN" });
  win.setPeerReports([report]);
  assert.deepEqual(await win.services.resolvePeerRecheckAudition({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V03_s1803__q1" }), { channelId: CH, kind: "sent", relativePath: V03_FILE });
});

test("review round 1: a kept answer sent from Windows is no verdict there -- a later re-rating of the track asks about the Mac's verdict", async () => {
  const { win } = await twoComputers();
  await win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V03_s1803__q1", kept: true, note: "no voice heard" });
  await assert.rejects(win.services.recordPeerVerdict({ deviceId: "mac-1", planId: PLAN, ...V03, result: "rejected" }), (e: unknown) => {
    const existing = (e as { details?: { existing?: { result: string; rating: number | null; device: string | null } } }).details?.existing;
    return isDomainError(e) && e.code === "plan_verdict_exists" && existing?.result === "accepted" && existing.rating === 8 && existing.device === "MAC";
  });
});

test("review round 1: a re-check opened on a verdict still on its way from Windows -- the Mac's answer writes the first row and finishes the wave", async () => {
  const mac = await rated();
  mac.setPeerReports([
    {
      format: "ytm-generation-plans",
      version: 4,
      deviceId: "win-1",
      hostname: "WIN",
      updatedAt: new Date(clockMs).toISOString(),
      plans: [],
      verdicts: [{ verdictId: "win-verdict-1", planId: PLAN, ownerDeviceId: "mac-1", ...C15, result: "accepted", rating: 6, reasons: [], markers: [], note: null, at: new Date(clockMs).toISOString() }],
      claims: [],
      groupNotes: [],
    },
  ]);
  await mac.services.requestRecheck(question({ ...C15, recheckId: "c15-q1" }));
  await mac.services.answerRecheck({ planId: PLAN, recheckId: "c15-q1", result: "rejected" });
  // (C14 was finished by the two verdicts of the setup.)
  const reviewed = (await mac.services.getPlan({ planId: PLAN, latest: true })).events.filter((e) => e.kind === "group_reviewed" && e.details.groupId === "C15");
  assert.deepEqual(reviewed.map((e) => [e.details.groupId, e.details.rejected]), [["C15", 1]]);
});

test("review round 1: the verdict a re-check is opened on keeps the owner's words, without the ' (from <computer>)' a peer verdict carries", async () => {
  const mac = await rated();
  mac.setPeerReports([
    {
      format: "ytm-generation-plans",
      version: 4,
      deviceId: "win-1",
      hostname: "WIN",
      updatedAt: new Date(clockMs).toISOString(),
      plans: [],
      verdicts: [{ verdictId: "win-verdict-2", planId: PLAN, ownerDeviceId: "mac-1", ...C15, result: "accepted", rating: 7, reasons: [], markers: [], note: "nice drone", at: new Date(clockMs).toISOString() }],
      claims: [],
      groupNotes: [],
    },
  ]);
  await mac.services.applyPeerVerdicts();
  const { recheck } = await mac.services.requestRecheck(question({ ...C15, recheckId: "c15-q2" }));
  assert.deepEqual([recheck.previousVerdict?.note, recheck.previousVerdict?.device], ["nice drone", "WIN"]);
});

test("review round 1: a withdrawn revision's file is not needed to move the plan", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(revision());
  await mac.services.withdrawRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1" });
  mac.files.delete(REVISED);
  const moved = await mac.services.movePlan({ planId: PLAN, channelId: CH2 });
  assert.deepEqual([moved.moved, moved.checked, moved.missingCount], [true, 2, 0]);
});

// -- Review round 2 -----------------------------------------------------------------------------------------------------------

test("review round 2: a late Windows answer to a re-check that a later one replaced stays in the history; the later answer keeps the row and the current file", async () => {
  const { mac, win } = await twoComputers();
  // Windows read the Mac's report while r1 was open; meanwhile the Mac rejects r1, the factory opens r2 and the Mac accepts it.
  const stale = await mac.report();
  await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "rejected" });
  const R2 = "R-0001-S1-music/C14/C14-XL_V04_s1811__r2.mp3";
  mac.files.add(R2);
  await mac.services.requestRecheck(revision({ recheckId: "C14-XL_V04_s1811__r2", auditionFile: R2, title: "резкость 2" }));
  await mac.services.answerRecheck({ planId: PLAN, recheckId: "C14-XL_V04_s1811__r2", result: "accepted", rating: 8 });
  win.setPeerReports([stale]);
  await win.services.recordPeerRecheckAnswer({ deviceId: "mac-1", planId: PLAN, recheckId: "C14-XL_V04_s1811__r1", result: "rejected" });
  mac.setPeerReports([await win.report()]);
  await mac.services.applyPeerVerdicts();
  const row = (await rowsOf(mac, V04)).find((r) => r.stageId === "owner_review");
  assert.deepEqual([row?.result, row?.rating], ["accepted", 8], "r2's answer keeps the row");
  assert.deepEqual(await mac.services.resolveAudition({ planId: PLAN, ...V04 }), { channelId: CH, kind: "sent", relativePath: R2 });
  // (twoComputers also opened the V03 question; only V04's re-checks matter here.)
  const views = ((await mac.services.getPlan({ planId: PLAN })).progress.rechecks ?? []).filter((r) => r.itemKey === V04.itemKey);
  assert.deepEqual(views.map((r) => [r.recheckId, r.answer?.result, r.answer?.device, r.currentFile]), [
    ["C14-XL_V04_s1811__r1", "rejected", "MAC", R2],
    ["C14-XL_V04_s1811__r2", "accepted", "MAC", R2],
  ]);
  const late = (await mac.store.listVerdictHistory(PLAN)).at(-1);
  assert.deepEqual([late?.recheckId, late?.device, late?.result], ["C14-XL_V04_s1811__r1", "WIN", "rejected"], "the late answer is kept");
  const peerEvent = (await mac.services.getPlan({ planId: PLAN, latest: true })).events.find((e) => e.kind === "peer_verdict");
  assert.equal(peerEvent?.details.superseded, true);
});

test("review round 2: a revision failing a fail check shows its row as rejected (its failures lead); its row id is never a plan's stage id", async () => {
  const mac = await rated();
  await mac.services.requestRecheck(revision({ checks: [{ id: "harsh_db", pass: false, severity: "fail", value: 4.2, threshold: 3 }, { id: "ring_db", pass: true, severity: "warn" }] }));
  const [entry] = (await mac.services.reviewQueue({ planId: PLAN })).rechecks;
  const row = entry.stages.at(-1);
  assert.deepEqual([row?.stageId, row?.result], ["~recheck", "rejected"]);
  assert.equal(entry.validator, "passed", "what the validator said about the attempt itself");
  await assert.rejects(mac.services.updatePlan({ planId: PLAN, addStages: [{ stageId: "~recheck", title: "x", kind: "external" }] }), refused("validation_failed"));
});
