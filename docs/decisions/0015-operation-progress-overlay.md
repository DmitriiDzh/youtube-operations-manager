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
   create an overlay that cannot be closed. **Batches have no Cancel yet:** stopping a live batch
   changes the Gate B write-pipeline state machine (remaining rows, video locks, batch status) and
   needs its own design and acceptance tests. A button that only stopped polling would be a fake
   cancel.
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
   in the browser: it is read-only, so a reload only means starting it again.
5. **Quota in the overlay** (owner addition, 2026-10-03). An operation lists the pools it spends
   (`quotaServices: ["dataApi" | "analytics"]`); while it runs the hook reads
   `GET /api/settings` -> `cloudQuotaStatus` every 10 s (plus once at the end) and the overlay shows
   a bar `used / limit (24h)` and `this operation +N units` (reading at the end minus the first
   reading). The numbers are Google Cloud Monitoring's, which lags by about a minute, so the figure
   may trail the work; `null` (Cloud not connected / query failed) shows nothing rather than an
   invented value. Each poll is one `cloud_monitoring_reads` gateway call.
6. Planned, not built: registry reporting for sync, AI generation and import (`onProgress`
   callbacks in their services); cancel for live Batches (needs its own design -- state machine).

## Consequences

- One overlay and one reducer for every blocking operation; migrating a screen means calling
  `op.start/setItem/finish`.
- The overlay is a UX guard for one tab. Cross-tab and agent exclusion remains the server-side
  operation lock.
