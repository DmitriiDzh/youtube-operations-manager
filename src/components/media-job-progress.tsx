"use client";

import type { JobLiveProgress } from "@/lib/media-generation/job-progress";
import type { SharedJobProgress, SharedSessionJobs } from "@/lib/sync-gateway";
import type { Translate } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

// BL-144 (owner, Telegram 2026-10-06, msg 1887: real progress, not estimates): a generating job's progress exactly as
// ComfyUI reports it (media-generation/job-progress.ts). Nothing here is estimated or extrapolated.

export type JobProgressView = { headline: string; detail: string | null; percent: number | null; tone: "info" | "warn" | "error" | "done" };

/** The words and the bar for a job's live progress. Exported for its test. */
export function describeJobProgress(t: Translate, progress: JobLiveProgress): JobProgressView {
  const nodes = progress.nodesTotal ? t("jobs.node", { current: Math.min(progress.nodesDone + (progress.currentNode ? 1 : 0), progress.nodesTotal), total: progress.nodesTotal }) : null;
  const current = progress.currentNode ? (progress.currentNode.type ?? `#${progress.currentNode.id}`) : null;
  const step = progress.step ? t("jobs.step", { value: progress.step.value, max: progress.step.max }) : null;
  const cached = progress.nodesCached > 0 ? t("jobs.cached", { count: progress.nodesCached }) : null;
  switch (progress.state) {
    case "connecting":
      return { headline: t("jobs.connecting"), detail: null, percent: null, tone: "info" };
    case "waiting":
      return { headline: t("jobs.waiting"), detail: null, percent: null, tone: "info" };
    case "running":
      return {
        headline: [progress.percent !== null ? t("jobs.percent", { percent: progress.percent }) : null, nodes].filter(Boolean).join(" · ") || t("jobs.running"),
        detail: [current, step, cached].filter(Boolean).join(" · ") || null,
        percent: progress.percent,
        tone: "info",
      };
    case "finished":
      return { headline: t("jobs.finished"), detail: null, percent: 100, tone: "done" };
    case "error":
      return { headline: t("jobs.error"), detail: progress.detail, percent: progress.percent, tone: "error" };
    case "interrupted":
      return { headline: t("jobs.interrupted"), detail: null, percent: progress.percent, tone: "warn" };
    case "unavailable":
      return { headline: t("jobs.unavailable"), detail: progress.detail ? t("jobs.continuesBecause", { detail: progress.detail }) : t("jobs.continues"), percent: null, tone: "warn" };
  }
}

const toneClass: Record<JobProgressView["tone"], string> = {
  info: "bg-indigo-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
  done: "bg-emerald-500",
};

export function JobProgress({ progress }: { progress: JobLiveProgress }) {
  const t = useT();
  const view = describeJobProgress(t, progress);
  return (
    <div className="mt-1 min-w-[12rem] space-y-1" aria-label={t("jobs.progressLabel")}>
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
export function describeSessionJobCounts(t: Translate, jobs: Pick<SharedSessionJobs, "counts">): string {
  const { counts } = jobs;
  // Counts as written ("1200 done"), not grouped.
  const parts = [
    counts.done ? t("jobs.count.done", { count: String(counts.done) }) : null,
    counts.running ? t("jobs.count.running", { count: String(counts.running) }) : null,
    counts.queued ? t("jobs.count.queued", { count: String(counts.queued) }) : null,
    counts.failed ? t("jobs.count.failed", { count: String(counts.failed) }) : null,
    counts.cancelled ? t("jobs.count.cancelled", { count: String(counts.cancelled) }) : null,
  ].filter(Boolean);
  if (parts.length === 0) return t("jobs.count.none");
  return parts.join(" · ");
}
