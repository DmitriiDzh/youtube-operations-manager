import {
  planClosed,
  planInvalid,
  planMismatch,
  planNotFound,
  planVerdictExists,
  historyEntryOfVerdict,
  PLAN_MOVE_MISSING_LISTED,
  validatorOfEntry,
  type GenerationPlan,
  type PlanActor,
  type PlanChannelSummary,
  type PlanChannelWork,
  type PlanDefinition,
  type PlanEvent,
  type PlanGroup,
  type PlanItem,
  type PlanMoveResult,
  type PlanNotice,
  type PlanProgress,
  type PlanReference,
  type PlanResultRow,
  type PlanReviewBatch,
  type PlanReviewClaim,
  type PlanVerdictHistoryEntry,
  type PlanVerdictHistoryRow,
  type PlanStage,
  type PlanStatus,
  type PlanReviewEntry,
  type PlanTodo,
  type PlanView,
  sharedNotices,
} from "./contracts";
import { createHash } from "node:crypto";
import type { GenerationPlansReport, SharedClaim, SharedGroupNote, SharedPlan, SharedVerdict } from "@/lib/sync-gateway";
import { inAppAttempts, planEvents, planProgress, planTodo, reviewBatches, reviewCandidates, secondFloor, type PlanJobRow, type PlanSessionRow } from "./progress";
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
  movePlanInputSchema,
  ownerVerdictInputSchema,
  parseWithSchema,
  PLAN_LIMITS,
  peerVerdictInputSchema,
  peerGroupNoteInputSchema,
  reportInputSchema,
  reviewClaimInputSchema,
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
  /** BL-162 (FO-REQ-0013 §2.3): wave notes written here on other devices' plans (outgoing). */
  insertPeerGroupNote(note: SharedGroupNote): Promise<void>;
  /** The outgoing wave notes written since `sinceIso` (older ones are dropped), oldest first. */
  listPeerGroupNotes(sinceIso: string): Promise<SharedGroupNote[]>;
  /** BL-157 (AC-TC-05): every owner verdict on this device's plans, with the device it was given on. */
  insertVerdictHistory(planId: string, row: PlanVerdictHistoryRow): Promise<void>;
  /** A plan's verdict history, oldest first. */
  listVerdictHistory(planId: string): Promise<PlanVerdictHistoryRow[]>;
  /** BL-157 (AC-TC-01): this device's review claims (`claimId` decides which one a write replaces). */
  upsertClaim(claim: SharedClaim): Promise<void>;
  deleteClaim(claimId: string): Promise<void>;
  /** This device's live claims (expired ones are dropped). */
  listClaims(now: Date): Promise<SharedClaim[]>;
};

/** BL-143 slice 2: what running a stage needs of the media core (wired in `index.ts`; absent = runs are not available). */
export type PlanMediaPort = {
  getSession(sessionId: string): Promise<{ sessionId: string; status: string; channelId: string; requestedBy: string; planId: string | null } | null>;
  /** Sets the session's plan when it has none; `true` when it is (now) this plan's. */
  linkSession(sessionId: string, planId: string): Promise<boolean>;
  /** With `sessionId` (BL-159) it also refuses (`media_gpu_host_incompatible`) a template needing a newer host CUDA than that session's. */
  validateJobParams(input: { templateId: string; params: Record<string, string | number | boolean>; sessionId?: string }): Promise<{ parameterNames: string[] }>;
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
  /**
   * BL-157 (AC-MV-02/03): this device's channel workspaces, for a plan move's file check (absent = moves are refused).
   * `sentFileExists` uses the player's own resolver, so "exists" means "plays" (inside Sent to YTM, no symlink, a file).
   */
  files?: { workspaceOf(channelId: string): Promise<string | null>; sentFileExists(workspace: string, relativePath: string): Promise<boolean> };
  /** BL-157 (AC-TC-04/05): how this computer is named in a verdict's history (its host name, else its device id). */
  deviceLabel?: () => Promise<string>;
  generateId?: () => string;
  /**
   * BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.4): the small "what is open here" files -- this device's claims written the moment
   * they change, the other devices' read straight from disk (absent = claims travel only in the plans report).
   */
  presence?: { publish(claims: SharedClaim[]): Promise<void>; readPeers(): Promise<Array<{ deviceId: string; hostname: string | null; claims: SharedClaim[] }>> };
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
/**
 * BL-157 (AC-TC-01): a claim lasts this long after the screen last showed it. BL-162 (owner, msg 2263): 90 s with a heartbeat
 * every 30 s, so a closed screen frees its track within a minute and a half even when its release never arrived.
 */
export const REVIEW_CLAIM_TTL_MS = 90_000;
/** A peer's claim reaching further than this ahead is not believed (a clock far ahead, or a bad report). */
const PEER_CLAIM_MAX_AHEAD_MS = 15 * 60_000;
/** BL-157 (AC-TC-05): how many of an attempt's verdicts the history shows and the report carries. */
const HISTORY_SHOWN = 10;
/** BL-157 (AC-MV-02): a job in one of these may still write its output; a plan does not move while it has one. */
const UNFINISHED_JOB_STATUSES: ReadonlySet<PlanJobRow["status"]> = new Set(["queued", "submitted", "generating", "transferring"]);
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
/**
 * One plan's writes, one at a time in this process. Exported (BL-157, review round 2) as `withPlanLock` for a write that
 * starts outside this module but must not interleave with a plan move (the factory's plan-linked job creation).
 */
export function withPlanLock<T>(planId: string, work: () => Promise<T>): Promise<T> {
  return serializedPerPlan(planId, work);
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

function normalizeGroup(group: { groupId: string; title?: string; dependsOn?: string | null; note?: string | null; ownerNote?: string | null }): PlanGroup {
  // BL-157 (AC-WV-04): the owner's note survives a factory upsert of the same group (the factory never sends it).
  return { groupId: group.groupId, title: group.title ?? group.groupId, dependsOn: group.dependsOn ?? null, note: group.note ?? null, ...(group.ownerNote ? { ownerNote: group.ownerNote } : {}) };
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

// BL-162: `sharedNotices` lives in ./contracts (the Plans card reads it in the browser too); re-exported for this module's callers.
export { sharedNotices };

/**
 * BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.2): when each wave's owner note last changed -- the newest `group_note` event of the owner
 * that was not superseded, at the time the note was WRITTEN (`writtenAt` for one that came from another device, the event's own
 * time for one written here). The factory's notes (actor "factory") are a different field and do not count. Exported for its test.
 */
export function ownerNoteTimes(events: readonly PlanEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "group_note" || e.actor !== "owner" || e.details.superseded === true || typeof e.details.groupId !== "string") continue;
    const at = Date.parse(typeof e.details.writtenAt === "string" ? e.details.writtenAt : e.at);
    if (Number.isFinite(at) && at > (out.get(e.details.groupId) ?? Number.NEGATIVE_INFINITY)) out.set(e.details.groupId, at);
  }
  return out;
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
  async function checkJobs(planned: PlannedJob[], sessionId: string): Promise<void> {
    const media = requireMedia();
    for (const job of planned) {
      if (!job.item.templateId) throw planMismatch(`Item ${job.item.itemKey} has no templateId`, { itemKey: job.item.itemKey });
      let checked: { parameterNames: string[] };
      try {
        checked = await media.validateJobParams({ templateId: job.item.templateId, params: job.params, sessionId });
      } catch (error) {
        // BL-159 (AC-SC-04): a host too old for the template is the session's problem, not the plan's -- its own code, so the
        // factory starts a session with the template's minimum instead of editing the plan.
        if ((error as { code?: unknown }).code === "media_gpu_host_incompatible") throw error;
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

  const keyOf = (itemKey: string, attemptRef: string) => `${itemKey}\u0000${attemptRef}`;
  async function ownDeviceId(): Promise<string> {
    return deps.peers ? deps.peers.ownDeviceId() : "this-device";
  }
  async function ownLabel(): Promise<string> {
    return deps.deviceLabel ? deps.deviceLabel() : ownDeviceId();
  }
  /** One track claim per (plan's device, plan) -- it moves with the track; one claim per wave. */
  function claimIdOf(scope: "attempt" | "group", ownerDeviceId: string, planId: string, groupId?: string): string {
    return createHash("sha256").update([scope, ownerDeviceId, planId, scope === "group" ? (groupId ?? "") : ""].join("\u0000")).digest("hex").slice(0, 32);
  }
  /** BL-157 (AC-TC-05): an attempt's verdicts for the screen, oldest first, the last few. */
  function historyOf(history: PlanVerdictHistoryRow[], itemKey: string, attemptRef: string): PlanVerdictHistoryEntry[] {
    return history
      .filter((h) => h.itemKey === itemKey && h.attemptRef === attemptRef)
      .slice(-HISTORY_SHOWN)
      // Within the shared report's bounds whatever is stored, so one odd row never stops this device's report (review round 3).
      .map((h) => ({ result: h.result, rating: h.rating, note: h.note === null ? null : h.note.slice(0, 2000), device: h.device.slice(0, 255), at: h.at.slice(0, 40) }));
  }

  /**
   * BL-157 (AC-TC-05, review round 2): the first history row of an attempt whose current verdict was stored before the history
   * existed (schema v69) -- that verdict goes in first, so the history and the `owner_verdict` events never lose it. A verdict
   * applied from another device names it in its note (" (from <device>)"); any other was given on this device.
   */
  /**
   * A stored owner verdict applied from another device names it in its note (" (from <device>)"). A note that only ends like
   * "(from 1:20)" is the owner's own words: the suffix names a device only when a peer verdict from that device on this item
   * was applied here (review round 3). `[note before the suffix, device]`, or null.
   */
  async function relayOf(planId: string, current: PlanResultRow): Promise<[string, string] | null> {
    const match = current.note ? /^([\s\S]*?)\s*\(from ([^()]{1,255})\)$/.exec(current.note) : null;
    if (!match) return null;
    const proven = (await deps.store.listEvents(planId)).some((e) => e.kind === "peer_verdict" && e.details.superseded !== true && e.details.fromDevice === match[2] && e.details.itemKey === current.itemKey);
    return proven ? [match[1], match[2]] : null;
  }

  async function seedHistory(planId: string, history: PlanVerdictHistoryRow[], current: PlanResultRow | undefined): Promise<void> {
    if (!current || current.reportedBy !== "owner" || (current.result !== "accepted" && current.result !== "rejected")) return;
    if (history.some((h) => h.itemKey === current.itemKey && h.attemptRef === current.attemptRef)) return;
    const from = await relayOf(planId, current);
    const row: PlanVerdictHistoryRow = {
      itemKey: current.itemKey,
      attemptRef: current.attemptRef,
      result: current.result,
      rating: current.rating,
      reasons: current.reasons,
      markers: current.markers,
      note: from ? from[0].trim() || null : current.note,
      device: from ? from[1] : await ownLabel(),
      at: current.at,
    };
    await deps.store.insertVerdictHistory(planId, row);
    history.push(row);
  }

  /**
   * BL-157 (AC-TC-03): verdicts the other devices sent for THIS device's plan that this device has not applied yet (it applies
   * them on its tick), newest per attempt -- the same rules `applyPeerVerdicts` will use (not older than the stored verdict,
   * not dated more than 5 minutes ahead), so what shows as "being applied" is what will be applied.
   */
  async function pendingPeerVerdicts(row: StoredPlan, events: PlanEvent[], results: PlanResultRow[]): Promise<Map<string, { verdict: SharedVerdict; from: string }>> {
    const pending = new Map<string, { verdict: SharedVerdict; from: string }>();
    const review = row.definition.stages.find((s) => s.kind === "owner_review");
    // `applyPeerVerdicts` applies only to an active plan: on a closed one nothing is "being applied" (review round 1).
    if (!deps.peers || !review || row.status !== "active") return pending;
    const own = await deps.peers.ownDeviceId();
    const applied = new Set(events.filter((e) => e.kind === "peer_verdict" && typeof e.details.verdictId === "string").map((e) => e.details.verdictId as string));
    const stored = new Map(results.filter((r) => r.stageId === review.stageId && r.reportedBy === "owner").map((r) => [keyOf(r.itemKey, r.attemptRef), r]));
    const at = now().getTime();
    for (const report of await deps.peers.listPeerReports()) {
      for (const verdict of report.verdicts) {
        if (verdict.ownerDeviceId !== own || verdict.planId !== row.id || applied.has(verdict.verdictId) || Date.parse(verdict.at) > at + 5 * 60_000) continue;
        const key = keyOf(verdict.itemKey, verdict.attemptRef);
        const current = stored.get(key);
        if (current && Math.floor(Date.parse(verdict.at) / 1000) < Math.floor(Date.parse(current.at) / 1000)) continue;
        const seen = pending.get(key);
        if (!seen || Date.parse(verdict.at) > Date.parse(seen.verdict.at)) pending.set(key, { verdict, from: report.hostname ?? report.deviceId });
      }
    }
    return pending;
  }

  /** The queue as the owner sees it on this device: a verdict on its way from another device already counts as given. */
  function withPending(entries: PlanReviewEntry[], pending: Map<string, { verdict: SharedVerdict; from: string }>, reviewStageId: string): PlanReviewEntry[] {
    if (pending.size === 0) return entries;
    return entries.map((entry) => {
      const p = pending.get(keyOf(entry.itemKey, entry.attemptRef));
      if (!p) return entry;
      const v = p.verdict;
      return {
        ...entry,
        verdict: { stageId: reviewStageId, itemKey: entry.itemKey, attemptRef: entry.attemptRef, result: v.result, reportedBy: "owner", note: v.note, rating: v.rating, reasons: v.reasons, markers: v.markers, auditionFile: null, checks: [], metrics: {}, at: v.at },
        pendingFrom: p.from,
      };
    });
  }

  /**
   * BL-157 (AC-TC-03, review round 4): the plan's progress as the owner sees it here -- a track whose verdict is on its way
   * from another device no longer waits (items, waves and the `review_waiting` notice), like the queue and the badge. The
   * factory's reads keep the plain progress.
   */
  async function ownerProgress(row: StoredPlan, progress: PlanProgress, jobs: PlanJobRow[], results: PlanResultRow[]): Promise<PlanProgress> {
    if (!deps.peers) return progress;
    const pending = await pendingPeerVerdicts(row, await deps.store.listEvents(row.id), results);
    if (pending.size === 0) return progress;
    const given = reviewEntries(row, jobs, results).filter((e) => e.verdict === null && pending.has(keyOf(e.itemKey, e.attemptRef)));
    if (given.length === 0) return progress;
    const perItem = new Map<string, number>();
    const perGroup = new Map<string, number>();
    for (const e of given) {
      perItem.set(e.itemKey, (perItem.get(e.itemKey) ?? 0) + 1);
      if (e.groupId !== null) perGroup.set(e.groupId, (perGroup.get(e.groupId) ?? 0) + 1);
    }
    const rejected = given.filter((e) => e.validator === "rejected").length;
    const notices = progress.notices.flatMap((n): PlanNotice[] => {
      if (n.kind !== "review_waiting") return [n];
      const count = n.count - given.length;
      return count > 0 ? [{ kind: "review_waiting", count, passed: Math.max(0, n.passed - (given.length - rejected)), rejected: Math.max(0, n.rejected - rejected) }] : [];
    });
    return {
      ...progress,
      items: progress.items.map((i) => (perItem.has(i.itemKey) ? { ...i, waitingReview: Math.max(0, i.waitingReview - (perItem.get(i.itemKey) ?? 0)) } : i)),
      groups: progress.groups.map((g) => (perGroup.has(g.groupId) ? { ...g, counts: { ...g.counts, waitingReview: Math.max(0, g.counts.waitingReview - (perGroup.get(g.groupId) ?? 0)) } } : g)),
      notices,
    };
  }

  /** This device's queue of one of its own plans as the owner sees it here (history attached, pending verdicts counted). */
  async function ownerQueue(row: StoredPlan, jobs: PlanJobRow[], results: PlanResultRow[]): Promise<PlanReviewEntry[]> {
    const review = row.definition.stages.find((s) => s.kind === "owner_review");
    if (!review) return [];
    const [events, history] = await Promise.all([deps.store.listEvents(row.id), deps.store.listVerdictHistory(row.id)]);
    const entries = reviewEntries(row, jobs, results).map((e) => {
      const h = historyOf(history, e.itemKey, e.attemptRef);
      return h.length > 0 ? { ...e, history: h } : e;
    });
    return withPending(entries, await pendingPeerVerdicts(row, events, results), review.stageId);
  }

  /** BL-157 (AC-TC-01): a verdict given here ends this device's claim on that track. */
  async function endTrackClaim(ownerDeviceId: string, planId: string, itemKey: string, attemptRef: string): Promise<void> {
    const id = claimIdOf("attempt", ownerDeviceId, planId);
    const claim = (await deps.store.listClaims(now())).find((c) => c.claimId === id);
    if (claim && claim.itemKey === itemKey && claim.attemptRef === attemptRef) await deps.store.deleteClaim(id);
  }

  /**
   * BL-157 (SERVERS_MEDIA_PLAN.md AC-WV-05): a wave whose waiting count an owner verdict took from above zero to zero records
   * `group_reviewed` once -- the owner's accepted and rejected verdicts in it, and how many of the accepted ones the validator
   * had rejected (the factory's cue to recalibrate it). A wave finished again later records it again.
   */
  async function recordGroupsReviewed(row: StoredPlan, before: PlanReviewEntry[], after: PlanReviewEntry[]): Promise<void> {
    const waiting = (entries: PlanReviewEntry[], groupId: string) => entries.filter((e) => e.groupId === groupId && e.verdict === null).length;
    const groups = [...new Set(before.filter((e) => e.verdict === null && e.groupId !== null).map((e) => e.groupId as string))];
    for (const groupId of groups) {
      if (waiting(after, groupId) > 0) continue;
      const reviewed = after.filter((e) => e.groupId === groupId && e.verdict !== null);
      const accepted = reviewed.filter((e) => e.verdict?.result === "accepted");
      await record(row.id, "group_reviewed", "owner", {
        groupId,
        accepted: accepted.length,
        rejected: reviewed.filter((e) => e.verdict?.result === "rejected").length,
        overridesValidator: accepted.filter((e) => e.validator === "rejected").length,
      });
    }
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
        groups: groupIds.map((groupId) => {
          const given = (file.groups ?? []).find((g) => (g.groupId ?? g.id) === groupId);
          return normalizeGroup({ groupId, title: given?.title, dependsOn: given?.dependsOn, note: given?.note });
        }),
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

    /**
     * BL-157 (FO-REQ-0009 §4, AC-MV-01..04): the plan moves to another connected channel of this device. Every reported
     * `auditionFile` and every reference must already be in that channel's Sent to YTM (the factory copies them first);
     * one missing refuses the move with the list, `checkOnly` returns the same answer and changes nothing. Jobs, sessions,
     * results, verdicts and events stay as they are -- all of them are read by plan id, so progress and spend keep counting.
     */
    async movePlan(input: unknown, actor: PlanActor = "factory"): Promise<PlanMoveResult> {
      const parsed = parseWithSchema(movePlanInputSchema, input, "plan move");
      return serializedPerPlan(parsed.planId, async () => {
        const row = await requireActive(parsed.planId);
        const from = row.channelId;
        const to = parsed.channelId;
        if (to === from) throw planInvalid(`Plan ${row.id} is already on channel ${to}`, { planId: row.id, channelId: to });
        await requireConnected(to);
        const workspace = deps.files ? await deps.files.workspaceOf(to) : null;
        if (!deps.files || !workspace) throw planInvalid(`Channel ${to} has no workspace folder on this device (Settings → Channels); a plan's files live there`, { planId: row.id, channelId: to });
        const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
        const unfinishedJobs = jobs.filter((j) => UNFINISHED_JOB_STATUSES.has(j.status)).length;
        const files = [...new Set([...results.flatMap((r) => (r.auditionFile ? [r.auditionFile] : [])), ...(row.definition.references ?? []).map((r) => r.file)])].sort();
        const missing: string[] = [];
        for (const file of files) if (!(await deps.files.sentFileExists(workspace, file))) missing.push(file);
        const answer: PlanMoveResult = { planId: row.id, from, to, checked: files.length, missing: missing.slice(0, PLAN_MOVE_MISSING_LISTED), missingCount: missing.length, unfinishedJobs, moved: false };
        if (parsed.checkOnly) return answer;
        if (unfinishedJobs > 0) throw planInvalid(`Plan ${row.id} has ${unfinishedJobs} unfinished job(s); move it when they have finished`, { planId: row.id, unfinishedJobs });
        if (missing.length > 0) {
          throw planInvalid(`${missing.length} of ${files.length} file(s) of plan ${row.id} are not in channel ${to}'s Sent to YTM; copy them there first`, {
            planId: row.id,
            from,
            to,
            checked: files.length,
            missing: answer.missing,
            missingCount: missing.length,
          });
        }
        await mutate(row.id, (current) => {
          if (current.channelId !== from) throw planInvalid(`Plan ${row.id} moved to channel ${current.channelId} meanwhile`, { planId: row.id, channelId: current.channelId });
          // The files were checked against this revision; a plan changed meanwhile (e.g. a new reference) is checked again.
          if (current.revision !== row.revision) throw planInvalid(`Plan ${row.id} changed while its files were checked; move it again`, { planId: row.id });
          return { channelId: to };
        });
        await record(row.id, "plan_moved", actor, { from, to, checked: files.length });
        return { ...answer, moved: true };
      });
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
    async getPlan(input: unknown, opts: { ownerView?: boolean } = {}): Promise<PlanView & { events: PlanEvent[]; more: boolean; cursor: string }> {
      const parsed = parseWithSchema(getPlanInputSchema, input, "plan id");
      const row = await requirePlan(parsed.planId);
      const [jobs, results, sessions, recorded, history] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id), deps.store.listSessions(row.id), deps.store.listEvents(row.id), deps.store.listVerdictHistory(row.id)]);
      const plan = toPublicPlan(row);
      const at = now();
      const page = parsed.latest
        ? { events: planEvents(jobs, sessions, results, recorded, null, 1_000_000, history).events.slice(-500), more: false, cursor: null }
        : planEvents(jobs, sessions, results, recorded, parsed.since ? new Date(parsed.since) : null, 500, history);
      const progress = planProgress(plan, jobs, results, sessions, at);
      return {
        plan,
        progress: opts.ownerView ? await ownerProgress(row, progress, jobs, results) : progress,
        events: page.events,
        more: page.more,
        cursor: page.cursor ?? new Date(secondFloor(at).getTime() - EVENT_CURSOR_LOOKBACK_MS).toISOString(),
      };
    },

    /** `ownerView` (BL-157, AC-TC-03): the owner's Web view -- verdicts on their way from another device count as given. */
    async listPlans(input: unknown = {}, opts: { ownerView?: boolean } = {}): Promise<PlanView[]> {
      const parsed = parseWithSchema(listPlansInputSchema, input, "plan list");
      const rows = await deps.store.listPlans(parsed);
      return Promise.all(
        rows.map(async (row) => {
          const v = await view(row);
          if (!opts.ownerView) return v;
          const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
          return { ...v, progress: await ownerProgress(row, v.progress, jobs, results) };
        })
      );
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
      // BL-157 (AC-TC-04): a verdict already there -- given here, relayed, or on its way from another device -- is replaced
      // only when the owner confirmed it (`replace`); the screen asks first, this holds when the screen's data was stale.
      const history = await deps.store.listVerdictHistory(row.id);
      const current = results.find((r) => r.stageId === stage.stageId && r.itemKey === parsed.itemKey && r.attemptRef === parsed.attemptRef);
      if (!parsed.replace) {
        const events = await deps.store.listEvents(row.id);
        const incoming = (await pendingPeerVerdicts(row, events, results)).get(keyOf(parsed.itemKey, parsed.attemptRef));
        if (incoming) {
          throw planVerdictExists(`${parsed.itemKey} ${parsed.attemptRef} was already rated on ${incoming.from}`, { result: incoming.verdict.result, rating: incoming.verdict.rating, device: incoming.from, at: incoming.verdict.at });
        }
        if (current) {
          // The computer of the CURRENT verdict (review round 5): its own history row; a verdict from before the history (v69)
          // is named the way the history will name it (a proven relay, else this computer).
          const own = historyOf(history, parsed.itemKey, parsed.attemptRef);
          const device =
            current.reportedBy !== "owner"
              ? current.reportedBy
              : own.length > 0
                ? (historyEntryOfVerdict(own, current)?.device ?? null)
                : ((await relayOf(row.id, current))?.[1] ?? (await ownLabel()));
          throw planVerdictExists(`${parsed.itemKey} ${parsed.attemptRef} already has a verdict`, { result: current.result, rating: current.rating, device, at: current.at });
        }
      }
      const result = resultRow({ ...parsed, stageId: stage.stageId }, "owner", now().toISOString());
      await seedHistory(row.id, history, current);
      await deps.store.upsertResults(row.id, [result]);
      const given: PlanVerdictHistoryRow = {
        itemKey: result.itemKey,
        attemptRef: result.attemptRef,
        result: parsed.result,
        rating: result.rating,
        reasons: result.reasons,
        markers: result.markers,
        note: result.note,
        device: await ownLabel(),
        at: result.at,
      };
      await deps.store.insertVerdictHistory(row.id, given);
      history.push(given);
      await endTrackClaim(await ownDeviceId(), row.id, result.itemKey, result.attemptRef);
      await recordGroupsReviewed(row, reviewEntries(row, jobs, results), reviewEntries(row, jobs, await deps.store.listResults(row.id)));
      return result;
      });
    },

    /**
     * The owner's (or factory's) note on a whole wave (FO-MSG-0008 §4). BL-157 (AC-WV-04): the owner's goes to `ownerNote`, the
     * factory's to `note` (its context for the wave), so neither overwrites the other.
     */
    async setGroupNote(input: unknown, actor: PlanActor = "owner"): Promise<PlanView> {
      const parsed = parseWithSchema(groupNoteInputSchema, input, "group note");
      const field = actor === "owner" ? "ownerNote" : "note";
      const updated = await mutate(parsed.planId, (row) => {
        if (!row.definition.groups.some((g) => g.groupId === parsed.groupId)) throw planMismatch(`Plan ${row.id} has no group ${parsed.groupId}`, { planId: row.id, groupId: parsed.groupId });
        return { definition: { ...row.definition, groups: row.definition.groups.map((g) => (g.groupId === parsed.groupId ? { ...g, [field]: parsed.note } : g)) } };
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
      await checkJobs(planned, parsed.sessionId);
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
      await checkJobs(planned, parsed.sessionId);
      const result = await createJobs(row, parsed.sessionId, stage.stageId, planned);
      await record(row.id, "item_rerun", "factory", { sessionId: parsed.sessionId, itemKey: item.itemKey, seed, ...(result.stoppedAt ? { stoppedAt: result.stoppedAt } : {}) });
      return result;
    }
  }

  // The rest of the public surface (added to the object returned above).
  /** BL-162 (§5.4): this device's claims, written to its presence file at once; advisory, so a failure is ignored. */
  async function publishPresence(): Promise<void> {
    if (!deps.presence) return;
    try {
      await deps.presence.publish(await deps.store.listClaims(now()));
    } catch {
      // The plans report still carries the claims a minute later.
    }
  }

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
        // BL-157 (AC-TC-03): a verdict on its way from another device no longer waits here.
        const waiting = (await ownerQueue(row, jobs, results)).filter((e) => e.verdict === null);
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

    /**
     * BL-157 (SERVERS_MEDIA_PLAN.md AC-BL-01): the open Media work of each channel connected here -- this device's active
     * plans and the other devices' (minus the verdicts sent from here) -- and the active channel's counts for its badge.
     * A plan of a channel that is not connected here is not counted anywhere.
     */
    async channelSummary(input: { activeChannelId: string | null; connectedChannelIds: readonly string[] }): Promise<PlanChannelSummary> {
      const work = new Map<string, PlanChannelWork>(input.connectedChannelIds.map((channelId) => [channelId, { channelId, waitingReview: 0, waitingPassed: 0, waitingRejected: 0, plans: [], batches: [], notices: [] }]));
      const add = (
        row: PlanChannelWork,
        plan: { planId: string; title: string; groups: Array<{ groupId: string; title: string }> },
        device: PlanChannelWork["plans"][number]["device"],
        waiting: Array<{ groupId: string | null; rejected: boolean }>,
        notices: PlanNotice[]
      ) => {
        const rejected = waiting.filter((w) => w.rejected).length;
        row.waitingReview += waiting.length;
        row.waitingRejected += rejected;
        row.waitingPassed += waiting.length - rejected;
        if (waiting.length > 0) row.plans.push({ planId: plan.planId, title: plan.title, device, waiting: waiting.length });
        const titles = new Map(plan.groups.map((g) => [g.groupId, g.title]));
        const perGroup = new Map<string | null, number>();
        for (const w of waiting) perGroup.set(w.groupId, (perGroup.get(w.groupId) ?? 0) + 1);
        const order = [...plan.groups.map((g) => g.groupId), null];
        for (const groupId of [...perGroup.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
          row.batches.push({ planId: plan.planId, groupId, title: groupId === null ? "" : (titles.get(groupId) ?? groupId), waiting: perGroup.get(groupId) ?? 0 });
        }
        for (const notice of notices) if (notice.kind !== "review_waiting") row.notices.push({ planId: plan.planId, planTitle: plan.title, device, notice });
      };
      for (const row of await deps.store.listPlans({ status: "active" })) {
        const target = work.get(row.channelId);
        if (!target) continue;
        const [jobs, results, sessions] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id), deps.store.listSessions(row.id)]);
        const plan = toPublicPlan(row);
        const waiting = (await ownerQueue(row, jobs, results)).filter((e) => e.verdict === null);
        add(target, plan, null, waiting.map((e) => ({ groupId: e.groupId, rejected: e.validator === "rejected" })), planProgress(plan, jobs, results, sessions, now()).notices);
      }
      if (deps.peers) {
        const sent = new Set((await more.outgoingVerdicts()).map((v) => `${v.ownerDeviceId}\u0000${v.planId}\u0000${v.itemKey}\u0000${v.attemptRef}`));
        for (const report of await deps.peers.listPeerReports()) {
          for (const plan of report.plans.filter((p) => p.status === "active")) {
            const target = work.get(plan.channelId);
            if (!target) continue;
            const waiting = plan.review.filter((e) => e.verdict === null && !sent.has(`${report.deviceId}\u0000${plan.planId}\u0000${e.itemKey}\u0000${e.attemptRef}`));
            add(target, plan, { deviceId: report.deviceId, hostname: report.hostname }, waiting.map((e) => ({ groupId: e.groupId, rejected: validatorOfEntry(e) === "rejected" })), sharedNotices(plan.progress));
          }
        }
      }
      const active = input.activeChannelId ? work.get(input.activeChannelId) : undefined;
      return {
        activeChannelId: input.activeChannelId,
        waitingReview: active?.waitingReview ?? 0,
        waitingPassed: active?.waitingPassed ?? 0,
        waitingRejected: active?.waitingRejected ?? 0,
        channels: [...work.values()],
      };
    },

    /**
     * BL-157 (SERVERS_MEDIA_PLAN.md AC-TC-01, AC-WV-06): this device claims a track or a wave for review -- or gives it up
     * (`release`). A track claim moves with the track (one per plan) and lasts 10 minutes from the last call (the screen's
     * heartbeat); a verdict given here ends it. Advisory only: it reaches the other devices with this device's report.
     */
    async claimReview(input: unknown): Promise<{ claimId: string; until: string | null }> {
      const parsed = parseWithSchema(reviewClaimInputSchema, input, "review claim");
      const own = await ownDeviceId();
      const ownerDeviceId = parsed.deviceId ?? own;
      const claimId = claimIdOf(parsed.scope, ownerDeviceId, parsed.planId, parsed.groupId);
      // One plan's claims, one call at a time: a release and the next track's claim sent together never drop the new one
      // (review round 2).
      return serializedPerPlan(parsed.planId, async () => {
        if (parsed.release) {
          // Giving up removes only this device's own claim -- found by its id, and for a track only that track's (a track
          // claim moves with the track; review round 1). No plan or channel check: a claim is released even after the plan
          // closed or the active channel changed (review round 2).
          const stored = (await deps.store.listClaims(now())).find((c) => c.claimId === claimId);
          if (stored && (parsed.scope === "group" || (stored.itemKey === (parsed.itemKey ?? null) && stored.attemptRef === (parsed.attemptRef ?? null)))) await deps.store.deleteClaim(claimId);
          await publishPresence();
          return { claimId, until: null };
        }
        // The plan must be one this device can review: its own active plan, or an active plan in that device's report.
        let entries: Array<{ itemKey: string; attemptRef: string; groupId: string | null }>;
        let groups: string[];
        if (ownerDeviceId === own) {
          const row = await requireActive(parsed.planId);
          const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
          entries = reviewEntries(row, jobs, results);
          groups = row.definition.groups.map((g) => g.groupId);
        } else {
          const report = deps.peers ? (await deps.peers.listPeerReports()).find((r) => r.deviceId === ownerDeviceId) : undefined;
          const plan = report?.plans.find((p) => p.planId === parsed.planId);
          if (!plan) throw planNotFound(parsed.planId);
          if (plan.status !== "active") throw planClosed(parsed.planId, plan.status);
          entries = plan.review;
          groups = plan.groups.map((g) => g.groupId);
        }
        if (parsed.scope === "attempt" && !entries.some((e) => e.itemKey === parsed.itemKey && e.attemptRef === parsed.attemptRef)) {
          throw planMismatch(`Plan ${parsed.planId} has no attempt ${parsed.attemptRef} of ${parsed.itemKey} to review`, { planId: parsed.planId, itemKey: parsed.itemKey, attemptRef: parsed.attemptRef });
        }
        if (parsed.scope === "group" && !groups.includes(parsed.groupId as string)) throw planMismatch(`Plan ${parsed.planId} has no group ${parsed.groupId}`, { planId: parsed.planId, groupId: parsed.groupId });
        const at = now();
        const existing = (await deps.store.listClaims(at)).find((c) => c.claimId === claimId);
        const same = existing && existing.itemKey === (parsed.itemKey ?? null) && existing.attemptRef === (parsed.attemptRef ?? null);
        const until = new Date(at.getTime() + REVIEW_CLAIM_TTL_MS).toISOString();
        await deps.store.upsertClaim({
          claimId,
          planId: parsed.planId,
          ownerDeviceId,
          scope: parsed.scope,
          itemKey: parsed.scope === "attempt" ? (parsed.itemKey ?? null) : null,
          attemptRef: parsed.scope === "attempt" ? (parsed.attemptRef ?? null) : null,
          groupId: parsed.scope === "group" ? (parsed.groupId ?? null) : null,
          since: same && existing ? existing.since : at.toISOString(),
          until,
        });
        await publishPresence();
        return { claimId, until };
      });
    },

    /** BL-157 (AC-TC-01): this device's live claims, for its report. */
    async ownClaims(): Promise<SharedClaim[]> {
      return deps.store.listClaims(now());
    },

    /**
     * BL-157 (AC-TC-02): the OTHER devices' live claims on a plan owned by `ownerDeviceId` (this device for its own plans),
     * each named by the device that made it. A claim reaching implausibly far ahead is not believed.
     */
    /** BL-162 (§5.4): the other computers' live claims on a plan -- this device's (no `ownerDeviceId`) or another's -- for the review screen's quick poll. */
    async liveClaims(input: { planId: string; ownerDeviceId?: string }): Promise<PlanReviewClaim[]> {
      return more.claimsOn(input.ownerDeviceId ?? (await ownDeviceId()), input.planId);
    },

    async claimsOn(ownerDeviceId: string, planId: string): Promise<PlanReviewClaim[]> {
      return (await more.peerClaims()).filter((c) => c.ownerDeviceId === ownerDeviceId && c.planId === planId).map(({ ownerDeviceId: _o, planId: _p, ...claim }) => (void _o, void _p, claim));
    },

    /** Every live claim in the other devices' reports, with the plan it is on (the peer plans view filters them itself). */
    async peerClaims(): Promise<Array<PlanReviewClaim & { ownerDeviceId: string; planId: string }>> {
      if (!deps.peers && !deps.presence) return [];
      const at = now().getTime();
      const out: Array<PlanReviewClaim & { ownerDeviceId: string; planId: string }> = [];
      const add = (claims: readonly SharedClaim[], device: string) => {
        for (const c of claims) {
          const until = Date.parse(c.until);
          if (!(until > at) || until > at + PEER_CLAIM_MAX_AHEAD_MS) continue;
          out.push({ ownerDeviceId: c.ownerDeviceId, planId: c.planId, scope: c.scope, itemKey: c.itemKey, attemptRef: c.attemptRef, groupId: c.groupId, device, since: c.since, until: c.until });
        }
      };
      // BL-162 (§5.4): a device's presence file is fresher than its report -- when it has one, it alone says what is open there
      // (a claim given up a moment ago is gone from it, while the report may still carry it). A presence file that cannot be
      // read leaves the reports to speak.
      const presence = deps.presence ? await deps.presence.readPeers().catch(() => []) : [];
      const withPresence = new Set(presence.map((p) => p.deviceId));
      for (const report of deps.peers ? await deps.peers.listPeerReports() : []) {
        if (!withPresence.has(report.deviceId)) add(report.claims ?? [], report.hostname ?? report.deviceId);
      }
      for (const p of presence) add(p.claims, p.hostname ?? p.deviceId);
      return out;
    },

    /** BL-143 phase 2: the other devices' plans (read-only), each report with its age and whether it is stale. */
    async peerPlans(): Promise<Array<{ deviceId: string; hostname: string | null; updatedAt: string; stale: boolean; version: number; plans: SharedPlan[] }>> {
      if (!deps.peers) return [];
      const at = now().getTime();
      // BL-162: `version` -- a device below 3 cannot take wave notes from here yet.
      return (await deps.peers.listPeerReports()).map((r) => ({ deviceId: r.deviceId, hostname: r.hostname, updatedAt: r.updatedAt, stale: at - Date.parse(r.updatedAt) > PEER_PLANS_STALE_AFTER_MS, version: r.version, plans: r.plans }));
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
      const entry = plan.review.find((e) => e.itemKey === parsed.itemKey && e.attemptRef === parsed.attemptRef);
      if (!entry) {
        throw planMismatch(`Plan ${parsed.planId} on that device has no attempt ${parsed.attemptRef} of ${parsed.itemKey} to review`, { planId: parsed.planId, itemKey: parsed.itemKey, attemptRef: parsed.attemptRef });
      }
      // BL-157 (AC-TC-04): a verdict already there -- that device's, or one sent from here and not applied yet -- is replaced
      // only when the owner confirmed it.
      if (!parsed.replace) {
        const sent = (await more.outgoingVerdicts()).filter((v) => v.ownerDeviceId === parsed.deviceId && v.planId === parsed.planId && v.itemKey === parsed.itemKey && v.attemptRef === parsed.attemptRef).at(-1);
        const theirs = entry.verdict;
        if (sent && (!theirs || Math.floor(Date.parse(sent.at) / 1000) > Math.floor(Date.parse(theirs.at) / 1000))) {
          throw planVerdictExists(`${parsed.itemKey} ${parsed.attemptRef} was already rated here`, { result: sent.result, rating: sent.rating, device: await ownLabel(), at: sent.at });
        }
        if (theirs) {
          const device = theirs.reportedBy !== "owner" ? theirs.reportedBy : (historyEntryOfVerdict(entry.history, theirs)?.device ?? report?.hostname ?? parsed.deviceId);
          throw planVerdictExists(`${parsed.itemKey} ${parsed.attemptRef} already has a verdict`, { result: theirs.result, rating: theirs.rating, device, at: theirs.at });
        }
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
      await serializedPerPlan(parsed.planId, () => endTrackClaim(parsed.deviceId, parsed.planId, parsed.itemKey, parsed.attemptRef));
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
      if (entry.jobOutput && entry.jobId) return { channelId: entry.jobChannelId ?? plan.channelId, kind: "job", jobId: entry.jobId, localPath: entry.jobOutput };
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
     * BL-162 (FO-REQ-0013 §2.3, MEDIA_UX_REDESIGN_PLAN.md §5.2): the owner's note on a wave of ANOTHER device's plan -- kept here
     * and carried in this device's report (version 3) until that device applies it. Refused when that device's report is older
     * than version 3: it could not read this device's report any more (the verdicts it carries would stop too).
     */
    async recordPeerGroupNote(input: unknown): Promise<SharedGroupNote> {
      const parsed = parseWithSchema(peerGroupNoteInputSchema, input, "wave note");
      if (!deps.peers || !deps.generateId) throw planInvalid("Wave notes on other devices' plans are not available in this process");
      const report = (await deps.peers.listPeerReports()).find((r) => r.deviceId === parsed.deviceId);
      const plan = report?.plans.find((p) => p.planId === parsed.planId);
      if (!report || !plan) throw planNotFound(parsed.planId);
      if (report.version < 3) {
        throw planInvalid(`${report.hostname ?? report.deviceId} runs an older version of the app: update it there to send wave notes`, { reason: "peer_update_required", device: report.hostname ?? report.deviceId });
      }
      if (plan.status !== "active") throw planClosed(parsed.planId, plan.status);
      if (!plan.groups.some((g) => g.groupId === parsed.groupId)) throw planMismatch(`Plan ${parsed.planId} has no group ${parsed.groupId}`, { planId: parsed.planId, groupId: parsed.groupId });
      const note: SharedGroupNote = { noteId: deps.generateId(), planId: parsed.planId, ownerDeviceId: parsed.deviceId, groupId: parsed.groupId, note: parsed.note, at: now().toISOString() };
      await deps.store.insertPeerGroupNote(note);
      return note;
    },

    /** BL-162: the newest wave note per device, plan and wave written here in the last 30 days -- what this device's report carries. */
    async outgoingGroupNotes(): Promise<SharedGroupNote[]> {
      const newest = new Map<string, SharedGroupNote>();
      for (const n of await deps.store.listPeerGroupNotes(new Date(now().getTime() - PEER_VERDICTS_KEPT_MS).toISOString())) newest.set(`${n.ownerDeviceId}\u0000${n.planId}\u0000${n.groupId}`, n);
      return [...newest.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-200);
    },

    /**
     * BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.2, AC-NOTE-01..07): the wave notes other devices carry for THIS device's plans. A note
     * newer -- by when it was WRITTEN -- than the wave's last owner-note change is applied; an older one is recorded as
     * superseded and changes nothing. Applied or superseded, its id is in a `group_note` event, so it is weighed once.
     */
    async applyPeerGroupNotes(): Promise<{ applied: number; skipped: number }> {
      if (!deps.peers) return { applied: 0, skipped: 0 };
      const own = await deps.peers.ownDeviceId();
      const at = now().getTime();
      const byPlan = new Map<string, Array<{ note: SharedGroupNote; from: string }>>();
      for (const report of await deps.peers.listPeerReports()) {
        for (const note of report.groupNotes ?? []) {
          if (note.ownerDeviceId !== own) continue;
          const list = byPlan.get(note.planId) ?? [];
          list.push({ note, from: report.hostname ?? report.deviceId });
          byPlan.set(note.planId, list);
        }
      }
      let applied = 0;
      let skipped = 0;
      for (const [planId, incoming] of byPlan) {
        const done = await serializedPerPlan(planId, async () => {
          const row = await deps.store.getPlan(planId);
          if (!row || row.status !== "active") return { applied: 0, skipped: incoming.length };
          const events = await deps.store.listEvents(row.id);
          const handled = new Set(events.filter((e) => e.kind === "group_note" && typeof e.details.noteId === "string").map((e) => e.details.noteId as string));
          const lastChange = ownerNoteTimes(events);
          let a = 0;
          let k = 0;
          let current = row;
          for (const { note, from } of [...incoming].sort((x, y) => Date.parse(x.note.at) - Date.parse(y.note.at))) {
            if (handled.has(note.noteId)) continue;
            const written = Date.parse(note.at);
            // A note dated in the future (a fast clock) is not taken: it would block every newer one on that wave.
            if (!current.definition.groups.some((g) => g.groupId === note.groupId) || !Number.isFinite(written) || written > at + 5 * 60_000) {
              k++;
              continue;
            }
            const details = { groupId: note.groupId, note: note.note, noteId: note.noteId, fromDevice: from, writtenAt: note.at };
            const last = lastChange.get(note.groupId);
            if (last !== undefined && written <= last) {
              await record(row.id, "group_note", "owner", { ...details, superseded: true });
              handled.add(note.noteId);
              k++;
              continue;
            }
            try {
              current = await mutate(planId, (r) => ({ definition: { ...r.definition, groups: r.definition.groups.map((g) => (g.groupId === note.groupId ? { ...g, ownerNote: note.note } : g)) } }));
            } catch {
              // The plan kept changing under another writer, or it closed meanwhile: nothing was written and the note is not
              // marked handled, so the next tick weighs it again (it is never silently dropped).
              k++;
              continue;
            }
            await record(row.id, "group_note", "owner", details);
            handled.add(note.noteId);
            lastChange.set(note.groupId, written);
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
          const [jobs, results, events, history] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id), deps.store.listEvents(row.id), deps.store.listVerdictHistory(row.id)]);
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
            if (!known || Date.parse(verdict.at) > at + 5 * 60_000) {
              k++;
              continue;
            }
            // The verdict stored before the history existed goes into it first (review round 2).
            await seedHistory(row.id, history, stored);
            if (older) {
              // BL-157 (AC-TC-05, review round 1): a verdict older than the stored one does not replace it, but the history
              // keeps it -- the double rating claims and the confirmation exist for must not lose either verdict. Recorded as
              // handled, so the next tick does not weigh it again.
              const keptRow: PlanVerdictHistoryRow = {
                itemKey: verdict.itemKey,
                attemptRef: verdict.attemptRef,
                result: verdict.result,
                rating: verdict.rating,
                reasons: verdict.reasons,
                markers: verdict.markers,
                note: verdict.note,
                device: from,
                at: verdict.at,
              };
              await deps.store.insertVerdictHistory(row.id, keptRow);
              history.push(keptRow);
              await record(row.id, "peer_verdict", "owner", { verdictId: verdict.verdictId, fromDevice: from, itemKey: verdict.itemKey, result: verdict.result, superseded: true });
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
            // BL-157 (AC-TC-05): the history keeps the verdict as given there, with the device it came from -- also in the list
            // held for this tick, so a second verdict on the attempt in the same tick does not seed it again (review round 3).
            const appliedRow: PlanVerdictHistoryRow = {
              itemKey: verdict.itemKey,
              attemptRef: verdict.attemptRef,
              result: verdict.result,
              rating: verdict.rating,
              reasons: verdict.reasons,
              markers: verdict.markers,
              note: verdict.note,
              device: from,
              at: verdict.at,
            };
            await deps.store.insertVerdictHistory(row.id, appliedRow);
            history.push(appliedRow);
            current.set(key, row2);
            await record(row.id, "peer_verdict", "owner", { verdictId: verdict.verdictId, fromDevice: from, itemKey: verdict.itemKey, result: verdict.result });
            a++;
          }
          // BL-157 (AC-WV-05): a verdict from the other computer may finish a wave too.
          if (a > 0) await recordGroupsReviewed(row, reviewEntries(row, jobs, results), reviewEntries(row, jobs, await deps.store.listResults(row.id)));
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
        const [jobs, results, sessions, recorded, history] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id), deps.store.listSessions(row.id), deps.store.listEvents(row.id), deps.store.listVerdictHistory(row.id)]);
        const progress = planProgress(plan, jobs, results, sessions, now());
        // A job's error text can name local paths: other devices get the event without it (independent review, AC-GP2-01).
        const events = planEvents(jobs, sessions, results, recorded, null, 100_000, history)
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
          // BL-157 (AC-RP-03): the job's output is in the workspace of the channel the job ran on, not the plan's (a moved plan).
          const jobChannelId = entry.jobId ? (jobs.find((j) => j.id === entry.jobId)?.channelId ?? null) : null;
          // BL-157 (report v2, AC-TC-05): the attempt's verdict history travels with it.
          const entryHistory = historyOf(history, entry.itemKey, entry.attemptRef);
          review.push({ ...shared, stages: entry.stages.map(shareRow), verdict: entry.verdict ? shareRow(entry.verdict) : null, params: {}, jobOutput, jobChannelId, ...(entryHistory.length > 0 ? { history: entryHistory } : {}) });
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
          // BL-162 (v3): each wave's owner note with the time it was written, so a computer that sent one can tell what became of it.
          groups: plan.groups.map((g) => {
            const written = ownerNoteTimes(recorded).get(g.groupId);
            return { ...g, ownerNoteAt: written === undefined ? null : new Date(written).toISOString() };
          }),
          items: plan.items.map((i) => ({ itemKey: i.itemKey, groupId: i.groupId, templateLabel: i.templateLabel ?? i.templateId, targetCount: i.targetCount, mode: i.mode })),
          progress: progress as unknown as Record<string, unknown>,
          itemParams,
          references: plan.references ?? [],
          events,
          review,
          // BL-157 (report v2, AC-WV-03): the waves' context, computed here on the owning device.
          batches: reviewBatches(plan, jobs, results),
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
    async reviewQueue(input: unknown): Promise<{ planId: string; entries: PlanReviewEntry[]; references: PlanReference[]; batches: PlanReviewBatch[]; claims: PlanReviewClaim[] }> {
      const { planId } = parseWithSchema(getPlanInputSchema.pick({ planId: true }), input, "plan id");
      const row = await requirePlan(planId);
      const [jobs, results] = await Promise.all([deps.store.listJobs(row.id), deps.store.listResults(row.id)]);
      // BL-157 (AC-WV-03, AC-TC-02/03/05): each wave's context, the verdicts' history, verdicts on their way from another
      // device counted as given, and the other devices' claims on this plan.
      return {
        planId,
        entries: await ownerQueue(row, jobs, results),
        references: row.definition.references ?? [],
        batches: reviewBatches(toPublicPlan(row), jobs, results),
        claims: await more.claimsOn(await ownDeviceId(), row.id),
      };
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
      // BL-157 (AC-MV-05): a job's output is in the workspace of the channel it ran on, also after the plan moved.
      return { channelId: job.channelId, kind: "job", jobId: job.id, localPath: playable.localPath };
    },

    /** BL-143 phase 3 (FO-MSG-0009): a plan reference's file for A/B -- named only by the plan, never by the request. */
    async resolveReference(input: { planId: string; id: string }): Promise<{ channelId: string; kind: "sent"; relativePath: string }> {
      const row = await requirePlan(input.planId);
      const reference = (row.definition.references ?? []).find((r) => r.id === input.id);
      if (!reference) throw planMismatch(`Plan ${row.id} has no reference ${input.id}`, { planId: row.id, referenceId: input.id });
      return { channelId: row.channelId, kind: "sent", relativePath: reference.file };
    },

    /**
     * BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-03, ADR 0004 (b)): the owner's Web UI shows only the active channel's plans. A plan
     * of another channel -- or any plan while no channel is active -- is "not found", like an unknown one.
     */
    async assertPlanOfChannel(planId: string, channelId: string | null): Promise<void> {
      const row = await deps.store.getPlan(planId);
      if (!row || !channelId || row.channelId !== channelId) throw planNotFound(planId);
    },

    /** The same for another device's plan, judged by the channel that device's latest report names. */
    async assertPeerPlanOfChannel(deviceId: string, planId: string, channelId: string | null): Promise<void> {
      const report = deps.peers ? (await deps.peers.listPeerReports()).find((r) => r.deviceId === deviceId) : undefined;
      const plan = report?.plans.find((p) => p.planId === planId);
      if (!plan || !channelId || plan.channelId !== channelId) throw planNotFound(planId);
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
