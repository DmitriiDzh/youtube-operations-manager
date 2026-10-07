import {
  getGenerationPlan,
  insertGenerationPlanPeerVerdict,
  listGenerationPlanPeerVerdicts,
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
  type StoredGenerationPlanResult,
} from "@/lib/db";
import type { PlanDefinition, PlanEvent, PlanResultRow } from "../contracts";
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
        stageId: j.planStageId ?? null,
        itemKey: j.planItemKey ?? null,
        seed: j.planSeed ?? null,
        status: j.status,
        error: j.error ?? null,
        createdAt: j.createdAt,
        submittedAt: j.submittedAt ?? null,
        finishedAt: j.finishedAt ?? null,
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
