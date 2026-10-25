import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { insertVideoEditAuditEvent } from "@/lib/db";
import { createPublishingPlansCoreForProduction } from "@/lib/sync-gateway";
import type { PublishingPlansPorts } from "./contracts";
import { agentSurface, createPublishingPlansService, ownerSurface, type PublishingPlansAgentSurface, type PublishingPlansOwnerSurface, type PublishingPlansService } from "./services";

// BL-225 (ADR 0051): the publishing-plans module of THIS server process. The write lock is one per process (keyed on globalThis: the
// MCP routes and the Web routes are compiled separately), so it covers the agents' saves and the owner's decisions together. The
// `progress` port (stage 2: what the release packages say of a slot) is given by the caller's composition layer -- this module
// never imports `publishing` (AGENTS.md §M); without it every slot is `planned` or `vetoed`.
const LOCK_KEY = Symbol.for("ytom.publishingPlans.lock");
type GlobalWithLock = typeof globalThis & { [LOCK_KEY]?: { queue: Promise<unknown> } };

function hostLabel(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

function service(progress?: PublishingPlansPorts["progress"]): PublishingPlansService {
  const holder = globalThis as GlobalWithLock;
  const lock = (holder[LOCK_KEY] ??= { queue: Promise.resolve() });
  return createPublishingPlansService({
    store: createPublishingPlansCoreForProduction(),
    isChannelConnected: async (channelId) => (await createChannelConnectionsCore().listConnectedChannels()).some((c) => c.channelId === channelId),
    deviceLabel: async () => hostLabel(),
    now: () => new Date(),
    randomId: () => randomUUID().replace(/-/g, "").slice(0, 16),
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = lock.queue.then(fn, fn);
      lock.queue = run.catch(() => undefined);
      return run;
    },
    // The owner's decisions are audited on the computer they were made on (the synced record names the device for the others).
    audit: ({ channelId, weekStart, slotId, detail }) => insertVideoEditAuditEvent({ channelId, videoId: `plan:${weekStart}:${slotId}`, eventType: "RESULT", detail }),
    ...(progress ? { progress } : {}),
  });
}

/** The agents' surface (MCP: the Factory Operator and a channel's worker): save, get, list -- no decision. */
export function createPublishingPlansAgentCore(progress?: PublishingPlansPorts["progress"]): PublishingPlansAgentSurface {
  return agentSurface(service(progress));
}

/** The owner's surface: used only by the Web UI's publishing-plans routes (AC-WP-05 source scan). */
export function createPublishingPlansOwnerCore(progress?: PublishingPlansPorts["progress"]): PublishingPlansOwnerSurface {
  return ownerSurface(service(progress));
}

export { createPublishingPlansService, agentSurface, ownerSurface } from "./services";
export type { PublishingPlansService, PublishingPlansAgentSurface, PublishingPlansOwnerSurface } from "./services";
export { contentHashOf, instantOf, isMonday, weekEndOf, addDays, planViewOf, slotViewOf, decisionStateOf, needsOwner } from "./model";
export * from "./contracts";
export * from "./schemas";
