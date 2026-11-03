import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { insertVideoEditAuditEvent, rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createClipReviewsCoreForProduction } from "@/lib/sync-gateway";
import { hashClipFile, probeClipDurationSeconds, resolveClipFile } from "./adapters/files";
import { createClipReviewsService, ownerSurface, producerSurface, type ClipReviewsOwnerSurface, type ClipReviewsProducerSurface, type ClipReviewsService } from "./services";

// BL-241 (ADR 0061): the clip-reviews module of THIS server process. The write lock is one per process (keyed on globalThis: the MCP
// routes and the Web routes are compiled separately), so it covers the Producer's submits and the owner's decisions together.
const LOCK_KEY = Symbol.for("ytom.clipReviews.lock");
type GlobalWithLock = typeof globalThis & { [LOCK_KEY]?: { queue: Promise<unknown> } };

function hostLabel(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

function service(): ClipReviewsService {
  const holder = globalThis as GlobalWithLock;
  const lock = (holder[LOCK_KEY] ??= { queue: Promise.resolve() });
  return createClipReviewsService({
    store: createClipReviewsCoreForProduction(),
    isChannelConnected: async (channelId) => (await createChannelConnectionsCore().listConnectedChannels()).some((c) => c.channelId === channelId),
    async workspace(channelId) {
      const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
      return workspace.configured ? workspace.path : null;
    },
    resolveFile: resolveClipFile,
    probeDurationSeconds: probeClipDurationSeconds,
    hashFile: hashClipFile,
    assertDeviceAvailable: () => assertDeviceAvailableForMutation(rawSqlClient),
    deviceLabel: async () => hostLabel(),
    now: () => new Date(),
    randomId: () => randomUUID().replace(/-/g, "").slice(0, 16),
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = lock.queue.then(fn, fn);
      lock.queue = run.catch(() => undefined);
      return run;
    },
    // The owner's decisions are audited on the computer they were made on (the synced record names the device for the other).
    audit: ({ channelId, clipId, detail }) => insertVideoEditAuditEvent({ channelId, videoId: `clip:${clipId}`, eventType: "RESULT", detail }),
  });
}

/** The Producer's surface (its MCP endpoint only): submit, withdraw, list, get -- no decision. */
export function createClipReviewsProducerCore(): ClipReviewsProducerSurface {
  return producerSurface(service());
}

/** The owner's surface: used only by the Web UI's clip-review routes (AC-CR-12 source scan). */
export function createClipReviewsOwnerCore(): ClipReviewsOwnerSurface {
  return ownerSurface(service());
}

export { createClipReviewsService, producerSurface, ownerSurface } from "./services";
export type { ClipReviewsService, ClipReviewsProducerSurface, ClipReviewsOwnerSurface } from "./services";
export { clipViewOf, decidingRecordOf, sortClipViews, clipVideoTypeOf, durationAccepted } from "./model";
export * from "./contracts";
export * from "./schemas";
