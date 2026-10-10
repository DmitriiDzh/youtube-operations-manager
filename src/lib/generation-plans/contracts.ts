import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// BL-143 (ADR 0029, docs/roadmap/plans/GENERATION_PLANS_PLAN.md): generation plans. A plan is a definition (stages, groups,
// items with their job params) plus results. In-app (generate) results are READ from the media jobs linked to the plan,
// never copied; external stages and verdicts are rows of their own. Everything derived (counts, spend, ETA, budget warnings,
// events) is computed when read.
// ---------------------------------------------------------------------------

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

export const PLAN_STAGE_KINDS = ["in_app", "external", "owner_review"] as const;
export type PlanStageKind = (typeof PLAN_STAGE_KINDS)[number];
export const PLAN_STATUSES = ["active", "completed", "cancelled"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_ITEM_MODES = ["fixed", "until_accepted"] as const;
export type PlanItemMode = (typeof PLAN_ITEM_MODES)[number];
/** What a report or verdict can say about one attempt at an external or owner-review stage. */
export const PLAN_RESULTS = ["done", "failed", "accepted", "rejected"] as const;
export type PlanResultValue = (typeof PLAN_RESULTS)[number];
export type PlanReporter = "factory" | "owner" | "import";
export type PlanActor = "factory" | "owner";

export type PlanParamValue = string | number | boolean;

export type PlanStage = { stageId: string; title: string; kind: PlanStageKind };
/**
 * `note` is the factory's context for the wave; `ownerNote` (BL-157, SERVERS_MEDIA_PLAN.md AC-WV-04) is the owner's own note on
 * it, kept apart so neither overwrites the other -- present only once the owner wrote one.
 */
export type PlanGroup = { groupId: string; title: string; dependsOn: string | null; note: string | null; ownerNote?: string | null };
export type PlanItem = {
  itemKey: string;
  groupId: string | null;
  /** Free text as the factory names the template (an imported plan may say "a / b"); never resolved. */
  templateLabel: string | null;
  /** A real workflow template id; checked only when jobs are created from the item. */
  templateId: string | null;
  variant: string | null;
  targetCount: number;
  mode: PlanItemMode;
  /** `until_accepted` only: give up after this many attempts (null = no cap of the plan's own). */
  maxAttempts: number | null;
  /** The job parameters exactly as `create_job` takes them. */
  params: Record<string, PlanParamValue>;
  /** One job per seed (`fixed`), or the seeds tried in order (`until_accepted`). */
  seeds: number[];
};
/** BL-143 phase 3 (FO-MSG-0009): a reference track for A/B listening, copied by the factory into the channel's Sent to YTM. */
export type PlanReference = { id: string; label: string; file: string; lufs: number | null; lra: number | null; truePeak: number | null };
export type PlanDefinition = {
  stages: PlanStage[];
  groups: PlanGroup[];
  items: PlanItem[];
  references?: PlanReference[];
  /** BL-153 (FO-REQ-0008): validator-rejected attempts that can be played also wait for the owner's review. Default off. */
  reviewRejected?: boolean;
};

export type GenerationPlan = {
  planId: string;
  title: string;
  channelId: string;
  owner: "factory" | "operator";
  status: PlanStatus;
  budget: { usd: number | null; gpuMinutes: number | null };
  note: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
} & PlanDefinition;

export type PlanCheck = {
  id: string;
  label: string | null;
  value: number | string | boolean | null;
  unit: string | null;
  threshold: number | string | null;
  pass: boolean;
  /** The check's weight class; `pass` is the verdict (a passing check may well be of severity `fail`). */
  severity: "info" | "warn" | "fail";
  atSeconds: [number, number] | null;
  detail: string | null;
};
export type PlanMarker = { start: number; end: number | null; note: string | null };

/**
 * The files the review player plays or shows, by extension (BL-143 AC-GP-14). BL-173: here, not in the audition route, so a
 * re-check's file is refused at opening by the same list the player serves.
 */
export const AUDITION_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
});

/** The player's content type for a file name or path, by its extension; null = not played. */
export function auditionContentType(file: string): string | null {
  const name = file.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (AUDITION_CONTENT_TYPES[name.slice(dot).toLowerCase()] ?? null) : null;
}

export type PlanResultRow = {
  stageId: string;
  itemKey: string;
  attemptRef: string;
  result: PlanResultValue;
  reportedBy: PlanReporter;
  note: string | null;
  rating: number | null;
  reasons: string[];
  markers: PlanMarker[];
  auditionFile: string | null;
  checks: PlanCheck[];
  metrics: Record<string, number | string | boolean | null>;
  /** BL-143 phase 3: plan references nearest to this attempt (the validator's nearest library tracks), for A/B. */
  referenceIds?: string[];
  at: string;
};

/** How one in-app attempt (a job, or an attempt imported from a plan file) stands. */
export type PlanAttemptState = "queued" | "running" | "done" | "failed" | "interrupted" | "cancelled";

export type PlanAttempt = {
  attemptRef: string;
  itemKey: string;
  state: PlanAttemptState;
  jobId: string | null;
  sessionId: string | null;
  seed: number | null;
  createdAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

export type PlanStageCounts = {
  planned: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  interrupted: number;
  cancelled: number;
  accepted: number;
  rejected: number;
};

export type PlanItemProgress = {
  itemKey: string;
  groupId: string | null;
  targetCount: number;
  mode: PlanItemMode;
  attempts: number;
  /** Attempts at the in-app stage that ended done. */
  generated: number;
  /** Attempts accepted at the final stage (owner review when the plan has one, else the last stage). */
  accepted: number;
  rejected: number;
  open: number;
  waitingReview: number;
  /** Generated attempts still on their way through the later stages (no final verdict, not rejected). */
  pending: number;
  /** How many more attempts the item still needs (0 when complete). */
  missing: number;
};

/** BL-143 slice 4: one attempt on the owner's review screen, with what the earlier stages said about it. */
export type PlanReviewEntry = {
  itemKey: string;
  groupId: string | null;
  attemptRef: string;
  jobId: string | null;
  seed: number | null;
  /** The item's job params (the generation details shown next to the player). */
  params: Record<string, PlanParamValue>;
  /** The external stages' rows for this attempt (validator checks, metrics, notes), in stage order. */
  stages: PlanResultRow[];
  /** The owner's verdict when given (null = waiting). */
  verdict: PlanResultRow | null;
  /** Something can be played: a reported audition file or a job of this plan. */
  playable: boolean;
  /**
   * BL-153: what the stage right before the owner review said -- "passed" (accepted/done, or a finished job when that stage is
   * in-app) or "rejected"; null when it said nothing (an attempt that only has an owner verdict).
   */
  validator: PlanValidatorVerdict | null;
  /** BL-157 (AC-TC-05): the attempt's owner verdicts, oldest first (the last 10); absent when there are none. */
  history?: PlanVerdictHistoryEntry[];
  /**
   * BL-157 (AC-TC-03): on the device that owns the plan, a verdict another device sent and this one has not applied yet --
   * shown as "rated on <device>, being applied" and already counted as given (`verdict` carries it).
   */
  pendingFrom?: string;
};

export type PlanValidatorVerdict = "passed" | "rejected";

/**
 * BL-153: the validator verdict of a review entry from what its stages said -- for an entry that does not carry `validator`
 * (another device's report: the shared format has no such field, so devices on different versions still read each other).
 * The last stage row before the review decides, as in `reviewCandidates`.
 */
export function validatorOfEntry(entry: { validator?: PlanValidatorVerdict | null; stages: Array<{ result: PlanResultValue }> }): PlanValidatorVerdict | null {
  if (entry.validator !== undefined) return entry.validator;
  const last = entry.stages.at(-1);
  if (!last) return null;
  return last.result === "rejected" || last.result === "failed" ? "rejected" : "passed";
}

/**
 * BL-157 (AC-TC-04, review round 5): the history row of the CURRENT verdict -- the last one of the same second, result and
 * rating (the newest-by-time row can be another verdict: a peer verdict of the same second wins). Else the last row.
 */
export function historyEntryOfVerdict<T extends { result: string; rating: number | null; at: string; kept?: boolean }>(history: readonly T[] | undefined, verdict: { result: string; rating: number | null; at: string }): T | undefined {
  // BL-173: a kept re-check answer is a note, never the verdict itself.
  const verdicts = (history ?? []).filter((h) => h.kept !== true);
  if (verdicts.length === 0) return undefined;
  const second = Math.floor(Date.parse(verdict.at) / 1000);
  for (let i = verdicts.length - 1; i >= 0; i--) {
    const h = verdicts[i];
    if (Math.floor(Date.parse(h.at) / 1000) === second && h.result === verdict.result && h.rating === verdict.rating) return h;
  }
  return verdicts.at(-1);
}

export type PlanEvent = { at: string; kind: string; actor: string; details: Record<string, unknown> };

export type PlanProgress = {
  stages: Array<PlanStage & { counts: PlanStageCounts }>;
  /** BL-173: `rechecks` = the wave's open re-checks (never part of `waitingReview`). */
  groups: Array<{ groupId: string; title: string; counts: { items: number; generated: number; accepted: number; rejected: number; waitingReview: number; missing: number; rechecks: number } }>;
  items: PlanItemProgress[];
  spend: { usd: number; gpuMinutes: number; sessions: Array<{ sessionId: string; status: string; gpuTypeId: string | null; usd: number; final: boolean; stopReason: string | null }> };
  budget: { usd: number | null; usedShare: number | null; warnings: Array<"80" | "100"> };
  /** Mean finished-job duration on the same GPU type × attempts still missing; null below 3 finished samples. */
  eta: { seconds: number | null; gpuTypeId: string | null; samples: number };
  /** BL-143 phase 3 (AC-GP3-01): what the owner and the factory should notice now, derived like everything else. */
  notices: PlanNotice[];
  /** BL-173 (PLAN_RECHECKS_PLAN.md §2.5): the plan's open re-checks (apart from `waitingReview`). */
  rechecksOpen: number;
  /** BL-173: every re-check of the plan with its attempt's current file -- in `factory_plan_get` only. */
  rechecks?: PlanRecheckView[];
};

export type PlanNotice =
  | { kind: "stage_complete"; stageId: string; title: string }
  | { kind: "budget_80" | "budget_100" }
  | { kind: "plan_complete" }
  /** until_accepted items that used up maxAttempts below their target. */
  | { kind: "attempts_exhausted"; count: number }
  /** BL-153: `passed` + `rejected` = `count` (rejected ones wait only when the plan's `reviewRejected` is on). */
  | { kind: "review_waiting"; count: number; passed: number; rejected: number };

export type PlanView = { plan: GenerationPlan; progress: PlanProgress };

/**
 * BL-157 (SERVERS_MEDIA_PLAN.md AC-WV-03, FO-REQ-0009 §7.2): one wave (group) of a plan for the review's context card --
 * computed on the device that owns the plan, carried to the others in the plans report.
 */
export type PlanReviewBatch = {
  groupId: string;
  title: string;
  /** The factory's context for the wave. */
  note: string | null;
  /** The owner's own note on the wave. */
  ownerNote: string | null;
  /** The earliest attempt of the wave (a job's creation, or a reported row's time); null = no attempt yet. */
  firstAt: string | null;
  /** The wave's items' templates (label, else id), each once. */
  templates: string[];
  /** The item params whose values differ between the wave's items, each with its distinct values in item order. */
  differingParams: Array<{ name: string; values: PlanParamValue[] }>;
  /** At the stage right before the owner's review: attempts it passed (accepted / done) and rejected. */
  validator: { passed: number; rejected: number };
};

/**
 * BL-157 (SERVERS_MEDIA_PLAN.md AC-TC-05): one owner verdict of an attempt, as its history shows it (oldest first). BL-173: an
 * answer to a re-check carries its `recheckId`; `kept` = the owner kept the verdict and only wrote a note (not a verdict: it
 * changes nothing and gives no `owner_verdict` event; `result` repeats the verdict it kept).
 */
export type PlanVerdictHistoryEntry = { result: "accepted" | "rejected"; rating: number | null; note: string | null; device: string; at: string; recheckId?: string; kept?: boolean };

/** The full stored row (the history of a plan, every attempt). */
export type PlanVerdictHistoryRow = PlanVerdictHistoryEntry & { itemKey: string; attemptRef: string; reasons: string[]; markers: PlanMarker[] };

/** BL-157 (AC-TC-04): what is already there when a verdict would replace it -- for "Already rated on … Replace?". */
export type PlanExistingVerdict = { result: string; rating: number | null; device: string | null; at: string };

/** BL-157 (AC-TC-01/02, AC-WV-06): "being reviewed on <device> since <time>" -- another device's claim on a track or a wave. */
export type PlanReviewClaim = { scope: "attempt" | "group"; itemKey: string | null; attemptRef: string | null; groupId: string | null; device: string; since: string; until: string };

/** BL-157 (SERVERS_MEDIA_PLAN.md AC-BL-01): another device's plan, named for "open the place" (null = this device's). */
export type PlanDeviceRef = { deviceId: string; hostname: string | null } | null;

/**
 * BL-157 (AC-BL-01/04): one connected channel's open Media work -- what its menu badge, the channel switcher and (for a
 * channel that is not active) the bell show. Counts include other devices' plans of the channel, minus verdicts sent from here.
 */
export type PlanChannelWork = {
  channelId: string;
  waitingReview: number;
  waitingPassed: number;
  waitingRejected: number;
  /** The active plans with tracks waiting, in plan order (the bell opens the review when there is one). */
  plans: Array<{ planId: string; title: string; device: PlanDeviceRef; waiting: number }>;
  /** One row per wave with tracks waiting (groupId null = tracks in no wave). */
  batches: Array<{ planId: string; groupId: string | null; title: string; waiting: number }>;
  /** The active plans' notices other than `review_waiting` (that one is the counts above). */
  notices: Array<{ planId: string; planTitle: string; device: PlanDeviceRef; notice: Exclude<PlanNotice, { kind: "review_waiting" }> }>;
};

export type PlanChannelSummary = {
  /** The channel these counts treat as active (the bell leaves exactly this one out); null = none. */
  activeChannelId: string | null;
  /** The ACTIVE channel's waiting tracks (the Media menu badge); zero while no channel is active. */
  waitingReview: number;
  waitingPassed: number;
  waitingRejected: number;
  /** Every channel connected on this device, in the order given. */
  channels: PlanChannelWork[];
};

/**
 * BL-157 (AC-MV-03): a plan move's file check. `checked` = the distinct files checked (every reported `auditionFile` and
 * every reference file); `missing` lists up to `PLAN_MOVE_MISSING_LISTED` of the `missingCount` not found in the target
 * channel's Sent to YTM; `unfinishedJobs` = jobs of the plan still queued or running (a move waits for them).
 */
export type PlanMoveResult = {
  planId: string;
  from: string;
  to: string;
  checked: number;
  missing: string[];
  missingCount: number;
  unfinishedJobs: number;
  moved: boolean;
};

export const PLAN_MOVE_MISSING_LISTED = 500;

export type PlanTodo = {
  planId: string;
  short: Array<{ itemKey: string; groupId: string | null; missing: number; mode: PlanItemMode }>;
  waitingReview: Array<{ itemKey: string; attemptRef: string; validator: PlanValidatorVerdict }>;
  rerun: Array<{ itemKey: string; attemptRef: string; state: "failed" | "interrupted" }>;
  /** BL-173: the open re-checks, oldest first. */
  rechecks: Array<{ recheckId: string; kind: PlanRecheckKind; itemKey: string; attemptRef: string; openedAt: string }>;
};

// ---------------------------------------------------------------------------
// BL-173 (FO-REQ-0017, docs/roadmap/plans/PLAN_RECHECKS_PLAN.md): a re-check sends an attempt the owner already rated back to
// the owner -- a fixed version (its own file and checks) or a question about a spot. Stored apart from the result rows, so the
// original's rows and verdicts are never overwritten; the answer goes into the verdict history with its `recheckId`.
// ---------------------------------------------------------------------------

export const PLAN_RECHECK_KINDS = ["revision", "question"] as const;
export type PlanRecheckKind = (typeof PLAN_RECHECK_KINDS)[number];
export const PLAN_RECHECK_STATUSES = ["open", "answered", "withdrawn"] as const;
export type PlanRecheckStatus = (typeof PLAN_RECHECK_STATUSES)[number];
/** The stage id of the row under which a revision's own checks show on the review screen (never a real stage). */
export const RECHECK_STAGE_ID = "recheck";
/** The review screen's "wave" of re-checks (`?wave=~rechecks`); no group id can contain `~`. */
export const RECHECKS_WAVE = "~rechecks";

/** The verdict a re-check was opened on (who gave it: a device, or the factory for a relayed one; null = not known). */
export type PlanRecheckVerdict = { result: "accepted" | "rejected"; rating: number | null; reasons: string[]; markers: PlanMarker[]; note: string | null; device: string | null; at: string };
/** The owner's answer: a verdict, or (`kept`) the verdict kept with a note. */
export type PlanRecheckAnswer = { result: "accepted" | "rejected"; kept: boolean; rating: number | null; reasons: string[]; markers: PlanMarker[]; note: string | null; device: string; at: string };

export type PlanRecheck = {
  recheckId: string;
  itemKey: string;
  attemptRef: string;
  kind: PlanRecheckKind;
  /** The short reason on the entry («резкость», «голос на 0:25»). */
  title: string;
  /** What was wrong and what changed (revision), or the question itself. */
  note: string;
  /** The revised file, relative to the channel's Sent to YTM (revision only). */
  auditionFile: string | null;
  markers: PlanMarker[];
  /** The validator's results for the revised file (revision). */
  checks: PlanCheck[];
  metrics: Record<string, number | string | boolean | null>;
  previousVerdict: PlanRecheckVerdict | null;
  status: PlanRecheckStatus;
  openedAt: string;
  closedAt: string | null;
  answer: PlanRecheckAnswer | null;
  withdrawNote: string | null;
  /** "plan_closed" = withdrawn because the plan was closed. */
  closeReason: string | null;
};

/** `factory_plan_get`: a re-check with the current file of its attempt (null = the attempt's own audition). */
export type PlanRecheckView = PlanRecheck & { currentFile: string | null };

/**
 * The review screen's entry for one open re-check: the attempt's entry, plus the re-check. `pendingKept`: the answer on its way
 * (`verdict`) keeps the verdict -- a note, not a new verdict.
 */
export type PlanRecheckEntry = PlanReviewEntry & { recheck: PlanRecheck; pendingKept?: boolean };

/**
 * The current file of each attempt with an accepted revision: the `auditionFile` of its newest revision the owner accepted
 * (not kept), by the answer's time. Pure.
 */
export function currentFilesOf(rechecks: readonly PlanRecheck[]): Map<string, { file: string; recheck: PlanRecheck }> {
  const out = new Map<string, { file: string; recheck: PlanRecheck }>();
  const accepted = rechecks
    .filter((r) => r.kind === "revision" && r.auditionFile !== null && r.answer !== null && !r.answer.kept && r.answer.result === "accepted")
    .sort((a, b) => Date.parse(a.answer!.at) - Date.parse(b.answer!.at));
  for (const r of accepted) out.set(`${r.itemKey}\u0000${r.attemptRef}`, { file: r.auditionFile as string, recheck: r });
  return out;
}

/** The row under which a revision's checks and metrics show (null when it has neither). */
export function recheckStageRow(recheck: Pick<PlanRecheck, "itemKey" | "attemptRef" | "auditionFile" | "checks" | "metrics" | "openedAt">): PlanResultRow | null {
  if (recheck.checks.length === 0 && Object.keys(recheck.metrics).length === 0) return null;
  return { stageId: RECHECK_STAGE_ID, itemKey: recheck.itemKey, attemptRef: recheck.attemptRef, result: "done", reportedBy: "factory", note: null, rating: null, reasons: [], markers: [], auditionFile: recheck.auditionFile, checks: recheck.checks, metrics: recheck.metrics, referenceIds: [], at: recheck.openedAt };
}

/**
 * The review screen's entry for an open re-check (PLAN_RECHECKS_PLAN.md §2.8): the attempt's own entry (its rows, history,
 * validator), then `extra` -- the revision's row for a revision, or the accepted revision's row for a question that plays it.
 * `verdict` stays null while the re-check waits for an answer (the screen's "waiting"); an answer on its way is passed in.
 */
export function recheckEntry(
  recheck: PlanRecheck,
  base: PlanReviewEntry | null,
  item: { groupId: string | null; params: Record<string, PlanParamValue> } | null,
  extra: PlanResultRow | null,
  pending: { verdict: PlanResultRow; from: string; kept?: boolean } | null = null
): PlanRecheckEntry {
  const stages = [...(base?.stages ?? []), ...(extra ? [extra] : [])];
  return {
    itemKey: recheck.itemKey,
    groupId: base?.groupId ?? item?.groupId ?? null,
    attemptRef: recheck.attemptRef,
    jobId: base?.jobId ?? null,
    seed: base?.seed ?? null,
    params: base && Object.keys(base.params).length > 0 ? base.params : (item?.params ?? {}),
    stages,
    verdict: pending ? pending.verdict : null,
    playable: true,
    // What the validator said about the attempt itself -- never the revision's row.
    validator: base ? validatorOfEntry(base) : null,
    ...(base?.history ? { history: base.history } : {}),
    ...(pending ? { pendingFrom: pending.from } : {}),
    ...(pending?.kept ? { pendingKept: true } : {}),
    recheck,
  };
}

/** BL-173: a re-check id already stored with other content. */
export function planRecheckExists(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError({ code: "plan_recheck_exists", message, details });
}
/** BL-173: a re-check that is no longer open (answered, withdrawn), or already answered from this computer. */
export function planRecheckClosed(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError({ code: "plan_recheck_closed", message, details });
}

export function planNotFound(planId: string): DomainError {
  return new DomainError({ code: "plan_not_found", message: `No generation plan ${planId} on this device`, details: { planId } });
}
export function planClosed(planId: string, status: PlanStatus): DomainError {
  return new DomainError({ code: "plan_closed", message: `Plan ${planId} is ${status}; it can no longer be changed`, details: { planId, status } });
}
export function planMismatch(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError({ code: "plan_mismatch", message, details });
}
/** BL-157 (AC-TC-04): a verdict on an attempt that already has one, without `replace`. */
export function planVerdictExists(message: string, existing: PlanExistingVerdict): DomainError {
  return new DomainError({ code: "plan_verdict_exists", message, details: { existing } });
}
export function planInvalid(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError({ code: "plan_invalid", message, details });
}

/**
 * BL-157 (AC-BL-01): the notices in another device's report (`progress` is that device's derived progress, a loose record):
 * only well-formed ones of the known kinds are taken, anything else is left out.
 */
export function sharedNotices(progress: Record<string, unknown>): PlanNotice[] {
  const raw = Array.isArray(progress.notices) ? (progress.notices as unknown[]) : [];
  const out: PlanNotice[] = [];
  for (const n of raw) {
    if (!n || typeof n !== "object") continue;
    const x = n as Record<string, unknown>;
    if (x.kind === "stage_complete" && typeof x.stageId === "string" && typeof x.title === "string") out.push({ kind: "stage_complete", stageId: x.stageId.slice(0, 40), title: x.title.slice(0, 200) });
    else if (x.kind === "budget_80" || x.kind === "budget_100" || x.kind === "plan_complete") out.push({ kind: x.kind });
    else if (x.kind === "attempts_exhausted" && typeof x.count === "number" && Number.isFinite(x.count)) out.push({ kind: "attempts_exhausted", count: x.count });
  }
  return out;
}
