import assert from "node:assert/strict";
import test from "node:test";
import { computePercentChange, computePreviousPeriod, enumerateDates, formatChartDate, zeroFillDailySeries } from "./period";

test("computePreviousPeriod computes the immediately-preceding period of the same length (28 days, live-observed range)", () => {
  // Studio itself showed "Aug 26 - Sep 22, 2026" for "Last 28 days" (live-verified 2026-09-23).
  // Hand-computed independently of the implementation: Aug 26 - Sep 22 inclusive is 28 days
  // (6 remaining days of August + 22 days of September), so the previous 28-day period is
  // Jul 29 - Aug 25 (3 days of July + 25 days of August).
  assert.deepEqual(computePreviousPeriod("2026-08-26", "2026-09-22"), {
    previousStartDate: "2026-07-29",
    previousEndDate: "2026-08-25",
  });
});

test("computePreviousPeriod handles a single-day period", () => {
  assert.deepEqual(computePreviousPeriod("2026-01-01", "2026-01-01"), {
    previousStartDate: "2025-12-31",
    previousEndDate: "2025-12-31",
  });
});

test("computePreviousPeriod crosses a leap-year February boundary correctly", () => {
  // 2024 is a leap year -- the day before 2024-03-01 is 2024-02-29, not 2024-02-28.
  assert.deepEqual(computePreviousPeriod("2024-03-01", "2024-03-01"), {
    previousStartDate: "2024-02-29",
    previousEndDate: "2024-02-29",
  });
});

test("computePreviousPeriod rejects an endDate before startDate", () => {
  assert.throws(() => computePreviousPeriod("2026-09-22", "2026-08-26"));
});

// Found by independent review, 2026-09-23: `Date.parse` does not reject a calendar-invalid
// day-of-month -- it silently rolls over to a different, real date instead (e.g. "2026-02-30"
// parses as 2026-03-02). Without an explicit round-trip check, a caller passing a malformed date
// would get a silently-shifted date range rather than a clear rejection.
test("computePreviousPeriod rejects a calendar-invalid day-of-month (rolled-over date), not silently shifting it", () => {
  assert.throws(() => computePreviousPeriod("2026-02-30", "2026-02-30"));
  assert.throws(() => computePreviousPeriod("2026-04-31", "2026-04-31"));
});

test("computePreviousPeriod rejects Feb 29 on a non-leap year but accepts it on a leap year", () => {
  assert.throws(() => computePreviousPeriod("2025-02-29", "2025-02-29"), "2025 is not a leap year");
  assert.doesNotThrow(() => computePreviousPeriod("2024-02-29", "2024-02-29"), "2024 is a leap year");
});

test("enumerateDates returns every calendar date inclusive, in order", () => {
  assert.deepEqual(enumerateDates("2026-09-01", "2026-09-04"), [
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
  ]);
});

test("enumerateDates returns a single-element array for a one-day range", () => {
  assert.deepEqual(enumerateDates("2026-09-01", "2026-09-01"), ["2026-09-01"]);
});

test("enumerateDates crosses a month boundary correctly", () => {
  assert.deepEqual(enumerateDates("2026-08-30", "2026-09-01"), ["2026-08-30", "2026-08-31", "2026-09-01"]);
});

test("enumerateDates rejects an inverted range", () => {
  assert.throws(() => enumerateDates("2026-09-04", "2026-09-01"));
});

test("computePercentChange computes a rounded whole-percent increase", () => {
  // Hand-computed: (1031 - 100) / 100 * 100 = 931.
  assert.equal(computePercentChange(1031, 100), 931);
});

test("computePercentChange computes a negative change", () => {
  assert.equal(computePercentChange(50, 100), -50);
});

test("computePercentChange returns null when there is no baseline to compare against (previous = 0)", () => {
  assert.equal(computePercentChange(42, 0), null);
});

test("computePercentChange returns 0 for no change", () => {
  assert.equal(computePercentChange(100, 100), 0);
});

// A real, reachable case: net subscribers (gained - lost) over a churn-heavy period can be
// negative. Hand-computed: (5 - -2) / |-2| * 100 = 350 -- a genuine improvement, must be
// positive, never the "-350%" a naive (current-previous)/previous division would produce.
test("computePercentChange stays positive for an increase from a negative baseline", () => {
  assert.equal(computePercentChange(5, -2), 350);
});

test("computePercentChange stays negative for a decrease from a negative baseline", () => {
  // Hand-computed: (-5 - -2) / |-2| * 100 = -150.
  assert.equal(computePercentChange(-5, -2), -150);
});

test("zeroFillDailySeries returns an empty array for empty input", () => {
  assert.deepEqual(zeroFillDailySeries([], "2026-09-01", (date) => ({ date, value: 0 })), []);
});

test("zeroFillDailySeries fills an interior gap with a zero row", () => {
  const rows = [
    { date: "2026-09-01", value: 10 },
    // 2026-09-02 missing entirely from the API response.
    { date: "2026-09-03", value: 30 },
  ];
  assert.deepEqual(zeroFillDailySeries(rows, "2026-09-01", (date) => ({ date, value: 0 })), [
    { date: "2026-09-01", value: 10 },
    { date: "2026-09-02", value: 0 },
    { date: "2026-09-03", value: 30 },
  ]);
});

test("zeroFillDailySeries never pads past the last date actually present (no fabricated trailing zeros)", () => {
  // startDate/endDate would span 2026-09-01..2026-09-05, but the API has only reported through
  // 2026-09-03 (the last 1-2 days of any range are never yet reported) -- the result must stop
  // at 2026-09-03, not continue to 09-04/09-05 as fake zero days.
  const rows = [{ date: "2026-09-01", value: 5 }, { date: "2026-09-03", value: 7 }];
  const result = zeroFillDailySeries(rows, "2026-09-01", (date) => ({ date, value: 0 }));
  assert.deepEqual(
    result.map((r) => r.date),
    ["2026-09-01", "2026-09-02", "2026-09-03"]
  );
});

test("zeroFillDailySeries fills from startDate even when the first row starts later (channel predates its own data)", () => {
  const rows = [{ date: "2026-09-03", value: 9 }];
  const result = zeroFillDailySeries(rows, "2026-09-01", (date) => ({ date, value: 0 }));
  assert.deepEqual(result, [
    { date: "2026-09-01", value: 0 },
    { date: "2026-09-02", value: 0 },
    { date: "2026-09-03", value: 9 },
  ]);
});

// Studio-parity Slice O2 (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §2.4) --
// formatChartDate. Expected value hand-computed from a real calendar (AGENTS.md §L): 2026-09-06 is
// a Sunday. Shortened 2026-09-26 (owner instruction) to drop the year.
test("formatChartDate matches real Studio's own tooltip wording (\"Weekday, Mon D\")", () => {
  assert.equal(formatChartDate("2026-09-06"), "Sun, Sep 6");
});

test("formatChartDate never shifts the weekday due to the viewer's own local timezone offset from UTC", () => {
  // A date parsed via `new Date(isoDate)` + local formatting would show Dec 31 in a timezone
  // behind UTC -- this must always report the calendar date exactly as given, Jan 1.
  assert.equal(formatChartDate("2027-01-01"), "Fri, Jan 1");
});
