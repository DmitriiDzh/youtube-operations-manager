import { DomainError } from "../video-metadata/contracts";

// ---------------------------------------------------------------------------
// Classifies a real YouTube Data API v3 / YouTube Analytics API read error into a
// `youtube_quota_exceeded` DomainError when it genuinely is one, otherwise re-throws the
// original error completely unchanged (owner instruction, 2026-09-22, Telegram: "Что будет
// когда мы перейдем за лимиты по YouTube Data или аналитики?" -> "Сделай правильную обработку
// этого события... чтобы агенту это тоже было транслировано корректно").
//
// **Applied at the single client-construction choke point, not at each of the ~15 individual
// call sites** (owner instruction, same day, after seeing an earlier version that wrapped every
// call site individually: "у нас же один шлюз который взаимодействует с API, он и может и
// обрабатывать / переводить это сообщение"). `wrapYoutubeClientForQuotaClassification` wraps
// whatever `google.youtube(...)`/`google.youtubeAnalytics(...)` returns in a `Proxy`, applied
// once inside `createYoutubeClient`/`createYoutubeAnalyticsClient` -- every current call site,
// and any future one, is covered automatically with no risk of a call site "forgetting" to wrap
// itself. `callYoutubeApi` below still exists as the underlying single-call helper the proxy
// itself uses, and remains independently useful/testable.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wraps every method on one resource sub-object (e.g. `youtube.videos`, `youtube.channels`)
 * so calling it goes through `callYoutubeApi`. Lazy -- only the specific resource a caller
 * actually accesses gets wrapped, nothing about the client's other, untouched internals is
 * disturbed. */
function wrapResourceForQuotaClassification<T extends object>(resource: T): T {
  return new Proxy(resource, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          callYoutubeApi(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return value;
    },
  }) as T;
}

/**
 * Wraps a real `youtube_v3.Youtube` or `youtubeAnalytics_v2.Youtubeanalytics` client so that
 * calling ANY method on ANY of its resources (`.videos.list(...)`, `.channels.list(...)`,
 * `.reports.query(...)`, etc.) automatically goes through `classifyYoutubeReadError`. Applied
 * once, inside `createYoutubeClient`/`createYoutubeAnalyticsClient` -- the two gateway children's
 * own single choke points for constructing a real client -- so every read call site in the
 * codebase, present and future, is covered without needing to remember to wrap itself.
 *
 * **Builds a new plain object rather than `new Proxy(client, {...})` directly** -- found live
 * (2026-09-22): the real `googleapis` client defines each resource (`.channels`, `.videos`,
 * etc.) as a non-configurable, non-writable own property, and a `Proxy`'s `get` trap is required
 * by the JS spec to return that exact same value for such a property -- returning a wrapped
 * substitute throws `TypeError: 'get' on proxy: property '...' is a read-only and
 * non-configurable data property...`. This was only caught by testing against a client shaped
 * like the real one; the unit tests below use a plain object precisely because that shape
 * doesn't happen to trigger this invariant, which is exactly why it needed a live check too.
 * Copying each own property onto a fresh object via `Object.defineProperty` (not plain
 * assignment, which can silently fail to shadow a non-writable property found via the prototype
 * chain) sidesteps the invariant entirely -- the new object has no such restrictive descriptors
 * of its own to violate.
 */
export function wrapYoutubeClientForQuotaClassification<T extends object>(client: T): T {
  const wrapped: Record<PropertyKey, unknown> = Object.create(Object.getPrototypeOf(client) ?? Object.prototype);
  for (const key of Reflect.ownKeys(client)) {
    const value = Reflect.get(client, key);
    Object.defineProperty(wrapped, key, {
      value: isPlainObject(value) ? wrapResourceForQuotaClassification(value) : value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return wrapped as T;
}
