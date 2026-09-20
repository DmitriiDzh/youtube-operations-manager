import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";
import type { AttemptOutcome, AttemptPhase, LedgerStatus } from "./ledger-state";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };
export type { AttemptOutcome, AttemptPhase, LedgerStatus };

// ---------------------------------------------------------------------------
// Phase 5, Slice 1 -- FOUNDATION.
//
// Scope of this module as of Slice 1 (see docs/acceptance/PHASE_5_ACCEPTANCE.md and the
// approved five-slice implementation plan): Batch entity with immutable membership,
// per-video execution ledger, durable two-phase attempt-intent persistence, the explicit
// ledger/attempt state model, and cross-batch/cross-video concurrency protection.
//
// Slice 2 ("SAFETY PREPARATION") added: channel identity validation, approval/payload
// integrity re-check, fresh remote fetch, conflict detection, immutable backup, safe
// merge, dry-run semantics.
//
// Slice 3 ("RECOVERY AND AUDIT") added: durable audit trail (src/lib/audit/), bounded
// retry with transient/permanent classification, §0.F UNKNOWN/reconciliation, crash
// recovery (recoverBatch), item-level failure isolation + systemic abort handling,
// quota-exhaustion classification, and mandatory post-write verification.
//
// Deliberately NOT in this module yet:
//   - the real YouTube adapter behind the WriteExecutor port (Slice 4). No production
//     code path in this repository constructs a WriteExecutor or invokes `executeBatch`/
//     `executeWithRetry` -- every caller of those functions in this codebase is a test.
//
// The `WriteExecutor` port below is the single interface Slice 4 will implement with a
// real YouTube adapter. Slice 1 only ships a fake implementation (see
// `adapters/write-executor.fake.ts`), used by tests and not wired into any production
// code path -- there is no way, in this slice, to reach a real `videos.update` call.
// ---------------------------------------------------------------------------

export type BatchStatus = "PENDING" | "RUNNING" | "COMPLETED" | "ABORTED";

// LedgerStatus/AttemptPhase/AttemptOutcome now live in ./ledger-state (RISK-10 fix,
// 2026-09-18) -- imported and re-exported above so every existing consumer of this
// module keeps working unchanged. Their meaning:
//
//   PENDING            -- never attempted.
//   AWAITING_EXECUTION -- Slice 3 (revised 2026-09-17, per the project owner's
//     "execution-state correctness" review of Slice 2): a live batch's per-video
//     preparation (identity check, approval re-check, fresh fetch, defaultLanguage
//     check, conflict check, backup, merge/diff) has completed successfully and the row
//     is ready for its first attempt -- but no attempt has begun. This is what a
//     Slice-2-only "leave it APPLYING" used to mean; it is now its own explicit state so
//     APPLYING unambiguously means "an attempt is genuinely active" (a durable INTENDED
//     record exists, unresolved), never "prepared but idle." A row also returns here
//     after an UNKNOWN resolution re-runs the full safety pipeline (§0.F Step 4) and
//     finds no conflict/invalid-approval -- ready for a brand new attempt.
//   APPLYING, SUCCESS, FAILED, CONFLICT, UNKNOWN, ABORTED_SYSTEMIC -- as their names say.
//   DRY_RUN_COMPLETE   -- Slice 2: a dry-run batch's per-video preparation completed
//     successfully (identity check, fresh fetch, defaultLanguage check, conflict check,
//     backup, merge/diff all ran) but no write was attempted or simulated as sent.
//     Distinct from SUCCESS so a report can never conflate a dry-run with a real write
//     (AC-DRYRUN-01/03) and terminal so a later live run of the same batch id is a fully
//     independent execution rather than resuming from this row (AC-DRYRUN-03).

/**
 * The ledger state machine (DEC-OQ-1/§0.C). This is the single source of truth for which
 * transitions are legal -- `services.ts` never writes a status the store layer wouldn't
 * also accept, and the store layer (`transitionLedgerRowStatus` in `src/lib/db.ts`)
 * enforces the same `from` set atomically against concurrent callers.
 *
 * PENDING -> AWAITING_EXECUTION|CONFLICT|FAILED|ABORTED_SYSTEMIC|DRY_RUN_COMPLETE is
 * Slice 2's preparation outcome. AWAITING_EXECUTION -> APPLYING is Slice 3's beginAttempt
 * (the ONLY way a row ever becomes APPLYING -- there is no direct PENDING->APPLYING or
 * UNKNOWN->APPLYING path; both must pass through a (re-)preparation step first, so a
 * fresh approval/conflict check is structurally unavoidable before every attempt, per
 * AC-BATCH-03/§0.F Step 4). UNKNOWN's exits mirror §0.F: a reconciliation read can close
 * the loop directly (SUCCESS/CONFLICT); an operator-authorized or later-independent
 * resolution pass re-runs the full pipeline, landing back on AWAITING_EXECUTION (ready
 * for a genuinely new attempt) or a terminal state (FAILED, if approval no longer holds).
 */
export const ALLOWED_LEDGER_TRANSITIONS: Record<LedgerStatus, LedgerStatus[]> = {
  PENDING: ["AWAITING_EXECUTION", "CONFLICT", "FAILED", "ABORTED_SYSTEMIC", "DRY_RUN_COMPLETE"],
  // FAILED/CONFLICT here cover the mandatory fresh pre-send re-check (executeBatch calls
  // the same safety pipeline again immediately before every attempt cycle, per
  // AC-BATCH-03/§0.F Step 4) discovering a newly-invalidated approval or a newly-diverged
  // remote value between preparation time and actual send time.
  AWAITING_EXECUTION: ["APPLYING", "FAILED", "CONFLICT", "ABORTED_SYSTEMIC"],
  APPLYING: ["SUCCESS", "FAILED", "CONFLICT", "UNKNOWN"],
  UNKNOWN: ["SUCCESS", "CONFLICT", "FAILED", "AWAITING_EXECUTION"],
  SUCCESS: [],
  FAILED: [],
  CONFLICT: [],
  ABORTED_SYSTEMIC: [],
  DRY_RUN_COMPLETE: [],
};

export const TERMINAL_LEDGER_STATUSES: ReadonlySet<LedgerStatus> = new Set([
  "SUCCESS",
  "FAILED",
  "CONFLICT",
  "ABORTED_SYSTEMIC",
  "DRY_RUN_COMPLETE",
]);

export type Batch = {
  id: string;
  channelId: string;
  status: BatchStatus;
  concurrency: number;
  dryRun: boolean;
  runId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type LedgerRow = {
  id: string;
  batchId: string;
  videoId: string;
  changeIds: string[];
  status: LedgerStatus;
  error: string | null;
  verificationResult: unknown | null;
  /** The currently unresolved attempt's id, if any -- see beginAttemptIntent in src/lib/db.ts. */
  activeAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Attempt = {
  id: string;
  ledgerRowId: string;
  attemptNumber: number;
  phase: AttemptPhase;
  payloadSnapshot: unknown;
  requestedAt: string;
  outcome: AttemptOutcome | null;
  outcomeDetail: string | null;
  resultAt: string | null;
};

export type BatchVideoSelection = {
  videoId: string;
  changeIds: string[];
};

export type StoredBatchRecord = {
  id: string;
  channelId: string;
  status: BatchStatus;
  concurrency: number;
  dryRun: boolean;
  runId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type StoredLedgerRowRecord = {
  id: string;
  batchId: string;
  videoId: string;
  changeIds: string[];
  status: LedgerStatus;
  error: string | null;
  verificationResult: unknown | null;
  activeAttemptId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredAttemptRecord = {
  id: string;
  ledgerRowId: string;
  attemptNumber: number;
  phase: AttemptPhase;
  payloadSnapshot: unknown;
  requestedAt: Date;
  outcome: AttemptOutcome | null;
  outcomeDetail: string | null;
  resultAt: Date | null;
};

/**
 * The single abstract interface every write attempt goes through. Slice 1 wires only a
 * fake implementation (tests). Slice 4 will implement this same interface with the real
 * YouTube adapter and plug it into the identical execution pipeline built in Slices 1-3
 * -- no alternative or shortcut write path is introduced at that point.
 *
 * `classification` on a FAILED result is the executor's own call (§29's list: it is the
 * transport layer that actually knows whether an error was e.g. an HTTP 503 vs. a 403) --
 * Slice 3's retry logic trusts this classification rather than re-deriving it by guessing
 * at `detail` strings. `systemic: true` marks a class of failure that should halt the
 * rest of the batch (e.g. quota exhaustion) rather than being scoped to just this video.
 */
export type WriteExecutorResult =
  | { outcome: "SUCCESS"; detail?: string }
  | { outcome: "FAILED"; detail: string; classification: "transient" | "permanent"; systemic?: boolean }
  | { outcome: "UNKNOWN"; detail: string };

export type WriteExecutor = {
  attemptWrite(payload: unknown): Promise<WriteExecutorResult>;
};

// ---------------------------------------------------------------------------
// Slice 3 ("RECOVERY AND AUDIT") additions.
// ---------------------------------------------------------------------------

/** §0.E's approved, conservative retry parameters -- see docs/acceptance/PHASE_5_ACCEPTANCE.md §0.E. */
export type RetryConfig = {
  /** Total attempts for a transient-class failure, including the first: 1 initial + 3 retries. */
  maxAttempts: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
};

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 2000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
};

/** Full jitter, per §0.E: uniform random in [0, computedDelay]. */
export function computeBackoffDelayMs(attemptNumber: number, config: RetryConfig): number {
  const raw = config.baseDelayMs * Math.pow(config.backoffMultiplier, attemptNumber - 1);
  const capped = Math.min(raw, config.maxDelayMs);
  return Math.random() * capped;
}

export type ExecutionResult = {
  ledgerRowId: string;
  videoId: string;
  /** The row's final LedgerStatus for this run -- deliberately the same type as the
   * ledger's own status (not a separate parallel enum), so a report can never drift out
   * of sync with what the ledger itself says. */
  status: LedgerStatus;
  detail?: string;
  /** Only present for a CONFLICT outcome -- the specific changes whose approval-time
   * baseline no longer matches the live remote value (AC-CONFLICT-01/AC-LEDGER-04).
   * Previously dropped by two of the (at the time three, now four) code paths that can
   * produce a CONFLICT ExecutionResult, even though the audit record for the identical
   * event always included it (independent review, second cycle). */
  conflictingChangeIds?: string[];
  /** True only for a reconciliation-confirmed SUCCESS/CONFLICT or crash-recovered result
   * -- distinguishes "this attempt's own response was observed" from "the outcome was
   * established by a later remote read" (AC-AUDIT-05). Absent for FAILED/UNKNOWN/etc. */
  ownResponseObserved?: boolean;
  /** True when this FAILED result came from a WriteExecutorResult marked `systemic` --
   * the caller (executeBatch) must halt all remaining not-yet-attempted rows rather than
   * treating this as an isolated item-level failure. */
  systemic?: boolean;
};

export type BatchExecutionSummary = {
  batchId: string;
  results: ExecutionResult[];
  /** True if a systemic condition (e.g. quota exhaustion) stopped the batch before every
   * row was processed -- the remaining, never-reached rows are reported as
   * ABORTED_SYSTEMIC, not silently missing. */
  haltedSystemically: boolean;
};

export type RecoveredRow = {
  ledgerRowId: string;
  videoId: string;
  previousStatus: LedgerStatus;
  resultingStatus: LedgerStatus;
};

export type BatchRecoveryResult = {
  batchId: string;
  recovered: RecoveredRow[];
};

// ---------------------------------------------------------------------------
// Slice 2 ("SAFETY PREPARATION") additions.
// ---------------------------------------------------------------------------

/**
 * The minimal shape of a `changesets` module `Change` row this module needs to re-check
 * approval/payload integrity before every send (AC-BATCH-03) -- deliberately narrow
 * (§6.2: modules stay independent) rather than importing changesets' own types.
 */
export type PendingChangeRecord = {
  id: string;
  videoId: string;
  language: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  /**
   * Independent-review finding (2026-09-18, Slice 5): a frozen snapshot of `proposedValue`
   * taken at the moment `approvalStatus` last became `"approved"` (`null` if never
   * approved, or after a rejection) -- mirrors `src/lib/changesets/contracts.ts`'s
   * `Change.approvedValue`. Required so `assertApprovalStillValid` can detect AC-BATCH-03
   * sub-case (c)/AC-TIMEOUT-02: a change whose `proposedValue` was edited after approval
   * while `approvalStatus` itself was left `"approved"`. Checking `approvalStatus` alone
   * (this module's only check before this fix) cannot catch that case -- the status
   * genuinely still says "approved", just no longer for the value now present.
   */
  approvedValue: string | null;
  approvalStatus: "pending" | "approved" | "rejected";
  validationStatus: "valid" | "invalid";
  conflictStatus: "none" | "conflict";
  /**
   * Optional for the same reason as `PendingChange.changeType` in `merge.ts` -- added
   * 2026-09-21 for the deletion feature (docs/PROJECT_SPEC.md §16), absent/undefined
   * behaves exactly like "add"/"modify"/"unchanged" everywhere it is read.
   */
  changeType?: "add" | "modify" | "unchanged" | "delete";
};

export type PreparedRowOutcome =
  | { ledgerRowId: string; videoId: string; status: "DRY_RUN_COMPLETE"; payload: PreparedPayload }
  | { ledgerRowId: string; videoId: string; status: "AWAITING_EXECUTION"; payload: PreparedPayload }
  | { ledgerRowId: string; videoId: string; status: "FAILED"; error: string }
  | { ledgerRowId: string; videoId: string; status: "CONFLICT"; conflictingChangeIds: string[] };

/**
 * Slice 4 addition: `videoId` was missing from this type through Slices 1-3 -- nothing
 * in those slices ever needed to address a specific video from the payload alone, since
 * no real WriteExecutor existed yet and every caller had `row.videoId` available
 * separately. A real `WriteExecutor.attemptWrite(payload)` genuinely cannot call
 * `videos.update` without knowing which video to target, so `videoId` is added here
 * (the single canonical payload shape) rather than passed as a second, parallel
 * argument to `attemptWrite` -- this keeps the durable attempt snapshot (`payloadSnapshot`
 * in `src/lib/db.ts`), the audit trail, and what the executor actually receives all
 * identically shaped, with no separate "enrichment" step that could drift out of sync.
 */
export type PreparedPayload = {
  videoId: string;
  snippet: Record<string, unknown>;
  localizations: Record<string, { title: string; description: string }>;
};

export type PrepareBatchExecutionResult = {
  batchId: string;
  rows: PreparedRowOutcome[];
};
