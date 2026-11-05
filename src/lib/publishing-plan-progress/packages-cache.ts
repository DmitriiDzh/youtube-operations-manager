import type { ScannedPackage } from "@/lib/publishing";

// BL-243: the plan progress's one removed-list read and one package scan per channel, kept for a minute -- the plan screen polls
// every minute, agents read on demand. Pure over its ports (the composition in `index.ts` wires the real ones).

export const PACKAGES_CACHE_MS = 60_000;

export type PackagesEntry = { at: number; packages: readonly ScannedPackage[] | null; synthetic: boolean; removedVideoIds: Set<string> };

export type PackagesCacheDeps = {
  removedVideos(channelId: string): Promise<Array<{ videoId: string; removedAt: string }>>;
  scan(channelId: string, removedVideos: Array<{ videoId: string; removedAt: string }>): Promise<{ status: "ok"; packages: ScannedPackage[] } | { status: string }>;
  synthetic(channelId: string): Promise<boolean>;
  now(): number;
  cache: Map<string, PackagesEntry>;
};

/**
 * ONE removed-list read, one answer for the packages and the rows -- handed to the one scan; that read failing, both get "none
 * known" (an empty list, never a second read) and the answer is NOT kept (the next call reads again). `packages` null: the scan
 * failed (not kept either).
 */
export function createPackagesReader(deps: PackagesCacheDeps) {
  return async function packagesOf(channelId: string): Promise<PackagesEntry> {
    const hit = deps.cache.get(channelId);
    if (hit && deps.now() - hit.at < PACKAGES_CACHE_MS) return hit;
    const read = await deps.removedVideos(channelId).then(
      (list) => ({ list, ok: true }),
      () => ({ list: [] as Array<{ videoId: string; removedAt: string }>, ok: false })
    );
    const removedVideoIds = new Set(read.list.map((video) => video.videoId));
    try {
      const [scan, synthetic] = await Promise.all([deps.scan(channelId, read.list), deps.synthetic(channelId)]);
      if (scan.status !== "ok" || !("packages" in scan)) return { at: deps.now(), packages: null, synthetic: false, removedVideoIds };
      const entry: PackagesEntry = { at: deps.now(), packages: scan.packages, synthetic, removedVideoIds };
      if (read.ok) deps.cache.set(channelId, entry);
      return entry;
    } catch {
      return { at: deps.now(), packages: null, synthetic: false, removedVideoIds };
    }
  };
}
