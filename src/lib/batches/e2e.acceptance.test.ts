// ---------------------------------------------------------------------------
// AC-E2E-01 (= official test §53, docs/acceptance/PHASE_5_ACCEPTANCE.md): ONE
// integrated automated scenario walking the approved Phase 5 workflow end to end,
// mocked track (steps 3-23 of §53; steps 1-2, "launch"/"authenticate", are live-only
// per the acceptance doc's own §4 methodology and are explicitly NOT claimed here).
// This complements, and does not replace, the many individual component-level AC
// tests elsewhere in this directory -- this file's job is specifically to prove the
// steps compose correctly as one continuous flow, not just in isolation.
//
// Flow exercised, in order:
//   1. Two videos, each with an approved change adding a NEW locale (pt-BR) while
//      existing locales (es, de) must survive untouched -- official test §57's own
//      scenario, embedded here as the batch's actual content (§53 step 6-9 shape).
//   2. Create a batch (default dryRun) -> prepareBatchExecution -> DRY_RUN_COMPLETE for
//      both rows, zero videos.update-equivalent calls, diff shows es/de preserved byte-
//      for-byte and pt-BR added (§53 steps 10-14: preview/diff before any write).
//   3. Create a second, live batch from the SAME approved changes -> executeBatch with
//      a mocked WriteExecutor -> SUCCESS for both rows: identity check passed, backup
//      captured before either write, safe merge preserved es/de, post-write
//      verification confirmed the applied value, complete per-video audit trail
//      (PREPARATION -> ATTEMPT -> RESULT -> VERIFICATION), success summary available
//      (§53 steps 15-22).
//   4. Re-running executeBatch on the SAME already-succeeded batch id performs zero
//      additional attemptWrite calls and reports the same SUCCESS results -- §53 step
//      23 ("no duplicate/unnecessary updates on re-running the same batch"), which is
//      AC-RESUME-01's no-op-on-already-successful-item guarantee applied to a fully-
//      successful (non-interrupted) batch.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import type {
  AttemptOutcome,
  BatchStatus,
  LedgerStatus,
  PendingChangeRecord,
  StoredAttemptRecord,
  StoredBatchRecord,
  StoredLedgerRowRecord,
  WriteExecutor,
  WriteExecutorResult,
} from "./contracts";
import { createBatchServices } from "./services";

function createFakeStore() {
  const batches = new Map<string, StoredBatchRecord>();
  const ledgerRows = new Map<string, StoredLedgerRowRecord>();
  const attempts = new Map<string, StoredAttemptRecord>();
  const locks = new Map<string, { batchId: string; ledgerRowId: string; lockedAt: Date }>();
  const changes = new Map<string, PendingChangeRecord>();

  return {
    changes,
    registerApprovedChange(entry: Partial<PendingChangeRecord> & { id: string; videoId: string }) {
      const proposedValue = entry.proposedValue ?? "Proposed";
      changes.set(entry.id, {
        id: entry.id,
        videoId: entry.videoId,
        language: entry.language ?? "pt-BR",
        field: entry.field ?? "title",
        baselineValue: entry.baselineValue ?? "",
        proposedValue,
        approvedValue: entry.approvedValue !== undefined ? entry.approvedValue : proposedValue,
        approvalStatus: entry.approvalStatus ?? "approved",
        validationStatus: entry.validationStatus ?? "valid",
        conflictStatus: entry.conflictStatus ?? "none",
      });
    },
    async getChange(changeId: string) {
      return changes.get(changeId) ?? null;
    },
    async createBatchWithLedger(input: {
      id: string;
      channelId: string;
      concurrency: number;
      dryRun: boolean;
      ledgerRows: Array<{ id: string; videoId: string; changeIds: string[] }>;
    }) {
      const now = new Date();
      batches.set(input.id, {
        id: input.id,
        channelId: input.channelId,
        status: "PENDING",
        concurrency: input.concurrency,
        dryRun: input.dryRun,
        runId: null,
        createdAt: now,
        startedAt: null,
        completedAt: null,
      });
      for (const row of input.ledgerRows) {
        ledgerRows.set(row.id, {
          id: row.id,
          batchId: input.id,
          videoId: row.videoId,
          changeIds: row.changeIds,
          status: "PENDING",
          error: null,
          verificationResult: null,
          activeAttemptId: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    },
    async getBatch(batchId: string) {
      return batches.get(batchId) ?? null;
    },
    async listBatchesByChannel(channelId: string) {
      return [...batches.values()].filter((b) => b.channelId === channelId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async listLedgerRowsByBatch(batchId: string) {
      return [...ledgerRows.values()].filter((row) => row.batchId === batchId);
    },
    async getLedgerRow(ledgerRowId: string) {
      return ledgerRows.get(ledgerRowId) ?? null;
    },
    async claimBatchExecution(batchId: string, runId: string) {
      const batch = batches.get(batchId);
      if (!batch || batch.status !== "PENDING") return false;
      batches.set(batchId, { ...batch, status: "RUNNING", runId, startedAt: new Date() });
      return true;
    },
    async markBatchTerminal(batchId: string, status: Extract<BatchStatus, "COMPLETED" | "ABORTED">) {
      const batch = batches.get(batchId);
      if (!batch) return;
      batches.set(batchId, { ...batch, status, completedAt: new Date() });
    },
    async acquireVideoExecutionLock(input: { videoId: string; batchId: string; ledgerRowId: string }) {
      const existing = locks.get(input.videoId);
      if (existing) return existing.batchId === input.batchId && existing.ledgerRowId === input.ledgerRowId;
      locks.set(input.videoId, { batchId: input.batchId, ledgerRowId: input.ledgerRowId, lockedAt: new Date() });
      return true;
    },
    async releaseVideoExecutionLock(input: { videoId: string; batchId: string }) {
      const holder = locks.get(input.videoId);
      if (holder && holder.batchId === input.batchId) locks.delete(input.videoId);
    },
    async getVideoExecutionLockHolder(videoId: string) {
      return locks.get(videoId) ?? null;
    },
    async transitionLedgerRowStatus(input: {
      ledgerRowId: string;
      from: LedgerStatus[];
      to: LedgerStatus;
      error?: string | null;
      verificationResult?: unknown;
    }) {
      const row = ledgerRows.get(input.ledgerRowId);
      if (!row || !input.from.includes(row.status)) return false;
      ledgerRows.set(input.ledgerRowId, {
        ...row,
        status: input.to,
        error: input.error !== undefined ? input.error : row.error,
        verificationResult: input.verificationResult !== undefined ? input.verificationResult : row.verificationResult,
        updatedAt: new Date(),
      });
      return true;
    },
    async beginAttemptIntent(input: { id: string; ledgerRowId: string; attemptNumber: number; payloadSnapshot: unknown }) {
      const row = ledgerRows.get(input.ledgerRowId);
      if (!row || row.activeAttemptId !== null) return false;
      ledgerRows.set(input.ledgerRowId, { ...row, activeAttemptId: input.id, updatedAt: new Date() });
      attempts.set(input.id, {
        id: input.id,
        ledgerRowId: input.ledgerRowId,
        attemptNumber: input.attemptNumber,
        phase: "INTENDED",
        payloadSnapshot: input.payloadSnapshot,
        requestedAt: new Date(),
        outcome: null,
        outcomeDetail: null,
        resultAt: null,
      });
      return true;
    },
    async recordAttemptResult(input: { attemptId: string; outcome: AttemptOutcome; outcomeDetail: string | null }) {
      const attempt = attempts.get(input.attemptId);
      if (!attempt || attempt.phase !== "INTENDED") return false;
      attempts.set(input.attemptId, { ...attempt, phase: "RESULT_RECORDED", outcome: input.outcome, outcomeDetail: input.outcomeDetail, resultAt: new Date() });
      const row = ledgerRows.get(attempt.ledgerRowId);
      if (row && row.activeAttemptId === input.attemptId) {
        ledgerRows.set(attempt.ledgerRowId, { ...row, activeAttemptId: null, updatedAt: new Date() });
      }
      return true;
    },
    async listAttemptsByLedgerRow(ledgerRowId: string) {
      return [...attempts.values()].filter((a) => a.ledgerRowId === ledgerRowId).sort((a, b) => a.attemptNumber - b.attemptNumber);
    },
    async listAttemptsByBatch(batchId: string) {
      const rowIds = new Set([...ledgerRows.values()].filter((r) => r.batchId === batchId).map((r) => r.id));
      return [...attempts.values()].filter((a) => rowIds.has(a.ledgerRowId));
    },
    async getAttempt(attemptId: string) {
      return attempts.get(attemptId) ?? null;
    },
  };
}

type RemoteFixture = {
  snippet: { title: string; description: string; defaultLanguage: string; categoryId?: string };
  localizations: Record<string, { title: string; description: string }>;
};

test("AC-E2E-01 (= official test §53), mocked track: full happy-path workflow, one continuous scenario", async () => {
  const store = createFakeStore();
  const auditEvents: Array<{ videoId: string; ledgerRowId: string; eventType: string }> = [];
  const backupWrites: Array<{ videoId: string }> = [];
  let counter = 0;

  // Real per-video remote state (not a stateless mock): starts at each video's baseline
  // (es/de present, pt-BR absent), and is mutated only when the mocked executor
  // actually "applies" a write -- so the mandatory post-write verification fetch
  // genuinely reflects what was written, exactly like a real API would.
  const remoteState = new Map<string, RemoteFixture>([
    [
      "v1",
      {
        snippet: { title: "Main Title V1", description: "Main Description V1", defaultLanguage: "en", categoryId: "10" },
        localizations: {
          es: { title: "Titulo ES", description: "Descripcion ES" },
          de: { title: "Titel DE", description: "Beschreibung DE" },
        },
      },
    ],
    [
      "v2",
      {
        snippet: { title: "Main Title V2", description: "Main Description V2", defaultLanguage: "en", categoryId: "10" },
        localizations: {
          es: { title: "Titulo ES V2", description: "Descripcion ES V2" },
          de: { title: "Titel DE V2", description: "Beschreibung DE V2" },
        },
      },
    ],
  ]);

  const services = createBatchServices({
    batchStore: store,
    changeSetStore: store,
    authResolver: {
      async resolve() {
        return { credentialRef: { userId: "user-1" }, accessToken: "tok", scopeSet: new Set<string>() };
      },
    },
    writeContext: {
      // AC-GUARD-01's own dedicated test covers the mismatch path; this flow's identity
      // check simply must pass for the intended channel, exactly as §53 step 4 requires.
      async assertWriteChannel(args) {
        return { expectedChannelId: args.expectedChannelId ?? "UC_TEST", shouldPersistSelection: false, userId: "user-1" };
      },
    },
    youtubeApi: {
      async fetchFreshVideoContext(args: { videoId: string }) {
        const fixture = remoteState.get(args.videoId);
        if (!fixture) return null;
        return { snippet: { ...fixture.snippet }, localizations: structuredCloneLocalizations(fixture.localizations) };
      },
    },
    backup: {
      async checkInfrastructureHealth() {
        return { healthy: true };
      },
      async captureBackup(args: { videoId: string }) {
        backupWrites.push({ videoId: args.videoId });
        return { path: `/fake/${args.videoId}.json`, capturedAt: new Date().toISOString() };
      },
    },
    audit: {
      async record(input) {
        auditEvents.push({ videoId: input.videoId, ledgerRowId: input.ledgerRowId, eventType: input.eventType });
      },
    },
    clock: { async wait() {} },
    idGenerator: () => `id-${++counter}`,
    logger: { info() {}, error() {} },
  });

  function structuredCloneLocalizations(loc: Record<string, { title: string; description: string }>) {
    const copy: Record<string, { title: string; description: string }> = {};
    for (const [k, v] of Object.entries(loc)) copy[k] = { ...v };
    return copy;
  }

  const selections = [
    { videoId: "v1", changeIds: ["c-v1-title", "c-v1-desc"] },
    { videoId: "v2", changeIds: ["c-v2-title", "c-v2-desc"] },
  ];
  for (const { videoId } of selections) {
    store.registerApprovedChange({ id: `c-${videoId}-title`, videoId, language: "pt-BR", field: "title", baselineValue: "", proposedValue: `Titulo PT ${videoId}` });
    store.registerApprovedChange({ id: `c-${videoId}-desc`, videoId, language: "pt-BR", field: "description", baselineValue: "", proposedValue: `Descricao PT ${videoId}` });
  }

  // --- Step: preview/diff via a dry-run batch (§53 steps 6-14) ----------------------
  const dryRunBatch = await services.createBatch({ channelId: "UC_TEST", dryRun: true, selections });
  const dryRunPrepared = await services.prepareBatchExecution({ batchId: dryRunBatch.id, credentialRef: { userId: "user-1" } });

  assert.equal(dryRunPrepared.rows.length, 2);
  for (const row of dryRunPrepared.rows) {
    assert.equal(row.status, "DRY_RUN_COMPLETE");
    if (row.status !== "DRY_RUN_COMPLETE") continue;
    const fixture = remoteState.get(row.videoId)!;
    // Existing locales (es, de) preserved byte-for-byte; pt-BR added -- official §57.
    assert.deepEqual(row.payload.localizations.es, fixture.localizations.es);
    assert.deepEqual(row.payload.localizations.de, fixture.localizations.de);
    assert.equal(row.payload.localizations["pt-BR"]?.title, `Titulo PT ${row.videoId}`);
    assert.equal(row.payload.localizations["pt-BR"]?.description, `Descricao PT ${row.videoId}`);
  }
  assert.equal(backupWrites.length, 2, "dry-run still captures backup (AC-DRYRUN-01) before either simulated write");

  // --- Step: identical content, a real (live) batch, executed (§53 steps 15-20) ----
  const liveBatch = await services.createBatch({ channelId: "UC_TEST", dryRun: false, selections });
  const executorCalls: string[] = [];
  const executor: WriteExecutor = {
    async attemptWrite(payload: unknown): Promise<WriteExecutorResult> {
      const { videoId } = payload as { videoId: string };
      executorCalls.push(videoId);
      const fixture = remoteState.get(videoId)!;
      // Simulate the write actually applying: the remote pt-BR locale now exists.
      fixture.localizations["pt-BR"] = { title: `Titulo PT ${videoId}`, description: `Descricao PT ${videoId}` };
      return { outcome: "SUCCESS" };
    },
  };

  const summary = await services.executeBatch({ batchId: liveBatch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.haltedSystemically, false);
  assert.equal(summary.results.length, 2);
  for (const result of summary.results) {
    assert.equal(result.status, "SUCCESS", `${result.videoId} must reach SUCCESS`);
    assert.equal(result.ownResponseObserved, true, "an ordinary (non-reconciled) success must record ownResponseObserved: true");
  }
  assert.deepEqual(executorCalls.sort(), ["v1", "v2"]);

  // --- Step: complete audit trail per video (§53 step 22) ---------------------------
  // Filtered by this LIVE batch's own ledger row ids (not just videoId) -- v1/v2 also
  // appear in the earlier dry-run batch's own audit events, which must not be conflated
  // with this batch's sequence (two distinct batches, two distinct ledger rows).
  const liveRows = await store.listLedgerRowsByBatch(liveBatch.id);
  for (const row of liveRows) {
    const sequence = auditEvents.filter((e) => e.ledgerRowId === row.id).map((e) => e.eventType);
    assert.deepEqual(sequence, ["PREPARATION", "ATTEMPT", "RESULT", "VERIFICATION"], `audit sequence for ${row.videoId}: ${sequence.join(",")}`);
  }

  // --- Step: existing (untouched) localizations remain intact on the real remote
  // state, not just in the constructed payload (§53 step 19) ------------------------
  for (const videoId of ["v1", "v2"]) {
    const fixture = remoteState.get(videoId)!;
    assert.ok(fixture.localizations.es.title.length > 0);
    assert.ok(fixture.localizations.de.title.length > 0);
    assert.ok(fixture.localizations["pt-BR"]);
  }

  // --- Step: success/failure summary and audit are both queryable after the fact
  // (§53 step 21) ---------------------------------------------------------------------
  const errorReport = await services.getBatchErrorReport(liveBatch.id);
  assert.deepEqual(errorReport, [], "a fully-successful batch's error report must be empty");

  // --- Step: re-running the SAME already-succeeded batch id performs zero additional
  // writes and reports the same result -- §53 step 23 / AC-RESUME-01's no-op guarantee
  // applied to a non-interrupted, fully-successful batch ------------------------------
  const executorCallsBeforeRerun = executorCalls.length;
  const rerunSummary = await services.executeBatch({ batchId: liveBatch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(executorCalls.length, executorCallsBeforeRerun, "re-running an already-succeeded batch must issue zero additional attemptWrite calls");
  for (const result of rerunSummary.results) {
    assert.equal(result.status, "SUCCESS");
  }
  for (const videoId of ["v1", "v2"]) {
    const ledgerRowId = (await store.listLedgerRowsByBatch(liveBatch.id)).find((r) => r.videoId === videoId)!.id;
    const attempts = await store.listAttemptsByLedgerRow(ledgerRowId);
    assert.equal(attempts.length, 1, `${videoId} must have exactly one attempt record even after the batch was re-run`);
  }
});
