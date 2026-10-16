import { hostname } from "node:os";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { createStoryboardsCoreForProduction, createVideoReservationsShareCoreForProduction } from "@/lib/sync-gateway";
import { createVideoProjectsStore } from "./adapters/store";
import { createVideoProjectsWorkspace } from "./adapters/workspace";
import { createVideoProjectsService, type VideoProjectsService } from "./services";

// BL-194 stage 1 (ADR 0040): the video-projects module of THIS server process. One instance per process (keyed on globalThis: the
// Factory route, the Web routes and the media modules are compiled separately), so its lock covers every reservation here.
const PRODUCTION_KEY = Symbol.for("ytom.videoProjects.service");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: VideoProjectsService };

function hostLabel(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

export function createVideoProjectsServiceForProduction(): VideoProjectsService {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const share = createVideoReservationsShareCoreForProduction();
    const bootstrap = createBootstrapConfigStore(getProductionAppPaths().bootstrapConfigPath);
    const store = createVideoProjectsStore();
    let queue: Promise<unknown> = Promise.resolve();
    holder[PRODUCTION_KEY] = createVideoProjectsService({
      store,
      uploads: store.uploads,
      planVideo: store.planVideo,
      peers: () => share.listPeerReports(),
      publishReport: (report) => share.publishLocalReport(report),
      ownDevice: async () => ({ deviceId: (await bootstrap.ensureExists()).deviceId, hostName: hostLabel() }),
      isChannelConnected: async (channelId) => (await createChannelConnectionsCore().listConnectedChannels()).some((c) => c.channelId === channelId),
      workspace: createVideoProjectsWorkspace((channelId) => createChannelWorkspacesCore().getWorkspace({ channelId })),
      // A storyboard's video, read from the synced storyboards document (never through the storyboards feature module).
      storyboardVideo: async (channelId, storyboardId) => (await createStoryboardsCoreForProduction().read(channelId)).find((s) => s.id === storyboardId)?.video ?? null,
      now: () => new Date(),
      withLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = queue.then(fn, fn);
        queue = run.catch(() => undefined);
        return run;
      },
      log: (line) => console.warn(line),
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createVideoProjectsService } from "./services";
export type { VideoProjectsService, VideoListResult } from "./services";
export { buildVideoList, nextVideoNumber, videoNumberValue, knownNumbers } from "./numbering";
export * from "./contracts";
export * from "./schemas";
