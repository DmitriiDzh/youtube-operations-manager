import assert from "node:assert/strict";
import test from "node:test";
import {
  computeDefaultAutoCollectionRange,
  isAnalyticsCollectionStale,
  isValidIanaTimezone,
  isValidLocalTimeOfDay,
} from "./staleness";

// Every expected value below is computed by hand from the owner's own rule
// (docs/roadmap/plans/PHASE_8_PLAN.md §10 item 3, quoted in staleness.ts's doc comment) --
// never derived by calling isAnalyticsCollectionStale itself and copying its output (AGENTS.md §L).

test("isAnalyticsCollectionStale: never collected before -> stale", () => {
  assert.equal(
    isAnalyticsCollectionStale({
      now: new Date("2026-09-22T15:00:00Z"),
      lastAutoCollectedAt: null,
      timezone: "UTC",
      localTime: "12:00",
    }),
    true
  );
});

test("isAnalyticsCollectionStale: last run today at 11:59 local, boundary 12:00 -> stale (before boundary)", () => {
  assert.equal(
    isAnalyticsCollectionStale({
      now: new Date("2026-09-22T20:00:00Z"),
      lastAutoCollectedAt: new Date("2026-09-22T11:59:00Z"),
      timezone: "UTC",
      localTime: "12:00",
    }),
    true
  );
});

test("isAnalyticsCollectionStale: last run today at 12:06 local, boundary 12:00 -> fresh (after boundary)", () => {
  assert.equal(
    isAnalyticsCollectionStale({
      now: new Date("2026-09-22T20:00:00Z"),
      lastAutoCollectedAt: new Date("2026-09-22T12:06:00Z"),
      timezone: "UTC",
      localTime: "12:00",
    }),
    false
  );
});

test("isAnalyticsCollectionStale: last run exactly at the boundary -> fresh (not strictly before)", () => {
  assert.equal(
    isAnalyticsCollectionStale({
      now: new Date("2026-09-22T20:00:00Z"),
      lastAutoCollectedAt: new Date("2026-09-22T12:05:00Z"),
      timezone: "UTC",
      localTime: "12:05",
    }),
    false
  );
});

test("isAnalyticsCollectionStale: last run yesterday at 23:00 local -> stale regardless of boundary", () => {
  assert.equal(
    isAnalyticsCollectionStale({
      now: new Date("2026-09-22T01:00:00Z"),
      lastAutoCollectedAt: new Date("2026-09-21T23:00:00Z"),
      timezone: "UTC",
      localTime: "12:00",
    }),
    true
  );
});

test("isAnalyticsCollectionStale: lastAutoCollectedAt in the future (clock skew) -> never stale", () => {
  assert.equal(
    isAnalyticsCollectionStale({
      now: new Date("2026-09-22T01:00:00Z"),
      lastAutoCollectedAt: new Date("2026-09-23T01:00:00Z"),
      timezone: "UTC",
      localTime: "12:00",
    }),
    false
  );
});

// The owner's own stated concern (msg 356 item 6): "время... может меняться в зимнее/летнее
// время" (the boundary must respect real DST transitions, not a fixed UTC offset). Same UTC wall
// clock (16:00Z) collected-at time, same boundary ("12:00" local New York time), same relative
// "now" offset (+4h) -- but the two calendar dates fall on opposite sides of America/New_York's
// DST rule, so the *same* inputs (differing only by date) must produce *different* results if the
// zone's real DST rule is actually being applied, not a hardcoded UTC-4 or UTC-5 offset.
test("isAnalyticsCollectionStale: respects real DST transitions for America/New_York, not a fixed offset", () => {
  // January -- EST, UTC-5. 16:00Z -> 11:00 local -- before the 12:00 boundary.
  assert.equal(
    isAnalyticsCollectionStale({
      now: new Date("2026-01-15T20:00:00Z"),
      lastAutoCollectedAt: new Date("2026-01-15T16:00:00Z"),
      timezone: "America/New_York",
      localTime: "12:00",
    }),
    true,
    "EST: 16:00Z is 11:00 local, before the noon boundary -> stale"
  );

  // July -- EDT, UTC-4. The SAME 16:00Z is now 12:00 local exactly -- at the boundary, not before.
  assert.equal(
    isAnalyticsCollectionStale({
      now: new Date("2026-07-15T20:00:00Z"),
      lastAutoCollectedAt: new Date("2026-07-15T16:00:00Z"),
      timezone: "America/New_York",
      localTime: "12:00",
    }),
    false,
    "EDT: the same 16:00Z is 12:00 local exactly, at the boundary -> fresh"
  );
});

test("isValidLocalTimeOfDay accepts HH:MM, rejects malformed input", () => {
  assert.equal(isValidLocalTimeOfDay("12:05"), true);
  assert.equal(isValidLocalTimeOfDay("00:00"), true);
  assert.equal(isValidLocalTimeOfDay("23:59"), true);
  assert.equal(isValidLocalTimeOfDay("24:00"), false);
  assert.equal(isValidLocalTimeOfDay("12:60"), false);
  assert.equal(isValidLocalTimeOfDay("12"), false);
  assert.equal(isValidLocalTimeOfDay("noon"), false);
  assert.equal(isValidLocalTimeOfDay(""), false);
});

test("computeDefaultAutoCollectionRange: ends yesterday, spans rangeDays, in UTC", () => {
  const { startDate, endDate } = computeDefaultAutoCollectionRange({
    now: new Date("2026-09-22T15:00:00Z"),
    timezone: "UTC",
    rangeDays: 7,
  });
  assert.equal(endDate, "2026-09-21");
  assert.equal(startDate, "2026-09-14");
});

test("computeDefaultAutoCollectionRange: uses the timezone's own local calendar date, not UTC's", () => {
  // 2026-09-22T02:00:00Z is still 2026-09-21 local in America/Los_Angeles (UTC-7 in September,
  // PDT) -- "yesterday" from that local date is 2026-09-20, not 2026-09-21 (which UTC would give).
  const { startDate, endDate } = computeDefaultAutoCollectionRange({
    now: new Date("2026-09-22T02:00:00Z"),
    timezone: "America/Los_Angeles",
    rangeDays: 7,
  });
  assert.equal(endDate, "2026-09-20");
  assert.equal(startDate, "2026-09-13");
});

test("computeDefaultAutoCollectionRange: rolls over a month/year boundary correctly", () => {
  const { startDate, endDate } = computeDefaultAutoCollectionRange({
    now: new Date("2027-01-03T12:00:00Z"),
    timezone: "UTC",
    rangeDays: 7,
  });
  assert.equal(endDate, "2027-01-02");
  assert.equal(startDate, "2026-12-26");
});

test("isValidIanaTimezone accepts real zones, rejects garbage without throwing", () => {
  assert.equal(isValidIanaTimezone("UTC"), true);
  assert.equal(isValidIanaTimezone("America/New_York"), true);
  assert.equal(isValidIanaTimezone("Europe/Moscow"), true);
  assert.equal(isValidIanaTimezone("Not/A_Real_Zone"), false);
  assert.equal(isValidIanaTimezone(""), false);
});
