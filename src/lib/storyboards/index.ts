import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createStoryboardsCoreForProduction } from "@/lib/sync-gateway";
import { createStoryboardFiles } from "./adapters/files";
import { createStoryboardsService, type StoryboardsService } from "./services";

// BL-184 (ADR 0038): the storyboards module of THIS server process. One instance per process (keyed on globalThis: the Factory
// route and the Web routes are compiled separately), so its write lock covers the Operator's and the owner's actions together.
const PRODUCTION_KEY = Symbol.for("ytom.storyboards.service");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: StoryboardsService };

function hostLabel(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

export function createStoryboardsServiceForProduction(): StoryboardsService {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    let queue: Promise<unknown> = Promise.resolve();
    holder[PRODUCTION_KEY] = createStoryboardsService({
      store: createStoryboardsCoreForProduction(),
      files: createStoryboardFiles((channelId) => createChannelWorkspacesCore().getWorkspace({ channelId })),
      isChannelConnected: async (channelId) => (await createChannelConnectionsCore().listConnectedChannels()).some((c) => c.channelId === channelId),
      deviceLabel: async () => hostLabel(),
      now: () => new Date(),
      randomId: () => randomUUID().replace(/-/g, "").slice(0, 16),
      withLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = queue.then(fn, fn);
        queue = run.catch(() => undefined);
        return run;
      },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createStoryboardsService, checkContent, exchangeRelativePath } from "./services";
export type { StoryboardsService, StoryboardSummary, StoryboardDetail } from "./services";
export { createStoryboardFiles, sha256OfFile } from "./adapters/files";
export { storyboardState, approvedVersion, diffVersions, changedPropCells, latestVersion, latestVersionNumber } from "./model";
export type { StoryboardState, VersionDiff } from "./model";
export * from "./contracts";
export * from "./schemas";
