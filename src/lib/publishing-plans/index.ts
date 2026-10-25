import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { insertVideoEditAuditEvent } from "@/lib/db";
import { createPublishingPlansCoreForProduction } from "@/lib/sync-gateway";
import { agentSurface, createPublishingPlansService, ownerSurface, type PublishingPlansAgentSurface, type PublishingPlansOwnerSurface, type PublishingPlansService } from "./services";

// BL-225 (ADR 0051): the publishing-plans module of THIS server process. One instance per process (keyed on globalThis: the MCP
// routes and the Web routes are compiled separately), so its write lock covers the agents' saves and the owner's decisions together.
const PRODUCTION_KEY = Symbol.for("ytom.publishingPlans.service");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: PublishingPlansService };

function hostLabel(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

function service(): PublishingPlansService {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    let queue: Promise<unknown> = Promise.resolve();
    holder[PRODUCTION_KEY] = createPublishingPlansService({
      store: createPublishingPlansCoreForProduction(),
      isChannelConnected: async (channelId) => (await createChannelConnectionsCore().listConnectedChannels()).some((c) => c.channelId === channelId),
      deviceLabel: async () => hostLabel(),
      now: () => new Date(),
      randomId: () => randomUUID().replace(/-/g, "").slice(0, 16),
      withLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = queue.then(fn, fn);
        queue = run.catch(() => undefined);
        return run;
      },
      // The owner's decisions are audited on the computer they were made on (the synced record names the device for the others).
      audit: ({ channelId, weekStart, slotId, detail }) => insertVideoEditAuditEvent({ channelId, videoId: `plan:${weekStart}:${slotId}`, eventType: "RESULT", detail }),
      // Stage 1: no package or upload names a slot yet (stages 2-3 fill this port from the publishing module).
    });
  }
  return holder[PRODUCTION_KEY];
}

/** The agents' surface (MCP: the Factory Operator and a channel's worker): save, get, list -- no decision. */
export function createPublishingPlansAgentCore(): PublishingPlansAgentSurface {
  return agentSurface(service());
}

/** The owner's surface: used only by the Web UI's publishing-plans routes (AC-WP-05 source scan). */
export function createPublishingPlansOwnerCore(): PublishingPlansOwnerSurface {
  return ownerSurface(service());
}

export { createPublishingPlansService, agentSurface, ownerSurface } from "./services";
export type { PublishingPlansService, PublishingPlansAgentSurface, PublishingPlansOwnerSurface } from "./services";
export { contentHashOf, instantOf, isMonday, weekEndOf, addDays, planViewOf, slotViewOf, decisionStateOf, needsOwner } from "./model";
export * from "./contracts";
export * from "./schemas";
