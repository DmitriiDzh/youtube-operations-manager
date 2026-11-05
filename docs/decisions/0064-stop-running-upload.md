# 0064. Stop an upload that is being sent, before its last chunk -- the owner and the Producer, one function

Status: Accepted (owner, Telegram 2026-11-05: msg 4046 «Можешь дать продюсеру останавливать начатые загрузки?», msg 4050 -- yes,
for the Producer and for the owner, through one shared function). Amends ADR 0059 §3 (the Producer cancelled only `queued` rows)
and the owner's cancel of ADR 0037 (queued, or paused before the last byte).

**Date:** 2026-11-05.
- **Plan:** `docs/roadmap/plans/UPLOAD_QUEUE_CONTROL_PLAN.md`, section BL-244, acceptance AC-STOP-01..13.

## Context

An upload is sent to YouTube as a resumable session in chunks. YouTube makes the video only when the last byte arrives; before
that, an abandoned session simply expires (about a week) and nothing is left on the channel. The runner records
`steps_json.finalChunkSentAt` with a compare-and-set on `uploading` before it sends the last chunk -- from then on the video may
exist even if no answer said so (ADR 0037 §4, "never twice").

Until now a row being sent could not be cancelled at all (the owner had to pause it by turning Live writes off), and the Producer
could cancel only a row still `queued`.

## Decision

1. **What can be stopped.** A row with no video id, no `finalChunkSentAt` and -- once it started sending -- bytes still to send:
   `queued`, `uploading`, or `paused` with `resume_status` `queued` / `uploading` (`isCancellable`). The Producer may now also
   cancel a row paused before its last chunk: that is a started upload in the owner's words, and the safety argument is the same.
   Everything else is refused `upload_not_cancellable` with `details.reason` (`final_chunk_sent`, `video_exists`, `status`,
   `changed`): it runs to its end, and the owner deletes the video in Studio if it is not wanted.
2. **Atomic against the runner: one statement.** `stopPublishingUploadBeforeYoutube` (`db.ts`) writes `cancelled` in one `UPDATE`
   whose `WHERE` checks the status the caller read, `video_id IS NULL`, the absence of `finalChunkSentAt` in a valid
   `steps_json` (a damaged one is never read as "absent") and `stored_bytes < total_bytes` once sending. The runner's mark is a
   compare-and-set on `uploading`; SQLite runs the two one after the other, so exactly one wins. If the stop wins, the mark fails
   and the last chunk is never sent; if the mark wins, the stop is refused (`final_chunk_sent`).
3. **The runner after a stop.** Every write it makes is a compare-and-set on its status, so its next write fails and it returns;
   `claimPublishingUpload` now takes a lease only on an active row, so no chunk starts after the stop (at most the one already on
   the wire finishes; YouTube keeps it in the abandoned session). `fail()` no longer writes or audits a failure when its
   compare-and-set fails, so a stopped row stays `cancelled` with no false `publishing.upload_failed`.
4. **One function.** `createUploadQueueControl().cancel(input, actor)` is the only cancel: the Producer's
   `producer_upload_queue_cancel` and the owner's `POST .../publishing/uploads/[uploadId]/cancel` (now via `cancelUpload(input,
   userId)`, which calls the same core as the owner) both go through it. It reads the row (another channel's is `upload_not_found`),
   checks `isCancellable`, then runs the statement from the status it read; a row that changed status in between is read once
   more. The Producer's stop sets `error_code = cancelled_by_producer` (it may queue the same manifest version again, as after its
   queued cancel); the owner's leaves `error_code` as it was (a row he approved, or the automatic upload queued, stays his).
5. **Audit.** `publishing.upload_cancelled` (it never started sending) or `publishing.upload_stopped` (uploading, or paused while
   sending), with `by` (owner + user id / producer + token id), the status it had and `storedBytes` / `totalBytes` from the
   statement itself.
6. **No YouTube call.** The abandoned resumable session needs nothing: it expires by itself, and no video is created before the
   last chunk. A stopped package is uploaded again from the beginning in a new session.
7. **Surfaces.** One Producer tool, not a new one: ADR 0059 has one cancel, and "what can be cancelled" is the rule that changed,
   not the action; a second tool would duplicate the refusal paths. Producer API 1.18.0 (the result gains `previousStatus`,
   `storedBytes`, `totalBytes`; refusals carry `details.reason`). The owner's uploads list shows «Остановить загрузку» on a
   cancellable row that is sending (or paused while sending), with the app's own confirmation dialog; a queued row keeps
   «Отменить». Channel worker agents and the factory endpoint still get no upload tool.

## Consequences

- A stopped row frees its package and its weekly-plan slot like any cancelled row without a video (`holdsPackage` false; the
  one-live-row index does not count `cancelled`), so the slot no longer shows "uploading".
- The owner's cancel now passes the device mutation gate (`assertMutationAllowed`), like his move and the Producer's cancel: during a
  device handoff or recovery it is refused (`operation_lock_held` / `device_in_recovery_mode`) instead of cancelling a queued row.
- A stop that loses the race to the mark leaves an upload the owner wanted gone: it finishes privately and he deletes it in Studio.
  The window is one chunk's mark; the refusal says so.

## Compatibility / migration impact

- No schema change (stays v118). Producer API 1.18.0, additive in shape; a Producer that expected `upload_not_cancellable` for an
  `uploading` row now stops it. Agent API and Factory API unchanged.
