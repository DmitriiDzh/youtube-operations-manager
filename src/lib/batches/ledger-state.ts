// Canonical, single-source definition of the ledger/attempt execution-state literal
// types (closes docs/TECHNICAL_DEBT.md RISK-10). This file deliberately has ZERO
// imports: it exists so that both `src/lib/db.ts` (a domain-agnostic persistence layer
// that must not depend on any specific domain's contracts.ts, per its existing pattern --
// it imports no other domain module today) and `src/lib/batches/contracts.ts` (the
// domain layer) can share one definition without inverting that layering.
//
// Previously, src/lib/db.ts held its own hand-maintained copy of these three types.
// When DRY_RUN_COMPLETE (Slice 2) and AWAITING_EXECUTION (Slice 3) were added to
// contracts.ts, the db.ts copy silently fell out of sync and only surfaced as a
// `tsc` error once a test happened to pass one of the new literals through a db.ts
// function signature -- `npm test` (which does not typecheck) could not catch it. See
// docs/TECHNICAL_DEBT.md RISK-10 for the full incident. Both files now import from here
// instead of maintaining independent copies, so this class of drift is no longer
// structurally possible.

export type LedgerStatus =
  | "PENDING"
  | "AWAITING_EXECUTION"
  | "APPLYING"
  | "SUCCESS"
  | "FAILED"
  | "CONFLICT"
  | "UNKNOWN"
  | "ABORTED_SYSTEMIC"
  | "DRY_RUN_COMPLETE";

export type AttemptPhase = "INTENDED" | "RESULT_RECORDED";
export type AttemptOutcome = "SUCCESS" | "FAILED" | "UNKNOWN";

/** Every literal value of each type above, for exhaustive regression testing. */
export const ALL_LEDGER_STATUSES: readonly LedgerStatus[] = [
  "PENDING",
  "AWAITING_EXECUTION",
  "APPLYING",
  "SUCCESS",
  "FAILED",
  "CONFLICT",
  "UNKNOWN",
  "ABORTED_SYSTEMIC",
  "DRY_RUN_COMPLETE",
];

export const ALL_ATTEMPT_PHASES: readonly AttemptPhase[] = ["INTENDED", "RESULT_RECORDED"];
export const ALL_ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ["SUCCESS", "FAILED", "UNKNOWN"];
