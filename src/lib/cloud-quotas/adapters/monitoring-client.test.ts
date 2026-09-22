import assert from "node:assert/strict";
import test from "node:test";
import { fetchDailyQuotaLimit, fetchDailyQuotaUsage, type FetchLike } from "./monitoring-client";

// Fixture shapes below are copied from the REAL Cloud Monitoring API responses captured during a
// live spike against a real, connected Google Cloud project (2026-09-22) -- not invented, and not
// derived by running this module's own code (AGENTS.md §L). Real confirmed numbers: Data API v3
// (youtube.googleapis.com) daily limit 10,000; a real 28-video Analytics collection run showed up
// as a usage delta of exactly 28 in the same minute.

function fakeFetch(responses: Array<{ status: number; body: unknown }>): FetchLike {
  let call = 0;
  return async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    };
  };
}

test("fetchDailyQuotaLimit: parses the real quota/limit response shape, returns the defaultPerDayPerProject value", async () => {
  const fetchImpl = fakeFetch([
    {
      status: 200,
      body: {
        timeSeries: [
          {
            metric: { labels: { limit_name: "defaultPerDayPerProject", quota_metric: "youtube.googleapis.com/default" } },
            points: [{ interval: { endTime: "2026-09-22T16:02:15Z" }, value: { int64Value: "10000" } }],
          },
        ],
      },
    },
  ]);

  const limit = await fetchDailyQuotaLimit({
    accessToken: "fake-token",
    projectNumber: "131970858038",
    service: "youtube.googleapis.com",
    fetchImpl,
  });

  assert.equal(limit, 10000);
});

test("fetchDailyQuotaLimit: no time series in the response -> null, never a fabricated number", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { timeSeries: undefined } }]);

  const limit = await fetchDailyQuotaLimit({
    accessToken: "fake-token",
    projectNumber: "131970858038",
    service: "youtube.googleapis.com",
    fetchImpl,
  });

  assert.equal(limit, null);
});

test("fetchDailyQuotaLimit: a non-2xx response throws with the real error message, never silently returns null", async () => {
  const fetchImpl = fakeFetch([
    { status: 403, body: { error: { message: "Cloud Monitoring API has not been used in project 131970858038 before or it is disabled." } } },
  ]);

  await assert.rejects(
    () =>
      fetchDailyQuotaLimit({
        accessToken: "fake-token",
        projectNumber: "131970858038",
        service: "youtube.googleapis.com",
        fetchImpl,
      }),
    /disabled/
  );
});

test("fetchDailyQuotaUsage: sums DELTA points across a single page (real shape: several 1-minute deltas)", async () => {
  const fetchImpl = fakeFetch([
    {
      status: 200,
      body: {
        timeSeries: [
          {
            points: [
              { value: { int64Value: "4" } },
              { value: { int64Value: "2" } },
              { value: { int64Value: "5" } },
            ],
          },
        ],
      },
    },
  ]);

  const used = await fetchDailyQuotaUsage({
    accessToken: "fake-token",
    projectNumber: "131970858038",
    service: "youtube.googleapis.com",
    fetchImpl,
  });

  assert.equal(used, 11);
});

test("fetchDailyQuotaUsage: paginates via nextPageToken and sums across every page", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { timeSeries: [{ points: [{ value: { int64Value: "28" } }] }], nextPageToken: "page-2" } },
    { status: 200, body: { timeSeries: [{ points: [{ value: { int64Value: "15" } }] }] } },
  ]);

  const used = await fetchDailyQuotaUsage({
    accessToken: "fake-token",
    projectNumber: "131970858038",
    service: "youtubeanalytics.googleapis.com",
    fetchImpl,
  });

  assert.equal(used, 43);
});

test("fetchDailyQuotaUsage: no time series at all -> 0, not an error (genuinely zero usage is valid)", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: {} }]);

  const used = await fetchDailyQuotaUsage({
    accessToken: "fake-token",
    projectNumber: "131970858038",
    service: "youtube.googleapis.com",
    fetchImpl,
  });

  assert.equal(used, 0);
});
