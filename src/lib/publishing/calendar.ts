// ---------------------------------------------------------------------------
// BL-182 stage 1 (PUBLISHING_PLAN.md §2 stage 1; FO-REQ-0023 §4 C, D). The publishing calendar and the "nothing scheduled within
// N days" reminder, built only from the locally synced videos -- no YouTube call. YouTube has no "scheduled" status: a scheduled
// video is a non-public video with a future `status.publishAt` (videos resource reference); once YouTube publishes it, it is public
// and `publishAt` is gone. A live broadcast (`liveBroadcastContent` live / upcoming) is not a release and is left out.
// ---------------------------------------------------------------------------

export const PUBLISHING_REMINDER_DAYS = 7;
const DAY_MS = 86_400_000;

export type CalendarSourceVideo = {
  videoId: string;
  title: string;
  privacyStatus: string;
  /** For a public video, when it went public; for a private one, when it was uploaded (snippet.publishedAt). */
  publishedAt: string;
  publishAt: string | null;
  liveBroadcastContent?: string | null;
};

/**
 * - `published`: public (or unlisted), at its publish time.
 * - `scheduled`: not public, with a `publishAt` still ahead.
 * - `overdue`: not public, with a `publishAt` already passed -- the stored copy is older than the publication (a sync shows it
 *   published) or YouTube did not publish it; either way it is not "covered" any more.
 * - `unscheduled`: private without a date (uploaded, waiting).
 */
export type CalendarEntryKind = "published" | "scheduled" | "overdue" | "unscheduled";

export type CalendarEntry = { videoId: string; title: string; kind: CalendarEntryKind; privacyStatus: string; at: string | null };

export type PublishingCoverage = {
  /** The latest future `publishAt`; null when nothing is scheduled. */
  coveredThrough: string | null;
  scheduledCount: number;
  unscheduledCount: number;
  /** Whole days from now to `coveredThrough` (rounded down); 0 when nothing is scheduled. */
  daysCovered: number;
  /** The reminder: coverage ends within `thresholdDays`. */
  due: boolean;
  thresholdDays: number;
};

function isLive(video: CalendarSourceVideo): boolean {
  return video.liveBroadcastContent === "live" || video.liveBroadcastContent === "upcoming";
}

export function classifyCalendarVideo(video: CalendarSourceVideo, now: Date): CalendarEntry | null {
  if (isLive(video)) return null;
  const base = { videoId: video.videoId, title: video.title, privacyStatus: video.privacyStatus };
  if (video.privacyStatus === "public" || video.privacyStatus === "unlisted") return { ...base, kind: "published", at: video.publishedAt };
  if (video.publishAt) {
    const at = Date.parse(video.publishAt);
    if (!Number.isNaN(at)) return { ...base, kind: at > now.getTime() ? "scheduled" : "overdue", at: video.publishAt };
  }
  return { ...base, kind: "unscheduled", at: null };
}

export function buildPublishingCalendar(
  videos: readonly CalendarSourceVideo[],
  now: Date,
  thresholdDays: number = PUBLISHING_REMINDER_DAYS
): { entries: CalendarEntry[]; coverage: PublishingCoverage } {
  const entries = videos.map((video) => classifyCalendarVideo(video, now)).filter((entry): entry is CalendarEntry => entry !== null);
  const scheduled = entries.filter((entry) => entry.kind === "scheduled");
  const coveredThrough = scheduled.reduce<string | null>((latest, entry) => {
    if (!entry.at) return latest;
    return latest === null || Date.parse(entry.at) > Date.parse(latest) ? entry.at : latest;
  }, null);
  const coveredMs = coveredThrough ? Date.parse(coveredThrough) - now.getTime() : 0;
  return {
    entries: entries.sort((a, b) => (a.at === null ? 1 : b.at === null ? -1 : a.at.localeCompare(b.at))),
    coverage: {
      coveredThrough,
      scheduledCount: scheduled.length,
      unscheduledCount: entries.filter((entry) => entry.kind === "unscheduled").length,
      daysCovered: coveredThrough ? Math.floor(coveredMs / DAY_MS) : 0,
      due: coveredThrough === null || coveredMs < thresholdDays * DAY_MS,
      thresholdDays,
    },
  };
}
