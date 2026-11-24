import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { insertVideoEditAuditEvent, rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createLargeImagePreviewerForProduction, readImageInfo } from "@/lib/media-preview";
import { hashReviewFile, resolveReviewFile } from "@/lib/review-items";
import { nudgeReviewNotify } from "@/lib/review-notify";
import { createImageReviewsCoreForProduction } from "@/lib/sync-gateway";
import { createImageReviewsService, ownerSurface, producerSurface, type ImageReviewsOwnerSurface, type ImageReviewsProducerSurface, type ImageReviewsService } from "./services";

// BL-272 (ADR 0076): the image-reviews module of THIS server process. The write lock is one per process (keyed on globalThis: the
// MCP routes and the Web routes are compiled separately), so it covers the Producer's submits and the owner's decisions together.
const LOCK_KEY = Symbol.for("ytom.imageReviews.lock");
type GlobalWithLock = typeof globalThis & { [LOCK_KEY]?: { queue: Promise<unknown> } };

function hostLabel(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

function service(): ImageReviewsService {
  const holder = globalThis as GlobalWithLock;
  const lock = (holder[LOCK_KEY] ??= { queue: Promise.resolve() });
  return createImageReviewsService({
    store: createImageReviewsCoreForProduction(),
    isChannelConnected: async (channelId) => (await createChannelConnectionsCore().listConnectedChannels()).some((c) => c.channelId === channelId),
    async workspace(channelId) {
      const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
      return workspace.configured ? workspace.path : null;
    },
    resolveFile: resolveReviewFile,
    probeImage: readImageInfo,
    hashFile: hashReviewFile,
    preview: (absolutePath) => createLargeImagePreviewerForProduction().preview(absolutePath),
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
    audit: ({ channelId, imageId, detail }) => insertVideoEditAuditEvent({ channelId, videoId: `image:${imageId}`, eventType: "RESULT", detail }),
    // ADR 0066: an owner decision nudges the Producer's Inbox writer (the shared review-notify module).
    notifyOwnerDecision: () => nudgeReviewNotify(),
  });
}

/** The Producer's surface (its MCP endpoint only): submit, withdraw, list, get -- no decision. */
export function createImageReviewsProducerCore(): ImageReviewsProducerSurface {
  return producerSurface(service());
}

/** The owner's surface: used only by the Web UI's image-review routes (source scan in boundaries.test.ts). */
export function createImageReviewsOwnerCore(): ImageReviewsOwnerSurface {
  return ownerSurface(service());
}

export { createImageReviewsService, producerSurface, ownerSurface } from "./services";
export type { ImageReviewsService, ImageReviewsProducerSurface, ImageReviewsOwnerSurface } from "./services";
export { decidingImageRecordOf, imageViewOf, sortImageViews, imageFileTypeOf } from "./model";
export * from "./contracts";
export * from "./schemas";
