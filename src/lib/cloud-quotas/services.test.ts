import assert from "node:assert/strict";
import test from "node:test";
import { createCloudQuotasServices } from "./services";
import type { FetchLike } from "./adapters/monitoring-client";

function createFixture(opts: {
  connected?: boolean;
  projectNumber?: string | null;
  limitByService?: Record<string, number | null>;
  usageByService?: Record<string, number>;
  throwForService?: string;
  monitoringPerMinuteLimit?: number | null;
  monitoringPerMinuteUsage?: number;
  throwForMonitoringOwnQuota?: boolean;
  throwOnResolveCredentials?: boolean;
}) {
  const cloudConnection = {
    async getStatus() {
      return { connected: opts.connected ?? true };
    },
    async resolveCloudCredentials() {
      if (opts.throwOnResolveCredentials) throw new Error("Cloud connection token refresh failed");
      return { accessToken: "fake-access-token" };
    },
  };

  let monitoringCallCount = 0;
  const usageSinceByService: Record<string, string | undefined> = {};
  const monitoringClient = {
    async fetchDailyQuotaLimit(args: { service: string }) {
      monitoringCallCount += 1;
      if (args.service === opts.throwForService) throw new Error("simulated Monitoring API failure");
      return opts.limitByService?.[args.service] ?? null;
    },
    async fetchDailyQuotaUsage(args: { service: string; since?: Date }) {
      usageSinceByService[args.service] = args.since?.toISOString();
      monitoringCallCount += 1;
      if (args.service === opts.throwForService) throw new Error("simulated Monitoring API failure");
      return opts.usageByService?.[args.service] ?? 0;
    },
    async fetchPerMinuteQuotaLimit() {
      monitoringCallCount += 1;
      if (opts.throwForMonitoringOwnQuota) throw new Error("simulated Monitoring API failure");
      return opts.monitoringPerMinuteLimit ?? null;
    },
    async fetchLatestMinuteUsage() {
      monitoringCallCount += 1;
      if (opts.throwForMonitoringOwnQuota) throw new Error("simulated Monitoring API failure");
      return opts.monitoringPerMinuteUsage ?? 0;
    },
  };

  const services = createCloudQuotasServices({
    cloudConnection,
    monitoringClient,
    fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as FetchLike,
    projectNumber: opts.projectNumber ?? "131970858038",
    now: () => new Date("2026-10-03T18:00:00Z"), // 11:00 PDT: the Data API quota day started 2026-10-03T07:00:00Z
  });

  return { services, getMonitoringCallCount: () => monitoringCallCount, usageSinceByService };
}

// Independent test-suite audit (2026-09-26): this test's own title claimed "never calls the real
// APIs" but the fixture had no call-tracking at all -- production code is correct today (it
// early-returns before any monitoringClient call), but nothing here would have caught a
// regression that started calling the API anyway before discarding the result.
test("getQuotaStatus: not connected -> connected: false, all three services unknown, never calls the real APIs", async () => {
  const { services, getMonitoringCallCount } = createFixture({ connected: false });
  const status = await services.getQuotaStatus();
  assert.deepEqual(status, { connected: false, dataApi: null, analytics: null, reporting: null, monitoring: null });
  assert.equal(getMonitoringCallCount(), 0, "no monitoringClient method should be called when not connected");
});

test("getQuotaStatus: no project number derivable (GOOGLE_CLIENT_ID unset/malformed) -> degrades to unknown rather than throwing", async () => {
  const { services } = createFixture({ connected: true, projectNumber: null });
  const status = await services.getQuotaStatus();
  assert.deepEqual(status, { connected: true, dataApi: null, analytics: null, reporting: null, monitoring: null });
});

// Real confirmed numbers from the live spike (2026-09-22): Data API v3 limit 10,000/day,
// Analytics API limit 100,000/day -- distinct pools, exactly matching the owner's "Live writes +
// Data reads share one counter, Analytics is separate" instruction. Cloud Monitoring's own quota
// (added same day, owner: "Не вижу прогресс бара у Google Cloud connection") uses a DIFFERENT
// shape -- `usedLastMinute`, not `usedLast24h` -- because this service has no daily quota at all
// in this project, only a real per-minute one (6000/min, confirmed live).
test("getQuotaStatus: connected -> returns real limit/usage per service, all kept separate", async () => {
  const { services } = createFixture({
    connected: true,
    limitByService: { "youtube.googleapis.com": 10000, "youtubeanalytics.googleapis.com": 100000, "youtubereporting.googleapis.com": 20000 },
    usageByService: { "youtube.googleapis.com": 42, "youtubeanalytics.googleapis.com": 28, "youtubereporting.googleapis.com": 3 },
    monitoringPerMinuteLimit: 6000,
    monitoringPerMinuteUsage: 8,
  });

  const status = await services.getQuotaStatus();

  assert.deepEqual(status, {
    connected: true,
    dataApi: { limit: 10000, usedLast24h: 42, window: "since_reset", resetsAt: "2026-10-04T07:00:00.000Z" },
    analytics: { limit: 100000, usedLast24h: 28, window: "rolling_24h", resetsAt: null },
    reporting: { limit: 20000, usedLast24h: 3, window: "rolling_24h", resetsAt: null },
    monitoring: { limit: 6000, usedLastMinute: 8 },
  });
});

test("getQuotaStatus: one service's real call fails -> that service is null, the others are unaffected", async () => {
  const { services } = createFixture({
    connected: true,
    limitByService: { "youtubeanalytics.googleapis.com": 100000 },
    usageByService: { "youtubeanalytics.googleapis.com": 28 },
    throwForService: "youtube.googleapis.com",
    monitoringPerMinuteLimit: 6000,
    monitoringPerMinuteUsage: 8,
  });

  const status = await services.getQuotaStatus();

  assert.deepEqual(status, {
    connected: true,
    dataApi: null,
    analytics: { limit: 100000, usedLast24h: 28, window: "rolling_24h", resetsAt: null },
    reporting: null,
    monitoring: { limit: 6000, usedLastMinute: 8 },
  });
});

test("getQuotaStatus: a service the Monitoring API has no limit data for -> null for that service, not a fabricated 0", async () => {
  const { services } = createFixture({
    connected: true,
    limitByService: { "youtube.googleapis.com": null },
    usageByService: { "youtube.googleapis.com": 5 },
  });

  const status = await services.getQuotaStatus();

  assert.equal(status.dataApi, null);
});

test("getQuotaStatus: Cloud Monitoring's own per-minute quota query fails -> monitoring is null, dataApi/analytics unaffected", async () => {
  const { services } = createFixture({
    connected: true,
    limitByService: { "youtube.googleapis.com": 10000, "youtubeanalytics.googleapis.com": 100000 },
    usageByService: { "youtube.googleapis.com": 42, "youtubeanalytics.googleapis.com": 28 },
    throwForMonitoringOwnQuota: true,
  });

  const status = await services.getQuotaStatus();

  assert.deepEqual(status, {
    connected: true,
    dataApi: { limit: 10000, usedLast24h: 42, window: "since_reset", resetsAt: "2026-10-04T07:00:00.000Z" },
    analytics: { limit: 100000, usedLast24h: 28, window: "rolling_24h", resetsAt: null },
    reporting: null,
    monitoring: null,
  });
});

// Found live 2026-09-30: a revoked Cloud grant made resolveCloudCredentials throw, which propagated
// out of GET /api/settings as a 500 and broke the whole Settings tab. It must degrade like any other
// quota failure: connected, all three unknown, no Monitoring call attempted.
// BL-126 (requirement change, not an implementation convenience): the UI must be able to tell "connected but the grant expired"
// from "not connected" so it can say "reconnect" instead of showing nothing, hence the extra `tokenRefreshFailed: true`. The
// not-connected case above deliberately has no such flag.
test("getQuotaStatus: Cloud credentials cannot be refreshed -> degrades to unknown rather than throwing, and says the token refresh failed", async () => {
  const { services, getMonitoringCallCount } = createFixture({ connected: true, throwOnResolveCredentials: true });
  const status = await services.getQuotaStatus();
  assert.deepEqual(status, { connected: true, tokenRefreshFailed: true, dataApi: null, analytics: null, reporting: null, monitoring: null });
  assert.equal(getMonitoringCallCount(), 0);
});

test("getQuotaStatus: Data API usage is summed SINCE the last Pacific midnight (reset time known); Analytics keeps the rolling 24 h with no reset time", async () => {
  const { services, usageSinceByService } = createFixture({
    connected: true,
    limitByService: { "youtube.googleapis.com": 10000, "youtubeanalytics.googleapis.com": 100000 },
    usageByService: { "youtube.googleapis.com": 1, "youtubeanalytics.googleapis.com": 1 },
  });
  const status = await services.getQuotaStatus();
  assert.equal(usageSinceByService["youtube.googleapis.com"], "2026-10-03T07:00:00.000Z");
  assert.equal(usageSinceByService["youtubeanalytics.googleapis.com"], undefined, "rolling window: no `since`");
  assert.equal(status.dataApi?.window, "since_reset");
  assert.equal(status.dataApi?.resetsAt, "2026-10-04T07:00:00.000Z");
  assert.equal(status.analytics?.resetsAt, null);
});
