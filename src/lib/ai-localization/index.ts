import { createDefaultLogger } from "@/lib/channel-sync/adapters/logger";
import { createChangeSetChannelStoreAdapter, createIdGenerator } from "@/lib/changesets/adapters/store";
import { createChangeSetCore } from "@/lib/changesets";
import { createAiConnectionCore } from "@/lib/ai-connections";
import { createEditorialProfileStoreAdapter, createGenerationProvenanceStoreAdapter } from "./adapters/profile-store";
import { resolveLocalizationProvider } from "./provider-registry";
import { createAiLocalizationServices } from "./services";
import { rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-handoff";

export function createAiLocalizationCore() {
  const changeSetCore = createChangeSetCore();
  const connectionCore = createAiConnectionCore();

  return createAiLocalizationServices({
    channelStore: createChangeSetChannelStoreAdapter(),
    resolveProvider: resolveLocalizationProvider,
    defaultProviderName: "mock",
    resolveConnectionProvider: connectionCore.resolveConnectionProvider,
    assertDeviceAvailable: () => assertDeviceAvailableForMutation(rawSqlClient),
    changeSetServices: { createChangeSetFromProposals: changeSetCore.createChangeSetFromProposals },
    profileStore: createEditorialProfileStoreAdapter(),
    provenanceStore: createGenerationProvenanceStoreAdapter(),
    idGenerator: createIdGenerator(),
    logger: createDefaultLogger(),
  });
}

export type AiLocalizationCore = ReturnType<typeof createAiLocalizationCore>;
export { resolveLocalizationProvider } from "./provider-registry";
export { createMockLocalizationProvider } from "./adapters/mock-provider";
