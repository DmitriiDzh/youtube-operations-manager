import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAttemptIntent,
  claimBatchExecution,
  createBatchWithLedger,
  getDraftRetentionDays,
  getStoredBatch,
  getStoredChangeSet,
  getWriteLogRetentionDays,
  rawSqlClient,
  insertAuditEvent,
  listAuditEventsByBatch,
  listStoredAttemptsByBatch,
  listStoredLedgerRowsByBatch,
  markBatchTerminal,
  recordAttemptResult,
  setDraftRetentionDays,
  setWriteLogRetentionDays,
  transitionLedgerRowStatus,
  upsertChannel,
} from "@/lib/db";
import { createChangeDraftsCore } from "@/lib/sync-gateway/change-drafts";
import { createSqlProjectionAdapter } from "@/lib/sync-gateway/change-drafts/adapters/sql-projection";
import { createSqlRetentionSource } from "./adapters/source";
import { createRetentionCore } from "./services";

// Real SQLite (isolated per test file) with its real foreign keys: this is what proves the delete ORDER, which an in-memory fake cannot.

const CHANNEL = "UC_retention_test";
// Every record is created "now"; the sweep runs 40 days later so the default periods (7 and 30 days) have passed.
const LATER = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);

function memoryDrafts() {
  const files = new Map<string, Uint8Array>();
  return createChangeDraftsCore({
    store: {
      async loadDocumentBytes(channelId) {
        return files.get(channelId) ?? null;
      },
      async saveDocumentBytes(channelId, bytes) {
        files.set(channelId, bytes);
      },
    },
    sqlSource: { async listChangeSetsForChannel() { return []; }, async listChangesForChangeSet() { return []; } },
    projection: createSqlProjectionAdapter(),
    discardedBackupStore: { async backup() { return { path: "/unused", capturedAt: new Date().toISOString() }; } },
  });
}

async function addSet(
  drafts: ReturnType<typeof memoryDrafts>,
  id: string,
  decisions: Array<"approved" | "rejected" | "pending">,
  status: "in_review" | "approved" | "rejected" | "partially_approved"
) {
  await drafts.createChangeSet({ channelId: CHANNEL, changeSetId: id, source: "ai_localization" });
  await drafts.createProvenance({ channelId: CHANNEL, id: `prov-${id}`, changeSetId: id, profileVersion: 1, effectiveContextJson: null });
  for (const [i, decision] of decisions.entries()) {
    await drafts.addChange({
      channelId: CHANNEL,
      changeId: `${id}-c${i}`,
      changeSetId: id,
      videoId: `v-${id}-${i}`,
      language: "es",
      field: "title",
      baselineValue: "Original",
      proposedValue: "Propuesta",
      changeType: "modify",
    });
    if (decision !== "pending") {
      await drafts.setApprovalStatus({ channelId: CHANNEL, changeId: `${id}-c${i}`, approvalStatus: decision, approvedValue: decision === "approved" ? "Propuesta" : null });
    }
  }
  await drafts.setChangeSetStatus({ channelId: CHANNEL, changeSetId: id, status });
}

/** A batch run to the end: every row ends in `rowStatus`; with SUCCESS it gets an attempt and audit events like a real run. */
async function addBatch(id: string, rows: Array<{ changeIds: string[]; status: "SUCCESS" | "FAILED" }>, dryRun = false) {
  await createBatchWithLedger({
    id,
    channelId: CHANNEL,
    concurrency: 1,
    dryRun,
    ledgerRows: rows.map((row, i) => ({ id: `${id}-r${i}`, videoId: `v-${id}-${i}`, changeIds: row.changeIds })),
  });
  await claimBatchExecution(id, `run-${id}`);
  for (const [i, row] of rows.entries()) {
    const ledgerRowId = `${id}-r${i}`;
    await transitionLedgerRowStatus({ ledgerRowId, from: ["PENDING"], to: "AWAITING_EXECUTION" });
    await beginAttemptIntent({ id: `${id}-a${i}`, ledgerRowId, attemptNumber: 1, payloadSnapshot: { x: 1 } });
    await transitionLedgerRowStatus({ ledgerRowId, from: ["AWAITING_EXECUTION"], to: "APPLYING" });
    await recordAttemptResult({ attemptId: `${id}-a${i}`, outcome: row.status === "SUCCESS" ? "SUCCESS" : "FAILED", outcomeDetail: null });
    await transitionLedgerRowStatus({ ledgerRowId, from: ["APPLYING"], to: row.status });
    await insertAuditEvent({ batchId: id, ledgerRowId, videoId: `v-${id}-${i}`, eventType: "VERIFICATION", detail: {} });
  }
  await markBatchTerminal(id, "COMPLETED");
}

function core(drafts: ReturnType<typeof memoryDrafts>) {
  return createRetentionCore({ ...createSqlRetentionSource(), drafts: { purgeChangeSets: (input) => drafts.purgeChangeSets(input) } });
}

test("sweep deletes settled drafts and the fully successful write log, in FK order, and keeps everything else", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_ret", connectedUserId: null });
  const drafts = memoryDrafts();
  await addSet(drafts, "cs-rejected", ["rejected", "rejected"], "rejected");
  await addSet(drafts, "cs-written", ["approved", "rejected"], "partially_approved");
  await addSet(drafts, "cs-in-review", ["pending", "approved"], "in_review");
  await addSet(drafts, "cs-failed", ["approved"], "approved");
  await addSet(drafts, "cs-never-sent", ["approved"], "approved");

  await addBatch("b-ok", [{ changeIds: ["cs-written-c0"], status: "SUCCESS" }]);
  await addBatch("b-failed", [{ changeIds: ["cs-failed-c0"], status: "FAILED" }]);

  const result = await core(drafts).sweepChannel(CHANNEL, LATER);

  assert.deepEqual(
    { sets: result.purgedChangeSets, changes: result.purgedChanges, provenance: result.purgedProvenance, batches: result.purgedBatches },
    { sets: 2, changes: 4, provenance: 2, batches: 1 }
  );
  // Gone from SQL and from the Automerge document.
  assert.equal(await getStoredChangeSet("cs-rejected"), null);
  assert.equal(await getStoredChangeSet("cs-written"), null);
  const doc = await drafts.getDocument({ channelId: CHANNEL });
  assert.deepEqual(Object.keys(doc.changeSets).sort(), ["cs-failed", "cs-in-review", "cs-never-sent"]);
  // Kept: in review, a failed write, an approved set nobody sent.
  assert.ok(await getStoredChangeSet("cs-in-review"));
  assert.ok(await getStoredChangeSet("cs-failed"));
  assert.ok(await getStoredChangeSet("cs-never-sent"));
  // The successful batch is gone with all its children; the failed one is untouched.
  assert.equal(await getStoredBatch("b-ok"), null);
  assert.deepEqual(await listStoredLedgerRowsByBatch("b-ok"), []);
  assert.deepEqual(await listStoredAttemptsByBatch("b-ok"), []);
  assert.deepEqual(await listAuditEventsByBatch("b-ok"), []);
  assert.ok(await getStoredBatch("b-failed"));
  assert.equal((await listStoredLedgerRowsByBatch("b-failed")).length, 1);
  assert.equal((await listAuditEventsByBatch("b-failed")).length, 1);
});

test("a second sweep with nothing new changes nothing", async () => {
  const drafts = memoryDrafts();
  const result = await core(drafts).sweepChannel(CHANNEL, LATER);
  // (a fresh in-memory document has no sets; the earlier test's SQL rows that are kept stay kept)
  assert.equal(result.purgedChangeSets, 0);
  assert.equal(result.purgedBatches, 0);
  assert.ok(await getStoredChangeSet("cs-failed"));
});

test("nothing is purged before the periods pass", async () => {
  const drafts = memoryDrafts();
  await upsertChannel({ channelId: "UC_retention_young", title: "Young", thumbnailUrl: null, uploadsPlaylistId: "UU_young", connectedUserId: null });
  await drafts.createChangeSet({ channelId: "UC_retention_young", changeSetId: "cs-young", source: "ai_localization" });
  await drafts.addChange({ channelId: "UC_retention_young", changeId: "cs-young-c0", changeSetId: "cs-young", videoId: "v", language: "es", field: "title", baselineValue: "a", proposedValue: "b", changeType: "modify" });
  await drafts.setApprovalStatus({ channelId: "UC_retention_young", changeId: "cs-young-c0", approvalStatus: "rejected" });
  await drafts.setChangeSetStatus({ channelId: "UC_retention_young", changeSetId: "cs-young", status: "rejected" });

  const result = await core(drafts).sweepChannel("UC_retention_young", new Date());
  assert.equal(result.purgedChangeSets, 0);
  assert.ok(await getStoredChangeSet("cs-young"));
});

test("retention settings: defaults 7 and 30; the write log can never be below 7; values are validated", async () => {
  assert.equal(await getDraftRetentionDays(), 7);
  assert.equal(await getWriteLogRetentionDays(), 30);

  await setDraftRetentionDays(1);
  assert.equal(await getDraftRetentionDays(), 1);
  await assert.rejects(() => setDraftRetentionDays(0));
  await assert.rejects(() => setDraftRetentionDays(2.5));

  await setWriteLogRetentionDays(7);
  assert.equal(await getWriteLogRetentionDays(), 7);
  await assert.rejects(() => setWriteLogRetentionDays(6));
  await assert.rejects(() => setWriteLogRetentionDays(-30));
  assert.equal(await getWriteLogRetentionDays(), 7, "a refused value changes nothing");
});

test("a write-log value below 7 that ended up in the settings table anyway is read back as 7, never lower", async () => {
  await rawSqlClient.execute({ sql: "INSERT INTO app_settings (key, value) VALUES ('write_log_retention_days', '2') ON CONFLICT(key) DO UPDATE SET value = '2'", args: [] });
  assert.equal(await getWriteLogRetentionDays(), 7);
});

// Review finding 4: the write log may only go once the draft really is gone; "planned" is not "purged".
test("a set whose purge was only partly done (not reported as purged) keeps its batch in the write log", async () => {
  const NOW = new Date("2026-10-20T12:00:00.000Z");
  const old = new Date("2026-09-01T00:00:00.000Z");
  let deleted: string[] = [];
  const sweep = createRetentionCore({
    source: {
      async listChangeSets() {
        return [{ id: "cs-1", status: "rejected" as const, updatedAt: old, changes: [{ id: "c-1", approvalStatus: "rejected" as const, updatedAt: old }] }];
      },
      async listLedgerRows() {
        return [];
      },
      async listBatches() {
        return [{ id: "b-1", status: "COMPLETED", completedAt: old, rows: [{ status: "SUCCESS", changeIds: ["c-1"] }] }];
      },
    },
    drafts: { purgeChangeSets: async () => ({ changeSets: 0, changes: 0, provenance: 0, purgedChangeSetIds: [] }) },
    writeLog: {
      async deleteBatches(ids) {
        deleted = ids;
        return ids.length;
      },
    },
    settings: { draftRetentionDays: async () => 7, writeLogRetentionDays: async () => 30 },
    logger: { info: () => undefined, error: () => undefined },
  });

  const result = await sweep.sweepChannel("UC_x", NOW);

  assert.deepEqual(deleted, [], "c-1 is still in a surviving set, so its batch stays");
  assert.equal(result.purgedBatches, 0);
});

test("manual delete (owner request 2026-10-04): any status goes, including in_review and ones the sweep never touches; the document and SQL rows both lose it", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_ret", connectedUserId: null });
  const drafts = memoryDrafts();
  await addSet(drafts, "m-in-review", ["pending", "rejected"], "in_review");
  await addSet(drafts, "m-other", ["approved"], "approved");

  const result = await core(drafts).deleteChangeSet({ channelId: CHANNEL, changeSetId: "m-in-review" });

  assert.deepEqual(result, { changeSets: 1, changes: 2, provenance: 1 });
  assert.equal(await getStoredChangeSet("m-in-review"), null);
  assert.ok(await getStoredChangeSet("m-other"));
  assert.deepEqual(Object.keys((await drafts.getDocument({ channelId: CHANNEL })).changeSets), ["m-other"]);
});

test("manual delete is refused while a real write carrying one of its changes is waiting or running, but a dry run does not block it", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_ret", connectedUserId: null });
  const drafts = memoryDrafts();
  await addSet(drafts, "m-live", ["approved"], "approved");
  await addSet(drafts, "m-dry", ["approved"], "approved");
  await createBatchWithLedger({ id: "b-live", channelId: CHANNEL, concurrency: 1, dryRun: false, ledgerRows: [{ id: "b-live-r0", videoId: "v-m-live-0", changeIds: ["m-live-c0"] }] });
  await createBatchWithLedger({ id: "b-dry", channelId: CHANNEL, concurrency: 1, dryRun: true, ledgerRows: [{ id: "b-dry-r0", videoId: "v-m-dry-0", changeIds: ["m-dry-c0"] }] });

  await assert.rejects(
    core(drafts).deleteChangeSet({ channelId: CHANNEL, changeSetId: "m-live" }),
    (e: unknown) => (e as { code?: string }).code === "change_set_in_use"
  );
  assert.ok(await getStoredChangeSet("m-live"));
  await core(drafts).deleteChangeSet({ channelId: CHANNEL, changeSetId: "m-dry" });
  assert.equal(await getStoredChangeSet("m-dry"), null);
});

test("manual delete of an id that is not in this channel is a named 'not found' and deletes nothing", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_ret", connectedUserId: null });
  const drafts = memoryDrafts();
  await addSet(drafts, "m-keep", ["pending"], "in_review");
  await assert.rejects(
    core(drafts).deleteChangeSet({ channelId: CHANNEL, changeSetId: "nope" }),
    (e: unknown) => (e as { code?: string }).code === "change_set_not_found"
  );
  assert.ok(await getStoredChangeSet("m-keep"));
});

test("manual delete is also refused for rows in APPLYING / UNKNOWN (outcome not known yet)", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_ret", connectedUserId: null });
  const drafts = memoryDrafts();
  await addSet(drafts, "m-applying", ["approved"], "approved");
  await createBatchWithLedger({ id: "b-applying", channelId: CHANNEL, concurrency: 1, dryRun: false, ledgerRows: [{ id: "b-applying-r0", videoId: "v-m-applying-0", changeIds: ["m-applying-c0"] }] });
  await claimBatchExecution("b-applying", "run-b-applying");
  await transitionLedgerRowStatus({ ledgerRowId: "b-applying-r0", from: ["PENDING"], to: "AWAITING_EXECUTION" });
  await beginAttemptIntent({ id: "b-applying-a0", ledgerRowId: "b-applying-r0", attemptNumber: 1, payloadSnapshot: { x: 1 } });
  await transitionLedgerRowStatus({ ledgerRowId: "b-applying-r0", from: ["AWAITING_EXECUTION"], to: "APPLYING" });
  await assert.rejects(core(drafts).deleteChangeSet({ channelId: CHANNEL, changeSetId: "m-applying" }), (e: unknown) => (e as { code?: string }).code === "change_set_in_use");
  assert.ok(await getStoredChangeSet("m-applying"));
});

test("manual delete: a set whose write already finished (SUCCESS) can be deleted; the finished batch stays for the write-log retention", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_ret", connectedUserId: null });
  const drafts = memoryDrafts();
  await addSet(drafts, "m-done", ["approved"], "approved");
  await addBatch("b-done", [{ changeIds: ["m-done-c0"], status: "SUCCESS" }]);
  await core(drafts).deleteChangeSet({ channelId: CHANNEL, changeSetId: "m-done" });
  assert.equal(await getStoredChangeSet("m-done"), null);
  assert.ok(await getStoredBatch("b-done"));
});

test("manual delete reports a purge that did not remove the set instead of pretending success", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_ret", connectedUserId: null });
  const drafts = memoryDrafts();
  await addSet(drafts, "m-stuck", ["pending"], "in_review");
  const failing = createRetentionCore({
    ...createSqlRetentionSource(),
    drafts: { purgeChangeSets: async () => ({ changeSets: 0, changes: 0, provenance: 0, purgedChangeSetIds: [] }) },
  });
  await assert.rejects(failing.deleteChangeSet({ channelId: CHANNEL, changeSetId: "m-stuck" }), (e: unknown) => (e as { code?: string }).code === "change_set_delete_failed");
});
