import type {
  GenerationPlan,
  PlanAttempt,
  PlanAttemptState,
  PlanEvent,
  PlanItemProgress,
  PlanProgress,
  PlanResultRow,
  PlanStage,
  PlanStageCounts,
  PlanTodo,
  PlanValidatorVerdict,
} from "./contracts";

// ---------------------------------------------------------------------------
// BL-143 (ADR 0029 decision 2): everything a plan shows is derived here from the rows -- the linked jobs, the result rows,
// the linked sessions -- when it is read. Nothing in this file writes or stores a counter. Pure functions (no I/O, no clock
// except the `now` passed in).
// ---------------------------------------------------------------------------

/** What the plans module needs of a media job linked to a plan (`media_jobs.plan_*`). */
export type PlanJobRow = {
  id: string;
  sessionId: string;
  stageId: string | null;
  itemKey: string | null;
  seed: number | null;
  status: "queued" | "submitted" | "generating" | "transferring" | "done" | "failed" | "cancelled";
  error: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  finishedAt: Date | null;
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

/** One attempt the owner reviews (or reviewed): what the stage before the review said, and whether the owner already ruled. */
export type ReviewCandidate = { itemKey: string; attemptRef: string; validator: PlanValidatorVerdict | null; reviewed: boolean; failedChecks: number };

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
  options: { keepFoundOrder?: boolean } = {}
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
    if (!out.has(k)) out.set(k, { itemKey, attemptRef, validator, reviewed: verdicts.has(k), failedChecks: failedFailChecks(beforeRows.get(k)) });
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
  const rank = (c: ReviewCandidate) => (c.reviewed ? 2 : c.validator === "rejected" ? 1 : 0);
  if (options.keepFoundOrder) {
    const found = [...out.values()];
    return [...found.filter((c) => c.validator !== "rejected" || c.reviewed), ...found.filter((c) => c.validator === "rejected" && !c.reviewed).sort((a, b) => a.failedChecks - b.failedChecks || (itemOrder.get(a.itemKey) ?? Infinity) - (itemOrder.get(b.itemKey) ?? Infinity) || a.attemptRef.localeCompare(b.attemptRef))];
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
};

function derive(plan: GenerationPlan, jobs: PlanJobRow[], results: PlanResultRow[]): Derived {
  const attempts = inAppAttempts(plan, jobs, results);
  const byStageResults = new Map<string, PlanResultRow[]>();
  for (const r of results) {
    const list = byStageResults.get(r.stageId) ?? [];
    list.push(r);
    byStageResults.set(r.stageId, list);
  }
  const final = finalStage(plan);
  const waiting = reviewCandidates(plan, attempts, results, { keepFoundOrder: true })
    .filter((c) => !c.reviewed)
    .map((c) => ({ itemKey: c.itemKey, attemptRef: c.attemptRef, validator: c.validator ?? "passed" }));
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
  const fate = (a: PlanAttempt): "accepted" | "dead" | "pending" => {
    if (a.state === "failed" || a.state === "interrupted" || a.state === "cancelled") return "dead";
    const rows = verdictsOf.get(`${a.itemKey}\u0000${a.attemptRef}`) ?? [];
    if (final && final.kind !== "in_app" && rows.some((r) => r.stageId === final.stageId && (r.result === "accepted" || r.result === "done"))) return "accepted";
    if (final?.kind === "in_app" && a.state === "done") return "accepted";
    if (rows.some((r) => r.result === "rejected" || r.result === "failed")) return "dead";
    return "pending";
  };
  const items: PlanItemProgress[] = plan.items.map((item) => {
    const own = attempts.filter((a) => a.itemKey === item.itemKey);
    const generated = own.filter((a) => a.state === "done").length;
    const open = own.filter((a) => a.state === "queued" || a.state === "running").length;
    const fates = own.map(fate);
    const accepted = fates.filter((f) => f === "accepted").length;
    const pending = fates.filter((f) => f === "pending").length;
    const rejected = finalRows.filter((r) => r.itemKey === item.itemKey && (r.result === "rejected" || r.result === "failed")).length;
    const waitingReview = waiting.filter((w) => w.itemKey === item.itemKey).length;
    let missing: number;
    if (item.mode === "fixed") {
      // Exactly targetCount attempts that generated or still may: a failed or interrupted job is replaced, a rejection is not.
      const usable = own.filter((a) => a.state === "done" || a.state === "queued" || a.state === "running").length;
      missing = Math.max(0, item.targetCount - usable);
    } else {
      const capLeft = item.maxAttempts === null ? Infinity : Math.max(0, item.maxAttempts - own.length);
      missing = Math.min(Math.max(0, item.targetCount - accepted - pending), capLeft);
    }
    return { itemKey: item.itemKey, groupId: item.groupId, targetCount: item.targetCount, mode: item.mode, attempts: own.length, generated, accepted, rejected, open, waitingReview, pending, missing };
  });
  return { attempts, byStageResults, items, waiting };
}

function sessionUsd(s: PlanSessionRow, now: Date): { usd: number; final: boolean; seconds: number } {
  // A finished session counts what it was charged (never a cost growing with the clock, even without a stop time).
  if (SESSION_FINAL.has(s.status)) return { usd: s.usdCharged ?? 0, final: true, seconds: s.secondsUsed ?? 0 };
  if (!s.startedAt) return { usd: s.usdCharged ?? 0, final: SESSION_FINAL.has(s.status), seconds: s.secondsUsed ?? 0 };
  const end = s.stoppedAt ?? now;
  const seconds = Math.max(0, (end.getTime() - s.startedAt.getTime()) / 1000);
  return { usd: s.costPerHr !== null ? (s.costPerHr * seconds) / 3600 : 0, final: false, seconds };
}

export function planProgress(plan: GenerationPlan, jobs: PlanJobRow[], results: PlanResultRow[], sessions: PlanSessionRow[], now: Date): PlanProgress {
  const d = derive(plan, jobs, results);
  const totalTarget = plan.items.reduce((sum, i) => sum + i.targetCount, 0);
  const stages = plan.stages.map((stage) => {
    const counts = emptyCounts(totalTarget);
    if (stage.kind === "in_app") {
      for (const a of d.attempts) counts[a.state] += 1;
    } else {
      for (const r of d.byStageResults.get(stage.stageId) ?? []) counts[r.result] += 1;
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
  };
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

export function planTodo(plan: GenerationPlan, jobs: PlanJobRow[], results: PlanResultRow[]): PlanTodo {
  const d = derive(plan, jobs, results);
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
export function planEvents(jobs: PlanJobRow[], sessions: PlanSessionRow[], results: PlanResultRow[], recorded: PlanEvent[], since: Date | null, limit = 500): { events: PlanEvent[]; more: boolean; cursor: string | null } {
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
  for (const r of results) {
    if (r.reportedBy === "import") continue;
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
