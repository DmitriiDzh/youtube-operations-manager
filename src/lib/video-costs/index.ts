import { hostname } from "node:os";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { createStoryboardsCoreForProduction, createVideoCostsShareCoreForProduction } from "@/lib/sync-gateway";
import { createVideoProjectsServiceForProduction } from "@/lib/video-projects";
import { countUnlinkedJobsByOrigin, linkUnlinkedJobsToVideo, listGenerationPlanVideos } from "@/lib/db";
import { createBackfillFiles } from "./adapters/backfill-files";
import { createCostFiles } from "./adapters/cost-file";
import { createVideoCostsBackfill, type BackfillDeps, type VideoCostsBackfill } from "./backfill";
import { readOwnRunRows } from "./adapters/store";
import type { VideoStateInfo } from "./contracts";
import { createVideoCostsService, type VideoCostsService } from "./services";

// BL-194 stage 3 (ADR 0041): the video-costs module of THIS server process (one per process, on globalThis: the routes, the Factory
// route and the scheduler are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.videoCosts.service");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: VideoCostsService };

function hostLabel(): string | null {
  try {
    return (hostname() || "").replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 64) || null;
  } catch {
    return null;
  }
}

export function createVideoCostsServiceForProduction(): VideoCostsService {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const share = createVideoCostsShareCoreForProduction();
    const bootstrap = createBootstrapConfigStore(getProductionAppPaths().bootstrapConfigPath);
    const workspaces = createChannelWorkspacesCore();
    holder[PRODUCTION_KEY] = createVideoCostsService({
      ownRows: readOwnRunRows,
      peers: () => share.listPeerReports(),
      publishReport: (report) => share.publishLocalReport(report),
      ownDevice: async () => ({ deviceId: (await bootstrap.ensureExists()).deviceId, hostName: hostLabel() }),
      isChannelConnected: async (channelId) => (await createChannelConnectionsCore().listConnectedChannels()).some((c) => c.channelId === channelId),
      // The picks and renders, read from the synced storyboards document (never through the storyboards feature module).
      storyboards: async (channelId) => (await createStoryboardsCoreForProduction().read(channelId)).map((s) => ({ id: s.id, picks: s.picks, renders: s.renders })),
      videoStates: async (channelId) => {
        const list = await createVideoProjectsServiceForProduction().listVideos({ channelId });
        return new Map<string, VideoStateInfo>(list.videos.map((v) => [v.video, { state: v.state, folder: v.folder }]));
      },
      costFiles: createCostFiles(async (channelId) => {
        const workspace = await workspaces.getWorkspace({ channelId });
        if (!workspace.configured) throw new Error("This channel has no workspace folder on this computer.");
        return workspace.path;
      }),
      now: () => new Date(),
      log: (line) => console.warn(line),
    });
  }
  return holder[PRODUCTION_KEY];
}

async function workspacePath(channelId: string): Promise<string> {
  const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
  if (!workspace.configured) throw new Error("This channel has no workspace folder on this computer.");
  return workspace.path;
}

/**
 * BL-194 stage 4 (ADR 0041): older runs of this computer. `setStoryboardVideo` is the storyboards module's own owner action, given by
 * the caller (the route): this module never imports a feature module (AGENTS.md §M).
 */
export function createVideoCostsBackfillForProduction(extra: Pick<BackfillDeps, "setStoryboardVideo"> = {}): VideoCostsBackfill {
  const files = createBackfillFiles(workspacePath);
  return createVideoCostsBackfill({
    isChannelConnected: async (channelId) => (await createChannelConnectionsCore().listConnectedChannels()).some((c) => c.channelId === channelId),
    storyboards: async (channelId) =>
      (await createStoryboardsCoreForProduction().read(channelId)).map((s) => {
        const numbers = Object.keys(s.versions).map(Number).filter(Number.isFinite);
        const latest = numbers.length > 0 ? s.versions[String(Math.max(...numbers))] : undefined;
        return {
          id: s.id,
          title: latest?.title ?? s.id,
          video: s.video ?? null,
          renders: Object.values(s.renders ?? {}).map((r) => ({ file: r.file, sha256: r.sha256, bytes: r.bytes, versionNumber: r.versionNumber })),
        };
      }),
    videoFolders: (channelId) => files.videoFolders(channelId),
    hashOf: (channelId, relativePath) => files.hashOf(channelId, relativePath),
    unlinkedRuns: (channelId) => countUnlinkedJobsByOrigin(channelId),
    plans: async (channelId, ids) => (await listGenerationPlanVideos(ids)).filter((p) => p.channelId === channelId),
    assertAttachable: (channelId, video) => createVideoProjectsServiceForProduction().assertAttachable(channelId, video),
    ...extra,
    linkRuns: (channelId, target, video) => linkUnlinkedJobsToVideo(channelId, target, video),
    log: (line) => console.warn(line),
  });
}

export { createVideoCostsBackfill } from "./backfill";
export type { BackfillDeps, BackfillProposals, BackfillStoryboard, VideoCostsBackfill } from "./backfill";
export { createVideoCostsService, buildOwnRuns, resultOf, selectReportRuns, totalsOf, PUBLISHED_RUNS_KEEP_DAYS, UNLINKED_RUNS_KEEP_DAYS } from "./services";
export type { VideoCostsService } from "./services";
export * from "./contracts";
