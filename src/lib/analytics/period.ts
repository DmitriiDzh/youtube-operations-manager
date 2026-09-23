/**
 * Pure calendar-day arithmetic for the Analytics "Overview" tab's period-over-period comparison
 * (docs/roadmap/plans/STUDIO_PARITY_PLAN.md §4, Studio's own "+N% vs previous period" cards).
 * Deliberately its own file, not inlined in `services.ts`: this has zero I/O and is directly
 * unit-testable (`docs/DEVELOPMENT_PLAYBOOK.md` §6.2's "pure functions in their own file" rule),
 * mirroring `diff.ts`/`staleness.ts` elsewhere in this codebase.
 *
 * Dates are always `YYYY-MM-DD` calendar days, parsed as UTC midnight purely so day-arithmetic
 * never shifts across a DST boundary -- there is no timezone concept here at all (unlike
 * `staleness.ts`, which genuinely needs the operator's local timezone). A `day`-dimension
 * Analytics API row's own date is already a fixed calendar day with no time-of-day component
 * (docs/roadmap/plans/PHASE_8_PLAN.md §10 item 4), so this never needs to reason about "when" a
 * day boundary falls locally.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseIsoDateUtc(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  // `Date.parse` does not reject a calendar-invalid day-of-month -- it silently rolls over
  // instead (e.g. "2026-02-30" parses as 2026-03-02, "2026-04-31" as 2026-05-01). Re-formatting
  // the parsed instant and comparing it back to the original string catches this: a rolled-over
  // date can never format back to the exact string that was parsed. Found by independent review,
  // 2026-09-23, after fixing the separate inverted-range case -- this is a distinct gap: an
  // inverted range throws (already handled), but a calendar-invalid single date never did,
  // letting `getChannelOverview` silently query the wrong days for a caller who can't tell.
  if (Number.isNaN(parsed) || formatIsoDateUtc(parsed) !== date) {
    throw new Error(`period: invalid ISO date "${date}"`);
  }
  return parsed;
}

function formatIsoDateUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Throws unless `date` is a real, existing calendar date (not merely digit-shaped) -- reuses
 * `parseIsoDateUtc`'s own round-trip check. Exported so callers with an optional single date
 * (e.g. `listMetrics`'s filters, which don't necessarily come as a startDate/endDate pair) can
 * validate it without needing a full range.
 */
export function assertValidIsoDate(date: string): void {
  parseIsoDateUtc(date);
}

function assertValidRange(startDate: string, endDate: string): { startMs: number; endMs: number } {
  const startMs = parseIsoDateUtc(startDate);
  const endMs = parseIsoDateUtc(endDate);
  if (endMs < startMs) {
    throw new Error(`period: endDate (${endDate}) is before startDate (${startDate})`);
  }
  return { startMs, endMs };
}

/**
 * Throws unless `startDate`/`endDate` are both real calendar dates with `startDate <= endDate`.
 * Found by independent review (2026-09-23) that `listMetrics`'s own optional `startDate`/`endDate`
 * filters had no equivalent check -- an inverted or calendar-invalid range silently filtered every
 * row out (an empty, misleadingly "successful" result) rather than the `validation_failed` error
 * `getChannelOverview` already gives for the identical bug class via `computePreviousPeriod` below.
 */
export function assertValidDateRange(startDate: string, endDate: string): void {
  assertValidRange(startDate, endDate);
}

/**
 * The immediately-preceding period of the same length, with no gap and no overlap:
 * `[startDate, endDate]` is `N` days long, so the previous period is the `N` days ending the day
 * before `startDate`. Matches Studio's own "vs previous 28 days" semantics (verified live,
 * 2026-09-23: Studio's "Last 28 days" range showed "Aug 26 - Sep 22" with deltas captioned
 * "more than previous 28 days").
 */
export function computePreviousPeriod(startDate: string, endDate: string): {
  previousStartDate: string;
  previousEndDate: string;
} {
  const { startMs, endMs } = assertValidRange(startDate, endDate);

  const dayCount = Math.round((endMs - startMs) / MS_PER_DAY) + 1;
  const previousEndMs = startMs - MS_PER_DAY;
  const previousStartMs = previousEndMs - (dayCount - 1) * MS_PER_DAY;

  return {
    previousStartDate: formatIsoDateUtc(previousStartMs),
    previousEndDate: formatIsoDateUtc(previousEndMs),
  };
}

/**
 * Percentage change from `previous` to `current`, matching Studio's own display convention:
 * `null` when `previous` is `0` (a "N% more than previous period" claim is meaningless with no
 * baseline -- never fabricated as `Infinity` or `0`), otherwise rounded to the nearest whole
 * percent like Studio's own cards (e.g. "931% more than previous 28 days").
 *
 * Divides by `Math.abs(previous)`, not `previous` itself -- `previous` can be genuinely negative
 * (e.g. net subscribers, gained minus lost, over a period with more churn than growth). Dividing
 * by a negative `previous` flips the sign of the whole result: `current=5, previous=-2` would
 * otherwise compute -350% ("350% less"), describing a real improvement as a decline. Using the
 * magnitude keeps the sign tied to the actual direction of change (current > previous is always
 * an increase), which is the only definition consistent with "more/less than previous period."
 */
export function computePercentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

/**
 * Fills gaps in a `day`-dimension Analytics API response so a chart built from it spaces points
 * by actual calendar date, not by array index. Without this, a channel whose real data only
 * starts partway through the requested range (e.g. before the channel existed) renders with every
 * returned point packed evenly across the full axis, and any day genuinely missing from the
 * middle of the response (the API can omit a day outright rather than return it as zero) gets
 * silently skipped rather than shown as a real gap.
 *
 * Fills from `startDate` through the LAST date actually present in `rows`, inclusive -- never
 * past it. The Analytics API's own documented behavior is that it does not yet report the most
 * recent day(s) of any range (the reporting lag `docs/roadmap/plans/PHASE_8_PLAN.md` §10 item 4
 * describes) -- extending the fill through the requested `endDate` would insert fabricated zero
 * days for dates the API simply hasn't processed yet, which would render as a real drop to zero
 * rather than "not yet reported." A date the API did report as part of the response, with all
 * requested metrics genuinely absent, is indistinguishable from this function's own zero-fill --
 * both correctly mean "no reported activity."
 *
 * Returns `[]` for an empty input (the "no data for this period at all" case) -- there is no
 * "last reported date" to fill up to, and the caller already renders a dedicated empty state for
 * an empty array.
 */
/**
 * The default `[startDate, endDate]` window for a UI period picker (e.g. "Last 28 days") --
 * shared by `channel-overview-panel.tsx` and `home-dashboard-panel.tsx` (found duplicated
 * near-verbatim in both by independent review, 2026-09-23; factored out per `AGENTS.md` §D).
 * Ends yesterday, never today: the Analytics API's own documented behavior is that a
 * `day`-dimension query never returns rows for the most recent day(s) yet (see
 * `docs/roadmap/plans/PHASE_8_PLAN.md` §10 item 4), so defaulting to "today" would make every
 * fresh page load look like it has less data than it actually will once it reports.
 *
 * `now` is injectable (defaults to the real wall clock) so callers -- and this function's own
 * tests -- never depend on the actual calendar date, the same pattern `staleness.ts` already uses
 * elsewhere in this module for the same reason.
 */
export function computeDefaultPeriodRange(periodDays: number, now: Date = new Date()): {
  startDate: string;
  endDate: string;
} {
  const end = new Date(now);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (periodDays - 1));
  return { startDate: formatLocalCalendarDate(start), endDate: formatLocalCalendarDate(end) };
}

/**
 * The operator's own local calendar date (NOT `toISOString()`, which is UTC and can land on the
 * wrong day depending on the operator's timezone/time of day) -- deliberately distinct from
 * `formatIsoDateUtc` above, which formats a fixed UTC instant for internal period arithmetic, not
 * "what day is it where the operator actually is right now."
 */
function formatLocalCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Watch-time hours, formatted to one decimal place -- shared display helper (same duplication
 * finding as `computeDefaultPeriodRange` above). */
export function formatWatchTimeHours(minutes: number): string {
  return (minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function zeroFillDailySeries<T extends { date: string }>(
  rows: T[],
  startDate: string,
  makeZeroRow: (date: string) => T
): T[] {
  if (rows.length === 0) return [];

  const byDate = new Map(rows.map((row) => [row.date, row]));
  const lastDate = rows.reduce((max, row) => (row.date > max ? row.date : max), rows[0].date);

  const result: T[] = [];
  for (let cursorMs = parseIsoDateUtc(startDate); ; cursorMs += MS_PER_DAY) {
    const cursor = formatIsoDateUtc(cursorMs);
    result.push(byDate.get(cursor) ?? makeZeroRow(cursor));
    if (cursor >= lastDate) break;
  }
  return result;
}
