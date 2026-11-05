import { createPackageScanCore, createPublishingSettingsCore, listChannelUploads, removedVideosOf } from "@/lib/publishing";
import type { PlanProgressResult, PlanSlotProgress, PublishingPlansPorts } from "@/lib/publishing-plans";
import { deletedVideosBySlot, progressOfSlots, progressWithUploads } from "./progress";

// BL-225 stage 2 (ADR 0051, AGENTS.md §M): the plan's `progress` port from the publishing module's package scan, given to the plan's
// surfaces by the MCP deps and the Web routes. A scan reads the channel's whole `04 Videos/` folder, so one is kept for a minute per
// channel (the plan screen polls every minute; agents read on demand). A failed scan gives no progress -- never a wrong one.

const CACHE_KEY = Symbol.for("ytom.publishingPlanProgress.cache");
const CACHE_MS = 60_000;
type Cached = { at: number; packages: Parameters<typeof progressOfSlots>[0] | null; synthetic: boolean; removedVideoIds: Set<string> };
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: Map<string, Cached> };

/**
 * BL-243 (round 8): ONE removed-list read, one answer for the packages and the rows -- handed to the one scan; that read failing,
 * both get "none known" (an empty list, never a second read). `packages` null: the scan failed (not cached).
 */
async function packagesOf(channelId: string): Promise<Cached> {
  const holder = globalThis as GlobalWithCache;
  const cache = (holder[CACHE_KEY] ??= new Map());
  const hit = cache.get(channelId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const removed = await removedVideosOf(channelId).catch(() => []);
  const removedVideoIds = new Set(removed.map((video) => video.videoId));
  try {
    const [scan, settings] = await Promise.all([createPackageScanCore().scan(channelId, { removedVideos: removed }), createPublishingSettingsCore().read(channelId)]);
    if (scan.status !== "ok") return { at: Date.now(), packages: null, synthetic: false, removedVideoIds };
    const entry: Cached = { at: Date.now(), packages: scan.packages, synthetic: settings.settings.containsSyntheticMedia, removedVideoIds };
    cache.set(channelId, entry);
    return entry;
  } catch {
    return { at: Date.now(), packages: null, synthetic: false, removedVideoIds };
  }
}

/** The plan's progress port: the packages (`built`, `packaged`) and this computer's uploads (`uploading`, `failed`, `scheduled`, `published`). */
export const publishingPlanProgress: NonNullable<PublishingPlansPorts["progress"]> = async (channelId, _weekStart, slotIds): Promise<PlanProgressResult> => {
  const found = await packagesOf(channelId);
  // BL-225 stage 3: this computer's upload rows name their slot -- uploading, failed (with the step's code), scheduled, published.
  const rows = await listChannelUploads(channelId).catch(() => []);
  // BL-243: of two deleted packages naming a slot, the one uploaded last speaks (`uploadTimeOf`: record, else the row's own time).
  const fromPackages = found.packages ? progressOfSlots(found.packages, slotIds, found.synthetic, rows) : new Map<string, PlanSlotProgress>();
  // BL-243: the rows of removed videos and deleted packages say nothing -- by the same removed list the packages were scanned with.
  const progress = progressWithUploads(fromPackages, rows, slotIds, Date.now(), {
    removedVideoIds: found.removedVideoIds,
    deletedVideosBySlot: found.packages ? deletedVideosBySlot(found.packages, rows) : new Map(),
  });
  // The packages could not be read: save()'s approval rule then keeps the older, stricter one.
  return { progress, packagesUnavailable: found.packages === null };
};

export { deletedVideosBySlot, progressOfPackage, progressOfSlots, progressOfUploadRow, progressWithUploads } from "./progress";
