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
  cloneGroupInputSchema,
  closePlanInputSchema,
  jobLinkInputSchema,
  rerunInputSchema,
  runStageInputSchema,
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

/** BL-143 slice 2: what running a stage needs of the media core (wired in `index.ts`; absent = runs are not available). */
export type PlanMediaPort = {
  getSession(sessionId: string): Promise<{ sessionId: string; status: string; channelId: string; requestedBy: string; planId: string | null } | null>;
  /** Sets the session's plan when it has none; `true` when it is (now) this plan's. */
  linkSession(sessionId: string, planId: string): Promise<boolean>;
  validateJobParams(input: { templateId: string; params: Record<string, string | number | boolean> }): Promise<{ parameterNames: string[] }>;
  createJob(input: {
    sessionId: string;
    channelId: string;
    templateId: string;
    params: Record<string, string | number | boolean>;
    createdBy: "factory";
    plan: { planId: string; stageId: string; itemKey: string; seed: number | null };
  }): Promise<{ jobId: string }>;
};

export type PlanServiceDependencies = {
  store: PlanStore;
  channels: { isConnected(channelId: string): Promise<boolean> };
  clock: { now(): Date };
  media?: PlanMediaPort;
};

/** A template parameter with this name receives an attempt's seed (GENERATION_PLANS_PLAN.md AC-GP-09). */
export const SEED_PARAMETER = "seed";

export type PlanRunResult = {
  planId: string;
  sessionId: string;
  created: Array<{ itemKey: string; jobId: string; seed: number | null }>;
  /** Set when a job could not be created after the checks passed (e.g. ComfyUI down); the jobs before it exist. */
  stoppedAt: { itemKey: string; seed: number | null; error: { code: string; message: string } } | null;
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

  function requireMedia(): PlanMediaPort {
    if (!deps.media) throw planInvalid("Running plan stages is not available in this process");
    return deps.media;
  }

  /** AC-GP-10: the session must be running, the factory's, of the plan's channel, and not another plan's. */
  async function requireRunSession(row: StoredPlan, sessionId: string) {
    const media = requireMedia();
    const session = await media.getSession(sessionId);
    if (!session || session.requestedBy !== "factory") throw planMismatch(`Session ${sessionId} is not one of the factory's sessions`, { sessionId });
    if (session.status !== "running") throw planMismatch(`Session ${sessionId} is ${session.status}, not running`, { sessionId, status: session.status });
    if (session.channelId !== row.channelId) throw planMismatch(`Session ${sessionId} is for another channel than plan ${row.id}`, { sessionId, planId: row.id });
    if (session.planId !== null && session.planId !== row.id) throw planMismatch(`Session ${sessionId} works for plan ${session.planId}`, { sessionId, planId: row.id, sessionPlanId: session.planId });
    return session;
  }

  type PlannedJob = { item: PlanItem; seed: number | null; params: Record<string, string | number | boolean> };

  /** AC-GP-10: every job is checked (template, params, seed parameter) before the first is created; any failure refuses all. */
  async function checkJobs(planned: PlannedJob[]): Promise<void> {
    const media = requireMedia();
    for (const job of planned) {
      if (!job.item.templateId) throw planMismatch(`Item ${job.item.itemKey} has no templateId`, { itemKey: job.item.itemKey });
      let checked: { parameterNames: string[] };
      try {
        checked = await media.validateJobParams({ templateId: job.item.templateId, params: job.params });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw planMismatch(`Item ${job.item.itemKey}: ${message}`, { itemKey: job.item.itemKey, templateId: job.item.templateId, cause: (error as { details?: unknown }).details ?? null });
      }
      if (job.seed !== null && !checked.parameterNames.includes(SEED_PARAMETER)) {
        throw planMismatch(`Item ${job.item.itemKey} has seeds, but template ${job.item.templateId} has no "${SEED_PARAMETER}" parameter`, { itemKey: job.item.itemKey, templateId: job.item.templateId });
      }
    }
  }

  async function createJobs(row: StoredPlan, sessionId: string, stageId: string, planned: PlannedJob[]): Promise<PlanRunResult> {
    const media = requireMedia();
    if (!(await media.linkSession(sessionId, row.id))) throw planMismatch(`Session ${sessionId} works for another plan`, { sessionId, planId: row.id });
    const created: PlanRunResult["created"] = [];
    for (const job of planned) {
      try {
        const { jobId } = await media.createJob({
          sessionId,
          channelId: row.channelId,
          templateId: job.item.templateId as string,
          params: job.params,
          createdBy: "factory",
          plan: { planId: row.id, stageId, itemKey: job.item.itemKey, seed: job.seed },
        });
        created.push({ itemKey: job.item.itemKey, jobId, seed: job.seed });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return { planId: row.id, sessionId, created, stoppedAt: { itemKey: job.item.itemKey, seed: job.seed, error: { code: typeof code === "string" ? code : "internal_error", message: error instanceof Error ? error.message : String(error) } } };
      }
    }
    return { planId: row.id, sessionId, created, stoppedAt: null };
  }

  function withSeed(item: PlanItem, seed: number | null): Record<string, string | number | boolean> {
    return seed === null ? { ...item.params } : { ...item.params, [SEED_PARAMETER]: seed };
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

    /**
     * AC-GP-09/10: creates the jobs a stage still needs, in a running session the factory started for this plan's channel.
     * fixed -- one job per seed with no live or finished attempt yet, up to what the target still misses (without seeds:
     * that many jobs); until_accepted -- as many as the target still misses, within maxAttempts, taking the next unused
     * seeds. Everything is checked before the first job; nothing is ever started without this call.
     */
    async runStage(input: unknown): Promise<PlanRunResult> {
      const parsed = parseWithSchema(runStageInputSchema, input, "run stage");
      const row = await requireActive(parsed.planId);
      const stage = row.definition.stages.find((s) => s.kind === "in_app");
      if (!stage) throw planMismatch(`Plan ${row.id} has no in_app stage`, { planId: row.id });
      await requireRunSession(row, parsed.sessionId);
      let items = row.definition.items;
      if (parsed.itemKeys) {
        const unknown = parsed.itemKeys.filter((k) => !items.some((i) => i.itemKey === k));
        if (unknown.length > 0) throw planMismatch(`Plan ${row.id} has no item ${unknown[0]}`, { planId: row.id, itemKeys: unknown });
        items = items.filter((i) => parsed.itemKeys!.includes(i.itemKey));
      } else if (parsed.groupId) {
        if (!row.definition.groups.some((g) => g.groupId === parsed.groupId)) throw planMismatch(`Plan ${row.id} has no group ${parsed.groupId}`, { planId: row.id, groupId: parsed.groupId });
        items = items.filter((i) => i.groupId === parsed.groupId);
      }
      const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
      const progress = planProgress(toPublicPlan(row), jobs, results, [], now());
      const planned: PlannedJob[] = [];
      for (const item of items) {
        const missing = progress.items.find((i) => i.itemKey === item.itemKey)?.missing ?? 0;
        if (missing === 0) continue;
        const usedSeeds = new Set(jobs.filter((j) => j.itemKey === item.itemKey && j.seed !== null && ["queued", "submitted", "generating", "transferring", "done"].includes(j.status)).map((j) => j.seed as number));
        const freeSeeds = item.seeds.filter((s) => !usedSeeds.has(s));
        const count = item.mode === "fixed" && item.seeds.length > 0 ? Math.min(missing, freeSeeds.length) : missing;
        for (let n = 0; n < count; n++) {
          const seed = freeSeeds[n] ?? null;
          planned.push({ item, seed, params: withSeed(item, seed) });
        }
      }
      await checkJobs(planned);
      const result = await createJobs(row, parsed.sessionId, stage.stageId, planned);
      await record(row.id, "stage_run", "factory", { sessionId: parsed.sessionId, created: result.created.length, ...(result.stoppedAt ? { stoppedAt: result.stoppedAt } : {}) });
      return result;
    },

    /** One more attempt of one item (a new seed: the given one, else the next unused one, else none). */
    async rerun(input: unknown): Promise<PlanRunResult> {
      const parsed = parseWithSchema(rerunInputSchema, input, "re-run");
      const row = await requireActive(parsed.planId);
      const stage = row.definition.stages.find((s) => s.kind === "in_app");
      if (!stage) throw planMismatch(`Plan ${row.id} has no in_app stage`, { planId: row.id });
      const item = row.definition.items.find((i) => i.itemKey === parsed.itemKey);
      if (!item) throw planMismatch(`Plan ${row.id} has no item ${parsed.itemKey}`, { planId: row.id, itemKey: parsed.itemKey });
      await requireRunSession(row, parsed.sessionId);
      const jobs = await deps.store.listJobs(row.id);
      const used = new Set(jobs.filter((j) => j.itemKey === item.itemKey && j.seed !== null).map((j) => j.seed as number));
      const seed = parsed.seed ?? item.seeds.find((s) => !used.has(s)) ?? null;
      const planned: PlannedJob[] = [{ item, seed, params: withSeed(item, seed) }];
      await checkJobs(planned);
      const result = await createJobs(row, parsed.sessionId, stage.stageId, planned);
      await record(row.id, "item_rerun", "factory", { sessionId: parsed.sessionId, itemKey: item.itemKey, seed, ...(result.stoppedAt ? { stoppedAt: result.stoppedAt } : {}) });
      return result;
    },

    /** AC-GP-12: the next wave -- the group's items under `<newGroupId>/<rest of the key>`, params patched, no results copied. */
    async cloneGroup(input: unknown, actor: PlanActor = "factory"): Promise<PlanView> {
      const parsed = parseWithSchema(cloneGroupInputSchema, input, "clone group");
      const updated = await mutate(parsed.planId, (row) => {
        const source = row.definition.groups.find((g) => g.groupId === parsed.groupId);
        if (!source) throw planMismatch(`Plan ${row.id} has no group ${parsed.groupId}`, { planId: row.id, groupId: parsed.groupId });
        if (row.definition.groups.some((g) => g.groupId === parsed.newGroupId)) throw planInvalid(`Group ${parsed.newGroupId} already exists`, { groupId: parsed.newGroupId });
        const rest = (key: string) => (key.includes("/") ? key.slice(key.indexOf("/") + 1) : key);
        const copies = row.definition.items
          .filter((i) => i.groupId === parsed.groupId)
          .map((i) => ({ ...i, itemKey: `${parsed.newGroupId}/${rest(i.itemKey)}`, groupId: parsed.newGroupId, params: { ...i.params, ...(parsed.paramsPatch ?? {}) }, seeds: parsed.seeds ?? [...i.seeds] }));
        return {
          definition: {
            ...row.definition,
            groups: [...row.definition.groups, { groupId: parsed.newGroupId, title: parsed.title ?? parsed.newGroupId, dependsOn: parsed.groupId, note: null }],
            items: [...row.definition.items, ...copies],
          },
        };
      });
      await record(updated.id, "group_cloned", actor, { from: parsed.groupId, to: parsed.newGroupId });
      return view(updated);
    },

    /**
     * A job created by hand that names a plan attempt (`factory_media_create_job` with plan fields): the plan is active and
     * of the session's channel, the item exists, the stage is the in-app one. Returns the stage id to store on the job.
     */
    async checkJobLink(input: unknown): Promise<{ planId: string; stageId: string; itemKey: string; seed: number | null }> {
      const parsed = parseWithSchema(jobLinkInputSchema, input, "plan link");
      const row = await requireActive(parsed.planId);
      const stage = row.definition.stages.find((s) => s.kind === "in_app");
      if (!stage || (parsed.stageId !== undefined && parsed.stageId !== stage.stageId)) throw planMismatch(`Jobs feed only the in_app stage of plan ${row.id}`, { planId: row.id, stageId: parsed.stageId ?? null });
      if (row.channelId !== parsed.channelId) throw planMismatch(`Plan ${row.id} is for another channel`, { planId: row.id });
      if (!row.definition.items.some((i) => i.itemKey === parsed.itemKey)) throw planMismatch(`Plan ${row.id} has no item ${parsed.itemKey}`, { planId: row.id, itemKey: parsed.itemKey });
      if (deps.media && !(await deps.media.linkSession(parsed.sessionId, row.id))) throw planMismatch(`Session ${parsed.sessionId} works for another plan`, { sessionId: parsed.sessionId, planId: row.id });
      return { planId: row.id, stageId: stage.stageId, itemKey: parsed.itemKey, seed: parsed.seed ?? null };
    },

    /** A session started for a plan (`factory_media_start_session` with planId): the plan is active and of that channel. */
    async checkSessionLink(input: { planId: string; channelId: string }): Promise<void> {
      const row = await requireActive(input.planId);
      if (row.channelId !== input.channelId) throw planMismatch(`Plan ${row.id} is for another channel`, { planId: row.id });
    },
  };
}

export type GenerationPlanServices = ReturnType<typeof createGenerationPlanServices>;
