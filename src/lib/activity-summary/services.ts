import { ACTIVITY_SOURCES, type ActivityItem, type ActivitySource, type ActivitySourceState, type ActivitySummary } from "./contracts";

// BL-195 stage D: the summary from each source's own read. Each source is read on its own and its failure only marks it
// `unavailable` (AGENTS.md §M: the Activity centre depends on the other modules, never the other way, and one of them being
// down never hides the rest). BL-258 (owner msg 4385): every channel's work -- the sources are read without a channel.

export type ActivityOperation = { id: string; channelId: string; kind: string; status: string; startedAt: number; done: number; total: number };
export type ActivityMediaJob = {
  jobId: string;
  channelId: string | null;
  source: "runpod" | "gemini";
  status: string;
  label: string;
  hostName: string | null;
  own: boolean;
  createdAt: string;
  finished: boolean;
  stale: boolean;
  /** The job's own progress report (RunPod/ComfyUI), or null. */
  progress: { percent: number | null; step: { value: number; max: number } | null } | null;
};
export type ActivityUpload = { id: string; channelId: string; video: string; status: string; storedBytes: number; totalBytes: number; createdAt: Date; queuePosition: number | null };
export type ActivityStream = { channelId: string; state: string; since: string | null };

export type ActivityDeps = {
  activeChannelOf: (userId: string) => Promise<string | null>;
  /** This computer's operations, every channel. */
  operations: () => Promise<ActivityOperation[]> | ActivityOperation[];
  /** Every computer's media jobs, every channel. */
  mediaJobs: () => Promise<ActivityMediaJob[]>;
  /** This computer's uploads still open, every channel, with their place in the shared queue. */
  uploads: () => Promise<ActivityUpload[]>;
  streams: () => Promise<ActivityStream[]>;
  now: () => Date;
};

const OPEN_UPLOAD = new Set(["queued", "uploading", "processing", "finishing", "paused"]);
const ON_AIR = new Set(["starting", "live", "replaying", "no_source", "reconnecting"]);
/** Statuses a media job waits in before it runs (RunPod and Gemini). */
const JOB_WAITING = new Set(["queued", "pending", "waiting", "submitting"]);

const clampPercent = (value: number) => Math.max(0, Math.min(100, Math.floor(value)));

/** How far an operation is: done of total (null without a total). */
export function operationProgress(done: number, total: number): number | null {
  return total > 0 ? clampPercent((done / total) * 100) : null;
}

/** How far an upload is: bytes sent while uploading (or paused mid-way); null while queued or while YouTube processes it. */
export function uploadProgress(status: string, storedBytes: number, totalBytes: number): number | null {
  if ((status === "uploading" || status === "paused") && totalBytes > 0) return clampPercent((storedBytes / totalBytes) * 100);
  return null;
}

/** How far a media job is: its own percent, else its step; null when it reports neither (Gemini, or not started). */
export function jobProgress(progress: ActivityMediaJob["progress"]): number | null {
  if (!progress) return null;
  if (progress.percent !== null && Number.isFinite(progress.percent)) return clampPercent(progress.percent);
  if (progress.step && progress.step.max > 0) return clampPercent((progress.step.value / progress.step.max) * 100);
  return null;
}

/** The shared queue as the owner reads it: what is being sent or finished first (oldest first), then the queued ones by place. */
function uploadOrder(a: ActivityUpload, b: ActivityUpload): number {
  const queuedA = a.status === "queued";
  const queuedB = b.status === "queued";
  if (queuedA !== queuedB) return queuedA ? 1 : -1;
  if (queuedA && queuedB) return (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER) || a.createdAt.getTime() - b.createdAt.getTime();
  return a.createdAt.getTime() - b.createdAt.getTime();
}

export function createActivitySummary(deps: ActivityDeps) {
  return {
    async summary(userId: string): Promise<ActivitySummary> {
      const channelId = await deps.activeChannelOf(userId).catch(() => null);
      const sources = Object.fromEntries(ACTIVITY_SOURCES.map((s) => [s, "ok"])) as Record<ActivitySource, ActivitySourceState>;
      const items: ActivityItem[] = [];
      const read = async <T,>(source: ActivitySource, load: () => Promise<T> | T, take: (value: T) => ActivityItem[]) => {
        try {
          items.push(...take(await load()));
        } catch {
          sources[source] = "unavailable";
        }
      };
      await Promise.all([
        read("operations", () => deps.operations(), (ops) =>
          ops
            .filter((o) => o.status === "running" || o.status === "cancelling")
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((o) => ({ source: "operations" as const, id: o.id, channelId: o.channelId, kind: o.kind, status: o.status as "running" | "cancelling", startedAt: new Date(o.startedAt).toISOString(), done: o.done, total: o.total, progress: operationProgress(o.done, o.total) }))
        ),
        read("media_jobs", () => deps.mediaJobs(), (jobs) =>
          jobs
            // A computer silent past the pool's stale limit is not known to run anything; the Media tab shows it as stale.
            .filter((j) => !j.finished && !j.stale)
            // Running first, then waiting; oldest first in each.
            .sort((a, b) => Number(JOB_WAITING.has(a.status)) - Number(JOB_WAITING.has(b.status)) || Date.parse(a.createdAt) - Date.parse(b.createdAt))
            .map((j) => ({ source: "media_jobs" as const, id: j.jobId, channelId: j.channelId, provider: j.source, status: j.status, label: j.label, device: j.own ? null : j.hostName, own: j.own, createdAt: j.createdAt, progress: JOB_WAITING.has(j.status) ? null : jobProgress(j.progress) }))
        ),
        read("uploads", () => deps.uploads(), (uploads) =>
          uploads
            .filter((u) => OPEN_UPLOAD.has(u.status))
            .sort(uploadOrder)
            .map((u) => ({
              source: "uploads" as const,
              id: u.id,
              channelId: u.channelId,
              video: u.video,
              status: u.status as "queued",
              storedBytes: u.storedBytes,
              totalBytes: u.totalBytes,
              createdAt: u.createdAt.toISOString(),
              queuePosition: u.status === "queued" ? u.queuePosition : null,
              progress: uploadProgress(u.status, u.storedBytes, u.totalBytes),
            }))
        ),
        read("live_streams", () => deps.streams(), (streams) =>
          streams.filter((s) => ON_AIR.has(s.state)).map((s) => ({ source: "live_streams" as const, channelId: s.channelId, state: s.state, since: s.since }))
        ),
      ]);
      return { channelId, items, sources, at: deps.now().toISOString() };
    },
  };
}
