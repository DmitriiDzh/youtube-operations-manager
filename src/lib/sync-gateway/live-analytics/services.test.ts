import assert from "node:assert/strict";
import test from "node:test";
import { liveAnalyticsReportSchema, type LiveAnalyticsReport, type SharedLiveSummary } from "./contracts";
import { createLiveAnalyticsShareCore, type LiveAnalyticsReportStore } from "./services";

// BL-222 acceptance, LIVE_ANALYTICS_PLAN.md §6: AC-LA5-01 (the strict schema holds no free text and only the four ranges) and
// AC-LA5-04 (an older peer report never replaces a newer one).

const figures = { samples: 3, onAirMs: 600_000, notLiveMs: 0, dataGaps: 0, viewerHours: 1.5, averageViewers: 9, peakViewers: 12, interruptions: 0 };
const summary = (): SharedLiveSummary => ({
  totals: figures,
  days: [{ date: "2026-10-25", ...figures }],
  hours: [{ hour: "2026-10-25T10:00:00.000Z", averageViewers: 9, peakViewers: 12 }],
  broadcasts: [{ broadcastId: "AAAAAAAAAA1", firstSampleAt: 1_761_386_400_000, lastSampleAt: 1_761_387_000_000, ...figures }],
  analytics: [{ broadcastId: "AAAAAAAAAA1", status: "collected", final: false, collectedAt: "2026-10-25T12:00:00.000Z", concurrent: { average: 8, peak: 12 }, live: { views: 40, minutesWatched: 300 }, onDemand: null }],
});
const report = (overrides: Partial<LiveAnalyticsReport> = {}): LiveAnalyticsReport => ({
  format: "ytm-live-analytics",
  version: 1,
  deviceId: "mac-1",
  hostName: "Mac mini",
  updatedAt: "2026-10-25T12:00:00.000Z",
  channels: [{ channelId: "UC1", ranges: [{ days: 7, from: "2026-10-18T12:00:00.000Z", to: "2026-10-25T12:00:00.000Z", summary: summary() }] }],
  ...overrides,
});
const withSummary = (change: (s: SharedLiveSummary) => unknown) => {
  const r = report();
  return { ...r, channels: [{ ...r.channels[0], ranges: [{ ...r.channels[0].ranges[0], summary: change(summary()) }] }] };
};

test("AC-LA5-01: a well-formed report passes, and so does one with no channels", () => {
  assert.equal(liveAnalyticsReportSchema.safeParse(report()).success, true);
  assert.equal(liveAnalyticsReportSchema.safeParse(report({ channels: [] })).success, true);
});

test("AC-LA5-01: an extra field anywhere is rejected", () => {
  assert.equal(liveAnalyticsReportSchema.safeParse({ ...report(), note: "x" }).success, false);
  assert.equal(liveAnalyticsReportSchema.safeParse({ ...report(), channels: [{ ...report().channels[0], title: "My channel" }] }).success, false);
  assert.equal(liveAnalyticsReportSchema.safeParse(withSummary((s) => ({ ...s, totals: { ...s.totals, note: "x" } }))).success, false);
  // The per-minute curve stays on the computer that pulled it.
  assert.equal(liveAnalyticsReportSchema.safeParse(withSummary((s) => ({ ...s, analytics: [{ ...s.analytics![0], curve: [[1, 2, 3]] }] }))).success, false);
});

test("AC-LA5-01: ids, dates and codes cannot hold free text", () => {
  const bad = [
    withSummary((s) => ({ ...s, broadcasts: [{ ...s.broadcasts[0], broadcastId: "https://youtu.be/x" }] })),
    withSummary((s) => ({ ...s, days: [{ ...s.days[0], date: "Monday" }] })),
    withSummary((s) => ({ ...s, hours: [{ ...s.hours[0], hour: "10 o'clock" }] })),
    withSummary((s) => ({ ...s, analytics: [{ ...s.analytics![0], status: "a long error text" }] })),
    { ...report(), hostName: "https://x/y" },
    { ...report(), channels: [{ ...report().channels[0], channelId: "UC 1 / x" }] },
  ];
  for (const r of bad) assert.equal(liveAnalyticsReportSchema.safeParse(r).success, false, JSON.stringify(r).slice(0, 200));
});

test("AC-LA5-01: only the card's ranges (1, 7, 30, 90 days) are shared", () => {
  const r = report();
  for (const days of [1, 7, 30, 90]) assert.equal(liveAnalyticsReportSchema.safeParse({ ...r, channels: [{ ...r.channels[0], ranges: [{ ...r.channels[0].ranges[0], days }] }] }).success, true, String(days));
  for (const days of [0, 3, 14, 91]) assert.equal(liveAnalyticsReportSchema.safeParse({ ...r, channels: [{ ...r.channels[0], ranges: [{ ...r.channels[0].ranges[0], days }] }] }).success, false, String(days));
});

function memoryStore(): LiveAnalyticsReportStore {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return {
    readLocal: async () => local,
    writeLocal: async (json) => {
      local = json;
    },
    readPeers: async () => ({ ...peers }),
    writePeer: async (deviceId, json) => {
      peers[deviceId] = json;
    },
  };
}

test("AC-LA5-04: a peer's newer report replaces its older one, never the other way round", async () => {
  const core = createLiveAnalyticsShareCore({ store: memoryStore(), ownDeviceId: async () => "win-1", clock: { now: () => new Date("2026-10-25T12:30:00.000Z") } });
  const bytes = (r: LiveAnalyticsReport) => new TextEncoder().encode(JSON.stringify(r));
  assert.deepEqual(await core.mergeIncoming(bytes(report()), "mac-1"), { accepted: true });
  assert.deepEqual(await core.mergeIncoming(bytes(report({ updatedAt: "2026-10-25T11:00:00.000Z", channels: [] })), "mac-1"), { accepted: false });
  const peers = await core.listPeerReports();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].channels.length, 1, "the newer report with its channel is kept");
});

test("a newer report version is refused with 'update the app'", async () => {
  const core = createLiveAnalyticsShareCore({ store: memoryStore(), ownDeviceId: async () => "win-1" });
  await assert.rejects(core.mergeIncoming(new TextEncoder().encode(JSON.stringify({ ...report(), version: 2 })), "mac-1"), /newer than this app understands/);
});
