// BL-124 / ADR 0020 -- docs/acceptance/BL124_SEND_APPROVED_ACCEPTANCE.md, criteria AC-SEND-07/08/09 (and the
// batch half of AC-SEND-01): the batch the one-click send creates is executed by the EXISTING executeBatch, with a
// fake YouTube write executor, over the real batch services (fake store as in e2e.acceptance.test.ts).
// Expected values are hand-computed from the acceptance document's fixture F.

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
import { createSendApprovedServices } from "./send-approved";

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

type Remote = {
  snippet: { title: string; description: string; defaultLanguage: string };
  localizations: Record<string, { title: string; description: string }>;
};

function build(options: { failVideoIds?: string[] } = {}) {
  const store = createFakeStore();
  const writes: Array<{ videoId: string; localizations: Record<string, { title: string; description: string }>; snippet: Record<string, unknown> }> = [];
  const remote = new Map<string, Remote>([
    ["v1", { snippet: { title: "T1", description: "D1", defaultLanguage: "en" }, localizations: { de: { title: "Titel DE", description: "Beschreibung DE" } } }],
    ["v2", { snippet: { title: "T2", description: "D2", defaultLanguage: "en" }, localizations: {} }],
  ]);
  let counter = 0;

  // Fixture F (acceptance document): sendable = c1, c2 (v1) and c3 (v2).
  const register = (id: string, videoId: string, field: "title" | "description", extra: Partial<PendingChangeRecord> = {}) =>
    store.registerApprovedChange({ id, videoId, language: "es", field, proposedValue: `ES ${id}`, ...extra });
  register("c1", "v1", "title");
  register("c2", "v1", "description");
  register("c3", "v2", "title");
  register("c4", "v2", "description", { approvalStatus: "pending", approvedValue: null });
  register("c5", "v3", "title", { approvalStatus: "rejected", approvedValue: null });
  register("c6", "v3", "description", { validationStatus: "invalid" });
  register("c7", "v4", "title", { conflictStatus: "conflict" });
  register("c8", "v5", "title", { approvedValue: "approved text", proposedValue: "edited after approval" });

  const batchServices = createBatchServices({
    batchStore: store,
    changeSetStore: store,
    authResolver: { async resolve() { return { credentialRef: { userId: "user-1" }, accessToken: "tok", scopeSet: new Set<string>() }; } },
    writeContext: { async assertWriteChannel(args) { return { expectedChannelId: args.expectedChannelId ?? "UC_A", shouldPersistSelection: false, userId: "user-1" }; } },
    youtubeApi: {
      async fetchFreshVideoContext(args: { videoId: string }) {
        const state = remote.get(args.videoId);
        if (!state) return null;
        return { snippet: { ...state.snippet }, localizations: JSON.parse(JSON.stringify(state.localizations)) };
      },
    },
    backup: {
      async checkInfrastructureHealth() { return { healthy: true }; },
      async captureBackup(args: { videoId: string }) { return { path: `/fake/${args.videoId}.json`, capturedAt: new Date().toISOString() }; },
    },
    audit: { async record() {} },
    clock: { async wait() {} },
    idGenerator: () => `id-${++counter}`,
    logger: { info() {}, error() {} },
  });

  const send = createSendApprovedServices({
    isLiveWritesEnabled: async () => true,
    batches: batchServices,
    changeSets: {
      async getChangeSet(id) { return id === "CS1" ? { id, channelId: "UC_A" } : null; },
      async listChanges() {
        return [...store.changes.values()].map((c) => ({
          id: c.id, videoId: c.videoId, approvalStatus: c.approvalStatus, validationStatus: c.validationStatus,
          conflictStatus: c.conflictStatus, approvedValue: c.approvedValue, proposedValue: c.proposedValue,
        }));
      },
    },
  });

  const executor: WriteExecutor = {
    async attemptWrite(payload: unknown): Promise<WriteExecutorResult> {
      const p = payload as { videoId: string; localizations: Record<string, { title: string; description: string }>; snippet: Record<string, unknown> };
      writes.push(p);
      if (options.failVideoIds?.includes(p.videoId)) return { outcome: "FAILED", detail: "simulated failure" } as WriteExecutorResult;
      remote.get(p.videoId)!.localizations = JSON.parse(JSON.stringify(p.localizations));
      return { outcome: "SUCCESS" };
    },
  };

  return { store, batchServices, send, executor, writes, remote };
}

const CREDENTIALS = { userId: "user-1" };

test("AC-SEND-07: executing the sent batch writes exactly v1 and v2, only es title/description, keeping the unrelated de locale", async () => {
  const { send, batchServices, executor, writes } = build();

  const sent = await send.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });
  const summary = await batchServices.executeBatch({ batchId: sent.batch.id, credentialRef: CREDENTIALS, executor });

  assert.deepEqual(summary.results.map((r) => [r.videoId, r.status]).sort(), [["v1", "SUCCESS"], ["v2", "SUCCESS"]]);
  assert.deepEqual(writes.map((w) => w.videoId).sort(), ["v1", "v2"]);
  const v1 = writes.find((w) => w.videoId === "v1")!;
  assert.deepEqual(v1.localizations, {
    de: { title: "Titel DE", description: "Beschreibung DE" },
    es: { title: "ES c1", description: "ES c2" },
  });
  const v2 = writes.find((w) => w.videoId === "v2")!;
  assert.equal(v2.localizations.es?.title, "ES c3");
  for (const write of writes) {
    // Nothing but the video's own snippet baseline and its localizations is ever sent.
    assert.deepEqual(Object.keys(write).sort(), ["localizations", "snippet", "videoId"]);
  }
});

test("AC-SEND-08: a failed write leaves the batch not settled -- v1 SUCCESS, v2 FAILED, reported", async () => {
  const { send, batchServices, executor, store } = build({ failVideoIds: ["v2"] });

  const sent = await send.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });
  await batchServices.executeBatch({ batchId: sent.batch.id, credentialRef: CREDENTIALS, executor });

  const rows = await store.listLedgerRowsByBatch(sent.batch.id);
  assert.deepEqual(rows.map((r) => [r.videoId, r.status]).sort(), [["v1", "SUCCESS"], ["v2", "FAILED"]]);
  const report = await batchServices.getBatchErrorReport(sent.batch.id);
  assert.deepEqual(report.map((e) => e.videoId), ["v2"]);
});

test("AC-SEND-09: a PENDING batch left behind writes nothing; the next send points at it and executing it writes exactly twice", async () => {
  const { send, batchServices, executor, writes } = build();

  const first = await send.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });
  assert.equal(writes.length, 0, "creating the batch writes nothing");

  await assert.rejects(
    send.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" }),
    (error: { code?: string; details?: { batchId?: string } }) => error.code === "send_already_in_progress" && error.details?.batchId === first.batch.id
  );

  await batchServices.executeBatch({ batchId: first.batch.id, credentialRef: CREDENTIALS, executor });
  assert.equal(writes.length, 2);

  // Re-executing the finished batch (a stale second click on the pop-up) adds no write.
  await batchServices.executeBatch({ batchId: first.batch.id, credentialRef: CREDENTIALS, executor });
  assert.equal(writes.length, 2);
});

test("AC-SEND-09: resume after an interruption never writes the already-written video twice", async () => {
  const { send, batchServices, executor, writes, store } = build({ failVideoIds: ["v2"] });

  const sent = await send.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });
  await batchServices.executeBatch({ batchId: sent.batch.id, credentialRef: CREDENTIALS, executor });
  // v1 is written once; v2's failing write is retried by the existing retry policy (not asserted here).
  assert.equal(writes.filter((w) => w.videoId === "v1").length, 1);
  assert.ok(writes.some((w) => w.videoId === "v2"));

  // The batch is finished (FAILED row is terminal); a re-run must not touch v1 again.
  await batchServices.executeBatch({ batchId: sent.batch.id, credentialRef: CREDENTIALS, executor });
  assert.equal(writes.filter((w) => w.videoId === "v1").length, 1);
  const v1Row = (await store.listLedgerRowsByBatch(sent.batch.id)).find((r) => r.videoId === "v1")!;
  assert.equal((await store.listAttemptsByLedgerRow(v1Row.id)).length, 1);
});
