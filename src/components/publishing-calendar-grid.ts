// BL-182 stage 1 (FO-REQ-0023 §4 C1): the calendar's month grid, in the viewer's local time zone -- pure, so it is tested on its own.
// Weeks start on Monday (the owner's locale); a day's key is its local YYYY-MM-DD.

import { formatZonedDateAndTime } from "@/lib/zoned-time";

// BL-182 stage 2: "package" -- a ready release package on its planned day, not uploaded yet (FO-REQ-0023 §4 C1); it fills no gap.
// BL-235 review: "published_pending" -- its date passed less than 24 h ago, the copy not synced yet (it counts as the day's release).
// `day`: a fixed calendar day (a package's planned date) instead of the day of `at`.
export type GridEntry = {
  videoId: string;
  title: string;
  kind: "published" | "scheduled" | "published_pending" | "overdue" | "unscheduled" | "package";
  at: string | null;
  day?: string;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The local calendar day of an instant, as YYYY-MM-DD. */
export function localDayKey(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

/** The weeks shown for a month (`month` 0-11): Monday first, days of the neighbouring months included to fill the weeks. */
export function monthWeeks(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(year, month, 1 - offset);
  const last = new Date(year, month + 1, 0);
  const weeks: Date[][] = [];
  for (let cursor = new Date(start); cursor <= last || weeks.length === 0 || weeks[weeks.length - 1].length < 7; ) {
    if (weeks.length === 0 || weeks[weeks.length - 1].length === 7) {
      if (cursor > last) break;
      weeks.push([]);
    }
    weeks[weeks.length - 1].push(new Date(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return weeks;
}

/** The day of an instant: in `timeZone` (BL-235: the channel's, as the coverage counts days) or, without one, the viewer's own. */
export function dayKeyIn(value: Date, timeZone: string | null): string {
  return timeZone ? formatZonedDateAndTime(value, timeZone).localDate : localDayKey(value);
}

/** Dated entries by their day (local, or in `timeZone`), each day in time order. Undated entries are not on the grid. */
export function entriesByDay(entries: readonly GridEntry[], timeZone: string | null = null): Map<string, GridEntry[]> {
  const byDay = new Map<string, GridEntry[]>();
  for (const entry of entries) {
    if (!entry.at) continue;
    const at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) continue;
    const key = entry.day ?? dayKeyIn(at, timeZone);
    byDay.set(key, [...(byDay.get(key) ?? []), entry]);
  }
  // By instant, not by string: `...:00Z` and `...:00.000Z` are the same time (review).
  for (const list of byDay.values()) list.sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
  return byDay;
}

/**
 * The gaps the owner looks for (FO-REQ-0023 §4 C1): the days from today through the next `days - 1` with no published or scheduled
 * video. An overdue entry does not fill a day: its date has passed without a confirmed publication.
 */
export function gapDays(now: Date, byDay: Map<string, GridEntry[]>, days: number = 14): Set<string> {
  const gaps = new Set<string>();
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const key = localDayKey(day);
    const filled = (byDay.get(key) ?? []).some((entry) => entry.kind === "published" || entry.kind === "scheduled" || entry.kind === "published_pending");
    if (!filled) gaps.add(key);
  }
  return gaps;
}

/** BL-235: the shared coverage's days as the grid reads them -- the gaps, and the days whose videos lack translations. */
export type CoverageDayLike = { date: string; status: "covered" | "missing_translations" | "gap"; missingLanguages: string[] };

export function coverageMarks(days: readonly CoverageDayLike[]): { gaps: Set<string>; missing: Map<string, string[]> } {
  const gaps = new Set<string>();
  const missing = new Map<string, string[]>();
  for (const day of days) {
    if (day.status === "gap") gaps.add(day.date);
    else if (day.status === "missing_translations") missing.set(day.date, day.missingLanguages);
  }
  return { gaps, missing };
}

/** BL-235 review item 6: the month (0-11) and year of a YYYY-MM-DD day -- the channel's today opens its own month. */
export function monthOfDay(day: string): { year: number; month: number } {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) - 1 };
}
