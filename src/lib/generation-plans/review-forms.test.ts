import assert from "node:assert/strict";
import test from "node:test";
import { GENERATION_PLANS_REPORT_VERSION, generationPlansReportSchema, generationPlansReportVersionFor, type GenerationPlansReport, type SharedClaim, type SharedGroupNote, type SharedPickAction, type SharedVerdict } from "@/lib/sync-gateway";
import { isDomainError, type PlanEvent, type PlanPickRecord, type PlanRecheck, type PlanResultRow, type PlanVerdictHistoryRow } from "./contracts";
import type { PlanJobRow } from "./progress";
import { isGenreIcon } from "./schemas";
import { createGenerationPlanServices, type PlanStore, type StoredPlan } from "./services";

// BL-229 part B acceptance AC-MR-01..08 (docs/roadmap/plans/MUSIC_LIBRARY_PLAN.md §4.2), written from the plan, DEV-MSG-0009 and
// FO-RESP-0044 before the services were run. Every expected value is stated by hand from those rules.

function memoryStore(jobs: Array<PlanJobRow & { planId: string | null }>) {
  const plans = new Map<string, StoredPlan>();
  const results = new Map<string, PlanResultRow & { planId: string }>();
  const events: Array<PlanEvent & { planId: string }> = [];
  const peerVerdicts: SharedVerdict[] = [];
  const peerGroupNotes: SharedGroupNote[] = [];
  const history: Array<PlanVerdictHistoryRow & { planId: string }> = [];
  const claims = new Map<string, SharedClaim>();
  const rechecks: Array<PlanRecheck & { planId: string }> = [];
  // BL-175: picks, one record per (plan, item, kind, attempt); pick actions sent to other devices.
  const picks: Array<PlanPickRecord & { planId: string }> = [];
  const peerPicks: SharedPickAction[] = [];
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
    listPicks: async (planId) => picks.filter((r) => r.planId === planId).map(({ planId: _p, ...r }) => (void _p, structuredClone(r))),
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
    listPeerPicks: async (sinceIso) => peerPicks.filter((a) => a.at >= sinceIso).map((a) => structuredClone(a)),
  };
  return { store, results, events, history, rechecks, peerVerdicts };
}

const PLAN = "music-014";
const CH = "UC_japan";
const A014 = { itemKey: "014/V01", attemptRef: "job:a0140001" };
const B014 = { itemKey: "014/V02", attemptRef: "job:a0140002" };
const A015 = { itemKey: "015/V01", attemptRef: "job:a0150001" };
let clockMs = Date.parse("2026-10-27T12:00:00.000Z");

function jobsOf(): Array<PlanJobRow & { planId: string | null }> {
  const job = (id: string, itemKey: string) => ({ id, planId: PLAN, sessionId: "s1", channelId: CH, stageId: "generate", itemKey, seed: 1, status: "done" as const, error: null, createdAt: new Date("2026-10-27T08:00:00Z"), submittedAt: null, finishedAt: new Date("2026-10-27T08:05:00Z") });
  return [job("a0140001", A014.itemKey), job("a0140002", B014.itemKey), job("a0150001", A015.itemKey)];
}

function computer(opts: { deviceId: string; label: string }) {
  const mem = memoryStore(jobsOf());
  let peerReports: GenerationPlansReport[] = [];
  let ids = 0;
  const services = createGenerationPlanServices({
    store: mem.store,
    channels: { isConnected: async (id) => id === CH },
    clock: { now: () => new Date((clockMs += 1000)) },
    deviceLabel: async () => opts.label,
    generateId: () => `${opts.deviceId}-id-${String(++ids).padStart(4, "0")}`,
    peers: { ownDeviceId: async () => opts.deviceId, listPeerReports: async () => peerReports },
  });
  return {
    ...mem,
    services,
    setPeerReports: (reports: GenerationPlansReport[]) => (peerReports = reports),
    async report(): Promise<GenerationPlansReport> {
      return generationPlansReportSchema.parse({
        format: "ytm-generation-plans",
        version: 6,
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

const GENERAL_FIELDS = [
  { id: "g.no_vocals", type: "yes_no", question: "Нет вокала и голосов?", required: true },
  { id: "g.background", type: "scale_1_10", question: "Годится как спокойный фон" },
];
const GENRE = { id: "rural-japan-control", title: "Sounds of Rural Japan", color: "#4f9d69", icon: "🌾" };
const GENRE_FIELDS = [
  { id: "rj.instruments", type: "yes_no", question: "Слышно японские инструменты?", required: true },
  { id: "rj.tempo", type: "choice", question: "Темп", options: ["slower", "right", "faster"] },
];

function planInput(overrides: Record<string, unknown> = {}, wave014: Record<string, unknown> = {}) {
  return {
    planId: PLAN,
    title: "Batch 014",
    channelId: CH,
    stages: [
      { stageId: "generate", title: "Generate", kind: "in_app" },
      { stageId: "owner_review", title: "Owner review", kind: "owner_review" },
    ],
    reviewReasons: ["голос / вокал", "щелчок / провал"],
    reviewForm: { fields: GENERAL_FIELDS },
    groups: [
      { groupId: "014", title: "Batch 014", genre: GENRE, reviewReasons: ["барабаны / бит"], reviewForm: { fields: GENRE_FIELDS }, ...wave014 },
      { groupId: "015", title: "Batch 015" },
    ],
    items: [A014, B014, A015].map((a) => ({ itemKey: a.itemKey, groupId: a.itemKey.split("/")[0], templateId: "ace-step", targetCount: 1 })),
    ...overrides,
  };
}

async function created(input = planInput()) {
  const mac = computer({ deviceId: "mac-1", label: "MAC" });
  await mac.services.createPlan(input);
  return mac;
}

const refused = (code: string) => (e: unknown) => isDomainError(e) && e.code === code;
const definition = async (mac: Awaited<ReturnType<typeof created>>) => (await mac.services.getPlan({ planId: PLAN })).plan;
const ANSWERS = { "g.no_vocals": true, "rj.instruments": false, "g.background": 7, "rj.tempo": "right" };

// -- AC-MR-01 ---------------------------------------------------------------------------------------------------------------

test("AC-MR-01: the factory's own keys inside a field and a genre are stripped; an unknown key on a wave is refused", async () => {
  const mac = await created(
    planInput({}, {
      genre: { ...GENRE, profileVersion: "1.3.1" },
      reviewForm: { listen: { from: "middle", seconds: 180 }, fields: [{ ...GENRE_FIELDS[0], rule: "instruments", fails_when: "no", fails_below: 3 }, GENRE_FIELDS[1]] },
    })
  );
  const wave = (await definition(mac)).groups.find((g) => g.groupId === "014");
  assert.deepEqual(wave?.genre, { id: "rural-japan-control", title: "Sounds of Rural Japan", color: "#4f9d69", icon: "🌾" });
  assert.deepEqual(wave?.reviewForm, {
    fields: [
      { id: "rj.instruments", type: "yes_no", question: "Слышно японские инструменты?", required: true },
      { id: "rj.tempo", type: "choice", question: "Темп", options: ["slower", "right", "faster"] },
    ],
  });
  const other = computer({ deviceId: "mac-2", label: "MAC2" });
  await assert.rejects(other.services.createPlan(planInput({}, { foo: 1 })), refused("validation_failed"));
});

// -- AC-MR-02 ---------------------------------------------------------------------------------------------------------------

test("AC-MR-02: choice options 2-10 and distinct, options only on a choice, a #rrggbb colour and one emoji as the icon", async () => {
  const choice = (options: unknown) => ({ reviewForm: { fields: [{ id: "rj.tempo", type: "choice", question: "Темп", ...(options === undefined ? {} : { options }) }] } });
  const bad: Array<[string, Record<string, unknown>]> = [
    ["choice without options", choice(undefined)],
    ["one option", choice(["right"])],
    ["eleven options", choice(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"])],
    ["an option twice", choice(["right", "right"])],
    ["options on yes_no", { reviewForm: { fields: [{ id: "rj.x", type: "yes_no", question: "?", options: ["a", "b"] }] } }],
    ["an unknown type", { reviewForm: { fields: [{ id: "rj.x", type: "scale_1_5", question: "?" }] } }],
    ["colour green", { genre: { ...GENRE, color: "green" } }],
    ["icon ab", { genre: { ...GENRE, icon: "ab" } }],
    ["icon of 3 graphemes", { genre: { ...GENRE, icon: "🌾🌾🌾" } }],
  ];
  for (const [name, wave] of bad) {
    const mac = computer({ deviceId: "m", label: "M" });
    await assert.rejects(mac.services.createPlan(planInput({}, wave)), refused("validation_failed"), name);
  }
  assert.equal(isGenreIcon("🌧️"), true);
  assert.equal(isGenreIcon("🪷"), true);
  assert.equal(isGenreIcon("🌾🌾"), true, "two graphemes are allowed");
  assert.equal(isGenreIcon("👨‍👩‍👧‍👦👨‍👩‍👧‍👦"), false, "two graphemes of 22 characters are over 16");
  assert.equal(isGenreIcon("🌾a"), false);
  assert.equal(isGenreIcon(""), false);
  const ok = await created(planInput({}, choice(["slower", "right", "faster", "a", "b", "c", "d", "e", "f", "g"])));
  assert.equal((await definition(ok)).groups[0].reviewForm?.fields[0].options?.length, 10);
});

// -- AC-MR-03 ---------------------------------------------------------------------------------------------------------------

test("AC-MR-03: field ids are unique across the plan's form plus a wave's; two waves may reuse an id", async () => {
  const clash = computer({ deviceId: "m", label: "M" });
  await assert.rejects(clash.services.createPlan(planInput({}, { reviewForm: { fields: [GENERAL_FIELDS[0], GENRE_FIELDS[1]] } })), refused("plan_invalid"));
  const twice = computer({ deviceId: "m", label: "M" });
  await assert.rejects(twice.services.createPlan(planInput({}, { reviewForm: { fields: [GENRE_FIELDS[1], GENRE_FIELDS[1]] } })), refused("validation_failed"));
  const reuse = await created(planInput({ groups: [
    { groupId: "014", reviewForm: { fields: [GENRE_FIELDS[1]] } },
    { groupId: "015", reviewForm: { fields: [GENRE_FIELDS[1]] } },
  ] }));
  assert.deepEqual((await definition(reuse)).groups.map((g) => g.reviewForm?.fields[0].id), ["rj.tempo", "rj.tempo"]);
  // The same rule on an update: a wave form naming a plan question is refused, nothing changes.
  await assert.rejects(reuse.services.updatePlan({ planId: PLAN, upsertGroups: [{ groupId: "015", reviewForm: { fields: [GENERAL_FIELDS[0]] } }] }), refused("plan_invalid"));
});

// -- AC-MR-04 ---------------------------------------------------------------------------------------------------------------

test("AC-MR-04: update -- reviewForm null clears; an upsert without genre keeps it, genre null clears it; chips change mid-review", async () => {
  const mac = await created();
  await mac.services.recordOwnerVerdict({ planId: PLAN, ...A014, result: "accepted", answers: ANSWERS });
  await mac.services.updatePlan({ planId: PLAN, upsertGroups: [{ groupId: "014", title: "Batch 014 (renamed)" }] });
  let plan = await definition(mac);
  assert.deepEqual(plan.groups[0].genre, GENRE);
  assert.equal(plan.groups[0].reviewForm?.fields.length, 2);
  assert.deepEqual(plan.groups[0].reviewReasons, ["барабаны / бит"]);
  // Mid-review: the factory adds chips to the plan and to the wave (FO-RESP-0044 amendment).
  await mac.services.updatePlan({ planId: PLAN, reviewReasons: ["голос / вокал", "щелчок / провал", "обрыв в конце"], upsertGroups: [{ groupId: "014", reviewReasons: ["барабаны / бит", "синтезатор / электроника"] }] });
  const queue = await mac.services.reviewQueue({ planId: PLAN });
  assert.deepEqual(queue.reviewReasons.plan, ["голос / вокал", "щелчок / провал", "обрыв в конце"]);
  assert.deepEqual({ ...queue.reviewReasons.groups }, { "014": ["барабаны / бит", "синтезатор / электроника"] });
  assert.deepEqual(queue.reviewForms.plan.map((f) => f.id), ["g.no_vocals", "g.background"]);
  assert.deepEqual(queue.reviewForms.groups["014"], { genre: GENRE, fields: plan.groups[0].reviewForm!.fields });
  assert.equal(Object.hasOwn(queue.reviewForms.groups, "015"), false, "a wave with neither a genre nor a form is not listed");

  await mac.services.updatePlan({ planId: PLAN, reviewForm: null, upsertGroups: [{ groupId: "014", genre: null }] });
  plan = await definition(mac);
  assert.equal(plan.reviewForm, undefined);
  assert.equal(plan.groups[0].genre, undefined);
  assert.equal(plan.groups[0].reviewForm?.fields.length, 2, "the wave's form stays");
});

// -- AC-MR-05 ---------------------------------------------------------------------------------------------------------------

test("AC-MR-05: answers fit the attempt's form, each refusal has its own code, a required one counts for a reject too", async () => {
  const mac = await created();
  const verdict = (answers: Record<string, unknown>, result: "accepted" | "rejected" = "accepted", attempt = A014) => mac.services.recordOwnerVerdict({ planId: PLAN, ...attempt, result, answers });
  await assert.rejects(verdict({ ...ANSWERS, x: 1 }), refused("plan_answer_unknown_field"));
  await assert.rejects(verdict({ ...ANSWERS, "g.background": "7" }), refused("plan_answer_wrong_type"));
  await assert.rejects(verdict({ ...ANSWERS, "rj.instruments": 1 }), refused("plan_answer_wrong_type"));
  await assert.rejects(verdict({ ...ANSWERS, "rj.tempo": 2 }), refused("plan_answer_wrong_type"));
  for (const value of [0, 11, 7.5]) await assert.rejects(verdict({ ...ANSWERS, "g.background": value }), refused("plan_answer_out_of_range"), String(value));
  await assert.rejects(verdict({ ...ANSWERS, "rj.tempo": "fast" }), refused("plan_answer_unknown_option"));
  await assert.rejects(verdict({ "g.no_vocals": true }, "rejected"), (e: unknown) => refused("plan_answer_required")(e) && (e as { details: { missing: string[] } }).details.missing.join() === "rj.instruments");
  await assert.rejects(mac.services.recordOwnerVerdict({ planId: PLAN, ...A014, result: "rejected" }), refused("plan_answer_required"), "no answers at all");
  assert.equal((await mac.store.listResults(PLAN)).length, 0, "nothing stored by a refused verdict");

  const row = await verdict({ "rj.tempo": "right", "g.background": 7, "rj.instruments": false, "g.no_vocals": true });
  assert.deepEqual(row.answers, { "g.no_vocals": true, "g.background": 7, "rj.instruments": false, "rj.tempo": "right" }, "in the form's order");
  // A wave without a form: only the plan's questions -- a genre question is unknown there, the plan's required one still counts.
  await assert.rejects(verdict({ "g.no_vocals": true, "rj.tempo": "right" }, "accepted", A015), refused("plan_answer_unknown_field"));
  await assert.rejects(verdict({}, "accepted", A015), refused("plan_answer_required"));
  const plain = await verdict({ "g.no_vocals": false }, "rejected", A015);
  assert.deepEqual(plain.answers, { "g.no_vocals": false });
});

test("AC-MR-05: a plan without forms takes a verdict without answers exactly as before, and refuses any answer", async () => {
  const mac = await created(planInput({ reviewForm: undefined, groups: [{ groupId: "014" }, { groupId: "015" }] }));
  const row = await mac.services.recordOwnerVerdict({ planId: PLAN, ...A014, result: "accepted", rating: 8, reasons: ["щелчок / провал"] });
  assert.equal("answers" in row, false);
  assert.deepEqual([row.result, row.rating, row.reasons], ["accepted", 8, ["щелчок / провал"]]);
  await assert.rejects(mac.services.recordOwnerVerdict({ planId: PLAN, ...B014, result: "accepted", answers: { "g.no_vocals": true } }), refused("plan_answer_unknown_field"));
});

// -- AC-MR-06 ---------------------------------------------------------------------------------------------------------------

test("AC-MR-06: the verdict, its history row and its owner_verdict event carry the answers; a verdict without answers carries none", async () => {
  const mac = await created();
  await mac.services.recordOwnerVerdict({ planId: PLAN, ...A014, result: "accepted", rating: 9, answers: ANSWERS });
  await mac.services.recordOwnerVerdict({ planId: PLAN, ...A015, result: "rejected", answers: { "g.no_vocals": false } });
  const stored = (await mac.store.listResults(PLAN)).find((r) => r.itemKey === A014.itemKey);
  assert.deepEqual(stored?.answers, { "g.no_vocals": true, "g.background": 7, "rj.instruments": false, "rj.tempo": "right" });
  assert.deepEqual((await mac.store.listVerdictHistory(PLAN)).map((h) => h.answers), [{ "g.no_vocals": true, "g.background": 7, "rj.instruments": false, "rj.tempo": "right" }, { "g.no_vocals": false }]);
  const events = (await mac.services.getPlan({ planId: PLAN })).events.filter((e) => e.kind === "owner_verdict");
  assert.deepEqual(events.map((e) => [e.details.itemKey, e.details.result, e.details.rating ?? null, e.details.answers]), [
    ["014/V01", "accepted", 9, { "g.no_vocals": true, "g.background": 7, "rj.instruments": false, "rj.tempo": "right" }],
    ["015/V01", "rejected", null, { "g.no_vocals": false }],
  ]);
  // Without forms there is no answers key at all.
  const plain = await created(planInput({ reviewForm: undefined, groups: [{ groupId: "014" }, { groupId: "015" }] }));
  await plain.services.recordOwnerVerdict({ planId: PLAN, ...A014, result: "accepted" });
  const plainEvent = (await plain.services.getPlan({ planId: PLAN })).events.find((e) => e.kind === "owner_verdict");
  assert.equal(plainEvent && "answers" in plainEvent.details, false);
});

// -- AC-MR-07 / AC-MR-08 ----------------------------------------------------------------------------------------------------

test("AC-MR-07/08: answers given on Windows are checked against the Mac's report, sent in report v6 and applied with the verdict", async () => {
  const mac = await created();
  const macReport = await mac.report();
  const shared = macReport.plans[0];
  assert.deepEqual(shared.reviewForm?.fields.map((f) => f.id), ["g.no_vocals", "g.background"]);
  assert.deepEqual(shared.groups.find((g) => g.groupId === "014")?.genre, GENRE);
  const win = computer({ deviceId: "win-1", label: "WIN" });
  win.setPeerReports([macReport]);
  const peer = (attempt: typeof A014, answers: Record<string, unknown>, result: "accepted" | "rejected" = "accepted") => win.services.recordPeerVerdict({ deviceId: "mac-1", planId: PLAN, ...attempt, result, answers });
  await assert.rejects(peer(A014, { ...ANSWERS, x: true }), refused("plan_answer_unknown_field"));
  await assert.rejects(peer(A014, { ...ANSWERS, "g.background": 11 }), refused("plan_answer_out_of_range"));
  await assert.rejects(peer(A014, { ...ANSWERS, "rj.tempo": "fast" }), refused("plan_answer_unknown_option"));
  await assert.rejects(peer(A014, { "g.no_vocals": true }, "rejected"), refused("plan_answer_required"));
  const sent = await peer(A014, ANSWERS);
  assert.deepEqual(sent.answers, { "g.no_vocals": true, "g.background": 7, "rj.instruments": false, "rj.tempo": "right" });
  await peer(B014, { "g.no_vocals": true, "rj.instruments": true, "rj.tempo": "slower" }, "rejected");

  const winReport = await win.report();
  assert.equal(winReport.version, 6);
  assert.deepEqual(winReport.verdicts.map((v) => v.answers), [
    { "g.no_vocals": true, "g.background": 7, "rj.instruments": false, "rj.tempo": "right" },
    { "g.no_vocals": true, "rj.instruments": true, "rj.tempo": "slower" },
  ]);
  // Before the Mac applies them, the factory drops the tempo question from wave 014: that answer is dropped, the verdicts stay.
  await mac.services.updatePlan({ planId: PLAN, upsertGroups: [{ groupId: "014", reviewForm: { fields: [GENRE_FIELDS[0]] } }] });
  mac.setPeerReports([winReport]);
  assert.deepEqual(await mac.services.applyPeerVerdicts(), { applied: 2, skipped: 0 });
  const rows = (await mac.store.listResults(PLAN)).filter((r) => r.stageId === "owner_review");
  assert.deepEqual(rows.map((r) => [r.itemKey, r.result, r.answers]), [
    ["014/V01", "accepted", { "g.no_vocals": true, "g.background": 7, "rj.instruments": false }],
    ["014/V02", "rejected", { "g.no_vocals": true, "rj.instruments": true }],
  ]);
  assert.deepEqual((await mac.store.listVerdictHistory(PLAN)).map((h) => [h.device, h.answers]), [
    ["WIN", { "g.no_vocals": true, "g.background": 7, "rj.instruments": false }],
    ["WIN", { "g.no_vocals": true, "rj.instruments": true }],
  ]);
  const events = (await mac.services.getPlan({ planId: PLAN })).events.filter((e) => e.kind === "owner_verdict");
  assert.deepEqual(events.map((e) => [e.details.device, e.details.answers]), [
    ["WIN", { "g.no_vocals": true, "g.background": 7, "rj.instruments": false }],
    ["WIN", { "g.no_vocals": true, "rj.instruments": true }],
  ]);
  // The Mac's next report carries the answers in the review entries' verdict and history (read by Windows).
  const after = (await mac.report()).plans[0].review.find((e) => e.itemKey === A014.itemKey);
  assert.deepEqual(after?.verdict?.answers, { "g.no_vocals": true, "g.background": 7, "rj.instruments": false });
  assert.deepEqual(after?.history?.map((h) => h.answers), [{ "g.no_vocals": true, "g.background": 7, "rj.instruments": false }]);
});

test("AC-MR-08: this build writes report version 6 and reads 1-6; 7 is refused", async () => {
  assert.equal(GENERATION_PLANS_REPORT_VERSION, 6);
  const report = await (await created()).report();
  for (const version of [1, 2, 3, 4, 5, 6]) assert.equal(generationPlansReportSchema.safeParse({ ...report, version }).success, true, String(version));
  assert.equal(generationPlansReportSchema.safeParse({ ...report, version: 7 }).success, false);
});

test("AC-MR-08: version 6 stays strict -- an answer outside 1..10 or a form field with an extra key is not a valid report", async () => {
  const mac = await created();
  await mac.services.recordOwnerVerdict({ planId: PLAN, ...A014, result: "accepted", answers: ANSWERS });
  const report = JSON.parse(JSON.stringify(await mac.report())) as GenerationPlansReport;
  const entry = report.plans[0].review.find((e) => e.itemKey === A014.itemKey)!;
  assert.deepEqual(entry.verdict?.answers, { "g.no_vocals": true, "g.background": 7, "rj.instruments": false, "rj.tempo": "right" });
  entry.verdict!.answers = { "g.background": 11 };
  assert.equal(generationPlansReportSchema.safeParse(report).success, false);
  const again = JSON.parse(JSON.stringify(await mac.report())) as GenerationPlansReport;
  (again.plans[0].reviewForm!.fields[0] as Record<string, unknown>).rule = "x";
  assert.equal(generationPlansReportSchema.safeParse(again).success, false);
});

// -- report version follow-up: 6 only with version 6 content ----------------------------------------------------------------

/** Every key anywhere in a JSON value (to prove a version 5 report holds none of version 6's). */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

test("AC-MR-08: without forms, a genre or answers the report is written as version 5 with no version 6 key; one answer makes it 6", async () => {
  const plain = await created(planInput({ reviewForm: undefined, groups: [{ groupId: "014" }, { groupId: "015" }] }));
  await plain.services.recordOwnerVerdict({ planId: PLAN, ...A014, result: "accepted", rating: 8 });
  const plans = await plain.services.buildSharedPlans();
  const verdicts = await plain.services.outgoingVerdicts();
  assert.equal(generationPlansReportVersionFor({ plans, verdicts }), 5);
  const keys = keysOf(plans);
  for (const k of ["reviewForm", "genre", "answers"]) assert.equal(keys.has(k), false, k);

  // A form alone (no answer yet) is version 6 content.
  const formed = await created();
  assert.equal(generationPlansReportVersionFor({ plans: await formed.services.buildSharedPlans(), verdicts: [] }), 6);

  // One answer on a plan whose form was later removed: the stored answer alone still makes it 6.
  await formed.services.recordOwnerVerdict({ planId: PLAN, ...A015, result: "accepted", answers: { "g.no_vocals": true } });
  await formed.services.updatePlan({ planId: PLAN, reviewForm: null, upsertGroups: [{ groupId: "014", genre: null, reviewForm: null }] });
  const after = await formed.services.buildSharedPlans();
  assert.equal(keysOf(after).has("genre") || keysOf(after).has("reviewForm"), false);
  assert.equal(generationPlansReportVersionFor({ plans: after, verdicts: [] }), 6);

  // A verdict sent to another computer with answers is version 6 too, and without them it is not.
  const base = { verdictId: "win-0001", planId: PLAN, ownerDeviceId: "mac-1", ...A014, result: "accepted" as const, rating: null, reasons: [], markers: [], note: null, at: "2026-10-27T12:00:00.000Z" };
  assert.equal(generationPlansReportVersionFor({ plans, verdicts: [base] }), 5);
  assert.equal(generationPlansReportVersionFor({ plans, verdicts: [{ ...base, answers: { "g.no_vocals": true } }] }), 6);
});
