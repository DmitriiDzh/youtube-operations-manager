import {
  planClosed,
  planInvalid,
  planMismatch,
  planNotFound,
  type GenerationPlan,
  type PlanActor,
  type PlanDefinition,
  type PlanEvent,
  type PlanGroup,
  type PlanItem,
  type PlanResultRow,
  type PlanStage,
  type PlanStatus,
  type PlanTodo,
  type PlanView,
} from "./contracts";
import { inAppAttempts, planEvents, planProgress, planTodo, type PlanJobRow, type PlanSessionRow } from "./progress";
import {
  closePlanInputSchema,
  createPlanInputSchema,
  getPlanInputSchema,
  groupNoteInputSchema,
  importFileSchema,
  importInputSchema,
  listPlansInputSchema,
  ownerVerdictInputSchema,
  parseWithSchema,
  reportInputSchema,
  rerunRequestInputSchema,
  updatePlanInputSchema,
  type ReportRowInput,
} from "./schemas";

// ---------------------------------------------------------------------------
// BL-143 (ADR 0029, GENERATION_PLANS_PLAN.md): the plan services. The definition is changed only through a compare-and-swap
// on the plan's revision; results are idempotent per (plan, stage, item, attempt); every number shown is derived when read
// (`progress.ts`). This module depends on nothing of `media-generation` but the rows its adapter reads (§M).
// ---------------------------------------------------------------------------

export type StoredPlan = {
  id: string;
  title: string;
  channelId: string;
  owner: "factory" | "operator";
  status: PlanStatus;
  budgetUsd: number | null;
  budgetGpuMinutes: number | null;
  note: string | null;
  definition: PlanDefinition;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};

export type PlanStore = {
  /** `null` when the id is taken. */
  insertPlan(row: StoredPlan): Promise<StoredPlan | null>;
  getPlan(id: string): Promise<StoredPlan | null>;
  listPlans(filter: { status?: PlanStatus; channelId?: string }): Promise<StoredPlan[]>;
  /** Compare-and-swap on `revision`; `null` when it changed meanwhile. */
  updatePlan(id: string, expectedRevision: number, set: Partial<Omit<StoredPlan, "id" | "revision" | "createdAt">>): Promise<StoredPlan | null>;
  upsertResults(planId: string, rows: PlanResultRow[]): Promise<void>;
  listResults(planId: string): Promise<PlanResultRow[]>;
  insertEvent(planId: string, event: PlanEvent): Promise<void>;
  listEvents(planId: string): Promise<PlanEvent[]>;
  listJobs(planId: string): Promise<PlanJobRow[]>;
  /** Links an existing job of the plan's channel that is in no plan yet; `true` when linked. */
  linkJob(jobId: string, link: { planId: string; stageId: string; itemKey: string; channelId: string }): Promise<boolean>;
  listSessions(planId: string): Promise<PlanSessionRow[]>;
};

export type PlanServiceDependencies = {
  store: PlanStore;
  channels: { isConnected(channelId: string): Promise<boolean> };
  clock: { now(): Date };
};

const CAS_RETRIES = 5;

function toPublicPlan(row: StoredPlan): GenerationPlan {
  return {
    planId: row.id,
    title: row.title,
    channelId: row.channelId,
    owner: row.owner,
    status: row.status,
    budget: { usd: row.budgetUsd, gpuMinutes: row.budgetGpuMinutes },
    note: row.note,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    ...row.definition,
  };
}

function normalizeItem(item: {
  itemKey: string;
  groupId?: string | null;
  templateLabel?: string | null;
  templateId?: string | null;
  variant?: string | null;
  targetCount: number;
  mode?: PlanItem["mode"];
  maxAttempts?: number | null;
  params?: PlanItem["params"];
  seeds?: number[];
}): PlanItem {
  return {
    itemKey: item.itemKey,
    groupId: item.groupId ?? null,
    templateLabel: item.templateLabel ?? null,
    templateId: item.templateId ?? null,
    variant: item.variant ?? null,
    targetCount: item.targetCount,
    mode: item.mode ?? "fixed",
    maxAttempts: item.maxAttempts ?? null,
    params: item.params ?? {},
    seeds: item.seeds ?? [],
  };
}

function normalizeGroup(group: { groupId: string; title?: string; dependsOn?: string | null; note?: string | null }): PlanGroup {
  return { groupId: group.groupId, title: group.title ?? group.groupId, dependsOn: group.dependsOn ?? null, note: group.note ?? null };
}

/** The whole-definition rules (AC-GP-01): unique ids, at most one in-app and one owner-review stage, known references. */
export function validateDefinition(definition: PlanDefinition): void {
  const problems: string[] = [];
  const dup = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of dup(definition.stages.map((s) => s.stageId))) problems.push(`stage ${id} appears twice`);
  if (definition.stages.filter((s) => s.kind === "in_app").length > 1) problems.push("at most one in_app stage");
  if (definition.stages.filter((s) => s.kind === "owner_review").length > 1) problems.push("at most one owner_review stage");
  const groupIds = new Set(definition.groups.map((g) => g.groupId));
  for (const id of dup(definition.groups.map((g) => g.groupId))) problems.push(`group ${id} appears twice`);
  for (const g of definition.groups) {
    if (g.dependsOn !== null && (g.dependsOn === g.groupId || !groupIds.has(g.dependsOn))) problems.push(`group ${g.groupId} depends on unknown group ${g.dependsOn}`);
  }
  for (const id of dup(definition.items.map((i) => i.itemKey))) problems.push(`item ${id} appears twice`);
  for (const item of definition.items) {
    if (item.groupId !== null && !groupIds.has(item.groupId)) problems.push(`item ${item.itemKey} is in unknown group ${item.groupId}`);
    if (new Set(item.seeds).size !== item.seeds.length) problems.push(`item ${item.itemKey} lists a seed twice`);
    if (Object.keys(item.params).length > 60) problems.push(`item ${item.itemKey} has more than 60 params`);
  }
  if (problems.length > 0) throw planInvalid(`The plan is not valid: ${problems.slice(0, 10).join("; ")}`, { problems });
}

export function createGenerationPlanServices(deps: PlanServiceDependencies) {
  const now = () => deps.clock.now();

  async function requirePlan(planId: string): Promise<StoredPlan> {
    const row = await deps.store.getPlan(planId);
    if (!row) throw planNotFound(planId);
    return row;
  }

  async function requireActive(planId: string): Promise<StoredPlan> {
    const row = await requirePlan(planId);
    if (row.status !== "active") throw planClosed(planId, row.status);
    return row;
  }

  async function requireConnected(channelId: string): Promise<void> {
    if (!(await deps.channels.isConnected(channelId))) throw planInvalid(`Channel ${channelId} is not connected on this device`, { channelId });
  }

  async function record(planId: string, kind: string, actor: string, details: Record<string, unknown> = {}): Promise<void> {
    await deps.store.insertEvent(planId, { at: now().toISOString(), kind, actor, details });
  }

  /** A change of the definition/header as a compare-and-swap, re-read and re-applied when another writer won. */
  async function mutate(planId: string, change: (row: StoredPlan) => Partial<Omit<StoredPlan, "id" | "revision" | "createdAt">>): Promise<StoredPlan> {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const row = await requireActive(planId);
      const set = change(row);
      if (set.definition) validateDefinition(set.definition);
      const updated = await deps.store.updatePlan(planId, row.revision, { ...set, updatedAt: now() });
      if (updated) return updated;
    }
    throw planInvalid(`Plan ${planId} kept changing while this update was applied; try again`, { planId });
  }

  async function view(row: StoredPlan): Promise<PlanView> {
    const plan = toPublicPlan(row);
    const [jobs, results, sessions] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id), deps.store.listSessions(row.id)]);
    return { plan, progress: planProgress(plan, jobs, results, sessions, now()) };
  }

  function checkRowsFit(row: StoredPlan, rows: ReportRowInput[]): void {
    const stages = new Map(row.definition.stages.map((s) => [s.stageId, s]));
    const items = new Set(row.definition.items.map((i) => i.itemKey));
    for (const r of rows) {
      const stage = stages.get(r.stageId);
      if (!stage) throw planMismatch(`Plan ${row.id} has no stage ${r.stageId}`, { planId: row.id, stageId: r.stageId });
      if (stage.kind === "in_app") throw planMismatch(`Stage ${r.stageId} is fed by the plan's jobs, not by reports`, { planId: row.id, stageId: r.stageId });
      if (!items.has(r.itemKey)) throw planMismatch(`Plan ${row.id} has no item ${r.itemKey}`, { planId: row.id, itemKey: r.itemKey });
    }
  }

  function resultRow(r: ReportRowInput, reportedBy: PlanResultRow["reportedBy"], at: string): PlanResultRow {
    return {
      stageId: r.stageId,
      itemKey: r.itemKey,
      attemptRef: r.attemptRef,
      result: r.result,
      reportedBy,
      note: r.note ?? null,
      rating: r.rating ?? null,
      reasons: r.reasons ?? [],
      markers: (r.markers ?? []).map((m) => ({ start: m.start, end: m.end ?? null, note: m.note ?? null })),
      auditionFile: r.auditionFile ?? null,
      checks: (r.checks ?? []).map((c) => ({
        id: c.id,
        label: c.label ?? null,
        value: c.value ?? null,
        unit: c.unit ?? null,
        threshold: c.threshold ?? null,
        pass: c.pass,
        severity: c.severity,
        atSeconds: c.atSeconds ?? null,
        detail: c.detail ?? null,
      })),
      metrics: r.metrics ?? {},
      at,
    };
  }

  return {
    /** AC-GP-01. */
    async createPlan(input: unknown, actor: PlanActor = "factory"): Promise<PlanView> {
      const parsed = parseWithSchema(createPlanInputSchema, input, "generation plan");
      await requireConnected(parsed.channelId);
      const definition: PlanDefinition = {
        stages: parsed.stages as PlanStage[],
        groups: (parsed.groups ?? []).map(normalizeGroup),
        items: (parsed.items ?? []).map(normalizeItem),
      };
      validateDefinition(definition);
      const at = now();
      const row = await deps.store.insertPlan({
        id: parsed.planId,
        title: parsed.title,
        channelId: parsed.channelId,
        owner: actor === "owner" ? "operator" : "factory",
        status: "active",
        budgetUsd: parsed.budget?.usd ?? null,
        budgetGpuMinutes: parsed.budget?.gpuMinutes ?? null,
        note: parsed.note ?? null,
        definition,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
      });
      if (!row) throw planInvalid(`A plan with id ${parsed.planId} already exists on this device`, { planId: parsed.planId });
      await record(row.id, "plan_created", actor);
      return view(row);
    },

    /**
     * AC-GP-02: a `ytm-generation-plan/1` file. Template strings are kept as labels; an in-app attempt `job:<id>` naming a job
     * of this channel that is in no plan is linked to the plan (so its live state counts); any other attempt is kept as an
     * imported row.
     */
    async importPlan(input: unknown, actor: PlanActor = "factory"): Promise<PlanView & { linkedJobs: number; importedResults: number }> {
      const { plan: raw } = parseWithSchema(importInputSchema, input, "plan import");
      const file = parseWithSchema(importFileSchema, raw, "ytm-generation-plan/1 file");
      await requireConnected(file.channelId);
      const groupIds = [...new Set(file.items.map((i) => i.group).filter((g): g is string => typeof g === "string"))];
      const definition: PlanDefinition = {
        stages: file.stages as PlanStage[],
        groups: groupIds.map((groupId) => normalizeGroup({ groupId })),
        items: file.items.map((i) =>
          normalizeItem({ itemKey: i.itemKey, groupId: i.group ?? null, templateLabel: i.templateId ?? null, variant: i.variant, targetCount: i.targetCount, mode: i.mode, maxAttempts: i.maxAttempts, params: i.params, seeds: i.seeds })
        ),
      };
      validateDefinition(definition);
      const stages = new Map(definition.stages.map((s) => [s.stageId, s]));
      const items = new Set(definition.items.map((i) => i.itemKey));
      for (const r of file.results ?? []) {
        if (!stages.has(r.stageId)) throw planInvalid(`A result names unknown stage ${r.stageId}`, { stageId: r.stageId });
        if (!items.has(r.itemKey)) throw planInvalid(`A result names unknown item ${r.itemKey}`, { itemKey: r.itemKey });
      }
      const at = now();
      const status = file.status ?? "active";
      const row = await deps.store.insertPlan({
        id: file.planId,
        title: file.title,
        channelId: file.channelId,
        owner: file.owner ?? "factory",
        status,
        budgetUsd: file.budget?.usd ?? null,
        budgetGpuMinutes: file.budget?.gpuMinutes ?? null,
        note: file.note ?? null,
        definition,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        closedAt: status === "active" ? null : at,
      });
      if (!row) throw planInvalid(`A plan with id ${file.planId} already exists on this device`, { planId: file.planId });
      let linkedJobs = 0;
      const rows: PlanResultRow[] = [];
      for (const r of file.results ?? []) {
        const stage = stages.get(r.stageId)!;
        if (stage.kind === "in_app" && r.attemptRef.startsWith("job:")) {
          if (await deps.store.linkJob(r.attemptRef.slice(4), { planId: row.id, stageId: stage.stageId, itemKey: r.itemKey, channelId: row.channelId })) {
            linkedJobs++;
            continue;
          }
        }
        const reportedBy = r.reportedBy === "owner" ? "owner" : stage.kind === "in_app" || r.reportedBy === "job" ? "import" : "factory";
        rows.push({ stageId: r.stageId, itemKey: r.itemKey, attemptRef: r.attemptRef, result: r.result, reportedBy, note: r.note ?? null, rating: null, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: r.at ? new Date(r.at).toISOString() : at.toISOString() });
      }
      await deps.store.upsertResults(row.id, rows);
      await record(row.id, "plan_imported", actor, { linkedJobs, importedResults: rows.length });
      return { ...(await view(row)), linkedJobs, importedResults: rows.length };
    },

    /** AC-GP-06. */
    async updatePlan(input: unknown, actor: PlanActor = "factory"): Promise<PlanView> {
      const parsed = parseWithSchema(updatePlanInputSchema, input, "plan update");
      const [jobs, results] = await Promise.all([deps.store.listJobs(parsed.planId), deps.store.listResults(parsed.planId)]);
      const updated = await mutate(parsed.planId, (row) => {
        const d = row.definition;
        const attempts = inAppAttempts(d, jobs, results);
        const usedStage = (stageId: string) => results.some((r) => r.stageId === stageId) || (d.stages.find((s) => s.stageId === stageId)?.kind === "in_app" && attempts.length > 0);
        const usedItem = (itemKey: string) => results.some((r) => r.itemKey === itemKey) || attempts.some((a) => a.itemKey === itemKey);
        for (const id of parsed.removeStageIds ?? []) if (usedStage(id)) throw planInvalid(`Stage ${id} has results and cannot be removed`, { stageId: id });
        for (const key of parsed.removeItemKeys ?? []) if (usedItem(key)) throw planInvalid(`Item ${key} has attempts or results and cannot be removed`, { itemKey: key });
        let stages = d.stages.filter((s) => !(parsed.removeStageIds ?? []).includes(s.stageId));
        for (const s of parsed.addStages ?? []) {
          if (stages.some((x) => x.stageId === s.stageId)) throw planInvalid(`Stage ${s.stageId} already exists`, { stageId: s.stageId });
          stages = [...stages, s as PlanStage];
        }
        let groups = d.groups.filter((g) => !(parsed.removeGroupIds ?? []).includes(g.groupId));
        for (const g of parsed.upsertGroups ?? []) {
          const existing = groups.find((x) => x.groupId === g.groupId);
          const next = normalizeGroup({ ...existing, ...g, title: g.title ?? existing?.title });
          groups = existing ? groups.map((x) => (x.groupId === g.groupId ? next : x)) : [...groups, next];
        }
        let items = d.items.filter((i) => !(parsed.removeItemKeys ?? []).includes(i.itemKey));
        for (const i of parsed.upsertItems ?? []) {
          const next = normalizeItem(i);
          items = items.some((x) => x.itemKey === i.itemKey) ? items.map((x) => (x.itemKey === i.itemKey ? next : x)) : [...items, next];
        }
        for (const g of parsed.removeGroupIds ?? []) if (items.some((i) => i.groupId === g)) throw planInvalid(`Group ${g} still has items`, { groupId: g });
        return {
          ...(parsed.title !== undefined ? { title: parsed.title } : {}),
          ...(parsed.note !== undefined ? { note: parsed.note ?? null } : {}),
          ...(parsed.budget !== undefined
            ? { budgetUsd: parsed.budget.usd === undefined ? row.budgetUsd : parsed.budget.usd, budgetGpuMinutes: parsed.budget.gpuMinutes === undefined ? row.budgetGpuMinutes : parsed.budget.gpuMinutes }
            : {}),
          definition: { stages, groups, items },
        };
      });
      await record(updated.id, "plan_updated", actor);
      return view(updated);
    },

    /** AC-GP-05: the status only -- no job, session or file is touched. */
    async closePlan(input: unknown, actor: PlanActor = "factory"): Promise<PlanView> {
      const parsed = parseWithSchema(closePlanInputSchema, input, "plan close");
      const updated = await mutate(parsed.planId, () => ({ status: parsed.status, closedAt: now(), ...(parsed.note !== undefined ? { note: parsed.note ?? null } : {}) }));
      await record(updated.id, `plan_${parsed.status}`, actor);
      return view(updated);
    },

    async getPlan(input: unknown): Promise<PlanView & { events: PlanEvent[]; cursor: string }> {
      const parsed = parseWithSchema(getPlanInputSchema, input, "plan id");
      const row = await requirePlan(parsed.planId);
      const [jobs, results, sessions, recorded] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id), deps.store.listSessions(row.id), deps.store.listEvents(row.id)]);
      const plan = toPublicPlan(row);
      const at = now();
      return { plan, progress: planProgress(plan, jobs, results, sessions, at), events: planEvents(jobs, sessions, results, recorded, parsed.since ? new Date(parsed.since) : null), cursor: at.toISOString() };
    },

    async listPlans(input: unknown = {}): Promise<PlanView[]> {
      const parsed = parseWithSchema(listPlansInputSchema, input, "plan list");
      const rows = await deps.store.listPlans(parsed);
      return Promise.all(rows.map(view));
    },

    /** AC-GP-07. */
    async todo(input: unknown): Promise<PlanTodo> {
      const { planId } = parseWithSchema(getPlanInputSchema.pick({ planId: true }), input, "plan id");
      const row = await requirePlan(planId);
      const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
      return planTodo(toPublicPlan(row), jobs, results);
    },

    /** AC-GP-03/04: all rows checked before any is written; one row per (plan, stage, item, attempt), a repeat replaces it. */
    async report(input: unknown, actor: PlanActor = "factory"): Promise<{ planId: string; stored: number }> {
      const parsed = parseWithSchema(reportInputSchema, input, "plan report");
      const row = await requireActive(parsed.planId);
      checkRowsFit(row, parsed.rows);
      const at = now().toISOString();
      await deps.store.upsertResults(row.id, parsed.rows.map((r) => resultRow(r, actor, at)));
      return { planId: row.id, stored: parsed.rows.length };
    },

    /** AC-GP-13: the owner's verdict from the Web UI, at the plan's owner-review stage, for an attempt the plan has. */
    async recordOwnerVerdict(input: unknown): Promise<PlanResultRow> {
      const parsed = parseWithSchema(ownerVerdictInputSchema, input, "owner verdict");
      const row = await requireActive(parsed.planId);
      const stage = row.definition.stages.find((s) => s.kind === "owner_review");
      if (!stage) throw planMismatch(`Plan ${row.id} has no owner review stage`, { planId: row.id });
      if (!row.definition.items.some((i) => i.itemKey === parsed.itemKey)) throw planMismatch(`Plan ${row.id} has no item ${parsed.itemKey}`, { planId: row.id, itemKey: parsed.itemKey });
      const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
      const known = inAppAttempts(row.definition, jobs, results).some((a) => a.itemKey === parsed.itemKey && a.attemptRef === parsed.attemptRef) || results.some((r) => r.itemKey === parsed.itemKey && r.attemptRef === parsed.attemptRef);
      if (!known) throw planMismatch(`Item ${parsed.itemKey} has no attempt ${parsed.attemptRef}`, { planId: row.id, itemKey: parsed.itemKey, attemptRef: parsed.attemptRef });
      const result = resultRow({ ...parsed, stageId: stage.stageId }, "owner", now().toISOString());
      await deps.store.upsertResults(row.id, [result]);
      return result;
    },

    /** The owner's (or factory's) note on a whole wave (FO-MSG-0008 §4). */
    async setGroupNote(input: unknown, actor: PlanActor = "owner"): Promise<PlanView> {
      const parsed = parseWithSchema(groupNoteInputSchema, input, "group note");
      const updated = await mutate(parsed.planId, (row) => {
        if (!row.definition.groups.some((g) => g.groupId === parsed.groupId)) throw planMismatch(`Plan ${row.id} has no group ${parsed.groupId}`, { planId: row.id, groupId: parsed.groupId });
        return { definition: { ...row.definition, groups: row.definition.groups.map((g) => (g.groupId === parsed.groupId ? { ...g, note: parsed.note } : g)) } };
      });
      await record(updated.id, "group_note", actor, { groupId: parsed.groupId, note: parsed.note });
      return view(updated);
    },

    /** The owner asks for one item to be generated again; recorded for the factory, nothing is started (ADR 0029 §4). */
    async requestRerun(input: unknown): Promise<{ recorded: true }> {
      const parsed = parseWithSchema(rerunRequestInputSchema, input, "re-run request");
      const row = await requireActive(parsed.planId);
      if (!row.definition.items.some((i) => i.itemKey === parsed.itemKey)) throw planMismatch(`Plan ${row.id} has no item ${parsed.itemKey}`, { planId: row.id, itemKey: parsed.itemKey });
      await record(row.id, "rerun_requested", "owner", { itemKey: parsed.itemKey, ...(parsed.attemptRef ? { attemptRef: parsed.attemptRef } : {}), ...(parsed.note ? { note: parsed.note } : {}) });
      return { recorded: true };
    },
  };
}

export type GenerationPlanServices = ReturnType<typeof createGenerationPlanServices>;
