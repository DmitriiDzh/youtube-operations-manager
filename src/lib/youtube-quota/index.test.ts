import { test } from "node:test";
import assert from "node:assert/strict";
import { startOfYoutubeQuotaDay } from "./index";

// Expected values computed by hand from the Pacific-time rule (PDT = UTC-7 in summer, PST = UTC-8 in winter).

test("summer (PDT): the quota day starts at 07:00 UTC", () => {
  assert.equal(startOfYoutubeQuotaDay(new Date("2026-10-01T12:00:00Z")).toISOString(), "2026-10-01T07:00:00.000Z");
  // 03:00 UTC on Oct 1 is still Sep 30 in California.
  assert.equal(startOfYoutubeQuotaDay(new Date("2026-10-01T03:00:00Z")).toISOString(), "2026-09-30T07:00:00.000Z");
});

test("winter (PST): the quota day starts at 08:00 UTC", () => {
  assert.equal(startOfYoutubeQuotaDay(new Date("2026-12-15T20:00:00Z")).toISOString(), "2026-12-15T08:00:00.000Z");
});

test("DST switch day (2026-11-01, PDT -> PST): midnight was still PDT", () => {
  assert.equal(startOfYoutubeQuotaDay(new Date("2026-11-01T20:00:00Z")).toISOString(), "2026-11-01T07:00:00.000Z");
});

// Phase 13 slice 13.7 -- YouTube changed view counting on 2026-08-27 (Data API revision history).
import { rangesStraddleViewCountingChange } from "./index";

test("13.7: comparisons that mix the old and new view counting are detected", () => {
  const r = (startDate: string, endDate: string) => ({ startDate, endDate });
  assert.equal(rangesStraddleViewCountingChange(r("2026-09-01", "2026-09-28"), r("2026-08-04", "2026-08-31")), true, "previous contains the change day");
  assert.equal(rangesStraddleViewCountingChange(r("2026-08-28", "2026-09-03"), r("2026-08-21", "2026-08-26")), true, "before vs after");
  assert.equal(rangesStraddleViewCountingChange(r("2026-09-10", "2026-09-16"), r("2026-09-03", "2026-09-09")), false, "both after");
  assert.equal(rangesStraddleViewCountingChange(r("2026-07-10", "2026-07-16"), r("2026-07-03", "2026-07-09")), false, "both before");
  assert.equal(rangesStraddleViewCountingChange(r("2026-08-27", "2026-09-02"), r("2026-08-20", "2026-08-26")), true, "starts exactly on the change day");
});
