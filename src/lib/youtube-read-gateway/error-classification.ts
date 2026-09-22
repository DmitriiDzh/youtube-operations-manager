import { DomainError } from "../video-metadata/contracts";

// ---------------------------------------------------------------------------
// Classifies a real YouTube Data API v3 / YouTube Analytics API read error into a
// `youtube_quota_exceeded` DomainError when it genuinely is one, otherwise re-throws the
// original error completely unchanged (owner instruction, 2026-09-22, Telegram: "Что будет
// когда мы перейдем за лимиты по YouTube Data или аналитики?" -> "Сделай правильную обработку
// этого события... чтобы агенту это тоже было транслировано корректно").
//
// Mirrors `src/lib/batches/adapters/write-executor.youtube.ts`'s `classifyYoutubeWriteError`'s
// already-proven error-shape probing (`error.response.status`,
// `.data.error.errors[].reason`) -- confirmed against real Google API error objects there --
// but is a DELIBERATELY SEPARATE classifier, not a reuse of that one: the write side's
// `quotaExceeded` maps to `FAILED/permanent/systemic` (AC-QUOTA-02, halts the whole batch,
// Phase 5 acceptance-tested behavior) -- reads have no such "halt" concept, they just need the
// caller (human or agent) to see a clear, distinct signal instead of a generic/opaque error.
// Do not "unify" these two classifiers -- they serve different outcome types for different
// call sites with different established acceptance criteria.
//
// Deliberately does NOT compute or include a reset timestamp: YouTube Data API v3's quota is
// documented to reset at midnight Pacific Time, but the YouTube Analytics API's own reset
// boundary has not been separately verified, and this one classifier covers both gateway
// children. A confidently-wrong machine-readable `resetAt` would be worse than none -- an
// agent could schedule a retry against it. The message states the same fact Google's own error
// text does (quota, no timestamp) and nothing more.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Throws (never returns) a `youtube_quota_exceeded` `DomainError` if `error` is a real Google
 * API 403 with a `quotaExceeded`/`dailyLimitExceeded` reason; otherwise re-throws `error`
 * completely unchanged (same object, same shape) so every other error path -- forbidden,
 * notFound, network failure, etc. -- behaves exactly as it did before this function existed.
 */
export function classifyYoutubeReadError(error: unknown): never {
  const response = isRecord(error) && isRecord(error.response) ? error.response : undefined;
  const status = typeof response?.status === "number" ? response.status : undefined;

  if (status === 403) {
    const errorBody = isRecord(response?.data) && isRecord(response.data.error) ? response.data.error : undefined;
    const reasonsRaw = Array.isArray(errorBody?.errors) ? errorBody.errors : [];
    const reasons = reasonsRaw
      .map((entry) => (isRecord(entry) && typeof entry.reason === "string" ? entry.reason : undefined))
      .filter((reason): reason is string => Boolean(reason));

    if (reasons.includes("quotaExceeded") || reasons.includes("dailyLimitExceeded")) {
      throw new DomainError({
        code: "youtube_quota_exceeded",
        message:
          "YouTube API quota exceeded for today. Quota resets daily at midnight Pacific Time " +
          "(per Google's documentation). This is not a bug -- wait for the reset or reduce API usage.",
        details: { reasons },
      });
    }
  }

  throw error;
}

/** Wraps one real API call, applying `classifyYoutubeReadError` to whatever it throws. Every
 * real `youtube.*.list(...)`/`youtubeAnalytics.reports.query(...)` call in this gateway's two
 * children goes through this, so a caller anywhere in the app that hits real quota exhaustion
 * always sees the same, single, correctly-classified error -- never a raw googleapis error one
 * call site remembered to handle and another didn't. */
export async function callYoutubeApi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    return classifyYoutubeReadError(error);
  }
}
