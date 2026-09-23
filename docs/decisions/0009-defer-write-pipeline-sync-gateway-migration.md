# 0009. Reaffirm ADR 0006's exclusion of the write pipeline from Automerge, with stronger evidence

Status: Accepted

Decided during implementation of `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md`'s M5
slice, 2026-09-22 — recorded as its own ADR because it reverses a scope expansion the same plan
had proposed and the project owner had approved earlier the same day, on a premise later found to
be factually wrong (`AGENTS.md` §L: never build on an assumption instead of reading the code).

## Context

`docs/decisions/0006-automerge-for-draft-layer.md` originally excluded the write pipeline
(`batches`/`batch_ledger_rows`/`batch_attempts`/`audit_events`) from the Automerge migration,
reasoning that it is "the part of the system with the least tolerance for a new failure mode" and
"not the part of the system that actually needs concurrent multi-device editing."

While planning the broader sync-gateway consolidation (`FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md`),
that exclusion was reopened on the strength of a claim that these four tables are "structurally
append-only and immutable once written, uniquely keyed by a generated UUID" — making them, in
CRDT terms, a *lower*-risk shape than the already-shipped `change_sets`/`changes` migration, not a
harder one. The project owner approved reopening the exclusion on this premise (Telegram,
2026-09-22: *"Если нет конфликтов то не страшно, но думаю нам надо все перевести на 1 систему"*).

A dedicated research pass immediately before implementing M5 (per `AGENTS.md` §L — derive
behavior from the actual code, not from an assumption written down before reading it) found the
append-only premise false for three of the four tables, and found a second, independent blocker
for the fourth.

## Findings that reverse the premise

1. **`batches`, `batch_ledger_rows`, `batch_attempts` are real state machines, not append-only.**
   `batches.status` (`PENDING → RUNNING → COMPLETED/ABORTED`), `batch_ledger_rows.status`/
   `active_attempt_id` (`PENDING → APPLYING → SUCCESS/FAILED/CONFLICT/UNKNOWN`, mutated repeatedly
   per video), and `batch_attempts.phase` (`INTENDED → RESULT_RECORDED`) are each UPDATEd in place
   multiple times during one video's processing. Only `audit_events` is genuinely insert-only.

2. **The safety guarantees these three tables provide have no Automerge equivalent.**
   `docs/acceptance/PHASE_5_ACCEPTANCE.md`'s AC-CONCURRENCY-01/02/03 and AC-RESUME-01/AC-CRASH-01
   (bounded concurrency, no double-apply, no two batches racing the same video, crash-safe resume)
   are enforced by guarded compare-and-set UPDATEs (`src/lib/db.ts`'s `beginAttemptIntent`/
   `transitionLedgerRowStatus`: an `UPDATE ... WHERE status = 'PENDING'`-style statement paired
   with `.returning()` to detect a zero-rows-affected precondition failure) and a real
   UNIQUE-constraint claim (`acquireVideoExecutionLock`'s `onConflictDoNothing`) — deliberately
   chosen over `db.transaction(...)`, which was found to deadlock/serialize more aggressively
   across libSQL connections (`db.ts`'s own comment on `beginAttemptIntent`). Automerge has no
   compare-and-set or mutual-exclusion primitive: a merge always accepts both sides' writes and
   resolves via LWW/conflict-recording — it cannot *refuse* a write the way a guarded UPDATE's
   `WHERE` clause failing to match a row can. This is a structural incompatibility between what
   these acceptance criteria require and what a CRDT document can provide, not an engineering
   inconvenience to design around.

3. **The recovery-mode gate reads live SQL directly, never a lagging projection.**
   `scanForUnresolvedExecutionState` (`src/lib/snapshot/services.ts`) queries
   `batch_ledger_rows WHERE status IN ('APPLYING','UNKNOWN')` against the current connection, and
   `isDeviceInRecoveryMode`/`assertNotInRecoveryMode` use the result as a real-time, fail-closed
   safety gate. Every Automerge-backed family this session's sync-gateway work actually shipped
   (editorial-profile, ai-connections-catalog) deliberately lets its SQL projection lag on a
   transient write failure (logged, never rethrown — an acceptable, recoverable degradation for
   settings data). Reused here, that same lag would make the recovery gate **fail open**: a real
   unresolved row could stop being visible to SQL exactly when a projection write happened to
   fail, and `assertDeviceAvailableForMutation` would then wrongly permit a mutation.

4. **`audit_events`, the one table that genuinely is insert-only, still can't migrate as originally
   scoped — for an unrelated, independent reason: rowid-derived ordering.** `audit_events.id` is a
   SQLite `AUTOINCREMENT` rowid, and existing code comments confirm this is deliberate — it is what
   makes a ledger row's full event sequence reconstructable in *exact* order
   (AC-AUDIT-01/AC-AUDIT-04), never `occurred_at` (`unixepoch()`, second granularity, against 14+
   audit inserts per video during real execution — same-second collisions are the norm). An
   Automerge document has no rowid-equivalent ordering primitive: keying entries by a generated id
   and letting the SQL projection assign a fresh `AUTOINCREMENT` value on insert makes the
   projected order equal to *local insertion order*, which is wrong the instant a peer's events are
   merged in after later local ones — exactly the scenario cross-device sync exists to handle.

## Decision

**All four write-pipeline tables — `batches`, `batch_ledger_rows`, `batch_attempts`,
`audit_events` — remain relational SQLite, unmigrated.** ADR 0006's original exclusion is
reinstated in full, now with stronger, code-verified evidence than 0006 itself had, rather than
the disproven "append-only, lower-risk-than-drafts" reasoning that briefly reopened it.

`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md`'s M5 slice is cancelled as a result.
This does not, by itself, change M6 (the whole-DB Device-Handoff/snapshot mechanism's own
retirement) — see that plan's §3 for the resulting open question the project owner still needs to
resolve (whether these four tables get any cross-device continuity going forward at all, and if
so, through what mechanism).

## Named follow-up (not part of this decision, not authorized by it)

The audit-ordering problem in finding #4 is narrower than findings #1-#3 and could, in principle,
be solved on its own: an explicit, origin-assigned ordering key (e.g. a per-ledger-row monotonic
sequence plus an actor tiebreak) threaded through `src/lib/audit/services.ts`'s
`listForLedgerRow`/`listForBatch`, with AC-AUDIT-01/AC-AUDIT-04 re-derived against that new
ordering contract. If solved, `audit_events` alone could become migratable independently of
`batches`/`batch_ledger_rows`/`batch_attempts`, which remain blocked by findings #1-#3 regardless.
This is a real, separately-scoped design task requiring its own `AGENTS.md` §L acceptance-criteria
pass and its own explicit assignment (`AGENTS.md` §C) — not something this ADR authorizes or
schedules.

## Compatibility / migration impact

No schema or code change results from this ADR — it is a reaffirmation of already-live behavior.
`src/lib/batches/`, `src/lib/audit/`, and `src/lib/device-handoff/`/`src/lib/snapshot/`'s existing
handling of these four tables are entirely unaffected.
