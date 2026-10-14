import type { MediaJobsReport, SharedMediaJob } from "@/lib/sync-gateway";
import type { JobLiveProgress } from "@/lib/media-generation/job-progress";

// BL-188 (owner, Telegram 2026-10-14, msgs 2801/2803/2806; SHARED_MEDIA_JOBS_PLAN.md): one list of media jobs -- RunPod and
// Gemini, this computer's and every other computer's -- the same on every computer. This module only reads and merges: the
// feature modules (media-generation, gemini-media) know nothing of it (AGENTS.md §M), and with it broken each feature's own
// journal still works.

/** A peer whose report is older than this is shown as "not heard from since …" (its jobs may have moved on). */
export const POOL_PEER_STALE_AFTER_MS = 5 * 60_000;
/** The `99 Data Exchange/From YTM/` subfolders the two modules write job outputs into. */
export const POOL_JOB_OUTPUT_SUBDIRS = ["media", "gemini"] as const;

export type PoolMediaKind = "audio" | "image" | "video";

export type PoolJobOutput = {
  /** The file's name, as shown. */
  name: string;
  /** Relative to the channel's `99 Data Exchange/` folder (`From YTM/<media|gemini>/<jobId>/<file…>`). */
  path: string;
  /** Whether the file is in THIS computer's copy of the channel workspace (a peer's file arrives by the workspace sync). */
  available: boolean;
};

/** One row of the shared list. */
export type PoolJob = Omit<SharedMediaJob, "outputs" | "progress"> & {
  deviceId: string;
  hostName: string | null;
  /** True for this computer's own jobs (its own actions apply directly). */
  own: boolean;
  /** The executing computer's report is older than `POOL_PEER_STALE_AFTER_MS` (never for own jobs). */
  stale: boolean;
  /** The shared progress shape (a peer's, or this computer's without `detail`). */
  progress: SharedMediaJob["progress"];
  /** This computer's own RunPod job only: ComfyUI's live progress as watched here (with its `detail`). */
  liveProgress: JobLiveProgress | null;
  /** This computer's own job only: the full error text; a peer's failure is its code only. */
  error: string | null;
  outputs: PoolJobOutput[];
  /** RunPod outputs not pulled yet (own jobs only; a peer reports pulled files only). */
  pendingOutputs: number;
};

export type PoolDevice = { deviceId: string; hostName: string | null; own: boolean; updatedAt: string | null; stale: boolean };

export type PoolView = { jobs: PoolJob[]; devices: PoolDevice[] };

export type { MediaJobsReport, SharedMediaJob };
