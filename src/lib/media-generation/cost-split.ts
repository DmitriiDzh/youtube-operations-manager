import type { MediaJobStatus } from "./contracts";

// BL-194 stage 2 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 2, ADR 0041): a RunPod session's charge split across its jobs.
//
// ComfyUI runs one pod's prompts one at a time, although they are submitted together, so a job's GPU time is from its real start
// to its real finish (the websocket's execution_start and execution_success / _error / _interrupted, stored on the job). A missed
// start is estimated as the later of the job's submit and the previous job's finish on the same pod; a missed finish is the job's
// own finish (its output transfer included). Either makes the job's share an estimate.
//
// The charge (pod creation to confirmed termination, so pod start and idle time included) is split in proportion to the GPU
// seconds, in units of 1/10000 USD, by largest remainder (equal remainders go to the earlier job): the shares always add up to
// the charge exactly. The overhead part of a share is what is left above the job's own seconds at the hourly price.

export type CostSplitJob = {
  id: string;
  status: MediaJobStatus;
  createdAt: Date;
  submittedAt: Date | null;
  startedAt: Date | null;
  gpuFinishedAt: Date | null;
  finishedAt: Date | null;
};

export type CostShare = {
  id: string;
  gpuSeconds: number;
  allocatedUsd: number;
  /** The part of the share above the job's own GPU time at the hourly price; null without an hourly price. */
  overheadUsd: number | null;
  basis: "measured" | "estimated";
};

const UNITS_PER_USD = 10_000;
const TERMINAL: readonly MediaJobStatus[] = ["done", "failed", "cancelled"];

/** null while one of the session's jobs is still running (split later); [] for a session without jobs. */
export function splitSessionCost(input: { chargeUsd: number; costPerHr: number | null; jobs: CostSplitJob[] }): CostShare[] | null {
  if (input.jobs.some((j) => !TERMINAL.includes(j.status))) return null;
  if (input.jobs.length === 0) return [];
  const key = (j: CostSplitJob) => (j.startedAt ?? j.submittedAt ?? j.createdAt).getTime();
  const ordered = [...input.jobs].sort((a, b) => key(a) - key(b) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // GPU seconds, one job after the other on the pod.
  let previousFinish = Number.NEGATIVE_INFINITY;
  const timed = ordered.map((j) => {
    const reached = j.startedAt !== null || j.submittedAt !== null;
    if (!reached) return { job: j, seconds: 0, reached, estimated: false };
    let estimated = false;
    let start: number;
    if (j.startedAt) start = j.startedAt.getTime();
    else {
      estimated = true;
      start = Math.max(j.submittedAt!.getTime(), previousFinish);
    }
    let finish: number;
    if (j.gpuFinishedAt) finish = j.gpuFinishedAt.getTime();
    else {
      estimated = true;
      finish = (j.finishedAt ?? j.submittedAt ?? j.createdAt).getTime();
    }
    finish = Math.max(finish, start);
    previousFinish = Math.max(previousFinish, finish);
    return { job: j, seconds: (finish - start) / 1000, reached, estimated };
  });

  const totalUnits = Math.max(0, Math.round(input.chargeUsd * UNITS_PER_USD));
  const totalSeconds = timed.reduce((sum, t) => sum + t.seconds, 0);
  // Weights: GPU seconds; with none at all, the jobs that reached ComfyUI share equally (else every job does).
  const equal = totalSeconds <= 0;
  const equalPool = timed.some((t) => t.reached) ? timed.filter((t) => t.reached) : timed;
  const weights = timed.map((t) => (equal ? (equalPool.includes(t) ? 1 : 0) : t.seconds));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (weightSum > 0 ? (totalUnits * w) / weightSum : 0));
  const units = exact.map((e) => Math.floor(e + 1e-9));
  let remainder = totalUnits - units.reduce((a, b) => a + b, 0);
  const byRemainder = exact.map((e, i) => ({ i, frac: e - units[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of byRemainder) {
    if (remainder <= 0) break;
    if (weights[i] <= 0) continue;
    units[i] += 1;
    remainder -= 1;
  }

  return timed.map((t, i) => {
    const direct = input.costPerHr === null ? null : Math.min(units[i], Math.round((t.seconds * input.costPerHr * UNITS_PER_USD) / 3600));
    return {
      id: t.job.id,
      gpuSeconds: Math.round(t.seconds * 1000) / 1000,
      allocatedUsd: units[i] / UNITS_PER_USD,
      overheadUsd: direct === null ? null : (units[i] - direct) / UNITS_PER_USD,
      basis: t.estimated || (equal && weights[i] > 0) ? "estimated" : "measured",
    };
  });
}

export type CostSplitSession = { id: string; usdCharged: number | null; costPerHr: number | null };

export type CostSplitterDeps = {
  /** Ended sessions whose charge is not (or no longer) split, each with every one of its jobs. */
  pending(): Promise<Array<{ session: CostSplitSession; jobs: CostSplitJob[] }>>;
  store(jobId: string, share: { gpuSeconds: number; allocatedUsd: number; overheadUsd: number | null; allocationBasis: "measured" | "estimated"; allocationSessionUsd: number }): Promise<void>;
  log?(line: string): void;
};

/**
 * Splits every ended session's charge that is not split yet (or was split from another charge -- a late correction), and stores
 * each job's share. A session with a job still running waits for the next call. Old sessions (before the websocket times were
 * stored) are split the same way, every share an estimate. Returns how many sessions were split.
 */
export async function splitEndedSessionCosts(deps: CostSplitterDeps): Promise<number> {
  let split = 0;
  for (const { session, jobs } of await deps.pending()) {
    if (session.usdCharged === null) continue;
    const shares = splitSessionCost({ chargeUsd: session.usdCharged, costPerHr: session.costPerHr, jobs });
    if (!shares || shares.length === 0) continue;
    try {
      for (const share of shares) {
        await deps.store(share.id, { gpuSeconds: share.gpuSeconds, allocatedUsd: share.allocatedUsd, overheadUsd: share.overheadUsd, allocationBasis: share.basis, allocationSessionUsd: session.usdCharged });
      }
      split++;
    } catch (error) {
      deps.log?.(`[media] session ${session.id}: cost not split across its jobs (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return split;
}
