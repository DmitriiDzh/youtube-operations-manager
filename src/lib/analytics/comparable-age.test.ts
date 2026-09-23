import assert from "node:assert/strict";
import test from "node:test";
import { computeComparableAgeSeries, diffCalendarDays, toPacificCalendarDate } from "./comparable-age";

test("toPacificCalendarDate: a timestamp comfortably inside the Pacific-Time day keeps the same calendar date", () => {
  // 2026-09-20T17:00:36Z is PDT (UTC-7) in September -> 10:00:36 local, same calendar day.
  assert.equal(toPacificCalendarDate("2026-09-20T17:00:36Z"), "2026-09-20");
});

test("toPacificCalendarDate: a UTC timestamp just after midnight is still the PREVIOUS Pacific-Time day", () => {
  // 2026-09-21T02:00:00Z - 7h (PDT) = 2026-09-20T19:00:00 local -- the whole reason day-0
  // alignment must use Pacific Time rather than the UTC calendar date of `publishedAt`.
  assert.equal(toPacificCalendarDate("2026-09-21T02:00:00Z"), "2026-09-20");
});

test("toPacificCalendarDate: correct on both sides of the November DST fall-back", () => {
  // Before the 2026-11-01 fall-back, Pacific Time is still PDT (UTC-7).
  assert.equal(toPacificCalendarDate("2026-10-31T09:00:00Z"), "2026-10-31");
  // After the fall-back, Pacific Time is PST (UTC-8).
  assert.equal(toPacificCalendarDate("2026-11-02T09:00:00Z"), "2026-11-02");
});

test("toPacificCalendarDate: rejects an unparseable timestamp", () => {
  assert.throws(() => toPacificCalendarDate("not-a-date"));
});

test("diffCalendarDays: zero for the same date", () => {
  assert.equal(diffCalendarDays("2026-09-20", "2026-09-20"), 0);
});

test("diffCalendarDays: a positive week-long span", () => {
  assert.equal(diffCalendarDays("2026-09-20", "2026-09-27"), 7);
});

test("diffCalendarDays: a negative span for an earlier `to` date", () => {
  assert.equal(diffCalendarDays("2026-09-20", "2026-09-19"), -1);
});

test("diffCalendarDays: unaffected by the DST fall-back between the two dates", () => {
  // Pure calendar-day counting via Date.UTC never sees a 25-hour local day -- exactly 2 days.
  assert.equal(diffCalendarDays("2026-10-31", "2026-11-02"), 2);
});

test("computeComparableAgeSeries: contiguous data from day 0 produces a full cumulative series", () => {
  const result = computeComparableAgeSeries({
    publishedAt: "2026-09-20T17:00:00Z",
    metricRows: [
      { metricDate: "2026-09-20", metricValue: 10 },
      { metricDate: "2026-09-21", metricValue: 5 },
      { metricDate: "2026-09-22", metricValue: 3 },
    ],
    maxDays: 10,
  });

  assert.equal(result.publishDatePacific, "2026-09-20");
  assert.deepEqual(result.points, [
    { dayOffset: 0, value: 10 },
    { dayOffset: 1, value: 5 },
    { dayOffset: 2, value: 3 },
  ]);
  assert.deepEqual(result.cumulativePoints, [
    { dayOffset: 0, cumulativeValue: 10 },
    { dayOffset: 1, cumulativeValue: 15 },
    { dayOffset: 2, cumulativeValue: 18 },
  ]);
});

test("computeComparableAgeSeries: a gap after day 0 stops the cumulative series but not the raw points", () => {
  const result = computeComparableAgeSeries({
    publishedAt: "2026-09-20T17:00:00Z",
    metricRows: [
      { metricDate: "2026-09-20", metricValue: 10 },
      // day offset 1 missing entirely -- never zero-filled, never assumed.
      { metricDate: "2026-09-22", metricValue: 3 },
    ],
    maxDays: 10,
  });

  assert.deepEqual(result.points, [
    { dayOffset: 0, value: 10 },
    { dayOffset: 2, value: 3 },
  ]);
  // Cumulative stops dead at the last contiguous known day (day 0) -- day 2's real value is
  // never folded in past the gap, since the true day-1 total is genuinely unknown.
  assert.deepEqual(result.cumulativePoints, [{ dayOffset: 0, cumulativeValue: 10 }]);
});

test("computeComparableAgeSeries: no day-0 data means an empty cumulative series, not a fabricated one", () => {
  const result = computeComparableAgeSeries({
    publishedAt: "2026-09-20T17:00:00Z",
    metricRows: [{ metricDate: "2026-09-21", metricValue: 5 }],
    maxDays: 10,
  });

  assert.deepEqual(result.points, [{ dayOffset: 1, value: 5 }]);
  assert.deepEqual(result.cumulativePoints, []);
});

test("computeComparableAgeSeries: rows before publish date or beyond maxDays are excluded, not treated as gaps", () => {
  const result = computeComparableAgeSeries({
    publishedAt: "2026-09-20T17:00:00Z",
    metricRows: [
      { metricDate: "2026-09-19", metricValue: 99 }, // day offset -1
      { metricDate: "2026-09-20", metricValue: 10 },
      { metricDate: "2026-10-05", metricValue: 50 }, // day offset 15, beyond maxDays
    ],
    maxDays: 10,
  });

  assert.deepEqual(result.points, [{ dayOffset: 0, value: 10 }]);
  assert.deepEqual(result.cumulativePoints, [{ dayOffset: 0, cumulativeValue: 10 }]);
});

test("computeComparableAgeSeries: uses the video's own Pacific-Time publish day, not the UTC calendar date", () => {
  // publishedAt is 2026-09-21 in UTC but 2026-09-20 in Pacific Time (see toPacificCalendarDate's
  // own boundary test above). A metric row dated 2026-09-20 (Pacific) must land at day offset 0,
  // not -1 -- the entire reason this module converts via Pacific Time instead of slicing the UTC
  // ISO string.
  const result = computeComparableAgeSeries({
    publishedAt: "2026-09-21T02:00:00Z",
    metricRows: [{ metricDate: "2026-09-20", metricValue: 7 }],
    maxDays: 10,
  });

  assert.equal(result.publishDatePacific, "2026-09-20");
  assert.deepEqual(result.points, [{ dayOffset: 0, value: 7 }]);
});

test("computeComparableAgeSeries: a row at exactly dayOffset === maxDays is included, not excluded", () => {
  const result = computeComparableAgeSeries({
    publishedAt: "2026-09-20T17:00:00Z",
    metricRows: [{ metricDate: "2026-09-30", metricValue: 5 }], // day offset 10
    maxDays: 10,
  });

  assert.deepEqual(result.points, [{ dayOffset: 10, value: 5 }]);
});

test("computeComparableAgeSeries: a row at exactly dayOffset === maxDays + 1 is excluded", () => {
  const result = computeComparableAgeSeries({
    publishedAt: "2026-09-20T17:00:00Z",
    metricRows: [{ metricDate: "2026-10-01", metricValue: 5 }], // day offset 11
    maxDays: 10,
  });

  assert.deepEqual(result.points, []);
});

test("computeComparableAgeSeries: a contiguous series through maxDays includes maxDays in cumulativePoints", () => {
  const result = computeComparableAgeSeries({
    publishedAt: "2026-09-20T17:00:00Z",
    metricRows: [
      { metricDate: "2026-09-20", metricValue: 1 },
      { metricDate: "2026-09-21", metricValue: 1 },
    ],
    maxDays: 1,
  });

  assert.deepEqual(result.cumulativePoints, [
    { dayOffset: 0, cumulativeValue: 1 },
    { dayOffset: 1, cumulativeValue: 2 },
  ]);
});

test("computeComparableAgeSeries: multiple rows landing on the same day offset are summed", () => {
  const result = computeComparableAgeSeries({
    publishedAt: "2026-09-20T17:00:00Z",
    metricRows: [
      { metricDate: "2026-09-20", metricValue: 4 },
      { metricDate: "2026-09-20", metricValue: 6 },
    ],
    maxDays: 10,
  });

  assert.deepEqual(result.points, [{ dayOffset: 0, value: 10 }]);
});
