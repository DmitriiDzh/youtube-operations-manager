import {
  closeGenerationPlanRecheck,
  deleteGenerationPlanReviewClaim,
  insertGenerationPlanRecheck,
  listGenerationPlanRechecks,
  replaceGenerationPlanRecheckAnswer,
  getGenerationPlan,
  insertGenerationPlanVerdictHistory,
  listGenerationPlanReviewClaims,
  listGenerationPlanVerdictHistory,
  upsertGenerationPlanReviewClaim,
  insertGenerationPlanPeerVerdict,
  listGenerationPlanPeerVerdicts,
  insertGenerationPlanPeerGroupNote,
  listGenerationPlanPeerGroupNotes,
  insertGenerationPlanPeerPick,
  listGenerationPlanPeerPicks,
  listGenerationPlanPicks,
  upsertGenerationPlanPicks,
  insertGenerationPlan,
  insertGenerationPlanEvent,
  linkMediaJobToPlan,
  listGenerationPlanEvents,
  listGenerationPlanResults,
  listGenerationPlans,
  listMediaJobsByPlan,
  listMediaSessionsByPlan,
  updateGenerationPlan,
  upsertGenerationPlanResults,
  type StoredGenerationPlan,
  type StoredGenerationPlanRecheck,
  type StoredGenerationPlanResult,
} from "@/lib/db";
import type { PlanDefinition, PlanEvent, PlanPickRecord, PlanRecheck, PlanRecheckAnswer, PlanRecheckVerdict, PlanResultRow } from "../contracts";
import type { PlanStore, StoredPlan } from "../services";

// BL-143: the plans module's only door to the database (DEVELOPMENT_PLAYBOOK §6.2). JSON columns are written and read only here.

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function planFromDb(row: StoredGenerationPlan): StoredPlan {
  return {
    id: row.id,
    title: row.title,
    channelId: row.channelId,
    owner: row.owner,
    status: row.status,
    budgetUsd: row.budgetUsd ?? null,
    budgetGpuMinutes: row.budgetGpuMinutes ?? null,
    note: row.note ?? null,
    definition: parseJson<PlanDefinition>(row.definitionJson, { stages: [], groups: [], items: [] }),
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt ?? null,
    video: row.video ?? null,
  };
}

function resultFromDb(row: StoredGenerationPlanResult): PlanResultRow {
  return {
    stageId: row.stageId,
    itemKey: row.itemKey,
    attemptRef: row.attemptRef,
    result: row.result as PlanResultRow["result"],
    reportedBy: row.reportedBy as PlanResultRow["reportedBy"],
    note: row.note ?? null,
    rating: row.rating ?? null,
    reasons: parseJson(row.reasonsJson, []),
    markers: parseJson(row.markersJson, []),
    auditionFile: row.auditionFile ?? null,
    checks: parseJson(row.checksJson, []),
    metrics: parseJson(row.metricsJson, {}),
    referenceIds: parseJson<string[]>(row.referenceIdsJson, []),
    at: row.at.toISOString(),
  };
}

/**
 * BL-175 (VISUAL_REVIEW_PLAN.md §2.1): the file name of the job output the review shows -- the same output `resolveAudition`
 * plays (the first audio, video or image with a local file, else the first with a local file); null = none yet.
 */
export function outputFileOf(outputsJson: string | null | undefined): string | null {
  const outputs = parseJson<Array<{ kind?: unknown; filename?: unknown; localPath?: unknown }>>(outputsJson, []);
  if (!Array.isArray(outputs)) return null;
  const local = outputs.filter((o) => o && typeof o.localPath === "string" && o.localPath.length > 0);
  const chosen = local.find((o) => o.kind === "audio" || o.kind === "video" || o.kind === "image") ?? local[0];
  if (!chosen) return null;
  const name = typeof chosen.filename === "string" && chosen.filename ? chosen.filename : String(chosen.localPath).split(/[\\/]/).pop();
  return name || null;
}

/** BL-175: a stored pick or "none fits"; an unknown kind reads as a pick (it then names its attempt). */
function pickFromDb(row: { itemKey: string; kind: string; attemptRef: string; active: number; note: string | null; device: string; at: string; coveredJson: string | null }): PlanPickRecord {
  const kind = row.kind === "none_fits" ? "none_fits" : "pick";
  return { itemKey: row.itemKey, kind, attemptRef: kind === "none_fits" ? null : row.attemptRef, active: row.active === 1, note: row.note ?? null, device: row.device, at: row.at, covered: parseJson<string[]>(row.coveredJson, []) };
}

/** BL-173: a stored re-check; an unknown kind or status reads as the safe one (a question; open). */
function recheckFromDb(row: StoredGenerationPlanRecheck): PlanRecheck {
  return {
    recheckId: row.recheckId,
    itemKey: row.itemKey,
    attemptRef: row.attemptRef,
    kind: row.kind === "revision" ? "revision" : "question",
    title: row.title,
    note: row.note,
    auditionFile: row.auditionFile ?? null,
    markers: parseJson(row.markersJson, []),
    checks: parseJson(row.checksJson, []),
    metrics: parseJson(row.metricsJson, {}),
    previousVerdict: parseJson<PlanRecheckVerdict | null>(row.previousVerdictJson, null),
    status: row.status === "answered" || row.status === "withdrawn" ? row.status : "open",
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    answer: parseJson<PlanRecheckAnswer | null>(row.answerJson, null),
    withdrawNote: row.withdrawNote ?? null,
    closeReason: row.closeReason ?? null,
  };
}

export function createPlanStore(): PlanStore {
  return {
    async insertPlan(row) {
      const inserted = await insertGenerationPlan({
        id: row.id,
        title: row.title,
        channelId: row.channelId,
        owner: row.owner,
        status: row.status,
        budgetUsd: row.budgetUsd,
        budgetGpuMinutes: row.budgetGpuMinutes,
        note: row.note,
        definitionJson: JSON.stringify(row.definition),
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        closedAt: row.closedAt,
        video: row.video ?? null,
      });
      return inserted ? planFromDb(inserted) : null;
    },
    getPlan: async (id) => {
      const row = await getGenerationPlan(id);
      return row ? planFromDb(row) : null;
    },
    listPlans: async (filter) => (await listGenerationPlans(filter)).map(planFromDb),
    async updatePlan(id, expectedRevision, set) {
      const { definition, ...rest } = set;
      const updated = await updateGenerationPlan(id, expectedRevision, { ...rest, ...(definition ? { definitionJson: JSON.stringify(definition) } : {}) });
      return updated ? planFromDb(updated) : null;
    },
    upsertResults: (planId, rows) =>
      upsertGenerationPlanResults(
        rows.map((r) => ({
          planId,
          stageId: r.stageId,
          itemKey: r.itemKey,
          attemptRef: r.attemptRef,
          result: r.result,
          reportedBy: r.reportedBy,
          note: r.note,
          rating: r.rating,
          reasonsJson: r.reasons.length > 0 ? JSON.stringify(r.reasons) : null,
          markersJson: r.markers.length > 0 ? JSON.stringify(r.markers) : null,
          auditionFile: r.auditionFile,
          checksJson: r.checks.length > 0 ? JSON.stringify(r.checks) : null,
          metricsJson: Object.keys(r.metrics).length > 0 ? JSON.stringify(r.metrics) : null,
          referenceIdsJson: r.referenceIds && r.referenceIds.length > 0 ? JSON.stringify(r.referenceIds) : null,
          at: new Date(r.at),
        }))
      ),
    listResults: async (planId) => (await listGenerationPlanResults(planId)).map(resultFromDb),
    insertEvent: (planId, event: PlanEvent) => insertGenerationPlanEvent({ planId, at: new Date(event.at), kind: event.kind, actor: event.actor, detailsJson: JSON.stringify(event.details) }),
    listEvents: async (planId) =>
      (await listGenerationPlanEvents(planId)).map((e) => ({ at: e.at.toISOString(), kind: e.kind, actor: e.actor, details: parseJson<Record<string, unknown>>(e.detailsJson, {}) })),
    listJobs: async (planId) =>
      (await listMediaJobsByPlan(planId)).map((j) => ({
        id: j.id,
        sessionId: j.sessionId,
        channelId: j.channelId,
        stageId: j.planStageId ?? null,
        itemKey: j.planItemKey ?? null,
        seed: j.planSeed ?? null,
        status: j.status,
        error: j.error ?? null,
        createdAt: j.createdAt,
        submittedAt: j.submittedAt ?? null,
        finishedAt: j.finishedAt ?? null,
        outputFile: outputFileOf(j.outputsJson),
      })),
    linkJob: (jobId, link) => linkMediaJobToPlan(jobId, link),
    insertPeerVerdict: (v) =>
      insertGenerationPlanPeerVerdict({
        verdictId: v.verdictId,
        planId: v.planId,
        ownerDeviceId: v.ownerDeviceId,
        itemKey: v.itemKey,
        attemptRef: v.attemptRef,
        result: v.result,
        rating: v.rating,
        reasonsJson: v.reasons.length > 0 ? JSON.stringify(v.reasons) : null,
        markersJson: v.markers.length > 0 ? JSON.stringify(v.markers) : null,
        note: v.note,
        at: v.at,
        recheckId: v.recheckId ?? null,
        kept: v.kept ? 1 : null,
        reviewSeconds: v.reviewSeconds ?? null,
      }),
    listPeerVerdicts: async (sinceIso) =>
      (await listGenerationPlanPeerVerdicts(sinceIso)).map((r) => ({
        verdictId: r.verdictId,
        planId: r.planId,
        ownerDeviceId: r.ownerDeviceId,
        itemKey: r.itemKey,
        attemptRef: r.attemptRef,
        result: r.result === "accepted" ? ("accepted" as const) : ("rejected" as const),
        rating: r.rating ?? null,
        reasons: parseJson(r.reasonsJson, []),
        markers: parseJson(r.markersJson, []),
        note: r.note ?? null,
        at: r.at,
        ...(r.recheckId ? { recheckId: r.recheckId } : {}),
        ...(r.kept ? { kept: true } : {}),
        ...(r.reviewSeconds !== null && r.reviewSeconds !== undefined ? { reviewSeconds: r.reviewSeconds } : {}),
      })),
    // BL-175 (VISUAL_REVIEW_PLAN.md §2.2/§2.6): picks on this device's plans, and pick actions given here on other devices' plans.
    listPicks: async (planId) => (await listGenerationPlanPicks(planId)).map(pickFromDb),
    upsertPicks: (planId, records) =>
      upsertGenerationPlanPicks(
        records.map((r) => ({
          planId,
          itemKey: r.itemKey,
          kind: r.kind,
          attemptRef: r.kind === "none_fits" ? "" : (r.attemptRef ?? ""),
          active: r.active ? 1 : 0,
          note: r.note,
          device: r.device,
          at: r.at,
          coveredJson: r.covered.length > 0 ? JSON.stringify(r.covered) : null,
        }))
      ),
    insertPeerPick: (a) =>
      insertGenerationPlanPeerPick({ pickId: a.pickId, planId: a.planId, ownerDeviceId: a.ownerDeviceId, itemKey: a.itemKey, attemptRef: a.attemptRef, action: a.action, note: a.note, at: a.at, coveredJson: a.covered ? JSON.stringify(a.covered) : null, reviewSeconds: a.reviewSeconds ?? null }),
    listPeerPicks: async (sinceIso) =>
      (await listGenerationPlanPeerPicks(sinceIso)).map((r) => ({
        pickId: r.pickId,
        planId: r.planId,
        ownerDeviceId: r.ownerDeviceId,
        itemKey: r.itemKey,
        attemptRef: r.attemptRef ?? null,
        action: r.action === "unpick" || r.action === "none_fits" || r.action === "clear_none_fits" ? r.action : ("pick" as const),
        note: r.note ?? null,
        at: r.at,
        ...(r.coveredJson ? { covered: parseJson<string[]>(r.coveredJson, []) } : {}),
        ...(r.reviewSeconds !== null && r.reviewSeconds !== undefined ? { reviewSeconds: r.reviewSeconds } : {}),
      })),
    insertPeerGroupNote: (n) => insertGenerationPlanPeerGroupNote({ noteId: n.noteId, planId: n.planId, ownerDeviceId: n.ownerDeviceId, groupId: n.groupId, note: n.note, at: n.at }),
    listPeerGroupNotes: async (sinceIso) => (await listGenerationPlanPeerGroupNotes(sinceIso)).map((r) => ({ noteId: r.noteId, planId: r.planId, ownerDeviceId: r.ownerDeviceId, groupId: r.groupId, note: r.note ?? null, at: r.at })),
    // BL-157 (AC-TC-05): the owner verdicts' history.
    insertVerdictHistory: (planId, h) =>
      insertGenerationPlanVerdictHistory({
        planId,
        itemKey: h.itemKey,
        attemptRef: h.attemptRef,
        result: h.result,
        rating: h.rating,
        reasonsJson: h.reasons.length > 0 ? JSON.stringify(h.reasons) : null,
        markersJson: h.markers.length > 0 ? JSON.stringify(h.markers) : null,
        note: h.note,
        device: h.device,
        at: h.at,
        recordedAt: new Date(),
        recheckId: h.recheckId ?? null,
        kept: h.kept ? 1 : null,
        reviewSeconds: h.reviewSeconds ?? null,
      }),
    listVerdictHistory: async (planId) =>
      (await listGenerationPlanVerdictHistory(planId)).map((h) => ({
        itemKey: h.itemKey,
        attemptRef: h.attemptRef,
        result: h.result === "accepted" ? ("accepted" as const) : ("rejected" as const),
        rating: h.rating ?? null,
        reasons: parseJson(h.reasonsJson, []),
        markers: parseJson(h.markersJson, []),
        note: h.note ?? null,
        device: h.device,
        at: h.at,
        ...(h.recheckId ? { recheckId: h.recheckId } : {}),
        ...(h.kept ? { kept: true } : {}),
        ...(h.reviewSeconds !== null && h.reviewSeconds !== undefined ? { reviewSeconds: h.reviewSeconds } : {}),
      })),
    // BL-173: the plan's re-checks.
    insertRecheck: (planId, r) =>
      insertGenerationPlanRecheck({
        planId,
        recheckId: r.recheckId,
        itemKey: r.itemKey,
        attemptRef: r.attemptRef,
        kind: r.kind,
        title: r.title,
        note: r.note,
        auditionFile: r.auditionFile,
        markersJson: r.markers.length > 0 ? JSON.stringify(r.markers) : null,
        checksJson: r.checks.length > 0 ? JSON.stringify(r.checks) : null,
        metricsJson: Object.keys(r.metrics).length > 0 ? JSON.stringify(r.metrics) : null,
        previousVerdictJson: r.previousVerdict ? JSON.stringify(r.previousVerdict) : null,
        status: r.status,
        openedAt: new Date(r.openedAt),
        closedAt: r.closedAt ? new Date(r.closedAt) : null,
        answerJson: r.answer ? JSON.stringify(r.answer) : null,
        withdrawNote: r.withdrawNote,
        closeReason: r.closeReason,
      }),
    listRechecks: async (planId) => (await listGenerationPlanRechecks(planId)).map(recheckFromDb),
    closeRecheck: (planId, recheckId, set) =>
      closeGenerationPlanRecheck(planId, recheckId, {
        status: set.status,
        closedAt: new Date(set.closedAt),
        answerJson: set.answer ? JSON.stringify(set.answer) : null,
        withdrawNote: set.withdrawNote ?? null,
        closeReason: set.closeReason ?? null,
      }),
    replaceRecheckAnswer: (planId, recheckId, answer) => replaceGenerationPlanRecheckAnswer(planId, recheckId, JSON.stringify(answer)),
    // BL-157 (AC-TC-01): this device's review claims (times in ms in the table, ISO here).
    upsertClaim: (c) =>
      upsertGenerationPlanReviewClaim({
        claimId: c.claimId,
        planId: c.planId,
        ownerDeviceId: c.ownerDeviceId,
        scope: c.scope,
        itemKey: c.itemKey,
        attemptRef: c.attemptRef,
        groupId: c.groupId,
        since: new Date(c.since),
        until: new Date(c.until),
      }),
    deleteClaim: (claimId) => deleteGenerationPlanReviewClaim(claimId),
    listClaims: async (at) =>
      (await listGenerationPlanReviewClaims(at)).map((c) => ({
        claimId: c.claimId,
        planId: c.planId,
        ownerDeviceId: c.ownerDeviceId,
        scope: c.scope,
        itemKey: c.itemKey ?? null,
        attemptRef: c.attemptRef ?? null,
        groupId: c.groupId ?? null,
        since: c.since.toISOString(),
        until: c.until.toISOString(),
      })),
    listSessions: async (planId) =>
      (await listMediaSessionsByPlan(planId)).map((s) => ({
        id: s.id,
        status: s.status,
        gpuTypeId: s.gpuTypeId ?? null,
        costPerHr: s.costPerHr ?? null,
        startedAt: s.startedAt ?? null,
        readyAt: s.readyAt ?? null,
        stoppedAt: s.stoppedAt ?? null,
        secondsUsed: s.secondsUsed ?? null,
        usdCharged: s.usdCharged ?? null,
        stopReason: s.stopReason ?? null,
      })),
  };
}
