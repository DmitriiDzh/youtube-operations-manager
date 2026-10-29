import assert from "node:assert/strict";
import test from "node:test";
import { buildPublishingCalendar, classifyCalendarVideo, currentRows, type CalendarSourceVideo } from "./calendar";

// BL-182 stage 1 (FO-REQ-0023 §4 C and D; PUBLISHING_PLAN.md §2 stage 1). Requirements:
// - YouTube has no "scheduled" status: a scheduled video is non-public with a future `status.publishAt` (YouTube Data API videos
//   reference: publishAt is set only for a private video and is the time it becomes public);
// - the calendar shows published, scheduled, private without a date; a live broadcast is not a release;
// - reminder: "covered through" = the latest future publishAt (none -> not covered); it fires when that is less than N days away
//   (default 7). Example from the request: both channels scheduled only through 14.10 12:00Z -> it fires today (13.10).
// Expected values are worked out by hand.

const NOW = new Date("2026-10-13T11:00:00Z");
const v = (over: Partial<CalendarSourceVideo> & Pick<CalendarSourceVideo, "videoId">): CalendarSourceVideo => ({
  title: over.videoId,
  privacyStatus: "private",
  publishedAt: "2026-10-12T09:00:00Z",
  publishAt: null,
  liveBroadcastContent: "none",
  ...over,
});

test("classification: public = published at its publish time; private + future publishAt = scheduled; past = overdue; none = unscheduled", () => {
  assert.deepEqual(classifyCalendarVideo(v({ videoId: "a", privacyStatus: "public", publishedAt: "2026-10-12T12:00:00Z" }), NOW), {
    videoId: "a",
    title: "a",
    privacyStatus: "public",
    kind: "published",
    at: "2026-10-12T12:00:00Z",
  });
  assert.equal(classifyCalendarVideo(v({ videoId: "b", publishAt: "2026-10-14T12:00:00Z" }), NOW)?.kind, "scheduled");
  // BL-235 review item 1 (a requirement change): a date passed less than 24 h ago is the publication YouTube made and the copy
  // has not synced yet (`published_pending`); 24 h or more is overdue.
  assert.equal(classifyCalendarVideo(v({ videoId: "c", publishAt: "2026-10-13T10:00:00Z" }), NOW)?.kind, "published_pending");
  assert.equal(classifyCalendarVideo(v({ videoId: "c2", publishAt: "2026-10-12T11:00:00Z" }), NOW)?.kind, "overdue");
  assert.equal(classifyCalendarVideo(v({ videoId: "d" }), NOW)?.kind, "unscheduled");
  assert.equal(classifyCalendarVideo(v({ videoId: "e", privacyStatus: "unlisted" }), NOW)?.kind, "published");
});

test("a live broadcast (live or upcoming) is not a release; a finished one (none) is", () => {
  assert.equal(classifyCalendarVideo(v({ videoId: "radio", privacyStatus: "public", liveBroadcastContent: "live" }), NOW), null);
  assert.equal(classifyCalendarVideo(v({ videoId: "next", liveBroadcastContent: "upcoming", publishAt: "2026-10-20T12:00:00Z" }), NOW), null);
  assert.equal(classifyCalendarVideo(v({ videoId: "vod", privacyStatus: "public", liveBroadcastContent: "none" }), NOW)?.kind, "published");
});

test("the request's own case: scheduled only through 14.10 12:00Z on 13.10 -> covered 1 day, the 7-day reminder fires", () => {
  const { coverage } = buildPublishingCalendar(
    [
      v({ videoId: "V54", privacyStatus: "public", publishedAt: "2026-10-12T12:00:00Z" }),
      v({ videoId: "V55", publishAt: "2026-10-13T12:00:00Z" }),
      v({ videoId: "V56", publishAt: "2026-10-14T12:00:00Z" }),
    ],
    NOW
  );
  // 2026-10-14T12:00Z - 2026-10-13T11:00Z = 25 h -> 1 whole day.
  assert.deepEqual(coverage, { coveredThrough: "2026-10-14T12:00:00Z", scheduledCount: 2, unscheduledCount: 0, daysCovered: 1, due: true, thresholdDays: 7 });
});

test("the reminder: exactly 7 days ahead does not fire, a minute less does; nothing scheduled always fires", () => {
  const atSeven = buildPublishingCalendar([v({ videoId: "x", publishAt: "2026-10-20T11:00:00Z" })], NOW).coverage;
  assert.deepEqual([atSeven.daysCovered, atSeven.due], [7, false]);
  const justShort = buildPublishingCalendar([v({ videoId: "x", publishAt: "2026-10-20T10:59:00Z" })], NOW).coverage;
  assert.deepEqual([justShort.daysCovered, justShort.due], [6, true]);
  const none = buildPublishingCalendar([v({ videoId: "p", privacyStatus: "public" }), v({ videoId: "u" })], NOW).coverage;
  assert.deepEqual(none, { coveredThrough: null, scheduledCount: 0, unscheduledCount: 1, daysCovered: 0, due: true, thresholdDays: 7 });
  const longer = buildPublishingCalendar([v({ videoId: "x", publishAt: "2026-10-18T12:00:00Z" })], NOW, 3).coverage;
  assert.equal(longer.due, false, "another threshold");
});

test("an overdue video does not cover anything (the stored copy is older than its publication)", () => {
  const { coverage } = buildPublishingCalendar([v({ videoId: "late", publishAt: "2026-10-12T12:00:00Z" })], NOW);
  assert.deepEqual([coverage.coveredThrough, coverage.scheduledCount, coverage.due], [null, 0, true]);
});

test("entries come in time order, the ones without a date last", () => {
  const { entries } = buildPublishingCalendar(
    [
      v({ videoId: "u" }),
      v({ videoId: "s2", publishAt: "2026-10-16T12:00:00Z" }),
      v({ videoId: "p", privacyStatus: "public", publishedAt: "2026-10-01T12:00:00Z" }),
      v({ videoId: "s1", publishAt: "2026-10-15T12:00:00Z" }),
    ],
    NOW
  );
  assert.deepEqual(entries.map((entry) => entry.videoId), ["p", "s1", "s2", "u"]);
});

// Review S5: a row the latest channel sync did not return (deleted or replaced in Studio) must not keep the channel "covered".
test("rows the latest sync did not return are left out; without a channel sync time every row stays", () => {
  const synced = Date.parse("2026-10-13T10:00:00Z");
  const rows = [
    v({ videoId: "kept", publishAt: "2026-10-20T12:00:00Z", syncedAtMs: synced }),
    v({ videoId: "deleted", publishAt: "2026-10-30T12:00:00Z", syncedAtMs: synced - 3_600_000 }),
  ];
  assert.deepEqual(currentRows(rows, synced).map((row) => row.videoId), ["kept"]);
  assert.equal(buildPublishingCalendar(currentRows(rows, synced), NOW).coverage.coveredThrough, "2026-10-20T12:00:00Z");
  assert.deepEqual(currentRows(rows, null).map((row) => row.videoId), ["kept", "deleted"]);
});
