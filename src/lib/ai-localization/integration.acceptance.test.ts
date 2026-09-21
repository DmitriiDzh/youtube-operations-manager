// ---------------------------------------------------------------------------
// AC-APPROVAL-01, AC-CONFLICT-REUSE-01, AC-BATCH-REUSE-01, AC-PRESERVE-01
// (docs/acceptance/PHASE_6_ACCEPTANCE.md).
//
// One integrated flow: ai-localization.generateProposals -> createChangeSetFromGeneration
// -> the EXISTING, UNMODIFIED changesets.approveChange -> the EXISTING, UNMODIFIED
// batches.createBatch/prepareBatchExecution (dry-run only). Proves an AI-sourced Change
// is indistinguishable from an XLSX-imported one once it enters Phase 4/5's pipeline
// (AGENTS.md §D: one approval system, one batch system -- no parallel implementation).
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import type {
  StoredChangeRecord,
  StoredChangeSetRecord,
  StoredChannelRecord,
  StoredVideoRecord,
} from "@/lib/changesets/contracts";
import { createChangeSetServices } from "@/lib/changesets/services";
import type { AttemptOutcome, BatchStatus, LedgerStatus, PendingChangeRecord, StoredAttemptRecord, StoredBatchRecord, StoredLedgerRowRecord } from "@/lib/batches/contracts";
import { createBatchServices } from "@/lib/batches/services";
import { createAiLocalizationServices } from "./services";
import { createMockLocalizationProvider } from "./adapters/mock-provider";

function makeChannel(): StoredChannelRecord {
  return {
    channelId: "UC_TEST",
    title: "Tropico Jazz",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_TEST",
    connectedUserId: "user-1",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function makeVideo(): StoredVideoRecord {
  return {
    videoId: "v1",
    channelId: "UC_TEST",
    title: "Cats of the world",
    description: "A tour.",
    publishedAt: "2026-01-01T00:00:00.000Z",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    thumbnails: {},
    existingLocalizations: {
      de: { title: "Katzen der Welt", description: "Eine Tour." },
      fr: { title: "Chats du monde", description: "Une visite." },
    },
    etag: "etag-v1",
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function createChangesetsFixture() {
  const channel = makeChannel();
  let video = makeVideo();
  const changeSets = new Map<string, StoredChangeSetRecord>();
  const changesByChangeSet = new Map<string, StoredChangeRecord[]>();
  let idCounter = 0;

  const channelStore = {
    async getChannel(channelId: string) {
      return channelId === channel.channelId ? channel : null;
    },
    async listVideosByChannel(channelId: string) {
      return channelId === channel.channelId ? [video] : [];
    },
  };

  const changeSetStore = {
    async createChangeSetWithChanges(input: Parameters<
      Parameters<typeof createChangeSetServices>[0]["changeSetStore"]["createChangeSetWithChanges"]
    >[0]) {
      const now = new Date();
      changeSets.set(input.id, {
        id: input.id,
        channelId: input.channelId,
        source: input.source,
        status: input.status,
        importedFilename: input.importedFilename,
        schemaVersion: input.schemaVersion,
        exportedAt: input.exportedAt,
        createdAt: now,
        updatedAt: now,
      });
      changesByChangeSet.set(
        input.id,
        input.changes.map((c) => ({
          ...c,
          changeSetId: input.id,
          approvalStatus: "pending" as const,
          approvedValue: null,
          createdAt: now,
          updatedAt: now,
        }))
      );
    },
    async listChangeSetsByChannel(channelId: string) {
      return [...changeSets.values()].filter((cs) => cs.channelId === channelId);
    },
    async getChangeSet(changeSetId: string) {
      return changeSets.get(changeSetId) ?? null;
    },
    async listChangesByChangeSet(changeSetId: string) {
      return changesByChangeSet.get(changeSetId) ?? [];
    },
    async updateChangeSetStatus(changeSetId: string, status: StoredChangeSetRecord["status"]) {
      const cs = changeSets.get(changeSetId);
      if (cs) changeSets.set(changeSetId, { ...cs, status, updatedAt: new Date() });
    },
    async updateChange(changeId: string, patch: Partial<StoredChangeRecord>) {
      for (const [csId, list] of changesByChangeSet) {
        const idx = list.findIndex((c) => c.id === changeId);
        if (idx >= 0) {
          list[idx] = { ...list[idx], ...patch, updatedAt: new Date() };
          changesByChangeSet.set(csId, list);
          return;
        }
      }
    },
    async bulkUpdateChanges(updates: Array<{ id: string; patch: Partial<StoredChangeRecord> }>) {
      for (const u of updates) {
        await this.updateChange(u.id, u.patch);
      }
    },
  };

  const logger = { info() {}, error() {} };

  const changeSetServices = createChangeSetServices({
    channelStore,
    changeSetStore,
    crdtConflicts: { async listConflictedChangeIds() { return new Set<string>(); } },
    idGenerator: () => `cs-id-${++idCounter}`,
    logger,
  });

  return {
    channelStore,
    changeSetServices,
    setEsTitleExternally(newTitle: string) {
      video = { ...video, existingLocalizations: { ...video.existingLocalizations, es: { title: newTitle, description: "external" } } };
    },
  };
}

// These two integration tests exercise the Change Set / approval / Batch reuse
// guarantees; editorial profiles are a separate, additive concern covered by their
// own dedicated tests (profiles.test.ts) -- a no-op profile/provenance store here
// keeps that separation clean without pulling profile machinery into scope.
function createNoopProfileStore() {
  return {
    async getProfile() {
      return null;
    },
    async saveProfile(): Promise<never> {
      throw new Error("not used in this test");
    },
  };
}

function createNoopProvenanceStore() {
  return {
    async create() {},
    async getByChangeSetId() {
      return null;
    },
  };
}

function createBatchFakeStore() {
  const batches = new Map<string, StoredBatchRecord>();
  const ledgerRows = new Map<string, StoredLedgerRowRecord>();
  const attempts = new Map<string, StoredAttemptRecord>();
  const locks = new Map<string, { batchId: string; ledgerRowId: string; lockedAt: Date }>();
  const changes = new Map<string, PendingChangeRecord>();

  return {
    changes,
    async getChange(changeId: string) {
      return changes.get(changeId) ?? null;
    },
    async createBatchWithLedger(input: { id: string; channelId: string; concurrency: number; dryRun: boolean; ledgerRows: Array<{ id: string; videoId: string; changeIds: string[] }> }) {
      const now = new Date();
      batches.set(input.id, { id: input.id, channelId: input.channelId, status: "PENDING", concurrency: input.concurrency, dryRun: input.dryRun, runId: null, createdAt: now, startedAt: null, completedAt: null });
      for (const row of input.ledgerRows) {
        ledgerRows.set(row.id, { id: row.id, batchId: input.id, videoId: row.videoId, changeIds: row.changeIds, status: "PENDING", error: null, verificationResult: null, activeAttemptId: null, createdAt: now, updatedAt: now });
      }
    },
    async getBatch(batchId: string) {
      return batches.get(batchId) ?? null;
    },
    async listBatchesByChannel(channelId: string) {
      return [...batches.values()].filter((b) => b.channelId === channelId);
    },
    async listLedgerRowsByBatch(batchId: string) {
      return [...ledgerRows.values()].filter((r) => r.batchId === batchId);
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
      if (batch) batches.set(batchId, { ...batch, status, completedAt: new Date() });
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
    async transitionLedgerRowStatus(input: { ledgerRowId: string; from: LedgerStatus[]; to: LedgerStatus; error?: string | null; verificationResult?: unknown }) {
      const row = ledgerRows.get(input.ledgerRowId);
      if (!row || !input.from.includes(row.status)) return false;
      ledgerRows.set(input.ledgerRowId, { ...row, status: input.to, error: input.error !== undefined ? input.error : row.error, verificationResult: input.verificationResult !== undefined ? input.verificationResult : row.verificationResult, updatedAt: new Date() });
      return true;
    },
    async beginAttemptIntent(input: { id: string; ledgerRowId: string; attemptNumber: number; payloadSnapshot: unknown }) {
      const row = ledgerRows.get(input.ledgerRowId);
      if (!row || row.activeAttemptId !== null) return false;
      ledgerRows.set(input.ledgerRowId, { ...row, activeAttemptId: input.id, updatedAt: new Date() });
      attempts.set(input.id, { id: input.id, ledgerRowId: input.ledgerRowId, attemptNumber: input.attemptNumber, phase: "INTENDED", payloadSnapshot: input.payloadSnapshot, requestedAt: new Date(), outcome: null, outcomeDetail: null, resultAt: null });
      return true;
    },
    async recordAttemptResult(input: { attemptId: string; outcome: AttemptOutcome; outcomeDetail: string | null }) {
      const attempt = attempts.get(input.attemptId);
      if (!attempt || attempt.phase !== "INTENDED") return false;
      attempts.set(input.attemptId, { ...attempt, phase: "RESULT_RECORDED", outcome: input.outcome, outcomeDetail: input.outcomeDetail, resultAt: new Date() });
      const row = ledgerRows.get(attempt.ledgerRowId);
      if (row && row.activeAttemptId === input.attemptId) ledgerRows.set(attempt.ledgerRowId, { ...row, activeAttemptId: null, updatedAt: new Date() });
      return true;
    },
    async listAttemptsByLedgerRow(ledgerRowId: string) {
      return [...attempts.values()].filter((a) => a.ledgerRowId === ledgerRowId);
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

function createBatchHarness(freshLocalizations: Record<string, { title: string; description: string }>) {
  const store = createBatchFakeStore();
  let counter = 0;

  const services = createBatchServices({
    batchStore: store,
    changeSetStore: store,
    authResolver: {
      async resolve() {
        return { credentialRef: { userId: "user-1" }, accessToken: "tok", scopeSet: new Set<string>() };
      },
    },
    writeContext: {
      async assertWriteChannel(args) {
        return { expectedChannelId: args.expectedChannelId ?? "UC_TEST", shouldPersistSelection: false, userId: "user-1" };
      },
    },
    youtubeApi: {
      async fetchFreshVideoContext() {
        return { snippet: { title: "Cats of the world", description: "A tour.", defaultLanguage: "en" }, localizations: freshLocalizations };
      },
      async fetchPreliminaryBatchContext(args: { videoIds: string[] }) {
        return args.videoIds.map((videoId) => ({ videoId, defaultLanguage: "en" }));
      },
    },
    backup: {
      async checkInfrastructureHealth() {
        return { healthy: true };
      },
      async captureBackup(args: { videoId: string; snapshot: unknown }) {
        return { path: `/fake/${args.videoId}.json`, capturedAt: new Date().toISOString() };
      },
    },
    audit: {
      async record() {},
    },
    clock: { async wait() {} },
    idGenerator: () => `batch-id-${++counter}`,
    logger: { info() {}, error() {} },
  });

  return { store, services };
}

test("AC-APPROVAL-01 + AC-BATCH-REUSE-01 + AC-PRESERVE-01: AI-generated proposal flows unmodified through approval and dry-run batch, preserving untouched locales", async () => {
  const fixture = createChangesetsFixture();
  const provider = createMockLocalizationProvider();
  const ai = createAiLocalizationServices({
    channelStore: fixture.channelStore,
    resolveProvider: () => provider,
    defaultProviderName: "mock",
    changeSetServices: { createChangeSetFromProposals: fixture.changeSetServices.createChangeSetFromProposals },
    profileStore: createNoopProfileStore(),
    provenanceStore: createNoopProvenanceStore(),
    idGenerator: (() => {
      let n = 0;
      return () => `ai-id-${++n}`;
    })(),
    logger: { info() {}, error() {} },
  });

  // Step 1-2: generate + validate.
  const generation = await ai.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["pt-BR"] });
  assert.equal(generation.results.length, 1);
  const [target] = generation.results;
  assert.equal(target.providerError, null);
  const titleField = target.fields.find((f) => f.field === "title")!;
  const descriptionField = target.fields.find((f) => f.field === "description")!;
  assert.equal(titleField.changeType, "add");

  // Step 3-4: human inspects, edits the title, and creates the Change Set.
  const editedTitle = "Gatos do Mundo (revisado)";
  const changeSet = await ai.createChangeSetFromGeneration({
    channelId: "UC_TEST",
    proposals: [{ videoId: "v1", language: "pt-BR", title: editedTitle, description: descriptionField.proposedValue }],
  });
  assert.equal(changeSet.source, "ai_localization");
  assert.equal(changeSet.totalChanges, 2);

  // AC-APPROVAL-02 (re-confirmed at the integration level): nothing is pre-approved.
  const { changes: pendingChanges } = await fixture.changeSetServices.getChangeSet({ channelId: "UC_TEST", changeSetId: changeSet.id });
  assert.ok(pendingChanges.every((c) => c.approvalStatus === "pending"));

  const titleChange = pendingChanges.find((c) => c.field === "title")!;
  const descriptionChange = pendingChanges.find((c) => c.field === "description")!;

  // AC-APPROVAL-01: approve using the EXISTING, UNMODIFIED changesets.approveChange.
  const approvedTitle = await fixture.changeSetServices.approveChange({ channelId: "UC_TEST", changeSetId: changeSet.id, changeId: titleChange.id });
  const approvedDescription = await fixture.changeSetServices.approveChange({ channelId: "UC_TEST", changeSetId: changeSet.id, changeId: descriptionChange.id });
  assert.equal(approvedTitle.change.approvalStatus, "approved");
  assert.equal(approvedTitle.change.approvedValue, editedTitle);
  assert.equal(approvedDescription.change.approvalStatus, "approved");

  // AC-BATCH-REUSE-01: feed the approved change ids straight into the EXISTING,
  // UNMODIFIED batches pipeline. The fresh-fetch mock supplies the CURRENT remote
  // localizations (de/fr, untouched) that must survive the merge.
  const batchHarness = createBatchHarness({
    de: { title: "Katzen der Welt", description: "Eine Tour." },
    fr: { title: "Chats du monde", description: "Une visite." },
  });
  batchHarness.store.changes.set(approvedTitle.change.id, {
    id: approvedTitle.change.id,
    videoId: "v1",
    language: "pt-BR",
    field: "title",
    baselineValue: "",
    proposedValue: approvedTitle.change.proposedValue,
    approvedValue: approvedTitle.change.approvedValue!,
    approvalStatus: "approved",
    validationStatus: "valid",
    conflictStatus: "none",
  });
  batchHarness.store.changes.set(approvedDescription.change.id, {
    id: approvedDescription.change.id,
    videoId: "v1",
    language: "pt-BR",
    field: "description",
    baselineValue: "",
    proposedValue: approvedDescription.change.proposedValue,
    approvedValue: approvedDescription.change.approvedValue!,
    approvalStatus: "approved",
    validationStatus: "valid",
    conflictStatus: "none",
  });

  const batch = await batchHarness.services.createBatch({
    channelId: "UC_TEST",
    dryRun: true,
    selections: [{ videoId: "v1", changeIds: [approvedTitle.change.id, approvedDescription.change.id] }],
  });

  const result = await batchHarness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.status, "DRY_RUN_COMPLETE");

  // AC-PRESERVE-01: de/fr untouched, pt-BR added with the human-edited title.
  const localizations = (row as { payload: { localizations: Record<string, { title: string; description: string }> } }).payload.localizations;
  assert.deepEqual(localizations.de, { title: "Katzen der Welt", description: "Eine Tour." });
  assert.deepEqual(localizations.fr, { title: "Chats du monde", description: "Une visite." });
  assert.equal(localizations["pt-BR"].title, editedTitle);
});

test("AC-CONFLICT-REUSE-01: an ai_localization change is revalidated against current remote state exactly like an xlsx_import change", async () => {
  const fixture = createChangesetsFixture();
  const provider = createMockLocalizationProvider();
  const ai = createAiLocalizationServices({
    channelStore: fixture.channelStore,
    resolveProvider: () => provider,
    defaultProviderName: "mock",
    changeSetServices: { createChangeSetFromProposals: fixture.changeSetServices.createChangeSetFromProposals },
    profileStore: createNoopProfileStore(),
    provenanceStore: createNoopProvenanceStore(),
    idGenerator: (() => {
      let n = 0;
      return () => `ai-id-${++n}`;
    })(),
    logger: { info() {}, error() {} },
  });

  const changeSet = await ai.createChangeSetFromGeneration({
    channelId: "UC_TEST",
    proposals: [{ videoId: "v1", language: "es", title: "Gatos del mundo" }],
  });
  const { changes } = await fixture.changeSetServices.getChangeSet({ channelId: "UC_TEST", changeSetId: changeSet.id });
  const change = changes[0];

  const approved = await fixture.changeSetServices.approveChange({ channelId: "UC_TEST", changeSetId: changeSet.id, changeId: change.id });
  assert.equal(approved.change.approvalStatus, "approved");

  // Simulate an external edit to the same locale after approval (a fresh re-sync
  // would pick this up) -- the baseline this approval was computed against ("") no
  // longer matches the current remote value.
  fixture.setEsTitleExternally("Changed outside the app");

  const { changes: revalidated } = await fixture.changeSetServices.getChangeSet({ channelId: "UC_TEST", changeSetId: changeSet.id });
  const revalidatedChange = revalidated.find((c) => c.id === change.id)!;

  assert.equal(revalidatedChange.conflictStatus, "conflict");
  assert.equal(revalidatedChange.approvalStatus, "pending");
  assert.equal(revalidatedChange.approvedValue, null);
});
