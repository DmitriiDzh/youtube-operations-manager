import {
  planClosed,
  planInvalid,
  planMismatch,
  planNotFound,
  validatorOfEntry,
  type GenerationPlan,
  type PlanActor,
  type PlanDefinition,
  type PlanEvent,
  type PlanGroup,
  type PlanItem,
  type PlanReference,
  type PlanResultRow,
  type PlanStage,
  type PlanStatus,
  type PlanReviewEntry,
  type PlanTodo,
  type PlanView,
} from "./contracts";
import type { GenerationPlansReport, SharedPlan, SharedVerdict } from "@/lib/sync-gateway";
import { inAppAttempts, planEvents, planProgress, planTodo, reviewCandidates, secondFloor, type PlanJobRow, type PlanSessionRow } from "./progress";
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
  PLAN_LIMITS,
  peerVerdictInputSchema,
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
  /** BL-143 phase 2: verdicts given here on other devices' plans (outgoing). */
  insertPeerVerdict(verdict: SharedVerdict): Promise<void>;
  /** The outgoing verdicts given since `sinceIso` (older ones are dropped), oldest first. */
  listPeerVerdicts(sinceIso: string): Promise<SharedVerdict[]>;
};

/** BL-143 slice 2: what running a stage needs of the media core (wired in `index.ts`; absent = runs are not available). */
export type PlanMediaPort = {
  getSession(sessionId: string): Promise<{ sessionId: string; status: string; channelId: string; requestedBy: string; planId: string | null } | null>;
  /** Sets the session's plan when it has none; `true` when it is (now) this plan's. */
  linkSession(sessionId: string, planId: string): Promise<boolean>;
  validateJobParams(input: { templateId: string; params: Record<string, string | number | boolean> }): Promise<{ parameterNames: string[] }>;
  /** The job's output files as recorded by the media core (`localPath` on this device). */
  getJobOutputs(jobId: string): Promise<Array<{ kind: string; localPath: string | null; filename: string }>>;
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
  /** BL-143 phase 2: the other devices' latest plans reports and this device's id (absent = no cross-device view). */
  peers?: { ownDeviceId(): Promise<string>; listPeerReports(): Promise<GenerationPlansReport[]> };
  generateId?: () => string;
};

/** BL-143 phase 2: a peer report older than this is shown as stale (the same 5 minutes as the sessions of other devices). */
export const PEER_PLANS_STALE_AFTER_MS = 5 * 60_000;
const PEER_VERDICTS_KEPT_MS = 30 * 24 * 60 * 60_000;

/** A template parameter with this name receives an attempt's seed (GENERATION_PLANS_PLAN.md AC-GP-09). */
export const SEED_PARAMETER = "seed";

export type PlanRunResult = {
  planId: string;
  sessionId: string;
  created: Array<{ itemKey: string; jobId: string; seed: number | null }>;
  /** Items that still need attempts but list seeds and have none left unused: nothing was created for them. */
  skipped: Array<{ itemKey: string; missing: number; reason: string }>;
  /** Set when a job could not be created after the checks passed (e.g. ComfyUI down); the jobs before it exist. */
  stoppedAt: { itemKey: string; seed: number | null; error: { code: string; message: string } } | null;
};

const CAS_RETRIES = 5;
/** BL-143 phase 2: what goes into this device's plans report for the other devices. */
type SharedPlanView = SharedPlan;
const SHARE_CLOSED_FOR_MS = 30 * 24 * 60 * 60_000;
const SHARE_MAX_PLANS = 50;
const SHARE_MAX_EVENTS = 50;
const SHARE_MAX_REVIEW = 500;
/** The longest note a result row (and so a report) carries. */
const PLAN_NOTE_MAX = 2000;
/** A report larger than this drops its oldest plans (closed ones first) until it fits (independent review: bounded). */
export const SHARE_MAX_BYTES = 4_000_000;
/**
 * Re-review 1: some events are stamped before their row is written (a job's `finishedAt` is taken before its manifest is
 * written to the workspace drive). A cursor that is "now" could pass such an event, so a complete page's cursor looks back
 * this far; the repeats are part of the contract (drop what you already have).
 */
export const EVENT_CURSOR_LOOKBACK_MS = 60_000;
/** Independent review (A2): at most this many jobs per run_stage call -- larger runs go per group or per item. */
export const MAX_JOBS_PER_RUN = 200;

/**
 * Independent review (A2): runs of one plan are serialized in this process ("work out what is missing, check, create" is
 * not atomic -- two concurrent run_stage calls, or a retry while the first still creates, would each create the missing
 * jobs). On globalThis because the plans core is created per call. The factory endpoint runs only in the web server.
 */
const RUN_LOCKS_KEY = Symbol.for("youtube-operations-manager.generation-plans.run-locks");
function runLocks(): Map<string, Promise<unknown>> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>> | undefined>;
  return (holder[RUN_LOCKS_KEY] ??= new Map());
}
function serializedPerPlan<T>(planId: string, work: () => Promise<T>): Promise<T> {
  const locks = runLocks();
  const previous = locks.get(planId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  locks.set(planId, settled);
  void settled.then(() => {
    if (locks.get(planId) === settled) locks.delete(planId);
  });
  return run;
}

/** A seed counts as used while its attempt is live or generated (a failed, interrupted or cancelled one frees it). */
function usedSeedsOf(jobs: PlanJobRow[], itemKey: string): Set<number> {
  return new Set(jobs.filter((j) => j.itemKey === itemKey && j.seed !== null && ["queued", "submitted", "generating", "transferring", "done"].includes(j.status)).map((j) => j.seed as number));
}

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

function normalizeReference(r: { id: string; label: string; file: string; lufs?: number | null; lra?: number | null; truePeak?: number | null }): PlanReference {
  return { id: r.id, label: r.label, file: r.file, lufs: r.lufs ?? null, lra: r.lra ?? null, truePeak: r.truePeak ?? null };
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
  for (const id of dup((definition.references ?? []).map((r) => r.id))) problems.push(`reference ${id} appears twice`);
  if ((definition.references ?? []).length > PLAN_LIMITS.references) problems.push(`more than ${PLAN_LIMITS.references} references`);
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
      const unknownRef = (r.referenceIds ?? []).find((id) => !(row.definition.references ?? []).some((x) => x.id === id));
      if (unknownRef) throw planMismatch(`Plan ${row.id} has no reference ${unknownRef}; add it with factory_plan_update first`, { planId: row.id, referenceId: unknownRef });
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
      referenceIds: r.referenceIds ?? [],
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
    if (planned.length === 0) return { planId: row.id, sessionId, created: [], skipped: [], stoppedAt: null };
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
        return { planId: row.id, sessionId, created, skipped: [], stoppedAt: { itemKey: job.item.itemKey, seed: job.seed, error: { code: typeof code === "string" ? code : "internal_error", message: error instanceof Error ? error.message : String(error) } } };
      }
    }
    return { planId: row.id, sessionId, created, skipped: [], stoppedAt: null };
  }

  function withSeed(item: PlanItem, seed: number | null): Record<string, string | number | boolean> {
    return seed === null ? { ...item.params } : { ...item.params, [SEED_PARAMETER]: seed };
  }

  /** The attempts the owner reviews -- `reviewCandidates` decides which and in what order (waiting ones first). */
  function reviewEntries(row: StoredPlan, jobs: PlanJobRow[], results: PlanResultRow[]): PlanReviewEntry[] {
    const review = row.definition.stages.find((s) => s.kind === "owner_review");
    if (!review) return [];
    const plan = toPublicPlan(row);
    const attempts = inAppAttempts(plan, jobs, results);
    const order = new Map(row.definition.stages.map((s, i) => [s.stageId, i]));
    return reviewCandidates(plan, attempts, results).map(({ itemKey, attemptRef, validator }) => {
      const item = row.definition.items.find((i) => i.itemKey === itemKey);
      const attempt = attempts.find((a) => a.itemKey === itemKey && a.attemptRef === attemptRef);
      const own = results.filter((r) => r.itemKey === itemKey && r.attemptRef === attemptRef);
      const stages = own.filter((r) => r.stageId !== review.stageId).sort((a, b) => (order.get(a.stageId) ?? 0) - (order.get(b.stageId) ?? 0));
      return {
        itemKey,
        groupId: item?.groupId ?? null,
        attemptRef,
        jobId: attempt?.jobId ?? null,
        seed: attempt?.seed ?? null,
        params: item?.params ?? {},
        stages,
        verdict: own.find((r) => r.stageId === review.stageId) ?? null,
        playable: Boolean(attempt?.jobId) || stages.some((s) => s.auditionFile !== null),
        validator,
      };
    });
  }

  const api = {
    /** AC-GP-01. */
    async createPlan(input: unknown, actor: PlanActor = "factory"): Promise<PlanView> {
      const parsed = parseWithSchema(createPlanInputSchema, input, "generation plan");
      await requireConnected(parsed.channelId);
      const definition: PlanDefinition = {
        stages: parsed.stages as PlanStage[],
        groups: (parsed.groups ?? []).map(normalizeGroup),
        items: (parsed.items ?? []).map(normalizeItem),
        references: (parsed.references ?? []).map(normalizeReference),
        ...(parsed.reviewRejected !== undefined ? { reviewRejected: parsed.reviewRejected } : {}),
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
        references: (file.references ?? []).map(normalizeReference),
        ...(typeof file.reviewRejected === "boolean" ? { reviewRejected: file.reviewRejected } : {}),
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
        let references = (d.references ?? []).filter((r) => !(parsed.removeReferenceIds ?? []).includes(r.id));
        for (const r of parsed.upsertReferences ?? []) {
          const next = normalizeReference(r);
          references = references.some((x) => x.id === r.id) ? references.map((x) => (x.id === r.id ? next : x)) : [...references, next];
        }
        return {
          ...(parsed.title !== undefined ? { title: parsed.title } : {}),
          ...(parsed.note !== undefined ? { note: parsed.note ?? null } : {}),
          ...(parsed.budget !== undefined
            ? { budgetUsd: parsed.budget.usd === undefined ? row.budgetUsd : parsed.budget.usd, budgetGpuMinutes: parsed.budget.gpuMinutes === undefined ? row.budgetGpuMinutes : parsed.budget.gpuMinutes }
            : {}),
          definition: { stages, groups, items, references, ...(parsed.reviewRejected !== undefined ? { reviewRejected: parsed.reviewRejected } : d.reviewRejected !== undefined ? { reviewRejected: d.reviewRejected } : {}) },
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

    /**
     * Events (review A1): times are stored to the second, so `since` is inclusive and the cursor is a whole second --
     * an event in the cursor's own second can come again on the next call (drop ones you already have); none is lost.
     */
    async getPlan(input: unknown): Promise<PlanView & { events: PlanEvent[]; more: boolean; cursor: string }> {
      const parsed = parseWithSchema(getPlanInputSchema, input, "plan id");
      const row = await requirePlan(parsed.planId);
      const [jobs, results, sessions, recorded] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id), deps.store.listSessions(row.id), deps.store.listEvents(row.id)]);
      const plan = toPublicPlan(row);
      const at = now();
      const page = parsed.latest
        ? { events: planEvents(jobs, sessions, results, recorded, null, 1_000_000).events.slice(-500), more: false, cursor: null }
        : planEvents(jobs, sessions, results, recorded, parsed.since ? new Date(parsed.since) : null);
      return { plan, progress: planProgress(plan, jobs, results, sessions, at), events: page.events, more: page.more, cursor: page.cursor ?? new Date(secondFloor(at).getTime() - EVENT_CURSOR_LOOKBACK_MS).toISOString() };
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
      // Same lock as the owner's verdict (re-review 2): the "no owner verdict yet" check and the write are one step.
      return serializedPerPlan(parsed.planId, async () => {
      const row = await requireActive(parsed.planId);
      checkRowsFit(row, parsed.rows);
      // Review A3 (approval integrity): a relayed verdict never replaces the owner's own verdict on the same attempt.
      const review = row.definition.stages.find((s) => s.kind === "owner_review");
      if (review && parsed.rows.some((r) => r.stageId === review.stageId)) {
        const owned = new Set((await deps.store.listResults(row.id)).filter((r) => r.stageId === review.stageId && r.reportedBy === "owner").map((r) => `${r.itemKey}\u0000${r.attemptRef}`));
        const clash = parsed.rows.find((r) => r.stageId === review.stageId && owned.has(`${r.itemKey}\u0000${r.attemptRef}`));
        if (clash) throw planMismatch(`The owner already gave a verdict on ${clash.itemKey} ${clash.attemptRef}; a relayed verdict cannot replace it`, { itemKey: clash.itemKey, attemptRef: clash.attemptRef });
      }
      const at = now().toISOString();
      await deps.store.upsertResults(row.id, parsed.rows.map((r) => resultRow(r, actor, at)));
      return { planId: row.id, stored: parsed.rows.length };
      });
    },

    /** AC-GP-13: the owner's verdict from the Web UI, at the plan's owner-review stage, for an attempt the plan has. */
    async recordOwnerVerdict(input: unknown): Promise<PlanResultRow> {
      const parsed = parseWithSchema(ownerVerdictInputSchema, input, "owner verdict");
      return serializedPerPlan(parsed.planId, async () => {
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
      });
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
      return serializedPerPlan(parsed.planId, () => runStageLocked(parsed));
    },

    /** One more attempt of one item (the given seed, else the item's next unused one; none only when the item has no seeds). */
    async rerun(input: unknown): Promise<PlanRunResult> {
      const parsed = parseWithSchema(rerunInputSchema, input, "re-run");
      return serializedPerPlan(parsed.planId, () => rerunLocked(parsed));
    },
  };

  async function runStageLocked(parsed: { planId: string; sessionId: string; itemKeys?: string[]; groupId?: string }): Promise<PlanRunResult> {
    {
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
      const skipped: PlanRunResult["skipped"] = [];
      for (const item of items) {
        const missing = progress.items.find((i) => i.itemKey === item.itemKey)?.missing ?? 0;
        if (missing === 0) continue;
        // An item that lists seeds is never run without one (review B1: a template's default seed would repeat a result).
        const freeSeeds = item.seeds.filter((s) => !usedSeedsOf(jobs, item.itemKey).has(s));
        const count = item.seeds.length > 0 ? Math.min(missing, freeSeeds.length) : missing;
        if (count < missing) skipped.push({ itemKey: item.itemKey, missing: missing - count, reason: "no unused seed left; add seeds with factory_plan_update" });
        for (let n = 0; n < count; n++) {
          const seed = item.seeds.length > 0 ? freeSeeds[n] : null;
          planned.push({ item, seed, params: withSeed(item, seed) });
        }
      }
      if (planned.length > MAX_JOBS_PER_RUN) {
        throw planMismatch(`This run would create ${planned.length} jobs; at most ${MAX_JOBS_PER_RUN} per call -- run it per group or per item`, { planId: row.id, jobs: planned.length, max: MAX_JOBS_PER_RUN });
      }
      await checkJobs(planned);
      const result = await createJobs(row, parsed.sessionId, stage.stageId, planned);
      await record(row.id, "stage_run", "factory", { sessionId: parsed.sessionId, created: result.created.length, ...(skipped.length > 0 ? { skipped } : {}), ...(result.stoppedAt ? { stoppedAt: result.stoppedAt } : {}) });
      return { ...result, skipped };
    }
  }

  async function rerunLocked(parsed: { planId: string; sessionId: string; itemKey: string; seed?: number }): Promise<PlanRunResult> {
    {
      const row = await requireActive(parsed.planId);
      const stage = row.definition.stages.find((s) => s.kind === "in_app");
      if (!stage) throw planMismatch(`Plan ${row.id} has no in_app stage`, { planId: row.id });
      const item = row.definition.items.find((i) => i.itemKey === parsed.itemKey);
      if (!item) throw planMismatch(`Plan ${row.id} has no item ${parsed.itemKey}`, { planId: row.id, itemKey: parsed.itemKey });
      await requireRunSession(row, parsed.sessionId);
      const jobs = await deps.store.listJobs(row.id);
      // Review B2: the same seed rule as run_stage, and an until_accepted item's attempt cap holds here too.
      if (item.mode === "until_accepted" && item.maxAttempts !== null && inAppAttempts(row.definition, jobs, await deps.store.listResults(row.id)).filter((a) => a.itemKey === item.itemKey).length >= item.maxAttempts) {
        throw planMismatch(`Item ${item.itemKey} reached its ${item.maxAttempts} attempts`, { itemKey: item.itemKey, maxAttempts: item.maxAttempts });
      }
      const used = usedSeedsOf(jobs, item.itemKey);
      const seed = parsed.seed ?? (item.seeds.length > 0 ? (item.seeds.find((s) => !used.has(s)) ?? null) : null);
      if (seed === null && item.seeds.length > 0) throw planMismatch(`Item ${item.itemKey} has no unused seed left; give a seed or add seeds`, { itemKey: item.itemKey });
      const planned: PlannedJob[] = [{ item, seed, params: withSeed(item, seed) }];
      await checkJobs(planned);
      const result = await createJobs(row, parsed.sessionId, stage.stageId, planned);
      await record(row.id, "item_rerun", "factory", { sessionId: parsed.sessionId, itemKey: item.itemKey, seed, ...(result.stoppedAt ? { stoppedAt: result.stoppedAt } : {}) });
      return result;
    }
  }

  // The rest of the public surface (added to the object returned above).
  const more = {
    /**
     * AC-GP3-02: how many attempts wait for the owner -- this device's active plans plus other devices' active plans, minus
     * the verdicts already sent from here (the Production badge).
     */
    async summary(): Promise<{ waitingReview: number; waitingPassed: number; waitingRejected: number; local: number; otherDevices: number }> {
      let local = 0;
      let rejected = 0;
      for (const row of await deps.store.listPlans({ status: "active" })) {
        const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
        const waiting = reviewEntries(row, jobs, results).filter((e) => e.verdict === null);
        local += waiting.length;
        rejected += waiting.filter((e) => e.validator === "rejected").length;
      }
      let otherDevices = 0;
      if (deps.peers) {
        const sent = new Set((await more.outgoingVerdicts()).map((v) => `${v.ownerDeviceId}\u0000${v.planId}\u0000${v.itemKey}\u0000${v.attemptRef}`));
        for (const report of await deps.peers.listPeerReports()) {
          for (const plan of report.plans.filter((p) => p.status === "active")) {
            const waiting = plan.review.filter((e) => e.verdict === null && !sent.has(`${report.deviceId}\u0000${plan.planId}\u0000${e.itemKey}\u0000${e.attemptRef}`));
            otherDevices += waiting.length;
            rejected += waiting.filter((e) => validatorOfEntry(e) === "rejected").length;
          }
        }
      }
      const total = local + otherDevices;
      return { waitingReview: total, waitingPassed: total - rejected, waitingRejected: rejected, local, otherDevices };
    },

    /** BL-143 phase 2: the other devices' plans (read-only), each report with its age and whether it is stale. */
    async peerPlans(): Promise<Array<{ deviceId: string; hostname: string | null; updatedAt: string; stale: boolean; plans: SharedPlan[] }>> {
      if (!deps.peers) return [];
      const at = now().getTime();
      return (await deps.peers.listPeerReports()).map((r) => ({ deviceId: r.deviceId, hostname: r.hostname, updatedAt: r.updatedAt, stale: at - Date.parse(r.updatedAt) > PEER_PLANS_STALE_AFTER_MS, plans: r.plans }));
    },

    /**
     * AC-GP2-03: the owner's verdict on another device's plan -- only for a plan and attempt in that device's latest report, and
     * only while the plan is active there. Stored here and carried in this device's report until that device applies it.
     */
    async recordPeerVerdict(input: unknown): Promise<SharedVerdict> {
      const parsed = parseWithSchema(peerVerdictInputSchema, input, "verdict");
      if (!deps.peers || !deps.generateId) throw planInvalid("Verdicts on other devices' plans are not available in this process");
      const report = (await deps.peers.listPeerReports()).find((r) => r.deviceId === parsed.deviceId);
      const plan = report?.plans.find((p) => p.planId === parsed.planId);
      if (!plan) throw planNotFound(parsed.planId);
      if (plan.status !== "active") throw planClosed(parsed.planId, plan.status);
      if (!plan.review.some((e) => e.itemKey === parsed.itemKey && e.attemptRef === parsed.attemptRef)) {
        throw planMismatch(`Plan ${parsed.planId} on that device has no attempt ${parsed.attemptRef} of ${parsed.itemKey} to review`, { planId: parsed.planId, itemKey: parsed.itemKey, attemptRef: parsed.attemptRef });
      }
      const verdict: SharedVerdict = {
        verdictId: deps.generateId(),
        planId: parsed.planId,
        ownerDeviceId: parsed.deviceId,
        itemKey: parsed.itemKey,
        attemptRef: parsed.attemptRef,
        result: parsed.result,
        rating: parsed.rating ?? null,
        reasons: parsed.reasons ?? [],
        markers: (parsed.markers ?? []).map((m) => ({ start: m.start, end: m.end ?? null, note: m.note ?? null })),
        note: parsed.note ?? null,
        at: now().toISOString(),
      };
      await deps.store.insertPeerVerdict(verdict);
      return verdict;
    },

    /**
     * AC-GP2-05: what to play for an attempt of ANOTHER device's plan -- named only by that device's latest report: the
     * latest reported `auditionFile` (relative to the channel's Sent to YTM), else the job output `media/<jobId>/<file>`
     * relative to the channel's From YTM. Resolved later in THIS device's copy of the channel workspace.
     */
    async resolvePeerAudition(input: { deviceId: string; planId: string; itemKey: string; attemptRef: string }): Promise<{ channelId: string } & ({ kind: "sent"; relativePath: string } | { kind: "job"; jobId: string; localPath: string })> {
      if (!deps.peers) throw planNotFound(input.planId);
      const report = (await deps.peers.listPeerReports()).find((r) => r.deviceId === input.deviceId);
      const plan = report?.plans.find((p) => p.planId === input.planId);
      if (!plan) throw planNotFound(input.planId);
      const entry = plan.review.find((e) => e.itemKey === input.itemKey && e.attemptRef === input.attemptRef);
      if (!entry) throw planMismatch(`That device's plan ${input.planId} has nothing to play for ${input.itemKey} ${input.attemptRef}`, { planId: input.planId, itemKey: input.itemKey, attemptRef: input.attemptRef });
      const reported = [...entry.stages].reverse().find((s) => s.auditionFile !== null);
      if (reported?.auditionFile) return { channelId: plan.channelId, kind: "sent", relativePath: reported.auditionFile };
      if (entry.jobOutput && entry.jobId) return { channelId: plan.channelId, kind: "job", jobId: entry.jobId, localPath: entry.jobOutput };
      throw planMismatch(`That device reports no file for ${input.itemKey} ${input.attemptRef}`, { planId: input.planId });
    },

    /** A reference of ANOTHER device's plan, named only by that device's latest report. */
    async resolvePeerReference(input: { deviceId: string; planId: string; id: string }): Promise<{ channelId: string; kind: "sent"; relativePath: string }> {
      const report = deps.peers ? (await deps.peers.listPeerReports()).find((r) => r.deviceId === input.deviceId) : undefined;
      const plan = report?.plans.find((p) => p.planId === input.planId);
      if (!plan) throw planNotFound(input.planId);
      const reference = plan.references.find((r) => r.id === input.id);
      if (!reference) throw planMismatch(`That device's plan ${input.planId} has no reference ${input.id}`, { planId: input.planId, referenceId: input.id });
      return { channelId: plan.channelId, kind: "sent", relativePath: reference.file };
    },

    /** The verdicts this device carries for other devices (the last 30 days). */
    async outgoingVerdicts(): Promise<SharedVerdict[]> {
      return deps.store.listPeerVerdicts(new Date(now().getTime() - PEER_VERDICTS_KEPT_MS).toISOString());
    },

    /**
     * AC-GP2-04: the verdicts other devices carry for THIS device's plans become owner verdicts here -- newest wins: one not
     * newer than the owner verdict already stored for that attempt is skipped, so applying the same verdict twice changes
     * nothing. Closed, unknown or another device's plans and unknown attempts are skipped.
     */
    async applyPeerVerdicts(): Promise<{ applied: number; skipped: number }> {
      if (!deps.peers) return { applied: 0, skipped: 0 };
      const own = await deps.peers.ownDeviceId();
      const at = now().getTime();
      // Grouped by plan (independent review): each plan is loaded once per tick, and a verdict already applied (its id is in
      // the plan's peer_verdict events) is passed over without touching anything.
      const byPlan = new Map<string, Array<{ verdict: SharedVerdict; from: string }>>();
      for (const report of await deps.peers.listPeerReports()) {
        for (const verdict of report.verdicts) {
          if (verdict.ownerDeviceId !== own) continue;
          const list = byPlan.get(verdict.planId) ?? [];
          list.push({ verdict, from: report.hostname ?? report.deviceId });
          byPlan.set(verdict.planId, list);
        }
      }
      let applied = 0;
      let skipped = 0;
      for (const [planId, incoming] of byPlan) {
        const done = await serializedPerPlan(planId, async () => {
          const row = await deps.store.getPlan(planId);
          const review = row?.definition.stages.find((s) => s.kind === "owner_review");
          if (!row || row.status !== "active" || !review) return { applied: 0, skipped: incoming.length };
          const [jobs, results, events] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id), deps.store.listEvents(row.id)]);
          const appliedIds = new Set(events.filter((e) => e.kind === "peer_verdict" && typeof e.details.verdictId === "string").map((e) => e.details.verdictId as string));
          const attempts = inAppAttempts(row.definition, jobs, results);
          const current = new Map(results.filter((r) => r.stageId === review.stageId && r.reportedBy === "owner").map((r) => [`${r.itemKey}\u0000${r.attemptRef}`, r]));
          let a = 0;
          let k = 0;
          for (const { verdict, from } of [...incoming].sort((x, y) => Date.parse(x.verdict.at) - Date.parse(y.verdict.at))) {
            if (appliedIds.has(verdict.verdictId)) continue;
            // A verdict dated in the future (a fast clock) is not taken: it would block every newer one on that attempt.
            const known = attempts.some((x) => x.itemKey === verdict.itemKey && x.attemptRef === verdict.attemptRef) || results.some((r) => r.itemKey === verdict.itemKey && r.attemptRef === verdict.attemptRef);
            const key = `${verdict.itemKey}\u0000${verdict.attemptRef}`;
            const stored = current.get(key);
            // Newest wins; stored times are whole seconds, so a verdict of the same second as the stored one is taken (ids differ).
            const older = stored !== undefined && Math.floor(Date.parse(verdict.at) / 1000) < Math.floor(Date.parse(stored.at) / 1000);
            if (!known || older || Date.parse(verdict.at) > at + 5 * 60_000) {
              k++;
              continue;
            }
            const label = ` (from ${from})`.slice(0, 200);
            const note = verdict.note ? `${verdict.note.slice(0, PLAN_NOTE_MAX - label.length)}${label}` : label.trim();
            const row2: PlanResultRow = {
              stageId: review.stageId,
              itemKey: verdict.itemKey,
              attemptRef: verdict.attemptRef,
              result: verdict.result,
              reportedBy: "owner",
              note,
              rating: verdict.rating,
              reasons: verdict.reasons,
              markers: verdict.markers,
              auditionFile: null,
              checks: [],
              metrics: {},
              at: verdict.at,
            };
            await deps.store.upsertResults(row.id, [row2]);
            current.set(key, row2);
            await record(row.id, "peer_verdict", "owner", { verdictId: verdict.verdictId, fromDevice: from, itemKey: verdict.itemKey, result: verdict.result });
            a++;
          }
          return { applied: a, skipped: k };
        });
        applied += done.applied;
        skipped += done.skipped;
      }
      return { applied, skipped };
    },

    /**
     * BL-143 phase 2 (AC-GP2-01): what the other devices may see of this device's plans -- active ones and those closed in the
     * last 30 days (newest first, at most 50): header, stages, groups, items WITHOUT params, the derived progress, the last 50
     * events and the review entries with the job output as `media/<jobId>/<file>` (never an absolute path).
     */
    async buildSharedPlans(): Promise<SharedPlanView[]> {
      const cutoff = now().getTime() - SHARE_CLOSED_FOR_MS;
      const rows = (await deps.store.listPlans({}))
        .filter((r) => r.status === "active" || (r.closedAt !== null && r.closedAt.getTime() >= cutoff))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, SHARE_MAX_PLANS);
      const out: SharedPlanView[] = [];
      for (const row of rows) {
        const plan = toPublicPlan(row);
        const [jobs, results, sessions, recorded] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id), deps.store.listSessions(row.id), deps.store.listEvents(row.id)]);
        const progress = planProgress(plan, jobs, results, sessions, now());
        // A job's error text can name local paths: other devices get the event without it (independent review, AC-GP2-01).
        const events = planEvents(jobs, sessions, results, recorded, null, 100_000)
          .events.slice(-SHARE_MAX_EVENTS)
          .map((e) => (e.kind.startsWith("job_") && "error" in e.details ? { ...e, details: Object.fromEntries(Object.entries(e.details).filter(([k]) => k !== "error")) } : e));
        const queue = (await more.reviewQueueOf(row, jobs, results)).slice(0, SHARE_MAX_REVIEW);
        const review: SharedPlanView["review"] = [];
        for (const entry of queue) {
          let jobOutput: string | null = null;
          if (entry.jobId && deps.media) {
            const output = (await deps.media.getJobOutputs(entry.jobId).catch(() => [])).find((o) => o.localPath && (o.kind === "audio" || o.kind === "video" || o.kind === "image"));
            const name = output?.localPath ? output.localPath.split(/[\\/]/).pop() : undefined;
            if (name && /^[^/\\]{1,200}$/.test(name) && name !== "." && name !== ".." && /^[A-Za-z0-9_-]{1,64}$/.test(entry.jobId)) jobOutput = `media/${entry.jobId}/${name}`;
          }
          const shareRow = (r: PlanResultRow) => ({ ...r, referenceIds: r.referenceIds ?? [] });
          // `validator` stays out of the shared format (strict on every device; the reader derives it -- `validatorOfEntry`).
          const { validator: _validator, ...shared } = entry;
          void _validator;
          review.push({ ...shared, stages: entry.stages.map(shareRow), verdict: entry.verdict ? shareRow(entry.verdict) : null, params: {}, jobOutput });
        }
        // A null-prototype map: an item key like "constructor" must be an ordinary key here.
        const itemParams: Record<string, PlanItem["params"]> = Object.create(null) as Record<string, PlanItem["params"]>;
        for (const entry of queue) if (!Object.hasOwn(itemParams, entry.itemKey)) itemParams[entry.itemKey] = entry.params;
        out.push({
          planId: plan.planId,
          title: plan.title,
          channelId: plan.channelId,
          owner: plan.owner,
          status: plan.status,
          budget: plan.budget,
          note: plan.note,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
          closedAt: plan.closedAt,
          stages: plan.stages,
          groups: plan.groups,
          items: plan.items.map((i) => ({ itemKey: i.itemKey, groupId: i.groupId, templateLabel: i.templateLabel ?? i.templateId, targetCount: i.targetCount, mode: i.mode })),
          progress: progress as unknown as Record<string, unknown>,
          itemParams,
          references: plan.references ?? [],
          events,
          review,
        });
      }
      // Bounded (independent review): the oldest plans -- closed ones first -- are left out until the report fits.
      const size = (plans: SharedPlanView[]) => new TextEncoder().encode(JSON.stringify(plans)).length;
      while (out.length > 1 && size(out) > SHARE_MAX_BYTES) {
        const closed = out.map((p, i) => ({ p, i })).filter(({ p }) => p.status !== "active").at(-1);
        out.splice(closed ? closed.i : out.length - 1, 1);
      }
      return out;
    },

    /** The review queue of a plan whose rows are already loaded (shared by `reviewQueue` and the share report). */
    async reviewQueueOf(row: StoredPlan, jobs: PlanJobRow[], results: PlanResultRow[]): Promise<PlanReviewEntry[]> {
      return reviewEntries(row, jobs, results);
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

    /**
     * BL-143 slice 4: the attempts the owner reviews -- every attempt that passed the stage before the owner review --
     * waiting ones first, each with what the earlier stages reported and the owner's verdict if given.
     */
    async reviewQueue(input: unknown): Promise<{ planId: string; entries: PlanReviewEntry[]; references: PlanReference[] }> {
      const { planId } = parseWithSchema(getPlanInputSchema.pick({ planId: true }), input, "plan id");
      const row = await requirePlan(planId);
      const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
      return { planId, entries: reviewEntries(row, jobs, results), references: row.definition.references ?? [] };
    },

    /**
     * AC-GP-14: what to play for one attempt of this plan -- the latest reported `auditionFile` (relative to the channel's
     * Sent to YTM), else the attempt's own job output. Never a path from the caller; an unknown attempt is plan_mismatch.
     */
    async resolveAudition(input: { planId: string; itemKey: string; attemptRef: string }): Promise<{ channelId: string } & ({ kind: "sent"; relativePath: string } | { kind: "job"; jobId: string; localPath: string })> {
      const row = await requirePlan(input.planId);
      const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
      const order = new Map(row.definition.stages.map((s, i) => [s.stageId, i]));
      const reported = results
        .filter((r) => r.itemKey === input.itemKey && r.attemptRef === input.attemptRef && r.auditionFile !== null)
        .sort((a, b) => (order.get(b.stageId) ?? 0) - (order.get(a.stageId) ?? 0) || b.at.localeCompare(a.at))[0];
      if (reported?.auditionFile) return { channelId: row.channelId, kind: "sent", relativePath: reported.auditionFile };
      const job = input.attemptRef.startsWith("job:") ? jobs.find((j) => j.id === input.attemptRef.slice(4) && j.itemKey === input.itemKey) : undefined;
      if (!job) throw planMismatch(`Plan ${row.id} has nothing to play for ${input.itemKey} ${input.attemptRef}`, { planId: row.id, itemKey: input.itemKey, attemptRef: input.attemptRef });
      const outputs = deps.media ? await deps.media.getJobOutputs(job.id) : [];
      const playable = outputs.find((o) => o.localPath && (o.kind === "audio" || o.kind === "video" || o.kind === "image")) ?? outputs.find((o) => o.localPath);
      if (!playable?.localPath) throw planMismatch(`Job ${job.id} has no output on this device`, { jobId: job.id });
      return { channelId: row.channelId, kind: "job", jobId: job.id, localPath: playable.localPath };
    },

    /** BL-143 phase 3 (FO-MSG-0009): a plan reference's file for A/B -- named only by the plan, never by the request. */
    async resolveReference(input: { planId: string; id: string }): Promise<{ channelId: string; kind: "sent"; relativePath: string }> {
      const row = await requirePlan(input.planId);
      const reference = (row.definition.references ?? []).find((r) => r.id === input.id);
      if (!reference) throw planMismatch(`Plan ${row.id} has no reference ${input.id}`, { planId: row.id, referenceId: input.id });
      return { channelId: row.channelId, kind: "sent", relativePath: reference.file };
    },

    /** A session started for a plan (`factory_media_start_session` with planId): the plan is active and of that channel. */
    async checkSessionLink(input: { planId: string; channelId: string }): Promise<void> {
      const row = await requireActive(input.planId);
      if (row.channelId !== input.channelId) throw planMismatch(`Plan ${row.id} is for another channel`, { planId: row.id });
    },
  };
  return { ...api, ...more };
}

export type GenerationPlanServices = ReturnType<typeof createGenerationPlanServices>;
