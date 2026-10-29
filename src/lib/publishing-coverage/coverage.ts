import { missingTrackedLanguages, type LocaleText } from "@/lib/shared-language-baseline";
import { formatZonedDateAndTime } from "@/lib/zoned-time";
import { classifyCalendarVideo, currentRows, type CalendarSourceVideo } from "./rules";

// BL-235 (owner, Telegram msg 3806, 2026-10-29): the one answer to "is this publishing day covered", computed from the channel's
// synced copy of its videos -- no snapshot, no YouTube call. A day (a calendar date in the channel's time zone) is:
// - `covered`: at least one release viewers can see is on that day -- a video published that day (public, at its publish time),
//   scheduled for it (private with a future publishAt) or published-pending (its publishAt passed less than 24 h ago while the copy
//   still shows it private: YouTube published it, the next sync will show it) -- AND it has every required translation;
// - `missing_translations`: such a video is there, but none of them has every required translation;
// - `gap`: none. Never a release (review item 4, "a video scheduled to go out / uploaded" = what viewers see): an unlisted video,
//   the recording of a live broadcast the app ran (`liveBroadcastIds`), an overdue video (publishAt passed 24 h ago or more, still
//   private in the copy), a private upload without a date, a live or upcoming broadcast.
// "Every required translation" = the channel's tracked languages (Languages tab) minus the video's own language, read against the
// channel's language, each with a non-empty title and, where the original has a description, a non-empty description -- the
// Languages tab's own rule (`missingTrackedLanguages`, `@/lib/shared-language-baseline`). No tracked languages = nothing required.
// Pure: the caller brings the videos, the languages, the zone and the clock.

/**
 * A synced video with what the translation check needs. The language fields are optional only so the calendar can hand over the
 * rows it already read; a row without them reads as having no translation (never as complete).
 */
export type CoverageSourceVideo = CalendarSourceVideo & {
  description?: string;
  defaultLanguage?: string | null;
  localizations?: Record<string, LocaleText>;
};

export type CoverageDayStatus = "covered" | "missing_translations" | "gap";

export type CoverageDayVideo = {
  videoId: string;
  title: string;
  /**
   * `published_pending`: its publishAt passed less than 24 h ago, the copy still shows it private -- it counts. `overdue`,
   * `unlisted` and `live_recording` are listed for information only: they never cover a day.
   */
  kind: "published" | "scheduled" | "published_pending" | "overdue" | "unlisted" | "live_recording";
  at: string;
  /** The required languages this video lacks ([] for a video that is not counted). */
  missingLanguages: string[];
};

export type CoverageDay = {
  /** YYYY-MM-DD in the channel's time zone. */
  date: string;
  status: CoverageDayStatus;
  /** The day's releases (published, scheduled, published-pending), in time order -- the ones that can cover it. */
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

/** The kinds that are a release viewers see (or will see that day). */
const COUNTED: ReadonlySet<CoverageDayVideo["kind"]> = new Set(["published", "scheduled", "published_pending"]);

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
  /** Video ids of the live broadcasts the app ran on the channel: their recordings are not releases. */
  liveBroadcastIds?: ReadonlySet<string>;
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
    const kind: CoverageDayVideo["kind"] =
      input.liveBroadcastIds?.has(video.videoId) ? "live_recording" : video.privacyStatus === "unlisted" ? "unlisted" : entry.kind;
    const missingLanguages = !COUNTED.has(kind)
      ? []
      : missingTrackedLanguages(
          { defaultLanguage: video.defaultLanguage ?? null, title: video.title, description: video.description ?? "", localizations: video.localizations ?? {} },
          input.trackedLanguages,
          input.channelLanguage
        );
    byDate.set(date, [...(byDate.get(date) ?? []), { videoId: video.videoId, title: video.title, kind, at: at.toISOString(), missingLanguages }]);
  }

  const days: CoverageDay[] = dates.map((date) => {
    const videos = (byDate.get(date) ?? []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.videoId.localeCompare(b.videoId));
    const counted = videos.filter((video) => COUNTED.has(video.kind));
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
