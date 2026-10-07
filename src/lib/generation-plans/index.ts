import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { linkMediaSessionToPlan } from "@/lib/db";
import { createMediaGenerationCore, isDomainError } from "@/lib/media-generation";
import { createPlanStore } from "./adapters/store";
import { createGenerationPlanServices } from "./services";

// BL-143 (ADR 0029): the generation plans core. Stateless apart from the database, so a new instance per call is fine.
// It depends on the media core (to run stages), never the reverse (AGENTS.md §M).

export * from "./contracts";
export { createGenerationPlanServices, validateDefinition, type GenerationPlanServices, type PlanServiceDependencies, type PlanStore, type StoredPlan } from "./services";
export { PLAN_LIMITS, PLAN_ID_PATTERN } from "./schemas";

export function createGenerationPlansCore() {
  const channels = createChannelConnectionsCore();
  return createGenerationPlanServices({
    store: createPlanStore(),
    channels: { isConnected: async (channelId) => (await channels.listConnectedChannels()).some((c) => c.channelId === channelId) },
    clock: { now: () => new Date() },
    media: {
      async getSession(sessionId) {
        try {
          const session = await createMediaGenerationCore().getSession({ sessionId });
          return { sessionId: session.sessionId, status: session.status, channelId: session.channelId, requestedBy: session.requestedBy, planId: session.planId };
        } catch (error) {
          if (isDomainError(error) && error.code === "media_session_not_found") return null;
          throw error;
        }
      },
      linkSession: (sessionId, planId) => linkMediaSessionToPlan(sessionId, planId),
      validateJobParams: (input) => createMediaGenerationCore().validateJobParams(input),
      getJobOutputs: async (jobId) => (await createMediaGenerationCore().getJob({ jobId })).outputs.map((o) => ({ kind: o.kind, localPath: o.localPath ?? null, filename: o.filename })),
      createJob: async (input) => ({ jobId: (await createMediaGenerationCore().createJob(input)).jobId }),
    },
  });
}
