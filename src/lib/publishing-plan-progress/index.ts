import { createPackageScanCore, createPublishingSettingsCore, listChannelUploads } from "@/lib/publishing";
import type { PlanSlotProgress, PublishingPlansPorts } from "@/lib/publishing-plans";
import { deletedVideosBySlot, progressOfSlots, progressWithUploads } from "./progress";

// BL-225 stage 2 (ADR 0051, AGENTS.md §M): the plan's `progress` port from the publishing module's package scan, given to the plan's
// surfaces by the MCP deps and the Web routes. A scan reads the channel's whole `04 Videos/` folder, so one is kept for a minute per
// channel (the plan screen polls every minute; agents read on demand). A failed scan gives no progress -- never a wrong one.

const CACHE_KEY = Symbol.for("ytom.publishingPlanProgress.cache");
const CACHE_MS = 60_000;
type Cached = { at: number; packages: Parameters<typeof progressOfSlots>[0]; synthetic: boolean; removedVideoIds: Set<string> };
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: Map<string, Cached> };

async function packagesOf(channelId: string): Promise<Cached | null> {
  const holder = globalThis as GlobalWithCache;
  const cache = (holder[CACHE_KEY] ??= new Map());
  const hit = cache.get(channelId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  try {
    const [scan, settings] = await Promise.all([createPackageScanCore().scan(channelId), createPublishingSettingsCore().read(channelId)]);
    if (scan.status !== "ok") return null;
    // BL-243: the removed ids this very scan read (none known when that read failed), never a second, fresher read.
    const entry: Cached = { at: Date.now(), packages: scan.packages, synthetic: settings.settings.containsSyntheticMedia, removedVideoIds: new Set(scan.removedVideoIds) };
    cache.set(channelId, entry);
    return entry;
  } catch {
    return null;
  }
}

/** The plan's progress port: the packages (`built`, `packaged`) and this computer's uploads (`uploading`, `failed`, `scheduled`, `published`). */
export const publishingPlanProgress: NonNullable<PublishingPlansPorts["progress"]> = async (channelId, _weekStart, slotIds): Promise<Map<string, PlanSlotProgress>> => {
  const found = await packagesOf(channelId);
  // BL-225 stage 3: this computer's upload rows name their slot -- uploading, failed (with the step's code), scheduled, published.
  const rows = await listChannelUploads(channelId).catch(() => []);
  // BL-243: of two deleted packages naming a slot, the one uploaded last speaks (its record's time, else its newest row here).
  const rowTimes = new Map<string, number>();
  for (const row of rows) if (row.videoId) rowTimes.set(row.videoId, Math.max(rowTimes.get(row.videoId) ?? 0, row.createdAt.getTime()));
  const fromPackages = found ? progressOfSlots(found.packages, slotIds, found.synthetic, rowTimes) : new Map<string, PlanSlotProgress>();
  // BL-243: the rows of deleted videos and packages say nothing -- as the scan shown read them (no scan: none known).
  return progressWithUploads(fromPackages, rows, slotIds, Date.now(), {
    removedVideoIds: found?.removedVideoIds ?? new Set<string>(),
    deletedVideosBySlot: found ? deletedVideosBySlot(found.packages) : new Map(),
  });
};

export { deletedVideosBySlot, progressOfPackage, progressOfSlots, progressOfUploadRow, progressWithUploads } from "./progress";
