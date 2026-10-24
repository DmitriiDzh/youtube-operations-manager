import { resolvePublishDate } from "@/lib/shared-formatting";
import type { SyncedVideo } from "./content-manager";

export type SortKey = "title" | "privacy" | "publish" | "views" | "comments" | "duration" | ExtraSortKey;
/** BL-221: the columns whose values come from outside the synced video (Vn, last 7 days, languages, cost). */
export type ExtraSortKey = "vn" | "views7d" | "ctr" | "languages" | "cost";
export type SortDirection = "asc" | "desc";
export type SortState = { key: SortKey; direction: SortDirection };

// Owner instruction, 2026-10-01: the Content table defaults to the Publish date, newest first.
export const DEFAULT_SORT: SortState = { key: "publish", direction: "desc" };

// First click on a column picks the direction that is most natural for it: text ascending (A-Z),
// numbers and dates descending (largest / newest first). A second click on the active column flips it.
const DEFAULT_DIRECTION: Record<SortKey, SortDirection> = {
  title: "asc",
  privacy: "asc",
  publish: "desc",
  views: "desc",
  comments: "desc",
  duration: "desc",
  vn: "desc",
  views7d: "desc",
  ctr: "desc",
  languages: "desc",
  cost: "desc",
};

export function nextSortState(current: SortState, key: SortKey): SortState {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: DEFAULT_DIRECTION[key] };
}

// Mirrors the "Publish" column's own logic (formatPublishColumn): the real publish date for a
// public video, YouTube's scheduled `publishAt` otherwise, nothing when neither exists.
function publishTimestamp(video: SyncedVideo): number | null {
  const iso = resolvePublishDate(video);
  return iso ? new Date(iso).getTime() : null;
}

function sortValue(video: SyncedVideo, key: SortKey, extra?: (video: SyncedVideo, key: ExtraSortKey) => number | null): string | number | null {
  switch (key) {
    case "title":
      return video.title;
    case "privacy":
      return video.privacyStatus;
    case "publish":
      return publishTimestamp(video);
    case "views":
      return video.viewCount;
    case "comments":
      return video.commentCount;
    case "duration":
      return video.durationSeconds ?? null;
    default:
      return extra ? extra(video, key) : null;
  }
}

/** Returns a new array; the input is never mutated. Missing values always sort last, in either direction. `extra` gives the
 * BL-221 columns that are not fields of the synced video (absent: those sort as missing). */
export function sortVideos(
  videos: SyncedVideo[],
  sort: SortState,
  extra?: (video: SyncedVideo, key: ExtraSortKey) => number | null,
): SyncedVideo[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return videos
    .map((video, index) => ({ video, index, value: sortValue(video, sort.key, extra) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      const cmp =
        typeof a.value === "string" && typeof b.value === "string"
          ? a.value.localeCompare(b.value, undefined, { sensitivity: "base", numeric: true })
          : (a.value as number) - (b.value as number);
      // Stable tiebreak on the original order keeps equal rows from jumping around.
      return cmp !== 0 ? cmp * sign : a.index - b.index;
    })
    .map((entry) => entry.video);
}
