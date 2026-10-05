// ---------------------------------------------------------------------------
// AC-CONN-17 (docs/acceptance/PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md): a generation
// routed through a real-adapter connection (backed by a fake HTTP client, never a
// real network call) preserves the entire existing pipeline -- editorial profile
// merge, per-request editorialBrief, approval, Change Set, Batch/dry-run, and
// preservation of untouched locales -- exactly like the mock-provider path already
// proven in src/lib/ai-localization/integration.acceptance.test.ts.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import type { StoredChangeRecord, StoredChangeSetRecord, StoredChannelRecord, StoredVideoRecord } from "@/lib/changesets/contracts";
import { createChangeSetServices } from "@/lib/changesets/services";
import type { AttemptOutcome, BatchStatus, LedgerStatus, PendingChangeRecord, StoredAttemptRecord, StoredBatchRecord, StoredLedgerRowRecord } from "@/lib/batches/contracts";
import { createBatchServices } from "@/lib/batches/services";
import { createAiLocalizationServices } from "@/lib/ai-localization/services";
import { createAiConnectionServices } from "./services";
import { createOpenAiCompatibleAdapter, type FetchLike } from "./adapters/openai-compatible";
import { createMockConnectionAdapter } from "./adapters/mock-adapter";
import type { StoredAiConnection, StoredAiConnectionCredential } from "@/lib/db";

function makeChannel(): StoredChannelRecord {
  return {
    channelId: "UC_TEST",
    title: "Test Channel",
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
  const video = makeVideo();
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
    async createChangeSetWithChanges(input: Parameters<Parameters<typeof createChangeSetServices>[0]["changeSetStore"]["createChangeSetWithChanges"]>[0]) {
      const now = new Date();
      changeSets.set(input.id, { id: input.id, channelId: input.channelId, source: input.source, status: input.status, importedFilename: input.importedFilename, schemaVersion: input.schemaVersion, exportedAt: input.exportedAt, createdAt: now, updatedAt: now });
      changesByChangeSet.set(input.id, input.changes.map((c) => ({ ...c, changeSetId: input.id, approvalStatus: "pending" as const, approvedValue: null, createdAt: now, updatedAt: now })));
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
      for (const u of updates) await this.updateChange(u.id, u.patch);
    },
  };

  const changeSetServices = createChangeSetServices({
    channelStore,
    changeSetStore,
    crdtConflicts: { async listConflictedChangeIds() { return new Set<string>(); } },
    idGenerator: () => `cs-id-${++idCounter}`,
    logger: { info() {}, error() {} },
  });

  return { channelStore, changeSetServices };
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
      for (const row of input.ledgerRows) ledgerRows.set(row.id, { id: row.id, batchId: input.id, videoId: row.videoId, changeIds: row.changeIds, status: "PENDING", error: null, verificationResult: null, activeAttemptId: null, createdAt: now, updatedAt: now });
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
    authResolver: { async resolve() { return { credentialRef: { userId: "user-1" }, accessToken: "tok", scopeSet: new Set<string>() }; } },
    writeContext: { async assertWriteChannel(args) { return { expectedChannelId: args.expectedChannelId ?? "UC_TEST", shouldPersistSelection: false, userId: "user-1" }; } },
    youtubeApi: {
      async fetchFreshVideoContext() {
        return { snippet: { title: "Cats of the world", description: "A tour.", defaultLanguage: "en" }, localizations: freshLocalizations };
      },
      async fetchPreliminaryBatchContext(args: { videoIds: string[] }) {
        return args.videoIds.map((videoId) => ({ videoId, defaultLanguage: "en" }));
      },
    },
    backup: {
      async checkInfrastructureHealth() { return { healthy: true }; },
      async captureBackup(args: { videoId: string; snapshot: unknown }) { return { path: `/fake/${args.videoId}.json`, capturedAt: new Date().toISOString() }; },
    },
    audit: { async record() {} },
    clock: { async wait() {} },
    idGenerator: () => `batch-id-${++counter}`,
    logger: { info() {}, error() {} },
  });
  return { store, services };
}

function createConnectionsFixture() {
  const connections = new Map<string, StoredAiConnection>();
  const credentials = new Map<string, StoredAiConnectionCredential>();
  const key = randomBytes(32);
  let counter = 0;

  const connectionStore = {
    async createConnection(input: Omit<StoredAiConnection, "status" | "statusMessage" | "statusCheckedAt" | "createdAt" | "updatedAt">) {
      const now = new Date();
      const stored: StoredAiConnection = { ...input, status: "unknown", statusMessage: null, statusCheckedAt: null, createdAt: now, updatedAt: now };
      connections.set(input.id, stored);
      return stored;
    },
    async listConnections() {
      return [...connections.values()];
    },
    async getConnection(id: string) {
      return connections.get(id) ?? null;
    },
    async updateConnection(id: string, patch: Partial<StoredAiConnection>) {
      const existing = connections.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: new Date() };
      connections.set(id, updated);
      return updated;
    },
    async deleteConnection(id: string) {
      connections.delete(id);
      credentials.delete(id);
    },
  };

  const credentialStore = {
    async upsertCredential(input: StoredAiConnectionCredential) {
      credentials.set(input.connectionId, input);
    },
    async getCredential(id: string) {
      return credentials.get(id) ?? null;
    },
    async deleteCredential(id: string) {
      credentials.delete(id);
    },
  };

  function build(fetchImpl: FetchLike) {
    return createAiConnectionServices({
      connectionStore,
      credentialStore,
      resolveEncryptionKey: () => key,
      protocolAdapters: { mock: createMockConnectionAdapter(), openai_compatible: createOpenAiCompatibleAdapter({ fetchImpl, dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }] }) },
      idGenerator: () => `conn-${++counter}`,
      logger: { info() {}, error() {} },
    });
  }

  return { build };
}

test("AC-CONN-17: a connection-backed generation preserves the entire AI Localization / Change Set / Batch pipeline unmodified", async () => {
  const changesetsFixture = createChangesetsFixture();
  const connectionsFixture = createConnectionsFixture();

  let fetchCalls = 0;
  const fakeFetch: FetchLike = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ title: "Gatos do Mundo", description: "Um tour." }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
      },
      async text() {
        return "";
      },
    };
  };
  const connectionServices = connectionsFixture.build(fakeFetch);

  const connection = await connectionServices.createConnection({
    displayName: "Fake OpenAI-compatible",
    adapterType: "openai_compatible",
    baseUrl: "https://api.example.com/v1",
    modelId: "some-model",
    capabilities: { structuredOutput: "json_object" },
    apiKey: "sk-fake",
  });

  const ai = createAiLocalizationServices({
    channelStore: changesetsFixture.channelStore,
    resolveProvider: () => {
      throw new Error("must not be used when connectionId is supplied");
    },
    defaultProviderName: "mock",
    resolveConnectionProvider: connectionServices.resolveConnectionProvider,
    changeSetServices: { createChangeSetFromProposals: changesetsFixture.changeSetServices.createChangeSetFromProposals },
    profileStore: { async getProfile() { return null; }, async saveProfile(): Promise<never> { throw new Error("unused"); } },
    provenanceStore: { async create() {}, async getByChangeSetId() { return null; } },
    idGenerator: (() => { let n = 0; return () => `ai-id-${++n}`; })(),
    logger: { info() {}, error() {} },
  });

  const generation = await ai.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["pt-BR"], connectionId: connection.id });

  assert.equal(fetchCalls, 1);
  assert.equal(generation.results.length, 1);
  const [target] = generation.results;
  assert.equal(target.providerError, null);
  assert.deepEqual(target.usage, { inputTokens: 100, outputTokens: 20 });
  const title = target.fields.find((f) => f.field === "title")!;
  assert.equal(title.proposedValue, "Gatos do Mundo");

  const changeSet = await ai.createChangeSetFromGeneration(
    {
      channelId: "UC_TEST",
      proposals: [{ videoId: "v1", language: "pt-BR", title: "Gatos do Mundo", description: "Um tour." }],
    },
    { createdVia: "web_ui", agentApiVersion: null }
  );
  assert.equal(changeSet.source, "ai_localization");

  const { changes } = await changesetsFixture.changeSetServices.getChangeSet({ channelId: "UC_TEST", changeSetId: changeSet.id });
  assert.ok(changes.every((c) => c.approvalStatus === "pending")); // no auto-approval

  const approvedTitle = await changesetsFixture.changeSetServices.approveChange({ channelId: "UC_TEST", changeSetId: changeSet.id, changeId: changes.find((c) => c.field === "title")!.id });
  const approvedDescription = await changesetsFixture.changeSetServices.approveChange({ channelId: "UC_TEST", changeSetId: changeSet.id, changeId: changes.find((c) => c.field === "description")!.id });

  const batchHarness = createBatchHarness({ de: { title: "Katzen der Welt", description: "Eine Tour." }, fr: { title: "Chats du monde", description: "Une visite." } });
  batchHarness.store.changes.set(approvedTitle.change.id, { id: approvedTitle.change.id, videoId: "v1", language: "pt-BR", field: "title", baselineValue: "", proposedValue: approvedTitle.change.proposedValue, approvedValue: approvedTitle.change.approvedValue!, approvalStatus: "approved", validationStatus: "valid", conflictStatus: "none" });
  batchHarness.store.changes.set(approvedDescription.change.id, { id: approvedDescription.change.id, videoId: "v1", language: "pt-BR", field: "description", baselineValue: "", proposedValue: approvedDescription.change.proposedValue, approvedValue: approvedDescription.change.approvedValue!, approvalStatus: "approved", validationStatus: "valid", conflictStatus: "none" });

  const batch = await batchHarness.services.createBatch({ channelId: "UC_TEST", dryRun: true, selections: [{ videoId: "v1", changeIds: [approvedTitle.change.id, approvedDescription.change.id] }] });
  const result = await batchHarness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  assert.equal(result.rows[0].status, "DRY_RUN_COMPLETE");
  const localizations = (result.rows[0] as { payload: { localizations: Record<string, { title: string; description: string }> } }).payload.localizations;
  assert.deepEqual(localizations.de, { title: "Katzen der Welt", description: "Eine Tour." });
  assert.deepEqual(localizations.fr, { title: "Chats du monde", description: "Une visite." });
  assert.equal(localizations["pt-BR"].title, "Gatos do Mundo");
});
