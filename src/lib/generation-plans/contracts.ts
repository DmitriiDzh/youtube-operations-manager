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
export type PlanGroup = { groupId: string; title: string; dependsOn: string | null; note: string | null };
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
export type PlanDefinition = { stages: PlanStage[]; groups: PlanGroup[]; items: PlanItem[] };

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
  /** How many more attempts the item still needs (0 when complete). */
  missing: number;
};

export type PlanEvent = { at: string; kind: string; actor: string; details: Record<string, unknown> };

export type PlanProgress = {
  stages: Array<PlanStage & { counts: PlanStageCounts }>;
  groups: Array<{ groupId: string; title: string; counts: { items: number; generated: number; accepted: number; rejected: number; waitingReview: number; missing: number } }>;
  items: PlanItemProgress[];
  spend: { usd: number; gpuMinutes: number; sessions: Array<{ sessionId: string; status: string; gpuTypeId: string | null; usd: number; final: boolean; stopReason: string | null }> };
  budget: { usd: number | null; usedShare: number | null; warnings: Array<"80" | "100"> };
  /** Mean finished-job duration on the same GPU type × attempts still missing; null below 3 finished samples. */
  eta: { seconds: number | null; gpuTypeId: string | null; samples: number };
};

export type PlanView = { plan: GenerationPlan; progress: PlanProgress };

export type PlanTodo = {
  planId: string;
  short: Array<{ itemKey: string; groupId: string | null; missing: number; mode: PlanItemMode }>;
  waitingReview: Array<{ itemKey: string; attemptRef: string }>;
  rerun: Array<{ itemKey: string; attemptRef: string; state: "failed" | "interrupted" }>;
};

export function planNotFound(planId: string): DomainError {
  return new DomainError({ code: "plan_not_found", message: `No generation plan ${planId} on this device`, details: { planId } });
}
export function planClosed(planId: string, status: PlanStatus): DomainError {
  return new DomainError({ code: "plan_closed", message: `Plan ${planId} is ${status}; it can no longer be changed`, details: { planId, status } });
}
export function planMismatch(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError({ code: "plan_mismatch", message, details });
}
export function planInvalid(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError({ code: "plan_invalid", message, details });
}
