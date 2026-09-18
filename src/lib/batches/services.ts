import {
  ALLOWED_LEDGER_TRANSITIONS,
  DEFAULT_RETRY_CONFIG,
  DomainError,
  TERMINAL_LEDGER_STATUSES,
  computeBackoffDelayMs,
  type Attempt,
  type AttemptOutcome,
  type Batch,
  type BatchExecutionSummary,
  type BatchRecoveryResult,
  type BatchStatus,
  type ExecutionResult,
  type LedgerRow,
  type LedgerStatus,
  type PendingChangeRecord,
  type PrepareBatchExecutionResult,
  type PreparedPayload,
  type PreparedRowOutcome,
  type RetryConfig,
  type StoredAttemptRecord,
  type StoredBatchRecord,
  type StoredLedgerRowRecord,
  type WriteExecutor,
  type WriteExecutorResult,
} from "./contracts";
import { createBatchInputSchema, DEFAULT_CONCURRENCY, parseWithSchema, type CreateBatchInput } from "./schemas";
import {
  buildSafeLocalizationsPayload,
  checkDefaultLanguage,
  classifyFreshStateAgainstAttempt,
  detectPreWriteConflict,
  type FreshVideoContext,
  type PendingChange,
} from "./merge";
import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import type { CredentialRef, ResolvedCredentials } from "@/lib/video-metadata/contracts";

type BatchStoreDeps = {
  createBatchWithLedger(input: {
    id: string;
    channelId: string;
    concurrency: number;
    dryRun: boolean;
    ledgerRows: Array<{ id: string; videoId: string; changeIds: string[] }>;
  }): Promise<void>;
  getBatch(batchId: string): Promise<StoredBatchRecord | null>;
  listLedgerRowsByBatch(batchId: string): Promise<StoredLedgerRowRecord[]>;
  getLedgerRow(ledgerRowId: string): Promise<StoredLedgerRowRecord | null>;
  claimBatchExecution(batchId: string, runId: string): Promise<boolean>;
  markBatchTerminal(batchId: string, status: Extract<BatchStatus, "COMPLETED" | "ABORTED">): Promise<void>;
  acquireVideoExecutionLock(input: {
    videoId: string;
    batchId: string;
    ledgerRowId: string;
  }): Promise<boolean>;
  releaseVideoExecutionLock(input: { videoId: string; batchId: string }): Promise<void>;
  getVideoExecutionLockHolder(
    videoId: string
  ): Promise<{ batchId: string; ledgerRowId: string; lockedAt: Date } | null>;
  transitionLedgerRowStatus(input: {
    ledgerRowId: string;
    from: LedgerStatus[];
    to: LedgerStatus;
    error?: string | null;
    verificationResult?: unknown;
  }): Promise<boolean>;
  beginAttemptIntent(input: {
    id: string;
    ledgerRowId: string;
    attemptNumber: number;
    payloadSnapshot: unknown;
  }): Promise<boolean>;
  recordAttemptResult(input: {
    attemptId: string;
    outcome: AttemptOutcome;
    outcomeDetail: string | null;
  }): Promise<boolean>;
  listAttemptsByLedgerRow(ledgerRowId: string): Promise<StoredAttemptRecord[]>;
  listAttemptsByBatch(batchId: string): Promise<StoredAttemptRecord[]>;
  getAttempt(attemptId: string): Promise<StoredAttemptRecord | null>;
};

type AuditDeps = {
  record(input: {
    batchId: string;
    ledgerRowId: string;
    videoId: string;
    eventType: "PREPARATION" | "ATTEMPT" | "RESULT" | "CONFLICT" | "VERIFICATION" | "DRY_RUN" | "RECONCILIATION";
    detail: unknown;
  }): Promise<void>;
};

type ClockDeps = {
  wait(ms: number): Promise<void>;
};

type ChangeSetStoreDeps = {
  getChange(changeId: string): Promise<PendingChangeRecord | null>;
};

type AuthResolverDeps = {
  resolve(args: { credentialRef: CredentialRef; requiredScopes: readonly string[] }): Promise<ResolvedCredentials>;
};

type WriteContextDeps = {
  assertWriteChannel(args: {
    credentialRef: CredentialRef;
    credentials: ResolvedCredentials;
    expectedChannelId?: string;
  }): Promise<{ expectedChannelId: string; shouldPersistSelection: boolean; userId: string | null }>;
};

type BatchYoutubeApiDeps = {
  fetchFreshVideoContext(args: {
    credentials: ResolvedCredentials;
    videoId: string;
  }): Promise<{ snippet: Record<string, unknown>; localizations: Record<string, { title: string; description: string }> } | null>;
};

type BackupDeps = {
  checkInfrastructureHealth(): Promise<{ healthy: boolean; error?: string }>;
  captureBackup(args: {
    channelId: string;
    batchId: string;
    videoId: string;
    snapshot: { defaultLanguage: string | null; existingLocalizations: Record<string, { title: string; description: string }> };
  }): Promise<{ path: string; capturedAt: string }>;
};

type ServiceDependencies = {
  batchStore: BatchStoreDeps;
  changeSetStore: ChangeSetStoreDeps;
  authResolver: AuthResolverDeps;
  writeContext: WriteContextDeps;
  youtubeApi: BatchYoutubeApiDeps;
  backup: BackupDeps;
  audit: AuditDeps;
  clock: ClockDeps;
  retryConfig?: RetryConfig;
  idGenerator: () => string;
  logger: {
    info(payload: { event: string; context?: Record<string, unknown> }): void;
    error(payload: { event: string; context?: Record<string, unknown> }): void;
  };
};

function toBatch(record: StoredBatchRecord): Batch {
  return {
    id: record.id,
    channelId: record.channelId,
    status: record.status,
    concurrency: record.concurrency,
    dryRun: record.dryRun,
    runId: record.runId,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt ? record.startedAt.toISOString() : null,
    completedAt: record.completedAt ? record.completedAt.toISOString() : null,
  };
}

function toLedgerRow(record: StoredLedgerRowRecord): LedgerRow {
  return {
    id: record.id,
    batchId: record.batchId,
    videoId: record.videoId,
    changeIds: record.changeIds,
    status: record.status,
    error: record.error,
    verificationResult: record.verificationResult,
    activeAttemptId: record.activeAttemptId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toAttempt(record: StoredAttemptRecord): Attempt {
  return {
    id: record.id,
    ledgerRowId: record.ledgerRowId,
    attemptNumber: record.attemptNumber,
    phase: record.phase,
    payloadSnapshot: record.payloadSnapshot,
    requestedAt: record.requestedAt.toISOString(),
    outcome: record.outcome,
    outcomeDetail: record.outcomeDetail,
    resultAt: record.resultAt ? record.resultAt.toISOString() : null,
  };
}

/** Which current statuses may legally transition to `to`, per ALLOWED_LEDGER_TRANSITIONS. */
function allowedFromStatuses(to: LedgerStatus): LedgerStatus[] {
  return (Object.keys(ALLOWED_LEDGER_TRANSITIONS) as LedgerStatus[]).filter((from) =>
    ALLOWED_LEDGER_TRANSITIONS[from].includes(to)
  );
}

/**
 * AC-BATCH-03 / AC-MERGE-04: a change must be exactly `approved` + `valid` +
 * non-conflicting to be published, checked identically whether this is the first time
 * (batch creation) or a re-check immediately before send (§0.F Step 4's "re-run the full
 * safety pipeline") -- one function, two call sites, per architectural decision #3.
 */
function assertApprovalStillValid(change: PendingChangeRecord): void {
  if (change.approvalStatus !== "approved" || change.validationStatus !== "valid" || change.conflictStatus !== "none") {
    throw new DomainError({
      code: "change_approval_invalid",
      message: `Change ${change.id} is not (or is no longer) approved/valid/non-conflicting -- approvalStatus=${change.approvalStatus}, validationStatus=${change.validationStatus}, conflictStatus=${change.conflictStatus}`,
      details: { changeId: change.id },
    });
  }
}

export function createBatchServices(deps: ServiceDependencies) {
  const { batchStore, changeSetStore, idGenerator, logger, audit } = deps;
  const retryConfig = deps.retryConfig ?? DEFAULT_RETRY_CONFIG;

  async function requireChangeForVideo(changeId: string, videoId: string): Promise<PendingChangeRecord> {
    const change = await changeSetStore.getChange(changeId);
    if (!change) {
      throw new DomainError({
        code: "batch_invalid_selection",
        message: `Change ${changeId} not found`,
        details: { changeId },
      });
    }
    if (change.videoId !== videoId) {
      throw new DomainError({
        code: "batch_invalid_selection",
        message: `Change ${changeId} belongs to video ${change.videoId}, not ${videoId}`,
        details: { changeId, expectedVideoId: videoId, actualVideoId: change.videoId },
      });
    }
    return change;
  }

  async function createBatch(rawInput: CreateBatchInput): Promise<Batch> {
    const input = parseWithSchema(createBatchInputSchema, rawInput, "createBatch input");

    const seenVideoIds = new Set<string>();
    for (const selection of input.selections) {
      if (seenVideoIds.has(selection.videoId)) {
        throw new DomainError({
          code: "batch_invalid_selection",
          message: `Duplicate videoId ${selection.videoId} in batch selection -- exactly one ledger row per video is required (DEC-OQ-1)`,
          details: { videoId: selection.videoId },
        });
      }
      seenVideoIds.add(selection.videoId);

      // AC-MERGE-04: pending/invalid/conflicting/unselected changes must never reach
      // payload construction -- checked here at creation time (defense in depth; the
      // authoritative re-check immediately before send is assertApprovalStillValid,
      // reused in prepareLedgerRow below per AC-BATCH-03).
      for (const changeId of selection.changeIds) {
        const change = await requireChangeForVideo(changeId, selection.videoId);
        assertApprovalStillValid(change);
      }
    }

    const batchId = idGenerator();
    const ledgerRows = input.selections.map((selection) => ({
      id: idGenerator(),
      videoId: selection.videoId,
      changeIds: selection.changeIds,
    }));

    await batchStore.createBatchWithLedger({
      id: batchId,
      channelId: input.channelId,
      concurrency: input.concurrency ?? DEFAULT_CONCURRENCY,
      dryRun: input.dryRun ?? true,
      ledgerRows,
    });

    logger.info({
      event: "batch.created",
      context: { batchId, channelId: input.channelId, videoCount: ledgerRows.length },
    });

    const stored = await requireBatch(batchId);
    return toBatch(stored);
  }

  async function requireBatch(batchId: string): Promise<StoredBatchRecord> {
    const batch = await batchStore.getBatch(batchId);
    if (!batch) {
      throw new DomainError({ code: "batch_not_found", message: `Batch ${batchId} not found` });
    }
    return batch;
  }

  async function requireLedgerRow(ledgerRowId: string): Promise<StoredLedgerRowRecord> {
    const row = await batchStore.getLedgerRow(ledgerRowId);
    if (!row) {
      throw new DomainError({
        code: "ledger_row_not_found",
        message: `Ledger row ${ledgerRowId} not found`,
      });
    }
    return row;
  }

  async function getBatch(batchId: string): Promise<Batch> {
    return toBatch(await requireBatch(batchId));
  }

  /** Membership is fixed at creation (AC-BATCH-01/02) -- this never filters or re-derives it. */
  async function listLedgerRows(batchId: string): Promise<LedgerRow[]> {
    await requireBatch(batchId);
    const rows = await batchStore.listLedgerRowsByBatch(batchId);
    return rows.map(toLedgerRow);
  }

  /** Atomic PENDING -> RUNNING claim; fails if the batch is already running (AC-CONCURRENCY-02/03). */
  async function claimBatchExecution(batchId: string): Promise<{ runId: string }> {
    await requireBatch(batchId);
    const runId = idGenerator();
    const claimed = await batchStore.claimBatchExecution(batchId, runId);
    if (!claimed) {
      throw new DomainError({
        code: "batch_already_running",
        message: `Batch ${batchId} is already running or not in PENDING status`,
        details: { batchId },
      });
    }
    logger.info({ event: "batch.execution_claimed", context: { batchId, runId } });
    return { runId };
  }

  async function completeBatchExecution(
    batchId: string,
    status: Extract<BatchStatus, "COMPLETED" | "ABORTED">
  ): Promise<void> {
    await requireBatch(batchId);
    await batchStore.markBatchTerminal(batchId, status);
    logger.info({ event: "batch.execution_completed", context: { batchId, status } });
  }

  /** Cross-batch exclusive lock on one video (AC-CONCURRENCY-01). Fails closed on conflict. */
  async function acquireVideoLock(input: {
    batchId: string;
    ledgerRowId: string;
    videoId: string;
  }): Promise<void> {
    const acquired = await batchStore.acquireVideoExecutionLock(input);
    if (!acquired) {
      const holder = await batchStore.getVideoExecutionLockHolder(input.videoId);
      throw new DomainError({
        code: "video_locked",
        message: `Video ${input.videoId} is already locked by another batch execution`,
        details: { videoId: input.videoId, holder },
      });
    }
  }

  async function releaseVideoLock(input: { batchId: string; videoId: string }): Promise<void> {
    await batchStore.releaseVideoExecutionLock(input);
  }

  function toFreshVideoContext(raw: {
    snippet: Record<string, unknown>;
    localizations: Record<string, { title: string; description: string }>;
  }): FreshVideoContext {
    const rawDefaultLanguage = raw.snippet.defaultLanguage;
    return {
      snippet: {
        ...raw.snippet,
        title: typeof raw.snippet.title === "string" ? raw.snippet.title : "",
        description: typeof raw.snippet.description === "string" ? raw.snippet.description : "",
        defaultLanguage: typeof rawDefaultLanguage === "string" ? rawDefaultLanguage : null,
      },
      localizations: raw.localizations,
    };
  }

  async function loadChangesForRow(row: StoredLedgerRowRecord): Promise<PendingChangeRecord[]> {
    return Promise.all(row.changeIds.map((changeId) => requireChangeForVideo(changeId, row.videoId)));
  }

  function toPendingChanges(changeRecords: PendingChangeRecord[]): PendingChange[] {
    return changeRecords.map((change) => ({
      id: change.id,
      language: change.language,
      field: change.field,
      baselineValue: change.baselineValue,
      proposedValue: change.proposedValue,
    }));
  }

  type SafetyPipelineResult =
    | { outcome: "FAILED"; error: string }
    | { outcome: "CONFLICT"; conflictingChangeIds: string[] }
    | { outcome: "READY"; payload: PreparedPayload; changes: PendingChangeRecord[] };

  /**
   * The single shared "is it still safe to send this payload right now" pipeline:
   * approval/payload-integrity re-check (AC-BATCH-03), fresh single-video fetch (never
   * the preliminary batched pass -- architectural decision #2), defaultLanguage check
   * (AC-DEFAULTLANG-01/02), pre-write conflict detection against that fresh fetch
   * (AC-CONFLICT-01/AC-LEDGER-04), optional backup (AC-BACKUP-01/02), and safe merge
   * (AC-MERGE-01..04, AC-MULTI-01). Used identically by:
   *   - prepareLedgerRow (Slice 2 entry point, from PENDING, captures backup)
   *   - executeBatch's per-attempt-cycle re-check (Slice 3, "immediately before send",
   *     backup already captured -- never re-captured)
   *   - resolveUnknownLedgerRow (§0.F Step 4's mandatory full pipeline re-run for an
   *     UNKNOWN row, backup already captured)
   * per architectural decision #3/#4: one guardrail, reused, never duplicated.
   */
  async function runSafetyPipeline(args: {
    row: StoredLedgerRowRecord;
    batch: StoredBatchRecord;
    credentials: ResolvedCredentials;
    captureBackupNow: boolean;
  }): Promise<SafetyPipelineResult> {
    const { row, batch, credentials } = args;

    let changeRecords: PendingChangeRecord[];
    try {
      changeRecords = await loadChangesForRow(row);
      for (const change of changeRecords) assertApprovalStillValid(change);
    } catch (error) {
      return { outcome: "FAILED", error: error instanceof DomainError ? error.message : String(error) };
    }

    const rawFresh = await deps.youtubeApi.fetchFreshVideoContext({ credentials, videoId: row.videoId });
    if (!rawFresh) {
      return { outcome: "FAILED", error: `Video ${row.videoId} not found on fresh fetch` };
    }
    const fresh = toFreshVideoContext(rawFresh);

    const defaultLanguageCheck = checkDefaultLanguage(fresh.snippet);
    if (!defaultLanguageCheck.ok) {
      return { outcome: "FAILED", error: defaultLanguageCheck.reason };
    }

    const pendingChanges = toPendingChanges(changeRecords);

    const conflict = detectPreWriteConflict(pendingChanges, fresh);
    if (conflict.status === "conflict") {
      return { outcome: "CONFLICT", conflictingChangeIds: conflict.conflictingChangeIds };
    }

    if (args.captureBackupNow) {
      try {
        await deps.backup.captureBackup({
          channelId: batch.channelId,
          batchId: batch.id,
          videoId: row.videoId,
          snapshot: { defaultLanguage: fresh.snippet.defaultLanguage, existingLocalizations: fresh.localizations },
        });
      } catch (error) {
        return { outcome: "FAILED", error: error instanceof DomainError ? error.message : String(error) };
      }
    }

    const payload = buildSafeLocalizationsPayload(fresh, pendingChanges);
    return { outcome: "READY", payload, changes: changeRecords };
  }

  /**
   * Slice 2 entry point: runs the safety pipeline for one ledger row starting from
   * PENDING, capturing its backup. For a dry-run batch this is the entire pipeline
   * (AC-DRYRUN-01/02/03: identity/fetch/merge/diff/backup all run, nothing is sent, the
   * row lands on the dedicated DRY_RUN_COMPLETE terminal state). For a live batch this
   * stops at AWAITING_EXECUTION with the video lock held -- executeBatch (Slice 3)
   * re-runs the pipeline once more immediately before the actual attempt (the mandatory
   * "fresh check right before send", not merely "fresh at preparation time").
   */
  async function prepareLedgerRow(args: {
    row: StoredLedgerRowRecord;
    batch: StoredBatchRecord;
    credentials: ResolvedCredentials;
  }): Promise<PreparedRowOutcome> {
    const { row, batch } = args;

    await acquireVideoLock({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId });
    await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "PREPARATION", detail: { dryRun: batch.dryRun } });

    const result = await runSafetyPipeline({ ...args, captureBackupNow: true });

    if (result.outcome === "FAILED") {
      await transitionLedgerStatus(row.id, "FAILED", { error: result.error });
      await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      return { ledgerRowId: row.id, videoId: row.videoId, status: "FAILED", error: result.error };
    }

    if (result.outcome === "CONFLICT") {
      await transitionLedgerStatus(row.id, "CONFLICT");
      await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "CONFLICT", detail: { conflictingChangeIds: result.conflictingChangeIds } });
      await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      return { ledgerRowId: row.id, videoId: row.videoId, status: "CONFLICT", conflictingChangeIds: result.conflictingChangeIds };
    }

    if (batch.dryRun) {
      await transitionLedgerStatus(row.id, "DRY_RUN_COMPLETE");
      await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "DRY_RUN", detail: { payload: result.payload } });
      await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      return { ledgerRowId: row.id, videoId: row.videoId, status: "DRY_RUN_COMPLETE", payload: result.payload };
    }

    await transitionLedgerStatus(row.id, "AWAITING_EXECUTION");
    // Live batch: prepared and ready, video lock stays held -- executeBatch continues.
    return { ledgerRowId: row.id, videoId: row.videoId, status: "AWAITING_EXECUTION", payload: result.payload };
  }

  /**
   * Batch-level orchestration entry point for Slice 2. Order, per the approved plan:
   * claim (AC-CONCURRENCY-02/03) -> identity check (AC-GUARD-01, whole batch fails
   * closed before any write/backup) -> backup-infrastructure health (AC-BACKUP-04, whole
   * batch halts before any per-video work) -> per-video preparation, isolated so one
   * video's FAILED/CONFLICT never stops the rest (full systemic-abort/retry/audit
   * semantics remain Slice 3's scope; this is the minimal isolation Slice 2 itself needs
   * to not fail an entire batch over one bad video).
   */
  async function prepareBatchExecution(input: {
    batchId: string;
    credentialRef: CredentialRef;
    expectedChannelId?: string;
  }): Promise<PrepareBatchExecutionResult> {
    const batch = await requireBatch(input.batchId);
    await claimBatchExecution(input.batchId);

    let credentials: ResolvedCredentials;
    try {
      credentials = await deps.authResolver.resolve({ credentialRef: input.credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
      await deps.writeContext.assertWriteChannel({
        credentialRef: input.credentialRef,
        credentials,
        expectedChannelId: input.expectedChannelId ?? batch.channelId,
      });
    } catch (error) {
      await batchStore.markBatchTerminal(input.batchId, "ABORTED");
      logger.error({ event: "batch.aborted_systemic", context: { batchId: input.batchId, reason: "identity_guardrail" } });
      throw error;
    }

    const backupHealth = await deps.backup.checkInfrastructureHealth();
    if (!backupHealth.healthy) {
      const rows = await batchStore.listLedgerRowsByBatch(input.batchId);
      for (const row of rows) {
        if (row.status === "PENDING") {
          await batchStore.transitionLedgerRowStatus({ ledgerRowId: row.id, from: ["PENDING"], to: "ABORTED_SYSTEMIC" });
        }
      }
      await batchStore.markBatchTerminal(input.batchId, "ABORTED");
      logger.error({ event: "batch.aborted_systemic", context: { batchId: input.batchId, reason: "backup_infrastructure" } });
      throw new DomainError({
        code: "backup_infrastructure_unavailable",
        message: `Backup storage unavailable: ${backupHealth.error ?? "unknown reason"}`,
        details: { batchId: input.batchId },
      });
    }

    const ledgerRows = await batchStore.listLedgerRowsByBatch(input.batchId);
    const outcomes: PreparedRowOutcome[] = [];

    for (const row of ledgerRows) {
      try {
        outcomes.push(await prepareLedgerRow({ row, batch, credentials }));
      } catch (error) {
        logger.error({
          event: "ledger_row.preparation_failed",
          context: { ledgerRowId: row.id, error: error instanceof Error ? error.message : String(error) },
        });
        outcomes.push({
          ledgerRowId: row.id,
          videoId: row.videoId,
          status: "FAILED",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    if (batch.dryRun) {
      await batchStore.markBatchTerminal(input.batchId, "COMPLETED");
    }
    // Live batch: intentionally left RUNNING -- see prepareLedgerRow's comment.

    return { batchId: input.batchId, rows: outcomes };
  }

  /**
   * The single enforcement point for ledger transitions at the service layer -- delegates
   * the actual atomicity to `transitionLedgerRowStatus`'s guarded `from`/`to` UPDATE, so
   * a transition can never be observed as having "half happened" under concurrent access.
   */
  async function transitionLedgerStatus(
    ledgerRowId: string,
    to: LedgerStatus,
    patch: { error?: string | null; verificationResult?: unknown } = {}
  ): Promise<LedgerRow> {
    const from = allowedFromStatuses(to);
    const succeeded = await batchStore.transitionLedgerRowStatus({
      ledgerRowId,
      from,
      to,
      ...patch,
    });

    if (!succeeded) {
      const current = await batchStore.getLedgerRow(ledgerRowId);
      throw new DomainError({
        code: "ledger_invalid_transition",
        message: current
          ? `Cannot transition ledger row ${ledgerRowId} from ${current.status} to ${to}`
          : `Ledger row ${ledgerRowId} not found`,
        details: { ledgerRowId, to, currentStatus: current?.status ?? null },
      });
    }

    return toLedgerRow(await requireLedgerRow(ledgerRowId));
  }

  /**
   * Durably commits the attempt's INTENDED record and, only if the ledger row was
   * AWAITING_EXECUTION (its first attempt this cycle), transitions it to APPLYING first.
   * The caller must await this function's resolution BEFORE invoking the write executor
   * -- see AC-ATTEMPT-03. This function never itself calls a WriteExecutor; that ordering
   * guarantee is the caller's responsibility (see `executeSingleAttempt`/`executeWithRetry`
   * below for the reference sequencing).
   *
   * Precondition: the row must be AWAITING_EXECUTION (first attempt) or already APPLYING
   * (an ordinary retry within the same attempt cycle -- see executeWithRetry). There is
   * deliberately no direct PENDING/UNKNOWN -> APPLYING path: both must first pass through
   * (re-)preparation (prepareLedgerRow / resolveUnknownLedgerRow), which lands on
   * AWAITING_EXECUTION -- this makes a fresh approval/conflict check structurally
   * unavoidable before every first attempt, never bypassable by calling beginAttempt
   * directly on a stale row.
   *
   * Enforces "at most one active (unresolved) attempt per ledger row at any time" via
   * `batchStore.beginAttemptIntent`'s atomic claim-then-insert (see src/lib/db.ts) --
   * this is NOT merely detected after the fact by the attempt-number UNIQUE constraint;
   * a losing concurrent caller's attempt number is simply never written. If the ledger
   * row already has an active attempt (including one left behind by a crashed process
   * that never completed -- see recoverBatch), this throws `attempt_already_active`
   * rather than silently queuing or overwriting.
   */
  async function beginAttempt(
    ledgerRowId: string,
    payloadSnapshot: unknown
  ): Promise<{ attemptId: string; attemptNumber: number }> {
    const row = await requireLedgerRow(ledgerRowId);

    if (row.status === "AWAITING_EXECUTION") {
      await transitionLedgerStatus(ledgerRowId, "APPLYING");
    } else if (row.status !== "APPLYING") {
      throw new DomainError({
        code: "ledger_invalid_transition",
        message: `Ledger row ${ledgerRowId} must be AWAITING_EXECUTION or APPLYING to begin an attempt (found ${row.status})`,
        details: { ledgerRowId, status: row.status },
      });
    }

    const existingAttempts = await batchStore.listAttemptsByLedgerRow(ledgerRowId);
    const attemptNumber = existingAttempts.length + 1;
    const attemptId = idGenerator();

    const claimed = await batchStore.beginAttemptIntent({
      id: attemptId,
      ledgerRowId,
      attemptNumber,
      payloadSnapshot,
    });

    if (!claimed) {
      throw new DomainError({
        code: "attempt_already_active",
        message: `Ledger row ${ledgerRowId} already has an active, unresolved attempt`,
        details: { ledgerRowId },
      });
    }

    logger.info({
      event: "attempt.intent_recorded",
      context: { ledgerRowId, attemptId, attemptNumber },
    });

    return { attemptId, attemptNumber };
  }

  /** Guarded: an attempt can only move from INTENDED to RESULT_RECORDED once. */
  async function completeAttempt(
    attemptId: string,
    outcome: AttemptOutcome,
    detail: string | null
  ): Promise<void> {
    const recorded = await batchStore.recordAttemptResult({
      attemptId,
      outcome,
      outcomeDetail: detail,
    });

    if (!recorded) {
      throw new DomainError({
        code: "attempt_already_resolved",
        message: `Attempt ${attemptId} was not found in INTENDED phase (already resolved, or does not exist)`,
        details: { attemptId },
      });
    }

    logger.info({ event: "attempt.result_recorded", context: { attemptId, outcome } });
  }

  /**
   * Reference sequencing that satisfies AC-ATTEMPT-03: `beginAttempt`'s durable INTENDED
   * commit is fully awaited before `executor.attemptWrite` is ever called. Slice 1 wires
   * only a fake `WriteExecutor` (tests); Slice 4 substitutes the real YouTube adapter
   * behind the identical interface, without changing this ordering.
   */
  async function executeSingleAttempt(
    ledgerRowId: string,
    payloadSnapshot: unknown,
    executor: WriteExecutor
  ): Promise<{ attemptId: string; attemptNumber: number; result: WriteExecutorResult }> {
    const { attemptId, attemptNumber } = await beginAttempt(ledgerRowId, payloadSnapshot);
    const result = await executor.attemptWrite(payloadSnapshot);
    await completeAttempt(attemptId, result.outcome, result.detail ?? null);
    return { attemptId, attemptNumber, result };
  }

  // -------------------------------------------------------------------------
  // Slice 3 ("RECOVERY AND AUDIT").
  // -------------------------------------------------------------------------

  /**
   * §0.F: the bounded, two-read reconciliation procedure for an outcome-unknown attempt.
   * Never issues a retry itself -- only ever resolves to SUCCESS (goal-state confirmed),
   * CONFLICT (a third party's value), or UNKNOWN (insufficient evidence, requiring a
   * separate later pass or explicit operator action). The row is assumed to already be
   * APPLYING when this is called (via executeWithRetry after an UNKNOWN attempt result,
   * or via recoverLedgerRow after a crash).
   */
  async function reconcileAttempt(args: {
    row: StoredLedgerRowRecord;
    batch: StoredBatchRecord;
    changes: PendingChangeRecord[];
    credentials: ResolvedCredentials;
  }): Promise<ExecutionResult> {
    const { row, batch, credentials } = args;
    const pendingChanges = toPendingChanges(args.changes);

    const finalizeSuccess = async (): Promise<ExecutionResult> => {
      await transitionLedgerStatus(row.id, "SUCCESS", {
        verificationResult: { resolvedVia: "reconciliation", ownResponseObserved: false, confirmedAt: new Date().toISOString() },
      });
      await audit.record({
        batchId: batch.id,
        ledgerRowId: row.id,
        videoId: row.videoId,
        eventType: "VERIFICATION",
        detail: { resolvedVia: "reconciliation", ownResponseObserved: false },
      });
      await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      return { ledgerRowId: row.id, videoId: row.videoId, status: "SUCCESS", ownResponseObserved: false };
    };

    const finalizeConflict = async (): Promise<ExecutionResult> => {
      await transitionLedgerStatus(row.id, "CONFLICT");
      await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "CONFLICT", detail: { detectedVia: "reconciliation" } });
      await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      return { ledgerRowId: row.id, videoId: row.videoId, status: "CONFLICT" };
    };

    const finalizeUnknown = async (reason: string): Promise<ExecutionResult> => {
      await transitionLedgerStatus(row.id, "UNKNOWN");
      // Lock is deliberately NOT released -- an UNKNOWN row must never be reacquirable by
      // another batch while its outcome is unresolved (see the Foundation verification's
      // "how UNKNOWN prevents unsafe reacquisition" analysis).
      return { ledgerRowId: row.id, videoId: row.videoId, status: "UNKNOWN", detail: reason };
    };

    const read1 = await deps.youtubeApi.fetchFreshVideoContext({ credentials, videoId: row.videoId });
    const classification1 = read1 ? classifyFreshStateAgainstAttempt(pendingChanges, toFreshVideoContext(read1)) : "diverged";
    await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "RECONCILIATION", detail: { step: 1, classification: classification1 } });

    if (classification1 === "matches_requested") return finalizeSuccess();
    if (classification1 === "diverged") return finalizeConflict();

    // matches_baseline -- inconclusive by itself (§0.F Step 1), proceed to Step 2.
    await deps.clock.wait(retryConfig.baseDelayMs);

    const read2 = await deps.youtubeApi.fetchFreshVideoContext({ credentials, videoId: row.videoId });
    const classification2 = read2 ? classifyFreshStateAgainstAttempt(pendingChanges, toFreshVideoContext(read2)) : "diverged";
    await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "RECONCILIATION", detail: { step: 2, classification: classification2 } });

    if (classification2 === "matches_requested") return finalizeSuccess();

    // Both a consistent-negative (matches_baseline again) and a diverged/inconsistent
    // second read land here -- §0.F Step 3: neither, by itself or together, ever
    // authorizes an automatic retry.
    return finalizeUnknown(
      classification2 === "matches_baseline"
        ? "Two consistent reconciliation reads still show the pre-write baseline -- insufficient evidence either way"
        : "Reconciliation reads were inconsistent -- insufficient evidence either way"
    );
  }

  /**
   * §0.F Step 4 / AC-TIMEOUT-02: resolves an UNKNOWN ledger row by re-running the FULL
   * safety pipeline (never a bare resend of the original payload) -- an explicit,
   * deliberate action (an operator decision, or a separate later independent pass), never
   * auto-triggered by this module. If the pipeline still finds everything valid, the row
   * returns to AWAITING_EXECUTION, ready for a genuinely new attempt cycle via
   * executeWithRetry/executeBatch.
   */
  async function resolveUnknownLedgerRow(args: {
    ledgerRowId: string;
    credentialRef: CredentialRef;
    expectedChannelId?: string;
  }): Promise<PreparedRowOutcome> {
    const row = await requireLedgerRow(args.ledgerRowId);
    if (row.status !== "UNKNOWN") {
      throw new DomainError({
        code: "ledger_invalid_transition",
        message: `Ledger row ${args.ledgerRowId} is not UNKNOWN (found ${row.status}) -- nothing to resolve`,
        details: { ledgerRowId: args.ledgerRowId, status: row.status },
      });
    }
    const batch = await requireBatch(row.batchId);

    const credentials = await deps.authResolver.resolve({ credentialRef: args.credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
    await deps.writeContext.assertWriteChannel({
      credentialRef: args.credentialRef,
      credentials,
      expectedChannelId: args.expectedChannelId ?? batch.channelId,
    });

    // The lock should already be held by this batch (never released while UNKNOWN) --
    // re-acquiring is the idempotent-same-owner case, not a fresh acquisition.
    await acquireVideoLock({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId });

    const result = await runSafetyPipeline({ row, batch, credentials, captureBackupNow: false });

    if (result.outcome === "FAILED") {
      await transitionLedgerStatus(row.id, "FAILED", { error: result.error });
      await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      return { ledgerRowId: row.id, videoId: row.videoId, status: "FAILED", error: result.error };
    }
    if (result.outcome === "CONFLICT") {
      await transitionLedgerStatus(row.id, "CONFLICT");
      await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "CONFLICT", detail: { conflictingChangeIds: result.conflictingChangeIds } });
      await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      return { ledgerRowId: row.id, videoId: row.videoId, status: "CONFLICT", conflictingChangeIds: result.conflictingChangeIds };
    }

    await transitionLedgerStatus(row.id, "AWAITING_EXECUTION");
    return { ledgerRowId: row.id, videoId: row.videoId, status: "AWAITING_EXECUTION", payload: result.payload };
  }

  /**
   * The bounded-retry attempt cycle for one ledger row, already AWAITING_EXECUTION (its
   * mandatory fresh pre-send check having just passed -- see executeBatch). Only
   * definitively-failed *transient* attempts are retried (§0.E), up to `maxAttempts`
   * total; a permanent classification or a UNKNOWN outcome never triggers an automatic
   * retry (UNKNOWN routes to reconcileAttempt instead, per §0.F). Every SUCCESS is
   * mandatorily verified (AC-VERIFY-01/02, AC-CONFLICT-02) before being trusted.
   */
  async function executeWithRetry(args: {
    row: StoredLedgerRowRecord;
    batch: StoredBatchRecord;
    payload: PreparedPayload;
    changes: PendingChangeRecord[];
    credentials: ResolvedCredentials;
    executor: WriteExecutor;
  }): Promise<ExecutionResult> {
    const { row, batch, payload, changes, credentials, executor } = args;
    const pendingChanges = toPendingChanges(changes);

    let attemptCount = 0;
    for (;;) {
      attemptCount++;
      const { attemptId, attemptNumber } = await beginAttempt(row.id, payload);
      await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "ATTEMPT", detail: { attemptId, attemptNumber } });

      const result = await executor.attemptWrite(payload);
      const outcomeDetail = result.outcome === "SUCCESS" ? result.detail ?? null : result.detail;
      await completeAttempt(attemptId, result.outcome, outcomeDetail);
      await audit.record({
        batchId: batch.id,
        ledgerRowId: row.id,
        videoId: row.videoId,
        eventType: "RESULT",
        detail: { attemptId, attemptNumber, outcome: result.outcome, ownResponseObserved: true, detail: outcomeDetail },
      });

      if (result.outcome === "SUCCESS") {
        const verifyRaw = await deps.youtubeApi.fetchFreshVideoContext({ credentials, videoId: row.videoId });
        const verifyClassification = verifyRaw
          ? classifyFreshStateAgainstAttempt(pendingChanges, toFreshVideoContext(verifyRaw))
          : "diverged";

        if (verifyClassification === "matches_requested") {
          await transitionLedgerStatus(row.id, "SUCCESS", {
            verificationResult: { resolvedVia: "own_response", ownResponseObserved: true, confirmedAt: new Date().toISOString() },
          });
          await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "VERIFICATION", detail: { resolvedVia: "own_response", ownResponseObserved: true, confirmed: true } });
          await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
          return { ledgerRowId: row.id, videoId: row.videoId, status: "SUCCESS", ownResponseObserved: true };
        }

        // AC-VERIFY-01/AC-CONFLICT-02: a 200 response alone is never sufficient -- a
        // mismatch here means either a partial apply or a same-instant external race.
        await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "VERIFICATION", detail: { confirmed: false, classification: verifyClassification } });
        await transitionLedgerStatus(row.id, "FAILED", { error: "Post-write verification mismatch: confirmed remote state does not match the requested value" });
        await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
        return { ledgerRowId: row.id, videoId: row.videoId, status: "FAILED", detail: "verification_mismatch" };
      }

      if (result.outcome === "FAILED") {
        if (result.systemic) {
          await transitionLedgerStatus(row.id, "FAILED", { error: result.detail });
          await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
          return { ledgerRowId: row.id, videoId: row.videoId, status: "FAILED", detail: result.detail, systemic: true };
        }

        const retriesExhausted = result.classification === "permanent" || attemptCount >= retryConfig.maxAttempts;
        if (retriesExhausted) {
          await transitionLedgerStatus(row.id, "FAILED", { error: result.detail });
          await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
          return { ledgerRowId: row.id, videoId: row.videoId, status: "FAILED", detail: result.detail };
        }

        // Transient, retries remain -- bounded exponential backoff with full jitter,
        // then a brand new attempt on the SAME still-APPLYING row (no re-preparation:
        // an ordinary retry of a known transient transport failure is not a §0.F
        // outcome-unknown case, and re-running the full pipeline for every retry would
        // contradict "reuse the shared guardrails, don't duplicate them for a case the
        // spec doesn't require it for").
        await deps.clock.wait(computeBackoffDelayMs(attemptCount, retryConfig));
        continue;
      }

      // UNKNOWN: never retried automatically -- always reconciled.
      return reconcileAttempt({ row: await requireLedgerRow(row.id), batch, changes, credentials });
    }
  }

  /**
   * Restores a single interrupted ledger row to a safe, explicit state. Only ever acts
   * on rows found APPLYING (a genuinely interrupted attempt) or on a terminal row that
   * still (incorrectly) holds its video lock (crash between finalizing status and
   * releasing the lock) -- every other status is left untouched, which is what makes
   * calling this repeatedly across restarts idempotent: once a row leaves APPLYING, a
   * second recovery pass finds nothing left to do for it.
   */
  async function recoverLedgerRow(args: {
    row: StoredLedgerRowRecord;
    batch: StoredBatchRecord;
    credentials: ResolvedCredentials;
  }): Promise<LedgerStatus | null> {
    const { row, batch, credentials } = args;

    if (TERMINAL_LEDGER_STATUSES.has(row.status)) {
      // Defensive cleanup: a terminal row must never hold a lock (crash between the
      // finalizing transition and releaseVideoLock). Idempotent no-op if already released
      // or held by someone else (which should not happen for a row this batch owns).
      const holder = await batchStore.getVideoExecutionLockHolder(row.videoId);
      if (holder && holder.batchId === batch.id && holder.ledgerRowId === row.id) {
        await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      }
      return null;
    }

    if (row.status !== "APPLYING") {
      // PENDING/AWAITING_EXECUTION/UNKNOWN: nothing "in flight" was interrupted here --
      // AC-RESUME-01's "PENDING may continue execution" applies unchanged; UNKNOWN
      // requires its own explicit resolveUnknownLedgerRow, never bundled into recovery.
      return null;
    }

    // The ledger row's activeAttemptId is already cleared (NULL) by the time an attempt
    // reaches RESULT_RECORDED (recordAttemptResult's job) -- so it can only ever locate
    // a still-unresolved (INTENDED) attempt, never the most recent one after resolution.
    // The attempt list, ordered by attemptNumber, always has the right one as its last
    // element regardless of which of those two situations this is.
    const attemptsForRow = await batchStore.listAttemptsByLedgerRow(row.id);
    const attempt = attemptsForRow.length > 0 ? attemptsForRow[attemptsForRow.length - 1] : null;
    const changes = await loadChangesForRow(row);

    if (!attempt || attempt.phase === "INTENDED") {
      // Covers both AC-ATTEMPT-04 sub-cases (crash before the network call was ever
      // issued, and crash after issuance but before any result was recorded) -- they are
      // indistinguishable from durable state alone and are handled identically, exactly
      // as the accepted contract requires: classify UNKNOWN, then reconcile. Note:
      // reconcileAttempt performs the APPLYING -> {SUCCESS,CONFLICT,UNKNOWN} transition
      // itself (see its finalize* helpers) -- this function must NOT pre-transition to
      // UNKNOWN first, or reconcileAttempt's own UNKNOWN finalize would attempt an
      // illegal UNKNOWN -> UNKNOWN self-transition.
      await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "RECONCILIATION", detail: { trigger: "crash_recovery", attemptPhase: attempt?.phase ?? "none" } });
      const outcome = await reconcileAttempt({ row, batch, changes, credentials });
      return outcome.status;
    }

    // attempt.phase === "RESULT_RECORDED" but the ledger row was never finalized --
    // crash between completeAttempt and transitionLedgerStatus, or between
    // transitionLedgerStatus and releaseVideoLock (handled by the terminal-status branch
    // above once this finalizes it).
    if (attempt.outcome === "FAILED") {
      await transitionLedgerStatus(row.id, "FAILED", { error: attempt.outcomeDetail ?? "Unknown failure" });
      await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      return "FAILED";
    }

    if (attempt.outcome === "UNKNOWN") {
      // Same non-pre-transition rule as above -- reconcileAttempt does APPLYING -> UNKNOWN
      // itself if it still can't resolve the outcome.
      const outcome = await reconcileAttempt({ row, batch, changes, credentials });
      return outcome.status;
    }

    // attempt.outcome === "SUCCESS": never trust a recorded SUCCESS blindly on recovery
    // -- re-verify via a fresh read first (AC-CRASH-01's causation-aware finalization).
    const pendingChanges = toPendingChanges(changes);
    const verifyRaw = await deps.youtubeApi.fetchFreshVideoContext({ credentials, videoId: row.videoId });
    const classification = verifyRaw ? classifyFreshStateAgainstAttempt(pendingChanges, toFreshVideoContext(verifyRaw)) : "diverged";

    if (classification === "matches_requested") {
      await transitionLedgerStatus(row.id, "SUCCESS", {
        verificationResult: { resolvedVia: "crash_recovery_reverification", ownResponseObserved: true, confirmedAt: new Date().toISOString() },
      });
      await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "VERIFICATION", detail: { resolvedVia: "crash_recovery_reverification", ownResponseObserved: true } });
      await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
      return "SUCCESS";
    }

    await transitionLedgerStatus(row.id, "FAILED", { error: "Post-crash re-verification mismatch" });
    await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
    return "FAILED";
  }

  /**
   * Idempotent across repeated calls/restarts (see recoverLedgerRow's contract): a
   * second call after everything has already been resolved finds no APPLYING rows left
   * and does nothing further. Never issues a duplicate write -- every path either reads
   * remote state or applies an already-known, durably-recorded outcome.
   */
  async function recoverBatch(input: {
    batchId: string;
    credentialRef: CredentialRef;
    expectedChannelId?: string;
  }): Promise<BatchRecoveryResult> {
    const batch = await requireBatch(input.batchId);
    const credentials = await deps.authResolver.resolve({ credentialRef: input.credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
    await deps.writeContext.assertWriteChannel({
      credentialRef: input.credentialRef,
      credentials,
      expectedChannelId: input.expectedChannelId ?? batch.channelId,
    });

    const rows = await batchStore.listLedgerRowsByBatch(input.batchId);
    const recovered: BatchRecoveryResult["recovered"] = [];

    for (const row of rows) {
      const previousStatus = row.status;
      const resultingStatus = await recoverLedgerRow({ row, batch, credentials });
      if (resultingStatus && resultingStatus !== previousStatus) {
        recovered.push({ ledgerRowId: row.id, videoId: row.videoId, previousStatus, resultingStatus });
      }
    }

    return { batchId: input.batchId, recovered };
  }

  /**
   * Slice 3 batch-level execution: continues a batch already prepared by
   * prepareBatchExecution (auto-preparing it first if it is still PENDING). For each
   * AWAITING_EXECUTION row, re-runs the mandatory fresh pre-send safety check (never
   * reusing the preparation-time payload as-is) and, if still safe, drives it through
   * executeWithRetry. Item-level failures never stop the batch (AC-ISOLATION-01); a
   * `systemic: true` WriteExecutorResult halts all remaining not-yet-attempted rows
   * (marked ABORTED_SYSTEMIC) without touching already-completed ones (AC-ISOLATION-02).
   */
  async function executeBatch(input: {
    batchId: string;
    credentialRef: CredentialRef;
    expectedChannelId?: string;
    executor: WriteExecutor;
  }): Promise<BatchExecutionSummary> {
    const initialBatch = await requireBatch(input.batchId);
    if (initialBatch.status === "PENDING") {
      await prepareBatchExecution({
        batchId: input.batchId,
        credentialRef: input.credentialRef,
        expectedChannelId: input.expectedChannelId,
      });
    }

    const batch = await requireBatch(input.batchId);
    const credentials = await deps.authResolver.resolve({ credentialRef: input.credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });

    const rows = await batchStore.listLedgerRowsByBatch(input.batchId);
    const results: ExecutionResult[] = [];
    let haltedSystemically = false;

    for (const row of rows) {
      if (haltedSystemically) {
        if (row.status === "PENDING" || row.status === "AWAITING_EXECUTION") {
          await batchStore.transitionLedgerRowStatus({ ledgerRowId: row.id, from: [row.status], to: "ABORTED_SYSTEMIC" });
          results.push({ ledgerRowId: row.id, videoId: row.videoId, status: "ABORTED_SYSTEMIC" });
        } else {
          results.push({ ledgerRowId: row.id, videoId: row.videoId, status: row.status, detail: row.error ?? undefined });
        }
        continue;
      }

      if (row.status !== "AWAITING_EXECUTION") {
        // Already terminal from preparation (FAILED/CONFLICT/DRY_RUN_COMPLETE), or some
        // other non-executable state -- report as-is, do not re-attempt.
        results.push({ ledgerRowId: row.id, videoId: row.videoId, status: row.status, detail: row.error ?? undefined });
        continue;
      }

      // Mandatory fresh pre-send check -- immediately before this row's actual attempt,
      // not merely at batch-preparation time (closes the gap Slice 2 documented as a
      // known limitation). Backup was already captured during preparation.
      const safety = await runSafetyPipeline({ row, batch, credentials, captureBackupNow: false });

      if (safety.outcome === "FAILED") {
        await transitionLedgerStatus(row.id, "FAILED", { error: safety.error });
        await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
        results.push({ ledgerRowId: row.id, videoId: row.videoId, status: "FAILED", detail: safety.error });
        continue;
      }
      if (safety.outcome === "CONFLICT") {
        await transitionLedgerStatus(row.id, "CONFLICT");
        await audit.record({ batchId: batch.id, ledgerRowId: row.id, videoId: row.videoId, eventType: "CONFLICT", detail: { conflictingChangeIds: safety.conflictingChangeIds } });
        await releaseVideoLock({ batchId: batch.id, videoId: row.videoId });
        results.push({ ledgerRowId: row.id, videoId: row.videoId, status: "CONFLICT" });
        continue;
      }

      const result = await executeWithRetry({
        row,
        batch,
        payload: safety.payload,
        changes: safety.changes,
        credentials,
        executor: input.executor,
      });
      results.push(result);

      if (result.systemic) {
        haltedSystemically = true;
        logger.error({ event: "batch.systemic_failure_mid_execution", context: { batchId: batch.id, ledgerRowId: row.id, detail: result.detail } });
      }
    }

    if (!haltedSystemically) {
      await batchStore.markBatchTerminal(input.batchId, "COMPLETED");
    } else {
      await batchStore.markBatchTerminal(input.batchId, "ABORTED");
    }

    return { batchId: input.batchId, results, haltedSystemically };
  }

  /** Downloadable error report (AC-ISOLATION-03): every non-successful item, with detail. */
  async function getBatchErrorReport(batchId: string): Promise<Array<{ ledgerRowId: string; videoId: string; status: LedgerStatus; error: string | null }>> {
    await requireBatch(batchId);
    const rows = await batchStore.listLedgerRowsByBatch(batchId);
    return rows
      .filter((row) => row.status !== "SUCCESS" && row.status !== "DRY_RUN_COMPLETE")
      .map((row) => ({ ledgerRowId: row.id, videoId: row.videoId, status: row.status, error: row.error }));
  }

  async function listAttempts(ledgerRowId: string): Promise<Attempt[]> {
    await requireLedgerRow(ledgerRowId);
    const rows = await batchStore.listAttemptsByLedgerRow(ledgerRowId);
    return rows.map(toAttempt);
  }

  async function listAttemptsForBatch(batchId: string): Promise<Attempt[]> {
    await requireBatch(batchId);
    const rows = await batchStore.listAttemptsByBatch(batchId);
    return rows.map(toAttempt);
  }

  return {
    createBatch,
    getBatch,
    listLedgerRows,
    claimBatchExecution,
    completeBatchExecution,
    acquireVideoLock,
    releaseVideoLock,
    transitionLedgerStatus,
    beginAttempt,
    completeAttempt,
    executeSingleAttempt,
    listAttempts,
    listAttemptsForBatch,
    prepareBatchExecution,
    executeWithRetry,
    executeBatch,
    resolveUnknownLedgerRow,
    recoverLedgerRow,
    recoverBatch,
    getBatchErrorReport,
  };
}

export type BatchServices = ReturnType<typeof createBatchServices>;
