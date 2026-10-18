import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { CHANNEL_SUBJECT, createBreakdownServices, isChannelBreakdownPeriodStored, type BreakdownDependencies, type StoredBreakdownRow } from "./breakdowns";

// BL-197 acceptance (owner, Telegram 2026-10-18, msg 2988): the Content tab's traffic sources (and the Audience tab's devices, stored the
// same way since BL-168) are answered from the stored channel days when they cover the period, with no YouTube call. Expected sums are
// worked out by hand from the rows below. Coverage: every day within the stored range, except the newest 2 days (the Analytics API lag,
// ANALYTICS_REPORTING_LAG_DAYS) -- on 2026-10-18 the days after 10-16 count as covered.

const NOW = new Date("2026-10-18T12:00:00Z");
const CREDENTIAL = { userId: "user-1" };

const ROWS: StoredBreakdownRow[] = [
  { subject: CHANNEL_SUBJECT, breakdown: "traffic_source", day: "2026-10-01", value: "YT_SEARCH", views: 5, estimatedMinutesWatched: 50 },
  { subject: CHANNEL_SUBJECT, breakdown: "traffic_source", day: "2026-10-02", value: "YT_SEARCH", views: 7, estimatedMinutesWatched: 70 },
  { subject: CHANNEL_SUBJECT, breakdown: "traffic_source", day: "2026-10-01", value: "SUBSCRIBER", views: 20, estimatedMinutesWatched: 9 },
  { subject: CHANNEL_SUBJECT, breakdown: "traffic_source", day: "2026-09-30", value: "SUBSCRIBER", views: 1000, estimatedMinutesWatched: 1 },
  { subject: CHANNEL_SUBJECT, breakdown: "device_type", day: "2026-10-01", value: "MOBILE", views: 3, estimatedMinutesWatched: 40 },
  { subject: CHANNEL_SUBJECT, breakdown: "device_type", day: "2026-10-02", value: "DESKTOP", views: 9, estimatedMinutesWatched: 15 },
  { subject: CHANNEL_SUBJECT, breakdown: "device_type", day: "2026-10-03", value: "MOBILE", views: 1, estimatedMinutesWatched: null },
];

function services(state: { rangeStart: string; collectedThrough: string | null } | null, options: { activeChannel?: string } = {}) {
  const live: string[] = [];
  const deps = {
    clock: { now: () => NOW },
    authResolver: { resolve: async () => ({ accessToken: "t" }) },
    channelAccess: {
      assertActiveChannel: async ({ channelId }: { channelId: string }) => {
        if (channelId !== (options.activeChannel ?? "UC_own")) throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
        return channelId;
      },
    },
    videoStore: { listVideos: async () => [] },
    youtubeApi: {
      queryChannelBreakdownReport: async () => {
        live.push("reports.query");
        return [];
      },
    },
    store: {
      listStates: async () =>
        state
          ? [{ subject: CHANNEL_SUBJECT, rangeStart: state.rangeStart, collectedThrough: state.collectedThrough, collectedOn: null, collectedAt: null, status: "collected" as const, nextAttemptAt: null, attempts: 0, lastError: null }]
          : [],
      saveCollected: async () => undefined,
      defer: async () => undefined,
      recordFailure: async () => "retry" as const,
      listRows: async (_channelId: string, subjects: string[], startDate: string, endDate: string) =>
        ROWS.filter((row) => subjects.includes(row.subject) && row.day >= startDate && row.day <= endDate),
    },
  } as unknown as BreakdownDependencies;
  return { core: createBreakdownServices(deps), live };
}

const ask = (breakdown: string, startDate: string, endDate: string, channelId = "UC_own") => ({ credentialRef: CREDENTIAL, channelId, startDate, endDate, breakdown });

test("stored breakdown: traffic sources summed over the period, views only, most views first", async () => {
  const { core, live } = services({ rangeStart: "2026-07-20", collectedThrough: "2026-10-16" });
  assert.deepEqual(await core.answerChannelBreakdownFromStore(ask("trafficSources", "2026-10-01", "2026-10-17")), {
    channelId: "UC_own",
    breakdown: "trafficSources",
    startDate: "2026-10-01",
    endDate: "2026-10-17",
    rows: [
      { dimensionValues: ["SUBSCRIBER"], metrics: { views: 20 } },
      { dimensionValues: ["YT_SEARCH"], metrics: { views: 12 } },
    ],
  });
  assert.deepEqual(live, []);
});

test("stored breakdown: devices use watch time (the card's metric); a missing value counts as 0", async () => {
  const { core } = services({ rangeStart: "2026-07-20", collectedThrough: "2026-10-16" });
  const result = await core.answerChannelBreakdownFromStore(ask("deviceType", "2026-10-01", "2026-10-17"));
  assert.deepEqual(result?.rows, [
    { dimensionValues: ["MOBILE"], metrics: { estimatedMinutesWatched: 40 } },
    { dimensionValues: ["DESKTOP"], metrics: { estimatedMinutesWatched: 15 } },
  ]);
});

test("stored breakdown: a day after the last collected one and older than the lag is not covered -- null (read live)", async () => {
  // Through 10-15: 10-16 is neither collected nor within the 2-day lag on 10-18.
  const { core } = services({ rangeStart: "2026-07-20", collectedThrough: "2026-10-15" });
  assert.equal(await core.answerChannelBreakdownFromStore(ask("trafficSources", "2026-10-01", "2026-10-17")), null);
  // The same store answers a period that ends on its last collected day.
  assert.notEqual(await core.answerChannelBreakdownFromStore(ask("trafficSources", "2026-10-01", "2026-10-15")), null);
});

test("stored breakdown: a period starting before the stored range, or never collected, is null", async () => {
  assert.equal(await services({ rangeStart: "2026-10-02", collectedThrough: "2026-10-16" }).core.answerChannelBreakdownFromStore(ask("trafficSources", "2026-10-01", "2026-10-10")), null);
  assert.equal(await services({ rangeStart: "2026-07-20", collectedThrough: null }).core.answerChannelBreakdownFromStore(ask("trafficSources", "2026-10-01", "2026-10-10")), null);
  assert.equal(await services(null).core.answerChannelBreakdownFromStore(ask("trafficSources", "2026-10-01", "2026-10-10")), null);
});

test("stored breakdown: the cards that are not stored (geography, age/gender, ...) are null", async () => {
  const { core } = services({ rangeStart: "2026-07-20", collectedThrough: "2026-10-16" });
  for (const breakdown of ["geography", "ageGender", "subscribedStatus", "contentFormat"]) {
    assert.equal(await core.answerChannelBreakdownFromStore(ask(breakdown, "2026-10-01", "2026-10-10")), null);
  }
});

test("stored breakdown: another channel than the session's active one is refused, as the live read refuses it", async () => {
  const { core } = services({ rangeStart: "2026-07-20", collectedThrough: "2026-10-16" });
  await assert.rejects(core.answerChannelBreakdownFromStore(ask("trafficSources", "2026-10-01", "2026-10-10", "UC_other")), /not active/);
});

test("stored breakdown coverage: the lag boundary on 2026-10-18 is 10-16 (not covered unless collected) / 10-17 (covered)", () => {
  const state = { rangeStart: "2026-07-20", collectedThrough: "2026-10-15" };
  assert.equal(isChannelBreakdownPeriodStored({ state, startDate: "2026-10-17", endDate: "2026-10-17", now: NOW }), true);
  assert.equal(isChannelBreakdownPeriodStored({ state, startDate: "2026-10-16", endDate: "2026-10-16", now: NOW }), false);
  assert.equal(isChannelBreakdownPeriodStored({ state, startDate: "2026-07-20", endDate: "2026-10-15", now: NOW }), true);
  assert.equal(isChannelBreakdownPeriodStored({ state, startDate: "2026-07-19", endDate: "2026-10-15", now: NOW }), false);
});
