import type { LinkCandidate } from "./contracts";

// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage B, owner msgs 3448/3449/3451): which synced videos the owner is offered when
// linking a number uploaded outside the app. Never by title (AGENTS.md §F): by the folder's MMDD date against the video's publish
// date. The owner confirms; nothing here decides a link. No I/O.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The `MMDD` of a `…/<MMDD Vn>` folder; null for any other name or an impossible date. */
export function folderMonthDay(folder: string): { month: number; day: number } | null {
  const name = folder.slice(folder.lastIndexOf("/") + 1);
  const match = /^(\d{2})(\d{2})\s+V\d+/i.exec(name);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

/** The publish moment of a video: the scheduled `publishAt` while there is one, else `publishedAt`. */
function publishMs(candidate: LinkCandidate): number {
  return Date.parse(candidate.publishAt ?? candidate.publishedAt);
}

/**
 * The folder's date in the year that puts it closest to `now` (a folder is named for a day at most about half a year away), as
 * UTC midnight; null without a folder date.
 */
export function folderDateNear(folder: string, now: Date): number | null {
  const md = folderMonthDay(folder);
  if (!md) return null;
  const year = now.getUTCFullYear();
  const options = [year - 1, year, year + 1]
    .map((y) => Date.UTC(y, md.month - 1, md.day))
    .filter((ms) => new Date(ms).getUTCDate() === md.day);
  if (options.length === 0) return null;
  return options.reduce((best, ms) => (Math.abs(ms - now.getTime()) < Math.abs(best - now.getTime()) ? ms : best));
}

/**
 * `suggested`: unlinked regular videos (not a live or upcoming broadcast) published -- or scheduled -- on the folder's UTC day.
 * `others`: every other unlinked regular video, the closest publish date to the folder's date first (at most `limit`).
 */
export function linkSuggestions(
  folder: string,
  candidates: readonly LinkCandidate[],
  linkedVideoIds: ReadonlySet<string>,
  now: Date,
  limit = 30,
): { suggested: LinkCandidate[]; others: LinkCandidate[] } {
  const target = folderDateNear(folder, now);
  const open = candidates.filter(
    (c) => !linkedVideoIds.has(c.videoId) && c.liveBroadcastContent !== "live" && c.liveBroadcastContent !== "upcoming" && Number.isFinite(publishMs(c)),
  );
  if (target === null) return { suggested: [], others: [...open].sort((a, b) => publishMs(b) - publishMs(a)).slice(0, limit) };
  const sameDay = (c: LinkCandidate) => {
    const ms = publishMs(c);
    return ms >= target && ms < target + DAY_MS;
  };
  const distance = (c: LinkCandidate) => Math.abs(publishMs(c) - target);
  const suggested = open.filter(sameDay).sort((a, b) => distance(a) - distance(b));
  const others = open.filter((c) => !sameDay(c)).sort((a, b) => distance(a) - distance(b)).slice(0, limit);
  return { suggested, others };
}
