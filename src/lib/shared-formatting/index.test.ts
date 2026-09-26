import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDisplayDate,
  formatDisplayDateTime,
  formatDisplayDateUtc,
  parseDisplayDate,
  parseDisplayDateTime,
} from "./index";

// Expected values hand-computed from the calendar (AGENTS.md §L), not copied from running the
// implementation. `new Date(year, monthIndex, day, ...)` constructs a LOCAL-time date directly --
// deliberately avoided ISO-string-with-"Z" inputs in these tests, since those are parsed as UTC
// and would make the expected local-calendar-day depend on the machine's own timezone offset.

test("formatDisplayDate renders a local date as DD.MM.YYYY, zero-padding single-digit day and month", () => {
  assert.equal(formatDisplayDate(new Date(2026, 0, 5)), "05.01.2026"); // Jan 5, 2026
});

test("formatDisplayDate does not zero-pad a two-digit day or month", () => {
  assert.equal(formatDisplayDate(new Date(2026, 11, 25)), "25.12.2026"); // Dec 25, 2026
});

test("formatDisplayDate accepts an epoch millisecond number", () => {
  const ms = new Date(2026, 0, 5).getTime();
  assert.equal(formatDisplayDate(ms), "05.01.2026");
});

test("formatDisplayDate accepts an ISO timestamp string with an explicit time component", () => {
  // Constructed via the Date object's own local getters, then re-parsed from its ISO form, so the
  // expected output is independently derivable regardless of the test machine's own timezone: an
  // ISO string with an explicit offset always round-trips to the exact same local calendar date.
  const date = new Date(2026, 0, 5, 14, 30);
  assert.equal(formatDisplayDate(date.toISOString()), formatDisplayDate(date));
});

test("formatDisplayDate returns 'Invalid date' for unparseable input, never 'NaN.NaN.NaN'", () => {
  assert.equal(formatDisplayDate("not-a-real-date"), "Invalid date");
  assert.equal(formatDisplayDate(new Date(NaN)), "Invalid date");
});

test("formatDisplayDateTime renders DD.MM.YYYY HH:MM, zero-padding single-digit hour and minute", () => {
  assert.equal(formatDisplayDateTime(new Date(2026, 0, 5, 9, 3)), "05.01.2026 09:03");
});

test("formatDisplayDateTime does not zero-pad a two-digit hour or minute", () => {
  assert.equal(formatDisplayDateTime(new Date(2026, 0, 5, 23, 59)), "05.01.2026 23:59");
});

test("formatDisplayDateTime handles midnight as 00:00, not 24:00 or blank", () => {
  assert.equal(formatDisplayDateTime(new Date(2026, 0, 5, 0, 0)), "05.01.2026 00:00");
});

test("formatDisplayDateTime returns 'Invalid date' for unparseable input", () => {
  assert.equal(formatDisplayDateTime("garbage"), "Invalid date");
});

// formatDisplayDateUtc -- for a PURE calendar date with no real time-of-day (recordingDate),
// paired with parseDisplayDate's own UTC-midnight write direction. Independent review, 2026-09-26,
// found live: reading a UTC-midnight value back with `formatDisplayDate`'s LOCAL components shifts
// the displayed day by one for any negative-UTC-offset viewer, with no edit in between. These
// tests use `Date.UTC(...)` inputs specifically (unlike every local-time test above) and would
// catch that exact regression regardless of which timezone actually runs them.

test("formatDisplayDateUtc renders a UTC date as DD.MM.YYYY, zero-padding single-digit day and month", () => {
  assert.equal(formatDisplayDateUtc(new Date(Date.UTC(2026, 0, 5))), "05.01.2026");
});

test("formatDisplayDateUtc does not zero-pad a two-digit day or month", () => {
  assert.equal(formatDisplayDateUtc(new Date(Date.UTC(2026, 11, 25))), "25.12.2026");
});

test("formatDisplayDateUtc reads the UTC calendar day, not the viewer's local one, for a UTC-midnight value", () => {
  // The exact bug this function fixes: a naive local-time read of UTC midnight rolls back to the
  // previous day for any negative-UTC-offset viewer. `formatDisplayDateUtc` must report the SAME
  // day this produces regardless of which offset the test happens to run under -- verified here by
  // comparing against the date's own UTC getters directly, never the machine's local ones.
  const utcMidnight = new Date(Date.UTC(2026, 0, 5));
  assert.equal(formatDisplayDateUtc(utcMidnight), "05.01.2026");
  assert.equal(utcMidnight.getUTCDate(), 5, "sanity: this really is Jan 5 in UTC");
});

test("formatDisplayDateUtc round-trips with parseDisplayDate's own UTC-midnight output, in any timezone", () => {
  // This is the exact regression scenario the independent review reproduced empirically under
  // TZ=America/New_York: typing "05.01.2026", writing it, and reading it back must reproduce
  // "05.01.2026" again -- never "04.01.2026" -- regardless of which timezone this test itself runs
  // under, since both functions are UTC-anchored.
  const wireValue = parseDisplayDate("05.01.2026");
  assert.ok(wireValue);
  assert.equal(formatDisplayDateUtc(wireValue!), "05.01.2026");
});

// Round 3 of independent review, 2026-09-26: UTC midnight plus a POSITIVE offset (e.g. Moscow
// +3, Auckland +12/+13) never crosses into the previous calendar day, so the test above (and
// whatever ambient `TZ` the machine running it happens to have) would silently pass even if
// `formatDisplayDateUtc` were reverted back to LOCAL getters -- reproduced live: that mutation
// passed 24/24 under TZ=UTC, TZ=Europe/Moscow, and TZ=Pacific/Auckland, and only failed under a
// NEGATIVE offset (TZ=America/New_York). The test above alone therefore does NOT make good on its
// own "in any timezone" claim -- it only does when the machine running the suite happens to sit
// behind UTC. This test pins the timezone explicitly so the regression is caught no matter what
// timezone actually runs the suite, closing that gap rather than leaving it to chance.
test("formatDisplayDateUtc does not roll back a day under a negative-UTC-offset timezone, regardless of the machine's own ambient TZ", () => {
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = "America/New_York"; // UTC-5/-4 -- the exact zone the live bug was found under.
    const wireValue = parseDisplayDate("05.01.2026");
    assert.ok(wireValue);
    assert.equal(
      formatDisplayDateUtc(wireValue!),
      "05.01.2026",
      "must not silently become 04.01.2026 -- this is the exact live-found regression"
    );
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test("formatDisplayDateUtc returns 'Invalid date' for unparseable input", () => {
  assert.equal(formatDisplayDateUtc("not-a-real-date"), "Invalid date");
});

// parseDisplayDate/parseDisplayDateTime -- the write direction. Expected values hand-derived from
// the Gregorian calendar (AGENTS.md §L): which months have 30/31/28/29 days, and which years are
// leap years (divisible by 4, except centuries not divisible by 400) are facts independent of this
// implementation, not read off it.

test("parseDisplayDate converts DD.MM.YYYY to a UTC-midnight ISO date, matching new Date('YYYY-MM-DD').toISOString()", () => {
  assert.equal(parseDisplayDate("05.01.2026"), "2026-01-05T00:00:00.000Z");
  assert.equal(parseDisplayDate("25.12.2026"), "2026-12-25T00:00:00.000Z");
});

test("parseDisplayDate rejects a day that does not exist in that month, rather than letting it roll over", () => {
  // JS's own `new Date(2026, 1, 31)` silently rolls over to March 3rd -- must be rejected instead.
  assert.equal(parseDisplayDate("31.02.2026"), null);
  assert.equal(parseDisplayDate("31.04.2026"), null); // April has 30 days
});

test("parseDisplayDate handles February 29 correctly for leap and non-leap years", () => {
  assert.equal(parseDisplayDate("29.02.2024"), "2024-02-29T00:00:00.000Z"); // 2024 is a leap year
  assert.equal(parseDisplayDate("29.02.2026"), null); // 2026 is not
});

test("parseDisplayDate rejects an out-of-range day or month", () => {
  assert.equal(parseDisplayDate("00.01.2026"), null);
  assert.equal(parseDisplayDate("32.01.2026"), null);
  assert.equal(parseDisplayDate("05.13.2026"), null);
  assert.equal(parseDisplayDate("05.00.2026"), null);
});

test("parseDisplayDate rejects the wrong shape entirely, including a non-zero-padded value and an empty string", () => {
  assert.equal(parseDisplayDate("5.1.2026"), null);
  assert.equal(parseDisplayDate("2026-01-05"), null);
  assert.equal(parseDisplayDate(""), null);
  assert.equal(parseDisplayDate("garbage"), null);
});

test("parseDisplayDateTime converts DD.MM.YYYY HH:MM as the viewer's local time, matching new Date('YYYY-MM-DDTHH:mm').toISOString()", () => {
  // Compared against a Date object built from the same local components, exactly like
  // formatDisplayDate's own "explicit time component" test above -- independent of the CI
  // machine's own timezone.
  const expected = new Date(2026, 0, 5, 14, 30).toISOString();
  assert.equal(parseDisplayDateTime("05.01.2026 14:30"), expected);
});

test("parseDisplayDateTime accepts midnight as 00:00", () => {
  assert.equal(parseDisplayDateTime("05.01.2026 00:00"), new Date(2026, 0, 5, 0, 0).toISOString());
});

test("parseDisplayDateTime rejects an out-of-range hour or minute, never wrapping into the next day", () => {
  assert.equal(parseDisplayDateTime("05.01.2026 24:00"), null);
  assert.equal(parseDisplayDateTime("05.01.2026 12:60"), null);
});

test("parseDisplayDateTime rejects an impossible calendar date even with a valid time", () => {
  assert.equal(parseDisplayDateTime("31.02.2026 10:00"), null);
});

test("parseDisplayDateTime rejects the wrong shape, including a date with no time part and an empty string", () => {
  assert.equal(parseDisplayDateTime("05.01.2026"), null);
  assert.equal(parseDisplayDateTime(""), null);
  assert.equal(parseDisplayDateTime("garbage"), null);
});
