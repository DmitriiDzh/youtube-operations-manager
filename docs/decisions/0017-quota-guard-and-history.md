# 0017. Pre-flight quota guard for write runs, and a quota call log

Status: Accepted

**Date:** 2026-10-03.

**Assigned by** the owner (chat, 2026-10-03, BL-117): block a batch that certainly needs more YouTube quota than is
left, before it starts; prepare a smaller batch that fits plus a batch of the rest; same guard for Fix all; show a
history of what the quota was spent on, grouped by work, and when it resets; a Cloud-not-connected popup with a Connect
button; a configurable (default 20%) reserve that stops background reads. Plan: `docs/roadmap/plans/QUOTA_HISTORY_AND_GUARD_PLAN.md`.

## Context

Until now only Google refused work when the daily quota ran out (403 `quotaExceeded`), which stopped a batch half way and
left some videos written and others not. Quota is one pool shared by reads and writes and by every device on the Cloud
project. Nothing recorded what spent it.

## Decision

1. **Quota ledger (`quota_ledger`, device-local).** Every Data/Analytics API call is logged from the single client wrapper
   (`wrapYoutubeClientForQuotaClassification`, which every gateway client already goes through) with method, units from
   Google's published cost table (unknown method = NULL, failed call = 1, 403 quotaExceeded = 0), outcome and the work it
   belonged to (an `AsyncLocalStorage` context on `globalThis`). Logging is fire-and-forget and can never change or delay a call.
2. **The guard runs in the services, before any state change.** `executeBatch` (live batches only, rows still to write) and
   Fix all `start` ask `quota-guard` whether `videos x 52` units (fresh list 1 + update 50 + read-back list 1) fit into
   `limit - used(since reset) - this device's calls of the last 2 minutes - 100`. Equal is allowed. A refusal is the typed
   error `quota_insufficient` (numbers, `fitVideos`, `canSplit`) before any claim, backup, lock or API call. An unreadable
   quota (Cloud not connected / lookup failed) is `quota_unknown`; the user may proceed knowingly with
   `acknowledgeUnknownQuota` ("Run anyway").
3. **Truncated batch = a transactional split, never a new state.** `splitPendingBatchForQuota` (one transaction) takes a
   never-executed live batch whose rows are all `PENDING` and creates a "fits" batch (the first N rows in stored order) and a
   "rest" batch (everything else) through the existing batch/ledger tables, then closes the original (`ABORTED`, every row
   `CANCELLED`, `batches.split_into_json` set, SCHEMA_MIGRATIONS v43). A resumed (`RUNNING`) batch is never split. The UI
   hides "Resend cancelled" for a split batch, so no video can be written twice. Nothing is written to YouTube.
4. **Background reads leave a reserve.** The automatic Analytics collection and Research refresh wait while less than
   `quota_reserve_percent` (default 20, 0-90, Settings) of the limit is left; an unknown quota never blocks them; manual runs
   are not held back.
5. **Data API usage is counted since the last Pacific midnight** (matching Google's reset), not a rolling 24 h; Analytics keeps
   the rolling 24 h because its reset boundary is not confirmed.

## Consequences

- The estimate is derived from the call sequence, not measured live; retries and extra calls are covered by the 100-unit
  margin. The first real batch should be compared against the history popup.
- `Run anyway` is a deliberate override for an unreadable quota only; it never overrides `quota_insufficient`.
- The local ledger covers one device; Google's figure covers the whole Cloud project. The history popup shows the difference as
  "other device or not attributed". Sharing the log between devices is a separate per-device-file exchange (a replace-style
  snapshot would conflict forever, since every device writes constantly).
