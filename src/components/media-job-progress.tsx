"use client";

import type { JobLiveProgress } from "@/lib/media-generation/job-progress";
import type { SharedJobProgress, SharedSessionJobs } from "@/lib/sync-gateway";

// BL-144 (owner, Telegram 2026-10-06, msg 1887: real progress, not estimates): a generating job's progress exactly as
// ComfyUI reports it (media-generation/job-progress.ts). Nothing here is estimated or extrapolated.

export type JobProgressView = { headline: string; detail: string | null; percent: number | null; tone: "info" | "warn" | "error" | "done" };

/** The words and the bar for a job's live progress. Exported for its test. */
export function describeJobProgress(progress: JobLiveProgress): JobProgressView {
  const nodes = progress.nodesTotal ? `node ${Math.min(progress.nodesDone + (progress.currentNode ? 1 : 0), progress.nodesTotal)} of ${progress.nodesTotal}` : null;
  const current = progress.currentNode ? (progress.currentNode.type ?? `#${progress.currentNode.id}`) : null;
  const step = progress.step ? `step ${progress.step.value} of ${progress.step.max}` : null;
  const cached = progress.nodesCached > 0 ? `${progress.nodesCached} from cache` : null;
  switch (progress.state) {
    case "connecting":
      return { headline: "Connecting to ComfyUI…", detail: null, percent: null, tone: "info" };
    case "waiting":
      return { headline: "Waiting in ComfyUI's queue", detail: null, percent: null, tone: "info" };
    case "running":
      return {
        headline: [progress.percent !== null ? `${progress.percent} %` : null, nodes].filter(Boolean).join(" · ") || "Running",
        detail: [current, step, cached].filter(Boolean).join(" · ") || null,
        percent: progress.percent,
        tone: "info",
      };
    case "finished":
      return { headline: "Generated — collecting the outputs", detail: null, percent: 100, tone: "done" };
    case "error":
      return { headline: "ComfyUI reported an error", detail: progress.detail, percent: progress.percent, tone: "error" };
    case "interrupted":
      return { headline: "Interrupted in ComfyUI", detail: null, percent: progress.percent, tone: "warn" };
    case "unavailable":
      return { headline: "Live progress unavailable", detail: progress.detail ? `the job continues; ${progress.detail}` : "the job continues", percent: null, tone: "warn" };
  }
}

const toneClass: Record<JobProgressView["tone"], string> = {
  info: "bg-indigo-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
  done: "bg-emerald-500",
};

export function JobProgress({ progress }: { progress: JobLiveProgress }) {
  const view = describeJobProgress(progress);
  return (
    <div className="mt-1 min-w-[12rem] space-y-1" aria-label="Job progress">
      {view.percent !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent}>
          <div className={`h-full ${toneClass[view.tone]}`} style={{ width: `${view.percent}%` }} />
        </div>
      )}
      <div className={view.tone === "error" ? "text-red-400" : view.tone === "warn" ? "text-amber-300" : "text-zinc-300"}>{view.headline}</div>
      {view.detail && <div className="text-zinc-500">{view.detail}</div>}
    </div>
  );
}

/** BL-148: another device's reported progress (no `detail`) in the shape the view above takes. Exported for its test. */
export function fromSharedProgress(p: SharedJobProgress): JobLiveProgress {
  return {
    state: p.state,
    nodesTotal: p.nodesTotal,
    nodesDone: p.nodesDone,
    nodesCached: p.nodesCached,
    currentNode: p.currentNodeType ? { id: "", type: p.currentNodeType } : null,
    step: p.step,
    percent: p.percent,
    startedAt: p.startedAt,
    updatedAt: p.updatedAt,
    detail: null,
  };
}

/**
 * BL-148: "4 done · 1 in ComfyUI · 3 queued · 1 failed" for another device's session (zeros left out). "In ComfyUI", not "running":
 * a submitted job may still wait in ComfyUI's own queue (re-review); the job list below says which one runs. Exported for its test.
 */
export function describeSessionJobCounts(jobs: Pick<SharedSessionJobs, "counts">): string {
  const { counts } = jobs;
  const parts = [
    counts.done ? `${counts.done} done` : null,
    counts.running ? `${counts.running} in ComfyUI` : null,
    counts.queued ? `${counts.queued} queued` : null,
    counts.failed ? `${counts.failed} failed` : null,
    counts.cancelled ? `${counts.cancelled} cancelled` : null,
  ].filter(Boolean);
  if (parts.length === 0) return "no jobs yet";
  return parts.join(" · ");
}
