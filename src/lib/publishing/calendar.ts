import { classifyCalendarVideo, type CalendarEntry, type CalendarSourceVideo } from "@/lib/publishing-coverage/rules";

// BL-235: the per-video rule (published / scheduled / overdue / unscheduled, stale rows) lives in the shared publishing-coverage
// module; re-exported here under the names the publishing module always used.
export { classifyCalendarVideo, currentRows, type CalendarEntry, type CalendarEntryKind, type CalendarSourceVideo } from "@/lib/publishing-coverage/rules";

// ---------------------------------------------------------------------------
// BL-182 stage 1 (PUBLISHING_PLAN.md §2 stage 1; FO-REQ-0023 §4 C, D). The publishing calendar and the "nothing scheduled within
// N days" reminder, built only from the locally synced videos -- no YouTube call. YouTube has no "scheduled" status: a scheduled
// video is a non-public video with a future `status.publishAt` (videos resource reference); once YouTube publishes it, it is public
// and `publishAt` is gone. A live broadcast (`liveBroadcastContent` live / upcoming) is not a release and is left out.
// ---------------------------------------------------------------------------

export const PUBLISHING_REMINDER_DAYS = 7;
const DAY_MS = 86_400_000;

export type PublishingCoverage = {
  /** The latest future `publishAt`; null when nothing is scheduled. */
  coveredThrough: string | null;
  scheduledCount: number;
  unscheduledCount: number;
  /** Whole days from now to `coveredThrough` (rounded down); 0 when nothing is scheduled. */
  daysCovered: number;
  /**
   * The reminder. With the daily coverage (BL-235, the calendar route, the alerts and the agents' calendar): fewer than
   * `thresholdDays` covered days in a row from today -- a covered day has a published or scheduled video with every required
   * translation (`@/lib/publishing-coverage`). Without it: the latest scheduled time is within `thresholdDays`.
   */
  due: boolean;
  thresholdDays: number;
  /** BL-235: covered days in a row from today in the channel's zone; absent when the daily coverage was not read. */
  coveredDaysInARow?: number;
};

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
