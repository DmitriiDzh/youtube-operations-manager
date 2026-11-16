import type { ScannedPackage } from "@/lib/publishing";

// BL-243: the plan progress's one removed-list read and one package scan per channel, kept for a minute -- the plan screen polls
// every minute, agents read on demand. Pure over its ports (the composition in `index.ts` wires the real ones).

export const PACKAGES_CACHE_MS = 60_000;
/**
 * BL-270 (owner TG 4662/4665): the plan schedule reads every minute too, so a one-minute answer was always just too old and every
 * tick scanned again. Past the first minute a kept answer is reused for up to 5 minutes, but only while the scan's own cheap
 * fingerprint (`signature`: the `04 Videos/` files with their sizes and modification times, the removed list, the copy's sync time)
 * is unchanged -- an edited or new manifest is seen at the next read. What the fingerprint does not cover (a setting, the language
 * baseline, a review decision made on another computer) is at most 5 minutes old; this computer's review decisions still drop the
 * answer at once (`invalidatePackagesEntry`).
 */
export const PACKAGES_CACHE_MAX_MS = 5 * 60_000;

export type PackagesEntry = {
  at: number;
  packages: readonly ScannedPackage[] | null;
  synthetic: boolean;
  removedVideoIds: Set<string>;
  /** BL-270: the scan's fingerprint read just BEFORE it (a change during the scan then reads as a change); null = never reused late. */
  signature?: string | null;
};

export type PackagesCacheDeps = {
  removedVideos(channelId: string): Promise<Array<{ videoId: string; removedAt: string }>>;
  scan(channelId: string, removedVideos: Array<{ videoId: string; removedAt: string }>): Promise<{ status: "ok"; packages: ScannedPackage[] } | { status: string }>;
  synthetic(channelId: string): Promise<boolean>;
  /** BL-270: the scan's cheap fingerprint (null: unknown -- nothing reused past the first minute). Optional: omitted = as before. */
  signature?(channelId: string): Promise<string | null>;
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
    const signatureOf = async () => (deps.signature ? await deps.signature(channelId).catch(() => null) : null);
    const signature = hit?.signature != null && deps.now() - hit.at < PACKAGES_CACHE_MAX_MS ? await signatureOf() : undefined;
    // BL-270: the same folder and copy as at the kept scan -- reused (its `at` stays, so it is never older than the 5 minutes).
    if (hit && signature != null && signature === hit.signature) return hit;
    const before = signature !== undefined ? signature : await signatureOf();
    const read = await deps.removedVideos(channelId).then(
      (list) => ({ list, ok: true }),
      () => ({ list: [] as Array<{ videoId: string; removedAt: string }>, ok: false })
    );
    const removedVideoIds = new Set(read.list.map((video) => video.videoId));
    try {
      const [scan, synthetic] = await Promise.all([deps.scan(channelId, read.list), deps.synthetic(channelId)]);
      if (scan.status !== "ok" || !("packages" in scan)) return { at: deps.now(), packages: null, synthetic: false, removedVideoIds };
      const entry: PackagesEntry = { at: deps.now(), packages: scan.packages, synthetic, removedVideoIds, signature: before };
      if (read.ok) deps.cache.set(channelId, entry);
      return entry;
    } catch {
      return { at: deps.now(), packages: null, synthetic: false, removedVideoIds };
    }
  };
}

/**
 * BL-257 (ADR 0070, PACKAGE_REVIEW_PLAN.md AC-PR-10): the owner's package-review decision (or switch) changes what the scan says, so
 * the channel's kept answer is dropped -- the slot moves at the plan screen's next read instead of up to a minute later.
 */
export function invalidatePackagesEntry(cache: Map<string, PackagesEntry>, channelId: string): void {
  cache.delete(channelId);
}
