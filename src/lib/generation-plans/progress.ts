import { mediaKindOf, pickTargetOf, type PlanMediaKind } from "./contracts";
import type {
  GenerationPlan,
  PlanAttempt,
  PlanAttemptState,
  PlanEvent,
  PlanItemProgress,
  PlanParamValue,
  PlanPickRecord,
  PlanProgress,
  PlanResultRow,
  PlanReviewBatch,
  PlanStage,
  PlanStageCounts,
  PlanTodo,
  PlanValidatorVerdict,
  PlanVerdictHistoryRow,
} from "./contracts";
import { pickFlagsOf, pickStateOf } from "./picks";

// ---------------------------------------------------------------------------
// BL-143 (ADR 0029 decision 2): everything a plan shows is derived here from the rows -- the linked jobs, the result rows,
// the linked sessions -- when it is read. Nothing in this file writes or stores a counter. Pure functions (no I/O, no clock
// except the `now` passed in).
// ---------------------------------------------------------------------------

/** What the plans module needs of a media job linked to a plan (`media_jobs.plan_*`). */
export type PlanJobRow = {
  id: string;
  sessionId: string;
  /** BL-157 (AC-MV-05): the channel the job ran on -- its output lives in that channel's workspace, whatever the plan's now. */
  channelId: string;
  stageId: string | null;
  itemKey: string | null;
  seed: number | null;
  status: "queued" | "submitted" | "generating" | "transferring" | "done" | "failed" | "cancelled";
  error: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  finishedAt: Date | null;
  /** BL-175 (VISUAL_REVIEW_PLAN.md §2.1): the file name of the output the review shows (as `resolveAudition` picks it); null = none yet. */
  outputFile?: string | null;
};

/** What the plans module needs of a media session linked to a plan (`media_sessions.plan_id`). */
export type PlanSessionRow = {
  id: string;
  status: string;
  gpuTypeId: string | null;
  costPerHr: number | null;
  startedAt: Date | null;
  readyAt: Date | null;
  stoppedAt: Date | null;
  secondsUsed: number | null;
  usdCharged: number | null;
  stopReason: string | null;
};

const SESSION_FINAL = new Set(["done", "failed", "rejected", "interrupted"]);
/** The error a server restart leaves on a job it could not resume (`jobs.ts` `sweepInterruptedJobs`). */
const INTERRUPTED_PREFIX = "interrupted";

export function attemptStateOfJob(job: Pick<PlanJobRow, "status" | "error">): PlanAttemptState {
  switch (job.status) {
    case "queued":
    case "submitted":
      return "queued";
    case "generating":
    case "transferring":
      return "running";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
      return job.error?.startsWith(INTERRUPTED_PREFIX) ? "interrupted" : "failed";
  }
}

export const jobAttemptRef = (jobId: string) => `job:${jobId}`;

const round2 = (n: number) => Math.round(n * 100) / 100;
const emptyCounts = (planned: number): PlanStageCounts => ({ planned, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0, accepted: 0, rejected: 0 });

/**
 * The in-app attempts: the plan's jobs at its in-app stage, plus attempts imported from a plan file (result rows at that
 * stage) for which no linked job carries the same ref.
 */
export function inAppAttempts(plan: Pick<GenerationPlan, "stages">, jobs: PlanJobRow[], results: PlanResultRow[]): PlanAttempt[] {
  const stage = plan.stages.find((s) => s.kind === "in_app");
  if (!stage) return [];
  const fromJobs: PlanAttempt[] = jobs
    .filter((j) => j.itemKey !== null && (j.stageId === null || j.stageId === stage.stageId))
    .map((j) => ({
      attemptRef: jobAttemptRef(j.id),
      itemKey: j.itemKey as string,
      state: attemptStateOfJob(j),
      jobId: j.id,
      sessionId: j.sessionId,
      seed: j.seed,
      createdAt: j.createdAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
      error: j.error,
    }));
  const seen = new Set(fromJobs.map((a) => a.attemptRef));
  const imported: PlanAttempt[] = results
    .filter((r) => r.stageId === stage.stageId && !seen.has(r.attemptRef))
    .map((r) => ({
      attemptRef: r.attemptRef,
      itemKey: r.itemKey,
      state: r.result === "failed" || r.result === "rejected" ? "failed" : "done",
      jobId: null,
      sessionId: null,
      seed: null,
      createdAt: null,
      finishedAt: r.at,
      error: null,
    }));
  return [...fromJobs, ...imported];
}

/** The stage whose verdict decides "accepted": the owner review when the plan has one, else the last stage. */
export function finalStage(plan: Pick<GenerationPlan, "stages">): PlanStage | null {
  return plan.stages.find((s) => s.kind === "owner_review") ?? plan.stages.at(-1) ?? null;
}

/**
 * One attempt the owner reviews (or reviewed): what the stage before the review said, and whether the owner already ruled.
 * BL-175: `picked` / `notChosen` (VISUAL_REVIEW_PLAN.md §2.3) -- settled without a verdict, so not waiting either.
 */
export type ReviewCandidate = { itemKey: string; attemptRef: string; validator: PlanValidatorVerdict | null; reviewed: boolean; failedChecks: number; picked: boolean; notChosen: boolean };

/** BL-175: an attempt's pick flags (`pickFlagsOf`); absent = no picks anywhere (every attempt as before). */
export type PickFlags = (itemKey: string, attemptRef: string, hasVerdict: boolean) => { picked: unknown; notChosen: boolean };

/** Settled = no longer waiting: the owner ruled on it, picked it, or decided its item without it. */
const settled = (c: Pick<ReviewCandidate, "reviewed" | "picked" | "notChosen">) => c.reviewed || c.picked || c.notChosen;

/** `fail`-severity checks that did not pass -- the near-miss order of rejected attempts (BL-153 AC-RR-05). */
function failedFailChecks(row: PlanResultRow | undefined): number {
  return row ? row.checks.filter((c) => !c.pass && c.severity === "fail").length : 0;
}

/**
 * The one rule for "waiting for the owner" (queue, counts, notices, todo, badge all read it). An attempt waits when it has no
 * owner verdict and the stage right before `owner_review` passed it -- or, with the plan's `reviewRejected` (BL-153), rejected
 * it and it can be played (an audition file or a job of this plan). A `failed` row never waits. Attempts with an owner
 * verdict are listed as reviewed. Order: see the sort below.
 */
export function reviewCandidates(
  plan: Pick<GenerationPlan, "stages" | "items" | "reviewRejected">,
  attempts: PlanAttempt[],
  results: PlanResultRow[],
  /** todo/counts: passed attempts in the order they were found (job order, then stored results -- as before BL-153). */
  options: { keepFoundOrder?: boolean; flags?: PickFlags } = {}
): ReviewCandidate[] {
  const index = plan.stages.findIndex((s) => s.kind === "owner_review");
  if (index < 0) return [];
  const review = plan.stages[index];
  const before = index > 0 ? plan.stages[index - 1] : null;
  const key = (itemKey: string, attemptRef: string) => `${itemKey}\u0000${attemptRef}`;
  const verdicts = new Set(results.filter((r) => r.stageId === review.stageId).map((r) => key(r.itemKey, r.attemptRef)));
  const beforeRows = new Map(before && before.kind !== "in_app" ? results.filter((r) => r.stageId === before.stageId).map((r) => [key(r.itemKey, r.attemptRef), r] as const) : []);
  const jobOf = new Map(attempts.map((a) => [key(a.itemKey, a.attemptRef), a]));
  // Playable as the review screen plays it: a job of this plan, or an audition file reported at any stage before the review.
  const withAudio = new Set(results.filter((r) => r.stageId !== review.stageId && r.auditionFile !== null).map((r) => key(r.itemKey, r.attemptRef)));
  const playable = (itemKey: string, attemptRef: string) => withAudio.has(key(itemKey, attemptRef)) || Boolean(jobOf.get(key(itemKey, attemptRef))?.jobId);
  const out = new Map<string, ReviewCandidate>();
  const add = (itemKey: string, attemptRef: string, validator: PlanValidatorVerdict | null) => {
    const k = key(itemKey, attemptRef);
    if (out.has(k)) return;
    const reviewed = verdicts.has(k);
    const flags = options.flags ? options.flags(itemKey, attemptRef, reviewed) : null;
    out.set(k, { itemKey, attemptRef, validator, reviewed, failedChecks: failedFailChecks(beforeRows.get(k)), picked: Boolean(flags?.picked), notChosen: flags?.notChosen === true });
  };
  if (before?.kind === "in_app") for (const a of attempts) if (a.state === "done") add(a.itemKey, a.attemptRef, "passed");
  for (const r of beforeRows.values()) {
    if (r.result === "accepted" || r.result === "done") add(r.itemKey, r.attemptRef, "passed");
    else if (r.result === "rejected" && plan.reviewRejected === true && playable(r.itemKey, r.attemptRef)) add(r.itemKey, r.attemptRef, "rejected");
  }
  // Attempts the owner already ruled on stay listed (reviewed), whatever the stage before said.
  for (const r of results) {
    if (r.stageId !== review.stageId) continue;
    const row = beforeRows.get(key(r.itemKey, r.attemptRef));
    add(r.itemKey, r.attemptRef, row ? (row.result === "rejected" || row.result === "failed" ? "rejected" : "passed") : before?.kind === "in_app" ? "passed" : null);
  }
  const itemOrder = new Map(plan.items.map((i, n) => [i.itemKey, n]));
  // BL-175: picked and not-chosen attempts rank with the reviewed ones (the report's queue cut drops them first).
  const rank = (c: ReviewCandidate) => (settled(c) ? 2 : c.validator === "rejected" ? 1 : 0);
  if (options.keepFoundOrder) {
    const found = [...out.values()];
    return [...found.filter((c) => c.validator !== "rejected" || settled(c)), ...found.filter((c) => c.validator === "rejected" && !settled(c)).sort((a, b) => a.failedChecks - b.failedChecks || (itemOrder.get(a.itemKey) ?? Infinity) - (itemOrder.get(b.itemKey) ?? Infinity) || a.attemptRef.localeCompare(b.attemptRef))];
  }
  // Passed and reviewed attempts keep the queue's order from before BL-153 (item key, then attempt); waiting rejects follow
  // the passed ones, fewest failed `fail` checks first, then the plan's item order (AC-RR-05).
  return [...out.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 1 ? a.failedChecks - b.failedChecks || (itemOrder.get(a.itemKey) ?? Infinity) - (itemOrder.get(b.itemKey) ?? Infinity) : a.itemKey.localeCompare(b.itemKey)) ||
      a.attemptRef.localeCompare(b.attemptRef)
  );
}

type Derived = {
  attempts: PlanAttempt[];
  byStageResults: Map<string, PlanResultRow[]>;
  items: PlanItemProgress[];
  /** Waiting for the owner, in the plan's item order (see `reviewCandidates`). */
  waiting: Array<{ itemKey: string; attemptRef: string; validator: PlanValidatorVerdict }>;
  /** BL-175: picked attempts that have no accepted row at the owner-review stage (they count as accepted there). */
  pickedWithoutRow: number;
};

/**
 * BL-175 (VISUAL_REVIEW_PLAN.md §2.3): the attempts only external stages report -- refs no in-app attempt of the item carries
 * (a copied Gemini file, a seed made outside the app). Before BL-175 they could wait and be rejected but never counted as
 * accepted; now they join the item's counts like the app's own.
 */
export function externalAttempts(plan: Pick<GenerationPlan, "stages">, inApp: PlanAttempt[], results: PlanResultRow[]): Array<{ itemKey: string; attemptRef: string }> {
  // Only rows of EXTERNAL stages make an attempt: a verdict the factory relays for a ref nothing else reports is not one (review round 1).
  const external = new Set(plan.stages.filter((s) => s.kind === "external").map((s) => s.stageId));
  const known = new Set(inApp.map((a) => `${a.itemKey}\u0000${a.attemptRef}`));
  const out = new Map<string, { itemKey: string; attemptRef: string }>();
  for (const r of results) {
    if (!external.has(r.stageId)) continue;
    const k = `${r.itemKey}\u0000${r.attemptRef}`;
    if (!known.has(k) && !out.has(k)) out.set(k, { itemKey: r.itemKey, attemptRef: r.attemptRef });
  }
  return [...out.values()];
}

/**
 * BL-175 (review round 2): the attempts a pick may stand on ("item\u0000ref") -- in the owner's queue (`reviewCandidates`) and
 * counted in the item's numbers (an in-app attempt or one an external stage reports). A pick anywhere else -- an attempt a stage
 * failed after it was picked, a verdict relayed for a ref nothing reports -- neither shows nor decides its item.
 */
export function pickableRefs(plan: Pick<GenerationPlan, "stages" | "items" | "reviewRejected">, attempts: PlanAttempt[], results: PlanResultRow[]): Set<string> {
  const key = (a: { itemKey: string; attemptRef: string }) => `${a.itemKey}\u0000${a.attemptRef}`;
  // Review of round 4: an app's attempt whose job failed, was interrupted or cancelled is dead -- a pick on it would decide its
  // item while it never counts as accepted, so the replacement it asks for would never reach the owner.
  const alive = attempts.filter((a) => a.state !== "failed" && a.state !== "interrupted" && a.state !== "cancelled");
  const counted = new Set([...alive, ...externalAttempts(plan, attempts, results)].map(key));
  return new Set(reviewCandidates(plan, attempts, results, { keepFoundOrder: true }).map(key).filter((k) => counted.has(k)));
}

function derive(plan: GenerationPlan, jobs: PlanJobRow[], results: PlanResultRow[], picks: readonly PlanPickRecord[] = []): Derived {
  const attempts = inAppAttempts(plan, jobs, results);
  const byStageResults = new Map<string, PlanResultRow[]>();
  for (const r of results) {
    const list = byStageResults.get(r.stageId) ?? [];
    list.push(r);
    byStageResults.set(r.stageId, list);
  }
  const final = finalStage(plan);
  const pickState = pickStateOf(picks);
  const live = picks.length > 0 ? pickableRefs(plan, attempts, results) : new Set<string>();
  const flags = picks.length > 0 ? pickFlagsOf(pickState, plan.items, live) : undefined;
  const candidates = reviewCandidates(plan, attempts, results, { keepFoundOrder: true, flags });
  const waiting = candidates.filter((c) => !settled(c)).map((c) => ({ itemKey: c.itemKey, attemptRef: c.attemptRef, validator: c.validator ?? "passed" }));
  const candidateOf = new Map(candidates.map((c) => [`${c.itemKey}\u0000${c.attemptRef}`, c]));
  const finalRows = final && final.kind !== "in_app" ? (byStageResults.get(final.stageId) ?? []) : [];
  // An attempt is dead once its job failed, or any stage after generation said failed/rejected; accepted once the final stage
  // accepted it; otherwise it may still become accepted (pending).
  const verdictsOf = new Map<string, PlanResultRow[]>();
  for (const r of results) {
    const key = `${r.itemKey}\u0000${r.attemptRef}`;
    const list = verdictsOf.get(key) ?? [];
    list.push(r);
    verdictsOf.set(key, list);
  }
  type Fate = "accepted" | "dead" | "pending" | "not_chosen";
  const fateOf = (itemKey: string, attemptRef: string, state: PlanAttemptState): Fate => {
    if (state === "failed" || state === "interrupted" || state === "cancelled") return "dead";
    const key = `${itemKey}\u0000${attemptRef}`;
    const rows = verdictsOf.get(key) ?? [];
    // BL-175: a pick is the owner's choice -- it wins over a validator's rejection; a not-chosen attempt is settled, not pending.
    const candidate = candidateOf.get(key);
    if (candidate?.picked) return "accepted";
    if (final && final.kind !== "in_app" && rows.some((r) => r.stageId === final.stageId && (r.result === "accepted" || r.result === "done"))) return "accepted";
    if (final?.kind === "in_app" && state === "done") return "accepted";
    if (candidate?.notChosen) return "not_chosen";
    if (rows.some((r) => r.result === "rejected" || r.result === "failed")) return "dead";
    return "pending";
  };
  const external = externalAttempts(plan, attempts, results);
  // An external attempt is "done" unless a row says it failed (it was made outside the app; its rows are all there is) -- or,
  // review round 3, the owner picked it: then it is done and usable, as a picked attempt of the app's own (its job is done).
  const externalState = (e: { itemKey: string; attemptRef: string }): PlanAttemptState => {
    const key = `${e.itemKey}\u0000${e.attemptRef}`;
    if (candidateOf.get(key)?.picked) return "done";
    return (verdictsOf.get(key) ?? []).some((r) => r.result === "failed") ? "failed" : "done";
  };
  const items: PlanItemProgress[] = plan.items.map((item) => {
    const own = attempts.filter((a) => a.itemKey === item.itemKey);
    const outside = external.filter((e) => e.itemKey === item.itemKey);
    const generated = own.filter((a) => a.state === "done").length;
    const open = own.filter((a) => a.state === "queued" || a.state === "running").length;
    const fates = [...own.map((a) => fateOf(a.itemKey, a.attemptRef, a.state)), ...outside.map((e) => fateOf(e.itemKey, e.attemptRef, externalState(e)))];
    const accepted = fates.filter((f) => f === "accepted").length;
    const pending = fates.filter((f) => f === "pending").length;
    const notChosen = fates.filter((f) => f === "not_chosen").length;
    const rejected = finalRows.filter((r) => r.itemKey === item.itemKey && (r.result === "rejected" || r.result === "failed")).length;
    const waitingReview = waiting.filter((w) => w.itemKey === item.itemKey).length;
    const total = own.length + outside.length;
    let missing: number;
    if (item.mode === "fixed") {
      // Exactly targetCount attempts that generated or still may: a failed or interrupted job is replaced, a rejection is not.
      const usable = own.filter((a) => a.state === "done" || a.state === "queued" || a.state === "running").length + outside.filter((e) => externalState(e) === "done").length;
      missing = Math.max(0, item.targetCount - usable);
    } else {
      const capLeft = item.maxAttempts === null ? Infinity : Math.max(0, item.maxAttempts - total);
      missing = Math.min(Math.max(0, item.targetCount - accepted - pending), capLeft);
    }
    const state = pickState.get(item.itemKey);
    return {
      itemKey: item.itemKey,
      groupId: item.groupId,
      targetCount: item.targetCount,
      mode: item.mode,
      attempts: total,
      generated,
      accepted,
      rejected,
      open,
      waitingReview,
      pending,
      missing,
      pickTarget: pickTargetOf(item),
      picks: state ? state.picks.filter((p) => live.has(`${item.itemKey}\u0000${p.attemptRef}`)).map((p) => ({ ...p })) : [],
      noneFits: state?.noneFits ? { note: state.noneFits.note, device: state.noneFits.device, at: state.noneFits.at, attempts: state.noneFits.attempts } : null,
      notChosen,
    };
  });
  const review = plan.stages.find((s) => s.kind === "owner_review");
  const acceptedRows = new Set(review ? (byStageResults.get(review.stageId) ?? []).filter((r) => r.result === "accepted" || r.result === "done").map((r) => `${r.itemKey}\u0000${r.attemptRef}`) : []);
  const pickedWithoutRow = candidates.filter((c) => c.picked && !acceptedRows.has(`${c.itemKey}\u0000${c.attemptRef}`)).length;
  return { attempts, byStageResults, items, waiting, pickedWithoutRow };
}

function sessionUsd(s: PlanSessionRow, now: Date): { usd: number; final: boolean; seconds: number } {
  // A finished session counts what it was charged (never a cost growing with the clock, even without a stop time).
  if (SESSION_FINAL.has(s.status)) return { usd: s.usdCharged ?? 0, final: true, seconds: s.secondsUsed ?? 0 };
  if (!s.startedAt) return { usd: s.usdCharged ?? 0, final: SESSION_FINAL.has(s.status), seconds: s.secondsUsed ?? 0 };
  const end = s.stoppedAt ?? now;
  const seconds = Math.max(0, (end.getTime() - s.startedAt.getTime()) / 1000);
  return { usd: s.costPerHr !== null ? (s.costPerHr * seconds) / 3600 : 0, final: false, seconds };
}

/**
 * `rechecks` (BL-173, PLAN_RECHECKS_PLAN.md §2.5): the plan's re-checks -- the open ones are counted per plan and per wave, apart
 * from `waitingReview` (they never enter the review counts, the notices or the badge).
 */
export function planProgress(
  plan: GenerationPlan,
  jobs: PlanJobRow[],
  results: PlanResultRow[],
  sessions: PlanSessionRow[],
  now: Date,
  rechecks: ReadonlyArray<{ itemKey: string; status: string }> = [],
  /** BL-175 (§2.2): the plan's pick records (active or not). */
  picks: readonly PlanPickRecord[] = []
): PlanProgress {
  const d = derive(plan, jobs, results, picks);
  const open = rechecks.filter((r) => r.status === "open");
  const groupOf = new Map(plan.items.map((i) => [i.itemKey, i.groupId]));
  const totalTarget = plan.items.reduce((sum, i) => sum + i.targetCount, 0);
  const stages = plan.stages.map((stage) => {
    const counts = emptyCounts(totalTarget);
    if (stage.kind === "in_app") {
      for (const a of d.attempts) counts[a.state] += 1;
    } else {
      for (const r of d.byStageResults.get(stage.stageId) ?? []) counts[r.result] += 1;
      // BL-175 (§2.3): a picked attempt is the owner's acceptance at the review stage, row or not.
      if (stage.kind === "owner_review") counts.accepted += d.pickedWithoutRow;
    }
    return { ...stage, counts };
  });
  const groups = plan.groups.map((g) => {
    const own = d.items.filter((i) => i.groupId === g.groupId);
    return {
      groupId: g.groupId,
      title: g.title,
      counts: {
        items: own.length,
        generated: own.reduce((s, i) => s + i.generated, 0),
        accepted: own.reduce((s, i) => s + i.accepted, 0),
        rejected: own.reduce((s, i) => s + i.rejected, 0),
        waitingReview: own.reduce((s, i) => s + i.waitingReview, 0),
        missing: own.reduce((s, i) => s + i.missing, 0),
        rechecks: open.filter((r) => groupOf.get(r.itemKey) === g.groupId).length,
        picked: own.reduce((s, i) => s + i.picks.length, 0),
        noneFits: own.filter((i) => i.noneFits !== null).length,
      },
    };
  });
  const sessionViews = sessions.map((s) => {
    const cost = sessionUsd(s, now);
    return { sessionId: s.id, status: s.status, gpuTypeId: s.gpuTypeId, usd: round2(cost.usd), final: cost.final, stopReason: s.stopReason, seconds: cost.seconds };
  });
  const usd = round2(sessionViews.reduce((sum, s) => sum + s.usd, 0));
  const gpuMinutes = round2(sessionViews.reduce((sum, s) => sum + s.seconds, 0) / 60);
  const usedShare = plan.budget.usd ? usd / plan.budget.usd : null;
  const warnings: Array<"80" | "100"> = usedShare === null ? [] : usedShare >= 1 ? ["80", "100"] : usedShare >= 0.8 ? ["80"] : [];
  return {
    stages,
    groups,
    items: d.items,
    spend: { usd, gpuMinutes, sessions: sessionViews.map((s) => ({ sessionId: s.sessionId, status: s.status, gpuTypeId: s.gpuTypeId, usd: s.usd, final: s.final, stopReason: s.stopReason })) },
    budget: { usd: plan.budget.usd, usedShare: usedShare === null ? null : Math.round(usedShare * 1000) / 1000, warnings },
    eta: estimate(plan, d, jobs, sessions),
    notices: noticesOf(plan, stages, d, warnings),
    rechecksOpen: open.length,
  };
}

/**
 * BL-184 stage 3 (FO-REQ-0024 A): the kinds a plan makes -- each result's audition file by its extension, and each item's template
 * by what it saves (`templateKinds`: template id -> kind, from the media module). Sorted; empty when nothing is known yet.
 */
export function planMediaKinds(plan: Pick<GenerationPlan, "items">, results: ReadonlyArray<Pick<PlanResultRow, "auditionFile">>, templateKinds: Readonly<Record<string, PlanMediaKind | null>>): PlanMediaKind[] {
  const kinds = new Set<PlanMediaKind>();
  for (const r of results) {
    const kind = mediaKindOf(r.auditionFile);
    if (kind) kinds.add(kind);
  }
  for (const item of plan.items) {
    const kind = item.templateId ? templateKinds[item.templateId] : null;
    if (kind) kinds.add(kind);
  }
  return (["audio", "image", "video"] as const).filter((k) => kinds.has(k));
}

/** AC-GP3-01: stage complete (its done/accepted count reached the plan's target), budget, plan complete, reviews waiting. */
function noticesOf(plan: GenerationPlan, stages: Array<PlanStage & { counts: PlanStageCounts }>, d: Derived, warnings: Array<"80" | "100">): PlanProgress["notices"] {
  const notices: PlanProgress["notices"] = [];
  for (const s of stages) {
    const reached = s.kind === "in_app" ? s.counts.done : s.counts.accepted + s.counts.done;
    if (s.counts.planned > 0 && reached >= s.counts.planned) notices.push({ kind: "stage_complete", stageId: s.stageId, title: s.title });
  }
  if (warnings.includes("100")) notices.push({ kind: "budget_100" });
  else if (warnings.includes("80")) notices.push({ kind: "budget_80" });
  // Complete only when every item reached its target AND nothing is still on its way (independent review: generated attempts
  // the validator or the owner have not judged yet are not "done"). An until_accepted item that used up its attempts below
  // its target is "exhausted", never complete.
  const open = d.attempts.some((a) => a.state === "queued" || a.state === "running");
  const exhausted = d.items.filter((i) => i.mode === "until_accepted" && i.missing === 0 && i.accepted < i.targetCount && i.pending === 0 && i.open === 0).length;
  const reached = d.items.every((i) => (i.mode === "until_accepted" ? i.accepted >= i.targetCount : i.missing === 0) && i.pending === 0);
  if (plan.items.length > 0 && !open && d.waiting.length === 0 && reached) notices.push({ kind: "plan_complete" });
  if (exhausted > 0) notices.push({ kind: "attempts_exhausted", count: exhausted });
  if (d.waiting.length > 0) {
    const rejected = d.waiting.filter((w) => w.validator === "rejected").length;
    notices.push({ kind: "review_waiting", count: d.waiting.length, passed: d.waiting.length - rejected, rejected });
  }
  return notices;
}

/** ETA (owner/FO-MSG-0008 §8): only finished jobs on the GPU type of the plan's current (or latest) session count. */
function estimate(plan: GenerationPlan, d: Derived, jobs: PlanJobRow[], sessions: PlanSessionRow[]): PlanProgress["eta"] {
  const gpuOf = new Map(sessions.map((s) => [s.id, s.gpuTypeId]));
  const current = [...sessions].reverse().find((s) => !SESSION_FINAL.has(s.status) && s.gpuTypeId) ?? [...sessions].reverse().find((s) => s.gpuTypeId);
  const gpuTypeId = current?.gpuTypeId ?? null;
  const durations = jobs
    .filter((j) => j.status === "done" && j.submittedAt && j.finishedAt && gpuTypeId !== null && gpuOf.get(j.sessionId) === gpuTypeId)
    .map((j) => ((j.finishedAt as Date).getTime() - (j.submittedAt as Date).getTime()) / 1000);
  const left = d.items.reduce((sum, i) => sum + i.missing, 0) + d.attempts.filter((a) => a.state === "queued" || a.state === "running").length;
  if (durations.length < 3) return { seconds: null, gpuTypeId, samples: durations.length };
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  void plan;
  return { seconds: Math.round(mean * left), gpuTypeId, samples: durations.length };
}

export function planTodo(plan: GenerationPlan, jobs: PlanJobRow[], results: PlanResultRow[], picks: readonly PlanPickRecord[] = []): Omit<PlanTodo, "rechecks"> {
  const d = derive(plan, jobs, results, picks);
  // A failed/interrupted attempt needs a re-run only while its item is still short of its target.
  const shortItems = new Set(d.items.filter((i) => i.missing > 0).map((i) => i.itemKey));
  return {
    planId: plan.planId,
    short: d.items.filter((i) => i.missing > 0).map((i) => ({ itemKey: i.itemKey, groupId: i.groupId, missing: i.missing, mode: i.mode })),
    waitingReview: d.waiting,
    rerun: d.attempts
      .filter((a): a is PlanAttempt & { state: "failed" | "interrupted" } => (a.state === "failed" || a.state === "interrupted") && shortItems.has(a.itemKey))
      .map((a) => ({ itemKey: a.itemKey, attemptRef: a.attemptRef, state: a.state })),
  };
}

/**
 * The plan's events since a moment (FO-MSG-0008 §7): job created/done/failed, session started/ready/stopped (with its stop
 * reason), each result and verdict, and the plan's own recorded events. Budget warnings are a current state, in progress.
 */
/** The start of the second `at` falls in (the stored times' resolution). */
export function secondFloor(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}

/**
 * The first `limit` events at or after `since`, oldest first, and the cursor for the next call: the whole second of the last
 * event returned when more remain (so none is skipped -- events of that second may repeat), else null (the caller uses
 * the current second). Stored times have one-second resolution, hence the inclusive bound.
 */
/**
 * `history` (BL-157, AC-TC-05): the owner verdicts' history -- an attempt that has history rows gets one `owner_verdict` per
 * verdict (with the device it was given on); one without (a verdict from before the history existed) gets one from its row.
 */
export function planEvents(jobs: PlanJobRow[], sessions: PlanSessionRow[], results: PlanResultRow[], recorded: PlanEvent[], since: Date | null, limit = 500, history: PlanVerdictHistoryRow[] = []): { events: PlanEvent[]; more: boolean; cursor: string | null } {
  const events: PlanEvent[] = [];
  for (const j of jobs) {
    const base = { jobId: j.id, sessionId: j.sessionId, itemKey: j.itemKey, seed: j.seed };
    events.push({ at: j.createdAt.toISOString(), kind: "job_created", actor: "app", details: base });
    if (j.finishedAt && (j.status === "done" || j.status === "failed" || j.status === "cancelled")) {
      const state = attemptStateOfJob(j);
      events.push({ at: j.finishedAt.toISOString(), kind: `job_${state}`, actor: "app", details: { ...base, ...(j.error ? { error: j.error } : {}) } });
    }
  }
  for (const s of sessions) {
    if (s.startedAt) events.push({ at: s.startedAt.toISOString(), kind: "session_started", actor: "app", details: { sessionId: s.id, gpuTypeId: s.gpuTypeId } });
    if (s.readyAt) events.push({ at: s.readyAt.toISOString(), kind: "session_ready", actor: "app", details: { sessionId: s.id, gpuTypeId: s.gpuTypeId } });
    if (s.stoppedAt) events.push({ at: s.stoppedAt.toISOString(), kind: "session_stopped", actor: "app", details: { sessionId: s.id, stopReason: s.stopReason, usdCharged: s.usdCharged } });
  }
  const rejectedEarlier = new Set(results.filter((r) => r.result === "rejected").map((r) => `${r.stageId}\u0000${r.itemKey}\u0000${r.attemptRef}`));
  // BL-153 AC-RR-04: the owner accepted an attempt an earlier stage (the validator) rejected -- a calibration case for the factory.
  const overrides = (r: PlanResultRow) => r.reportedBy === "owner" && r.result === "accepted" && results.some((x) => x.stageId !== r.stageId && x.itemKey === r.itemKey && x.attemptRef === r.attemptRef && rejectedEarlier.has(`${x.stageId}\u0000${x.itemKey}\u0000${x.attemptRef}`));
  const historyKeys = new Set(history.map((h) => `${h.itemKey}\u0000${h.attemptRef}`));
  for (const r of results) {
    if (r.reportedBy === "import") continue;
    if (r.reportedBy === "owner" && historyKeys.has(`${r.itemKey}\u0000${r.attemptRef}`)) {
      // BL-173: a kept re-check answer is a note, not a verdict -- no `owner_verdict` (its `recheck_answered` event says it).
      for (const h of history.filter((x) => x.itemKey === r.itemKey && x.attemptRef === r.attemptRef && x.kept !== true)) {
        const asRow = { ...r, result: h.result };
        events.push({
          at: h.at,
          kind: "owner_verdict",
          actor: "owner",
          details: {
            stageId: r.stageId,
            itemKey: h.itemKey,
            attemptRef: h.attemptRef,
            result: h.result,
            device: h.device,
            ...(h.rating !== null ? { rating: h.rating } : {}),
            ...(h.reasons.length > 0 ? { reasons: h.reasons } : {}),
            ...(h.markers.length > 0 ? { markers: h.markers } : {}),
            ...(h.note ? { note: h.note } : {}),
            ...(overrides(asRow) ? { overridesValidator: true } : {}),
            ...(h.recheckId ? { recheckId: h.recheckId } : {}),
            // BL-175 phase 3 (FO-REQ-0018 §G): the owner's seconds on the attempt before this verdict.
            ...(h.reviewSeconds !== undefined ? { reviewSeconds: h.reviewSeconds } : {}),
          },
        });
      }
      continue;
    }
    events.push({
      at: r.at,
      kind: r.reportedBy === "owner" ? "owner_verdict" : "result_reported",
      actor: r.reportedBy,
      details: {
        stageId: r.stageId,
        itemKey: r.itemKey,
        attemptRef: r.attemptRef,
        result: r.result,
        ...(r.rating !== null ? { rating: r.rating } : {}),
        ...(r.reasons.length > 0 ? { reasons: r.reasons } : {}),
        ...(r.markers.length > 0 ? { markers: r.markers } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(overrides(r) ? { overridesValidator: true } : {}),
      },
    });
  }
  events.push(...recorded);
  const sinceMs = since ? secondFloor(since).getTime() : -Infinity;
  const after = events.filter((e) => Date.parse(e.at) >= sinceMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (after.length <= limit) return { events: after, more: false, cursor: null };
  const page = after.slice(0, limit);
  const lastSecond = secondFloor(new Date(page[page.length - 1].at));
  // A page that is all one second would never advance: then the next call starts at the following second.
  const stuck = since !== null && lastSecond.getTime() <= secondFloor(since).getTime();
  return { events: page, more: true, cursor: (stuck ? new Date(lastSecond.getTime() + 1000) : lastSecond).toISOString() };
}

const BATCH_LIMITS = { templates: 20, params: 60, values: 20, valueChars: 500 } as const;

/**
 * BL-157 (SERVERS_MEDIA_PLAN.md AC-WV-03): each wave's context for the review -- its title and notes, its earliest attempt,
 * its templates, the item params that differ between its items, and what the stage right before the owner's review said
 * about its attempts. In the plan's group order. Pure.
 */
export function reviewBatches(plan: GenerationPlan, jobs: PlanJobRow[], results: PlanResultRow[]): PlanReviewBatch[] {
  const reviewIndex = plan.stages.findIndex((s) => s.kind === "owner_review");
  const before = reviewIndex > 0 ? plan.stages[reviewIndex - 1] : null;
  const attempts = before?.kind === "in_app" ? inAppAttempts(plan, jobs, results) : [];
  return plan.groups.map((group) => {
    const items = plan.items.filter((i) => i.groupId === group.groupId);
    const keys = new Set(items.map((i) => i.itemKey));
    const times = [
      ...jobs.filter((j) => j.itemKey !== null && keys.has(j.itemKey)).map((j) => j.createdAt.getTime()),
      ...results.filter((r) => keys.has(r.itemKey)).map((r) => Date.parse(r.at)),
    ].filter((ms) => Number.isFinite(ms));
    const templates = [...new Set(items.map((i) => i.templateLabel ?? i.templateId).filter((x): x is string => typeof x === "string" && x.length > 0))]
      .slice(0, BATCH_LIMITS.templates)
      .map((x) => x.slice(0, 200));
    const names = [...new Set(items.flatMap((i) => Object.keys(i.params ?? {})))];
    const differingParams: PlanReviewBatch["differingParams"] = [];
    for (const name of names) {
      const values: PlanParamValue[] = [];
      for (const item of items) {
        const raw = item.params?.[name];
        if (raw === undefined) continue;
        const value = typeof raw === "string" ? raw.slice(0, BATCH_LIMITS.valueChars) : raw;
        if (!values.some((v) => v === value)) values.push(value);
      }
      if (values.length > 1 && differingParams.length < BATCH_LIMITS.params) differingParams.push({ name: name.slice(0, 64), values: values.slice(0, BATCH_LIMITS.values) });
    }
    let passed = 0;
    let rejected = 0;
    if (before?.kind === "in_app") {
      passed = attempts.filter((a) => keys.has(a.itemKey) && a.state === "done").length;
    } else if (before) {
      for (const r of results) {
        if (r.stageId !== before.stageId || !keys.has(r.itemKey)) continue;
        if (r.result === "accepted" || r.result === "done") passed++;
        else if (r.result === "rejected") rejected++;
      }
    }
    return {
      groupId: group.groupId,
      title: group.title,
      note: group.note,
      ownerNote: group.ownerNote ?? null,
      firstAt: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
      templates,
      differingParams,
      validator: { passed, rejected },
    };
  });
}
