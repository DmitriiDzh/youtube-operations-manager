import type { GeminiJobView } from "@/lib/gemini-media";
import type { MediaJob } from "@/lib/media-generation";
import type { MediaKind } from "@/lib/media-generation/contracts";
import type { JobLiveProgress } from "@/lib/media-generation/job-progress";
import {
  MEDIA_JOB_OUTPUTS_MAX,
  MEDIA_JOBS_FINISHED_WINDOW_MS,
  MEDIA_JOBS_REPORT_FORMAT,
  MEDIA_JOBS_REPORT_MAX,
  MEDIA_JOBS_REPORT_VERSION,
  sharedMediaJobSchema,
  type MediaJobsReport,
  type SharedCommandResult,
  type SharedJobCommand,
  type SharedMediaJob,
} from "@/lib/sync-gateway";
import { POOL_PEER_STALE_AFTER_MS, type PoolDevice, type PoolJob, type PoolJobOutput, type PoolMediaKind, type PoolView } from "./contracts";

// BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.1, §3): the pure part of the shared list -- what of a job crosses to the other computers,
// the report's window, and the merge of this computer's jobs with the peers' reports. No I/O here: `./index.ts` wires it.

/** A RunPod job as `media-generation.listJobsForShare` gives it. */
export type LocalRunpodJob = MediaJob & { mediaKind: MediaKind | null; templateName: string | null };
/** How a job's live progress becomes the shape another computer may see (media-generation's own conversion, injected). */
export type ShareProgress = (progress: JobLiveProgress) => NonNullable<SharedMediaJob["progress"]>;

const RUNPOD_TERMINAL = new Set(["done", "failed", "cancelled"]);
const GEMINI_TERMINAL = new Set(["done", "failed"]);

export function isFinished(job: Pick<SharedMediaJob, "source" | "status">): boolean {
  return (job.source === "runpod" ? RUNPOD_TERMINAL : GEMINI_TERMINAL).has(job.status);
}

/**
 * An output's path relative to the channel's `99 Data Exchange/` folder, from the absolute path a RunPod job recorded
 * (`<workspace>/99 Data Exchange/From YTM/media/<jobId>/<file…>`); null when it is not under that job's folder.
 */
export function runpodOutputPath(localPath: string, jobId: string): string | null {
  const normalized = localPath.replace(/\\/g, "/");
  const marker = `/From YTM/media/${jobId}/`;
  const at = normalized.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = normalized.slice(at + marker.length);
  if (!rest || rest.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  return `From YTM/media/${jobId}/${rest}`;
}

/** A Gemini output's path (recorded relative to `From YTM/`, e.g. `gemini/<jobId>/image-1.png`) relative to `99 Data Exchange/`. */
export function geminiOutputPath(relativeToFromYtm: string): string | null {
  const p = relativeToFromYtm.replace(/\\/g, "/");
  if (!p || p.startsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  return `From YTM/${p}`;
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
const errorCodeOf = (code: string | null | undefined) => (code && /^[a-z0-9_]{1,64}$/.test(code) ? code : null);

/** What another computer may see of a RunPod job: never the ComfyUI URL, the prompt id, the parameters or ComfyUI's error text. */
export function toSharedRunpodJob(job: LocalRunpodJob, shareProgress: ShareProgress, errorCode: (error: string | null) => string | null): SharedMediaJob {
  return {
    jobId: job.jobId,
    source: "runpod",
    channelId: job.channelId,
    mediaKind: job.mediaKind,
    status: job.status,
    createdBy: job.createdBy,
    label: clip(`${job.templateName ?? job.templateId} v${job.templateVersion}`, 160),
    sessionId: job.sessionId,
    progress: job.progress ? shareProgress(job.progress) : null,
    plan: job.plan ? { planId: clip(job.plan.planId, 80), itemKey: job.plan.itemKey ? clip(job.plan.itemKey, 200) : null, seed: job.plan.seed } : null,
    storyboard: job.storyboard ? { storyboardId: job.storyboard.storyboardId, versionNumber: job.storyboard.versionNumber, segmentId: job.storyboard.segmentId } : null,
    costUsd: null,
    costIsEstimate: false,
    errorCode: job.status === "failed" ? errorCodeOf(errorCode(job.error)) : null,
    createdAt: job.createdAt,
    submittedAt: job.submittedAt,
    finishedAt: job.finishedAt,
    outputs: job.outputs
      .map((o) => (o.localPath ? runpodOutputPath(o.localPath, job.jobId) : null))
      .filter((p): p is string => p !== null)
      .slice(0, MEDIA_JOB_OUTPUTS_MAX),
  };
}

/** What another computer may see of a Gemini job: never the prompt, the inputs or Google's error text. */
export function toSharedGeminiJob(job: GeminiJobView): SharedMediaJob {
  return {
    jobId: job.jobId,
    source: "gemini",
    channelId: job.channelId,
    mediaKind: job.kind,
    status: job.status,
    createdBy: job.createdBy,
    label: clip(job.model, 160),
    sessionId: null,
    progress: null,
    plan: null,
    storyboard: job.storyboard ? { storyboardId: job.storyboard.storyboardId, versionNumber: job.storyboard.versionNumber, segmentId: job.storyboard.segmentId } : null,
    costUsd: job.costUsd ?? job.estimateUsd,
    costIsEstimate: job.costUsd === null,
    errorCode: job.status === "failed" ? errorCodeOf(job.errorCode) : null,
    createdAt: job.createdAt,
    submittedAt: job.submittedAt,
    finishedAt: job.finishedAt,
    outputs: job.outputs
      .map((o) => geminiOutputPath(o.path))
      .filter((p): p is string => p !== null)
      .slice(0, MEDIA_JOB_OUTPUTS_MAX),
  };
}

/**
 * The report's window (owner msg 2806): every unfinished job, plus finished ones of the last 7 days (by when they finished, or
 * were created when that is unknown); at most `MEDIA_JOBS_REPORT_MAX`, unfinished ones kept first; newest first. A job that does
 * not fit the report's schema is left out (one odd row must not stop the whole report).
 */
export function selectReportJobs(jobs: readonly SharedMediaJob[], now: Date): SharedMediaJob[] {
  const cutoff = now.getTime() - MEDIA_JOBS_FINISHED_WINDOW_MS;
  const valid = jobs.filter((job) => sharedMediaJobSchema.safeParse(job).success);
  const open = valid.filter((job) => !isFinished(job));
  const finished = valid.filter((job) => isFinished(job) && Date.parse(job.finishedAt ?? job.createdAt) >= cutoff);
  const byNewest = (a: SharedMediaJob, b: SharedMediaJob) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const kept = [...open.sort(byNewest), ...finished.sort(byNewest)].slice(0, MEDIA_JOBS_REPORT_MAX);
  return kept.sort(byNewest);
}

export function buildMediaJobsReport(input: {
  deviceId: string;
  hostName: string | null;
  now: Date;
  jobs: readonly SharedMediaJob[];
  /** Stage 2: this computer's commands to other computers, and the results of those it received. */
  commands?: readonly SharedJobCommand[];
  commandResults?: readonly SharedCommandResult[];
}): MediaJobsReport {
  return {
    format: MEDIA_JOBS_REPORT_FORMAT,
    version: MEDIA_JOBS_REPORT_VERSION,
    deviceId: input.deviceId,
    hostName: input.hostName,
    updatedAt: input.now.toISOString(),
    jobs: selectReportJobs(input.jobs, input.now),
    commands: [...(input.commands ?? [])],
    commandResults: [...(input.commandResults ?? [])],
  };
}

/** A computer name as the report allows it (letters, digits, space, `._'-`, ≤ 64), or null. */
export function reportHostName(hostname: string | null | undefined): string | null {
  return (hostname ?? "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 64) || null;
}

const nameOf = (relative: string) => relative.slice(relative.lastIndexOf("/") + 1);

export type MergeInput = {
  own: { deviceId: string; hostName: string | null; runpod: readonly LocalRunpodJob[]; gemini: readonly GeminiJobView[] };
  peers: readonly MediaJobsReport[];
  now: Date;
  /** Only this channel's jobs (Media is the active channel's). */
  channelId: string;
  /** Only jobs of this kind; a job of no known kind shows under every kind. null = every kind. */
  kind: PoolMediaKind | null;
  shareProgress: ShareProgress;
  errorCode: (error: string | null) => string | null;
  /** Whether a peer's output (relative to `99 Data Exchange/`) is in this computer's copy of the channel workspace. */
  hasLocalFile: (relativePath: string) => Promise<boolean>;
  /** At most this many rows, newest first (a peer's files are looked up only for the rows returned). */
  limit: number;
};

/**
 * One list: this computer's jobs as they are here (full error text, live progress, own outputs) and every peer's reported jobs
 * (codes only), newest first, with the computers they run on. A peer report naming this computer is ignored; the same job id
 * reported twice keeps the newest report's row.
 */
export async function mergePool(input: MergeInput): Promise<PoolView> {
  const kindMatches = (kind: PoolMediaKind | null) => input.kind === null || kind === null || kind === input.kind;
  const rows: PoolJob[] = [];
  const seen = new Set<string>();
  for (const job of input.own.runpod) {
    if (job.channelId !== input.channelId || !kindMatches(job.mediaKind)) continue;
    const shared = toSharedRunpodJob(job, input.shareProgress, input.errorCode);
    seen.add(`runpod:${job.jobId}`);
    rows.push({
      ...shared,
      deviceId: input.own.deviceId,
      hostName: input.own.hostName,
      own: true,
      stale: false,
      liveProgress: job.progress ?? null,
      error: job.error,
      outputs: job.outputs.filter((o) => o.localPath).map((o) => ({ name: nameOf((o.localPath ?? o.filename).replace(/\\/g, "/")), path: runpodOutputPath(o.localPath ?? "", job.jobId) ?? "", available: true })),
      pendingOutputs: job.outputs.filter((o) => !o.localPath).length,
    });
  }
  for (const job of input.own.gemini) {
    if (job.channelId !== input.channelId || !kindMatches(job.kind)) continue;
    const shared = toSharedGeminiJob(job);
    seen.add(`gemini:${job.jobId}`);
    rows.push({
      ...shared,
      deviceId: input.own.deviceId,
      hostName: input.own.hostName,
      own: true,
      stale: false,
      liveProgress: null,
      error: job.error,
      outputs: shared.outputs.map((path) => ({ name: nameOf(path), path, available: true })),
      pendingOutputs: 0,
    });
  }
  const devices: PoolDevice[] = [{ deviceId: input.own.deviceId, hostName: input.own.hostName, own: true, updatedAt: null, stale: false }];
  const peers = input.peers.filter((r) => r.deviceId !== input.own.deviceId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const report of peers) {
    const stale = input.now.getTime() - Date.parse(report.updatedAt) > POOL_PEER_STALE_AFTER_MS;
    devices.push({ deviceId: report.deviceId, hostName: report.hostName, own: false, updatedAt: report.updatedAt, stale });
    for (const job of report.jobs) {
      const key = `${job.source}:${job.jobId}`;
      if (seen.has(key) || job.channelId !== input.channelId || !kindMatches(job.mediaKind)) continue;
      seen.add(key);
      const outputs: PoolJobOutput[] = job.outputs.map((path) => ({ name: nameOf(path), path, available: false }));
      rows.push({ ...job, deviceId: report.deviceId, hostName: report.hostName, own: false, stale, liveProgress: null, error: null, outputs, pendingOutputs: 0 });
    }
  }
  rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.jobId < b.jobId ? 1 : -1));
  const shown = rows.slice(0, Math.max(0, input.limit));
  for (const row of shown) {
    if (row.own) continue;
    for (const output of row.outputs) output.available = await input.hasLocalFile(output.path).catch(() => false);
  }
  return { jobs: shown, devices };
}

// ---------------------------------------------------------------------------
// BL-188 stage 3 (SHARED_MEDIA_JOBS_PLAN.md §2.7, owner msg 2806 item 4): the Factory Operator's read of every computer's jobs
// (`factory_jobs_list`). Read-only, and in the report's shape for every computer -- this one's own jobs too -- so the Operator
// sees codes, never a prompt, parameters, an input path or a provider's error text, wherever the job runs.
// ---------------------------------------------------------------------------

export const AGENT_JOBS_LIST_DEFAULT = 100;
export const AGENT_JOBS_LIST_MAX = 500;

export type AgentJobsFilter = {
  channelId?: string;
  source?: "runpod" | "gemini";
  mediaKind?: PoolMediaKind;
  status?: string;
  planId?: string;
  /** Default 100, at most 500. */
  limit?: number;
};

export type AgentJobsDevice = { deviceId: string; hostName: string | null; thisComputer: boolean; updatedAt: string; reportAgeSeconds: number; stale: boolean };
export type AgentJobsRow = SharedMediaJob & { device: { deviceId: string; hostName: string | null; thisComputer: boolean }; reportAgeSeconds: number; stale: boolean };
export type AgentJobsList = { devices: AgentJobsDevice[]; jobs: AgentJobsRow[]; total: number; truncated: boolean };

/**
 * Every computer's jobs for the Operator, newest first: this computer's (as its own report would carry them, age 0) and every
 * peer's reported jobs, with the computer and how old its report is ("stale" after 5 minutes). A peer report naming this
 * computer is ignored, and the same job reported twice keeps the first (this computer's, then the newest report's). A filter
 * on `mediaKind` keeps jobs of no known kind out (the Operator asked for that kind).
 */
export function agentJobsList(input: {
  own: { deviceId: string; hostName: string | null; jobs: readonly SharedMediaJob[] };
  peers: readonly MediaJobsReport[];
  now: Date;
  filter: AgentJobsFilter;
}): AgentJobsList {
  const limit = Math.min(AGENT_JOBS_LIST_MAX, Math.max(1, Math.trunc(input.filter.limit ?? AGENT_JOBS_LIST_DEFAULT)));
  const nowIso = input.now.toISOString();
  const devices: AgentJobsDevice[] = [{ deviceId: input.own.deviceId, hostName: input.own.hostName, thisComputer: true, updatedAt: nowIso, reportAgeSeconds: 0, stale: false }];
  const sources: Array<{ device: AgentJobsDevice; jobs: readonly SharedMediaJob[] }> = [{ device: devices[0], jobs: selectReportJobs(input.own.jobs, input.now) }];
  const peers = input.peers.filter((r) => r.deviceId !== input.own.deviceId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const report of peers) {
    const ageMs = Math.max(0, input.now.getTime() - Date.parse(report.updatedAt));
    const device: AgentJobsDevice = { deviceId: report.deviceId, hostName: report.hostName, thisComputer: false, updatedAt: report.updatedAt, reportAgeSeconds: Math.round(ageMs / 1000), stale: ageMs > POOL_PEER_STALE_AFTER_MS };
    devices.push(device);
    sources.push({ device, jobs: report.jobs });
  }
  const f = input.filter;
  const seen = new Set<string>();
  const rows: AgentJobsRow[] = [];
  for (const { device, jobs } of sources) {
    for (const job of jobs) {
      const key = `${job.source}:${job.jobId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (f.channelId !== undefined && job.channelId !== f.channelId) continue;
      if (f.source !== undefined && job.source !== f.source) continue;
      if (f.mediaKind !== undefined && job.mediaKind !== f.mediaKind) continue;
      if (f.status !== undefined && job.status !== f.status) continue;
      if (f.planId !== undefined && job.plan?.planId !== f.planId) continue;
      rows.push({ ...job, device: { deviceId: device.deviceId, hostName: device.hostName, thisComputer: device.thisComputer }, reportAgeSeconds: device.reportAgeSeconds, stale: device.stale });
    }
  }
  rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.jobId < b.jobId ? 1 : -1));
  return { devices, jobs: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
}
