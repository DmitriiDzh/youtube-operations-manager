# 0015. Shared operation-progress overlay for long writes and syncs

Status: Accepted (stage 1-2 implemented; later stages planned)

**Date:** 2026-10-03.

**Assigned by** the owner (chat, 2026-10-03): long YouTube writes and syncs show no progress, so
the operator cannot tell the program is still working. A blocking dialog (dim + blur) is allowed
where the operator must not leave the screen. Cancel is wanted. Approved plan: five stages.

## Context

Every component kept its own boolean (`syncing`, `executing`, `preparing`) and changed a button
label. Only `ProgressBar` and `ConfirmDialog` were shared. Server operations (`channels/sync`,
`batches/[id]/execute`, `prepare`, AI generation, import) are single blocking POSTs. Batch ledger
rows are committed per row, so progress is already readable through `GET .../batches/[id]`.

## Decision

1. **`src/components/operation-progress/`** is a feature-independent UI module (AGENTS.md §M):
   a pure reducer (`operation-state.ts`), a `useOperation()` hook, `OperationOverlay`, `Spinner`.
   The overlay is `fixed inset-0 z-[70]` with backdrop blur, cannot be dismissed (no Esc, no
   backdrop click) until the operation ends, and warns on page unload while active.
2. **Cancel is cooperative.** The flag lives in a ref (a loop's closure cannot see state), is
   checked before each item and never aborts an in-flight request - a write already sent to YouTube
   cannot be recalled. An operation declares `cancellable`; the reducer ignores a cancel request
   otherwise.
3. **Batches show progress by polling** the existing batch GET route only while their own
   `execute`/`prepare` request is in flight, so a stale `PENDING` batch in the database can never
   create an overlay that cannot be closed. **Cancel for Batches** is a write-pipeline state change
   (remaining rows, video locks, batch status) and is decided separately in ADR 0016; a button that
   only stopped polling would be a fake cancel.
4. **Server-run operations survive a reload** (slice 3, 2026-10-03). `src/lib/operation-progress`
   is an in-memory registry (a `globalThis` singleton) with a heartbeat: a run silent for 3 minutes
   is shown as failed, so a crashed job can never keep an overlay open, and a finished run stays
   readable for 10 minutes. One active run per `(channel, kind)`. Routes: `GET /api/operations`,
   `GET /api/operations/[id]`, `POST /api/operations/[id]/cancel` -- each checks that the
   operation's channel is the active channel (AGENTS.md section F). The client mirrors the snapshot
   (`useOperation().attach`) and a freshly loaded page re-attaches to a run still active.
   **Fix all moved to the server** (owner decision): `src/lib/language-fix-all` plans the run from
   the channel baseline (the request names only videos and previewed etags, so the caller can never
   choose fields or values), runs it sequentially and fail-fast through `after()`, and writes ONLY
   via `video-details`' `applyFieldsUpdate` -> `youtube-write-gateway`. It calls no YouTube method
   and adds no write path (owner reminder: every write goes through the one gateway). Preview stays
   in the browser: it is read-only, so a reload only means starting it again. Three safeguards
   (author's self-review, 2026-10-03): (a) every registry heartbeat also records activity for the idle
   auto-shutdown (`onHeartbeat` -> `recordActivity`), because a closed tab sends no `/api` request
   and the 60-minute idle exit would otherwise kill a long run between backup and verification;
   (b) `src/proxy.ts` gates only the START request, so the run calls the same
   `assertDeviceAvailableForMutation` before EVERY video and stops on a refusal (an export/import or
   an unavailable device mid-run); (c) the request carries the baseline the operator previewed and
   the server refuses (`video_details_conflict`) if it changed since, so a value the operator never
   saw is never written. `after()` is supported by `next start` (Next self-hosting guide); a
   SIGINT/SIGTERM shutdown drains pending `after()` callbacks, a hard kill does not -- tracked as
   RISK-94.
5. **Quota in the overlay** (owner addition, 2026-10-03). An operation lists the pools it spends
   (`quotaServices: ["dataApi" | "analytics"]`); while it runs the hook reads
   `GET /api/settings` -> `cloudQuotaStatus` every 10 s (plus once at the end) and the overlay shows
   a bar `used / limit (24h)` and `this operation +N units` (reading at the end minus the first
   reading). The numbers are Google Cloud Monitoring's, which lags by about a minute, so the figure
   may trail the work; `null` (Cloud not connected / query failed) shows nothing rather than an
   invented value. Each poll is one `cloud_monitoring_reads` gateway call.
6. **Stage 4-5 (2026-10-03).** `runTrackedOperation` (`src/lib/operation-progress/tracked.ts`) wraps one
   blocking server operation so it appears in the registry (stage, counts, heartbeat, final status) while
   the endpoint's own response stays unchanged. Services take an OPTIONAL `ProgressReporter` (structural
   type, so a service never depends on the registry): `syncChannel` (stages + per-chunk counts through
   optional gateway callbacks; still one logical metadata call), `generateProposals` (Cancel is checked
   BEFORE each target, so a paid provider call is never made after a cancel; finished results are kept;
   `cancelled`/`targetsSkipped` appear only on a cancel) and `collectMetrics` (per video; not cancellable --
   a partial run would still count for the daily freshness gate). Client: `useOperation().runBlocking`
   shows one blocking request, mirrors the registry's stage/counts, forwards Cancel (a Cancel pressed
   before the operation was discovered is sent as soon as it is). Wired: Content/Languages sync,
   AI generation (Languages), Analytics collect (both tabs), single-video save, reach import, channel
   discovery search, hypothesis draft. Re-attach after a reload exists for syncs only: an AI generation's
   proposals exist only in its original HTTP response, so there is nothing to re-attach to (the unload
   warning covers it). Stage 5: the shared `LoadingIndicator` (spinner + text) replaces every bare
   `<p>Loading...</p>`; an inventory test fails if one comes back.
7. **Found by the independent review and a browser check (2026-10-03), fixed:** (a) the Content tab's
   automatic resync (stale data on open) would have opened the blocking overlay -- it now runs plainly
   (`background`), only a sync the operator pressed shows the overlay; (b) the sync route now refuses a
   concurrent second sync with 409 `operation_already_running`, so every caller waits for the running one
   (`postChannelSync`, `waitForOperation`) instead of showing an error (the dashboard fires the same
   implicit sync on every load); (c) the overlay swallows Escape while an operation runs, because
   `VideoDetailModal` closes on a window-level Escape and would have unmounted the panel mid-save.
8. Not covered: Batches execution is not registered in the registry (its progress comes from the ledger),
   so a reloaded page does not re-attach to a running Batch; import of a localization workbook.

## Consequences

- One overlay and one reducer for every blocking operation; migrating a screen means calling
  `op.start/setItem/finish`.
- The overlay is a UX guard for one tab. Cross-tab and agent exclusion remains the server-side
  operation lock.
