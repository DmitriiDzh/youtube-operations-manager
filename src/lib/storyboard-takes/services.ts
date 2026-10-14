import path from "node:path";
import type { MediaJobsReport, SharedMediaJob } from "@/lib/sync-gateway";
import { jobOutputPathOf } from "@/lib/workspace-exchange";

// BL-184 stage 3 / BL-189 (FO-REQ-0025 A, STORYBOARD_TAKES_PLAN.md §2.1-§2.3): a storyboard's takes -- the video jobs that rendered
// its segments -- from THIS computer's two job modules and from every other computer's `media-jobs` report (BL-188). Pure: the
// wiring in `index.ts` reads the modules and the files.

export type TakeSource = "media" | "gemini";

export type StoryboardTake = {
  source: TakeSource;
  jobId: string;
  segmentId: string;
  versionNumber: number;
  status: string;
  createdAt: string;
  /** What made it: the template (and seed), or the Gemini model. */
  label: string;
  /** This computer's job: its error text; another computer's: its error code only. */
  error: string | null;
  /** The computer that ran it; null for this computer. */
  device: { deviceId: string; hostName: string | null } | null;
  /** The take's video on THIS computer (absolute; never sent to the browser), or null while this computer has no copy. */
  localPath: string | null;
  /** Another computer's take: its video, relative to the channel's `99 Data Exchange/` (`From YTM/<subdir>/<jobId>/...`). */
  exchangePath: string | null;
};

const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4" };

export function videoTypeOf(filePath: string): string | null {
  return VIDEO_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

export const takeSourceOf = (source: SharedMediaJob["source"]): TakeSource => (source === "runpod" ? "media" : "gemini");

/**
 * A peer's output that is a video inside that job's own `From YTM/<subdir>/<jobId>/` folder, or null. A report is another
 * computer's data: a path naming another job's folder, `..` or a non-video is never used.
 */
export function peerVideoPath(job: Pick<SharedMediaJob, "source" | "jobId" | "outputs">): string | null {
  const subdir = takeSourceOf(job.source);
  for (const output of job.outputs) {
    const parsed = jobOutputPathOf(output, [subdir]);
    if (parsed && parsed.subdir === subdir && parsed.jobId === job.jobId && videoTypeOf(output)) return output;
  }
  return null;
}

export const takeKey = (take: Pick<StoryboardTake, "source" | "jobId">) => `${take.source}:${take.jobId}`;

/**
 * The other computers' takes of one storyboard in one channel: jobs whose `storyboard` link names it, not already among this
 * computer's takes (`ownKeys`), each once (the newest report wins when two name the same job).
 */
export function peerTakes(reports: readonly MediaJobsReport[], input: { channelId: string; storyboardId: string; ownKeys: ReadonlySet<string> }): StoryboardTake[] {
  const seen = new Set(input.ownKeys);
  const out: StoryboardTake[] = [];
  const newestFirst = [...reports].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const report of newestFirst) {
    for (const job of report.jobs) {
      if (job.channelId !== input.channelId || job.storyboard?.storyboardId !== input.storyboardId) continue;
      const source = takeSourceOf(job.source);
      const key = takeKey({ source, jobId: job.jobId });
      if (seen.has(key)) continue;
      seen.add(key);
      const seed = job.plan?.seed;
      out.push({
        source,
        jobId: job.jobId,
        segmentId: job.storyboard.segmentId,
        versionNumber: job.storyboard.versionNumber,
        status: job.status,
        createdAt: job.createdAt,
        label: seed === null || seed === undefined ? job.label : `${job.label} · seed ${seed}`,
        error: job.errorCode,
        device: { deviceId: report.deviceId, hostName: report.hostName },
        localPath: null,
        exchangePath: peerVideoPath(job),
      });
    }
  }
  return out;
}

export function sortTakes(takes: StoryboardTake[]): StoryboardTake[] {
  return takes.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.jobId.localeCompare(b.jobId));
}
