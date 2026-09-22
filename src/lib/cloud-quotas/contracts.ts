import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// Cloud quotas: real Google Cloud quota limit/usage numbers, sourced from the Cloud Monitoring
// API (owner instruction, 2026-09-22, Telegram: "сколько наши лимиты"). Depends on
// `src/lib/cloud-connection/` for the OAuth grant -- this module never resolves credentials
// itself, mirroring the layering every other domain module in this codebase already uses.
//
// Verified live against the real, connected project (2026-09-22) that the Cloud Quotas API
// (`quotaInfos.list`) is NOT needed at all: the Cloud Monitoring API alone already exposes both
// numbers via two GA-launch metrics that exist for every project --
// `serviceruntime.googleapis.com/quota/limit` (the daily limit) and
// `serviceruntime.googleapis.com/quota/rate/net_usage` (per-minute usage deltas, summed over the
// last 24h). The BETA `quota/ratev2/*` metrics returned no data for this project and are not
// used. Confirmed real numbers at spike time: Data API v3 (youtube.googleapis.com) limit 10,000
// units/day; YouTube Analytics API (youtubeanalytics.googleapis.com) limit 100,000 units/day;
// usage deltas matched real activity exactly (e.g. a 28-video Analytics collection run showed up
// as a usage delta of 28 in the same minute).
//
// `youtube.googleapis.com` covers BOTH Data API v3 reads and Live writes -- they are the same
// Google service, just different per-call unit costs, so this module exposes ONE number for both
// (owner instruction, 2026-09-22: "Можем пока что отображать на Live write и на Data reads один
// и тот же счетчик").
// ---------------------------------------------------------------------------

export type QuotaService = "youtube.googleapis.com" | "youtubeanalytics.googleapis.com" | "monitoring.googleapis.com";

/** `null` means "unknown" -- not connected, or the real query failed -- never a fabricated 0. */
export type ServiceQuotaStatus = { limit: number; usedLast24h: number } | null;

export type CloudQuotaStatus = {
  connected: boolean;
  /** Covers Data API v3 reads AND Live writes (same underlying Google service). */
  dataApi: ServiceQuotaStatus;
  analytics: ServiceQuotaStatus;
  /** Cloud Monitoring API's own quota -- the same real numbers shown next to its own
   * `cloud_monitoring_reads` traffic counter (owner instruction, 2026-09-22: "Не вижу прогресс
   * бара у Google Cloud connection" -- the other three gateways get both a traffic count AND a
   * real quota bar; this one is no different a Google API than the others).
   *
   * **Verified live to genuinely be `null` for this project, not a bug:** unlike
   * `youtube.googleapis.com`/`youtubeanalytics.googleapis.com` (both have a
   * `defaultPerDayPerProject` limit), Cloud Monitoring API's own quota in this project is
   * modeled entirely per-MINUTE (`DefaultRequestsPerMinutePerUser`, effectively unlimited;
   * `QueryRequestsPerMinutePerProject`, 6000/min) -- there is no daily limit metric to match
   * `fetchDailyQuotaLimit`'s `defaultPerDayPerProject` filter against. `null` here honestly
   * reflects "this service has no comparable daily quota to show," not a failed query. */
  monitoring: ServiceQuotaStatus;
};
