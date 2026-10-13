import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { CalendarSourceVideo } from "./calendar";
import { createPublishingCalendarReads } from "./calendar-reads";

// BL-182 stage 1 (FO-REQ-0023 §4 C4 "read-only calendar for agents and the Producer: published / scheduled / gaps for the past 14 and
// the next 14 days"; D "a channel never synced must not produce a false alert"). Days are UTC dates (the owner publishes at 12:00Z).

const NOW = new Date("2026-10-13T11:00:00Z");
const VIDEOS: CalendarSourceVideo[] = [
  { videoId: "old", title: "old", privacyStatus: "public", publishedAt: "2026-09-20T12:00:00Z", publishAt: null },
  { videoId: "p", title: "p", privacyStatus: "public", publishedAt: "2026-10-12T12:00:00Z", publishAt: null },
  { videoId: "s1", title: "s1", privacyStatus: "private", publishedAt: "2026-10-10T09:00:00Z", publishAt: "2026-10-13T12:00:00Z" },
  { videoId: "s2", title: "s2", privacyStatus: "private", publishedAt: "2026-10-10T09:00:00Z", publishAt: "2026-10-14T12:00:00Z" },
  { videoId: "far", title: "far", privacyStatus: "private", publishedAt: "2026-10-10T09:00:00Z", publishAt: "2026-11-30T12:00:00Z" },
  { videoId: "u", title: "u", privacyStatus: "private", publishedAt: "2026-10-11T09:00:00Z", publishAt: null },
];

function reads(opts: { lastSyncedAt?: Date | null; active?: string } = {}) {
  return createPublishingCalendarReads({
    listVideos: async () => VIDEOS,
    getChannel: async () => ({ lastSyncedAt: opts.lastSyncedAt === undefined ? new Date("2026-10-13T10:00:00Z") : opts.lastSyncedAt }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== (opts.active ?? "UC_A")) throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
    },
    clock: { now: () => NOW },
  });
}

test("agent calendar: the past and next 14 UTC days, the undated uploads apart, and the days without a video", async () => {
  const calendar = await reads().getAgentCalendar({ credentialRef: { userId: "u1" }, channelId: "UC_A" });
  assert.deepEqual(calendar.window, { from: "2026-09-29", to: "2026-10-27" });
  assert.deepEqual(calendar.entries.map((e) => [e.videoId, e.kind]), [
    ["p", "published"],
    ["s1", "scheduled"],
    ["s2", "scheduled"],
  ]);
  assert.deepEqual(calendar.unscheduled.map((e) => e.videoId), ["u"]);
  // 13.10 and 14.10 are filled; 15.10 .. 26.10 are the gaps (14 days from today).
  assert.equal(calendar.gapDates.length, 12);
  assert.deepEqual([calendar.gapDates[0], calendar.gapDates[11]], ["2026-10-15", "2026-10-26"]);
  // "far" is scheduled (outside the window) and still counts for the coverage.
  assert.equal(calendar.coverage.coveredThrough, "2026-11-30T12:00:00Z");
  assert.equal(calendar.coverage.due, false);
  assert.equal(calendar.lastSyncedAt, "2026-10-13T10:00:00.000Z");
});

test("agent calendar: only the caller's active channel", async () => {
  await assert.rejects(reads({ active: "UC_B" }).getAgentCalendar({ credentialRef: { userId: "u1" }, channelId: "UC_A" }), (e: unknown) => e instanceof DomainError);
});

test("alert: a channel never synced gives no alert; a synced one gives its coverage", async () => {
  assert.equal(await reads({ lastSyncedAt: null }).getAlert({ channelId: "UC_A" }), null);
  const alert = await reads().getAlert({ channelId: "UC_A" });
  assert.deepEqual([alert?.coveredThrough, alert?.due, alert?.lastSyncedAt], ["2026-11-30T12:00:00Z", false, "2026-10-13T10:00:00.000Z"]);
});
