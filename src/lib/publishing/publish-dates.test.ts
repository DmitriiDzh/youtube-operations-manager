import assert from "node:assert/strict";
import test from "node:test";
import { assignPublishDates, publishInstant } from "./publish-dates";

// FO-REQ-0023 §4 B3: each package gets its planned date at the channel's default time; a date already taken shifts to the next
// free day; the owner can edit any date; "upload as private without a date" stays possible. Owner msgs 2725/2727: the time is UTC.

const NOW = new Date("2026-10-13T12:00:00Z");

test("planned dates at the channel's time; a taken day moves to the next free one, also past days taken by the selection", () => {
  const dates = assignPublishDates({
    selected: [
      { key: "V56", plannedDate: "2026-10-15" },
      { key: "V57", plannedDate: "2026-10-15" },
      { key: "V58", plannedDate: "2026-10-17" },
    ],
    takenDays: new Set(["2026-10-16"]),
    publishTimeUtc: "12:00",
    now: NOW,
  });
  // V56 keeps 15.10; V57 also wants 15.10 -> 16.10 is taken by a scheduled video -> 17.10; V58 wants 17.10 -> 18.10.
  assert.deepEqual([...dates.entries()], [["V56", "2026-10-15"], ["V57", "2026-10-17"], ["V58", "2026-10-18"]]);
});

test("a planned date already past, or today at a time 15 minutes away or less, moves to the next possible day", () => {
  const dates = assignPublishDates({
    selected: [{ key: "old", plannedDate: "2026-10-10" }, { key: "today", plannedDate: "2026-10-13" }],
    takenDays: new Set(),
    publishTimeUtc: "12:10",
    now: NOW,
  });
  // 13.10 12:10Z is 10 minutes away: too soon. "old" -> 14.10 (10.10–13.10 are past or too soon); "today" -> 15.10.
  assert.deepEqual([...dates.entries()], [["old", "2026-10-14"], ["today", "2026-10-15"]]);
});

test("no planned date: no date (a private upload) until the owner picks one", () => {
  assert.deepEqual([...assignPublishDates({ selected: [{ key: "x", plannedDate: null }], takenDays: new Set(), publishTimeUtc: "12:00", now: NOW }).entries()], [["x", null]]);
});

test("the instant of a day at the UTC time", () => {
  assert.equal(publishInstant("2026-10-24", "12:00"), "2026-10-24T12:00:00.000Z");
});
