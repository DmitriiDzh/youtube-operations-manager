import type { youtube_v3 } from "googleapis";
import { getLiveWritesEnabled } from "@/lib/db";
import { applyVideoMetadataUpdate } from "@/lib/youtube";
import { DomainError, type PreparedPayload, type WriteExecutor, type WriteExecutorResult } from "../contracts";
import { pickWritableSnippetFields } from "../merge";

// ---------------------------------------------------------------------------
// Phase 5, Slice 4 -- the real YouTube adapter behind the `WriteExecutor` port
// (src/lib/batches/contracts.ts). See docs/DEVELOPMENT_PLAYBOOK.md §6.5 and
// docs/acceptance/PHASE_5_ACCEPTANCE.md.
//
// This file reuses `applyVideoMetadataUpdate` (src/lib/youtube.ts), the same
// `videos.update` call already used by the existing single-item write path -- one
// YouTube client, no parallel write implementation (AGENTS.md §D).
//
// Request/response contract, verified 2026-09-18 against the official YouTube Data API
// v3 reference (developers.google.com/youtube/v3/docs/videos/update and .../videos),
// not derived from this repository's own mocks or assumptions:
//   - "If you are submitting an update request, and your request does not specify a
//     value for a property that already has a value, the property's existing value will
//     be deleted" -- and "this method will override the existing values for all of the
//     mutable properties that are contained in any parts that the parameter value
//     specifies." This is exactly why `merge.ts`'s buildSafeLocalizationsPayload always
//     spreads the FULL fresh `snippet`/`localizations` before applying targeted changes
//     (AC-MERGE-01/03/05, INV-1) -- omitting an untouched field would delete it, not
//     preserve it.
//   - `snippet.title` and `snippet.categoryId` are the only two snippet fields the API
//     itself marks as required when the `snippet` part is updated; both survive
//     automatically via the full-snippet spread above, since the fresh `videos.list`
//     fetch that seeds it always includes them for a real video.
//   - Documented errors for this method: 400 badRequest (defaultLanguageNotSet,
//     invalidCategoryId, invalidTitle, invalidDescription, invalidTags,
//     invalidVideoMetadata, invalidPublishAt, invalidRecordingDetails,
//     invalidDefaultBroadcastPrivacySetting) = permanent, never retried (§29's "invalid
//     metadata"/"invalid language" bucket); 403 forbidden/forbiddenPrivacySetting/
//     forbiddenEmbedSetting/forbiddenLicenseSetting = permanent ("insufficient
//     permissions"); 403 quotaExceeded (documented separately, API-wide, at
//     developers.google.com/youtube/v3/docs/errors) = permanent AND systemic (§29's
//     "quota exhausted", AC-QUOTA-02 -- halts the batch, never retried); 404
//     videoNotFound = permanent ("video not found"). 408/429/5xx = transient (Google's
//     documented general retry guidance: "HTTP 408, 429, and 5xx response codes...
//     indicate transient problems that are useful to retry" -- matches this project's
//     own AC-RETRY-01/03 fixtures, which use HTTP 503 as the canonical transient case).
//   - A genuine no-response condition (timeout, connection reset, DNS failure -- no HTTP
//     status was ever received) is classified UNKNOWN, never FAILED-transient: per
//     DEC-OQ-6/§0.F, an outcome that cannot be confirmed one way or the other must go
//     through the bounded reconciliation procedure, never a direct blind retry. This is
//     the single most safety-critical line in this file -- see AC-TIMEOUT-01.
//   - RISK-11 (fixed 2026-09-18, Slice 5): the docs never state whether echoing back an
//     unchanged READ-ONLY snippet field (publishedAt, channelId, channelTitle,
//     thumbnails, liveBroadcastContent -- per developers.google.com/youtube/v3/docs/
//     videos's per-property mutability table) is a harmless no-op or a rejected/ignored
//     value -- so this adapter no longer relies on finding out. `merge.ts`'s
//     `buildSafeLocalizationsPayload` now builds the outgoing `snippet` from an explicit
//     whitelist of only the six documented-writable fields (title, description, tags,
//     categoryId, defaultLanguage, defaultAudioLanguage); this adapter sends exactly the
//     `PreparedPayload` it is given, so no read-only field can reach `videos.update`
//     through this pipeline regardless of what a real `videos.list` response contains.
//     The pre-existing single-item write path (src/lib/video-metadata/services.ts's
//     removeReadOnlySnippetFields) still only strips `.localized` and was intentionally
//     left unchanged here (out of this task's named scope) -- see
//     docs/TECHNICAL_DEBT.md RISK-11 for that follow-up.
// ---------------------------------------------------------------------------

/** The minimal shape this adapter needs from a real `youtube_v3.Youtube` client --
 * exactly what `applyVideoMetadataUpdate` itself requires, re-declared here so tests can
 * inject a mock without constructing a real googleapis client at all (the "mockable
 * boundary around the googleapis client" this slice is required to expose). */
export type MinimalYoutubeWriteClient = {
  videos: {
    update: youtube_v3.Youtube["videos"]["update"];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Maps a caught error from a `videos.update` call to the correct `WriteExecutorResult`,
 * per the documented error/retry semantics above. Pure and fully unit-testable against
 * fixture error shapes -- never touches the network itself.
 */
export function classifyYoutubeWriteError(error: unknown): WriteExecutorResult {
  const response = isRecord(error) && isRecord(error.response) ? error.response : undefined;
  const status = typeof response?.status === "number" ? response.status : undefined;

  // No HTTP response was ever received (timeout, connection reset, DNS failure, etc.):
  // this attempt's outcome is genuinely unknown -- never treated as a confirmed failure
  // eligible for direct retry. See DEC-OQ-6/§0.F; AC-TIMEOUT-01.
  if (status === undefined) {
    const detail = error instanceof Error ? error.message : "No response received from YouTube API";
    return { outcome: "UNKNOWN", detail };
  }

  const errorBody = isRecord(response?.data) && isRecord(response.data.error) ? response.data.error : undefined;
  const reasonsRaw = Array.isArray(errorBody?.errors) ? errorBody.errors : [];
  const reasons = reasonsRaw
    .map((entry) => (isRecord(entry) && typeof entry.reason === "string" ? entry.reason : undefined))
    .filter((reason): reason is string => Boolean(reason));
  const detail =
    (typeof errorBody?.message === "string" ? errorBody.message : undefined) ??
    (error instanceof Error ? error.message : `YouTube API returned HTTP ${status}`);

  if (status === 403 && reasons.includes("quotaExceeded")) {
    return { outcome: "FAILED", detail, classification: "permanent", systemic: true };
  }

  // Google's documented guidance treats a 403 rate-limit reason the same as a 429 --
  // transient per-user/per-project throttling, not a permanent authorization/quota
  // problem. Must be checked before the generic 403 bucket below, or it would be
  // misclassified as "permanent" and never retried (independent review, second cycle).
  if (status === 403 && (reasons.includes("rateLimitExceeded") || reasons.includes("userRateLimitExceeded"))) {
    return { outcome: "FAILED", detail, classification: "transient" };
  }

  // §29's "insufficient permissions"/"wrong channel" bucket, plus every documented
  // videos.update 400 badRequest reason (invalid metadata/language/etc.) and the
  // documented 404 videoNotFound -- all are shape/permission problems a retry cannot
  // fix, never eligible for the bounded transient-retry path.
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return { outcome: "FAILED", detail, classification: "permanent" };
  }

  // Google's documented general retry guidance: 408/429/5xx indicate transient
  // problems, matching this project's own AC-RETRY-01/03 fixtures (HTTP 503).
  if (status === 408 || status === 429 || status >= 500) {
    return { outcome: "FAILED", detail, classification: "transient" };
  }

  // An HTTP response was received but its status is not one this adapter recognizes --
  // never guess; treat as unresolved rather than silently picking permanent or
  // transient, consistent with this project's conservative default elsewhere.
  return { outcome: "UNKNOWN", detail: `Unrecognized YouTube API response status ${status}: ${detail}` };
}

/**
 * The actual request/response handling, decoupled from the live-write barrier below so
 * it can be fully exercised by mock-based tests (a mock `MinimalYoutubeWriteClient`,
 * never a real googleapis client or network call) without ever touching or bypassing
 * that barrier. `attemptWrite` (below) is the only production entry point, and it always
 * calls the barrier first.
 */
export async function performYoutubeWrite(
  client: MinimalYoutubeWriteClient,
  payload: unknown
): Promise<WriteExecutorResult> {
  const prepared = payload as PreparedPayload;
  try {
    // Defense in depth (RISK-11): re-apply the same documented-writable-fields
    // whitelist `merge.ts` already applies when building this payload. This adapter is
    // the actual boundary to the live API -- it must never trust that every possible
    // caller of `attemptWrite` correctly pre-filtered `snippet`, even though today only
    // `merge.ts`'s output ever reaches here.
    const safeSnippet = pickWritableSnippetFields(prepared.snippet);
    await applyVideoMetadataUpdate({
      youtube: client as youtube_v3.Youtube,
      update: {
        videoId: prepared.videoId,
        snippet: safeSnippet,
        localizations: prepared.localizations,
      },
    });
    return { outcome: "SUCCESS" };
  } catch (error) {
    return classifyYoutubeWriteError(error);
  }
}

/**
 * LIVE-WRITE BARRIER, LAYER 2 (AGENTS.md §K; owner instruction 2026-09-21 -- the Settings tab
 * "live writes" toggle -- is the explicit, reviewed activation this function's own prior
 * doc-comment required before it could ever become conditional; see that instruction and
 * `docs/TECHNICAL_DEBT.md` RISK-09 for the authorization trail).
 *
 * Re-reads the persisted setting itself, at call time -- never passed in as a parameter, never
 * captured once at construction -- so a stale value cached anywhere else can't defeat this
 * specific check. This is deliberately the SECOND of two independent layers: Layer 1 is
 * `src/lib/batches/adapters/write-executor.ts`'s `createLiveWriteExecutorIfEnabled`, which
 * constructs no `WriteExecutor` at all unless the same setting is already on -- so with the
 * toggle off, there is still no code path to `videos.update`, exactly as before this change.
 * `dryRun` never reaches this function at all (dry-run batches terminate at
 * DRY_RUN_COMPLETE in `prepareLedgerRow`, long before `executeBatch`/`executeWithRetry` would
 * ever call `attemptWrite`), so this barrier is independent of and additional to that
 * mechanism, not a substitute for it.
 */
async function assertLiveWritesAuthorized(): Promise<void> {
  if (await getLiveWritesEnabled()) return;

  throw new DomainError({
    code: "live_writes_disabled",
    message:
      "Real YouTube videos.update execution is disabled -- the Settings tab's \"live writes\" toggle is off (defaults off every session, docs/TECHNICAL_DEBT.md RISK-09/Gate B).",
  });
}

/**
 * Production factory for the real `WriteExecutor`. Not constructed anywhere in
 * `src/lib/batches/index.ts` or any API route (Layer 1 of the barrier -- an inventory/
 * grep check, AC-SCOPE-01's verification method, confirms no production code path
 * reaches this function at all except `write-executor.ts`'s `createLiveWriteExecutorIfEnabled`,
 * itself gated on the same setting). Even when it is, `attemptWrite` itself independently
 * re-checks via `assertLiveWritesAuthorized` before touching `client` or the network (Layer
 * 2). Two independent layers, neither dependent on the other holding.
 */
export function createYoutubeWriteExecutor(deps: { getClient(): Promise<MinimalYoutubeWriteClient> }): WriteExecutor {
  return {
    async attemptWrite(payload: unknown): Promise<WriteExecutorResult> {
      await assertLiveWritesAuthorized();
      const client = await deps.getClient();
      return performYoutubeWrite(client, payload);
    },
  };
}
