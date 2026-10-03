# 0016. Cooperative cancel for a running Batch (ledger status CANCELLED)

Status: Accepted

**Date:** 2026-10-03.

**Assigned by** the owner (chat, 2026-10-03): an operator must be able to stop a long live Batch; the
status of the rows that did not get written is `CANCELLED` (owner's explicit choice over reusing
`ABORTED_SYSTEMIC`). Companion to ADR 0015 (progress overlay).

## Context

A live Batch runs per-video rows through `PENDING -> AWAITING_EXECUTION -> APPLYING -> SUCCESS/FAILED/...`
(`src/lib/batches/contracts.ts`). Nothing could stop it once started. An overlay button that only stopped
polling while the server kept writing would have been a fake cancel.

## Decision

1. **New terminal ledger status `CANCELLED`.** Reachable only from `PENDING` and `AWAITING_EXECUTION`
   (rows that have not begun an attempt). Never from `APPLYING` (a write is in flight) or `UNKNOWN` (a sent
   write whose outcome is still to be reconciled). No exits. `batch_ledger_rows.status` is plain `TEXT`, so
   no schema migration; the audit trail gets a `CANCELLED` event type per cancelled row.
2. **Cooperative, between rows.** `executeBatch` registers itself in an in-process control map
   (`src/lib/batches/execution-control.ts`, a `globalThis` singleton). `POST .../batches/[id]/cancel` sets a
   flag only if that batch is executing right now. The flag is checked before preparing a row and before
   starting a row; rows that have not started become `CANCELLED` and release their video lock. A row already
   writing finishes and is verified. The flag exists only while the run exists, so a cancel can never leak
   into a later run; a cancel with nothing executing returns `accepted: false`.
3. **The batch ends `ABORTED`** (existing status); the rows distinguish an operator cancel (`CANCELLED`) from
   a systemic abort (`ABORTED_SYSTEMIC`). `BatchExecutionSummary.cancelled` is true only if a row was
   actually cancelled -- a cancel that arrives after everything was written changes nothing and the batch
   still ends `COMPLETED`.
4. **A cancelled batch is closed.** Batch membership is immutable. The UI offers "Resend N cancelled in a
   new batch": a NEW live batch from the cancelled rows' change ids, through the normal `createBatch`
   checks (approval, validity, no conflict) and the full safety pipeline. Rows already written are not
   resent (their changes would now read as conflicts against the written value).
5. **Device gate before every row (closes the Batches part of RISK-94).** `src/proxy.ts` gates only the
   START request. `executeBatch` and the preparation loop now call the same
   `assertDeviceAvailableForMutation` before each not-yet-started row. A refusal during execution halts
   the rest as `ABORTED_SYSTEMIC` (existing systemic path); a refusal during preparation aborts every
   unfinished row, releases the locks, ends the batch `ABORTED` and throws `device_unavailable` (503).
   Rows aborted by ANY systemic halt (this gate, quota) now release their video lock when the guarded
   transition succeeds -- previously a halted batch left prepared rows' locks stranded (author's
   self-review, 2026-10-03). A lock is released only when the transition really happened, so a cancel that
   loses a race to a row already `APPLYING` never frees the lock of an in-flight write.
6. **Automatic device sync waits for server-side operations.** An auto-export takes the operation lock,
   which would make the per-row/per-video gate above refuse and abort a running Fix all (a Fix all is not
   a Batch, so `hasUnfinishedBatch` does not see it). `device-sync` therefore pauses while the operation
   registry has an active operation (`hasActiveLocalOperation`); a running Batch was already covered
   (`RUNNING`).

## Consequences

- Contract change: `LedgerStatus`, `ALLOWED_LEDGER_TRANSITIONS`, `TERMINAL_LEDGER_STATUSES`,
  `PreparedRowOutcome`, `BatchExecutionSummary.cancelled`, audit event type, error code `device_unavailable`.
  All additive; consumers that switch on a status must handle `CANCELLED` (the progress overlay does).
- The cancel route calls no YouTube method and no `WriteExecutor`; `write-path-inventory` and
  `gateway-inventory` stay green.
- Not covered: cancel is in-process. After a server restart nothing is executing, so there is nothing to
  cancel; resuming a half-run batch goes through `recoverBatch` as before.
