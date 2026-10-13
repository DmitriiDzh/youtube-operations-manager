// Civil time in an IANA zone: "HH:MM" times of day, zone names, and the instant of a local date and time. Pure, no I/O.
// Moved out of `analytics/staleness.ts` (Phase 8, BL-059; BL-181) in BL-183 (owner msgs 2725/2727: times set in UTC with the
// owner's own time in parentheses), because Settings and publishing need the same rules -- one owner for them (AGENTS.md §M). `Intl` applies each zone's real DST rules.

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidLocalTimeOfDay(localTime: string): boolean {
  return LOCAL_TIME_PATTERN.test(localTime);
}

/**
 * `Intl.DateTimeFormat` throws `RangeError` on an unrecognized `timeZone`. The value is user input (a field the owner can edit)
 * -- validate it at the write boundary rather than letting a bad value throw later, on every read that formats a time with it.
 */
export function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The local calendar date and "HH:MM" of an instant in `timezone` (also used by `weekly-report.ts`'s boundary comparison). */
export function formatZonedDateAndTime(date: Date, timezone: string): { localDate: string; localTime: string } {
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

function utcMillisFromLocalParts(localDate: string, localTime: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
}

/**
 * The absolute instant of a civil (zone, Y-M-D, H:M). Converting it needs the zone's actual offset for that specific date,
 * which a DST transition can change from one day to the next. Solved with the standard fixed-point correction: guess an
 * instant, read back what wall-clock time that guess actually represents in `timezone`, and shift the guess by the observed
 * difference -- converges in one step whenever the offset is constant across the correction, and in two when the correction
 * itself crosses a DST boundary (see `analytics/staleness.test.ts`'s spring-forward/fall-back tests).
 */
export function zonedInstant(args: { localDate: string; localTime: string; timezone: string }): Date {
  const targetMillis = utcMillisFromLocalParts(args.localDate, args.localTime);

  let guessMillis = targetMillis;
  for (let attempt = 0; attempt < 3; attempt++) {
    const observed = formatZonedDateAndTime(new Date(guessMillis), args.timezone);
    const observedMillis = utcMillisFromLocalParts(observed.localDate, observed.localTime);
    const diff = targetMillis - observedMillis;
    if (diff === 0) break;
    guessMillis += diff;
  }

  return new Date(guessMillis);
}

/**
 * A daily time set in UTC, as the clock in `timezone` shows it on the day of `on` (owner, Telegram msgs 2725/2727: times are set
 * in UTC, and the owner's own time is shown next to them "с учетом того какое сейчас время (зимнее или летнее)"). `dayOffset`
 * is -1, 0 or +1 when that local time falls on the day before, the same day or the day after the UTC date of `on`.
 */
export function localTimeOfUtc(args: { utcTime: string; on: Date; timezone: string }): { localTime: string; dayOffset: number } {
  const utcDate = args.on.toISOString().slice(0, 10);
  const instant = new Date(`${utcDate}T${args.utcTime}:00Z`);
  const local = formatZonedDateAndTime(instant, args.timezone);
  const dayOffset = Math.round((Date.parse(`${local.localDate}T00:00:00Z`) - Date.parse(`${utcDate}T00:00:00Z`)) / 86_400_000);
  return { localTime: local.localTime, dayOffset };
}
