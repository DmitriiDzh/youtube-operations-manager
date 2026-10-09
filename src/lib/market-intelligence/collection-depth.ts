// Operator request 2026-10-04 ("paged collection deeper than 50 videos") -- the pure rules for how deep a watchlist channel's uploads
// are collected, when a deep (backfill) collection is needed, and what it costs. Zero I/O; shared by the collection loop, the
// channel context/overview and the settings UI so all of them state the same numbers.

/** Today's behaviour (one playlist page), kept until the operator sets a depth. */
export const DEFAULT_MAX_VIDEOS_PER_CHANNEL = 50;
/** Largest accepted depth (40 playlist pages, ~41-81 units for a first collection). */
export const MAX_VIDEOS_PER_CHANNEL_LIMIT = 2000;
/** `playlistItems.list` page size (the API maximum) -- also the `videos.list` batch size the flat 1-unit charge relies on. */
export const PLAYLIST_PAGE_SIZE = 50;

export type CollectionCompleteReason = "exhausted" | "cap" | "date";

/** The persisted progress of one channel's deep collection (`research_channels.videos_*`; undefined/null = not yet known). */
export type CollectionProgressState = {
  videosComplete?: number | null;
  videosCompleteReason?: string | null;
  videosNextPageToken?: string | null;
  videosCapAtRun?: number | null;
  videosPublishedAfterAtRun?: string | null;
};

export type EffectiveCollectionDepth = {
  maxVideosPerChannel: number;
  /** `YYYY-MM-DD` or null. */
  publishedAfter: string | null;
};

/** A calendar date `YYYY-MM-DD` that really exists (2026-02-30 is rejected). */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isValidMaxVideosPerChannel(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_VIDEOS_PER_CHANNEL_LIMIT;
}

/** A per-channel value wins over the global default, which wins over the built-in 50 / no date. */
export function resolveCollectionDepth(
  channel: { maxVideosPerChannel?: number | null; publishedAfter?: string | null },
  defaults: { maxVideosPerChannel: number | null; publishedAfter: string | null }
): EffectiveCollectionDepth {
  return {
    maxVideosPerChannel: channel.maxVideosPerChannel ?? defaults.maxVideosPerChannel ?? DEFAULT_MAX_VIDEOS_PER_CHANNEL,
    publishedAfter: channel.publishedAfter ?? defaults.publishedAfter ?? null,
  };
}

/**
 * Whether the next collection must (continue to) walk the playlist deeper. Not yet known (NULL) and an unfinished backfill both do;
 * a finished one does again only when the settings moved past what it covered: a raised cap after it stopped on the cap, or an
 * earlier/removed date after it stopped on the date. An `exhausted` playlist has nothing deeper to find.
 */
export function needsBackfill(state: CollectionProgressState, depth: EffectiveCollectionDepth, storedVideoCount?: number): boolean {
  if (state.videosComplete === null || state.videosComplete === undefined) return true;
  if (state.videosComplete === 0) return true;
  if (state.videosCompleteReason === "cap") {
    if (state.videosCapAtRun === null || state.videosCapAtRun === undefined || depth.maxVideosPerChannel > state.videosCapAtRun) return true;
    // Review (2026-10-04): snapshots older than the 30-day API retention window drop out of every read, and deeper pages are only
    // snapshotted once -- so a finished deep collection would silently shrink back toward one page. When the readable stored count has fallen
    // below 90% of the depth it reached, walk deeper again. (90%, not 100%: a few videos can never be stored, e.g. private or blocked ones.)
    const reached = Math.min(depth.maxVideosPerChannel, state.videosCapAtRun);
    return storedVideoCount !== undefined && storedVideoCount * 10 < reached * 9;
  }
  if (state.videosCompleteReason === "date") {
    const before = state.videosPublishedAfterAtRun ?? null;
    return before !== null && (depth.publishedAfter === null || depth.publishedAfter < before);
  }
  return false;
}

export function pagesForCap(maxVideos: number): number {
  return Math.ceil(maxVideos / PLAYLIST_PAGE_SIZE);
}

/**
 * Pool units of a first (or backfilling) collection at depth `maxVideos`: 1 `channels.list` plus, per page, one `playlistItems.list`
 * and one `videos.list`. Statistics come from `videos.batchGetStats` (own bucket, no pool units), but it returns no duration or live
 * status, so a page whose videos have no recent details reads them with `videos.list` (FO-REQ-0015 item 4) -- on a first collection,
 * every page; the same unit is the fallback when the batch call fails, so the worst case is unchanged. Steady state (everything
 * stored, details read within VIDEO_DETAILS_REFRESH_DAYS): 1 + 1 page [+1 when page 1 had new videos so page 2 is read] [+1 per page
 * with new or stale videos] -- about 2, at most 5 (`STEADY_STATE_WORST_CASE_UNITS`).
 */
/** channels.list 1 + page 1 + page 2 + one videos.list fallback per page. */
export const STEADY_STATE_WORST_CASE_UNITS = 5;

export function estimateCollectionUnits(maxVideos: number): { firstCollection: number; firstCollectionWorstCase: number; steadyState: string } {
  const pages = pagesForCap(maxVideos);
  return { firstCollection: 1 + 2 * pages, firstCollectionWorstCase: 1 + 2 * pages, steadyState: `2-${STEADY_STATE_WORST_CASE_UNITS}` };
}

/** One channel's effective depth and progress, as returned by `getWatchlistEntryContext` (`collectionProgressSchema`). */
export type CollectionProgress = {
  maxVideosPerChannel: number;
  maxVideosPerChannelOverride: number | null;
  publishedAfter: string | null;
  publishedAfterOverride: string | null;
  videosStored: number;
  complete: boolean;
  completeReason: CollectionCompleteReason | null;
  estimatedFirstCollectionUnits: number;
  estimatedFirstCollectionWorstCaseUnits: number;
};
