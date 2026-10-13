import path from "node:path";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createGeminiMediaCore } from "@/lib/gemini-media";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createMediaGenerationCore } from "@/lib/media-generation";
import { createExchangeFs, resolveFromYtmJobFile } from "@/lib/workspace-exchange";

// BL-184 stage 3 (FO-REQ-0024 B5): a storyboard's takes -- the GPU media jobs and the Gemini jobs that rendered its segments (the
// link the storyboard gate recorded on them). Composed here, in the route layer: the storyboards module never imports the video
// modules (AGENTS.md §M), and they never import it back except for the injected gate.

export type TakeSource = "media" | "gemini";

export type StoryboardTake = {
  source: TakeSource;
  jobId: string;
  segmentId: string;
  versionNumber: number;
  status: string;
  createdAt: string;
  /** What made it: the template and seed, or the Gemini model. */
  label: string;
  error: string | null;
  /** The job's video file on this computer (absolute; never sent to the browser), or null while it has none. */
  localPath: string | null;
};

const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4" };

export function videoTypeOf(filePath: string): string | null {
  return VIDEO_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

export async function listStoryboardTakes(channelId: string, storyboardId: string): Promise<StoryboardTake[]> {
  const [media, gemini] = await Promise.all([createMediaGenerationCore().listJobsByStoryboard(channelId, storyboardId), createGeminiMediaCore().listJobsByStoryboard(channelId, storyboardId)]);
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
      localPath: video?.localPath ?? null,
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
      localPath: video?.localPath ?? null,
    });
  }
  return takes.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.jobId.localeCompare(b.jobId));
}

/** The take's file, proven to be inside that job's own `From YTM/<media|gemini>/<jobId>/` folder on this computer. */
export async function resolveTakeFile(channelId: string, take: Pick<StoryboardTake, "source" | "jobId" | "localPath">): Promise<{ path: string; bytes: number } | null> {
  if (!take.localPath) return null;
  const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
  if (!workspace.configured) return null;
  return resolveFromYtmJobFile({
    workspace: workspace.path,
    subdir: take.source,
    jobId: take.jobId,
    filePath: take.localPath,
    fs: createExchangeFs(),
    validateWorkspacePath: validateOperatorDirectoryPath,
    isPathInsideOrEqual,
    unavailable: (reason) => new Error(reason),
  }).catch(() => null);
}
