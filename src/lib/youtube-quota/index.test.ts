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
