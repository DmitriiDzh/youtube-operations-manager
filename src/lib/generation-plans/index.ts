import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createPlanStore } from "./adapters/store";
import { createGenerationPlanServices } from "./services";

// BL-143 (ADR 0029): the generation plans core. Stateless apart from the database, so a new instance per call is fine.

export * from "./contracts";
export { createGenerationPlanServices, validateDefinition, type GenerationPlanServices, type PlanServiceDependencies, type PlanStore, type StoredPlan } from "./services";
export { PLAN_LIMITS, PLAN_ID_PATTERN } from "./schemas";

export function createGenerationPlansCore() {
  const channels = createChannelConnectionsCore();
  return createGenerationPlanServices({
    store: createPlanStore(),
    channels: { isConnected: async (channelId) => (await channels.listConnectedChannels()).some((c) => c.channelId === channelId) },
    clock: { now: () => new Date() },
  });
}
