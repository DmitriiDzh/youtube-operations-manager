// BL-117 -- what one API call costs in quota units. Source of truth: Google's official page
// https://developers.google.com/youtube/v3/determine_quota_cost (read 2026-10-03). A pure leaf like the rest of this
// module. An unknown method is `null` (shown as "unknown"), never a guessed number.

export type QuotaLedgerService = "data" | "analytics";

/** YouTube Data API v3, units per call, keyed `resource.method`. */
export const DATA_API_UNIT_COSTS: Readonly<Record<string, number>> = {
  "videos.list": 1,
  "videos.update": 50,
  "videos.rate": 50,
  "videos.delete": 50,
  "playlists.list": 1,
  "playlists.insert": 50,
  "playlists.update": 50,
  "playlists.delete": 50,
  "playlistItems.list": 1,
  "playlistItems.insert": 50,
  "playlistItems.update": 50,
  "playlistItems.delete": 50,
  "channels.list": 1,
  "channels.update": 50,
  "subscriptions.list": 1,
  "subscriptions.insert": 50,
  "subscriptions.delete": 50,
  "comments.list": 1,
  "comments.insert": 50,
  "comments.update": 50,
  "comments.delete": 50,
  "commentThreads.list": 1,
  "captions.list": 50,
  "captions.insert": 400,
  "captions.update": 450,
  "captions.delete": 50,
  "activities.list": 1,
  // Since 2026-06-01 `search.list` has its own bucket (100 calls/day, 1 unit each), not the 10,000-unit pool.
  "search.list": 1,
  "videoCategories.list": 1,
  "i18nLanguages.list": 1,
  "i18nRegions.list": 1,
};

/** YouTube Analytics API. This repo's own live evidence (2026-09-22): a 28-query collection moved usage by exactly 28. */
export const ANALYTICS_API_UNIT_COSTS: Readonly<Record<string, number>> = {
  "reports.query": 1,
};

export function quotaUnitsForCall(service: QuotaLedgerService, method: string): number | null {
  const table = service === "data" ? DATA_API_UNIT_COSTS : ANALYTICS_API_UNIT_COSTS;
  return Object.prototype.hasOwnProperty.call(table, method) ? table[method] : null;
}

/**
 * BL-145: whether a logged call counts against the 10,000-unit daily pool. `search.list` has its own bucket (100
 * calls/day) since 2026-06-01, so it never does. The one shared rule for every pool total (Settings bar, quota guard,
 * quota history), so they cannot disagree.
 */
export function countsAgainstPool(service: QuotaLedgerService, method: string): boolean {
  return !(service === "data" && method === "search.list");
}

/** Methods that change channel content (50+ units): the history says "changed", not just "called". */
export function isWriteMethod(method: string): boolean {
  return /\.(insert|update|delete|rate)$/.test(method);
}
