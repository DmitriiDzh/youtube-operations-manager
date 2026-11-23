import type { ScannedPackage } from "@/lib/publishing";

// BL-243: the plan progress's one removed-list read and one package scan per channel, kept for a minute -- the plan screen polls
// every minute, agents read on demand. Pure over its ports (the composition in `index.ts` wires the real ones).

export const PACKAGES_CACHE_MS = 60_000;
/**
 * BL-270 (owner TG 4662/4665): the plan schedule reads every minute too, so a one-minute answer was always just too old and every
 * tick scanned again. Past the first minute a kept answer is reused for up to 5 minutes, but only while the scan's own cheap
 * fingerprints are unchanged (`signature`: the `04 Videos/` files with their sizes and modification times, the removed list, the
 * copy's sync times and -- review finding 2 -- the scan's fields of the channel's videos rows, so a `video-details` local-copy write
 * counts; `filesSignature`, review finding 3: the files the kept scan resolved, through symlinks and below the walk's depth) -- an
 * edited or new manifest, a re-render or a veto is seen at the next read. What the fingerprint does not cover (a setting, the language
 * baseline, a review decision made on another computer) is at most 5 minutes old; this computer's review decisions still drop the
 * answer at once (`invalidatePackagesEntry`).
 */
export const PACKAGES_CACHE_MAX_MS = 5 * 60_000;
/** BL-270 review: how much earlier than the scan's start a resolved file must have last changed for the result to be reused late. */
const FILE_CLOCK_SLACK_MS = 2_000;

export type PackagesEntry = {
  at: number;
  packages: readonly ScannedPackage[] | null;
  synthetic: boolean;
  removedVideoIds: Set<string>;
  /** BL-270: the scan's fingerprint read just BEFORE it (a change during the scan then reads as a change); null = never reused late. */
  signature?: string | null;
  /** BL-270 review (finding 3): the fingerprint of the files this scan resolved, taken after it; null = never reused late. */
  filesSignature?: string | null;
};

export type PackagesCacheDeps = {
  removedVideos(channelId: string): Promise<Array<{ videoId: string; removedAt: string }>>;
  scan(channelId: string, removedVideos: Array<{ videoId: string; removedAt: string }>): Promise<{ status: "ok"; packages: ScannedPackage[] } | { status: string }>;
  synthetic(channelId: string): Promise<boolean>;
  /** BL-270: the scan's cheap fingerprint (null: unknown -- nothing reused past the first minute). Optional: omitted = as before. */
  signature?(channelId: string): Promise<string | null>;
  /**
   * BL-270 review (finding 3): the fingerprint of the files a scan resolved (the manifest, video, thumbnails and upload record it
   * names, through symlinks and below the folder walk's depth) and their newest modification time. Optional: omitted = only
   * `signature` decides.
   */
  filesSignature?(channelId: string, packages: readonly ScannedPackage[]): Promise<{ key: string; newestMtimeMs: number } | null>;
  now(): number;
  cache: Map<string, PackagesEntry>;
};

/**
 * ONE removed-list read, one answer for the packages and the rows -- handed to the one scan; that read failing, both get "none
 * known" (an empty list, never a second read) and the answer is NOT kept (the next call reads again). `packages` null: the scan
 * failed (not kept either).
 */
export function createPackagesReader(deps: PackagesCacheDeps) {
  /**
   * Owner TG 4784 («План» loads slowly): the plan list, the shown week, the calendar and the alerts ask at the same moment, and on a
   * cold cache each of them walked `04 Videos/` on its own. Callers arriving while a read of the channel is under way share that
   * read; `invalidatePackagesEntry` forgets it (a caller after the invalidation reads again, and the older read is not kept).
   */
  const inflight = inflightOf(deps.cache);
  return function packagesOf(channelId: string): Promise<PackagesEntry> {
    const running = inflight.get(channelId);
    if (running) return running;
    const read = readPackages(channelId).finally(() => {
      if (inflight.get(channelId) === read) inflight.delete(channelId);
    });
    inflight.set(channelId, read);
    return read;
  };

  async function readPackages(channelId: string): Promise<PackagesEntry> {
    const generation = generationOf(deps.cache, channelId);
    const hit = deps.cache.get(channelId);
    if (hit && deps.now() - hit.at < PACKAGES_CACHE_MS) return hit;
    const signatureOf = async () => (deps.signature ? await deps.signature(channelId).catch(() => null) : null);
    const signature = hit?.signature != null && deps.now() - hit.at < PACKAGES_CACHE_MAX_MS ? await signatureOf() : undefined;
    // BL-270: the same folder and copy as at the kept scan -- reused (its `at` stays, so it is never older than the 5 minutes) when
    // the files it resolved are unchanged too.
    if (hit && signature != null && signature === hit.signature) {
      if (!deps.filesSignature) return hit;
      if (hit.filesSignature != null && hit.packages) {
        const files = await deps.filesSignature(channelId, hit.packages).catch(() => null);
        if (files && files.key === hit.filesSignature) return hit;
      }
    }
    const before = signature !== undefined ? signature : await signatureOf();
    const startedAt = deps.now();
    const read = await deps.removedVideos(channelId).then(
      (list) => ({ list, ok: true }),
      () => ({ list: [] as Array<{ videoId: string; removedAt: string }>, ok: false })
    );
    const removedVideoIds = new Set(read.list.map((video) => video.videoId));
    try {
      const [scan, synthetic] = await Promise.all([deps.scan(channelId, read.list), deps.synthetic(channelId)]);
      if (scan.status !== "ok" || !("packages" in scan)) return { at: deps.now(), packages: null, synthetic: false, removedVideoIds };
      // BL-270 review (finding 3): a resolved file modified at or after the scan began (2 s for coarse file-system clocks) may have
      // been read before the change -- such a result is never reused past the first minute.
      let filesSignature: string | null | undefined;
      if (deps.filesSignature && before != null) {
        const files = await deps.filesSignature(channelId, scan.packages).catch(() => null);
        filesSignature = files && files.newestMtimeMs < startedAt - FILE_CLOCK_SLACK_MS ? files.key : null;
      }
      const entry: PackagesEntry = {
        at: deps.now(),
        packages: scan.packages,
        synthetic,
        removedVideoIds,
        signature: filesSignature === null ? null : before,
        ...(filesSignature !== undefined ? { filesSignature } : {}),
      };
      // Kept only while no invalidation came during the read (that read may have seen the state before the change).
      if (read.ok && generationOf(deps.cache, channelId) === generation) deps.cache.set(channelId, entry);
      return entry;
    } catch {
      return { at: deps.now(), packages: null, synthetic: false, removedVideoIds };
    }
  }
}

/**
 * Per cache: the read under way for each channel, and how many times the channel was invalidated. Kept on the cache object itself
 * (under a registry symbol), so every copy of this module the server bundles -- the cache is one `globalThis` map -- shares it.
 */
type SharedState = { inflight: Map<string, Promise<PackagesEntry>>; generations: Map<string, number> };
const STATE_KEY = Symbol.for("ytom.publishingPlanProgress.cache.state");
function stateOf(cache: Map<string, PackagesEntry>): SharedState {
  const holder = cache as Map<string, PackagesEntry> & { [STATE_KEY]?: SharedState };
  holder[STATE_KEY] ??= { inflight: new Map(), generations: new Map() };
  return holder[STATE_KEY];
}
const inflightOf = (cache: Map<string, PackagesEntry>) => stateOf(cache).inflight;
const generationOf = (cache: Map<string, PackagesEntry>, channelId: string) => stateOf(cache).generations.get(channelId) ?? 0;

/**
 * BL-257 (ADR 0070, PACKAGE_REVIEW_PLAN.md AC-PR-10): the owner's package-review decision (or switch) changes what the scan says, so
 * the channel's kept answer is dropped -- the slot moves at the plan screen's next read instead of up to a minute later. Owner TG
 * 4784: a read still under way is forgotten too (the next caller scans again) and its answer is not kept.
 */
export function invalidatePackagesEntry(cache: Map<string, PackagesEntry>, channelId: string): void {
  cache.delete(channelId);
  const state = stateOf(cache);
  state.inflight.delete(channelId);
  state.generations.set(channelId, (state.generations.get(channelId) ?? 0) + 1);
}
