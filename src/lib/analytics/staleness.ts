// Phase 8 (BL-059, docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-5). Pure, no I/O -- the
// owner's own rule, verbatim: "повторный запрос информации чаще раза в день имеет смысл только
// если прошлый был до 12:00 сегодняшнего дня" (a repeat collection only makes sense if the
// previous one was before today's local boundary time). This is a **wall-clock boundary** rule,
// not an elapsed-duration one: a run at 11:59 local today is still stale (it happened before
// today's boundary), while a run at 12:06 local today is fresh, even though both are "today."
//
// Deliberately does NOT construct absolute instants via offset arithmetic (`Date.UTC` +
// `formatToParts` + diff-correction) -- that's unnecessary for a pure comparison. Instead it
// formats both instants into the target timezone's own local calendar date + time strings (via
// one `Intl.DateTimeFormat` each) and compares those strings. `Intl` already applies the zone's
// real DST rules to each instant independently, so this is correct across a DST transition
// without any manual seasonal-offset code (see staleness.test.ts's dedicated DST test) -- exactly
// the owner's own "зимнее/летнее время" concern (docs/roadmap/plans/PHASE_8_PLAN.md §10 item 4).

import { formatZonedDateAndTime, zonedInstant } from "@/lib/zoned-time";

// BL-182 stage 2: the zone helpers moved to `@/lib/zoned-time` (publishing needs them too); re-exported so callers keep their import.
export { formatZonedDateAndTime, isValidIanaTimezone, isValidLocalTimeOfDay, zonedInstant } from "@/lib/zoned-time";

/** BL-181: what the evening switch turns back on with when no evening time was ever saved -- 22:05 in Helsinki summer time, in UTC
 * since 2026-10-13 (owner, msgs 2725/2727). Pure, so the Settings card and the store share it. */
export const DEFAULT_ANALYTICS_EVENING_UTC_TIME = "19:05";

export function isAnalyticsCollectionStale(args: {
  now: Date;
  lastAutoCollectedAt: Date | null;
  timezone: string;
  /** The daily boundary, "HH:MM" 24-hour, local to `timezone`. */
  localTime: string;
}): boolean {
  if (args.lastAutoCollectedAt === null) return true;

  const nowZoned = formatZonedDateAndTime(args.now, args.timezone);
  const lastZoned = formatZonedDateAndTime(args.lastAutoCollectedAt, args.timezone);

  if (lastZoned.localDate < nowZoned.localDate) return true; // last run was on an earlier local day
  if (lastZoned.localDate > nowZoned.localDate) return false; // clock-skew guard -- never treat as stale
  return lastZoned.localTime < args.localTime; // same local day -- stale only if before today's boundary
}

/**
 * The absolute instant of the next daily refresh boundary (owner instruction, 2026-09-22 --
 * "Надо возращать сообщение... новая будет доступна через столько-то времени"), for display
 * when `isAnalyticsCollectionStale` says "not stale" (i.e. today's boundary has already passed
 * with a real collection). Always the day AFTER `now`'s own local calendar date, at `localTime`,
 * in `timezone` -- never "the next occurrence of `localTime`, whichever day that lands on,"
 * since this is only ever called once today's own boundary has already been used.
 *
 * Converting a civil (zone, Y-M-D, H:M) into an absolute UTC instant needs the zone's actual
 * offset for that specific date, which a DST transition can change from one day to the next --
 * unlike `isAnalyticsCollectionStale` above (a pure string comparison with no such need), this
 * genuinely cannot avoid resolving a real offset. Solved with the standard fixed-point
 * correction: guess an instant, read back what wall-clock time that guess actually represents in
 * `timezone`, and shift the guess by the observed difference -- converges in one step whenever
 * the offset is constant across the correction, and in two when the correction itself crosses a
 * DST boundary (see `staleness.test.ts`'s dedicated spring-forward/fall-back tests).
 */
export function computeNextRefreshAt(args: { now: Date; timezone: string; localTime: string }): Date {
  const { localDate } = formatZonedDateAndTime(args.now, args.timezone);
  const [year, month, day] = localDate.split("-").map(Number);
  return zonedInstant({ localDate: new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10), localTime: args.localTime, timezone: args.timezone });
}

/** BL-181: the instant a YouTube reporting day ends -- midnight Pacific Time after `date` (07:00Z in summer, 08:00Z in winter). */
export function pacificDayEnd(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return zonedInstant({ localDate: new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10), localTime: "00:00", timezone: "America/Los_Angeles" });
}

/**
 * The date range an unattended auto-collection run picks (`AUTO_COLLECTION_RANGE_DAYS`,
 * contracts.ts) -- `endDate` is *yesterday's* local calendar date in `timezone` (the Analytics
 * API never returns the most recent day(s) yet), `startDate` is `rangeDays` before that. Pure
 * calendar-day arithmetic on the zone's own Y-M-D components (via `formatZonedDateAndTime`) --
 * never a zone-to-UTC time-of-day conversion, so this has no DST edge case to reason about (a
 * calendar day is a calendar day in every zone, unlike a specific clock time).
 */
export function computeDefaultAutoCollectionRange(args: {
  now: Date;
  timezone: string;
  rangeDays: number;
}): { startDate: string; endDate: string } {
  const { localDate } = formatZonedDateAndTime(args.now, args.timezone);
  const [year, month, day] = localDate.split("-").map(Number);

  const formatUtcDate = (utcMillis: number) => new Date(utcMillis).toISOString().slice(0, 10);
  const endDate = formatUtcDate(Date.UTC(year, month - 1, day - 1));
  const startDate = formatUtcDate(Date.UTC(year, month - 1, day - 1 - args.rangeDays));

  return { startDate, endDate };
}
