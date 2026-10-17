import { ACTIVITY_SOURCES, type ActivityItem, type ActivitySource, type ActivitySourceState, type ActivitySummary } from "./contracts";

// BL-195 stage D: the summary from each source's own read. Each source is read on its own and its failure only marks it
// `unavailable` (AGENTS.md §M: the Activity centre depends on the other modules, never the other way, and one of them being
// down never hides the rest).

export type ActivityOperation = { id: string; kind: string; status: string; startedAt: number; done: number; total: number };
export type ActivityMediaJob = { jobId: string; source: "runpod" | "gemini"; status: string; label: string; hostName: string | null; own: boolean; createdAt: string; finished: boolean };
export type ActivityUpload = { id: string; video: string; status: string; storedBytes: number; totalBytes: number; createdAt: Date };
export type ActivityStream = { channelId: string; state: string; since: string | null };

export type ActivityDeps = {
  activeChannelOf: (userId: string) => Promise<string | null>;
  operations: (channelId: string) => Promise<ActivityOperation[]> | ActivityOperation[];
  mediaJobs: (channelId: string) => Promise<ActivityMediaJob[]>;
  uploads: (channelId: string) => Promise<ActivityUpload[]>;
  streams: () => Promise<ActivityStream[]>;
  now: () => Date;
};

const OPEN_UPLOAD = new Set(["queued", "uploading", "processing", "finishing", "paused"]);
const ON_AIR = new Set(["starting", "live", "replaying", "no_source", "reconnecting"]);

export function createActivitySummary(deps: ActivityDeps) {
  return {
    async summary(userId: string): Promise<ActivitySummary> {
      const channelId = await deps.activeChannelOf(userId);
      const sources = Object.fromEntries(ACTIVITY_SOURCES.map((s) => [s, "ok"])) as Record<ActivitySource, ActivitySourceState>;
      const items: ActivityItem[] = [];
      const read = async <T,>(source: ActivitySource, needsChannel: boolean, load: () => Promise<T> | T, take: (value: T) => ActivityItem[]) => {
        if (needsChannel && !channelId) {
          sources[source] = "no_channel";
          return;
        }
        try {
          items.push(...take(await load()));
        } catch {
          sources[source] = "unavailable";
        }
      };
      await Promise.all([
        read("operations", true, () => deps.operations(channelId!), (ops) =>
          ops
            .filter((o) => o.status === "running" || o.status === "cancelling")
            .map((o) => ({ source: "operations" as const, id: o.id, kind: o.kind, status: o.status as "running" | "cancelling", startedAt: new Date(o.startedAt).toISOString(), done: o.done, total: o.total }))
        ),
        read("media_jobs", true, () => deps.mediaJobs(channelId!), (jobs) =>
          jobs
            .filter((j) => !j.finished)
            .map((j) => ({ source: "media_jobs" as const, id: j.jobId, provider: j.source, status: j.status, label: j.label, device: j.own ? null : j.hostName, own: j.own, createdAt: j.createdAt }))
        ),
        read("uploads", true, () => deps.uploads(channelId!), (uploads) =>
          uploads
            .filter((u) => OPEN_UPLOAD.has(u.status))
            .map((u) => ({ source: "uploads" as const, id: u.id, video: u.video, status: u.status as "queued", storedBytes: u.storedBytes, totalBytes: u.totalBytes, createdAt: u.createdAt.toISOString() }))
        ),
        read("live_streams", false, () => deps.streams(), (streams) =>
          streams.filter((s) => ON_AIR.has(s.state)).map((s) => ({ source: "live_streams" as const, channelId: s.channelId, state: s.state, since: s.since }))
        ),
      ]);
      return { channelId, items, sources, at: deps.now().toISOString() };
    },
  };
}
