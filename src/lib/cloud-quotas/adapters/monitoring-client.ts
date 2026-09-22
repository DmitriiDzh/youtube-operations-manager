// Raw REST calls to the Cloud Monitoring API, deliberately NOT the `googleapis` npm client --
// mirrors `src/lib/auth.ts`'s own existing convention for simple Google REST endpoints
// (`revokeGoogleToken`, `fetchGoogleIdentity`, `startGoogleDeviceAuthorization` all use plain
// `fetch`, not the `googleapis` client library). This also means this module is exempt from
// `read-gateway-inventory.test.ts`'s "no runtime import from googleapis" check by construction --
// there is nothing to import. `cloud-quotas-inventory.test.ts` is this module's own equivalent
// enforcement: no file outside this module may call `monitoring.googleapis.com` directly.
//
// `fetchImpl` is an explicit dependency (never a bare global `fetch` reference), matching
// `src/lib/ai-connections/adapters/openai-compatible.ts`'s own `FetchLike` convention -- so a
// test can never reach a real host by omission.
import { recordGatewayCallOutcome } from "@/lib/db";

export type FetchLike = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const MONITORING_BASE_URL = "https://monitoring.googleapis.com/v3";

type TimeSeriesResponse = {
  timeSeries?: Array<{ points?: Array<{ value?: { int64Value?: string } }> }>;
  nextPageToken?: string;
};

// The single choke point every real call in this module goes through (both
// `fetchDailyQuotaLimit` and `fetchDailyQuotaUsage`'s pagination loop) -- the one place traffic
// is recorded, mirroring `assertDataApiReadsAuthorized`'s own choke-point pattern
// (`src/lib/youtube-read-gateway/data-api.ts`). Never records `blocked` -- there is no
// enable/disable toggle for this category, so every attempt is allowed by definition.
async function callMonitoring(args: { url: string; accessToken: string; fetchImpl: FetchLike }): Promise<TimeSeriesResponse> {
  await recordGatewayCallOutcome("cloud_monitoring_reads", "allowed");
  const response = await args.fetchImpl(args.url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  } as RequestInit);
  const body = (await response.json().catch(() => null)) as (TimeSeriesResponse & { error?: { message?: string } }) | null;
  if (!response.ok) {
    throw new Error(`Cloud Monitoring API request failed (${response.status}): ${body?.error?.message ?? "unknown error"}`);
  }
  return body ?? {};
}

/**
 * `serviceruntime.googleapis.com/quota/limit`, filtered to `limit_name="defaultPerDayPerProject"`
 * -- a GAUGE metric, so only the most recent point matters. Returns `null` if the project has no
 * data for this metric/service combination (e.g. the API was never called from this project).
 *
 * **Window is 25h, not 1h** -- found live (2026-09-22): unlike a constant heartbeat, Google only
 * emits a fresh `quota/limit` sample when the service actually receives traffic. Data API v3
 * (near-constant traffic from channel syncs) always had a point in a 1h window; the far less
 * frequently called Analytics API did not, making its quota card silently show "unknown"
 * whenever no Analytics call had happened in the last hour, even though the connection and the
 * limit itself were both fine. 25h (a day plus buffer, matching this codebase's own established
 * pattern for daily-boundary windows, e.g. `gateway_call_events`' 7-day retention buffer around
 * its own 24h read window) makes finding at least one real sample far more reliable for an
 * infrequently-used service.
 */
export async function fetchDailyQuotaLimit(args: {
  accessToken: string;
  projectNumber: string;
  service: string;
  fetchImpl: FetchLike;
}): Promise<number | null> {
  const now = new Date();
  const startTime = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const endTime = now.toISOString();
  const filter =
    `metric.type="serviceruntime.googleapis.com/quota/limit" AND resource.type="consumer_quota" ` +
    `AND resource.labels.service="${args.service}" AND metric.labels.limit_name="defaultPerDayPerProject"`;
  const url =
    `${MONITORING_BASE_URL}/projects/${args.projectNumber}/timeSeries?filter=${encodeURIComponent(filter)}` +
    `&interval.startTime=${startTime}&interval.endTime=${endTime}`;

  const body = await callMonitoring({ url, accessToken: args.accessToken, fetchImpl: args.fetchImpl });
  const raw = body.timeSeries?.[0]?.points?.[0]?.value?.int64Value;
  return raw !== undefined ? Number(raw) : null;
}

/**
 * `serviceruntime.googleapis.com/quota/rate/net_usage` -- a DELTA metric (per-minute usage
 * deltas), summed over the last 24h client-side. Paginates via `nextPageToken` in case a busy
 * project's 24h window spans more than one page of 1-minute points.
 */
export async function fetchDailyQuotaUsage(args: {
  accessToken: string;
  projectNumber: string;
  service: string;
  fetchImpl: FetchLike;
}): Promise<number> {
  const now = new Date();
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const endTime = now.toISOString();
  const filter =
    `metric.type="serviceruntime.googleapis.com/quota/rate/net_usage" AND resource.type="consumer_quota" ` +
    `AND resource.labels.service="${args.service}"`;

  let total = 0;
  let pageToken: string | undefined;
  do {
    const url =
      `${MONITORING_BASE_URL}/projects/${args.projectNumber}/timeSeries?filter=${encodeURIComponent(filter)}` +
      `&interval.startTime=${startTime}&interval.endTime=${endTime}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const body = await callMonitoring({ url, accessToken: args.accessToken, fetchImpl: args.fetchImpl });
    for (const series of body.timeSeries ?? []) {
      for (const point of series.points ?? []) {
        const raw = point.value?.int64Value;
        if (raw !== undefined) total += Number(raw);
      }
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  return total;
}
