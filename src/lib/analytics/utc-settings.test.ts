import assert from "node:assert/strict";
import test from "node:test";
import { isAnalyticsCollectionStale } from "./staleness";
import { utcCollectionSettingsStore } from "./utc-settings";

// Owner, Telegram msgs 2725/2727 (2026-10-13): the collection times are set in UTC, so the daily boundary stays at the same UTC
// time all year -- for the owner's Helsinki, 09:05Z is 12:05 in summer and 11:05 after the change on 2026-10-25 (before this
// change it would have moved to 10:05Z). Expected values by hand.

const store = utcCollectionSettingsStore(async () => ({ dailyUtc: "09:05", eveningUtc: "19:05" }));

test("the services get the UTC times in UTC", async () => {
  assert.deepEqual(await store.getAnalyticsSyncSettings(), { localTime: "09:05", timezone: "UTC" });
  assert.equal(await store.getAnalyticsEveningLocalTime(), "19:05");
});

test("after the winter change the daily boundary is still 09:05Z (11:05 in Helsinki), not 10:05Z", async () => {
  const { localTime, timezone } = await store.getAnalyticsSyncSettings();
  const stale = (now: string, last: string) => isAnalyticsCollectionStale({ now: new Date(now), lastAutoCollectedAt: new Date(last), timezone, localTime });
  // 26.10 09:30Z: a run at 09:10Z the same morning is after the boundary -> fresh (the old 12:05-local rule would say stale).
  assert.equal(stale("2026-10-26T09:30:00Z", "2026-10-26T09:10:00Z"), false);
  // A run at 09:00Z is before the boundary -> stale; yesterday's run -> stale.
  assert.equal(stale("2026-10-26T09:30:00Z", "2026-10-26T09:00:00Z"), true);
  assert.equal(stale("2026-10-26T09:30:00Z", "2026-10-25T20:00:00Z"), true);
  // The UTC day starts at 00:00Z (02:00 in Helsinki in winter): a run at 23:30Z on 25.10 belongs to 25.10.
  assert.equal(stale("2026-10-26T00:30:00Z", "2026-10-25T23:30:00Z"), true);
});
