import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createGeminiMediaCore } from "@/lib/gemini-media";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createMediaGenerationCore } from "@/lib/media-generation";
import { listPeerMediaJobReports } from "@/lib/media-jobs-pool";
import { createExchangeFs, resolveExchangeFile, resolveFromYtmJobFile } from "@/lib/workspace-exchange";
import { peerTakes, sortTakes, takeKey, videoTypeOf, type StoryboardTake } from "./services";

// BL-184 stage 3 / BL-189 (FO-REQ-0025 A; STORYBOARD_TAKES_PLAN.md §2.8): a composition module. It reads the two video modules,
// the shared job reports and the workspace files; the storyboards module never imports a video module (AGENTS.md §M), and no
// feature module imports this one -- the storyboard routes and the Factory route use it.

export * from "./services";

const exchangeArgs = () => ({ fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable: (reason: string) => new Error(reason) });

async function workspaceOf(channelId: string): Promise<string | null> {
  const workspace = await createChannelWorkspacesCore()
    .getWorkspace({ channelId })
    .catch(() => ({ configured: false as const }));
  return workspace.configured ? workspace.path : null;
}

/** This computer's linked jobs (each module read on its own: one that fails never hides the other's takes). */
async function ownTakes(channelId: string, storyboardId: string): Promise<StoryboardTake[]> {
  const [media, gemini] = await Promise.all([
    createMediaGenerationCore()
      .listJobsByStoryboard(channelId, storyboardId)
      .catch(() => []),
    Promise.resolve()
      .then(() => createGeminiMediaCore().listJobsByStoryboard(channelId, storyboardId))
      .catch(() => []),
  ]);
  const takes: StoryboardTake[] = [];
  for (const job of media) {
    if (!job.storyboard) continue;
    const video = job.outputs.find((o) => o.localPath && videoTypeOf(o.localPath));
    const seed = job.params.seed;
    takes.push({
      source: "media",
      jobId: job.jobId,
      segmentId: job.storyboard.segmentId,
      versionNumber: job.storyboard.versionNumber,
      status: job.status,
      createdAt: job.createdAt,
      label: seed === undefined ? job.templateId : `${job.templateId} · seed ${String(seed)}`,
      error: job.error,
      device: null,
      localPath: video?.localPath ?? null,
      exchangePath: null,
    });
  }
  for (const job of gemini) {
    if (!job.storyboard) continue;
    const video = job.outputs.find((o) => o.kind === "video" && videoTypeOf(o.localPath));
    takes.push({
      source: "gemini",
      jobId: job.jobId,
      segmentId: job.storyboard.segmentId,
      versionNumber: job.storyboard.versionNumber,
      status: job.status,
      createdAt: job.createdAt,
      label: job.model,
      error: job.error,
      device: null,
      localPath: video?.localPath ?? null,
      exchangePath: null,
    });
  }
  return takes;
}

/** The take's video on this computer: its own job's file, or this computer's copy of another computer's output; null when absent. */
export async function resolveTakeFile(channelId: string, take: Pick<StoryboardTake, "source" | "jobId" | "localPath" | "exchangePath">): Promise<{ path: string; bytes: number } | null> {
  const workspace = await workspaceOf(channelId);
  if (!workspace) return null;
  if (take.exchangePath) {
    return resolveExchangeFile({ ...exchangeArgs(), workspace, relativePath: take.exchangePath, jobSubdirs: [take.source] }).catch(() => null);
  }
  if (!take.localPath) return null;
  return resolveFromYtmJobFile({ ...exchangeArgs(), workspace, subdir: take.source, jobId: take.jobId, filePath: take.localPath }).catch(() => null);
}

/** A storyboard's takes on every computer, oldest first; another computer's take has `localPath` set when its file is here. */
export async function listStoryboardTakes(channelId: string, storyboardId: string): Promise<StoryboardTake[]> {
  const [own, reports] = await Promise.all([ownTakes(channelId, storyboardId), listPeerMediaJobReports()]);
  const peers = peerTakes(reports, { channelId, storyboardId, ownKeys: new Set(own.map(takeKey)) });
  const located = await Promise.all(peers.map(async (take) => ({ ...take, localPath: take.exchangePath ? ((await resolveTakeFile(channelId, take))?.path ?? null) : null })));
  return sortTakes([...own, ...located]);
}
