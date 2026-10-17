import { hostname } from "node:os";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { createStoryboardsCoreForProduction, createVideoCostsShareCoreForProduction } from "@/lib/sync-gateway";
import { createVideoProjectsServiceForProduction } from "@/lib/video-projects";
import { createCostFiles } from "./adapters/cost-file";
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

export { createVideoCostsService, buildOwnRuns, resultOf, selectReportRuns, totalsOf, PUBLISHED_RUNS_KEEP_DAYS, UNLINKED_RUNS_KEEP_DAYS } from "./services";
export type { VideoCostsService } from "./services";
export * from "./contracts";
