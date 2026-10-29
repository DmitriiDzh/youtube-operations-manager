import { missingTrackedLanguages, type LocaleText } from "@/lib/shared-language-baseline";
import { formatZonedDateAndTime } from "@/lib/zoned-time";
import { classifyCalendarVideo, currentRows, type CalendarSourceVideo } from "./rules";

// BL-235 (owner, Telegram msg 3806, 2026-10-29): the one answer to "is this publishing day covered", computed from the channel's
// synced copy of its videos -- no snapshot, no YouTube call. A day (a calendar date in the channel's time zone) is:
// - `covered`: at least one video is published that day (public or unlisted, at its publish time) or scheduled for it (private
//   with a future publishAt), AND that video has every required translation;
// - `missing_translations`: such a video is there, but none of them has every required translation;
// - `gap`: no published or scheduled video that day. An overdue video (its publishAt passed while the copy still shows it not
//   public) does not cover, nor does a private upload without a date, nor a live broadcast -- the calendar's rule (`./rules.ts`).
// "Every required translation" = the channel's tracked languages (Languages tab) minus the video's own language, read against the
// channel's language, each with a non-empty title and, where the original has a description, a non-empty description -- the
// Languages tab's own rule (`missingTrackedLanguages`, `@/lib/shared-language-baseline`). No tracked languages = nothing required.
// Pure: the caller brings the videos, the languages, the zone and the clock.

export type CoverageSourceVideo = CalendarSourceVideo & {
  description: string;
  defaultLanguage: string | null;
  localizations: Record<string, LocaleText>;
};

export type CoverageDayStatus = "covered" | "missing_translations" | "gap";

export type CoverageDayVideo = {
  videoId: string;
  title: string;
  /** `overdue` videos are listed for information only: they never cover a day. */
  kind: "published" | "scheduled" | "overdue";
  at: string;
  /** The required languages this video lacks ([] for an overdue video: it is not counted). */
  missingLanguages: string[];
};

export type CoverageDay = {
  /** YYYY-MM-DD in the channel's time zone. */
  date: string;
  status: CoverageDayStatus;
  /** The published and scheduled videos of the day, in time order (the ones that can cover it). */
  videoIds: string[];
  /**
   * What still keeps the day open: [] when covered or a gap; for `missing_translations` the missing languages of the day's video
   * closest to covered (the fewest missing; the earlier one on a tie). Each video's own list is in `videos`.
   */
  missingLanguages: string[];
  videos: CoverageDayVideo[];
};

export type CoverageSummary = {
  covered: number;
  missingTranslations: number;
  gaps: number;
  /** Covered days one after another from the first day of the range (0 when the first day is not covered). */
  coveredDaysInARow: number;
};

export type CoverageReport = {
  /** The first and last day of the range (YYYY-MM-DD, channel time zone). */
  from: string;
  to: string;
  days: CoverageDay[];
  summary: CoverageSummary;
};

export const COVERAGE_MAX_DAYS = 30;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `date` + `offset` calendar days (UTC arithmetic on the date itself: no instant, so no DST shift). */
export function addCalendarDays(date: string, offset: number): string {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offset)).toISOString().slice(0, 10);
}

/** Today's date in `timeZone`. */
export function todayIn(timeZone: string, now: Date): string {
  return formatZonedDateAndTime(now, timeZone).localDate;
}

export function computePublishingCoverage(input: {
  videos: readonly CoverageSourceVideo[];
  /** The channel's last sync (ms); rows the latest sync did not return are left out (`currentRows`). Null: never synced. */
  channelSyncedAtMs: number | null;
  trackedLanguages: readonly string[];
  /** The channel's language (Languages → Language defaults); null when not set. */
  channelLanguage: string | null;
  timeZone: string;
  /** The first day, YYYY-MM-DD in `timeZone`. */
  fromDate: string;
  days: number;
  now: Date;
}): CoverageReport {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > COVERAGE_MAX_DAYS) throw new Error(`days must be 1..${COVERAGE_MAX_DAYS}`);
  const dates = Array.from({ length: input.days }, (_, offset) => addCalendarDays(input.fromDate, offset));
  const wanted = new Set(dates);
  const byDate = new Map<string, CoverageDayVideo[]>();
  for (const video of currentRows(input.videos, input.channelSyncedAtMs)) {
    const entry = classifyCalendarVideo(video, input.now);
    if (!entry || entry.kind === "unscheduled" || entry.at === null) continue;
    const at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) continue;
    const date = formatZonedDateAndTime(at, input.timeZone).localDate;
    if (!wanted.has(date)) continue;
    const missingLanguages =
      entry.kind === "overdue"
        ? []
        : missingTrackedLanguages(
            { defaultLanguage: video.defaultLanguage, title: video.title, description: video.description, localizations: video.localizations },
            input.trackedLanguages,
            input.channelLanguage
          );
    byDate.set(date, [...(byDate.get(date) ?? []), { videoId: video.videoId, title: video.title, kind: entry.kind, at: at.toISOString(), missingLanguages }]);
  }

  const days: CoverageDay[] = dates.map((date) => {
    const videos = (byDate.get(date) ?? []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.videoId.localeCompare(b.videoId));
    const counted = videos.filter((video) => video.kind !== "overdue");
    if (counted.length === 0) return { date, status: "gap", videoIds: [], missingLanguages: [], videos };
    const best = counted.reduce((a, b) => (b.missingLanguages.length < a.missingLanguages.length ? b : a));
    return {
      date,
      status: best.missingLanguages.length === 0 ? "covered" : "missing_translations",
      videoIds: counted.map((video) => video.videoId),
      missingLanguages: best.missingLanguages,
      videos,
    };
  });

  const firstOpen = days.findIndex((day) => day.status !== "covered");
  return {
    from: dates[0],
    to: dates[dates.length - 1],
    days,
    summary: {
      covered: days.filter((day) => day.status === "covered").length,
      missingTranslations: days.filter((day) => day.status === "missing_translations").length,
      gaps: days.filter((day) => day.status === "gap").length,
      coveredDaysInARow: firstOpen === -1 ? days.length : firstOpen,
    },
  };
}
