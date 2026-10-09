import { isDomainError } from "./contracts";

/**
 * What a failed background Analytics query means for its run. Shared by the day-7 / day-28 milestones (BL-166) and the stored traffic and
 * device breakdowns (BL-168), so both treat the same Google answer the same way (moved from `milestones.ts` unchanged).
 */

/** 403 reasons that are about the account, the project or the rate, never about one video. */
const SYSTEM_403_REASONS = new Set(["insufficientPermissions", "accessNotConfigured", "rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]);

/** The HTTP status and error reasons of a Google API error as the gateway rethrows it (`response.status`, `response.data.error.errors`). */
function googleErrorOf(error: unknown): { status: number | null; reasons: string[] } {
  const response = typeof error === "object" && error !== null ? (error as { response?: unknown }).response : undefined;
  if (typeof response !== "object" || response === null) return { status: null, reasons: [] };
  const { status, data } = response as { status?: unknown; data?: { error?: { errors?: unknown } } };
  const entries = Array.isArray(data?.error?.errors) ? (data.error.errors as unknown[]) : [];
  return {
    status: typeof status === "number" ? status : null,
    reasons: entries.flatMap((entry) => (typeof entry === "object" && entry !== null && typeof (entry as { reason?: unknown }).reason === "string" ? [(entry as { reason: string }).reason] : [])),
  };
}

/**
 * What a failed query means for the run (reviews of BL-166):
 * - `stop`: nothing about one video -- reads off, quota, sign-in, channel access, a 401, a 403 about permissions, the project or the
 *   rate. The run stops and nothing is recorded.
 * - `defer`: no usable answer -- no HTTP answer at all (offline, DNS, timeout), 429, 5xx. Most likely an outage, so the run stops too,
 *   but this item is put back by a day without counting an attempt, so a video that keeps getting such answers cannot hold the
 *   channel's queue.
 * - `attempt`: an answer about the query itself (400, 404, another 403, any other error) -- one of the item's attempts.
 */
export function failureKind(error: unknown): "stop" | "defer" | "attempt" {
  if (isDomainError(error)) {
    const code = String(error.code);
    const stops =
      code === "analytics_reads_disabled" ||
      code === "youtube_quota_exceeded" ||
      code === "unauthorized" ||
      code === "CHANNEL_NOT_ACTIVE" ||
      code.startsWith("AUTH_");
    return stops ? "stop" : "attempt";
  }
  const { status, reasons } = googleErrorOf(error);
  if (status === null || status === 429 || status >= 500) return "defer";
  if (status === 401 || (status === 403 && reasons.some((reason) => SYSTEM_403_REASONS.has(reason)))) return "stop";
  return "attempt";
}
