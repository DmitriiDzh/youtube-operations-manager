import assert from "node:assert/strict";
import test from "node:test";
import { formatDisplayDate, formatDisplayDateTime } from "./index";

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
