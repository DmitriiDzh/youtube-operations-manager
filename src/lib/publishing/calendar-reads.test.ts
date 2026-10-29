import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { CalendarSourceVideo } from "./calendar";
import { agentUploadOf, createPublishingCalendarReads } from "./calendar-reads";

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

// BL-182 stage 2 (FO-REQ-0023 §4 C4: "published / scheduled / ready packages / gaps"; PUBLISHING_PLAN.md §2 stage 2 item 8: agents
// read the package and job states, never write them): the agent calendar carries the packages and this computer's uploads; a
// package read that fails says "unavailable" rather than failing the calendar.
test("agent calendar: the release packages and this computer's uploads ride along; a failed package read is 'unavailable'", async () => {
  const base = {
    listVideos: async () => VIDEOS,
    getChannel: async () => ({ lastSyncedAt: new Date("2026-10-13T10:00:00Z") }),
    assertActiveChannel: async () => undefined,
    clock: { now: () => NOW },
  };
  const items = [{ video: "V65", title: "T", plannedPublishDate: "2026-10-24", state: "not_ready", problems: ["thumbnail_missing"], videoId: null }];
  // BL-209 (Agent API 3.20.0): an upload also carries automatic / progressPercent / finishedAt -- added to the fixture, the
  // pass-through it checks is unchanged.
  const uploads = [{ video: "V64", status: "paused", publishAt: "2026-10-23T12:00:00.000Z", videoId: null, pausedReason: "live_writes_off", errorCode: null, automatic: false, progressPercent: 0, finishedAt: null }];
  const ok = await createPublishingCalendarReads({ ...base, packages: async () => ({ status: "ok", items }), uploads: async () => uploads }).getAgentCalendar({ credentialRef: { userId: "u1" }, channelId: "UC_A" });
  assert.deepEqual(ok.packages, { status: "ok", items });
  assert.deepEqual(ok.uploads, uploads);
  const failed = await createPublishingCalendarReads({
    ...base,
    packages: async () => {
      throw new Error("drive not mounted");
    },
  }).getAgentCalendar({ credentialRef: { userId: "u1" }, channelId: "UC_A" });
  assert.deepEqual([failed.packages, failed.uploads], [{ status: "unavailable" }, []]);
});

// BL-209 AC-AU-12 (AUTO_PRIVATE_UPLOAD_PLAN.md §2 item 7): the agents' calendar read reports, for each upload, whether it was queued
// automatically, its progress (stored bytes / total, as a whole percent; null when the total is unknown) and when it ended.
test("AC-AU-12: an upload's automatic flag, progressPercent and finishedAt in the agent read", () => {
  const base = { video: "V65", status: "uploading" as const, publishAt: null, videoId: null, pausedReason: null, errorCode: null, finishedAt: null };
  assert.deepEqual(agentUploadOf({ ...base, automatic: true, storedBytes: 250, totalBytes: 1000 }), {
    video: "V65",
    status: "uploading",
    publishAt: null,
    videoId: null,
    pausedReason: null,
    errorCode: null,
    automatic: true,
    progressPercent: 25,
    finishedAt: null,
  });
  // 2/3 of the bytes -> 66 (rounded down: never "100" before the last byte).
  assert.equal(agentUploadOf({ ...base, automatic: false, storedBytes: 2, totalBytes: 3 }).progressPercent, 66);
  assert.equal(agentUploadOf({ ...base, automatic: false, storedBytes: 999, totalBytes: 1000 }).progressPercent, 99);
  assert.equal(agentUploadOf({ ...base, automatic: false, storedBytes: 0, totalBytes: 0 }).progressPercent, null);
  const done = agentUploadOf({ ...base, status: "done", automatic: true, storedBytes: 1000, totalBytes: 1000, videoId: "vid1", finishedAt: new Date("2026-10-21T13:05:00Z") });
  assert.deepEqual([done.automatic, done.progressPercent, done.finishedAt, done.videoId], [true, 100, "2026-10-21T13:05:00.000Z", "vid1"]);
});

// BL-235 (owner msg 3806): with the shared daily coverage wired, the reminder and the alert follow it -- "fewer than 7 covered days
// in a row from today" -- even when a video is scheduled far ahead (`far`, 30.11: the older rule says "not due"). A failing
// coverage read never takes the calendar down: the older rule answers and `dayCoverage` is null.
function dailyStub(inARow: number, asked: number[] = []) {
  return async (_channelId: string, days: number) => {
    asked.push(days);
    return {
      channelId: "UC_A",
      asOf: "2026-10-13T10:00:00.000Z",
      timeZone: "Asia/Tokyo",
      timeZoneSource: "publishing_plan" as const,
      trackedLanguages: [],
      channelLanguage: null,
      from: "2026-10-13",
      to: "2026-10-26",
      days: [],
      summary: { covered: inARow, missingTranslations: 0, gaps: 0, coveredDaysInARow: inARow },
    };
  };
}

function readsWithDaily(dailyCoverage: (channelId: string, days: number) => ReturnType<ReturnType<typeof dailyStub>>) {
  return createPublishingCalendarReads({
    listVideos: async () => VIDEOS,
    getChannel: async () => ({ lastSyncedAt: new Date("2026-10-13T10:00:00Z") }),
    clock: { now: () => NOW },
    dailyCoverage,
  });
}

test("BL-235: the calendar's reminder is due with fewer than 7 covered days in a row; 7 is enough; 14 days are asked", async () => {
  const asked: number[] = [];
  const short = await readsWithDaily(dailyStub(2, asked)).getCalendar({ channelId: "UC_A" });
  assert.deepEqual([short.coverage.due, short.coverage.coveredDaysInARow, short.coverage.coveredThrough], [true, 2, "2026-11-30T12:00:00Z"]);
  assert.equal(short.dayCoverage?.timeZone, "Asia/Tokyo");
  assert.deepEqual(asked, [14]);
  const enough = await readsWithDaily(dailyStub(7)).getCalendar({ channelId: "UC_A" });
  assert.equal(enough.coverage.due, false);
});

test("BL-235: the alert (badge and bell) follows the same rule over 7 days", async () => {
  const asked: number[] = [];
  const alert = await readsWithDaily(dailyStub(6, asked)).getAlert({ channelId: "UC_A" });
  assert.deepEqual([alert?.due, alert?.coveredDaysInARow], [true, 6]);
  assert.deepEqual(asked, [7]);
});

test("BL-235: a failing coverage read leaves the older rule and no day coverage", async () => {
  const calendar = await readsWithDaily(async () => {
    throw new Error("coverage down");
  }).getCalendar({ channelId: "UC_A" });
  assert.deepEqual([calendar.coverage.due, calendar.dayCoverage, calendar.coverage.coveredDaysInARow], [false, null, undefined]);
});

// BL-235 review item 3: the agents' calendar gives one answer -- with the daily coverage, `gapDates` are its days that are not
// covered (the channel's dates, the translation check included) and `missingTranslationDates` those with a release lacking
// translations; without it, UTC days as before (the first test above).
test("BL-235: agent calendar gaps come from the daily coverage, in the channel's dates", async () => {
  const calendar = await createPublishingCalendarReads({
    listVideos: async () => VIDEOS,
    getChannel: async () => ({ lastSyncedAt: new Date("2026-10-13T10:00:00Z") }),
    assertActiveChannel: async () => undefined,
    clock: { now: () => NOW },
    dailyCoverage: async (channelId, days, preRead) => ({
      ...(await dailyStub(1)(channelId, days)),
      days: [
        { date: "2026-10-13", status: "covered" as const, videoIds: ["s1"], missingLanguages: [], videos: [] },
        { date: "2026-10-14", status: "missing_translations" as const, videoIds: ["s2"], missingLanguages: ["es"], videos: [] },
        { date: "2026-10-15", status: "gap" as const, videoIds: [], missingLanguages: [], videos: [] },
      ],
      // The coverage got the rows this read already has.
      trackedLanguages: preRead.videos.length === VIDEOS.length ? ["es"] : [],
    }),
  }).getAgentCalendar({ credentialRef: { userId: "u1" }, channelId: "UC_A" });
  assert.deepEqual(calendar.gapDates, ["2026-10-14", "2026-10-15"]);
  assert.deepEqual(calendar.missingTranslationDates, ["2026-10-14"]);
  assert.equal(calendar.gapDatesTimeZone, "Asia/Tokyo");
});
