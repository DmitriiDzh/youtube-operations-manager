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
4. **Reconnect after a reload applies only to operations the server runs.** Fix all is driven by
   the browser loop: a reload stops it after the current video (the unload warning says so).
5. **Quota in the overlay** (owner addition, 2026-10-03). An operation lists the pools it spends
   (`quotaServices: ["dataApi" | "analytics"]`); while it runs the hook reads
   `GET /api/settings` -> `cloudQuotaStatus` every 10 s (plus once at the end) and the overlay shows
   a bar `used / limit (24h)` and `this operation +N units` (reading at the end minus the first
   reading). The numbers are Google Cloud Monitoring's, which lags by about a minute, so the figure
   may trail the work; `null` (Cloud not connected / query failed) shows nothing rather than an
   invented value. Each poll is one `cloud_monitoring_reads` gateway call.
6. Planned, not built: a server-side in-memory progress registry (`onProgress` callbacks in
   services, `GET /api/operations/[id]`, cancel flag checked by the callback) for sync, AI
   generation and import; reconnect via that registry.

## Consequences

- One overlay and one reducer for every blocking operation; migrating a screen means calling
  `op.start/setItem/finish`.
- The overlay is a UX guard for one tab. Cross-tab and agent exclusion remains the server-side
  operation lock.
