import { createDefaultLogger } from "@/lib/channel-sync/adapters/logger";
import { createChangeSetChannelStoreAdapter, createChangeSetStoreAdapter, createIdGenerator } from "./adapters/store";
import { createChangeSetServices } from "./services";

export function createChangeSetCore() {
  return createChangeSetServices({
    channelStore: createChangeSetChannelStoreAdapter(),
    changeSetStore: createChangeSetStoreAdapter(),
    idGenerator: createIdGenerator(),
    logger: createDefaultLogger(),
  });
}

export type ChangeSetCore = ReturnType<typeof createChangeSetCore>;
