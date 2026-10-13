import assert from "node:assert/strict";
import test from "node:test";
import { isValidIanaTimezone, isValidLocalTimeOfDay, localTimeOfUtc, zonedInstant } from "./index";

// Owner, Telegram msgs 2725/2727 (2026-10-13): times are set in UTC; the owner's own time is shown in parentheses for the date,
// summer or winter. Expected values by hand from the zones' published rules:
// - Europe/Helsinki is UTC+3 until the EU change on Sunday 2026-10-25 01:00Z, UTC+2 after it;
// - America/Los_Angeles is UTC-7 until the US change on Sunday 2026-11-01 09:00Z, UTC-8 after it.

test("12:00 UTC is 15:00 in Helsinki in summer and 14:00 after the change on 25.10", () => {
  assert.deepEqual(localTimeOfUtc({ utcTime: "12:00", on: new Date("2026-10-13T08:00:00Z"), timezone: "Europe/Helsinki" }), { localTime: "15:00", dayOffset: 0 });
  assert.deepEqual(localTimeOfUtc({ utcTime: "12:00", on: new Date("2026-10-26T08:00:00Z"), timezone: "Europe/Helsinki" }), { localTime: "14:00", dayOffset: 0 });
});

test("the day the local time falls on: the next day east of UTC, the previous day west of it", () => {
  assert.deepEqual(localTimeOfUtc({ utcTime: "22:30", on: new Date("2026-10-13T08:00:00Z"), timezone: "Europe/Helsinki" }), { localTime: "01:30", dayOffset: 1 });
  assert.deepEqual(localTimeOfUtc({ utcTime: "03:00", on: new Date("2026-10-13T08:00:00Z"), timezone: "America/Los_Angeles" }), { localTime: "20:00", dayOffset: -1 });
  assert.deepEqual(localTimeOfUtc({ utcTime: "03:00", on: new Date("2026-11-02T08:00:00Z"), timezone: "America/Los_Angeles" }), { localTime: "19:00", dayOffset: -1 });
});

test("the reference date is taken as its UTC date, whatever its time of day", () => {
  // 23:30Z on 13.10 is already 14.10 in Helsinki, but the UTC date -- 13.10 -- is the one the UTC time is set on.
  assert.deepEqual(localTimeOfUtc({ utcTime: "09:05", on: new Date("2026-10-13T23:30:00Z"), timezone: "Europe/Helsinki" }), { localTime: "12:05", dayOffset: 0 });
  assert.deepEqual(localTimeOfUtc({ utcTime: "09:05", on: new Date("2026-10-13T23:30:00Z"), timezone: "UTC" }), { localTime: "09:05", dayOffset: 0 });
});

test("the helpers moved from analytics keep their behaviour", () => {
  assert.equal(isValidLocalTimeOfDay("09:05"), true);
  assert.equal(isValidLocalTimeOfDay("9:05"), false);
  assert.equal(isValidLocalTimeOfDay("24:00"), false);
  assert.equal(isValidIanaTimezone("Europe/Helsinki"), true);
  assert.equal(isValidIanaTimezone("Mars/Olympus"), false);
  // 15:00 in Helsinki on 13.10 (UTC+3) is 12:00Z; on 26.10 (UTC+2) it is 13:00Z.
  assert.equal(zonedInstant({ localDate: "2026-10-13", localTime: "15:00", timezone: "Europe/Helsinki" }).toISOString(), "2026-10-13T12:00:00.000Z");
  assert.equal(zonedInstant({ localDate: "2026-10-26", localTime: "15:00", timezone: "Europe/Helsinki" }).toISOString(), "2026-10-26T13:00:00.000Z");
});
