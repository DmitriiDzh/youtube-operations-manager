import { createPackageScanCore, createPublishingSettingsCore } from "@/lib/publishing";
import type { PlanSlotProgress, PublishingPlansPorts } from "@/lib/publishing-plans";
import { progressOfSlots } from "./progress";

// BL-225 stage 2 (ADR 0051, AGENTS.md §M): the plan's `progress` port from the publishing module's package scan, given to the plan's
// surfaces by the MCP deps and the Web routes. A scan reads the channel's whole `04 Videos/` folder, so one is kept for a minute per
// channel (the plan screen polls every minute; agents read on demand). A failed scan gives no progress -- never a wrong one.

const CACHE_KEY = Symbol.for("ytom.publishingPlanProgress.cache");
const CACHE_MS = 60_000;
type Cached = { at: number; packages: Parameters<typeof progressOfSlots>[0]; synthetic: boolean };
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: Map<string, Cached> };

async function packagesOf(channelId: string): Promise<Cached | null> {
  const holder = globalThis as GlobalWithCache;
  const cache = (holder[CACHE_KEY] ??= new Map());
  const hit = cache.get(channelId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  try {
    const [scan, settings] = await Promise.all([createPackageScanCore().scan(channelId), createPublishingSettingsCore().read(channelId)]);
    if (scan.status !== "ok") return null;
    const entry: Cached = { at: Date.now(), packages: scan.packages, synthetic: settings.settings.containsSyntheticMedia };
    cache.set(channelId, entry);
    return entry;
  } catch {
    return null;
  }
}

/** The plan's progress port (stage 2: `built`, `packaged`, and `scheduled` / `published` once a package's upload record says so). */
export const publishingPlanProgress: NonNullable<PublishingPlansPorts["progress"]> = async (channelId, _weekStart, slotIds): Promise<Map<string, PlanSlotProgress>> => {
  const found = await packagesOf(channelId);
  return found ? progressOfSlots(found.packages, slotIds, found.synthetic) : new Map();
};

export { progressOfPackage, progressOfSlots } from "./progress";
