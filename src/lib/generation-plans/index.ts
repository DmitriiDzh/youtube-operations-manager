import { hostname } from "node:os";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveExchangeFile } from "@/lib/workspace-exchange";
import { appDataPaths, linkMediaSessionToPlan } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { createGenerationPlansShareCoreForProduction, createReviewPresenceForProduction, GENERATION_PLANS_REPORT_FORMAT, generationPlansReportVersionFor } from "@/lib/sync-gateway";
import { createMediaGenerationCore, isDomainError } from "@/lib/media-generation";
import { createVideoProjectsServiceForProduction } from "@/lib/video-projects";
import { createPlanStore } from "./adapters/store";
import { PLAN_JOB_OUTPUT_SUBDIRS, type PlanPickRecord, type PlanVerdictHistoryRow } from "./contracts";
import { createGenerationPlanServices } from "./services";

// BL-143 (ADR 0029): the generation plans core. Stateless apart from the database, so a new instance per call is fine.
// It depends on the media core (to run stages), never the reverse (AGENTS.md §M).

export * from "./contracts";
export { createGenerationPlanServices, validateDefinition, withPlanLock, type GenerationPlanServices, type PlanServiceDependencies, type PlanStore, type StoredPlan } from "./services";
export { PLAN_LIMITS, PLAN_ID_PATTERN } from "./schemas";

/**
 * BL-248 (ADR 0066, REVIEW_NOTIFY_PLAN.md §2-§3): the owner's review activity on THIS computer's plans since `sinceIso` -- every
 * verdict of the history (the other computer's included, once applied here), the active picks and «ни один не подходит», and when a
 * wave was finished (`group_reviewed`). Read-only; the composition layer turns it into the Producer's review-pass files.
 */
export type PlanReviewActivity = {
  planId: string;
  channelId: string;
  title: string;
  video: string | null;
  /** The wave of each item. */
  groupOf: Record<string, string | null>;
  history: PlanVerdictHistoryRow[];
  picks: PlanPickRecord[];
  waveFinishedAt: string[];
};

export async function listPlanReviewActivity(sinceIso: string): Promise<PlanReviewActivity[]> {
  const store = createPlanStore();
  const since = Date.parse(sinceIso);
  const after = (iso: string) => Date.parse(iso) >= since;
  const plans = (await store.listPlans({})).filter((p) => p.status === "active" || p.updatedAt.getTime() >= since || (p.closedAt !== null && p.closedAt.getTime() >= since));
  const out: PlanReviewActivity[] = [];
  for (const plan of plans) {
    const history = (await store.listVerdictHistory(plan.id)).filter((h) => after(h.at));
    const picks = (await store.listPicks(plan.id)).filter((p) => p.active && after(p.at));
    const waveFinishedAt = (await store.listEvents(plan.id)).filter((e) => e.kind === "group_reviewed" && after(e.at)).map((e) => e.at);
    if (history.length === 0 && picks.length === 0) continue;
    out.push({
      planId: plan.id,
      channelId: plan.channelId,
      title: plan.title,
      video: plan.video ?? null,
      groupOf: Object.fromEntries(plan.definition.items.map((i) => [i.itemKey, i.groupId ?? null])),
      history,
      picks,
      waveFinishedAt,
    });
  }
  return out;
}

export function createGenerationPlansCore() {
  const channels = createChannelConnectionsCore();
  return createGenerationPlanServices({
    store: createPlanStore(),
    channels: { isConnected: async (channelId) => (await channels.listConnectedChannels()).some((c) => c.channelId === channelId) },
    clock: { now: () => new Date() },
    generateId: () => randomUUID(),
    // BL-194 (ADR 0040): a plan's video is checked by the shared video-projects module.
    videos: { assertAttachable: (channelId, video) => createVideoProjectsServiceForProduction().assertAttachable(channelId, video) },
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
        resolveExchangeFile({ workspace, relativePath, jobSubdirs: PLAN_JOB_OUTPUT_SUBDIRS, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable: (reason) => new Error(reason) }).then(
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
      // BL-184 stage 3: what each template makes, for Media's kind tabs.
      templateKinds: async () => Object.fromEntries((await createMediaGenerationCore().listWorkflowTemplates()).map((t) => [t.templateId, t.mediaKind])),
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
  // BL-175 (VISUAL_REVIEW_PLAN.md §2.6): and their picks -- after the verdicts, so a rejection that came with them is known.
  await core.applyPeerPicks().catch((error: unknown) => console.warn(`[generation-plans] could not apply other devices' picks: ${error instanceof Error ? error.message : String(error)}`));
  const plans = await core.buildSharedPlans();
  const verdicts = await core.outgoingVerdicts();
  await createGenerationPlansShareCoreForProduction().publishLocalReport({
    format: GENERATION_PLANS_REPORT_FORMAT,
    // BL-229 part B: version 6 only once the report carries forms, a genre or answers; until then 5, as the old build reads.
    version: generationPlansReportVersionFor({ plans, verdicts }),
    deviceId: config.deviceId,
    hostname: host,
    updatedAt: new Date().toISOString(),
    plans,
    verdicts,
    // BL-157 (AC-TC-01): this device's "being reviewed here" claims.
    claims: await core.ownClaims(),
    // BL-162 (v3): the wave notes written here on other devices' plans.
    groupNotes: await core.outgoingGroupNotes(),
    // BL-175 (v5): the pick actions taken here on other devices' plans.
    picks: await core.outgoingPicks(),
  });
}
