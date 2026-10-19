import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.2 "Errors in plain words") -- what a failed live-streaming call means, from the reason
// YouTube gives (developers.google.com/youtube/v3/live/docs, method pages and the errors page, read 2026-10-12).
// Everything else falls back to `update_failed` with YouTube's own message.
// ---------------------------------------------------------------------------

export const LIVE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  liveStreamingNotEnabled: "Live streaming is not enabled for this channel. Enable it in YouTube Studio (it can take up to 24 hours), then try again.",
  livePermissionBlocked: "YouTube does not allow this channel to stream live at the moment (see YouTube Studio).",
  insufficientLivePermissions: "This Google account is not allowed to manage this channel's live broadcasts.",
  invalidScheduledStartTime: "YouTube refused the start time; try again (it is set to a couple of minutes from now).",
  errorStreamInactive: "YouTube is not receiving the picture yet, so the broadcast cannot go live; wait a minute and try again.",
  invalidTransition: "The broadcast cannot change to that state from where it is now.",
  liveBroadcastBindingNotAllowed: "The broadcast's state does not allow binding it to the stream.",
  concurrentBroadcastsExceedLimit: "The channel already has the maximum number of live broadcasts running.",
  liveBroadcastNotFound: "YouTube no longer has this broadcast.",
  liveStreamNotFound: "YouTube no longer has this stream.",
});

/** The first `reason` of a Google API error (`error.response.data.error.errors[].reason`), else null. */
export function liveErrorReason(error: unknown): string | null {
  const response = (error as { response?: { data?: { error?: { errors?: Array<{ reason?: unknown }> } } } } | null)?.response;
  const reason = response?.data?.error?.errors?.find((e) => typeof e?.reason === "string")?.reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * Spike C (2026-10-19, LIVE_STREAMS_FIELDS_PLAN.md §4.2): a channel that may not switch recording off gets "The user is not
 * permitted to disable recording." from `liveBroadcasts.insert` with `recordFromStart: false`. Matched on the message, because the
 * reason code was not captured; the reason is accepted too when YouTube gives it.
 */
export function isRecordingRequiredRefusal(error: unknown): boolean {
  const messages: string[] = [];
  if (error instanceof Error) messages.push(error.message);
  const errors = (error as { response?: { data?: { error?: { message?: unknown; errors?: Array<{ message?: unknown; reason?: unknown }> } } } } | null)?.response?.data?.error;
  if (typeof errors?.message === "string") messages.push(errors.message);
  for (const e of errors?.errors ?? []) {
    if (typeof e?.message === "string") messages.push(e.message);
    if (e?.reason === "recordingRequired" || e?.reason === "invalidRecordFromStart") return true;
  }
  return messages.some((m) => /not permitted to disable recording/i.test(m));
}

/** §3.2: `redundantTransition` ("already in the requested status") counts as done. */
export function isRedundantTransition(error: unknown): boolean {
  return liveErrorReason(error) === "redundantTransition";
}

/** A failed live call as a DomainError in plain words; a DomainError (e.g. Live writes off) passes through unchanged. */
export function toLiveDomainError(error: unknown, action: string): DomainError {
  if (error instanceof DomainError) return error;
  const reason = liveErrorReason(error);
  const plain = reason ? LIVE_ERROR_MESSAGES[reason] : undefined;
  return new DomainError({
    code: "update_failed",
    message: plain ?? `${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    details: { action, ...(reason ? { reason } : {}) },
  });
}
