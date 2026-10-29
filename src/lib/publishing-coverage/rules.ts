import { isScheduledVideo } from "@/lib/shared-formatting";

// BL-182 stage 1 (PUBLISHING_PLAN.md §2 stage 1; FO-REQ-0023 §4 C, D): how one synced video reads on the publishing calendar. Moved
// here from `publishing/calendar.ts` in BL-235 (owner msg 3806: one source of truth for "a publishing day is covered"), so the
// calendar, the weekly plan and the agents' coverage share one rule (AGENTS.md §M). Pure, no I/O. YouTube has no "scheduled"
// status: a scheduled video is a non-public video with a future `status.publishAt` (videos resource reference); once YouTube
// publishes it, it is public and `publishAt` is gone. A live broadcast (`liveBroadcastContent` live / upcoming) is not a release
// and is left out.

export type CalendarSourceVideo = {
  videoId: string;
  title: string;
  privacyStatus: string;
  /** For a public video, when it went public; for a private one, when it was uploaded (snippet.publishedAt). */
  publishedAt: string;
  publishAt: string | null;
  liveBroadcastContent?: string | null;
  /** When the channel sync last returned this row (ms); see `currentRows`. */
  syncedAtMs?: number;
};

/**
 * BL-182 review S5: the channel sync never deletes a row, so a video deleted (or replaced) in Studio would stay "scheduled" and keep
 * the reminder quiet. Every row the latest sync returned carries that sync's time, so a row older than the channel's last sync is
 * one YouTube no longer lists: it is left out. A second of slack covers the two stamps being written separately.
 */
export function currentRows<T extends CalendarSourceVideo>(videos: readonly T[], channelSyncedAtMs: number | null): T[] {
  if (channelSyncedAtMs === null) return [...videos];
  return videos.filter((video) => video.syncedAtMs === undefined || video.syncedAtMs >= channelSyncedAtMs - 1000);
}

/**
 * - `published`: public (or unlisted), at its publish time.
 * - `scheduled`: not public, with a `publishAt` still ahead.
 * - `overdue`: not public, with a `publishAt` already passed -- the stored copy is older than the publication (a sync shows it
 *   published) or YouTube did not publish it; either way it is not "covered" any more.
 * - `unscheduled`: private without a date (uploaded, waiting).
 */
export type CalendarEntryKind = "published" | "scheduled" | "overdue" | "unscheduled";

export type CalendarEntry = { videoId: string; title: string; kind: CalendarEntryKind; privacyStatus: string; at: string | null };

function isLive(video: CalendarSourceVideo): boolean {
  return video.liveBroadcastContent === "live" || video.liveBroadcastContent === "upcoming";
}

export function classifyCalendarVideo(video: CalendarSourceVideo, now: Date): CalendarEntry | null {
  if (isLive(video)) return null;
  const base = { videoId: video.videoId, title: video.title, privacyStatus: video.privacyStatus };
  if (video.privacyStatus === "public" || video.privacyStatus === "unlisted") return { ...base, kind: "published", at: video.publishedAt };
  if (isScheduledVideo(video, now.getTime())) return { ...base, kind: "scheduled", at: video.publishAt };
  if (video.publishAt && !Number.isNaN(Date.parse(video.publishAt))) return { ...base, kind: "overdue", at: video.publishAt };
  return { ...base, kind: "unscheduled", at: null };
}
