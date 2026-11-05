import { createPackageScanCore, createPublishingSettingsCore, listChannelUploads, removedVideoIdsOf, removedVideosOf, type PackageScanResult } from "@/lib/publishing";
import type { PlanProgressResult, PlanSlotProgress, PublishingPlansPorts } from "@/lib/publishing-plans";
import { deletedVideosBySlot, progressOfSlots, progressWithUploads } from "./progress";

// BL-225 stage 2 (ADR 0051, AGENTS.md §M): the plan's `progress` port from the publishing module's package scan, given to the plan's
// surfaces by the MCP deps and the Web routes. A scan reads the channel's whole `04 Videos/` folder, so one is kept for a minute per
// channel (the plan screen polls every minute; agents read on demand). A failed scan gives no progress -- never a wrong one.

const CACHE_KEY = Symbol.for("ytom.publishingPlanProgress.cache");
const CACHE_MS = 60_000;
type Cached = { at: number; packages: Parameters<typeof progressOfSlots>[0]; synthetic: boolean; removedVideoIds: Set<string> | null };
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: Map<string, Cached> };

async function packagesOf(channelId: string): Promise<Cached | null> {
  const holder = globalThis as GlobalWithCache;
  const cache = (holder[CACHE_KEY] ??= new Map());
  const hit = cache.get(channelId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  try {
    const core = createPackageScanCore();
    const [first, settings] = await Promise.all([core.scan(channelId), createPublishingSettingsCore().read(channelId)]);
    // BL-243 round 6: the scan's removed-list read failed -- read it here and scan again with it, so the packages (deleted_on_youtube,
    // their fingerprints) and the rows agree. That read failing too: the scan as it was (none known).
    let scan: PackageScanResult = first;
    if (first.status === "ok" && first.removedVideoIds === null) {
      const removed = await removedVideosOf(channelId).catch(() => null);
      if (removed) scan = await core.scan(channelId, { removedVideos: removed });
    }
    if (scan.status !== "ok") return null;
    // BL-243: the removed ids this very scan read (null when that read failed).
    const entry: Cached = { at: Date.now(), packages: scan.packages, synthetic: settings.settings.containsSyntheticMedia, removedVideoIds: scan.removedVideoIds ? new Set(scan.removedVideoIds) : null };
    cache.set(channelId, entry);
    return entry;
  } catch {
    return null;
  }
}

/** The plan's progress port: the packages (`built`, `packaged`) and this computer's uploads (`uploading`, `failed`, `scheduled`, `published`). */
export const publishingPlanProgress: NonNullable<PublishingPlansPorts["progress"]> = async (channelId, _weekStart, slotIds): Promise<PlanProgressResult> => {
  const found = await packagesOf(channelId);
  // BL-225 stage 3: this computer's upload rows name their slot -- uploading, failed (with the step's code), scheduled, published.
  // BL-243: the removed ids from the scan shown; when the scan or its removed-list read failed, the list read on its own (so a
  // removed video's rows still say nothing; that read failing too: none known).
  const [rows, removedVideoIds] = await Promise.all([
    listChannelUploads(channelId).catch(() => []),
    found?.removedVideoIds ? Promise.resolve(found.removedVideoIds) : removedVideoIdsOf(channelId).catch(() => new Set<string>()),
  ]);
  // BL-243: of two deleted packages naming a slot, the one uploaded last speaks (`uploadTimeOf`: record, else the row's own time).
  const fromPackages = found ? progressOfSlots(found.packages, slotIds, found.synthetic, rows) : new Map<string, PlanSlotProgress>();
  const progress = progressWithUploads(fromPackages, rows, slotIds, Date.now(), {
    removedVideoIds,
    deletedVideosBySlot: found ? deletedVideosBySlot(found.packages, rows) : new Map(),
  });
  // The packages could not be read: save()'s approval rule then keeps the older, stricter one.
  return { progress, packagesUnavailable: !found };
};

export { deletedVideosBySlot, progressOfPackage, progressOfSlots, progressOfUploadRow, progressWithUploads } from "./progress";
