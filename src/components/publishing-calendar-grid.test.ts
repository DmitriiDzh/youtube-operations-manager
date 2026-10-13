import assert from "node:assert/strict";
import test from "node:test";
import { entriesByDay, gapDays, localDayKey, monthWeeks, type GridEntry } from "./publishing-calendar-grid";

// BL-182 stage 1 (FO-REQ-0023 §4 C1): a month view whose weeks start on Monday, videos placed on their local day, and the gaps --
// days of the next two weeks with no published or scheduled video. Calendar facts below are from the real 2026 calendar.

test("October 2026 starts on a Thursday: 5 weeks from Mon 28.09 to Sun 01.11, Monday first", () => {
  const weeks = monthWeeks(2026, 9);
  assert.equal(weeks.length, 5);
  assert.deepEqual(weeks.map((week) => week.length), [7, 7, 7, 7, 7]);
  assert.equal(localDayKey(weeks[0][0]), "2026-09-28");
  assert.equal(localDayKey(weeks[0][3]), "2026-10-01");
  assert.equal(localDayKey(weeks[4][6]), "2026-11-01");
  for (const week of weeks) assert.equal(week[0].getDay(), 1, "every week starts on a Monday");
});

test("February 2027 starts on a Monday and has exactly 4 weeks", () => {
  const weeks = monthWeeks(2027, 1);
  assert.deepEqual([weeks.length, localDayKey(weeks[0][0]), localDayKey(weeks[3][6])], [4, "2027-02-01", "2027-02-28"]);
});

const at = (y: number, m: number, d: number, h: number) => new Date(y, m, d, h, 0).toISOString();

test("entries go to their local day in time order; undated ones are not on the grid", () => {
  const entries: GridEntry[] = [
    { videoId: "late", title: "late", kind: "scheduled", at: at(2026, 9, 14, 18) },
    { videoId: "early", title: "early", kind: "scheduled", at: at(2026, 9, 14, 9) },
    { videoId: "none", title: "none", kind: "unscheduled", at: null },
  ];
  const byDay = entriesByDay(entries);
  assert.deepEqual([...byDay.keys()], ["2026-10-14"]);
  assert.deepEqual(byDay.get("2026-10-14")?.map((entry) => entry.videoId), ["early", "late"]);
});

test("gaps: the next 14 days without a published or scheduled video; an overdue one does not fill its day", () => {
  const now = new Date(2026, 9, 13, 14, 0);
  const byDay = entriesByDay([
    { videoId: "today", title: "t", kind: "published", at: at(2026, 9, 13, 15) },
    { videoId: "tomorrow", title: "t", kind: "scheduled", at: at(2026, 9, 14, 15) },
    { videoId: "late", title: "t", kind: "overdue", at: at(2026, 9, 15, 15) },
  ]);
  const gaps = gapDays(now, byDay);
  assert.equal(gaps.size, 12, "14 days, two of them filled");
  assert.ok(!gaps.has("2026-10-13") && !gaps.has("2026-10-14"));
  assert.ok(gaps.has("2026-10-15"), "the overdue day is a gap");
  assert.ok(gaps.has("2026-10-26") && !gaps.has("2026-10-27"), "13.10 + 13 days is the last one");
});

// BL-182 stage 2 (FO-REQ-0023 §4 C1): a ready package shows on its planned day, but it is not scheduled yet, so the day stays a gap.
test("a ready package on its planned day does not fill the gap", () => {
  const now = new Date(2026, 9, 13, 14, 0);
  const byDay = entriesByDay([{ videoId: "04 Videos/x/V65_release.json", title: "V65", kind: "package", at: at(2026, 9, 16, 15) }]);
  assert.equal(byDay.get("2026-10-16")?.length, 1);
  assert.ok(gapDays(now, byDay).has("2026-10-16"));
});
