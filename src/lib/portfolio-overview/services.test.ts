import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import { initializeDatabaseSchema, insertProducerCallLogEntry, listProducerCallLogEntries, type AppDb } from "@/lib/db";
import type { PortfolioChannelSource } from "./contracts";
import { buildPortfolioRow, createPortfolioOverviewServices } from "./services";

// Expected values from docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §3 (AC-PR-08: sums of stored rows, computed by hand below; a source
// with nothing stored is null, never zero) and FO-REQ-0012 §2.3 (views, watch time, subscribers, impressions, CTR, uploads,
// freshness side by side). AC-PR-09's log retention (90 days) on a real database at the end.

const RANGE = { startDate: "2026-10-01", endDate: "2026-10-07" };

const tropico: PortfolioChannelSource = {
  channelId: "UC_T",
  title: "Tropico Jazz",
  metrics: [
    { metricDate: "2026-10-01", metricName: "views", metricValue: 120 },
    { metricDate: "2026-10-02", metricName: "views", metricValue: 80 },
    { metricDate: "2026-10-01", metricName: "estimatedMinutesWatched", metricValue: 300 },
    { metricDate: "2026-10-02", metricName: "estimatedMinutesWatched", metricValue: 150.5 },
    { metricDate: "2026-10-02", metricName: "subscribersGained", metricValue: 3 },
    { metricDate: "2026-10-02", metricName: "subscribersLost", metricValue: 1 },
    // Outside the range: never counted.
    { metricDate: "2026-09-30", metricName: "views", metricValue: 1000 },
  ],
  reach: { state: "ready", impressions: 5400, ctr: 0.042, coveredThrough: "2026-10-05" },
  videoPublishedAt: ["2026-09-30T23:59:59Z", "2026-10-01T00:00:00Z", "2026-10-07T23:00:00Z", "2026-10-08T00:00:01Z", "not a date"],
  lastVideoSyncAt: new Date("2026-10-08T09:00:00Z"),
  lastAnalyticsCollectedAt: new Date("2026-10-08T06:00:00Z"),
};

const japan: PortfolioChannelSource = {
  channelId: "UC_J",
  title: "Rural Japan Music",
  metrics: [],
  reach: { state: "waiting_for_first_report", impressions: 0, ctr: null, coveredThrough: null },
  videoPublishedAt: [],
  lastVideoSyncAt: null,
  lastAnalyticsCollectedAt: null,
};

test("AC-PR-08: a channel's row adds up its stored data for the range", () => {
  assert.deepEqual(buildPortfolioRow(tropico, RANGE), {
    channelId: "UC_T",
    title: "Tropico Jazz",
    // 120 + 80 views; 300 + 150.5 minutes; days with data: 10-01 and 10-02.
    analytics: { daysWithData: 2, views: 200, watchMinutes: 450.5, subscribersGained: 3, subscribersLost: 1 },
    reach: { state: "ready", impressions: 5400, ctr: 0.042 },
    // 10-01 00:00 and 10-07 23:00 are inside; 09-30 23:59:59, 10-08 and the unreadable date are not.
    uploads: 2,
    freshness: { lastVideoSyncAt: "2026-10-08T09:00:00.000Z", lastAnalyticsCollectedAt: "2026-10-08T06:00:00.000Z", reachCoveredThrough: "2026-10-05" },
  });
});

test("AC-PR-08: nothing stored is null, never zero; Reach that is not ready shows no figures", () => {
  assert.deepEqual(buildPortfolioRow(japan, RANGE), {
    channelId: "UC_J",
    title: "Rural Japan Music",
    analytics: { daysWithData: 0, views: null, watchMinutes: null, subscribersGained: null, subscribersLost: null },
    reach: { state: "waiting_for_first_report", impressions: null, ctr: null },
    uploads: 0,
    freshness: { lastVideoSyncAt: null, lastAnalyticsCollectedAt: null, reachCoveredThrough: null },
  });
  assert.deepEqual(buildPortfolioRow({ ...japan, reach: null }, RANGE).reach, { state: "unavailable", impressions: null, ctr: null });
  // A metric absent on days that have others is null too (no subscribers rows at all): not zero.
  const viewsOnly = buildPortfolioRow({ ...japan, metrics: [{ metricDate: "2026-10-03", metricName: "views", metricValue: 7 }] }, RANGE);
  assert.deepEqual(viewsOnly.analytics, { daysWithData: 1, views: 7, watchMinutes: null, subscribersGained: null, subscribersLost: null });
});

test("AC-PR-08: the overview has one row per connected channel, in the listed order", async () => {
  const loaded: string[] = [];
  const services = createPortfolioOverviewServices({
    listChannels: async () => [
      { channelId: "UC_J", title: "Rural Japan Music" },
      { channelId: "UC_T", title: "Tropico Jazz" },
    ],
    loadChannel: async (channel, range) => {
      loaded.push(`${channel.channelId}:${range.startDate}..${range.endDate}`);
      return channel.channelId === "UC_T" ? tropico : japan;
    },
  });
  const overview = await services.getOverview(RANGE);
  assert.equal(overview.source, "local");
  assert.deepEqual(overview.channels.map((row) => row.channelId), ["UC_J", "UC_T"]);
  assert.deepEqual(loaded.sort(), ["UC_J:2026-10-01..2026-10-07", "UC_T:2026-10-01..2026-10-07"]);
});

test("AC-PR-09 (real database, v72): the Producer call log keeps 90 days, newest first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "producer-call-log-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const database = drizzle(client) as unknown as AppDb;
    const day = 24 * 60 * 60_000;
    const now = new Date("2026-10-09T12:00:00Z");
    await insertProducerCallLogEntry({ at: new Date(now.getTime() - 91 * day), tool: "old", channelId: "UC_T", outcome: "ok", errorCode: null }, database);
    await insertProducerCallLogEntry({ at: new Date(now.getTime() - 89 * day), tool: "kept", channelId: null, outcome: "error", errorCode: "CHANNEL_NOT_ACTIVE" }, database);
    await insertProducerCallLogEntry({ at: now, tool: "agent_query_channel_reach", channelId: "UC_J", outcome: "ok", errorCode: null }, database);
    const entries = await listProducerCallLogEntries(10, database);
    assert.deepEqual(
      entries.map((entry) => [entry.tool, entry.channelId, entry.outcome, entry.errorCode]),
      [
        ["agent_query_channel_reach", "UC_J", "ok", null],
        ["kept", null, "error", "CHANNEL_NOT_ACTIVE"],
      ]
    );
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
