// Phase 8 (BL-054, docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-5). Pure, no I/O -- the
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

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidLocalTimeOfDay(localTime: string): boolean {
  return LOCAL_TIME_PATTERN.test(localTime);
}

/**
 * `Intl.DateTimeFormat` throws `RangeError` on an unrecognized `timeZone`. The value is user
 * input (a Settings-tab field the owner can edit) -- validate it here, at the write boundary,
 * rather than letting a bad value throw inside `isAnalyticsCollectionStale` on every dashboard
 * load (advisor review).
 */
export function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function formatZonedDateAndTime(date: Date, timezone: string): { localDate: string; localTime: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}`,
  };
}

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
