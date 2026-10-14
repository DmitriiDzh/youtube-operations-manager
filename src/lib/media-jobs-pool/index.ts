import { hostname } from "node:os";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createGeminiMediaCore } from "@/lib/gemini-media";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createMediaGenerationCore, jobErrorCode, toSharedJobProgress } from "@/lib/media-generation";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createMediaJobsShareCoreForProduction, MEDIA_JOBS_REPORT_MAX } from "@/lib/sync-gateway";
import { createExchangeFs, resolveExchangeFile } from "@/lib/workspace-exchange";
import { POOL_JOB_OUTPUT_SUBDIRS, type PoolMediaKind, type PoolView } from "./contracts";
import { buildMediaJobsReport, mergePool, reportHostName, toSharedGeminiJob, toSharedRunpodJob, type LocalRunpodJob } from "./services";
import type { GeminiJobView } from "@/lib/gemini-media";

// BL-188 (SHARED_MEDIA_JOBS_PLAN.md): the shared list wired to the real modules. It reads both feature modules and the
// sync-gateway family; neither feature module knows it exists (AGENTS.md §M). If one module cannot be read, the other one's jobs
// and the peers' are still listed.

export * from "./contracts";
export { buildMediaJobsReport, isFinished, mergePool, runpodOutputPath, geminiOutputPath, selectReportJobs, toSharedGeminiJob, toSharedRunpodJob } from "./services";

const errorCode = (error: string | null) => jobErrorCode(error);

async function thisDevice(): Promise<{ deviceId: string; hostName: string | null }> {
  const deviceId = (await createBootstrapConfigStore(getProductionAppPaths().bootstrapConfigPath).ensureExists()).deviceId;
  let name: string | null = null;
  try {
    name = hostname();
  } catch {
    name = null;
  }
  return { deviceId, hostName: reportHostName(name) };
}

/** Each module's own jobs, or none when that module cannot be read now (a broken one never hides the other). */
async function localJobs(): Promise<{ runpod: LocalRunpodJob[]; gemini: GeminiJobView[] }> {
  const [runpod, gemini] = await Promise.all([
    createMediaGenerationCore()
      .listJobsForShare(MEDIA_JOBS_REPORT_MAX)
      .catch((error: unknown) => {
        console.warn(`[media-jobs] RunPod jobs not read: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }),
    Promise.resolve()
      .then(() => createGeminiMediaCore().listJobsForShare(MEDIA_JOBS_REPORT_MAX))
      .catch((error: unknown) => {
        console.warn(`[media-jobs] Gemini jobs not read: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }),
  ]);
  return { runpod, gemini };
}

let lastPublished = { key: "", at: 0 };

/** This computer's jobs for the other computers: written when they changed, and at least every 5 minutes (freshness). */
export async function publishMediaJobsShare(now: Date = new Date()): Promise<void> {
  const [device, jobs] = await Promise.all([thisDevice(), localJobs()]);
  const report = buildMediaJobsReport({
    ...device,
    now,
    jobs: [...jobs.runpod.map((job) => toSharedRunpodJob(job, toSharedJobProgress, errorCode)), ...jobs.gemini.map(toSharedGeminiJob)],
  });
  const key = JSON.stringify([report.hostName, report.jobs]);
  if (key === lastPublished.key && now.getTime() - lastPublished.at < 5 * 60_000) return;
  await createMediaJobsShareCoreForProduction().publishLocalReport(report);
  lastPublished = { key, at: now.getTime() };
}

/** The shared list for Media: the active channel's jobs of one kind (or every kind) on every computer, newest first. */
export async function listMediaJobsPool(input: { channelId: string; kind: PoolMediaKind | null; limit: number }): Promise<PoolView> {
  const [device, jobs, peers, workspace] = await Promise.all([
    thisDevice(),
    localJobs(),
    createMediaJobsShareCoreForProduction()
      .listPeerReports()
      .catch(() => []),
    createChannelWorkspacesCore()
      .getWorkspace({ channelId: input.channelId })
      .catch(() => ({ configured: false as const })),
  ]);
  const hasLocalFile = async (relativePath: string) => {
    if (!workspace.configured) return false;
    return resolveExchangeFile({
      workspace: workspace.path,
      relativePath,
      jobSubdirs: POOL_JOB_OUTPUT_SUBDIRS,
      fs: createExchangeFs(),
      validateWorkspacePath: validateOperatorDirectoryPath,
      isPathInsideOrEqual,
      unavailable: (reason) => new Error(reason),
    }).then(
      () => true,
      () => false
    );
  };
  return mergePool({ own: { ...device, ...jobs }, peers, now: new Date(), channelId: input.channelId, kind: input.kind, shareProgress: toSharedJobProgress, errorCode, hasLocalFile, limit: input.limit });
}
