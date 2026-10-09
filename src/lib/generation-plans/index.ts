import { hostname } from "node:os";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { appDataPaths, linkMediaSessionToPlan } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { createGenerationPlansShareCoreForProduction, createReviewPresenceForProduction, GENERATION_PLANS_REPORT_FORMAT, GENERATION_PLANS_REPORT_VERSION } from "@/lib/sync-gateway";
import { createMediaGenerationCore, isDomainError } from "@/lib/media-generation";
import { createPlanStore } from "./adapters/store";
import { createGenerationPlanServices } from "./services";

// BL-143 (ADR 0029): the generation plans core. Stateless apart from the database, so a new instance per call is fine.
// It depends on the media core (to run stages), never the reverse (AGENTS.md §M).

export * from "./contracts";
export { createGenerationPlanServices, validateDefinition, withPlanLock, type GenerationPlanServices, type PlanServiceDependencies, type PlanStore, type StoredPlan } from "./services";
export { PLAN_LIMITS, PLAN_ID_PATTERN } from "./schemas";

export function createGenerationPlansCore() {
  const channels = createChannelConnectionsCore();
  return createGenerationPlanServices({
    store: createPlanStore(),
    channels: { isConnected: async (channelId) => (await channels.listConnectedChannels()).some((c) => c.channelId === channelId) },
    clock: { now: () => new Date() },
    generateId: () => randomUUID(),
    // BL-157 (AC-TC-04/05): this computer as a verdict's history names it.
    deviceLabel: async () => hostLabel() ?? (await createBootstrapConfigStore(appDataPaths.bootstrapConfigPath).ensureExists()).deviceId,
    peers: {
      ownDeviceId: async () => (await createBootstrapConfigStore(appDataPaths.bootstrapConfigPath).ensureExists()).deviceId,
      listPeerReports: () => createGenerationPlansShareCoreForProduction().listPeerReports(),
    },
    // BL-162 (§5.4): "what is open here" in its own small file, written at once and read straight from disk.
    presence: {
      publish: (claims) => createReviewPresenceForProduction().publish({ hostname: hostLabel(), claims }),
      readPeers: () => createReviewPresenceForProduction().readPeers(),
    },
    // BL-157 (AC-MV-03): a plan move checks its files with the same resolver the player uses.
    files: {
      async workspaceOf(channelId) {
        const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
        return workspace.configured ? workspace.path : null;
      },
      sentFileExists: (workspace, relativePath) =>
        resolveSentToYtmFile({ workspace, relativePath, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable: (reason) => new Error(reason) }).then(
          () => true,
          () => false
        ),
    },
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

/**
 * BL-143 phase 2: this device's generation plans report for the other devices (sync-gateway `generation-plans`), built on the
 * media watcher tick. Verdicts given here on other devices' plans travel in the same report.
 */
/** This computer's host name, or null when it cannot be read. */
function hostLabel(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

export async function publishGenerationPlansShare(): Promise<void> {
  const config = await createBootstrapConfigStore(appDataPaths.bootstrapConfigPath).ensureExists();
  const host = hostLabel();
  const core = createGenerationPlansCore();
  // First take in the verdicts other devices gave on this device's plans, so this report already shows them applied.
  // Its own failure never stops this device's report from going out (independent review).
  await core.applyPeerVerdicts().catch((error: unknown) => console.warn(`[generation-plans] could not apply other devices' verdicts: ${error instanceof Error ? error.message : String(error)}`));
  // BL-162 (FO-REQ-0013 §2.3): and the wave notes they wrote on this device's plans.
  await core.applyPeerGroupNotes().catch((error: unknown) => console.warn(`[generation-plans] could not apply other devices' wave notes: ${error instanceof Error ? error.message : String(error)}`));
  await createGenerationPlansShareCoreForProduction().publishLocalReport({
    format: GENERATION_PLANS_REPORT_FORMAT,
    version: GENERATION_PLANS_REPORT_VERSION,
    deviceId: config.deviceId,
    hostname: host,
    updatedAt: new Date().toISOString(),
    plans: await core.buildSharedPlans(),
    verdicts: await core.outgoingVerdicts(),
    // BL-157 (AC-TC-01): this device's "being reviewed here" claims.
    claims: await core.ownClaims(),
    // BL-162 (v3): the wave notes written here on other devices' plans.
    groupNotes: await core.outgoingGroupNotes(),
  });
}
